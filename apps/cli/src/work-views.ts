import { createHash } from "node:crypto";
import {
  taskAttemptReportedCost,
  taskAttemptRunningCommand,
  taskAttemptWarnings,
  taskExecutionPlacementReport,
} from "@supertag/control-plane";
import type {
  JsonRecord,
  MountManifest,
  MountOutputManifest,
  Session,
  Task,
  TaskStatus,
} from "@supertag/core";
import {
  isInboxSessionKey,
  objectiveIdOfSessionKey,
  placementHoldReason,
  type StoredTaskFindingsBySeverity,
  storedTaskFindingsBySeverity,
  type TaskDelivery,
  taskDelivery,
  unsandboxedCommandHoldsOf,
  workspacePullRequestFromEvents,
} from "@supertag/core";
import type { OperatorReadStore } from "./operator-seams.js";
import { type TaskStorage, taskStorage } from "./task-storage.js";

/**
 * Task and Session views as the Control Plane projects them from its records: what `WorkService`
 * serves, before it becomes protobuf.
 */

const API_VERSION = "supertag/v1" as const;

/** Most objects of each `copy` mount a Task view lists per Attempt. */
export const TASK_VIEW_MOUNT_OBJECTS = 20;

/** The store reads a Task or Session view makes. */
export type WorkViewStore = Pick<
  OperatorReadStore,
  | "findTagById"
  | "hasArtifactUpload"
  | "listArtifactStorageLocations"
  | "listArtifactVolumeLocations"
  | "listCapturedArtifacts"
  | "listTaskAttempts"
  | "listTaskEvents"
  | "listVolumes"
  | "listWorkerHosts"
  | "sessionTaskSummaries"
>;

interface WorkResource<Kind extends string, Spec extends JsonRecord, Status extends JsonRecord> {
  readonly apiVersion: typeof API_VERSION;
  readonly kind: Kind;
  readonly metadata: {
    readonly id: string;
    readonly resourceVersion: string;
    readonly createdAt: string;
    readonly updatedAt: string;
  };
  readonly spec: Spec;
  readonly status: Status;
}

/** A prepared Workspace environment as a Task Attempt's input provenance reports it. */
export interface PreparedWorkspaceStatus {
  readonly digest: string;
  readonly provider: string;
  readonly trustedCommit: string;
}

export type TaskResource = WorkResource<
  "Task",
  {
    readonly tagId: string;
    readonly sessionId: string;
    /** The Objective whose Session the Task belongs to. */
    readonly objectiveId?: string;
    readonly execution: Task["execution"];
    readonly trigger: JsonRecord;
    /** The named Workspace and Task branch recorded when the Task was accepted. */
    readonly workspace?: {
      readonly name: string;
      readonly branch: string;
      readonly ref?: string;
      readonly delivery: string;
    };
  },
  {
    readonly phase: Task["status"];
    readonly startedAt?: string;
    readonly endedAt?: string;
    readonly outcome?: JsonRecord;
    /** The Task result's findings by severity, or why its stored findings are unreadable. */
    readonly findings?: StoredTaskFindingsBySeverity;
    /** How the harness, model and effort were resolved, and what the latest Attempt ran. */
    readonly execution?: JsonRecord;
    readonly attempt?: JsonRecord;
    /** Every Task Attempt, oldest first, with its provider-reported cost when known. */
    readonly attempts?: readonly {
      readonly id: string;
      readonly number: number;
      readonly phase: string;
      readonly startedAt: string;
      readonly endedAt: string | null;
      readonly reportedCost: {
        readonly amountMinor: number;
        readonly currency: string;
        readonly estimated?: boolean;
      } | null;
      /**
       * What the Workspace's `copy` mounts placed in this Attempt's environment, when recorded.
       * This view lists at most the first {@link TASK_VIEW_MOUNT_OBJECTS} objects of each mount;
       * `objectCount` and `totalBytes` cover all of them.
       */
      readonly mountManifests?: readonly MountManifest[];
      readonly mountOutputManifests?: readonly MountOutputManifest[];
    }[];
    readonly scheduling?: JsonRecord;
    /** Skills actually delivered to the latest Task Attempt. */
    readonly skills?: readonly {
      readonly name: string;
      readonly source: string;
      readonly digest: string;
    }[];
    /** The prepared Workspace artifact used by the latest Task Attempt, when reported. */
    readonly preparedWorkspace?: {
      readonly digest: string;
      readonly provider: string;
      readonly trustedCommit: string;
    };
    /** The pull request a Worker opened for this Task, for `pull-request` delivery. */
    readonly pullRequest?: {
      readonly repository: string;
      readonly number: number;
      readonly url: string;
      readonly state: "draft" | "ready" | "closed";
      readonly lastError?: string;
      /** When a failed ready or close transition is retried; absent once retries stop. */
      readonly nextAttemptAt?: string;
    };
    /** What the Task delivered: its Workspace branch, patches, pull request, and outputs. */
    readonly delivery?: TaskDelivery;
    /**
     * Where the latest Attempt's Task files and each captured artifact live, flagging copies
     * held only on ephemeral storage. Present when one Task is read.
     */
    readonly storage?: TaskStorage;
  }
