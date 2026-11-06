import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ControlPlaneClient } from "../apps/cli/src/control-plane-client.ts";
import { startControlPlaneRuntime } from "../apps/cli/src/control-plane-runtime.ts";
import {
  runTagConversationCommand,
  type TagMessageRecord,
} from "../apps/cli/src/tag-conversation.ts";
import { ReplyStreams } from "../packages/control-plane/src/reply-streams.ts";
import type { TaskAttemptEvent, Worklet } from "../packages/runtime/sdk/src/index.ts";
import { DrizzleStore, migrateDatabase } from "../packages/store/src/index.ts";
import { createIsolatedPostgresDatabase } from "./support/database.ts";

const postgres = process.env["SUPERTAG_POSTGRES_URL"];
const ADMIN = "test-administrative-token";

interface Part {
  readonly frame?: number;
  readonly type: string;
  readonly [key: string]: unknown;
}

/** Parses Server-Sent Events text into its parts; `[DONE]` becomes `{ type: "[DONE]" }`. */
function parts(text: string): Part[] {
  return text
    .split("\n\n")
    .filter((frame) => frame.includes("data: "))
    .map((frame) => {
      const id = /^id: (\d+)$/mu.exec(frame)?.[1];
      const data = /^data: (.*)$/mu.exec(frame)?.[1] ?? "";
      const part = data === "[DONE]" ? { type: "[DONE]" } : (JSON.parse(data) as Part);
      return id === undefined ? part : { ...part, frame: Number(id) };
    });
}

async function readAll(stream: ReadableStream<string> | undefined): Promise<string> {
  if (stream === undefined) throw new Error("no stream");
  let text = "";
  for await (const chunk of stream) text += chunk;
  return text;
}

const identity = { taskId: "task-1", attemptId: "attempt-1", at: new Date().toISOString() };

