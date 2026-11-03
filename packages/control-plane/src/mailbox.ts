import { createHash, randomBytes, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import {
  mailboxObject,
  mailboxText,
  parseCreateObjective,
  parseObjectiveStatus,
  parsePostWorkstream,
  parseTagMessageInput,
  type Store,
  type TagMailboxCredential,
  type TagMessage,
  type TagMessageDelivery,
  type TagMessageType,
  TagMessagingError,
  type WorkstreamPost,
} from "@supertag/core";
import { tagRuntimeActions } from "./roles.js";

type MailboxPersistence = Pick<
  Store,
  | "claimTagMessage"
  | "createObjective"
  | "createTagMailboxCredential"
  | "enqueueTagMessage"
  | "findTagMailboxCredential"
  | "getObjective"
  | "getWorkstream"
  | "listVisibleObjectives"
  | "listTagMessageHistory"
  | "listWorkstreamPosts"
  | "listWorkstreams"
  | "postWorkstream"
  | "renewTagMessage"
  | "setTagMessagingGrant"
  | "settleTagMessage"
  | "updateObjectiveStatus"
  // Role resolution for an Objective's default runtime actions.
  | "findSurfaceAccountById"
  | "findRoleById"
  | "findTagContextSetById"
  | "findTagPermissionSetById"
  | "listRoleAssignments"
  | "listTagContextItems"
  | "listTagPermissions"
>;

/** Starts live delivery of stored Team coordination to running teammates. */
export interface TeamLiveDeliveryStarter {
  deliverPost(post: WorkstreamPost): void;
  deliverDirectMessage(message: TagMessage): void;
}

/** Control-Plane-owned coordination; credentials identify a Tag independently of any surface. */
export class TagMailboxService {
  constructor(
    private readonly store: MailboxPersistence,
    /** The Control Plane's live delivery; without it, posts and messages wait for digests. */
    private readonly live?: TeamLiveDeliveryStarter,
  ) {}

  async issueCredential(tagId: string): Promise<TagMailboxCredential & { readonly token: string }> {
    const credential = {
      id: randomUUID(),
      tagId: mailboxText(tagId, "tagId"),
      createdAt: new Date().toISOString(),
    };
    const token = `stm_${randomBytes(32).toString("base64url")}`;
    await this.store.createTagMailboxCredential({ ...credential, tokenHash: digest(token) });
    return { ...credential, token };
  }

  async authenticate(token: string | undefined): Promise<TagMailboxCredential> {
    if (!token || token.length > 256)
      throw new TagMessagingError(401, "A valid Tag mailbox credential is required");
    const identity = await this.store.findTagMailboxCredential(digest(token));
    if (!identity) throw new TagMessagingError(401, "A valid Tag mailbox credential is required");
    return identity;
  }

  async setGrant(value: unknown): Promise<void> {
    const record = mailboxObject(value, ["senderTagId", "recipientTagId", "messageTypes"]);
    await this.store.setTagMessagingGrant({
      senderTagId: mailboxText(record["senderTagId"], "senderTagId"),
      recipientTagId: mailboxText(record["recipientTagId"], "recipientTagId"),
      messageTypes: record["messageTypes"] as readonly TagMessageType[],
    });
  }

  async createObjective(token: string | undefined, value: unknown) {
    const identity = await this.authenticate(token);
    if (typeof value === "object" && value !== null && "runtimeActions" in value)
      throw new TagMessagingError(403, "Only operators may grant Objective runtime actions");
    if (typeof value === "object" && value !== null && "workspaces" in value)
      throw new TagMessagingError(403, "Only operators may name Objective workspaces");
    const definition = parseCreateObjective(value);
    if (definition.observations?.length)
      throw new TagMessagingError(403, "Only operators may configure Objective observations");
    // The creating Tag owns the Objective, so the default, its own Permission Sets' runtime
    // actions, never exceeds what it could already use. A retry keeps the recorded actions.
    const prior = await this.store.getObjective(definition.id).catch(() => undefined);
    return this.store.createObjective({
      ...definition,
      runtimeActions:
        prior?.ownerTagId === identity.tagId
          ? (prior.runtimeActions ?? [])
          : await tagRuntimeActions(this.store, identity.tagId),
      ownerTagId: identity.tagId,
    });
  }
  async getObjective(token: string | undefined, id: string) {
    const identity = await this.authenticate(token);
    return this.store.getObjective(id, identity.tagId);
  }
  async listObjectives(token: string | undefined, value: unknown) {
    const identity = await this.authenticate(token);
    const record = mailboxObject(value, ["limit"]);
    return this.store.listVisibleObjectives(identity.tagId, record["limit"] as number | undefined);
  }
  async updateObjectiveStatus(token: string | undefined, id: string, value: unknown) {
    const identity = await this.authenticate(token);
    return this.store.updateObjectiveStatus(id, parseObjectiveStatus(value), identity.tagId);
  }

  async getWorkstream(token: string | undefined, id: string) {
    const identity = await this.authenticate(token);
    return this.store.getWorkstream(id, identity.tagId);
  }

  async listWorkstreams(token: string | undefined, value: unknown) {
    const identity = await this.authenticate(token);
    const record = mailboxObject(value, ["limit"]);
    return this.store.listWorkstreams(identity.tagId, record["limit"] as number | undefined);
  }

  async history(token: string | undefined, value: unknown) {
    const identity = await this.authenticate(token);
    const input = mailboxObject(value, ["before", "limit"]);
    let before: { createdAt: string; id: string } | undefined;
    if (input["before"] !== undefined) {
      const cursor = mailboxObject(input["before"], ["createdAt", "id"]);
      before = {
        createdAt: mailboxText(cursor["createdAt"], "createdAt"),
        id: mailboxText(cursor["id"], "id"),
      };
    }
    return this.store.listTagMessageHistory(identity.tagId, {
      ...(before === undefined ? {} : { before }),
      ...(input["limit"] === undefined ? {} : { limit: input["limit"] as number }),
    });
  }

  async postWorkstream(token: string | undefined, id: string, value: unknown) {
    const identity = await this.authenticate(token);
    const record = mailboxObject(value, [
      "body",
      "type",
      "to",
      "references",
      "replyTo",
      "idempotencyKey",
    ]);
    const post = await this.store.postWorkstream(
      parsePostWorkstream({ ...record, workstreamId: id, authorTagId: identity.tagId }),
    );
    this.live?.deliverPost(post);
    return post;
  }

  async listWorkstreamPosts(token: string | undefined, id: string, value: unknown) {
    const identity = await this.authenticate(token);
    const record = mailboxObject(value, ["afterSequence", "limit"]);
    return this.store.listWorkstreamPosts(id, identity.tagId, {
      ...(record["afterSequence"] === undefined
        ? {}
        : { afterSequence: record["afterSequence"] as number }),
      ...(record["limit"] === undefined ? {} : { limit: record["limit"] as number }),
    });
  }

  async send(token: string | undefined, value: unknown) {
    const identity = await this.authenticate(token);
    const sent = await this.store.enqueueTagMessage({
      ...parseTagMessageInput(value),
      senderTagId: identity.tagId,
    });
    this.live?.deliverDirectMessage(sent.message);
    return sent;
  }

  async receive(
    token: string | undefined,
    value: unknown,
    signal?: AbortSignal,
  ): Promise<TagMessageDelivery | undefined> {
    const record = mailboxObject(value, ["waitMs", "leaseMs"]);
    const waitMs = duration(record["waitMs"], 0, 0, 20_000);
    const leaseMs = duration(record["leaseMs"], 60_000, 5_000, 300_000);
    const deadline = Date.now() + waitMs;
    for (;;) {
      signal?.throwIfAborted();
      // Recheck revocation while long-polling; no stale authenticated waiter can claim work.
      const identity = await this.authenticate(token);
      const now = new Date();
      const delivery = await this.store.claimTagMessage({
        tagId: identity.tagId,
        credentialId: identity.id,
        now: now.toISOString(),
        leaseExpiresAt: new Date(now.getTime() + leaseMs).toISOString(),
      });
      if (delivery) return delivery;
      const remaining = deadline - Date.now();
      if (remaining <= 0) return undefined;
      await delay(Math.min(250, remaining), undefined, signal === undefined ? {} : { signal });
    }
  }

  async settle(
    token: string | undefined,
    messageId: string,
    action: "ack" | "release" | "renew",
    value: unknown,
  ): Promise<void> {
    const identity = await this.authenticate(token);
    const record = mailboxObject(
      value,
      action === "renew"
        ? ["leaseToken", "leaseMs"]
        : action === "release"
          ? ["leaseToken", "retry"]
          : ["leaseToken"],
    );
    const input = {
      tagId: identity.tagId,
      credentialId: identity.id,
      messageId: mailboxText(messageId, "messageId"),
      leaseToken: mailboxText(record["leaseToken"], "leaseToken"),
      now: new Date().toISOString(),
    };
    let ok: boolean;
    if (action === "renew") {
      const leaseMs = duration(record["leaseMs"], 60_000, 5_000, 300_000);
      ok = await this.store.renewTagMessage({
        ...input,
        leaseExpiresAt: new Date(Date.parse(input.now) + leaseMs).toISOString(),
      });
    } else {
      if (
        action === "release" &&
        record["retry"] !== undefined &&
        typeof record["retry"] !== "boolean"
      ) {
        throw new TagMessagingError(400, "retry must be a boolean");
      }
      ok = await this.store.settleTagMessage({
        ...input,
        status: action === "ack" ? "processed" : record["retry"] === true ? "pending" : "failed",
      });
    }
    if (!ok)
      throw new TagMessagingError(
        409,
        "Message lease is expired or no longer owned by this consumer",
      );
  }
}
function digest(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
function duration(value: unknown, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new TagMessagingError(
      400,
      `Duration must be an integer between ${min} and ${max} milliseconds`,
    );
  }
  return value;
}