>;

export type SessionResource = WorkResource<
  "Session",
  {
    readonly tagId: string;
    readonly sessionKey: string;
    readonly origin: JsonRecord;
    /** The conversation Session that started this work Session; read-only. */
    readonly parentSessionId?: string;
  },
  {
    readonly phase: Session["state"];
    readonly audience: Session["audience"];
    /** The Tag's name. */
    readonly tag?: string;
    /** A work Session's title, or how a conversation began: its first request, shortened. */
    readonly title?: string;
    /** The status of the Session's latest Task. */
    readonly latestTaskStatus?: TaskStatus;
    readonly lastInteractionAt: string;
  }
>;

const PREPARED_DIGEST = /^sha256:[0-9a-f]{64}$/u;
const COMMIT = /^[0-9a-f]{40}([0-9a-f]{24})?$/u;
const PROVIDER = /^[a-z0-9][a-z0-9._-]{0,62}$/u;

/**
 * The prepared Workspace environment an Attempt's resolved inputs report. Only a well-formed
 * digest, provider name, and commit are kept; nothing else from provenance is projected.
 */
export function preparedWorkspaceOf(
  events: readonly { readonly type: string; readonly payload?: JsonRecord | null }[],
): PreparedWorkspaceStatus | undefined {
  const manifest = events.findLast((event) => event.type === "runtime-inputs.resolved")?.payload?.[
    "manifest"
  ];
  const inputs = isRecord(manifest) && Array.isArray(manifest["inputs"]) ? manifest["inputs"] : [];
  for (const input of inputs) {
    if (!isRecord(input) || input["kind"] !== "workspace" || !isRecord(input["resource"])) continue;
    const provenance = input["resource"]["provenance"];
    if (!isRecord(provenance) || provenance["provider"] !== "supertag-workspace") continue;
    const digest = provenance["preparedDigest"];
    const provider = provenance["preparedProvider"];
    const trustedCommit = provenance["trustedCommit"];
    if (
      typeof digest === "string" &&
      PREPARED_DIGEST.test(digest) &&
      typeof provider === "string" &&
      PROVIDER.test(provider) &&
      typeof trustedCommit === "string" &&
      COMMIT.test(trustedCommit)
    )
      return { digest, provider, trustedCommit };
  }
  return undefined;
}

export function taskResource(task: Task): TaskResource {
  return {
    apiVersion: API_VERSION,
    kind: "Task",
    metadata: {
      id: task.id,
      resourceVersion: task.updatedAt,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
    },
    spec: {
      tagId: task.tagId,
      sessionId: task.sessionId,
      ...(task.objectiveId === undefined ? {} : { objectiveId: task.objectiveId }),
      execution: task.execution,
      trigger: task.trigger,
      ...(task.workspacePlan?.status === "workspace"
        ? {
            workspace: {
              name: task.workspacePlan.workspace,
              branch: task.workspacePlan.branch,
              ...(task.workspacePlan.ref === undefined ? {} : { ref: task.workspacePlan.ref }),
              delivery: task.workspacePlan.delivery,
            },
          }
        : {}),
    },
    status: {
      phase: task.status,
      ...(task.startedAt === undefined ? {} : { startedAt: task.startedAt }),
      ...(task.endedAt === undefined ? {} : { endedAt: task.endedAt }),
      ...(task.outcome === undefined ? {} : { outcome: task.outcome }),
    },
  };
}