describe("ReplyStreams", () => {
  it("streams deltas, activity, and the finish in order, and resumes after a part", async () => {
    const streams = new ReplyStreams();
    try {
      streams.open("task-1", 1);
      streams.event("task-1", { ...identity, type: "output.delta", text: "Look" });
      streams.event("task-1", { ...identity, type: "output.delta", text: "ing." });
      streams.event("task-1", {
        ...identity,
        type: "command.updated",
        command: { id: "c1", command: "ls -la", status: "running" },
      });
      const early = await streams.read("task-1");
      streams.event("task-1", { ...identity, type: "output.delta", text: "Done." });
      const resumed = await streams.read("task-1", 5);
      streams.finish("task-1", {
        status: "completed",
        reply: { presentation: "final-result", text: "Done." },
      });
      const all = parts(await readAll(early));
      expect(all.map(({ frame: _frame, ...part }) => part)).toEqual([
        { type: "start", messageId: "task-1" },
        { type: "text-start", id: "text-1" },
        // Deltas arriving together share one part.
        { type: "text-delta", id: "text-1", delta: "Looking." },
        { type: "text-end", id: "text-1" },
        {
          type: "data-activity",
          id: "command:c1",
          data: { kind: "command", command: "ls -la", status: "running" },
        },
        { type: "text-start", id: "text-2" },
        { type: "text-delta", id: "text-2", delta: "Done." },
        { type: "text-end", id: "text-2" },
        {
          type: "finish",
          messageMetadata: {
            status: "completed",
            reply: { presentation: "final-result", text: "Done." },
          },
        },
        { type: "[DONE]" },
      ]);
      expect(all.slice(0, -1).map((part) => part.frame)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
      expect(parts(await readAll(resumed)).map((part) => part.frame ?? part.type)).toEqual([
        6,
        7,
        8,
        9,
        "[DONE]",
      ]);
      // A finished stream is gone; readers use the stored reply.
      expect(await streams.read("task-1")).toBeUndefined();
    } finally {
      streams.close();
    }
  });

  it("continues one stream across a retry and ends a failure with an error", async () => {
    const streams = new ReplyStreams();
    try {
      streams.open("task-1", 1);
      const reader = await streams.read("task-1");
      streams.event("task-1", { ...identity, type: "output.delta", text: "partial" });
      streams.open("task-1", 2);
      streams.finish("task-1", {
        status: "failed",
        reply: { presentation: "error", text: "Worker crashed" },
      });
      expect(parts(await readAll(reader)).map(({ frame: _frame, ...part }) => part)).toEqual([
        { type: "start", messageId: "task-1" },
        { type: "text-start", id: "text-1" },
        { type: "text-delta", id: "text-1", delta: "partial" },
        { type: "text-end", id: "text-1" },
        { type: "data-activity", data: { kind: "retry", attempt: 2 } },
        { type: "error", errorText: "Worker crashed" },
        { type: "[DONE]" },
      ]);
    } finally {
      streams.close();
    }
  });

  it("bounds the frames it keeps, dropping text and activity, but still finishes", async () => {
    const streams = new ReplyStreams();
    try {
      streams.open("task-1", 1);
      const reader = await streams.read("task-1");
      const chunk = "x".repeat(1024 * 1024);
      for (let index = 0; index < 8; index += 1)
        streams.event("task-1", { ...identity, type: "output.delta", text: chunk });
      streams.event("task-1", {
        ...identity,
        type: "command.updated",
        command: { id: "c1", command: "ls", status: "running" },
      });
      streams.open("task-1", 2);
      streams.finish("task-1", { status: "completed" });
      const text = await readAll(reader);
      expect(text.length).toBeLessThanOrEqual(4 * 1024 * 1024 + 1024);
      const received = parts(text);
      expect(received.filter((part) => part.type === "text-delta")).toHaveLength(3);
      expect(received.map((part) => part.type).slice(-5)).toEqual([
        "text-delta",
        "text-end",
        "data-activity",
        "finish",
        "[DONE]",
      ]);
      expect(received.at(-3)).toMatchObject({ data: { kind: "retry", attempt: 2 } });
    } finally {
      streams.close();
    }
  });

  it("batches token-sized deltas into larger parts", async () => {
    const streams = new ReplyStreams();
    try {
      streams.open("task-1", 1);
      const reader = await streams.read("task-1");
      for (let index = 0; index < 1000; index += 1)
        streams.event("task-1", { ...identity, type: "output.delta", text: "ab" });
      await new Promise((resolve) => setTimeout(resolve, 60));
      streams.event("task-1", { ...identity, type: "output.delta", text: "!" });
      streams.finish("task-1", { status: "completed" });
      const deltas = parts(await readAll(reader)).filter((part) => part.type === "text-delta");
      expect(deltas.map((part) => part["delta"])).toEqual(["ab".repeat(1000), "!"]);
    } finally {
      streams.close();
    }
  });
});

/** A Worklet whose one Worker writes its reply in deltas, waiting at `gate` before finishing. */
function streamingWorklet(gate: { promise: Promise<void> }, received: string[] = []): Worklet {
  return {
    id: "stream-worklet",
    describe: async () => ({
      id: "stream-worklet",
      protocolVersion: 1,
      host: {
        id: "stream-host",
        workers: [
          {
            profileCapabilities: [
              { profile: { id: "default", revision: "1" }, capabilities: [], contextTypes: [] },
            ],
            id: "stream-worker",
            type: "deterministic",
            profiles: [{ id: "default", revision: "1" }],
            capabilities: [],
            contextTypes: [],
            maxConcurrency: 2,
          },
        ],
      },
    }),
    controlCapabilities: async () => ({ version: 1, operations: ["input"], inputMode: "queue" }),
    control: async (command) => {
      received.push(command.type === "input" ? command.text : "unexpected");
      return {
        id: command.id,
        taskId: command.taskId,
        attemptId: command.attemptId,
        status: "accepted",
      };
    },
    async *execute(spec): AsyncIterable<TaskAttemptEvent> {
      const at = () => new Date().toISOString();
      const id = { taskId: spec.taskId, attemptId: spec.attemptId };
      yield { ...id, at: at(), type: "execution.started", workerId: "stream-worker" };
      yield { ...id, at: at(), type: "output.delta", text: "Checking " };
      yield {
        ...id,
        at: at(),
        type: "command.updated",
        command: { id: "c1", command: "pnpm lint", status: "running" },
      };
      yield {
        ...id,
        at: at(),
        type: "command.updated",
        command: { id: "c1", command: "pnpm lint", status: "completed" },
      };
      await gate.promise;
      const summary = received.length > 0 ? "Answered both." : "All clean.";
      yield { ...id, at: at(), type: "output.delta", text: "All " };
      yield { ...id, at: at(), type: "output.delta", text: summary.slice(4) };
      yield {
        ...id,
        at: at(),
        type: "output.message",
        message: { role: "teammate", text: summary },
      };
      yield {
        ...id,
        at: at(),
        type: "result",
        result: {
          summary,
          decisions: [],
          changes: [],
          unresolved: [],
          findings: [],
          references: [],
          artifacts: [],
        },
      };
      yield { ...id, at: at(), type: "execution.completed" };
    },
  };
}

for (const dialect of ["sqlite", "postgresql"] as const) {
  describe.skipIf(dialect === "postgresql" && !postgres)(`reply stream (${dialect})`, () => {
    let directory: string;
    let runtime: Awaited<ReturnType<typeof startControlPlaneRuntime>>;
    let store: DrizzleStore;
    let cleanup: (() => Promise<void>) | undefined;
    let release: () => void;
    let gate: { promise: Promise<void> };
    let received: string[];
    let client: ControlPlaneClient;

    beforeEach(async () => {
      directory = await mkdtemp(join(tmpdir(), "supertag-reply-stream-"));
      let databaseUrl = `file:${join(directory, "supertag.db")}`;
      cleanup = undefined;
      if (dialect === "postgresql") {
        const isolated = await createIsolatedPostgresDatabase(postgres as string);
        databaseUrl = isolated.url;
        cleanup = isolated.cleanup;
      }
      await migrateDatabase({ url: databaseUrl });
      vi.stubEnv("SUPERTAG_STATE_DIR", join(directory, "server"));
      gate = { promise: new Promise<void>((resolve) => (release = resolve)) };
      received = [];
      runtime = await startControlPlaneRuntime({
        host: "127.0.0.1",
        port: 0,
        databaseUrl,
        adminToken: ADMIN,
        worklet: streamingWorklet(gate, received),
      });
      store = new DrizzleStore({ url: databaseUrl });
      await store.connect();
      const tag = await store.createTag({ name: "planner" });
      await store.bindTagWorkerHost(tag.id, "stream-host");
      client = new ControlPlaneClient({ url: runtime.url, token: ADMIN });
    });

    afterEach(async () => {
      release();
      await store.disconnect();
      await runtime.close();
      await cleanup?.();
      await rm(directory, { recursive: true, force: true });
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
    });

    const post = (text: string, session = "work") =>
      client.request<TagMessageRecord>("/api/v1/tags/planner/messages", {
        method: "POST",
        body: JSON.stringify({ text, session }),
      });

    /** Opens a reply stream; `until` reads until the text received so far matches. */
    async function open(taskId: string, query = "") {
      const response = await fetch(
        `${runtime.url}/api/v1/tags/planner/messages/${taskId}/stream${query}`,
        { headers: { authorization: `Bearer ${ADMIN}` } },
      );
      if (response.body === null) throw new Error("no body");
      const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
      let text = "";
      return {
        response,
        async until(pattern: RegExp): Promise<string> {
          while (!pattern.test(text)) {
            const { done, value } = await reader.read();
            if (done) break;
            text += value;
          }
          return text;
        },
        close: () => reader.cancel(),
      };
    }

    async function follow(taskId: string, until: RegExp, query = "") {
      const stream = await open(taskId, query);
      const text = await stream.until(until);
      await stream.close();
      return { response: stream.response, text };
    }

    it("streams a running reply, resumes it, and serves a finished one whole", async () => {
      const message = await post("Check the repository");
      const live = await follow(message.taskId, /pnpm lint/u);
      expect(live.response.headers.get("content-type")).toMatch(/^text\/event-stream/u);
      expect(live.response.headers.get("x-vercel-ai-ui-message-stream")).toBe("v1");
      const running = parts(live.text);
      expect(running.slice(0, 5).map((part) => part.type)).toEqual([
        "start",
        "text-start",
        "text-delta",
        "text-end",
        "data-activity",
      ]);
      expect(running[2]).toMatchObject({ delta: "Checking " });

      // A reader that saw part 3 resumes at part 4, then follows the reply to its finish.
      const resuming = await open(message.taskId, "?resumeAt=3");
      await resuming.until(/pnpm lint/u);
      release();
      const resumed = parts(await resuming.until(/\[DONE\]/u));
      await resuming.close();
      expect(resumed[0]).toMatchObject({ frame: 4, type: "text-end" });
      expect(
        resumed
          .filter((part) => part.type === "text-delta")
          .map((part) => part["delta"])
          .join(""),
      ).toBe("All clean.");
      expect(resumed.at(-2)).toMatchObject({
        type: "finish",
        messageMetadata: {
          status: "completed",
          reply: { presentation: "final-result", text: "All clean." },
        },
      });

      // After the finish, the stored reply arrives as one complete message.
      const late = parts((await follow(message.taskId, /\[DONE\]/u)).text);
      expect(late.map((part) => part.type)).toEqual([
        "start",
        "text-start",
        "text-delta",
        "text-end",
        "finish",
        "[DONE]",
      ]);
      expect(late[2]).toMatchObject({ delta: "All clean." });

      // Reply text reaches readers through the stream; it is not stored as Task events.
      const events = await store.listTaskEvents(message.taskId);
      expect(events.some((event) => event.type === "execution.output.delta")).toBe(false);
      expect(events.some((event) => event.type === "execution.command.updated")).toBe(true);
    });

    it("hides another operator's reply stream", async () => {
      const issued = await client.request<{ secret: string }>("/api/v1/operator-tokens", {
        method: "POST",
        body: JSON.stringify({ kind: "OperatorToken", metadata: { name: "alice" } }),
      });
      const message = await post("Check the repository");
      const response = await fetch(
        `${runtime.url}/api/v1/tags/planner/messages/${message.taskId}/stream`,
        { headers: { authorization: `Bearer ${issued.secret}` } },
      );
      expect(response.status).toBe(404);
      await response.body?.cancel();
    });

    it("streams a joined message from the Task it joined", async () => {
      const first = await post("Check the repository");
      await follow(first.taskId, /pnpm lint/u);
      const second = await post("Also check the tests");
      const joined = follow(second.taskId, /\[DONE\]/u);
      await vi.waitFor(() => expect(received).toHaveLength(1));
      // Give the stream request time to find the joined Task before it finishes.
      await new Promise((resolve) => setTimeout(resolve, 600));
      release();
      const streamed = parts((await joined).text);
      // Only the joined Task's parts after the join arrive, not its earlier reply text.
      expect(streamed.some((part) => part["delta"] === "Checking ")).toBe(false);
      expect(streamed.at(-2)).toMatchObject({
        type: "finish",
        messageMetadata: { reply: { text: "Answered both." } },
      });
    });

    it("prints the streamed reply and its command activity", async () => {
      const written: string[] = [];
      const command = runTagConversationCommand(
        { url: runtime.url, token: ADMIN },
        ["planner", "Check the repository", "--session", "cli"],
        { write: (text) => written.push(text), interactive: true },
      );
      await vi.waitFor(() => expect(written.join("")).toContain("pnpm lint"));
      release();
      const rest = await command;
      expect(written.join("") + rest).toBe(
        "Checking \n\u001b[2m· running: pnpm lint\u001b[22m\nAll clean.\n",
      );
    });

    it("prints plain streamed text when not on a terminal, and detaches on request", async () => {
      const written: string[] = [];
      const warned: string[] = [];
      const detach = new AbortController();
      const command = runTagConversationCommand(
        { url: runtime.url, token: ADMIN },
        ["planner", "Check the repository", "--session", "plain"],
        {
          write: (text) => written.push(text),
          warn: (text) => warned.push(text),
          signal: detach.signal,
        },
      );
      await vi.waitFor(() => expect(written.join("")).toBe("Checking "));
      detach.abort();
      await expect(command).resolves.toBe("");
      expect(warned.join("")).toMatch(/keeps working on task\/.+supertag describe task/u);
      // Detaching does not cancel the Task.
      release();
      const tasks = await store.listTasks();
      await vi.waitFor(async () =>
        expect((await store.findTaskById(tasks[0]?.id ?? ""))?.status).toBe("completed"),
      );
    });
  });
}
