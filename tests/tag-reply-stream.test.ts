import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { equals } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startControlPlaneRuntime } from "../apps/cli/src/control-plane-runtime.ts";
import { conversationClient } from "../apps/cli/src/operator-client.ts";
import { type ReplyStreamPart, ReplyStreams } from "../packages/control-plane/src/reply-streams.ts";
import {
  ActivityStatus,
  type FollowEvent,
  FollowEventSchema,
  ReplyPresentation,
} from "../packages/operator-api/src/index.ts";
import type { TaskAttemptEvent, Worklet } from "../packages/runtime/sdk/src/index.ts";
import { DrizzleStore, migrateDatabase } from "../packages/store/src/index.ts";
import { createIsolatedPostgresDatabase } from "./support/database.ts";
import { issueOperatorToken } from "./support/operator-access.ts";

const postgres = process.env["SUPERTAG_POSTGRES_URL"];
const ADMIN = "test-administrative-token";

interface Part {
  readonly frame?: number;
  readonly type: string;
  readonly [key: string]: unknown;
}

/** Reads a live reply to its end, as parts carrying their frame numbers. */
async function readAll(stream: ReadableStream<ReplyStreamPart> | undefined): Promise<Part[]> {
  if (stream === undefined) throw new Error("no stream");
  const parts: Part[] = [];
  for await (const { frame, part } of stream) parts.push({ ...part, frame });
  return parts;
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
      const all = await readAll(early);
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
      ]);
      expect(all.map((part) => part.frame)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
      expect((await readAll(resumed)).map((part) => part.frame)).toEqual([6, 7, 8, 9]);
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
      expect((await readAll(reader)).map(({ frame: _frame, ...part }) => part)).toEqual([
        { type: "start", messageId: "task-1" },
        { type: "text-start", id: "text-1" },
        { type: "text-delta", id: "text-1", delta: "partial" },
        { type: "text-end", id: "text-1" },
        { type: "data-activity", data: { kind: "retry", attempt: 2 } },
        { type: "error", errorText: "Worker crashed" },
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
      const received = await readAll(reader);
      expect(JSON.stringify(received).length).toBeLessThanOrEqual(4 * 1024 * 1024 + 1024);
      expect(received.filter((part) => part.type === "text-delta")).toHaveLength(3);
      expect(received.map((part) => part.type).slice(-4)).toEqual([
        "text-delta",
        "text-end",
        "data-activity",
        "finish",
      ]);
      expect(received.at(-2)).toMatchObject({ data: { kind: "retry", attempt: 2 } });
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
      const deltas = (await readAll(reader)).filter((part) => part.type === "text-delta");
      expect(deltas.map((part) => part["delta"])).toEqual(["ab".repeat(1000), "!"]);
    } finally {
      streams.close();
    }
  });
});

/**
 * How `streamingWorklet` treats a message delivered into its running turn: with `withdraw`, the
 * turn reports it unread. The follower opens and finishes the message's own reply.
 */
interface Delivery {
  withdraw: boolean;
  ownReply?: {
    begin: PromiseWithResolvers<void>;
    finish: PromiseWithResolvers<void>;
  };
}

