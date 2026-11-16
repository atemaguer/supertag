import { Channel, invoke } from "@tauri-apps/api/core";

export interface Tag {
  tagId: string;
  name?: string;
  instructions: string;
  allowedActions: string[];
  revision: number;
  harnessKind: string;
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
}

export interface Message {
  task: Task;
  conversation: string;
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

export interface Conversation {
  tagId: string;
  name: string;
  sessionId: string;
  latestTask?: Task;
}

export interface MessagePage {
  messages: Message[];
  nextCursor?: string;
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
  conversations(tagId: string): Promise<Conversation[]>;
  messages(tagId: string, conversation: string, cursor?: string): Promise<MessagePage>;
  send(tagId: string, conversation: string, text: string, operationId: string): Promise<Message>;
  /** All of a Task's events after a sequence, oldest first. */
  events(taskId: string, afterSequence: number): Promise<TaskEvent[]>;
  saveArtifact(artifactId: string, path: string): Promise<boolean>;
  /**
   * The Control Plane and principal this connection acts as. Conversations cached under one
   * scope are never shown under another.
   */
  readonly scope: string;
  /** The conversation this connection's Control Plane and principal last cached, if any. */
  readCache(tagId: string, conversation: string): Promise<unknown>;
  writeCache(tagId: string, conversation: string, value: unknown): Promise<void>;
}

export type WatchUpdate =
  | { kind: "ready" | "resync" | "lost" | "tag" }
  | { kind: "conversation"; tagId: string; conversation: string };

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
    conversations: (tagId) => invoke("list_conversations", { connectionId, tagId }),
    messages: (tagId, conversation, cursor) =>
      invoke("list_messages", { connectionId, tagId, conversation, cursor }),
    send: (tagId, conversation, text, operationId) =>
      invoke("send_message", { connectionId, tagId, conversation, text, operationId }),
    events: (taskId, afterSequence) =>
      invoke("list_task_events", { connectionId, taskId, afterSequence }),
    saveArtifact: (artifactId, path) =>
      invoke("save_result_artifact", { connectionId, artifactId, path }),
    readCache: (tagId, conversation) =>
      invoke("read_conversation_cache", { connectionId, tagId, conversation }),
    writeCache: (tagId, conversation, value) =>
      invoke("write_conversation_cache", { connectionId, tagId, conversation, value }),
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
