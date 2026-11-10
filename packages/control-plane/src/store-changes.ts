import type {
  ApprovalRequest,
  CoordinationInboxItem,
  Objective,
  Session,
  Store,
  Tag,
  Task,
  WorkstreamPost,
} from "@supertag/core";
import type { ChangeNotice, ChangeNotifications } from "./change-notifications.js";
import { messageConversation, parseCliConversationKey } from "./conversations.js";

/** What one store write changed, before the notice names its Tag, Session and conversation. */
type StoreChange =
  | { readonly kind: "tag"; readonly tag: Tag; readonly reason: string }
  | { readonly kind: "tag-id"; readonly tagId: string; readonly reason: string }
  | { readonly kind: "session"; readonly session: Session; readonly reason: string }
  | { readonly kind: "task"; readonly taskId: string; readonly reason: string }
  | { readonly kind: "objective"; readonly objective: Objective; readonly reason: string }
  | { readonly kind: "approval"; readonly request: ApprovalRequest; readonly reason: string }
  | { readonly kind: "reply"; readonly inboundEventId: string; readonly reason: string }
  | { readonly kind: "post"; readonly post: WorkstreamPost; readonly reason: string }
  | { readonly kind: "team"; readonly teamId: string; readonly reason: string };

interface StoreWrite {
  /** Reads what the write is about before it runs, as a Tag that it deletes. */
  readonly before?: (store: Store, args: readonly unknown[]) => Promise<unknown>;
  readonly changes: (
    args: readonly unknown[],
    result: unknown,
    before: unknown,
  ) => readonly StoreChange[];
}

const tagWrite =
  (reason: string): StoreWrite["changes"] =>
  ([tagId]) =>
    typeof tagId === "string" ? [{ kind: "tag-id", tagId, reason }] : [];
const objectiveWrite =
  (reason: string): StoreWrite["changes"] =>
  (_args, result) => {
    const objective =
      isRecord(result) && isRecord(result["objective"]) ? result["objective"] : result;
    return isObjective(objective) ? [{ kind: "objective", objective, reason }] : [];
  };
const approvalWrite =
  (reason: string): StoreWrite["changes"] =>
  (_args, result) => {
    const request = isRecord(result) && isRecord(result["request"]) ? result["request"] : result;
    return isApproval(request) ? [{ kind: "approval", request, reason }] : [];
  };

/** The store writes that change what operators watch, and what each changed. */
const STORE_WRITES: Readonly<Record<string, StoreWrite>> = {
  createTag: { changes: (_args, tag) => [{ kind: "tag", tag: tag as Tag, reason: "created" }] },
  retireTag: { changes: (_args, tag) => [{ kind: "tag", tag: tag as Tag, reason: "retired" }] },
  deleteTag: {
    before: (store, [id]) => store.findTagById(String(id)),
    changes: (_args, deleted, tag) =>
      deleted === true && tag !== undefined
        ? [{ kind: "tag", tag: tag as Tag, reason: "deleted" }]
        : [],
  },
  bindTagWorkerHost: { changes: tagWrite("Worker Host bound") },
  unbindTagWorkerHost: { changes: tagWrite("Worker Host unbound") },
  setTagRunsOn: { changes: tagWrite("runsOn changed") },
  setTagExecution: { changes: tagWrite("execution changed") },
  addTagRoute: {
    changes: ([input]) =>
      isRecord(input) && typeof input["tagId"] === "string"
        ? [{ kind: "tag-id", tagId: input["tagId"], reason: "location added" }]
        : [],
  },
  openSession: {
    changes: (_args, session) => [
      { kind: "session", session: session as Session, reason: "opened" },
    ],
  },
  openTask: {
    changes: (_args, task) => [{ kind: "task", taskId: (task as Task).id, reason: "created" }],
  },
  appendTaskEvent: {
    changes: ([input]) => {
      if (!isRecord(input) || typeof input["taskId"] !== "string") return [];
      const type = typeof input["type"] === "string" ? input["type"] : "";
      return type.startsWith("task.")
        ? [{ kind: "task", taskId: input["taskId"], reason: taskReason(type) }]
        : [];
    },
  },
  enqueueOutboundReply: {
    changes: ([input]) =>
      isRecord(input) && typeof input["inboundEventId"] === "string"
        ? [
            {
              kind: "reply",
              inboundEventId: input["inboundEventId"],
              reason: `${String(input["presentation"] ?? "reply")} posted`,
            },
          ]
        : [],
  },
  createObjective: {
    changes: (args, result) => {
      const options = args[1];
      if (isRecord(options) && options["dryRun"] === true) return [];
      return objectiveWrite("created")(args, result, undefined);
    },
  },
  createSurfaceObjective: { changes: objectiveWrite("created") },
  updateObjectiveStatus: { changes: objectiveWrite("status changed") },
  recordObjectiveLimitState: { changes: objectiveWrite("limits changed") },
  cancelObjective: { changes: objectiveWrite("status cancelled") },
  pauseObjective: { changes: objectiveWrite("paused") },
  resumeObjective: { changes: objectiveWrite("resumed") },
  createApprovalRequest: { changes: approvalWrite("created") },
  requestActionApproval: {
    changes: (args, result) =>
      isRecord(result) && result["status"] === "pending" && result["created"] === true
        ? approvalWrite("created")(args, result, undefined)
        : [],
  },
  decideApprovalRequest: { changes: approvalWrite("decided") },
  post: {
    changes: (_args, result) =>
      isRecord(result) && result["duplicate"] === false && isRecord(result["post"])
        ? [{ kind: "post", post: result["post"] as unknown as WorkstreamPost, reason: "posted" }]
        : [],
  },
  expireApprovalRequest: { changes: approvalWrite("expired") },
  createTeam: { changes: (_args, team) => teamChange(team, "created") },
  updateTeam: { changes: (_args, team) => teamChange(team, "changed") },
  deleteTeam: {
    changes: ([id], deleted) =>
      deleted === true && typeof id === "string"
        ? [{ kind: "team", teamId: id, reason: "deleted" }]
        : [],
  },
};