export async function taskResourceFromStore(
  store: WorkViewStore,
  task: Task,
  options: {
    /** Also read where the Task's files and artifacts live; `describe task` shows it. */
    readonly storage?: boolean;
  } = {},
): Promise<TaskResource> {
  const [attempts, history] = await Promise.all([
    store.listTaskAttempts(task.id),
    store.listTaskEvents(task.id),
  ]);
  const events = history.toSorted((a, b) => a.sequence - b.sequence);
  const skillManifest = events.findLast((event) => event.type === "runtime-inputs.resolved")
    ?.payload?.["manifest"];
  const skills =
    isRecord(skillManifest) && Array.isArray(skillManifest["inputs"])
      ? skillManifest["inputs"].flatMap(
          (input): { name: string; source: string; digest: string }[] => {
            if (!isRecord(input) || input["kind"] !== "skill" || !isRecord(input["resource"]))
              return [];
            const resource = input["resource"];
            const provenance = isRecord(resource["provenance"]) ? resource["provenance"] : {};
            if (typeof input["id"] !== "string" || typeof resource["digest"] !== "string")
              return [];
            return [
              {
                name: input["id"].startsWith("skill:") ? input["id"].slice(6) : input["id"],
                source:
                  typeof provenance["source"] === "string" ? provenance["source"] : "host service",
                digest: resource["digest"],
              },
            ];
          },
        )
      : [];
  const latest = attempts.toSorted((a, b) => b.attemptNumber - a.attemptNumber)[0];
  const attemptEvents = latest ? events.filter((event) => event.attemptId === latest.id) : [];
  const preparedWorkspace = preparedWorkspaceOf(attemptEvents);
  const started = attemptEvents.findLast((event) => event.type === "execution.started");
  const lastEvent = attemptEvents.at(-1);
  const terminal = attemptEvents.findLast(
    (event) => event.type === "execution.failed" || event.type === "execution.completed",
  );
  const error = terminal?.type === "execution.failed" ? terminal.payload?.["error"] : undefined;
  // Worker events already apply their redaction policy. Never project extra error fields.
  const failureMessage = isRecord(error) ? text(error["message"]) : undefined;
  const placement = taskExecutionPlacementReport(latest, events);
  const warnings = taskAttemptWarnings(latest, events);
  const selectedPlacement =
    latest && isRecord(latest.workerSnapshot["placement"])
      ? latest.workerSnapshot["placement"]
      : undefined;
  // Keep the last recorded check; describe presents it only while work is queued.
  const scheduling = events.findLast(
    (event) =>
      event.type === "task.scheduling-incompatible" || event.type === "task.scheduling-compatible",
  );
  const resource = taskResource(task);
  const resolved = events.findLast((event) => event.type === "task.execution-resolved")?.payload;
  const attemptExecution =
    latest && isRecord(latest.workerSnapshot["execution"])
      ? latest.workerSnapshot["execution"]
      : undefined;
  const execution =
    resolved === undefined && attemptExecution === undefined
      ? undefined
      : {
          ...(resolved === undefined
            ? {}
            : Object.fromEntries(Object.entries(resolved).filter(([key]) => key !== "version"))),
          ...(attemptExecution === undefined ? {} : { latestAttempt: attemptExecution }),
        };
  const pullRequest =
    task.workspacePlan?.status === "workspace" && task.workspacePlan.delivery === "pull-request"
      ? workspacePullRequestFromEvents(events)
      : undefined;
  const delivery = taskDelivery({
    ...(task.workspacePlan === undefined ? {} : { workspacePlan: task.workspacePlan }),
    result: task.result,
    events,
  });
  const environment = (value: typeof placement.executionEnvironment) =>
    value === null ? null : { id: value.id, provider: value.provider, placement: value.placement };
  const findings = storedTaskFindingsBySeverity(task.result);
  const status: TaskResource["status"] = {
    ...resource.status,
    ...("unreadable" in findings ||
    findings.high.length + findings.medium.length + findings.low.length
      ? { findings }
      : {}),
    ...(skills.length ? { skills } : {}),
    ...(preparedWorkspace === undefined ? {} : { preparedWorkspace }),
    ...(execution === undefined ? {} : { execution }),
    ...(attempts.length === 0
      ? {}
      : {
          attempts: attempts
            .toSorted((a, b) => a.attemptNumber - b.attemptNumber)
            .map((candidate) => ({
              id: candidate.id,
              number: candidate.attemptNumber,
              phase: candidate.status,
              startedAt: candidate.startedAt,
              endedAt: candidate.endedAt ?? null,
              reportedCost: taskAttemptReportedCost(candidate, events),
              ...(candidate.liveMounts === undefined ? {} : { liveMounts: candidate.liveMounts }),
              ...(candidate.mountOutputManifests === undefined
                ? {}
                : { mountOutputManifests: candidate.mountOutputManifests }),
              ...(candidate.mountManifests === undefined
                ? {}
                : {
                    mountManifests: candidate.mountManifests.map((manifest) => ({
                      ...manifest,
                      objects: manifest.objects.slice(0, TASK_VIEW_MOUNT_OBJECTS),
                    })),
                  }),
            })),
        }),
    ...(latest === undefined
      ? {}
      : {
          attempt: {
            id: latest.id,
            number: latest.attemptNumber,
            phase: latest.status,
            workerProfile: latest.workerProfile,
            durableExecution: latest.workerSnapshot["durableExecution"] === true,
            failure:
              failureMessage === undefined || terminal === undefined
                ? null
                : {
                    message: failureMessage,
                    at: terminal.createdAt,
                    sequence: terminal.sequence,
                  },
            warnings: warnings.map((warning) => ({
              message: warning.text,
              at: warning.at,
              sequence: warning.sequence,
            })),
            runningCommand: taskAttemptRunningCommand(latest, events),
            workerId:
              text(latest.workerSnapshot["workerId"]) ??
              text(started?.payload?.["workerId"]) ??
              text(selectedPlacement?.["workerId"]) ??
              null,
            workerHostId:
              text(latest.workerSnapshot["workerHostId"]) ??
              text(selectedPlacement?.["workerHostId"]) ??
              null,
            workletId:
              text(latest.workerSnapshot["workletId"]) ??
              text(selectedPlacement?.["workletId"]) ??
              null,
            selection:
              selectedPlacement === undefined
                ? null
                : {
                    allowedWorkerHostIds: Array.isArray(selectedPlacement["allowedWorkerHostIds"])
                      ? selectedPlacement["allowedWorkerHostIds"].filter(
                          (item): item is string => typeof item === "string",
                        )
                      : [],
                    reservation: placementReservationStatus(
                      selectedPlacement["reservation"],
                      typeof latest.workerSnapshot["workerHostId"] === "string",
                    ),
                  },
            lastEvent:
              lastEvent === undefined
                ? null
                : {
                    type: lastEvent.type,
                    sequence: lastEvent.sequence,
                    at: lastEvent.createdAt,
                  },
            placement: {
              status: placement.status,
              mode: placement.mode,
              cleanup: placement.cleanup,
              cleanupFailure: placement.cleanupFailure,
              harness:
                placement.harness === null
                  ? null
                  : {
                      id: placement.harness.id,
                      version: placement.harness.version,
                    },
              harnessRuntime: environment(placement.harnessRuntime),
              executionEnvironment: environment(placement.executionEnvironment),
            },
          },
        }),
    ...(scheduling === undefined
      ? {}
      : {
          scheduling: {
            status:
              scheduling.type === "task.scheduling-incompatible" ? "incompatible" : "compatible",
            unmetRequirements: Array.isArray(scheduling.payload?.["unmetRequirements"])
              ? scheduling.payload["unmetRequirements"].filter(
                  (item): item is string => typeof item === "string",
                )
              : [],
            ...(scheduling.type === "task.scheduling-incompatible" &&
            placementHoldReason(scheduling.payload) !== undefined
              ? { reason: placementHoldReason(scheduling.payload) }
              : {}),
            ...(scheduling.type === "task.scheduling-incompatible" &&
            unsandboxedCommandHoldsOf(scheduling.payload).length > 0
              ? { unsandboxedCommands: unsandboxedCommandHoldsOf(scheduling.payload) }
              : {}),
            ...(scheduling.type === "task.scheduling-incompatible" &&
            Array.isArray(scheduling.payload?.["workspaceRefusals"])
              ? {
                  workspaceRefusals: scheduling.payload["workspaceRefusals"].filter(
                    (reason): reason is string => typeof reason === "string",
                  ),
                }
              : {}),
            observedAt: scheduling.createdAt,
            sequence: scheduling.sequence,
          },
        }),
    ...(pullRequest === undefined
      ? {}
      : {
          pullRequest: {
            repository: pullRequest.repository,
            number: pullRequest.number,
            url: pullRequest.url,
            state: pullRequest.state,
            ...(pullRequest.lastError === undefined ? {} : { lastError: pullRequest.lastError }),
            ...(pullRequest.nextAttemptAt === undefined
              ? {}
              : { nextAttemptAt: pullRequest.nextAttemptAt }),
          },
        }),
    ...(delivery === undefined ? {} : { delivery }),
  };
  // Storage is read only for one Task and kept out of its version, so a list and a read agree.
  const storage =
    options.storage === true
      ? await taskStorage(store, task.id, latest, environment(placement.executionEnvironment))
      : undefined;
  return {
    ...resource,
    metadata: { ...resource.metadata, resourceVersion: resourceVersion({ task, status }) },
    status: storage === undefined ? status : { ...status, storage },
  };
}

