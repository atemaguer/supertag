export { explainHarnessSignIn } from "./harness-signin.js";

import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import {
  coordinationInboxOccurrence,
  namedWorkspacePlan,
  workspaceBranchHeadPin,
  workspaceBranchPin,
} from "@supertag/core";
import {
  approvalDecisionText,
  workSessionApprovalNotice,
  workSessionNotContinuedNotice,
} from "./approvals.js";
import { isSchedulingEvent } from "./capacity-wait.js";
import {
  latestSessionDelivery,
  sessionWorkspaceBranches,
  workerEvents,
} from "./dependency-branches.js";
import { DispatchErrorReporter } from "./dispatch-errors.js";
import { ObjectiveMessages } from "./objective-messages.js";
import { repositoryReferences, unambiguousRepositoryReference } from "./repository-references.js";
import { SESSION_INPUT_COMMAND_PREFIX, withdrawSessionInput } from "./session-input-withdrawal.js";
import { conversationViewer, tagPortfolio } from "./tag-sessions.js";
import {
  type ContinueSessionRequest,
  continuedWorkSessionEvent,
  internalTurnMessages,
  reportedTurnSpend,
  resumedWorkSessionExecution,
  SESSION_UPDATE_SKIPPED_EVENT,
  type StartSessionRequest,
  samePermissions,
  sessionReportEvent,
  sessionUpdateEvent,
  WORK_SESSION_ASKED_EVENT,
  workSessionBranch,
  workSessionDelivery,
  workSessionEvent,
  workSessionExecution,
  workSessionsPerTurn,
  workSessionWorkspace,
} from "./work-sessions.js";

export type {
  ObjectiveConversationMessage,
  ObjectiveOverview,
  ObjectiveOverviewInput,
} from "./objective-overview.js";

import type {
  ApprovalRequest,
  CapturedArtifactSummary,
  DurableInboundEvent,
  GatewayCredentialVault,
  InboundSurfaceEvent,
  OutboundReply,
  RecordAuditEntryInput,
  Store,
  SurfaceAccount,
  SurfaceAccountInput,
  Tag,
  TagArtifactContextConfig,
  TagArtifactContextSnapshot,
  TagAuthorizationResource,
  SurfaceTagAuthorizationSnapshot as TagAuthorizationSnapshot,
  TagContextItem,
  TagContextPlan,
  TagContextPlanItem,
  TagContextSet,
  TagRoute,
  TagWorkerHostBinding,
  Task,
  TaskAttempt,
  TaskExecutionRequirements,
  TaskReference,
  TaskResult,
  TaskWorkspacePlan,
  WorkerHost,
  WorkerHostObservationResult,
  WorkSessionSummary,
} from "@supertag/core";
import {
  ARTIFACT_CONTEXT_TYPE,
  ArtifactCatalogError,
  AUTH_KEY_LOOKUP_LENGTH,
  AUTH_KEY_PREFIX,
  type AuthKey,
  approvalRequirementFor,
  authKeyLookupId,
  canonicalJson,
  effectiveWorkerHostLabels,
  isAuthKeySecret,
  isOperatorTokenSecret,
  MAX_AUTH_KEY_TAGS,
  OPERATOR_TOKEN_LOOKUP_LENGTH,
  OPERATOR_TOKEN_PREFIX,
  type OperatorToken,
  operatorTokenLookupId,
  parseAuthKeyName,
  parseOperatorTokenName,
  parseSurfaceObjectiveCommand,
  parseTaskExecutionRequirements,
  parseWorkerHostName,
  SESSION_INPUT_ACK_TIMEOUT_MS,
  sessionRequesterKey,
  TagMessagingError,
  WORK_SESSION_MAX_OPEN,
  WORK_SESSION_MAX_RUNNING,
  WORK_SESSION_MAX_UPDATES,
  WORK_SESSION_NOT_CONTINUED_EVENT,
  workSessionApprovalDeliveryId,
} from "@supertag/core";
import type {
  SurfacePresentation,
  SurfaceReplyCapabilities,
  VerifiedSurfaceAccount,
} from "@supertag/surface-sdk";
import {
  type AttemptJournalEvent,
  type DurableWorklet,
  descriptorSupportsRequiredContext,
  descriptorSupportsSurfaceCoordination,
  type HarnessControlCapabilities,
  type SchedulableWorklet,
  type TaskAttemptSpec,
  terminalOutputText,
  type TaskAttemptEvent as WorkerTaskAttemptEvent,
  type Worklet,
  WorkletAdmissionRejectedError,
  type WorkletDescriptor,
} from "@supertag/worker-sdk";
import { BudgetNotifications } from "./budget-notifications.js";
import {
  DURABLE_RECONNECT_GRACE_MS,
  executeWorkletAttempt,
  recordAttemptWorkerReceipt,
  supportsDurableExecution,
  UncertainExecutionError,
} from "./durable-execution.js";
import { controlPlaneEventLoopLag } from "./event-loop-lag.js";
import { ExecutionAffinityCache } from "./execution-affinity.js";
import {
  attemptExecutionRecord,
  EXECUTION_RESOLVED_EVENT,
  recordsSelection,
  resolveTaskExecution,
} from "./execution-settings.js";
import {
  commandPlacement,
  dispatchedWorkspacePlan,
  placeTask,
  type TaskPlacement,
  taskPlacementLabels,
  undeclaredMcpServers,
  volumeMountRequirements,
  withoutMcpServers,
  withRequiredCapabilities,
  workspaceMcpServers,
} from "./label-placement.js";
import { type CoordinationOperatorPrincipal, ObjectiveController } from "./objective-controller.js";
import {
  type NotificationDestination,
  type NotificationDestinationResolver,
  OperatorChannelNotifications,
  type OperatorNotificationSender,
  objectiveThreadCarries,
  shouldNotifyInboxItem,
} from "./operator-channel.js";
import { outboundPresentationPolicy, sentNowhere } from "./outbound-presentation.js";
import { detectOverlapWarnings } from "./overlap-warnings.js";
import { ReplyStreams } from "./reply-streams.js";
import {
  capturePermissionBundle,
  ensureBuiltInRoles,
  type ResolvedTagRoles,
  resolveTagRoles,
  tagExecutionRange,
} from "./roles.js";
import {
  profileHarness,
  SessionContinuity,
  type SessionPlacementChoice,
  sessionPlacement,
} from "./session-continuity.js";
import {
  isSurfaceFailure,
  type PreparedSurfaceOutcome,
  type SurfaceFailureOutcome,
  type SurfaceOutcome,
  SurfaceSettlement,
} from "./surface-settlement.js";
import { readSystemWake } from "./suspend-detector.js";
import { taskExecutionLimitReport, taskExecutionPlacementReport } from "./task-execution-report.js";
import { boundedTaskHistory, buildTaskResult, taskReferencesFromOrigin } from "./task-results.js";
import { describeWorklet } from "./worklet-descriptor.js";
import { workspaceMcpDigest, workspaceMcpPin } from "./workspace-mcp-digest.js";
import {
  workspaceLiveMounts,
  workspaceMountManifests,
  workspaceMountOutputFailure,
  workspaceMountOutputManifests,
} from "./workspace-mount-manifests.js";
import type { WorkspacePullRequestHandler } from "./workspace-pull-requests.js";
import { workspaceSkillPins } from "./workspace-skill-pins.js";

export type {
  TaskAttemptWarning,
  TaskExecutionLimitReport,
  TaskExecutionPlacementReport,
} from "./task-execution-report.js";

/** How often the task controller looks for finished work Sessions still owed a report turn. */
const WORK_REPORT_SWEEP_INTERVAL_MS = 10_000;
/** How many due inbound events one dispatch pass tries, oldest first, before it waits. */
const DISPATCH_CANDIDATES_PER_TICK = 50;
const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_LEASE_DURATION_MS = 5 * 60_000;
const DEFAULT_RETRY_BASE_MS = 1_000;
const DEFAULT_MAX_ATTEMPTS = 5;
const MAX_ARTIFACTS_PER_PLAN = 5;
const MAX_SESSION_HISTORY_TASKS = 5;
const WORKER_HOST_CREDENTIAL_ALGORITHM = "sha256";
const WORKER_HOST_CREDENTIAL_BYTES = 32;
/**
 * A disconnected ephemeral Worker Host is removed after the same grace an observer gives a durable
 * Attempt's host to reconnect.
 */
export const EPHEMERAL_WORKER_HOST_GRACE_MS = DURABLE_RECONNECT_GRACE_MS;
/** An ephemeral host that joined but never connected is removed after this long. */
export const EPHEMERAL_WORKER_HOST_JOIN_TIMEOUT_MS = 10 * 60_000;
const EPHEMERAL_WORKER_HOST_SWEEP_INTERVAL_MS = 10_000;

/** A rejected Auth Key redemption, with the HTTP status the API Server returns. */
export class AuthKeyRedemptionError extends TagMessagingError {
  constructor(
    statusCode: number,
    readonly reason: "invalid" | "expired" | "revoked" | "used" | "tag-missing",
    message: string,
  ) {
    super(statusCode, message);
    this.name = "AuthKeyRedemptionError";
  }
}

interface MutableAuthorizationResource {
  readonly surfaceAccountId: string;
  readonly provider: SurfaceAccount["provider"];
  readonly scope: string;
  reference?: string;
  readonly actions: Set<string>;
  readonly sources: Set<"origin" | "permission-set">;
}

export type InboundEventHandler = (
  event: InboundSurfaceEvent,
  account: SurfaceAccount,
  route: InboundRoute,
) => Promise<void>;

export interface InboundRoute {
  readonly tagRouteId: string;
  readonly tagId: string;
}

/** The one built-in SurfaceAccount that CLI conversations are recorded under. */
const CLI_EXTERNAL_ACCOUNT_ID = "control-plane";

export interface OutboundReplyHandler {
  (
    event: InboundSurfaceEvent,
    presentation: SurfacePresentation,
    account: SurfaceAccount,
    delivery: { readonly replaceExternalMessageId?: string },
  ): Promise<{ readonly externalMessageId?: string } | undefined>;
  /**
   * Declares surface delivery behavior without teaching the Control Plane about
   * individual providers. Undeclared surfaces are create-only.
   */
  readonly capabilities?: (
    event: InboundSurfaceEvent,
    account: SurfaceAccount,
  ) => SurfaceReplyCapabilities;
}

export interface InboundIngestResult {
  readonly status: "accepted" | "duplicate" | "ignored" | "rejected" | "unconfigured";
  readonly surfaceAccountId: string;
  readonly eventId: string;
  readonly inboundEventId?: string;
  readonly taskId?: string;
  readonly tagRouteId?: string;
  readonly tagId?: string;
  /** The Objective a reply in its notification thread was routed to. */
  readonly objectiveId?: string;
  readonly reason?: string;
}

export interface ControlPlaneDispatchOptions {
  readonly instanceId?: string;
  readonly pollIntervalMs?: number;
  readonly leaseDurationMs?: number;
  readonly retryBaseMs?: number;
  readonly maxAttempts?: number;
  readonly onDispatchError?: (error: unknown) => void;
}

export interface ControlPlaneDependencies {
  readonly store: Store;
  readonly credentialVault: GatewayCredentialVault;
  /** Default verified surface Task used for operator notifications. */
  readonly operatorNotificationTaskId?: string;
  readonly onInboundEvent?: InboundEventHandler;
  readonly worklet?: Worklet;
  readonly reply?: OutboundReplyHandler;
  readonly dispatch?: ControlPlaneDispatchOptions;
  /** Marks Workspace pull requests ready or closes them as their Tasks settle. */
  readonly pullRequests?: WorkspacePullRequestHandler;
  /**
   * Sends new inbox items to operator destinations, such as one configured Slack channel.
   * Items the Objective's own thread already carries are not repeated there.
   */
  readonly operatorNotifications?: {
    readonly resolver: NotificationDestinationResolver;
    readonly send: OperatorNotificationSender;
    readonly destinationFromKey?: (key: string) => NotificationDestination;
    readonly redact?: (text: string) => string;
    readonly retryBaseMs?: number;
    readonly now?: () => Date;
  };
  /**
   * Records operator changes that arrive through the Gateway, such as approving an Objective from
   * its thread. Defaults to the store's audit trail. A throw or rejection is reported and never
   * fails the change.
   */
  readonly audit?: (entry: RecordAuditEntryInput) => unknown;
}

export interface ControlPlaneControllerStatus {
  readonly name: "task-dispatch" | "reply-delivery";
  readonly phase: "disabled" | "running" | "draining" | "stopped";
}

export interface WorkerHostAuthenticationRequest {
  readonly credential: string;
  readonly worklet: WorkletDescriptor;
  readonly protocolVersion: number;
}

export interface WorkerHostAuthenticationResult {
  readonly connectionGeneration: number;
  readonly draining: boolean;
}

export interface WorkerHostConnectionObservation {
  readonly changedPaths?: readonly {
    readonly attemptId: string;
    readonly paths: readonly string[];
    readonly truncated: boolean;
  }[];
  readonly workerHostId: string;
  readonly connectionGeneration: number;
  readonly protocolVersion: number;
  readonly descriptor: WorkletDescriptor;
  readonly observedAt: string;
  readonly connected: boolean;
  readonly draining: boolean;
  readonly activeAttempts: number;
  readonly capacity: number;
  readonly availableSlots: number;
}

type InvocationIdentityResolution =
  | { readonly status: "unconfigured"; readonly account: SurfaceAccount }
  | {
      readonly status: "resolved";
      readonly account: SurfaceAccount;
      readonly route: TagRoute;
      readonly tag: Tag;
    };

/**
 * The Control Plane is the long-running service boundary. Provider callbacks only return
 * after admission is durable; Worker execution and reply delivery are recovered by
 * the background dispatcher if the process is interrupted.
 */
export class ControlPlane {
  readonly objectives: ObjectiveController;
  readonly #store: Store;
  readonly #sessionContinuity: SessionContinuity;
  readonly #surfaceSettlement: SurfaceSettlement;
  readonly #credentialVault: GatewayCredentialVault;
  readonly #onInboundEvent: InboundEventHandler | undefined;
  readonly #worklet: Worklet | undefined;
  readonly #reply: OutboundReplyHandler | undefined;
  readonly #instanceId: string;
  readonly #pollIntervalMs: number;
  readonly #leaseDurationMs: number;
  readonly #retryBaseMs: number;
  readonly #maxAttempts: number;
  readonly #dispatchErrors: DispatchErrorReporter;
  readonly #dispatchFailures = { inbound: 0, outbound: 0 };
  readonly #startedAt = new Date().toISOString();
  readonly #activeTaskControllers = new Map<string, AbortController>();
  /** Surface Tasks whose placement is held for an unsandboxed harness; their hold is recorded. */
  /**
   * Surface Tasks whose placement hold this process recorded (true) or found clear (false). A
   * Task's entry goes once it is claimed.
   */
  readonly #surfaceHolds = new Map<string, boolean>();
  readonly #surfaceJournalReplays = new Map<string, Promise<void>>();
  readonly #replyStreams = new ReplyStreams();
  /** Work Session executions running beside the task controller loop. */
  readonly #backgroundRuns = new Set<Promise<void>>();
  readonly #workSessionStarts = new Map<string, Promise<void>>();
  /** Per work Task: its message_parent notes and its report admission run one at a time. */
  readonly #workTaskTurns = new Map<string, Promise<void>>();
  #accepting = false;
  #running = false;
  #stopping = false;
  #taskControllerDrained = false;
  #taskControllerLoop: Promise<void> | undefined;
  #deliveryControllerLoop: Promise<void> | undefined;
  #drainPromise: Promise<void> | undefined;
  #wakeTaskController: (() => void) | undefined;
  #wakeDeliveryController: (() => void) | undefined;
  readonly #budgetNotifications: BudgetNotifications;
  readonly #objectiveMessages: ObjectiveMessages;
  readonly #operatorChannel: OperatorChannelNotifications | undefined;
  #lastBudgetNotificationScan = 0;
  #lastWorkReportSweep = 0;
  #lastOperatorChannelScan = 0;
  #operatorInboxRevision = 0;
  #scannedOperatorInboxRevision = -1;
  #operatorInboxChangedAt = 0;
  readonly #executionAffinity = new ExecutionAffinityCache();
  #activeAdmissions = 0;
  #admissionsDrained: (() => void) | undefined;
  #ephemeralSweepTimer: NodeJS.Timeout | undefined;
  readonly #audit: (entry: RecordAuditEntryInput) => unknown;

