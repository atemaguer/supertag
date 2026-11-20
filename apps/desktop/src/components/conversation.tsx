import type {
  Gateway,
  Tag,
  Message as TagMessage,
  TagSummary,
  TaskEvent,
  WatchUpdate,
} from "@supertag/client/model";
import {
  conversationSummary,
  deliveryStatus,
  describe,
  earlierHistory,
  emptyHistory,
  eventLine,
  type History,
  joinedReplies,
  lastOperatorMessage,
  latestHistory,
  receivedMessage,
  refreshRequest,
  shownMessages,
  timeDividers,
} from "@supertag/client/model";
import {
  cachedHistory,
  cacheHistory,
  discard,
  markShown,
  type Outgoing,
  openConversation,
  send as queue,
  resumeOutbox,
  retry,
  storedHistory,
  useConversationFollow,
  useOutbox,
  usePolling,
  useWatchRefresh,
  type WatchFeed,
} from "@supertag/client/react";
import { ArrowDown, ArrowUp, CircleAlert, X } from "lucide-react";
import {
  type FormEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { type StickToBottomContext, useStickToBottomContext } from "use-stick-to-bottom";
import { Conversation, ConversationContent } from "./ai-elements/conversation";
import { Message } from "./ai-elements/message";
import type { AvatarEditing } from "./avatar-editor";
import { Bubble, LiveConversationEntry } from "./conversation-entry";
import { clamp, ResizeHandle, useStoredWidth } from "./resize";
import { TagAvatar } from "./tag-avatar";
import { TagDetails } from "./tag-details";
import { TaskFiles } from "./task-files";
import { Button } from "./ui/button";
import { Textarea } from "./ui/textarea";

const interval = 2_500;

/** The Task activity pane's default and least width, and the least the conversation keeps. */
export const ACTIVITY_WIDTH = { initial: 320, min: 280, conversation: 420 };
const ACTIVITY_WIDTH_KEY = "supertag.desktop.activity-width";

/** What the operator is writing to a Tag. A message sent waits in the outbox until it arrives. */
export interface Draft {
  text: string;
}

interface ConversationProps {
  gateway: Gateway;
  watch?: WatchFeed;
  tag: Tag;
  draft: Draft;
  updateDraft(update: (draft: Draft) => Draft): void;
  onWriteChange(delta: 1 | -1): void;
  /** Reports what the sidebar shows for this conversation as its history changes. */
  onSummary?(summary: TagSummary): void;
  /** The Tag details panel, with its memory, shows beside the conversation. */
  details?: boolean;
  onCloseDetails?(): void;
  /** Changes the Tag's portrait from its details, when this connection may manage Tags. */
  avatar?: AvatarEditing;
}

export function ConversationPane({
  gateway,
  watch,
  tag,
  draft,
  updateDraft,
  onWriteChange,
  onSummary,
  details,
  onCloseDetails,
  avatar,
}: ConversationProps) {
  const tagId = tag.tagId;
  // A conversation shown before renders at once from the cache, then revalidates.
  const [history, renderHistory] = useState<History>(
    () => cachedHistory(gateway, tagId) ?? emptyHistory,
  );
  // The message sent that has not arrived yet, also after a restart.
  const outgoing = useOutbox(gateway, tagId)[0];
  const currentHistory = useRef(history);
  const [error, setError] = useState("");
  const [paging, setPaging] = useState(false);
  const [activeTask, setActiveTask] = useState<string>();
  const revision = useRef(0);
  const active = useRef(true);
  const scrollOffset = useRef<{ height: number; top: number } | undefined>(undefined);
  const transcript = useRef<StickToBottomContext>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  const activityTrigger = useRef<HTMLButtonElement>(null);
  const setHistory = useCallback(
    (next: History) => {
      currentHistory.current = next;
      renderHistory(next);
      cacheHistory(gateway, tagId, next);
      // The latest finished turn on screen has been read.
      if (next.read && !document.hidden) markShown(gateway, tagId, next);
    },
    [gateway, tagId],
  );

  useEffect(() => {
    active.current = true;
    const close = openConversation(gateway, tagId);
    // Messages a previous run could not send go out again.
    void resumeOutbox(gateway);
    // Not in memory: the disk cache shows it until the Gateway answers.
    if (!currentHistory.current.read)
      void storedHistory(gateway, tagId).then((stored) => {
        if (stored && active.current && !currentHistory.current.read) {
          currentHistory.current = stored;
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
        // Only what changed since the copy shown, once there is one.
        const page = await gateway.messages(refreshRequest(tagId, currentHistory.current));
        if (signal.aborted || revision.current !== started) return;
        const previous = currentHistory.current;
        const next = latestHistory(previous, page);
        if (previous.conversationId && previous.conversationId !== next.conversationId)
          setActiveTask(undefined);
        setHistory(next);
        setError("");
      } catch (error) {
        if (!signal.aborted && revision.current === started) {
          setHistory({ ...currentHistory.current, loading: false });
          setError(describe(error));
          return false;
        }
      }
    },
    [gateway, tagId, setHistory],
  );
  // The conversation's follow pushes each change as it happens. The Watch and a timer read the
  // history only while the follow is down.
  const follow = useConversationFollow(
    gateway,
    tagId,
    () => refreshRequest(tagId, currentHistory.current),
    (page) => {
      revision.current++;
      const previous = currentHistory.current;
      const next = latestHistory(previous, page);
      if (previous.conversationId && previous.conversationId !== next.conversationId)
        setActiveTask(undefined);
      setHistory(next);
      setError("");
    },
  );
  const followLive = follow.live;
  const historyChanged = useCallback(
    (update: WatchUpdate) =>
      update.kind === "conversation" && update.tagId === tagId && !followLive.current,
    [tagId, followLive],
  );
  const requestHistory = useWatchRefresh(refresh, interval, watch, historyChanged);

  // The transcript follows new messages while it is at the bottom. Earlier messages are added
  // above, so keep what was in view where it was.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs once the new history renders.
  useLayoutEffect(() => {
    const region = transcript.current?.scrollRef.current;
    if (!region || !scrollOffset.current) return;
    const { height, top } = scrollOffset.current;
    region.scrollTop = Math.max(0, top + region.scrollHeight - height);
    scrollOffset.current = undefined;
  }, [history]);

  // The composer grows with its text up to its maximum height, then scrolls.
  // biome-ignore lint/correctness/useExhaustiveDependencies: measures each new draft.
  useLayoutEffect(() => {
    const field = composer.current;
    if (!field) return;
    field.style.height = "auto";
    field.style.height = `${field.scrollHeight}px`;
  }, [draft.text]);

  async function loadEarlier() {
    const expected = currentHistory.current;
    if (!expected.cursor || paging) return;
    setPaging(true);
    try {
      const page = await gateway.messages({ tagId, cursor: expected.cursor });
      if (!active.current) return;
      const previous = currentHistory.current;
      const next = earlierHistory(previous, expected, page);
      if (next === previous) return;
      const region = transcript.current?.scrollRef.current;
      if (region) scrollOffset.current = { height: region.scrollHeight, top: region.scrollTop };
      setHistory(next);
    } catch (error) {
      if (active.current) setError(describe(error));
    } finally {
      if (active.current) setPaging(false);
    }
  }

  // The outbox keeps the message, across restarts, until the Gateway has it. A retry
  // reuses its operation, so it is sent at most once.
  async function deliver(sending: Promise<TagMessage | undefined>) {
    onWriteChange(1);
    void transcript.current?.scrollToBottom();
    try {
      const message = await sending;
      if (message && active.current) {
        revision.current++;
        setHistory(receivedMessage(currentHistory.current, message));
        void transcript.current?.scrollToBottom();
        requestHistory();
      }
    } finally {
      onWriteChange(-1);
    }
  }

  // Opening a Tag's conversation puts the cursor in its composer, as a messaging app does.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when another Tag opens.
  useEffect(() => {
    composer.current?.focus({ preventScroll: true });
  }, [tagId]);

  // The message leaves the composer at once and shows as sending until the Gateway has it.
  function send(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = draft.text.trim();
    if (!text || outgoing) return;
    updateDraft(() => ({ text: "" }));
    void deliver(queue(gateway, tagId, text));
    composer.current?.focus();
  }

  // A message that was not delivered goes back to the composer to change, if that is empty.
  function edit(failed: Outgoing) {
    discard(gateway, failed.operationId);
    updateDraft((current) => ({ text: current.text.trim() ? current.text : failed.text }));
    composer.current?.focus();
  }

  function viewActivity(taskId: string, trigger: HTMLButtonElement) {
    activityTrigger.current = trigger;
    setActiveTask(taskId);
  }

  // The activity pane's width: at least 280px, at most 60% of the window, and never so wide
  // that the conversation is narrower than 420px.
  const workArea = useRef<HTMLDivElement>(null);
  const conversationPane = useRef<HTMLDivElement>(null);
  const composerForm = useRef<HTMLFormElement>(null);
  // The conversation pads its end, and places its jump-to-latest button, by the composer's
  // height, which grows with a long draft.
  useEffect(() => {
    const form = composerForm.current;
    const pane = conversationPane.current;
    if (!form || !pane) return;
    const follow = () =>
      pane.style.setProperty("--composer-height", `${form.getBoundingClientRect().height}px`);
    follow();
    const observer = new ResizeObserver(follow);
    observer.observe(form);
    return () => observer.disconnect();
  }, []);
  const [activityWidth, setActivityWidth] = useStoredWidth(
    ACTIVITY_WIDTH_KEY,
    ACTIVITY_WIDTH.initial,
  );
  const [activityLive, setActivityLive] = useState<number>();
  const activityMax = () =>
    Math.min(
      window.innerWidth * 0.6,
      (workArea.current?.clientWidth ?? window.innerWidth) - ACTIVITY_WIDTH.conversation,
    );
  const activityShown = activityLive ?? clamp(activityWidth, ACTIVITY_WIDTH.min, activityMax());

  const messages = useMemo(() => shownMessages(history.messages), [history.messages]);
  const dividers = useMemo(() => timeDividers(messages), [messages]);
  const joined = useMemo(() => joinedReplies(messages), [messages]);
  const reportSummary = useRef(onSummary);
  reportSummary.current = onSummary;
  useEffect(() => {
    if (!history.loading) reportSummary.current?.(conversationSummary(messages));
  }, [history.loading, messages]);
  const lastSent = outgoing ? undefined : lastOperatorMessage(messages);
  const blocked = outgoing?.error
    ? "Retry or edit the message that was not delivered"
    : outgoing
      ? "Sending…"
      : undefined;
  return (
    <>
      {error && (
        <div className="sync-error" role="status">
          {error}
        </div>
      )}
      <div className="work-area" ref={workArea}>
        <div className="conversation" ref={conversationPane}>
          {history.loading ? (
            <div className="history">
              <div className="timeline">
                <div className="empty" role="status">
                  Loading conversation…
                </div>
              </div>
            </div>
          ) : (
            // Mounted once the history has loaded, so it opens at the latest message.
            <Conversation className="history" contextRef={transcript} initial="instant">
              <ConversationContent
                className="timeline"
                scrollProps={{
                  className: "history-scroll",
                  "aria-label": "Conversation history",
                  tabIndex: 0,
                }}
              >
                {messages.length === 0 && <EmptyConversation tag={tag} />}
                {history.cursor && (
                  <Button
                    variant="link"
                    className="earlier"
                    disabled={paging}
                    onClick={() => void loadEarlier()}
                  >
                    {paging ? "Loading…" : "Load earlier messages"}
                  </Button>
                )}
                {messages.map((message) => {
                  // A turn that later messages joined shows its reply after the last of them.
                  const answers = joined.answeredBy.get(message.task.taskId);
                  const turnId = (answers ?? message).task.taskId;
                  return (
                    <LiveConversationEntry
                      key={message.task.taskId}
                      message={message}
                      answers={answers}
                      replyLater={joined.replyLater.has(message.task.taskId)}
                      readEvents={gateway.events}
                      wait={follow.waits.get(turnId)}
                      writing={follow.texts.get(turnId)}
                      activeTask={activeTask}
                      delivery={
                        message.task.taskId === lastSent ? deliveryStatus(message) : undefined
                      }
                      divider={dividers.get(message.task.taskId)}
                      onActivity={viewActivity}
                      resolveAttempt={gateway.resolveAttempt}
                    />
                  );
                })}
                {outgoing && (
                  <OutgoingMessage
                    outgoing={outgoing}
                    onRetry={(failed) => void deliver(retry(gateway, failed.operationId))}
                    onEdit={edit}
                  />
                )}
              </ConversationContent>
              <JumpToLatest messages={messages.length} />
            </Conversation>
          )}
          {/* The composer floats over the conversation, which scrolls under it. */}
          <form className="composer" ref={composerForm} onSubmit={send}>
            <div className="composer-box">
              <Textarea
                ref={composer}
                rows={1}
                required
                aria-label="Message"
                value={draft.text}
                placeholder={`Message ${tag.name ?? tagId}`}
                onChange={(event) => {
                  const text = event.target.value;
                  updateDraft((current) => ({ ...current, text }));
                }}
                onKeyDown={(event) => {
                  if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing)
                    return;
                  event.preventDefault();
                  if (draft.text.trim() && !outgoing) event.currentTarget.form?.requestSubmit();
                }}
              />
              <Button
                size="icon"
                type="submit"
                className="send"
                aria-label="Send message"
                title={blocked ?? "Send message"}
                disabled={Boolean(outgoing) || !draft.text.trim()}
              >
                <ArrowUp size={18} aria-hidden />
              </Button>
            </div>
            <div className="composer-footer">
              Enter to send <span aria-hidden>·</span> Shift + Enter for a new line
            </div>
          </form>
        </div>
        {(activeTask || details) && (
          <div className="activity-frame" style={{ width: activityShown }}>
            <ResizeHandle
              label="Resize Task activity"
              className="activity-resize"
              value={activityShown}
              min={ACTIVITY_WIDTH.min}
              max={activityMax()}
              grows={-1}
              onResize={(raw, done) => {
                const width = clamp(raw, ACTIVITY_WIDTH.min, activityMax());
                if (done) {
                  setActivityLive(undefined);
                  setActivityWidth(width);
                } else setActivityLive(width);
              }}
              onDoubleClick={() => setActivityWidth(ACTIVITY_WIDTH.initial)}
            />
            {activeTask ? (
              <ActivityPane
                key={activeTask}
                gateway={gateway}
                taskId={activeTask}
                task={messages.find((message) => message.task.taskId === activeTask)?.task}
                latest={latestEvent(messages, activeTask)}
                pushed={follow.connected}
                onClose={() => {
                  setActiveTask(undefined);
                  activityTrigger.current?.focus();
                }}
              />
            ) : (
              <TagDetails
                gateway={gateway}
                watch={watch}
                tag={tag}
                avatar={avatar}
                onClose={() => onCloseDetails?.()}
              />
            )}
          </div>
        )}
      </div>
    </>
  );
}

/** The operator's message while it is sent, or after it was not delivered, with a retry. */
function OutgoingMessage({
  outgoing,
  onRetry,
  onEdit,
}: {
  outgoing: Outgoing;
  onRetry(outgoing: Outgoing): void;
  onEdit(outgoing: Outgoing): void;
}) {
  return (
    <article className="exchange">
      <Message from="user" className="user-turn">
        <span className="visually-hidden">You</span>
        <Bubble text={outgoing.text} className="prompt-text" tail />
        {outgoing.error ? (
          <div className="delivery" data-delivery="Not delivered" role="alert">
            <CircleAlert size={13} aria-hidden />
            <span title={outgoing.error}>Not delivered</span>
            <Button variant="link" className="delivery-action" onClick={() => onRetry(outgoing)}>
              Retry
            </Button>
            <Button variant="link" className="delivery-action" onClick={() => onEdit(outgoing)}>
              Edit
            </Button>
          </div>
        ) : (
          <div className="delivery" data-delivery="Sending" role="status">
            Sending…
          </div>
        )}
        {outgoing.error && <p className="delivery-error">{outgoing.error}</p>}
      </Message>
    </article>
  );
}

/**
 * The arrow back to the latest message, shown while scrolled up, with how many messages arrived
 * since.
 */
function JumpToLatest({ messages }: { messages: number }) {
  const { isAtBottom, scrollToBottom } = useStickToBottomContext();
  const seen = useRef(messages);
  if (isAtBottom) seen.current = messages;
  const unseen = Math.max(0, messages - seen.current);
  if (isAtBottom) return null;
  const label = unseen
    ? `${unseen} new ${unseen === 1 ? "message" : "messages"}. Scroll to the latest`
    : "Scroll to the latest message";
  return (
    <Button
      variant="outline"
      className="scroll-latest"
      data-unseen={unseen || undefined}
      aria-label={label}
      title={label}
      onClick={() => void scrollToBottom()}
    >
      <ArrowDown size={16} aria-hidden />
      {unseen > 0 && <span className="unseen-count">{unseen}</span>}
    </Button>
  );
}

function EmptyConversation({ tag }: { tag: Tag }) {
  return (
    <div className="empty">
      <TagAvatar tag={tag} large />
      <h2>Message {tag.name ?? tag.tagId}</h2>
      {tag.instructions && <p className="tag-instructions">{tag.instructions}</p>}
      <details className="permissions">
        <summary>Permissions</summary>
        {tag.allowedActions.length ? (
          <ul>
            {tag.allowedActions.map((action) => (
              <li key={action}>{action}</li>
            ))}
          </ul>
        ) : (
          <p>No allowed actions are configured.</p>
        )}
      </details>
    </div>
  );
}

/** The sequence of the latest event a turn's message carries, which changes as the turn works. */
function latestEvent(messages: readonly TagMessage[], taskId: string) {
  return messages.find((message) => message.task.taskId === taskId)?.events?.at(-1)?.sequence;
}

/**
 * Every activity line of a Task. It reads newer ones whenever the conversation's follow pushes a
 * change to the turn (`latest`), and on a timer only while the follow is down.
 */
function ActivityPane({
  gateway,
  taskId,
  task,
  latest,
  pushed,
  onClose,
}: {
  gateway: Gateway;
  taskId: string;
  task?: { tagId: string; sessionId: string };
  latest?: number;
  pushed: boolean;
  onClose(): void;
}) {
  const [events, setEvents] = useState<TaskEvent[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const after = useRef(0);
  const close = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    close.current?.focus();
  }, []);
  const refresh = useCallback(
    async (signal: AbortSignal) => {
      try {
        const page = await gateway.events(taskId, after.current);
        if (signal.aborted) return;
        const next = page.filter((entry) => entry.sequence > after.current);
        const last = next.at(-1);
        if (last) {
          after.current = last.sequence;
          setEvents((previous) => previous.concat(next.filter((entry) => eventLine(entry))));
        }
        setError("");
      } catch (error) {
        if (!signal.aborted) setError(describe(error));
      } finally {
        if (!signal.aborted) setLoading(false);
      }
    },
    [gateway, taskId],
  );
  usePolling(refresh, pushed ? undefined : interval);
  // Reads again as the turn's latest event moves.
  useEffect(() => {
    if (latest === undefined) return;
    const controller = new AbortController();
    void refresh(controller.signal);
    return () => controller.abort();
  }, [latest, refresh]);

  const status =
    error || (loading ? "Loading activity…" : events.length ? "" : "No activity recorded yet.");
  return (
    <aside id="activity" className="activity" aria-label="Task activity">
      <div className="activity-header">
        <h2>Task activity</h2>
        <Button
          variant="ghost"
          size="icon"
          className="icon-button"
          ref={close}
          aria-label="Close task activity"
          onClick={onClose}
        >
          <X size={16} aria-hidden />
        </Button>
      </div>
      {status && (
        <p className="activity-status" role="status">
          {status}
        </p>
      )}
      <ol>
        {events.map((event) => (
          <li key={event.sequence}>{eventLine(event)}</li>
        ))}
      </ol>
      <TaskFiles
        gateway={gateway}
        taskId={taskId}
        {...(task ? { session: { tagId: task.tagId, sessionId: task.sessionId } } : {})}
      />
    </aside>
  );
}
