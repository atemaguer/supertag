import type { MessageInitShape } from "@bufbuild/protobuf";
import type {
  AuditEntry as AuditEntryRecord,
  CoordinationMetricSnapshot,
  SpendGroup as SpendGroupRecord,
  SpendReport as SpendReportRecord,
} from "@supertag/core";
import {
  type AuditEntry,
  type AuditEntrySchema,
  AuditOutcome,
  AuditSource,
  type MetricSnapshotSchema,
  type OrganizationOverview,
  type OrganizationOverviewSchema,
  type SpendGroup,
  SpendGrouping,
  type SpendGroupSchema,
  type SpendReport,
  type SpendReportSchema,
  WorkerHostPhase,
} from "@supertag/operator-api";
import type { RpcTelemetrySnapshot } from "@supertag/worker-transport";
import { nameOf, WORKER_HOST_PHASES } from "./host-protos.js";
import { isoOf, OBJECTIVE_STATUS, timestampOf } from "./objective-protos.js";
import type { OrganizationStatus } from "./organization-views.js";

/**
 * `OrganizationService` reports in both directions: from what the Control Plane reads to the
 * operator API's messages, and back to the records `supertag status`, `spend` and `audit` print.
 */

const optionalTimestamp = <K extends string>(key: K, iso: string | null | undefined) =>
  (iso === null || iso === undefined ? {} : { [key]: timestampOf(iso) }) as Partial<
    Record<K, NonNullable<ReturnType<typeof timestampOf>>>
  >;

// The organization overview.

export function organizationOverviewMessage(
  status: OrganizationStatus,
): MessageInitShape<typeof OrganizationOverviewSchema> {
  return {
    ...optionalTimestamp("capturedAt", status.asOf),
    workerHosts: status.workerHosts.map((host) => ({
      id: host.id,
      phase: WORKER_HOST_PHASES[host.phase],
      running: host.running,
      capacity: host.capacity,
      coordinationCapacity: host.coordinationCapacity,
      harnesses: host.harnesses.map((load) => ({ ...load })),
      ...(host.diskSpace === undefined
        ? {}
        : {
            diskSpace: {
              freeBytes: BigInt(host.diskSpace.freeBytes),
              totalBytes: BigInt(host.diskSpace.totalBytes),
            },
          }),
      diskWarning: host.diskWarning ?? "",
    })),
    tags: status.tags.map((tag) => ({
      id: tag.id,
      name: tag.name,
      runningTaskIds: [...tag.runningTaskIds],
      runningCommands: tag.runningCommands.map((running) => ({
        taskId: running.taskId,
        command: running.command,
        ...optionalTimestamp("startedAt", running.startedAt),
      })),
    })),
    objectives: status.objectives.map((objective) => ({
      id: objective.id,
      status: OBJECTIVE_STATUS.value(objective.status),
      ownerTagId: objective.ownerTagId,
      owner: objective.ownerName,
      ...optionalTimestamp("deadline", objective.deadline),
      spentMinor: BigInt(objective.spentMinor),
      ...(objective.budgetLimitMinor === null
        ? {}
        : { budgetLimitMinor: BigInt(objective.budgetLimitMinor) }),
      currency: objective.currency ?? "",
      spendCurrency: objective.spendCurrency ?? "",
      unpricedAttempts: objective.unpricedAttempts ?? 0,
      unpricedTokens: BigInt(objective.unpricedTokens ?? 0),
      highFindings: (objective.highFindings ?? []).map((finding) => ({
        taskId: finding.taskId,
        id: finding.id,
        summary: finding.summary,
        ...(finding.location === undefined ? {} : { location: finding.location }),
      })),
    })),
  };
}

