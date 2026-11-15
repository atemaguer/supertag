import { Readable } from "node:stream";
import { expect, it, vi } from "vitest";
import { observeClaudeOutput } from "./src/query.js";

it("scans fragmented multi-megabyte output only once and forwards every byte", async () => {
  const message = { type: "assistant", text: `${"x".repeat(2 * 1024 * 1024)}🙂` };
  const bytes = Buffer.from(
    `${JSON.stringify(message)}\nnot-json\n${JSON.stringify({ type: "result" })}`,
  );
  const chunks = Array.from({ length: Math.ceil(bytes.length / 1024) }, (_, index) =>
    bytes.subarray(index * 1024, (index + 1) * 1024),
  );
  const observed: unknown[] = [];
  const forwarded: (Buffer | string)[] = [];
  let scanned = 0;
  const indexOf = String.prototype.indexOf;
  const spy = vi.spyOn(String.prototype, "indexOf").mockImplementation(function (
    this: string,
    search,
    start = 0,
  ) {
    const end = indexOf.call(this, search, start);
    if (search === "\n") scanned += (end < 0 ? this.length : end + 1) - start;
    return end;
  });
  try {
    for await (const chunk of observeClaudeOutput(Readable.from(chunks), (value) =>
      observed.push(value),
    ))
      forwarded.push(chunk);
  } finally {
    spy.mockRestore();
  }
  expect(Buffer.concat(forwarded.map((chunk) => Buffer.from(chunk)))).toEqual(bytes);
  expect(observed).toEqual([message, { type: "result" }]);
  expect(scanned).toBeLessThanOrEqual(bytes.length + 1);
  // Spying on every indexOf call in the process makes this slow on loaded machines.
}, 30_000);
