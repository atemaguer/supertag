// biome-ignore-all lint/suspicious/noExplicitAny: Shared Drizzle transaction across dialects.
import { randomUUID } from "node:crypto";
import {
  type DatabaseProvider,
  mailboxText,
  type PrepareTeamLiveDeliveryResult,
  TagMessagingError,
  TEAM_LIVE_DELIVERY_MAX_CHARACTERS,
  TEAM_LIVE_DELIVERY_PAIR_LIMIT,
  TEAM_LIVE_DELIVERY_PENDING_MS,
  type TeamLiveDelivery,
  type TeamLiveDeliveryInput,
  type TeamLiveDeliveryItem,
  type TeamLiveDeliveryStore,
  teamSupportsObjective,
} from "@supertag/core";
import { and, asc, desc, eq, gt, ne, or, sql } from "drizzle-orm";
import { runDialectTransaction } from "./dialect-transaction.js";

/** References and characters of each carried with an injected post. */
const LIVE_MAX_REFERENCES = 5;
const LIVE_REFERENCE_CHARACTERS = 200;

/**
 * Live delivery records. Admission takes the Team row lock that membership and Objective-link
 * changes take, so a sender removed before admission is refused, and the per-pair count for a
 * Task Attempt of that Team is read and written by one admission at a time. Confirmation checks
 * before queuing and again when the harness requests a take. Recording acceptance checks again
 * so revocation after that handoff never advances a digest cursor or settles a message.
 */
export class DrizzleTeamLiveDeliveryStore implements TeamLiveDeliveryStore {
  constructor(
    private readonly db: any,
    private readonly tables: any,
    private readonly provider: DatabaseProvider,
  ) {}

  async findTeamLiveDeliveryTargets(
    input: TeamLiveDeliveryInput,
  ): ReturnType<TeamLiveDeliveryStore["findTeamLiveDeliveryTargets"]> {
    const parsed = parseInput(input);
    const self = this;
    return runDialectTransaction(this.db, this.provider, function* (tx) {
      const item = yield* self.itemIn(tx, parsed);
      if (!item) return [];
      const targets = yield* self.targetsIn(
        tx,
        parsed.recipientTagId,
        parsed.itemKind === "post" ? undefined : item.objectiveId,
        item.teamId,
      );
      return targets.map((target) => ({ taskId: target.taskId, attemptId: target.attemptId }));
    });
  }

  async prepareTeamLiveDelivery(
    input: Parameters<TeamLiveDeliveryStore["prepareTeamLiveDelivery"]>[0],
  ): Promise<PrepareTeamLiveDeliveryResult> {
    const parsed = parseInput(input);
    const taskId = mailboxText(input.taskId, "taskId");
    const attemptId = mailboxText(input.attemptId, "attemptId");
    const self = this;
    const live = this.tables.teamLiveDeliveries;
    return runDialectTransaction(this.db, this.provider, function* (tx) {
      const admitted = yield* self.admissionIn(tx, parsed, taskId, attemptId);
      if (!admitted) return { status: "ineligible" as const };
      const { item, team } = admitted;
      if (yield* self.digestBlocksLiveIn(tx, parsed, item.objectiveId))
        return { status: "duplicate" as const };
      const [existing] = yield tx
        .select({ id: live.id })
        .from(live)
        .where(
          and(
            eq(live.recipientTagId, parsed.recipientTagId),
            eq(live.objectiveId, item.objectiveId),
            eq(live.attemptId, attemptId),
            eq(live.itemKind, parsed.itemKind),
            eq(live.itemId, parsed.itemId),
          ),
        )
        .limit(1);
      if (existing) return { status: "duplicate" as const };
      // A pending delivery left by an interrupted Control Plane stops counting once it is stale,
      // so it cannot hold a slot of the pair's limit for the rest of the Task Attempt.
      const stale = new Date(Date.now() - TEAM_LIVE_DELIVERY_PENDING_MS).toISOString();
      const [count] = yield tx
        .select({ total: sql`count(*)` })
        .from(live)
        .where(
          and(
            eq(live.attemptId, attemptId),
            eq(live.senderTagId, item.from),
            or(ne(live.status, "pending"), gt(live.createdAt, stale)),
          ),
        );
      if (Number(count?.total ?? 0) >= TEAM_LIVE_DELIVERY_PAIR_LIMIT)
        return { status: "capped" as const };
      const at = new Date().toISOString();
      const [row] = yield tx
        .insert(live)
        .values({
          id: randomUUID(),
          objectiveId: item.objectiveId,
          teamId: team.id,
          taskId,
          attemptId,
          // System posts use the lead as a schema-backed cap key; the input still says system.
          senderTagId: deliverySender(item, team),
          recipientTagId: parsed.recipientTagId,
          itemKind: parsed.itemKind,
          itemId: parsed.itemId,
          itemType: item.type,
          status: "pending",
          truncated: item.truncated,
          createdAt: at,
          updatedAt: at,
        })
        .onConflictDoNothing()
        .returning();
      if (!row) return { status: "duplicate" as const };
      const { objectiveId: _objectiveId, createdAt: _createdAt, ...visible } = item;
      return { status: "prepared" as const, delivery: liveDelivery(row), item: visible };
    });
  }

