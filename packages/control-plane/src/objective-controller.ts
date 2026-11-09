import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import {
  type CoordinationInboxPage,
  type DurableInboundEvent,
  effectiveWorkerHostLabels,
  isInboxSessionKey,
  mailboxObject,
  mailboxText,
  type Objective,
  type ObjectiveLimitCandidate,
  objectiveCancellationNotice,
  objectiveClosed,
  objectiveCompletionNotice,
  objectiveDeadlineGraceMs,
  objectiveDeadlineNotices,
  objectiveDeadlineStopsRunning,
  objectiveHasReportedBudget,
  objectiveIdOfSessionKey,
  objectiveLimitEvents,
  objectiveResumeSummary,
  parseObjectiveStatus,
  parsePost,
  parseSendMessage,
  parseSurfaceObjectiveCommand,
  type ReadCoordinationInboxInput,
  type Store,
  TAG_MESSAGE_TEXT_MAX,
  TagMessagingError,
  type Task,
  type TaskAttempt,
  type Team,
  tagMessageText,
} from "@supertag/core";
import type { Worklet } from "@supertag/worker-sdk";
import { ApprovalCoordinator, sessionWaitsOnApproval } from "./approvals.js";
import { objectiveBudgetReport, type TaskBudgetReport, taskBudgetReport } from "./budget-report.js";
import {
  evaluateObjectiveLimits,
  limitStateChanged,
  objectiveShouldLimit,
  reportedSpend,
} from "./objective-limits.js";
import {
  buildObjectiveOverview,
  type ObjectiveOverview,
  type ObjectiveOverviewInput,
} from "./objective-overview.js";
import {
  harnessSignInAttempt,
  type ObjectiveRunnableCondition,
  type ObjectiveRunnableFacts,
  objectiveRunnableCondition,
  objectiveRuntimeActionWarnings,
} from "./objective-runnable.js";
import { objectiveSummary } from "./objective-summary.js";
import type { MessageObjectiveResult, SessionHandlers } from "./session-handlers.js";
import { SuspendDetector, type SystemWake } from "./suspend-detector.js";
import {
  conversationViewer,
  isTagSessionTool,
  TAG_SESSION_TOOLS,
  tagSessionCommand,
} from "./tag-sessions.js";
import {
  ASK_TOOL,
  CONTINUE_SESSION_TOOL,
  parseAsk,
  parseContinueSession,
  parseStartSession,
  START_SESSION_TOOL,
  WORK_SESSION_ASKED_EVENT,
} from "./work-sessions.js";
import { describeWorklet } from "./worklet-descriptor.js";
import {
  type WorkspacePullRequestHandler,
  WorkspacePullRequestLifecycle,
} from "./workspace-pull-requests.js";

/** A verified Surface Attempt calling a coordination tool. */
export interface CoordinationCaller {
  readonly kind: "surface";
  readonly taskId: string;
  readonly attemptId: string;
}

/** Authenticated server-side identity for coordination administration. */
export interface CoordinationOperatorPrincipal {
  readonly operatorId: string;
  readonly scopes: {
    /** Exact coordination action names, or `*` for a break-glass principal. */
    readonly actions: readonly string[];
    /** Omission means every Objective. */
    readonly objectiveIds?: readonly string[];
  };
}

const EMBEDDED_BREAK_GLASS_PRINCIPAL: CoordinationOperatorPrincipal = {
  operatorId: "embedded-break-glass",
  scopes: { actions: ["*"] },
};

/** Reported spend is recomputed from persisted evidence, so the sweep is rate-limited. */
const LIMIT_SWEEP_INTERVAL_MS = 10_000;
/** Notice keys remembered as handed over, so each sweep skips them. */
const NOTICE_MEMORY = 4096;

/** What kind of turn a Task is: it decides the tools the Task gets. */
type Turn = "objective" | "inbox" | "conversation" | "report" | "work_session";

const SESSION_READS: readonly string[] = ["list_sessions", "search_sessions", "read_session"];
const INBOX_TOOLS: readonly string[] = [
  START_SESSION_TOOL,
  CONTINUE_SESSION_TOOL,
  "send_message",
  "post",
  "read_workstream",
  "read_objective",
  ...TAG_SESSION_TOOLS,
];
/** The tools each turn gets; `request_action_approval` is hidden and open to every turn. */
const TURN_TOOLS: Readonly<Record<Turn, readonly string[]>> = {
  objective: [
    START_SESSION_TOOL,
    CONTINUE_SESSION_TOOL,
    ASK_TOOL,
    "send_message",
    "post",
    "read_workstream",
    "update_objective",
    "read_objective",
    ...SESSION_READS,
  ],
  inbox: INBOX_TOOLS,
  conversation: ["create_objective", ...INBOX_TOOLS],
  report: ["read_objective", ...TAG_SESSION_TOOLS],
  work_session: [ASK_TOOL],
};
const TURN_REFUSAL: Readonly<Record<Turn, string>> = {
  objective: "An Objective's turn cannot use this tool",
  inbox: "An inbox turn cannot use this tool",
  conversation: "A conversation turn cannot use this tool",
  report: "A report turn cannot start or continue Sessions, message Tags or change Objectives",
  work_session:
    "A work Session sees only its own work: it cannot read other Sessions or Objectives, start or continue Sessions, message Tags or change Objectives. Use ask",
};

function turnOf(inbound: Pick<DurableInboundEvent, "sessionKey" | "event">): Turn {
  if (objectiveIdOfSessionKey(inbound.sessionKey) !== undefined) return "objective";
  if (isInboxSessionKey(inbound.sessionKey)) return "inbox";
  const internal = inbound.event.internal?.kind;
  if (internal === "work_session") return "work_session";
  if (internal === "session_report") return "report";
  return "conversation";
}

type ObjectivePersistence = Pick<
  Store,
  | "appendTaskEvent"
  | "cancelObjective"
  | "createSurfaceObjective"
  | "decideApprovalRequest"
  | "expireApprovalRequest"
  | "findInboundEventById"
  | "findSurfaceAccountById"
  | "findTagById"
  | "findTagByName"
  | "findTaskById"
  | "findVisibleObjective"
  | "findVisibleSession"
  | "findWorkspaceByName"
  | "getApprovalRequest"
  | "getObjective"
  | "getSurfaceObjective"
  | "getTeam"
  | "listApprovalRequests"
  | "listExecutingObjectives"
  | "listObjectiveSessions"
  | "listSessionTaskIds"
  | "listTagWorkerHostBindings"
  | "listTaskAttempts"
  | "listTaskEvents"
  | "listTaskHistory"
  | "listTeamPosts"
  | "listTeamsOfTag"
  | "listVisibleOpenObjectives"
  | "listVisibleSessions"
  | "listWorkerHosts"
  | "pauseObjective"
  | "post"
  | "readCoordinationInbox"
  | "readSpend"
  | "recordObjectiveLimitState"
  | "requestActionApproval"
  | "resumeObjective"
  | "saveWorkspacePullRequestTransition"
  | "listDueWorkspacePullRequestTransitions"
  | "deleteWorkspacePullRequestTransition"
  | "searchVisibleSessions"
  | "sessionTaskSummaries"
  | "updateObjectiveStatus"
