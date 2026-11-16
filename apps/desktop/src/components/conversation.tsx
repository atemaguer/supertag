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
import type { ControlPlane, Tag, TaskEvent, WatchUpdate } from "../control-plane";
import {
  cachedHistory,
  cacheHistory,
  openConversation,
  showConversation,
  storedHistory,
} from "../lib/conversation-cache";
import {
  earlierHistory,
  emptyHistory,
  type History,
  latestHistory,
  readHistory,
  receivedMessage,
} from "../lib/history";
import { describe, usePolling } from "../lib/polling";
import { eventLine } from "../lib/turn";
import { useWatchRefresh, type WatchFeed } from "../lib/watch";
import { Conversation, ConversationContent } from "./ai-elements/conversation";
import { Message } from "./ai-elements/message";
import { Bubble, LiveConversationEntry } from "./conversation-entry";
import { clamp, ResizeHandle, useStoredWidth } from "./resize";
import type { TagSummary } from "./sidebar";
import { TagAvatar } from "./tag-avatar";
import {
  conversationSummary,
  deliveryStatus,
  lastOperatorMessage,
  timeDividers,
} from "./transcript";
import { Button } from "./ui/button";
import { Textarea } from "./ui/textarea";

const interval = 2_500;

/** The Task activity pane's default and least width, and the least the conversation keeps. */
export const ACTIVITY_WIDTH = { initial: 320, min: 280, conversation: 420 };
const ACTIVITY_WIDTH_KEY = "supertag.desktop.activity-width";

/** A message on its way to the Control Plane: its text and the operation that sends it once. */
export interface Outgoing {
  text: string;
  operationId: string;
  /** Why it was not delivered. A retry reuses the operation, so it is sent at most once. */
  error?: string;
}

/** What the operator is writing to a Tag, and the message they sent that has not arrived yet. */
export interface Draft {
  text: string;
  outgoing?: Outgoing;
}

interface ConversationProps {
  controlPlane: ControlPlane;
  watch?: WatchFeed;
  tag: Tag;
  name: string;
  draft: Draft;
  updateDraft(update: (draft: Draft) => Draft): void;
  onWriteChange(delta: 1 | -1): void;
  /** Reports what the sidebar shows for this conversation as its history changes. */
  onSummary?(summary: TagSummary): void;
}

