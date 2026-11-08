import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { opensTui, runTui } from "./src/tui.js";

const token = "st-test-token-on-fd-3";
const target = { name: "local", url: "http://127.0.0.1:4321", token };
let directory: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "supertag-tui-"));
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(directory, { recursive: true, force: true });
});

function stubBinary(exitCode = 0): { binary: string; out: string } {
  const binary = join(directory, "stub-tui");
  const out = join(directory, "received.json");
  writeFileSync(
    binary,
    `#!${process.execPath}
const fs = require("node:fs");
const chunks = [];
const handoff = fs.createReadStream(null, { fd: 3 });
handoff.on("data", (chunk) => chunks.push(chunk));
handoff.on("end", () => {
  fs.writeFileSync(${JSON.stringify(out)}, JSON.stringify({
    fd3: Buffer.concat(chunks).toString("utf8"),
    argv: process.argv,
    env: process.env,
  }));
  process.exit(${exitCode});
});
`,
  );
  chmodSync(binary, 0o755);
  return { binary, out };
}

it("hands the target to the binary on fd 3, never in argv or the environment", async () => {
  const { binary, out } = stubBinary(7);
  const code = await runTui({
    override: "local",
    env: { ...process.env, SUPERTAG_TUI_BINARY: binary, SUPERTAG_OPERATOR_TOKEN: token },
    resolveTarget: async (override) => {
      expect(override).toBe("local");
      return target;
    },
  });
  expect(code).toBe(7);
  const received = JSON.parse(readFileSync(out, "utf8")) as {
    fd3: string;
    argv: string[];
    env: Record<string, string>;
  };
  expect(received.fd3.endsWith("\n")).toBe(true);
  expect(received.fd3.trim().split("\n")).toHaveLength(1);
  expect(JSON.parse(received.fd3)).toEqual(target);
  expect(JSON.stringify(received.argv)).not.toContain(token);
  expect(JSON.stringify(received.env)).not.toContain(token);
});

it("reports a missing binary without resolving a Control Plane, so supertag shows help", async () => {
  const resolveTarget = vi.fn(async () => target);
  const code = await runTui({
    env: { SUPERTAG_TUI_BINARY: join(directory, "missing") },
    resolveTarget,
  });
  expect(code).toBeUndefined();
  expect(resolveTarget).not.toHaveBeenCalled();
});

it("says to run supertag init when no Control Plane is set up", async () => {
  const write = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  const { binary, out } = stubBinary();
  const code = await runTui({
    env: { SUPERTAG_TUI_BINARY: binary },
    resolveTarget: async () => undefined,
  });
  expect(code).toBe(1);
  expect(String(write.mock.calls[0]?.[0])).toContain("Run supertag init");
  expect(() => readFileSync(out)).toThrow();
});

it("opens only for plain supertag in an interactive terminal", () => {
  expect(opensTui([], true, true)).toBe(true);
  expect(opensTui([], true, false)).toBe(false);
  expect(opensTui([], false, true)).toBe(false);
  expect(opensTui([], undefined, undefined)).toBe(false);
  expect(opensTui(["--help"], true, true)).toBe(false);
  expect(opensTui(["list", "tag"], true, true)).toBe(false);
});
