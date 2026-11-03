import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CapturedArtifactEntry, emptyTagContextPlan } from "@supertag/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type ArtifactStore,
  collectTaskAttemptEvents,
  createWorker,
  type ExecutionEnvironmentProvider,
  type Harness,
  LocalExecutionEnvironmentProvider,
  TASK_OUTPUT_POLICY_CAPABILITY,
  type TaskAttemptSpec,
  terminalTaskResult,
} from "./src/index.js";

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function attempt(): TaskAttemptSpec {
  const capturedAt = "2026-09-16T00:00:00.000Z";
  return {
    version: 2,
    taskId: "task-1",
    attemptId: "attempt-1",
    tag: { id: "tag-1", name: "Research" },
    input: {
      origin: {
        surface: "slack",
        accountId: "account",
        scope: "channel",
        sessionKey: "session",
        occurredAt: capturedAt,
      },
      messages: [],
    },
    authorization: {
      version: 5,
      capturedAt,
      tag: { id: "tag-1", name: "Research" },
      origin: {
        tagRouteId: "route",
        surfaceAccountId: "account",
        provider: "slack",
        scope: "channel",
      },
      requester: { id: "human", kind: "user" },
      permissionSets: [],
      resources: [],
      runtimeActions: ["files:write"],
    },
    contextPlan: emptyTagContextPlan(capturedAt),
    workspacePlan: { version: 1, status: "none" },
    workerProfile: { id: "test", revision: "1" },
    execution: {},
    coordination: {
      controlPlaneUrl: "https://catalog.example",
      token: "attempt-token",
      scope: "surface",
    },
  };
}

async function fixture(
  id: string,
  supported = true,
  nativeId: string | undefined = "native-conversation",
) {
  const root = await mkdtemp(join(tmpdir(), "managed-output-worker-"));
  roots.push(root);
  const blobs = new Map<string, Buffer>();
  const captured: {
    id: string;
    entries: CapturedArtifactEntry[];
    harnessSession?: { harnessId: string; id: string };
  }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer attempt-token");
      const endpoint = String(url).split("/").at(-1) ?? "";
      // The Control Plane takes catalog metadata only; bytes stay in this Worker Host's store.
      if (endpoint === "capture") {
        const artifact = { ...JSON.parse(String(init?.body)), id: `artifact-${captured.length}` };
        captured.push(artifact);
        return Response.json({ artifact });
      }
      throw new Error(`Unexpected request ${String(url)}`);
    }),
  );
  let environmentRoot = "";
  let outputDirectory: string | undefined;
  let instruction: string | undefined;
  let requiredPaths: readonly string[] = [];
  const harness: Harness = {
    id,
    async describe() {
      return {
        sessions: { resume: false, export: false, scope: "none" as const },
        id,
        version: "1",
        inputKinds: ["instruction", "tool"],
        toolIsolation: { managerOnly: true },
        mcpClients: [{ client: "worker-host", transports: ["worker-local"] }],
        streaming: true,
        cancellation: true,
        sessionPersistence: "none",
      };
    },
    async plan(context) {
      requiredPaths = context.attempt.execution.outputs?.required ?? [];
      expect(
        context.context.instructions.find((input) => input.id === "supertag-scratch-directory")
          ?.content,
      ).toContain("SUPERTAG_SCRATCH_DIR");
      instruction = context.context.instructions.find(
        (input) => input.id === "supertag-output-policy",
      )?.content;
      const environment = {
        files: [],
        mounts: [],
        environmentVariables: {},
        secretBindings: [],
        network: { mode: "none" as const },
      };
      return {
        runtime: environment,
        execution: environment,
        metadata: { requiredOutputPaths: ["stale-harness-path"] },
      };
    },
    async start(plan, environments) {
      let observed: { harnessId: string; id: string } | undefined;
      environmentRoot = environments.execution.rootDirectory;
      outputDirectory = plan.execution.environmentVariables["SUPERTAG_OUTPUT_DIR"];
      const scratch = plan.execution.environmentVariables["SUPERTAG_SCRATCH_DIR"];
      expect(scratch).toBe(join(environmentRoot, "scratch"));
      await access(scratch);
      expect(plan.runtime.environmentVariables["SUPERTAG_OUTPUT_DIR"]).toBe(outputDirectory);
      if (outputDirectory) expect(plan.metadata?.["requiredOutputPaths"]).toEqual(requiredPaths);
      return {
        get session() {
          return observed;
        },
        async *run() {
          observed = nativeId ? { harnessId: id, id: nativeId } : undefined;
          if (outputDirectory) {
            // Preparation belongs to the Worker; the Harness only writes a deliverable.
            await access(join(environmentRoot, outputDirectory));
            await writeFile(
              join(environmentRoot, outputDirectory, "report.md"),
              "Reusable research",
            );
          }
          await mkdir(join(environmentRoot, "workspace"), { recursive: true });
          await writeFile(join(environmentRoot, "workspace", "source.ts"), "Repository change");
          yield { type: "output.message" as const, text: "Completed" };
        },
        async close() {},
      };
    },
  };
  const local = new LocalExecutionEnvironmentProvider({ temporaryDirectory: root });
  const environment: ExecutionEnvironmentProvider = supported
    ? local
    : {
        id: local.id,
        capabilities: [
          ...local.capabilities.filter(
            (capability) => capability.id !== "supertag.environment.output-files",
          ),
          TASK_OUTPUT_POLICY_CAPABILITY,
        ],
        provision: local.provision.bind(local),
      };
  // This Worker Host's own copies, keyed by digest.
  const hostStore: ArtifactStore = {
    async put({ bytes }) {
      const hex = createHash("sha256").update(bytes).digest("hex");
      blobs.set(hex, Buffer.from(bytes));
      return { uri: `supertag-artifact:sha256:${hex}`, digest: `sha256:${hex}` };
    },
    async get(ref) {
      const bytes = blobs.get(ref.digest?.slice("sha256:".length) ?? "");
      if (!bytes) throw Object.assign(new Error("Artifact is not stored"), { code: "ENOENT" });
      return bytes;
    },
  };
  const worker = createWorker({
    id: "managed-worker",
    outputJournalDirectory: join(root, "journal"),
    artifactStore: hostStore,
    profiles: [
      {
        ref: { id: "test", revision: "1" },
        workerType: "supertag",
        harness: { provider: id },
        execution: { provider: local.id, lifetime: { scope: "attempt" } },
      },
    ],
    harnesses: [harness],
    environments: [environment],
  });
  return {
    worker,
    captured,
    blobs,
    state: () => ({ environmentRoot, outputDirectory, instruction }),
  };
}

