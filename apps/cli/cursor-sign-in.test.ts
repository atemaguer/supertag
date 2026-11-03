import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type CursorModelVerifier,
  type CursorProbeExec,
  checkCursorSignIn,
} from "./src/cursor-sign-in.js";

const directories: string[] = [];
const valid: CursorModelVerifier = vi.fn(async () => ({ status: "ok", models: ["auto"] }));

async function home(): Promise<string> {
  const directory = await mkdtemp(
    join(process.env["SUPERTAG_SCRATCH_DIR"] ?? tmpdir(), "cursor-signin-"),
  );
  directories.push(directory);
  return directory;
}

function fakeExec(responses: Record<string, string | Error>): {
  exec: CursorProbeExec;
  calls: string[];
} {
  const calls: string[] = [];
  const exec: CursorProbeExec = vi.fn(async (command, args, options) => {
    expect(options.timeout).toBeGreaterThan(0);
    expect(options.killSignal).toBe("SIGKILL");
    expect(options.env).not.toHaveProperty("CURSOR_API_KEY");
    const call = `${command} ${args.join(" ")}`;
    calls.push(call);
    const response = responses[call];
    if (response instanceof Error) throw response;
    if (response === undefined) throw Object.assign(new Error("missing"), { code: "ENOENT" });
    return { stdout: response };
  });
  return { exec, calls };
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
  vi.clearAllMocks();
});

