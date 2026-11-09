import { createHash } from "node:crypto";
import { timestampDate, timestampFromDate } from "@bufbuild/protobuf/wkt";
import { Code, type ServiceImpl } from "@connectrpc/connect";
import type { TaskAttemptRunningCommand } from "@supertag/control-plane";
import { taskAttemptRunningCommand } from "@supertag/control-plane";
import {
  AUDIT_DEFAULT_LIMIT,
  AUDIT_MAX_LIMIT,
  type AuditEntryPosition,
  parseAuditQuery,
  type Task,
} from "@supertag/core";
import {
  ControllerPhase,
  ControlPlanePhase,
  ErrorReason,
  type OrganizationService,
  SpendGrouping,
} from "@supertag/operator-api";
import type { RpcTelemetrySnapshot } from "@supertag/worker-transport";
import { workerHostResource } from "./control-plane-resources.js";
import { pageSizeOf } from "./inbox-rpc.js";
import { operatorError } from "./operator-rpc-context.js";
import type { OperatorQueries, OperatorReadStore } from "./operator-seams.js";
import {
  auditEntryMessage,
  metricSnapshotMessage,
  organizationOverviewMessage,
  spendReportMessage,
} from "./organization-protos.js";
import { organizationStatus } from "./organization-views.js";

export interface OrganizationServiceDependencies {
  readonly store: Pick<
    OperatorReadStore,
    | "findTaskById"
    | "listAuditEntries"
    | "listObjectiveSessions"
    | "listOpenObjectives"
    | "listRunningTaskAttempts"
    | "listTags"
    | "listTaskEvents"
    | "readCoordinationMetrics"
    | "readSpend"
  >;
  readonly queries: Pick<OperatorQueries, "controlPlaneStatus" | "listWorkerHosts">;
  /**
   * The RPC counters of the API Server process answering the call. They are this process's own,
   * which `MetricSnapshot.rpc` says.
   */
  readonly rpcTelemetry: () => RpcTelemetrySnapshot;
}