>;

/**
 * The Objective side of the Control Plane: coordination credentials, the tool router for Surface
 * Attempts, approvals, operator actions on Objectives, and the periodic Objective sweep. Every
 * Objective turn runs on the generic dispatcher, which installs its Session mechanics with
 * `setSessionHandlers`.
 */
export class ObjectiveController {
  private secret = randomBytes(32);
  /** Gives Surface Attempts a grace to renew leases after the process was suspended. */
  readonly suspend = new SuspendDetector();
  private readonly systemWakeReader: (() => Promise<SystemWake | undefined>) | undefined;
  private readonly surfaceLeaseOwner: string | undefined;
  private readonly surfaceAttemptsRunning: () => boolean;
  private systemWakeReadAt = 0;
  private controlPlaneUrl: string | undefined;
  private handlers: SessionHandlers | undefined;
  private inboxEnricher:
    | ((page: CoordinationInboxPage) => Promise<CoordinationInboxPage>)
    | undefined;
  private inboxChanged: (() => void) | undefined;
  private readonly approvals: ApprovalCoordinator;
  private readonly pullRequests: WorkspacePullRequestLifecycle;
  private readonly limitSweepIntervalMs: number;
  private readonly deadlineGraceMs: number | undefined;
  private lastLimitSweep = 0;
  /** Budget reports of ended Tasks, by Objective then Task, valid while the Task is unchanged. */
  private readonly endedTaskBudgets = new Map<
    string,
    Map<string, { readonly updatedAt: string; readonly budget: TaskBudgetReport }>
  >();
  /** Notice keys already handed to the Session handlers, oldest first. */
  private readonly handedNotices = new Set<string>();

  constructor(
    private readonly store: ObjectivePersistence,
    private readonly worklet: Worklet | undefined,
    private readonly onError: (error: unknown) => void = () => {},
    options: {
      /** Minimum time between Objective limit sweeps; tests shorten it. */
      readonly limitSweepIntervalMs?: number;
      /**
       * How long running Task Attempts keep authority after the deadline; tests override it.
       * Defaults to 15 minutes, capped at a quarter of a short deadline window.
       */
      readonly deadlineGraceMs?: number;
      /** Reads the host's latest system wake; the Control Plane passes the macOS reader. */
      readonly systemWake?: () => Promise<SystemWake | undefined>;
      /** The lease owner of Surface Attempts this Control Plane runs; they share the grace. */
      readonly surfaceLeaseOwner?: string;
      /** Whether this Control Plane runs Surface Attempts, so it polls system wakes for them. */
      readonly surfaceAttemptsRunning?: () => boolean;
    } = {},
  ) {
    this.systemWakeReader = options.systemWake;
    this.surfaceLeaseOwner = options.surfaceLeaseOwner;
    this.surfaceAttemptsRunning = options.surfaceAttemptsRunning ?? (() => false);
    this.limitSweepIntervalMs = options.limitSweepIntervalMs ?? LIMIT_SWEEP_INTERVAL_MS;
    this.deadlineGraceMs = options.deadlineGraceMs;
    this.approvals = new ApprovalCoordinator(store, onError);
    this.pullRequests = new WorkspacePullRequestLifecycle(store, undefined, onError);
  }

  /** Installs what the dispatcher does for Session tools and Objective entry points. */
  setSessionHandlers(handlers: SessionHandlers) {
    this.handlers = handlers;
    this.approvals.setDecisionListener((request) => handlers.approvalDecided(request));
  }
  setInboxChangeListener(listener: () => void) {
    this.inboxChanged = listener;
  }
  setInboxEnricher(enrich: (page: CoordinationInboxPage) => Promise<CoordinationInboxPage>) {
    this.inboxEnricher = enrich;
  }
  /** Provider calls that mark Workspace pull requests ready or close them as Tasks end. */
  setWorkspacePullRequestHandler(handler: WorkspacePullRequestHandler | undefined) {
    this.pullRequests.setHandler(handler);
  }

  private sessions(): SessionHandlers {
    if (!this.handlers)
      throw new TagMessagingError(503, "Sessions are unavailable on this Control Plane");
    return this.handlers;
  }

  get executionReadiness(): "awaiting-coordination" | "awaiting-worklet" | "ready" {
    if (!this.controlPlaneUrl) return "awaiting-coordination";
    if (!this.worklet) return "awaiting-worklet";
    return "ready";
  }

  /** Activates coordination once the host knows its bound, reachable endpoint. */
  activateCoordination({
    url,
    signingKey,
  }: {
    readonly url: string;
    readonly signingKey?: Uint8Array;
  }) {
    if (signingKey !== undefined) {
      if (signingKey.byteLength !== 32)
        throw new Error("Coordination signing key must be 32 bytes");
      this.secret = Buffer.from(signingKey);
    }
    this.controlPlaneUrl = url.replace(/\/$/u, "");
  }

  /**
   * One pass of the Objective sweep, on the dispatcher's cadence: limits and their notices,
   * expiry of approval requests whose Task finished, approval digests to home threads, and due
   * pull-request retries.
   */
  async sweep(): Promise<void> {
    this.suspend.observe();
    await this.pollSystemWake();
    await this.sweepObjectiveLimits();
    await this.approvals.expireFinished().catch(this.onError);
    await this.reportApprovalNotices();
    await this.pullRequests.retryDue();
  }

  /** Moves a finished Task's Workspace pull request: ready when completed, closed when cancelled. */
  settleWorkspacePullRequest(task: Task): Promise<void> {
    return this.pullRequests.settle(task);
  }

  // Credentials and authentication.

