import { Code, type ServiceImpl } from "@connectrpc/connect";
import type { ControlPlane } from "@supertag/control-plane";
import type { Store } from "@supertag/core";
import { type ConversationService, ErrorReason } from "@supertag/operator-api";
import {
  conversationName,
  conversationTag,
  messageOf,
  operatorConversations,
  pageOffset,
  pageSize,
  pageToken,
  readableMessage,
  sentMessages,
} from "./conversation-messages.js";
import type { MessageFollows } from "./message-follow.js";
import { conversationOperator, operatorAuditTarget, operatorError } from "./operator-rpc.js";

/** A key is 1 to 200 characters without whitespace or control characters. */
const IDEMPOTENCY_KEY = /^[^\s\p{Cc}]{1,200}$/u;

export interface ConversationServiceDependencies {
  readonly store: Store;
  readonly controlPlane: Pick<ControlPlane, "isAccepting" | "messageTag">;
  readonly follows: MessageFollows;
  /** Aborted once the API Server drains; open streams then end with `Unavailable`. */
  readonly draining: () => AbortSignal;
}

/** `ConversationService`: the caller's CLI conversations with Tags. */
export function conversationService(
  dependencies: ConversationServiceDependencies,
): ServiceImpl<typeof ConversationService> {
  const { store, controlPlane, follows } = dependencies;
  return {
    async sendMessage(request, context) {
      const operatorId = conversationOperator(context);
      const tag = await conversationTag(store, request.tag);
      const note = context.values.get(operatorAuditTarget);
      if (note !== undefined) note.target = `Tag/${tag.name}`;
      const text = request.text.trim();
      if (!text)
        throw operatorError(
          Code.InvalidArgument,
          ErrorReason.INVALID_ARGUMENT,
          "The message is empty",
          [{ path: "text", description: "the message, not only whitespace" }],
        );
      const conversation = conversationName(request.conversation);
      if (request.idempotencyKey !== "" && !IDEMPOTENCY_KEY.test(request.idempotencyKey))
        throw operatorError(
          Code.InvalidArgument,
          ErrorReason.INVALID_ARGUMENT,
          "An idempotency key is 1 to 200 characters without whitespace or control characters",
          [{ path: "idempotency_key", description: "1 to 200 characters, no whitespace" }],
        );
      if (!controlPlane.isAccepting)
        throw operatorError(Code.Unavailable, ErrorReason.DRAINING, "Control Plane is draining");
      const result = await controlPlane.messageTag({
        tagName: tag.name,
        operatorId,
        session: conversation,
        text,
        ...(request.idempotencyKey === "" ? {} : { idempotencyKey: request.idempotencyKey }),
      });
      const task =
        result.taskId === undefined ? undefined : await store.findTaskById(result.taskId);
      if (task === undefined)
        throw operatorError(
          Code.FailedPrecondition,
          ErrorReason.CONFLICT,
          result.reason ?? `Tag ${tag.name} did not accept the message`,
        );
      const found = await readableMessage(store, tag, task.id, operatorId);
      return messageOf(store, tag, found.task, found.conversation);
    },

    async getMessage(request, context) {
      const tag = await conversationTag(store, request.tag);
      const found = await readableMessage(
        store,
        tag,
        request.taskId,
        conversationOperator(context),
      );
      return messageOf(store, tag, found.task, found.conversation);
    },

    async *followMessage(request, context) {
      const operatorId = conversationOperator(context);
      const tag = await conversationTag(store, request.tag);
      const found = await readableMessage(store, tag, request.taskId, operatorId);
      const draining = dependencies.draining();
      yield* follows.follow(
        { operatorId, tag, task: found.task, conversation: found.conversation },
        request.afterSequence,
        AbortSignal.any([context.signal, draining]),
      );
      if (draining.aborted && !context.signal.aborted) throw drainingError();
    },

    async listConversations(request, context) {
      const tag = request.tag === "" ? undefined : await conversationTag(store, request.tag);
      const size = pageSize(request.pageSize);
      const offset = pageOffset(request.pageToken);
      const conversations = await operatorConversations(store, conversationOperator(context), tag);
      return {
        conversations: conversations.slice(offset, offset + size),
        nextPageToken: offset + size < conversations.length ? pageToken(offset + size) : "",
      };
    },

    async listMessages(request, context) {
      const tag = await conversationTag(store, request.tag);
      const conversation = conversationName(request.conversation);
      const size = pageSize(request.pageSize);
      const offset = pageOffset(request.pageToken);
      const page = await sentMessages(
        store,
        tag,
        conversationOperator(context),
        conversation,
        offset,
        size,
      );
      return {
        messages: page.messages,
        nextPageToken: page.more ? pageToken(offset + size) : "",
      };
    },
  };
}

export function drainingError() {
  return operatorError(Code.Unavailable, ErrorReason.DRAINING, "Control Plane is draining");
}
