import { ArrowUp, X } from "lucide-react";
import { type FormEvent, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import type { Gateway, Message, Tag, TaskEvent } from "../gateway";
import { describe, usePolling } from "../lib/polling";
import { TagAvatar } from "./tag-avatar";

const interval = 2_500;

export interface Draft {
  text: string;
  operationId?: string;
  sending?: boolean;
  error?: string;
}

interface History {
  recent: Message[];
  earlier: Message[];
  cursor?: string;
  paging: boolean;
  loading: boolean;
}

interface ConversationProps {
  gateway: Gateway;
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

function statusText(taskState: string, inputState?: string) {
  return (
    {
      pending: "Waiting to join Task",
      dispatching: "Joining Task",
      accepted: "Joined active Task",
      unknown: "Delivery uncertain",
      withdrawn: "Withdrawn",
    }[inputState ?? ""] ??
    {
      queued: "Queued",
      claimed: "Starting",
      running: "Working",
      succeeded: "Completed",
      failed: "Failed",
      cancelled: "Cancelled",
      uncertain: "Needs attention",
    }[taskState] ??
    "Pending"
  );
}

export function ConversationPane({
  gateway,
  tag,
  name,
  draft,
  setDraft,
  onWriteChange,
}: ConversationProps) {
  const [history, setHistory] = useState<History>({
    recent: [],
    earlier: [],
    paging: false,
    loading: true,
  });
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
        const page = await gateway.messages(tagId, name);
        if (signal.aborted || revision.current !== started) return;
        const recent = [...page.messages].reverse();
        const recentIds = new Set(recent.map(({ task }) => task.taskId));
        setHistory((previous) => {
          const earlier = previous.paging
            ? previous.earlier.concat(
                previous.recent.filter(({ task }) => !recentIds.has(task.taskId)),
              )
            : previous.earlier;
          return {
            ...previous,
            earlier,
            recent,
            cursor: previous.paging ? previous.cursor : page.nextCursor || undefined,
            loading: false,
          };
        });
        setError("");
      } catch (error) {
        if (!signal.aborted && revision.current === started) {
          setHistory((previous) => ({ ...previous, loading: false }));
          setError(describe(error));
        }
      }
    },
    [gateway, tagId, name],
  );
  usePolling(refresh, interval);

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
    if (!history.cursor || paging) return;
    setPaging(true);
    setHistory((previous) => ({ ...previous, paging: true }));
    try {
      const page = await gateway.messages(tagId, name, history.cursor);
      if (!active.current) return;
      const region = viewport.current;
      if (region) scrollOffset.current = { height: region.scrollHeight, top: region.scrollTop };
      setHistory((previous) => ({
        ...previous,
        earlier: [...page.messages].reverse().concat(previous.earlier),
        cursor: page.nextCursor || undefined,
      }));
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
        setHistory((previous) => ({
          ...previous,
          loading: false,
          recent: previous.recent.some(({ task }) => task.taskId === message.task.taskId)
            ? previous.recent
            : previous.recent.concat(message),
        }));
      }
    } catch (error) {
      setDraft({ text: draft.text, operationId, error: describe(error) });
    } finally {
      inFlight.current = false;
      onWriteChange(-1);
      composer.current?.focus();
    }
  }

  const messages = [
    ...new Map(
      [...history.earlier, ...history.recent].map((message) => [message.task.taskId, message]),
    ).values(),
  ];
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
              {messages.map(({ task, liveInput }) => {
                const status = statusText(task.state, liveInput?.state);
                const joined = liveInput?.state === "accepted";
                const activityTask = joined ? liveInput.taskId : task.taskId;
                return (
                  <article className="exchange" key={task.taskId}>
                    <div className="user-turn">
                      <span className="visually-hidden">You</span>
                      <p className="prompt-text">{task.prompt}</p>
                    </div>
                    <div className="tag-turn">
                      <TagAvatar tagId={tagId} />
                      <div className="reply-body">
                        <div className="reply-heading">
                          <strong>{tagId}</strong>
                          <Button
                            variant="outline"
                            className="task-status"
                            data-state={task.state}
                            aria-label={`${status} · View Task activity`}
                            aria-expanded={activeTask === activityTask}
                            aria-controls={activeTask ? "activity" : undefined}
                            onClick={(event) => {
                              activityTrigger.current = event.currentTarget;
                              setActiveTask(activityTask);
                            }}
                          >
                            {status}
                          </Button>
                        </div>
                        {task.result && !joined && <p className="result-text">{task.result}</p>}
                      </div>
                    </div>
                  </article>
                );
              })}
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
                placeholder={`Message ${tagId}…`}
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