function newOperationId() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function ConversationPane({
  controlPlane,
  watch,
  tag,
  name,
  draft,
  updateDraft,
  onWriteChange,
  onSummary,
}: ConversationProps) {
  const tagId = tag.tagId;
  // A conversation shown before renders at once from the cache, then revalidates.
  const [history, renderHistory] = useState<History>(
    () => cachedHistory(controlPlane, tagId, name) ?? emptyHistory,
  );
  const currentHistory = useRef(history);
  const [error, setError] = useState("");
  const [paging, setPaging] = useState(false);
  const [activeTask, setActiveTask] = useState<string>();
  const revision = useRef(0);
  const inFlight = useRef(false);
  const active = useRef(true);
  const scrollOffset = useRef<{ height: number; top: number } | undefined>(undefined);
  const transcript = useRef<StickToBottomContext>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  const activityTrigger = useRef<HTMLButtonElement>(null);
  const setHistory = useCallback(
    (next: History) => {
      currentHistory.current = next;
      renderHistory(next);
      cacheHistory(controlPlane, tagId, name, next);
    },
    [controlPlane, tagId, name],
  );

  useEffect(() => {
    active.current = true;
    showConversation(controlPlane, tagId, name);
    const close = openConversation(controlPlane, tagId, name);
    // Not in memory: the disk cache shows it until the Control Plane answers.
    if (!currentHistory.current.read)
      void storedHistory(controlPlane, tagId, name).then((stored) => {
        if (stored && active.current && !currentHistory.current.read) {
          currentHistory.current = stored;
          renderHistory(stored);
        }
      });
    return () => {
      active.current = false;
      close();
    };
  }, [controlPlane, tagId, name]);

  const refresh = useCallback(
    async (signal: AbortSignal) => {
      const started = revision.current;
      try {
        const page = await readHistory(
          (cursor) => controlPlane.messages(tagId, name, cursor),
          currentHistory.current,
          signal,
        );
        if (signal.aborted || revision.current !== started) return;
        const previous = currentHistory.current;
        const next = latestHistory(previous, page);
        if (previous.sessionId && previous.sessionId !== next.sessionId) setActiveTask(undefined);
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
    [controlPlane, tagId, name, setHistory],
  );
  const historyChanged = useCallback(
    (update: WatchUpdate) =>
      update.kind === "conversation" && update.tagId === tagId && update.conversation === name,
    [tagId, name],
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
      const page = await controlPlane.messages(tagId, name, expected.cursor);
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

  async function deliver(outgoing: Outgoing) {
    if (inFlight.current) return;
    inFlight.current = true;
    onWriteChange(1);
    updateDraft((current) => ({ ...current, outgoing: { ...outgoing, error: undefined } }));
    void transcript.current?.scrollToBottom();
    try {
      const message = await controlPlane.send(tagId, name, outgoing.text, outgoing.operationId);
      updateDraft((current) => ({ text: current.text }));
      if (active.current) {
        revision.current++;
        setHistory(receivedMessage(currentHistory.current, message));
        void transcript.current?.scrollToBottom();
        requestHistory();
      }
    } catch (error) {
      updateDraft((current) => ({ ...current, outgoing: { ...outgoing, error: describe(error) } }));
    } finally {
      inFlight.current = false;
      onWriteChange(-1);
    }
  }

  // The message leaves the composer at once and shows as sending until the Control Plane has it.
  function send(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = draft.text.trim();
    if (!text || draft.outgoing) return;
    updateDraft(() => ({ text: "" }));
    void deliver({ text, operationId: newOperationId() });
    composer.current?.focus();
  }

  // A message that was not delivered goes back to the composer to change, if that is empty.
  function edit(outgoing: Outgoing) {
    updateDraft((current) => ({ text: current.text.trim() ? current.text : outgoing.text }));
    composer.current?.focus();
  }

  function viewActivity(taskId: string, trigger: HTMLButtonElement) {
    activityTrigger.current = trigger;
    setActiveTask(taskId);
  }

  // The activity pane's width: at least 280px, at most 60% of the window, and never so wide
  // that the conversation is narrower than 420px.
  const workArea = useRef<HTMLDivElement>(null);
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

  const messages = history.messages;
  const dividers = useMemo(() => timeDividers(messages), [messages]);
  const reportSummary = useRef(onSummary);
  reportSummary.current = onSummary;
  useEffect(() => {
    if (!history.loading) reportSummary.current?.(conversationSummary(messages));
  }, [history.loading, messages]);
  const lastSent = draft.outgoing ? undefined : lastOperatorMessage(messages);
  const blocked = draft.outgoing?.error
    ? "Retry or edit the message that was not delivered"
    : draft.outgoing
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
        <div className="conversation">
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
                {messages.map((message) => (
                  <LiveConversationEntry
                    key={message.task.taskId}
                    message={message}
                    readEvents={controlPlane.events}
                    activeTask={activeTask}
                    delivery={
                      message.task.taskId === lastSent ? deliveryStatus(message) : undefined
                    }
                    divider={dividers.get(message.task.taskId)}
                    onActivity={viewActivity}
                    onSaveArtifact={controlPlane.saveArtifact}
                  />
                ))}
                {draft.outgoing && (
                  <OutgoingMessage
                    outgoing={draft.outgoing}
                    onRetry={(outgoing) => void deliver(outgoing)}
                    onEdit={edit}
                  />
                )}
              </ConversationContent>
              <JumpToLatest messages={messages.length} />
            </Conversation>
          )}
          <form className="composer" onSubmit={send}>
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
                  if (draft.text.trim() && !draft.outgoing)
                    event.currentTarget.form?.requestSubmit();
                }}
              />
              <Button
                size="icon"
                type="submit"
                className="send"
                aria-label="Send message"
                title={blocked ?? "Send message"}
                disabled={Boolean(draft.outgoing) || !draft.text.trim()}
              >
                <ArrowUp size={18} aria-hidden />
              </Button>
            </div>
            <div className="composer-footer">
              Enter to send <span aria-hidden>·</span> Shift + Enter for a new line
            </div>
          </form>
        </div>
        {activeTask && (
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
            <ActivityPane
              key={activeTask}
              controlPlane={controlPlane}
              taskId={activeTask}
              onClose={() => {
                setActiveTask(undefined);
                activityTrigger.current?.focus();
              }}
            />
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
      <TagAvatar tagId={tag.tagId} large />
      <h2>Message {tag.tagId}</h2>
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

function ActivityPane({
  controlPlane,
  taskId,
  onClose,
}: {
  controlPlane: ControlPlane;
  taskId: string;
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
        const page = await controlPlane.events(taskId, after.current);
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
    [controlPlane, taskId],
  );
  usePolling(refresh, interval);

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
    </aside>
  );
}
