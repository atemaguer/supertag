import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { repositoryAttempt } from "../../../../tests/support/repository-execution.js";
import {
  type ExecutionContext,
  type HarnessEvent,
  InMemorySessionStateStore,
  LocalHarnessRuntimeProvider,
} from "../../sdk/src/index.js";
import { startCodexAppServer } from "./src/app-server.js";

it("registers and verifies exec-server before binding both the thread and turn to it", async () => {
  const fixture = await splitFixture("ready");
  try {
    const events: HarnessEvent[] = [];
    for await (const event of fixture.execution.run()) events.push(event);
    expect(events.at(-1)).toEqual({
      type: "output.message",
      text: "remote complete",
      final: true,
    });
    const calls = await fixture.calls();
    expect(calls.map(({ method }) => method)).toEqual([
      "initialize",
      "initialized",
      "environment/add",
      "environment/info",
      "environment/status",
      "config/read",
      "thread/start",
      "turn/start",
    ]);
    expect(call(calls, "environment/add").params).toEqual({
      environmentId: "remote-executor",
      execServerUrl: "ws://127.0.0.1:9876/private",
      connectTimeoutMs: 5_000,
    });
    expect(call(calls, "config/read").params).toMatchObject({
      cwd: fixture.runtime.rootDirectory,
    });
    for (const method of ["thread/start", "turn/start"]) {
      expect(call(calls, method).params).toMatchObject({
        environments: [
          {
            environmentId: "remote-executor",
            cwd: "/remote/workspace",
            runtimeWorkspaceRoots: ["/remote/workspace", "/remote/outputs/attempt"],
          },
        ],
      });
    }
    expect(call(calls, "thread/start").params).toMatchObject({
      approvalPolicy: "never",
      sandbox: "danger-full-access",
    });
    expect(call(calls, "thread/start").params["config"]).toBeUndefined();
    expect(call(calls, "turn/start").params).toMatchObject({
      sandboxPolicy: { type: "externalSandbox", networkAccess: "restricted" },
    });
    expect(fixture.execution.provenance).toEqual({
      protocol: "codex-exec-server",
      environmentId: "remote-executor",
      executionEnvironmentId: "shared:incarnation:access",
      execServerSessionId: "exec-session",
    });
  } finally {
    await fixture.cleanup();
  }
});

it("fails before starting a thread when the selected exec-server is not ready", async () => {
  const fixture = await splitFixture("failed", false);
  try {
    await expect(fixture.start).rejects.toThrow("Codex exec-server is not ready: unavailable");
    const calls = await fixture.calls();
    expect(calls.map(({ method }) => method)).toEqual([
      "initialize",
      "initialized",
      "environment/add",
      "environment/info",
      "environment/status",
    ]);
  } finally {
    await fixture.cleanup();
  }
});

it("fails the active turn when Codex reports that its exec-server disconnected", async () => {
  const fixture = await splitFixture("ready", true, true);
  try {
    await expect(async () => {
      for await (const _event of fixture.execution.run()) {
        // The disconnect must end the iterator with a failure.
      }
    }).rejects.toThrow("Codex execution environment disconnected");
  } finally {
    await fixture.cleanup();
  }
});

it("marks execution transport shutdown before a failed turn closes its app-server", async () => {
  const fixture = await splitFixture("ready", true, false, true);
  try {
    await expect(async () => {
      for await (const _event of fixture.execution.run()) {
      }
    }).rejects.toThrow("Codex turn failed");
    expect(fixture.shutdown[0]).toBe("intent");
    expect(fixture.shutdown).toContain("end-input");
    expect(fixture.shutdown.filter((event) => event === "intent")).toHaveLength(1);
    await fixture.execution.close();
    expect(fixture.shutdown.filter((event) => event === "intent")).toHaveLength(1);
  } finally {
    await fixture.cleanup();
  }
});