function teamChange(team: unknown, reason: string): readonly StoreChange[] {
  return isRecord(team) && typeof team["id"] === "string"
    ? [{ kind: "team", teamId: team["id"], reason }]
    : [];
}

/** How long an inbox rescan waits for more changes after the one that asked for it. */
const INBOX_SCAN_DELAY_MS = 500;
const INBOX_PAGE_SIZE = 100;
const INBOX_MAX_PAGES = 20;

/**
 * Returns `store` with each write that changes what operators watch publishing a notice to
 * `changes`: Tags, Sessions, Tasks, Objectives, approval requests, messages in CLI conversations,
 * Workstream posts, Teams, and the inbox items they make, which it finds by rereading the inbox. A
 * notice is published once the write succeeds, in the order the writes finished; naming it reads
 * the store, which never fails the write.
 */
export function observeStoreChanges<S extends Store>(
  store: S,
  changes: ChangeNotifications,
  onError: (error: unknown) => void = () => {},
): S {
  const observer = new StoreChangeObserver(store, changes, onError);
  const wrapped = new Map<PropertyKey, unknown>();
  return new Proxy(store, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property, target);
      if (typeof value !== "function") return value;
      const cached = wrapped.get(property);
      if (cached !== undefined) return cached;
      const method = value as (...args: unknown[]) => unknown;
      const write = typeof property === "string" ? STORE_WRITES[property] : undefined;
      const result =
        write === undefined
          ? property === "connect"
            ? async (...args: unknown[]) => {
                const connected = await method.apply(target, args);
                observer.open();
                return connected;
              }
            : property === "disconnect"
              ? async (...args: unknown[]) => {
                  await observer.close();
                  return method.apply(target, args);
                }
              : method.bind(target)
          : async (...args: unknown[]) => {
              const before = await write.before?.(target, args).catch(() => undefined);
              const returned = await method.apply(target, args);
              observer.record(write.changes(args, returned, before));
              return returned;
            };
      wrapped.set(property, result);
      return result;
    },
  });
}

class StoreChangeObserver {
  readonly #store: Store;
  readonly #changes: ChangeNotifications;
  readonly #onError: (error: unknown) => void;
  #publishing: Promise<void> = Promise.resolve();
  #open = false;
  /**
   * Each inbox item's fingerprint as last read. It starts empty rather than read at startup, so
   * an idle Control Plane never reads the inbox; the first rescan reports every item it finds.
   */
  #inbox = new Map<string, string>();
  #inboxScan: NodeJS.Timeout | undefined;
  #scanning: Promise<void> = Promise.resolve();

  constructor(store: Store, changes: ChangeNotifications, onError: (error: unknown) => void) {
    this.#store = store;
    this.#changes = changes;
    this.#onError = onError;
  }

  /** Starts publishing once the store is connected. */
  open(): void {
    this.#open = true;
  }