  constructor(dependencies: ControlPlaneDependencies) {
    if ((dependencies.worklet === undefined) !== (dependencies.reply === undefined)) {
      throw new Error("Control Plane Worklet and reply handler must be configured together");
    }
    this.#dispatchErrors = new DispatchErrorReporter(dependencies.dispatch?.onDispatchError);
    this.#instanceId = dependencies.dispatch?.instanceId ?? randomUUID();
    this.objectives = new ObjectiveController(
      dependencies.store,
      dependencies.worklet,
      (error) => this.#reportDispatchError(error),
      this.#executionAffinity,
      {
        wakeTaskController: () => this.#wakeTaskController?.(),
        systemWake: () => readSystemWake(),
        surfaceLeaseOwner: this.#instanceId,
        surfaceAttemptsRunning: () => this.#activeTaskControllers.size > 0,
      },
    );
    this.objectives.setWorkspacePullRequestHandler(dependencies.pullRequests);
    this.#store = dependencies.store;
    this.#audit = dependencies.audit ?? ((entry) => dependencies.store.recordAuditEntry(entry));
    this.#budgetNotifications = new BudgetNotifications(
      dependencies.store,
      dependencies.operatorNotificationTaskId,
      dependencies.reply !== undefined,
    );
    this.#objectiveMessages = new ObjectiveMessages(
      dependencies.store,
      dependencies.operatorNotificationTaskId,
      dependencies.reply !== undefined,
    );
    this.objectives.setInboxEnricher(async (page) => {
      const enriched = await this.#objectiveMessages.enrich(
        await this.#budgetNotifications.enrich(page),
      );
      const records = await dependencies.store.listOperatorNotificationsForItems(
        enriched.items.map(coordinationInboxOccurrence),
      );
      return {
        ...enriched,
        items: enriched.items.map((item) => {
          const deliveries = records.get(coordinationInboxOccurrence(item)) ?? [];
          if (deliveries.length === 0) {
            if (item.notification?.status === "unconfigured")
              return { ...item, notification: { status: "not configured" as const } };
            return item.notification || !shouldNotifyInboxItem(item)
              ? item
              : { ...item, notification: { status: "not configured" as const } };
          }
          const delivered = deliveries.filter((entry) => entry.status === "delivered");
          if (delivered.length > 0)
            return {
              ...item,
              notification: {
                status: "delivered" as const,
                reason: `via ${[...new Set(delivered.map((entry) => entry.destination.split(":", 1)[0]))].join(",")}`,
              },
            };
          const pending = deliveries.find(
            (entry) => entry.status === "pending" || entry.status === "delivering",
          );
          if (pending)
            return {
              ...item,
              notification: {
                status: "pending" as const,
                reason: `retry ${Math.min(pending.attemptCount + 1, pending.maxAttempts)}/${pending.maxAttempts}`,
              },
            };
          const failure = deliveries[0];
          return failure
            ? {
                ...item,
                notification: {
                  status:
                    failure.lastError === "Desktop notification unavailable"
                      ? ("unavailable" as const)
                      : ("failed" as const),
                  ...(failure.lastError === "Desktop notification unavailable"
                    ? {}
                    : { reason: failure.lastError ?? "delivery failed" }),
                },
              }
            : item;
        }),
      };
    });
    const operatorNotifications = dependencies.operatorNotifications;
    const surfaceDelivery = dependencies.reply !== undefined;
    this.#operatorChannel = operatorNotifications
      ? new OperatorChannelNotifications({
          store: dependencies.store,
          resolver: operatorNotifications.resolver,
          send: operatorNotifications.send,
          ...(operatorNotifications.destinationFromKey
            ? { destinationFromKey: operatorNotifications.destinationFromKey }
            : {}),
          ...(operatorNotifications.redact ? { redact: operatorNotifications.redact } : {}),
          readInbox: (input) => this.objectives.readCoordinationInbox(input),
          carriedElsewhere: async (item) =>
            surfaceDelivery && objectiveThreadCarries(dependencies.store, item),
          leaseOwner: dependencies.dispatch?.instanceId ?? `control-plane-${randomUUID()}`,
          ...(operatorNotifications.retryBaseMs === undefined
            ? {}
            : { retryBaseMs: operatorNotifications.retryBaseMs }),
          ...(operatorNotifications.now === undefined ? {} : { now: operatorNotifications.now }),
        })
      : undefined;
    this.objectives.setInboxChangeListener(() => this.#markOperatorInboxChanged());
    this.#sessionContinuity = new SessionContinuity(dependencies.store);
    this.#surfaceSettlement = new SurfaceSettlement(dependencies.store);
    this.objectives.setSurfaceReporter(async (objectiveId, text, deliveryKey) => {
      const objective = await this.#store.getObjective(objectiveId);
      const origin = objective.notificationTaskId
        ? undefined
        : await this.#store.getObjectiveSurfaceTask(objectiveId);
      const destination =
        objective.notificationTaskId ?? origin?.id ?? dependencies.operatorNotificationTaskId;
      const anchor = destination
        ? await this.#store.getVerifiedSurfaceTask(destination)
        : undefined;
      if (!anchor?.inboundEventId)
        throw new Error("Objective has no verified reporting destination");
      await this.#postNoticeOnce(anchor.inboundEventId, deliveryKey, text);
    });
    this.objectives.setWorkSessionHandlers({
      start: (task, inbound, request) => this.#startWorkSession(task, inbound, { start: request }),
      continue: (task, inbound, request) =>
        this.#startWorkSession(task, inbound, { continue: request }),
      approvalNotice: (task, inbound, requestId) =>
        this.#oneWorkTaskTurn(task.id, () =>
          this.#postWorkSessionApproval(task, inbound, requestId),
        ),
      messageParent: (task, inbound, text) =>
        this.#oneWorkTaskTurn(task.id, () => this.#messageParent(task, inbound, text)),
      approvalDecided: (request) =>
        this.#oneWorkTaskTurn(request.taskId, () =>
          this.#continueDecidedWorkSession(request.taskId),
        ),
    });
    this.objectives.setLostWorkerHostResolver((attempt) =>
      this.#removeLostEphemeralWorkerHost(attempt, EPHEMERAL_WORKER_HOST_GRACE_MS),
    );
    this.#credentialVault = dependencies.credentialVault;
    this.#onInboundEvent = dependencies.onInboundEvent;
    this.#worklet = dependencies.worklet;
    this.#reply = dependencies.reply;
    this.#pollIntervalMs = positiveDuration(
      dependencies.dispatch?.pollIntervalMs,
      DEFAULT_POLL_INTERVAL_MS,
      "pollIntervalMs",
    );
    this.#leaseDurationMs = positiveDuration(
      dependencies.dispatch?.leaseDurationMs,
      DEFAULT_LEASE_DURATION_MS,
      "leaseDurationMs",
    );
    this.#retryBaseMs = positiveDuration(
      dependencies.dispatch?.retryBaseMs,
      DEFAULT_RETRY_BASE_MS,
      "retryBaseMs",
    );
    this.#maxAttempts = positiveInteger(
      dependencies.dispatch?.maxAttempts,
      DEFAULT_MAX_ATTEMPTS,
      "maxAttempts",
    );
  }

  get isAccepting(): boolean {
    return this.#accepting;
  }

  async describeWorklet() {
    return this.#worklet ? describeWorklet(this.#worklet) : undefined;
  }

  /**
   * Bound Worker Hosts that carry the Tag's runsOn labels, provide the MCP servers its granted
   * tools need, and can serve the Task's workspace.
   */
  async #placement(task: Task, bindings: readonly TagWorkerHostBinding[]): Promise<TaskPlacement> {
    const tag = await this.#store.findTagById(task.tagId);
    const hosts = await this.listWorkerHosts();
    const workspaceMcp =
      task.workspacePlan?.status === "workspace" ? task.workspacePlan.mcp : undefined;
    const boundWorkerHostIds = bindings.map((binding) => binding.workerHostId);
    // A Task without a Workspace needs only the granted servers its bound hosts declare.
    const authorization = withoutMcpServers(
      task.authorizationSnapshot,
      undeclaredMcpServers(
        task.authorizationSnapshot,
        task.workspacePlan,
        boundWorkerHostIds,
        hosts,
      ),
    );
    return placeTask(
      boundWorkerHostIds,
      taskPlacementLabels(tag?.runsOn ?? [], authorization, workspaceMcp),
      task.workspacePlan,
      () => Promise.resolve(hosts),
      workspaceMcpServers(authorization, workspaceMcp),
      {
        ...commandPlacement(task),
        mounts: await volumeMountRequirements(this.#store, task.workspacePlan),
      },
    );
  }

  /**
   * Records why a surface Task cannot be placed, so `supertag describe task` and
   * `supertag message tag` show what it waits for, and records the hold's end once the Task can
   * be placed. A reason is written only when it changes, never on every dispatch pass.
   */
  async #recordSurfacePlacement(task: Task, placement: TaskPlacement): Promise<void> {
    // A hold recorded before a restart, or by another Control Plane, is read once per process.
    if (placement.status === "eligible" && this.#surfaceHolds.get(task.id) === false) return;
    const latest = (await this.#store.listTaskEvents(task.id)).findLast(isSchedulingEvent);
    if (placement.status === "eligible") {
      this.#surfaceHolds.set(task.id, false);
      if (latest?.type === "task.scheduling-incompatible")
        await this.#appendTaskEvent(task.id, "task.scheduling-compatible", {
          version: 1,
          status: "compatible",
        });
      return;
    }
    this.#surfaceHolds.set(task.id, true);
    const payload = {
      version: 1,
      status: "incompatible",
      unmetRequirements: [placement.requirement],
      candidates: [],
      ...(placement.mcpLogins === undefined ? {} : { mcpLogins: placement.mcpLogins }),
      ...(placement.unsandboxedCommands === undefined
        ? {}
        : { unsandboxedCommands: placement.unsandboxedCommands }),
      ...(placement.workspaceRefusals === undefined
        ? {}
        : { workspaceRefusals: placement.workspaceRefusals }),
      execution: task.execution,
    };
    if (
      latest?.type === "task.scheduling-incompatible" &&
      JSON.stringify(latest.payload) === JSON.stringify(payload)
    )
      return;
    await this.#appendTaskEvent(task.id, "task.scheduling-incompatible", payload);
  }

  async listWorkerHosts(): Promise<readonly WorkerHost[]> {
    if (this.#worklet === undefined || isSchedulableWorklet(this.#worklet))
      return this.#store.listWorkerHosts();
    const descriptor = await describeWorklet(this.#worklet);
    const at = this.#startedAt;
    const capacity = Math.max(
      1,
      descriptor.host.workers.reduce((total, worker) => total + (worker.maxConcurrency ?? 1), 0),
    );
    return [
      {
        id: descriptor.host.id,
        credentialId: "embedded",
        credentialRevision: 1,
        enrollmentStatus: "active",
        ephemeral: false,
        connectionGeneration: 1,
        connectionStatus: "connected",
        workletId: descriptor.id,
        protocolVersion: descriptor.protocolVersion,
        ...(descriptor.durableProtocolVersion === undefined
          ? {}
          : { durableProtocolVersion: descriptor.durableProtocolVersion }),
        ...(descriptor.controlProtocolVersion === undefined
          ? {}
          : { controlProtocolVersion: descriptor.controlProtocolVersion }),
        workerSnapshot: { ...descriptor.host },
        labels: effectiveWorkerHostLabels({ ...descriptor.host }),
        grantedLabels: [],
        ready: true,
        draining: false,
        lastSeenAt: at,
        connectedAt: at,
        activeAttempts: this.#activeTaskControllers.size + this.objectives.activeCount,
        capacity,
        availableSlots: Math.max(
          0,
          capacity - this.#activeTaskControllers.size - this.objectives.activeCount,
        ),
        lastAuthenticatedAt: at,
        failedAuthenticationCount: 0,
        createdAt: at,
        updatedAt: at,
      },
    ];
  }

  async enrollWorkerHost(input: {
    readonly id: string;
  }): Promise<{ readonly workerHost: WorkerHost; readonly token: string }> {
    const id = requiredText(input.id, "Worker Host id");
    if (await this.#store.findWorkerHostById(id))
      throw new Error(`Worker Host ${id} is already enrolled`);
    const issuedAt = new Date().toISOString();
    const token = workerHostToken();
    const credentialId = workerHostCredentialId(id, 1);
    await this.#credentialVault.store(credentialId, workerHostCredentialDigest(token));
    try {
      const workerHost = await this.#store.enrollWorkerHost({
        id,
        credentialId,
        enrolledAt: issuedAt,
      });
      return { workerHost, token };
    } catch (error) {
      await this.#credentialVault.delete(credentialId).catch(() => undefined);
      throw error;
    }
  }

  async rotateWorkerHostCredential(
    workerHostId: string,
  ): Promise<{ readonly workerHost: WorkerHost; readonly token: string } | undefined> {
    const id = requiredText(workerHostId, "Worker Host id");
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const current = await this.#store.findWorkerHostById(id);
      if (current === undefined || current.enrollmentStatus !== "active") return undefined;
      const token = workerHostToken();
      const credentialId = workerHostCredentialId(id, current.credentialRevision + 1);
      await this.#credentialVault.store(credentialId, workerHostCredentialDigest(token));
      let rotated: WorkerHost | undefined;
      try {
        rotated = await this.#store.rotateWorkerHostCredential({
          workerHostId: id,
          expectedCredentialRevision: current.credentialRevision,
          credentialId,
          rotatedAt: new Date().toISOString(),
        });
      } catch (error) {
        await this.#credentialVault.delete(credentialId).catch(() => undefined);
        throw error;
      }
      if (rotated !== undefined) {
        await this.#credentialVault
          .delete(current.credentialId)
          .catch((error) => this.#reportDispatchError(error));
        disconnectWorkerHost(this.#worklet, id, "Worker Host credential rotated");
        return { workerHost: rotated, token };
      }
      await this.#credentialVault.delete(credentialId).catch(() => undefined);
    }
    throw new Error(`Worker Host ${id} credential changed concurrently`);
  }

  async revokeWorkerHostCredential(
    workerHostId: string,
    reason: "OperatorRevoked" | "SelfRevoked" | "EphemeralDisconnected" = "OperatorRevoked",
  ): Promise<WorkerHost | undefined> {
    const id = requiredText(workerHostId, "Worker Host id");
    const current = await this.#store.findWorkerHostById(id);
    if (current === undefined) return undefined;
    const revoked = await this.#store.revokeWorkerHost({
      workerHostId: id,
      revokedAt: new Date().toISOString(),
      reason,
    });
    if (revoked === undefined) return undefined;
    await this.#credentialVault
      .delete(current.credentialId)
      .catch((error) => this.#reportDispatchError(error));
    disconnectWorkerHost(this.#worklet, id);
    return revoked;
  }

  /**
   * Creates an Auth Key for existing Tags. The secret is returned once; the store keeps only its
   * SHA-256 digest.
   */
  async createAuthKey(input: {
    readonly name: string;
    readonly tags: readonly string[];
    /** Placement labels granted to every host that redeems the key. */
    readonly labels?: readonly string[];
    readonly reusable: boolean;
    readonly ephemeral: boolean;
  }): Promise<{ readonly authKey: AuthKey; readonly secret: string }> {
    const name = parseAuthKeyName(input.name);
    const tagNames = [...new Set(input.tags.map((tag) => tag.trim()).filter(Boolean))];
    if (tagNames.length === 0 || tagNames.length > MAX_AUTH_KEY_TAGS)
      throw new TagMessagingError(400, `An Auth Key needs 1-${MAX_AUTH_KEY_TAGS} Tags`);
    const tagIds: string[] = [];
    for (const tagName of tagNames) {
      const tag = await this.#store.findTagByName(tagName);
      if (tag === undefined) throw new TagMessagingError(400, `Tag ${tagName} does not exist`);
      tagIds.push(tag.id);
    }
    const lookupId = randomBytes(AUTH_KEY_LOOKUP_LENGTH / 2).toString("hex");
    const secret = `${AUTH_KEY_PREFIX}${lookupId}${randomBytes(24).toString("hex")}`;
    const authKey = await this.#store.createAuthKey({
      name,
      tagIds,
      labels: input.labels ?? [],
      reusable: input.reusable,
      ephemeral: input.ephemeral,
      lookupId,
      secretDigest: storedSecretDigest(secret),
      createdAt: new Date().toISOString(),
    });
    return { authKey, secret };
  }

  listAuthKeys(): Promise<readonly AuthKey[]> {
    return this.#store.listAuthKeys();
  }

  findAuthKey(name: string): Promise<AuthKey | undefined> {
    return this.#store.findAuthKeyByName(name);
  }

  /** Blocks new redemptions. Hosts that already joined keep their enrollment and Tags. */
  revokeAuthKey(name: string): Promise<AuthKey | undefined> {
    return this.#store.revokeAuthKey(name, new Date().toISOString());
  }

  /**
   * Creates an Operator Token. The secret is returned once; the store keeps only its SHA-256
   * digest. Only admin-token holders reach this through the API.
   */
  async createOperatorToken(input: {
    readonly name: string;
  }): Promise<{ readonly operatorToken: OperatorToken; readonly secret: string }> {
    const name = parseOperatorTokenName(input.name);
    const lookupId = randomBytes(OPERATOR_TOKEN_LOOKUP_LENGTH / 2).toString("hex");
    const secret = `${OPERATOR_TOKEN_PREFIX}${lookupId}${randomBytes(24).toString("hex")}`;
    const operatorToken = await this.#store.createOperatorToken({
      name,
      lookupId,
      secretDigest: storedSecretDigest(secret),
      createdAt: new Date().toISOString(),
    });
    return { operatorToken, secret };
  }

  listOperatorTokens(): Promise<readonly OperatorToken[]> {
    return this.#store.listOperatorTokens();
  }

  findOperatorToken(name: string): Promise<OperatorToken | undefined> {
    return this.#store.findOperatorTokenByName(name);
  }

  /** Stops the token authenticating immediately. Idempotent. */
  revokeOperatorToken(name: string): Promise<OperatorToken | undefined> {
    return this.#store.revokeOperatorToken(name, new Date().toISOString());
  }

  /**
   * Authenticates a presented Operator Token secret. Returns the token, or why it was refused;
   * malformed text is `invalid` without a store read.
   */
  async authenticateOperatorToken(
    secret: string,
  ): Promise<
    | { readonly status: "authenticated"; readonly operatorToken: OperatorToken }
    | { readonly status: "invalid" | "expired" | "revoked" }
  > {
    if (!isOperatorTokenSecret(secret)) return { status: "invalid" };
    return this.#store.authenticateOperatorToken({
      lookupId: operatorTokenLookupId(secret),
      secretDigest: storedSecretDigest(secret),
      authenticatedAt: new Date().toISOString(),
    });
  }

  /**
   * Redeems an Auth Key: enrolls a new Worker Host under `workerHostName` (or `NAME-2`, `NAME-3`
   * on collision), binds the key's Tags, and returns the host's first credential once.
   */
  async redeemAuthKey(
    secret: string,
    workerHostName: string,
  ): Promise<{
    readonly workerHost: WorkerHost;
    readonly token: string;
    readonly authKey: AuthKey;
  }> {
    const name = parseWorkerHostName(workerHostName);
    if (!isAuthKeySecret(secret))
      throw new AuthKeyRedemptionError(401, "invalid", "Auth Key is invalid");
    const token = workerHostToken();
    const credentialId = workerHostCredentialId(`join/${randomUUID()}`, 1);
    await this.#credentialVault.store(credentialId, workerHostCredentialDigest(token));
    let result: Awaited<ReturnType<Store["redeemAuthKey"]>>;
    try {
      result = await this.#store.redeemAuthKey({
        lookupId: authKeyLookupId(secret),
        secretDigest: storedSecretDigest(secret),
        workerHostName: name,
        credentialId,
        redeemedAt: new Date().toISOString(),
      });
    } catch (error) {
      await this.#credentialVault.delete(credentialId).catch(() => undefined);
      throw error;
    }
    if (result.status === "redeemed")
      return { workerHost: result.workerHost, token, authKey: result.authKey };
    await this.#credentialVault.delete(credentialId).catch(() => undefined);
    throw authKeyRedemptionError(result.status);
  }

  /**
   * Removes ephemeral Worker Hosts that stayed disconnected past the grace period, or that joined
   * and never connected. Removal revokes the host, unbinds its Tags, and fences its connection,
   * so its interrupted Task Attempts count as stopped and may run elsewhere.
   */
  async sweepEphemeralWorkerHosts(now = Date.now()): Promise<readonly string[]> {
    const removed: string[] = [];
    for (const host of await this.#store.listWorkerHosts()) {
      if (!host.ephemeral || host.enrollmentStatus !== "active") continue;
      if (host.connectionStatus !== "disconnected") continue;
      const since = Date.parse(host.disconnectedAt ?? host.createdAt);
      const limit =
        host.lastAuthenticatedAt === undefined
          ? EPHEMERAL_WORKER_HOST_JOIN_TIMEOUT_MS
          : EPHEMERAL_WORKER_HOST_GRACE_MS;
      if (now - since < limit) continue;
      if (await this.#removeEphemeralWorkerHost(host.id)) removed.push(host.id);
    }
    return removed;
  }

  async #removeEphemeralWorkerHost(workerHostId: string): Promise<boolean> {
    const revoked = await this.revokeWorkerHostCredential(workerHostId, "EphemeralDisconnected");
    if (revoked?.revocationReason !== "EphemeralDisconnected") return false;
    for (const tag of await this.#store.listTags())
      await this.#store.unbindTagWorkerHost(tag.id, workerHostId);
    return true;
  }

  /**
   * Returns the ID of the removed ephemeral Worker Host that ran `attempt`, removing the host
   * first when it has been disconnected for at least `minimumDisconnectedMs`. Returns undefined
   * for persistent hosts, which keep the stricter rule that unknown execution retains capacity.
   */
  async #removeLostEphemeralWorkerHost(
    attempt: TaskAttempt,
    minimumDisconnectedMs: number,
  ): Promise<string | undefined> {
    const workerHostId = attemptWorkerHostId(attempt);
    if (workerHostId === undefined) return undefined;
    const host = await this.#store.findWorkerHostById(workerHostId);
    if (!host?.ephemeral) return undefined;
    if (host.enrollmentStatus === "revoked") return host.id;
    if (host.connectionStatus !== "disconnected") return undefined;
    const since = Date.parse(host.disconnectedAt ?? host.createdAt);
    if (Date.now() - since < minimumDisconnectedMs) return undefined;
    await this.#removeEphemeralWorkerHost(host.id);
    const current = await this.#store.findWorkerHostById(host.id);
    return current?.enrollmentStatus === "revoked" ? host.id : undefined;
  }

  async authenticateWorkerHost(
    request: WorkerHostAuthenticationRequest,
  ): Promise<WorkerHostAuthenticationResult | undefined> {
    const workerHostId = request.worklet.host.id;
    const current = await this.#store.findWorkerHostById(workerHostId);
    if (current === undefined || current.enrollmentStatus !== "active") return undefined;
    const stored = await this.#credentialVault.resolve(current.credentialId);
    if (!workerHostCredentialMatches(request.credential, stored)) {
      await this.#store.recordWorkerHostAuthenticationFailure(
        workerHostId,
        new Date().toISOString(),
      );
      return undefined;
    }
    const capacity = Math.max(
      1,
      request.worklet.host.workers.reduce(
        (total, worker) => total + (worker.maxConcurrency ?? 1),
        0,
      ),
    );
    const claimed = await this.#store.claimWorkerHostConnection({
      workerHostId,
      credentialRevision: current.credentialRevision,
      workletId: request.worklet.id,
      protocolVersion: request.protocolVersion,
      ...(request.worklet.durableProtocolVersion === undefined
        ? {}
        : { durableProtocolVersion: request.worklet.durableProtocolVersion }),
      ...(request.worklet.controlProtocolVersion === undefined
        ? {}
        : { controlProtocolVersion: request.worklet.controlProtocolVersion }),
      workerSnapshot: { ...request.worklet.host },
      capacity,
      availableSlots: current.draining ? 0 : capacity,
      activeAttempts: 0,
      ready: !current.draining,
      observedAt: new Date().toISOString(),
    });
    return claimed === undefined
      ? undefined
      : { connectionGeneration: claimed.connectionGeneration, draining: claimed.draining };
  }

  /** Authenticates an already-enrolled Host for bounded auxiliary Worklet APIs. */
  async authenticateConnectedWorkerHost(
    workerHostId: string,
    credential: string | undefined,
  ): Promise<WorkerHost | undefined> {
    const current = await this.authenticateWorkerHostCredential(workerHostId, credential);
    return current?.connectionStatus === "connected" ? current : undefined;
  }

  /** Authenticates an active Host's own credential, whether or not it is connected. */
  async authenticateWorkerHostCredential(
    workerHostId: string,
    credential: string | undefined,
  ): Promise<WorkerHost | undefined> {
    const id = requiredText(workerHostId, "Worker Host id");
    const current = await this.#store.findWorkerHostById(id);
    if (current === undefined || current.enrollmentStatus !== "active" || credential === undefined)
      return undefined;
    const stored = await this.#credentialVault.resolve(current.credentialId);
    if (!workerHostCredentialMatches(credential, stored)) {
      await this.#store.recordWorkerHostAuthenticationFailure(id, new Date().toISOString());
      return undefined;
    }
    return current;
  }

  async observeWorkerHostConnection(
    observation: WorkerHostConnectionObservation,
  ): Promise<boolean | WorkerHostObservationResult> {
    if (!observation.connected)
      return this.#store.releaseWorkerHostConnection({
        workerHostId: observation.workerHostId,
        connectionGeneration: observation.connectionGeneration,
        disconnectedAt: observation.observedAt,
      });
    const result = await this.#store.updateWorkerHostObservation({
      workerHostId: observation.workerHostId,
      connectionGeneration: observation.connectionGeneration,
      workletId: observation.descriptor.id,
      protocolVersion: observation.protocolVersion,
      ...(observation.descriptor.durableProtocolVersion === undefined
        ? {}
        : { durableProtocolVersion: observation.descriptor.durableProtocolVersion }),
      ...(observation.descriptor.controlProtocolVersion === undefined
        ? {}
        : { controlProtocolVersion: observation.descriptor.controlProtocolVersion }),
      workerSnapshot: { ...observation.descriptor.host },
      capacity: observation.capacity,
      availableSlots: observation.availableSlots,
      activeAttempts: observation.activeAttempts,
      ready: observation.connected && !observation.draining && observation.availableSlots > 0,
      observedAt: observation.observedAt,
    });
    if (result !== undefined && observation.changedPaths?.length) {
      try {
        await detectOverlapWarnings(
          this.#store,
          this.objectives.liveDelivery,
          observation.changedPaths,
        );
      } catch (error) {
        this.#reportDispatchError(error);
      }
    }
    return result === undefined ? false : result;
  }

  async setWorkerHostDraining(workerHostId: string, draining: boolean): Promise<boolean> {
    const workerHost = await this.#store.setWorkerHostDraining(
      workerHostId,
      draining,
      new Date().toISOString(),
    );
    if (workerHost === undefined) return false;
    const worklet = this.#worklet;
    if (worklet !== undefined && isSchedulableWorklet(worklet))
      await worklet.setHostDraining(workerHostId, draining);
    return true;
  }

  async inspectTaskExecution(taskId: string) {
    const [task, attempts] = await Promise.all([
      this.#store.findTaskById(taskId),
      this.#store.listTaskAttempts(taskId),
    ]);
    const attempt = attempts.toSorted((a, b) => b.attemptNumber - a.attemptNumber)[0];
    if (
      attempt?.workerSnapshot["durableExecution"] === true &&
      task?.inboundEventId != null &&
      !this.#activeTaskControllers.has(taskId) &&
      this.#worklet &&
      "inspect" in this.#worklet &&
      typeof this.#worklet.inspect === "function" &&
      "events" in this.#worklet &&
      typeof this.#worklet.events === "function"
    )
      await this.#replaySurfaceAttemptJournal(
        taskId,
        attempt.id,
        this.#worklet as DurableWorklet,
      ).catch((error) => this.#reportDispatchError(error));
    const events = await this.#store.listTaskEvents(taskId);
    const limits = taskExecutionLimitReport(task, attempt, events);
    const placement = taskExecutionPlacementReport(attempt, events);
    if (!attempt) return { availability: "not_started" as const, limits, placement };
    if (attempt.workerSnapshot["durableExecution"] !== true)
      return { availability: "unsupported" as const, attemptId: attempt.id, limits, placement };
    if (
      !this.#worklet ||
      !("inspect" in this.#worklet) ||
      typeof this.#worklet.inspect !== "function"
    )
      return { availability: "unavailable" as const, attemptId: attempt.id, limits, placement };
    try {
      const receipt = await this.#worklet.inspect(attempt.id);
      return receipt
        ? { availability: "available" as const, attemptId: attempt.id, receipt, limits, placement }
        : { availability: "unavailable" as const, attemptId: attempt.id, limits, placement };
    } catch {
      return { availability: "unavailable" as const, attemptId: attempt.id, limits, placement };
    }
  }

  async requestTaskCancellation(
    taskId: string,
    /** The operator who asked; recorded on the Task's coordination change. */
    principal?: CoordinationOperatorPrincipal,
  ): Promise<{ readonly accepted: boolean; readonly task: Task }> {
    const internal = await this.#store.getTaskAssignment(taskId);
    if (internal) {
      if (!["queued", "running", "submitted"].includes(internal.status)) {
        const task = await this.#store.findTaskById(taskId);
        if (!task) throw new Error("Task not found");
        return { accepted: false, task };
      }
      await this.objectives.commandAsAdministrator(
        "update_task",
        {
          objectiveId: internal.objectiveId,
          taskId,
          expectedStatus: internal.status,
          status: "cancelled",
        },
        principal,
      );
      const task = await this.#store.findTaskById(taskId);
      if (!task) throw new Error("Task not found");
      return { accepted: true, task };
    }
    const task = await this.#store.findTaskById(taskId);
    if (task === undefined) throw new Error(`Task ${JSON.stringify(taskId)} does not exist`);
    if (task.status !== "pending" && task.status !== "running") return { accepted: false, task };
    const controller = this.#activeTaskControllers.get(task.id);
    if (controller === undefined) {
      const cancelled = await this.#store.cancelPendingSurfaceTask({
        taskId: task.id,
        cancelledAt: new Date().toISOString(),
      });
      if (!cancelled)
        return { accepted: false, task: (await this.#store.findTaskById(task.id)) ?? task };
      await this.#appendTaskEvent(task.id, "task.cancellation-requested", {});
      await this.#appendTaskEvent(task.id, "task.cancelled", { reason: "operator-request" });
      if (task.inboundEventId !== null)
        await this.#finishReplyStream(task.id, task.inboundEventId, "cancelled");
      await this.#reportWorkSession(task.id);
      this.#wakeDeliveryController?.();
      this.#markOperatorInboxChanged();
      return { accepted: true, task: cancelled };
    }
    if (await this.#surfaceSettlement.pending(task.id)) return { accepted: false, task };
    await this.#appendTaskEvent(task.id, "task.cancellation-requested", {});
    controller.abort(new Error("Task cancelled by an operator"));
    return { accepted: true, task };
  }

  get isRunning(): boolean {
    return this.#running;
  }

  get controllerStatuses(): readonly ControlPlaneControllerStatus[] {
    const phase = this.#stopping ? "draining" : this.#running ? "running" : "stopped";
    return [
      { name: "task-dispatch", phase },
      { name: "reply-delivery", phase: this.#reply === undefined ? "disabled" : phase },
    ];
  }

  async start(): Promise<void> {
    if (this.#running) {
      return;
    }
    await this.#store.connect();
    try {
      await ensureBuiltInRoles(this.#store);
    } catch (error) {
      await this.#store.disconnect();
      throw error;
    }
    this.#stopping = false;
    this.#taskControllerDrained = false;
    this.#drainPromise = undefined;
    this.#running = true;
    this.#accepting = true;
    this.objectives.start();
    this.#ephemeralSweepTimer = setInterval(() => {
      void controlPlaneEventLoopLag
        .run("job: ephemeral Worker Host sweep", () => this.sweepEphemeralWorkerHosts())
        .catch((error) => this.#reportDispatchError(error));
    }, EPHEMERAL_WORKER_HOST_SWEEP_INTERVAL_MS);
    this.#ephemeralSweepTimer.unref();
    this.#taskControllerLoop = this.#runTaskController();
    // A report turn a stop or crash cut off is admitted now; admission is idempotent.
    void this.#reportFinishedWorkSessions();
    if (this.#reply !== undefined || this.#operatorChannel !== undefined) {
      this.#deliveryControllerLoop = this.#runDeliveryController();
    }
  }

  /** Fence new admissions while allowing already accepted work to drain. */
  beginDrain(): void {
    this.#accepting = false;
  }

  /** Settle accepted work while keeping persistence connected for execution APIs. */
  async drain(): Promise<void> {
    if (!this.#running) {
      return;
    }
    this.beginDrain();
    clearInterval(this.#ephemeralSweepTimer);
    this.#ephemeralSweepTimer = undefined;
    this.#drainPromise ??= (async () => {
      await this.#waitForAdmissions();
      await this.objectives.stop();
      this.#stopping = true;
      this.#wakeTaskController?.();
      this.#wakeDeliveryController?.();
      await Promise.all([this.#taskControllerLoop, this.#deliveryControllerLoop]);
    })();
    await this.#drainPromise;
  }

  async stop(): Promise<void> {
    if (!this.#running) return;
    await this.drain();
    this.#running = false;
    this.#taskControllerLoop = undefined;
    this.#deliveryControllerLoop = undefined;
    this.#drainPromise = undefined;
    this.#replyStreams.close();
    await this.#store.disconnect();
    this.#dispatchErrors.flush();
  }

  /**
   * Stores verified credentials in the credential vault and saves the account. A SurfaceAccount
   * manifest also records its name and the references its secrets came from, never the values.
   */
  async setupSurfaceAccount(
    verified: VerifiedSurfaceAccount,
    declaration: {
      readonly name?: string;
      readonly secretReferences?: SurfaceAccountInput["secretReferences"];
    } = {},
  ): Promise<SurfaceAccount> {
    const credentialId = `surface/${verified.provider}/${verified.externalAccountId}`;
    const priorCredential = await this.#credentialVault.resolve(credentialId);

    await this.#credentialVault.store(credentialId, verified.secrets);
    try {
      return await this.#store.saveSurfaceAccount({
        provider: verified.provider,
        externalAccountId: verified.externalAccountId,
        displayName: verified.displayName,
        authMethod: verified.authMethod,
        credentialId,
        status: "connected",
        configuration: verified.configuration,
        verifiedAt: new Date().toISOString(),
        ...(declaration.name === undefined ? {} : { name: declaration.name }),
        ...(declaration.secretReferences === undefined
          ? {}
          : { secretReferences: declaration.secretReferences }),
      });
    } catch (error) {
      if (priorCredential === undefined) {
        await this.#credentialVault.delete(credentialId);
      } else {
        await this.#credentialVault.store(credentialId, priorCredential);
      }
      throw error;
    }
  }

  async ingestSurfaceEvent(
    event: InboundSurfaceEvent,
    options: { readonly execution?: TaskExecutionRequirements } = {},
  ): Promise<InboundIngestResult> {
    const requested = parseTaskExecutionRequirements(options.execution ?? {});
    if (event.internal !== undefined)
      throw new Error("Only SuperTag admits work Session, report and update turns");
    return this.#admitting(async () => {
      const identity = await this.#resolveInvocationIdentity(event);
      if (identity.status === "unconfigured") {
        return {
          status: "unconfigured",
          surfaceAccountId: identity.account.id,
          eventId: event.eventId,
        };
      }
      const { account, route, tag } = identity;
      const objectiveThread = await this.#routeObjectiveThread(event, account, route, tag);
      if (objectiveThread) return objectiveThread;
      return this.#admitEvent(event, account, route, tag, requested);
    });
  }

  /**
   * `supertag message tag`: one message from an operator to a Tag in a CLI conversation. The
   * conversation is direct, so its Session is private to the operator, and it has no location:
   * the synthetic origin carries no Permission or Context Set activations, so the Tag answers
   * with its Roles only. Replies are recorded, never sent anywhere; the CLI reads them.
   */
  async messageTag(input: {
    readonly tagName: string;
    /** Stable operator identity: `admin` or `token:NAME`. */
    readonly operatorId: string;
    readonly session: string;
    readonly text: string;
  }): Promise<InboundIngestResult> {
    return this.#admitting(async () => {
      const tag = await this.#store.findTagByName(input.tagName);
      if (tag === undefined || tag.status !== "active")
        throw new Error(`Tag ${input.tagName} does not exist`);
      const now = new Date().toISOString();
      const account =
        (await this.#store.findSurfaceAccount("cli", CLI_EXTERNAL_ACCOUNT_ID)) ??
        (await this.#store.saveSurfaceAccount({
          provider: "cli",
          externalAccountId: CLI_EXTERNAL_ACCOUNT_ID,
          displayName: "CLI",
          authMethod: "operator",
          credentialId: `surface/cli/${CLI_EXTERNAL_ACCOUNT_ID}`,
          status: "connected",
          configuration: {},
          verifiedAt: now,
        }));
      const route = cliTagRoute(tag, account);
      const eventId = randomUUID();
      const sessionKey = `cli:${input.operatorId}:${input.session}`;
      const event: InboundSurfaceEvent = {
        eventId,
        logicalEventId: eventId,
        provider: "cli",
        externalAccountId: CLI_EXTERNAL_ACCOUNT_ID,
        kind: "message",
        scope: route.scope,
        sessionKey,
        actor: { id: input.operatorId, displayName: input.operatorId, kind: "user" },
        text: input.text,
        occurredAt: now,
        callback: { provider: "cli", mode: "cli_conversation", threadKey: sessionKey, target: {} },
        source: { session: input.session },
        metadata: {},
        direct: true,
      };
      return this.#admitEvent(event, account, route, tag, parseTaskExecutionRequirements({}));
    });
  }

  async #admitting(admit: () => Promise<InboundIngestResult>): Promise<InboundIngestResult> {
    if (!this.#accepting) {
      throw new Error("Control Plane is stopped or draining and is not accepting inbound events");
    }
    this.#activeAdmissions += 1;
    try {
      return await admit();
    } finally {
      this.#activeAdmissions -= 1;
      if (this.#activeAdmissions === 0) {
        this.#admissionsDrained?.();
        this.#admissionsDrained = undefined;
      }
    }
  }

  async #admitEvent(
    event: InboundSurfaceEvent,
    account: SurfaceAccount,
    route: TagRoute,
    tag: Tag,
    requested: TaskExecutionRequirements,
  ): Promise<InboundIngestResult> {
    const workerHostBindings = await this.#store.listTagWorkerHostBindings(tag.id);
    if (workerHostBindings.length === 0) {
      const reason = `Tag ${tag.name} cannot accept Tasks because it has no Worker Host binding. Bind a Worker Host to the Tag, then retry.`;
      if (event.provider !== "cli")
        await this.#reply?.(event, { kind: "error", markdown: reason }, account, {});
      return {
        status: "rejected",
        surfaceAccountId: account.id,
        eventId: event.eventId,
        tagRouteId: route.id,
        tagId: tag.id,
        reason,
      };
    }
    const conversationalSurface = event.provider === "slack" || event.provider === "lark";
    const existingSession =
      conversationalSurface && event.kind === "message"
        ? await this.#store.findSessionByTagAndKey(tag.id, event.sessionKey)
        : undefined;
    if (
      conversationalSurface &&
      (event.actor.kind !== "user" ||
        (event.kind === "message" &&
          (existingSession === undefined ||
            existingSession.origin["provider"] !== event.provider ||
            existingSession.origin["surfaceAccountId"] !== account.id ||
            existingSession.origin["scope"] !== event.scope ||
            existingSession.origin["threadKey"] !== event.callback.threadKey)))
    ) {
      return {
        status: "ignored",
        surfaceAccountId: account.id,
        eventId: event.eventId,
        tagRouteId: route.id,
        tagId: tag.id,
      };
    }

    const capturedAt = new Date().toISOString();
    const roles = await resolveTagRoles(this.#store, tag.id);
    // A surface message chooses nothing: the Tag's defaults apply unless the caller set them.
    const { execution, selection } = resolveTaskExecution({
      range: await tagExecutionRange(this.#store, tag, roles),
      requested,
      chosen: {
        ...(requested.model === undefined ? {} : { model: requested.model }),
        ...(requested.effort === undefined ? {} : { effort: requested.effort }),
      },
      subject: `Tag ${tag.name}`,
    });
    const [authorization, contextPlan] = await Promise.all([
      this.#captureAuthorization(event, account, route, tag, capturedAt, roles),
      this.#captureContextPlan(event, account, route, capturedAt, roles),
    ]);

    const admission = await this.#store.admitInboundEvent({
      surfaceAccountId: account.id,
      tagRouteId: route.id,
      tagId: tag.id,
      authorization,
      contextPlan,
      execution,
      event,
      maxAttempts: this.#maxAttempts,
    });
    const task = await this.#openTask(admission.work);
    if (admission.status === "duplicate") {
      return {
        status: "duplicate",
        surfaceAccountId: account.id,
        eventId: event.eventId,
        inboundEventId: admission.work.id,
        taskId: task.id,
        tagRouteId: route.id,
        tagId: tag.id,
      };
    }
    await this.#appendTaskEvent(task.id, "task.admitted", {
      tagRouteId: route.id,
      scope: event.scope,
      contextSetIds: contextPlan.sets.map((set) => set.id),
      roleIds: authorization.roles?.map((entry) => entry.role.id) ?? [],
    });
    if (recordsSelection(selection))
      await this.#appendTaskEvent(task.id, EXECUTION_RESOLVED_EVENT, {
        version: 1,
        ...selection,
      });
    const inputDelivery = await this.#deliverSessionInput(admission.work, task);
    await this.#enqueuePresentation(admission.work, {
      workerId: "control-plane",
      presentation: "acknowledgement",
      deliveryKey: "acknowledgement",
      text:
        inputDelivery === "accepted"
          ? "Your message was accepted by the active execution in this thread."
          : inputDelivery === "unknown"
            ? "I could not confirm delivery to the active execution. I have kept the delivery record. Your message will be retried on the next activation if the active execution withdraws it as unread; please do not resend it while that execution is active. If it ends without resolving delivery, I will tell you to resend in a new thread."
            : acknowledgementText(task),
    });
    this.#wakeTaskController?.();
    this.#wakeDeliveryController?.();
    return {
      status: "accepted",
      surfaceAccountId: account.id,
      eventId: event.eventId,
      inboundEventId: admission.work.id,
      taskId: task.id,
      tagRouteId: route.id,
      tagId: tag.id,
    };
  }

  /**
   * A person replying in an Objective's notification thread directs that Objective. A plain
   * thread reply becomes an operator message to the owner, like `supertag message objective`;
   * `@SuperTag approve` approves a ready_for_review result, and `@SuperTag pause` and
   * `@SuperTag resume` pause and resume the Objective. Anyone who may create Objectives
   * from this surface may do this. Other messages keep their ordinary Session handling.
   */
  async #routeObjectiveThread(
    event: InboundSurfaceEvent,
    account: SurfaceAccount,
    route: { readonly id: string; readonly scope: string },
    tag: { readonly id: string },
  ): Promise<InboundIngestResult | undefined> {
    if (
      (event.provider !== "slack" && event.provider !== "lark") ||
      event.actor.kind !== "user" ||
      !event.text?.trim()
    )
      return undefined;
    const command = parseSurfaceObjectiveCommand(event);
    const directive =
      command?.kind === "approve" || command?.kind === "pause" || command?.kind === "resume"
        ? command.kind
        : undefined;
    if (!directive && (event.kind !== "message" || command !== undefined)) return undefined;
    const session = await this.#store.findSessionByTagAndKey(tag.id, event.sessionKey);
    if (
      !session ||
      session.origin["provider"] !== event.provider ||
      session.origin["surfaceAccountId"] !== account.id ||
      session.origin["scope"] !== event.scope ||
      session.origin["threadKey"] !== event.callback.threadKey
    )
      return undefined;
    const objective = await this.#store.findObjectiveByNotificationSession(session.id);
    if (!objective) return undefined;
    const principal = {
      operatorId: `${event.provider}:${event.actor.id}`,
      scopes: { actions: ["send_message", "update_objective"] },
    };
    let text: string;
    // Recording never fails the change it describes, whether it throws or rejects.
    const audited = async (outcome: "succeeded" | "failed", status?: number) => {
      try {
        await this.#audit({
          at: new Date().toISOString(),
          actor: principal.operatorId,
          action: directive ? `objective.${directive}` : "objective.message",
          target: `Objective/${objective.id}`,
          outcome,
          ...(status === undefined ? {} : { status }),
          source: "gateway",
        });
      } catch (error) {
        this.#reportAuditError(error);
      }
    };
    try {
      if (directive === "pause") {
        const paused = await this.objectives.pauseObjective(
          { objectiveId: objective.id },
          principal,
        );
        text = paused.changed
          ? `Paused. Objective ${objective.id} starts no new work; running Task Attempts finish. Resume with @SuperTag resume.`
          : `Objective ${objective.id} is already paused. Resume with @SuperTag resume.`;
      } else if (directive === "resume") {
        const resumed = await this.objectives.resumeObjective(
          { objectiveId: objective.id },
          principal,
        );
        text = resumed.changed
          ? `Resumed. Objective ${objective.id} can start work again; the owner received a summary of what changed while it was paused.`
          : `Objective ${objective.id} is not paused.`;
      } else if (directive === "approve") {
        const approved = await this.objectives.approveObjective(
          { objectiveId: objective.id },
          principal,
        );
        text = `Approved. Objective ${approved.id} is completed.`;
      } else {
        const sent = await this.objectives.messageObjective(
          {
            objectiveId: objective.id,
            message: event.text,
            idempotencyKey: `surface:${createHash("sha256").update(`${account.id}\n${event.eventId}`).digest("hex").slice(0, 40)}`,
          },
          principal,
        );
        text = sent.duplicate
          ? "This message was already delivered to the Objective owner."
          : sent.statusChange
            ? `Sent to the Objective owner. The Objective moved from ${sent.statusChange.from} to working.`
            : "Sent to the Objective owner.";
      }
      await audited("succeeded");
    } catch (error) {
      await audited("failed", error instanceof TagMessagingError ? error.statusCode : undefined);
      if (!(error instanceof TagMessagingError)) throw error;
      text = error.message;
    }
    await this.#reply?.(event, { kind: "status", markdown: text }, account, {});
    return {
      status: "accepted",
      surfaceAccountId: account.id,
      eventId: event.eventId,
      tagRouteId: route.id,
      tagId: tag.id,
      objectiveId: objective.id,
    };
  }

  async #deliverSessionInput(
    work: DurableInboundEvent,
    task: Task,
  ): Promise<"accepted" | "unknown" | undefined> {
    const worklet = this.#worklet;
    if (
      !worklet?.control ||
      !worklet.controlCapabilities ||
      work.event.actor.kind !== "user" ||
      !work.event.text?.trim() ||
      parseSurfaceObjectiveCommand(work.event) !== undefined
    )
      return undefined;
    const active = await this.#store.findActiveSessionAttempt(work.id);
    if (!active?.task.inboundEventId) return undefined;
    const original = await this.#store.findInboundEventById(active.task.inboundEventId);
    // An internal turn (a work Session's Task, a report or an update turn) is not a conversation
    // turn: a person's message waits for its own Task, which may start work and answer them.
    if (
      !original ||
      original.event.internal !== undefined ||
      !this.#sessionContinuity.acceptsInput(
        { work: original, task: active.task, workerProfile: active.attempt.workerProfile },
        { work, task },
      )
    )
      return undefined;
    let capabilities: HarnessControlCapabilities | undefined;
    let capabilityTimeout: ReturnType<typeof setTimeout> | undefined;
    try {
      capabilities = await Promise.race([
        worklet.controlCapabilities(active.task.id, active.attempt.id),
        new Promise<undefined>((resolve) => {
          capabilityTimeout = setTimeout(() => resolve(undefined), 2_000);
          capabilityTimeout.unref();
        }),
      ]);
    } catch {
      return undefined;
    } finally {
      if (capabilityTimeout) clearTimeout(capabilityTimeout);
    }
    if (
      !capabilities ||
      !Array.isArray(capabilities.operations) ||
      !capabilities.operations.includes("input") ||
      (capabilities.inputMode !== "queue" && capabilities.inputMode !== "steer")
    )
      return undefined;
    const command = {
      id: `${SESSION_INPUT_COMMAND_PREFIX}${work.id}`,
      taskId: active.task.id,
      attemptId: active.attempt.id,
      type: "input" as const,
      text: `Human message ${JSON.stringify({ eventId: work.event.eventId, actor: work.event.actor })}:\n${work.event.text}`,
    };
    const prepared = await this.#store.prepareInboundControlDelivery({
      inboundEventId: work.id,
      taskId: active.task.id,
      attemptId: active.attempt.id,
      command,
    });
    if (!prepared) return undefined;
    if (!prepared.created) return prepared.delivery.status === "accepted" ? "accepted" : "unknown";
    let status: "accepted" | "rejected" | "unknown" = "unknown";
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const remaining =
        Date.parse(prepared.delivery.createdAt) + SESSION_INPUT_ACK_TIMEOUT_MS - Date.now();
      if (remaining <= 0) throw new Error("Session input acknowledgement timed out");
      const acknowledgement = await Promise.race([
        worklet.control(command),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error("Session input acknowledgement timed out")),
            remaining,
          );
          timeout.unref();
        }),
      ]);
      if (
        acknowledgement.id === command.id &&
        acknowledgement.taskId === command.taskId &&
        acknowledgement.attemptId === command.attemptId &&
        ["accepted", "rejected", "unknown"].includes(acknowledgement.status)
      )
        status = acknowledgement.status;
    } catch {
      // The native action may have happened. Never replay an ambiguous delivery.
    } finally {
      if (timeout) clearTimeout(timeout);
    }
    const finished = await this.#store.finishInboundControlDelivery({
      inboundEventId: work.id,
      status,
    });
    // Withdrawn before the acknowledgement arrived: the message runs as its own Task.
    if (finished.status === "withdrawn") return undefined;
    return finished.status === "rejected"
      ? undefined
      : finished.status === "accepted"
        ? "accepted"
        : "unknown";
  }

  async #resolveInvocationIdentity(
    event: InboundSurfaceEvent,
  ): Promise<InvocationIdentityResolution> {
    const account = await this.#store.findSurfaceAccount(event.provider, event.externalAccountId);
    if (account === undefined) {
      throw new Error(`No connected ${event.provider} account matches ${event.externalAccountId}`);
    }
    const route = await this.#store.resolveTagRoute(account.id, event.scope);
    if (route === undefined) return { status: "unconfigured", account };
    if (route.surfaceAccountId !== account.id || route.scope !== event.scope) {
      throw new Error("Resolved Tag route does not match the authenticated invocation surface");
    }
    const tag = await this.#store.findTagById(route.tagId);
    if (tag === undefined) {
      throw new Error(`Tag ${route.tagId} for route ${route.id} no longer exists`);
    }
    // Retirement removes routes; a route that outlived it still must not admit work.
    if (tag.status !== "active") return { status: "unconfigured", account };
    return { status: "resolved", account, route, tag };
  }

  async #runTaskController(): Promise<void> {
    try {
      while (this.#running) {
        try {
          const progressed = await controlPlaneEventLoopLag.run("job: task dispatch", () =>
            this.#reconcileNextTask(),
          );
          if (progressed) {
            this.#dispatchFailures.inbound = 0;
            this.#markOperatorInboxChanged();
          }
          if (!progressed && this.#running) {
            if (this.#stopping) break;
            await this.#waitForDispatch("inbound");
          }
        } catch (error) {
          this.#dispatchFailures.inbound++;
          this.#reportDispatchError(error);
          if (this.#stopping) break;
          if (this.#running) await this.#waitForDispatch("inbound");
        }
      }
    } finally {
      await Promise.allSettled([...this.#backgroundRuns]);
      this.#taskControllerDrained = true;
      this.#wakeDeliveryController?.();
    }
  }

  async #runDeliveryController(): Promise<void> {
    while (this.#running) {
      try {
        const progressed = await controlPlaneEventLoopLag.run("job: reply delivery", () =>
          this.#reconcileNextDelivery(),
        );
        this.#dispatchFailures.outbound = 0;
        if (!progressed && this.#running) {
          if (this.#stopping && this.#taskControllerDrained) break;
          await this.#waitForDispatch("outbound");
        }
      } catch (error) {
        this.#dispatchFailures.outbound++;
        this.#reportDispatchError(error);
        if (this.#stopping && this.#taskControllerDrained) break;
        if (this.#running) await this.#waitForDispatch("outbound");
      }
    }
  }

  async #reconcileNextTask(): Promise<boolean> {
    const claim = this.#claimInput();
    if (Date.now() - this.#lastWorkReportSweep >= WORK_REPORT_SWEEP_INTERVAL_MS)
      await this.#reportFinishedWorkSessions();
    // An event that cannot be placed now waits without holding back the events behind it. Each
    // Session has at most one due event, so no event overtakes an earlier one of its Session.
    // Pages run until one event runs or every due event was tried.
    let after: DurableInboundEvent | undefined;
    for (let page = 0; ; page++) {
      const candidates = await this.#store.listDueInboundEvents({
        now: claim.now,
        limit: DISPATCH_CANDIDATES_PER_TICK,
        ...(after === undefined ? {} : { after }),
      });
      if (page === 0 && candidates.length === 0) this.#dispatchFailures.inbound = 0;
      for (const candidate of candidates)
        if ((await this.#reconcileInboundEvent(candidate, claim)) === true) return true;
      if (candidates.length < DISPATCH_CANDIDATES_PER_TICK) return false;
      after = candidates.at(-1);
    }
  }

  /** Places, claims and runs one due inbound event; "unplaced" when no Worker can take it now. */
  async #reconcileInboundEvent(
    candidate: DurableInboundEvent,
    claim: { readonly leaseOwner: string; readonly now: string; readonly leaseExpiresAt: string },
  ): Promise<boolean | "unplaced"> {
    // A Surface Attempt this Control Plane runs keeps its lease through a suspend grace; its
    // renewal timer extends the lease, so do not reclaim it as abandoned meanwhile.
    if (candidate.status === "processing" && this.objectives.surfaceLeaseCurrent(candidate))
      return false;
    // Health, profile compatibility, draining, and capacity are checked before
    // the assignment lease is claimed. Unschedulable work remains pending and
    // does not consume an execution attempt.
    let selectedPlacement: import("@supertag/worker-sdk").WorkletExecutionPlacement | undefined;
    let preparedOutcome: PreparedSurfaceOutcome | undefined;
    let outcomePersisted = false;
    let pendingTask: Task;
    try {
      pendingTask = await this.#openTask(candidate);
      preparedOutcome = await this.#surfaceSettlement.pending(pendingTask.id);
      if (!preparedOutcome) {
        if (!this.#worklet) return false;
        const workerHostBindings = await this.#store.listTagWorkerHostBindings(pendingTask.tagId);
        if (workerHostBindings.length === 0) {
          await this.#recordSurfacePlacement(pendingTask, {
            status: "unmet",
            requirement: "tag.workerHostBindings",
          });
          return "unplaced";
        }
        // Labels narrow the bound hosts; with none eligible the Task waits for one to connect.
        const placement = await this.#placement(pendingTask, workerHostBindings);
        await this.#recordSurfacePlacement(pendingTask, placement);
        if (placement.status === "unmet") return "unplaced";
        const preferred = await this.#sessionContinuity.preferredProfile(candidate, pendingTask);
        const descriptor = preferred ? await describeWorklet(this.#worklet) : undefined;
        const tiers = placement.tiers.map((tier) => ({
          allowedWorkerHostIds: tier.allowedWorkerHostIds,
          requirements: withRequiredCapabilities(pendingTask.execution, tier.requires),
        }));
        // The Session constraint is decided once across every tier, so a later tier that can
        // resume the Session wins over an earlier one that could only replay it.
        const sessionTiers: readonly SessionPlacementChoice[] =
          preferred && descriptor
            ? sessionPlacement(descriptor, tiers, candidate.contextPlan, preferred)
            : tiers.map((tier) => ({ requirements: tier.requirements }));
        for (const [index, tier] of tiers.entries()) {
          const sessionTier = sessionTiers[index];
          if (sessionTier === undefined) continue;
          const { requirements, compatibleProfile } = sessionTier;
          selectedPlacement = await this.#executionAffinity.select(
            this.#worklet,
            pendingTask.tagId,
            requirements,
            candidate.contextPlan,
            {
              allowedWorkerHostIds: tier.allowedWorkerHostIds,
              ...(compatibleProfile === undefined ? {} : { compatibleProfile }),
              ...(conversationSlot(candidate) ? { coordinationSlot: true } : {}),
            },
          );
          if (selectedPlacement) break;
        }
        this.#dispatchFailures.inbound = 0;
        if (!selectedPlacement) return "unplaced";
      }
    } catch (error) {
      this.#dispatchFailures.inbound++;
      this.#reportDispatchError(error);
      return false;
    }
    const work = await this.#store.claimDueInboundEvent({
      ...claim,
      inboundEventId: candidate.id,
      // A recovery preflight did not select execution capacity. If another owner
      // consumes its intent first, leave the next real Attempt for fresh scheduling.
      recoveryOnly: preparedOutcome !== undefined,
    });
    if (work === undefined) {
      return false;
    }
    this.#surfaceHolds.delete(pendingTask.id);
    try {
      // The prior owner may have prepared its outcome after our preflight read
      // but before lease takeover. Re-read under the newly acquired authority.
      preparedOutcome = await this.#surfaceSettlement.pending(pendingTask.id);
    } catch (error) {
      this.#reportDispatchError(error);
      return true;
    }
    if (preparedOutcome) {
      try {
        await this.#commitSurfaceOutcome(work, preparedOutcome);
      } catch (error) {
        // Keep the durable intent and let lease recovery retry only persistence.
        this.#reportDispatchError(error);
      }
      return true;
    }
    if (!selectedPlacement || !this.#worklet) throw new Error("Selected Worker is missing");
    const placed = selectedPlacement;
    const worklet = this.#worklet;
    const pending = pendingTask;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const execute = async (): Promise<void> => {
      let task: Task | undefined;
      let attempt: TaskAttempt | undefined;
      let executionController: AbortController | undefined;
      let durableExecution = false;
      let leaseRenewalTimer: NodeJS.Timeout | undefined;
      const workerEvents: WorkerTaskAttemptEvent[] = [];
      let lastProgressText: string | undefined;
      try {
        const account = await this.#store.findSurfaceAccountById(work.surfaceAccountId);
        if (account === undefined) {
          throw new Error(`Surface account ${work.surfaceAccountId} no longer exists`);
        }
        await this.#onInboundEvent?.(work.event, account, {
          tagRouteId: work.tagRouteId,
          tagId: work.tagId,
        });

        task = await this.#openTask(work);
        const priorAttempts = await this.#store.listTaskAttempts(task.id);
        const prior = priorAttempts.toSorted((a, b) => b.attemptNumber - a.attemptNumber)[0];
        // A removed ephemeral host cannot report again, so its Attempt counts as stopped.
        const lostWorkerHostId =
          prior?.workerSnapshot["durableExecution"] === true &&
          (prior.status === "running" || prior.status === "failed")
            ? await this.#removeLostEphemeralWorkerHost(prior, 0)
            : undefined;
        if (prior !== undefined && lostWorkerHostId !== undefined && prior.status === "running")
          await this.#appendTaskEvent(
            task.id,
            "task.worker-host-removed",
            { version: 1, workerHostId: lostWorkerHostId, requeued: true },
            prior.id,
          );
        if (prior?.workerSnapshot["durableExecution"] === true && lostWorkerHostId === undefined) {
          attempt = prior;
          if (
            "inspect" in worklet &&
            typeof worklet.inspect === "function" &&
            "events" in worklet &&
            typeof worklet.events === "function"
          )
            await this.#replaySurfaceAttemptJournal(
              task.id,
              prior.id,
              worklet as DurableWorklet,
            ).catch((error) => this.#reportDispatchError(error));
          throw new UncertainExecutionError(prior.id);
        }
        const history = (
          await this.#store.listTaskHistory({
            sessionId: task.sessionId,
            tagId: task.tagId,
            excludeTaskId: task.id,
            limit: MAX_SESSION_HISTORY_TASKS,
          })
        )
          .toReversed()
          .map(boundedTaskHistory);
        if (task.status === "pending")
          task = await this.#store.refreshPendingTaskSessionHistory(task.id, history);
        durableExecution = await supportsDurableExecution(
          worklet,
          placed.workerProfile,
          task.contextPlan,
        );
        attempt = await this.#openTaskAttempt(work, task, durableExecution, placed);
        // Only CLI conversations have a reader for the live reply.
        if (work.event.provider === "cli") this.#replyStreams.open(task.id, attempt.attemptNumber);
        executionController = new AbortController();
        this.#activeTaskControllers.set(task.id, executionController);
        leaseRenewalTimer = setInterval(
          () => {
            const now = new Date();
            void this.#store
              .renewInboundEventLease({
                inboundEventId: work.id,
                leaseOwner: this.#instanceId,
                now: now.toISOString(),
                leaseExpiresAt: new Date(now.getTime() + this.#leaseDurationMs).toISOString(),
              })
              .then((renewed) => {
                if (!renewed && !executionController?.signal.aborted) {
                  executionController?.abort(new AssignmentLeaseLostError(work.id));
                }
              })
              .catch((error: unknown) => {
                this.#reportDispatchError(error);
              });
          },
          Math.max(10, Math.floor(this.#leaseDurationMs / 3)),
        );
        leaseRenewalTimer.unref();
        const executionTaskId = task.id;
        const executionAttemptId = attempt.id;
        for await (const event of executeWorkletAttempt(
          worklet,
          await this.#taskAttemptSpec(work, task, attempt),
          executionController.signal,
          durableExecution,
          durableExecution
            ? (entry) => this.#recordWorkerJournalEvent(executionTaskId, executionAttemptId, entry)
            : undefined,
          undefined,
          (receipt) =>
            recordAttemptWorkerReceipt(this.#store, executionTaskId, executionAttemptId, receipt),
        )) {
          workerEvents.push(event);
          markStarted();
          this.#replyStreams.event(task.id, event);
          if (!durableExecution) await this.#recordWorkerEvent(task.id, attempt.id, event);
          // A work Session posts nowhere, and an update turn may post nothing at all.
          if (
            event.type === "progress.updated" &&
            work.event.internal?.kind !== "work_session" &&
            work.event.internal?.kind !== "session_update" &&
            (await this.#supportsReplyReplacement(work))
          ) {
            const text = taskProgressText(event.progress);
            if (text !== lastProgressText) {
              lastProgressText = text;
              await this.#enqueuePresentation(work, {
                workerId: worklet.id,
                presentation: "status",
                deliveryKey: "progress",
                text,
              });
              this.#wakeDeliveryController?.();
            }
          }
        }
        const outputFailure = workspaceMountOutputFailure(workerEvents);
        if (outputFailure) throw new Error(outputFailure);
        const responseText = terminalOutputText(workerEvents);
        const workerId = executionWorkerId(workerEvents) ?? worklet.id;
        const completedAt = new Date().toISOString();
        const result = buildTaskResult(work, responseText, workerEvents);
        // A work Session Task completes either done or waiting: on the person, with the question
        // it asked, or on the approval requests it left pending, which a decision continues.
        const asked =
          work.event.internal?.kind === "work_session"
            ? (await this.#store.listTaskEvents(task.id)).findLast(
                (event) =>
                  event.type === WORK_SESSION_ASKED_EVENT && event.attemptId === attempt?.id,
              )?.payload?.["question"]
            : undefined;
        // The requests this Attempt was told to end its turn on, while pending or decided but
        // unused: a decision that lands while the Task still runs reaches no tool call, so the
        // Task waits on it too, and the continuation after completion carries it.
        const approvals =
          work.event.internal?.kind === "work_session"
            ? (
                await this.#store.listApprovalRequests({
                  taskId: task.id,
                  kind: "surface-action",
                  limit: 500,
                })
              )
                .filter(
                  (request) =>
                    request.attemptId === attempt?.id &&
                    (request.status === "pending" ||
                      request.status === "denied" ||
                      (request.status === "approved" && request.consumedAt === null)),
                )
                .toSorted((left, right) => left.createdAt.localeCompare(right.createdAt))
                .map((request) => request.id)
            : [];
        // An update turn that called skip_reply ends with an empty final reply, which posts
        // nothing; its result keeps what the Tag wrote.
        const skipped =
          work.event.internal?.kind === "session_update" &&
          (await this.#store.listTaskEvents(task.id)).some(
            (event) =>
              event.type === SESSION_UPDATE_SKIPPED_EVENT && event.attemptId === attempt?.id,
          );
        preparedOutcome = {
          taskId: task.id,
          attemptId: attempt.id,
          status: "completed",
          outcome: {
            responseLength: responseText.length,
            ...(typeof asked === "string" ? { question: asked } : {}),
            ...(approvals.length === 0 ? {} : { approvals }),
            ...(skipped ? { skipped: true } : {}),
          },
          workerId,
          responseText: skipped ? "" : finalResultText(responseText, result),
          completedAt,
          result,
        };
        try {
          await this.#surfaceSettlement.prepare(preparedOutcome, work.id, this.#instanceId);
        } catch (error) {
          // A rejected output is terminal validation, not a persistence outage to retry.
          if (error instanceof ArtifactCatalogError) preparedOutcome = undefined;
          throw error;
        }
        outcomePersisted = true;
        await this.#sessionContinuity
          .save(work, task, attempt.workerProfile, workerEvents, completedAt)
          .catch((error) => this.#reportDispatchError(error));
        await this.#commitSurfaceOutcome(work, preparedOutcome);
      } catch (error) {
        if (preparedOutcome) {
          // Never reinterpret an observed outcome as a new execution failure. If
          // intent persistence failed, retry it before allowing lease recovery.
          await this.#retainSurfaceOutcome(work, preparedOutcome, error, outcomePersisted);
          return;
        }
        if (executionController?.signal.reason instanceof AssignmentLeaseLostError) {
          this.#reportDispatchError(executionController.signal.reason);
          return;
        }
        if (task !== undefined && attempt !== undefined && executionController?.signal.aborted) {
          const completedAt = new Date().toISOString();
          const cancelled: SurfaceOutcome = {
            taskId: task.id,
            attemptId: attempt.id,
            status: "cancelled",
            outcome: { reason: "operator-request" },
            workerId: worklet?.id ?? "control-plane",
            responseText: durableExecution
              ? "Cancellation requested; the Worker may still be cleaning up."
              : "I stopped working on this.",
            completedAt,
            ...(durableExecution
              ? { sessionBlockReason: "Cancellation cleanup has not been confirmed" }
              : {}),
          };
          try {
            await this.#surfaceSettlement.prepare(cancelled, work.id, this.#instanceId);
            outcomePersisted = true;
            await this.#commitSurfaceOutcome(work, cancelled);
          } catch (settlementError) {
            await this.#retainSurfaceOutcome(work, cancelled, settlementError, outcomePersisted);
          }
          return;
        }
        const budgetExhausted = workerEvents.some(
          (event) =>
            event.type === "execution.failed" &&
            event.error.name === "ExecutionBudgetExceededError",
        );
        const failure = externalWriteFailure(error, workerEvents);
        // An ephemeral host that stayed away past the observer's reconnect grace is removed; its
        // interrupted Attempt counts as stopped and the Task retries elsewhere. Persistent hosts
        // keep the stricter rule: unknown execution is never replayed automatically.
        const lostWorkerHostId =
          error instanceof UncertainExecutionError &&
          attempt !== undefined &&
          !workerEvents.some((event) => event.type === "execution.completed")
            ? await this.#removeLostEphemeralWorkerHost(attempt, 0).catch((lookupError) => {
                this.#reportDispatchError(lookupError);
                return undefined;
              })
            : undefined;
        const uncertain =
          lostWorkerHostId === undefined &&
          (error instanceof UncertainExecutionError ||
            (durableExecution &&
              !workerEvents.some(
                (event) =>
                  event.type === "execution.failed" || event.type === "execution.completed",
              )));
        const now = new Date();
        const failed: SurfaceFailureOutcome = {
          taskId: task?.id ?? pending.id,
          ...(attempt ? { attemptId: attempt.id } : {}),
          claimAttemptCount: work.attemptCount,
          error: errorMessage(failure),
          retryable:
            !budgetExhausted &&
            failure === error &&
            !(error instanceof ArtifactCatalogError) &&
            (!durableExecution || lostWorkerHostId !== undefined) &&
            !uncertain &&
            !workerEvents.some((event) => event.type === "execution.completed") &&
            workspaceMountOutputFailure(workerEvents) === undefined,
          retryAt: new Date(now.getTime() + this.#retryDelay(work.attemptCount)).toISOString(),
          failedAt: now.toISOString(),
          workerId: worklet?.id ?? "control-plane",
          responseText: budgetExhausted
            ? "Execution stopped because its budget was exhausted. Completed work remains recorded; additional execution requires an authorized allocation. " +
              failureText(failure)
            : failureText(failure),
          ...(uncertain
            ? { sessionBlockReason: "Execution completion could not be confirmed" }
            : {}),
        };
        try {
          await this.#surfaceSettlement.prepare(failed, work.id, this.#instanceId);
          outcomePersisted = true;
          await this.#commitSurfaceOutcome(work, failed);
        } catch (settlementError) {
          await this.#retainSurfaceOutcome(work, failed, settlementError, outcomePersisted);
        }
        this.#reportDispatchError(failure);
      } finally {
        if (leaseRenewalTimer !== undefined) clearInterval(leaseRenewalTimer);
        if (task !== undefined) this.#activeTaskControllers.delete(task.id);
        markStarted();
      }
    };
    if (work.event.internal?.kind === "work_session") {
      // A work Session runs beside conversation turns: dispatch waits only until it has started,
      // so the conversation and its report turns stay responsive while the work runs.
      const running: Promise<void> = execute()
        .catch((error: unknown) => this.#reportDispatchError(error))
        .finally(() => this.#backgroundRuns.delete(running));
      this.#backgroundRuns.add(running);
      await Promise.race([started, running]);
      return true;
    }
    await execute();
    return true;
  }

  async #commitSurfaceOutcome(
    work: DurableInboundEvent,
    outcome: PreparedSurfaceOutcome,
  ): Promise<void> {
    const status = await this.#surfaceSettlement.commit(outcome, work.id, this.#instanceId);
    const result = isSurfaceFailure(outcome) ? { error: outcome.error } : outcome.outcome;
    if (outcome.attemptId)
      await this.#appendTaskEvent(
        outcome.taskId,
        `attempt.${isSurfaceFailure(outcome) ? "failed" : outcome.status}`,
        result,
        outcome.attemptId,
      );
    if (status !== "pending") {
      await this.#appendTaskEvent(outcome.taskId, `task.${status}`, result);
      await this.#finishReplyStream(outcome.taskId, work.id, status);
      if (work.event.internal?.kind === "work_session")
        await this.#reportWorkSession(outcome.taskId);
      this.#wakeDeliveryController?.();
      this.#markOperatorInboxChanged();
    }
  }

  /** Ends a conversation Task's live reply with the final reply it recorded. */
  async #finishReplyStream(
    taskId: string,
    inboundEventId: string,
    status: "completed" | "failed" | "cancelled",
  ): Promise<void> {
    const reply = await this.#store
      .findOutboundReply(inboundEventId, "final")
      .catch((error: unknown) => {
        this.#reportDispatchError(error);
        return undefined;
      });
    this.#replyStreams.finish(taskId, {
      status,
      ...(reply === undefined
        ? {}
        : { reply: { presentation: reply.presentation, text: reply.text } }),
    });
  }

  /**
   * The live reply of a running conversation Task as Server-Sent Events, after the part numbered
   * `after` or only parts still to come; undefined when the Task has no running reply stream, so
   * the caller reads the record.
   */
  streamTaskReply(
    taskId: string,
    after: number | "now" = 0,
  ): Promise<ReadableStream<string> | undefined> {
    return this.#replyStreams.read(taskId, after);
  }

  async #retainSurfaceOutcome(
    work: DurableInboundEvent,
    outcome: PreparedSurfaceOutcome,
    error: unknown,
    alreadyPersisted: boolean,
  ): Promise<void> {
    if (alreadyPersisted) {
      this.#reportDispatchError(error);
      return;
    }
    try {
      await this.#surfaceSettlement.prepare(outcome, work.id, this.#instanceId);
    } catch (prepareError) {
      await this.#store.blockInboundSession(work.id, "Execution outcome could not be persisted", {
        leaseOwner: this.#instanceId,
        now: new Date().toISOString(),
      });
      this.#reportDispatchError(prepareError);
    }
    this.#reportDispatchError(error);
  }

  async #taskAttemptSpec(
    work: DurableInboundEvent,
    task: Task,
    attempt: TaskAttempt,
  ): Promise<TaskAttemptSpec> {
    const text = work.event.text?.trim();
    const persistence = await this.objectives.sessionPersistence(task, attempt);
    const workerHostBindings = await this.#store.listTagWorkerHostBindings(task.tagId);
    if (workerHostBindings.length === 0)
      throw new WorkletAdmissionRejectedError(
        `Tag ${task.authorizationSnapshot.tag.name} has no Worker Host binding`,
      );
    const placement = await this.#placement(task, workerHostBindings);
    if (placement.status === "unmet")
      throw new WorkletAdmissionRejectedError(
        `No bound Worker Host can run this Task (${placement.requirement})`,
      );
    const selectedPlacement = executionPlacementSnapshot(attempt.workerSnapshot);
    const descriptor = await (this.#worklet ? describeWorklet(this.#worklet) : undefined);
    // Native state resumes on any profile of the harness that produced it.
    const sessionState = await this.#sessionContinuity.read(
      work,
      task,
      descriptor ? profileHarness(descriptor.host.workers, attempt.workerProfile) : undefined,
    );
    const supportsSurfaceCoordination = descriptor?.host.workers.some(
      (worker) =>
        descriptorSupportsSurfaceCoordination(worker, attempt.workerProfile) &&
        descriptorSupportsRequiredContext(worker, work.contextPlan, attempt.workerProfile) &&
        worker.profiles.some(
          (profile) =>
            profile.id === attempt.workerProfile.id &&
            profile.revision === attempt.workerProfile.revision,
        ),
    );
    const coordination =
      supportsSurfaceCoordination && work.event.actor.kind === "user"
        ? await this.objectives.surfaceCoordination(task, attempt)
        : undefined;
    const internal = work.event.internal;
    // Every conversation turn with surface coordination sees the Tag's open Objectives and the
    // work Sessions it started. A work Session sees only its own work, so it gets no portfolio.
    const portfolio =
      coordination === undefined || internal?.kind === "work_session"
        ? undefined
        : await tagPortfolio(this.#store, conversationViewer(task, work), {
            workSessions: await this.#store.listWorkSessions(task.sessionId),
            startSessions: internal === undefined,
          });
    const turn =
      internal === undefined
        ? undefined
        : internalTurnMessages(internal, text, task.sessionId, coordination !== undefined);
    const workspaceEvents =
      task.workspacePlan.status === "workspace"
        ? workerEvents(await this.#store.listTaskEvents(task.id))
        : [];
    const branchPin =
      task.workspacePlan.status === "workspace"
        ? workspaceBranchPin(workspaceEvents, task.workspacePlan.workspace)
        : undefined;
    const branchPinHead =
      task.workspacePlan.status === "workspace"
        ? workspaceBranchHeadPin(workspaceEvents, task.workspacePlan.workspace)
        : undefined;
    const skillPins = workspaceSkillPins(workspaceEvents);
    const mcpPin =
      task.workspacePlan.status === "workspace" && task.workspacePlan.mcp?.length
        ? workspaceMcpPin(await this.#store.listTaskAttempts(task.id))
        : undefined;
    // A continued work Session Task starts from the work Session's earlier commits.
    const sessionBranches =
      task.workspacePlan.status === "workspace" &&
      internal?.kind === "work_session" &&
      internal.continued === true
        ? await sessionWorkspaceBranches(this.#store, task, task.workspacePlan)
        : [];
    return {
      version: 2,
      taskId: task.id,
      attemptId: attempt.id,
      tag: { id: work.authorization.tag.id, name: work.authorization.tag.name },
      input: {
        origin: {
          surface: work.event.provider,
          accountId: work.surfaceAccountId,
          scope: work.event.scope,
          sessionKey: work.event.sessionKey,
          occurredAt: work.event.occurredAt,
          source: work.event.source,
          metadata: work.event.metadata,
        },
        messages: [
          ...(portfolio === undefined
            ? []
            : [{ id: `${task.id}:portfolio`, role: "system" as const, text: portfolio }]),
          // An internal turn's prompt comes from SuperTag or the Tag, never from a person.
          ...(turn === undefined
            ? []
            : [
                { id: `${task.id}:${internal?.kind}`, role: "system" as const, text: turn.system },
                { id: work.event.eventId, role: "requester" as const, text: turn.prompt },
              ]),
          ...(turn !== undefined || text === undefined || text.length === 0
            ? []
            : [
                {
                  id: work.event.eventId,
                  role: "requester" as const,
                  text,
                  actor: work.event.actor,
                },
              ]),
        ],
      },
      authorization: withoutMcpServers(
        work.authorization,
        undeclaredMcpServers(
          work.authorization,
          task.workspacePlan,
          workerHostBindings.map((binding) => binding.workerHostId),
          await this.listWorkerHosts(),
        ),
      ),
      ...(coordination === undefined ? {} : { coordination }),
      contextPlan: work.contextPlan,
      workspacePlan:
        task.workspacePlan.status === "workspace"
          ? {
              ...(await dispatchedWorkspacePlan(this.#store, task.workspacePlan)),
              ...(skillPins === undefined ? {} : { skillPins }),
              ...(branchPin === undefined ? {} : { branch: branchPin, branchPin }),
              ...(branchPinHead === undefined ? {} : { branchPinHead }),
              ...(mcpPin === undefined ? {} : { mcpPin }),
              ...(sessionBranches.length === 0 ? {} : { dependencyBranches: sessionBranches }),
            }
          : task.workspacePlan,
      workerProfile: attempt.workerProfile,
      execution: task.execution,
      placement: {
        allowedWorkerHostIds: placement.tiers.flatMap((tier) => tier.allowedWorkerHostIds),
        ...(selectedPlacement === undefined ? {} : selectedPlacement),
        ...(conversationSlot(work) ? { coordinationSlot: true } : {}),
      },
      session: {
        id: task.sessionId,
        ...(persistence === undefined ? {} : { persistence }),
        ...(sessionState === undefined ? {} : { sessionState }),
        ...(task.sessionHistory.length === 0 ? {} : { history: task.sessionHistory }),
      },
    };
  }

  async #recordWorkerEvent(
    taskId: string,
    attemptId: string,
    event: WorkerTaskAttemptEvent,
  ): Promise<void> {
    const digest = workspaceMcpDigest(event);
    if (digest) await this.#store.recordTaskAttemptMcpDigest(taskId, attemptId, digest);
    const liveMounts = workspaceLiveMounts(event);
    if (liveMounts) await this.#store.recordTaskAttemptLiveMounts(taskId, attemptId, liveMounts);
    const mounts = workspaceMountManifests(event);
    if (mounts) await this.#store.recordTaskAttemptMountManifests(taskId, attemptId, mounts);
    const output = workspaceMountOutputManifests(event);
    if (output) await this.#store.recordTaskAttemptMountOutputManifests(taskId, attemptId, output);
    const { taskId: _workerTaskId, attemptId: _workerAttemptId, type, at, ...data } = event;
    const eventType = type.startsWith("execution.") ? type : `execution.${type}`;
    // Reply text reaches readers through the reply stream; the result keeps the final text.
    if (type !== "output.delta")
      await this.#appendTaskEvent(taskId, eventType, { at, ...data }, attemptId);
    await this.#withdrawSessionInput({ ...event, taskId, attemptId });
  }

  /** An operator message the model never read before the final response runs as its own Task. */
  async #withdrawSessionInput(event: WorkerTaskAttemptEvent): Promise<void> {
    if (await withdrawSessionInput(this.#store, event)) this.#wakeTaskController?.();
  }

  /**
   * A durable Worklet owns the journal sequence. Persist it before consuming the
   * event so recovery can resume at the first missing entry without rerunning work.
   */
  async #recordWorkerJournalEvent(
    taskId: string,
    attemptId: string,
    entry: AttemptJournalEvent,
  ): Promise<void> {
    if (entry.event.taskId !== taskId || entry.event.attemptId !== attemptId)
      throw new UncertainExecutionError(attemptId);
    const digest = workspaceMcpDigest(entry.event);
    if (digest) await this.#store.recordTaskAttemptMcpDigest(taskId, attemptId, digest);
    const liveMounts = workspaceLiveMounts(entry.event);
    if (liveMounts) await this.#store.recordTaskAttemptLiveMounts(taskId, attemptId, liveMounts);
    const mounts = workspaceMountManifests(entry.event);
    if (mounts) await this.#store.recordTaskAttemptMountManifests(taskId, attemptId, mounts);
    const output = workspaceMountOutputManifests(entry.event);
    if (output) await this.#store.recordTaskAttemptMountOutputManifests(taskId, attemptId, output);
    const { taskId: _workerTaskId, attemptId: _workerAttemptId, type, at, ...data } = entry.event;
    const eventType = type.startsWith("execution.") ? type : `execution.${type}`;
    // Before the journal cursor moves past it, so recovery repeats a withdrawal a crash cut off.
    await this.#withdrawSessionInput(entry.event);
    // Reply text is not stored. Replay starts after the last stored entry, so a crash repeats only
    // the deltas after it, and they change nothing.
    if (type === "output.delta") return;
    await this.#store.appendTaskEvent({
      taskId,
      attemptId,
      type: eventType,
      payload: { at, ...data, journalSequence: entry.sequence },
    });
  }

  async #replaySurfaceAttemptJournal(
    taskId: string,
    attemptId: string,
    durable: DurableWorklet,
  ): Promise<void> {
    const active = this.#surfaceJournalReplays.get(attemptId);
    if (active) return active;
    const replay = this.#replaySurfaceAttemptJournalNow(taskId, attemptId, durable);
    this.#surfaceJournalReplays.set(attemptId, replay);
    try {
      await replay;
    } finally {
      if (this.#surfaceJournalReplays.get(attemptId) === replay)
        this.#surfaceJournalReplays.delete(attemptId);
    }
  }

  async #replaySurfaceAttemptJournalNow(
    taskId: string,
    attemptId: string,
    durable: DurableWorklet,
  ): Promise<void> {
    const saved = (await this.#store.listTaskEvents(taskId)).filter(
      (event) =>
        event.attemptId === attemptId && typeof event.payload?.["journalSequence"] === "number",
    );
    let cursor = Math.max(0, ...saved.map((event) => Number(event.payload?.["journalSequence"])));
    const receipt = await durable.inspect(attemptId);
    await recordAttemptWorkerReceipt(this.#store, taskId, attemptId, receipt);
    if (!receipt || receipt.lastSequence <= cursor) return;
    const throughSequence = receipt.lastSequence;
    for await (const entry of durable.events(attemptId, cursor)) {
      if (entry.sequence <= cursor) continue;
      if (entry.sequence !== cursor + 1) throw new UncertainExecutionError(attemptId);
      await this.#recordWorkerJournalEvent(taskId, attemptId, entry);
      cursor = entry.sequence;
      if (cursor === throughSequence) break;
    }
    if (cursor !== throughSequence) throw new UncertainExecutionError(attemptId);
  }

  /**
   * `start_session` opens a work Session of the conversation and admits its first Task;
   * `continue_session` admits the next Task of one of the conversation's finished work Sessions.
   * Either Task runs under the starting turn's admitted authorization, context plan, execution
   * requirements and Workspace plan, and counts against that turn's work Session bounds. It
   * returns at once; the Task queues behind the conversation's running work Sessions.
   */
  async #startWorkSession(
    conversation: Task,
    starting: DurableInboundEvent,
    request:
      | { readonly start: StartSessionRequest }
      | { readonly continue: ContinueSessionRequest },
  ): Promise<{
    readonly sessionId: string;
    readonly title: string;
    readonly status: "started" | "queued";
  }> {
    if (!this.#accepting)
      throw new TagMessagingError(503, "The Control Plane is not accepting new work now");
    // One conversation's start_session and continue_session calls run one at a time, so the
    // bounds below hold.
    const previous = this.#workSessionStarts.get(conversation.sessionId) ?? Promise.resolve();
    const run = previous.then(() => this.#startWorkSessionNow(conversation, starting, request));
    const settled = run.then(
      () => undefined,
      () => undefined,
    );
    this.#workSessionStarts.set(conversation.sessionId, settled);
    try {
      return await run;
    } finally {
      if (this.#workSessionStarts.get(conversation.sessionId) === settled)
        this.#workSessionStarts.delete(conversation.sessionId);
    }
  }

  async #startWorkSessionNow(
    conversation: Task,
    starting: DurableInboundEvent,
    request:
      | { readonly start: StartSessionRequest }
      | { readonly continue: ContinueSessionRequest },
  ): Promise<{
    readonly sessionId: string;
    readonly title: string;
    readonly status: "started" | "queued";
  }> {
    const verb = "start" in request ? "start" : "continue";
    // Work Sessions are parallel agents of the starting turn: a turn starts at most its share,
    // none when its maxNativeAgents is 0, and they spend from its reported token and cost limits.
    // A retired Tag admits no new work, even work a running turn asks for.
    if ((await this.#store.findTagById(conversation.tagId))?.status !== "active")
      throw new TagMessagingError(
        409,
        `This Tag is no longer active, so it cannot ${verb} a work Session`,
      );
    const perTurn = workSessionsPerTurn(starting.execution);
    if (perTurn === 0)
      throw new TagMessagingError(
        403,
        `This turn may not run parallel agents (maxNativeAgents is 0), so it cannot ${verb} a work Session; do the work in this turn`,
      );
    const sessions = await this.#store.listWorkSessions(conversation.sessionId);
    // The turn continuing a work Session is its latest Task's starter, so this counts each work
    // Task this turn started once: a turn never continues a work Session it ran itself.
    const startedBy = (session: WorkSessionSummary) =>
      session.task?.startedByTaskId ?? session.startedByTaskId;
    let previous: { readonly work: DurableInboundEvent; readonly title: string } | undefined;
    if ("continue" in request) {
      const target = sessions.find((session) => session.sessionId === request.continue.sessionId);
      if (target?.task === undefined)
        throw new TagMessagingError(
          404,
          "No work Session of this conversation has that id; continue_session continues only work Sessions this conversation started",
        );
      if (target.task.status === "pending" || target.task.status === "running")
        throw new TagMessagingError(
          409,
          "That work Session is still working; its report comes back here when it finishes",
        );
      // A cancelled work Session was stopped on purpose; only a new work Session resumes the work.
      if (target.task.status === "cancelled")
        throw new TagMessagingError(
          409,
          "That work Session was cancelled; start a new work Session if the work should continue",
        );
      if (startedBy(target) === conversation.id)
        throw new TagMessagingError(
          409,
          "This turn already ran that work Session; pass the person's answer from a later message",
        );
      // Continue only after the latest Task's report turn has run: that turn put its result or
      // question to the person, so a later report never asks a question already answered.
      const report = await this.#store.findWorkSessionReport(target.task.id);
      const reportTask = report?.taskId ? await this.#store.findTaskById(report.taskId) : undefined;
      if (
        reportTask === undefined ||
        reportTask.status === "pending" ||
        reportTask.status === "running"
      )
        throw new TagMessagingError(
          409,
          "That work Session's report has not reached this conversation yet; continue it after its report turn",
        );
      const latest = await this.#store.findTaskById(target.task.id);
      const work = latest?.inboundEventId
        ? await this.#store.findInboundEventById(latest.inboundEventId)
        : undefined;
      if (!latest || work?.event.internal?.kind !== "work_session")
        throw new Error(`Work Session ${target.sessionId} has no admitted Task`);
      // Never broader than the work Session ran with, nor than this turn may act.
      if (!samePermissions(work.authorization, starting.authorization))
        throw new TagMessagingError(
          409,
          "This conversation's permissions changed since that work Session last ran, so it cannot continue under them; start a new work Session instead",
        );
      previous = { work, title: target.title };
    }
    if (sessions.filter((session) => startedBy(session) === conversation.id).length >= perTurn)
      throw new TagMessagingError(
        409,
        `This turn already started ${perTurn} work Session Task${perTurn === 1 ? "" : "s"}, the most one turn may start`,
      );
    if (
      sessions.filter(
        (session) => session.task?.status === "running" || session.task?.status === "pending",
      ).length >= WORK_SESSION_MAX_OPEN
    )
      throw new TagMessagingError(
        409,
        `This conversation already has ${WORK_SESSION_MAX_OPEN} unfinished work Sessions; wait for one to finish`,
      );
    // The turn and every work Task it admits share the turn's reported limits.
    const limits = starting.execution.limits;
    const execution =
      limits?.maxReportedTokens === undefined && limits?.maxReportedCost === undefined
        ? starting.execution
        : workSessionExecution(
            starting.execution,
            reportedTurnSpend(
              await this.#store.readSpend({ taskIds: [conversation.id] }),
              starting.execution,
            ),
            (
              await Promise.all(
                sessions
                  .filter((session) => startedBy(session) === conversation.id)
                  .map((session) =>
                    session.task === undefined
                      ? undefined
                      : this.#store.findTaskById(session.task.id),
                  ),
              )
            ).flatMap((task) => (task === undefined ? [] : [task.execution])),
          );
    if (execution === undefined)
      throw new TagMessagingError(
        409,
        `This turn and the work Sessions it started already spent or hold too much of its token and cost limits to ${verb} a useful work Session; finish the work in this turn`,
      );
    const running = sessions.filter((session) => session.task?.status === "running").length;
    // A new work Session edits one of the conversation's Workspaces on its own branch; a continued
    // one keeps the Workspace it started in.
    const workspace =
      "start" in request
        ? await workSessionWorkspace(
            this.#store,
            (await this.describeWorklet().catch(() => undefined))?.host,
            starting,
            request.start.workspace,
          )
        : undefined;
    const at = new Date().toISOString();
    const title = "start" in request ? request.start.title : (previous?.title ?? "");
    const admission = await this.#store.admitInboundEvent({
      surfaceAccountId: starting.surfaceAccountId,
      tagRouteId: starting.tagRouteId,
      tagId: starting.tagId,
      authorization: starting.authorization,
      contextPlan: starting.contextPlan,
      execution,
      event:
        "start" in request
          ? workSessionEvent(
              starting,
              conversation.id,
              conversation.sessionId,
              {
                title: request.start.title,
                instruction: request.start.instruction,
                ...(workspace === undefined ? {} : { workspace }),
              },
              at,
            )
          : continuedWorkSessionEvent(
              previous?.work as DurableInboundEvent,
              starting,
              conversation.id,
              conversation.sessionId,
              title,
              request.continue.message,
              at,
            ),
      maxAttempts: this.#maxAttempts,
    });
    const task = await this.#openTask(admission.work);
    await this.#appendTaskEvent(task.id, "task.admitted", {
      tagRouteId: starting.tagRouteId,
      scope: starting.event.scope,
      startedByTaskId: conversation.id,
      parentSessionId: conversation.sessionId,
      ...("continue" in request ? { continued: true } : {}),
    });
    this.#wakeTaskController?.();
    return {
      sessionId: task.sessionId,
      title,
      status: running >= WORK_SESSION_MAX_RUNNING ? "queued" : "started",
    };
  }

  /**
   * A work Session Task's pending approval request, posted where its conversation turn replies:
   * the work Session itself posts nowhere. The request id is the delivery key, so it posts once,
   * and a Task posts one notice per admitted requirement while its requests are pending.
   */
  async #postWorkSessionApproval(
    task: Task,
    work: DurableInboundEvent,
    requestId: string,
  ): Promise<void> {
    const internal = work.event.internal;
    if (internal?.kind !== "work_session") return;
    const [request, starting] = await Promise.all([
      this.objectives.getApprovalRequest(requestId),
      this.#store.findTaskById(internal.startedByTaskId),
    ]);
    if (request?.taskId !== task.id || !starting?.inboundEventId) return;
    const requirementOf = (candidate: ApprovalRequest) => {
      const action = candidate.actions[0];
      return action === undefined
        ? undefined
        : approvalRequirementFor(task.authorizationSnapshot.approvals, action);
    };
    const requirement = requirementOf(request);
    if (requirement === undefined) return;
    // One notice per admitted requirement while its requests wait: the work Session picks each
    // request's arguments, so a new request for the same action waits on the notice already
    // posted rather than posting another.
    const key = canonicalJson(requirement);
    for (const other of await this.#store.listApprovalRequests({
      taskId: task.id,
      status: "pending",
      limit: 500,
    })) {
      if (other.id === request.id) continue;
      const covered = requirementOf(other);
      if (
        covered !== undefined &&
        canonicalJson(covered) === key &&
        (await this.#store.findOutboundReply(starting.inboundEventId, `approval:${other.id}`))
      )
        return;
    }
    await this.#postNoticeOnce(
      starting.inboundEventId,
      `approval:${request.id}`,
      workSessionApprovalNotice(internal.title, request, requirement),
    );
  }

  /** Posts a status notice on an inbound event's thread once per delivery key. */
  async #postNoticeOnce(inboundEventId: string, deliveryKey: string, text: string): Promise<void> {
    const existing = await this.#store.findOutboundReply(inboundEventId, deliveryKey);
    if (existing) {
      if (existing.text !== text) throw new Error("Report key already used for different content");
      return;
    }
    await this.#store.enqueueOutboundReply({
      inboundEventId,
      workerId: "objective-controller",
      presentation: "status",
      deliveryKey,
      text,
      createdAt: new Date().toISOString(),
    });
    this.#wakeDeliveryController?.();
  }

  /** Admits the report turns that finished work Sessions are still owed. */
  /**
   * Admits the report turns that finished work Sessions are still owed, and continues the work
   * Sessions whose waited-on approval request was decided without continuing them, as after a
   * restart or a failed admission.
   */
  async #reportFinishedWorkSessions(): Promise<void> {
    this.#lastWorkReportSweep = Date.now();
    try {
      for (const taskId of await this.#store.listUnreportedWorkTasks(20))
        await this.#reportWorkSession(taskId);
      for (const taskId of await this.#store.listDecidedWorkSessionWaits(20))
        await this.#oneWorkTaskTurn(taskId, () => this.#continueDecidedWorkSession(taskId));
    } catch (error) {
      this.#reportDispatchError(error);
    }
  }

  /**
   * A finished work Session Task's report turn: a new Task in the conversation Session, under
   * the starting turn's admitted authorization, that replies where that turn replied. Its event
   * id is the delivery key, so a repeat after a restart is a duplicate admission, not a report.
   */
  async #reportWorkSession(workTaskId: string): Promise<void> {
    await this.#oneWorkTaskTurn(workTaskId, async () => {
      await this.#reportWorkSessionNow(workTaskId);
      // A request decided before the Task's outcome was committed continues the Session now.
      await this.#continueDecidedWorkSession(workTaskId);
    });
  }

  /**
   * Runs one work Task's `message_parent` admissions and its report admission one at a time, so
   * a note admitted while the Task runs is queued before its report, and a note that arrives
   * once the Task has finished is dropped.
   */
  async #oneWorkTaskTurn<T>(workTaskId: string, admit: () => Promise<T>): Promise<T> {
    const previous = this.#workTaskTurns.get(workTaskId) ?? Promise.resolve();
    const run = previous.then(admit);
    const settled = run.then(
      () => undefined,
      () => undefined,
    );
    this.#workTaskTurns.set(workTaskId, settled);
    try {
      return await run;
    } finally {
      if (this.#workTaskTurns.get(workTaskId) === settled) this.#workTaskTurns.delete(workTaskId);
    }
  }

  /**
   * `message_parent`: a running work Session Task's note to its conversation, admitted as an
   * update turn there under the starting turn's admitted authorization, replying where that turn
   * replied. Its event id is the delivery key per work Task and sequence, so each note is
   * admitted once, and at most `WORK_SESSION_MAX_UPDATES` per work Task. A note with the same
   * text as one the Task already sent, as a retried Attempt sends, admits nothing.
   */
  async #messageParent(
    task: Task,
    work: DurableInboundEvent,
    text: string,
  ): Promise<{ readonly status: "sent" | "dropped"; readonly next: string }> {
    const internal = work.event.internal;
    if (internal?.kind !== "work_session")
      throw new TagMessagingError(403, "Only a work Session messages its conversation");
    if (!this.#accepting)
      throw new TagMessagingError(503, "The Control Plane is not accepting new work now");
    // A retired Tag takes no more turns.
    if ((await this.#store.findTagById(task.tagId))?.status !== "active")
      throw new TagMessagingError(
        409,
        "This Tag is no longer active, so its conversation takes no update",
      );
    // A note after the Task finished would follow its report; the report already says it all.
    if (
      (await this.#store.findTaskById(task.id))?.status !== "running" ||
      (await this.#store.findWorkSessionReport(task.id)) !== undefined
    )
      return {
        status: "dropped",
        next: "This Task has finished, so the note was not sent; its result reaches the conversation.",
      };
    const startingTask = await this.#store.findTaskById(internal.startedByTaskId);
    const starting = startingTask?.inboundEventId
      ? await this.#store.findInboundEventById(startingTask.inboundEventId)
      : undefined;
    if (!startingTask || !starting)
      throw new Error(`Work Session ${task.sessionId} has no conversation turn to message`);
    const updates = await this.#store.listWorkSessionUpdates(task.id);
    // A retried Attempt redoes the work and sends its notes again; a note this Task already
    // sent is not sent twice, so the person sees it once and the retry keeps its cap.
    for (const update of updates) {
      const sent = (await this.#store.findInboundEventById(update.inboundEventId))?.event.internal;
      if (sent?.kind === "session_update" && sent.text === text)
        return {
          status: "sent",
          next: "This Task already sent this note, so it was not sent again. Keep working; put everything else in your final result.",
        };
    }
    const used = updates.length;
    for (let sequence = used + 1; sequence <= WORK_SESSION_MAX_UPDATES; sequence++) {
      const admission = await this.#store.admitInboundEvent({
        surfaceAccountId: starting.surfaceAccountId,
        tagRouteId: starting.tagRouteId,
        tagId: starting.tagId,
        authorization: starting.authorization,
        contextPlan: starting.contextPlan,
        execution: starting.execution,
        event: sessionUpdateEvent(
          starting,
          {
            startedByTaskId: startingTask.id,
            workSessionId: task.sessionId,
            workTaskId: task.id,
            title: internal.title,
            sequence,
            text,
          },
          new Date().toISOString(),
        ),
        maxAttempts: this.#maxAttempts,
      });
      // Another Control Plane took this sequence; the next one is free.
      if (admission.status === "duplicate") continue;
      const update = await this.#openTask(admission.work);
      await this.#appendTaskEvent(update.id, "task.admitted", {
        tagRouteId: starting.tagRouteId,
        scope: starting.event.scope,
        updatesTaskId: task.id,
        workSessionId: task.sessionId,
        sequence,
      });
      this.#wakeTaskController?.();
      const left = WORK_SESSION_MAX_UPDATES - sequence;
      return {
        status: "sent",
        next: `Keep working. The Tag decides whether to tell the person. ${left === 0 ? "This Task may send no more notes" : `This Task may send ${left} more note${left === 1 ? "" : "s"}`}; put everything else in your final result.`,
      };
    }
    throw new TagMessagingError(
      409,
      `This Task already sent ${WORK_SESSION_MAX_UPDATES} notes with message_parent, the most one Task may send; put the rest in your final result`,
    );
  }

  async #reportWorkSessionNow(workTaskId: string): Promise<void> {
    try {
      const task = await this.#store.findTaskById(workTaskId);
      if (
        !task?.inboundEventId ||
        (task.status !== "completed" && task.status !== "failed" && task.status !== "cancelled")
      )
        return;
      const work = await this.#store.findInboundEventById(task.inboundEventId);
      const internal = work?.event.internal;
      if (!work || internal?.kind !== "work_session") return;
      const startingTask = await this.#store.findTaskById(internal.startedByTaskId);
      const starting = startingTask?.inboundEventId
        ? await this.#store.findInboundEventById(startingTask.inboundEventId)
        : undefined;
      if (!startingTask || !starting)
        throw new Error(`Work Session ${task.sessionId} has no conversation turn to report to`);
      // A retired Tag takes no more turns; its work Session's result stays on the Session.
      if ((await this.#store.findTagById(task.tagId))?.status !== "active") return;
      const final = await this.#store.findOutboundReply(work.id, "final");
      const question = task.status === "completed" ? task.outcome?.["question"] : undefined;
      const approvals =
        task.status === "completed" && Array.isArray(task.outcome?.["approvals"])
          ? task.outcome["approvals"].filter((id): id is string => typeof id === "string")
          : [];
      const basedOn =
        task.workspacePlan.status === "workspace" && internal.continued === true
          ? (await sessionWorkspaceBranches(this.#store, task, task.workspacePlan)).at(-1)?.branch
          : undefined;
      const delivery =
        task.workspacePlan.status === "workspace"
          ? workSessionDelivery(
              task,
              workerEvents(await this.#store.listTaskEvents(task.id)),
              basedOn,
            )
          : undefined;
      const admission = await this.#store.admitInboundEvent({
        surfaceAccountId: starting.surfaceAccountId,
        tagRouteId: starting.tagRouteId,
        tagId: starting.tagId,
        authorization: starting.authorization,
        contextPlan: starting.contextPlan,
        execution: starting.execution,
        event: sessionReportEvent(
          starting,
          {
            startedByTaskId: startingTask.id,
            workSessionId: task.sessionId,
            workTaskId: task.id,
            title: internal.title,
            result: final?.text ?? task.result?.summary ?? "",
            ...(typeof question === "string" || approvals.length > 0
              ? {
                  status: "waiting" as const,
                  ...(typeof question === "string" ? { question } : {}),
                  ...(approvals.length === 0 ? {} : { approvals }),
                }
              : { status: task.status }),
            ...(delivery === undefined ? {} : { delivery }),
          },
          new Date().toISOString(),
        ),
        maxAttempts: this.#maxAttempts,
      });
      if (admission.status === "duplicate") return;
      const report = await this.#openTask(admission.work);
      await this.#appendTaskEvent(report.id, "task.admitted", {
        tagRouteId: starting.tagRouteId,
        scope: starting.event.scope,
        reportsTaskId: task.id,
        workSessionId: task.sessionId,
      });
      this.#wakeTaskController?.();
    } catch (error) {
      this.#reportDispatchError(error);
    }
  }

  /**
   * Continues a work Session whose latest Task completed waiting on approval requests, once one
   * of them is decided: the next Task of that Session, with the decisions as its message. It runs
   * under the waiting Task's admitted authorization only while the Tag's current permissions are
   * the same, as `continue_session` requires, and draws from the waiting Task's share of the
   * starting turn's budget. When either check fails, the conversation is told, and the Task waits
   * on nothing. Its event id is keyed by the waiting Task, so the decision listener, the report
   * path and the sweep continue it once between them. Runs in the waiting Task's turn, after its
   * report admission.
   */
  async #continueDecidedWorkSession(taskId: string): Promise<void> {
    try {
      if (!this.#accepting) return;
      const task = await this.#store.findTaskById(taskId);
      const waitedOn = task?.outcome?.["approvals"];
      if (
        !task?.inboundEventId ||
        task.status !== "completed" ||
        !Array.isArray(waitedOn) ||
        waitedOn.length === 0
      )
        return;
      const work = await this.#store.findInboundEventById(task.inboundEventId);
      const internal = work?.event.internal;
      if (!work || internal?.kind !== "work_session") return;
      if ((await this.#store.listSessionTaskIds(task.sessionId)).at(-1) !== task.id) return;
      // A retired Tag takes no more turns; its work Session stays where it stopped.
      if ((await this.#store.findTagById(task.tagId))?.status !== "active") return;
      const decided = (
        await Promise.all(
          waitedOn
            .filter((id): id is string => typeof id === "string")
            .map((id) => this.objectives.getApprovalRequest(id)),
        )
      ).filter(
        (request): request is ApprovalRequest =>
          request !== undefined &&
          request.taskId === task.id &&
          (request.status === "denied" ||
            (request.status === "approved" && request.consumedAt === null)),
      );
      if (decided.length === 0) return;
      if (
        (await this.#store.listTaskEvents(task.id)).some(
          (event) => event.type === WORK_SESSION_NOT_CONTINUED_EVENT,
        )
      )
        return;
      // The waiting Task's report reaches the conversation before the Session goes on.
      await this.#reportWorkSessionNow(task.id);
      const startingTask = await this.#store.findTaskById(internal.startedByTaskId);
      const starting = startingTask?.inboundEventId
        ? await this.#store.findInboundEventById(startingTask.inboundEventId)
        : undefined;
      if (!startingTask || !starting)
        throw new Error(`Work Session ${task.sessionId} has no conversation turn to report to`);
      // A conversation holds a bounded number of unfinished work Sessions; the sweep continues
      // this one once another finishes.
      const open = (await this.#store.listWorkSessions(internal.parentSessionId)).filter(
        (session) => session.task?.status === "running" || session.task?.status === "pending",
      ).length;
      if (open >= WORK_SESSION_MAX_OPEN) return;
      const stop = async (reason: "permissions" | "budget") => {
        await this.#appendTaskEvent(task.id, WORK_SESSION_NOT_CONTINUED_EVENT, {
          requestIds: decided.map((request) => request.id),
          reason,
        });
        await this.#postNoticeOnce(
          starting.id,
          `approval-continue:${task.id}`,
          workSessionNotContinuedNotice(internal.title, decided, reason),
        );
      };
      // Never broader than the Tag may act now: a decision does not revive revoked permissions.
      const current = await this.#currentAuthorization(starting);
      if (current === undefined || !samePermissions(work.authorization, current)) {
        await stop("permissions");
        return;
      }
      const execution = resumedWorkSessionExecution(
        startingTask.execution,
        work.execution,
        reportedTurnSpend(await this.#store.readSpend({ taskIds: [task.id] }), work.execution),
      );
      if (execution === undefined) {
        await stop("budget");
        return;
      }
      const resumed = continuedWorkSessionEvent(
        work,
        work,
        internal.startedByTaskId,
        internal.parentSessionId,
        internal.title,
        decided.map(approvalDecisionText).join("\n\n"),
        new Date().toISOString(),
      );
      const eventId = workSessionApprovalDeliveryId(task.id);
      const admission = await this.#store.admitInboundEvent({
        surfaceAccountId: work.surfaceAccountId,
        tagRouteId: work.tagRouteId,
        tagId: work.tagId,
        authorization: work.authorization,
        contextPlan: work.contextPlan,
        execution,
        event: { ...resumed, eventId, logicalEventId: eventId },
        maxAttempts: this.#maxAttempts,
      });
      if (admission.status === "duplicate") return;
      const next = await this.#openTask(admission.work);
      await this.#appendTaskEvent(next.id, "task.admitted", {
        tagRouteId: work.tagRouteId,
        scope: work.event.scope,
        startedByTaskId: internal.startedByTaskId,
        parentSessionId: internal.parentSessionId,
        continued: true,
        approvalRequestId: decided[0]?.id,
      });
      this.#wakeTaskController?.();
    } catch (error) {
      this.#reportDispatchError(error);
    }
  }

  /**
   * The authorization an inbound event would be admitted with now, for comparing with the one it
   * was admitted with; undefined when its route, surface account or Tag is gone.
   */
  async #currentAuthorization(
    inbound: DurableInboundEvent,
  ): Promise<TagAuthorizationSnapshot | undefined> {
    const [account, stored, tag] = await Promise.all([
      this.#store.findSurfaceAccountById(inbound.surfaceAccountId),
      this.#store.findTagRouteById(inbound.tagRouteId),
      this.#store.findTagById(inbound.tagId),
    ]);
    if (!account || !tag) return undefined;
    const route =
      stored ??
      (account.provider === "cli" && inbound.tagRouteId === cliTagRoute(tag, account).id
        ? cliTagRoute(tag, account)
        : undefined);
    if (!route) return undefined;
    return this.#captureAuthorization(
      inbound.event,
      account,
      route,
      tag,
      new Date().toISOString(),
      await resolveTagRoles(this.#store, tag.id),
    );
  }

  /** Opens the durable Task for one accepted unit of user intent. */
  async #openTask(work: DurableInboundEvent): Promise<Task> {
    const now = new Date().toISOString();
    const internal = work.event.internal;
    // An internal turn keeps the Workspace plan its starting conversation turn was admitted with.
    const starting = internal
      ? await this.#store.findTaskById(internal.startedByTaskId)
      : undefined;
    if (internal && starting?.tagId !== work.tagId)
      throw new Error(`Task ${internal.startedByTaskId} that started this turn does not exist`);
    // A work Session belongs to its conversation's audience: private to the same person or shared.
    const parent =
      internal?.kind === "work_session"
        ? await this.#store.findSessionById(internal.parentSessionId)
        : undefined;
    if (internal?.kind === "work_session" && parent?.tagId !== work.tagId)
      throw new Error(`Conversation Session ${internal.parentSessionId} does not exist`);
    const audienceActorKey =
      parent !== undefined
        ? parent.audienceActorKey
        : work.event.direct === true
          ? sessionRequesterKey(work.event.provider, work.surfaceAccountId, work.event.actor.id)
          : undefined;
    const session = await this.#store.openSession({
      tagId: work.tagId,
      sessionKey: work.event.sessionKey,
      origin: {
        provider: work.event.provider,
        surfaceAccountId: work.surfaceAccountId,
        scope: work.event.scope,
        threadKey: work.event.callback.threadKey,
        ...(internal?.kind === "work_session"
          ? { title: internal.title, startedByTaskId: internal.startedByTaskId }
          : {}),
      },
      // A direct conversation is private to its one person; the first open fixes the audience.
      ...(audienceActorKey === undefined ? {} : { audienceActorKey }),
      ...(parent === undefined ? {} : { parentSessionId: parent.id }),
      at: now,
    });
    const sessionHistory = (
      await this.#store.listTaskHistory({
        sessionId: session.id,
        tagId: work.tagId,
        limit: MAX_SESSION_HISTORY_TASKS,
      })
    )
      .toReversed()
      .map(boundedTaskHistory);
    const task = await this.#store.openTask({
      inboundEventId: work.id,
      tagId: work.tagId,
      sessionId: session.id,
      execution: work.execution,
      actor: work.event.actor,
      ...(work.event.text === undefined ? {} : { requestText: work.event.text }),
      trigger: {
        kind: work.event.kind,
        inboundEventId: work.id,
        logicalEventId: work.event.logicalEventId,
        source: work.event.source,
        origin: {
          tagRouteId: work.tagRouteId,
          provider: work.event.provider,
          surfaceAccountId: work.surfaceAccountId,
          scope: work.event.scope,
          sessionKey: work.event.sessionKey,
        },
        occurredAt: work.event.occurredAt,
      },
      workspacePlan:
        internal?.kind === "work_session" && internal.workspace !== undefined
          ? await this.#workSessionPlan(work, internal.workspace, session.id)
          : (starting?.workspacePlan ?? captureWorkspacePlan(work.event, work.authorization)),
      sessionHistory,
      authorizationSnapshot: work.authorization,
      contextPlan: work.contextPlan,
      createdAt: work.createdAt,
    });
    return task;
  }

  /**
   * A work Session Task's plan for its Workspace: the plan it was opened with, or a new one on
   * the work Session's next branch, after the branch of the Session's latest Task.
   */
  async #workSessionPlan(
    work: DurableInboundEvent,
    name: string,
    sessionId: string,
  ): Promise<TaskWorkspacePlan> {
    const tasks = await this.#store.listTasks({ tagId: work.tagId, sessionId, limit: 100 });
    const opened = tasks.find((task) => task.inboundEventId === work.id);
    if (opened) return opened.workspacePlan;
    const workspace = await this.#store.findWorkspaceByName(name);
    if (!workspace)
      throw new TagMessagingError(
        409,
        `Workspace ${name} no longer exists; start a new work Session`,
      );
    // Branches are numbered after the latest Task that delivered commits, so one that only
    // asked the person leaves the next name to the Task that does the work. The number follows
    // the branch that Task requested, not a hash-suffixed name its Worker fell back to.
    const delivered = await latestSessionDelivery(this.#store, tasks, { workspace: name });
    const deliveredPlan = tasks.find((task) => task.id === delivered?.taskId)?.workspacePlan;
    return namedWorkspacePlan(
      workspace,
      workSessionBranch(
        sessionId,
        deliveredPlan?.status === "workspace" ? deliveredPlan.branch : delivered?.branch,
      ),
    );
  }

  async #openTaskAttempt(
    work: DurableInboundEvent,
    task: Task,
    durableExecution: boolean,
    placement: import("@supertag/worker-sdk").WorkletExecutionPlacement,
  ): Promise<TaskAttempt> {
    const worklet = await (this.#worklet ? describeWorklet(this.#worklet) : undefined);
    const startedAt = new Date().toISOString();
    const attempt = await this.#store.openSurfaceTaskAttempt({
      inboundEventId: work.id,
      leaseOwner: this.#instanceId,
      now: startedAt,
      taskId: task.id,
      attemptNumber: work.attemptCount,
      workerProfile: placement.workerProfile,
      workerSnapshot: {
        durableExecution,
        ...(!durableExecution
          ? {
              workerHostId: worklet?.host.id ?? "unknown",
              workletId: worklet?.id ?? "unknown",
            }
          : {}),
        placement,
        workerProfile: placement.workerProfile,
        execution: attemptExecutionRecord(
          task.execution,
          worklet?.host.workers.find((worker) => worker.id === placement.workerId),
          placement.workerProfile,
        ),
      },
      startedAt,
    });
    if (work.attemptCount === 1) {
      await this.#appendTaskEvent(task.id, "task.started", {
        tagRouteId: work.tagRouteId,
        scope: work.event.scope,
      });
    }
    await this.#appendTaskEvent(
      task.id,
      "attempt.started",
      { attemptNumber: attempt.attemptNumber },
      attempt.id,
    );
    return attempt;
  }

  /** Task history is observability; it must never fail the dispatch it records. */
  async #appendTaskEvent(
    taskId: string,
    type: string,
    payload: Readonly<Record<string, unknown>>,
    attemptId?: string,
  ): Promise<void> {
    try {
      await this.#store.appendTaskEvent({
        taskId,
        type,
        payload,
        ...(attemptId ? { attemptId } : {}),
      });
    } catch (error) {
      this.#reportDispatchError(error);
    }
  }

  async #reconcileNextDelivery(): Promise<boolean> {
    if (this.#operatorChannel !== undefined) {
      const now = Date.now();
      const dirty = this.#operatorInboxRevision !== this.#scannedOperatorInboxRevision;
      const dirtyDueAt = Math.max(
        this.#operatorInboxChangedAt + 100,
        this.#lastOperatorChannelScan + 1000,
      );
      if (
        !this.#stopping &&
        ((dirty && now >= dirtyDueAt) || now - this.#lastOperatorChannelScan >= 30_000)
      ) {
        const revision = this.#operatorInboxRevision;
        try {
          await this.#operatorChannel.reconcile();
          this.#scannedOperatorInboxRevision = revision;
        } catch (error) {
          this.#reportDispatchError(error);
        } finally {
          this.#lastOperatorChannelScan = Date.now();
        }
      }
      const progressed = await this.#operatorChannel.deliverNext().catch((error) => {
        this.#reportDispatchError(error);
        return false;
      });
      if (progressed) return true;
    }
    if (this.#reply === undefined) {
      return false;
    }
    if (!this.#stopping && Date.now() - this.#lastBudgetNotificationScan >= 1000) {
      this.#lastBudgetNotificationScan = Date.now();
      await this.#objectiveMessages.reconcile().catch((error) => this.#reportDispatchError(error));
      await this.#budgetNotifications
        .reconcile()
        .catch((error) => this.#reportDispatchError(error));
    }
    await this.#store.enqueueUnresolvedSessionInputReplies({
      now: new Date().toISOString(),
      text: "Your message may not have been delivered. The target execution ended without confirming whether it read the message. I will not retry it automatically because it may already be in the saved conversation. Please resend it in a new thread; this thread remains blocked to prevent duplicate execution.",
    });
    const outbound = await this.#store.claimNextOutboundReply(this.#claimInput());
    if (outbound === undefined) {
      return false;
    }
    try {
      const account = await this.#store.findSurfaceAccountById(outbound.surfaceAccountId);
      if (account === undefined) {
        throw new Error(`Surface account ${outbound.surfaceAccountId} no longer exists`);
      }
      if (account.provider === "cli" || sentNowhere(outbound)) {
        // The CLI reads its conversation's replies from the Control Plane, and some replies are
        // only records; nothing is sent.
        const completed = await this.#store.completeOutboundReply({
          outboundReplyId: outbound.id,
          leaseOwner: this.#instanceId,
          revision: outbound.revision,
          deliveredAt: new Date().toISOString(),
        });
        if (!completed) this.#wakeDeliveryController?.();
        return true;
      }
      if (
        outbound.deliveryKey.startsWith("task-budget:") ||
        outbound.deliveryKey.startsWith("objective-budget:") ||
        outbound.deliveryKey.startsWith("objective-limit:")
      ) {
        if (!(await this.#budgetNotifications.mayDeliver(outbound)))
          throw new Error(
            "Operator notification was superseded, resolved, or its destination is no longer verified",
          );
      }
      if (
        outbound.deliveryKey.startsWith("operator-message:") &&
        !(await this.#objectiveMessages.mayDeliver(outbound))
      )
        throw new Error("Operator message was replied to or its notification destination changed");
      const policy = outboundPresentationPolicy(outbound);
      const acknowledgement = policy.useAcknowledgement
        ? await this.#store.findOutboundReply(outbound.inboundEventId, "acknowledgement")
        : undefined;
      if (policy.waitForAcknowledgement && acknowledgement?.externalMessageId === undefined) {
        if (acknowledgement?.status === "failed") {
          throw new Error("Cannot deliver progress because its acknowledgement failed");
        }
        await this.#store.deferOutboundReply({
          outboundReplyId: outbound.id,
          leaseOwner: this.#instanceId,
          availableAt: new Date(Date.now() + 250).toISOString(),
        });
        return true;
      }
      const receipt = await this.#reply(
        outbound.event,
        { kind: outbound.presentation, markdown: outbound.text },
        account,
        acknowledgement?.externalMessageId === undefined ||
          this.#reply.capabilities?.(outbound.event, account).replacement !== true
          ? {}
          : { replaceExternalMessageId: acknowledgement.externalMessageId },
      );
      const completed = await this.#store.completeOutboundReply({
        outboundReplyId: outbound.id,
        leaseOwner: this.#instanceId,
        revision: outbound.revision,
        deliveredAt: new Date().toISOString(),
        ...(receipt?.externalMessageId === undefined
          ? {}
          : { externalMessageId: receipt.externalMessageId }),
      });
      if (!completed) this.#wakeDeliveryController?.();
    } catch (error) {
      await this.#retryOutbound(outbound, error);
      this.#reportDispatchError(error);
    }
    return true;
  }

  #markOperatorInboxChanged(): void {
    if (this.#operatorChannel === undefined) return;
    this.#operatorInboxRevision += 1;
    this.#operatorInboxChangedAt = Date.now();
    this.#wakeDeliveryController?.();
  }

  async #supportsReplyReplacement(work: DurableInboundEvent): Promise<boolean> {
    if (this.#reply?.capabilities === undefined) return false;
    const account = await this.#store.findSurfaceAccountById(work.surfaceAccountId);
    return account === undefined
      ? false
      : this.#reply.capabilities(work.event, account).replacement;
  }

  #claimInput() {
    const now = new Date();
    return {
      leaseOwner: this.#instanceId,
      now: now.toISOString(),
      leaseExpiresAt: new Date(now.getTime() + this.#leaseDurationMs).toISOString(),
    };
  }

  async #captureAuthorization(
    event: InboundSurfaceEvent,
    originAccount: SurfaceAccount,
    route: TagRoute,
    tag: Tag,
    capturedAt: string,
    roles: ResolvedTagRoles,
  ): Promise<TagAuthorizationSnapshot> {
    const activations = await this.#store.listTagPermissionActivations({
      tagRouteId: route.id,
    });

    const permissionBundle = await capturePermissionBundle(this.#store, [
      ...activations.map((activation) => activation.permissionSetId),
      ...roles.permissionSetIds,
    ]);

    const resources = new Map<string, MutableAuthorizationResource>();
    const origin = authorizationResource(
      originAccount,
      route.scope,
      ["event:receive", "thread:read", "thread:reply"],
      "origin",
      sourceReference(event, originAccount.provider),
    );
    resources.set(resourceKey(origin.surfaceAccountId, origin.scope), origin);

    for (const permission of permissionBundle.resources) {
      const key = resourceKey(permission.surfaceAccountId, permission.scope);
      const existing = resources.get(key);
      if (existing === undefined) {
        resources.set(key, {
          surfaceAccountId: permission.surfaceAccountId,
          provider: permission.provider,
          scope: permission.scope,
          ...(permission.reference === undefined ? {} : { reference: permission.reference }),
          actions: new Set(permission.actions),
          sources: new Set(["permission-set"]),
        });
      } else {
        for (const action of permission.actions) existing.actions.add(action);
        existing.sources.add("permission-set");
        if (existing.reference === undefined && permission.reference !== undefined) {
          existing.reference = permission.reference;
        }
      }
    }

    return {
      version: 5,
      capturedAt,
      tag: { id: tag.id, name: tag.name },
      origin: {
        tagRouteId: route.id,
        surfaceAccountId: originAccount.id,
        provider: originAccount.provider,
        scope: route.scope,
      },
      requester: event.actor,
      permissionSets: permissionBundle.permissionSets,
      roles: roles.snapshots,
      resources: [...resources.values()].map(freezeAuthorizationResource),
      runtimeActions: permissionBundle.runtimeActions,
      ...(permissionBundle.mcp === undefined ? {} : { mcp: permissionBundle.mcp }),
      ...(permissionBundle.approvals === undefined
        ? {}
        : { approvals: permissionBundle.approvals }),
    };
  }

  async #captureContextPlan(
    event: InboundSurfaceEvent,
    account: SurfaceAccount,
    route: TagRoute,
    capturedAt: string,
    roles: ResolvedTagRoles,
  ): Promise<TagContextPlan> {
    const requestReferences = taskReferencesFromOrigin(event, account.id);
    const activations = await this.#store.listTagContextActivations({
      tagRouteId: route.id,
    });
    const setIds = [
      ...new Set([
        ...activations.map((activation) => activation.contextSetId),
        ...roles.contextSetIds,
      ]),
    ];
    const sets = (await Promise.all(setIds.map((id) => this.#store.findTagContextSetById(id))))
      .filter((set): set is TagContextSet => set !== undefined)
      .sort(
        (left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id),
      );
    const itemsBySet = await Promise.all(
      sets.map((set) => this.#store.listTagContextItems({ contextSetId: set.id })),
    );
    const planSets = await Promise.all(
      sets.map(async (set, index) => ({
        id: set.id,
        name: set.name,
        items: await Promise.all(
          (itemsBySet[index] ?? []).map(async (item): Promise<TagContextPlanItem> => {
            if (item.type === ARTIFACT_CONTEXT_TYPE && item.version === 1) {
              const config = item.config as TagArtifactContextConfig;
              const sourceRoute = await this.#store.findTagRouteById(config.sourceRouteId);
              if (sourceRoute === undefined) {
                throw new Error(
                  `Artifact selection ${item.itemKey} references an unavailable source route`,
                );
              }
              const sourceAccount = await this.#store.findSurfaceAccountById(
                sourceRoute.surfaceAccountId,
              );
              if (sourceAccount === undefined) {
                throw new Error(
                  `Artifact selection ${item.itemKey} references a disconnected source account`,
                );
              }
              const artifacts = await this.#resolveSharedArtifacts(
                item,
                sourceRoute,
                sourceAccount,
                route.tagId,
                requestReferences,
                event.sessionKey,
                capturedAt,
              );
              return {
                id: item.id,
                itemKey: item.itemKey,
                type: item.type,
                version: item.version,
                required: item.required,
                config: item.config,
                snapshot: {
                  source: {
                    tagRouteId: sourceRoute.id,
                    surfaceAccountId: sourceAccount.id,
                    provider: sourceAccount.provider,
                    scope: sourceRoute.scope,
                  },
                  artifacts,
                } satisfies TagArtifactContextSnapshot,
              };
            }
            return {
              id: item.id,
              itemKey: item.itemKey,
              type: item.type,
              version: item.version,
              required: item.required,
              config: item.config,
            };
          }),
        ),
      })),
    );
    const artifactCount = planSets
      .flatMap((set) => set.items)
      .reduce(
        (count, item) =>
          count +
          (item.type === ARTIFACT_CONTEXT_TYPE
            ? ((item.snapshot as TagArtifactContextSnapshot | undefined)?.artifacts.length ?? 0)
            : 0),
        0,
      );
    if (artifactCount > MAX_ARTIFACTS_PER_PLAN) {
      throw new Error(
        `Context Plan selects ${artifactCount} artifacts; narrow it to ${MAX_ARTIFACTS_PER_PLAN}`,
      );
    }
    return {
      version: 7,
      capturedAt,
      sets: planSets,
    };
  }

  async #resolveSharedArtifacts(
    item: TagContextItem,
    sourceRoute: TagRoute,
    sourceAccount: SurfaceAccount,
    tagId: string,
    requestReferences: readonly TaskReference[],
    currentSessionKey: string,
    capturedAt: string,
  ): Promise<readonly CapturedArtifactSummary[]> {
    const config = item.config as TagArtifactContextConfig;
    const matchable = requestReferences.filter(
      (reference) =>
        reference.resourceType === "channel" ||
        reference.resourceType === "repository" ||
        reference.resourceType === "issue" ||
        reference.resourceType === "pull-request" ||
        reference.resourceType === "file" ||
        reference.resourceType === "project",
    );
    if (matchable.length === 0) return [];
    const createdAfter = new Date(
      Date.parse(capturedAt) - config.selection.maxAgeDays * 24 * 60 * 60 * 1_000,
    ).toISOString();
    if (sourceRoute.tagId !== tagId) return [];
    const page = await this.#store.listCapturedArtifacts({
      source: {
        tagId,
        tagRouteId: sourceRoute.id,
        provider: sourceAccount.provider,
        surfaceAccountId: sourceAccount.id,
        scope: sourceRoute.scope,
        excludeSessionKey: currentSessionKey,
        completedAfter: createdAfter,
        relatedTo: matchable,
      },
      newestFirst: true,
      limit: config.selection.limit,
    });
    return page.artifacts.map(
      ({ entries, operationId: _operation, inputs: _inputs, summary, ...artifact }) => ({
        ...artifact,
        ...(summary === undefined ? {} : { summary: summary.slice(0, 512) }),
        entryCount: entries.length,
        sizeBytes: entries.reduce((total, entry) => total + entry.sizeBytes, 0),
      }),
    );
  }

  async #enqueuePresentation(
    work: DurableInboundEvent,
    presentation: {
      readonly workerId: string;
      readonly presentation: "acknowledgement" | "error" | "final-result" | "status";
      readonly deliveryKey: string;
      readonly text: string;
    },
  ): Promise<void> {
    await this.#store.enqueueOutboundReply({
      inboundEventId: work.id,
      ...presentation,
      createdAt: new Date().toISOString(),
    });
  }

  async #retryOutbound(outbound: OutboundReply, error: unknown): Promise<void> {
    const now = new Date();
    await this.#store.retryOutboundReply({
      outboundReplyId: outbound.id,
      leaseOwner: this.#instanceId,
      error: errorMessage(error),
      retryAt: new Date(now.getTime() + this.#retryDelay(outbound.attemptCount)).toISOString(),
      failedAt: now.toISOString(),
    });
  }

  #retryDelay(attemptCount: number): number {
    return this.#retryBaseMs * 2 ** Math.max(0, attemptCount - 1);
  }

  async #waitForDispatch(kind: "inbound" | "outbound"): Promise<void> {
    await new Promise<void>((resolve) => {
      const now = Date.now();
      const notificationWait =
        kind === "outbound" && this.#operatorChannel !== undefined && !this.#stopping
          ? Math.max(
              1,
              Math.min(
                30_000 - (now - this.#lastOperatorChannelScan),
                this.#operatorInboxRevision === this.#scannedOperatorInboxRevision
                  ? Number.POSITIVE_INFINITY
                  : Math.max(
                      this.#operatorInboxChangedAt + 100,
                      this.#lastOperatorChannelScan + 1000,
                    ) - now,
              ),
            )
          : Number.POSITIVE_INFINITY;
      const timeout = setTimeout(
        () => {
          if (kind === "inbound") this.#wakeTaskController = undefined;
          else this.#wakeDeliveryController = undefined;
          resolve();
        },
        Math.min(
          notificationWait,
          this.#dispatchFailures[kind] === 0
            ? this.#pollIntervalMs
            : Math.max(
                this.#pollIntervalMs,
                Math.min(5000, 250 * 2 ** Math.min(5, this.#dispatchFailures[kind] - 1)),
              ),
        ),
      );
      const wake = () => {
        clearTimeout(timeout);
        if (kind === "inbound") this.#wakeTaskController = undefined;
        else this.#wakeDeliveryController = undefined;
        resolve();
      };
      if (kind === "inbound") this.#wakeTaskController = wake;
      else this.#wakeDeliveryController = wake;
    });
  }

  async #waitForAdmissions(): Promise<void> {
    if (this.#activeAdmissions === 0) {
      return;
    }
    await new Promise<void>((resolve) => {
      this.#admissionsDrained = resolve;
    });
  }

  #reportDispatchError(error: unknown): void {
    this.#dispatchErrors.report(error);
  }

  /** Reports an audit recording failure; a reporter that throws too is ignored. */
  #reportAuditError(error: unknown): void {
    try {
      this.#reportDispatchError(error);
    } catch {
      // Nothing is left to report to.
    }
  }
}

