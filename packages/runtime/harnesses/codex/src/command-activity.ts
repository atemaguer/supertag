/**
 * The status of a Codex shell command for a `command.updated` event. A started command is
 * running; a completed one failed when Codex says so, declined it, or it exited nonzero.
 * Handles both the exec JSON stream (`exit_code`) and the app-server protocol (`exitCode`).
 */
export function codexCommandStatus(
  eventType: "item.started" | "item.completed" | "item/started" | "item/completed",
  item: { readonly status?: unknown; readonly exit_code?: unknown; readonly exitCode?: unknown },
): "running" | "completed" | "failed" {
  if (eventType === "item.started" || eventType === "item/started") return "running";
  const exitCode = item.exit_code ?? item.exitCode;
  return item.status === "failed" ||
    item.status === "declined" ||
    (typeof exitCode === "number" && exitCode !== 0)
    ? "failed"
    : "completed";
}

/** The command line of an app-server command item, which may be a string or an argument list. */
export function codexCommandText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && value.every((part) => typeof part === "string"))
    return value.join(" ");
  return undefined;
}
