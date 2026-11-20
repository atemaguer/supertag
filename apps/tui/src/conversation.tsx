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
import { type Command, namedCommand } from "./commands";
import { DeliveryLine, Entry } from "./entry";
import { ArgumentHint, SlashPopup, useSlash } from "./slash";
import { safe } from "./text";
import {
  atBottom,
  color,
  type InputRenderable,
  type KeyEvent,
  pasteOnOneLine,
  type ScrollBoxRenderable,
  useKeyboard,
} from "./ui";

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
  /** The commands available now, which `/` at the start of a message lists. */
  commands: readonly Command[];
  /** Runs a command chosen in the popup or sent as `/name`. */
  onCommand(command: Command, argument?: string): void;
  onSummary?(tagId: string, summary: TagSummary): void;
  /** ↑ on an empty message: the Work Sessions the turns of the conversation's Sessions started. */
  onWork?(): void;
  /** The Sessions the conversation's turns ran in, as they change. */
  onSessions?(tagId: string, sessionIds: string[]): void;
  /** The line under the reply that created an Objective, once it needs a person or ended. */
  homeLine?(objectiveId: string): string | undefined;
  /** Connecting failed and the screen says so already: a read's own error is not repeated. */
  offline?: boolean;
}

export function ConversationPane({
  gateway,
  watch,
  tag,
  draft,
  onDraft,
  focused,
  commands,
  onCommand,
  onSummary,
  onWork,
  onSessions,
  homeLine,
  offline = false,
}: ConversationProps) {
  const tagId = tag.tagId;
  const platform = usePlatform();
  const [history, renderHistory] = useState<History>(
    () => cachedHistory(gateway, tagId) ?? emptyHistory,
  );
  // Every message sent here that the Gateway has not accepted yet, oldest first. Another can be
  // sent while one is on its way; each waits in the outbox, on disk.
  const queued = useOutbox(gateway, tagId);
  const outgoing = queued[0];
  const undelivered = queued.filter((entry) => entry.error && !entry.sending);
  const current = useRef(history);
  const [error, setError] = useState("");
  const [window, setWindow] = useState(WINDOW);
  const [paging, setPaging] = useState(false);
  const [unseen, setUnseen] = useState(0);
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

  // The field shows what it is given even when the draft it had was never rendered (keys that
  // land together, then a command clears it).
  const field = useRef<InputRenderable>(null);
  const setText = (text: string) => {
    if (field.current && field.current.value !== text) field.current.value = text;
    onDraft(text);
  };
  const slash = useSlash({ text: draft, focused, commands, setText, run: onCommand });

  function submit(value: string) {
    // The popup is open (it takes Enter itself, unless keys landed together): never send.
    if (slash.submit(value)) return;
    const text = value.trim();
    // `/name` runs the command; `/goal OUTCOME` is a message the Gateway reads. A command that
    // takes no argument, given one (`/help me with this`), and `/anything else` are messages.
    const named = namedCommand(text, commands);
    const argument = named?.command.slash?.argument;
    if (named && (argument ? !(named.argument && argument.message) : !named.argument)) {
      setText("");
      onCommand(named.command, named.argument);
      return;
    }
    if (!text) return;
    setText("");
    jumpToLatest();
    void deliver(queue(gateway, tagId, text));
  }

  function jumpToLatest() {
    const box = scroll.current;
    if (box) box.scrollTop = box.scrollHeight;
    setUnseen(0);
  }

  // The first uncertain turn holds every later one: Ctrl-R runs it again, Ctrl-X records it as
  // failed, once no undelivered message has those keys.
  const uncertain = messages.find(
    (message) => message.task.state === "uncertain" && message.task.attemptId,
  );
  const [deciding, setDeciding] = useState<
    { taskId: string; text: string; busy: boolean } | undefined
  >();
  function decide(decision: "retry" | "failed") {
    const task = uncertain?.task;
    if (!task?.attemptId || !gateway.resolveAttempt || deciding?.busy) return;
    const taskId = task.taskId;
    setDeciding({
      taskId,
      text: decision === "retry" ? "Retrying…" : "Marking it failed…",
      busy: true,
    });
    gateway.resolveAttempt(taskId, task.attemptId, decision).then(
      () => {
        if (!active.current) return;
        setDeciding(undefined);
        requestHistory();
      },
      (problem: unknown) => {
        if (active.current) setDeciding({ taskId, text: describe(problem), busy: false });
      },
    );
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
    } else if (key.ctrl && key.name === "r" && undelivered.length) {
      // Each again with its own operation, oldest first, so they arrive in order.
      void (async () => {
        for (const entry of undelivered) await deliver(retry(gateway, entry.operationId));
      })();
    } else if (key.ctrl && key.name === "x" && undelivered.length && !draft.trim()) {
      // The latest one goes back into the composer.
      const latest = undelivered[undelivered.length - 1] as (typeof undelivered)[number];
      discard(gateway, latest.operationId);
      onDraft(latest.text);
    } else if (key.ctrl && key.name === "r" && uncertain && gateway.resolveAttempt) {
      decide("retry");
    } else if (
      key.ctrl &&
      key.name === "x" &&
      uncertain &&
      gateway.resolveAttempt &&
      !draft.trim()
    ) {
      decide("failed");
    }
  });

  const mounted = messages.slice(-window);
  const hidden = messages.length - mounted.length;
  const lastSent = outgoing ? undefined : lastOperatorMessage(messages);
  const name = tag.name ?? tagId;
  return (
    <box flexDirection="column" flexGrow={1} minHeight={0} minWidth={0}>
      {error && !offline ? (
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
              decide={
                message === uncertain && gateway.resolveAttempt
                  ? deciding?.taskId === message.task.taskId
                    ? deciding.text
                    : "Later messages wait for a decision · Ctrl-R retry · Ctrl-X mark failed"
                  : undefined
              }
            />
          );
        })}
        {queued.map((entry, position) => (
          <box key={entry.operationId} flexDirection="column" alignItems="flex-end" marginTop={1}>
            <box maxWidth="75%">
              <text fg={color.you}>{safe(entry.text)}</text>
            </box>
            {entry.error && !entry.sending ? (
              <>
                <DeliveryLine text="Not delivered" />
                {entry === undelivered[undelivered.length - 1] ? (
                  <text fg={color.muted}>{safe(entry.error)} · Ctrl-R retry · Ctrl-X edit</text>
                ) : null}
              </>
            ) : position === queued.length - 1 ? (
              <text fg={color.faint}>Sending…</text>
            ) : null}
          </box>
        ))}
      </scrollbox>
      {unseen > 0 ? (
        <text fg={color.accent} flexShrink={0}>
          ↓ {unseen} new {unseen === 1 ? "message" : "messages"} · End
        </text>
      ) : null}
      {slash.awaiting && focused ? <ArgumentHint command={slash.awaiting} /> : null}
      <box border borderColor={focused ? color.focus : color.border} height={3} flexShrink={0}>
        <input
          ref={field}
          onPaste={pasteOnOneLine}
          focused={focused}
          placeholder={`Message ${safe(name)} · / for commands`}
          value={draft}
          onInput={(value: string) => {
            slash.input(value);
            onDraft(value);
          }}
          onSubmit={(value: string) => submit(String(value))}
        />
      </box>
      {slash.open ? <SlashPopup slash={slash} /> : null}
    </box>
  );
}
