import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";
import { main } from "./src/index.js";

const source = (name: string) =>
  readFileSync(fileURLToPath(new URL(`./src/${name}.ts`, import.meta.url)), "utf8");

function optionNames(block: string): string[] {
  return [...block.matchAll(/^\s*(?:"([\w-]+)"|([\w-]+)):\s*\{ type:/gm)].map(
    ([, quoted, plain]) => quoted ?? plain ?? "",
  );
}

it("lists every recover worklet parser flag in top-level help", async () => {
  const parser =
    source("worker")
      .split("export async function runWorkletRecoveryCommand")[1]
      ?.split("const worker =")[0] ?? "";
  const options = parser.split("options: {")[1]?.split("\n    },")[0] ?? "";
  const names = optionNames(options);
  expect(names.length).toBeGreaterThan(0);

  const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  try {
    expect(await main(["--help"])).toBe(0);
    const help = write.mock.calls.map(([chunk]) => String(chunk)).join("");
    const line = help
      .split("\n")
      .find((entry) => entry.trim().startsWith("supertag recover worklet "));
    expect(line).toBeDefined();
    for (const name of names) expect(line).toContain(`--${name}`);
  } finally {
    write.mockRestore();
  }
});
