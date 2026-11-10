import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Code } from "@connectrpc/connect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startControlPlaneRuntime } from "../apps/cli/src/control-plane-runtime.ts";
import { conversationClient } from "../apps/cli/src/operator-client.ts";
import {
  type Message,
  ReplyPresentation,
  ReplyStatus,
} from "../packages/operator-api/src/index.ts";
import { LocalWorklet, StaticWorker, type Worklet } from "../packages/runtime/sdk/src/index.ts";
import { DrizzleStore, migrateDatabase } from "../packages/store/src/index.ts";
import { createIsolatedPostgresDatabase } from "./support/database.ts";
import { issueOperatorToken } from "./support/operator-access.ts";

const postgres = process.env["SUPERTAG_POSTGRES_URL"];
const ADMIN = "test-administrative-token";

async function replyTo(client: ReturnType<typeof conversationClient>, sent: Message) {
  return vi.waitFor(
    async () => {
      const message = await client.getMessage({ tag: sent.tag, taskId: sent.taskId });
      expect(message.status).toBe(ReplyStatus.REPLIED);
      return message;
    },
    { timeout: 20_000 },
  );
}

for (const dialect of ["sqlite", "postgresql"] as const) {
  describe.skipIf(dialect === "postgresql" && !postgres)(
    `operator conversations (${dialect})`,
    () => {
      let directory: string;
      let runtime: Awaited<ReturnType<typeof startControlPlaneRuntime>>;
      let store: DrizzleStore;
      let cleanup: (() => Promise<void>) | undefined;

      beforeEach(async () => {
        directory = await mkdtemp(join(tmpdir(), "supertag-tag-conversation-"));
        let databaseUrl = `file:${join(directory, "supertag.db")}`;
        cleanup = undefined;
        if (dialect === "postgresql") {
          const isolated = await createIsolatedPostgresDatabase(postgres as string);
          databaseUrl = isolated.url;
          cleanup = isolated.cleanup;
        }
        await migrateDatabase({ url: databaseUrl });
        vi.stubEnv("SUPERTAG_STATE_DIR", join(directory, "server"));
        runtime = await startControlPlaneRuntime({
          host: "127.0.0.1",
          port: 0,
          databaseUrl,
          adminToken: ADMIN,
          worklet: new LocalWorklet("cli-worklet", "cli-host", [
            new StaticWorker({
              id: "cli-worker",
              profile: { id: "default", revision: "1" },
              text: "Hello from planner.",
            }),
          ]),
        });
        store = new DrizzleStore({ url: databaseUrl });
        await store.connect();
        const tag = await store.createTag({ name: "planner" });
        await store.bindTagWorkerHost(tag.id, "cli-host");
      });

      afterEach(async () => {
        await store.disconnect();
        await runtime.close();
        await cleanup?.();
        await rm(directory, { recursive: true, force: true });
        vi.restoreAllMocks();
        vi.unstubAllEnvs();
      });

      const send = async (token: string, text: string, conversation = "") => {
        const client = conversationClient({ url: runtime.url, token });
        return replyTo(client, await client.sendMessage({ tag: "planner", conversation, text }));
      };

      it("returns the Tag's reply and keeps the conversation's history", async () => {
        const first = await send(ADMIN, "First request", "plan");
        expect(first).toMatchObject({
          tag: "planner",
          conversation: "plan",
          text: "First request",
          status: ReplyStatus.REPLIED,
          reply: { presentation: ReplyPresentation.FINAL_RESULT, text: "Hello from planner." },
        });
        const second = await send(ADMIN, "Second request", "plan");
        expect(second.sessionId).toBe(first.sessionId);
        const task = await store.findTaskById(second.taskId);
        expect(task?.sessionHistory.map((entry) => entry.requestText)).toEqual(["First request"]);
        expect(task?.actor).toMatchObject({ id: "admin", kind: "user" });

        // The default conversation is a different Session.
        const other = await send(ADMIN, "Unrelated");
        expect(other.conversation).toBe("default");
        expect(other.sessionId).not.toBe(first.sessionId);

        // The direct reply is recorded as delivered without posting to an external surface.
        const inbound = await store.findInboundEventById(task?.inboundEventId ?? "");
        expect(inbound?.event).toMatchObject({
          provider: "cli",
          direct: true,
          sessionKey: "cli:admin:plan",
        });
        expect(inbound?.authorization.permissionSets).toEqual([]);
        // The Session is private to the operator who holds the conversation.
        const session = await store.findSessionById(second.sessionId);
        expect(session).toMatchObject({ audience: "private" });
        expect(session?.audienceActorKey).toMatch(/^cli:.+:admin$/u);
        await vi.waitFor(async () =>
          expect((await store.findOutboundReply(task?.inboundEventId ?? "", "final"))?.status).toBe(
            "delivered",
          ),
        );
        // The built-in CLI account is not a connected surface.
        expect(await store.listSurfaceAccounts()).toEqual([]);
      });

      it("keeps each operator's conversations private", async () => {
        const issued = { secret: await issueOperatorToken(runtime.url, ADMIN, "alice") };
        const mine = await send(ADMIN, "Admin request", "plan");
        const hers = await send(issued.secret, "Alice request", "plan");
        expect(hers.sessionId).not.toBe(mine.sessionId);
        const task = await store.findTaskById(hers.taskId);
        expect(task?.sessionHistory).toEqual([]);
        expect(task?.actor).toMatchObject({ id: "token:alice", kind: "user" });
        await expect(
          conversationClient({ url: runtime.url, token: issued.secret }).getMessage({
            tag: "planner",
            taskId: mine.taskId,
          }),
        ).rejects.toMatchObject({ code: Code.NotFound });
      });

      it("rejects an empty message and an invalid session name", async () => {
        await expect(send(ADMIN, "   ")).rejects.toThrow("The message is empty");
        await expect(send(ADMIN, "hi", "a b")).rejects.toThrow("conversation name");
        await expect(
          conversationClient({ url: runtime.url, token: ADMIN }).sendMessage({
            tag: "missing",
            text: "hi",
          }),
        ).rejects.toThrow("Tag missing does not exist");
      });
    },
  );

  describe.skipIf(dialect === "postgresql" && !postgres)(
    `operator message into a running Task (${dialect})`,
    () => {
      it("answers a message the running Task accepted with that Task's reply", async () => {
        const directory = await mkdtemp(join(tmpdir(), "supertag-tag-conversation-input-"));
        const isolated =
          dialect === "postgresql"
            ? await createIsolatedPostgresDatabase(postgres as string)
            : undefined;
        const databaseUrl = isolated?.url ?? `file:${join(directory, "supertag.db")}`;
        await migrateDatabase({ url: databaseUrl });
        vi.stubEnv("SUPERTAG_STATE_DIR", join(directory, "server"));
        let release!: () => void;
        const blocked = new Promise<void>((resolve) => {
          release = resolve;
        });
        let started = 0;
        const received: string[] = [];
        const worklet: Worklet = {
          id: "input-worklet",
          describe: async () => ({
            id: "input-worklet",
            protocolVersion: 1,
            host: {
              id: "input-host",
              workers: [
                {
                  profileCapabilities: [
                    {
                      profile: { id: "default", revision: "1" },
                      capabilities: [],
                      contextTypes: [],
                    },
                  ],
                  id: "input-worker",
                  type: "deterministic",
                  profiles: [{ id: "default", revision: "1" }],
                  capabilities: [],
                  contextTypes: [],
                  maxConcurrency: 2,
                },
              ],
            },
          }),
          controlCapabilities: async () => ({
            version: 1,
            operations: ["input"],
            inputMode: "queue",
          }),
          control: async (command) => {
            received.push(command.type === "input" ? command.text : "unexpected");
            return {
              id: command.id,
              taskId: command.taskId,
              attemptId: command.attemptId,
              status: "accepted",
            };
          },
          async *execute(spec) {
            started += 1;
            const identity = {
              taskId: spec.taskId,
              attemptId: spec.attemptId,
              at: new Date().toISOString(),
            };
            yield { ...identity, type: "execution.started", workerId: "input-worker" };
            await blocked;
            const summary = `Answered ${received.length + 1} messages.`;
            yield {
              ...identity,
              type: "output.message",
              message: { role: "teammate", text: summary },
            };
            yield {
              ...identity,
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
            yield { ...identity, type: "execution.completed" };
          },
        };
        const runtime = await startControlPlaneRuntime({
          host: "127.0.0.1",
          port: 0,
          databaseUrl,
          adminToken: ADMIN,
          worklet,
        });
        const store = new DrizzleStore({ url: databaseUrl });
        try {
          await store.connect();
          const tag = await store.createTag({ name: "planner" });
          await store.bindTagWorkerHost(tag.id, "input-host");
          const client = conversationClient({ url: runtime.url, token: ADMIN });
          const first = await client.sendMessage({
            tag: "planner",
            conversation: "work",
            text: "Inspect the project",
          });
          expect(first.status).toBe(ReplyStatus.WAITING);
          await vi.waitFor(() => expect(started).toBe(1));
          const second = await client.sendMessage({
            tag: "planner",
            conversation: "work",
            text: "Also inspect the tests",
          });
          await vi.waitFor(() => expect(received).toHaveLength(1));
          expect(received[0]).toContain("Also inspect the tests");
          release();
          const record = await replyTo(client, second);
          expect(record).toMatchObject({
            joinedTaskId: first.taskId,
            status: ReplyStatus.REPLIED,
            reply: { presentation: ReplyPresentation.FINAL_RESULT, text: "Answered 2 messages." },
          });
          expect(record.taskId).not.toBe(first.taskId);
          expect(started).toBe(1);
        } finally {
          await store.disconnect();
          await runtime.close();
          await isolated?.cleanup();
          await rm(directory, { recursive: true, force: true });
          vi.unstubAllEnvs();
        }
      });
    },
  );
}
