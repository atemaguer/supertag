/**
 * Live delivery of Team coordination: a Team post addressed to a Tag, or a direct message within
 * a Team, injected as input into the recipient's running Task Attempt of that Team. Addressed
 * posts may reach another Objective served by the Team; direct messages stay Objective-scoped.
 * Delivery is recorded only when the harness acknowledges acceptance. An item not accepted live
 * remains eligible for the next activation digest in its own Objective.
 */

/**
 * Items one sender may inject into one recipient Task Attempt. Beyond it, the sender's items to
 * that Task Attempt wait for the recipient's next activation digest.
 */
export const TEAM_LIVE_DELIVERY_PAIR_LIMIT = 5;
/**
 * How long a delivery may stay `pending` while the harness answers. Digests skip an item only
 * while its delivery is pending, younger than this, and its Task Attempt still runs, so an
 * interrupted delivery is not lost. An older pending delivery no longer counts toward the pair's
 * limit.
 */
export const TEAM_LIVE_DELIVERY_PENDING_MS = 60_000;
/** Characters of an item's text injected live; read_workstream or read_mailbox return the rest. */
export const TEAM_LIVE_DELIVERY_MAX_CHARACTERS = 4_000;

/**
 * `pending` until the harness answers. `accepted` means the harness took the input; the item is
 * then delivered and leaves the digest. `unknown` means acceptance is uncertain; the item is never
 * injected again and stays for the digest. `revoked` means the input was sent while the item
 * qualified but failed the take-time authority check, or was revoked before acceptance was
 * recorded. A take-time refusal exposes no text; revocation after handoff cannot recall it.
 * Neither case is recorded as delivered or settles anything. `withdrawn` means the harness
 * acknowledged the input, but its model never read it before the Task Attempt's final response:
 * it is not delivered, is never injected again, and stays for the digest. Every status but a
 * stale `pending` still counts toward the pair's limit. Other rejections leave no row.
 */
export type TeamLiveDeliveryStatus = "pending" | "accepted" | "unknown" | "revoked" | "withdrawn";