function executionPlacementSnapshot(snapshot: Record<string, unknown>):
  | {
      readonly workerHostId: string;
      readonly workletId: string;
      readonly workerId: string;
      readonly reservation?: { readonly id: string; readonly expiresAt: string };
    }
  | undefined {
  const value = snapshot["placement"];
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const placement = value as Record<string, unknown>;
  return typeof placement["workerHostId"] === "string" &&
    typeof placement["workletId"] === "string" &&
    typeof placement["workerId"] === "string"
    ? {
        workerHostId: placement["workerHostId"],
        workletId: placement["workletId"],
        workerId: placement["workerId"],
        ...executionReservationSnapshot(placement["reservation"]),
      }
    : undefined;
}

function executionReservationSnapshot(value: unknown): {
  readonly reservation?: { readonly id: string; readonly expiresAt: string };
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const reservation = value as Record<string, unknown>;
  return typeof reservation["id"] === "string" && typeof reservation["expiresAt"] === "string"
    ? { reservation: { id: reservation["id"], expiresAt: reservation["expiresAt"] } }
    : {};
}

function positiveDuration(value: number | undefined, fallback: number, name: string): number {
  const selected = value ?? fallback;
  if (!Number.isFinite(selected) || selected <= 0) {
    throw new Error(`Control Plane dispatch ${name} must be greater than zero`);
  }
  return selected;
}

