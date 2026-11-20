import type {
  AttemptDecisionName,
  Gateway,
  Message as TagMessage,
  TaskEvent,
} from "@supertag/client/model";
import { dividerLabel, fromOperator, RUNNING, turnNotice, turnView } from "@supertag/client/model";
import { useTurnEvents } from "@supertag/client/react";
import { Check, Copy, ListTree } from "lucide-react";
import { useEffect, useState } from "react";
import { defaultRehypePlugins } from "streamdown";
import { Message, MessageContent, MessageResponse } from "./ai-elements/message";
import { ExternalLink } from "./external-link";

/**
 * Streamdown's plugins, except that a link it would block, such as a relative path to a file in
 * the repository (`README.md`), shows as its text rather than with a "[blocked]" marker.
 */
const [harden, hardening] = defaultRehypePlugins["harden"] as [
  (options: Record<string, unknown>) => unknown,
  Record<string, unknown>,
];
const REHYPE_PLUGINS = [
  ...Object.entries(defaultRehypePlugins)
    .filter(([name]) => name !== "harden")
    .map(([, plugin]) => plugin),
  [harden, { ...hardening, linkBlockPolicy: "text-only" }],
] as NonNullable<Parameters<typeof MessageResponse>[0]["rehypePlugins"]>;

import { Button } from "./ui/button";

/**
 * A conversation entry that shows its turn's messages and what it is doing, as the conversation's
 * follow pushes them, and why it still waits for a Worker Host while it is queued or, running, for
 * the Worker Host holding its Session's last delivery.
 */
export function LiveConversationEntry(
  props: Omit<Parameters<typeof ConversationEntry>[0], "events"> & {
    readEvents: Gateway["events"];
  },
) {
  const { message, wait, answers, ...entry } = props;
  const joined = fromOperator(message) && message.liveInput?.state === "accepted";
  // A message that joined a turn shows nothing of its own; the last of them shows that turn's reply.
  const turn = answers ?? (joined ? undefined : message);
  const events = useTurnEvents(props.readEvents, turn ? { ...turn, taskId: turn.task.taskId } : {});
  // A queued turn waits for a Worker Host; a running one may wait for the host holding its
  // Session's last delivery. The follow clears a reason once it no longer holds.
  const waiting =
    turn && (turn.task.state === "queued" || turn.task.waitingForHolder) ? wait : undefined;
  return (
    <ConversationEntry
      {...entry}
      message={message}
      answers={answers}
      events={events}
      wait={waiting}
    />
  );
}

