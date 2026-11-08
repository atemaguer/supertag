import type { ControlPlaneClient } from "./control-plane-client.js";
import { takeOutputFlag } from "./output-flag.js";

export type TaskCommand = "cancel" | "events" | "execution" | "get";

export function isTaskCommand(value: string | undefined): value is TaskCommand {
  return value === "cancel" || value === "events" || value === "execution" || value === "get";
}

export async function runTaskCommand(
  client: Pick<ControlPlaneClient, "request">,
  command: TaskCommand,
  args: readonly string[],
): Promise<string> {
  if (args.includes("--help")) return taskHelp();
  if (command === "cancel") {
    const output = takeOutputFlag(args);
    args = output.args;
    const id = args[0]?.trim();
    if (args.length !== 1 || !id) throw new Error("Usage: supertag cancel task ID [--output json]");
    const result = await client.request<{
      readonly status?: { readonly accepted?: boolean; readonly phase?: string };
    }>(`/api/v1/tasks/${encodeURIComponent(id)}/cancel`, { method: "POST" });
    if (output.json) return `${JSON.stringify(result, null, 2)}\n`;
    const phase = result?.status?.phase;
    return phase === undefined || phase === "cancelled"
      ? `task/${id} cancelled.\n`
      : result?.status?.accepted
        ? `task/${id} cancellation requested; it is ${phase} until its Worker stops.\n`
        : `task/${id} is already ${phase}; nothing to cancel.\n`;
  }
  const rawId = args[0];
  if (args.length !== 1 || rawId === undefined || rawId.trim() === "") {
    throw new Error(`Usage: supertag ${command} task ID`);
  }
  const id = encodeURIComponent(rawId);
  const suffix = command === "events" ? "/events" : command === "execution" ? "/execution" : "";
  const result = await client.request(`/api/v1/tasks/${id}${suffix}`);
  return `${JSON.stringify(result, null, 2)}\n`;
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
