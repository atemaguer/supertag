/**
 * Most characters of a native command line a Worker reports. Status views cut it further with
 * {@link plainCommandText}.
 */
export const MAX_COMMAND_TEXT_CHARACTERS = 200;

/**
 * Renders untrusted, AI-authored command text as one plain line safe to print to a terminal.
 * Removes ANSI escape sequences, replaces every remaining control, format, and line or paragraph
 * separator character with a space, collapses whitespace, and cuts the result to `maximum`
 * characters ending in an ellipsis. Returns an empty string when nothing printable remains.
 */
export function plainCommandText(value: string, maximum = MAX_COMMAND_TEXT_CHARACTERS): string {
  const plain = value
    // biome-ignore lint/suspicious/noControlCharactersInRegex: Remove ANSI escapes from untrusted text.
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/gu, " ")
    // biome-ignore lint/suspicious/noControlCharactersInRegex: Remove OSC sequences, such as titles and links.
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/gu, " ")
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  const characters = [...plain];
  if (characters.length <= maximum) return plain;
  return `${characters
    .slice(0, Math.max(0, maximum - 1))
    .join("")
    .trimEnd()}…`;
}

/** Elapsed time for status views, such as `45s`, `24m`, or `2h 5m`. */
export function elapsedText(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}