describe("Cursor sign-in check", () => {
  it("verifies a key and does not start the CLI", async () => {
    const { exec } = fakeExec({});
    const verifyModels = vi.fn(valid);
    const checked = await checkCursorSignIn({
      environment: { CURSOR_API_KEY: "secret-token", HOME: await home() },
      verifyModels,
      exec,
    });
    expect(checked.status).toBe("signed-in");
    expect(checked.signedIn).toBe(true);
    expect(verifyModels).toHaveBeenCalledWith("secret-token");
    expect(exec).not.toHaveBeenCalled();
    expect(JSON.stringify(checked)).not.toContain("secret-token");
  });

  it.each([
    ["invalid-key", { status: "invalid-key" }, "invalid-key"],
    ["no-models", { status: "ok", models: [] }, "no-models"],
    ["verification error", { status: "error" }, "verification-failed"],
  ] as const)("reports %s distinctly", async (_name, verification, status) => {
    const checked = await checkCursorSignIn({
      environment: { CURSOR_API_KEY: "secret-token", HOME: await home() },
      verifyModels: async () => verification,
      exec: fakeExec({}).exec,
    });
    expect(checked.status).toBe(status);
    expect(checked.signedIn).toBe(false);
    expect(JSON.stringify(checked)).not.toContain("secret-token");
  });

  it("does not accept an SDK auth file without CURSOR_API_KEY", async () => {
    const directory = await home();
    await mkdir(join(directory, ".cursor", "sdk"), { recursive: true });
    await writeFile(join(directory, ".cursor", "sdk", "auth.json"), "secret-file-content");
    const verifyModels = vi.fn(valid);
    const checked = await checkCursorSignIn({
      environment: { HOME: directory },
      verifyModels,
      exec: fakeExec({}).exec,
    });
    expect(checked.status).toBe("missing-cli");
    expect(checked.signedIn).toBe(false);
    expect(verifyModels).not.toHaveBeenCalled();
    expect(JSON.stringify(checked)).not.toContain("secret-file-content");
  });

  it("treats a logged-in CLI as advice, not SDK sign-in", async () => {
    const { exec, calls } = fakeExec({
      "cursor-agent --version": "cursor-agent 1.0",
      "cursor-agent status --format json": JSON.stringify({ status: "ok", isAuthenticated: true }),
    });
    const checked = await checkCursorSignIn({
      environment: { HOME: await home() },
      verifyModels: valid,
      exec,
    });
    expect(checked).toMatchObject({ status: "cli-login-only", signedIn: false });
    expect(checked.message).toContain("CURSOR_API_KEY");
    expect(calls).toEqual(["cursor-agent --version", "cursor-agent status --format json"]);
  });

  it("parses logged-out JSON despite exit zero", async () => {
    const { exec } = fakeExec({
      "cursor-agent --version": "cursor-agent 1.0",
      "cursor-agent status --format json": JSON.stringify({
        status: "logged_out",
        isAuthenticated: false,
      }),
    });
    expect(
      (await checkCursorSignIn({ environment: { HOME: await home() }, verifyModels: valid, exec }))
        .status,
    ).toBe("logged-out");
  });

  it("reports missing binaries", async () => {
    const { exec, calls } = fakeExec({});
    const checked = await checkCursorSignIn({
      environment: { HOME: await home() },
      verifyModels: valid,
      exec,
    });
    expect(checked.status).toBe("missing-cli");
    expect(calls).not.toContain("agent status --format json");
  });

  it("rejects Grok's agent without asking it for status", async () => {
    const { exec, calls } = fakeExec({
      "agent about --format json": '{"name":"Grok CLI","message":"Cursor is elsewhere"}',
      "agent --version": "Grok CLI 1.0",
    });
    const checked = await checkCursorSignIn({
      environment: { HOME: await home() },
      verifyModels: valid,
      exec,
    });
    expect(checked.status).toBe("missing-cli");
    expect(calls).not.toContain("agent status --format json");
  });

  it("accepts a Cursor alias identified by --version", async () => {
    const { exec } = fakeExec({
      "agent --version": "Cursor Agent 2026.05.28",
      "agent status --format json": '{"isAuthenticated":false}',
    });
    const checked = await checkCursorSignIn({
      environment: { HOME: await home() },
      verifyModels: valid,
      exec,
    });
    expect(checked.status).toBe("logged-out");
  });

  it("accepts a Cursor agent alias after identity verification", async () => {
    const { exec, calls } = fakeExec({
      "agent about --format json": '{"name":"Cursor Agent"}',
      "agent status --format json": '{"status":"ok","isAuthenticated":true}',
    });
    const checked = await checkCursorSignIn({
      environment: { HOME: await home() },
      verifyModels: valid,
      exec,
    });
    expect(checked.status).toBe("cli-login-only");
    expect(calls).toContain("agent status --format json");
  });

  it("rejects malformed status JSON and redacts CLI output", async () => {
    const { exec } = fakeExec({
      "cursor-agent --version": "cursor-agent 1.0",
      "cursor-agent status --format json": "secret-token {not-json",
    });
    const checked = await checkCursorSignIn({
      environment: { HOME: await home() },
      verifyModels: valid,
      exec,
    });
    expect(checked.status).toBe("probe-failed");
    expect(JSON.stringify(checked)).not.toContain("secret-token");
  });

  it("redacts a verifier exception containing the key", async () => {
    const checked = await checkCursorSignIn({
      environment: { HOME: await home(), CURSOR_API_KEY: "secret-token" },
      verifyModels: async () => {
        throw new Error("secret-token rejected");
      },
      exec: fakeExec({}).exec,
    });
    expect(checked.status).toBe("verification-failed");
    expect(JSON.stringify(checked)).not.toContain("secret-token");
  });

  it("kills a hanging CLI probe on timeout", async () => {
    const directory = await home();
    const binary = join(directory, "cursor-agent");
    const pidFile = join(directory, "pid");
    await writeFile(
      binary,
      `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);\n`,
    );
    await chmod(binary, 0o755);
    const checked = await checkCursorSignIn({
      environment: { HOME: directory, PATH: `${directory}:${process.env["PATH"] ?? ""}` },
      verifyModels: valid,
      timeoutMs: 1_000,
    });
    expect(checked.status).toBe("probe-failed");
    const pid = Number(await readFile(pidFile, "utf8"));
    expect(() => process.kill(pid, 0)).toThrow();
  });
});