function captureWorkspacePlan(
  event: InboundSurfaceEvent,
  authorization: TagAuthorizationSnapshot,
): TaskWorkspacePlan {
  const choices = authorization.resources
    .filter(
      (resource) =>
        resource.provider === "github" &&
        resource.scope.startsWith("repository:") &&
        resource.actions.includes("contents:read"),
    )
    .map((resource) => ({
      provider: resource.provider,
      surfaceAccountId: resource.surfaceAccountId,
      scope: resource.scope,
      ...(resource.reference === undefined ? {} : { reference: resource.reference }),
      actions: resource.actions,
    }))
    .sort((left, right) =>
      (left.reference ?? left.scope).localeCompare(right.reference ?? right.scope),
    );
  const mentioned = repositoryReferences(event.text ?? "");
  if (choices.length === 0) {
    // Only a reference that must be a repository refuses; a mentioned path is ordinary text.
    const requested = mentioned.filter(unambiguousRepositoryReference);
    return requested.length === 0
      ? { version: 1, status: "none" }
      : { version: 1, status: "unavailable", requested };
  }
  // A request is a reference to one of the Tag's repositories, or one that must be a repository;
  // a mention that may be a path, such as src/index.ts, is ordinary text.
  const requested = mentioned.filter(
    (reference) =>
      unambiguousRepositoryReference(reference) ||
      choices.some((choice) => choice.reference?.toLowerCase() === reference),
  );

  if (event.provider === "github") {
    const origin = choices.find(
      (choice) =>
        choice.surfaceAccountId === authorization.origin.surfaceAccountId &&
        choice.scope === authorization.origin.scope,
    );
    if (origin !== undefined) {
      return { version: 1, status: "selected", selectedBy: "origin", target: origin };
    }
  }

  if (requested.length > 0) {
    const selected = choices.find(
      (choice) =>
        choice.reference !== undefined &&
        requested.some((reference) => reference === choice.reference?.toLowerCase()),
    );
    if (selected !== undefined) {
      return { version: 1, status: "selected", selectedBy: "request", target: selected };
    }
    return { version: 1, status: "selection-required", choices };
  }

  const onlyChoice = choices[0];
  if (choices.length === 1 && onlyChoice !== undefined) {
    return { version: 1, status: "selected", selectedBy: "default", target: onlyChoice };
  }
  return { version: 1, status: "selection-required", choices };
}

