import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { emptyTagContextPlan, type TagAuthorizationSnapshot } from "../packages/core/src/index.ts";
import {
  DurableLocalWorklet,
  FileAttemptJournal,
  LocalWorklet,
  type TaskAttemptEvent,
  type TaskAttemptSpec,
  type Worker,
} from "../packages/runtime/sdk/src/index.ts";

test("native usage and child activity survive durable restart and cursor replay without execution replay", async () => {
  const directory = await mkdtemp(join(tmpdir(), "native-events-"));
  let executions = 0;
  const spec = taskAttemptSpec();
  const base = { taskId: spec.taskId, attemptId: spec.attemptId, at: "2026-09-07T00:00:00.000Z" };
  const updates: TaskAttemptEvent[] = [
    { ...base, type: "agent.updated", agent: { id: "parent", status: "running" } },
    {
      ...base,
      type: "agent.updated",
      agent: { id: "child", parentId: "parent", status: "running" },
    },
    {
      ...base,
      type: "usage.updated",
      usage: {
        inputTokens: 12,
        outputTokens: 8,
        cachedInputTokens: 4,
        totalTokens: 20,
        complete: false,
      },
    },
    {
      ...base,
      type: "agent.updated",
      agent: { id: "child", parentId: "parent", status: "completed" },
    },
    {
      ...base,
      type: "usage.updated",
      usage: {
        inputTokens: 30,
        outputTokens: 10,
        cachedInputTokens: 7,
        totalTokens: 40,
        complete: true,
      },
    },
  ];
  const worker: Worker = {
    async describe() {
      return {
        profileCapabilities: [{ profile: spec.workerProfile, capabilities: [], contextTypes: [] }],
        id: "worker",
        type: "test",
        profiles: [spec.workerProfile],
        capabilities: [],
        contextTypes: [],
        maxConcurrency: 1,
      };
    },
    async *execute() {
      executions++;
      yield* updates;
      yield {
        ...base,
        type: "usage.updated",
        usage: {
          // Extra fields are journaled (and redacted); a known field of the wrong type is not.
          inputTokens: 5,
          outputTokens: 0,
          cachedInputTokens: 0,
          totalTokens: 0,
          complete: false,
          apiToken: "secret-value",
          nested: { inputTokens: 123 },
        },
      } as unknown as TaskAttemptEvent;
      yield { ...base, type: "execution.completed", result: { summary: "Done" } };
    },
  };
  const local = new LocalWorklet("local", "host", [worker]);
  let durable = new DurableLocalWorklet(local, new FileAttemptJournal(directory));
  try {
    await durable.accept(spec);
    const original = [];
    for await (const event of durable.events(spec.attemptId)) original.push(event);
    expect(original.slice(0, 5).map((entry) => entry.event)).toEqual(updates);
    await durable.close();
    durable = new DurableLocalWorklet(local, new FileAttemptJournal(directory));
    const replay = [];
    for await (const event of durable.events(spec.attemptId, 2)) replay.push(event);
    expect(replay).toEqual(original.slice(2));
    expect(replay[3]?.event).toMatchObject({
      type: "usage.updated",
      usage: {
        inputTokens: 5,
        outputTokens: 0,
        apiToken: "[REDACTED]",
        nested: { inputTokens: "[REDACTED]" },
      },
    });
    await durable.accept(spec);
    expect(executions).toBe(1);
    expect(replay[0]?.event).toMatchObject({
      type: "usage.updated",
      usage: { complete: false, totalTokens: 20 },
    });
    expect(replay[2]?.event).toMatchObject({
      type: "usage.updated",
      usage: { complete: true, totalTokens: 40 },
    });
  } finally {
    await durable.close();
    await rm(directory, { recursive: true, force: true });
  }
});
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
    execution: {},
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
    workerProfile,
  };
}
