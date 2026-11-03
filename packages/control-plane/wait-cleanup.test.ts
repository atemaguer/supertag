import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Store } from "@supertag/core";
import type { AttemptInspection, AttemptJournalEvent, DurableWorklet } from "@supertag/worker-sdk";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DrizzleStore, FileGatewayCredentialVault, migrateDatabase } from "../store/src/index.js";
import { ControlPlane } from "./src/index.js";
import { confirmWaitCleanup } from "./src/wait-cleanup.js";

function fixture() {
  const receipt = (status: AttemptInspection["status"]): AttemptInspection => ({
    taskId: "task",
    attemptId: "attempt",
    specDigest: "digest",
    lastSequence: 1,
    status,
  });
  const cancel = vi.fn<DurableWorklet["cancel"]>().mockResolvedValue(receipt("running"));
  const inspect = vi.fn<DurableWorklet["inspect"]>().mockResolvedValue(receipt("running"));
  const events = vi.fn<DurableWorklet["events"]>(async function* () {});
  const listTaskEvents = vi.fn<Store["listTaskEvents"]>().mockResolvedValue([
    {
      id: "saved",
      taskId: "task",
      attemptId: "attempt",
      sequence: 1,
      type: "execution.started",
      payload: { journalSequence: 1 },
      createdAt: "2030-01-01T00:00:00.000Z",
    },
  ]);
  const appendTaskAssignmentJournalEvent = vi.fn<Store["appendTaskAssignmentJournalEvent"]>();
  const settleTaskAssignment = vi.fn<Store["settleTaskAssignment"]>();
  const appendTaskEvent = vi.fn<Store["appendTaskEvent"]>();
  const withdrawTeamLiveDelivery = vi.fn<Store["withdrawTeamLiveDelivery"]>();
  const withdrawInboundControlDelivery = vi.fn<Store["withdrawInboundControlDelivery"]>();
  const onError = vi.fn();
  const isStopping = vi.fn(() => false);
  return {
    appendTaskEvent,
    withdrawTeamLiveDelivery,
    withdrawInboundControlDelivery,
    receipt,
    cancel,
    inspect,
    events,
    listTaskEvents,
    appendTaskAssignmentJournalEvent,
    settleTaskAssignment,
    onError,
    isStopping,
    input: {
      durable: { cancel, events, inspect },
      store: {
        appendTaskAssignmentJournalEvent,
        listTaskEvents,
        settleTaskAssignment,
        appendTaskEvent,
        withdrawTeamLiveDelivery,
        withdrawInboundControlDelivery,
      },
      task: { taskId: "task", attemptCount: 3 },
      attemptId: "attempt",
      leaseOwner: "owner",
      isStopping,
      onError,
    },
  };
}

afterEach(() => vi.useRealTimers());