function placementReservationStatus(
  value: unknown,
  consumed: boolean,
): { readonly id: string; readonly expiresAt: string; readonly phase: string } | null {
  if (!isRecord(value)) return null;
  const id = text(value["id"]);
  const expiresAt = text(value["expiresAt"]);
  if (!id || !expiresAt) return null;
  return {
    id,
    expiresAt,
    phase: consumed ? "consumed" : Date.parse(expiresAt) <= Date.now() ? "expired" : "reserved",
  };
}

export function sessionResource(
  session: Session,
  summary: {
    readonly tag?: string;
    readonly latestTaskStatus?: TaskStatus;
    readonly firstRequest?: string;
  } = {},
): SessionResource {
  const title = sessionTitle(session, summary.firstRequest);
  const { latestTaskStatus } = summary;
  return {
    apiVersion: API_VERSION,
    kind: "Session",
    metadata: {
      id: session.id,
      resourceVersion: session.updatedAt,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
    },
    spec: {
      tagId: session.tagId,
      sessionKey: session.sessionKey,
      origin: session.origin,
      ...(session.parentSessionId === undefined
        ? {}
        : { parentSessionId: session.parentSessionId }),
    },
    status: {
      phase: session.state,
      audience: session.audience,
      ...(summary.tag === undefined ? {} : { tag: summary.tag }),
      ...(title === undefined ? {} : { title }),
      ...(latestTaskStatus === undefined ? {} : { latestTaskStatus }),
      lastInteractionAt: session.lastInteractionAt,
    },
  };
}

