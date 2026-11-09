import type { JsonObject, MessageInitShape } from "@bufbuild/protobuf";
import type { TaskExecutionLimitReport } from "@supertag/control-plane";
import type {
  CapturedArtifact,
  ExecutionEffort,
  JsonRecord,
  LiveMount as LiveMountRecord,
  MountManifest as MountManifestRecord,
  MountOutputManifest as MountOutputManifestRecord,
  ResolvedArtifactTransfer,
  Session as SessionRecord,
  SessionStateRecord,
  SessionStateSummary,
  TaskEvent as TaskEventRecord,
  TaskExecutionRequirements,
  TaskFinding as TaskFindingRecord,
} from "@supertag/core";
import {
  type Artifact,
  type ArtifactCopy,
  type ArtifactDownload,
  type ArtifactDownloadSchema,
  type ArtifactSchema,
  CleanupStatus,
  EnvironmentPlacement,
  type ExecutionEnvironment,
  ExecutionSource,
  type InspectTaskExecutionResponseSchema,
  LimitOutcomeStatus,
  ModelSource,
  MountAccess,
  MountOutputStatus,
  OutputGitMode,
  PlacementMode,
  PlacementReservationPhase,
  PlacementStatus,
  SchedulingStatus,
  type Session,
  SessionAudience,
  SessionPhase,
  type SessionSchema,
  type SessionState,
  type SessionStateSchema,
  SessionStateStatus,
  type Task,
  type TaskEventSchema,
  TaskExecutionAvailability,
  TaskFindingSeverity,
  type TaskSchema,
} from "@supertag/operator-api";
import {
  ATTEMPT_STATUS,
  DELIVERY_MODE,
  deliveryMessage,
  deliveryRecord,
  enumTable,
  isoOf,
  TASK_STATUS,
  timestampOf,
} from "./objective-protos.js";
import type { TaskExecutionInspection } from "./operator-seams.js";
import type { ArtifactCopyLocations, TaskArtifactLocation, TaskStorage } from "./task-storage.js";
import type { SessionResource, TaskResource } from "./work-views.js";

const OUTPUT_GIT = enumTable(
  [
    ["reference", OutputGitMode.REFERENCE],
    ["capture", OutputGitMode.CAPTURE],
    ["ignore", OutputGitMode.IGNORE],
  ] as const,
  OutputGitMode.UNSPECIFIED,
);

const FINDING_SEVERITY = enumTable(
  [
    ["high", TaskFindingSeverity.HIGH],
    ["medium", TaskFindingSeverity.MEDIUM],
    ["low", TaskFindingSeverity.LOW],
  ] as const,
  TaskFindingSeverity.UNSPECIFIED,
);

const EXECUTION_SOURCE = enumTable(
  [
    ["default", ExecutionSource.DEFAULT],
    ["chosen", ExecutionSource.CHOSEN],
  ] as const,
  ExecutionSource.UNSPECIFIED,
);

const MODEL_SOURCE = enumTable(
  [
    ["task", ModelSource.TASK],
    ["host-default", ModelSource.HOST_DEFAULT],
  ] as const,
  ModelSource.UNSPECIFIED,
);

const MOUNT_ACCESS = enumTable(
  [
    ["read-only", MountAccess.READ_ONLY],
    ["read-write", MountAccess.READ_WRITE],
  ] as const,
  MountAccess.UNSPECIFIED,
);

const MOUNT_OUTPUT_STATUS = enumTable(
  [
    ["complete", MountOutputStatus.COMPLETE],
    ["partial", MountOutputStatus.PARTIAL],
    ["refused", MountOutputStatus.REFUSED],
  ] as const,
  MountOutputStatus.UNSPECIFIED,
);

const RESERVATION_PHASE = enumTable(
  [
    ["reserved", PlacementReservationPhase.RESERVED],
    ["consumed", PlacementReservationPhase.CONSUMED],
    ["expired", PlacementReservationPhase.EXPIRED],
  ] as const,
  PlacementReservationPhase.UNSPECIFIED,
);

const PLACEMENT_STATUS = enumTable(
  [
    ["not_started", PlacementStatus.NOT_STARTED],
    ["pending", PlacementStatus.PENDING],
    ["available", PlacementStatus.AVAILABLE],
    ["unknown", PlacementStatus.UNKNOWN],
  ] as const,
  PlacementStatus.UNSPECIFIED,
);

const PLACEMENT_MODE = enumTable(
  [
    ["colocated", PlacementMode.COLOCATED],
    ["split", PlacementMode.SPLIT],
  ] as const,
  PlacementMode.UNSPECIFIED,
);

const CLEANUP_STATUS = enumTable(
  [
    ["not_started", CleanupStatus.NOT_STARTED],
    ["pending", CleanupStatus.PENDING],
    ["confirmed", CleanupStatus.CONFIRMED],
    ["unknown", CleanupStatus.UNKNOWN],
  ] as const,
  CleanupStatus.UNSPECIFIED,
);

const ENVIRONMENT_PLACEMENT = enumTable(
  [
    ["local", EnvironmentPlacement.LOCAL],
    ["remote", EnvironmentPlacement.REMOTE],
    ["managed", EnvironmentPlacement.MANAGED],
  ] as const,
  EnvironmentPlacement.UNSPECIFIED,
);

const SCHEDULING_STATUS = enumTable(
  [
    ["compatible", SchedulingStatus.COMPATIBLE],
    ["incompatible", SchedulingStatus.INCOMPATIBLE],
  ] as const,
  SchedulingStatus.UNSPECIFIED,
);

const AVAILABILITY = enumTable(
  [
    ["not_started", TaskExecutionAvailability.NOT_STARTED],
    ["unsupported", TaskExecutionAvailability.UNSUPPORTED],
    ["unavailable", TaskExecutionAvailability.UNAVAILABLE],
    ["available", TaskExecutionAvailability.AVAILABLE],
  ] as const,
  TaskExecutionAvailability.UNSPECIFIED,
);

