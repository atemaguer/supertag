import { parseArgs } from "node:util";
import { toJsonString } from "@bufbuild/protobuf";
import { CancelObjectiveResponseSchema } from "@supertag/operator-api";
import type { objectiveClient } from "./operator-client.js";

export function objectiveCancelUsage(): string {
  return "Usage: supertag cancel objective ID [--reason TEXT] [--output text|json]";
}

/**
 * `supertag cancel objective ID [--reason TEXT]`. Cancellation is terminal and idempotent, so it
 * takes no revision: cancelling a cancelled Objective succeeds without changing it.
 */
export async function runObjectiveCancel(
  client: Pick<ReturnType<typeof objectiveClient>, "cancelObjective">,
  args: readonly string[],
): Promise<string> {
  let parsed: ReturnType<typeof parse>;
  try {
    parsed = parse(args);
  } catch {
    throw new Error(objectiveCancelUsage());
  }
  const [id] = parsed.positionals;
  if (parsed.positionals.length !== 1 || id === undefined || !id.trim())
    throw new Error(objectiveCancelUsage());
  const output = parsed.values.output ?? "text";
  if (output !== "text" && output !== "json") throw new Error("--output must be text or json");
  const result = await client.cancelObjective({ id, reason: parsed.values.reason ?? "" });
  if (output === "json")
    return `${toJsonString(CancelObjectiveResponseSchema, result, { prettySpaces: 2 })}\n`;
  const cancelled = result.cancelledTaskIds.length;
  const tasks =
    cancelled === 0
      ? ""
      : `; ${cancelled} open Task${cancelled === 1 ? " was" : "s were"} cancelled`;
  return result.changed
    ? `objective/${id} cancelled${tasks}.\n`
    : `objective/${id} was already cancelled${tasks}.\n`;
}

function parse(args: readonly string[]) {
  return parseArgs({
    args: [...args],
    allowPositionals: true,
    strict: true,
    options: { reason: { type: "string" }, output: { type: "string" } },
  });
}