it.each([
  [
    "Provider refused the requested model.",
    "Codex turn failed: Provider refused the requested model.",
  ],
  [
    `${"x".repeat(2040)}credential-crossing-the-boundary`,
    "Codex turn failed: provider error exceeds 2048 characters",
  ],
])(
  "retains useful provider errors without cutting credentials at the size limit (%#)",
  async (detail, expected) => {
    const fixture = await splitFixture("ready", true, false, detail);
    try {
      let failure: unknown;
      try {
        for await (const _event of fixture.execution.run()) {
        }
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toBe(expected);
      expect((failure as Error).message).not.toContain("credential");
      expect(fixture.shutdown[0]).toBe("intent");
    } finally {
      await fixture.cleanup();
    }
  },
);

type RpcCall = { readonly method: string; readonly params: Record<string, unknown> };

async function splitFixture(
  status: "ready" | "failed",
  waitForStart = true,
  disconnect = false,
  failedTurn: boolean | string = false,
) {
  const directory = await mkdtemp(join(tmpdir(), "codex-app-server-split-"));
  const script = join(directory, "app-server.cjs");
  await writeFile(
    script,
    `const fs=require('node:fs'),rl=require('node:readline').createInterface({input:process.stdin});
const calls='calls.jsonl',send=x=>process.stdout.write(JSON.stringify(x)+'\\n');
const reply=(id,result)=>send({id,result}),record=m=>fs.appendFileSync(calls,JSON.stringify({method:m.method,params:m.params})+'\\n');
rl.on('line',line=>{const m=JSON.parse(line);record(m);
if(m.method==='initialize')return reply(m.id,{codexHome:process.env.CODEX_HOME});
if(m.method==='initialized')return;
if(m.method==='environment/add')return reply(m.id,{status:'pending'});
if(m.method==='environment/info')return reply(m.id,{shell:{name:'zsh',path:'/bin/zsh'},cwd:'/remote/workspace'});
if(m.method==='environment/status')return reply(m.id,{status:${JSON.stringify(status)},error:${status === "failed" ? "'unavailable'" : "null"}});
if(m.method==='config/read')return reply(m.id,{layers:[]});
if(m.method==='thread/start')return reply(m.id,{thread:{id:'root'}});
if(m.method==='turn/start'){reply(m.id,{turn:{id:'turn'}});send({method:'turn/started',params:{threadId:'root',turn:{id:'turn'}}});${failedTurn ? `send({method:'turn/completed',params:{threadId:'root',turn:{id:'turn',status:'failed',error:${JSON.stringify(typeof failedTurn === "string" ? { message: failedTurn } : null)}}}});` : disconnect ? "send({method:'thread/environment/disconnected',params:{threadId:'root',environmentId:'remote-executor'}});" : "send({method:'item/completed',params:{threadId:'root',item:{type:'agentMessage',id:'message',text:'remote complete'}}});send({method:'turn/completed',params:{threadId:'root',turn:{id:'turn',status:'completed'}}});"}}
});`,
  );
  const attempt = repositoryAttempt("app-server-split");
  const profile = {
    ref: attempt.workerProfile,
    workerType: "supertag",
    harness: { provider: "codex" },
    runtime: { provider: "local-runtime", lifetime: { scope: "attempt" as const } },
    execution: { provider: "remote-execution", lifetime: { scope: "attempt" as const } },
  };
  const context: ExecutionContext = {
    attempt,
    profile,
    context: { instructions: [], skills: [], history: [], resources: [] },
    tools: [],
    secrets: [],
    sessionStates: [],
    extensions: [],
    sessionStateStore: new InMemorySessionStateStore(),
  };
  const provider = new LocalHarnessRuntimeProvider({ temporaryDirectory: directory });
  const runtime = await provider.provisionRuntime({
    task: attempt,
    profile,
    plan: {
      files: [],
      mounts: [],
      environmentVariables: {},
      secretBindings: [],
      network: { mode: "none" },
    },
    lifetime: profile.runtime.lifetime,
  });
  const shutdown: string[] = [];
  const spawn = runtime.spawn.bind(runtime);
  runtime.spawn = async (...args) => {
    const process = await spawn(...args);
    const endInput = process.endInput?.bind(process);
    const kill = process.kill.bind(process);
    return {
      ...process,
      output: process.output,
      write: process.write?.bind(process),
      wait: process.wait.bind(process),
      endInput: async () => {
        shutdown.push("end-input");
        await endInput?.();
      },
      kill: (signal) => {
        shutdown.push("kill");
        kill(signal);
      },
    };
  };
  const start = startCodexAppServer({
    request: {
      prompt: "work remotely",
      workspace: "/remote/workspace",
      timeoutMs: 5_000,
      command: "codex",
      mcpServers: [],
      toolInputs: [],
      runtimeActions: ["files:write"],
      sandboxMode: "external",
      outputDirectory: "/remote/outputs/attempt",
      externalNetworkAccess: "restricted",
    },
    environment: runtime,
    executionEnvironment: {
      environmentId: "remote-executor",
      url: "ws://127.0.0.1:9876/private",
      cwd: "/remote/workspace",
      provenance: {
        protocol: "codex-exec-server",
        environmentId: "remote-executor",
        executionEnvironmentId: "shared:incarnation:access",
        execServerSessionId: "exec-session",
      },
    },
    context,
    onClosing: () => {
      shutdown.push("intent");
    },
    command: process.execPath,
    args: [script],
    processEnvironment: { CODEX_HOME: runtime.resolvePath(".codex") },
  });
  const execution = waitForStart ? await start : undefined;
  return {
    start,
    shutdown,
    execution: execution as Awaited<typeof start>,
    runtime,
    calls: async (): Promise<RpcCall[]> => {
      const contents = await readFile(runtime.resolvePath("calls.jsonl"), "utf8").catch(() => "");
      return contents
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as RpcCall);
    },
    cleanup: async () => {
      if (execution) await execution.close();
      await runtime.dispose(status === "ready" ? "completed" : "failed");
      await rm(directory, { recursive: true, force: true });
    },
  };
}

function call(calls: readonly RpcCall[], method: string): RpcCall {
  const found = calls.find((candidate) => candidate.method === method);
  if (!found) throw new Error(`Missing ${method}`);
  return found;
}
