import {
  type Store,
  sanitizeApprovalText,
  type Task,
  WORKSPACE_PULL_REQUEST_EVENTS,
  workspacePullRequestFromEvents,
} from "@supertag/core";
import { WORK_SESSION_ASKED_EVENT } from "./work-sessions.js";

/** One Workspace pull request the Control Plane acts on after its Task settles. */
export interface WorkspacePullRequestTarget {
  readonly surfaceAccountId: string;
  /** `owner/name`. */
  readonly repository: string;
  readonly number: number;
  readonly url: string;
  readonly signal?: AbortSignal;
}

/**
 * Provider calls for the pull-request steps that happen after a Task ends. The Control Plane
 * holds the Surface Account credential, so it marks a draft ready when the Task completes its
 * work and closes it when the Task is cancelled. Neither call ever merges.
 *
 * A thrown error with `retryable: false` is permanent, such as a missing pull request or a
 * permission denial. Any other error, including network failures, is retried with backoff.
 */
export interface WorkspacePullRequestHandler {
  /** Marks a draft pull request ready for review. A pull request that is not a draft is left alone. */
  markReadyForReview(target: WorkspacePullRequestTarget): Promise<void>;
  /** Comments, then closes an open pull request. A closed or merged one is left alone. */
  close(target: WorkspacePullRequestTarget & { readonly comment: string }): Promise<void>;
}

/** A pull-request failure that no retry can fix until a person changes something. */
export class PermanentPullRequestError extends Error {
  readonly retryable = false;
  constructor(message: string) {
    super(message);
    this.name = "PermanentPullRequestError";
  }
}

/** Backoff for failed transitions: 1 minute, doubling to 1 hour, for at most 10 attempts. */
export const WORKSPACE_PULL_REQUEST_RETRY = {
  firstDelayMs: 60_000,
  maxDelayMs: 60 * 60_000,
  maxAttempts: 10,
} as const;

/** Delay before the next attempt after `failures` failed attempts. */
export function pullRequestRetryDelayMs(failures: number): number {
  const exponent = Math.max(0, Math.min(30, Math.floor(failures) - 1));
  return Math.min(
    WORKSPACE_PULL_REQUEST_RETRY.maxDelayMs,
    WORKSPACE_PULL_REQUEST_RETRY.firstDelayMs * 2 ** exponent,
  );
}

function retryable(error: unknown): boolean {
  return !(
    typeof error === "object" &&
    error !== null &&
    "retryable" in error &&
    (error as { retryable: unknown }).retryable === false
  );
}

type LifecyclePersistence = Pick<
  Store,
  | "appendTaskEvent"
  | "findTaskById"
  | "listSessionTaskIds"
  | "listTaskEvents"
  | "saveWorkspacePullRequestTransition"
  | "listDueWorkspacePullRequestTransitions"
  | "deleteWorkspacePullRequestTransition"
>;

const SETTLED = ["completed", "cancelled"] as const;
type Settled = (typeof SETTLED)[number];

/** Minimum time between scans for due retries. */
const RETRY_SCAN_INTERVAL_MS = 5_000;

/**
 * Moves a Task's pull request through its review lifecycle once the Task ends: a completed Task
 * that waits on nothing marks the draft ready for review; a cancelled one closes a pull request
 * it opened with a short comment. Each
 * transition is recorded as a Task event, so repeating a settlement never repeats the call.
 * A failure that may clear with time is stored as a pending transition and retried with backoff
 * by `retryDue`; a permanent failure is recorded once and left for a person.
 */
export class WorkspacePullRequestLifecycle {
  private lastRetryScan = 0;
  constructor(
    private readonly store: LifecyclePersistence,
    private handler: WorkspacePullRequestHandler | undefined,
    private readonly onError: (error: unknown) => void = () => {},
    private readonly now: () => number = Date.now,
  ) {}

  setHandler(handler: WorkspacePullRequestHandler | undefined): void {
    this.handler = handler;
  }

  async settle(
    task: Pick<Task, "id" | "sessionId" | "status" | "workspacePlan" | "outcome">,
  ): Promise<void> {
    try {
      const pending = await this.pending(task);
      // A scheduled retry owns the transition; settling again must not reset its backoff.
      if (pending && pending.pullRequest.nextAttemptAt === undefined)
        await this.attempt(task.id, pending.status, pending.pullRequest, 0);
    } catch (error) {
      this.onError(error);
    }
  }

