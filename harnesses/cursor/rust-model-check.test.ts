import { expect, it, vi } from "vitest";
import { writeModelCheck } from "./src/rust-adapter/model-check.js";

it("writes one JSON result for the Rust model check, passing only CURSOR_API_KEY", async () => {
  const lines: string[] = [];
  const check = vi.fn(async () => ({ status: "ok" as const, availableIds: ["auto"] }));
  await writeModelCheck(
    ["auto"],
    { CURSOR_API_KEY: " key ", OTHER: "x" },
    (line) => lines.push(line),
    check,
  );
  expect(check).toHaveBeenCalledWith(["auto"], { apiKey: "key" });
  expect(lines).toEqual([`${JSON.stringify({ status: "ok", availableIds: ["auto"] })}\n`]);
  await writeModelCheck([], {}, (line) => lines.push(line), check);
  expect(check).toHaveBeenLastCalledWith([], {});
});