export function ConversationEntry({
  message,
  answers,
  replyLater,
  events = [],
  wait,
  writing,
  activeTask,
  delivery,
  divider,
  onActivity,
  resolveAttempt,
}: {
  message: TagMessage;
  /**
   * The turn this message joined, when it is the last message that joined it: its reply shows
   * here, after every message it answers.
   */
  answers?: TagMessage;
  /** Shows only the person's message: its reply shows after a later message that joined it. */
  replyLater?: boolean;
  /** The turn's recorded events, for the messages the Tag wrote and what it is doing. */
  events?: readonly TaskEvent[];
  /** Why the queued turn has not started, such as a Worker Host slot an uncertain Attempt keeps. */
  wait?: string;
  /** The text of the message the Tag is writing now, shown as it is written. */
  writing?: string;
  /** The delivery of the operator's message, shown when it is their last one. */
  delivery?: string;
  /** When a time divider precedes this exchange: its time in milliseconds since the epoch. */
  divider?: number;
  activeTask?: string;
  onActivity(taskId: string, trigger: HTMLButtonElement): void;
  /** Decides about the turn when it is uncertain: run it again, or record it as failed. */
  resolveAttempt?: Gateway["resolveAttempt"];
}) {
  const prompt = message.task.prompt;
  const own = fromOperator(message);
  // The reply shown here: the joined turn's, after its last joined message.
  const shown = answers ?? message;
  const { task, workSessionReportId, scheduleId } = shown;
  const report = workSessionReportId !== undefined;
  const scheduled = scheduleId !== undefined;
  const input = !answers && fromOperator(message) ? message.liveInput : undefined;
  const notice = turnNotice(task.state, input?.state);
  const joined = input?.state === "accepted";
  const activityTask = joined ? input.taskId : task.taskId;
  const turn = turnView(joined ? [] : events, task.result);
  const working = RUNNING.has(task.state);
  // The message the Tag is writing streams into its own bubble until it is recorded.
  const written = !joined && !task.result && writing?.trim() ? writing : undefined;
  const bubbles = [
    ...turn.messages.map((text) => ({ text, className: "tag-message" })),
    ...(written ? [{ text: written, className: "tag-message writing" }] : []),
    ...(task.result && !joined ? [{ text: task.result, className: "result-text" }] : []),
  ];
  // While the turn runs the Tag is typing, after whatever it has written so far, until its result.
  const typing = working && !joined && !task.result;
  const openActivity = (trigger: HTMLButtonElement) => onActivity(activityTask, trigger);
  const activity = {
    expanded: activeTask === activityTask,
    controls: activeTask ? "activity" : undefined,
    open: openActivity,
  };
  return (
    <>
      {divider !== undefined && (
        <div className="time-divider" title={new Date(divider).toLocaleString()}>
          {dividerLabel(divider)}
        </div>
      )}
      <article className="exchange">
        {own && (
          <Message from="user" className="user-turn">
            <span className="visually-hidden">You</span>
            <Bubble text={prompt ?? ""} className="prompt-text" tail />
            {delivery && (
              <div className="delivery" data-delivery={delivery}>
                {delivery}
              </div>
            )}
          </Message>
        )}
        {!replyLater && (
          <Message from="assistant" className="tag-turn">
            <span className="visually-hidden">{task.tagId}</span>
            {bubbles.map((bubble, index) => (
              <Bubble
                // Messages are append-only, so their position is their identity.
                // biome-ignore lint/suspicious/noArrayIndexKey: see above.
                key={index}
                text={bubble.text}
                markdown
                className={bubble.className}
                tail={!typing && index === bubbles.length - 1}
                // A settled reply opens its activity from its last bubble's actions.
                activity={!typing && index === bubbles.length - 1 ? activity : undefined}
              />
            ))}
            {typing && (
              // The dots alone say the Tag is working, as in a messaging app. They open the turn's
              // activity, and only their label names the current step.
              <div className="typing" role="status">
                <button
                  type="button"
                  className="typing-button"
                  aria-label={`${task.tagId} is working${turn.status ? `: ${turn.status}` : ""} · View Task activity`}
                  aria-expanded={activeTask === activityTask}
                  aria-controls={activeTask ? "activity" : undefined}
                  onClick={(event) => openActivity(event.currentTarget)}
                >
                  <span className="bubble typing-bubble tail" aria-hidden>
                    <span className="working-dots">
                      <span />
                      <span />
                      <span />
                    </span>
                  </span>
                </button>
                {wait && <p className="task-wait">{wait}</p>}
              </div>
            )}
            {report && (
              <div className="turn-meta">
                <span className="report-label">
                  Work Session report
                  {message.workSessionClosed ? ` · closed: ${message.workSessionClosed}` : ""}
                </span>
              </div>
            )}
            {scheduled && (
              // The Tag speaks because it asked to be woken, not because the operator wrote.
              <div className="turn-meta">
                <span className="report-label">Scheduled</span>
              </div>
            )}
            {/* A settled turn says something here only when it did not simply succeed, or when it
              has no bubble whose actions open its activity. */}
            {!typing && (notice || bubbles.length === 0) && (
              <div className="turn-meta">
                <Button
                  variant="ghost"
                  className="task-status"
                  data-state={task.state}
                  data-tone={notice?.tone ?? "muted"}
                  aria-label={`${notice?.text ?? "Completed"} · View Task activity`}
                  aria-expanded={activity.expanded}
                  aria-controls={activity.controls}
                  onClick={(event) => openActivity(event.currentTarget)}
                >
                  <span className="status-dot" aria-hidden />
                  {notice?.text ?? "View activity"}
                </Button>
              </div>
            )}
            {task.state === "uncertain" && task.attemptId && resolveAttempt && (
              <UncertainTurn
                taskId={task.taskId}
                attemptId={task.attemptId}
                resolve={resolveAttempt}
              />
            )}
          </Message>
        )}
      </article>
    </>
  );
}

