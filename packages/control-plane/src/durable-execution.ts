import { setTimeout as delay } from "node:timers/promises";
import type { Store } from "@supertag/core";
import type {
  AttemptJournalEvent,
  AttemptReceipt,
  DurableWorklet,
  TaskAttemptSpec,
  Worklet,
} from "@supertag/worker-sdk";
import { WorkletAdmissionRejectedError } from "@supertag/worker-sdk";

export async function supportsDurableExecution(
  worklet: Worklet | undefined,
  profile: TaskAttemptSpec["workerProfile"],
  contextPlan: TaskAttemptSpec["contextPlan"],
): Promise<boolean> {
  if (!worklet) return false;
  if (
    "supportsDurableExecution" in worklet &&
    typeof worklet.supportsDurableExecution === "function"
  )
    return Boolean(await worklet.supportsDurableExecution(profile, contextPlan));
  return ["accept", "inspect", "events", "cancel"].every(
    (key) => typeof (worklet as unknown as Record<string, unknown>)[key] === "function",
  );
}

export class ExecutionNotAcceptedError extends Error {
  constructor(attemptId: string) {
    super(`Attempt ${attemptId} was aborted before durable acceptance was invoked.`);
    this.name = "ExecutionNotAcceptedError";
  }
}

export class ExecutionAdmissionRejectedError extends ExecutionNotAcceptedError {
  constructor(
    attemptId: string,
    readonly reason: string,
  ) {
    super(attemptId);
    this.name = "ExecutionAdmissionRejectedError";
  }
}

export class UncertainExecutionError extends Error {
  constructor(attemptId: string, cause?: unknown) {
    super(
      `Attempt ${attemptId} may have executed. Inspect its durable Worklet receipt before running the work again; automatic replay is disabled.`,
      cause === undefined ? undefined : { cause },
    );
    this.name = "UncertainExecutionError";
  }
}

/** A receipt cannot be reconciled with the recorded selected Worker. */
export class UncertainWorkerIdentityError extends UncertainExecutionError {
  constructor(attemptId: string, cause?: unknown) {
    super(attemptId, cause);
    this.message = `Worker identity could not be confirmed against the recorded Attempt. ${this.message}`;
  }
}

export async function* executeWorkletAttempt(
  worklet: Worklet,
  spec: TaskAttemptSpec,
  signal: AbortSignal,
  durableExecution?: boolean,
  onJournalEvent?: (entry: AttemptJournalEvent) => Promise<void>,
  cancelOnAbort: () => boolean = () => true,
  onReceipt?: (receipt: AttemptReceipt) => Promise<void>,
) {
  if (
    !(
      durableExecution ??
      (await supportsDurableExecution(worklet, spec.workerProfile, spec.contextPlan))
    )
  ) {
    try {
      yield* worklet.execute(spec, signal);
    } catch (error) {
      if (error instanceof WorkletAdmissionRejectedError)
        throw new ExecutionAdmissionRejectedError(spec.attemptId, error.reason);
      throw error;
    }
    return;
  }
  const durable = worklet as DurableWorklet;
  if (signal.aborted) throw new ExecutionNotAcceptedError(spec.attemptId);
  let receipt: Awaited<ReturnType<DurableWorklet["accept"]>>;
  try {
    receipt = await durable.accept(spec);
  } catch (error) {
    if (error instanceof WorkletAdmissionRejectedError)
      throw new ExecutionAdmissionRejectedError(spec.attemptId, error.reason);
    let inspection: Awaited<ReturnType<DurableWorklet["inspect"]>>;
    try {
      inspection = await durable.inspect(spec.attemptId);
    } catch {
      throw error;
    }
    if (inspection) {
      await onReceipt?.(inspection);
      throw error;
    }
    throw new ExecutionAdmissionRejectedError(
      spec.attemptId,
      error instanceof Error ? error.message : "Durable execution admission rejected",
    );
  }
  await onReceipt?.(receipt);
  if (receipt.status === "unknown") throw new UncertainExecutionError(spec.attemptId);
  const cancel = () => {
    if (!cancelOnAbort()) return;
    // Forward why execution stopped, such as a cancellation. A bare abort carries no
    // explanation, so it keeps the generic authority reason.
    const reason =
      signal.reason instanceof Error && signal.reason.name !== "AbortError" && signal.reason.message
        ? signal.reason.message.slice(0, 500)
        : "Execution authority cancelled";
    void durable.cancel(spec.attemptId, reason).catch(() => {});
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    if (signal.aborted) cancel();
    for await (const entry of observeDurableAttempt(
      durable,
      spec.attemptId,
      signal,
      0,
      onReceipt,
    )) {
      await onJournalEvent?.(entry);
      yield entry.event;
    }
  } finally {
    signal.removeEventListener("abort", cancel);
  }
}

/** How long an observer waits for a durable Attempt's host to come back before giving up. */
export const DURABLE_RECONNECT_GRACE_MS = 30_000;

export async function* observeDurableAttempt(
  durable: DurableWorklet,
  attemptId: string,
  signal: AbortSignal,
  afterSequence = 0,
  onReceipt?: (receipt: AttemptReceipt) => Promise<void>,
): AsyncIterable<AttemptJournalEvent> {
  let cursor = afterSequence;
  let reconnectDeadline = Date.now() + DURABLE_RECONNECT_GRACE_MS;
  while (true) {
    signal.throwIfAborted();
    try {
      for await (const entry of durable.events(attemptId, cursor, signal)) {
        if (entry.sequence <= cursor) continue;
        if (entry.sequence !== cursor + 1) throw new UncertainExecutionError(attemptId);
        cursor = entry.sequence;
        reconnectDeadline = Date.now() + DURABLE_RECONNECT_GRACE_MS;
        yield entry;
      }
      const state = await durable.inspect(attemptId);
      if (state) await onReceipt?.(state);
      if (state?.status === "unknown") throw new UncertainExecutionError(attemptId);
      if (state && ["completed", "failed", "cancelled"].includes(state.status)) return;
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof UncertainExecutionError) throw error;
      // Reconnect observation to the same Attempt; never submit execution again.
      const state = await durable.inspect(attemptId).catch(() => undefined);
      if (state) await onReceipt?.(state);
      if (state?.status === "unknown") throw new UncertainExecutionError(attemptId);
    }
    if (Date.now() >= reconnectDeadline) throw new UncertainExecutionError(attemptId);
    await delay(100, undefined, { signal });
  }
}

/** Persist only confirmed admission provenance; profiles and aggregate hosts are not bindings. */
export async function recordAttemptWorkerReceipt(
  store: Pick<Store, "recordTaskAttemptWorker">,
  taskId: string,
  attemptId: string,
  receipt: AttemptReceipt | undefined,
): Promise<void> {
  if (!receipt) return;
  if (receipt.taskId !== taskId || receipt.attemptId !== attemptId)
    throw new UncertainWorkerIdentityError(attemptId);
  if (receipt.status === "unknown" || !receipt.workerHostId || !receipt.workletId) return;
  try {
    await store.recordTaskAttemptWorker({
      taskId,
      attemptId,
      workerHostId: receipt.workerHostId,
      workletId: receipt.workletId,
      ...(receipt.workerId ? { workerId: receipt.workerId } : {}),
      ...(receipt.connectionGeneration === undefined
        ? {}
        : { connectionGeneration: receipt.connectionGeneration }),
    });
  } catch (error) {
    // Acceptance already happened. A stale or conflicting binding is never proof
    // that execution did not start or that a different host completed cleanup.
    throw new UncertainWorkerIdentityError(attemptId, error);
  }
}
