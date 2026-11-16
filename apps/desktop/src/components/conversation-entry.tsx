import type { ControlPlane, Message, TaskEvent } from "../control-plane";
import { turnView, useTurnEvents } from "../lib/turn";
import { ResultFiles } from "./result-files";
import { TagAvatar } from "./tag-avatar";
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

/** A conversation entry that reads its turn's messages and activity while it runs. */
export function LiveConversationEntry(
  props: Omit<Parameters<typeof ConversationEntry>[0], "events"> & {
    readEvents: ControlPlane["events"];
  },
) {
  const { task, workSessionReportId, liveInput } = props.message;
  const joined = workSessionReportId === undefined && liveInput?.state === "accepted";
  const events = useTurnEvents(
    props.readEvents,
    task.tagId,
    joined ? undefined : task.taskId,
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
  message: Message;
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
  return (
    <article className="exchange">
      {!report && (
        <div className="user-turn">
          <span className="visually-hidden">You</span>
          <p className="prompt-text">{task.prompt}</p>
        </div>
      )}
      <div className="tag-turn">
        <TagAvatar tagId={task.tagId} />
        <div className="reply-body">
          <div className="reply-heading">
            <strong>{task.tagId}</strong>
            {report && <span className="report-label">Work Session report</span>}
            <Button
              variant="outline"
              className="task-status"
              data-state={task.state}
              aria-label={`${status} · View Task activity`}
              aria-expanded={activeTask === activityTask}
              aria-controls={activeTask ? "activity" : undefined}
              onClick={(event) => onActivity(activityTask, event.currentTarget)}
            >
              {status}
            </Button>
          </div>
          {turn.messages.map((text, index) => (
            // Messages are append-only, so their position is their identity.
            // biome-ignore lint/suspicious/noArrayIndexKey: see above.
            <p key={index} className="result-text tag-message">
              {text}
            </p>
          ))}
          {turn.status && (
            <p className="turn-status" role="status">
              {turn.status}
            </p>
          )}
          {task.result && !joined && <p className="result-text">{task.result}</p>}
          {!joined && task.artifacts && task.artifacts.length > 0 && (
            <ResultFiles artifacts={task.artifacts} onSave={onSaveArtifact} />
          )}
        </div>
      </div>
    </article>
  );
}
