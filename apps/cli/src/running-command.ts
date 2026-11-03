import { elapsedText, plainCommandText } from "@supertag/core";

/** Most command characters `describe task` and `supertag status` print. */
export const RUNNING_COMMAND_DISPLAY_CHARACTERS = 80;

/**
 * `running \`pnpm test:verify\` for 24m` for a recorded running command, or undefined when the
 * value is not one. The command is AI-authored, so it is cleaned again before printing.
 */
export function runningCommandText(value: unknown, now: number): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record["command"] !== "string" || typeof record["startedAt"] !== "string")
    return undefined;
  const command = plainCommandText(record["command"], RUNNING_COMMAND_DISPLAY_CHARACTERS);
  const startedAt = Date.parse(record["startedAt"]);
  if (!command || Number.isNaN(startedAt)) return undefined;
  return `running \`${command}\` for ${elapsedText(now - startedAt)}`;
}
