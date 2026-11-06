import { parseArgs } from "node:util";
import { ControlPlaneClient, type ControlPlaneTarget } from "./control-plane-client.js";
import { takeOutputFlag } from "./output-flag.js";
import { terminalLines, terminalText } from "./terminal-text.js";

/** One message in a CLI conversation, as `POST /api/v1/tags/NAME/messages` returns it. */
export interface TagMessageRecord {
  readonly kind: "TagMessage";
  readonly tag: string;
  readonly session: string;
  readonly sessionId: string;
  readonly taskId: string;
  readonly status: "waiting" | "replied";
  readonly reply?: { readonly presentation: string; readonly text: string };
}

/** How long `message tag` waits for the reply. Fixed, not configurable. */
const REPLY_TIMEOUT_MS = 10 * 60_000;
const POLL_INTERVAL_MS = 1000;

export function tagConversationHelp(): string {
  return `Usage:
  supertag message tag NAME TEXT|- [--session NAME] [--output text|json]

Sends TEXT (or standard input for -) to the Tag as you and waits for its reply.
--session names the conversation; without it the conversation is default. The same name
continues the same Session, so the Tag sees the earlier messages and replies.
The conversation is private to you: the admin token and each Operator Token have their own.
The Tag answers with its Roles' permissions only; no location's Permission or Context Sets apply.
--output json prints the message record with the reply.
`;
}

export async function runTagConversationCommand(
  target: ControlPlaneTarget,
  args: readonly string[],
  options: { readonly timeoutMs?: number; readonly intervalMs?: number } = {},
): Promise<string> {
  const output = takeOutputFlag(args);
  const { values, positionals } = parseArgs({
    args: output.args,
    allowPositionals: true,
    options: { session: { type: "string" } },
    strict: true,
  });
  const [name, message, ...rest] = positionals;
  if (name === undefined || message === undefined || rest.length > 0)
    throw new Error(tagConversationHelp());
  const text = message === "-" ? await readStdin() : message;
  if (!text.trim()) throw new Error("The message is empty");
  const client = new ControlPlaneClient(target);
  const tagPath = `/api/v1/tags/${encodeURIComponent(name)}/messages`;
  let record = await client.request<TagMessageRecord>(tagPath, {
    method: "POST",
    body: JSON.stringify({
      text,
      ...(values.session === undefined ? {} : { session: values.session }),
    }),
  });
  const deadline = Date.now() + (options.timeoutMs ?? REPLY_TIMEOUT_MS);
  while (record.status !== "replied") {
    if (Date.now() >= deadline)
      throw new Error(
        `Tag ${name} has not replied yet; it keeps working on task/${record.taskId}. Check it with: supertag describe task ${record.taskId}. The reply stays in the ${record.session} conversation, so your next message there sees it.`,
      );
    await new Promise((resolve) => setTimeout(resolve, options.intervalMs ?? POLL_INTERVAL_MS));
    record = await client.request<TagMessageRecord>(
      `${tagPath}/${encodeURIComponent(record.taskId)}`,
    );
  }
  if (output.json) return `${JSON.stringify(record, null, 2)}\n`;
  const reply = record.reply?.text ?? "";
  if (record.reply?.presentation === "error")
    throw new Error(`Tag ${terminalText(name)} could not answer: ${reply}`);
  return `${terminalLines(reply.trimEnd())}\n`;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}