function acknowledgementText(task: Task): string {
  const workspace = taskWorkspaceLabel(task.workspacePlan);
  return workspace === undefined
    ? "Got it. I’m looking into this now."
    : `Got it. I’m looking into this in ${workspace} now.`;
}

function taskProgressText(
  progress: Extract<WorkerTaskAttemptEvent, { readonly type: "progress.updated" }>["progress"],
): string {
  const items = progress.items ?? [];
  if (items.length === 0) return progress.summary;
  return [
    progress.summary,
    "",
    ...items.map((item) => {
      const marker =
        item.status === "completed"
          ? "✓"
          : item.status === "active"
            ? "•"
            : item.status === "blocked"
              ? "!"
              : "○";
      return `${marker} ${item.text}`;
    }),
  ].join("\n");
}

function finalResultText(response: string, result: TaskResult): string {
  const changedReferences = result.references
    .filter(
      (reference) =>
        reference.relationship === "changed" && /^https?:\/\//iu.test(reference.reference),
    )
    .map((reference) => reference.reference)
    .filter((reference) => !response.includes(reference));
  const changed =
    changedReferences.length === 0
      ? ""
      : `\n\nChanged: ${changedReferences.map((reference) => `[${reference}](${reference})`).join(", ")}`;
  return `${response.trim()}${changed}`;
}

