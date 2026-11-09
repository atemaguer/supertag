import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { opensTui, runTui, tuiBuildHint } from "./src/tui.js";

const token = "st-test-token-on-fd-3";
const target = { name: "local", url: "http://127.0.0.1:4321", token };
const version = "1.2.3";
let directory: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "supertag-tui-"));
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(directory, { recursive: true, force: true });
});

function stubBinary(exitCode = 0, reports = version): { binary: string; out: string } {
  const binary = join(directory, "stub-tui");
  const out = join(directory, "received.json");
  writeFileSync(
    binary,
    `#!${process.execPath}
const fs = require("node:fs");
if (process.argv[2] === "--version") {
  fs.writeFileSync(${JSON.stringify(join(directory, "version-env.json"))}, JSON.stringify(process.env));
  console.log(${JSON.stringify(reports)});
  process.exit(0);
}
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
    version,
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

it("keeps credential variables out of the version check's environment", async () => {
  vi.spyOn(process.stderr, "write").mockReturnValue(true);
  const { binary } = stubBinary(0, "1.2.2");
  const code = await runTui({
    env: {
      SUPERTAG_TUI_BINARY: binary,
      SUPERTAG_OPERATOR_TOKEN: token,
      SUPERTAG_ADMIN_TOKEN: token,
      SUPERTAG_TUI_STUB_MARKER: "injected",
    },
    resolveTarget: async () => target,
    version,
  });
  expect(code).toBe(1);
  const env = JSON.parse(readFileSync(join(directory, "version-env.json"), "utf8")) as Record<
    string,
    string
  >;
  expect(env["SUPERTAG_TUI_STUB_MARKER"]).toBe("injected");
  expect(JSON.stringify(env)).not.toContain(token);
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
    version,
  });
  expect(code).toBe(1);
  expect(String(write.mock.calls[0]?.[0])).toContain("Run supertag init");
  expect(() => readFileSync(out)).toThrow();
});

it("refuses a binary from another release, before resolving a Control Plane", async () => {
  const write = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  const resolveTarget = vi.fn(async () => target);
  const { binary, out } = stubBinary(0, "1.2.2");
  const code = await runTui({ env: { SUPERTAG_TUI_BINARY: binary }, resolveTarget, version });
  expect(code).toBe(1);
  expect(resolveTarget).not.toHaveBeenCalled();
  expect(String(write.mock.calls[0]?.[0])).toBe(
    `The terminal UI at ${binary} is 1.2.2 but this CLI is 1.2.3, and they must match. Point SUPERTAG_TUI_BINARY at a 1.2.3 build, or unset it.\n`,
  );
  expect(() => readFileSync(out)).toThrow();
});

it("says how to get the terminal UI when no binary is found", () => {
  expect(tuiBuildHint(true)).toBe(
    "The terminal UI is not built in this checkout. Build it with: cd apps/tui && ./build.sh\n",
  );
  expect(tuiBuildHint(false)).toBe(
    "The terminal UI is not installed. Reinstall SuperTag with the curl installer to get it: curl -fsSL https://github.com/atemaguer/supertag/releases/latest/download/install.sh | sh\n",
  );
});

it("opens only for plain supertag in an interactive terminal", () => {
  expect(opensTui([], true, true)).toBe(true);
  expect(opensTui([], true, false)).toBe(false);
  expect(opensTui([], false, true)).toBe(false);
  expect(opensTui([], undefined, undefined)).toBe(false);
  expect(opensTui(["--help"], true, true)).toBe(false);
  expect(opensTui(["list", "tag"], true, true)).toBe(false);
});
