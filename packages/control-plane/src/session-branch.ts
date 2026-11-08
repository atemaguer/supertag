import {
  type Task,
  type TaskEvent,
  type TaskListFilter,
  type TaskNamedWorkspacePlan,
  workspaceBranchPin,
  workspaceDeliveryEvidence,
} from "@supertag/core";

/** Where a Session's branch is: its name and the head a Worker last delivered on it. */
export interface SessionBranchPin {
  readonly branch: string;
  readonly head: string;
}

/**
 * The branch a later Task of a Session continues: the one the latest earlier Task of the Session
 * delivered commits on in the same Workspace, at the head it delivered. A Task that delivered
 * nothing, such as one that only asked the person, is passed over.
 */
export async function sessionBranchPin(
  store: {
    listTasks(filter: TaskListFilter): Promise<readonly Task[]>;
    listTaskEvents(taskId: string): Promise<readonly TaskEvent[]>;
  },
  task: Task,
  plan: Pick<TaskNamedWorkspacePlan, "workspace">,
): Promise<SessionBranchPin | undefined> {
  const earlier = (
    await store.listTasks({ tagId: task.tagId, sessionId: task.sessionId, limit: 100 })
  ).filter((other) => other.id !== task.id && other.createdAt <= task.createdAt);
  for (const other of earlier) {
    const delivered = deliveredBranch(
      other,
      workerEvents(await store.listTaskEvents(other.id)),
      plan,
    );
    if (delivered !== undefined) return delivered;
  }
  return undefined;
}

/**
 * A Task's events with the Worker's own event types: the Control Plane stores a Task's Worker
 * events under an `execution.` prefix.
 */
export function workerEvents(events: readonly TaskEvent[]): readonly TaskEvent[] {
  return events.map((event) =>
    event.type.startsWith("execution.")
      ? { ...event, type: event.type.slice("execution.".length) }
      : event,
  );
}

/**
 * The head a Task's Worker recorded delivering on the branch it resolved in `plan`'s Workspace,
 * or nothing when it delivered no commits there.
 */
function deliveredBranch(
  task: Task,
  events: readonly TaskEvent[],
  plan: Pick<TaskNamedWorkspacePlan, "workspace">,
): SessionBranchPin | undefined {
  const source = task.workspacePlan;
  if (source.status !== "workspace" || source.workspace !== plan.workspace) return undefined;
  const branch = workspaceBranchPin(events, source.workspace) ?? source.branch;
  let delivered: SessionBranchPin | undefined;
  for (const event of events) {
    if (event.type !== "progress.updated") continue;
    const evidence = workspaceDeliveryEvidence(event.payload);
    // A later record that shows no new commits never erases commits an earlier one proved.
    if (evidence === undefined || evidence.branch !== branch || evidence.head === evidence.base)
      continue;
    delivered = { branch: evidence.branch, head: evidence.head };
  }
  return delivered;
}