function failureText(error: unknown): string {
  const message = errorMessage(error).replace(/\s+/g, " ").slice(0, 500);
  return `I ran into a problem while working on this: ${message}`;
}

function taskWorkspaceLabel(plan: TaskWorkspacePlan): string | undefined {
  if (plan.status === "selected") return plan.target.reference ?? plan.target.scope;
  if (plan.status === "selection-required") return "a repository awaiting selection";
  if (plan.status === "unavailable") return plan.requested.join(", ");
  if (plan.status === "workspace") return `Workspace ${plan.workspace} (branch ${plan.branch})`;
  return undefined;
}

/**
 * The route of a Tag's CLI conversations. Not a stored TagRoute, so nothing can activate on it and
 * it is never a location.
 */
function cliTagRoute(tag: Tag, account: SurfaceAccount): TagRoute {
  return {
    id: `cli:${tag.id}`,
    tagId: tag.id,
    surfaceAccountId: account.id,
    scope: "cli",
    enabled: true,
    workspaces: [],
    createdAt: tag.createdAt,
    updatedAt: tag.updatedAt,
  };
}

function authorizationResource(
  account: SurfaceAccount,
  scope: string,
  actions: readonly string[],
  source: "origin" | "permission-set",
  reference?: string,
): MutableAuthorizationResource {
  return {
    surfaceAccountId: account.id,
    provider: account.provider,
    scope,
    ...(reference === undefined ? {} : { reference }),
    actions: new Set(actions),
    sources: new Set([source]),
  };
}

