import type { Store } from "@supertag/core";
import type { AttemptReceipt, DurableWorklet, TaskAttemptSpec } from "@supertag/worker-sdk";
import { expect, it, vi } from "vitest";
import { executeWorkletAttempt, recordAttemptWorkerReceipt } from "./src/durable-execution.js";

const receipt: AttemptReceipt = {
  taskId: "task",
  attemptId: "attempt",
  specDigest: "digest",
  status: "running",
  workerHostId: "selected-host",
  workletId: "selected-worklet",
  workerId: "selected-worker",
};

it("records a confirmed lost-ACK receipt before retaining the original acceptance uncertainty", async () => {
  const acceptError = new Error("accept acknowledgement lost");
  const accept = vi.fn().mockRejectedValue(acceptError);
  const inspect = vi.fn().mockResolvedValue({ ...receipt, lastSequence: 0 });
  const onReceipt = vi.fn(async () => {});
  const worklet = { accept, inspect } as unknown as DurableWorklet;
  const spec = { taskId: "task", attemptId: "attempt" } as TaskAttemptSpec;
  const consume = async () => {
    for await (const _ of executeWorkletAttempt(
      worklet,
      spec,
      new AbortController().signal,
      true,
      undefined,
      undefined,
      onReceipt,
    )) {
      /* no replay */
    }
  };
  await expect(consume()).rejects.toBe(acceptError);
  expect(onReceipt).toHaveBeenCalledWith(expect.objectContaining(receipt));
  expect(accept).toHaveBeenCalledOnce();
});

it("leaves unknown and unbound receipts unbound and rejects receipts for another Attempt", async () => {
  const recordTaskAttemptWorker = vi.fn<Store["recordTaskAttemptWorker"]>();
  const store = { recordTaskAttemptWorker };
  await recordAttemptWorkerReceipt(store, "task", "attempt", { ...receipt, status: "unknown" });
  const { workerHostId: _host, workletId: _worklet, ...unbound } = receipt;
  await recordAttemptWorkerReceipt(store, "task", "attempt", unbound);
  expect(recordTaskAttemptWorker).not.toHaveBeenCalled();
  await expect(
    recordAttemptWorkerReceipt(store, "task", "another-attempt", receipt),
  ).rejects.toThrow("may have executed");
  await recordAttemptWorkerReceipt(store, "task", "attempt", receipt);
  expect(recordTaskAttemptWorker).toHaveBeenCalledExactlyOnceWith({
    taskId: "task",
    attemptId: "attempt",
    workerHostId: "selected-host",
    workletId: "selected-worklet",
    workerId: "selected-worker",
  });
});

it("keeps a rejected binding uncertain even when the other receipt claims terminal completion", async () => {
  const conflict = new Error(
    "Task Attempt workerHostId conflicts with its recorded Worker identity",
  );
  const recordTaskAttemptWorker = vi
    .fn<Store["recordTaskAttemptWorker"]>()
    .mockRejectedValue(conflict);
  const worklet = {
    accept: vi.fn().mockResolvedValue({ ...receipt, status: "completed" }),
    inspect: vi.fn(),
    events: vi.fn(),
  } as unknown as DurableWorklet;
  const consume = async () => {
    for await (const _ of executeWorkletAttempt(
      worklet,
      { taskId: "task", attemptId: "attempt" } as TaskAttemptSpec,
      new AbortController().signal,
      true,
      undefined,
      undefined,
      (accepted) =>
        recordAttemptWorkerReceipt({ recordTaskAttemptWorker }, "task", "attempt", accepted),
    )) {
      /* no replay */
    }
  };
  await expect(consume()).rejects.toMatchObject({
    name: "UncertainExecutionError",
    cause: conflict,
  });
  expect(worklet.accept).toHaveBeenCalledOnce();
  expect(worklet.events).not.toHaveBeenCalled();
});

it("forwards the abort reason when cancelling durable execution", async () => {
  for (const [abortReason, expected] of [
    [new Error("Execution registered a durable wait"), "Execution registered a durable wait"],
    [undefined, "Execution authority cancelled"],
  ] as const) {
    const controller = new AbortController();
    let observing = false;
    const cancel = vi.fn().mockResolvedValue({ ...receipt, lastSequence: 0 });
    const worklet = {
      accept: vi.fn().mockResolvedValue(receipt),
      inspect: vi.fn().mockResolvedValue({ ...receipt, lastSequence: 0 }),
      cancel,
      async *events(_attemptId: string, _cursor: number, signal?: AbortSignal) {
        observing = true;
        await new Promise((resolve) => signal?.addEventListener("abort", resolve, { once: true }));
        yield* [];
      },
    } as unknown as DurableWorklet;
    const consume = async () => {
      for await (const _ of executeWorkletAttempt(
        worklet,
        { taskId: "task", attemptId: "attempt" } as TaskAttemptSpec,
        controller.signal,
        true,
      )) {
        /* no events */
      }
    };
    const consumed = consume();
    await vi.waitFor(() => expect(observing).toBe(true));
    controller.abort(abortReason);
    await expect(consumed).rejects.toBeDefined();
    expect(cancel).toHaveBeenCalledWith("attempt", expected);
  }
});