  async confirmTeamLiveDelivery(
    id: string,
    dispatch: () => void,
    atTake = false,
  ): Promise<boolean> {
    const deliveryId = mailboxText(id, "id");
    if (typeof dispatch !== "function") throw new TypeError("dispatch must be a function");
    const self = this;
    const live = this.tables.teamLiveDeliveries;
    return runDialectTransaction(this.db, this.provider, function* (tx) {
      const [row] = yield tx
        .select()
        .from(live)
        .where(and(eq(live.id, deliveryId), eq(live.status, "pending")))
        .limit(1);
      if (!row) return false;
      const parsed = {
        itemKind: row.itemKind as "post" | "direct_message",
        itemId: row.itemId as string,
        recipientTagId: row.recipientTagId as string,
      };
      // Every admission rule again, under the Team lock that a removal takes: a sender removed,
      // a message failed, or an item delivered since admission is never sent.
      const admitted = yield* self.admissionIn(tx, parsed, row.taskId, row.attemptId);
      const stale = new Date(Date.now() - TEAM_LIVE_DELIVERY_PENDING_MS).toISOString();
      const [current] = yield tx
        .select({ status: live.status, createdAt: live.createdAt })
        .from(live)
        .where(eq(live.id, deliveryId))
        .limit(1);
      const delivered = yield* self.digestBlocksLiveIn(tx, parsed, row.objectiveId);
      if (
        admitted &&
        current?.status === "pending" &&
        current.createdAt > stale &&
        deliverySender(admitted.item, admitted.team) === row.senderTagId &&
        !delivered
      ) {
        // Sent before the transaction ends, so before the Team lock is released: a removal waits
        // for it, and one that committed first was seen above. The only side effect here, and it
        // only starts sending: the harness's answer is awaited after commit.
        yield tx
          .update(live)
          .set({ dispatchedAt: new Date().toISOString() })
          .where(and(eq(live.id, deliveryId), eq(live.status, "pending")))
          .returning();
        dispatch();
        return true;
      }
      const qualified = atTake && !delivered && (admitted ?? (yield* self.qualifiedIn(tx, parsed)));
      if (
        atTake &&
        !delivered &&
        (!qualified || deliverySender(qualified.item, qualified.team) !== row.senderTagId)
      ) {
        // Authority was revoked at the native boundary. Expiry, a finished Attempt, or an
        // already-delivered digest instead follows ordinary rejection below and frees the cap.
        yield tx
          .update(live)
          .set({ status: "revoked", dispatchedAt: null, updatedAt: new Date().toISOString() })
          .where(and(eq(live.id, deliveryId), eq(live.status, "pending")))
          .returning();
        return false;
      }
      // Never sent: the item waits for the digest, and the pair's count is unchanged.
      yield tx
        .delete(live)
        .where(and(eq(live.id, deliveryId), eq(live.status, "pending")))
        .returning();
      return false;
    });
  }

