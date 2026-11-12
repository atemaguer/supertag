import { invoke } from "@tauri-apps/api/core";

export interface Tag {
  tagId: string;
  instructions: string;
  allowedActions: string[];
  revision: number;
  harnessKind: string;
}

export interface Task {
  taskId: string;
  tagId: string;
  sessionId: string;
  prompt: string;
  state: string;
  result?: string;
}

export interface Message {
  task: Task;
  conversation: string;
  liveInput?: { taskId: string; state: string };
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
  connect(gateway: string, token: string): Promise<void>;
  disconnect(): Promise<void>;
  tags(): Promise<Tag[]>;
  conversations(tagId: string): Promise<Conversation[]>;
  messages(tagId: string, conversation: string, cursor?: string): Promise<MessagePage>;
  send(tagId: string, conversation: string, text: string, operationId: string): Promise<Message>;
  events(tagId: string, taskId: string, afterSequence: number): Promise<TaskEvent[]>;
}

export const nativeGateway: Gateway = {
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
};