/** `OrganizationService`: the Control Plane's own state, and the organization it runs. */
export function organizationService(
  dependencies: OrganizationServiceDependencies,
): ServiceImpl<typeof OrganizationService> {
  const { store, queries } = dependencies;
  return {
    async getStatus() {
      const { accepting, startedAt, controllers } = await queries.controlPlaneStatus();
      return {
        metadata: {
          id: "control-plane",
          name: "control-plane",
          resourceVersion: createHash("sha256")
            .update(JSON.stringify({ accepting, controllers }))
            .digest("hex"),
          createdAt: timestampFromDate(new Date(startedAt)),
          updatedAt: timestampFromDate(new Date()),
        },
        phase: accepting ? ControlPlanePhase.ACCEPTING : ControlPlanePhase.DRAINING,
        controllers: controllers.map(({ name, phase }) => ({
          name,
          phase: CONTROLLER_PHASES[phase] ?? ControllerPhase.UNSPECIFIED,
        })),
      };
    },

    async getOrganization() {
      const [hosts, tags, runningAttempts, objectives] = await Promise.all([
        queries.listWorkerHosts(),
        store.listTags(),
        store.listRunningTaskAttempts(),
        store.listOpenObjectives(),
      ]);
      // Status shows spend only for open Objectives, so read only their Task Attempts.
      const spend = await store.readSpend({
        by: "objective",
        objectiveIds: objectives.map((objective) => objective.id),
      });
      const taskTagIds = new Map<string, string>();
      const runningCommands = new Map<string, TaskAttemptRunningCommand>();
      for (const taskId of new Set(runningAttempts.map((attempt) => attempt.taskId))) {
        const task = await store.findTaskById(taskId);
        if (task !== undefined) taskTagIds.set(taskId, task.tagId);
        const attempt = runningAttempts
          .filter((candidate) => candidate.taskId === taskId)
          .toSorted((a, b) => b.attemptNumber - a.attemptNumber)[0];
        const running = taskAttemptRunningCommand(attempt, await store.listTaskEvents(taskId));
        if (running !== null) runningCommands.set(taskId, running);
      }
      // The latest Task of each of the Objective's Sessions carries its current findings.
      const objectiveTasks = new Map(
        await Promise.all(
          objectives.map(async (objective) => {
            const tasks: Task[] = [];
            for (const session of await store.listObjectiveSessions(objective.id)) {
              const task =
                session.task === undefined ? undefined : await store.findTaskById(session.task.id);
              if (task !== undefined) tasks.push(task);
            }
            return [objective.id, tasks] as const;
          }),
        ),
      );
      return organizationOverviewMessage(
        organizationStatus({
          asOf: new Date().toISOString(),
          workerHosts: hosts
            .filter((host) => !(host.ephemeral && host.enrollmentStatus === "revoked"))
            .map((host) => workerHostResource(host)),
          tags,
          runningAttempts,
          taskTagIds,
          runningCommands,
          objectives,
          objectiveTasks,
          objectiveSpend: new Map(spend.groups.map((group) => [group.key, group])),
        }),
      );
    },

    async getSpend(request) {
      if (!(request.by in SpendGrouping))
        throw operatorError(
          Code.InvalidArgument,
          ErrorReason.INVALID_ARGUMENT,
          "by must group by Objective, Tag or day",
          [{ path: "by", description: "a SpendGrouping" }],
        );
      const by =
        request.by === SpendGrouping.TAG
          ? "tag"
          : request.by === SpendGrouping.DAY
            ? "day"
            : "objective";
      return spendReportMessage(
        await store.readSpend({
          by,
          ...(request.since === undefined
            ? {}
            : { since: timestampDate(request.since).toISOString() }),
        }),
      );
    },

    async listAuditEntries(request) {
      let query: ReturnType<typeof parseAuditQuery>;
      try {
        query = parseAuditQuery({
          ...(request.since === undefined
            ? {}
            : { since: timestampDate(request.since).toISOString() }),
          ...(request.actor === "" ? {} : { actor: request.actor }),
        });
      } catch (error) {
        throw operatorError(
          Code.InvalidArgument,
          ErrorReason.INVALID_ARGUMENT,
          error instanceof Error ? error.message : String(error),
          [{ path: "actor", description: "1 to 200 characters" }],
        );
      }
      const after = auditPagePosition(request.pageToken);
      const size = pageSizeOf(request.pageSize, AUDIT_DEFAULT_LIMIT, AUDIT_MAX_LIMIT);
      const page = await store.listAuditEntries({
        ...query,
        limit: size,
        ...(after === undefined ? {} : { after }),
      });
      // Another page follows when an entry exists past this one.
      const last = page.at(-1);
      const more =
        last !== undefined &&
        page.length === size &&
        (await store.listAuditEntries({ ...query, limit: 1, after: last })).length > 0;
      return {
        entries: page.map(auditEntryMessage),
        nextPageToken: more && last !== undefined ? auditPageToken(last) : "",
      };
    },

    async getMetrics() {
      return metricSnapshotMessage(
        await store.readCoordinationMetrics(),
        dependencies.rpcTelemetry(),
      );
    },
  };
}

/**
 * A page token naming the last entry of a page. The next page continues after that entry, so
 * entries recorded between the calls neither repeat nor shift it.
 */
function auditPageToken(entry: AuditEntryPosition): string {
  return Buffer.from(JSON.stringify([entry.at, entry.id])).toString("base64url");
}

function auditPagePosition(token: string): AuditEntryPosition | undefined {
  if (token === "") return undefined;
  let position: unknown;
  try {
    position = JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
  } catch {
    position = undefined;
  }
  if (
    Array.isArray(position) &&
    position.length === 2 &&
    typeof position[0] === "string" &&
    !Number.isNaN(Date.parse(position[0])) &&
    typeof position[1] === "string" &&
    position[1] !== "" &&
    position[1].length <= 200
  )
    return { at: position[0], id: position[1] };
  throw operatorError(
    Code.InvalidArgument,
    ErrorReason.INVALID_ARGUMENT,
    "The page token is not valid",
    [{ path: "page_token", description: "a next_page_token from the previous page" }],
  );
}

const CONTROLLER_PHASES: Readonly<Record<string, ControllerPhase>> = {
  running: ControllerPhase.RUNNING,
  degraded: ControllerPhase.DEGRADED,
  draining: ControllerPhase.DRAINING,
  stopped: ControllerPhase.STOPPED,
  disabled: ControllerPhase.DISABLED,
};