  /** Retries pending transitions whose backoff elapsed. Called from the controller's sweep. */
  async retryDue(force = false): Promise<void> {
    if (!force && this.now() - this.lastRetryScan < RETRY_SCAN_INTERVAL_MS) return;
    this.lastRetryScan = this.now();
    let due: Awaited<ReturnType<LifecyclePersistence["listDueWorkspacePullRequestTransitions"]>>;
    try {
      due = await this.store.listDueWorkspacePullRequestTransitions(
        new Date(this.now()).toISOString(),
      );
    } catch (error) {
      this.onError(error);
      return;
    }
    for (const transition of due) {
      try {
        const task = await this.store.findTaskById(transition.taskId);
        const pending = task ? await this.pending(task) : undefined;
        // The pull request already reached its state, or the Task no longer calls for it.
        if (
          !pending ||
          pending.pullRequest.url !== transition.url ||
          (pending.status === "completed") !== (transition.action === "ready")
        ) {
          await this.store.deleteWorkspacePullRequestTransition(transition.taskId);
          continue;
        }
        await this.attempt(
          transition.taskId,
          pending.status,
          pending.pullRequest,
          transition.attemptCount,
        );
      } catch (error) {
        this.onError(error);
      }
    }
  }

  /**
   * The transition an ended Task still needs, or undefined when there is nothing to do. A
   * cancelled Task closes only a pull request no earlier Task of its Session delivered to: the
   * Session's pull request holds their work too, so it stays open.
   */
  private async pending(
    task: Pick<Task, "id" | "sessionId" | "status" | "workspacePlan" | "outcome">,
  ) {
    if (!SETTLED.includes(task.status as Settled)) return undefined;
    const status = task.status as Settled;
    const plan = task.workspacePlan;
    if (plan.status !== "workspace" || plan.delivery !== "pull-request") return undefined;
    const events = await this.store.listTaskEvents(task.id);
    const approvals = task.outcome?.["approvals"];
    // A Task that ended waiting on an answer or an approval continues in its Session's next Task.
    if (
      status === "completed" &&
      ((Array.isArray(approvals) && approvals.length > 0) ||
        events.some((event) => event.type === WORK_SESSION_ASKED_EVENT))
    )
      return undefined;
    const pullRequest = workspacePullRequestFromEvents(events);
    if (pullRequest === undefined || pullRequest.state === "closed") return undefined;
    if (status === "completed" && pullRequest.state === "ready") return undefined;
    if (status === "cancelled") {
      const ids = await this.store.listSessionTaskIds(task.sessionId);
      for (const id of ids.slice(0, Math.max(0, ids.indexOf(task.id))))
        if (
          workspacePullRequestFromEvents(await this.store.listTaskEvents(id))?.url ===
          pullRequest.url
        )
          return undefined;
    }
    return { status, pullRequest };
  }

  private async attempt(
    taskId: string,
    status: Settled,
    pullRequest: NonNullable<ReturnType<typeof workspacePullRequestFromEvents>>,
    failures: number,
  ): Promise<void> {
    const identity = {
      url: pullRequest.url,
      repository: pullRequest.repository,
      number: pullRequest.number,
      taskStatus: status,
    };
    try {
      if (!this.handler)
        throw new PermanentPullRequestError(
          "This Control Plane has no GitHub pull request handler configured",
        );
      if (pullRequest.surfaceAccountId === undefined)
        throw new PermanentPullRequestError(
          "The pull request does not record its GitHub Surface Account",
        );
      const target = {
        surfaceAccountId: pullRequest.surfaceAccountId,
        repository: pullRequest.repository,
        number: pullRequest.number,
        url: pullRequest.url,
        signal: AbortSignal.timeout(30_000),
      };
      if (status === "completed") {
        await this.handler.markReadyForReview(target);
        await this.event(taskId, WORKSPACE_PULL_REQUEST_EVENTS.ready, identity);
      } else {
        await this.handler.close({
          ...target,
          comment: `SuperTag closed this pull request because Task ${taskId} was cancelled.`,
        });
        await this.event(taskId, WORKSPACE_PULL_REQUEST_EVENTS.closed, identity);
      }
      if (failures > 0) await this.store.deleteWorkspacePullRequestTransition(taskId);
    } catch (error) {
      const attempt = failures + 1;
      const message = sanitizeApprovalText(
        error instanceof Error ? error.message : String(error),
        500,
      );
      const retry = retryable(error) && attempt < WORKSPACE_PULL_REQUEST_RETRY.maxAttempts;
      const nextAttemptAt = retry
        ? new Date(this.now() + pullRequestRetryDelayMs(attempt)).toISOString()
        : undefined;
      if (nextAttemptAt)
        await this.store.saveWorkspacePullRequestTransition({
          taskId,
          url: pullRequest.url,
          action: status === "completed" ? "ready" : "close",
          attemptCount: attempt,
          nextAttemptAt,
          lastError: message,
        });
      else if (failures > 0) await this.store.deleteWorkspacePullRequestTransition(taskId);
      await this.event(taskId, WORKSPACE_PULL_REQUEST_EVENTS.failed, {
        ...identity,
        error: message,
        attempt,
        retryable: retryable(error),
        ...(nextAttemptAt ? { nextAttemptAt } : {}),
      });
    }
  }

  private async event(taskId: string, type: string, payload: Record<string, unknown>) {
    await this.store.appendTaskEvent({ taskId, type, payload: { ...payload } });
  }
}
