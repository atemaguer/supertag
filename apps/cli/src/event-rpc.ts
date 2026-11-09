import type { MessageInitShape } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { Code, type HandlerContext, type ServiceImpl } from "@connectrpc/connect";
import type {
  ChangeKind,
  ChangeNotifications,
  CoordinationOperatorPrincipal,
  PositionedChangeNotice,
} from "@supertag/control-plane";
import {
  ErrorReason,
  type EventService,
  type WatchEventSchema,
  WatchKind,
} from "@supertag/operator-api";
import { drainingError } from "./conversation-rpc.js";
import { STREAM_HEARTBEAT_MS } from "./message-follow.js";
import { conversationOperator, operatorError, operatorPrincipal } from "./operator-rpc.js";

/** Notices one watcher may fall behind by before it resynchronizes instead. */
const MAX_PENDING_NOTICES = 10_000;

const WATCH_KINDS: Readonly<Record<ChangeKind, WatchKind>> = {
  tag: WatchKind.TAG,
  session: WatchKind.SESSION,
  task: WatchKind.TASK,
  objective: WatchKind.OBJECTIVE,
  inbox_item: WatchKind.INBOX_ITEM,
  approval: WatchKind.APPROVAL,
  conversation_message: WatchKind.CONVERSATION_MESSAGE,
};

type WatchEventInit = MessageInitShape<typeof WatchEventSchema>;

export interface EventServiceDependencies {
  readonly changes: ChangeNotifications;
  /** Aborted once the API Server drains; open streams then end with `Unavailable`. */
  readonly draining: () => AbortSignal;
  /** How long a stream stays quiet before a heartbeat; 15 seconds unless a test shortens it. */
  readonly heartbeatMs?: number;
}

/** `EventService`: change notices for what the caller may read. */
export function eventService(
  dependencies: EventServiceDependencies,
): ServiceImpl<typeof EventService> {
  const { changes } = dependencies;
  const heartbeatMs = dependencies.heartbeatMs ?? STREAM_HEARTBEAT_MS;
  return {
    async *watch(request, context) {
      const visible = visibility(context, request.kinds);
      const draining = dependencies.draining();
      const signal = AbortSignal.any([context.signal, draining]);
      const pending: PositionedChangeNotice[] = [];
      let overflowed = false;
      let wake: (() => void) | undefined;
      const unsubscribe = changes.subscribe((notice) => {
        if (pending.length >= MAX_PENDING_NOTICES) overflowed = true;
        else pending.push(notice);
        wake?.();
      });
      try {
        let position = changes.position;
        if (request.resumeToken === "")
          yield {
            resumeToken: changes.resumeToken(position),
            event: { case: "heartbeat", value: {} },
          };
        else {
          const resumed = changes.resume(request.resumeToken);
          if (resumed.status === "invalid")
            throw operatorError(
              Code.InvalidArgument,
              ErrorReason.INVALID_ARGUMENT,
              "The resume token was not issued by this Control Plane",
              [{ path: "resume_token", description: "a resume_token from an earlier event" }],
            );
          if (resumed.status === "resync")
            yield {
              resumeToken: changes.resumeToken(position),
              event: { case: "resync", value: {} },
            };
          else
            for (const notice of resumed.notices) {
              const event = changeEvent(notice, visible, changes);
              if (event !== undefined) yield event;
            }
        }
        while (!signal.aborted) {
          if (overflowed) {
            overflowed = false;
            pending.length = 0;
            position = changes.position;
            yield {
              resumeToken: changes.resumeToken(position),
              event: { case: "resync", value: {} },
            };
          }
          const notice = pending.shift();
          if (notice !== undefined) {
            if (notice.position <= position) continue;
            position = notice.position;
            const event = changeEvent(notice, visible, changes);
            if (event !== undefined) yield event;
            continue;
          }
          const woke = await new Promise<boolean>((resolve) => {
            const done = (value: boolean) => {
              clearTimeout(timer);
              signal.removeEventListener("abort", stop);
              wake = undefined;
              resolve(value);
            };
            const stop = () => done(true);
            const timer = setTimeout(() => done(false), heartbeatMs);
            signal.addEventListener("abort", stop, { once: true });
            wake = () => done(true);
          });
          if (!woke && !signal.aborted)
            yield {
              resumeToken: changes.resumeToken(position),
              event: { case: "heartbeat", value: {} },
            };
        }
        if (draining.aborted && !context.signal.aborted) throw drainingError();
      } finally {
        unsubscribe();
      }
    },
  };
}

function changeEvent(
  notice: PositionedChangeNotice,
  visible: (notice: PositionedChangeNotice) => boolean,
  changes: ChangeNotifications,
): WatchEventInit | undefined {
  if (!visible(notice)) return undefined;
  const kind = WATCH_KINDS[notice.kind];
  const set = (field: string, value: string | undefined) =>
    value === undefined ? {} : { [field]: value };
  return {
    resumeToken: changes.resumeToken(notice.position),
    event: {
      case: "change",
      value: {
        kind,
        id: notice.id,
        ...(kind === WatchKind.APPROVAL || kind === WatchKind.INBOX_ITEM
          ? {}
          : set("tag", notice.tag)),
        ...(kind === WatchKind.TASK || kind === WatchKind.CONVERSATION_MESSAGE
          ? set("sessionId", notice.sessionId)
          : {}),
        ...(kind === WatchKind.APPROVAL ? set("taskId", notice.taskId) : {}),
        ...(kind === WatchKind.TASK || kind === WatchKind.APPROVAL || kind === WatchKind.INBOX_ITEM
          ? set("objectiveId", notice.objectiveId)
          : {}),
        ...(kind === WatchKind.SESSION || kind === WatchKind.CONVERSATION_MESSAGE
          ? set("conversation", notice.conversation)
          : {}),
        reason: notice.reason,
        changedAt: timestampFromDate(new Date(notice.changedAt)),
      },
    },
  };
}

/**
 * Which notices the caller may see: what it could read through the other RPCs, with the same
 * actions and Objective scope, and of the kinds it asked for.
 */
function visibility(
  context: HandlerContext,
  kinds: readonly WatchKind[],
): (notice: PositionedChangeNotice) => boolean {
  const caller = context.values.get(operatorPrincipal);
  const principal: CoordinationOperatorPrincipal | undefined = caller?.principal;
  const operatorId = conversationOperator(context);
  const actions = principal?.scopes.actions ?? [];
  const may = (action: string) => actions.includes("*") || actions.includes(action);
  const scope = principal?.scopes.objectiveIds;
  const inScope = (objectiveId: string | undefined) =>
    scope === undefined || (objectiveId !== undefined && scope.includes(objectiveId));
  const wanted = new Set(kinds);
  const owns = (notice: PositionedChangeNotice) =>
    notice.conversationOwner === undefined ||
    notice.conversationOwner === "*" ||
    notice.conversationOwner === operatorId;
  return (notice) => {
    const kind = WATCH_KINDS[notice.kind];
    if (wanted.size > 0 && !wanted.has(kind)) return false;
    switch (notice.kind) {
      case "conversation_message":
        return may("read_conversation") && notice.conversationOwner !== undefined && owns(notice);
      case "session":
      case "task":
        return owns(notice);
      case "tag":
        return true;
      case "objective":
        return may("read_objective") && inScope(notice.objectiveId ?? notice.id);
      case "inbox_item":
        return may("read_coordination_inbox") && inScope(notice.objectiveId);
      case "approval":
        return may("list_approvals") && inScope(notice.objectiveId);
    }
  };
}
