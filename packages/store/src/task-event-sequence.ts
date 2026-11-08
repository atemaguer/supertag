import { desc, eq, sql } from "drizzle-orm";
import * as postgresql from "./schema/postgresql.js";
import * as sqlite from "./schema/sqlite.js";

/**
 * Allocates the next TaskEvent sequence for a Task inside a transaction. Every writer first locks
 * the Task row, then reads the latest sequence, so two transactions never pick the same number:
 * on PostgreSQL a unique violation would abort the caller's whole transaction, so retrying after
 * the conflict isn't possible there.
 */
export function* nextTaskEventSequence(
  tx: any,
  taskEvents: any,
  taskId: string,
  /**
   * When the event changes what the Task records, such as late usage evidence on a settled Task,
   * the Task's `updatedAt` moves to it, so readers that cache a Task by `updatedAt` re-measure it.
   */
  updatedAt?: string,
): Generator<any, number, any> {
  const tasks = taskEvents === postgresql.taskEvents ? postgresql.tasks : sqlite.tasks;
  // The update takes the row lock on PostgreSQL; SQLite transactions are already serialized.
  yield tx
    .update(tasks)
    .set({ updatedAt: updatedAt ?? sql`${tasks.updatedAt}` })
    .where(eq(tasks.id, taskId))
    .returning({ id: tasks.id });
  const [last] = yield tx
    .select({ sequence: taskEvents.sequence })
    .from(taskEvents)
    .where(eq(taskEvents.taskId, taskId))
    .orderBy(desc(taskEvents.sequence))
    .limit(1);
  return (last?.sequence ?? 0) + 1;
}
