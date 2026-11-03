/**
 * One human-readable field or assembled display line. Call before joining lines or padding
 * table cells, so only the renderer can introduce line breaks. JSON keeps the original values.
 */
export function terminalText(value: string): string {
  // Keep escape payloads visible: dropping an OSC sequence can hide evidence.
  // Two combining marks cover ordinary accents without allowing unbounded stacking.
  return value
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\u115f\u1160\u2800\u3164\uffa0]/gu, " ")
    .replace(/(\p{M}{2})\p{M}+/gu, "$1 ");
}

/** Preserve renderer-owned JSON indentation while filtering values for a terminal. */
export function terminalJson(value: unknown, human: boolean): string {
  const json = JSON.stringify(value, null, 2);
  return `${human ? json.split("\n").map(terminalText).join("\n") : json}\n`;
}