  /**
   * Locks the item's Team and checks every admission rule under that lock: the item still
   * qualifies, the Team is active and serves the Objective, sender and recipient are current
   * members, the sender is active, and the Task Attempt is the recipient's running Attempt of a
   * Task of that Team that started no later than the item was created. Direct messages remain
   * Objective-scoped; addressed posts may reach another Objective served by the Team.
   */
  private *admissionIn(
    tx: any,
    parsed: ReturnType<typeof parseInput>,
    taskId: string,
    attemptId: string,
  ): Generator<
    any,
    | { item: TeamLiveDeliveryItem & { objectiveId: string; createdAt: string }; team: any }
    | undefined,
    any
  > {
    const qualified = yield* this.qualifiedIn(tx, parsed);
    if (!qualified) return undefined;
    const { item, team } = qualified;
    const targets = yield* this.targetsIn(
      tx,
      parsed.recipientTagId,
      parsed.itemKind === "post" ? undefined : item.objectiveId,
      team.id,
    );
    const target = targets.find(
      (entry) => entry.taskId === taskId && entry.attemptId === attemptId,
    );
    if (!target) return undefined;
    if (!teamSupportsObjective(team, target.objectiveId)) return undefined;
    // Items created before the Task Attempt started belong to its activation digest.
    if (item.createdAt < target.startedAt) return undefined;
    return { item, team };
  }

  /**
   * Locks the item's Team and checks, under that lock, what a sender's removal, an Objective
   * unlink, a governance move, or a failed message revokes: the item still qualifies, the Team is
   * active and serves the Objective, sender and recipient are current members, and the sender is
   * an active Tag.
   */
  private *qualifiedIn(
    tx: any,
    parsed: ReturnType<typeof parseInput>,
  ): Generator<
    any,
    | { item: TeamLiveDeliveryItem & { objectiveId: string; createdAt: string }; team: any }
    | undefined,
    any
  > {
    const teams = this.tables.teams;
    const unlocked = yield* this.itemIn(tx, parsed);
    if (!unlocked) return undefined;
    // The same lock membership changes and Objective-link changes take on the Team row.
    const [team] = yield tx
      .update(teams)
      .set({ updatedAt: sql`${teams.updatedAt}` })
      .where(eq(teams.id, unlocked.teamId))
      .returning();
    // Read the item again under the lock: a removal that committed first is visible now.
    const item = yield* this.itemIn(tx, parsed);
    if (
      !item ||
      !team ||
      team.status !== "active" ||
      !teamSupportsObjective(team, item.objectiveId) ||
      (item.from !== "system" && !inTeam(team, item.from)) ||
      !inTeam(team, parsed.recipientTagId) ||
      item.from === parsed.recipientTagId
    )
      return undefined;
    if (item.from !== "system") {
      const tags = this.tables.tags;
      const [sender] = yield tx
        .select({ status: tags.status })
        .from(tags)
        .where(eq(tags.id, item.from))
        .limit(1);
      if (sender?.status !== "active") return undefined;
    }
    return { item, team };
  }

  private *digestDeliveredIn(
    tx: any,
    parsed: ReturnType<typeof parseInput>,
    objectiveId: string,
  ): Generator<any, boolean, any> {
    const digest = this.tables.tagDigestDeliveries;
    const [delivered] = yield tx
      .select({ itemId: digest.itemId })
      .from(digest)
      .where(
        and(
          eq(digest.tagId, parsed.recipientTagId),
          eq(digest.objectiveId, objectiveId),
          eq(digest.itemKind, parsed.itemKind),
          eq(digest.itemId, parsed.itemId),
        ),
      )
      .limit(1);
    return !!delivered;
  }

  /** A post accepted by another running Attempt may still reach this Attempt. */
  private *digestBlocksLiveIn(
    tx: any,
    parsed: ReturnType<typeof parseInput>,
    objectiveId: string,
  ): Generator<any, boolean, any> {
    if (!(yield* this.digestDeliveredIn(tx, parsed, objectiveId))) return false;
    if (parsed.itemKind !== "post") return true;
    const live = this.tables.teamLiveDeliveries;
    const [accepted] = yield tx
      .select({ id: live.id })
      .from(live)
      .where(
        and(
          eq(live.recipientTagId, parsed.recipientTagId),
          eq(live.objectiveId, objectiveId),
          eq(live.itemKind, "post"),
          eq(live.itemId, parsed.itemId),
          eq(live.status, "accepted"),
        ),
      )
      .limit(1);
    return !accepted;
  }