/**
 * What an uncertain turn offers its owner: the Session runs no later turn until someone decides,
 * so the turn can run again or be recorded as failed. The Gateway accepts either only once the
 * Worker Host confirmed the turn stopped, and says so otherwise.
 */
export function UncertainTurn({
  taskId,
  attemptId,
  resolve,
}: {
  taskId: string;
  attemptId: string;
  resolve: NonNullable<Gateway["resolveAttempt"]>;
}) {
  const [busy, setBusy] = useState<AttemptDecisionName | undefined>();
  const [problem, setProblem] = useState("");
  const decide = (decision: AttemptDecisionName) => {
    if (busy) return;
    setBusy(decision);
    setProblem("");
    resolve(taskId, attemptId, decision).then(
      () => setBusy(undefined),
      (error: unknown) => {
        setBusy(undefined);
        setProblem(typeof error === "string" ? error : "Could not record the decision.");
      },
    );
  };
  return (
    <div className="turn-meta uncertain-turn">
      <p className="uncertain-help">
        SuperTag lost track of this turn, so it doesn't know whether it finished. Your next messages
        wait until you decide.
      </p>
      <div className="uncertain-actions">
        <Button
          variant="outline"
          size="sm"
          disabled={busy !== undefined}
          onClick={() => decide("retry")}
        >
          {busy === "retry" ? "Retrying…" : "Retry"}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={busy !== undefined}
          onClick={() => decide("failed")}
        >
          {busy === "failed" ? "Marking failed…" : "Mark failed"}
        </Button>
      </div>
      {problem && (
        <p className="uncertain-problem" role="alert">
          {problem}
        </p>
      )}
    </div>
  );
}

/** One message bubble, with a copy action beside it on hover. */
export function Bubble({
  text,
  markdown,
  className,
  tail,
  activity,
}: {
  text: string;
  /** The Tag writes markdown; the operator's text shows as typed. */
  markdown?: boolean;
  className: string;
  /** The last bubble of a group, which gets the tail corner. */
  tail?: boolean;
  /** Opens the turn's Task activity from the bubble's actions. */
  activity?: { expanded: boolean; controls?: string; open(trigger: HTMLButtonElement): void };
}) {
  return (
    <div className="bubble-row">
      <MessageContent className={`bubble ${className}${tail ? " tail" : ""}`}>
        {markdown ? (
          <MessageResponse
            className="markdown"
            components={{ a: ExternalLink }}
            rehypePlugins={REHYPE_PLUGINS}
          >
            {text}
          </MessageResponse>
        ) : (
          text
        )}
      </MessageContent>
      <div className="bubble-actions">
        <CopyText text={text} />
        {activity && (
          <Button
            variant="ghost"
            size="icon"
            className="icon-button"
            aria-label="View Task activity"
            title="View Task activity"
            aria-expanded={activity.expanded}
            aria-controls={activity.controls}
            onClick={(event) => activity.open(event.currentTarget)}
          >
            <ListTree size={14} aria-hidden />
          </Button>
        )}
      </div>
    </div>
  );
}

export function CopyText({ text, label = "Copy message" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1_500);
    return () => window.clearTimeout(timer);
  }, [copied]);
  return (
    <Button
      variant="ghost"
      size="icon"
      className="icon-button"
      aria-label={copied ? "Copied" : label}
      title={copied ? "Copied" : label}
      onClick={() =>
        navigator.clipboard.writeText(text).then(
          () => setCopied(true),
          () => {},
        )
      }
    >
      {copied ? <Check size={14} aria-hidden /> : <Copy size={14} aria-hidden />}
    </Button>
  );
}
