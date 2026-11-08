import { createHash } from "node:crypto";
import type { Store, TaskWorkspacePlan } from "@supertag/core";

type ChangedPathReport = {
  readonly attemptId: string;
  readonly paths: readonly string[];
  readonly truncated: boolean;
};
type OverlapStore = Pick<
  Store,
  "recordTaskAttemptChangedPaths" | "listRunningTaskAttemptChangedPaths" | "recordOverlaps"
>;
/** Tells an Objective's conversation about overlapping work, once per delivery key. */
export type OverlapNotice = (objectiveId: string, key: string, text: string) => Promise<void>;

/** The most changed paths one warning names. */
const OVERLAP_PATHS_SHOWN = 20;

function repository(plan: TaskWorkspacePlan): string | undefined {
  if (plan.status === "workspace") return `workspace:${plan.workspace}`;
  if (plan.status === "selected") {
    const { provider, surfaceAccountId, scope } = plan.target;
    return `selected:${provider}:${surfaceAccountId}:${scope}`;
  }
  return undefined;
}

function repositoryLabel(plan: TaskWorkspacePlan): string {
  if (plan.status === "workspace") return `Workspace ${plan.workspace}`;
  if (plan.status === "selected") return plan.target.reference ?? plan.target.scope;
  return "the same repository";
}

/**
 * Persists heartbeat reports, then tells the Objective's conversation once about each newly
 * overlapping batch of paths that two of its running Task Attempts change in the same repository.
 */
export async function detectOverlapWarnings(
  store: OverlapStore,
  notify: OverlapNotice,
  reports: readonly ChangedPathReport[],
): Promise<void> {
  for (const report of reports) await store.recordTaskAttemptChangedPaths(report);
  const rows = await store.listRunningTaskAttemptChangedPaths();
  const reported = new Set(reports.map((report) => report.attemptId));
  for (const current of rows) {
    if (!reported.has(current.attemptId) || current.truncated) continue;
    const currentRepo = repository(current.workspacePlan);
    if (!currentRepo || current.paths.length === 0) continue;
    const currentPaths = new Set(current.paths);
    for (const other of rows) {
      if (
        other.attemptId === current.attemptId ||
        other.truncated ||
        other.objectiveId !== current.objectiveId ||
        repository(other.workspacePlan) !== currentRepo ||
        (reported.has(other.attemptId) && other.attemptId < current.attemptId)
      )
        continue;
      const paths = other.paths.filter((path) => currentPaths.has(path));
      if (!paths.length) continue;
      const fresh = await store.recordOverlaps({
        objectiveId: current.objectiveId,
        firstAttemptId: current.attemptId,
        secondAttemptId: other.attemptId,
        paths,
      });
      if (fresh.length === 0) continue;
      const newPaths = [...new Set(fresh.map((overlap) => overlap.path))].sort();
      const [lower, higher] = [current.attemptId, other.attemptId].sort();
      const digest = createHash("sha256").update(newPaths.join("\n")).digest("hex").slice(0, 16);
      const shown = newPaths.slice(0, OVERLAP_PATHS_SHOWN).join(", ");
      const more =
        newPaths.length > OVERLAP_PATHS_SHOWN
          ? ` and ${newPaths.length - OVERLAP_PATHS_SHOWN} more`
          : "";
      await notify(
        current.objectiveId,
        `overlap:${lower}:${higher}:${digest}`,
        `Tasks ${current.taskId} and ${other.taskId} of this Objective are both changing ${shown}${more} in ${repositoryLabel(current.workspacePlan)}. Coordinate them before their changes conflict: continue one work Session with what the other changes, or let one finish first.`,
      );
    }
  }
}
