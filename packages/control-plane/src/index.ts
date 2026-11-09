export { explainHarnessSignIn } from "./harness-signin.js";

import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import {
  coordinationInboxOccurrence,
  type DeliveryFrom,
  type DeliveryReason,
  INBOX_MAX_HOPS,
  INBOX_SENDS_PER_TASK,
  inboxDeliveryId,
  inboxSessionKey,
  isInboxSessionKey,
  namedWorkspacePlan,
  type Objective,
  objectiveClosed,
  objectiveIdleDeliveryId,
  objectiveIdOfSessionKey,
  objectiveMessageDeliveryId,
  objectiveNoticeDeliveryId,
  objectiveSessionKey,
  objectiveStartDeliveryId,
  type TagMessage,
  workspaceBranchHeadPin,
  workspaceBranchPin,
} from "@supertag/core";
import {
  approvalDecisionText,
  workSessionApprovalNotice,
  workSessionNotContinuedNotice,
} from "./approvals.js";
import {
  type BudgetPool,
  limitsSpend,
  objectivePool,
  type PoolSpend,
  poolExecution,
  poolRemainderExecution,
  poolSpend,
  turnPool,
} from "./budget-pool.js";
import { isSchedulingEvent } from "./capacity-wait.js";
import { DispatchErrorReporter } from "./dispatch-errors.js";
import {
  idleAction,
  inboxTurnText,
  type ObjectiveLocation,
  objectiveAuthorization,
  objectiveBlockedText,
  objectiveHome,
  objectiveTurnText,
} from "./objective-sessions.js";
import { repositoryReferences, unambiguousRepositoryReference } from "./repository-references.js";
import { sessionBranchPin, workerEvents } from "./session-branch.js";
import type {
  DelegatedStartRequest,
  MessageObjectiveInput,
  MessageObjectiveResult,
  SendMessageInput,
  SendMessageResult,
  SessionHandlers,
  StartSessionResult,
} from "./session-handlers.js";
import { SESSION_INPUT_COMMAND_PREFIX, withdrawSessionInput } from "./session-input-withdrawal.js";
import { conversationViewer, tagPortfolio } from "./tag-sessions.js";
import {
  type ContinueSessionRequest,
  continuedWorkSessionEvent,
  type InternalTurnContext,
  internalTurnMessages,
  samePermissions,
  sessionReportEvent,
  WORK_SESSION_ASKED_EVENT,
  workSessionBranch,
  workSessionDelivery,
  workSessionEvent,
  workSessionsPerTurn,
  workSessionWorkspace,
} from "./work-sessions.js";

