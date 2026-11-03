import { explainHarnessSignIn, type ObjectiveOverview } from "@supertag/control-plane";
import { type ApprovalRequest, objectiveClosed, type TaskDelivery } from "@supertag/core";
import type { ControlPlaneClient } from "./control-plane-client.js";
import {
  deliverySummary,
  formatDelivery,
  hasDelivery,
  type LocalCheckouts,
} from "./delivery-view.js";
import { terminalText } from "./terminal-text.js";

/** One line of an Objective's timeline. */
export interface ObjectiveTimelineEvent {
  readonly at: string;
  /** Tag name, `operator`, or `chat` for a person in a connected collaboration surface. */
  readonly actor: string;
  readonly kind:
    | "objective.created"
    | "objective.status"
    | "task.created"
    | "task.status"
    | "task.escalated"
    | "task.delivered"
    | "approval.requested"
    | "approval.decided"
    | "message.owner"
    | "message.operator"
    | "team.post"
    | "team.direct_message"
    | "team.live_delivery"
    | "objective.closed";
  readonly objectiveId: string;
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

type OverviewTask = ObjectiveOverview["tasks"][number];

interface Snapshot {
  readonly objective: ObjectiveOverview["objective"] | undefined;
  readonly tasks: ReadonlyMap<string, OverviewTask>;
  readonly approvals: ReadonlyMap<string, ApprovalRequest>;
  readonly messages: ReadonlySet<string>;
  readonly posts: ReadonlySet<string>;
  readonly directMessages: ReadonlySet<string>;
  /** Live deliveries by ID and status, so a pending one prints once it is answered. */
  readonly liveDeliveries: ReadonlySet<string>;
}

const EMPTY: Snapshot = {
  objective: undefined,
  tasks: new Map(),
  approvals: new Map(),
  messages: new Set(),
  posts: new Set(),
  directMessages: new Set(),
  liveDeliveries: new Set(),
};
const PAGE_LIMIT = 100;
const MAX_PAGES = 20;
const SETTLE_MS = 30_000;

/**
 * Streams an Objective's timeline, one line per event, until the Objective is completed or
 * cancelled or the signal aborts. The first poll replays what already happened. Each poll reads
 * the Objective overview and its approval requests and prints what changed since the last one.
 * The owner can close the Objective while a Task Attempt in a Workspace is still finishing, so
 * after it closes the watch keeps polling, for at most `settleMs`, until those Tasks record their
 * delivery, and prints the summary with what they delivered.
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
      const view = await readOverview(client, objectiveId);
      const approvals = await client
        .request<{ readonly requests: readonly ApprovalRequest[] }>(
          `/api/v1/coordination/approvals?${new URLSearchParams({ objectiveId, status: "all", limit: "100" })}`,
        )
        .then((result) => result.requests)
        .catch(() => [...prior.approvals.values()]);
      if (options.signal.aborted) break;
      // The overview is a recent window, not a cursor. At its cap, intermediate
      // coordination events may have fallen out between polls.
      const posts = view.coordination?.posts ?? [];
      const byTeam = new Map<string, number>();
      for (const post of posts)
        byTeam.set(post.workstreamId, (byTeam.get(post.workstreamId) ?? 0) + 1);
      if (posts.length >= 200 || [...byTeam.values()].some((count) => count >= 100))
        options.warn?.(
          "Team post history reached the overview limit; watch may have missed posts. Read the Team channel for history.\n",
        );
      if ((view.coordination?.directMessages.length ?? 0) >= 200)
        options.warn?.(
          "Direct message history reached the overview limit; watch may have missed messages. Read Mailbox history.\n",
        );
      for (const [id, name] of Object.entries(view.tagNames ?? {})) names.set(id, name);
      const next: Snapshot = {
        objective: view.objective,
        tasks: new Map(view.tasks.map((task) => [task.taskId, task])),
        approvals: new Map(approvals.map((request) => [request.id, request])),
        messages: new Set((view.conversation ?? []).map((message) => message.id)),
        posts: new Set((view.coordination?.posts ?? []).map((post) => post.id)),
        directMessages: new Set(
          (view.coordination?.directMessages ?? []).map((message) => message.id),
        ),
        liveDeliveries: new Set(
          (view.coordination?.liveDeliveries ?? []).map(
            (delivery) => `${delivery.id}:${delivery.status}`,
          ),
        ),
      };
      const tag = (id: string) => names.get(id) ?? id;
      const events = timelineEvents(prior, next, view, tag).toSorted((a, b) =>
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

/**
 * Whether a Task in a Workspace has a Task Attempt that is running or just completed, but no
 * recorded delivery yet. A failed or cancelled Task Attempt delivers nothing, so it is not awaited.
 */
function awaitingDelivery(view: ObjectiveOverview): boolean {
  return view.tasks.some((task) => {
    if (task.workspace === null || task.delivery !== null) return false;
    const latest = task.evidence.attempts.at(-1);
    return latest?.status === "running" || latest?.status === "completed";
  });
}

async function readOverview(
  client: Pick<ControlPlaneClient, "request">,
  objectiveId: string,
): Promise<ObjectiveOverview> {
  const path = `/api/v1/coordination/objectives/${encodeURIComponent(objectiveId)}/overview`;
  let view = await client.request<ObjectiveOverview>(`${path}?limit=${PAGE_LIMIT}`);
  const tasks = [...view.tasks];
  for (let page = 1; view.nextOffset !== null && page < MAX_PAGES; page += 1) {
    view = await client.request<ObjectiveOverview>(
      `${path}?limit=${PAGE_LIMIT}&offset=${view.nextOffset}`,
    );
    tasks.push(...view.tasks);
  }
  return { ...view, tasks };
}

const STATUS_WORDS: Readonly<Record<string, string>> = {
  queued: "queued",
  running: "started",
  waiting: "is waiting",
  submitted: "submitted its result",
  accepted: "accepted",
  rejected: "rejected",
  cancelled: "cancelled",
  failed: "failed",
};

/** A failed Task whose Attempt left commits on its branch reads distinctly from a plain failure. */
function failedAfterCommits(task: OverviewTask): boolean {
  return (
    task.status === "failed" &&
    (task.explanations ?? []).some((reason) => reason.kind === "failed_after_delivering_commits")
  );
}

function timelineEvents(
  prior: Snapshot,
  next: Snapshot,
  view: ObjectiveOverview,
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
  for (const task of next.tasks.values()) {
    const old = prior.tasks.get(task.taskId);
    const taskBase = { ...base, taskId: task.taskId };
    if (old === undefined)
      events.push({
        ...taskBase,
        at: task.timing.createdAt,
        actor: tag(task.requestedByTagId),
        kind: "task.created",
        status: task.status,
        message: `Task ${task.taskId} for ${tag(task.assignedTagId)}: ${firstLine(task.instruction)}`,
      });
    if (task.status !== (old?.status ?? "queued")) {
      const reviewer = task.review.reviewedByTagId;
      // A Task that closed itself, such as an owner activation, had no reviewer: it finished.
      const reviewed = (task.status === "accepted" || task.status === "rejected") && !!reviewer;
      const selfClosed = task.status === "accepted" && !reviewer;
      const failure = task.explanations?.find((reason) => reason.kind === "execution_failed");
      events.push({
        ...taskBase,
        at: task.timing.updatedAt,
        actor: reviewed && reviewer ? tag(reviewer) : tag(task.assignedTagId),
        kind: "task.status",
        status: task.status,
        ...(failure ? { failure: failure.message } : {}),
        ...(failure?.failureKind ? { failureKind: failure.failureKind } : {}),
        ...(failure?.harness ? { harness: failure.harness } : {}),
        message: `Task ${task.taskId} ${failedAfterCommits(task) ? "failed after delivering commits" : selfClosed ? "finished" : (STATUS_WORDS[task.status] ?? task.status)}${reviewed && task.review.assessment ? `: ${firstLine(task.review.assessment)}` : ""}${failure ? `: ${failure.message}` : ""}`,
      });
    }
    // An older Control Plane reports no self-escalations.
    for (const escalation of (task.selfEscalations ?? []).slice(old?.selfEscalations?.length ?? 0))
      events.push({
        ...taskBase,
        at: escalation.at,
        actor: tag(escalation.byTagId || task.assignedTagId),
        kind: "task.escalated",
        message: `Task ${task.taskId} escalated: ${escalation.change}: ${firstLine(escalation.reason)}`,
      });
    const delivered = hasDelivery(task.delivery) ? task.delivery : undefined;
    const previous = hasDelivery(old?.delivery) ? old?.delivery : undefined;
    if (
      delivered !== undefined &&
      (previous === undefined || deliverySummary(previous) !== deliverySummary(delivered))
    )
      events.push({
        ...taskBase,
        at: task.timing.updatedAt,
        actor: tag(task.assignedTagId),
        kind: "task.delivered",
        delivery: delivered,
        message: `Task ${task.taskId} delivered ${deliverySummary(delivered)}`,
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
  for (const message of view.conversation ?? []) {
    if (prior.messages.has(message.id)) continue;
    events.push({
      ...base,
      at: message.createdAt,
      actor: message.from === "owner" ? tag(message.tagId) : "operator",
      kind: message.from === "owner" ? "message.owner" : "message.operator",
      message: `${message.from === "owner" ? (message.needsReply === false ? "Owner reported" : "Asked") : "Told the owner"}: "${firstLine(message.text)}"`,
    });
  }
  for (const post of view.coordination?.posts ?? []) {
    if (prior.posts.has(post.id)) continue;
    events.push({
      ...base,
      at: post.createdAt,
      actor: post.authorTagId === null ? "system" : tag(post.authorTagId),
      kind: "team.post",
      message: `Team ${post.workstreamId} ${post.type} post ${post.id}: ${firstLine(post.body)}`,
    });
  }
  for (const message of view.coordination?.directMessages ?? []) {
    if (prior.directMessages.has(message.id)) continue;
    events.push({
      ...base,
      at: message.createdAt,
      actor: tag(message.senderTagId),
      kind: "team.direct_message",
      message: `Direct ${message.type} message ${message.id} to ${tag(message.recipientTagId)}: ${firstLine(JSON.stringify(message.body))}`,
    });
  }
  // An older Control Plane reports no live deliveries.
  for (const delivery of view.coordination?.liveDeliveries ?? []) {
    if (
      delivery.status === "pending" ||
      prior.liveDeliveries.has(`${delivery.id}:${delivery.status}`)
    )
      continue;
    const item = `${delivery.itemType} ${delivery.itemKind === "post" ? "post" : "direct message"} ${delivery.itemId}`;
    events.push({
      ...base,
      taskId: delivery.taskId,
      at: delivery.updatedAt,
      actor: tag(delivery.senderTagId),
      kind: "team.live_delivery",
      status: delivery.status,
      message:
        delivery.status === "accepted"
          ? `Delivered ${item} live to ${tag(delivery.recipientTagId)} in Task ${delivery.taskId}`
          : delivery.status === "revoked"
            ? `Live delivery of ${item} to ${tag(delivery.recipientTagId)} in Task ${delivery.taskId} was revoked; it is not recorded as delivered`
            : delivery.status === "withdrawn"
              ? `Live delivery of ${item} to ${tag(delivery.recipientTagId)} in Task ${delivery.taskId} was withdrawn: it was not read before the final response; their next digest carries it`
              : `Live delivery of ${item} to ${tag(delivery.recipientTagId)} in Task ${delivery.taskId} is uncertain; their next digest carries it`,
    });
  }
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
  const delivered = view.tasks.filter((task) => hasDelivery(task.delivery));
  if (delivered.length > 0) lines.push("Delivered:");
  for (const task of delivered)
    if (task.delivery) {
      lines.push(`  Task ${task.taskId} (${tag(task.assignedTagId)})`);
      lines.push(
        ...formatDelivery(task.delivery, {
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
