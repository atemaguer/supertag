import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emptyTagContextPlan, type TagAuthorizationSnapshot } from "@supertag/core";
import { expect, it } from "vitest";
import { FileArtifactStore } from "../../../tests/support/file-artifact-store.js";
import {
  type ArtifactRef,
  collectTaskAttemptEvents,
  createWorker,
  type Harness,
  type HarnessPlan,
  LocalExecutionEnvironmentProvider,
  type TaskAttemptSpec,
} from "./src/index.js";

it("exports binary output before disposal and rematerializes it on a different Worker", async () => {
  const root = await mkdtemp(join(tmpdir(), "supertag-artifact-test-"));
  try {
    const bytes = new Uint8Array([0, 255, 128, 1, 0, 254]);
    let writerRoot = "";
    const writer: Harness = {
      id: "files",
      async describe() {
        return {
          sessions: { resume: false, export: false, scope: "none" as const },
          id: "files",
          version: "1",
          inputKinds: [],
          streaming: true,
          cancellation: true,
          sessionPersistence: "none",
        };
      },
      async plan() {
        return {
          runtime: emptyEnvironmentPlan(),
          execution: {
            ...emptyEnvironmentPlan(),
            files: [{ path: "output.bin", content: bytes }],
          },
          outputs: [{ path: "output.bin", mediaType: "application/octet-stream" }],
        };
      },
      async start(_plan, environments) {
        const environment = environments.execution;
        writerRoot = environment.rootDirectory;
        return {
          async *run() {
            yield { type: "output.message", text: "Done" };
          },
          async close() {},
        };
      },
    };
    const profile = {
      ref: { id: "static", revision: "1" },
      workerType: "files",
      harness: { provider: "files" },
      execution: { provider: "local-execution", lifetime: { scope: "attempt" as const } },
    };
    const store = new FileArtifactStore(join(root, "durable"));
    const events = await collectTaskAttemptEvents(
      createWorker({
        id: "writer",
        profiles: [profile],
        harnesses: [writer],
        environments: [new LocalExecutionEnvironmentProvider()],
        artifactStore: store,
      }).execute(taskAttemptSpec()),
    );
    expect(events.at(-1)?.type).toBe("execution.completed");
    await expect(access(writerRoot)).rejects.toThrow();
    const event = events.find((e) => e.type === "artifact.created");
    if (event?.type !== "artifact.created") throw new Error("Missing export");
    const artifact: ArtifactRef = event.artifact;
    expect(Array.from(await new FileArtifactStore(join(root, "durable")).get(artifact))).toEqual(
      Array.from(bytes),
    );
    const seed = join(root, "seed");
    await mkdir(seed);
    await writeFile(join(seed, "base.txt"), "Seed");
    const reader: Harness = {
      ...writer,
      async plan(): Promise<HarnessPlan> {
        return {
          runtime: emptyEnvironmentPlan(),
          execution: {
            ...emptyEnvironmentPlan(),
            mounts: [
              { source: { uri: `file://${seed}` }, destination: "workspace", readOnly: false },
              { source: artifact, destination: "workspace/inputs/received.bin", readOnly: true },
            ],
          },
        };
      },
      async start(_plan, environments) {
        const environment = environments.execution;
        expect(
          Array.from((await environment.readBytes?.("workspace/inputs/received.bin")) ?? []),
        ).toEqual(Array.from(bytes));
        return {
          async *run() {
            yield { type: "output.message", text: "Reviewed" };
          },
          async close() {},
        };
      },
    };
    const reviewed = await collectTaskAttemptEvents(
      createWorker({
        id: "reader",
        profiles: [profile],
        harnesses: [reader],
        environments: [new LocalExecutionEnvironmentProvider()],
        artifactStore: new FileArtifactStore(join(root, "durable")),
      }).execute(taskAttemptSpec()),
    );
    expect(reviewed.at(-1)?.type).toBe("execution.completed");
    const collision: Harness = {
      ...reader,
      async plan(context) {
        const plan = await reader.plan(context);
        return {
          ...plan,
          execution: {
            ...plan.execution,
            files: [{ path: "workspace/base.txt", content: "Overwrite" }],
          },
        };
      },
    };
    const collided = await collectTaskAttemptEvents(
      createWorker({
        id: "collision",
        profiles: [profile],
        harnesses: [collision],
        environments: [new LocalExecutionEnvironmentProvider()],
        artifactStore: store,
      }).execute(taskAttemptSpec()),
    );
    expect(collided.at(-1)?.type).toBe("execution.failed");
    const exportOnly: Harness = {
      ...writer,
      async start() {
        return { async *run() {}, async close() {} };
      },
    };
    const only = await collectTaskAttemptEvents(
      createWorker({
        id: "export-only",
        profiles: [profile],
        harnesses: [exportOnly],
        environments: [new LocalExecutionEnvironmentProvider()],
        artifactStore: store,
      }).execute(taskAttemptSpec()),
    );
    expect(only.find((event) => event.type === "result")).toMatchObject({
      result: { artifacts: [] },
    });
    const noStore = await collectTaskAttemptEvents(
      createWorker({
        id: "unconfigured",
        profiles: [profile],
        harnesses: [writer],
        environments: [new LocalExecutionEnvironmentProvider()],
      }).execute(taskAttemptSpec()),
    );
    expect(noStore.at(-1)?.type).toBe("execution.failed");
    expect(noStore.some((event) => event.type === "result")).toBe(false);
    const missing: Harness = {
      ...writer,
      async plan() {
        return {
          runtime: emptyEnvironmentPlan(),
          execution: emptyEnvironmentPlan(),
          outputs: [{ path: "missing.bin" }],
        };
      },
    };
    const failed = await collectTaskAttemptEvents(
      createWorker({
        id: "missing",
        profiles: [profile],
        harnesses: [missing],
        environments: [new LocalExecutionEnvironmentProvider()],
        artifactStore: store,
      }).execute(taskAttemptSpec()),
    );
    expect(failed.at(-1)?.type).toBe("execution.failed");
    expect(failed.some((event) => event.type === "result")).toBe(false);
    await writeFile(join(root, "durable", artifact.id), "corrupt");
    await expect(store.get(artifact)).rejects.toThrow(/digest mismatch/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function emptyEnvironmentPlan() {
  return {
    files: [],
    mounts: [],
    environmentVariables: {},
    secretBindings: [],
    network: { mode: "none" as const },
  };
}
function taskAttemptSpec(workerProfile = { id: "static", revision: "1" }): TaskAttemptSpec {
  const capturedAt = "2026-08-02T00:00:00.000Z";
  const authorization: TagAuthorizationSnapshot = {
    version: 5,
    capturedAt,
    tag: { id: "tag-1", name: "Engineering" },
    origin: {
      tagRouteId: "surface-1",
      surfaceAccountId: "account-1",
      provider: "slack",
      scope: "channel:general",
    },
    requester: { id: "user-1", kind: "user" },
    permissionSets: [{ id: "permissions-1", name: "engineering" }],
    resources: [
      {
        surfaceAccountId: "account-1",
        provider: "slack",
        scope: "channel:general",
        actions: ["history:read"],
        sources: ["permission-set"],
      },
    ],
    runtimeActions: [],
  };
  return {
    version: 1,
    taskId: "task-1",
    attemptId: "attempt-1",
    tag: { id: "tag-1", name: "Engineering" },
    input: {
      origin: {
        surface: "slack",
        accountId: "account-1",
        scope: "channel:general",
        sessionKey: "slack:account-1:general:thread-1",
        occurredAt: capturedAt,
      },
      messages: [{ id: "message-1", role: "requester", text: "How does this work?" }],
    },
    authorization,
    contextPlan: emptyTagContextPlan(capturedAt),
    execution: {},
    workerProfile,
  };
}