  /** Publishes what was already found, then nothing more, before the store disconnects. */
  async close(): Promise<void> {
    this.#open = false;
    clearTimeout(this.#inboxScan);
    this.#inboxScan = undefined;
    await Promise.all([this.#publishing, this.#scanning]);
  }

  record(found: readonly StoreChange[]): void {
    if (found.length === 0 || !this.#open) return;
    const changedAt = new Date().toISOString();
    this.#publishing = this.#publishing.then(async () => {
      for (const change of found) {
        try {
          for (const notice of await this.#notices(change, changedAt))
            this.#changes.publish(notice);
        } catch (error) {
          this.#onError(error);
        }
        if (change.kind === "task" || change.kind === "objective" || change.kind === "approval")
          this.scanInbox();
      }
    });
  }

  /** Rereads the inbox soon and publishes a notice for each item that appeared, changed or went. */
  scanInbox(): void {
    if (this.#inboxScan !== undefined || !this.#open) return;
    this.#inboxScan = setTimeout(() => {
      this.#inboxScan = undefined;
      this.#scanning = this.#scanning.then(() => this.#scanInbox()).catch(this.#onError);
    }, INBOX_SCAN_DELAY_MS);
    this.#inboxScan.unref();
  }

  async #scanInbox(): Promise<void> {
    const items: CoordinationInboxItem[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < INBOX_MAX_PAGES; page += 1) {
      const read = await this.#store.readCoordinationInbox({
        includeApprovals: true,
        limit: INBOX_PAGE_SIZE,
        ...(cursor === undefined ? {} : { cursor }),
      });
      items.push(...read.items);
      cursor = read.nextCursor;
      if (cursor === undefined) break;
    }
    const current = new Map(items.map((item) => [item.key, inboxFingerprint(item)] as const));
    const previous = this.#inbox;
    this.#inbox = current;
    const changedAt = new Date().toISOString();
    const objectives = new Map(items.map((item) => [item.key, item.objectiveId] as const));
    const publish = (key: string, reason: string, objectiveId: string | null | undefined) =>
      this.#publishing.then(() =>
        this.#changes.publish({
          kind: "inbox_item",
          id: key,
          ...(objectiveId ? { objectiveId } : {}),
          reason,
          changedAt,
        }),
      );
    for (const [key, fingerprint] of current) {
      const before = previous.get(key);
      if (before === fingerprint) continue;
      this.#publishing = publish(
        key,
        before === undefined ? "appeared" : "changed",
        objectives.get(key),
      );
    }
    for (const [key, fingerprint] of previous)
      if (!current.has(key))
        this.#publishing = publish(key, "resolved", inboxObjectiveId(fingerprint));
    await this.#publishing;
  }

  async #notices(change: StoreChange, changedAt: string): Promise<readonly ChangeNotice[]> {
    if (change.kind === "tag" || change.kind === "tag-id") {
      const tag = change.kind === "tag" ? change.tag : await this.#store.findTagById(change.tagId);
      if (tag === undefined) return [];
      return [{ kind: "tag", id: tag.id, tag: tag.name, reason: change.reason, changedAt }];
    }
    if (change.kind === "session") {
      const owner = await this.#sessionOwner(change.session);
      return [
        {
          kind: "session",
          id: change.session.id,
          ...(await this.#tagName(change.session.tagId)),
          ...owner,
          reason: change.reason,
          changedAt,
        },
      ];
    }
    if (change.kind === "objective") {
      const tag = await this.#tagName(change.objective.ownerTagId);
      return [
        {
          kind: "objective",
          id: change.objective.id,
          ...tag,
          objectiveId: change.objective.id,
          reason: change.reason,
          changedAt,
        },
      ];
    }
    if (change.kind === "approval") {
      const request = change.request;
      const task = await this.#store.findTaskById(request.taskId);
      return [
        {
          kind: "approval",
          id: request.id,
          taskId: request.taskId,
          ...(request.objectiveId === null ? {} : { objectiveId: request.objectiveId }),
          reason: change.reason,
          changedAt,
        },
        ...(task === undefined
          ? []
          : await this.#conversationMessages(task, `approval request ${change.reason}`, changedAt)),
      ];
    }
    if (change.kind === "post")
      return [
        {
          kind: "workstream_post",
          id: change.post.id,
          teamId: change.post.teamId,
          reason: change.reason,
          changedAt,
        },
      ];
    if (change.kind === "team")
      return [
        {
          kind: "team",
          id: change.teamId,
          teamId: change.teamId,
          reason: change.reason,
          changedAt,
        },
      ];
    if (change.kind === "reply") {
      const task = await this.#taskOfInboundEvent(change.inboundEventId);
      return task === undefined ? [] : this.#conversationMessages(task, change.reason, changedAt);
    }
    const task = await this.#store.findTaskById(change.taskId);
    if (task === undefined) return [];
    const session = await this.#store.findSessionById(task.sessionId);
    const owner = session === undefined ? {} : await this.#sessionOwner(session);
    const tag = await this.#tagName(task.tagId);
    return [
      {
        kind: "task",
        id: task.id,
        ...tag,
        sessionId: task.sessionId,
        ...(task.objectiveId === undefined ? {} : { objectiveId: task.objectiveId }),
        ...owner,
        reason: change.reason,
        changedAt,
      },
      ...(change.reason.startsWith("status ")
        ? [
            {
              kind: "session" as const,
              id: task.sessionId,
              ...tag,
              ...owner,
              reason: `Task ${change.reason}`,
              changedAt,
            },
          ]
        : []),
      ...(await this.#conversationMessages(task, change.reason, changedAt)),
    ];
  }

  /**
   * The messages a change to `task` changes: the Task itself when it is one, the message that
   * started its work Session or that its report answers, and the messages that joined it.
   */
  async #conversationMessages(
    task: Task,
    reason: string,
    changedAt: string,
  ): Promise<readonly ChangeNotice[]> {
    const messages = new Map<string, Task>([[task.id, task]]);
    const session = await this.#store.findSessionById(task.sessionId);
    if (session?.parentSessionId !== undefined) {
      const work = (await this.#store.listWorkSessions(session.parentSessionId)).find(
        (candidate) => candidate.sessionId === session.id,
      );
      const starter = work?.task?.startedByTaskId ?? work?.startedByTaskId;
      const started = starter === undefined ? undefined : await this.#store.findTaskById(starter);
      if (started !== undefined) messages.set(started.id, started);
    }
    if (task.inboundEventId) {
      const internal = (await this.#store.findInboundEventById(task.inboundEventId))?.event
        .internal;
      if (internal?.kind === "session_report") {
        const started = await this.#store.findTaskById(internal.startedByTaskId);
        if (started !== undefined) messages.set(started.id, started);
      }
    }
    if (reason.startsWith("status ") && session?.parentSessionId === undefined)
      for (const joined of await this.#store.listTasks({ sessionId: task.sessionId, limit: 20 }))
        if (joined.outcome?.["targetTaskId"] === task.id) messages.set(joined.id, joined);
    const notices: ChangeNotice[] = [];
    for (const message of messages.values()) {
      const conversation = await messageConversation(this.#store, message);
      if (conversation === undefined) continue;
      notices.push({
        kind: "conversation_message",
        id: message.id,
        ...(await this.#tagName(message.tagId)),
        sessionId: message.sessionId,
        conversation: conversation.name,
        conversationOwner: conversation.owner,
        reason: message.id === task.id ? reason : `work Session ${reason}`,
        changedAt,
      });
    }
    return notices;
  }

  /** The operator a CLI conversation's Session, or a work Session it started, belongs to. */
  async #sessionOwner(
    session: Session,
  ): Promise<{ readonly conversation?: string; readonly conversationOwner?: string }> {
    const own = parseCliConversationKey(session.sessionKey);
    if (own !== undefined) return { conversation: own.name, conversationOwner: own.operatorId };
    if (session.parentSessionId === undefined) return {};
    const parent = await this.#store.findSessionById(session.parentSessionId);
    const started = parent === undefined ? undefined : parseCliConversationKey(parent.sessionKey);
    return started === undefined ? {} : { conversationOwner: started.operatorId };
  }

  async #taskOfInboundEvent(inboundEventId: string): Promise<Task | undefined> {
    const inbound = await this.#store.findInboundEventById(inboundEventId);
    if (inbound?.event.provider !== "cli") return undefined;
    const session = await this.#store.findSessionByTagAndKey(inbound.tagId, inbound.sessionKey);
    if (session === undefined) return undefined;
    return (await this.#store.listTasks({ sessionId: session.id, limit: 50 })).find(
      (task) => task.inboundEventId === inboundEventId,
    );
  }

  async #tagName(tagId: string): Promise<{ readonly tag?: string }> {
    const tag = await this.#store.findTagById(tagId);
    return tag === undefined ? {} : { tag: tag.name };
  }
}

function taskReason(type: string): string {
  const event = type.slice("task.".length);
  if (event === "started") return "status running";
  if (event === "completed" || event === "failed" || event === "cancelled")
    return `status ${event}`;
  return event.replaceAll("-", " ");
}

/** What makes an inbox item different to its reader; its age does not. */
function inboxFingerprint(item: CoordinationInboxItem): string {
  return JSON.stringify([
    item.objectiveId,
    item.kind,
    item.status,
    item.reason,
    item.nextActorTagIds,
    item.deadline,
    item.evidence,
    item.approval,
    item.question,
    item.uncertainAttempt,
  ]);
}

function inboxObjectiveId(fingerprint: string): string | undefined {
  const [objectiveId] = JSON.parse(fingerprint) as [string | null];
  return objectiveId ?? undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isObjective(value: unknown): value is Objective {
  return (
    isRecord(value) && typeof value["id"] === "string" && typeof value["ownerTagId"] === "string"
  );
}

function isApproval(value: unknown): value is ApprovalRequest {
  return isRecord(value) && typeof value["id"] === "string" && typeof value["taskId"] === "string";
}
