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

it.each([
  {
    command: "message objective",
    file: "objectives",
    parserStart: "export async function runObjectiveCommand",
    parserEnd: "const allowed =",
    allowedStart: ': command === "message"',
    allowedEnd: ': command === "approve"',
  },
  {
    command: "recover worklet",
    file: "worker",
    parserStart: "export async function runWorkletRecoveryCommand",
    parserEnd: "const worker =",
  },
])("lists every $command parser flag in top-level help", async (item) => {
  const code = source(item.file);
  const parser = code.split(item.parserStart)[1]?.split(item.parserEnd)[0] ?? "";
  const options = parser.split("options: {")[1]?.split("\n    },")[0] ?? "";
  const names = optionNames(options);
  expect(names.length).toBeGreaterThan(0);
  const accepted = item.allowedStart
    ? names.filter((name) => {
        const allowed = code.split(item.allowedStart ?? "")[1]?.split(item.allowedEnd ?? "")[0];
        return allowed?.includes(`"${name}"`);
      })
    : names;
  expect(accepted.length).toBeGreaterThan(0);

  const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  try {
    expect(await main(["--help"])).toBe(0);
    const help = write.mock.calls.map(([chunk]) => String(chunk)).join("");
    const line = help
      .split("\n")
      .find((entry) => entry.trim().startsWith(`supertag ${item.command} `));
    expect(line).toBeDefined();
    for (const name of accepted) expect(line).toContain(`--${name}`);
  } finally {
    write.mockRestore();
  }
});
