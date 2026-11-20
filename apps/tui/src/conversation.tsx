/**
 * One Tag's conversation and its composer. It paints from the cache at once, then the
 * conversation's follow pushes each change; the Watch and a timer read it only while the follow
 * is down (the desktop app's rules, from `@supertag/client`). Only the newest messages are
 * mounted; PgUp at the top mounts more, then reads earlier ones. A message sent waits in the
 * outbox, which survives restarts, until the Gateway has it.
 */
import {
  conversationSummary,
  createdObjectiveId,
  deliveryStatus,
  describe,
  earlierHistory,
  emptyHistory,
  type Gateway,
  goalOutcome,
  type History,
  joinedReplies,
  lastOperatorMessage,
  latestHistory,
  receivedMessage,
  refreshRequest,
  shownMessages,
  type Tag,
  type TagSummary,
  timeDividers,
  type WatchUpdate,
} from "@supertag/client/model";
import {
  cachedHistory,
  cacheHistory,
  discard,
  markShown,
  openConversation,
  send as queue,
  resumeOutbox,
  retry,
  storedHistory,
  useConversationFollow,
  useOutbox,
  usePlatform,
  useWatchRefresh,
  type WatchFeed,
} from "@supertag/client/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DeliveryLine, Entry } from "./entry";
import { safe } from "./text";
import { atBottom, color, type KeyEvent, type ScrollBoxRenderable, useKeyboard } from "./ui";

/** How many of the newest messages are mounted at first, and how many more each PgUp adds. */
export const WINDOW = 40;
const READ_INTERVAL = 2_500;

export interface ConversationProps {
  gateway: Gateway;
  watch?: WatchFeed | undefined;
  tag: Tag;
  draft: string;
  onDraft(text: string): void;
  /** The composer has the keyboard. */
  focused: boolean;
  /** `/` typed on an empty message: open the palette. */
  onPalette(): void;
  onSummary?(tagId: string, summary: TagSummary): void;
  /** ↑ on an empty message: the Work Sessions the turns of the conversation's Sessions started. */
  onWork?(): void;
  /** The Sessions the conversation's turns ran in, as they change. */
  onSessions?(tagId: string, sessionIds: string[]): void;
  /** `/goal` alone: open the new Objective form. */
  onGoal?(): void;
  /** The line under the reply that created an Objective, once it needs a person or ended. */
  homeLine?(objectiveId: string): string | undefined;
}

