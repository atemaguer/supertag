import {
  type Task,
  type TaskAssignment,
  type TaskEvent,
  type TaskListFilter,
  type TaskNamedWorkspacePlan,
  type TaskWorkspaceDependencyBranch,
  workspaceBranchPin,
  workspaceDeliveryEvidence,
} from "@supertag/core";

/** The store reads {@link dependencyWorkspaceBranches} needs. */
export interface DependencyBranchStore {
  getTaskAssignment(taskId: string): Promise<TaskAssignment | undefined>;
  findTaskById(id: string): Promise<Task | undefined>;
  listTaskEvents(taskId: string): Promise<readonly TaskEvent[]>;
}

/**
 * The delivered branches a dependent Task starts from: for each accepted dependency in the same
 * Workspace, in declared order, the head its Worker recorded delivering in the accepted Attempt.
 * A dependency that delivered no commits contributes its own accepted dependencies' branches, so
 * work passes through a Task that changed nothing. A dependency in another Workspace, or one not
 * accepted, contributes nothing.
 */
export async function dependencyWorkspaceBranches(
  store: DependencyBranchStore,
  dependencies: readonly string[],
  plan: TaskNamedWorkspacePlan,
): Promise<readonly TaskWorkspaceDependencyBranch[]> {
  const branches: TaskWorkspaceDependencyBranch[] = [];
  const visited = new Set<string>();
  const visit = async (taskIds: readonly string[]): Promise<void> => {
    for (const taskId of taskIds) {
      if (visited.has(taskId)) continue;
      visited.add(taskId);
      const assignment = await store.getTaskAssignment(taskId);
      if (assignment?.status !== "accepted") continue;
      const task = await store.findTaskById(taskId);
      if (task === undefined) continue;
      const reviewed = assignment.result?.["reviewedAttemptId"];
      const delivered = deliveredWorkspaceBranch(
        task,
        await store.listTaskEvents(taskId),
        plan,
        typeof reviewed === "string" ? reviewed : undefined,
      );
      if (delivered !== undefined) branches.push(delivered);
      else await visit(assignment.dependencies);
    }
  };
  await visit(dependencies);
  return branches;
}

/**
 * The branch a continued work Session Task starts from: the latest earlier Task of the same work
 * Session that delivered commits in the same Workspace. Each such Task started from the one
 * before it, so its branch holds all of the work Session's earlier edits.
 */
export async function sessionWorkspaceBranches(
  store: Pick<DependencyBranchStore, "listTaskEvents"> & {
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
  store: Pick<DependencyBranchStore, "listTaskEvents">,
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
 * A conversation or work Session Task's events with the Worker event types an Objective Task
 * records: the Control Plane stores a surface Task's Worker events under an `execution.` prefix.
 */
export function workerEvents(events: readonly TaskEvent[]): readonly TaskEvent[] {
  return events.map((event) =>
    event.type.startsWith("execution.")
      ? { ...event, type: event.type.slice("execution.".length) }
      : event,
  );
}

/**
 * The head a Task's Worker recorded delivering on the Task's own branch in `plan`'s Workspace,
 * from `attemptId` when given, or nothing when it delivered no commits there.
 */
function deliveredWorkspaceBranch(
  task: Task,
  events: readonly TaskEvent[],
  plan: Pick<TaskNamedWorkspacePlan, "workspace">,
  attemptId?: string,
): TaskWorkspaceDependencyBranch | undefined {
  const source = task.workspacePlan;
  if (source.status !== "workspace" || source.workspace !== plan.workspace) return undefined;
  const branch = workspaceBranchPin(events, source.workspace) ?? source.branch;
  let delivered: TaskWorkspaceDependencyBranch | undefined;
  for (const event of events) {
    if (event.type !== "progress.updated") continue;
    if (attemptId !== undefined && event.attemptId !== attemptId) continue;
    const evidence = workspaceDeliveryEvidence(event.payload);
    // A later record that shows no new commits never erases commits an earlier one proved.
    if (evidence === undefined || evidence.branch !== branch || evidence.head === evidence.base)
      continue;
    delivered = { taskId: task.id, branch: evidence.branch, head: evidence.head };
  }
  return delivered;
}
