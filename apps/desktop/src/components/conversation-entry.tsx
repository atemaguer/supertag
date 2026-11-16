import { Check, Copy } from "lucide-react";
import { useEffect, useState } from "react";
import type { ControlPlane, Message as TagMessage, TaskEvent } from "../control-plane";
import { turnView, useTurnEvents } from "../lib/turn";
import { Message, MessageContent, MessageResponse } from "./ai-elements/message";
import { Shimmer } from "./ai-elements/shimmer";
import { ResultFiles } from "./result-files";
import { Button } from "./ui/button";

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

const RUNNING = new Set(["queued", "claimed", "running"]);

/** A conversation entry that shows its turn's messages and activity, and reads newer ones while it runs. */
export function LiveConversationEntry(
  props: Omit<Parameters<typeof ConversationEntry>[0], "events"> & {
    readEvents: ControlPlane["events"];
  },
) {
  const { message } = props;
  const { task, workSessionReportId, liveInput } = message;
  const joined = workSessionReportId === undefined && liveInput?.state === "accepted";
  const events = useTurnEvents(
    props.readEvents,
    joined ? {} : { ...message, taskId: task.taskId },
    RUNNING.has(task.state),
  );
  return <ConversationEntry {...props} events={events} />;
}

export function ConversationEntry({
  message,
  events = [],
  activeTask,
  onActivity,
  onSaveArtifact,
}: {
  message: TagMessage;
  /** The turn's recorded events, for the messages the Tag wrote and what it is doing. */
  events?: readonly TaskEvent[];
  activeTask?: string;
  onActivity(taskId: string, trigger: HTMLButtonElement): void;
  onSaveArtifact: ControlPlane["saveArtifact"];
}) {
  const { task, workSessionReportId } = message;
  const report = workSessionReportId !== undefined;
  const input = report ? undefined : message.liveInput;
  const status = statusText(task.state, input?.state);
  const joined = input?.state === "accepted";
  const activityTask = joined ? input.taskId : task.taskId;
  const turn = turnView(joined ? [] : events, task.result);
  const working = RUNNING.has(task.state);
  return (
    <article className="exchange">
      {!report && (
        <Message from="user" className="user-turn">
          <span className="visually-hidden">You</span>
          <Bubble text={task.prompt ?? ""} className="prompt-text" />
        </Message>
      )}
      <Message from="assistant" className="tag-turn">
        <span className="visually-hidden">{task.tagId}</span>
        {turn.messages.map((text, index) => (
          // Messages are append-only, so their position is their identity.
          // biome-ignore lint/suspicious/noArrayIndexKey: see above.
          <Bubble key={index} text={text} markdown className="tag-message" />
        ))}
        {task.result && !joined && <Bubble text={task.result} markdown className="result-text" />}
        {!joined && task.artifacts && task.artifacts.length > 0 && (
          <ResultFiles artifacts={task.artifacts} onSave={onSaveArtifact} />
        )}
        {turn.status && (
          <div className="turn-status" role="status">
            {working ? <Shimmer as="span">{turn.status}</Shimmer> : turn.status}
          </div>
        )}
        <div className="turn-meta">
          {report && <span className="report-label">Work Session report</span>}
          <Button
            variant="ghost"
            className="task-status"
            data-state={task.state}
            aria-label={`${status} · View Task activity`}
            aria-expanded={activeTask === activityTask}
            aria-controls={activeTask ? "activity" : undefined}
            onClick={(event) => onActivity(activityTask, event.currentTarget)}
          >
            <span className="status-dot" aria-hidden />
            {status}
          </Button>
        </div>
      </Message>
    </article>
  );
}

/** One message bubble, with a copy action beside it on hover. */
function Bubble({
  text,
  markdown,
  className,
}: {
  text: string;
  /** The Tag writes markdown; the operator's text shows as typed. */
  markdown?: boolean;
  className: string;
}) {
  return (
    <div className="bubble-row">
      <MessageContent className={`bubble ${className}`}>
        {markdown ? <MessageResponse className="markdown">{text}</MessageResponse> : text}
      </MessageContent>
      <CopyText text={text} />
    </div>
  );
}

function CopyText({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1_500);
    return () => window.clearTimeout(timer);
  }, [copied]);
  return (
    <div className="bubble-actions">
      <Button
        variant="ghost"
        size="icon"
        className="icon-button"
        aria-label={copied ? "Copied" : "Copy message"}
        title={copied ? "Copied" : "Copy message"}
        onClick={() =>
          navigator.clipboard.writeText(text).then(
            () => setCopied(true),
            () => {},
          )
        }
      >
        {copied ? <Check size={14} aria-hidden /> : <Copy size={14} aria-hidden />}
      </Button>
    </div>
  );
}