export interface TeamLiveDelivery {
  readonly id: string;
  readonly objectiveId: string;
  readonly teamId: string;
  readonly taskId: string;
  readonly attemptId: string;
  readonly senderTagId: string;
  readonly recipientTagId: string;
  readonly itemKind: "post" | "direct_message";
  readonly itemId: string;
  /** The post or message type, such as `decision`. */
  readonly itemType: string;
  readonly status: TeamLiveDeliveryStatus;
  /** The injected text was cut; the recipient reads the rest with read_workstream or read_mailbox. */
  readonly truncated: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * One item as stored, read under the same lock that admitted its delivery. Its text is a
 * teammate's words: it carries no authority and is never an operator or user instruction.
 */
export interface TeamLiveDeliveryItem {
  readonly kind: "post" | "direct_message";
  readonly id: string;
  readonly from: string;
  readonly type: string;
  readonly teamId: string;
  readonly workstreamId?: string;
  readonly sequence?: number;
  readonly inReplyTo?: string;
  readonly references: readonly string[];
  readonly text: string;
  readonly truncated: boolean;
}

export interface TeamLiveDeliveryInput {
  readonly itemKind: "post" | "direct_message";
  readonly itemId: string;
  readonly recipientTagId: string;
}

export type PrepareTeamLiveDeliveryResult =
  | {
      readonly status: "prepared";
      readonly delivery: TeamLiveDelivery;
      readonly item: TeamLiveDeliveryItem;
    }
  /** The pair reached {@link TEAM_LIVE_DELIVERY_PAIR_LIMIT} in this Task Attempt. */
  | { readonly status: "capped" }
  /** The item was injected or delivered in a digest before. */
  | { readonly status: "duplicate" }
  /** The item, sender, recipient, Team, or Task Attempt no longer qualifies. */
  | { readonly status: "ineligible" };

export interface TeamLiveDeliveryStore {
  /**
   * The recipient's running Task Attempt that may receive the item: a running Task assigned to
   * the recipient in the item's Team. Direct messages require the item's Objective; addressed
   * posts may target another Objective served by the Team. Prepare checks again under lock.
   */
  findTeamLiveDeliveryTargets(
    input: TeamLiveDeliveryInput,
  ): Promise<readonly { readonly taskId: string; readonly attemptId: string }[]>;
  /**
   * Admits one live delivery under the Team's lock, which membership changes also take. The
   * item must be undelivered; its sender and recipient current members of its active Team serving
   * the Objective; a direct message still pending; and the Task Attempt the running Attempt of a
   * Task of that Team assigned to the recipient. Direct messages require the item's Objective;
   * addressed posts may target another Objective served by the Team. The item must be created at
   * or after the Task Attempt started: older items belong to its own Objective's activation digest,
   * which selects only items created before it started. The sender's live deliveries into the Task
   * Attempt must be under {@link TEAM_LIVE_DELIVERY_PAIR_LIMIT}.
   */
  prepareTeamLiveDelivery(
    input: TeamLiveDeliveryInput & { readonly taskId: string; readonly attemptId: string },
  ): Promise<PrepareTeamLiveDeliveryResult>;
  /**
   * Checks a prepared delivery again under the Team's lock and sends it while still holding that
   * lock: every admission rule must still hold, the delivery must still be pending, and nothing
   * may have delivered the item meanwhile. Only then is `dispatch` called, synchronously, before
   * the lock is released, so a removal, Objective unlink, or governance move, which takes the
   * same lock, either commits first and nothing is sent, or commits after the input was handed
   * to the Worklet. `dispatch` must only start sending; it must not wait. A delivery that no
   * longer qualifies is removed, so it holds no slot of the pair's limit, `dispatch` is not
   * called, and false is returned. With `atTake`, a refusal keeps a `revoked` record instead.
   * Queued input must call this again at the harness take boundary; starting Worklet control
   * under the lock does not authorize consumption from a later queue.
   */
  confirmTeamLiveDelivery(id: string, dispatch: () => void, atTake?: boolean): Promise<boolean>;
  /**
   * Records the harness acknowledgement. `accepted` records digest delivery and settles a direct
   * message, even one injected cut, like a digest preview, if the item still qualifies under the
   * Team's lock; if its sender was removed or its message failed since it was sent, the delivery
   * is recorded `revoked` instead and settles nothing. `rejected` preserves a take-time revocation
   * record; otherwise it removes the row so the item can wait for the digest; `unknown` keeps the row, so the item is never injected again but stays
   * for the digest.
   */
  finishTeamLiveDelivery(input: {
    readonly id: string;
    readonly status: "accepted" | "rejected" | "unknown";
    /** The injected text was cut further than admission recorded, to fit the harness input. */
    readonly truncated?: boolean;
  }): Promise<TeamLiveDelivery | undefined>;
  /**
   * Undoes a delivery that its Task Attempt reports its harness acknowledged, but whose model never
   * read it before the Task Attempt's final response. Only a delivery of that Task and Task Attempt
   * that is `accepted`, or still `pending` because the acknowledgement is not recorded yet, becomes
   * `withdrawn`; anything else returns undefined, so repeating it changes nothing. The digest
   * delivery and the direct message's settlement that this acceptance recorded are undone, so the
   * item waits for the recipient's next activation digest; a digest's own delivery of the item, or
   * a settlement by anything else, is kept.
   */
  withdrawTeamLiveDelivery(input: {
    readonly id: string;
    readonly taskId: string;
    readonly attemptId: string;
  }): Promise<TeamLiveDelivery | undefined>;
  /** Recent live deliveries in the Objective, oldest first, for operator views. */
  listTeamLiveDeliveries(objectiveId: string, limit?: number): Promise<readonly TeamLiveDelivery[]>;
  /**
   * Sent input without confirmed acceptance prevents native resume alongside the next digest.
   * Preparation alone, rejection, and revocation do not. A withdrawal blocks resume only when
   * dispatch began; withdrawing a prepared but never-sent delivery does not.
   */
  hasUnconfirmedTeamLiveDelivery(taskId: string, attemptId: string): Promise<boolean>;
}
