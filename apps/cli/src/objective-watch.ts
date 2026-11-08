import { explainHarnessSignIn, type ObjectiveOverview } from "@supertag/control-plane";
import {
  type ApprovalRequest,
  objectiveClosed,
  type TaskDelivery,
  type WorkstreamPost,
} from "@supertag/core";
import type { ControlPlaneClient } from "./control-plane-client.js";
import {
  deliverySummary,
  formatDelivery,
  hasDelivery,
  type LocalCheckouts,
} from "./delivery-view.js";
import { type ObjectiveOverviewSession, sessionLabel } from "./objective-overview.js";
import { terminalText } from "./terminal-text.js";

/** One line of an Objective's timeline. */
export interface ObjectiveTimelineEvent {
  readonly at: string;
  /** Tag name, `operator`, or `chat` for a person in a connected collaboration surface. */
  readonly actor: string;
  readonly kind:
    | "objective.created"
    | "objective.status"
    | "session.started"
    | "task.status"
    | "task.delivered"
    | "approval.requested"
    | "approval.decided"
    | "team.post"
    | "objective.closed";
  readonly objectiveId: string;
  readonly sessionId?: string;
  readonly taskId?: string;
  readonly message: string;
  readonly status?: string;
  readonly approvalId?: string;
  readonly harness?: string;
  readonly failure?: string;
  readonly failureKind?: string;
  readonly delivery?: TaskDelivery;
}

export interface ObjectiveWatchOptions {
  readonly output: "json" | "text";
  readonly signal: AbortSignal;
  readonly write: (text: string) => void;
  readonly warn?: (text: string) => void;
  readonly intervalMs?: number;
  /**
   * How long to keep polling after the Objective closes for deliveries still being recorded.
   * Defaults to 30 seconds.
   */
  readonly settleMs?: number;
  readonly checkouts?: LocalCheckouts;
}

interface Snapshot {
  readonly objective: ObjectiveOverview["objective"] | undefined;
  readonly sessions: ReadonlyMap<string, ObjectiveOverviewSession>;
  readonly approvals: ReadonlyMap<string, ApprovalRequest>;
  /** The last Workstream post sequence printed. */
  readonly postSequence: number;
}

const EMPTY: Snapshot = {
  objective: undefined,
  sessions: new Map(),
  approvals: new Map(),
  postSequence: 0,
};
const POST_PAGE_LIMIT = 100;
const SETTLE_MS = 30_000;

/**
 * Streams an Objective's timeline, one line per event, until the Objective is completed or
 * cancelled or the signal aborts. The first poll replays what already happened. Each poll reads
 * the Objective overview, its approval requests, and its Team's new Workstream posts, and prints
 * what changed since the last one. The owner can close the Objective while a turn in a Workspace
 * is still finishing, so after it closes the watch keeps polling, for at most `settleMs`, until
 * those turns record their delivery, and prints the summary with what they delivered.
 */
export async function watchObjective(
  client: Pick<ControlPlaneClient, "request">,
  objectiveId: string,
  options: ObjectiveWatchOptions,
): Promise<void> {
  let prior = EMPTY;
  let closedAt: number | undefined;
  const names = new Map<string, string>();
  while (!options.signal.aborted) {
    try {
      const view = await client.request<ObjectiveOverview>(
        `/api/v1/coordination/objectives/${encodeURIComponent(objectiveId)}/overview`,
      );
      const approvals = await client
        .request<{ readonly requests: readonly ApprovalRequest[] }>(
          `/api/v1/coordination/approvals?${new URLSearchParams({ objectiveId, status: "all", limit: "100" })}`,
        )
        .then((result) => result.requests)
        .catch(() => [...prior.approvals.values()]);
      const posts =
        view.objective.teamId === null
          ? []
          : await readPosts(client, view.objective.teamId, prior.postSequence).catch(() => []);
      if (options.signal.aborted) break;
      for (const [id, name] of Object.entries(view.tagNames)) names.set(id, name);
      const next: Snapshot = {
        objective: view.objective,
        sessions: new Map(view.sessions.map((session) => [session.id, session])),
        approvals: new Map(approvals.map((request) => [request.id, request])),
        postSequence: Math.max(prior.postSequence, ...posts.map((post) => post.sequence)),
      };
      const tag = (id: string) => names.get(id) ?? id;
      const events = timelineEvents(prior, next, view, posts, tag).toSorted((a, b) =>
        a.at.localeCompare(b.at),
      );
      for (const event of events) options.write(render(event, options.output));
      prior = next;
      if (objectiveClosed(view.objective.status)) {
        // Only an Objective that closed recently can still be recording a delivery.
        const settleMs = options.settleMs ?? SETTLE_MS;
        closedAt ??= Math.max(Date.parse(view.objective.updatedAt) || 0, Date.now() - settleMs);
        if (!awaitingDelivery(view) || Date.now() - closedAt >= settleMs) {
          options.write(closing(view, tag, options));
          return;
        }
      }
    } catch (error) {
      // Nothing has streamed yet, so a first failure, such as an unknown ID, ends the command.
      if (prior === EMPTY) throw error;
      options.warn?.(
        `Objective poll failed: ${terminalText(error instanceof Error ? error.message : String(error))}\n`,
      );
    }
    await pause(options.signal, options.intervalMs ?? 1_000);
  }
}

