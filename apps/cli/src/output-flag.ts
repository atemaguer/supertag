/**
 * Removes `--output text|json` from a command's arguments. Commands that create or change
 * something print a one-line summary by default and the full record with `--output json`.
 */
export function takeOutputFlag(args: readonly string[]): {
  readonly json: boolean;
  readonly args: string[];
} {
  const rest: string[] = [];
  let output: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index] as string;
    if (argument === "--output") {
      output = args[index + 1];
      if (output === undefined) throw new Error("--output requires text or json");
      index += 1;
    } else if (argument.startsWith("--output=")) output = argument.slice("--output=".length);
    else rest.push(argument);
  }
  if (output !== undefined && output !== "text" && output !== "json")
    throw new Error("--output must be text or json");
  return { json: output === "json", args: rest };
}