export type {
  ObjectiveConversationMessage,
  ObjectiveOverview,
  ObjectiveOverviewInput,
} from "./objective-overview.js";
export type { MessageObjectiveResult } from "./session-handlers.js";

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
  CANCELLATION_CLEANUP_BLOCK_REASON,
  canonicalJson,
  EXECUTION_UNCONFIRMED_BLOCK_REASON,
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
  SESSION_NOT_CONTINUED_EVENT,
  sessionApprovalDeliveryId,
  sessionRequesterKey,
  TagMessagingError,
  type TaskFailureKind,
  WORK_SESSION_MAX_OPEN,
  WORK_SESSION_MAX_RUNNING,
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
import { ChangeNotifications } from "./change-notifications.js";
import { cliConversationKey } from "./conversations.js";
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
} from "./operator-channel.js";
import {
  objectiveReportKey,
  outboundPresentationPolicy,
  sentNowhere,
} from "./outbound-presentation.js";
import { detectOverlapWarnings } from "./overlap-warnings.js";
import { type ReplyStreamPart, ReplyStreams } from "./reply-streams.js";
import {
  captureInternalRoleContextPlan,
  capturePermissionBundle,
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

/**
 * How often the task controller sweeps Sessions: reports owed, decided approvals, idle
 * Objectives, undelivered Mailbox messages and the Objective controller's own sweep.
 */
const SESSION_SWEEP_INTERVAL_MS = 10_000;
/** How many items of each kind one Session sweep handles. */
const SESSION_SWEEP_BATCH = 20;
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
  /**
   * Where change notices for operators' watch streams go. The store given as `store` publishes
   * them when it was wrapped with `observeStoreChanges`; defaults to notices nothing publishes.
   */
  readonly changes?: ChangeNotifications;
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
  /** Work Session and delivered turns running beside the task controller loop. */
  readonly #backgroundRuns = new Set<Promise<void>>();
  readonly #workSessionStarts = new Map<string, Promise<void>>();
  /** Per Task: its approval notice, continuation and report admission run one at a time. */
  readonly #workTaskTurns = new Map<string, Promise<void>>();
  /** Per Tag: Mailbox deliveries and inbox admissions run one at a time. */
  readonly #inboxDeliveries = new Map<string, Promise<void>>();
  /** Objective notice keys this process already admitted; admission also deduplicates them. */
  readonly #deliveredNotices = new Set<string>();
  readonly #operatorNotificationTaskId: string | undefined;
  #sweeping: Promise<void> | undefined;
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
  readonly #operatorChannel: OperatorChannelNotifications | undefined;
  #lastBudgetNotificationScan = 0;
  #lastSessionSweep = 0;
  #blockedSessionCursor: string | undefined;
  #lastOperatorChannelScan = 0;
  #operatorInboxRevision = 0;
  #scannedOperatorInboxRevision = -1;
  #operatorInboxChangedAt = 0;
  readonly #executionAffinity = new ExecutionAffinityCache();
  #activeAdmissions = 0;
  #admissionsDrained: (() => void) | undefined;
  #ephemeralSweepTimer: NodeJS.Timeout | undefined;
  readonly #audit: (entry: RecordAuditEntryInput) => unknown;
  /** Change notices for operators' watch streams. */
  readonly changes: ChangeNotifications;

  constructor(dependencies: ControlPlaneDependencies) {
    this.changes = dependencies.changes ?? new ChangeNotifications();
    if ((dependencies.worklet === undefined) !== (dependencies.reply === undefined)) {
      throw new Error("Control Plane Worklet and reply handler must be configured together");
    }
    this.#dispatchErrors = new DispatchErrorReporter(dependencies.dispatch?.onDispatchError);
    this.#instanceId = dependencies.dispatch?.instanceId ?? randomUUID();
    this.objectives = new ObjectiveController(
      dependencies.store,
      dependencies.worklet,
      (error) => this.#reportDispatchError(error),
      {
        systemWake: () => readSystemWake(),
        surfaceLeaseOwner: this.#instanceId,
        surfaceAttemptsRunning: () => this.#activeTaskControllers.size > 0,
      },
    );
    this.objectives.setWorkspacePullRequestHandler(dependencies.pullRequests);
    this.#store = dependencies.store;
    this.#operatorNotificationTaskId = dependencies.operatorNotificationTaskId;
    this.#audit = dependencies.audit ?? ((entry) => dependencies.store.recordAuditEntry(entry));
    this.#budgetNotifications = new BudgetNotifications(
      dependencies.store,
      dependencies.operatorNotificationTaskId,
      dependencies.reply !== undefined,
    );
    this.objectives.setInboxEnricher(async (page) => {
      const enriched = await this.#budgetNotifications.enrich(page);
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
            return item.notification
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
    const handlers: SessionHandlers = {
      start: (task, inbound, request) => this.#startWorkSession(task, inbound, { start: request }),
      continue: (task, inbound, request) =>
        this.#startWorkSession(task, inbound, { continue: request }),
      approvalNotice: (task, inbound, requestId) =>
        this.#oneWorkTaskTurn(task.id, () => this.#postSessionApproval(task, inbound, requestId)),
      approvalDecided: (request) =>
        this.#oneWorkTaskTurn(request.taskId, () => this.#continueDecidedSession(request.taskId)),
      startObjective: (objectiveId) => this.startObjective(objectiveId),
      messageObjective: (input) => this.messageObjective(input),
      sendMessage: (task, input) => this.#sendMessage(task, input),
      deliverObjectiveNotice: (objectiveId, key, text, reason) =>
        this.#notifyObjective({ objectiveId, key, text, ...(reason ? { reason } : {}) }),
      postObjectiveNotice: (objectiveId, key, text) =>
        this.#postObjectiveNotice(objectiveId, key, text),
      cancelObjectiveTasks: (objectiveId, reason, exceptTaskId) =>
        this.#cancelObjectiveTasks(objectiveId, reason, exceptTaskId),
    };
    this.objectives.setSessionHandlers(handlers);
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
        activeAttempts: this.#activeTaskControllers.size,
        capacity,
        availableSlots: Math.max(0, capacity - this.#activeTaskControllers.size),
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
          (objectiveId, key, text) => this.#notifyObjective({ objectiveId, key, text }),
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
    /** The operator who asked; recorded on the Task's cancellation request. */
    principal?: CoordinationOperatorPrincipal,
    /** Why SuperTag cancels it, such as its Objective's cancellation. */
    reason?: string,
  ): Promise<{ readonly accepted: boolean; readonly task: Task }> {
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
      await this.#appendTaskEvent(task.id, "task.cancellation-requested", {
        ...(principal === undefined ? {} : { operatorId: principal.operatorId }),
        ...(reason === undefined ? {} : { reason }),
      });
      await this.#appendTaskEvent(task.id, "task.cancelled", { reason: "operator-request" });
      if (task.inboundEventId !== null)
        await this.#finishReplyStream(task.id, task.inboundEventId, "cancelled");
      // A cancelled work Session closes its draft pull request, as a settled Attempt's does.
      await this.objectives
        .settleWorkspacePullRequest(cancelled)
        .catch((error: unknown) => this.#reportDispatchError(error));
      await this.#reportWorkSession(task.id);
      this.#wakeDeliveryController?.();
      this.#markOperatorInboxChanged();
      return { accepted: true, task: cancelled };
    }
    if (await this.#surfaceSettlement.pending(task.id)) return { accepted: false, task };
    await this.#appendTaskEvent(task.id, "task.cancellation-requested", {
      ...(principal === undefined ? {} : { operatorId: principal.operatorId }),
      ...(reason === undefined ? {} : { reason }),
    });
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
    this.#stopping = false;
    this.#taskControllerDrained = false;
    this.#drainPromise = undefined;
    this.#running = true;
    this.#accepting = true;
    this.#ephemeralSweepTimer = setInterval(() => {
      void controlPlaneEventLoopLag
        .run("job: ephemeral Worker Host sweep", () => this.sweepEphemeralWorkerHosts())
        .catch((error) => this.#reportDispatchError(error));
    }, EPHEMERAL_WORKER_HOST_SWEEP_INTERVAL_MS);
    this.#ephemeralSweepTimer.unref();
    this.#taskControllerLoop = this.#runTaskController();
    // A turn a stop or crash cut off is admitted now; admission is idempotent.
    void this.#sweepSessions();
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
      throw new Error("Only SuperTag admits work Session and report turns");
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
    /**
     * A repeat with the same key from the same operator to the same Tag admits nothing and
     * returns the first message's Task, whatever its text or conversation.
     */
    readonly idempotencyKey?: string;
  }): Promise<InboundIngestResult> {
    return this.#admitting(async () => {
      const tag = await this.#store.findTagByName(input.tagName);
      if (tag === undefined || tag.status !== "active")
        throw new Error(`Tag ${input.tagName} does not exist`);
      const now = new Date().toISOString();
      const account = await this.#cliAccount();
      const route = cliTagRoute(tag, account);
      const eventId = randomUUID();
      const sessionKey = cliConversationKey(input.operatorId, input.session);
      const event: InboundSurfaceEvent = {
        eventId,
        logicalEventId:
          input.idempotencyKey === undefined
            ? eventId
            : `cli-message:${createHash("sha256").update(`${input.operatorId}\n${tag.id}\n${input.idempotencyKey}`).digest("hex")}`,
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
   * A person replying in an Objective's home thread directs that Objective. A plain thread reply
   * is the next turn of the Objective's conversation, like `supertag message objective`;
   * `@SuperTag approve` approves a ready_for_review result, and `@SuperTag pause` and
   * `@SuperTag resume` pause and resume the Objective. Anyone who may create Objectives from this
   * surface may do this. Other messages keep their ordinary Session handling.
   */
  async #routeObjectiveThread(
    event: InboundSurfaceEvent,
    account: SurfaceAccount,
    route: { readonly id: string; readonly scope: string },
    tag: { readonly id: string },
  ): Promise<InboundIngestResult | undefined> {
    if (event.actor.kind !== "user" || !event.text?.trim()) return undefined;
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
    const objective = await this.#store.findObjectiveByHomeSession(session.id);
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
        const sent = await this.messageObjective({
          objectiveId: objective.id,
          text: event.text,
          operatorId: principal.operatorId,
          idempotencyKey: `surface:${createHash("sha256").update(`${account.id}\n${event.eventId}`).digest("hex").slice(0, 40)}`,
          actor: event.actor,
        });
        text = sent.duplicate
          ? "This message was already delivered to the Objective."
          : sent.statusChange
            ? `Sent to the Objective. It moved from ${sent.statusChange} to working.`
            : "Sent to the Objective.";
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
    // An internal turn (a work Session's Task or a report turn) is not a conversation
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
    if (Date.now() - this.#lastSessionSweep >= SESSION_SWEEP_INTERVAL_MS)
      await this.#sweepSessions();
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
      // An inbox turn whose messages an earlier turn already took has nothing to do.
      if (
        !preparedOutcome &&
        candidate.status === "pending" &&
        candidate.event.internal?.kind === "delivery" &&
        candidate.event.internal.reason === "inbox" &&
        (await this.#store.bindInboxMessages(pendingTask.id, pendingTask.tagId)).length === 0
      ) {
        await this.#settleEmptyInboxTurn(pendingTask);
        return true;
      }
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
          if (
            event.type === "progress.updated" &&
            showsProgress(work) &&
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
        // A work Session's or an Objective's Task completes either done or waiting: with the
        // question it asked, or on the approval requests it left pending, which a decision
        // continues.
        const waits = waitingTurn(work);
        const asked = waits
          ? (await this.#store.listTaskEvents(task.id)).findLast(
              (event) => event.type === WORK_SESSION_ASKED_EVENT && event.attemptId === attempt?.id,
            )?.payload?.["question"]
          : undefined;
        // The requests this Attempt was told to end its turn on, while pending or decided but
        // unused: a decision that lands while the Task still runs reaches no tool call, so the
        // Task waits on it too, and the continuation after completion carries it.
        const approvals = waits
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
        preparedOutcome = {
          taskId: task.id,
          attemptId: attempt.id,
          status: "completed",
          outcome: {
            responseLength: responseText.length,
            ...(typeof asked === "string" ? { question: asked } : {}),
            ...(approvals.length === 0 ? {} : { approvals }),
          },
          workerId,
          responseText: finalResultText(responseText, result),
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
            ...(durableExecution ? { sessionBlockReason: CANCELLATION_CLEANUP_BLOCK_REASON } : {}),
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
          ...(uncertain ? { sessionBlockReason: EXECUTION_UNCONFIRMED_BLOCK_REASON } : {}),
          ...executionFailureKind(budgetExhausted, workerEvents),
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
    if (work.event.internal?.kind === "work_session" || work.event.internal?.kind === "delivery") {
      // A work Session, an Objective's turn and an inbox turn run beside conversation turns:
      // dispatch waits only until it has started, so conversations stay responsive meanwhile.
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
    // The terminal receipt may already be recorded, as when recovery replayed the journal first.
    if (outcome.sessionBlockReason !== undefined && outcome.attemptId)
      await this.#releaseStoppedSession(outcome.taskId, outcome.attemptId).catch((error) =>
        this.#reportDispatchError(error),
      );
    if (status !== "pending") {
      await this.#appendTaskEvent(outcome.taskId, `task.${status}`, result);
      await this.#finishReplyStream(outcome.taskId, work.id, status);
      // A work Session's pull request is ready once it completes and closed once it is cancelled.
      if (work.event.internal?.kind === "work_session") {
        const task = await this.#store.findTaskById(outcome.taskId);
        if (task?.workspacePlan.status === "workspace")
          await this.objectives
            .settleWorkspacePullRequest(task)
            .catch((error: unknown) => this.#reportDispatchError(error));
      }
      if (work.event.internal?.kind === "work_session")
        await this.#reportWorkSession(outcome.taskId);
      // A decision that landed before this Task's outcome was committed continues it now.
      else if (waitingTurn(work))
        await this.#oneWorkTaskTurn(outcome.taskId, () =>
          this.#continueDecidedSession(outcome.taskId),
        );
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
   * The live reply of a running conversation Task as AI SDK UI message stream parts, after the
   * part numbered `after` or only parts still to come; undefined when the Task has no running
   * reply stream, so the caller reads the record.
   */
  streamTaskReply(
    taskId: string,
    after: number | "now" = 0,
  ): Promise<ReadableStream<ReplyStreamPart> | undefined> {
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
    const internal = work.event.internal;
    // A person's message, or a turn SuperTag admitted itself, gets coordination; a bot's does not.
    const coordination =
      supportsSurfaceCoordination && (work.event.actor.kind === "user" || internal !== undefined)
        ? await this.objectives.surfaceCoordination(task, attempt)
        : undefined;
    // Every root Session turn with surface coordination sees the Tag's open Objectives and the
    // work Sessions it started. A work Session sees only its own work, so it gets no portfolio.
    const portfolio =
      coordination === undefined || internal?.kind === "work_session"
        ? undefined
        : await tagPortfolio(this.#store, conversationViewer(task, work), {
            workSessions: await this.#store.listWorkSessions(task.sessionId),
            startSessions: internal === undefined,
            ...(await this.#inboxSessionId(task.tagId)),
          });
    // An inbox turn handles every Mailbox message not yet taken, bound to it when it starts.
    const turnText =
      internal?.kind === "delivery" && internal.reason === "inbox"
        ? await this.#inboxText(task)
        : text;
    const turn =
      internal === undefined
        ? undefined
        : internalTurnMessages(
            internal,
            turnText,
            task.sessionId,
            coordination !== undefined,
            await this.#internalTurnContext(work, task),
          );
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
    // A Task without a branch of its own yet continues the one its Session's earlier Tasks
    // committed to, so a Worker Host without that branch adopts it rather than starting afresh.
    const sessionPin =
      task.workspacePlan.status === "workspace" && branchPin === undefined
        ? await sessionBranchPin(this.#store, task, task.workspacePlan)
        : undefined;
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
                {
                  id: work.event.eventId,
                  role: "requester" as const,
                  text: turn.prompt,
                  // An operator's message to an Objective is theirs; other internal turns carry
                  // no person.
                  ...(internal?.kind === "delivery" && internal.from.kind === "person"
                    ? { actor: work.event.actor }
                    : {}),
                },
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
              ...(sessionPin === undefined
                ? {}
                : {
                    branch: sessionPin.branch,
                    branchPin: sessionPin.branch,
                    branchPinHead: sessionPin.head,
                  }),
              ...(mcpPin === undefined ? {} : { mcpPin }),
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
    if (!receipt) return;
    if (receipt.lastSequence > cursor) {
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
    // A cancelled receipt journals no terminal event, so its cleanup evidence is recorded here.
    if (
      receipt.status === "cancelled" &&
      !(await this.#store.listTaskEvents(taskId)).some(
        (event) =>
          event.attemptId === attemptId && event.type === "task.cancellation-cleanup-confirmed",
      )
    )
      await this.#appendTaskEvent(
        taskId,
        "task.cancellation-cleanup-confirmed",
        { version: 1, receiptStatus: receipt.status },
        attemptId,
      );
    await this.#releaseStoppedSession(taskId, attemptId);
  }

  /**
   * An uncertain or cancelled Task Attempt blocks its Session only while its execution may still
   * run. Once the Worker's terminal receipt is recorded, or its removed ephemeral Worker Host can
   * never run it again, the Session's later turns run; the Task keeps its outcome and is never
   * replayed.
   */
  async #releaseStoppedSession(taskId: string, attemptId: string): Promise<void> {
    const task = await this.#store.findTaskById(taskId);
    if (task?.inboundEventId == null) return;
    if ((await this.#store.findInboundEventById(task.inboundEventId))?.sessionBlocked !== true)
      return;
    const attempt = (await this.#store.listTaskAttempts(taskId)).find(
      (candidate) => candidate.id === attemptId,
    );
    const events = await this.#store.listTaskEvents(taskId);
    if (
      attempt === undefined ||
      (taskExecutionPlacementReport(attempt, events).cleanup !== "confirmed" &&
        !events.some(
          (event) => event.attemptId === attemptId && event.type === "task.worker-host-removed",
        ))
    )
      return;
    if (
      !(await this.#store.releaseInboundSession({
        inboundEventId: task.inboundEventId,
        attemptId,
      }))
    )
      return;
    this.#wakeTaskController?.();
    this.#markOperatorInboxChanged();
  }

  /**
   * Checks a page of blocked Sessions' stopped Task Attempts each sweep, continuing after the
   * last page so Sessions that stay blocked cannot hide later ones. A connected Worker Host's
   * journal is replayed; a removed ephemeral Worker Host counts as evidence that its Attempt
   * stopped.
   */
  async #releaseStoppedSessions(): Promise<void> {
    const blocked = await this.#store.listBlockedSessionAttempts({
      ...(this.#blockedSessionCursor === undefined ? {} : { after: this.#blockedSessionCursor }),
      limit: SESSION_SWEEP_BATCH,
    });
    this.#blockedSessionCursor =
      blocked.length < SESSION_SWEEP_BATCH ? undefined : blocked.at(-1)?.inboundEventId;
    if (blocked.length === 0) return;
    const worklet = this.#worklet;
    const durable =
      worklet !== undefined &&
      "inspect" in worklet &&
      typeof worklet.inspect === "function" &&
      "events" in worklet &&
      typeof worklet.events === "function"
        ? (worklet as DurableWorklet)
        : undefined;
    const connected = new Set(
      (await this.listWorkerHosts())
        .filter((host) => host.connectionStatus === "connected")
        .map((host) => host.id),
    );
    for (const { taskId, attemptId } of blocked) {
      if (this.#activeTaskControllers.has(taskId)) continue;
      const attempt = (await this.#store.listTaskAttempts(taskId)).find(
        (candidate) => candidate.id === attemptId,
      );
      if (attempt?.workerSnapshot["durableExecution"] !== true) continue;
      const host = attemptWorkerHostId(attempt);
      if (host !== undefined && !connected.has(host)) {
        await this.#releaseRemovedHostSession(taskId, attempt).catch((error) =>
          this.#reportDispatchError(error),
        );
        continue;
      }
      if (durable === undefined || (host === undefined && connected.size === 0)) continue;
      await this.#replaySurfaceAttemptJournal(taskId, attemptId, durable).catch((error) =>
        this.#reportDispatchError(error),
      );
    }
  }

  /**
   * An ephemeral Worker Host removed after its reconnect grace can never run or report `attempt`
   * again, so its blocked Session is released, as the dispatcher requeues such Attempts.
   */
  async #releaseRemovedHostSession(taskId: string, attempt: TaskAttempt): Promise<void> {
    const removed = await this.#removeLostEphemeralWorkerHost(
      attempt,
      EPHEMERAL_WORKER_HOST_GRACE_MS,
    );
    if (removed === undefined) return;
    if (
      !(await this.#store.listTaskEvents(taskId)).some(
        (event) => event.attemptId === attempt.id && event.type === "task.worker-host-removed",
      )
    )
      await this.#appendTaskEvent(
        taskId,
        "task.worker-host-removed",
        { version: 1, workerHostId: removed, requeued: false },
        attempt.id,
      );
    await this.#releaseStoppedSession(taskId, attempt.id);
  }

  /**
   * `start_session` opens a work Session of a root Session and admits its first Task;
   * `continue_session` admits the next Task of one of its finished work Sessions. A work Session
   * of the same Tag runs under the starting turn's admitted authorization, context plan and
   * Workspace plan. An Objective's turn may start one for a member of the Objective's Team, under
   * that Tag's Roles narrowed to the Objective and to the starting turn. Each counts against the
   * starting turn's work Session bounds and draws from its limits, or from the Objective's budget
   * pool. It returns at once; the Task queues behind the Session's running work Sessions.
   */
  async #startWorkSession(
    conversation: Task,
    starting: DurableInboundEvent,
    request:
      | { readonly start: DelegatedStartRequest }
      | { readonly continue: ContinueSessionRequest },
  ): Promise<StartSessionResult> {
    if (!this.#accepting)
      throw new TagMessagingError(503, "The Control Plane is not accepting new work now");
    // One Session's start_session and continue_session calls run one at a time, so the bounds
    // below hold.
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
      | { readonly start: DelegatedStartRequest }
      | { readonly continue: ContinueSessionRequest },
  ): Promise<StartSessionResult> {
    const verb = "start" in request ? "start" : "continue";
    // Work Sessions are parallel agents of the starting turn: a turn starts a bounded number,
    // none when its maxNativeAgents is 0, and they draw on its reported token and cost limits.
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
    const parent = await this.#store.findSessionById(conversation.sessionId);
    if (parent?.parentSessionId !== undefined)
      throw new TagMessagingError(
        403,
        `A work Session cannot ${verb} work Sessions; end your turn with the result`,
      );
    const objective =
      parent?.objectiveId === undefined
        ? undefined
        : await this.#store.getObjective(parent.objectiveId);
    const delegate =
      "start" in request && request.start.tag !== undefined
        ? await this.#delegate(conversation, objective, request.start.tag)
        : undefined;
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
          "No work Session of this Session has that id; continue_session continues only work Sessions this Session started",
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
          "This turn already ran that work Session; pass the answer from a later turn",
        );
      // Continue only after the latest Task's report turn has run: that turn put its result or
      // question forward, so a later report never asks a question already answered.
      const report = await this.#store.findWorkSessionReport(target.task.id);
      const reportTask = report?.taskId ? await this.#store.findTaskById(report.taskId) : undefined;
      if (
        reportTask === undefined ||
        reportTask.status === "pending" ||
        reportTask.status === "running"
      )
        throw new TagMessagingError(
          409,
          "That work Session's report has not reached this Session yet; continue it after its report turn",
        );
      const latest = await this.#store.findTaskById(target.task.id);
      const work = latest?.inboundEventId
        ? await this.#store.findInboundEventById(latest.inboundEventId)
        : undefined;
      if (!latest || work?.event.internal?.kind !== "work_session")
        throw new Error(`Work Session ${target.sessionId} has no admitted Task`);
      // Never broader than the work Session ran with, nor than this turn may act. Another Tag's
      // work Session compares with what that Tag may do for the Objective now.
      const allowed =
        work.tagId === conversation.tagId
          ? starting.authorization
          : objective === undefined
            ? undefined
            : await this.#objectiveWorkAuthorization(objective, work, starting.authorization);
      if (allowed === undefined || !samePermissions(work.authorization, allowed))
        throw new TagMessagingError(
          409,
          "The permissions changed since that work Session last ran, so it cannot continue under them; start a new work Session instead",
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
        `This Session already has ${WORK_SESSION_MAX_OPEN} unfinished work Sessions; wait for one to finish`,
      );
    // The Session another Tag's work runs in keeps that Tag's location.
    const delegatedWork =
      previous !== undefined && previous.work.tagId !== conversation.tagId
        ? previous.work
        : undefined;
    const execution =
      objective !== undefined
        ? await this.#objectivePoolExecution(
            objective,
            delegate !== undefined
              ? await this.#tagExecution(delegate)
              : delegatedWork !== undefined
                ? delegatedWork.execution
                : starting.execution,
          )
        : await this.#turnPoolExecution(
            conversation,
            turnPool(starting.execution),
            starting.execution,
          );
    if (execution === undefined)
      throw new TagMessagingError(
        409,
        objective !== undefined
          ? `Objective ${objective.id} has too little of its budget left to ${verb} a work Session; finish the work in this turn, or ask an operator to raise the budget`
          : `This turn and the work Sessions it started or continued already spent too much of its token and cost limits to ${verb} a useful work Session; finish the work in this turn`,
      );
    const running = sessions.filter((session) => session.task?.status === "running").length;
    // A new work Session edits one of the Session's Workspaces on its own branch; a continued
    // one keeps the Workspace it started in.
    const workspace =
      "start" in request
        ? await workSessionWorkspace(
            this.#store,
            (await this.describeWorklet().catch(() => undefined))?.host,
            starting,
            request.start.workspace,
            objective === undefined ? undefined : (objective.workspaces ?? []),
          )
        : undefined;
    const at = new Date().toISOString();
    const title = "start" in request ? request.start.title : (previous?.title ?? "");
    const started = {
      title,
      instruction: "start" in request ? request.start.instruction : "",
      ...(workspace === undefined ? {} : { workspace }),
    };
    let admission: Awaited<ReturnType<Store["admitInboundEvent"]>>;
    if (delegate !== undefined && objective !== undefined) {
      const account = await this.#cliAccount();
      const route = cliTagRoute(delegate, account);
      const event = workSessionEvent(
        starting,
        conversation.id,
        conversation.sessionId,
        started,
        at,
        { externalAccountId: CLI_EXTERNAL_ACCOUNT_ID },
      );
      const roles = await resolveTagRoles(this.#store, delegate.id);
      admission = await this.#store.admitInboundEvent({
        surfaceAccountId: account.id,
        tagRouteId: route.id,
        tagId: delegate.id,
        authorization: await objectiveAuthorization(
          this.#store,
          objective,
          delegate,
          { account, route, event },
          starting.authorization,
        ),
        contextPlan: await captureInternalRoleContextPlan(this.#store, roles.contextSetIds, at),
        execution,
        event,
        maxAttempts: this.#maxAttempts,
      });
    } else {
      const from = delegatedWork ?? starting;
      admission = await this.#store.admitInboundEvent({
        surfaceAccountId: from.surfaceAccountId,
        tagRouteId: from.tagRouteId,
        tagId: from.tagId,
        authorization: from.authorization,
        contextPlan: from.contextPlan,
        execution,
        event:
          previous === undefined
            ? workSessionEvent(starting, conversation.id, conversation.sessionId, started, at)
            : continuedWorkSessionEvent(
                previous.work,
                starting,
                conversation.id,
                conversation.sessionId,
                title,
                "continue" in request ? request.continue.message : "",
                at,
              ),
        maxAttempts: this.#maxAttempts,
      });
    }
    const task = await this.#openTask(admission.work);
    await this.#appendTaskEvent(task.id, "task.admitted", {
      tagRouteId: admission.work.tagRouteId,
      scope: admission.work.event.scope,
      startedByTaskId: conversation.id,
      parentSessionId: conversation.sessionId,
      ...(task.tagId === conversation.tagId ? {} : { delegatedByTagId: conversation.tagId }),
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
   * The Tag `start_session {tag}` names, when it is another Tag: allowed only from an Objective's
   * own turn, for an active member of the Objective's Team bound to a Worker Host.
   */
  async #delegate(
    conversation: Task,
    objective: Objective | undefined,
    name: string,
  ): Promise<Tag | undefined> {
    const tag = (await this.#store.findTagByName(name)) ?? (await this.#store.findTagById(name));
    if (tag?.status !== "active") throw new TagMessagingError(404, `Tag ${name} does not exist`);
    if (tag.id === conversation.tagId) return undefined;
    if (objective === undefined)
      throw new TagMessagingError(
        403,
        "Only an Objective's turn may start a work Session for another Tag; omit tag",
      );
    const team =
      objective.teamId === null ? undefined : await this.#store.getTeam(objective.teamId);
    if (team === undefined)
      throw new TagMessagingError(
        409,
        `Objective ${objective.id} names no Team, so its work Sessions run on this Tag; omit tag`,
      );
    if (!team.memberTagIds.includes(tag.id))
      throw new TagMessagingError(
        403,
        `Tag ${tag.name} is not a member of Team ${team.name}; members: ${(
          await Promise.all(team.memberTagIds.map((id) => this.#store.findTagById(id)))
        )
          .flatMap((member) => (member?.status === "active" ? [member.name] : []))
          .join(", ")}`,
      );
    if ((await this.#store.listTagWorkerHostBindings(tag.id)).length === 0)
      throw new TagMessagingError(
        409,
        `Tag ${tag.name} cannot accept Tasks because it has no Worker Host binding`,
      );
    return tag;
  }

  /**
   * `base`, drawing on a conversation turn's pool: `pool`, the turn's reported limits, less what
   * the turn and every work Session Task it started or continued reported. Undefined once too
   * little of it is left.
   */
  async #turnPoolExecution(
    turn: Task,
    pool: BudgetPool,
    base: TaskExecutionRequirements,
  ): Promise<TaskExecutionRequirements | undefined> {
    if (!limitsSpend(pool)) return base;
    const taskIds = [turn.id, ...(await this.#workTasksStartedBy(turn))];
    return poolExecution(pool, poolSpend(pool, await this.#store.readSpend({ taskIds })), base);
  }

  /**
   * The work Session Tasks a turn started or continued, those that continued them after an
   * approval decision included: every Task whose admitted event names the turn as its starter.
   */
  async #workTasksStartedBy(turn: Task): Promise<readonly string[]> {
    const since = Date.parse(turn.createdAt);
    const found = await Promise.all(
      (await this.#store.listWorkSessions(turn.sessionId)).map(async (session) => {
        const ids: string[] = [];
        // Newest first: a Task older than the turn was not started by it.
        for (const id of (await this.#store.listSessionTaskIds(session.sessionId)).toReversed()) {
          const task = await this.#store.findTaskById(id);
          if (!task || Date.parse(task.createdAt) < since) break;
          const work = task.inboundEventId
            ? await this.#store.findInboundEventById(task.inboundEventId)
            : undefined;
          const internal = work?.event.internal;
          if (internal?.kind === "work_session" && internal.startedByTaskId === turn.id)
            ids.push(id);
        }
        return ids;
      }),
    );
    return found.flat();
  }

  /** The Tag's default execution requirements, for a turn nobody chose a model or effort for. */
  async #tagExecution(tag: Tag, roles?: ResolvedTagRoles): Promise<TaskExecutionRequirements> {
    return resolveTaskExecution({
      range: await tagExecutionRange(this.#store, tag, roles),
      requested: parseTaskExecutionRequirements({}),
      chosen: {},
      subject: `Tag ${tag.name}`,
    }).execution;
  }

  /** An Objective's budget pool and what its Tasks reported spending from it. */
  async #objectivePoolDraw(
    objective: Objective,
  ): Promise<{ readonly pool: BudgetPool; readonly spent: PoolSpend }> {
    const pool = objectivePool(objective);
    if (!limitsSpend(pool)) return { pool, spent: { tokens: 0, costMinor: 0 } };
    const report = await this.#store.readSpend({ objectiveIds: [objective.id] });
    return { pool, spent: poolSpend(pool, report) };
  }

  /** `base`, drawing on the Objective's budget pool; undefined once too little of it is left. */
  async #objectivePoolExecution(
    objective: Objective,
    base: TaskExecutionRequirements,
  ): Promise<TaskExecutionRequirements | undefined> {
    const { pool, spent } = await this.#objectivePoolDraw(objective);
    return poolExecution(pool, spent, base);
  }

  /**
   * What the Tag of a work Session under an Objective may do for it now: the Objective's
   * authorization for that Tag at the work Session's location, narrowed to `ceiling` for another
   * Tag's work. Undefined when the Tag or its location is gone.
   */
  async #objectiveWorkAuthorization(
    objective: Objective,
    work: DurableInboundEvent,
    ceiling: TagAuthorizationSnapshot,
  ): Promise<TagAuthorizationSnapshot | undefined> {
    const tag = await this.#store.findTagById(work.tagId);
    const location = await this.#locationOf(work);
    if (tag?.status !== "active" || location === undefined) return undefined;
    return objectiveAuthorization(
      this.#store,
      objective,
      tag,
      location,
      tag.id === objective.ownerTagId ? undefined : ceiling,
    );
  }

  /** The account and route an inbound event was admitted under, if both still exist. */
  async #locationOf(inbound: DurableInboundEvent): Promise<ObjectiveLocation | undefined> {
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
    return route === undefined ? undefined : { account, route, event: inbound.event };
  }

  /**
   * A work Session Task's pending approval request, posted where the conversation turn that
   * started it replies: the work Session itself posts nowhere. A Task of an Objective's Sessions is
   * left to the Objective's approval digest in its home thread, and an inbox turn's request
   * reaches only the operator inbox. The request id is the delivery key, so it posts once, and a
   * Task posts one notice per admitted requirement while its requests are pending.
   */
  async #postSessionApproval(
    task: Task,
    work: DurableInboundEvent,
    requestId: string,
  ): Promise<void> {
    const internal = work.event.internal;
    if (internal?.kind !== "work_session" || task.objectiveId !== undefined) return;
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

  /**
   * One pass over the Sessions that need SuperTag, oldest first in each step: report turns that
   * finished work Sessions are owed, Sessions whose waited-on approval request was decided
   * without continuing them (as after a restart), idle Objectives, Mailbox messages no inbox turn
   * took, then the Objective controller's own sweep. A failing step never stops the next.
   */
  #sweepSessions(): Promise<void> {
    this.#sweeping ??= this.#sweepSessionsNow().finally(() => {
      this.#sweeping = undefined;
    });
    return this.#sweeping;
  }

  async #sweepSessionsNow(): Promise<void> {
    this.#lastSessionSweep = Date.now();
    const step = async (run: () => Promise<void>) => {
      try {
        await run();
      } catch (error) {
        this.#reportDispatchError(error);
      }
    };
    await step(async () => {
      for (const taskId of await this.#store.listUnreportedWorkTasks(SESSION_SWEEP_BATCH))
        await this.#reportWorkSession(taskId);
    });
    await step(async () => {
      for (const taskId of await this.#store.listDecidedSessionWaits(SESSION_SWEEP_BATCH))
        await this.#oneWorkTaskTurn(taskId, () => this.#continueDecidedSession(taskId));
    });
    await step(() => this.#settleIdleObjectives());
    await step(() => this.#deliverPendingInboxes());
    await step(() => this.#releaseStoppedSessions());
    await step(() => this.objectives.sweep());
  }

  /**
   * A finished work Session Task's report turn: a new Task in the Session that started it, under
   * the starting turn's admitted authorization, that replies where that turn replied. Its event
   * id is the delivery key, so a repeat after a restart is a duplicate admission, not a report.
   */
  async #reportWorkSession(workTaskId: string): Promise<void> {
    await this.#oneWorkTaskTurn(workTaskId, async () => {
      await this.#reportWorkSessionNow(workTaskId);
      // A request decided before the Task's outcome was committed continues the Session now.
      await this.#continueDecidedSession(workTaskId);
    });
  }

  /**
   * Runs one Task's approval notice, approval continuation and report admission one at a time,
   * so a notice posted while the Task runs is queued before its report.
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
        throw new Error(`Work Session ${task.sessionId} has no Session turn to report to`);
      // A retired Tag takes no more turns; its work Session's result stays on the Session.
      if ((await this.#store.findTagById(starting.tagId))?.status !== "active") return;
      const final = await this.#store.findOutboundReply(work.id, "final");
      const question = task.status === "completed" ? task.outcome?.["question"] : undefined;
      const approvals =
        task.status === "completed" && Array.isArray(task.outcome?.["approvals"])
          ? task.outcome["approvals"].filter((id): id is string => typeof id === "string")
          : [];
      const delivery =
        task.workspacePlan.status === "workspace"
          ? workSessionDelivery(task, workerEvents(await this.#store.listTaskEvents(task.id)))
          : undefined;
      // A conversation's report runs under the starting turn's limits: it starts no work, and a
      // resumed conversation pays for its whole context on its first model call. A report to an
      // Objective draws from its budget pool like every turn of the Objective; it is owed, so it
      // gets what is left even below the floor.
      const objectiveId = objectiveIdOfSessionKey(starting.event.sessionKey);
      let execution = starting.execution;
      if (objectiveId !== undefined) {
        const { pool, spent } = await this.#objectivePoolDraw(
          await this.#store.getObjective(objectiveId),
        );
        execution = poolRemainderExecution(pool, spent, starting.execution);
      }
      const admission = await this.#store.admitInboundEvent({
        surfaceAccountId: starting.surfaceAccountId,
        tagRouteId: starting.tagRouteId,
        tagId: starting.tagId,
        authorization: starting.authorization,
        contextPlan: starting.contextPlan,
        execution,
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
   * Continues a Session whose latest Task completed waiting on approval requests, once one of
   * them is decided. An Objective's own Session gets the decisions as its next turn. A work
   * Session's next Task carries them as its message, under the waiting Task's admitted
   * authorization only while its Tag's current permissions are the same, as `continue_session`
   * requires, and drawing on the pool of the turn that started or continued the work Session, or
   * on the Objective's. When either check fails, the starting Session is told, and the Task waits on
   * nothing. The event id is keyed by the waiting Task, so the decision listener, the report path
   * and the sweep continue it once between them. Runs in the waiting Task's turn, after its report
   * admission.
   */
  async #continueDecidedSession(taskId: string): Promise<void> {
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
      if (!work) return;
      const internal = work.event.internal;
      const ownObjectiveId = objectiveIdOfSessionKey(work.event.sessionKey);
      const inbox = isInboxSessionKey(work.event.sessionKey);
      if (internal?.kind !== "work_session" && ownObjectiveId === undefined && !inbox) return;
      if ((await this.#store.listSessionTaskIds(task.sessionId)).at(-1) !== task.id) return;
      // A retired Tag takes no more turns; its Session stays where it stopped.
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
          (event) => event.type === SESSION_NOT_CONTINUED_EVENT,
        )
      )
        return;
      const decisions = decided.map(approvalDecisionText).join("\n\n");
      if (inbox) {
        // An inbox turn: the decision is the inbox's next turn, under the Tag's current Roles.
        const tag = await this.#store.findTagById(task.tagId);
        if (tag === undefined) return;
        await this.#oneInbox(tag.id, () =>
          this.#admitInboxDelivery(tag, {
            eventId: sessionApprovalDeliveryId(task.id),
            actor: { id: "supertag", displayName: "SuperTag", kind: "bot" },
            internal: { kind: "delivery", from: { kind: "supertag" }, reason: "approval_decision" },
            text: decisions,
            admitted: { approvalRequestId: decided[0]?.id },
          }),
        );
        return;
      }
      if (internal?.kind !== "work_session") {
        // An Objective's own turn: the decision is its conversation's next turn.
        const objective = await this.#store.getObjective(ownObjectiveId ?? "");
        if (objectiveClosed(objective.status)) return;
        try {
          await this.#admitObjectiveTurn(objective, {
            eventId: sessionApprovalDeliveryId(task.id),
            reason: "approval_decision",
            from: { kind: "supertag" },
            text: decisions,
          });
        } catch (error) {
          if (!(error instanceof TagMessagingError)) throw error;
          await this.#appendTaskEvent(task.id, SESSION_NOT_CONTINUED_EVENT, {
            requestIds: decided.map((request) => request.id),
            reason: "budget",
          });
          await this.#postObjectiveNotice(
            objective.id,
            `approval-continue:${task.id}`,
            `Objective ${objective.id} did not continue after approval request ${decided.map((request) => `${request.id} (${request.status})`).join(", ")} was decided: ${error.message}`,
          );
        }
        return;
      }
      // The waiting Task's report reaches the starting Session before the work Session goes on.
      await this.#reportWorkSessionNow(task.id);
      const startingTask = await this.#store.findTaskById(internal.startedByTaskId);
      const starting = startingTask?.inboundEventId
        ? await this.#store.findInboundEventById(startingTask.inboundEventId)
        : undefined;
      if (!startingTask || !starting)
        throw new Error(`Work Session ${task.sessionId} has no Session turn to report to`);
      // A Session holds a bounded number of unfinished work Sessions; the sweep continues this
      // one once another finishes.
      const open = (await this.#store.listWorkSessions(internal.parentSessionId)).filter(
        (session) => session.task?.status === "running" || session.task?.status === "pending",
      ).length;
      if (open >= WORK_SESSION_MAX_OPEN) return;
      const stop = async (reason: "permissions" | "budget") => {
        await this.#appendTaskEvent(task.id, SESSION_NOT_CONTINUED_EVENT, {
          requestIds: decided.map((request) => request.id),
          reason,
        });
        await this.#postNoticeOnce(
          starting.id,
          `approval-continue:${task.id}`,
          workSessionNotContinuedNotice(internal.title, decided, reason),
        );
      };
      const objectiveId = objectiveIdOfSessionKey(starting.event.sessionKey);
      const objective =
        objectiveId === undefined ? undefined : await this.#store.getObjective(objectiveId);
      if (objective !== undefined && objectiveClosed(objective.status)) return;
      // Never broader than the Tag may act now: a decision does not revive revoked permissions.
      const current =
        objective === undefined
          ? await this.#currentAuthorization(starting)
          : await this.#objectiveWorkAuthorization(objective, work, starting.authorization);
      if (current === undefined || !samePermissions(work.authorization, current)) {
        await stop("permissions");
        return;
      }
      // The continuing Task draws on the pool of the turn that started or continued the work.
      const execution =
        objective === undefined
          ? await this.#turnPoolExecution(
              startingTask,
              turnPool(startingTask.execution),
              work.execution,
            )
          : await this.#objectivePoolExecution(objective, work.execution);
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
        decisions,
        new Date().toISOString(),
      );
      const eventId = sessionApprovalDeliveryId(task.id);
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
    const location = await this.#locationOf(inbound);
    const tag = await this.#store.findTagById(inbound.tagId);
    if (!location || !tag) return undefined;
    return this.#captureAuthorization(
      inbound.event,
      location.account,
      location.route,
      tag,
      new Date().toISOString(),
      await resolveTagRoles(this.#store, tag.id),
    );
  }

  /**
   * Admits the first turn of an Objective's conversation, in its home thread. Idempotent: a
   * repeat returns the same Task.
   */
  async startObjective(objectiveId: string): Promise<{ readonly taskId: string }> {
    const objective = await this.#store.getObjective(objectiveId);
    if (objectiveClosed(objective.status))
      throw new TagMessagingError(409, `Objective ${objective.id} is ${objective.status}`);
    const { task } = await this.#admitObjectiveTurn(objective, {
      eventId: objectiveStartDeliveryId(objective.id),
      reason: "objective_start",
      from: { kind: "supertag" },
      text: objectiveTurnText("objective_start", objective),
    });
    return { taskId: task.id };
  }

  /**
   * An operator's message to an Objective: the next turn of its conversation, as if written in
   * its home thread. A blocked, limited or ready_for_review Objective goes back to working. The
   * idempotency key makes a repeat a duplicate.
   */
  async messageObjective(
    input: MessageObjectiveInput & {
      /** The person as the surface names them, when the message came from a thread. */
      readonly actor?: InboundSurfaceEvent["actor"];
    },
  ): Promise<MessageObjectiveResult> {
    const text = input.text.trim();
    if (!text) throw new TagMessagingError(400, "message must not be empty");
    const objective = await this.#store.getObjective(input.objectiveId);
    if (objectiveClosed(objective.status))
      throw new TagMessagingError(
        409,
        `Objective ${objective.id} is ${objective.status} and takes no more messages`,
      );
    const actor = input.actor ?? {
      id: input.operatorId,
      displayName: input.operatorId,
      kind: "user" as const,
    };
    const { task, duplicate } = await this.#admitObjectiveTurn(objective, {
      eventId: objectiveMessageDeliveryId(objective.id, input.idempotencyKey),
      reason: "objective_message",
      from: {
        kind: "person",
        id: input.operatorId,
        ...(actor.displayName === undefined ? {} : { displayName: actor.displayName }),
      },
      text,
      actor,
    });
    if (duplicate) return { duplicate, taskId: task.id };
    let current = objective;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (
        current.status !== "blocked" &&
        current.status !== "limited" &&
        current.status !== "ready_for_review"
      )
        return { duplicate, taskId: task.id };
      try {
        await this.#store.updateObjectiveStatus(
          current.id,
          { status: "working", expectedRevision: current.revision },
          undefined,
          undefined,
          { operatorId: input.operatorId },
        );
        return { duplicate, taskId: task.id, statusChange: current.status };
      } catch (error) {
        if (!(error instanceof TagMessagingError) || error.statusCode !== 409) throw error;
        current = await this.#store.getObjective(current.id);
      }
    }
    return { duplicate, taskId: task.id };
  }

  /**
   * Admits one turn of an Objective's conversation, the owner Tag's `objective:<id>` Session in
   * the Objective's home thread, and opens its Task at admission so the Session belongs to the
   * Objective before it is dispatched. It runs under the Objective's authorization for the owner
   * Tag and draws from the Objective's budget pool; a spent pool refuses it.
   */
  async #admitObjectiveTurn(
    objective: Objective,
    turn: {
      readonly eventId: string;
      readonly reason: DeliveryReason;
      readonly from: DeliveryFrom;
      readonly text: string;
      readonly actor?: InboundSurfaceEvent["actor"];
    },
  ): Promise<{ readonly task: Task; readonly duplicate: boolean }> {
    if (!this.#accepting)
      throw new TagMessagingError(503, "The Control Plane is not accepting new work now");
    const owner = await this.#store.findTagById(objective.ownerTagId);
    if (owner?.status !== "active")
      throw new TagMessagingError(409, `Objective ${objective.id}'s Tag is no longer active`);
    if ((await this.#store.listTagWorkerHostBindings(owner.id)).length === 0)
      throw new TagMessagingError(
        409,
        `Tag ${owner.name} cannot accept Tasks because it has no Worker Host binding. Bind a Worker Host to the Tag, then retry.`,
      );
    const at = new Date().toISOString();
    const location = await this.#objectiveLocation(objective, owner, {
      ...turn,
      at,
      internal: {
        kind: "delivery",
        from: turn.from,
        reason: turn.reason,
        objectiveId: objective.id,
      },
    });
    const roles = await resolveTagRoles(this.#store, owner.id);
    const execution = await this.#objectivePoolExecution(
      objective,
      await this.#tagExecution(owner, roles),
    );
    if (execution === undefined)
      throw new TagMessagingError(
        409,
        `Objective ${objective.id} has spent its budget; an operator can raise it with supertag update objective ${objective.id}`,
      );
    const admission = await this.#store.admitInboundEvent({
      surfaceAccountId: location.account.id,
      tagRouteId: location.route.id,
      tagId: owner.id,
      authorization: await objectiveAuthorization(this.#store, objective, owner, location),
      contextPlan: await captureInternalRoleContextPlan(this.#store, roles.contextSetIds, at),
      execution,
      event: location.event,
      maxAttempts: this.#maxAttempts,
    });
    const task = await this.#openTask(admission.work);
    if (admission.status === "duplicate") return { task, duplicate: true };
    await this.#appendTaskEvent(task.id, "task.admitted", {
      tagRouteId: location.route.id,
      scope: location.event.scope,
      objectiveId: objective.id,
      reason: turn.reason,
    });
    this.#wakeTaskController?.();
    this.#markOperatorInboxChanged();
    return { task, duplicate: false };
  }

  /**
   * Where an Objective's turns run: its home thread's location with the Objective's own Session
   * key, so the owner's replies post in that thread; or, without a home thread, the owner Tag's
   * CLI account.
   */
  async #objectiveLocation(
    objective: Objective,
    owner: Tag,
    turn: {
      readonly eventId: string;
      readonly text: string;
      readonly at: string;
      readonly actor?: InboundSurfaceEvent["actor"];
      readonly internal: Extract<InboundSurfaceEvent["internal"], { readonly kind: "delivery" }>;
    },
  ): Promise<ObjectiveLocation> {
    const sessionKey = objectiveSessionKey(objective.id);
    const turnFields = {
      eventId: turn.eventId,
      logicalEventId: turn.eventId,
      kind: "message" as const,
      sessionKey,
      actor: turn.actor ?? { id: "supertag", displayName: "SuperTag", kind: "bot" as const },
      internal: turn.internal,
      text: turn.text,
      occurredAt: turn.at,
    };
    const home = await objectiveHome(this.#store, objective, this.#operatorNotificationTaskId);
    const anchor = home?.inboundEventId
      ? await this.#store.findInboundEventById(home.inboundEventId)
      : undefined;
    const location = anchor === undefined ? undefined : await this.#locationOf(anchor);
    if (anchor !== undefined && location !== undefined)
      return {
        account: location.account,
        route: location.route,
        event: {
          provider: anchor.event.provider,
          externalAccountId: anchor.event.externalAccountId,
          scope: anchor.event.scope,
          callback: anchor.event.callback,
          source: anchor.event.source,
          metadata: anchor.event.metadata,
          ...turnFields,
        },
      };
    const account = await this.#cliAccount();
    const route = cliTagRoute(owner, account);
    return {
      account,
      route,
      event: {
        provider: "cli",
        externalAccountId: CLI_EXTERNAL_ACCOUNT_ID,
        scope: route.scope,
        callback: { provider: "cli", mode: "cli_conversation", threadKey: sessionKey, target: {} },
        source: {},
        metadata: {},
        ...turnFields,
      },
    };
  }

  /**
   * The inbound event an Objective's notices are posted on: its home thread's, or for a CLI home
   * the first turn of its own Session.
   */
  async #objectiveAnchor(objective: Objective): Promise<string | undefined> {
    const home = await objectiveHome(this.#store, objective, this.#operatorNotificationTaskId);
    if (home?.inboundEventId) return home.inboundEventId;
    const session = await this.#store.findObjectiveOwnerSession(objective.id);
    const first = session ? (await this.#store.listSessionTaskIds(session.id))[0] : undefined;
    return first
      ? ((await this.#store.findTaskById(first))?.inboundEventId ?? undefined)
      : undefined;
  }

  /** Posts SuperTag's notice to an Objective's home thread, as its own message, once per key. */
  async #postObjectiveNotice(objectiveId: string, key: string, text: string): Promise<void> {
    const anchor = await this.#objectiveAnchor(await this.#store.getObjective(objectiveId));
    if (anchor === undefined) throw new Error(`Objective ${objectiveId} has no home thread`);
    await this.#postNoticeOnce(anchor, objectiveReportKey(objectiveId, key), text);
  }

  /** Delivers SuperTag's notice as a turn of an Objective's conversation, once per key. */
  async #notifyObjective(input: {
    readonly objectiveId: string;
    readonly key: string;
    readonly text: string;
    readonly reason?: "objective_notice" | "objective_message";
  }): Promise<void> {
    const eventId = objectiveNoticeDeliveryId(input.objectiveId, input.key);
    if (this.#deliveredNotices.has(eventId)) return;
    const objective = await this.#store.getObjective(input.objectiveId);
    if (objectiveClosed(objective.status)) return;
    await this.#admitObjectiveTurn(objective, {
      eventId,
      reason: input.reason ?? "objective_notice",
      from: { kind: "supertag" },
      text: input.text,
    });
    if (this.#deliveredNotices.size >= 10_000) this.#deliveredNotices.clear();
    this.#deliveredNotices.add(eventId);
  }

  /**
   * Cancels the open Tasks of an Objective's Sessions, except `exceptTaskId`: a pending Task is
   * cancelled with its turn, and a running Attempt this Control Plane runs is stopped. Returns
   * the Tasks whose cancellation was accepted.
   */
  async #cancelObjectiveTasks(
    objectiveId: string,
    reason: string,
    exceptTaskId?: string,
  ): Promise<readonly string[]> {
    const cancelled: string[] = [];
    for (const taskId of await this.#store.listOpenObjectiveTaskIds(objectiveId)) {
      if (taskId === exceptTaskId) continue;
      const result = await this.requestTaskCancellation(taskId, undefined, reason);
      if (result.accepted) cancelled.push(taskId);
    }
    return cancelled;
  }

  /**
   * Objectives whose latest own turn ended with nothing running and nothing asked: the first time
   * the Objective is woken once; when that wake also ended idle, it is blocked and its home thread
   * is told.
   */
  async #settleIdleObjectives(): Promise<void> {
    for (const idle of await this.#store.listIdleObjectives(SESSION_SWEEP_BATCH)) {
      try {
        const objective = await this.#store.getObjective(idle.objectiveId);
        const task = await this.#store.findTaskById(idle.ownerTaskId);
        const inbound = task?.inboundEventId
          ? await this.#store.findInboundEventById(task.inboundEventId)
          : undefined;
        if (idleAction(inbound) === "wake") {
          await this.#admitObjectiveTurn(objective, {
            eventId: objectiveIdleDeliveryId(idle.ownerTaskId),
            reason: "objective_idle",
            from: { kind: "supertag" },
            text: objectiveTurnText("objective_idle", objective),
          });
          continue;
        }
        await this.#store.updateObjectiveStatus(objective.id, {
          status: "blocked",
          expectedRevision: objective.revision,
        });
        this.#markOperatorInboxChanged();
        await this.#postObjectiveNotice(
          objective.id,
          `objective-blocked:${idle.ownerTaskId}`,
          objectiveBlockedText(objective.id),
        );
      } catch (error) {
        // A spent budget or a stale revision is settled by the limit sweep or the next pass.
        if (!(error instanceof TagMessagingError)) this.#reportDispatchError(error);
      }
    }
  }

  /** Admits an inbox turn for each Tag with Mailbox messages no turn took. */
  async #deliverPendingInboxes(): Promise<void> {
    for (const tagId of await this.#store.listTagsWithUnboundMessages(SESSION_SWEEP_BATCH)) {
      try {
        const tag = await this.#store.findTagById(tagId);
        if (tag?.status !== "active") continue;
        const oldest = (
          await this.#store.listTagMessageHistory(tagId, { limit: 100 })
        ).items.findLast(
          (message) => message.recipientTagId === tagId && message.taskId === undefined,
        );
        if (oldest === undefined) continue;
        await this.#oneInbox(tagId, () => this.#admitInboxTurn(tag, oldest));
      } catch (error) {
        this.#reportDispatchError(error);
      }
    }
  }

  /**
   * `send_message`: stores a message for another Tag and admits a turn of its inbox Session, unless
   * one is already waiting to start, which takes this message too. Only a root Session may send,
   * to a Tag that shares a Team with this one or accepts messages from it. A message sent from an
   * inbox turn carries one more hop than the messages that turn handled.
   */
  async #sendMessage(task: Task, input: SendMessageInput): Promise<SendMessageResult> {
    if (!this.#accepting)
      throw new TagMessagingError(503, "The Control Plane is not accepting new work now");
    const session = await this.#store.findSessionById(task.sessionId);
    if (session === undefined || session.parentSessionId !== undefined)
      throw new TagMessagingError(
        403,
        "A work Session cannot send messages; its result reaches the Session that started it",
      );
    if ((await this.#store.findTagById(task.tagId))?.status !== "active")
      throw new TagMessagingError(409, "This Tag is no longer active, so it cannot send messages");
    const recipient =
      (await this.#store.findTagByName(input.to)) ?? (await this.#store.findTagById(input.to));
    if (recipient?.status !== "active")
      throw new TagMessagingError(404, `Tag ${input.to} does not exist`);
    if (recipient.id === task.tagId)
      throw new TagMessagingError(400, "A Tag cannot send a message to itself");
    if (!(await this.#store.mayMessage(task.tagId, recipient.id)))
      throw new TagMessagingError(
        403,
        `Tag ${recipient.name} does not accept messages from this Tag: they share no Team, and it has no grant for this Tag`,
      );
    const history = (await this.#store.listTagMessageHistory(task.tagId, { limit: 100 })).items;
    const handled = isInboxSessionKey(session.sessionKey)
      ? history.filter((message) => message.taskId === task.id)
      : [];
    const hops = handled.length === 0 ? 0 : Math.max(...handled.map((message) => message.hops)) + 1;
    if (hops > INBOX_MAX_HOPS)
      throw new TagMessagingError(
        409,
        `This message would continue a chain of messages through more than ${INBOX_MAX_HOPS} inboxes; answer in your reply instead`,
      );
    if (
      input.workstreamPostId === undefined &&
      history.filter(
        (message) => message.sourceTaskId === task.id && message.workstreamPostId === undefined,
      ).length >= INBOX_SENDS_PER_TASK
    )
      throw new TagMessagingError(
        429,
        `This turn already sent ${INBOX_SENDS_PER_TASK} messages, the most one turn may send`,
      );
    return this.#oneInbox(recipient.id, async () => {
      const { message, admit } = await this.#store.deliverTagMessage({
        senderTagId: task.tagId,
        recipientTagId: recipient.id,
        text: input.text,
        hops,
        ...(task.objectiveId === undefined ? {} : { objectiveId: task.objectiveId }),
        sourceTaskId: task.id,
        ...(input.workstreamPostId === undefined
          ? {}
          : { workstreamPostId: input.workstreamPostId }),
      });
      if (admit) await this.#admitInboxTurn(recipient, message);
      return {
        messageId: message.id,
        session: inboxSessionKey(recipient.id),
        status: admit ? "queued" : "batched",
      };
    });
  }

  /** Runs one Tag's Mailbox deliveries and inbox admissions one at a time. */
  async #oneInbox<T>(tagId: string, run: () => Promise<T>): Promise<T> {
    const previous = this.#inboxDeliveries.get(tagId) ?? Promise.resolve();
    const current = previous.then(run);
    const settled = current.then(
      () => undefined,
      () => undefined,
    );
    this.#inboxDeliveries.set(tagId, settled);
    try {
      return await current;
    } finally {
      if (this.#inboxDeliveries.get(tagId) === settled) this.#inboxDeliveries.delete(tagId);
    }
  }

  /**
   * Admits a turn of the Tag's inbox Session for a Mailbox message, in the Tag's CLI account and
   * under its Roles only, like `supertag message tag`. The message id keys the turn, so it is
   * admitted once; the turn takes every message waiting when it starts.
   */
  async #admitInboxTurn(
    recipient: Tag,
    message: Pick<TagMessage, "id" | "senderTagId" | "sourceTaskId">,
  ): Promise<void> {
    const sender = await this.#store.findTagById(message.senderTagId);
    const senderName = sender?.name ?? message.senderTagId;
    await this.#admitInboxDelivery(recipient, {
      eventId: inboxDeliveryId(recipient.id, message.id),
      actor: { id: `tag:${message.senderTagId}`, displayName: senderName, kind: "bot" },
      internal: {
        kind: "delivery",
        from: { kind: "tag", tagId: message.senderTagId, tagName: senderName },
        reason: "inbox",
        ...(message.sourceTaskId === undefined ? {} : { startedByTaskId: message.sourceTaskId }),
      },
      admitted: { messageId: message.id },
    });
  }

  /** Admits one turn of the Tag's inbox Session, once per event id. */
  async #admitInboxDelivery(
    recipient: Tag,
    turn: {
      readonly eventId: string;
      readonly actor: InboundSurfaceEvent["actor"];
      readonly internal: Extract<InboundSurfaceEvent["internal"], { readonly kind: "delivery" }>;
      readonly text?: string;
      readonly admitted: Readonly<Record<string, unknown>>;
    },
  ): Promise<void> {
    if ((await this.#store.listTagWorkerHostBindings(recipient.id)).length === 0) return;
    const account = await this.#cliAccount();
    const route = cliTagRoute(recipient, account);
    const sessionKey = inboxSessionKey(recipient.id);
    const at = new Date().toISOString();
    const event: InboundSurfaceEvent = {
      eventId: turn.eventId,
      logicalEventId: turn.eventId,
      provider: "cli",
      externalAccountId: CLI_EXTERNAL_ACCOUNT_ID,
      kind: "message",
      scope: route.scope,
      sessionKey,
      actor: turn.actor,
      occurredAt: at,
      callback: { provider: "cli", mode: "cli_conversation", threadKey: sessionKey, target: {} },
      source: {},
      metadata: {},
      internal: turn.internal,
      ...(turn.text === undefined ? {} : { text: turn.text }),
    };
    const roles = await resolveTagRoles(this.#store, recipient.id);
    const [authorization, contextPlan] = await Promise.all([
      this.#captureAuthorization(event, account, route, recipient, at, roles),
      this.#captureContextPlan(event, account, route, at, roles),
    ]);
    const admission = await this.#store.admitInboundEvent({
      surfaceAccountId: account.id,
      tagRouteId: route.id,
      tagId: recipient.id,
      authorization,
      contextPlan,
      execution: await this.#tagExecution(recipient, roles),
      event,
      maxAttempts: this.#maxAttempts,
    });
    const task = await this.#openTask(admission.work);
    if (admission.status === "duplicate") return;
    await this.#appendTaskEvent(task.id, "task.admitted", {
      tagRouteId: route.id,
      scope: route.scope,
      ...turn.admitted,
    });
    this.#wakeTaskController?.();
  }

  /** An inbox turn that found no message waiting ends without running. */
  async #settleEmptyInboxTurn(task: Task): Promise<void> {
    const cancelled = await this.#store.cancelPendingSurfaceTask({
      taskId: task.id,
      cancelledAt: new Date().toISOString(),
    });
    if (cancelled)
      await this.#appendTaskEvent(task.id, "task.cancelled", { reason: "inbox-empty" });
  }

  /** The Mailbox messages an inbox turn handles, bound to its Task when it starts. */
  async #inboxText(task: Task): Promise<string> {
    const messages = await this.#store.bindInboxMessages(task.id, task.tagId);
    const names = new Map<string, string>();
    for (const id of new Set(messages.map((message) => message.senderTagId))) {
      const tag = await this.#store.findTagById(id);
      if (tag) names.set(id, tag.name);
    }
    return inboxTurnText(messages, names);
  }

  async #inboxSessionId(tagId: string): Promise<{ readonly inboxSessionId?: string }> {
    const session = await this.#store.findSessionByTagAndKey(tagId, inboxSessionKey(tagId));
    return session === undefined ? {} : { inboxSessionId: session.id };
  }

  /** What an internal turn's text needs besides the turn: its Objective and Team, or its starter. */
  async #internalTurnContext(work: DurableInboundEvent, task: Task): Promise<InternalTurnContext> {
    const internal = work.event.internal;
    if (internal?.kind === "delivery" && internal.objectiveId !== undefined) {
      const objective = await this.#store.getObjective(internal.objectiveId);
      const team =
        objective.teamId === null ? undefined : await this.#store.getTeam(objective.teamId);
      if (team === undefined) return { objective };
      const members = (
        await Promise.all(
          team.memberTagIds
            .filter((id) => id !== task.tagId)
            .map((id) => this.#store.findTagById(id)),
        )
      ).flatMap((tag) => (tag?.status === "active" ? [tag.name] : []));
      return { objective, team: { name: team.name, members } };
    }
    if (internal?.kind === "session_report")
      return {
        objectiveConversation: objectiveIdOfSessionKey(work.event.sessionKey) !== undefined,
      };
    if (internal?.kind === "work_session") {
      const parent = await this.#store.findSessionById(internal.parentSessionId);
      if (parent !== undefined && parent.tagId !== task.tagId)
        return { delegatedBy: (await this.#store.findTagById(parent.tagId))?.name ?? parent.tagId };
    }
    return {};
  }

  /** The one built-in SurfaceAccount that CLI conversations are recorded under. */
  async #cliAccount(): Promise<SurfaceAccount> {
    return (
      (await this.#store.findSurfaceAccount("cli", CLI_EXTERNAL_ACCOUNT_ID)) ??
      (await this.#store.saveSurfaceAccount({
        provider: "cli",
        externalAccountId: CLI_EXTERNAL_ACCOUNT_ID,
        displayName: "CLI",
        authMethod: "operator",
        credentialId: `surface/cli/${CLI_EXTERNAL_ACCOUNT_ID}`,
        status: "connected",
        configuration: {},
        verifiedAt: new Date().toISOString(),
      }))
    );
  }

  /** Opens the durable Task for one accepted unit of user intent. */
  async #openTask(work: DurableInboundEvent): Promise<Task> {
    const now = new Date().toISOString();
    const internal = work.event.internal;
    // A work Session belongs to the Session that started it: of the same Tag, or the Objective
    // conversation that delegated it to this Tag.
    const parent =
      internal?.kind === "work_session"
        ? await this.#store.findSessionById(internal.parentSessionId)
        : undefined;
    if (
      internal?.kind === "work_session" &&
      (parent === undefined || (parent.tagId !== work.tagId && parent.objectiveId === undefined))
    )
      throw new Error(
        `Session ${internal.parentSessionId} that started this work Session does not exist`,
      );
    // A work Session or report turn keeps the Workspace plan its starting turn was admitted with.
    const starting =
      internal === undefined || internal.kind === "delivery"
        ? undefined
        : await this.#store.findTaskById(internal.startedByTaskId);
    if (
      internal !== undefined &&
      internal.kind !== "delivery" &&
      (starting === undefined ||
        (starting.tagId !== work.tagId && parent?.objectiveId === undefined))
    )
      throw new Error(`Task ${internal.startedByTaskId} that started this turn does not exist`);
    const objective =
      internal?.kind === "delivery" && internal.objectiveId !== undefined
        ? await this.#store.getObjective(internal.objectiveId)
        : undefined;
    // A work Session shares its parent's audience, an Objective's conversation its home thread's,
    // and a direct conversation is private to its one person; the first open fixes the audience.
    const audienceActorKey =
      parent !== undefined
        ? parent.audienceActorKey
        : objective !== undefined
          ? await this.#homeAudience(work, objective)
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
      ...(audienceActorKey === undefined ? {} : { audienceActorKey }),
      ...(parent === undefined ? {} : { parentSessionId: parent.id }),
      ...(objective === undefined ? {} : { objectiveId: objective.id }),
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
          : objective !== undefined
            ? await this.#objectivePlan(objective, session.id)
            : (starting?.workspacePlan ?? captureWorkspacePlan(work.event, work.authorization)),
      sessionHistory,
      authorizationSnapshot: work.authorization,
      contextPlan: work.contextPlan,
      createdAt: work.createdAt,
    });
    return task;
  }

  /**
   * The audience of an Objective's conversation when it first opens: that of the Session its
   * home thread belongs to, so a direct conversation's Objective stays private to its person.
   */
  async #homeAudience(
    work: DurableInboundEvent,
    objective: Objective,
  ): Promise<string | undefined> {
    if (await this.#store.findSessionByTagAndKey(work.tagId, work.event.sessionKey))
      return undefined;
    const home = await objectiveHome(this.#store, objective, this.#operatorNotificationTaskId);
    const session = home ? await this.#store.findSessionById(home.sessionId) : undefined;
    return session?.tagId === work.tagId ? session.audienceActorKey : undefined;
  }

  /**
   * The Workspace plan of an Objective's own turns: its one Workspace, on the Session's branch,
   * or none when it names several or none.
   */
  async #objectivePlan(objective: Objective, sessionId: string): Promise<TaskWorkspacePlan> {
    const [name, ...others] = objective.workspaces ?? [];
    if (name === undefined || others.length > 0) return { version: 1, status: "none" };
    const workspace = await this.#store.findWorkspaceByName(name);
    return workspace === undefined
      ? { version: 1, status: "none" }
      : namedWorkspacePlan(workspace, workSessionBranch(sessionId));
  }

  /**
   * A work Session Task's plan for its Workspace: the plan it was opened with, or a new one on
   * the work Session's branch, which every Task of the Session continues.
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
    return namedWorkspacePlan(workspace, workSessionBranch(sessionId));
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
        (outbound.deliveryKey.startsWith("objective-budget:") ||
          outbound.deliveryKey.startsWith("objective-limit:")) &&
        !(await this.#budgetNotifications.mayDeliver(outbound))
      )
        throw new Error(
          "Operator notification was superseded, resolved, or its destination is no longer verified",
        );
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

/**
 * The source of a failed Attempt, taken from the name the Worker reported with its
 * `execution.failed` event. Never inferred from diagnostic text.
 */
function executionFailureKind(
  budgetExhausted: boolean,
  events: readonly WorkerTaskAttemptEvent[],
): { readonly failureKind?: TaskFailureKind } {
  if (budgetExhausted) return { failureKind: "budget-exhausted" };
  const failed = events.findLast((event) => event.type === "execution.failed");
  switch (failed?.type === "execution.failed" ? failed.error.name : undefined) {
    case "HarnessProviderError":
      return { failureKind: "harness" };
    case "WorkspaceSetupError":
      return { failureKind: "workspace-setup" };
    case "WorkspaceIntegrityError":
      return { failureKind: "workspace-integrity" };
    default:
      return {};
  }
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
 * Session Tasks and delivered turns use ordinary slots only.
 */
function conversationSlot(work: DurableInboundEvent): boolean {
  const internal = work.event.internal;
  return internal === undefined || internal.kind === "session_report";
}

/**
 * Whether a turn posts its progress: a conversation's own turns do. A work Session posts nowhere,
 * and an Objective's and the inbox's turns post only their reply.
 */
function showsProgress(work: DurableInboundEvent): boolean {
  const internal = work.event.internal;
  return (
    internal === undefined ||
    (internal.kind === "session_report" &&
      objectiveIdOfSessionKey(work.event.sessionKey) === undefined)
  );
}

/**
 * Whether a turn ends waiting on the question it asked or on the approval requests it left
 * pending: every turn except a conversation's own (see `sessionWaitsOnApproval`).
 */
function waitingTurn(work: DurableInboundEvent): boolean {
  return (
    work.event.internal?.kind === "work_session" ||
    objectiveIdOfSessionKey(work.event.sessionKey) !== undefined ||
    isInboxSessionKey(work.event.sessionKey)
  );
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
export {
  type ChangeKind,
  type ChangeNotice,
  ChangeNotifications,
  type ChangeResumePoint,
  type PositionedChangeNotice,
} from "./change-notifications.js";
export {
  CONVERSATION_NAME,
  cliConversationKey,
  messageConversation,
  parseCliConversationKey,
} from "./conversations.js";
export { controlPlaneEventLoopLag } from "./event-loop-lag.js";

export { type CoordinationOperatorPrincipal, ObjectiveController } from "./objective-controller.js";
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
export type { ReplyStreamPart } from "./reply-streams.js";
export {
  resolveOwnerObjectiveRuntimeActions,
  tagExecutionRange,
  tagRuntimeActions,
} from "./roles.js";
export { SessionPersistence } from "./session-persistence.js";
export { observeStoreChanges } from "./store-changes.js";
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