export function ConversationPane({
  gateway,
  watch,
  tag,
  draft,
  onDraft,
  focused,
  onPalette,
  onSummary,
  onWork,
  onSessions,
  onGoal,
  homeLine,
}: ConversationProps) {
  const tagId = tag.tagId;
  const platform = usePlatform();
  const [history, renderHistory] = useState<History>(
    () => cachedHistory(gateway, tagId) ?? emptyHistory,
  );
  const outgoing = useOutbox(gateway, tagId)[0];
  const current = useRef(history);
  const [error, setError] = useState("");
  const [window, setWindow] = useState(WINDOW);
  const [paging, setPaging] = useState(false);
  const [unseen, setUnseen] = useState(0);
  const [composer, setComposer] = useState(0);
  const revision = useRef(0);
  const active = useRef(true);
  const scroll = useRef<ScrollBoxRenderable>(null);
  const setHistory = useCallback(
    (next: History) => {
      current.current = next;
      renderHistory(next);
      cacheHistory(gateway, tagId, next);
      if (next.read && platform.visible()) markShown(gateway, tagId, next);
    },
    [gateway, tagId, platform],
  );

  useEffect(() => {
    active.current = true;
    const close = openConversation(gateway, tagId);
    void resumeOutbox(gateway);
    if (!current.current.read)
      void storedHistory(gateway, tagId).then((stored) => {
        if (stored && active.current && !current.current.read) {
          current.current = stored;
          renderHistory(stored);
        }
      });
    return () => {
      active.current = false;
      close();
    };
  }, [gateway, tagId]);

  const refresh = useCallback(
    async (signal: AbortSignal) => {
      const started = revision.current;
      try {
        const page = await gateway.messages(refreshRequest(tagId, current.current));
        if (signal.aborted || revision.current !== started) return;
        setHistory(latestHistory(current.current, page));
        setError("");
      } catch (problem) {
        if (!signal.aborted && revision.current === started) {
          setHistory({ ...current.current, loading: false });
          setError(describe(problem));
          return false;
        }
      }
    },
    [gateway, tagId, setHistory],
  );
  const follow = useConversationFollow(
    gateway,
    tagId,
    () => refreshRequest(tagId, current.current),
    (page) => {
      revision.current++;
      setHistory(latestHistory(current.current, page));
      setError("");
    },
  );
  const followLive = follow.live;
  const historyChanged = useCallback(
    (update: WatchUpdate) =>
      update.kind === "conversation" && update.tagId === tagId && !followLive.current,
    [tagId, followLive],
  );
  const requestHistory = useWatchRefresh(refresh, READ_INTERVAL, watch, historyChanged);

  const messages = useMemo(() => shownMessages(history.messages), [history.messages]);
  const dividers = useMemo(() => timeDividers(messages), [messages]);
  const joined = useMemo(() => joinedReplies(messages), [messages]);
  const sessionIds = useMemo(
    () =>
      [...new Set(messages.map((message) => message.task.sessionId).filter(Boolean))].join("\n"),
    [messages],
  );
  const reportSessions = useRef(onSessions);
  reportSessions.current = onSessions;
  useEffect(() => {
    reportSessions.current?.(tagId, sessionIds ? sessionIds.split("\n") : []);
  }, [tagId, sessionIds]);
  const reportSummary = useRef(onSummary);
  reportSummary.current = onSummary;
  useEffect(() => {
    if (!history.loading) reportSummary.current?.(tagId, conversationSummary(messages));
  }, [history.loading, messages, tagId]);

  // Messages that arrive while scrolled up are counted until End.
  const count = useRef(messages.length);
  useEffect(() => {
    const added = messages.length - count.current;
    count.current = messages.length;
    if (added > 0 && !atBottom(scroll.current)) setUnseen((n) => n + added);
  }, [messages.length]);

  async function deliver(sending: ReturnType<typeof queue>) {
    const message = await sending;
    if (message && active.current) {
      revision.current++;
      setHistory(receivedMessage(current.current, message));
      requestHistory();
    }
  }

  function submit(value: string) {
    const text = value.trim();
    if (goalOutcome(text) === "" && onGoal) {
      onDraft("");
      onGoal();
      return;
    }
    if (!text || outgoing) return;
    onDraft("");
    jumpToLatest();
    void deliver(queue(gateway, tagId, text));
  }

  function jumpToLatest() {
    const box = scroll.current;
    if (box) box.scrollTop = box.scrollHeight;
    setUnseen(0);
  }

  async function earlier() {
    if (window < messages.length) {
      setWindow((size) => size + WINDOW);
      return;
    }
    const expected = current.current;
    if (!expected.cursor || paging) return;
    setPaging(true);
    try {
      const page = await gateway.messages({ tagId, cursor: expected.cursor });
      if (!active.current) return;
      const next = earlierHistory(current.current, expected, page);
      if (next !== current.current) {
        setHistory(next);
        setWindow((size) => size + WINDOW);
      }
    } catch (problem) {
      if (active.current) setError(describe(problem));
    } finally {
      if (active.current) setPaging(false);
    }
  }

  useKeyboard((key: KeyEvent) => {
    const box = scroll.current;
    if (key.name === "pageup") {
      if (box && box.scrollTop <= 0) void earlier();
      box?.scrollBy(-Math.max(1, box.viewport.height - 2));
    } else if (key.name === "pagedown") {
      box?.scrollBy(Math.max(1, (box?.viewport.height ?? 2) - 2));
      if (atBottom(box)) setUnseen(0);
    } else if (key.name === "end" && (key.ctrl || !focused || draft === "")) {
      jumpToLatest();
    } else if (key.name === "up" && focused && draft === "" && !key.meta && !key.option && onWork) {
      onWork();
    } else if (key.ctrl && key.name === "r" && outgoing?.error) {
      void deliver(retry(gateway, outgoing.operationId));
    } else if (key.ctrl && key.name === "x" && outgoing?.error) {
      discard(gateway, outgoing.operationId);
      if (!draft.trim()) onDraft(outgoing.text);
    }
  });

  const mounted = messages.slice(-window);
  const hidden = messages.length - mounted.length;
  const lastSent = outgoing ? undefined : lastOperatorMessage(messages);
  const name = tag.name ?? tagId;
  return (
    <box flexDirection="column" flexGrow={1} minHeight={0} minWidth={0}>
      {error ? (
        <text fg={color.warning} flexShrink={0}>
          {safe(error)}
        </text>
      ) : null}
      <scrollbox
        ref={scroll}
        flexGrow={1}
        minHeight={0}
        stickyScroll
        stickyStart="bottom"
        paddingLeft={1}
        paddingRight={1}
      >
        {history.loading && messages.length === 0 ? (
          <text fg={color.muted}>Loading conversation…</text>
        ) : null}
        {!history.loading && messages.length === 0 && !outgoing ? (
          <box flexDirection="column" marginTop={1}>
            <text fg={color.strong}>Message {safe(name)}</text>
            {tag.instructions ? <text fg={color.muted}>{safe(tag.instructions)}</text> : null}
          </box>
        ) : null}
        {hidden > 0 || history.cursor ? (
          <text fg={color.faint}>
            {paging
              ? "Loading earlier messages…"
              : hidden > 0
                ? `${hidden} earlier messages · PgUp`
                : "Earlier messages · PgUp"}
          </text>
        ) : null}
        {mounted.map((message) => {
          const answers = joined.answeredBy.get(message.task.taskId);
          const turnId = (answers ?? message).task.taskId;
          const created = createdObjectiveId((answers ?? message).task.result ?? "");
          return (
            <Entry
              key={message.task.taskId}
              message={message}
              answers={answers}
              replyLater={joined.replyLater.has(message.task.taskId)}
              readEvents={gateway.events}
              wait={follow.waits.get(turnId)}
              writing={follow.texts.get(turnId)}
              delivery={message.task.taskId === lastSent ? deliveryStatus(message) : undefined}
              divider={dividers.get(message.task.taskId)}
              home={created ? homeLine?.(created) : undefined}
            />
          );
        })}
        {outgoing ? (
          <box flexDirection="column" alignItems="flex-end" marginTop={1}>
            <box maxWidth="75%">
              <text fg={color.you}>{safe(outgoing.text)}</text>
            </box>
            {outgoing.error ? (
              <>
                <DeliveryLine text="Not delivered" />
                <text fg={color.muted}>{safe(outgoing.error)} · Ctrl-R retry · Ctrl-X edit</text>
              </>
            ) : (
              <text fg={color.faint}>Sending…</text>
            )}
          </box>
        ) : null}
      </scrollbox>
      {unseen > 0 ? (
        <text fg={color.accent} flexShrink={0}>
          ↓ {unseen} new {unseen === 1 ? "message" : "messages"} · End
        </text>
      ) : null}
      <box border borderColor={focused ? color.focus : color.border} height={3} flexShrink={0}>
        <input
          key={composer}
          focused={focused}
          placeholder={outgoing ? "Sending…" : `Message ${safe(name)}`}
          value={draft}
          onInput={(value: string) => {
            if (value === "/" && draft === "") {
              // The palette takes the `/`: a new field shows the message empty.
              setComposer((n) => n + 1);
              onPalette();
              return;
            }
            onDraft(value);
          }}
          onSubmit={(value: string) => submit(String(value))}
        />
      </box>
    </box>
  );
}