describe("durable wait cleanup proof", () => {
  it.each(["completed", "failed", "cancelled"] as const)(
    "settles a wait only after %s cleanup evidence with the existing fence",
    async (status) => {
      vi.useFakeTimers();
      const f = fixture();
      f.inspect.mockResolvedValueOnce(f.receipt("running")).mockResolvedValue(f.receipt(status));
      const outcome = confirmWaitCleanup(f.input);
      await vi.advanceTimersByTimeAsync(0);
      expect(f.settleTaskAssignment).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(50);
      expect(await outcome).toBe("settled");
      expect(f.settleTaskAssignment).toHaveBeenCalledExactlyOnceWith({
        taskId: "task",
        leaseOwner: "owner",
        attemptCount: 3,
        result: { text: "Execution suspended until its durable wait condition is satisfied" },
        terminalAttempt: { id: "attempt", status },
      });
    },
  );

  it("leaves absent cleanup evidence recoverable after the deadline", async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.inspect.mockRejectedValue(new Error("Host unavailable"));
    const outcome = confirmWaitCleanup(f.input);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(await outcome).toBe("recoverable");
    expect(f.settleTaskAssignment).not.toHaveBeenCalled();
    expect(f.cancel).toHaveBeenCalledTimes(1);
  });

  it("requests cancellation but skips polling if its caller is stopping", async () => {
    const f = fixture();
    f.isStopping.mockReturnValue(true);
    expect(await confirmWaitCleanup(f.input)).toBe("recoverable");
    expect(f.cancel).toHaveBeenCalledExactlyOnceWith(
      "attempt",
      "Execution registered a durable wait",
    );
    expect(f.inspect).not.toHaveBeenCalled();
    expect(f.settleTaskAssignment).not.toHaveBeenCalled();
  });

  it("does not turn a rejected settlement into permission to restart", async () => {
    const f = fixture();
    const failure = new Error("Lease lost");
    f.inspect.mockResolvedValue(f.receipt("cancelled"));
    f.settleTaskAssignment.mockRejectedValue(failure);
    expect(await confirmWaitCleanup(f.input)).toBe("recoverable");
    expect(f.onError).toHaveBeenCalledExactlyOnceWith(failure);
    expect(f.settleTaskAssignment).toHaveBeenCalledTimes(1);
  });

  it("can use terminal proof even when the cancellation acknowledgement was lost", async () => {
    const f = fixture();
    const failure = new Error("Cancellation acknowledgement lost");
    f.cancel.mockRejectedValue(failure);
    f.inspect.mockResolvedValue(f.receipt("cancelled"));
    expect(await confirmWaitCleanup(f.input)).toBe("settled");
    expect(f.onError).toHaveBeenCalledExactlyOnceWith(failure);
  });

  it("persists the final journal tail before settling a cancelled wait", async () => {
    const f = fixture();
    const identity = {
      taskId: "task",
      attemptId: "attempt",
      at: "2030-01-01T00:00:00.000Z",
    };
    f.inspect.mockResolvedValue({ ...f.receipt("cancelled"), lastSequence: 3 });
    f.listTaskEvents.mockResolvedValue([
      {
        id: "saved",
        taskId: "task",
        attemptId: "attempt",
        sequence: 1,
        type: "execution.limits.applied",
        payload: { journalSequence: 1 },
        createdAt: identity.at,
      },
    ]);
    f.events.mockImplementation(async function* () {
      const tail: AttemptJournalEvent[] = [
        {
          sequence: 2,
          event: {
            ...identity,
            type: "usage.updated",
            usage: {
              inputTokens: 20,
              outputTokens: 10,
              cachedInputTokens: 0,
              totalTokens: 30,
              complete: true,
              reportedCost: { amountMinor: 25, currency: "USD" },
            },
          },
        },
        { sequence: 3, event: { ...identity, type: "execution.completed" } },
      ];
      yield* tail;
    });

    expect(await confirmWaitCleanup(f.input)).toBe("settled");
    expect(f.events).toHaveBeenCalledWith("attempt", 1, expect.any(AbortSignal));
    expect(f.appendTaskAssignmentJournalEvent).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ sequence: 2, type: "usage.updated" }),
    );
    expect(f.appendTaskAssignmentJournalEvent).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ sequence: 3, type: "execution.completed" }),
    );
    expect(f.appendTaskAssignmentJournalEvent.mock.invocationCallOrder[1]).toBeLessThan(
      f.settleTaskAssignment.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it("keeps a wait recoverable when its terminal journal tail has a gap", async () => {
    const f = fixture();
    f.inspect.mockResolvedValue({ ...f.receipt("cancelled"), lastSequence: 2 });
    f.listTaskEvents.mockResolvedValue([]);
    f.events.mockImplementation(async function* () {
      yield {
        sequence: 2,
        event: {
          taskId: "task",
          attemptId: "attempt",
          at: "2030-01-01T00:00:00.000Z",
          type: "execution.completed" as const,
        },
      };
    });

    expect(await confirmWaitCleanup(f.input)).toBe("recoverable");
    expect(f.appendTaskAssignmentJournalEvent).not.toHaveBeenCalled();
    expect(f.settleTaskAssignment).not.toHaveBeenCalled();
    expect(f.onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.any(String) }),
    );
  });

  it("keeps a wait recoverable when its saved journal prefix has a gap", async () => {
    const f = fixture();
    f.inspect.mockResolvedValue({ ...f.receipt("cancelled"), lastSequence: 3 });
    f.listTaskEvents.mockResolvedValue([
      {
        id: "saved-1",
        taskId: "task",
        attemptId: "attempt",
        sequence: 1,
        type: "execution.started",
        payload: { journalSequence: 1 },
        createdAt: "2030-01-01T00:00:00.000Z",
      },
      {
        id: "saved-3",
        taskId: "task",
        attemptId: "attempt",
        sequence: 2,
        type: "execution.completed",
        payload: { journalSequence: 3 },
        createdAt: "2030-01-01T00:00:01.000Z",
      },
    ]);

    expect(await confirmWaitCleanup(f.input)).toBe("recoverable");
    expect(f.events).not.toHaveBeenCalled();
    expect(f.settleTaskAssignment).not.toHaveBeenCalled();
    expect(f.onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Wait cleanup saved journal prefix is not contiguous" }),
    );
  });
});