/** A Worklet whose one Worker writes its reply in deltas, waiting at `gate` before finishing. */
function streamingWorklet(
  gate: { promise: Promise<void> },
  received: string[] = [],
  delivery: Delivery = { withdraw: false },
): Worklet {
  const commands: string[] = [];
  let executions = 0;
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
      commands.push(command.id);
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
      executions += 1;
      const own = delivery.withdraw && executions > 1;
      yield { ...id, at: at(), type: "execution.started", workerId: "stream-worker" };
      if (own) await delivery.ownReply?.begin.promise;
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
      if (own) await delivery.ownReply?.finish.promise;
      if (delivery.withdraw && !own)
        for (const commandId of commands)
          yield { ...id, at: at(), type: "input.withdrawn", commandId };
      const summary = own
        ? "Answered the tests."
        : received.length > 0 && !delivery.withdraw
          ? "Answered both."
          : "All clean.";
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
  describe.skipIf(dialect === "postgresql" && !postgres)(`FollowMessage (${dialect})`, () => {
    let directory: string;
    let runtime: Awaited<ReturnType<typeof startControlPlaneRuntime>>;
    let store: DrizzleStore;
    let cleanup: (() => Promise<void>) | undefined;
    let release: () => void;
    let gate: { promise: Promise<void> };
    let received: string[];
    let delivery: Delivery;

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
      delivery = { withdraw: false };
      runtime = await startControlPlaneRuntime({
        host: "127.0.0.1",
        port: 0,
        databaseUrl,
        adminToken: ADMIN,
        worklet: streamingWorklet(gate, received, delivery),
      });
      store = new DrizzleStore({ url: databaseUrl });
      await store.connect();
      const tag = await store.createTag({ name: "planner" });
      await store.bindTagWorkerHost(tag.id, "stream-host");
    });

    afterEach(async () => {
      release();
      delivery.ownReply?.begin.resolve();
      delivery.ownReply?.finish.resolve();
      await store.disconnect();
      await runtime.close();
      await cleanup?.();
      await rm(directory, { recursive: true, force: true });
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
    });

    const conversations = (token = ADMIN) => conversationClient({ url: runtime.url, token });
    const send = (text: string, conversation = "work") =>
      conversations().sendMessage({ tag: "planner", conversation, text });

    /** Follows a message until `until` accepts an event, then cancels the call. */
    async function follow(
      taskId: string,
      until: (event: FollowEvent) => boolean,
      options: { readonly after?: bigint; readonly token?: string } = {},
    ): Promise<FollowEvent[]> {
      const abort = new AbortController();
      const events: FollowEvent[] = [];
      try {
        for await (const event of conversations(options.token).followMessage(
          { tag: "planner", taskId, afterSequence: options.after ?? 0n },
          { signal: abort.signal, timeoutMs: 0 },
        )) {
          events.push(event);
          if (until(event)) break;
        }
      } finally {
        abort.abort();
      }
      return events;
    }
    const ended = (event: FollowEvent) => event.part.case === "end";
    const linting = (event: FollowEvent) =>
      event.part.case === "activity" &&
      event.part.value.detail.case === "command" &&
      event.part.value.detail.value.status === ActivityStatus.RUNNING;
    const deltas = (events: readonly FollowEvent[]) =>
      events.flatMap((event) => (event.part.case === "textDelta" ? [event.part.value.text] : []));

    it("streams a running reply, resumes it, and serves a finished one's stored reply", async () => {
      const message = await send("Check the repository");
      const live = await follow(message.taskId, linting);
      expect(live.map((event) => event.part.case)).toEqual(["textDelta", "activity"]);
      expect(deltas(live)).toEqual(["Checking "]);
      expect(live[1]?.part).toMatchObject({
        case: "activity",
        value: {
          workSessionId: "",
          text: "running: pnpm lint",
          detail: { case: "command", value: { id: "c1", command: "pnpm lint" } },
        },
      });
      const [first, second] = live as [FollowEvent, FollowEvent];
      expect(second.sequence).toBeGreaterThan(first.sequence);

      // A follower that saw the first event resumes exactly after it.
      const resuming = follow(message.taskId, ended, { after: first.sequence });
      // A sequence this Control Plane never sent starts from the current state instead.
      const restarted = follow(message.taskId, ended, { after: 7n });
      await vi.waitFor(async () =>
        expect((await store.listTaskEvents(message.taskId)).length).toBeGreaterThan(0),
      );
      await new Promise((resolve) => setTimeout(resolve, 300));
      release();
      const resumed = await resuming;
      expect(equals(FollowEventSchema, resumed[0] as FollowEvent, second)).toBe(true);
      expect(deltas(resumed).join("")).toBe("All clean.");
      expect(resumed.slice(-2).map((event) => event.part.case)).toEqual(["finish", "end"]);
      expect(resumed.at(-2)?.part).toMatchObject({
        case: "finish",
        value: { reply: { presentation: ReplyPresentation.FINAL_RESULT, text: "All clean." } },
      });
      const fresh = await restarted;
      expect(deltas(fresh)).not.toContain("Checking ");
      expect(fresh.every((event) => event.sequence > 7n)).toBe(true);
      expect(fresh.at(-1)?.part.case).toBe("end");

      // After the finish, the stored reply arrives at once, without text.
      const late = await follow(message.taskId, ended);
      expect(late.map((event) => event.part.case)).toEqual(["finish", "end"]);
      expect(late[0]?.part).toMatchObject({ value: { reply: { text: "All clean." } } });

      // Reply text reaches readers through the stream; it is not stored as Task events.
      const events = await store.listTaskEvents(message.taskId);
      expect(events.some((event) => event.type === "execution.output.delta")).toBe(false);
      expect(events.some((event) => event.type === "execution.command.updated")).toBe(true);
    });

    it("hides another operator's message", async () => {
      const issued = { secret: await issueOperatorToken(runtime.url, ADMIN, "alice") };
      const message = await send("Check the repository");
      const refused = await follow(message.taskId, ended, { token: issued.secret }).catch(
        (error: unknown) => error,
      );
      expect(refused).toBeInstanceOf(ConnectError);
      expect((refused as ConnectError).code).toBe(Code.NotFound);
    });

    it("follows a joined message from the turn it joined, from the moment of the call", async () => {
      const first = await send("Check the repository");
      await follow(first.taskId, linting);
      const second = await send("Also check the tests");
      expect(second.joinedTaskId).toBe(first.taskId);
      await vi.waitFor(() => expect(received).toHaveLength(1));
      const joined = follow(second.taskId, ended);
      // Give the follower time to reach the joined turn before it finishes.
      await new Promise((resolve) => setTimeout(resolve, 600));
      release();
      const events = await joined;
      expect(events[0]?.part).toMatchObject({ case: "joined", value: { taskId: first.taskId } });
      // Only the joined turn's text after the call arrives, not its earlier text.
      expect(deltas(events)).not.toContain("Checking ");
      expect(events.at(-2)?.part).toMatchObject({
        case: "finish",
        value: { reply: { text: "Answered both." }, message: { taskId: second.taskId } },
      });
    });

    it("follows a message's own turn once its delivery into a running turn is withdrawn", async () => {
      delivery.withdraw = true;
      const ownReply = {
        begin: Promise.withResolvers<void>(),
        finish: Promise.withResolvers<void>(),
      };
      delivery.ownReply = ownReply;
      const first = await send("Check the repository");
      await follow(first.taskId, linting);
      const second = await send("Also check the tests");
      expect(second.joinedTaskId).toBe(first.taskId);
      await vi.waitFor(() => expect(received).toHaveLength(1));
      let withdrew = false;
      const events = await follow(second.taskId, (event) => {
        if (event.part.case === "joined" && event.part.value.taskId === first.taskId) release();
        if (event.part.case === "joined" && event.part.value.taskId === "") {
          withdrew = true;
          ownReply.begin.resolve();
        }
        // The first turn's gate is already open. Keep the second turn live until
        // the follower receives its prefix instead of racing its stored result.
        if (withdrew && event.part.case === "textDelta" && event.part.value.text === "Checking ")
          ownReply.finish.resolve();
        return ended(event);
      });
      expect(events.some((event) => event.part.case === "error")).toBe(false);
      const joins = events.flatMap((event) =>
        event.part.case === "joined" ? [event.part.value.taskId] : [],
      );
      expect(joins).toEqual([first.taskId, ""]);
      expect(deltas(events).join("")).toContain("Checking ");
      expect(events.at(-2)?.part).toMatchObject({
        case: "finish",
        value: { reply: { text: "Answered the tests." }, message: { taskId: second.taskId } },
      });
    });

    it("streams command activity before the final reply in one follow call", async () => {
      const { taskId } = await send("Check the repository");
      const events = await follow(taskId, (event) => {
        if (linting(event)) release();
        return ended(event);
      });
      const command = events.findIndex(linting);
      const finish = events.findIndex((event) => event.part.case === "finish");
      expect(events[command]?.part).toMatchObject({
        case: "activity",
        value: { detail: { case: "command", value: { command: "pnpm lint" } } },
      });
      expect(command).toBeLessThan(finish);
      expect(events[finish]?.part).toMatchObject({
        case: "finish",
        value: { reply: { text: "All clean." } },
      });
      expect(events.at(-1)?.part.case).toBe("end");
    });

    it("keeps the Task running when its follower disconnects", async () => {
      const { taskId } = await send("Check the repository");
      const events = await follow(taskId, linting);
      expect(events.some(linting)).toBe(true);
      expect((await store.findTaskById(taskId))?.status).toBe("running");

      release();
      await vi.waitFor(async () => {
        expect((await store.findTaskById(taskId))?.status).toBe("completed");
        const message = await conversations().getMessage({ tag: "planner", taskId });
        expect(message.reply?.text).toBe("All clean.");
      });
    });
  });
}