/** The Team's Workstream posts after `afterSequence`, oldest first. */
async function readPosts(
  client: Pick<ControlPlaneClient, "request">,
  teamId: string,
  afterSequence: number,
): Promise<readonly WorkstreamPost[]> {
  const posts: WorkstreamPost[] = [];
  for (let after = afterSequence; ; ) {
    const { items } = await client.request<{ readonly items: readonly WorkstreamPost[] }>(
      `/api/v1/tag-messaging/workstreams/${encodeURIComponent(teamId)}/posts?${new URLSearchParams({ afterSequence: String(after), limit: String(POST_PAGE_LIMIT) })}`,
    );
    posts.push(...items);
    if (items.length < POST_PAGE_LIMIT) return posts;
    after = Math.max(after, ...items.map((post) => post.sequence));
  }
}

/**
 * Whether a turn in a Workspace has a Task Attempt that is running or just completed, but no
 * recorded delivery yet. A failed or cancelled Task Attempt delivers nothing, so it is not awaited.
 */
function awaitingDelivery(view: ObjectiveOverview): boolean {
  return view.sessions.some(({ task }) => {
    if (task === undefined || task.workspace === null || task.delivery !== null) return false;
    return task.attemptStatus === "running" || task.attemptStatus === "completed";
  });
}

const STATUS_WORDS: Readonly<Record<string, string>> = {
  pending: "is queued",
  running: "started",
  waiting: "is waiting",
  completed: "finished",
  cancelled: "was cancelled",
  failed: "failed",
};

