import { create, toJsonString } from "@bufbuild/protobuf";
import {
  CancelTaskResponseSchema,
  InspectTaskExecutionResponseSchema,
  ListTaskEventsResponseSchema,
  type TaskEvent,
  TaskSchema,
} from "@supertag/operator-api";
import { TASK_STATUS } from "./objective-protos.js";
import { type OperatorClientOptions, refusedAsError, workClient } from "./operator-client.js";
import { takeOutputFlag } from "./output-flag.js";

export type TaskCommand = "cancel" | "events" | "execution" | "get";

export function isTaskCommand(value: string | undefined): value is TaskCommand {
  return value === "cancel" || value === "events" || value === "execution" || value === "get";
}

export async function runTaskCommand(
  client: { readonly operator: OperatorClientOptions },
  command: TaskCommand,
  args: readonly string[],
): Promise<string> {
  if (args.includes("--help")) return taskHelp();
  const work = () => workClient(client.operator);
  if (command === "cancel") {
    const output = takeOutputFlag(args);
    args = output.args;
    const id = args[0]?.trim();
    if (args.length !== 1 || !id) throw new Error("Usage: supertag cancel task ID [--output json]");
    const result = await refusedAsError(() => work().cancelTask({ id }));
    if (output.json)
      return `${toJsonString(CancelTaskResponseSchema, result, { prettySpaces: 2 })}\n`;
    const phase = TASK_STATUS.word(result.status);
    return phase === undefined || phase === "cancelled"
      ? `task/${id} cancelled.\n`
      : result.accepted
        ? `task/${id} cancellation requested; it is ${phase} until its Worker stops.\n`
        : `task/${id} is already ${phase}; nothing to cancel.\n`;
  }
  const id = args[0];
  if (args.length !== 1 || id === undefined || id.trim() === "") {
    throw new Error(`Usage: supertag ${command} task ID`);
  }
  if (command === "events") {
    const events = await refusedAsError(() => allTaskEvents(work(), id));
    return `${toJsonString(ListTaskEventsResponseSchema, create(ListTaskEventsResponseSchema, { events }), { prettySpaces: 2 })}\n`;
  }
  if (command === "execution")
    return `${toJsonString(
      InspectTaskExecutionResponseSchema,
      await refusedAsError(() => work().inspectTaskExecution({ taskId: id })),
      { prettySpaces: 2 },
    )}\n`;
  return `${toJsonString(TaskSchema, await refusedAsError(() => work().getTask({ id })), { prettySpaces: 2 })}\n`;
}

/** Every recorded event of a Task, in sequence order, one page after another. */
export async function allTaskEvents(
  work: ReturnType<typeof workClient>,
  taskId: string,
): Promise<TaskEvent[]> {
  const events: TaskEvent[] = [];
  let pageToken = "";
  do {
    const page = await work.listTaskEvents({ taskId, pageSize: 1_000, pageToken });
    events.push(...page.events);
    pageToken = page.nextPageToken;
  } while (pageToken !== "");
  return events;
}

export function taskHelp(): string {
  return `Usage:
  supertag get task ID
  supertag describe task ID
  supertag events task ID
  supertag cancel task ID [--output json]

A Task is one turn of a Session. Tags start Tasks; operators read and cancel them.
cancel prints a one-line summary; add --output json for the full record.
`;
}
