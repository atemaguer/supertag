import type { Gateway, Message } from "../gateway";
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

export function ConversationEntry({
  message,
  activeTask,
  onActivity,
  onSaveArtifact,
}: {
  message: Message;
  activeTask?: string;
  onActivity(taskId: string, trigger: HTMLButtonElement): void;
  onSaveArtifact: Gateway["saveArtifact"];
}) {
  const { task, workSessionReportId } = message;
  const report = workSessionReportId !== undefined;
  const input = report ? undefined : message.liveInput;
  const status = statusText(task.state, input?.state);
  const joined = input?.state === "accepted";
  const activityTask = joined ? input.taskId : task.taskId;
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
          {task.result && !joined && <p className="result-text">{task.result}</p>}
          {!joined && task.artifacts && task.artifacts.length > 0 && (
            <ResultFiles artifacts={task.artifacts} onSave={onSaveArtifact} />
          )}
        </div>
      </div>
    </article>
  );
}
