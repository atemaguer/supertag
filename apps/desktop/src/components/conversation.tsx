import { ArrowUp, X } from "lucide-react";
import { type FormEvent, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import type { Gateway, Tag, TaskEvent, WatchUpdate } from "../gateway";
import {
  earlierHistory,
  emptyHistory,
  type History,
  latestHistory,
  readHistory,
  receivedMessage,
} from "../lib/history";
import { describe, usePolling } from "../lib/polling";
import { useWatchRefresh, type WatchFeed } from "../lib/watch";
import { ConversationEntry } from "./conversation-entry";
import { TagAvatar } from "./tag-avatar";

const interval = 2_500;

export interface Draft {
  text: string;
  operationId?: string;
  sending?: boolean;
  error?: string;
}

interface ConversationProps {
  gateway: Gateway;
  watch?: WatchFeed;
  tag: Tag;
  name: string;
  draft: Draft;
  setDraft(draft: Draft): void;
  onWriteChange(delta: 1 | -1): void;
}

function newOperationId() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function ConversationPane({
  gateway,
  watch,
  tag,
  name,
  draft,
  setDraft,
  onWriteChange,
}: ConversationProps) {
  const [history, renderHistory] = useState<History>(emptyHistory);
  const currentHistory = useRef(history);
  const [error, setError] = useState("");
  const [paging, setPaging] = useState(false);
  const [activeTask, setActiveTask] = useState<string>();
  const tagId = tag.tagId;
  const revision = useRef(0);
  const inFlight = useRef(false);
  const active = useRef(true);
  const following = useRef(true);
  const scrollOffset = useRef<{ height: number; top: number } | undefined>(undefined);
  const viewport = useRef<HTMLElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  const activityTrigger = useRef<HTMLButtonElement>(null);
  const setHistory = useCallback((next: History) => {
    currentHistory.current = next;
    renderHistory(next);
  }, []);

  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);

  const refresh = useCallback(
    async (signal: AbortSignal) => {
      const started = revision.current;
      try {
        const page = await readHistory(
          (cursor) => gateway.messages(tagId, name, cursor),
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
    [gateway, tagId, name, setHistory],
  );
  const historyChanged = useCallback(
    (update: WatchUpdate) =>
      update.kind === "conversation" && update.tagId === tagId && update.conversation === name,
    [tagId, name],
  );
  const requestHistory = useWatchRefresh(refresh, interval, watch, historyChanged);

  useLayoutEffect(() => {
    const region = viewport.current;
    if (!region || history.loading) return;
    if (scrollOffset.current) {
      const { height, top } = scrollOffset.current;
      region.scrollTop = Math.max(0, top + region.scrollHeight - height);
      scrollOffset.current = undefined;
    } else if (following.current) {
      region.scrollTop = region.scrollHeight;
    }
  }, [history]);

  async function loadEarlier() {
    const expected = currentHistory.current;
    if (!expected.cursor || paging) return;
    setPaging(true);
    try {
      const page = await gateway.messages(tagId, name, expected.cursor);
      if (!active.current) return;
      const previous = currentHistory.current;
      const next = earlierHistory(previous, expected, page);
      if (next === previous) return;
      const region = viewport.current;
      if (region) scrollOffset.current = { height: region.scrollHeight, top: region.scrollTop };
      setHistory(next);
    } catch (error) {
      if (active.current) setError(describe(error));
    } finally {
      if (active.current) setPaging(false);
    }
  }

  async function send(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = draft.text.trim();
    if (!text || inFlight.current || draft.sending) return;
    const operationId = draft.operationId ?? newOperationId();
    inFlight.current = true;
    onWriteChange(1);
    setDraft({ text: draft.text, operationId, sending: true });
    try {
      const message = await gateway.send(tagId, name, text, operationId);
      setDraft({ text: "" });
      if (active.current) {
        revision.current++;
        following.current = true;
        setHistory(receivedMessage(currentHistory.current, message));
        requestHistory();
      }
    } catch (error) {
      setDraft({ text: draft.text, operationId, error: describe(error) });
    } finally {
      inFlight.current = false;
      onWriteChange(-1);
      composer.current?.focus();
    }
  }

  function viewActivity(taskId: string, trigger: HTMLButtonElement) {
    activityTrigger.current = trigger;
    setActiveTask(taskId);
  }

  const messages = history.messages;
  return (
    <>
      {error && (
        <div className="sync-error" role="status">
          {error}
        </div>
      )}
      <div className="work-area">
        <div className="conversation">
          <section
            className="history"
            ref={viewport}
            aria-label="Conversation history"
            // biome-ignore lint/a11y/noNoninteractiveTabindex: The scrollable transcript must be reachable by keyboard.
            tabIndex={0}
            onScroll={({ currentTarget }) => {
              following.current =
                currentTarget.scrollHeight - currentTarget.scrollTop - currentTarget.clientHeight <
                90;
            }}
          >
            <div className="timeline">
              {history.loading && (
                <div className="empty" role="status">
                  Loading conversation…
                </div>
              )}
              {!history.loading && messages.length === 0 && <EmptyConversation tag={tag} />}
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
                <ConversationEntry
                  key={message.task.taskId}
                  message={message}
                  activeTask={activeTask}
                  onActivity={viewActivity}
                  onSaveArtifact={gateway.saveArtifact}
                />
              ))}
            </div>
          </section>
          <form className="composer" onSubmit={(event) => void send(event)}>
            {draft.error && (
              <p className="field-error" role="alert">
                {draft.error}
              </p>
            )}
            <div className="composer-box">
              <Textarea
                ref={composer}
                rows={2}
                required
                aria-label="Message"
                value={draft.text}
                readOnly={draft.sending}
                placeholder={`Message ${tag.name ?? tagId}…`}
                onChange={(event) => {
                  const text = event.target.value;
                  setDraft({
                    text,
                    operationId: draft.text.trim() === text.trim() ? draft.operationId : undefined,
                  });
                }}
                onKeyDown={(event) => {
                  if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing)
                    return;
                  event.preventDefault();
                  if (draft.text.trim() && !draft.sending)
                    event.currentTarget.form?.requestSubmit();
                }}
              />
              <Button
                size="icon"
                type="submit"
                className="send"
                aria-label="Send message"
                title="Send message"
                disabled={draft.sending || !draft.text.trim()}
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
          <ActivityPane
            key={activeTask}
            gateway={gateway}
            tagId={tagId}
            taskId={activeTask}
            onClose={() => {
              setActiveTask(undefined);
              activityTrigger.current?.focus();
            }}
          />
        )}
      </div>
    </>
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
  gateway,
  tagId,
  taskId,
  onClose,
}: {
  gateway: Gateway;
  tagId: string;
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
        const page = await gateway.events(tagId, taskId, after.current);
        if (signal.aborted) return;
        const next = page.filter((entry) => entry.sequence > after.current);
        const last = next.at(-1);
        if (last) {
          after.current = last.sequence;
          setEvents((previous) => previous.concat(next.filter((entry) => entry.text)));
        }
        setError("");
      } catch (error) {
        if (!signal.aborted) setError(describe(error));
      } finally {
        if (!signal.aborted) setLoading(false);
      }
    },
    [gateway, tagId, taskId],
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
          <li key={event.sequence}>{event.text}</li>
        ))}
      </ol>
    </aside>
  );
}