/** The overview as the record `supertag status --output json` prints. */
export function organizationStatusView(overview: OrganizationOverview): OrganizationStatus {
  return {
    asOf: isoOf(overview.capturedAt) ?? "",
    workerHosts: overview.workerHosts.map((host) => ({
      id: host.id,
      phase: nameOf(WORKER_HOST_PHASES, host.phase) ?? phaseOf(host.phase),
      running: host.running,
      capacity: host.capacity,
      coordinationCapacity: host.coordinationCapacity,
      harnesses: host.harnesses.map((load) => ({
        harness: load.harness,
        running: load.running,
        capacity: load.capacity,
        coordinationCapacity: load.coordinationCapacity,
      })),
      ...(host.diskSpace === undefined
        ? {}
        : {
            diskSpace: {
              freeBytes: Number(host.diskSpace.freeBytes),
              totalBytes: Number(host.diskSpace.totalBytes),
            },
            ...(host.diskWarning === "" ? {} : { diskWarning: host.diskWarning }),
          }),
    })),
    tags: overview.tags.map((tag) => ({
      id: tag.id,
      name: tag.name,
      runningTaskIds: [...tag.runningTaskIds],
      runningCommands: tag.runningCommands.map((running) => ({
        taskId: running.taskId,
        command: running.command,
        startedAt: isoOf(running.startedAt) ?? "",
      })),
    })),
    objectives: overview.objectives.map((objective) => ({
      id: objective.id,
      status: OBJECTIVE_STATUS.word(objective.status) ?? "working",
      ownerTagId: objective.ownerTagId,
      ownerName: objective.owner,
      deadline: isoOf(objective.deadline),
      spentMinor: Number(objective.spentMinor),
      budgetLimitMinor:
        objective.budgetLimitMinor === undefined ? null : Number(objective.budgetLimitMinor),
      currency: objective.currency === "" ? null : objective.currency,
      spendCurrency: objective.spendCurrency === "" ? null : objective.spendCurrency,
      ...(objective.unpricedAttempts > 0
        ? {
            unpricedAttempts: objective.unpricedAttempts,
            unpricedTokens: Number(objective.unpricedTokens),
          }
        : {}),
      highFindings: objective.highFindings.map((finding) => ({
        taskId: finding.taskId,
        id: finding.id,
        summary: finding.summary,
        ...(finding.location === undefined || finding.location === ""
          ? {}
          : { location: finding.location }),
      })),
    })),
  };
}

function phaseOf(phase: WorkerHostPhase): never {
  throw new Error(`Control Plane returned an unknown Worker Host phase ${WorkerHostPhase[phase]}`);
}

// Spend.

export const SPEND_GROUPINGS = {
  objective: SpendGrouping.OBJECTIVE,
  tag: SpendGrouping.TAG,
  day: SpendGrouping.DAY,
} as const satisfies Record<SpendReportRecord["by"], SpendGrouping>;

const bigints = (record: Readonly<Record<string, number>> | null | undefined) =>
  Object.fromEntries(Object.entries(record ?? {}).map(([key, value]) => [key, BigInt(value)]));

export function spendReportMessage(
  report: SpendReportRecord,
): MessageInitShape<typeof SpendReportSchema> {
  return {
    by: SPEND_GROUPINGS[report.by],
    ...optionalTimestamp("since", report.since),
    groups: report.groups.map(spendGroupMessage),
  };
}

function spendGroupMessage(group: SpendGroupRecord): MessageInitShape<typeof SpendGroupSchema> {
  return {
    key: group.key,
    name: group.name ?? "",
    ...(group.budget === undefined || group.budget === null
      ? {}
      : {
          budget: {
            limitMinor: BigInt(group.budget.limitMinor),
            currency: group.budget.currency ?? "",
          },
        }),
    attempts: group.attempts,
    reportedCostByCurrency: bigints(group.reportedCostByCurrency),
    unknownCostAttempts: group.unknownCostAttempts,
    estimatedCostAttempts: group.estimatedCostAttempts ?? 0,
    unpricedModels: { ...group.unpricedModels },
    unpricedTokens: BigInt(group.unpricedTokens ?? 0),
    ...(group.reportedTokens === null ? {} : { reportedTokens: BigInt(group.reportedTokens) }),
    unknownTokenAttempts: group.unknownTokenAttempts,
  };
}