const LIMIT_OUTCOME = enumTable(
  [
    ["not_requested", LimitOutcomeStatus.NOT_REQUESTED],
    ["pending", LimitOutcomeStatus.PENDING],
    ["within_limits", LimitOutcomeStatus.WITHIN_LIMITS],
    ["threshold_reached", LimitOutcomeStatus.THRESHOLD_REACHED],
    ["unknown", LimitOutcomeStatus.UNKNOWN],
  ] as const,
  LimitOutcomeStatus.UNSPECIFIED,
);

const SESSION_AUDIENCE = enumTable(
  [
    ["shared", SessionAudience.SHARED],
    ["private", SessionAudience.PRIVATE],
  ] as const,
  SessionAudience.UNSPECIFIED,
);

const SESSION_STATE_STATUS = enumTable(
  [
    ["stored", SessionStateStatus.STORED],
    ["resumable", SessionStateStatus.RESUMABLE],
  ] as const,
  SessionStateStatus.UNSPECIFIED,
);

type Row = Record<string, unknown>;

const set = <K extends string, V>(key: K, value: V | null | undefined) =>
  (value === null || value === undefined ? {} : { [key]: value }) as Partial<Record<K, V>>;

function isRow(value: unknown): value is Row {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** A stored record as a protobuf `Struct`: JSON values only, undefined fields left out. */
function jsonObject(value: unknown): JsonObject | undefined {
  return isRow(value) ? (JSON.parse(JSON.stringify(value)) as JsonObject) : undefined;
}

const nonEmpty = (value: string) => (value === "" ? undefined : value);

function money(value: unknown) {
  return isRow(value) && typeof value["currency"] === "string"
    ? { currency: value["currency"], amountMinor: BigInt(Math.trunc(count(value["amountMinor"]))) }
    : undefined;
}

function moneyRecord(value: { currency: string; amountMinor: bigint } | undefined) {
  return value === undefined
    ? undefined
    : { amountMinor: Number(value.amountMinor), currency: value.currency };
}

// From the Control Plane's views and records to operator API messages.

function executionMessage(execution: TaskExecutionRequirements) {
  const outputs = execution.outputs;
  const limits = execution.limits;
  return {
    harness: execution.harness ?? "",
    model: execution.model ?? "",
    effort: execution.effort ?? "",
    ...set("profile", execution.profile),
    requires: (execution.requires ?? []).map(({ id, version }) => ({ id, version })),
    prefers: (execution.prefers ?? []).map(({ id, version }) => ({ id, version })),
    ...(outputs === undefined
      ? {}
      : {
          outputs: {
            directory: outputs.directory ?? "",
            required: [...(outputs.required ?? [])],
            include: [...(outputs.include ?? [])],
            exclude: [...(outputs.exclude ?? [])],
            git: OUTPUT_GIT.value(outputs.git),
            ...set("maxFiles", outputs.maxFiles),
            ...set(
              "maxBytes",
              outputs.maxBytes === undefined ? undefined : BigInt(outputs.maxBytes),
            ),
          },
        }),
    ...(limits === undefined ? {} : { limits: limitsMessage(limits) }),
  };
}

function limitsMessage(limits: NonNullable<TaskExecutionRequirements["limits"]>) {
  return {
    ...set("maxNativeAgents", limits.maxNativeAgents),
    ...set(
      "maxReportedTokens",
      limits.maxReportedTokens === undefined ? undefined : BigInt(limits.maxReportedTokens),
    ),
    ...set("maxReportedCost", money(limits.maxReportedCost)),
  };
}

function findingMessage(finding: TaskFindingRecord) {
  return {
    id: finding.id,
    severity: FINDING_SEVERITY.value(finding.severity),
    summary: finding.summary,
    location: finding.location ?? "",
  };
}

function liveMountMessage(mount: LiveMountRecord) {
  return {
    volume: mount.volume,
    source: mount.source,
    prefix: mount.prefix,
    path: mount.path,
    access: MOUNT_ACCESS.value(mount.access),
    ...set("attachedAt", timestampOf(mount.attachedAt)),
  };
}

function mountManifestMessage(manifest: MountManifestRecord) {
  return {
    volume: manifest.volume,
    source: manifest.source,
    path: manifest.path,
    access: MOUNT_ACCESS.value(manifest.access),
    objectCount: manifest.objectCount,
    totalBytes: BigInt(manifest.totalBytes),
    digest: manifest.digest,
    ...set("copiedAt", timestampOf(manifest.copiedAt)),
    objects: manifest.objects.map((object) => ({
      key: object.key,
      size: BigInt(object.size),
      etag: object.etag ?? "",
      versionId: object.versionId ?? "",
      sha256: object.sha256 ?? "",
    })),
  };
}

function mountOutputMessage(manifest: MountOutputManifestRecord) {
  return {
    volume: manifest.volume,
    source: manifest.source,
    path: manifest.path,
    status: MOUNT_OUTPUT_STATUS.value(manifest.status),
    ...set("uploadedAt", timestampOf(manifest.uploadedAt)),
    objects: manifest.objects.map((object) => ({
      key: object.key,
      size: BigInt(object.size),
      sha256: object.sha256,
    })),
    skipped: manifest.skipped,
    ...set("error", manifest.error),
    notAttempted: [...manifest.notAttempted],
  };
}

function environmentMessage(value: unknown, withProvenance: boolean) {
  if (!isRow(value)) return undefined;
  return {
    id: text(value["id"]),
    provider: text(value["provider"]),
    placement: ENVIRONMENT_PLACEMENT.value(text(value["placement"])),
    ...(withProvenance ? set("provenance", jsonObject(value["provenance"])) : {}),
  };
}

function placementMessage(placement: unknown, withProvenance: boolean) {
  if (!isRow(placement)) return undefined;
  const failure = isRow(placement["cleanupFailure"]) ? placement["cleanupFailure"] : undefined;
  const harness = isRow(placement["harness"]) ? placement["harness"] : undefined;
  return {
    status: PLACEMENT_STATUS.value(text(placement["status"])),
    mode: PLACEMENT_MODE.value(text(placement["mode"])),
    cleanup: CLEANUP_STATUS.value(text(placement["cleanup"])),
    ...(failure === undefined
      ? {}
      : {
          cleanupFailure: {
            sequence: BigInt(count(failure["sequence"])),
            ...set("at", timestampOf(text(failure["at"]))),
            summary: text(failure["summary"]),
            items: (Array.isArray(failure["items"]) ? failure["items"] : [])
              .filter(isRow)
              .map((item) => ({ id: text(item["id"]), text: text(item["text"]) })),
          },
        }),
    ...(harness === undefined
      ? {}
      : {
          harness: {
            id: text(harness["id"]),
            version: text(harness["version"]),
            ...(withProvenance ? set("provenance", jsonObject(harness["provenance"])) : {}),
          },
        }),
    ...set("harnessRuntime", environmentMessage(placement["harnessRuntime"], withProvenance)),
    ...set(
      "executionEnvironment",
      environmentMessage(placement["executionEnvironment"], withProvenance),
    ),
  };
}

function recordedEventMessage(value: unknown) {
  if (!isRow(value)) return undefined;
  return {
    message: text(value["message"]),
    ...set("at", timestampOf(text(value["at"]))),
    sequence: BigInt(count(value["sequence"])),
  };
}

function latestAttemptMessage(attempt: Row) {
  const profile = isRow(attempt["workerProfile"]) ? attempt["workerProfile"] : undefined;
  const selection = isRow(attempt["selection"]) ? attempt["selection"] : undefined;
  const reservation =
    selection !== undefined && isRow(selection["reservation"])
      ? selection["reservation"]
      : undefined;
  const command = isRow(attempt["runningCommand"]) ? attempt["runningCommand"] : undefined;
  const last = isRow(attempt["lastEvent"]) ? attempt["lastEvent"] : undefined;
  return {
    id: text(attempt["id"]),
    number: count(attempt["number"]),
    status: ATTEMPT_STATUS.value(text(attempt["phase"])),
    ...(profile === undefined
      ? {}
      : { workerProfile: { id: text(profile["id"]), revision: text(profile["revision"]) } }),
    durableExecution: attempt["durableExecution"] === true,
    ...set("failure", recordedEventMessage(attempt["failure"])),
    warnings: (Array.isArray(attempt["warnings"]) ? attempt["warnings"] : []).flatMap((warning) => {
      const message = recordedEventMessage(warning);
      return message === undefined ? [] : [message];
    }),
    ...(command === undefined
      ? {}
      : {
          runningCommand: {
            command: text(command["command"]),
            ...set("startedAt", timestampOf(text(command["startedAt"]))),
          },
        }),
    workerId: text(attempt["workerId"]),
    workerHostId: text(attempt["workerHostId"]),
    workletId: text(attempt["workletId"]),
    ...(selection === undefined
      ? {}
      : {
          selection: {
            allowedWorkerHostIds: (Array.isArray(selection["allowedWorkerHostIds"])
              ? selection["allowedWorkerHostIds"]
              : []
            ).filter((id): id is string => typeof id === "string"),
            ...(reservation === undefined
              ? {}
              : {
                  reservation: {
                    id: text(reservation["id"]),
                    ...set("expiresAt", timestampOf(text(reservation["expiresAt"]))),
                    phase: RESERVATION_PHASE.value(text(reservation["phase"])),
                  },
                }),
          },
        }),
    ...(last === undefined
      ? {}
      : {
          lastEvent: {
            type: text(last["type"]),
            sequence: BigInt(count(last["sequence"])),
            ...set("at", timestampOf(text(last["at"]))),
          },
        }),
    ...set("placement", placementMessage(attempt["placement"], false)),
  };
}

function copyMessage(location: TaskArtifactLocation) {
  return location.kind === "volume"
    ? { place: { case: "volume" as const, value: { volume: location.volume } } }
    : {
        place: {
          case: "workerHost" as const,
          value: {
            workerHostId: location.workerHostId,
            ephemeral: location.ephemeral,
            removed: location.removed,
          },
        },
      };
}

function storageMessage(storage: TaskStorage) {
  return {
    ...set(
      "taskFiles",
      storage.taskFiles === undefined ? undefined : filesMessage(storage.taskFiles),
    ),
    artifacts: storage.artifacts.map((artifact) => ({
      artifactId: artifact.artifactId,
      title: artifact.title,
      files: artifact.files,
      copies: artifact.locations.map(copyMessage),
      ephemeralOnly: artifact.ephemeralOnly,
    })),
    moreArtifacts: storage.moreArtifacts,
  };
}

function filesMessage(files: NonNullable<TaskStorage["taskFiles"]>) {
  return {
    workerHostId: files.workerHostId,
    ephemeral: files.ephemeral,
    sandbox: files.sandbox ?? "",
    placementUnknown: files.placementUnknown === true,
  };
}

/** A Task view as `WorkService` serves it; `tagName` is its Tag's, when the Tag exists. */
export function taskMessage(
  resource: TaskResource,
  tagName: string | undefined,
  chosenByTag: string | undefined,
): MessageInitShape<typeof TaskSchema> {
  const { spec, status } = resource;
  const findings = status.findings;
  const resolution = status.execution as Row | undefined;
  const latestExecution =
    resolution !== undefined && isRow(resolution["latestAttempt"])
      ? resolution["latestAttempt"]
      : undefined;
  const scheduling = status.scheduling as Row | undefined;
  const pullRequest = status.pullRequest;
  return {
    id: resource.metadata.id,
    resourceVersion: resource.metadata.resourceVersion,
    tagId: spec.tagId,
    tag: tagName ?? "",
    sessionId: spec.sessionId,
    objectiveId: spec.objectiveId ?? "",
    status: TASK_STATUS.value(status.phase),
    ...set("createdAt", timestampOf(resource.metadata.createdAt)),
    ...set("updatedAt", timestampOf(resource.metadata.updatedAt)),
    ...set("startedAt", timestampOf(status.startedAt)),
    ...set("endedAt", timestampOf(status.endedAt)),
    execution: executionMessage(spec.execution),
    ...set("trigger", jsonObject(spec.trigger)),
    ...(spec.workspace === undefined
      ? {}
      : {
          workspace: {
            name: spec.workspace.name,
            branch: spec.workspace.branch,
            ref: spec.workspace.ref ?? "",
            delivery: DELIVERY_MODE.value(spec.workspace.delivery),
          },
        }),
    ...set("outcome", jsonObject(status.outcome)),
    ...(findings === undefined
      ? {}
      : "unreadable" in findings
        ? { findings: { unreadable: String(findings.unreadable) } }
        : {
            findings: {
              findings: [...findings.high, ...findings.medium, ...findings.low].map(findingMessage),
            },
          }),
    ...(resolution === undefined
      ? {}
      : {
          resolution: {
            source: EXECUTION_SOURCE.value(text(resolution["source"])),
            chosenByTagId: text(resolution["chosenByTagId"]),
            chosenByTag: chosenByTag ?? "",
            harness: text(resolution["harness"]),
            model: text(resolution["model"]),
            effort: text(resolution["effort"]),
            ...(latestExecution === undefined
              ? {}
              : {
                  latestAttempt: {
                    harness: text(latestExecution["harness"]),
                    model: text(latestExecution["model"]),
                    modelSource: MODEL_SOURCE.value(text(latestExecution["modelSource"])),
                    effort: text(latestExecution["effort"]),
                    effortIgnored: text(latestExecution["effortIgnored"]),
                  },
                }),
          },
        }),
    skills: (status.skills ?? []).map(({ name, source, digest }) => ({ name, source, digest })),
    ...set("preparedWorkspace", status.preparedWorkspace),
    attempts: (status.attempts ?? []).map((attempt) => {
      const cost = attempt.reportedCost;
      const mounts = (attempt as { readonly liveMounts?: readonly LiveMountRecord[] }).liveMounts;
      return {
        id: attempt.id,
        number: attempt.number,
        status: ATTEMPT_STATUS.value(attempt.phase),
        ...set("startedAt", timestampOf(attempt.startedAt)),
        ...set("endedAt", timestampOf(attempt.endedAt)),
        ...(cost === null || cost === undefined
          ? {}
          : { reportedCost: { cost: money(cost), estimated: cost.estimated === true } }),
        liveMounts: (mounts ?? []).map(liveMountMessage),
        mountManifests: (attempt.mountManifests ?? []).map(mountManifestMessage),
        mountOutputManifests: (attempt.mountOutputManifests ?? []).map(mountOutputMessage),
      };
    }),
    ...(status.attempt === undefined
      ? {}
      : { latestAttempt: latestAttemptMessage(status.attempt) }),
    ...(scheduling === undefined
      ? {}
      : {
          scheduling: {
            status: SCHEDULING_STATUS.value(text(scheduling["status"])),
            unmetRequirements: strings(scheduling["unmetRequirements"]),
            reason: text(scheduling["reason"]),
            unsandboxedCommands: (Array.isArray(scheduling["unsandboxedCommands"])
              ? scheduling["unsandboxedCommands"]
              : []
            )
              .filter(isRow)
              .map((hold) => ({
                workerHostId: text(hold["workerHostId"]),
                harnesses: strings(hold["harnesses"]),
              })),
            workspaceRefusals: strings(scheduling["workspaceRefusals"]),
            ...set("observedAt", timestampOf(text(scheduling["observedAt"]))),
            sequence: BigInt(count(scheduling["sequence"])),
          },
        }),
    ...(pullRequest === undefined
      ? {}
      : {
          pullRequest: deliveryMessage({ patches: [], outputs: [], pullRequest }).pullRequest,
        }),
    ...(status.delivery === undefined ? {} : { delivery: deliveryMessage(status.delivery) }),
    ...(status.storage === undefined ? {} : { storage: storageMessage(status.storage) }),
  };
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

export function taskEventMessage(event: TaskEventRecord): MessageInitShape<typeof TaskEventSchema> {
  return {
    id: event.id,
    taskId: event.taskId,
    attemptId: event.attemptId ?? "",
    sequence: BigInt(event.sequence),
    type: event.type,
    ...set("payload", jsonObject(event.payload)),
    ...set("createdAt", timestampOf(event.createdAt)),
  };
}

/** How a Task's latest Task Attempt ran, as `InspectTaskExecution` returns it. */
export function inspectionMessage(
  report: TaskExecutionInspection,
): MessageInitShape<typeof InspectTaskExecutionResponseSchema> {
  return {
    availability: AVAILABILITY.value(report.availability),
    attemptId: report.attemptId ?? "",
    ...set("receipt", jsonObject(report.receipt)),
    limits: limitReportMessage(report.limits),
    ...set("placement", placementMessage(report.placement, true)),
  };
}

function limitReportMessage(report: TaskExecutionLimitReport) {
  const applied = report.applied;
  const usage = report.observed.usage;
  const threshold = report.outcome.thresholdReached;
  return {
    requested: limitsMessage(report.requested),
    ...(applied === null
      ? {}
      : {
          applied: {
            ...(applied.maxNativeAgents === undefined
              ? {}
              : {
                  maxNativeAgents: {
                    limit: BigInt(applied.maxNativeAgents.limit),
                    method: applied.maxNativeAgents.method,
                  },
                }),
            ...(applied.maxReportedTokens === undefined
              ? {}
              : {
                  maxReportedTokens: {
                    limit: BigInt(applied.maxReportedTokens.limit),
                    method: applied.maxReportedTokens.method,
                  },
                }),
            ...(applied.maxReportedCost === undefined
              ? {}
              : {
                  maxReportedCost: {
                    ...set("limit", money(applied.maxReportedCost.limit)),
                    method: applied.maxReportedCost.method,
                  },
                }),
          },
        }),
    observed: {
      ...(usage === null
        ? {}
        : {
            usage: {
              inputTokens: BigInt(usage.inputTokens),
              outputTokens: BigInt(usage.outputTokens),
              cachedInputTokens: BigInt(usage.cachedInputTokens),
              ...set(
                "cacheWriteTokens",
                usage.cacheWriteTokens === undefined ? undefined : BigInt(usage.cacheWriteTokens),
              ),
              ...set(
                "reasoningTokens",
                usage.reasoningTokens === undefined ? undefined : BigInt(usage.reasoningTokens),
              ),
              totalTokens: BigInt(usage.totalTokens),
              complete: usage.complete,
              ...(usage.reportedCost === undefined
                ? {}
                : {
                    reportedCost: {
                      cost: money(usage.reportedCost),
                      estimated: usage.reportedCost.estimated === true,
                    },
                  }),
              unpricedModel: usage.unpricedModel ?? "",
            },
          }),
      peakNativeAgents: report.observed.peakNativeAgents,
    },
    completeness: {
      applied: report.completeness.applied,
      ...set("usage", report.completeness.usage),
      terminal: report.completeness.terminal,
      complete: report.completeness.complete,
    },
    outcome: {
      status: LIMIT_OUTCOME.value(report.outcome.status),
      thresholdReached: {
        ...set("maxNativeAgents", threshold.maxNativeAgents),
        ...set("maxReportedTokens", threshold.maxReportedTokens),
        ...set("maxReportedCost", threshold.maxReportedCost),
      },
    },
  };
}

/**
 * A Session view as `WorkService` serves it. `delivery` is what its latest delivering Task
 * delivered, with where that Task's files are.
 */
export function sessionMessage(
  session: SessionRecord,
  resource: SessionResource,
  latestTaskId: string | undefined,
  delivery?: {
    readonly taskId: string;
    readonly delivery: NonNullable<TaskResource["status"]["delivery"]>;
    readonly checkout: TaskStorage["taskFiles"];
  },
): MessageInitShape<typeof SessionSchema> {
  return {
    id: session.id,
    resourceVersion: resource.metadata.resourceVersion,
    tagId: session.tagId,
    tag: resource.status.tag ?? "",
    sessionKey: session.sessionKey,
    ...set("origin", jsonObject(session.origin)),
    phase: session.state === "open" ? SessionPhase.OPEN : SessionPhase.UNSPECIFIED,
    audience: SESSION_AUDIENCE.value(session.audience),
    parentSessionId: session.parentSessionId ?? "",
    objectiveId: session.objectiveId ?? "",
    title: resource.status.title ?? "",
    latestTaskId: latestTaskId ?? "",
    latestTaskStatus: TASK_STATUS.value(resource.status.latestTaskStatus),
    ...set("lastInteractionAt", timestampOf(session.lastInteractionAt)),
    ...set("createdAt", timestampOf(session.createdAt)),
    ...set("updatedAt", timestampOf(session.updatedAt)),
    ...(delivery === undefined
      ? {}
      : {
          delivery: {
            taskId: delivery.taskId,
            delivery: deliveryMessage(delivery.delivery),
            ...set(
              "checkout",
              delivery.checkout === undefined ? undefined : filesMessage(delivery.checkout),
            ),
          },
        }),
  };
}

export function sessionStateMessage(
  state: SessionStateSummary | SessionStateRecord,
): MessageInitShape<typeof SessionStateSchema> {
  return {
    id: state.id,
    sessionId: state.sessionId,
    taskId: state.taskId,
    attemptId: state.attemptId,
    harnessId: state.harnessId,
    nativeId: state.nativeId ?? "",
    ...set("ref", jsonObject(state.ref)),
    status: SESSION_STATE_STATUS.value(state.status),
    writeVersion: BigInt(state.writeVersion),
    compatibility: state.compatibility ?? "",
    ...set("workerProfile", state.workerProfile),
    ...set("createdAt", timestampOf(state.createdAt)),
    ...set("updatedAt", timestampOf(state.updatedAt)),
    ...("data" in state ? set("data", jsonObject(state.data)) : {}),
  };
}

export function artifactMessage(
  artifact: CapturedArtifact,
  copies: ArtifactCopyLocations,
): MessageInitShape<typeof ArtifactSchema> {
  return {
    id: artifact.id,
    taskId: artifact.taskId,
    attemptId: artifact.attemptId,
    tagId: artifact.tagId,
    objectiveId: artifact.objectiveId ?? "",
    sessionId: artifact.sessionId,
    operationId: artifact.operationId,
    ...set("harnessSession", artifact.harnessSession),
    title: artifact.title,
    summary: artifact.summary ?? "",
    kind: artifact.kind,
    entries: artifact.entries.map((entry) => ({
      path: entry.path,
      uri: entry.uri,
      digest: entry.digest,
      sizeBytes: BigInt(entry.sizeBytes),
      mediaType: entry.mediaType ?? "",
    })),
    inputs: artifact.inputs.map(({ artifactId, paths }) => ({ artifactId, paths: [...paths] })),
    ...set("createdAt", timestampOf(artifact.createdAt)),
    copies: copies.locations.map(copyMessage),
    ephemeralOnly: copies.ephemeralOnly,
  };
}

export function artifactDownloadMessage(
  resolved: ResolvedArtifactTransfer,
): MessageInitShape<typeof ArtifactDownloadSchema> {
  return {
    artifactId: resolved.artifactId,
    path: resolved.path,
    digest: resolved.digest,
    sizeBytes: BigInt(resolved.sizeBytes),
    transfers: resolved.locations.map(({ workerHostId, transferUrl, grant }) => ({
      workerHostId,
      transferUrl,
      grant,
    })),
    volumes: resolved.volumes.map(({ volume, source, credential, key }) => ({
      volume,
      source,
      credential: credential ?? "",
      key,
    })),
    holders: {
      workerHostIds: [...resolved.holders.workerHostIds],
      volumes: [...resolved.holders.volumes],
    },
    ...set("expiresAt", timestampOf(resolved.expiresAt)),
  };
}

// From operator API messages to the views the CLI's text output reads.

function executionRecord(execution: Task["execution"]): TaskExecutionRequirements {
  if (execution === undefined) return {};
  const outputs = execution.outputs;
  return {
    ...(outputs === undefined
      ? {}
      : {
          outputs: {
            ...set("directory", nonEmpty(outputs.directory)),
            ...(outputs.required.length ? { required: outputs.required } : {}),
            ...(outputs.include.length ? { include: outputs.include } : {}),
            ...(outputs.exclude.length ? { exclude: outputs.exclude } : {}),
            ...set("git", OUTPUT_GIT.word(outputs.git)),
            ...set("maxFiles", outputs.maxFiles),
            ...set(
              "maxBytes",
              outputs.maxBytes === undefined ? undefined : Number(outputs.maxBytes),
            ),
          },
        }),
    ...(execution.requires.length
      ? { requires: execution.requires.map(({ id, version }) => ({ id, version })) }
      : {}),
    ...(execution.prefers.length
      ? { prefers: execution.prefers.map(({ id, version }) => ({ id, version })) }
      : {}),
    ...(execution.profile === undefined
      ? {}
      : { profile: { id: execution.profile.id, revision: execution.profile.revision } }),
    ...set("harness", nonEmpty(execution.harness)),
    ...set("model", nonEmpty(execution.model)),
    ...set("effort", nonEmpty(execution.effort) as ExecutionEffort | undefined),
    ...(execution.limits === undefined
      ? {}
      : {
          limits: {
            ...set("maxNativeAgents", execution.limits.maxNativeAgents),
            ...set(
              "maxReportedTokens",
              execution.limits.maxReportedTokens === undefined
                ? undefined
                : Number(execution.limits.maxReportedTokens),
            ),
            ...set("maxReportedCost", moneyRecord(execution.limits.maxReportedCost)),
          },
        }),
  };
}

function environmentRecord(environment: ExecutionEnvironment | undefined) {
  return environment === undefined
    ? null
    : {
        id: environment.id,
        provider: environment.provider,
        placement: ENVIRONMENT_PLACEMENT.word(environment.placement) ?? "managed",
      };
}

function copyRecord(copy: ArtifactCopy): TaskArtifactLocation[] {
  if (copy.place.case === "volume") return [{ kind: "volume", volume: copy.place.value.volume }];
  if (copy.place.case === "workerHost")
    return [
      {
        kind: "worker-host",
        workerHostId: copy.place.value.workerHostId,
        ephemeral: copy.place.value.ephemeral,
        removed: copy.place.value.removed,
      },
    ];
  return [];
}

function filesRecord(files: NonNullable<NonNullable<Task["storage"]>["taskFiles"]>) {
  return {
    workerHostId: files.workerHostId,
    ephemeral: files.ephemeral,
    ...(files.placementUnknown ? { placementUnknown: true } : {}),
    ...set("sandbox", nonEmpty(files.sandbox)),
  };
}

/** A Task as `describe task` and the list tables read it: the Control Plane's view of it. */
export function taskView(task: Task): TaskResource {
  const latest = task.latestAttempt;
  const resolution = task.resolution;
  const scheduling = task.scheduling;
  const findings = task.findings;
  const severities = (severity: TaskFindingSeverity) =>
    (findings?.findings ?? [])
      .filter((finding) => finding.severity === severity)
      .map((finding) => ({
        id: finding.id,
        severity: FINDING_SEVERITY.word(finding.severity) ?? "low",
        summary: finding.summary,
        ...set("location", nonEmpty(finding.location)),
      }));
  const placement = latest?.placement;
  return {
    apiVersion: "supertag/v1",
    kind: "Task",
    metadata: {
      id: task.id,
      resourceVersion: task.resourceVersion,
      createdAt: isoOf(task.createdAt) ?? "",
      updatedAt: isoOf(task.updatedAt) ?? "",
    },
    spec: {
      tagId: task.tagId,
      sessionId: task.sessionId,
      ...set("objectiveId", nonEmpty(task.objectiveId)),
      execution: executionRecord(task.execution),
      trigger: (task.trigger ?? {}) as JsonRecord,
      ...(task.workspace === undefined
        ? {}
        : {
            workspace: {
              name: task.workspace.name,
              branch: task.workspace.branch,
              ...set("ref", nonEmpty(task.workspace.ref)),
              delivery: DELIVERY_MODE.word(task.workspace.delivery) ?? "branch",
            },
          }),
    },
    status: {
      phase: TASK_STATUS.word(task.status) ?? "pending",
      ...set("startedAt", isoOf(task.startedAt)),
      ...set("endedAt", isoOf(task.endedAt)),
      ...set("outcome", task.outcome as JsonRecord | undefined),
      ...(findings === undefined
        ? {}
        : findings.unreadable !== ""
          ? { findings: { unreadable: findings.unreadable } }
          : {
              findings: {
                high: severities(TaskFindingSeverity.HIGH),
                medium: severities(TaskFindingSeverity.MEDIUM),
                low: severities(TaskFindingSeverity.LOW),
              },
            }),
      ...(task.skills.length
        ? { skills: task.skills.map(({ name, source, digest }) => ({ name, source, digest })) }
        : {}),
      ...(task.preparedWorkspace === undefined
        ? {}
        : {
            preparedWorkspace: {
              digest: task.preparedWorkspace.digest,
              provider: task.preparedWorkspace.provider,
              trustedCommit: task.preparedWorkspace.trustedCommit,
            },
          }),
      ...(resolution === undefined
        ? {}
        : {
            execution: {
              ...set("source", EXECUTION_SOURCE.word(resolution.source)),
              ...set("chosenByTagId", nonEmpty(resolution.chosenByTagId)),
              ...set("harness", nonEmpty(resolution.harness)),
              ...set("model", nonEmpty(resolution.model)),
              ...set("effort", nonEmpty(resolution.effort)),
              ...(resolution.latestAttempt === undefined
                ? {}
                : {
                    latestAttempt: {
                      ...set("harness", nonEmpty(resolution.latestAttempt.harness)),
                      ...set("model", nonEmpty(resolution.latestAttempt.model)),
                      ...set(
                        "modelSource",
                        MODEL_SOURCE.word(resolution.latestAttempt.modelSource),
                      ),
                      ...set("effort", nonEmpty(resolution.latestAttempt.effort)),
                      ...set("effortIgnored", nonEmpty(resolution.latestAttempt.effortIgnored)),
                    },
                  }),
            },
          }),
      ...(task.attempts.length === 0
        ? {}
        : {
            attempts: task.attempts.map((attempt) => {
              const cost = attempt.reportedCost;
              return {
                id: attempt.id,
                number: attempt.number,
                phase: ATTEMPT_STATUS.word(attempt.status) ?? "running",
                startedAt: isoOf(attempt.startedAt) ?? "",
                endedAt: isoOf(attempt.endedAt),
                reportedCost:
                  cost?.cost === undefined
                    ? null
                    : {
                        amountMinor: Number(cost.cost.amountMinor),
                        currency: cost.cost.currency,
                        ...(cost.estimated ? { estimated: true } : {}),
                      },
                ...(attempt.liveMounts.length
                  ? {
                      liveMounts: attempt.liveMounts.map((mount) => ({
                        volume: mount.volume,
                        source: mount.source,
                        prefix: mount.prefix,
                        path: mount.path,
                        strategy: "mount" as const,
                        access: MOUNT_ACCESS.word(mount.access) ?? "read-only",
                        attachedAt: isoOf(mount.attachedAt) ?? "",
                      })),
                    }
                  : {}),
                ...(attempt.mountOutputManifests.length
                  ? {
                      mountOutputManifests: attempt.mountOutputManifests.map((manifest) => ({
                        volume: manifest.volume,
                        source: manifest.source,
                        path: manifest.path,
                        status: MOUNT_OUTPUT_STATUS.word(manifest.status) ?? "refused",
                        uploadedAt: isoOf(manifest.uploadedAt) ?? "",
                        objects: manifest.objects.map((object) => ({
                          key: object.key,
                          size: Number(object.size),
                          sha256: object.sha256,
                        })),
                        skipped: manifest.skipped,
                        ...(manifest.error === undefined
                          ? {}
                          : { error: { key: manifest.error.key, reason: manifest.error.reason } }),
                        notAttempted: manifest.notAttempted,
                      })),
                    }
                  : {}),
                ...(attempt.mountManifests.length
                  ? {
                      mountManifests: attempt.mountManifests.map((manifest) => ({
                        volume: manifest.volume,
                        source: manifest.source,
                        path: manifest.path,
                        strategy: "copy" as const,
                        access: MOUNT_ACCESS.word(manifest.access) ?? "read-only",
                        objectCount: manifest.objectCount,
                        totalBytes: Number(manifest.totalBytes),
                        digest: manifest.digest,
                        copiedAt: isoOf(manifest.copiedAt) ?? "",
                        objects: manifest.objects.map((object) => ({
                          key: object.key,
                          size: Number(object.size),
                          ...set("etag", nonEmpty(object.etag)),
                          ...set("versionId", nonEmpty(object.versionId)),
                          ...set("sha256", nonEmpty(object.sha256)),
                        })),
                      })),
                    }
                  : {}),
              };
            }),
          }),
      ...(latest === undefined
        ? {}
        : {
            attempt: {
              id: latest.id,
              number: latest.number,
              phase: ATTEMPT_STATUS.word(latest.status) ?? "running",
              workerProfile:
                latest.workerProfile === undefined
                  ? undefined
                  : { id: latest.workerProfile.id, revision: latest.workerProfile.revision },
              durableExecution: latest.durableExecution,
              failure: recordedEventView(latest.failure),
              warnings: latest.warnings.flatMap((warning) => recordedEventView(warning) ?? []),
              runningCommand:
                latest.runningCommand === undefined
                  ? null
                  : {
                      command: latest.runningCommand.command,
                      startedAt: isoOf(latest.runningCommand.startedAt) ?? "",
                    },
              workerId: nonEmpty(latest.workerId) ?? null,
              workerHostId: nonEmpty(latest.workerHostId) ?? null,
              workletId: nonEmpty(latest.workletId) ?? null,
              selection:
                latest.selection === undefined
                  ? null
                  : {
                      allowedWorkerHostIds: latest.selection.allowedWorkerHostIds,
                      reservation:
                        latest.selection.reservation === undefined
                          ? null
                          : {
                              id: latest.selection.reservation.id,
                              expiresAt: isoOf(latest.selection.reservation.expiresAt) ?? "",
                              phase:
                                RESERVATION_PHASE.word(latest.selection.reservation.phase) ??
                                "reserved",
                            },
                    },
              lastEvent:
                latest.lastEvent === undefined
                  ? null
                  : {
                      type: latest.lastEvent.type,
                      sequence: Number(latest.lastEvent.sequence),
                      at: isoOf(latest.lastEvent.at) ?? "",
                    },
              placement:
                placement === undefined
                  ? undefined
                  : {
                      status: PLACEMENT_STATUS.word(placement.status) ?? "unknown",
                      mode: PLACEMENT_MODE.word(placement.mode) ?? null,
                      cleanup: CLEANUP_STATUS.word(placement.cleanup) ?? "unknown",
                      cleanupFailure:
                        placement.cleanupFailure === undefined
                          ? null
                          : {
                              sequence: Number(placement.cleanupFailure.sequence),
                              at: isoOf(placement.cleanupFailure.at) ?? "",
                              summary: placement.cleanupFailure.summary,
                              items: placement.cleanupFailure.items.map(({ id, text }) => ({
                                id,
                                text,
                                status: "blocked",
                              })),
                            },
                      harness:
                        placement.harness === undefined
                          ? null
                          : { id: placement.harness.id, version: placement.harness.version },
                      harnessRuntime: environmentRecord(placement.harnessRuntime),
                      executionEnvironment: environmentRecord(placement.executionEnvironment),
                    },
            },
          }),
      ...(scheduling === undefined
        ? {}
        : {
            scheduling: {
              status: SCHEDULING_STATUS.word(scheduling.status) ?? "compatible",
              unmetRequirements: scheduling.unmetRequirements,
              ...set("reason", nonEmpty(scheduling.reason)),
              ...(scheduling.unsandboxedCommands.length
                ? {
                    unsandboxedCommands: scheduling.unsandboxedCommands.map(
                      ({ workerHostId, harnesses }) => ({ workerHostId, harnesses }),
                    ),
                  }
                : {}),
              ...(scheduling.workspaceRefusals.length
                ? { workspaceRefusals: scheduling.workspaceRefusals }
                : {}),
              observedAt: isoOf(scheduling.observedAt) ?? "",
              sequence: Number(scheduling.sequence),
            },
          }),
      ...(task.pullRequest === undefined
        ? {}
        : (() => {
            const pullRequest = deliveryRecord({
              $typeName: "supertag.operator.v1.TaskDelivery",
              patches: [],
              outputs: [],
              pullRequest: task.pullRequest,
            }).pullRequest;
            return pullRequest === undefined
              ? {}
              : {
                  pullRequest: {
                    repository: pullRequest.repository,
                    number: pullRequest.number,
                    url: pullRequest.url,
                    state: pullRequest.state,
                    ...set("lastError", pullRequest.lastError),
                    ...set("nextAttemptAt", pullRequest.nextAttemptAt),
                  },
                };
          })()),
      ...(task.delivery === undefined ? {} : { delivery: deliveryRecord(task.delivery) }),
      ...(task.storage === undefined
        ? {}
        : {
            storage: {
              ...(task.storage.taskFiles === undefined
                ? {}
                : { taskFiles: filesRecord(task.storage.taskFiles) }),
              artifacts: task.storage.artifacts.map((artifact) => ({
                artifactId: artifact.artifactId,
                title: artifact.title,
                files: artifact.files,
                locations: artifact.copies.flatMap(copyRecord),
                ephemeralOnly: artifact.ephemeralOnly,
              })),
              moreArtifacts: task.storage.moreArtifacts,
            },
          }),
    },
  } as TaskResource;
}

function recordedEventView(
  event: { message: string; at?: Parameters<typeof isoOf>[0]; sequence: bigint } | undefined,
) {
  return event === undefined
    ? null
    : { message: event.message, at: isoOf(event.at) ?? "", sequence: Number(event.sequence) };
}

/** A Session as `describe session` and `list session` read it. */
export function sessionView(session: Session): SessionResource {
  return {
    apiVersion: "supertag/v1",
    kind: "Session",
    metadata: {
      id: session.id,
      resourceVersion: session.resourceVersion,
      createdAt: isoOf(session.createdAt) ?? "",
      updatedAt: isoOf(session.updatedAt) ?? "",
    },
    spec: {
      tagId: session.tagId,
      sessionKey: session.sessionKey,
      origin: (session.origin ?? {}) as JsonRecord,
      ...set("parentSessionId", nonEmpty(session.parentSessionId)),
    },
    status: {
      phase: "open",
      audience: SESSION_AUDIENCE.word(session.audience) ?? "shared",
      ...set("tag", nonEmpty(session.tag)),
      ...set("title", nonEmpty(session.title)),
      ...set("latestTaskStatus", TASK_STATUS.word(session.latestTaskStatus)),
      lastInteractionAt: isoOf(session.lastInteractionAt) ?? "",
    },
  };
}

/** A native archive as `describe session` lists it. */
export function sessionStateView(state: SessionState): Record<string, unknown> {
  return {
    id: state.id,
    harnessId: state.harnessId,
    ...set("nativeId", nonEmpty(state.nativeId)),
    status: SESSION_STATE_STATUS.word(state.status) ?? "stored",
    updatedAt: isoOf(state.updatedAt) ?? "",
  };
}

/** An artifact as `list artifact` tabulates it. */
export function artifactRow(artifact: Artifact): Record<string, unknown> {
  return {
    metadata: { id: artifact.id, createdAt: isoOf(artifact.createdAt) },
    spec: { taskId: artifact.taskId, entries: artifact.entries },
    status: {
      locations: artifact.copies.flatMap(copyRecord),
      ephemeralOnly: artifact.ephemeralOnly,
    },
  };
}

/** Where `download artifact` may read a file, as the Worker SDK's transfer client takes it. */
export function artifactTransferOf(download: ArtifactDownload): ResolvedArtifactTransfer {
  return {
    artifactId: download.artifactId,
    path: download.path,
    digest: download.digest,
    sizeBytes: Number(download.sizeBytes),
    locations: download.transfers.map(({ workerHostId, transferUrl, grant }) => ({
      workerHostId,
      transferUrl,
      grant,
    })),
    volumes: download.volumes.map(({ volume, source, credential, key }) => ({
      volume,
      source,
      ...set("credential", nonEmpty(credential)),
      key,
    })),
    holders: {
      workerHostIds: download.holders?.workerHostIds ?? [],
      volumes: download.holders?.volumes ?? [],
    },
    expiresAt: isoOf(download.expiresAt) ?? "",
  };
}
