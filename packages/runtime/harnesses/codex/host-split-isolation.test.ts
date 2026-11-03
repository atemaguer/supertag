import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ExecutionContext,
  type ExecutionEnvironment,
  InMemorySessionStateStore,
} from "@supertag/worker-sdk";
import { expect, it, vi } from "vitest";
import { repositoryAttempt } from "../../../../tests/support/repository-execution.js";
import { CodexHarness } from "./src/index.js";

const mocks = vi.hoisted(() => ({ appServer: vi.fn(), execServer: vi.fn() }));
vi.mock("./src/app-server.js", () => ({ startCodexAppServer: mocks.appServer }));
vi.mock("./src/exec-server.js", () => ({ startCodexExecServerBridge: mocks.execServer }));

it("keeps Codex provider keys and selected auth files on the Worker Host", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-host-split-"));
  const sentinel = "CODEX-HOST-CREDENTIAL-NEVER-IN-SANDBOX";
  const prior = {
    OPENAI_API_KEY: process.env["OPENAI_API_KEY"],
    CODEX_API_KEY: process.env["CODEX_API_KEY"],
    CODEX_HOME: process.env["CODEX_HOME"],
  };
  process.env["OPENAI_API_KEY"] = sentinel;
  process.env["CODEX_API_KEY"] = sentinel;
  process.env["CODEX_HOME"] = join(directory, `host-${sentinel}`);
  try {
    const authFile = join(directory, "auth.json");
    await writeFile(authFile, JSON.stringify({ OPENAI_API_KEY: sentinel }));
    const original = repositoryAttempt("codex-host-split");
    const attempt = {
      ...original,
      input: {
        ...original.input,
        messages: [{ id: "question", role: "requester" as const, text: "Inspect this" }],
      },
    };
    const context: ExecutionContext = {
      attempt,
      profile: {
        ref: attempt.workerProfile,
        workerType: "supertag",
        harness: { provider: "codex" },
        runtime: { provider: "local-runtime", lifetime: { scope: "attempt" } },
        execution: { provider: "remote-execution", lifetime: { scope: "attempt" } },
      },
      context: { instructions: [], skills: [], history: [], resources: [] },
      tools: [],
      secrets: [],
      sessionStates: [],
      extensions: [],
      sessionStateStore: new InMemorySessionStateStore(),
    };
    const hostPlans: unknown[] = [];
    const sandboxUse: unknown[] = [];
    const host = {
      id: "host-runtime",
      placement: "local",
      rootDirectory: directory,
      resolvePath: (path: string) => join(directory, "host", path),
      prepare: async (plan: unknown) => {
        hostPlans.push(plan);
      },
      read: async () => "",
      spawn: async () => {
        throw new Error("app-server must be mocked");
      },
      dispose: async () => {},
    } as ExecutionEnvironment;
    const sandbox = {
      id: "sandbox",
      placement: "remote",
      rootDirectory: "/sandbox",
      resolvePath: (path: string) => `/sandbox/${path}`,
      prepare: async (plan: unknown) => {
        sandboxUse.push(plan);
      },
      read: async (path: string) => {
        sandboxUse.push({ read: path });
        return "";
      },
      spawn: async (spec: unknown) => {
        sandboxUse.push(spec);
        throw new Error("unexpected spawn");
      },
      dispose: async () => {},
    } as ExecutionEnvironment;
    mocks.execServer.mockImplementationOnce(async (options) => {
      sandboxUse.push({
        bridge: { command: options.command, scratchDirectory: options.scratchDirectory },
      });
      expect(options.environment).toBe(sandbox);
      return {
        environmentId: "sandbox-exec",
        url: "ws://127.0.0.1:1/private",
        provenance: {},
        expectClose: () => {},
        close: async () => {},
      };
    });
    mocks.appServer.mockResolvedValueOnce({ close: async () => {} });
    const harness = new CodexHarness({
      workspace: directory,
      executionMode: "app-server",
      authFile,
    });
    const plan = await harness.plan(context);
    expect(JSON.stringify(plan.execution)).not.toContain(sentinel);
    const execution = await harness.start(plan, { runtime: host, execution: sandbox }, context);
    expect(JSON.stringify(hostPlans)).toContain(sentinel);
    expect(JSON.stringify(sandboxUse)).not.toContain(sentinel);
    expect(JSON.stringify(sandboxUse)).not.toContain("auth.json");
    expect(mocks.appServer.mock.calls.at(-1)?.[0].environment).toBe(host);
    expect(mocks.appServer.mock.calls.at(-1)?.[0].executionEnvironment).toMatchObject({
      environmentId: "sandbox-exec",
    });
    await execution.close?.();

    mocks.execServer.mockImplementationOnce(async (options) => {
      sandboxUse.push({ bridge: { command: options.command } });
      expect(options.environment).toBe(sandbox);
      return {
        environmentId: "sandbox-exec",
        url: "ws://127.0.0.1:1/private",
        provenance: {},
        expectClose: () => {},
        close: async () => {},
      };
    });
    mocks.appServer.mockResolvedValueOnce({ close: async () => {} });
    const ambientHarness = new CodexHarness({ workspace: directory, executionMode: "app-server" });
    const ambientExecution = await ambientHarness.start(
      await ambientHarness.plan(context),
      { runtime: host, execution: sandbox },
      context,
    );
    expect(mocks.appServer.mock.calls.at(-1)?.[0].processEnvironment).toMatchObject({
      CODEX_API_KEY: sentinel,
    });
    expect(JSON.stringify(sandboxUse)).not.toContain(sentinel);
    await ambientExecution.close?.();
  } finally {
    for (const [name, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await rm(directory, { recursive: true, force: true });
  }
});
