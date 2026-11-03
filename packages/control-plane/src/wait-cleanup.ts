import type { Store, TaskAssignment } from "@supertag/core";
import type { AttemptInspection, DurableWorklet } from "@supertag/worker-sdk";

import { withdrawSessionInput } from "./session-input-withdrawal.js";
import { withdrawTeamLiveInput } from "./team-live-delivery.js";

interface WaitCleanupInput {
  readonly durable: Pick<DurableWorklet, "cancel" | "events" | "inspect">;
  readonly store: Pick<
    Store,
    | "appendTaskAssignmentJournalEvent"
    | "listTaskEvents"
    | "settleTaskAssignment"
    | "appendTaskEvent"
    | "withdrawTeamLiveDelivery"
    | "withdrawInboundControlDelivery"
  >;
  readonly task: Pick<TaskAssignment, "taskId" | "attemptCount">;
  readonly attemptId: string;
  readonly leaseOwner: string;
  readonly waitSessionCompatibility?: string | undefined;
  readonly isStopping: () => boolean;
  readonly wakeTaskController?: (() => void) | undefined;
  readonly onError: (error: unknown) => void;
}

/**
 * A registered wait releases execution only after terminal cleanup evidence.
 * Missing evidence or a rejected settlement leaves the same Attempt recoverable.
 * Callers decide whether shutdown permits requesting cleanup; once invoked we
 * request cancellation even during shutdown, but never start polling after it.
 */
export async function confirmWaitCleanup(
  input: WaitCleanupInput,
): Promise<"settled" | "recoverable"> {
  const { durable, store, task, attemptId, leaseOwner, isStopping, onError } = input;
  await durable.cancel(attemptId, "Execution registered a durable wait").catch(onError);
  const until = Date.now() + 20_000;
  while (!isStopping() && Date.now() < until) {
    const receipt = await durable.inspect(attemptId).catch(() => undefined);
    if (
      receipt &&
      (receipt.status === "completed" ||
        receipt.status === "failed" ||
        receipt.status === "cancelled")
    ) {
      try {
        const unknownOutcome = await replayWaitCleanupJournal(input, receipt, until);
        await store.settleTaskAssignment({
          taskId: task.taskId,
          leaseOwner,
          attemptCount: task.attemptCount,
          result: unknownOutcome
            ? { error: unknownOutcome }
            : { text: "Execution suspended until its durable wait condition is satisfied" },
          ...(unknownOutcome ? { failed: true } : {}),
          terminalAttempt: { id: attemptId, status: receipt.status },
          ...(receipt.status !== "failed" && input.waitSessionCompatibility
            ? { waitSessionCompatibility: input.waitSessionCompatibility }
            : {}),
        });
        return "settled";
      } catch (error) {
        onError(error);
        return "recoverable";
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return "recoverable";
}

/**
 * Provider cleanup can emit its final usage observation after wait_for revokes
 * the live observer. A terminal receipt proves both that cleanup finished and
 * the exact journal sequence that must be durable before the Attempt settles.
 */
async function replayWaitCleanupJournal(
  input: WaitCleanupInput,
  receipt: AttemptInspection,
  deadline: number,
): Promise<string | undefined> {
  const saved = (await input.store.listTaskEvents(input.task.taskId)).filter(
    (event) =>
      event.attemptId === input.attemptId && typeof event.payload?.["journalSequence"] === "number",
  );
  let unknownOutcome: string | undefined;
  for (const event of saved) {
    const error = event.payload?.["error"];
    if (
      event.type === "execution.failed" &&
      error &&
      typeof error === "object" &&
      !Array.isArray(error) &&
      "name" in error &&
      error.name === "InterruptedExecutionOutcomeUnknown"
    )
      unknownOutcome = String(
        "message" in error ? error.message : "Interrupted execution outcome remains unknown",
      );
  }
  const savedSequences = saved
    .map((event) => Number(event.payload?.["journalSequence"]))
    .toSorted((a, b) => a - b);
  if (
    savedSequences.some(
      (sequence, index) => !Number.isSafeInteger(sequence) || sequence !== index + 1,
    )
  )
    throw new Error("Wait cleanup saved journal prefix is not contiguous");
  let cursor = savedSequences.length;
  if (cursor > receipt.lastSequence) throw new Error("Wait cleanup journal exceeds its receipt");
  if (cursor === receipt.lastSequence) return unknownOutcome;

  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) throw new Error("Wait cleanup journal replay deadline elapsed");
  const signal = AbortSignal.timeout(remainingMs);
  for await (const entry of input.durable.events(input.attemptId, cursor, signal)) {
    if (entry.sequence <= cursor) continue;
    if (entry.sequence !== cursor + 1)
      throw new Error(`Wait cleanup journal sequence gap after ${cursor}`);
    if (entry.event.attemptId !== input.attemptId || entry.event.taskId !== input.task.taskId)
      throw new Error("Wait cleanup journal identity mismatch");
    // Apply withdrawals before saving the cursor so failures remain replayable.
    await withdrawTeamLiveInput(input.store, entry.event);
    if (await withdrawSessionInput(input.store, entry.event)) input.wakeTaskController?.();
    await input.store.appendTaskAssignmentJournalEvent({
      taskId: input.task.taskId,
      attemptId: input.attemptId,
      leaseOwner: input.leaseOwner,
      attemptCount: input.task.attemptCount,
      sequence: entry.sequence,
      type: entry.event.type,
      payload: { ...entry.event },
    });
    if (
      entry.event.type === "execution.failed" &&
      entry.event.error.name === "InterruptedExecutionOutcomeUnknown"
    )
      unknownOutcome = entry.event.error.message;
    cursor = entry.sequence;
    if (cursor === receipt.lastSequence) break;
  }
  if (cursor !== receipt.lastSequence)
    throw new Error(`Wait cleanup journal ended at ${cursor}, expected ${receipt.lastSequence}`);
  return unknownOutcome;
}
