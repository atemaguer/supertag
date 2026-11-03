import { parseArgs } from "node:util";
import type { ControlPlaneClient } from "./control-plane-client.js";

export function objectivePauseUsage(command: "pause" | "resume"): string {
  return `Usage: supertag ${command} objective ID [--output text|json]`;
}

/**
 * `supertag pause objective ID` and `supertag resume objective ID`. Both are idempotent, so they
 * take no revision: pausing a paused Objective, or resuming a running one, changes nothing.
 */
export async function runObjectivePause(
  client: Pick<ControlPlaneClient, "request">,
  command: "pause" | "resume",
  args: readonly string[],
): Promise<string> {
  let parsed: ReturnType<typeof parse>;
  try {
    parsed = parse(args);
  } catch {
    throw new Error(objectivePauseUsage(command));
  }
  const [id] = parsed.positionals;
  if (parsed.positionals.length !== 1 || id === undefined || !id.trim())
    throw new Error(objectivePauseUsage(command));
  const output = parsed.values.output ?? "text";
  if (output !== "text" && output !== "json") throw new Error("--output must be text or json");
  const result = await client.request<{ readonly status?: { readonly changed?: boolean } }>(
    `/api/v1/objectives/${encodeURIComponent(id)}/${command}`,
    { method: "POST", body: "{}" },
  );
  if (output === "json") return `${JSON.stringify(result, null, 2)}\n`;
  if (command === "pause")
    return result.status?.changed === false
      ? `objective/${id} was already paused.\n`
      : `objective/${id} paused; running Task Attempts finish, and no new work starts until: supertag resume objective ${id}\n`;
  return result.status?.changed === false
    ? `objective/${id} was not paused.\n`
    : `objective/${id} resumed; the owner received a summary of what changed while it was paused.\n`;
}

function parse(args: readonly string[]) {
  return parseArgs({
    args: [...args],
    allowPositionals: true,
    strict: true,
    options: { output: { type: "string" } },
  });
}