it("does not resume a registered wait after cleanup leaves the execution outcome unknown", async () => {
  const f = fixture();
  f.inspect.mockResolvedValue(f.receipt("failed"));
  f.listTaskEvents.mockResolvedValue([
    {
      id: "saved",
      taskId: "task",
      attemptId: "attempt",
      sequence: 1,
      type: "execution.failed",
      createdAt: "2030-01-01T00:00:00.000Z",
      payload: {
        journalSequence: 1,
        error: {
          name: "InterruptedExecutionOutcomeUnknown",
          message: "Cleanup confirmed; outcome unknown",
        },
      },
    },
  ]);
  expect(await confirmWaitCleanup(f.input)).toBe("settled");
  expect(f.settleTaskAssignment).toHaveBeenCalledWith(
    expect.objectContaining({
      failed: true,
      result: { error: "Cleanup confirmed; outcome unknown" },
    }),
  );
});

it.each(["team-input", "session-input"])(
  "retries %s withdrawals before advancing the cleanup cursor",
  async (prefix) => {
    const f = fixture();
    f.inspect.mockResolvedValue({ ...f.receipt("cancelled"), lastSequence: 2 });
    f.events.mockImplementation(async function* () {
      yield {
        sequence: 2,
        event: {
          type: "input.withdrawn",
          taskId: "task",
          attemptId: "attempt",
          at: "2030-01-01T00:00:00.000Z",
          commandId: `${prefix}:input-id`,
          reason: "Unread",
        },
      };
    });
    const withdraw =
      prefix === "team-input" ? f.withdrawTeamLiveDelivery : f.withdrawInboundControlDelivery;
    const failure = new Error("Store unavailable");
    withdraw.mockRejectedValueOnce(failure);
    expect(await confirmWaitCleanup(f.input)).toBe("recoverable");
    expect(f.onError).toHaveBeenCalledWith(failure);
    expect(f.appendTaskAssignmentJournalEvent).not.toHaveBeenCalled();
    expect(f.settleTaskAssignment).not.toHaveBeenCalled();
    expect(await confirmWaitCleanup(f.input)).toBe("settled");
    expect(withdraw).toHaveBeenCalledTimes(2);
    expect(withdraw).toHaveBeenLastCalledWith({
      ...(prefix === "team-input" ? { id: "input-id" } : { inboundEventId: "input-id" }),
      taskId: "task",
      attemptId: "attempt",
    });
  },
);