  async surfaceCoordination(
    task: Task,
    attempt: TaskAttempt,
  ): Promise<
    { controlPlaneUrl: string; token: string; scope: "surface"; objectiveId?: string } | undefined
  > {
    if (!this.controlPlaneUrl) return undefined;
    await this.surfaceState(task.id, attempt.id);
    const objectiveId = task.objectiveId ?? (await this.store.getSurfaceObjective(task.id))?.id;
    return {
      controlPlaneUrl: this.controlPlaneUrl,
      scope: "surface",
      token: this.sign({ kind: "surface", id: task.id, attemptId: attempt.id }),
      ...(objectiveId === undefined ? {} : { objectiveId }),
    };
  }
  /** Private Session storage is independent of coordination. */
  async sessionPersistence(
    task: Task,
    attempt: TaskAttempt,
  ): Promise<{ readonly controlPlaneUrl: string; readonly token: string } | undefined> {
    if (!this.controlPlaneUrl) return undefined;
    await this.surfaceExecutionState(task.id, attempt.id);
    return {
      controlPlaneUrl: this.controlPlaneUrl,
      token: this.sign({ kind: "session", id: task.id, attemptId: attempt.id }),
    };
  }
  async authenticateExecution(token: string | undefined): Promise<CoordinationCaller> {
    const value = this.verifiedCredential(token);
    if (value.kind !== "surface")
      throw new TagMessagingError(403, "Session credential cannot authorize coordination");
    await this.surfaceState(value.id, value.attemptId);
    return { kind: "surface", taskId: value.id, attemptId: value.attemptId };
  }
  async authenticateSessionExecution(token: string | undefined): Promise<CoordinationCaller> {
    const value = this.verifiedCredential(token);
    if (value.kind !== "session") return this.authenticateExecution(token);
    await this.surfaceExecutionState(value.id, value.attemptId);
    return { kind: "surface", taskId: value.id, attemptId: value.attemptId };
  }
  /**
   * Artifact access follows the Session boundary: a Task reads its own Session's artifacts, and a
   * Task of an Objective reads those of every Session of that Objective.
   */
  async authorizeArtifactSource(caller: CoordinationCaller, sourceTaskId: string): Promise<void> {
    const [current, source] = await Promise.all([
      this.store.findTaskById(caller.taskId),
      this.store.findTaskById(sourceTaskId),
    ]);
    const visible =
      current !== undefined &&
      source !== undefined &&
      ((current.sessionId === source.sessionId && current.tagId === source.tagId) ||
        (current.objectiveId !== undefined && current.objectiveId === source.objectiveId));
    if (!visible) throw new TagMessagingError(404, "Artifact not found");
  }
  /**
   * Whether a Surface Attempt's inbound-event lease is current. A lease this Control Plane owns
   * also counts during a suspend grace if it was still valid when the suspend began.
   */
  surfaceLeaseCurrent(inbound: {
    readonly leaseOwner?: string | null | undefined;
    readonly leaseExpiresAt?: string | null | undefined;
  }): boolean {
    if (!inbound.leaseOwner || !inbound.leaseExpiresAt) return false;
    if (inbound.leaseExpiresAt > new Date().toISOString()) return true;
    if (inbound.leaseOwner !== this.surfaceLeaseOwner) return false;
    const now = Date.now();
    this.suspend.observe(now);
    return this.suspend.leaseCurrent(inbound.leaseExpiresAt, now);
  }
  /**
   * Polls the host's latest wake while Surface Attempts run, at most every 10 seconds. Each
   * sweep calls it; tests call it directly.
   */
  async pollSystemWake() {
    if (!this.systemWakeReader || !this.surfaceAttemptsRunning()) return;
    const now = Date.now();
    if (now - this.systemWakeReadAt < 10_000) return;
    this.systemWakeReadAt = now;
    const wake = await this.systemWakeReader().catch(() => undefined);
    if (wake) this.suspend.systemWake(wake, Date.now());
  }
  private sign(value: { kind: "surface" | "session"; id: string; attemptId: string }): string {
    const body = Buffer.from(JSON.stringify(value)).toString("base64url");
    return `${body}.${createHmac("sha256", this.secret).update(body).digest("base64url")}`;
  }
  private verifiedCredential(token: string | undefined): {
    readonly kind: "surface" | "session";
    readonly id: string;
    readonly attemptId: string;
  } {
    if (!token || token.length > 4096)
      throw new TagMessagingError(401, "Attempt credential required");
    const [body, signature, ...rest] = token.split(".");
    if (!body || !signature || rest.length > 0)
      throw new TagMessagingError(401, "Invalid attempt credential");
    const expected = createHmac("sha256", this.secret).update(body).digest();
    const actual = Buffer.from(signature, "base64url");
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual))
      throw new TagMessagingError(401, "Invalid attempt credential");
    let value: unknown;
    try {
      value = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    } catch {
      throw new TagMessagingError(401, "Invalid attempt credential");
    }
    const record = value as Record<string, unknown> | null;
    if (
      !record ||
      typeof record !== "object" ||
      Array.isArray(record) ||
      (record["kind"] !== "surface" && record["kind"] !== "session") ||
      typeof record["id"] !== "string" ||
      typeof record["attemptId"] !== "string"
    )
      throw new TagMessagingError(401, "Invalid attempt credential");
    return {
      kind: record["kind"],
      id: record["id"],
      attemptId: record["attemptId"],
    };
  }
  /**
   * A conversation turn needs a person's verified request. A turn SuperTag admitted itself (a
   * work Session, a report, or a delivery to an Objective or an inbox) carries no human command
   * and is authorized by its admitted snapshot.
   */
  private async surfaceState(taskId: string, attemptId: string) {
    const state = await this.surfaceExecutionState(taskId, attemptId);
    if (
      state.inbound.event.internal === undefined &&
      (state.task.actor.kind !== "user" || state.inbound.event.actor.kind !== "user")
    )
      throw new TagMessagingError(403, "Authenticated human surface request required");
    return state;
  }
  private async surfaceExecutionState(taskId: string, attemptId: string) {
    const task = await this.store.findTaskById(taskId);
    if (
      task?.status !== "running" ||
      task.authorizationSnapshot.version !== 5 ||
      !task.inboundEventId
    )
      throw new TagMessagingError(401, "Surface Task authority expired");
    const attempts = await this.store.listTaskAttempts(taskId);
    const attempt = attempts.toSorted((a, b) => b.attemptNumber - a.attemptNumber)[0];
    const inbound = await this.store.findInboundEventById(task.inboundEventId);
    if (
      !attempt ||
      attempt.id !== attemptId ||
      attempt.taskId !== taskId ||
      attempt.status !== "running" ||
      !inbound ||
      inbound.status !== "processing" ||
      !this.surfaceLeaseCurrent(inbound) ||
      inbound.attemptCount !== attempt.attemptNumber ||
      inbound.tagId !== task.tagId
    )
      throw new TagMessagingError(401, "Surface Attempt lease expired");
    const tag = await this.store.findTagById(task.tagId);
    if (
      tag?.status !== "active" ||
      task.actor.kind !== inbound.event.actor.kind ||
      task.actor.id !== inbound.event.actor.id
    )
      throw new TagMessagingError(403, "Authenticated surface request required");
    return { task, attempt, inbound };
  }

  // The tool router.

  /** The tools the caller's turn gets, by the table in TURN_TOOLS. */
  async coordinationActions(caller: CoordinationCaller): Promise<readonly string[]> {
    const task = await this.store.findTaskById(caller.taskId);
    const inbound = task?.inboundEventId
      ? await this.store.findInboundEventById(task.inboundEventId)
      : undefined;
    return inbound ? TURN_TOOLS[turnOf(inbound)] : [];
  }

  async commandAsAttempt(
    name: string,
    value: unknown,
    caller: CoordinationCaller,
  ): Promise<unknown> {
    // Runtime callers can omit a TypeScript-required argument.
    if (typeof caller !== "object" || caller === null)
      throw new TagMessagingError(401, "Attempt caller required");
    if (typeof value !== "object" || value === null || Array.isArray(value))
      throw new TagMessagingError(400, "Command arguments must be an object");
    const result = await this.command(name, value as Record<string, unknown>, caller);
    this.inboxChanged?.();
    return result;
  }

  private async command(
    name: string,
    input: Record<string, unknown>,
    caller: CoordinationCaller,
  ): Promise<unknown> {
    const { task, inbound } = await this.surfaceState(caller.taskId, caller.attemptId);
    const turn = turnOf(inbound);
    if (name === "request_action_approval")
      return this.requestActionApproval(task, inbound, caller.attemptId, input);
    if (!TURN_TOOLS[turn].includes(name)) throw new TagMessagingError(403, TURN_REFUSAL[turn]);
    if (name === ASK_TOOL) return this.ask(task, caller.attemptId, turn, input);
    if (name === START_SESSION_TOOL) {
      const { tag, ...rest } = input;
      const request = parseStartSession(rest);
      if (tag !== undefined && turn !== "objective")
        throw new TagMessagingError(
          403,
          "Only an Objective's turn starts a work Session of another Tag; start one of your own",
        );
      return this.sessions().start(
        task,
        inbound,
        tag === undefined ? request : { ...request, tag: mailboxText(tag, "tag") },
      );
    }
    if (name === CONTINUE_SESSION_TOOL)
      return this.sessions().continue(task, inbound, parseContinueSession(input));
    if (name === "send_message") return this.sessions().sendMessage(task, parseSendMessage(input));
    if (name === "post") return this.post(task, turn, input);
    if (name === "read_workstream") return this.readWorkstream(task, turn, input);
    if (name === "create_objective") return this.createObjective(task, inbound, input);
    if (name === "update_objective") return this.updateObjective(task, input);
    if (name === "read_objective") return this.readObjective(task, inbound, turn, input);
    if (isTagSessionTool(name))
      return tagSessionCommand(this.store, name, input, conversationViewer(task, inbound));
    throw new TagMessagingError(404, "Unknown coordination command");
  }

  /**
   * A gated action. Every turn except a conversation's own ends waiting on a pending request:
   * its conversation or the operator is told, and the decision continues the Session.
   */
  private async requestActionApproval(
    task: Task,
    inbound: DurableInboundEvent,
    attemptId: string,
    input: Record<string, unknown>,
  ) {
    const result = await this.approvals.requestAction(
      {
        taskId: task.id,
        attemptId,
        tagId: task.tagId,
        objectiveId: task.objectiveId ?? null,
      },
      input,
    );
    if (
      !sessionWaitsOnApproval(inbound) ||
      result.status !== "pending" ||
      result.requestId === undefined
    )
      return result;
    await this.sessions()
      .approvalNotice(task, inbound, result.requestId)
      .catch((error: unknown) => this.onError(error));
    return {
      ...result,
      next: `End your turn now with a brief final reply and no further tool call. This Task ends waiting on approval of request ${result.requestId}, and the person who decides it has been told. When the request is approved or denied, this Session continues as its next Task with the decision; an approved call succeeds when you retry it then.`,
    };
  }

  /** `ask`: the Task ends waiting on a person's answer, which arrives as the Session's next turn. */
  private async ask(task: Task, attemptId: string, turn: Turn, input: Record<string, unknown>) {
    const question = parseAsk(input);
    if (
      (await this.store.listTaskEvents(task.id)).some(
        (event) => event.type === WORK_SESSION_ASKED_EVENT && event.attemptId === attemptId,
      )
    )
      throw new TagMessagingError(
        409,
        "This Task already asked its question; end your turn now with a brief final reply",
      );
    await this.store.appendTaskEvent({
      taskId: task.id,
      attemptId,
      type: WORK_SESSION_ASKED_EVENT,
      payload: { version: 1, question },
    });
    return {
      status: "asked",
      next:
        turn === "objective"
          ? "End your turn now with a brief final reply and no further tool call. This Task ends waiting on the operator: the Objective's thread asks them, and their answer arrives as this conversation's next turn."
          : "End your turn now with a brief final reply and no further tool call. This Task ends waiting on the person: the conversation asks them, and their answer continues this work Session as its next Task.",
    };
  }

  /** The Team a turn's Workstream tools use: its Objective's Team, else the Tag's only Team. */
  private async workstreamTeam(task: Task, turn: Turn): Promise<Team> {
    if (turn === "objective" && task.objectiveId !== undefined) {
      const objective = await this.store.getObjective(task.objectiveId);
      if (objective.teamId === null)
        throw new TagMessagingError(409, "This Objective names no Team, so it has no Workstream");
      const team = await this.store.getTeam(objective.teamId);
      if (!team) throw new TagMessagingError(404, "The Objective's Team no longer exists");
      return team;
    }
    const teams = await this.store.listTeamsOfTag(task.tagId);
    const [only] = teams;
    if (teams.length === 1 && only) return only;
    throw new TagMessagingError(
      409,
      teams.length === 0
        ? "This Tag is in no Team, so it has no Workstream"
        : `This Tag is in several Teams (${teams.map((team) => team.name).join(", ")}); only an Objective's turn has one Workstream`,
    );
  }

  /** An active Tag's ID from its ID or name. */
  private async activeTagId(reference: string): Promise<string> {
    const byId = await this.store.findTagById(reference);
    if (byId?.status === "active") return byId.id;
    const byName = await this.store.findTagByName(reference);
    if (byName?.status === "active") return byName.id;
    throw new TagMessagingError(404, `No active Tag is named ${reference}`);
  }

  /** `post`: a Workstream post; each Tag it addresses receives it in its inbox. */
  private async post(task: Task, turn: Turn, input: Record<string, unknown>) {
    const { text, to } = parsePost(input);
    const team = await this.workstreamTeam(task, turn);
    const addressed = await Promise.all((to ?? []).map((tag) => this.activeTagId(tag)));
    const outsider = addressed.find((tagId) => !team.memberTagIds.includes(tagId));
    if (outsider !== undefined)
      throw new TagMessagingError(403, `Tag ${outsider} is not a member of Team ${team.name}`);
    const { post, duplicate } = await this.store.post({
      teamId: team.id,
      authorTagId: task.tagId,
      body: text,
      ...(addressed.length ? { to: addressed } : {}),
      sourceTaskId: task.id,
    });
    const delivered = duplicate
      ? []
      : await Promise.all(
          post.to
            .filter((tagId) => tagId !== task.tagId)
            .map((tagId) =>
              this.sessions().sendMessage(task, {
                to: tagId,
                text: post.body.slice(0, TAG_MESSAGE_TEXT_MAX),
                workstreamPostId: post.id,
              }),
            ),
        );
    return {
      post: { id: post.id, team: team.name, sequence: post.sequence, to: post.to },
      duplicate,
      delivered,
    };
  }

  private async readWorkstream(task: Task, turn: Turn, input: Record<string, unknown>) {
    const record = mailboxObject(input, ["afterSequence", "limit"]);
    const afterSequence = record["afterSequence"];
    const limit = record["limit"] ?? 50;
    if (
      afterSequence !== undefined &&
      (!Number.isSafeInteger(afterSequence) || (afterSequence as number) < 0)
    )
      throw new TagMessagingError(400, "afterSequence must be a nonnegative integer");
    if (!Number.isSafeInteger(limit) || (limit as number) < 1 || (limit as number) > 100)
      throw new TagMessagingError(400, "limit must be an integer between 1 and 100");
    const team = await this.workstreamTeam(task, turn);
    return {
      team: team.name,
      posts: await this.store.listTeamPosts(team.id, {
        limit: limit as number,
        ...(afterSequence === undefined ? {} : { afterSequence: afterSequence as number }),
      }),
    };
  }

  /** `create_objective`, only on an explicit objective command; its conversation starts at once. */
  private async createObjective(
    task: Task,
    inbound: DurableInboundEvent,
    input: Record<string, unknown>,
  ) {
    if (parseSurfaceObjectiveCommand(inbound.event)?.kind !== "create")
      throw new TagMessagingError(
        403,
        "Creating an Objective requires an explicit objective command",
      );
    mailboxObject(input, [
      "outcome",
      "deadline",
      "budgetLimitMinor",
      "budgetCurrency",
      "workspaces",
    ]);
    const created = await this.store.createSurfaceObjective({
      taskId: task.id,
      outcome: input["outcome"] as string,
      ...(input["deadline"] === undefined ? {} : { deadline: input["deadline"] as string }),
      ...(input["budgetLimitMinor"] === undefined
        ? {}
        : { budgetLimitMinor: input["budgetLimitMinor"] as number }),
      ...(input["budgetCurrency"] === undefined
        ? {}
        : { budgetCurrency: input["budgetCurrency"] as string }),
      ...(input["workspaces"] === undefined ? {} : { workspaces: input["workspaces"] as string[] }),
    });
    // Conditions that would hold or limit the new Objective's turns, for the person to act on.
    // Its runtime actions are what this request's Tag may use here.
    const warnings = [
      ...objectiveRuntimeActionWarnings({
        objectiveId: created.id,
        owner: task.authorizationSnapshot.tag,
        allowed: created.runtimeActions ?? [],
      }),
      ...(await this.objectiveRunnable(created)).reasons,
    ];
    try {
      const { taskId } = await this.sessions().startObjective(created.id);
      return { ...created, started: { taskId }, warnings };
    } catch (error) {
      if (!(error instanceof TagMessagingError)) throw error;
      return {
        ...created,
        warnings: [...warnings, `The Objective was created but did not start: ${error.message}`],
      };
    }
  }

  /** `update_objective` from an Objective's own turn: status and summary only. */
  private async updateObjective(task: Task, input: Record<string, unknown>) {
    if (task.objectiveId === undefined)
      throw new TagMessagingError(403, "Only an Objective's turn may update it");
    const { objectiveId, ...rest } = input;
    if (objectiveId !== undefined && objectiveId !== task.objectiveId)
      throw new TagMessagingError(403, "A turn may update only its own Objective");
    const previous = await this.store.getObjective(task.objectiveId);
    const updated = await this.store.updateObjectiveStatus(
      previous.id,
      parseObjectiveStatus(rest),
      task.tagId,
      undefined,
      { taskId: task.id },
    );
    if (updated.status === "completed" && previous.status !== "completed")
      await this.settleCompletedObjective(updated, task.id);
    return updated;
  }

  /** `read_objective`: an Objective's own, or one the Tag owns that this conversation may see. */
  private async readObjective(
    task: Task,
    inbound: DurableInboundEvent,
    turn: Turn,
    input: Record<string, unknown>,
  ) {
    mailboxObject(input, ["objectiveId"]);
    const requested =
      input["objectiveId"] === undefined
        ? undefined
        : mailboxText(input["objectiveId"], "objectiveId");
    const own =
      task.objectiveId === undefined ? undefined : await this.store.getObjective(task.objectiveId);
    if (turn === "objective" && requested !== undefined && requested !== own?.id)
      throw new TagMessagingError(403, "An Objective's turn reads only its own Objective");
    const bound = own ?? (await this.store.getSurfaceObjective(task.id));
    const objective =
      requested === undefined || requested === bound?.id
        ? bound
        : await this.store.findVisibleObjective(conversationViewer(task, inbound), requested);
    if (!objective)
      throw new TagMessagingError(404, "No matching Objective is visible to this conversation");
    const [sessions, team] = await Promise.all([
      this.store.listObjectiveSessions(objective.id),
      objective.teamId === null ? undefined : this.store.getTeam(objective.teamId),
    ]);
    return objectiveSummary({
      objective,
      sessions,
      team,
      tagNames: await this.tagNames([
        objective.ownerTagId,
        ...sessions.map((session) => session.tagId),
        ...(team?.memberTagIds ?? []),
      ]),
    });
  }

  /** Display names for Tag IDs; IDs that no longer resolve keep no entry. */
  private async tagNames(ids: readonly string[]): Promise<Record<string, string>> {
    const names: Record<string, string> = {};
    for (const id of new Set(ids)) {
      const tag = await this.store.findTagById(id).catch(() => undefined);
      if (tag) names[id] = tag.name;
    }
    return names;
  }

  // Operator actions.

  /** One approval request by id, for notices. */
  getApprovalRequest(id: string) {
    return this.approvals.get(id);
  }

  /** Operator listing of approval requests, scoped like the coordination inbox. */
  async listApprovalRequests(
    input: {
      readonly objectiveId?: string;
      readonly status?: string;
      readonly before?: { readonly createdAt: string; readonly id: string };
      readonly limit?: number;
    },
    principal: CoordinationOperatorPrincipal = EMBEDDED_BREAK_GLASS_PRINCIPAL,
  ) {
    this.authorizeOperatorAction("list_approvals", principal);
    const objectiveId = this.scopedObjectiveId(input.objectiveId, principal);
    const status = input.status === undefined || input.status === "all" ? undefined : input.status;
    if (status !== undefined && !["pending", "approved", "denied", "expired"].includes(status))
      throw new TagMessagingError(400, "status must be pending, approved, denied, expired, or all");
    return this.approvals.list({
      ...(objectiveId === undefined ? {} : { objectiveId }),
      ...(status === undefined
        ? {}
        : { status: status as "pending" | "approved" | "denied" | "expired" }),
      ...(input.before === undefined ? {} : { before: input.before }),
      ...(input.limit === undefined ? {} : { limit: input.limit }),
    });
  }

  /** Operator decision on one approval request; the decision continues the waiting Session. */
  async decideApprovalRequest(
    input: unknown,
    principal: CoordinationOperatorPrincipal = EMBEDDED_BREAK_GLASS_PRINCIPAL,
  ) {
    this.authorizeOperatorAction("decide_approval", principal);
    const requestId =
      input && typeof input === "object" && !Array.isArray(input)
        ? (input as Record<string, unknown>)["requestId"]
        : undefined;
    const request = await this.approvals.get(mailboxText(requestId, "requestId"));
    if (!request) throw new TagMessagingError(404, "Approval request not found");
    if (request.objectiveId) this.authorizeOperatorObjective(request.objectiveId, principal);
    else if (principal.scopes.objectiveIds !== undefined)
      throw new TagMessagingError(403, "Operator is not permitted to decide this request");
    const decided = await this.approvals.decideAsOperator(input, principal.operatorId);
    this.inboxChanged?.();
    return decided;
  }

  /** An operator's message to the Objective's conversation: the owner's next turn. */
  async messageObjective(
    input: {
      readonly objectiveId: string;
      readonly text: string;
      readonly idempotencyKey?: string;
    },
    principal: CoordinationOperatorPrincipal = EMBEDDED_BREAK_GLASS_PRINCIPAL,
  ): Promise<MessageObjectiveResult> {
    this.authorizeOperatorAction("message_objective", principal);
    const objectiveId = mailboxText(input.objectiveId, "objectiveId");
    this.authorizeOperatorObjective(objectiveId, principal);
    const result = await this.sessions().messageObjective({
      objectiveId,
      // Free-form prose, not an identifier: an operator message becomes the owner's next turn.
      text: tagMessageText(input.text),
      operatorId: principal.operatorId,
      idempotencyKey:
        input.idempotencyKey === undefined
          ? randomUUID()
          : mailboxText(input.idempotencyKey, "idempotencyKey"),
    });
    this.inboxChanged?.();
    return result;
  }

  /**
   * Completes an Objective its owner marked ready_for_review. The owner's recorded assessment
   * becomes the completion summary; without one, the summary records the operator approval.
   */
  async approveObjective(
    input: { readonly objectiveId: string },
    principal: CoordinationOperatorPrincipal = EMBEDDED_BREAK_GLASS_PRINCIPAL,
  ): Promise<Objective> {
    this.authorizeOperatorAction("update_objective", principal);
    const objectiveId = mailboxText(input.objectiveId, "objectiveId");
    this.authorizeOperatorObjective(objectiveId, principal);
    const objective = await this.store.getObjective(objectiveId);
    if (objective.status !== "ready_for_review")
      throw new TagMessagingError(
        409,
        objective.status === "completed"
          ? `Objective ${objective.id} is already completed`
          : objective.status === "cancelled"
            ? `Objective ${objective.id} is cancelled`
            : `Objective ${objective.id} is ${objective.status}, not ready_for_review. Only a result the owner submitted for review can be approved; send changes with supertag message objective ${objective.id} TEXT`,
      );
    const completed = await this.store.updateObjectiveStatus(
      objective.id,
      {
        status: "completed",
        expectedRevision: objective.revision,
        completionSummary:
          objective.completionSummary?.trim() ||
          `Approved by operator ${principal.operatorId}. The owner recorded no assessment.`,
      },
      undefined,
      undefined,
      { operatorId: principal.operatorId },
    );
    await this.settleCompletedObjective(completed);
    return completed;
  }

  /**
   * Operator cancellation: the Objective becomes cancelled, every open Task of its Sessions is
   * cancelled and their pending turns fail. Repeating it on a cancelled Objective changes nothing
   * but retries any Task an earlier call left open.
   */
  async cancelObjective(
    input: { readonly objectiveId: string; readonly reason?: string | null },
    principal: CoordinationOperatorPrincipal = EMBEDDED_BREAK_GLASS_PRINCIPAL,
  ): Promise<{
    readonly objective: Objective;
    readonly changed: boolean;
    readonly cancelledTaskIds: readonly string[];
  }> {
    this.authorizeOperatorAction("cancel_objective", principal);
    const objectiveId = mailboxText(input.objectiveId, "objectiveId");
    this.authorizeOperatorObjective(objectiveId, principal);
    const { objective, changed } = await this.store.cancelObjective(
      objectiveId,
      { reason: input.reason ?? null },
      { operatorId: principal.operatorId },
    );
    const { cancelledTaskIds } = await this.settleClosedObjective(objective);
    if (changed)
      await this.handlers
        ?.postObjectiveNotice(
          objectiveId,
          "objective-cancelled",
          objectiveCancellationNotice(objective),
        )
        .catch((error: unknown) => this.onError(error));
    this.inboxChanged?.();
    return { objective, changed, cancelledTaskIds };
  }

  /**
   * Operator pause. No turn of the Objective's Sessions starts while it is paused; running Task
   * Attempts finish, and pending turns wait.
   */
  async pauseObjective(
    input: { readonly objectiveId: string },
    principal: CoordinationOperatorPrincipal = EMBEDDED_BREAK_GLASS_PRINCIPAL,
  ): Promise<{ readonly objective: Objective; readonly changed: boolean }> {
    this.authorizeOperatorAction("update_objective", principal);
    const objectiveId = mailboxText(input.objectiveId, "objectiveId");
    this.authorizeOperatorObjective(objectiveId, principal);
    return this.store.pauseObjective(objectiveId, { operatorId: principal.operatorId });
  }

  /**
   * Operator resume. Clears the pause and tells the Objective's conversation what changed while
   * it was paused, as its next turn.
   */
  async resumeObjective(
    input: { readonly objectiveId: string },
    principal: CoordinationOperatorPrincipal = EMBEDDED_BREAK_GLASS_PRINCIPAL,
  ): Promise<{
    readonly objective: Objective;
    readonly changed: boolean;
    readonly summary: string | null;
  }> {
    this.authorizeOperatorAction("update_objective", principal);
    const objectiveId = mailboxText(input.objectiveId, "objectiveId");
    this.authorizeOperatorObjective(objectiveId, principal);
    const { objective, changed, pausedAt } = await this.store.resumeObjective(objectiveId, {
      operatorId: principal.operatorId,
    });
    if (!changed || pausedAt === null || objectiveClosed(objective.status))
      return { objective, changed, summary: null };
    const summary = objectiveResumeSummary(
      objective,
      pausedAt,
      await this.objectiveTasks(objectiveId),
    );
    // A resume is SuperTag's account of what changed while the Objective was paused, not a
    // limit notice: it arrives as the owner's next message.
    await this.sessions().deliverObjectiveNotice(
      objectiveId,
      `resumed:${pausedAt}`,
      summary,
      "objective_message",
    );
    return { objective, changed, summary };
  }

  /**
   * Ends what a completed or cancelled Objective leaves behind: every open Task of its Sessions
   * is cancelled and their pending turns fail, except the Task completing it. Safe to repeat.
   */
  async settleClosedObjective(
    objectiveOrId: Objective | string,
    completingTaskId?: string,
  ): Promise<{ readonly cancelledTaskIds: readonly string[] }> {
    const objective =
      typeof objectiveOrId === "string"
        ? await this.store.getObjective(objectiveOrId)
        : objectiveOrId;
    if (!objectiveClosed(objective.status)) return { cancelledTaskIds: [] };
    const cancelledTaskIds = await this.sessions().cancelObjectiveTasks(
      objective.id,
      closedObjectiveTaskReason(objective),
      completingTaskId,
    );
    return { cancelledTaskIds };
  }

  /**
   * Completion already succeeded, so leftovers must not fail the request. The completion notice
   * posts once to the home thread, keyed by the completing revision.
   */
  private async settleCompletedObjective(
    objective: Objective,
    completingTaskId?: string,
  ): Promise<void> {
    try {
      await this.settleClosedObjective(objective, completingTaskId);
      await this.handlers?.postObjectiveNotice(
        objective.id,
        `objective-completed:${objective.revision}`,
        objectiveCompletionNotice(objective),
      );
    } catch (error) {
      this.onError(error);
    }
  }

  /** Redacted operator projection over existing coordination records. */
  async readCoordinationInbox(
    input: ReadCoordinationInboxInput = {},
    principal: CoordinationOperatorPrincipal = EMBEDDED_BREAK_GLASS_PRINCIPAL,
  ): Promise<CoordinationInboxPage> {
    this.authorizeOperatorAction("read_coordination_inbox", principal);
    // Approval requests follow the same authority as `list approval`.
    const includeApprovals =
      principal.scopes.actions.includes("*") || principal.scopes.actions.includes("list_approvals");
    if (!includeApprovals && input.kind === "approval")
      throw new TagMessagingError(
        403,
        "Listing approval requests requires the list_approvals action",
      );
    const objectiveId = this.scopedObjectiveId(input.objectiveId, principal);
    const page = await this.store.readCoordinationInbox({
      ...input,
      ...(objectiveId === undefined ? {} : { objectiveId }),
      includeApprovals,
    });
    return this.inboxEnricher
      ? this.inboxEnricher(page)
      : {
          ...page,
          items: page.items.map((item) =>
            item.kind === "objective_budget" ||
            item.kind === "objective_limit" ||
            item.kind === "question"
              ? {
                  ...item,
                  notification: {
                    status: "unconfigured" as const,
                    reason: "Gateway notification delivery is not configured on this controller.",
                  },
                }
              : item,
          ),
        };
  }

  /** Read-only operator view of an Objective, its Sessions and their Tasks. */
  async readObjectiveOverview(
    input: ObjectiveOverviewInput,
    principal: CoordinationOperatorPrincipal = EMBEDDED_BREAK_GLASS_PRINCIPAL,
  ): Promise<ObjectiveOverview> {
    this.authorizeOperatorAction("read_objective", principal);
    const objectiveId = mailboxText(input.objectiveId, "objectiveId");
    this.authorizeOperatorObjective(objectiveId, principal);
    const limit = input.limit ?? 50;
    const offset = input.offset ?? 0;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw new TagMessagingError(400, "limit must be an integer between 1 and 100");
    if (!Number.isSafeInteger(offset) || offset < 0)
      throw new TagMessagingError(400, "offset must be a nonnegative integer");
    const objective = await this.store.getObjective(objectiveId);
    const [sessions, team] = await Promise.all([
      this.store.listObjectiveSessions(objectiveId),
      objective.teamId === null ? undefined : this.store.getTeam(objective.teamId),
    ]);
    return buildObjectiveOverview({
      store: this.store,
      objective,
      sessions,
      team,
      limit,
      offset,
      executionReadiness: this.executionReadiness,
      approvals: await this.approvals.summary(objectiveId),
      conditions: [await this.objectiveRunnable(objective)],
      tagNames: await this.tagNames([
        objective.ownerTagId,
        ...sessions.map((session) => session.tagId),
        ...(team?.memberTagIds ?? []),
      ]),
      posts: team ? await this.store.listTeamPosts(team.id, { limit: 50 }) : [],
    });
  }

  /**
   * Whether an Objective's turns can run now, with a reason for each condition that would hold
   * them. Used for creation warnings and the describe view's Runnable condition.
   */
  async objectiveRunnable(
    objective: ObjectiveRunnableFacts["objective"] & {
      readonly ownerTagId: string;
      readonly id?: string;
    },
  ): Promise<ObjectiveRunnableCondition> {
    const [owner, bindings, hosts, descriptor, workspaces, tasks] = await Promise.all([
      this.store.findTagById(objective.ownerTagId),
      this.store.listTagWorkerHostBindings(objective.ownerTagId),
      this.store.listWorkerHosts(),
      this.worklet ? describeWorklet(this.worklet).catch(() => undefined) : undefined,
      Promise.all((objective.workspaces ?? []).map((name) => this.store.findWorkspaceByName(name))),
      objective.id === undefined ? [] : this.objectiveTasks(objective.id),
    ]);
    const signInAttempts = (
      await Promise.all(
        tasks
          .filter((task) => task.tagId === objective.ownerTagId)
          .map(async (task) =>
            (
              await this.store.listTaskAttempts(task.id)
            ).map((attempt) => harnessSignInAttempt(attempt, attempt.outcome)),
          ),
      )
    )
      .flat()
      .filter((attempt) => attempt !== undefined);
    return objectiveRunnableCondition(
      {
        objective,
        owner: { id: objective.ownerTagId, name: owner?.name ?? objective.ownerTagId },
        boundHostIds: bindings.map((binding) => binding.workerHostId),
        signInAttempts,
        runsOn: owner?.runsOn ?? [],
        ...(owner?.execution?.harness === undefined ? {} : { harness: owner.execution.harness }),
        hosts,
        cloneableWorkspaces: workspaces.flatMap((workspace) =>
          workspace?.source ? [workspace.name] : [],
        ),
        directHosts: descriptor
          ? [
              {
                id: descriptor.host.id,
                workerSnapshot: { ...descriptor.host },
                ...(descriptor.host.workspaces ? { workspaces: descriptor.host.workspaces } : {}),
                labels: effectiveWorkerHostLabels({ ...descriptor.host }),
              },
            ]
          : [],
      },
      new Date().toISOString(),
    );
  }

  private authorizeOperatorAction(name: string, principal: CoordinationOperatorPrincipal): void {
    if (!principal.operatorId.trim() || principal.operatorId.length > 200)
      throw new TagMessagingError(401, "Invalid operator principal");
    if (!principal.scopes.actions.includes("*") && !principal.scopes.actions.includes(name))
      throw new TagMessagingError(403, "Operator is not permitted to perform this action");
  }

  private authorizeOperatorObjective(
    objectiveId: string,
    principal: CoordinationOperatorPrincipal,
  ): void {
    const allowed = principal.scopes.objectiveIds;
    if (allowed !== undefined && !allowed.includes(objectiveId))
      throw new TagMessagingError(403, "Operator is not permitted to access this Objective");
  }

  /** The Objective filter a principal's scope requires: the requested one, or its only one. */
  private scopedObjectiveId(
    requested: string | undefined,
    principal: CoordinationOperatorPrincipal,
  ): string | undefined {
    const allowed = principal.scopes.objectiveIds;
    if (requested !== undefined) {
      this.authorizeOperatorObjective(requested, principal);
      return requested;
    }
    if (allowed === undefined) return undefined;
    if (allowed.length !== 1 || allowed[0] === undefined)
      throw new TagMessagingError(403, "An Objective filter is required for this operator");
    return allowed[0];
  }

  // The sweep.

  /** Every Task of every Session of the Objective, its own Session first. */
  private async objectiveTasks(objectiveId: string): Promise<Task[]> {
    const sessions = await this.store.listObjectiveSessions(objectiveId);
    const ids = (
      await Promise.all(sessions.map((session) => this.store.listSessionTaskIds(session.sessionId)))
    ).flat();
    const tasks: Task[] = [];
    for (let offset = 0; offset < ids.length; offset += 16)
      for (const task of await Promise.all(
        ids.slice(offset, offset + 16).map((id) => this.store.findTaskById(id)),
      ))
        if (task) tasks.push(task);
    return tasks;
  }

  /** Each Task's provider budget report; an ended Task's is reused while it is unchanged. */
  private async taskBudgets(objective: ObjectiveLimitCandidate, tasks: readonly Task[]) {
    let cached = this.endedTaskBudgets.get(objective.id);
    if (!cached) {
      cached = new Map();
      this.endedTaskBudgets.set(objective.id, cached);
    }
    const current = new Set(tasks.map((task) => task.id));
    for (const id of cached.keys()) if (!current.has(id)) cached.delete(id);
    const ended = cached;
    return Promise.all(
      tasks.map(async (task) => {
        const prior = ended.get(task.id);
        if (prior?.updatedAt === task.updatedAt) return { taskId: task.id, budget: prior.budget };
        const [attempts, events] = await Promise.all([
          this.store.listTaskAttempts(task.id),
          this.store.listTaskEvents(task.id),
        ]);
        const budget = taskBudgetReport({ objective, task, attempts, events });
        if (task.status === "pending" || task.status === "running") ended.delete(task.id);
        else ended.set(task.id, { updatedAt: task.updatedAt, budget });
        return { taskId: task.id, budget };
      }),
    );
  }

  /** Records limit observations, moves exhausted Objectives to limited, and delivers notices. */
  async sweepObjectiveLimits(force = false): Promise<void> {
    if (!force && Date.now() - this.lastLimitSweep < this.limitSweepIntervalMs) return;
    this.lastLimitSweep = Date.now();
    const objectives = await this.store.listExecutingObjectives();
    for (const objective of objectives) {
      try {
        await this.sweepObjectiveLimit(objective);
      } catch (error) {
        this.onError(error);
      }
    }
    const active = new Set(objectives.map((objective) => objective.id));
    for (const id of this.endedTaskBudgets.keys())
      if (!active.has(id)) this.endedTaskBudgets.delete(id);
  }

  private async sweepObjectiveLimit(objective: ObjectiveLimitCandidate): Promise<void> {
    const now = new Date().toISOString();
    const tasks = await this.objectiveTasks(objective.id);
    let spend: ReturnType<typeof reportedSpend>;
    if (objectiveHasReportedBudget(objective)) {
      const budgets = await this.taskBudgets(objective, tasks);
      spend = reportedSpend(
        objective,
        objectiveBudgetReport(objective, budgets),
        budgets.flatMap(({ budget }) => budget.provider.attempts),
      );
    }
    const next = evaluateObjectiveLimits(objective, now, spend);
    const graceMs = this.deadlineGraceMs ?? objectiveDeadlineGraceMs(objective);
    // Running Attempts keep authority only through the grace period, and only while the owner
    // Tag is active. Past either, they are stopped so the Objective can become limited.
    const stop = await this.runningAuthorityEnded(objective, tasks, now, graceMs);
    if (stop) await this.sessions().cancelObjectiveTasks(objective.id, stop);
    const limited = objectiveShouldLimit(objective, next, stop ? [] : tasks, now, graceMs);
    if (limitStateChanged(objective.limitState, next) || limited)
      await this.store.recordObjectiveLimitState(objective.id, next, objective.revision, limited);
    await this.deliverLimitNotices(objective.id);
  }

  /**
   * Why the Objective's running Task Attempts must stop now, or undefined while they may run.
   * Checked only when something is running, so an idle sweep reads no Tag.
   */
  private async runningAuthorityEnded(
    objective: ObjectiveLimitCandidate,
    tasks: readonly Task[],
    now: string,
    graceMs: number,
  ): Promise<string | undefined> {
    if (!tasks.some((task) => task.status === "running" || task.status === "pending"))
      return undefined;
    if (objectiveDeadlineStopsRunning(objective, now, graceMs))
      return `The Objective deadline ${objective.deadline} passed and its grace period ended, so SuperTag stopped this Task.`;
    const owner = await this.store.findTagById(objective.ownerTagId).catch(() => undefined);
    if (owner && owner.status !== "active")
      return `Tag ${owner.name} is ${owner.status}, so SuperTag stopped this Task of its Objective.`;
    return undefined;
  }

  /** Each budget and deadline event becomes one turn of the Objective's conversation. */
  private async deliverLimitNotices(objectiveId: string): Promise<void> {
    if (!this.handlers) return;
    const objective = await this.store.getObjective(objectiveId);
    if (objectiveClosed(objective.status)) return;
    const notices = [
      ...objectiveDeadlineNotices(objective).filter(
        (notice) => notice.kind === "objective_deadline_set",
      ),
      ...objectiveLimitEvents(objective),
    ];
    for (const notice of notices) {
      const key = `${objectiveId}:${notice.key}`;
      if (this.handedNotices.has(key)) continue;
      await this.handlers.deliverObjectiveNotice(objectiveId, notice.key, notice.message);
      this.remember(key);
    }
  }

  /** One digest per Objective of pending approval requests, to its home thread. */
  private async reportApprovalNotices() {
    if (!this.handlers) return;
    for (const digest of await this.approvals.digests()) {
      const key = `${digest.objectiveId}:${digest.key}`;
      if (this.handedNotices.has(key)) continue;
      try {
        await this.handlers.postObjectiveNotice(digest.objectiveId, digest.key, digest.text);
        this.remember(key);
      } catch (error) {
        this.onError(error);
      }
    }
  }

  private remember(key: string) {
    this.handedNotices.add(key);
    for (const oldest of this.handedNotices) {
      if (this.handedNotices.size <= NOTICE_MEMORY) break;
      this.handedNotices.delete(oldest);
    }
  }
}

/** The reason recorded on a Task cancelled because its Objective reached a terminal status. */
export function closedObjectiveTaskReason(objective: Objective): string {
  if (objective.status === "cancelled")
    return `Objective ${objective.id} was cancelled${objective.cancellationReason ? `: ${objective.cancellationReason}` : ""}; this Task can no longer run.`.slice(
      0,
      2000,
    );
  return `Objective ${objective.id} completed; this Task can no longer run.`;
}
