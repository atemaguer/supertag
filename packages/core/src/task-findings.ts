/**
 * Review findings carried by a Task result. A finding always describes the Task whose result
 * carries it: it has no Task field, and only the settlement of that Task's own Attempt records it.
 */
export type TaskFindingSeverity = "high" | "medium" | "low";

export interface TaskFinding {
  /** Control Plane identifier, unique within the Task, such as `F1`. */
  readonly id: string;
  readonly severity: TaskFindingSeverity;
  /** One sentence. */
  readonly summary: string;
  /** `file:line` or another reference. */
  readonly location?: string;
}