/** The report as `supertag spend --output json` prints it, with the store's field order. */
export function spendReportView(report: SpendReport): SpendReportRecord {
  const by = nameOf(SPEND_GROUPINGS, report.by) ?? "objective";
  return {
    by,
    since: isoOf(report.since),
    groups: report.groups.map((group) => spendGroupView(group, by)),
  };
}

function spendGroupView(group: SpendGroup, by: SpendReportRecord["by"]): SpendGroupRecord {
  const costs = Object.entries(group.reportedCostByCurrency);
  const unpriced = Object.entries(group.unpricedModels);
  return {
    key: group.key,
    ...(by === "tag" ? { name: group.name } : {}),
    attempts: group.attempts,
    reportedCostByCurrency:
      costs.length === 0
        ? null
        : Object.fromEntries(costs.map(([currency, amount]) => [currency, Number(amount)])),
    unknownCostAttempts: group.unknownCostAttempts,
    unpricedTokens: Number(group.unpricedTokens),
    reportedTokens: group.reportedTokens === undefined ? null : Number(group.reportedTokens),
    unknownTokenAttempts: group.unknownTokenAttempts,
    ...(by === "objective"
      ? {
          budget:
            group.budget === undefined
              ? null
              : {
                  limitMinor: Number(group.budget.limitMinor),
                  currency: group.budget.currency === "" ? null : group.budget.currency,
                },
        }
      : {}),
    ...(group.estimatedCostAttempts === 0
      ? {}
      : { estimatedCostAttempts: group.estimatedCostAttempts }),
    ...(unpriced.length === 0 ? {} : { unpricedModels: Object.fromEntries(unpriced) }),
  };
}

// The audit trail.

const AUDIT_OUTCOMES = {
  succeeded: AuditOutcome.SUCCEEDED,
  failed: AuditOutcome.FAILED,
} as const satisfies Record<AuditEntryRecord["outcome"], AuditOutcome>;

const AUDIT_SOURCES = {
  api: AuditSource.API,
  gateway: AuditSource.GATEWAY,
} as const satisfies Record<AuditEntryRecord["source"], AuditSource>;

export function auditEntryMessage(
  entry: AuditEntryRecord,
): MessageInitShape<typeof AuditEntrySchema> {
  return {
    id: entry.id,
    ...optionalTimestamp("at", entry.at),
    actor: entry.actor,
    action: entry.action,
    target: entry.target,
    outcome: AUDIT_OUTCOMES[entry.outcome],
    ...(entry.status === undefined ? {} : { status: entry.status }),
    source: AUDIT_SOURCES[entry.source],
    method: entry.method ?? "",
    path: entry.path ?? "",
  };
}

/** An entry as `supertag audit --output json` prints it. */
export function auditEntryView(entry: AuditEntry): AuditEntryRecord {
  return {
    id: entry.id,
    at: isoOf(entry.at) ?? "",
    actor: entry.actor,
    action: entry.action,
    target: entry.target,
    outcome: nameOf(AUDIT_OUTCOMES, entry.outcome) ?? "failed",
    ...(entry.status === undefined ? {} : { status: entry.status }),
    source: nameOf(AUDIT_SOURCES, entry.source) ?? "api",
    ...(entry.method === "" ? {} : { method: entry.method }),
    ...(entry.path === "" ? {} : { path: entry.path }),
  };
}

// Metrics.

const METRIC_HOST_PHASES = {
  connected: WorkerHostPhase.CONNECTED,
  draining: WorkerHostPhase.DRAINING,
  unreachable: WorkerHostPhase.UNREACHABLE,
} as const;

const counts = (record: Readonly<Record<string, number>>) =>
  Object.fromEntries(Object.entries(record).map(([key, value]) => [key, BigInt(value)]));

const optionalSeconds = <K extends string>(key: K, seconds: number | null) =>
  (seconds === null ? {} : { [key]: BigInt(seconds) }) as Partial<Record<K, bigint>>;

/**
 * The stored metrics and this process's RPC counters as a `MetricSnapshot`. `rpc` is the
 * answering API Server process's own; everything else comes from stored records.
 */
