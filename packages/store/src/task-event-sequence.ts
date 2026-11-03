import { desc, eq } from "drizzle-orm";
import * as postgresql from "./schema/postgresql.js";
import * as sqlite from "./schema/sqlite.js";

/**
 * Allocates the next TaskEvent sequence for a Task inside a transaction. Every writer first locks
 * the Task's assignment row, then reads the latest sequence, so two transactions never pick the
 * same number: on PostgreSQL a unique violation would abort the caller's whole transaction, so
 * retrying after the conflict isn't possible there. Tasks without an assignment row (surface
 * Tasks) fall back to the unique constraint and the caller's retry.
 */
export function* nextTaskEventSequence(
  tx: any,
  taskEvents: any,
  taskId: string,
): Generator<any, number, any> {
  const assignments =
    taskEvents === postgresql.taskEvents ? postgresql.taskAssignments : sqlite.taskAssignments;
  // A no-op update takes the row lock on PostgreSQL; SQLite transactions are already serialized.
  yield tx
    .update(assignments)
    .set({ taskId })
    .where(eq(assignments.taskId, taskId))
    .returning({ taskId: assignments.taskId });
  const [last] = yield tx
    .select({ sequence: taskEvents.sequence })
    .from(taskEvents)
    .where(eq(taskEvents.taskId, taskId))
    .orderBy(desc(taskEvents.sequence))
    .limit(1);
  return (last?.sequence ?? 0) + 1;
}
