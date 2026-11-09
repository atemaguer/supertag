import { parseArgs } from "node:util";
import { toJsonString } from "@bufbuild/protobuf";
import {
  PauseObjectiveResponseSchema,
  ResumeObjectiveResponseSchema,
} from "@supertag/operator-api";
import type { objectiveClient } from "./operator-client.js";

export function objectivePauseUsage(command: "pause" | "resume"): string {
  return `Usage: supertag ${command} objective ID [--output text|json]`;
}

/**
 * `supertag pause objective ID` and `supertag resume objective ID`. Both are idempotent, so they
 * take no revision: pausing a paused Objective, or resuming a running one, changes nothing.
 */
export async function runObjectivePause(
  client: Pick<ReturnType<typeof objectiveClient>, "pauseObjective" | "resumeObjective">,
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
  if (command === "pause") {
    const result = await client.pauseObjective({ id });
    if (output === "json")
      return `${toJsonString(PauseObjectiveResponseSchema, result, { prettySpaces: 2 })}\n`;
    return result.changed
      ? `objective/${id} paused; running Task Attempts finish, and no new work starts until: supertag resume objective ${id}\n`
      : `objective/${id} was already paused.\n`;
  }
  const result = await client.resumeObjective({ id });
  if (output === "json")
    return `${toJsonString(ResumeObjectiveResponseSchema, result, { prettySpaces: 2 })}\n`;
  return result.changed
    ? `objective/${id} resumed; the owner received a summary of what changed while it was paused.\n`
    : `objective/${id} was not paused.\n`;
}

function parse(args: readonly string[]) {
  return parseArgs({
    args: [...args],
    allowPositionals: true,
    strict: true,
    options: { output: { type: "string" } },
  });
}
