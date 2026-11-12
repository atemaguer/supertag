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
  text: string;
}

export interface Gateway {
  tags(): Promise<Tag[]>;
  conversations(tagId: string): Promise<Conversation[]>;
  messages(tagId: string, conversation: string, cursor?: string): Promise<MessagePage>;
  send(tagId: string, conversation: string, text: string, operationId: string): Promise<Message>;
  events(tagId: string, taskId: string, afterSequence: number): Promise<TaskEvent[]>;
  saveArtifact(artifactId: string, path: string): Promise<boolean>;
}

export type WatchUpdate =
  | { kind: "ready" | "resync" | "lost" | "tag" }
  | { kind: "conversation"; tagId: string; conversation: string };

interface NativeGateway extends Gateway {
  connect(gateway: string, token: string): Promise<string>;
  disconnect(): Promise<void>;
  watch(
    connectionId: string,
    watchEpoch: number,
    onUpdate: (update: WatchUpdate) => void,
  ): Promise<() => Promise<void>>;
}

export const nativeGateway: NativeGateway = {
  connect: (gateway, token) => invoke("connect_gateway", { gateway, token }),
  disconnect: () => invoke("disconnect_gateway"),
  tags: () => invoke("list_tags"),
  conversations: (tagId) => invoke("list_conversations", { tagId }),
  messages: (tagId, conversation, cursor) =>
    invoke("list_messages", { tagId, conversation, cursor }),
  send: (tagId, conversation, text, operationId) =>
    invoke("send_message", { tagId, conversation, text, operationId }),
  events: (tagId, taskId, afterSequence) =>
    invoke("list_message_events", { tagId, taskId, afterSequence }),
  saveArtifact: (artifactId, path) => invoke("save_result_artifact", { artifactId, path }),
  async watch(connectionId, watchEpoch, receive) {
    const onUpdate = new Channel<WatchUpdate>(receive);
    const watchId = await invoke<string>("start_gateway_watch", {
      connectionId,
      watchEpoch,
      onUpdate,
    });
    return () => invoke("stop_gateway_watch", { watchId });
  },
};