  async finishTeamLiveDelivery(
    input: Parameters<TeamLiveDeliveryStore["finishTeamLiveDelivery"]>[0],
  ): Promise<TeamLiveDelivery | undefined> {
    const id = mailboxText(input.id, "id");
    if (!["accepted", "rejected", "unknown"].includes(input.status))
      throw new TagMessagingError(400, "status must be accepted, rejected, or unknown");
    const self = this;
    const live = this.tables.teamLiveDeliveries,
      digest = this.tables.tagDigestDeliveries,
      messages = this.tables.tagMessages;
    return runDialectTransaction(this.db, this.provider, function* (tx) {
      const at = new Date().toISOString();
      if (input.status === "rejected") {
        // Never handed over: the item waits for the digest, and the pair's count is unchanged.
        const [removed] = yield tx
          .delete(live)
          .where(and(eq(live.id, id), eq(live.status, "pending")))
          .returning();
        if (removed) return liveDelivery(removed);
        const [revoked] = yield tx
          .select()
          .from(live)
          .where(and(eq(live.id, id), eq(live.status, "revoked")))
          .limit(1);
        return revoked ? liveDelivery(revoked) : undefined;
      }
      let status: "accepted" | "unknown" | "revoked" = input.status;
      if (status === "accepted") {
        const [pending] = yield tx
          .select()
          .from(live)
          .where(and(eq(live.id, id), eq(live.status, "pending")))
          .limit(1);
        if (!pending) return undefined;
        const parsed = {
          itemKind: pending.itemKind as "post" | "direct_message",
          itemId: pending.itemId as string,
          recipientTagId: pending.recipientTagId as string,
        };
        // Sent while the item qualified, but answered later. If a removal, an Objective unlink, a
        // governance move, or a failed message revoked it meanwhile, the harness may have shown
        // it, yet it is not delivered: no digest cursor and no settlement.
        const qualified = yield* self.qualifiedIn(tx, parsed);
        if (!qualified || deliverySender(qualified.item, qualified.team) !== pending.senderTagId)
          status = "revoked";
      }
      const [row] = yield tx
        .update(live)
        .set({
          status,
          // Acknowledgement also proves handoff if the dispatch transaction failed to commit.
          dispatchedAt: sql`coalesce(${live.dispatchedAt}, ${at})`,
          ...(input.truncated === true ? { truncated: true } : {}),
          updatedAt: at,
        })
        .where(and(eq(live.id, id), eq(live.status, "pending")))
        .returning();
      if (!row || status !== "accepted") return row ? liveDelivery(row) : undefined;
      // Delivered: later activations' digests start after it, as if a digest had delivered it.
      yield tx
        .insert(digest)
        .values({
          tagId: row.recipientTagId,
          objectiveId: row.objectiveId,
          itemKind: row.itemKind,
          itemId: row.itemId,
          deliveredAt: at,
        })
        .onConflictDoNothing()
        .returning();
      // A direct message is settled like one a digest delivered, even a cut one: the injected
      // text says it was cut, the full body stays readable until explicit pruning, and the pair's
      // capacity is released, including for direct messages to the Objective owner.
      if (row.itemKind === "direct_message")
        yield tx
          .update(messages)
          .set({ status: "processed", processedAt: at, updatedAt: at })
          .where(
            and(
              eq(messages.id, row.itemId),
              eq(messages.recipientTagId, row.recipientTagId),
              eq(messages.objectiveId, row.objectiveId),
              eq(messages.status, "pending"),
              sql`${messages.directTeamId} is not null`,
            ),
          )
          .returning({ id: messages.id });
      return liveDelivery(row);
    });
  }

