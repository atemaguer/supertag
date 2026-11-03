import { expect, it, vi } from "vitest";
import {
  ExecutionAdmissionRejectedError,
  ExecutionNotAcceptedError,
  executeWorkletAttempt,
} from "../packages/control-plane/src/durable-execution.js";
import { emptyTagContextPlan } from "../packages/core/src/index.js";
import type {
  DurableWorklet,
  TaskAttemptEvent,
  TaskAttemptSpec,
} from "../packages/runtime/sdk/src/index.js";

it("resumes a disconnected event observer from its cursor without accepting execution again", async () => {
  const at = new Date().toISOString();
  const workerProfile = { id: "test", revision: "1" };
  const tag = { id: "tag", name: "Tag", workerProfile };
  const spec: TaskAttemptSpec = {
    execution: {},
    version: 1,
    taskId: "task",
    attemptId: "attempt",
    tag,
    workerProfile,
    contextPlan: emptyTagContextPlan(at),
    workspacePlan: { version: 1, status: "none" },
    authorization: {
      version: 5,
      capturedAt: at,
      tag,
      origin: {
        tagRouteId: "route",
        surfaceAccountId: "account",
        provider: "slack",
        scope: "channel:test",
      },
      requester: { id: "user", kind: "user" },
      permissionSets: [],
      resources: [],
      runtimeActions: [],
    },
    input: {
      origin: {
        surface: "slack",
        accountId: "account",
        scope: "channel:test",
        sessionKey: "session",
        occurredAt: at,
      },
      messages: [],
    },
  };
  const identity = { taskId: spec.taskId, attemptId: spec.attemptId, at: new Date().toISOString() };
  const first: TaskAttemptEvent = { ...identity, type: "execution.started", workerId: "worker" };
  const last: TaskAttemptEvent = { ...identity, type: "execution.completed" };
  const receipt = {
    taskId: spec.taskId,
    attemptId: spec.attemptId,
    specDigest: "digest",
    status: "completed" as const,
  };
  const accept = vi.fn(async () => receipt);
  const cursors: number[] = [];
  const worklet: DurableWorklet = {
    id: "durable",
    describe: async () => ({
      id: "durable",
      protocolVersion: 1,
      host: { id: "host", workers: [] },
    }),
    accept,
    inspect: async () => ({ ...receipt, lastSequence: 2 }),
    cancel: async () => ({ ...receipt, lastSequence: 2 }),
    execute() {
      throw new Error("Legacy execution must not be used");
    },
    async *events(_attemptId, after = 0) {
      cursors.push(after);
      if (after === 0) {
        yield { sequence: 1, event: first };
        throw new Error("Connection lost");
      }
      yield { sequence: 2, event: last };
    },
  };
  const alreadyAborted = new AbortController();
  alreadyAborted.abort();
  await expect(
    executeWorkletAttempt(worklet, spec, alreadyAborted.signal, true)
      [Symbol.asyncIterator]()
      .next(),
  ).rejects.toBeInstanceOf(ExecutionNotAcceptedError);
  expect(accept).not.toHaveBeenCalled();
  const rejectedBeforeAdmission: DurableWorklet = {
    ...worklet,
    accept: async () => {
      throw new Error("No eligible Worker capacity");
    },
    inspect: async () => undefined,
  };
  await expect(
    executeWorkletAttempt(rejectedBeforeAdmission, spec, new AbortController().signal, true)
      [Symbol.asyncIterator]()
      .next(),
  ).rejects.toBeInstanceOf(ExecutionAdmissionRejectedError);
  const observed = [];
  for await (const event of executeWorkletAttempt(worklet, spec, new AbortController().signal))
    observed.push(event);
  expect(observed).toEqual([first, last]);
  expect(cursors).toEqual([0, 1]);
  expect(accept).toHaveBeenCalledOnce();

  // The initial acceptance adapter distinguishes shutdown detachment from
  // an explicit execution-authority cancellation.
  for (const cancelOnAbort of [false, true]) {
    const abort = new AbortController();
    const cancel = vi.fn(async () => ({ ...receipt, lastSequence: 1 }));
    const running: DurableWorklet = {
      ...worklet,
      cancel,
      async *events() {
        yield { sequence: 1, event: first };
        abort.abort(new Error("Observer stopped"));
        abort.signal.throwIfAborted();
      },
    };
    const consume = async () => {
      for await (const _event of executeWorkletAttempt(
        running,
        spec,
        abort.signal,
        true,
        undefined,
        () => cancelOnAbort,
      )) {
        /* consume until abort */
      }
    };
    await expect(consume()).rejects.toThrow("Observer stopped");
    expect(cancel).toHaveBeenCalledTimes(cancelOnAbort ? 1 : 0);
  }
});