/** A work Session's own title; otherwise the first request, on one line and at most 60 characters. */
function sessionTitle(session: Session, firstRequest: string | undefined): string | undefined {
  const own = session.origin["title"];
  if (typeof own === "string" && own.trim()) return own.trim();
  // An Objective's conversation and a Tag's inbox are named for what they are, not their first turn.
  const objectiveId = objectiveIdOfSessionKey(session.sessionKey);
  if (objectiveId !== undefined) return `Objective ${objectiveId}`;
  if (isInboxSessionKey(session.sessionKey)) return "Inbox";
  const request = firstRequest?.replace(/\s+/gu, " ").trim();
  if (request) return request.length > 60 ? `${request.slice(0, 59).trimEnd()}…` : request;
  // A CLI conversation is named by its session name.
  const key = session.sessionKey.match(/^cli:[^:]+:(.+)$/u)?.[1];
  return key;
}

/** Sessions as views, each with its Tag's name and the status of its latest Task. */
export async function sessionResourcesFromStore(
  store: Pick<WorkViewStore, "findTagById" | "sessionTaskSummaries">,
  sessions: readonly Session[],
): Promise<SessionResource[]> {
  const summaries = await store.sessionTaskSummaries(sessions.map((session) => session.id));
  const tags = new Map(
    (
      await Promise.all(
        [...new Set(sessions.map((session) => session.tagId))].map((id) => store.findTagById(id)),
      )
    ).flatMap((tag) => (tag === undefined ? [] : [[tag.id, tag.name] as const])),
  );
  return sessions.map((session) => {
    const tag = tags.get(session.tagId);
    return sessionResource(session, {
      ...summaries.get(session.id),
      ...(tag === undefined ? {} : { tag }),
    });
  });
}

function resourceVersion(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
