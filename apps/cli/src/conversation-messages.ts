import { create } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { Code } from "@connectrpc/connect";
import {
  CONVERSATION_NAME,
  cliConversationKey,
  messageConversation,
  parseCliConversationKey,
} from "@supertag/control-plane";
import {
  placementHoldReason,
  type Session,
  type Store,
  type Tag,
  type Task,
  workSessionWaiting,
} from "@supertag/core";
import {
  type Conversation,
  ConversationAuthor,
  ConversationSchema,
  ErrorReason,
  type Message,
  MessageSchema,
  type Reply,
  ReplyPresentation,
  ReplySchema,
  ReplyStatus,
  type WorkSession,
  WorkSessionSchema,
  WorkSessionStatus,
} from "@supertag/operator-api";
import { operatorError } from "./operator-rpc.js";

/** Characters of a conversation's latest entry that `Conversation.last_message_text` keeps. */
const LAST_MESSAGE_CHARACTERS = 200;
/** How many of a conversation's latest turns its latest entry is looked for in. */
const LAST_ENTRY_TURNS = 5;
/** How many turns of one conversation `ListMessages` pages through. */
const MAX_LISTED_TURNS = 1_000;

type StoredReply = { readonly presentation: string; readonly text: string };

/** A Tag a conversation RPC names, or `NotFound`. */
export async function conversationTag(store: Store, name: string): Promise<Tag> {
  const tag = name === "" ? undefined : await store.findTagByName(name);
  if (tag === undefined || tag.status !== "active")
    throw operatorError(Code.NotFound, ErrorReason.NOT_FOUND, `Tag ${name} does not exist`);
  return tag;
}

/** A conversation name from a request, where empty means `default`, or `InvalidArgument`. */
export function conversationName(value: string): string {
  const name = value === "" ? "default" : value;
  if (!CONVERSATION_NAME.test(name))
    throw operatorError(
      Code.InvalidArgument,
      ErrorReason.INVALID_ARGUMENT,
      "A conversation name is 1 to 64 letters, digits, '.', '_' or '-', starting with a letter or digit",
      [{ path: "conversation", description: "1 to 64 of A-Z, a-z, 0-9, '.', '_', '-'" }],
    );
  return name;
}

/**
 * The message Task `taskId` names in the caller's conversations with `tag`, and its conversation,
 * or `NotFound`: for another operator's message exactly as for one that does not exist.
 */
export async function readableMessage(
  store: Store,
  tag: Tag,
  taskId: string,
  operatorId: string,
): Promise<{ readonly task: Task; readonly conversation: string }> {
  const task = taskId === "" ? undefined : await store.findTaskById(taskId);
  const conversation =
    task === undefined || task.tagId !== tag.id
      ? undefined
      : await messageConversation(store, task);
  if (
    task === undefined ||
    conversation === undefined ||
    (conversation.owner !== operatorId && conversation.owner !== "*")
  )
    throw operatorError(
      Code.NotFound,
      ErrorReason.NOT_FOUND,
      `Task ${taskId} is not a message in your conversations with Tag ${tag.name}`,
    );
  return { task, conversation: conversation.name };
}

/** A message as `GetMessage` returns it: its reply once written and its work Sessions. */
export async function messageOf(
  store: Store,
  tag: Pick<Tag, "name">,
  task: Task,
  conversation: string,
): Promise<Message> {
  const { reply, joinedTaskId } = await messageReply(store, task);
  const waiting = reply === undefined ? await placementHold(store, task) : undefined;
  return create(MessageSchema, {
    taskId: task.id,
    tag: tag.name,
    conversation,
    sessionId: task.sessionId,
    text: task.requestText ?? "",
    createdAt: timestampFromDate(new Date(task.createdAt)),
    status: reply === undefined ? ReplyStatus.WAITING : ReplyStatus.REPLIED,
    waitingReason: waiting ?? "",
    ...(reply === undefined ? {} : { reply: replyOf(reply) }),
    joinedTaskId: joinedTaskId ?? "",
    workSessions: await startedWorkSessions(store, task),
  });
}

/**
 * Whether a work Session needs no more following: its latest Task's report arrived, and that Task
 * does not wait only on an approval decision, which continues the work Session as its next Task.
 * One that asked a question waits on the person's next message, so it is settled.
 */
export function workSessionSettled(session: WorkSession): boolean {
  if (session.reportStatus !== ReplyStatus.REPLIED) return false;
  return !(session.status === WorkSessionStatus.WAITING && session.question === "");
}

export function replyOf(reply: StoredReply): Reply {
  return create(ReplySchema, {
    presentation: REPLY_PRESENTATIONS[reply.presentation] ?? ReplyPresentation.UNSPECIFIED,
    text: reply.text,
  });
}