  async withdrawTeamLiveDelivery(
    input: Parameters<TeamLiveDeliveryStore["withdrawTeamLiveDelivery"]>[0],
  ): Promise<TeamLiveDelivery | undefined> {
    const id = mailboxText(input?.id, "id");
    const taskId = mailboxText(input.taskId, "taskId");
    const attemptId = mailboxText(input.attemptId, "attemptId");
    const live = this.tables.teamLiveDeliveries,
      digest = this.tables.tagDigestDeliveries,
      messages = this.tables.tagMessages;
    return runDialectTransaction(this.db, this.provider, function* (tx) {
      // Lock the row first, so a concurrent acknowledgement or withdrawal waits for this one and
      // then finds it withdrawn.
      const [current] = yield tx
        .update(live)
        .set({ updatedAt: sql`${live.updatedAt}` })
        .where(and(eq(live.id, id), eq(live.taskId, taskId), eq(live.attemptId, attemptId)))
        .returning();
      if (current?.status !== "accepted" && current?.status !== "pending") return undefined;
      const at = new Date().toISOString();
      const [row] = yield tx
        .update(live)
        .set({
          status: "withdrawn",
          updatedAt: at,
        })
        .where(and(eq(live.id, id), eq(live.status, current.status)))
        .returning();
      if (!row) return undefined;
      // A pending delivery recorded nothing yet; its later acknowledgement finds it withdrawn.
      if (current.status !== "accepted") return liveDelivery(row);
      // The acceptance recorded its digest delivery and settlement at its updatedAt. Undo only
      // those: a digest that delivered the item, or a read that settled it, used another time.
      const acceptedAt = current.updatedAt as string;
      const digestKey = and(
        eq(digest.tagId, current.recipientTagId),
        eq(digest.objectiveId, current.objectiveId),
        eq(digest.itemKind, current.itemKind),
        eq(digest.itemId, current.itemId),
        eq(digest.deliveredAt, acceptedAt),
      );
      const [otherAccepted] =
        current.itemKind === "post"
          ? yield tx
              .select({ updatedAt: live.updatedAt })
              .from(live)
              .where(
                and(
                  ne(live.id, id),
                  eq(live.recipientTagId, current.recipientTagId),
                  eq(live.objectiveId, current.objectiveId),
                  eq(live.itemKind, current.itemKind),
                  eq(live.itemId, current.itemId),
                  eq(live.status, "accepted"),
                ),
              )
              .orderBy(desc(live.updatedAt))
              .limit(1)
          : [];
      if (otherAccepted)
        yield tx
          .update(digest)
          .set({ deliveredAt: otherAccepted.updatedAt })
          .where(digestKey)
          .returning();
      else yield tx.delete(digest).where(digestKey).returning();
      if (current.itemKind === "direct_message")
        yield tx
          .update(messages)
          .set({ status: "pending", processedAt: null, updatedAt: at })
          .where(
            and(
              eq(messages.id, current.itemId),
              eq(messages.recipientTagId, current.recipientTagId),
              eq(messages.objectiveId, current.objectiveId),
              eq(messages.status, "processed"),
              eq(messages.processedAt, acceptedAt),
              sql`${messages.directTeamId} is not null`,
            ),
          )
          .returning({ id: messages.id });
      return liveDelivery(row);
    });
  }

  async hasUnconfirmedTeamLiveDelivery(taskId: string, attemptId: string): Promise<boolean> {
    const live = this.tables.teamLiveDeliveries;
    const rows = await this.db
      .select({ id: live.id })
      .from(live)
      .where(
        and(
          eq(live.taskId, mailboxText(taskId, "taskId")),
          eq(live.attemptId, mailboxText(attemptId, "attemptId")),
          sql`${live.dispatchedAt} is not null`,
          or(eq(live.status, "pending"), eq(live.status, "unknown"), eq(live.status, "withdrawn")),
        ),
      )
      .limit(1);
    return rows.length > 0;
  }

