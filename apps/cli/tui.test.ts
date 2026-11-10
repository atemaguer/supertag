import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { FileOperatorCredentialProvider } from "./src/control-plane-client.js";
import { opensTui, runTui, tuiBuildHint, tuiHandover } from "./src/tui.js";

const token = "st-test-token-on-fd-3";
const target = { name: "local", url: "http://127.0.0.1:4321", token };
const team = { name: "team", url: "https://cp.example.com", token: "st-test-team-token" };
const version = "1.2.3";
let directory: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "supertag-tui-"));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
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

interface Received {
  fd3: string;
  argv: string[];
  env: Record<string, string>;
}

it("hands the target to the binary on fd 3, never in argv or the environment", async () => {
  const { binary, out } = stubBinary(7);
  const resolveContexts = vi.fn(async () => [team]);
  const code = await runTui({
    resolveContexts,
    override: "local",
    env: { ...process.env, SUPERTAG_TUI_BINARY: binary, SUPERTAG_OPERATOR_TOKEN: token },
    version,
    resolveTarget: async (override) => {
      expect(override).toBe("local");
      return target;
    },
  });
  expect(code).toBe(7);
  const received = JSON.parse(readFileSync(out, "utf8")) as Received;
  expect(received.fd3.endsWith("\n")).toBe(true);
  expect(received.fd3.trim().split("\n")).toHaveLength(1);
  // A token from the environment is for the Control Plane it selects only.
  expect(resolveContexts).not.toHaveBeenCalled();
  expect(JSON.parse(received.fd3)).toEqual({ contexts: [target], current: 0 });
  expect(JSON.stringify(received.argv)).not.toContain(token);
  expect(JSON.stringify(received.env)).not.toContain(token);
});

it("hands every saved Control Plane to the binary on fd 3, marking the current one", async () => {
  const { binary, out } = stubBinary();
  const local = { url: "http://127.0.0.1:7468", token: "st-test-local" };
  const code = await runTui({
    env: { PATH: process.env["PATH"], SUPERTAG_TUI_BINARY: binary },
    version,
    resolveTarget: async () => team,
    resolveContexts: async () => [local, target, team],
  });
  expect(code).toBe(0);
  const received = JSON.parse(readFileSync(out, "utf8")) as Received;
  expect(JSON.parse(received.fd3)).toEqual({ contexts: [local, target, team], current: 2 });
  for (const secret of [token, team.token, local.token]) {
    expect(JSON.stringify(received.argv)).not.toContain(secret);
    expect(JSON.stringify(received.env)).not.toContain(secret);
  }
});

it("gives local goals the registered checkout's Workspace", async () => {
  vi.stubEnv("SUPERTAG_STATE_DIR", directory);
  const { binary, out } = stubBinary();
  const root = realpathSync(
    execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim(),
  );
  const local = { url: "http://127.0.0.1:4321", token };
  writeFileSync(
    join(directory, "supertag.yaml"),
    `services:
  control-plane: { type: control-plane, ports: ["4321"] }
  laptop:
    type: host
    harnesses: [codex]
    workspaces:
      registered-checkout: ${JSON.stringify(root)}
`,
  );
  expect(
    await runTui({
      env: { PATH: process.env["PATH"], SUPERTAG_TUI_BINARY: binary },
      version,
      resolveTarget: async () => local,
      resolveContexts: async () => [local, team],
    }),
  ).toBe(0);
  const received = JSON.parse(readFileSync(out, "utf8")) as Received;
  expect(JSON.parse(received.fd3)).toEqual({
    contexts: [{ ...local, workspace: "registered-checkout" }, team],
    current: 0,
  });
});

it("hands over each saved connection whose credential it can read", async () => {
  vi.stubEnv("SUPERTAG_STATE_DIR", directory);
  vi.stubEnv("SUPERTAG_OPERATOR_TOKEN", "");
  vi.stubEnv("SUPERTAG_ADMIN_TOKEN", "");
  vi.stubEnv("SUPERTAG_CONTROL_PLANE", "");
  await new FileOperatorCredentialProvider(join(directory, "credentials.json")).store(
    "control-plane/team",
    { token: team.token },
  );
  writeFileSync(
    join(directory, "control-planes.json"),
    JSON.stringify({
      version: 1,
      activeConnection: "team",
      controlPlanes: { team: { url: team.url }, gone: { url: "https://gone.example.com" } },
      credentials: {
        team: { provider: "file", credentialId: "control-plane/team" },
        gone: { provider: "file", credentialId: "control-plane/gone" },
      },
      connections: {
        team: { controlPlane: "team", credential: "team" },
        gone: { controlPlane: "gone", credential: "gone" },
      },
    }),
  );
  const { binary, out } = stubBinary();
  const code = await runTui({
    env: { PATH: process.env["PATH"], SUPERTAG_TUI_BINARY: binary },
    version,
    resolveTarget: async () => target,
  });
  expect(code).toBe(0);
  const received = JSON.parse(readFileSync(out, "utf8")) as Received;
  expect(JSON.parse(received.fd3)).toEqual({ contexts: [target, team], current: 0 });
});

it("lists the selected Control Plane once, first when it is not saved", () => {
  const url = { url: "https://other.example.com", token: "st-test-url" };
  expect(tuiHandover(url, [target, team])).toEqual({ contexts: [url, target, team], current: 0 });
  expect(tuiHandover(target, [team, target, team])).toEqual({
    contexts: [team, target],
    current: 1,
  });
  expect(tuiHandover(target, [])).toEqual({ contexts: [target], current: 0 });
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
    "The terminal UI is not installed. Reinstall SuperTag with the curl installer to get it: curl -fsSL https://unpkg.com/supertag-ai@latest/install.sh | sh\n",
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
