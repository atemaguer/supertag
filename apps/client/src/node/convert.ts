/**
 * The Gateway's protobuf messages as the window reads them: camel-cased plain objects with
 * numbers for 64-bit fields, enum names in lowercase, and absent optional fields left out, as
 * the Rust app serialized them.
 */

import {
  type Conversation,
  type ConversationMessage,
  HarnessKind,
  type ListMessagesResponse,
  type LiveInput,
  LiveInputState,
  type Tag,
  type Task,
  type TaskEvent,
  TaskEventKind,
  TaskState,
  WorkSessionCloseReason,
} from "../../../../harnesses/sdk/src/rust-harness/gen/supertag/runtime/v2/runtime_pb";
import type {
  MessagePage,
  Conversation as WindowConversation,
  TaskEvent as WindowEvent,
  Message as WindowMessage,
  Tag as WindowTag,
  Task as WindowTask,
} from "../model/gateway";

export const INCOMPLETE_MESSAGE = "The Gateway returned an incomplete message.";

/** A 64-bit field as the window's number. */
export const num = (value: bigint | number): number => Number(value);

/** An optional 64-bit field, left out when absent. */
export const optionalNum = (value: bigint | number | undefined): number | undefined =>
  value === undefined ? undefined : Number(value);

/** Drops the keys whose value is `undefined`, as serde's `skip_serializing_if` did. */
export function compact<T extends object>(value: T): T {
  for (const key of Object.keys(value) as (keyof T)[]) {
    if (value[key] === undefined) delete value[key];
  }
  return value;
}

/** An enum value's name without its prefix, in lowercase: `TaskState.QUEUED` is `queued`. */
export function enumName(names: Record<number, string>, value: number): string {
  return (names[value] ?? "UNSPECIFIED").toLowerCase();
}

/** A harness as the app names it, such as `codex` or `claude_code`. */
export const harnessName = (kind: HarnessKind): string => enumName(HarnessKind, kind);

export function tag(value: Tag): WindowTag {
  return {
    tagId: value.tagId,
    name: value.name === "" ? value.tagId : value.name,
    instructions: value.instructions,
    allowedActions: [...value.allowedActions],
    revision: num(value.revision),
    harnessKind: harnessName(value.harnessKind),
    lead: value.lead,
    maxWorkSessions: value.maxWorkSessions,
    openWorkSessions: value.openWorkSessions,
    ...(value.workspace?.workspaceId
      ? {
          workspace: {
            id: value.workspace.workspaceId,
            ...(value.workspace.baseRef ? { ref: value.workspace.baseRef } : {}),
          },
        }
      : {}),
  };
}

export function task(value: Task): WindowTask {
  return compact({
    taskId: value.taskId,
    tagId: value.tagId,
    sessionId: value.sessionId,
    prompt: value.prompt === "" ? undefined : value.prompt,
    state: enumName(TaskState, value.state),
    result: value.result,
    attemptId: value.attemptId,
    createdAtMs: undefined as number | undefined,
    quiet: value.quiet ? true : undefined,
    waitingForHolder: value.waitingForHolder,
  } as WindowTask & { attemptId?: string });
}

export function conversation(value: Conversation): WindowConversation {
  return {
    tagId: value.tagId,
    conversationId: value.conversationId,
    preview: value.preview,
    previewFromTag: value.previewFromTag,
    lastActivityAtMs: num(value.lastActivityAtMs),
    latestOrder: num(value.latestOrder),
    readOrder: num(value.readOrder),
    unreadCount: value.unreadCount,
    working: value.working,
    asking: value.asking,
  };
}

function liveInput(value: LiveInput) {
  return {
    inputId: value.inputId,
    taskId: value.taskId,
    attemptId: value.attemptId,
    followerTaskId: value.followerTaskId,
    text: value.text,
    state: enumName(LiveInputState, value.state),
    order: num(value.order),
  };
}

export function event(value: TaskEvent): WindowEvent {
  const kinds: Record<number, WindowEvent["kind"]> = {
    [TaskEventKind.MESSAGE]: "message",
    [TaskEventKind.ACTIVITY]: "activity",
    [TaskEventKind.PROGRESS]: "progress",
  };
  return {
    sequence: num(value.sequence),
    kind: kinds[value.kind] ?? "unspecified",
    text: value.text,
  };
}

/** Why a work Session closed, as the app shows it after "closed: ". */
function closeReason(reason: WorkSessionCloseReason): string | undefined {
  switch (reason) {
    case WorkSessionCloseReason.IDLE:
      return "idle";
    case WorkSessionCloseReason.TAG:
      return "by the Tag";
    case WorkSessionCloseReason.OPERATOR:
      return "by an operator";
    case WorkSessionCloseReason.DELIVERY_PULLED:
      return "delivery pulled";
    case WorkSessionCloseReason.OBJECTIVE_CLOSED:
      return "Objective closed";
    case WorkSessionCloseReason.UPGRADE:
      return "finished before the upgrade";
    case WorkSessionCloseReason.MERGED:
      return "pull request merged";
    default:
      return undefined;
  }
}

/**
 * One message of a conversation. A Work Session report or a scheduled turn has no message from
 * the operator: its prompt and live input are internal, so neither reaches the window.
 */
export function message(value: ConversationMessage): WindowMessage {
  if (value.task === undefined) throw INCOMPLETE_MESSAGE;
  const shown = task(value.task);
  const internal = value.workSessionReportId !== undefined || value.scheduleId !== undefined;
  if (internal) delete shown.prompt;
  if (value.sentAtMs > 0n) shown.createdAtMs = num(value.sentAtMs);
  return compact({
    task: shown,
    order: num(value.order),
    completedAtMs: optionalNum(value.completedAtMs),
    liveInput: internal || value.liveInput === undefined ? undefined : liveInput(value.liveInput),
    workSessionReportId: value.workSessionReportId,
    scheduleId: value.scheduleId,
    workSessionClosed: closeReason(value.workSessionCloseReason),
    events: value.events.map(event),
    eventsTruncated: value.eventsTruncated ? true : undefined,
  } as WindowMessage);
}

export function messages(page: ListMessagesResponse): MessagePage {
  return {
    messages: page.messages.map(message),
    nextCursor: page.nextCursor,
    conversationId: page.conversationId,
    incremental: page.incremental,
  };
}
