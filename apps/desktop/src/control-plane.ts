import { Channel, invoke } from "@tauri-apps/api/core";

export interface Tag {
  tagId: string;
  name?: string;
  instructions: string;
  allowedActions: string[];
  revision: number;
  harnessKind: string;
  /** Whether this is the Control Plane's lead Tag, the one `supertag init` creates. */
  lead?: boolean;
  /** How many Work Sessions the Tag may have open at once, and has open. */
  maxWorkSessions?: number;
  openWorkSessions?: number;
}

export interface ResultArtifact {
  artifactId: string;
  paths: string[];
}

export interface Task {
  taskId: string;
  tagId: string;
  sessionId: string;
  prompt?: string;
  state: string;
  result?: string;
  artifacts?: ResultArtifact[];
  /** When the operator sent it, in milliseconds since the epoch, once the Control Plane says. */
  createdAtMs?: number;
  /** The turn finished quietly: no person was waiting and it found nothing to say. */
  quiet?: boolean;
}

export interface Message {
  task: Task;
  /** The message's place in its conversation. Later messages have larger orders. */
  order: number;
  /** When its turn finished, if the Control Plane recorded it. */
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

export interface ControlPlane {
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
  saveArtifact(artifactId: string, path: string): Promise<boolean>;
  /** The Tag's notes the caller sees, newest first. */
  notes?(tagId: string): Promise<Note[]>;
  /** Deletes a note at once; the Tag no longer sees it from its next turn. */
  deleteNote?(memoryId: string): Promise<Note>;
  /**
   * The Control Plane and principal this connection acts as. What is cached under one scope is
   * never shown under another.
   */
  readonly scope: string;
  /**
   * What the app last cached for this connection's Control Plane and principal under `key`:
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
  | { kind: "memory"; tagId: string };

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

export interface ControlPlaneProfile {
  name: string;
  origin: string;
}

/** What the app calls the local Control Plane in place of a saved origin. */
export const LOCAL_CONTROL_PLANE = "local";

/**
 * The Control Plane `supertag up` runs on this machine: its origin while it runs, otherwise why it
 * is unavailable. It connects with this machine's own credentials, which are never saved.
 */
export interface LocalControlPlane {
  origin?: string;
  problem?: string;
}

export interface ControlPlaneList {
  profiles: ControlPlaneProfile[];
  active?: string | null;
  local?: LocalControlPlane;
}

export interface ControlPlaneActivation {
  controlPlanes: ControlPlaneList;
  /** The saved origin connected to, or `local` for the local Control Plane. */
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

export function controlPlaneSession(connectionId: string, scope: string): ControlPlane {
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
    saveArtifact: (artifactId, path) =>
      invoke("save_result_artifact", { connectionId, artifactId, path }),
    notes: (tagId) => invoke("list_notes", { connectionId, tagId }),
    deleteNote: (memoryId) => invoke("delete_note", { connectionId, memoryId }),
    readCache: (key) => invoke("read_cache", { connectionId, key }),
    writeCache: (key, value) => invoke("write_cache", { connectionId, key, value }),
  };
}

export const nativeControlPlane = {
  list: () => invoke<ControlPlaneList>("list_control_planes"),
  save: (controlPlane: string, name: string, token: string) =>
    invoke<ControlPlaneActivation>("save_control_plane", { controlPlane, name, token }),
  select: (origin: string) => invoke<ControlPlaneActivation>("select_control_plane", { origin }),
  connectLocal: () => invoke<ControlPlaneActivation>("connect_local_control_plane"),
  clear: (forget?: string) => invoke<ControlPlaneList>("clear_control_plane", { forget }),
  async watch(connectionId: string, watchEpoch: number, receive: (update: WatchUpdate) => void) {
    const onUpdate = new Channel<WatchUpdate>(receive);
    const watchId = await invoke<string>("start_control_plane_watch", {
      connectionId,
      watchEpoch,
      onUpdate,
    });
    return () => invoke<void>("stop_control_plane_watch", { watchId });
  },
};
