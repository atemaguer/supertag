/** The most an activity line shows before it is cut short. */
const MAX_ACTIVITY = 160;

type ToolUse = { readonly name: string; readonly input: unknown };

/**
 * One line saying what a Claude tool call is about to do, such as `Running pnpm test`. It is
 * built from the call's input only, never from its output. `redact` hides secrets before the
 * line is cut to length, so a cut never leaves part of a secret that redaction cannot match.
 */
export function claudeToolActivity(
  tool: ToolUse,
  redact: (text: string) => string = (text) => text,
): string {
  const oneLine = (text: string) => shorten(redact(text));
  const input = (tool.input && typeof tool.input === "object" ? tool.input : {}) as Record<
    string,
    unknown
  >;
  const field = (...names: string[]) => {
    for (const name of names) {
      const value = input[name];
      if (typeof value === "string" && value.trim()) return value;
    }
    return undefined;
  };
  const target = (verb: string, ...names: string[]) => {
    const value = field(...names);
    return value ? `${verb} ${value}` : verb;
  };
  switch (tool.name) {
    case "Bash":
      return oneLine(target("Running", "command"));
    case "Read":
      return oneLine(target("Reading", "file_path"));
    case "Edit":
    case "MultiEdit":
    case "Write":
    case "NotebookEdit":
      return oneLine(target("Editing", "file_path", "notebook_path"));
    case "Grep":
    case "Glob":
      return oneLine(target("Searching for", "pattern"));
    case "WebFetch":
      return oneLine(target("Fetching", "url"));
    case "WebSearch":
      return oneLine(target("Searching the web for", "query"));
    case "TodoWrite":
      return "Updating its plan";
    case "Skill":
      return oneLine(target("Using the skill", "skill", "name"));
  }
  const mcp = /^mcp__(.+?)__(.+)$/u.exec(tool.name);
  if (mcp) return oneLine(`Using ${mcp[1]} ${mcp[2]}`);
  return oneLine(`Using ${tool.name}`);
}

/** The first non-blank line of `text`, cut to an activity line's length. */
export function shorten(text: string): string {
  const lines = text.split(/\r?\n/u).filter((line) => line.trim());
  const line = (lines[0] ?? "").trim();
  const chars = [...line];
  if (chars.length <= MAX_ACTIVITY && lines.length <= 1) return line;
  return `${chars.slice(0, MAX_ACTIVITY - 1).join("")}…`;
}

/**
 * The text a partial-message event adds to the message Claude is writing. Text blocks are joined
 * with a newline, as the completed message's are.
 */
export function streamedText(event: { type: string }, streamed: { blocks: number }) {
  const part = event as {
    type: string;
    delta?: { type?: string; text?: string };
    content_block?: { type?: string };
  };
  if (part.type === "message_start") streamed.blocks = 0;
  if (part.type === "content_block_start" && part.content_block?.type === "text")
    return streamed.blocks++ > 0 ? "\n" : undefined;
  if (part.type === "content_block_delta" && part.delta?.type === "text_delta")
    return part.delta.text || undefined;
  return undefined;
}
