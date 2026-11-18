import { Channel, invoke } from "@tauri-apps/api/core";

export interface Tag {
  tagId: string;
  name?: string;
  instructions: string;
  allowedActions: string[];
  revision: number;
  harnessKind: string;
  /** Whether this is the Gateway's lead Tag, the one `supertag init` creates. */
  lead?: boolean;
  /** How many Work Sessions the Tag may have open at once, and has open. */
  maxWorkSessions?: number;
  openWorkSessions?: number;
}

export interface Task {
  taskId: string;
  tagId: string;
  sessionId: string;
  prompt?: string;
  state: string;
  result?: string;
  /** When the operator sent it, in milliseconds since the epoch, once the Gateway says. */
  createdAtMs?: number;
  /** The turn finished quietly: no person was waiting and it found nothing to say. */
  quiet?: boolean;
  /** The Worker Host holding the Session's last delivery, which the running turn waits for. */
  waitingForHolder?: string;
}

export interface Message {
  task: Task;
  /** The message's place in its conversation. Later messages have larger orders. */
  order: number;
  /** When its turn finished, if the Gateway recorded it. */
  completedAtMs?: number;
  liveInput?: { taskId: string; state: string };
  workSessionReportId?: string;
  /** The Schedule that queued this turn. It has no message from the operator. */
  scheduleId?: string;
  /** For a report turn whose work Session has since closed: why, such as `idle`. */
  workSessionClosed?: string;
  /**
   * What the turn shows from its events, oldest first: each message the Tag wrote and its latest
   * activity or plan. The last is the turn's latest event.
   */
  events?: TaskEvent[];
  /** Earlier messages the Tag wrote were left out; `events` reads them. */
  eventsTruncated?: boolean;
}

/** The caller's one conversation with a Tag, as a conversation list shows it. */
export interface Conversation {
  tagId: string;
  conversationId: string;
  /** The latest message: the Tag's reply when it finished, otherwise the caller's message. */
  preview: string;
  previewFromTag: boolean;
  lastActivityAtMs: number;
  latestOrder: number;
  /** How far the caller has read, as a message order. */
  readOrder: number;
  /** Finished replies after `readOrder`. */
  unreadCount: number;
  /** A Task of the conversation is queued or running. */
  working: boolean;
  /** The latest message is the Tag's question, still unanswered. */
  asking?: boolean;
}

export interface MessagePage {
  messages: Message[];
  nextCursor?: string;
  /** Empty before the caller's first message to the Tag. */
  conversationId: string;
  /** The page holds only what changed after the request's `after`; otherwise it is the newest. */
  incremental?: boolean;
}

/**
 * A page of the caller's conversation with a Tag before `cursor`, or the changes after `after`
 * to a copy of conversation `conversationId`, with the current state of `refreshTaskIds`.
 */
export interface ReadMessages {
  tagId: string;
  cursor?: string;
  after?: number;
  conversationId?: string;
  refreshTaskIds?: string[];
}

export interface TaskEvent {
  sequence: number;
  /**
   * `message`: a message the Tag wrote while its turn ran. `activity`: one line saying what it
   * was doing. `progress`: its plan, as `progress.updated` JSON.
   */
  kind: "message" | "activity" | "progress" | "unspecified";
  text: string;
}

