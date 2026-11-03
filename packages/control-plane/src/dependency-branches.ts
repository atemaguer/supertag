import {
  type Task,
  type TaskAssignment,
  type TaskEvent,
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
      const source = task?.workspacePlan;
      if (source?.status !== "workspace" || source.workspace !== plan.workspace) continue;
      const reviewed = assignment.result?.["reviewedAttemptId"];
      const attemptId = typeof reviewed === "string" ? reviewed : undefined;
      let delivered: TaskWorkspaceDependencyBranch | undefined;
      const events = await store.listTaskEvents(taskId);
      const branch = workspaceBranchPin(events, source.workspace) ?? source.branch;
      for (const event of events) {
        if (event.type !== "progress.updated") continue;
        if (attemptId !== undefined && event.attemptId !== attemptId) continue;
        const evidence = workspaceDeliveryEvidence(event.payload);
        // A later record that shows no new commits never erases commits an earlier one proved.
        if (evidence === undefined || evidence.branch !== branch || evidence.head === evidence.base)
          continue;
        delivered = { taskId, branch: evidence.branch, head: evidence.head };
      }
      if (delivered !== undefined) branches.push(delivered);
      else await visit(assignment.dependencies);
    }
  };
  await visit(dependencies);
  return branches;
}
