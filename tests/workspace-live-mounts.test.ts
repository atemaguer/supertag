import { appendFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { taskWorkspaceBranch } from "../packages/core/src/index.js";
import { ModalWorkspaceEnvironment } from "../packages/runtime/environments/modal/src/index.js";
import {
  createWorker,
  type EnvironmentPlan,
  type Harness,
  type TaskAttemptEvent,
  WorkspaceEnvironmentResolver,
  WorkspaceResolverRegistry,
} from "../packages/runtime/sdk/src/index.js";
import {
  FAKE_TRANSFER,
  FAKE_WORKSPACE,
  FakeSandboxWorld,
} from "./support/fake-workspace-sandboxes.js";
import { createRepository, git, isolateGitConfiguration } from "./support/git-repository.js";
import { repositoryAttempt } from "./support/repository-execution.js";

const cleanups: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const empty = (): EnvironmentPlan => ({
  files: [],
  mounts: [],
  environmentVariables: {},
  secretBindings: [],
  network: { mode: "none" },
});

it.each([
  ["attached", "s3://datasets/prefix/"],
  ["start-failed", "s3://datasets/prefix/"],
  ["invalid-evidence", "s3://datasets/prefix/"],
  ["attached", "gs://datasets/prefix/"],
  ["attached", "modal-volume://datasets/prefix/"],
  ["attached", "r2://datasets/prefix/?endpoint=https%3A%2F%2Facct.r2.cloudflarestorage.com"],
] as const)(
  "reports provider attachment evidence only after successful start (%s, %s)",
  async (outcome, nativeSource) => {
    const reference = nativeSource.startsWith("modal-volume://")
      ? { nativeCredential: { "modal-volume": "datasets" } }
      : { nativeCredential: { "modal-secret": "dataset-access" } };
    cleanups.push(await isolateGitConfiguration());
    const repository = await createRepository();
    cleanups.push(() => rm(repository, { recursive: true, force: true }));
    const root = await mkdtemp(join(tmpdir(), "supertag-live-mounts-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const origin = join(root, "origin.git");
    git(repository, "clone", "--quiet", "--bare", repository, origin);
    const source = "https://example.test/app.git";
    await appendFile(
      process.env["GIT_CONFIG_GLOBAL"] as string,
      `[url "${pathToFileURL(origin).href}"]\n\tinsteadOf = ${source}\n`,
    );
    const world = await FakeSandboxWorld.create();
    cleanups.push(() => world.cleanup());
    const modal = world.modal();
    const timeline: string[] = [];
    let attachedAt: string | undefined;
    const environment = new ModalWorkspaceEnvironment({
      appName: "test",
      stagingDirectory: join(root, "returned"),
      workspaceDirectory: FAKE_WORKSPACE,
      transferDirectory: FAKE_TRANSFER,
      workspaceClient: modal.workspaceClient,
      sandboxFactory: {
        async create(input) {
          timeline.push("provider.start");
          if (outcome === "start-failed") throw new Error("fake attachment failed");
          expect(input.nativeMounts).toEqual([
            {
              volume: "datasets",
              source: nativeSource,
              path: "/mnt/datasets",
              access: "read-only",
              ...reference,
            },
          ]);
          expect(input.params.env).toBeUndefined();
          expect(input.params.secrets).toBeUndefined();
          const sandbox = await modal.sandboxFactory.create(input);
          attachedAt = new Date().toISOString();
          timeline.push("provider.attached");
          return sandbox;
        },
      },
    });
    // The provider now returns real attachment evidence. Corrupt only the negative case.
    if (outcome === "invalid-evidence") {
      const start = environment.start.bind(environment);
      vi.spyOn(environment, "start").mockImplementation(async (prepared, checkout, signal) => {
        const result = await start(prepared, checkout, signal);
        Object.defineProperty(result, "liveMounts", {
          value: result.liveMounts?.map((mount) => ({
            ...mount,
            credential: "canary-private-value",
          })),
        });
        return result;
      });
    }
    const resolver = new WorkspaceEnvironmentResolver({
      checkouts: [],
      cloneSources: true,
      worktreeRoot: join(root, "workspaces"),
      environments: { modal: environment },
      volumes: {
        async resolve() {
          throw new Error("native mounts must not resolve copy credentials");
        },
        async resolveMount(volume) {
          return {
            volume,
            source: nativeSource,
            ...reference,
          };
        },
      },
    });
    const harness: Harness = {
      id: "sh",
      async describe() {
        return {
          sessions: { resume: false, export: false, scope: "none" as const },
          id: "sh",
          version: "1",
          inputKinds: ["instruction", "workspace"],
          streaming: true,
          cancellation: true,
          sessionPersistence: "none",
        };
      },
      async plan() {
        return { runtime: empty(), execution: empty() };
      },
      async start() {
        timeline.push("harness.start");
        return {
          async *run() {
            yield { type: "output.message", text: "Done." };
          },
          async close() {},
        };
      },
    };
    const worker = createWorker({
      id: "test",
      profiles: [
        {
          ref: { id: "repository", revision: "1" },
          workerType: "test",
          harness: { provider: "sh" },
          execution: { provider: "modal", lifetime: { scope: "attempt" } },
        },
      ],
      harnesses: [harness],
      environments: [
        {
          id: "modal",
          capabilities: [],
          workspaceEnvironment: environment,
          async provision() {
            throw new Error("Must use Workspace sandbox");
          },
        },
      ],
      workspaceResolvers: new WorkspaceResolverRegistry([resolver]),
    });
    const spec = {
      ...repositoryAttempt("live"),
      workspacePlan: {
        version: 1 as const,
        status: "workspace" as const,
        workspace: "app",
        source,
        branch: taskWorkspaceBranch("objective", "live"),
        delivery: "branch" as const,
        mounts: [
          {
            volume: "datasets",
            path: "/mnt/datasets",
            strategy: "mount" as const,
            access: "read-only" as const,
          },
        ],
        volumes: [{ name: "datasets", source: nativeSource }],
      },
    };
    expect(resolver.liveMountsForAttempt(spec.attemptId)).toEqual([]);
    const events: TaskAttemptEvent[] = [];
    for await (const event of worker.execute(spec)) {
      events.push(event);
      if (event.type === "workspace.mounts.attached") timeline.push("event.attached");
    }
    const attached = events.filter((event) => event.type === "workspace.mounts.attached");
    expect(events.filter((event) => event.type === "workspace.mounts.copied")).toEqual([]);
    expect(JSON.stringify(events)).not.toContain("canary-private-value");
    if (outcome !== "attached") {
      expect(attached).toEqual([]);
      expect(timeline).toEqual(
        outcome === "start-failed" ? ["provider.start"] : ["provider.start", "provider.attached"],
      );
      expect(events.at(-1)?.type).toBe("execution.failed");
    } else {
      expect(attached).toHaveLength(1);
      const evidence = attached[0]?.mounts?.[0];
      if (evidence === undefined || attachedAt === undefined)
        throw new Error("missing attachment evidence");
      expect(Object.keys(evidence)).toHaveLength(7);
      expect(new Date(evidence.attachedAt).toISOString()).toBe(evidence.attachedAt);
      expect(evidence.attachedAt >= attachedAt).toBe(true);
      expect(
        world.calls
          .filter((call) => call.kind === "modal.setup.create" || call.kind === "modal.image.build")
          .every((call) => !JSON.stringify(call.detail).includes("dataset-access")),
      ).toBe(true);
      expect(attached[0]?.mounts).toEqual([
        {
          volume: "datasets",
          source: nativeSource,
          prefix: "prefix/",
          path: "/mnt/datasets",
          strategy: "mount",
          access: "read-only",
          attachedAt: expect.any(String),
        },
      ]);
      expect(timeline).toEqual([
        "provider.start",
        "provider.attached",
        "event.attached",
        "harness.start",
      ]);
      expect(events.at(-1)?.type).toBe("execution.completed");
    }
    expect(resolver.liveMountsForAttempt(spec.attemptId)).toEqual([]);
  },
  30_000,
);