describe("Worker-managed deliverable directory", () => {
  it.each(["codex", "claude-code"])(
    "captures %s deliverables without an explicit output policy",
    async (id) => {
      const f = await fixture(id);
      const spec = attempt();
      const events = await collectTaskAttemptEvents(f.worker.execute(spec));
      expect(events.at(-1), JSON.stringify(events)).toMatchObject({ type: "execution.completed" });
      const { environmentRoot, outputDirectory, instruction } = f.state();
      expect(outputDirectory).toMatch(/^outputs\/[a-f0-9]{64}$/);
      expect(instruction).toContain(`${outputDirectory}/`);
      expect(spec.execution.outputs).toBeUndefined();
      expect(f.captured).toHaveLength(1);
      expect(f.captured[0]?.harnessSession).toEqual({ harnessId: id, id: "native-conversation" });
      expect(f.captured[0]?.entries.map((entry) => entry.path)).toEqual([
        `${outputDirectory}/report.md`,
      ]);
      expect([...f.blobs.values()].map((bytes) => bytes.toString())).toEqual(["Reusable research"]);
      expect(terminalTaskResult(events)?.artifacts).toEqual([
        { artifactId: "artifact-0", paths: [`${outputDirectory}/report.md`] },
      ]);
      await expect(access(environmentRoot)).rejects.toThrow();
    },
  );

  it("uses an explicit output policy instead of the managed default", async () => {
    const f = await fixture("codex");
    const events = await collectTaskAttemptEvents(
      f.worker.execute({
        ...attempt(),
        execution: { outputs: { directory: "deliverables", required: ["deliverables/report.md"] } },
      }),
    );
    expect(events.at(-1), JSON.stringify(events)).toMatchObject({ type: "execution.completed" });
    expect(f.state().outputDirectory).toBe("deliverables");
    expect(f.captured[0]?.entries.map((entry) => entry.path)).toEqual(["deliverables/report.md"]);
    expect(f.captured[0]?.harnessSession).toEqual({
      harnessId: "codex",
      id: "native-conversation",
    });
  });

  it("leaves native provenance absent when no conversation identity was observed", async () => {
    const f = await fixture("codex", true, "");
    const events = await collectTaskAttemptEvents(f.worker.execute(attempt()));
    expect(events.at(-1)).toMatchObject({ type: "execution.completed" });
    expect(f.captured).toHaveLength(1);
    expect(f.captured[0]?.harnessSession).toBeUndefined();
  });

  it("rejects a malformed identity first reported during execution", async () => {
    const f = await fixture("codex", true, " ");
    const events = await collectTaskAttemptEvents(f.worker.execute(attempt()));
    expect(events.at(-1)).toMatchObject({ type: "execution.failed" });
    expect(f.captured).toHaveLength(0);
  });

  it.each(["custom-harness", "no-write-permission", "no-catalog", "unsupported-environment"])(
    "does not enable implicit collection for %s",
    async (condition) => {
      const f = await fixture(
        condition === "custom-harness" ? "custom" : "codex",
        condition !== "unsupported-environment",
      );
      const original = attempt();
      const { coordination: _coordination, ...withoutCatalog } = original;
      const spec =
        condition === "no-catalog"
          ? withoutCatalog
          : condition === "no-write-permission"
            ? { ...original, authorization: { ...original.authorization, runtimeActions: [] } }
            : original;
      if (condition === "unsupported-environment")
        expect((await f.worker.describe()).capabilities).not.toContainEqual(
          TASK_OUTPUT_POLICY_CAPABILITY,
        );
      const events = await collectTaskAttemptEvents(f.worker.execute(spec));
      expect(events.at(-1), JSON.stringify(events)).toMatchObject({ type: "execution.completed" });
      expect(f.state().outputDirectory).toBeUndefined();
      expect(f.state().instruction).toBeUndefined();
      expect(f.captured).toEqual([]);
    },
  );
});