function timelineEvents(
  prior: Snapshot,
  next: Snapshot,
  view: ObjectiveOverview,
  posts: readonly WorkstreamPost[],
  tag: (id: string) => string,
): ObjectiveTimelineEvent[] {
  const events: ObjectiveTimelineEvent[] = [];
  const objective = view.objective;
  const base = { objectiveId: objective.id };
  const owner = tag(objective.ownerTagId);
  if (prior.objective === undefined)
    events.push({
      ...base,
      at: objective.createdAt,
      actor: objective.surfaceTaskId ? "chat" : "operator",
      kind: "objective.created",
      message: `Objective ${objective.id} created for ${owner}: ${firstLine(objective.outcome)}`,
    });
  const before = prior.objective?.status ?? "working";
  if (objective.status !== before && !objectiveClosed(objective.status))
    events.push({
      ...base,
      at: objective.updatedAt,
      actor: owner,
      kind: "objective.status",
      status: objective.status,
      message: `Objective is ${objective.status.replaceAll("_", " ")}${objective.status === "ready_for_review" && objective.completionSummary ? `: ${firstLine(objective.completionSummary)}` : ""}`,
    });
  for (const session of next.sessions.values()) {
    const old = prior.sessions.get(session.id);
    const sessionBase = { ...base, sessionId: session.id };
    const label = sessionLabel(session);
    if (old === undefined && !session.owner)
      events.push({
        ...sessionBase,
        at: session.createdAt,
        actor: tag(session.tagId),
        kind: "session.started",
        message: `Started ${firstLine(label)}`,
      });
    const task = session.task;
    if (task === undefined) continue;
    const taskBase = { ...sessionBase, taskId: task.id };
    if (old?.task?.id !== task.id || old.task.status !== task.status) {
      const failure = task.explanations.find((reason) => reason.kind === "execution_failed");
      events.push({
        ...taskBase,
        at: task.updatedAt,
        actor: tag(session.tagId),
        kind: "task.status",
        status: task.status,
        ...(failure ? { failure: failure.message } : {}),
        ...(failure?.failureKind ? { failureKind: failure.failureKind } : {}),
        ...(failure?.harness ? { harness: failure.harness } : {}),
        message: `${label}: Task ${task.id} ${STATUS_WORDS[task.status] ?? task.status}${task.status === "waiting" && task.question ? `: ${firstLine(task.question)}` : ""}${failure ? `: ${failure.message}` : ""}`,
      });
    }
    const delivered = hasDelivery(task.delivery) ? task.delivery : undefined;
    const previous =
      old?.task?.id === task.id && hasDelivery(old.task.delivery) ? old.task.delivery : undefined;
    if (
      delivered !== undefined &&
      (previous === undefined || deliverySummary(previous) !== deliverySummary(delivered))
    )
      events.push({
        ...taskBase,
        at: task.updatedAt,
        actor: tag(session.tagId),
        kind: "task.delivered",
        delivery: delivered,
        message: `${label}: Task ${task.id} delivered ${deliverySummary(delivered)}`,
      });
  }
  for (const request of next.approvals.values()) {
    const old = prior.approvals.get(request.id);
    if (old === undefined)
      events.push({
        ...base,
        taskId: request.taskId,
        approvalId: request.id,
        at: request.createdAt,
        actor: tag(request.requestingTagId),
        kind: "approval.requested",
        message: `Requested approval ${request.id}: ${firstLine(request.summary)}`,
      });
    if (request.status !== "pending" && request.status !== old?.status)
      events.push({
        ...base,
        taskId: request.taskId,
        approvalId: request.id,
        at: request.decidedAt ?? request.updatedAt,
        actor:
          request.decidedByKind === "tag" && request.decidedBy
            ? tag(request.decidedBy)
            : request.decidedByKind === "operator"
              ? "operator"
              : "SuperTag",
        kind: "approval.decided",
        status: request.status,
        message: `Approval ${request.id} ${request.status}${request.reason ? `: ${firstLine(request.reason)}` : ""}`,
      });
  }
  for (const post of posts)
    events.push({
      ...base,
      at: post.createdAt,
      actor: tag(post.authorTagId),
      kind: "team.post",
      message: `Workstream post ${post.sequence}${post.to.length ? ` to ${post.to.map(tag).join(", ")}` : ""}: ${firstLine(post.body)}`,
    });
  if (objectiveClosed(objective.status) && objective.status !== prior.objective?.status)
    events.push({
      ...base,
      at:
        objective.status === "cancelled"
          ? (objective.cancelledAt ?? objective.updatedAt)
          : objective.updatedAt,
      actor: objective.status === "cancelled" || before === "ready_for_review" ? "operator" : owner,
      kind: "objective.closed",
      status: objective.status,
      message: `Objective ${objective.status}${objective.status === "cancelled" && objective.cancellationReason ? `: ${firstLine(objective.cancellationReason)}` : ""}`,
    });
  return events;
}

function render(event: ObjectiveTimelineEvent, output: "json" | "text"): string {
  if (output === "json") return `${JSON.stringify(event)}\n`;
  const failure =
    event.kind === "task.status" && event.status === "failed" ? event.failure : undefined;
  // The raw JSON message retains the failure suffix; only the text renderer separates it.
  const headline =
    failure === undefined ? event.message : event.message.slice(0, -(failure.length + 2));
  const lines = [
    `${terminalText(time(event.at))}  ${terminalText(event.actor).padEnd(12)}  ${terminalText(headline)}`,
  ];
  if (failure !== undefined)
    for (const line of explainHarnessSignIn(failure, event.harness, event.failureKind).split(
      /\r?\n/u,
    ))
      lines.push(`    ${terminalText(line)}`);
  return `${lines.join("\n")}\n`;
}

/** The summary printed once the Objective closes. */
function closing(
  view: ObjectiveOverview,
  tag: (id: string) => string,
  options: ObjectiveWatchOptions,
): string {
  if (options.output === "json") return "";
  const objective = view.objective;
  const lines = ["", `Objective ${objective.id} is ${objective.status}.`];
  if (objective.completionSummary) lines.push(`Result: ${objective.completionSummary}`);
  const delivered = view.sessions.filter((session) => hasDelivery(session.task?.delivery));
  if (delivered.length > 0) lines.push("Delivered:");
  for (const session of delivered)
    if (session.task?.delivery) {
      lines.push(`  ${sessionLabel(session)} (${tag(session.tagId)})`);
      lines.push(
        ...formatDelivery(session.task.delivery, {
          indent: "    ",
          ...(options.checkouts === undefined ? {} : { checkouts: options.checkouts }),
        }),
      );
    }
  return `${lines.map(terminalText).join("\n")}\n`;
}

function time(at: string): string {
  return at.replace("T", " ").replace(/\.\d+Z$/u, "Z");
}

function firstLine(text: string): string {
  const line = text.trim().split(/\r?\n/u)[0]?.trim() ?? "";
  return line.length > 120 ? `${line.slice(0, 119)}…` : line;
}

function pause(signal: AbortSignal, ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}