export interface Gateway {
  tags(): Promise<Tag[]>;
  /** The caller's conversation with each Tag it has talked to, the latest active first. */
  conversations(): Promise<Conversation[]>;
  messages(read: ReadMessages): Promise<MessagePage>;
  send(tagId: string, text: string, operationId: string): Promise<Message>;
  /** Records that the caller read its conversation with a Tag up to a finished turn. */
  markRead(tagId: string, order: number): Promise<Conversation>;
  /** All of a Task's events after a sequence, oldest first. */
  events(taskId: string, afterSequence: number): Promise<TaskEvent[]>;
  /**
   * Pushes the changes of the caller's conversation with `read.tagId` after the copy `read`
   * describes, until the returned stop is called.
   */
  follow?(
    read: ReadMessages,
    receive: (update: FollowUpdate) => void,
  ): Promise<() => Promise<void>>;
  /** The Tag's notes the caller sees, newest first. */
  notes?(tagId: string): Promise<Note[]>;
  /** Deletes a note at once; the Tag no longer sees it from its next turn. */
  deleteNote?(memoryId: string): Promise<Note>;
  /** How the Tag's unprompted messages landed lately, and its start rate. */
  tagActivity?(tagId: string): Promise<TagActivity>;
  /** The Tag's newest Task Attempts with a network log, newest first. Operators only. */
  networkLogs?(tagId: string): Promise<NetworkLog[]>;
  /** The Tag's Schedules the caller can see. */
  schedules?(tagId: string): Promise<Schedule[]>;
  /** Pauses, resumes, or deletes a Schedule. A deleted Schedule never fires again. */
  changeSchedule?(scheduleId: string, action: ScheduleAction): Promise<Schedule>;
  /**
   * The Gateway and principal this connection acts as. What is cached under one scope is
   * never shown under another.
   */
  readonly scope: string;
  /**
   * What the app last cached for this connection's Gateway and principal under `key`:
   * `roster`, `outbox`, or `tag:` and a Tag ID.
   */
  readCache(key: CacheKey): Promise<unknown>;
  writeCache(key: CacheKey, value: unknown): Promise<void>;
}

export type CacheKey = "roster" | "outbox" | `tag:${string}`;

/** Why a queued turn still waits for a Worker Host; an empty reason clears an earlier one. */
export interface TurnWait {
  taskId: string;
  reason: string;
}

/**
 * The text of the message a running turn's Tag is writing now, all of it so far; empty text
 * clears it. The message, once recorded, or the turn's result replaces it.
 */
export interface TurnText {
  taskId: string;
  text: string;
}

/**
 * What a conversation follow pushes: `ready` once its stream is open, `lost` when it dropped (it
 * reopens on its own), and `changed` with the messages that changed, why queued turns wait, and
 * the text running turns are writing.
 */
export type FollowUpdate =
  | { kind: "ready" | "lost" }
  | { kind: "changed"; messages?: MessagePage; waits?: TurnWait[]; texts?: TurnText[] };

export type WatchUpdate =
  | { kind: "ready" | "resync" | "lost" | "tag" }
  /** The caller's conversation with the Tag changed, or was marked read. */
  | { kind: "conversation"; tagId: string }
  /** One of the Tag's notes the caller sees was kept, rewritten, or deleted. */
  | { kind: "memory"; tagId: string }
  /** One of the Tag's Schedules was created, changed, or fired. */
  | { kind: "schedule"; tagId: string };

/** One of a Tag's notes: something it keeps of what it cannot look up again. */
export interface Note {
  memoryId: string;
  tagId: string;
  text: string;
  /** Private to the person whose conversation wrote it; otherwise every turn sees it. */
  private: boolean;
  createdBy: string;
  createdAtMs: number;
  updatedAtMs: number;
  /** When a turn last had it in its context. */
  lastSeenAtMs?: number;
}

/** One request a Task Attempt's egress proxy allowed or refused. Never headers or bodies. */
export interface NetworkRequest {
  atMs: number;
  method: string;
  origin: string;
  /** The path without its query, with credentials redacted. */
  path: string;
  allowed: boolean;
  /** Why it was refused. */
  reason?: string;
  /** The origin's HTTP status, when the request reached it. */
  status?: number;
  /** The Worker Host credential the proxy added. */
  credential?: string;
}

/**
 * How a Tag's unprompted messages (Schedule fires, Objective notices) landed over the last
 * `windowDays`, and its start rate when it has one. `describe tag` shows the same.
 */
export interface TagActivity {
  windowDays: number;
  posted: number;
  /** Read in a person's conversation; surfaces have no read receipts. */
  read: number;
  /** Answered in the same Session within a day. */
  answered: number;
  /** Checks that found nothing and posted nothing. */
  quiet: number;
  startRate?: { starts: number; perMs: number; inWindow: number };
}

/** A Task Attempt's network log: its first requests and how many it allowed and refused. */
export interface NetworkLog {
  taskId: string;
  attemptId: string;
  allowed: number;
  denied: number;
  /** Requests counted but not kept. */
  unrecorded: number;
  requests: NetworkRequest[];
}

