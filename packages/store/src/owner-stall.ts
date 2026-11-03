// biome-ignore-all lint/suspicious/noExplicitAny: Store rows come from either Drizzle dialect.
import { ownerActivation, storedTaskFindings } from "@supertag/core";

/** Durable facts that need the Objective owner while no owner activation is open. */
export function ownerStallWork(
  objective: { id: string; ownerTagId: string; status: string; executionStartedAt: string | null },
  tasks: readonly any[],
  messages: readonly any[],
  allowQueuedStallWake = false,
):
  | {
      waiting: string[];
      evidence: { id: string; status: string; attemptCount: number; updatedAt: string }[];
      since: string;
    }
  | undefined {
  if (objective.status !== "working" || !objective.executionStartedAt) return undefined;
  if (
    tasks.some(
      (task) =>
        ownerActivation(task, objective.ownerTagId) &&
        ["running", "queued", "waiting"].includes(task.status) &&
        !(allowQueuedStallWake && task.status === "queued" && task.taskId.includes(":stall-wake:")),
    )
  )
    return undefined;
  const waiting: string[] = [];
  const evidence: { id: string; status: string; attemptCount: number; updatedAt: string }[] = [];
  let since = new Date().toISOString();
  // A delegated Task still in flight, such as the review of a submitted Task, wakes its
  // requester when it settles, so submitted Tasks and open findings aren't waiting yet.
  const delegatedInFlight = tasks.some(
    (task) => Boolean(task.parentTaskId) && ["queued", "running", "waiting"].includes(task.status),
  );
  for (const task of delegatedInFlight ? [] : tasks) {
    const submitted = Boolean(task.parentTaskId) && task.status === "submitted";
    const findings = storedTaskFindings(task.result).filter((finding) => finding.status === "open");
    if (!submitted && findings.length === 0) continue;
    waiting.push(
      ...(submitted ? [`submitted Task ${task.taskId}`] : []),
      ...findings.map((finding) => `open finding ${task.taskId} ${finding.id}`),
    );
    evidence.push({
      id: task.taskId,
      status: task.status,
      attemptCount: task.attemptCount,
      updatedAt: task.updatedAt,
    });
    if (task.updatedAt < since) since = task.updatedAt;
  }
  for (const message of messages) {
    if (
      message.objectiveId !== objective.id ||
      message.recipientTagId !== objective.ownerTagId ||
      !message.operatorId ||
      !["pending", "processing", "failed"].includes(message.status)
    )
      continue;
    waiting.push(`unhandled operator input ${message.id}`);
    if (message.createdAt < since) since = message.createdAt;
  }
  return waiting.length ? { waiting, evidence, since } : undefined;
}
