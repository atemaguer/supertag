import type { Store, TaskAssignment, TaskAttempt } from "@supertag/core";
import type { DurableWorklet } from "@supertag/worker-sdk";
import { expect, it, vi } from "vitest";
import { inspectCancelledAttempt } from "./src/cancelled-attempt.js";
import { ObjectiveController } from "./src/objective-controller.js";

const attempt = {
  id: "attempt-1",
  workerSnapshot: {
    durableExecution: true,
    placement: { workerHostId: "host-1", workletId: "worklet-1" },
  },
} as unknown as TaskAttempt;

it("confirms absence only on the selected Worklet", async () => {
  const inspect = vi.fn().mockResolvedValue(undefined);
  const inspectOnHost = vi.fn().mockResolvedValue(undefined);
  const durable = { inspect, inspectOnHost } as unknown as DurableWorklet;
  expect(await inspectCancelledAttempt(durable, attempt)).toEqual({
    receipt: undefined,
    absenceConfirmed: true,
  });
  expect(inspectOnHost).toHaveBeenCalledWith("attempt-1", "host-1", "worklet-1");
  expect(inspect).not.toHaveBeenCalled();
});

it("keeps a missing unbound receipt uncertain", async () => {
  const inspect = vi.fn().mockResolvedValue(undefined);
  const durable = { inspect } as unknown as DurableWorklet;
  expect(await inspectCancelledAttempt(durable, { ...attempt, workerSnapshot: {} })).toEqual({
    receipt: undefined,
    absenceConfirmed: false,
  });
});

it("does not treat an unavailable selected Worklet as proof of non-admission", async () => {
  const durable = {
    inspectOnHost: vi.fn().mockRejectedValue(new Error("Selected durable Worklet unavailable")),
  } as unknown as DurableWorklet;
  await expect(inspectCancelledAttempt(durable, attempt)).rejects.toThrow(
    "Selected durable Worklet unavailable",
  );
});

it("closes a cancelled Attempt and frees its slot after selected Worklet non-admission", async () => {
  const appendTaskEvent = vi.fn().mockResolvedValue({});
  const closeTaskAttempt = vi.fn().mockResolvedValue({});
  const store = {
    listTaskAttempts: vi
      .fn()
      .mockResolvedValue([{ ...attempt, status: "running", attemptNumber: 1 }]),
    appendTaskEvent,
    closeTaskAttempt,
  } as unknown as Store;
  const worklet = {
    inspect: vi.fn(),
    inspectOnHost: vi.fn().mockResolvedValue(undefined),
    cancel: vi.fn(),
  } as unknown as DurableWorklet;
  const controller = new ObjectiveController(store, worklet);
  await controller["reconcileCancelledAttempt"]({
    taskId: "task-1",
    attemptCount: 1,
    status: "cancelled",
  } as TaskAssignment);
  expect(appendTaskEvent).toHaveBeenCalledWith({
    taskId: "task-1",
    attemptId: "attempt-1",
    type: "task.cancellation-cleanup-confirmed",
    payload: { version: 1, receiptStatus: "not-started" },
  });
  expect(closeTaskAttempt).toHaveBeenCalledWith({
    attemptId: "attempt-1",
    status: "cancelled",
    endedAt: expect.any(String),
  });
  expect(worklet.cancel).not.toHaveBeenCalled();
});