const REPLY_PRESENTATIONS: Readonly<Record<string, ReplyPresentation>> = {
  "final-result": ReplyPresentation.FINAL_RESULT,
  error: ReplyPresentation.ERROR,
  status: ReplyPresentation.STATUS,
  acknowledgement: ReplyPresentation.ACKNOWLEDGEMENT,
};

const WORK_SESSION_STATUSES: Readonly<Record<string, WorkSessionStatus>> = {
  pending: WorkSessionStatus.PENDING,
  running: WorkSessionStatus.RUNNING,
  completed: WorkSessionStatus.COMPLETED,
  failed: WorkSessionStatus.FAILED,
  cancelled: WorkSessionStatus.CANCELLED,
  waiting: WorkSessionStatus.WAITING,
};

/**
 * The reply that answers one message. A message sent while an earlier Task in the Session still
 * runs is delivered into that Task, so the answer is that Task's final reply; a delivery whose
 * outcome is unknown is answered by the error notice recorded for it.
 */
async function messageReply(
  store: Store,
  task: Task,
): Promise<{ readonly reply?: StoredReply; readonly joinedTaskId?: string }> {
  if (task.inboundEventId === null) return {};
  const own = await store.findOutboundReply(task.inboundEventId, "final");
  if (own !== undefined) return { reply: own };
  const unresolved = await store.findOutboundReply(task.inboundEventId, "session-input-unresolved");
  if (unresolved !== undefined) return { reply: unresolved };
  const reason = task.outcome?.["reason"];
  const targetTaskId = task.outcome?.["targetTaskId"];
  if (reason !== "input-accepted" || typeof targetTaskId !== "string") return {};
  const target = await store.findTaskById(targetTaskId);
  const reply =
    target?.inboundEventId === null || target === undefined
      ? undefined
      : await store.findOutboundReply(target.inboundEventId, "final");
  return { joinedTaskId: targetTaskId, ...(reply === undefined ? {} : { reply }) };
}

/**
 * Why a pending Task waits for placement, from its latest scheduling event, or undefined when it
 * is not held. The Control Plane records a reason only when it changes.
 */
async function placementHold(store: Store, task: Task): Promise<string | undefined> {
  if (task.status !== "pending") return undefined;
  const latest = (await store.listTaskEvents(task.id)).findLast(
    (event) =>
      event.type === "task.scheduling-incompatible" || event.type === "task.scheduling-compatible",
  );
  return latest?.type === "task.scheduling-incompatible"
    ? placementHoldReason(latest.payload)
    : undefined;
}

/** The work Sessions a message's turn started or continued, oldest first, with their reports. */
async function startedWorkSessions(store: Store, task: Task): Promise<WorkSession[]> {
  const started = (await store.listWorkSessions(task.sessionId)).filter(
    (session) => (session.task?.startedByTaskId ?? session.startedByTaskId) === task.id,
  );
  return Promise.all(
    started.map(async (session) => {
      const found = session.task ? await store.findWorkSessionReport(session.task.id) : undefined;
      const report = found
        ? await store.findOutboundReply(found.inboundEventId, "final")
        : undefined;
      const notContinued =
        session.task && task.inboundEventId
          ? await store.findOutboundReply(
              task.inboundEventId,
              `approval-continue:${session.task.id}`,
            )
          : undefined;
      const status = workSessionWaiting(session) ? "waiting" : (session.task?.status ?? "pending");
      return create(WorkSessionSchema, {
        id: session.sessionId,
        title: session.title,
        taskId: session.task?.id ?? "",
        status: WORK_SESSION_STATUSES[status] ?? WorkSessionStatus.UNSPECIFIED,
        question: session.task?.question ?? "",
        approvals: await workSessionApprovals(store, task, session.task),
        notContinued: notContinued?.text ?? "",
        reportStatus: report === undefined ? ReplyStatus.WAITING : ReplyStatus.REPLIED,
        reportTaskId: found?.taskId ?? "",
        ...(report === undefined ? {} : { report: replyOf(report) }),
      });
    }),
  );
}

/**
 * The approval notices a work Session Task's pending approval requests posted to the conversation
 * turn that started it. The CLI delivers no status replies, so the message carries them.
 */
async function workSessionApprovals(
  store: Store,
  turn: Task,
  work: { readonly id: string } | undefined,
): Promise<{ requestId: string; text: string }[]> {
  if (!turn.inboundEventId || work === undefined) return [];
  const inboundEventId = turn.inboundEventId;
  const requests = await store.listApprovalRequests({
    taskId: work.id,
    status: "pending",
    limit: 100,
  });
  const notices = await Promise.all(
    requests.map(async (request) => {
      const notice = await store.findOutboundReply(inboundEventId, `approval:${request.id}`);
      return notice === undefined ? [] : [{ requestId: request.id, text: notice.text }];
    }),
  );
  return notices.flat();
}

/** Whether a turn of a CLI conversation is a message the person sent, not one SuperTag admitted. */
async function sentByOperator(store: Store, task: Task): Promise<boolean> {
  if (!task.inboundEventId) return false;
  const inbound = await store.findInboundEventById(task.inboundEventId);
  return inbound !== undefined && inbound.event.internal === undefined;
}