function freezeAuthorizationResource(
  resource: MutableAuthorizationResource,
): TagAuthorizationResource {
  return {
    surfaceAccountId: resource.surfaceAccountId,
    provider: resource.provider,
    scope: resource.scope,
    ...(resource.reference === undefined ? {} : { reference: resource.reference }),
    actions: [...resource.actions].sort(),
    sources: [...resource.sources].sort(),
  };
}

function sourceReference(
  event: InboundSurfaceEvent,
  provider: SurfaceAccount["provider"],
): string | undefined {
  if (provider !== "github") return undefined;
  const candidate = event.source["repository"];
  return typeof candidate === "string" && candidate.trim().length > 0
    ? candidate.trim()
    : undefined;
}

function resourceKey(surfaceAccountId: string, scope: string): string {
  return `${surfaceAccountId}\u0000${scope}`;
}

function workerHostToken(): string {
  return randomBytes(WORKER_HOST_CREDENTIAL_BYTES).toString("base64url");
}

function workerHostCredentialId(workerHostId: string, revision: number): string {
  const encodedId = Buffer.from(workerHostId, "utf8").toString("base64url");
  const issuanceId = randomUUID().replaceAll("-", "");
  return `control-plane/worker-host/${encodedId}/credential/${revision}/${issuanceId}`;
}

