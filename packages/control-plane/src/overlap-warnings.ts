import type { Store, TaskWorkspacePlan, WorkstreamPost } from "@supertag/core";

type ChangedPathReport = {
  readonly attemptId: string;
  readonly paths: readonly string[];
  readonly truncated: boolean;
};
type OverlapStore = Pick<
  Store,
  | "recordTaskAttemptChangedPaths"
  | "listRunningTaskAttemptChangedPaths"
  | "getTeam"
  | "getTaskAssignment"
  | "recordOverlapWarning"
>;
type LivePosts = { deliverPost(post: WorkstreamPost): void };

function repository(plan: TaskWorkspacePlan): string | undefined {
  if (plan.status === "workspace") return `workspace:${plan.workspace}`;
  if (plan.status === "selected") {
    const { provider, surfaceAccountId, scope } = plan.target;
    return `selected:${provider}:${surfaceAccountId}:${scope}`;
  }
  return undefined;
}

/** Persist heartbeat reports, then publish each newly overlapping path batch once. */
export async function detectOverlapWarnings(
  store: OverlapStore,
  live: LivePosts,
  reports: readonly ChangedPathReport[],
): Promise<void> {
  for (const report of reports) await store.recordTaskAttemptChangedPaths(report);
  const rows = await store.listRunningTaskAttemptChangedPaths();
  const reported = new Set(reports.map((report) => report.attemptId));
  const teams = new Map<string, Awaited<ReturnType<OverlapStore["getTeam"]>>>();
  const objectives = new Map<string, string>();
  for (const current of rows) {
    if (!reported.has(current.attemptId) || current.truncated) continue;
    const currentRepo = repository(current.workspacePlan);
    if (!currentRepo || current.paths.length === 0) continue;
    const currentPaths = new Set(current.paths);
    for (const other of rows) {
      if (
        other.attemptId === current.attemptId ||
        other.truncated ||
        other.teamId !== current.teamId ||
        repository(other.workspacePlan) !== currentRepo ||
        (reported.has(other.attemptId) && other.attemptId < current.attemptId)
      )
        continue;
      const paths = other.paths.filter((path) => currentPaths.has(path));
      if (!paths.length) continue;
      let team = teams.get(current.teamId);
      if (team === undefined) {
        team = await store.getTeam(current.teamId);
        teams.set(current.teamId, team);
      }
      if (!team) continue;
      let objectiveId = objectives.get(current.taskId);
      if (!objectiveId) {
        objectiveId = (await store.getTaskAssignment(current.taskId))?.objectiveId;
        if (!objectiveId) continue;
        objectives.set(current.taskId, objectiveId);
      }
      const post = await store.recordOverlapWarning({
        teamId: current.teamId,
        objectiveId,
        firstAttemptId: current.attemptId,
        secondAttemptId: other.attemptId,
        firstTaskId: current.taskId,
        secondTaskId: other.taskId,
        paths,
        to: [...new Set([current.tagId, other.tagId, team.leadTagId])].sort(),
      });
      if (post) live.deliverPost(post);
    }
  }
}