/** The messages the caller sent in one conversation, newest first, from `offset`. */
export async function sentMessages(
  store: Store,
  tag: Tag,
  operatorId: string,
  conversation: string,
  offset: number,
  pageSize: number,
): Promise<{ readonly messages: Message[]; readonly more: boolean }> {
  const session = await store.findSessionByTagAndKey(
    tag.id,
    cliConversationKey(operatorId, conversation),
  );
  if (session === undefined) return { messages: [], more: false };
  const sent: Task[] = [];
  for (const task of await store.listTasks({ sessionId: session.id, limit: MAX_LISTED_TURNS })) {
    if (!(await sentByOperator(store, task))) continue;
    sent.push(task);
    if (sent.length > offset + pageSize) break;
  }
  const page = sent.slice(offset, offset + pageSize);
  return {
    messages: await Promise.all(page.map((task) => messageOf(store, tag, task, conversation))),
    more: sent.length > offset + pageSize,
  };
}

/** The caller's conversations, optionally with one Tag, the most recent entry first. */
export async function operatorConversations(
  store: Store,
  operatorId: string,
  tag: Tag | undefined,
): Promise<Conversation[]> {
  const sessions = (await store.listSessions(tag === undefined ? {} : { tagId: tag.id })).filter(
    (session) =>
      session.parentSessionId === undefined &&
      parseCliConversationKey(session.sessionKey)?.operatorId === operatorId,
  );
  const tagNames = new Map<string, string>();
  const tagName = async (id: string) => {
    if (!tagNames.has(id)) tagNames.set(id, (await store.findTagById(id))?.name ?? id);
    return tagNames.get(id) ?? id;
  };
  const conversations = await Promise.all(
    sessions.map(async (session) => {
      const entry = await latestEntry(store, session);
      return {
        at: entry?.at ?? session.lastInteractionAt,
        conversation: create(ConversationSchema, {
          tag: await tagName(session.tagId),
          name: parseCliConversationKey(session.sessionKey)?.name ?? "",
          sessionId: session.id,
          lastMessageText: Array.from(entry?.text ?? "")
            .slice(0, LAST_MESSAGE_CHARACTERS)
            .join(""),
          lastMessageAuthor: entry?.author ?? ConversationAuthor.UNSPECIFIED,
          ...(entry === undefined ? {} : { lastMessageAt: timestampFromDate(new Date(entry.at)) }),
          openWorkSessionCount: (await store.listWorkSessions(session.id)).filter((work) => {
            const status = workSessionWaiting(work) ? "waiting" : (work.task?.status ?? "pending");
            return status === "pending" || status === "running" || status === "waiting";
          }).length,
        }),
      };
    }),
  );
  return conversations
    .sort(
      (left, right) =>
        right.at.localeCompare(left.at) ||
        left.conversation.sessionId.localeCompare(right.conversation.sessionId),
    )
    .map((entry) => entry.conversation);
}

/** A conversation's most recent entry: the caller's message, a reply, or a work Session's report. */
async function latestEntry(
  store: Store,
  session: Session,
): Promise<
  { readonly text: string; readonly author: ConversationAuthor; readonly at: string } | undefined
> {
  const entries: { text: string; author: ConversationAuthor; at: string }[] = [];
  for (const task of await store.listTasks({ sessionId: session.id, limit: LAST_ENTRY_TURNS })) {
    if (task.inboundEventId === null) continue;
    const reply = await store.findOutboundReply(task.inboundEventId, "final");
    if (reply !== undefined)
      entries.push({ text: reply.text, author: ConversationAuthor.TAG, at: reply.createdAt });
    if (await sentByOperator(store, task))
      entries.push({
        text: task.requestText ?? "",
        author: ConversationAuthor.OPERATOR,
        at: task.createdAt,
      });
  }
  return entries.sort((left, right) => right.at.localeCompare(left.at))[0];
}

/** A page token: the offset of the page's first item. */
export function pageOffset(token: string): number {
  if (token === "") return 0;
  const match = /^o([1-9][0-9]{0,8})$/u.exec(token);
  if (match === null)
    throw operatorError(
      Code.InvalidArgument,
      ErrorReason.INVALID_ARGUMENT,
      "The page token is not valid",
      [{ path: "page_token", description: "a next_page_token from the previous page" }],
    );
  return Number(match[1]);
}

export function pageToken(offset: number): string {
  return `o${offset}`;
}

/** A request's page size: 0 means 50, and more than 100 means 100. */
export function pageSize(value: number): number {
  if (value < 0)
    throw operatorError(
      Code.InvalidArgument,
      ErrorReason.INVALID_ARGUMENT,
      "page_size must not be negative",
      [{ path: "page_size", description: "0 to 100" }],
    );
  return value === 0 ? 50 : Math.min(value, 100);
}
