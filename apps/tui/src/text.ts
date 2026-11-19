/**
 * Text from a Gateway, a Tag, or a file shows as text: an escape sequence in it must never reach
 * the terminal as one. ESC shows as `^[`; other control characters but tab and newline go.
 */
export function safe(text: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: filtering them is the point.
  return text.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/gu, (c) =>
    c === "\u001b" ? "^[" : "",
  );
}

/** One line of `text`, at most `width` characters, with an ellipsis when cut. */
export function clip(text: string, width: number): string {
  const line = safe(text).replace(/\s+/gu, " ").trim();
  const characters = [...line];
  if (width <= 0) return "";
  if (characters.length <= width) return line;
  return `${characters.slice(0, Math.max(0, width - 1)).join("")}…`;
}

/** A short time for a list row: `14:05` today, `Yday`, the weekday this week, else `Mar 4`. */
export function shortTime(at: number, now = Date.now()): string {
  const then = new Date(at);
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const day = 86_400_000;
  if (at >= today.getTime()) {
    return `${String(then.getHours()).padStart(2, "0")}:${String(then.getMinutes()).padStart(2, "0")}`;
  }
  if (at >= today.getTime() - day) return "Yday";
  if (at >= today.getTime() - 6 * day)
    return then.toLocaleDateString("en-US", { weekday: "short" });
  return then.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/** The initials a folded rail shows for a Tag: its first two letters or digits. */
export function initials(name: string): string {
  const letters = [...name].filter((c) => /[\p{L}\p{N}]/u.test(c));
  return letters.slice(0, 2).join("").toUpperCase() || "?";
}
