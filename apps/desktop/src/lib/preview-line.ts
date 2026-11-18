/**
 * The first line of a message as plain text, for a one-line preview: a Tag writes Markdown, and
 * a preview shows what the message says, not its markup.
 */
export function previewLine(text: string): string {
  const line =
    text
      .split("\n")
      .map((candidate) => candidate.trim())
      .find((candidate) => candidate && !/^(```|~~~)/u.test(candidate)) ?? "";
  return (
    line
      // Images and links keep their text.
      .replace(/!?\[([^\]]*)\]\([^)]*\)/gu, "$1")
      // Headings, quotes, and list markers.
      .replace(/^(#{1,6}\s+|>\s*|[-*+]\s+(\[[ xX]\]\s+)?|\d+[.)]\s+)/u, "")
      // Emphasis and code spans.
      .replace(/(\*\*|__)(.+?)\1/gu, "$2")
      .replace(/(^|[^\w*])[*_]([^*_\s][^*_]*?)[*_](?=[^\w*]|$)/gu, "$1$2")
      .replace(/`+([^`]+)`+/gu, "$1")
      .trim()
  );
}
