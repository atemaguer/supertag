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
}

export interface Message {
  task: Task;
  /** The message's place in its conversation. Later messages have larger orders. */
  order: number;
  /** When its turn finished, if the Control Plane recorded it. */
  completedAtMs?: number;
  liveInput?: { taskId: string; state: string };
  workSessionReportId?: string;
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
  saveArtifact(artifactId: string, path: string): Promise<boolean>;
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

export type WatchUpdate =
  | { kind: "ready" | "resync" | "lost" | "tag" }
  /** The caller's conversation with the Tag changed, or was marked read. */
  | { kind: "conversation"; tagId: string };

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
    saveArtifact: (artifactId, path) =>
      invoke("save_result_artifact", { connectionId, artifactId, path }),
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