  async listTeamLiveDeliveries(
    objectiveId: string,
    limit = 200,
  ): Promise<readonly TeamLiveDelivery[]> {
    const id = mailboxText(objectiveId, "objectiveId");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500)
      throw new TagMessagingError(400, "limit must be 1–500");
    const live = this.tables.teamLiveDeliveries;
    const rows = await this.db
      .select()
      .from(live)
      .where(eq(live.objectiveId, id))
      .orderBy(desc(live.createdAt), desc(live.id))
      .limit(limit);
    return rows.map(liveDelivery).reverse();
  }

  /**
   * The item as stored, if it still qualifies for its recipient: a post written under its
   * Objective that addresses the recipient, or a pending direct message to the recipient within
   * a Team. Membership is checked by the caller.
   */
  private *itemIn(
    tx: any,
    input: ReturnType<typeof parseInput>,
  ): Generator<
    any,
    | (TeamLiveDeliveryItem & { readonly objectiveId: string; readonly createdAt: string })
    | undefined,
    any
  > {
    if (input.itemKind === "post") {
      const p = this.tables.workstreamPosts;
      const [post] = yield tx.select().from(p).where(eq(p.id, input.itemId)).limit(1);
      const to = (Array.isArray(post?.to) ? post.to : []).map(String);
      if (!post || !to.includes(input.recipientTagId)) return undefined;
      const text = liveText(post.body);
      return {
        kind: "post",
        id: post.id,
        from: post.authorTagId ?? "system",
        type: post.type,
        teamId: post.workstreamId,
        objectiveId: post.objectiveId,
        createdAt: post.createdAt,
        workstreamId: post.workstreamId,
        sequence: post.sequence,
        ...(post.replyTo ? { inReplyTo: post.replyTo } : {}),
        references: (Array.isArray(post.references) ? post.references : [])
          .slice(0, LIVE_MAX_REFERENCES)
          .map((reference: unknown) => liveText(reference, LIVE_REFERENCE_CHARACTERS).text),
        ...text,
      };
    }
    const m = this.tables.tagMessages,
      o = this.tables.objectives;
    const [message] = yield tx.select().from(m).where(eq(m.id, input.itemId)).limit(1);
    if (
      !message ||
      message.recipientTagId !== input.recipientTagId ||
      !message.directTeamId ||
      message.bodyPrunedAt ||
      message.operatorId
    )
      return undefined;
    const [objective] = yield tx
      .select({ ownerTagId: o.ownerTagId })
      .from(o)
      .where(eq(o.id, message.objectiveId))
      .limit(1);
    if (!objective) return undefined;
    if (message.status !== "pending") return undefined;
    const body = message.body as Record<string, unknown>;
    const value = typeof body?.["message"] === "string" ? body["message"] : undefined;
    const text = liveText(value ?? body);
    // Other body fields are left out of the injected text, so it is cut too.
    const partial = value !== undefined && Object.keys(body).some((key) => key !== "message");
    return {
      kind: "direct_message",
      id: message.id,
      from: message.senderTagId,
      type: message.type,
      teamId: message.directTeamId,
      objectiveId: message.objectiveId,
      createdAt: message.createdAt,
      ...(message.inReplyTo ? { inReplyTo: message.inReplyTo } : {}),
      references: [],
      text: text.text,
      truncated: text.truncated || partial,
    };
  }

  /** The recipient's running Task Attempt in the Team, optionally in one Objective, newest first. */
  private *targetsIn(
    tx: any,
    recipientTagId: string,
    objectiveId: string | undefined,
    teamId: string,
  ): Generator<
    any,
    { taskId: string; attemptId: string; objectiveId: string; startedAt: string }[],
    any
  > {
    const a = this.tables.taskAssignments,
      attempts = this.tables.taskAttempts;
    const rows: any[] = yield tx
      .select({
        taskId: a.taskId,
        attemptId: attempts.id,
        objectiveId: a.objectiveId,
        startedAt: attempts.startedAt,
      })
      .from(a)
      .innerJoin(
        attempts,
        and(eq(attempts.taskId, a.taskId), eq(attempts.attemptNumber, a.attemptCount)),
      )
      .where(
        and(
          eq(a.assignedTagId, recipientTagId),
          ...(objectiveId === undefined ? [] : [eq(a.objectiveId, objectiveId)]),
          eq(a.teamId, teamId),
          eq(a.status, "running"),
          eq(attempts.status, "running"),
        ),
      )
      .orderBy(desc(attempts.startedAt), asc(a.taskId));
    return objectiveId === undefined ? rows : rows.slice(0, 1);
  }
}

function parseInput(input: TeamLiveDeliveryInput) {
  if (input?.itemKind !== "post" && input?.itemKind !== "direct_message")
    throw new TagMessagingError(400, "itemKind must be post or direct_message");
  return {
    itemKind: input.itemKind,
    itemId: mailboxText(input.itemId, "itemId"),
    recipientTagId: mailboxText(input.recipientTagId, "recipientTagId"),
  };
}

function deliverySender(item: TeamLiveDeliveryItem, team: { leadTagId: string }): string {
  return item.from === "system" ? team.leadTagId : item.from;
}

function inTeam(team: any, tagId: string): boolean {
  const members = Array.isArray(team.memberTagIds) ? team.memberTagIds.map(String) : [];
  return team.leadTagId === tagId || members.includes(tagId);
}

function liveText(
  value: unknown,
  limit = TEAM_LIVE_DELIVERY_MAX_CHARACTERS,
): { text: string; truncated: boolean } {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? null);
  return text.length > limit
    ? { text: `${text.slice(0, limit - 1)}…`, truncated: true }
    : { text, truncated: false };
}

function liveDelivery(row: any): TeamLiveDelivery {
  return {
    id: row.id,
    objectiveId: row.objectiveId,
    teamId: row.teamId,
    taskId: row.taskId,
    attemptId: row.attemptId,
    senderTagId: row.senderTagId,
    recipientTagId: row.recipientTagId,
    itemKind: row.itemKind,
    itemId: row.itemId,
    itemType: row.itemType,
    status: row.status,
    truncated: Boolean(row.truncated),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
