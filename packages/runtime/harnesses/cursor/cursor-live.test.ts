import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  collectTaskAttemptEvents,
  type HarnessRuntime,
  InMemorySessionStateStore,
  type TaskAttemptEvent,
  type ToolInput,
} from "@supertag/worker-sdk";
import { expect, it } from "vitest";
import { cursorLiveAttempt, cursorLiveTool, cursorLiveWorker } from "./cursor-live-setup.js";
import { type CursorRunRequest, runCursor } from "./src/index.js";
import type { CursorRunnerEvent } from "./src/protocol.js";

// Opt in only with SUPERTAG_LIVE_CURSOR=1. The SDK uses CURSOR_API_KEY, not app login.
// https://cursor.com/docs/sdk/typescript.md#authentication
// https://cursor.com/docs/sdk/typescript.md#resuming-agents
// https://cursor.com/docs/sdk/typescript.md#restricting-the-toolset
const live = process.env["SUPERTAG_LIVE_CURSOR"] === "1" ? it : it.skip;
const missingKey = () => {
  if (!process.env["CURSOR_API_KEY"])
    throw new Error("SUPERTAG_LIVE_CURSOR=1 requires CURSOR_API_KEY for the Cursor SDK");
};
const scratch = () => process.env["SUPERTAG_SCRATCH_DIR"] ?? tmpdir();

async function fixture() {
  const directory = await mkdtemp(join(scratch(), "supertag-cursor-live-"));
  execFileSync("git", ["init", "-q", directory]);
  await writeFile(join(directory, "seed.txt"), "baseline\n");
  execFileSync("git", ["-C", directory, "add", "seed.txt"]);
  execFileSync("git", [
    "-C",
    directory,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.test",
    "commit",
    "-qm",
    "Seed",
  ]);
  return directory;
}

async function runLive(input: {
  directory: string;
  prompt: string;
  actions?: readonly string[];
  session?: { id: string; sessionState?: import("@supertag/worker-sdk").SessionStateRef };
  store?: InMemorySessionStateStore;
  tool?: ToolInput;
  signal?: AbortSignal;
  onStart?: (request: CursorRunRequest) => void;
  onEvent?: (event: CursorRunnerEvent) => void;
}) {
  const spec = cursorLiveAttempt({ id: `cursor-live-${randomUUID()}`, ...input });
  const observed: { path?: string; content?: string; exists?: boolean; pid?: number } = {};
  const worker = cursorLiveWorker({
    directory: input.directory,
    ...(input.store ? { store: input.store } : {}),
    ...(input.tool ? { tool: input.tool } : {}),
    runner: async function* (request, runtime, signal, executor) {
      observed.path = request.workspace;
      input.onStart?.(request);
      const wrapped = Object.assign(Object.create(runtime) as HarnessRuntime, {
        spawn: async (...args: Parameters<HarnessRuntime["spawn"]>) => {
          const handle = await runtime.spawn(...args);
          if (handle.pid) observed.pid = handle.pid;
          return handle;
        },
      });
      for await (const event of runCursor(request, wrapped, signal, executor)) {
        input.onEvent?.(event);
        yield event;
      }
      const target = join(request.workspace, "cursor-live.txt");
      observed.exists = await access(target).then(
        () => true,
        () => false,
      );
      if (observed.exists) observed.content = await readFile(target, "utf8");
    },
  });
  const events = await collectTaskAttemptEvents(worker.execute(spec, input.signal));
  return { events, observed };
}

function completed(events: readonly TaskAttemptEvent[]) {
  expect(events.at(-1), JSON.stringify(events.at(-1))).toMatchObject({
    type: "execution.completed",
  });
}

