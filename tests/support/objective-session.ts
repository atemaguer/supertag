import { randomUUID } from "node:crypto";
import type { ControlPlane } from "../../packages/control-plane/src/index.ts";
import {
  type CreateObjectiveInput,
  type DeliveryReason,
  type InternalTurn,
  inboxSessionKey,
  type Objective,
  type Store,
  type TagMessage,
  type Task,
  type Team,
} from "../../packages/core/src/index.ts";

type SessionReport = Extract<InternalTurn, { readonly kind: "session_report" }>;

/** A Task of a Session, with the turn SuperTag admitted it for; absent for a person's turn. */
export interface SessionTurn {
  readonly task: Task;
  readonly turn?: InternalTurn;
}

export interface ObjectiveSessionOptions {
  readonly store: Store;
  readonly controlPlane: Pick<ControlPlane, "startObjective">;
  readonly ownerTagId: string;
  /** The Team's other members; the owner is always one. */
  readonly memberTagIds?: readonly string[];
  readonly maxConcurrency?: number;
  /** Objective fields; the outcome defaults to a short statement. */
  readonly objective?: Partial<Omit<CreateObjectiveInput, "id" | "teamId">>;
  /** How long each wait polls before it fails. Default 20 seconds. */
  readonly timeoutMs?: number;
}

export interface WaitForTurnOptions {
  /** Only a `delivery` turn for this reason. */
  readonly reason?: DeliveryReason;
  /** Return the Task while it is still pending or running. By default a wait returns it settled. */
  readonly unsettled?: true;
}

export interface ObjectiveSession {
  readonly objective: Objective;
  readonly team: Team;
  /** The Task of the Objective's first turn. */
  readonly startTaskId: string;
  /**
   * The next turn of the Objective's own Session that no earlier wait returned, oldest first. Each
   * call returns a later turn.
   */
  waitForOwnerTurn(options?: WaitForTurnOptions): Promise<SessionTurn>;
  /** The next report turn of the Objective's own Session, for one work Session when named. */
  waitForReport(
    workSessionId?: string,
    options?: Pick<WaitForTurnOptions, "unsettled">,
  ): Promise<SessionTurn & { readonly report: SessionReport }>;
  /** The next turn of the Tag's inbox that no earlier wait returned. */
  waitForInboxTurn(tagId: string, options?: WaitForTurnOptions): Promise<SessionTurn>;
  /**
   * Stores a Mailbox message for the recipient's inbox, as `send_message` does after its checks.
   * The Control Plane's Session sweep admits the inbox turn that takes it.
   */
  deliverMessage(input: {
    readonly from: string;
    readonly to: string;
    readonly text: string;
    readonly hops?: number;
  }): Promise<TagMessage>;
}

const SETTLED = new Set(["completed", "failed", "cancelled"]);

/**
 * Creates a Team of the owner and members and an Objective that names it, then starts the
 * Objective through the Control Plane. The Control Plane must be running.
 */
export async function startObjectiveSession(
  options: ObjectiveSessionOptions,
): Promise<ObjectiveSession> {
  const { store, ownerTagId } = options;
  const timeoutMs = options.timeoutMs ?? 20_000;
  const team = await store.createTeam({
    id: randomUUID(),
    name: `objective-${randomUUID()}`,
    memberTagIds: [...new Set([ownerTagId, ...(options.memberTagIds ?? [])])],
    ...(options.maxConcurrency === undefined ? {} : { maxConcurrency: options.maxConcurrency }),
  });
  const objective = await store.createObjective({
    outcome: "Finish the test Objective",
    ...options.objective,
    id: randomUUID(),
    ownerTagId,
    teamId: team.id,
  });
  const { taskId: startTaskId } = await options.controlPlane.startObjective(objective.id);
  /** Task ids each Session's waits already returned. */
  const returned = new Map<string, Set<string>>();

  const turnOf = async (task: Task): Promise<SessionTurn> => {
    if (task.inboundEventId === null) return { task };
    const internal = (await store.findInboundEventById(task.inboundEventId))?.event.internal;
    return internal === undefined ? { task } : { task, turn: internal };
  };

  const nextTurn = async (
    findSession: () => Promise<{ readonly id: string } | undefined>,
    label: string,
    matches: (turn: SessionTurn) => boolean,
    unsettled: boolean,
  ): Promise<SessionTurn> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const session = await findSession();
      if (session !== undefined) {
        const seen = returned.get(session.id) ?? new Set<string>();
        returned.set(session.id, seen);
        const tasks = (await store.listTasks({ sessionId: session.id }))
          .filter((task) => !seen.has(task.id))
          .toSorted((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
        for (const task of tasks) {
          const turn = await turnOf(task);
          if (!matches(turn)) continue;
          if (!unsettled && !SETTLED.has(task.status)) break;
          seen.add(task.id);
          return turn;
        }
      }
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };

  const delivered = (reason: DeliveryReason | undefined) => (turn: SessionTurn) =>
    reason === undefined || (turn.turn?.kind === "delivery" && turn.turn.reason === reason);
  const ownerSession = () => store.findObjectiveOwnerSession(objective.id);

  return {
    objective,
    team,
    startTaskId,
    waitForOwnerTurn: (wait = {}) =>
      nextTurn(
        ownerSession,
        `a turn of Objective ${objective.id}${wait.reason ? ` (${wait.reason})` : ""}`,
        delivered(wait.reason),
        wait.unsettled === true,
      ),
    async waitForReport(workSessionId, wait = {}) {
      const found = await nextTurn(
        ownerSession,
        `a report to Objective ${objective.id}${workSessionId ? ` from ${workSessionId}` : ""}`,
        (turn) =>
          turn.turn?.kind === "session_report" &&
          (workSessionId === undefined || turn.turn.workSessionId === workSessionId),
        wait.unsettled === true,
      );
      return { ...found, report: found.turn as SessionReport };
    },
    waitForInboxTurn: (tagId, wait = {}) =>
      nextTurn(
        () => store.findSessionByTagAndKey(tagId, inboxSessionKey(tagId)),
        `an inbox turn of Tag ${tagId}${wait.reason ? ` (${wait.reason})` : ""}`,
        delivered(wait.reason),
        wait.unsettled === true,
      ),
    async deliverMessage(input) {
      const { message } = await store.deliverTagMessage({
        senderTagId: input.from,
        recipientTagId: input.to,
        text: input.text,
        hops: input.hops ?? 0,
        objectiveId: objective.id,
      });
      return message;
    },
  };
}
