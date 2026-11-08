import {
  type Task,
  type TaskEvent,
  type TaskListFilter,
  type TaskNamedWorkspacePlan,
  type TaskWorkspaceDependencyBranch,
  workspaceBranchPin,
  workspaceDeliveryEvidence,
} from "@supertag/core";

/** The store reads a work Session's delivered branches need. */
type SessionBranchStore = {
  listTaskEvents(taskId: string): Promise<readonly TaskEvent[]>;
};

/**
 * The branch a continued work Session Task starts from: the latest earlier Task of the same work
 * Session that delivered commits in the same Workspace. Each such Task started from the one
 * before it, so its branch holds all of the work Session's earlier edits.
 */
export async function sessionWorkspaceBranches(
  store: SessionBranchStore & {
    listTasks(filter: TaskListFilter): Promise<readonly Task[]>;
  },
  task: Task,
  plan: TaskNamedWorkspacePlan,
): Promise<readonly TaskWorkspaceDependencyBranch[]> {
  const earlier = (
    await store.listTasks({ tagId: task.tagId, sessionId: task.sessionId, limit: 100 })
  ).filter((other) => other.id !== task.id && other.createdAt <= task.createdAt);
  const delivered = await latestSessionDelivery(store, earlier, plan);
  return delivered === undefined ? [] : [delivered];
}

/**
 * The latest of a work Session's `tasks`, newest first, that delivered commits in `plan`'s
 * Workspace, and where. A Task that delivered nothing, such as one that only asked the person,
 * has no branch to build on or number after.
 */
export async function latestSessionDelivery(
  store: SessionBranchStore,
  tasks: readonly Task[],
  plan: Pick<TaskNamedWorkspacePlan, "workspace">,
): Promise<TaskWorkspaceDependencyBranch | undefined> {
  for (const other of tasks) {
    const events = workerEvents(await store.listTaskEvents(other.id));
    const delivered = deliveredWorkspaceBranch(other, events, plan);
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
 * The head a Task's Worker recorded delivering on the Task's own branch in `plan`'s Workspace, or
 * nothing when it delivered no commits there.
 */
function deliveredWorkspaceBranch(
  task: Task,
  events: readonly TaskEvent[],
  plan: Pick<TaskNamedWorkspacePlan, "workspace">,
): TaskWorkspaceDependencyBranch | undefined {
  const source = task.workspacePlan;
  if (source.status !== "workspace" || source.workspace !== plan.workspace) return undefined;
  const branch = workspaceBranchPin(events, source.workspace) ?? source.branch;
  let delivered: TaskWorkspaceDependencyBranch | undefined;
  for (const event of events) {
    if (event.type !== "progress.updated") continue;
    const evidence = workspaceDeliveryEvidence(event.payload);
    // A later record that shows no new commits never erases commits an earlier one proved.
    if (evidence === undefined || evidence.branch !== branch || evidence.head === evidence.base)
      continue;
    delivered = { taskId: task.id, branch: evidence.branch, head: evidence.head };
  }
  return delivered;
}