/** A wake-up a Tag set for itself or an operator declared: once at a time, or on a recurrence. */
export interface Schedule {
  scheduleId: string;
  tagId: string;
  note: string;
  state: "active" | "paused" | "staged" | "done" | "cancelled";
  atMs?: number;
  /** A cron expression in an IANA time zone. */
  every?: { cron: string; timeZone: string };
  nextDueAtMs?: number;
  createdBy: string;
  fireCount: number;
  missedCount: number;
  lastFiredAtMs?: number;
}

export type ScheduleAction = "pause" | "resume" | "delete";

export interface GatewayProfile {
  name: string;
  origin: string;
}

/** What the app calls the local Gateway in place of a saved origin. */
export const LOCAL_GATEWAY = "local";

/**
 * The Gateway `supertag up` runs on this machine: its origin while it runs, otherwise why it
 * is unavailable. It connects with this machine's own credentials, which are never saved.
 */
export interface LocalGateway {
  origin?: string;
  problem?: string;
}

export interface GatewayList {
  profiles: GatewayProfile[];
  active?: string | null;
  local?: LocalGateway;
}

export interface GatewayActivation {
  gateways: GatewayList;
  /** The saved origin connected to, or `local` for the local Gateway. */
  origin: string;
  connectionId: string;
  tags: Tag[];
  /** Whom the saved credential acts as, such as `operator:local` or `client:alice-laptop`. */
  principal: string;
}

/** The scope of a connection's cached conversations: its Control Plane and principal. */
export function cacheScope(origin: string, principal: string) {
  return JSON.stringify([origin, principal]);
}

export function gatewaySession(connectionId: string, scope: string): Gateway {
  return {
    scope,
    tags: () => invoke("list_tags", { connectionId }),
    conversations: () => invoke("list_conversations", { connectionId }),
    messages: (read) => invoke("list_messages", { connectionId, read }),
    send: (tagId, text, operationId) =>
      invoke("send_message", { connectionId, tagId, text, operationId }),
    markRead: (tagId, order) => invoke("mark_conversation_read", { connectionId, tagId, order }),
    events: (taskId, afterSequence) =>
      invoke("list_task_events", { connectionId, taskId, afterSequence }),
    async follow(read, receive) {
      const onUpdate = new Channel<FollowUpdate>(receive);
      const followId = await invoke<string>("start_conversation_follow", {
        connectionId,
        read,
        onUpdate,
      });
      return () => invoke<void>("stop_conversation_follow", { followId });
    },
    notes: (tagId) => invoke("list_notes", { connectionId, tagId }),
    deleteNote: (memoryId) => invoke("delete_note", { connectionId, memoryId }),
    networkLogs: (tagId) => invoke("list_network_logs", { connectionId, tagId }),
    tagActivity: (tagId) => invoke("tag_activity", { connectionId, tagId }),
    schedules: (tagId) => invoke("list_schedules", { connectionId, tagId }),
    changeSchedule: (scheduleId, action) =>
      invoke("change_schedule", { connectionId, scheduleId, action }),
    readCache: (key) => invoke("read_cache", { connectionId, key }),
    writeCache: (key, value) => invoke("write_cache", { connectionId, key, value }),
  };
}

export const nativeGateway = {
  list: () => invoke<GatewayList>("list_gateways"),
  save: (gateway: string, name: string, token: string) =>
    invoke<GatewayActivation>("save_gateway", { gateway, name, token }),
  select: (origin: string) => invoke<GatewayActivation>("select_gateway", { origin }),
  connectLocal: () => invoke<GatewayActivation>("connect_local_gateway"),
  clear: (forget?: string) => invoke<GatewayList>("clear_gateway", { forget }),
  async watch(connectionId: string, watchEpoch: number, receive: (update: WatchUpdate) => void) {
    const onUpdate = new Channel<WatchUpdate>(receive);
    const watchId = await invoke<string>("start_gateway_watch", {
      connectionId,
      watchEpoch,
      onUpdate,
    });
    return () => invoke<void>("stop_gateway_watch", { watchId });
  },
};