export function metricSnapshotMessage(
  metrics: CoordinationMetricSnapshot,
  rpc: RpcTelemetrySnapshot,
): MessageInitShape<typeof MetricSnapshotSchema> {
  const { coordinationInbox: inbox, scheduling } = metrics;
  return {
    ...optionalTimestamp("capturedAt", metrics.capturedAt),
    tags: BigInt(metrics.tags),
    roles: BigInt(metrics.roles),
    roleAssignments: BigInt(metrics.roleAssignments),
    surfaceAccounts: BigInt(metrics.surfaceAccounts),
    permissionSets: BigInt(metrics.permissionSets),
    contextSets: BigInt(metrics.contextSets),
    sessions: BigInt(metrics.sessions),
    tasks: counts(metrics.tasks),
    recovery: counts(metrics.recovery),
    coordinationInbox: {
      pending: BigInt(inbox.pending),
      byKind: counts(inbox.byKind),
      ...optionalTimestamp("oldestActionableAt", inbox.oldestActionableAt),
      ...optionalSeconds("oldestActionableAgeSeconds", inbox.oldestActionableAgeSeconds),
    },
    usage: {
      reportingAttempts: BigInt(metrics.usage.reportingAttempts),
      totalTokens: BigInt(metrics.usage.totalTokens),
      incompleteAttempts: BigInt(metrics.usage.incompleteAttempts),
      reportedCostByCurrency: counts(metrics.usage.reportedCostByCurrency),
    },
    nativeAgents: counts(metrics.nativeAgents),
    scheduling: {
      queued: BigInt(scheduling.queued),
      ...optionalTimestamp("oldestQueuedAt", scheduling.oldestQueuedAt),
      ...optionalSeconds("oldestQueuedAgeSeconds", scheduling.oldestQueuedAgeSeconds),
      placedAttempts: BigInt(scheduling.placedAttempts),
      averageQueueDurationMs: scheduling.averageQueueDurationMs,
      maximumQueueDurationMs: scheduling.maximumQueueDurationMs,
      averagePlacementDurationMs: scheduling.averagePlacementDurationMs,
      maximumPlacementDurationMs: scheduling.maximumPlacementDurationMs,
      admissionRejections: BigInt(scheduling.admissionRejections),
      reservations: counts(scheduling.reservations),
      workerHosts: scheduling.workerHosts.map((host) => ({
        id: host.id,
        phase: METRIC_HOST_PHASES[host.phase],
        activeAttempts: host.activeAttempts,
        capacity: host.capacity,
        availableSlots: host.availableSlots,
        utilization: host.utilization,
      })),
    },
    mailbox: {
      pending: BigInt(metrics.mailbox.pending),
      ...optionalTimestamp("oldestPendingAt", metrics.mailbox.oldestPendingAt),
    },
    replyDelivery: {
      backlog: BigInt(metrics.replyDelivery.backlog),
      retrying: BigInt(metrics.replyDelivery.retrying),
      retryAttempts: BigInt(metrics.replyDelivery.retryAttempts),
      failed: BigInt(metrics.replyDelivery.failed),
      ...optionalTimestamp("oldestPendingAt", metrics.replyDelivery.oldestPendingAt),
    },
    rpc: {
      ...optionalTimestamp("startedAt", rpc.startedAt),
      ...optionalTimestamp("capturedAt", rpc.capturedAt),
      methods: rpc.methods.map((method) => ({
        service: method.service,
        method: method.method,
        started: BigInt(method.started),
        completed: BigInt(method.completed),
        active: BigInt(method.active),
        activeStreams: BigInt(method.activeStreams),
        errors: BigInt(method.errors),
        statusCodes: method.statusCodes.map((count) => BigInt(count)),
        duration: {
          count: BigInt(method.durationMs.count),
          total: method.durationMs.total,
          max: method.durationMs.max,
          buckets: method.durationMs.buckets.map((bucket) => ({
            ...(bucket.le === null ? {} : { le: bucket.le }),
            count: BigInt(bucket.count),
          })),
        },
      })),
      channels: counts(rpc.channels),
      queues: counts(rpc.queues),
      closeCodes: counts(rpc.closeCodes),
      traceErrors: BigInt(rpc.traceErrors),
    },
  };
}