function workerHostCredentialDigest(token: string): Readonly<Record<string, string>> {
  return {
    algorithm: WORKER_HOST_CREDENTIAL_ALGORITHM,
    digest: createHash(WORKER_HOST_CREDENTIAL_ALGORITHM).update(token).digest("hex"),
  };
}

function workerHostCredentialMatches(
  token: string,
  credential: Readonly<Record<string, string>> | undefined,
): boolean {
  if (
    credential?.["algorithm"] !== WORKER_HOST_CREDENTIAL_ALGORITHM ||
    typeof credential["digest"] !== "string" ||
    !/^[a-f0-9]{64}$/u.test(credential["digest"])
  )
    return false;
  const presented = createHash(WORKER_HOST_CREDENTIAL_ALGORITHM).update(token).digest();
  const expected = Buffer.from(credential["digest"], "hex");
  return expected.length === presented.length && timingSafeEqual(presented, expected);
}

/** SHA-256 of an Auth Key or Operator Token secret; only this digest is stored. */
function storedSecretDigest(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

function authKeyRedemptionError(
  reason: "invalid" | "expired" | "revoked" | "used" | "tag-missing",
): AuthKeyRedemptionError {
  switch (reason) {
    case "invalid":
      return new AuthKeyRedemptionError(401, reason, "Auth Key is invalid");
    case "expired":
      return new AuthKeyRedemptionError(403, reason, "Auth Key has expired; ask for a new key");
    case "revoked":
      return new AuthKeyRedemptionError(403, reason, "Auth Key was revoked; ask for a new key");
    case "used":
      return new AuthKeyRedemptionError(
        403,
        reason,
        "Auth Key was already used; a one-off key joins one Worker Host",
      );
    case "tag-missing":
      return new AuthKeyRedemptionError(
        409,
        reason,
        "Auth Key names a Tag that was deleted or no longer exists; ask for a new key",
      );
  }
}

/** The Worker Host recorded for an Attempt: the confirmed receipt, else the selected placement. */
function attemptWorkerHostId(attempt: TaskAttempt): string | undefined {
  const snapshot = attempt.workerSnapshot;
  if (typeof snapshot["workerHostId"] === "string") return snapshot["workerHostId"];
  const placement = snapshot["placement"];
  if (
    typeof placement === "object" &&
    placement !== null &&
    !Array.isArray(placement) &&
    typeof (placement as Record<string, unknown>)["workerHostId"] === "string"
  )
    return (placement as Record<string, string>)["workerHostId"];
  return undefined;
}

function disconnectWorkerHost(worklet: Worklet | undefined, workerHostId: string, reason?: string) {
  if (
    worklet !== undefined &&
    "disconnectHost" in worklet &&
    typeof worklet.disconnectHost === "function"
  )
    worklet.disconnectHost(workerHostId, reason);
}

function requiredText(value: string, name: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${name} must not be empty`);
  return normalized;
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  const selected = value ?? fallback;
  if (!Number.isInteger(selected) || selected <= 0) {
    throw new Error(`Control Plane dispatch ${name} must be a positive integer`);
  }
  return selected;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function externalWriteFailure(error: unknown, events: readonly WorkerTaskAttemptEvent[]): unknown {
  const started = events.findLast(
    (event): event is Extract<WorkerTaskAttemptEvent, { readonly type: "tool.call.started" }> =>
      event.type === "tool.call.started" && event.call.effect === "write",
  );
  if (started === undefined) return error;
  return new ExternalActionReconciliationError(
    started.call.provider,
    started.call.operation,
    errorMessage(error),
  );
}

/**
 * Conversation and report turns may use each Worker's coordination slot, one beyond its
 * maxConcurrency, so running work Sessions never leave the conversation without a Worker. Work
 * Session Tasks use ordinary slots only.
 */
function conversationSlot(work: DurableInboundEvent): boolean {
  return work.event.internal?.kind !== "work_session";
}

class ExternalActionReconciliationError extends Error {
  constructor(provider: string, operation: string, failure: string) {
    super(
      `External action ${provider}.${operation} started before execution failed. Automatic retry is disabled because the action may have completed; reconcile it before retrying. Original failure: ${failure}`,
    );
    this.name = "ExternalActionReconciliationError";
  }
}

class AssignmentLeaseLostError extends Error {
  constructor(inboundEventId: string) {
    super(`Assignment lease for inbound event ${inboundEventId} was lost`);
    this.name = "AssignmentLeaseLostError";
  }
}

function isSchedulableWorklet(worker: Worklet): worker is SchedulableWorklet {
  return (
    "canExecute" in worker &&
    typeof worker.canExecute === "function" &&
    "listWorkerHosts" in worker &&
    typeof worker.listWorkerHosts === "function"
  );
}

function executionWorkerId(events: readonly WorkerTaskAttemptEvent[]): string | undefined {
  return events.find(
    (event): event is Extract<WorkerTaskAttemptEvent, { readonly type: "execution.started" }> =>
      event.type === "execution.started",
  )?.workerId;
}

export { ArtifactCatalog } from "./artifact-catalog.js";
export { controlPlaneEventLoopLag } from "./event-loop-lag.js";
export { TagMailboxService, type TeamLiveDeliveryStarter } from "./mailbox.js";

export {
  type CoordinationOperatorPrincipal,
  ObjectiveController,
  OWNER_RESULT_GUIDANCE,
  OWNER_STATEMENT_GUIDANCE,
  STATEMENT_ITEMS_GUIDANCE,
  TASK_TITLE_GUIDANCE,
} from "./objective-controller.js";
export {
  objectiveRuntimeActionWarnings,
  resolveObjectiveRuntimeActions,
} from "./objective-runnable.js";
export {
  configuredOperatorChannel,
  formatOperatorNotification,
  type NotificationDestination,
  type NotificationDestinationResolver,
  OPERATOR_CHANNEL_WINDOW_MS,
  OperatorChannelNotifications,
  type OperatorNotificationSender,
  objectiveThreadCarries,
  parseNotificationDestination,
  parseOperatorChannel,
} from "./operator-channel.js";
export {
  resolveOwnerObjectiveRuntimeActions,
  tagExecutionRange,
  tagRuntimeActions,
} from "./roles.js";
export { SessionPersistence } from "./session-persistence.js";
export {
  type TaskAttemptRunningCommand,
  taskAttemptReportedCost,
  taskAttemptRunningCommand,
  taskAttemptWarnings,
  taskExecutionPlacementReport,
} from "./task-execution-report.js";
export {
  PermanentPullRequestError,
  WORKSPACE_PULL_REQUEST_RETRY,
  type WorkspacePullRequestHandler,
  type WorkspacePullRequestTarget,
} from "./workspace-pull-requests.js";