it("wakes the surface scheduler after wait cleanup returns operator input to pending", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wait-cleanup-wake-"));
  const path = join(directory, "state.db");
  const url = `file:${path}`;
  await migrateDatabase({ url });
  const store = new DrizzleStore({ url });
  const onError = vi.fn();
  const executed: string[] = [];
  const worklet: import("@supertag/worker-sdk").Worklet = {
    id: "worklet",
    describe: async () => ({
      id: "worklet",
      protocolVersion: 1,
      host: {
        id: "host",
        workers: [
          {
            id: "worker",
            type: "deterministic",
            profiles: [{ id: "default", revision: "1" }],
            profileCapabilities: [
              {
                profile: { id: "default", revision: "1" },
                capabilities: [],
                contextTypes: [],
              },
            ],
            capabilities: [],
            contextTypes: [],
            maxConcurrency: 2,
          },
        ],
      },
    }),
    async *execute(spec) {
      executed.push(spec.taskId);
      yield {
        taskId: spec.taskId,
        attemptId: spec.attemptId,
        at: new Date().toISOString(),
        type: "output.message",
        message: { role: "teammate", text: "Inspected the tests" },
      };
      yield {
        taskId: spec.taskId,
        attemptId: spec.attemptId,
        at: new Date().toISOString(),
        type: "execution.completed",
      };
    },
  };
  const plane = new ControlPlane({
    store,
    worklet,
    credentialVault: new FileGatewayCredentialVault(join(directory, "vault.json")),
    reply: async () => ({ externalMessageId: "reply" }),
    dispatch: { pollIntervalMs: 60_000, onDispatchError: onError },
  });
  try {
    await store.connect();
    const tag = await store.createTag({ name: "Builder" });
    // Hold dispatch during receipt setup; restore real selection before cleanup.
    const peek = vi.spyOn(store, "peekNextInboundEvent").mockResolvedValue(undefined);
    await store.bindTagWorkerHost(tag.id, "host");
    await plane.start();
    const account = await plane.setupSurfaceAccount({
      provider: "slack",
      externalAccountId: "T1",
      displayName: "Fixture",
      authMethod: "slack-socket-mode",
      configuration: { transport: "socket" },
      secrets: { botToken: "xoxb-test", appToken: "xapp-test" },
    });
    await store.addTagRoute({ tagId: tag.id, surfaceAccountId: account.id, scope: "channel:C1" });
    const admitted = await plane.ingestSurfaceEvent({
      eventId: "operator-input",
      logicalEventId: "operator-input",
      provider: "slack",
      externalAccountId: "T1",
      kind: "mention",
      scope: "channel:C1",
      sessionKey: "T1:C1:thread",
      actor: { id: "U1", kind: "user" },
      text: "Also inspect the tests",
      occurredAt: new Date().toISOString(),
      callback: {
        provider: "slack",
        mode: "slack_thread",
        threadKey: "T1:C1:thread",
        target: { channelId: "C1", threadTs: "1.000" },
      },
      source: {},
      metadata: {},
    });
    if (admitted.status !== "accepted") throw new Error("Missing follower");
    const follower = await store.findTaskById(admitted.taskId);
    if (!follower?.inboundEventId) throw new Error("Missing inbound event");
    const objective = await store.createObjective({
      id: "objective",
      ownerTagId: tag.id,
      outcome: "Work",
      runtimeActions: [],
    });
    const team = await store.createTeam({
      id: "team",
      objectiveId: objective.id,
      name: "Build",
      leadTagId: tag.id,
      memberTagIds: [],
    });
    const assigned = (await plane.objectives.command("assign_task", {
      objectiveId: objective.id,
      teamId: team.id,
      taskId: "waiting-task",
      assignedTagId: tag.id,
      instruction: "Work",
      acceptanceCriteria: ["Done"],
    })) as import("@supertag/core").TaskAssignment;
    const leaseOwner = plane.objectives["instanceId"];
    const task = await store.claimTaskAssignment({ taskId: assigned.taskId, leaseOwner });
    if (!task) throw new Error("Missing assignment lease");
    const attempt = await store.createTaskAttempt({
      taskId: task.taskId,
      attemptNumber: task.attemptCount,
      workerProfile: { id: "default", revision: "1" },
      workerSnapshot: { durableExecution: true },
      startedAt: new Date().toISOString(),
    });
    await store.startTask({ taskId: task.taskId, startedAt: new Date().toISOString() });
    await store.registerTaskAssignmentWait({
      taskId: task.taskId,
      leaseOwner,
      attemptCount: task.attemptCount,
      notBefore: new Date(Date.now() + 120_000).toISOString(),
    });
    // Seed the persisted delivery receipt; acknowledgement settlement, withdrawal,
    // journal ingestion, wait settlement, and follower scheduling use the real store.
    const commandId = `session-input:${follower.inboundEventId}`;
    const db = new Database(path);
    try {
      db.prepare(
        'INSERT INTO "InboundControlDelivery" ("inboundEventId", "taskId", "attemptId", "command", "status", "createdAt", "updatedAt") VALUES (?, ?, ?, ?, ?, ?, ?)',
      ).run(
        follower.inboundEventId,
        task.taskId,
        attempt.id,
        JSON.stringify({ id: commandId }),
        "dispatching",
        new Date().toISOString(),
        new Date().toISOString(),
      );
    } finally {
      db.close();
    }
    await store.finishInboundControlDelivery({
      inboundEventId: follower.inboundEventId,
      status: "accepted",
    });
    expect((await store.findTaskById(follower.id))?.status).toBe("completed");

    await vi.waitFor(() => expect(peek).toHaveBeenCalled());
    // The scheduler has observed no pending input and is sleeping for 60 seconds.
    await vi.waitFor(async () => expect(await peek.mock.results.at(-1)?.value).toBeUndefined());
    peek.mockRestore();
    const receipt: AttemptInspection = {
      taskId: task.taskId,
      attemptId: attempt.id,
      specDigest: "digest",
      status: "cancelled",
      lastSequence: 1,
    };
    let pendingAtWake: string | undefined;
    const wakeTaskController = async () => {
      pendingAtWake = (await store.findTaskById(follower.id))?.status;
      plane.objectives["wakeTaskController"]?.();
    };
    expect(
      await confirmWaitCleanup({
        durable: {
          cancel: async () => receipt,
          inspect: async () => receipt,
          events: async function* () {
            yield {
              sequence: 1,
              event: {
                type: "input.withdrawn",
                taskId: task.taskId,
                attemptId: attempt.id,
                at: new Date().toISOString(),
                commandId,
              },
            };
          },
        },
        store,
        task,
        attemptId: attempt.id,
        leaseOwner,
        isStopping: () => false,
        onError,
        wakeTaskController,
      }),
    ).toBe("settled");
    await vi.waitFor(() => expect(executed).toEqual([follower.id]), { timeout: 2_000 });
    expect(pendingAtWake).toBe("pending");
    expect((await store.getTaskAssignment(task.taskId))?.status).toBe("waiting");
    expect(await store.findInboundControlDelivery(follower.inboundEventId)).toMatchObject({
      status: "withdrawn",
    });
    expect(onError).not.toHaveBeenCalled();
  } finally {
    await plane.stop();
    await store.disconnect();
    await rm(directory, { recursive: true, force: true });
  }
}, 10_000);
