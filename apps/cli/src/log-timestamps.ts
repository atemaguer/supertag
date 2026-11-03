/**
 * Prefixes each line a background or service-unit process writes to its log file with an
 * ISO 8601 time, so `supertag logs` shows when each event happened. JSON lines, such as audit
 * records, already carry their own `at` field and stay valid JSON.
 */
export function timestampLines(
  stream: Pick<NodeJS.WriteStream, "write">,
  now: () => Date = () => new Date(),
): void {
  const original = stream.write.bind(stream) as (...args: unknown[]) => boolean;
  let lineStart = true;
  stream.write = ((chunk: unknown, ...rest: unknown[]) => {
    const text =
      typeof chunk === "string"
        ? chunk
        : chunk instanceof Uint8Array
          ? Buffer.from(chunk).toString("utf8")
          : "";
    if (!text) return original(chunk, ...rest);
    let output = "";
    for (const piece of text.split(/(?<=\n)/)) {
      if (lineStart && piece !== "\n" && !piece.startsWith("{"))
        output += `${now().toISOString()} `;
      output += piece;
      lineStart = piece.endsWith("\n");
    }
    return original(output, ...rest);
  }) as NodeJS.WriteStream["write"];
}
