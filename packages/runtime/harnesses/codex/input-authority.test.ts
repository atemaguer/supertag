import { expect, it, vi } from "vitest";
import { repositoryAttempt } from "../../../../tests/support/repository-execution.js";
import {
  type ExecutionContext,
  type HarnessRuntime,
  InMemorySessionStateStore,
} from "../../sdk/src/index.js";
import { startCodexAppServer } from "./src/app-server.js";

it("rechecks authority after the Codex stdin queue and never writes revoked text", async () => {
  // An in-memory app-server exercises the production RPC queue without launching processes.
  const frames: Record<string, unknown>[] = [];
  const output: string[] = [];
  let wake = () => {};
  let closed = false;
  const emit = (frame: unknown) => {
    output.push(`${JSON.stringify(frame)}\n`);
    wake();
  };
  let release!: () => void;
  const blockedWrite = new Promise<void>((resolve) => {
    release = resolve;
  });
  let exit!: () => void;
  const exited = new Promise<void>((resolve) => {
    exit = resolve;
  });
  const stop = () => {
    closed = true;
    wake();
    exit();
  };
  const environment = {
    rootDirectory: "/fixture",
    spawn: async () => ({
      output: (async function* () {
        while (!closed || output.length) {
          const text = output.shift();
          if (text) yield { stream: "stdout", text };
          else
            await new Promise<void>((resolve) => {
              wake = resolve;
            });
        }
      })(),
      write: async (bytes: Uint8Array) => {
        const frame = JSON.parse(new TextDecoder().decode(bytes));
        frames.push(frame);
        const reply = (result: unknown) => emit({ id: frame.id, result });
        if (frame.method === "initialize") reply({ codexHome: "/fixture/.codex" });
        else if (frame.method === "config/read") reply({ layers: [] });
        else if (frame.method === "thread/start") reply({ thread: { id: "root" } });
        else if (frame.method === "turn/start") {
          reply({ turn: { id: "turn" } });
          emit({ method: "turn/started", params: { threadId: "root", turn: { id: "turn" } } });
          emit({
            method: "item/agentMessage/delta",
            params: { threadId: "root", delta: "working" },
          });
          await blockedWrite;
        } else if (frame.method === "turn/steer") reply({ turnId: "turn" });
      },
      wait: async () => {
        await exited;
        return { exitCode: 0 };
      },
      endInput: async () => stop(),
      kill: stop,
    }),
  } as unknown as HarnessRuntime;
  const attempt = repositoryAttempt("input-authority");
  const context: ExecutionContext = {
    attempt,
    profile: {
      ref: attempt.workerProfile,
      workerType: "supertag",
      harness: { provider: "codex" },
      execution: { provider: "local-execution", lifetime: { scope: "attempt" } },
    },
    context: { instructions: [], skills: [], history: [], resources: [] },
    tools: [],
    secrets: [],
    sessionStates: [],
    extensions: [],
    sessionStateStore: new InMemorySessionStateStore(),
  };
  const execution = await startCodexAppServer({
    environment,
    context,
    command: "fixture",
    args: [],
    processEnvironment: { CODEX_HOME: "/fixture/.codex" },
    request: {
      command: "codex",
      prompt: "work",
      workspace: "/fixture",
      timeoutMs: 10_000,
      mcpServers: [],
      toolInputs: [],
      runtimeActions: [],
    },
  });
  const run = execution.run()[Symbol.asyncIterator]();
  try {
    for (;;) {
      const next = await run.next();
      if (next.done) throw new Error("Turn ended before input could be sent");
      if (next.value.type === "output.delta") break;
    }
    let member = true;
    const authorizeInput = vi.fn(async () => member);
    const pending = execution.control?.send(
      {
        id: "revoked",
        taskId: attempt.taskId,
        attemptId: attempt.attemptId,
        type: "input",
        text: "never write this",
        advisory: true,
        requiresInputAuthorization: true,
      },
      { authorizeInput },
    );
    await Promise.resolve();
    expect(authorizeInput).not.toHaveBeenCalled();
    member = false;
    release();
    expect((await pending)?.status).toBe("rejected");
    expect(authorizeInput).toHaveBeenCalledTimes(1);
    expect(frames.some((frame) => frame["method"] === "turn/steer")).toBe(false);
    expect(
      (
        await execution.control?.send({
          id: "operator",
          taskId: attempt.taskId,
          attemptId: attempt.attemptId,
          type: "input",
          text: "continue",
        })
      )?.status,
    ).toBe("accepted");
    expect(frames.filter((frame) => frame["method"] === "turn/steer")).toHaveLength(1);
    emit({
      method: "item/completed",
      params: { threadId: "root", item: { type: "agentMessage", id: "answer", text: "done" } },
    });
    emit({
      method: "turn/completed",
      params: { threadId: "root", turn: { id: "turn", status: "completed" } },
    });
    while (!(await run.next()).done) {}
  } finally {
    release();
    await execution.close();
    await run.return?.();
  }
});