live(
  "edits one file in a temporary Git repository and reports honest usage",
  async () => {
    missingKey();
    const directory = await fixture();
    try {
      const { events, observed } = await runLive({
        directory,
        prompt: "Create cursor-live.txt containing exactly: cursor live edit. Reply DONE.",
      });
      completed(events);
      expect(observed.content?.trim()).toBe("cursor live edit");
      const usage = events.findLast((event) => event.type === "usage.updated");
      expect(usage?.type === "usage.updated" ? usage.usage.totalTokens : 0).toBeGreaterThan(0);
      if (usage?.type === "usage.updated")
        expect(usage.usage.reportedCost || usage.usage.unpricedModel).toBeTruthy();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
  120_000,
);

live(
  "resumes a second turn with the first turn's private nonce",
  async () => {
    missingKey();
    const directory = await fixture();
    const store = new InMemorySessionStateStore();
    const nonce = randomUUID();
    try {
      const first = await runLive({
        directory,
        store,
        session: { id: "cursor-live-session" },
        prompt: `Remember this private nonce: ${nonce}. Do not write it to a file. Reply READY.`,
      });
      completed(first.events);
      const state = first.events.findLast((event) => event.type === "session.updated");
      if (state?.type !== "session.updated") throw new Error("Cursor did not export Session state");
      let resumed = false;
      const second = await runLive({
        directory,
        store,
        session: { id: "cursor-live-session", sessionState: state.sessionState },
        prompt: "What private nonce did I ask you to remember? Reply with only the nonce.",
        onStart: (request) => {
          resumed = Boolean(request.resumeAgentId);
        },
      });
      completed(second.events);
      expect(resumed).toBe(true);
      expect(JSON.stringify(second.events)).toContain(nonce);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
  240_000,
);

live(
  "cancels a running SDK turn and confirms its runner exits",
  async () => {
    missingKey();
    const directory = await fixture();
    const controller = new AbortController();
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    try {
      const run = runLive({
        directory,
        signal: controller.signal,
        prompt:
          "Inspect seed.txt, then wait and think through twenty possible filenames before replying.",
        onEvent: (event) => {
          if (event.type === "progress.updated" || event.type === "output.message") started();
        },
      });
      await Promise.race([
        ready,
        run.then(({ events }) => {
          throw new Error(`Cursor run settled before it started: ${JSON.stringify(events.at(-1))}`);
        }),
      ]);
      controller.abort(new Error("Live cancellation probe"));
      const { events, observed } = await run;
      // A Worker has no execution.cancelled event: a cancelled Attempt ends in
      // execution.failed carrying the abort reason it was cancelled with. A harness
      // failure would carry a different error, so the message identifies cancellation.
      const last = events.at(-1);
      expect(last, JSON.stringify(last)).toMatchObject({
        type: "execution.failed",
        error: { message: "Live cancellation probe" },
      });
      expect(observed.pid).toBeGreaterThan(0);
      let processStatus = "running";
      try {
        process.kill(observed.pid as number, 0);
      } catch (error) {
        processStatus = (error as NodeJS.ErrnoException).code ?? "unknown";
      }
      expect(processStatus).toBe("ESRCH");
      // runCursor's process-tree confirmation completes before worker.execute settles.
    } finally {
      controller.abort();
      await rm(directory, { recursive: true, force: true });
    }
  },
  120_000,
);

live(
  "calls an admitted SuperTag MCP tool",
  async () => {
    missingKey();
    const directory = await fixture();
    try {
      const script = join(directory, "supertag-mcp.cjs");
      await writeFile(
        script,
        `const readline=require('node:readline');
readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.id===undefined)return;const result=m.method==='initialize'?{protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'supertag',version:'1'}}:m.method==='tools/list'?{tools:[{name:'probe',description:'Return the SuperTag probe marker',inputSchema:{type:'object',properties:{}}}]}:{content:[{type:'text',text:'SUPERTAG_MCP_OK'}]};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n')});`,
      );
      const tool = cursorLiveTool(script);
      const { events } = await runLive({
        directory,
        tool,
        prompt: "Call the supertag probe MCP tool once. Reply with its exact returned text.",
      });
      completed(events);
      expect(JSON.stringify(events)).toContain("SUPERTAG_MCP_OK");
      expect(events.some((event) => event.type === "tool.call.completed")).toBe(true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
  120_000,
);

live(
  "refuses an edit in a read-only Task",
  async () => {
    missingKey();
    const directory = await fixture();
    try {
      const { events, observed } = await runLive({
        directory,
        actions: [],
        prompt:
          "Try to create cursor-live.txt containing denied. Then report whether it succeeded.",
      });
      completed(events);
      expect(observed.exists).toBe(false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
  120_000,
);
