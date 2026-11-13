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

export interface GatewayProfile {
  name: string;
  origin: string;
}

export interface GatewayList {
  profiles: GatewayProfile[];
  active?: string | null;
}

export interface GatewayActivation {
  gateways: GatewayList;
  connectionId: string;
  tags: Tag[];
}

export function gatewaySession(connectionId: string): Gateway {
  return {
    tags: () => invoke("list_tags", { connectionId }),
    conversations: (tagId) => invoke("list_conversations", { connectionId, tagId }),
    messages: (tagId, conversation, cursor) =>
      invoke("list_messages", { connectionId, tagId, conversation, cursor }),
    send: (tagId, conversation, text, operationId) =>
      invoke("send_message", { connectionId, tagId, conversation, text, operationId }),
    events: (tagId, taskId, afterSequence) =>
      invoke("list_message_events", { connectionId, tagId, taskId, afterSequence }),
    saveArtifact: (artifactId, path) =>
      invoke("save_result_artifact", { connectionId, artifactId, path }),
  };
}

export const nativeGateway = {
  list: () => invoke<GatewayList>("list_gateways"),
  save: (gateway: string, name: string, token: string) =>
    invoke<GatewayActivation>("save_gateway", { gateway, name, token }),
  select: (origin: string) => invoke<GatewayActivation>("select_gateway", { origin }),
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
