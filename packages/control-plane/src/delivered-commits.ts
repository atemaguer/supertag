import { type JsonRecord, type TaskEvent, workspaceDeliveryEvidence } from "@supertag/core";
import type { DurableWorklet } from "@supertag/worker-sdk";

/** The parts of a Task event that carry delivery evidence. */
export type DeliveryEvidenceEvent = Pick<TaskEvent, "attemptId" | "type" | "payload">;

/** Commits a failed Task Attempt left on its Task branch, recorded beside its failure. */
export interface DeliveredCommits {
  readonly attemptId: string;
  readonly branch: string;
  readonly base: string;
  readonly head: string;
  readonly changedFiles: number;
}

/**
 * Adds `deliveredCommits` to a failed Attempt's result when the Worker's delivery progress shows
 * the Task branch moved past its base. A timeout can land after the work was committed; the
 * delegator may then review and accept that committed result instead of discarding it.
 */
export function deliveredCommitsResult(
  events: readonly DeliveryEvidenceEvent[],
  attemptId: string,
  fallback: JsonRecord,
): JsonRecord {
  let found: DeliveredCommits | undefined;
  for (const event of events) {
    if (event.attemptId !== attemptId || event.type !== "progress.updated") continue;
    const evidence = workspaceDeliveryEvidence(event.payload);
    // A later record that shows no new commits never erases commits an earlier record proved.
    if (evidence === undefined || evidence.head === evidence.base) continue;
    found = { attemptId, ...evidence };
  }
  return found === undefined ? fallback : { ...fallback, deliveredCommits: { ...found } };
}

/**
 * Reads a terminal durable Attempt's journal for workspace delivery progress. An aborted observer
 * stops reading before the Worker reports the commits it made during failure cleanup, so the
 * failure path drains the journal, bounded by `timeoutMs`, before settling. Read failures yield
 * whatever was read; they never block settlement.
 */
export async function drainDeliveryEvidence(
  durable: Pick<DurableWorklet, "events">,
  attemptId: string,
  timeoutMs = 5000,
): Promise<DeliveryEvidenceEvent[]> {
  const evidence: DeliveryEvidenceEvent[] = [];
  try {
    for await (const entry of durable.events(attemptId, 0, AbortSignal.timeout(timeoutMs))) {
      if (entry.event.type !== "progress.updated") continue;
      evidence.push({
        attemptId: entry.event.attemptId,
        type: entry.event.type,
        payload: { ...entry.event } as unknown as JsonRecord,
      });
    }
  } catch {
    // Settlement proceeds with the evidence already persisted and read.
  }
  return evidence;
}
