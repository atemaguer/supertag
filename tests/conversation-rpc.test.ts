import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fromBinary } from "@bufbuild/protobuf";
import { Code } from "@connectrpc/connect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startControlPlaneRuntime } from "../apps/cli/src/control-plane-runtime.ts";
import { conversationClient } from "../apps/cli/src/operator-client.ts";
import {
  ConversationAuthor,
  ErrorDetailSchema,
  ErrorReason,
  ReplyStatus,
} from "../packages/operator-api/src/index.ts";
import { LocalWorklet, StaticWorker } from "../packages/runtime/sdk/src/index.ts";
import { DrizzleStore, migrateDatabase } from "../packages/store/src/index.ts";
import { createIsolatedPostgresDatabase } from "./support/database.ts";

const postgres = process.env["SUPERTAG_POSTGRES_URL"];
const ADMIN = "conversation-admin";
const SEND_MESSAGE = "/supertag.operator.v1.ConversationService/SendMessage";

for (const dialect of ["sqlite", "postgresql"] as const) {
  describe.skipIf(dialect === "postgresql" && !postgres)(`ConversationService (${dialect})`, () => {
    let directory: string;
    let runtime: Awaited<ReturnType<typeof startControlPlaneRuntime>>;
    let store: DrizzleStore;
    let cleanup: (() => Promise<void>) | undefined;
    let alice = "";

    beforeEach(async () => {
      directory = await mkdtemp(join(tmpdir(), "supertag-conversation-rpc-"));
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
        worklet: new LocalWorklet("conversation-worklet", "conversation-host", [
          new StaticWorker({
            id: "conversation-worker",
            profile: { id: "default", revision: "1" },
            text: "Hello from planner.",
          }),
        ]),
      });
      store = new DrizzleStore({ url: databaseUrl });
      await store.connect();
      const tag = await store.createTag({ name: "planner" });
      await store.bindTagWorkerHost(tag.id, "conversation-host");
      const issued = await fetch(`${runtime.url}/api/v1/operator-tokens`, {
        method: "POST",
        headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" },
        body: JSON.stringify({ kind: "OperatorToken", metadata: { name: "alice" } }),
      });
      alice = ((await issued.json()) as { secret: string }).secret;
    });

    afterEach(async () => {
      await store.disconnect();
      await runtime.close();
      await cleanup?.();
      await rm(directory, { recursive: true, force: true });
      vi.unstubAllEnvs();
    });

    /** `SendMessage` as `curl` sends it: a JSON POST. */
    const post = (body: unknown, token = ADMIN) =>
      fetch(`${runtime.url}${SEND_MESSAGE}`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    const reason = (body: { details?: { type: string; value: string }[] }) => {
      const detail = body.details?.find(({ type }) => type === "supertag.operator.v1.ErrorDetail");
      return detail === undefined
        ? undefined
        : ErrorReason[fromBinary(ErrorDetailSchema, Buffer.from(detail.value, "base64")).reason];
    };
    const conversations = (token = ADMIN) => conversationClient({ url: runtime.url, token });
    const replied = async (token: string, taskId: string) =>
      vi.waitFor(
        async () => {
          const message = await conversations(token).getMessage({ tag: "planner", taskId });
          expect(message.status).toBe(ReplyStatus.REPLIED);
          return message;
        },
        { timeout: 10_000 },
      );

    it("sends a message over plain Connect JSON and returns it before the reply", async () => {
      const response = await post({
        tag: "planner",
        conversation: "billing",
        text: "  Which step is riskiest?  ",
        idempotencyKey: "billing-0007",
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("application/json");
      const message = (await response.json()) as Record<string, unknown>;
      expect(message).toMatchObject({
        taskId: expect.any(String),
        tag: "planner",
        conversation: "billing",
        sessionId: expect.any(String),
        text: "Which step is riskiest?",
        createdAt: expect.stringMatching(/Z$/u),
      });
      expect(["REPLY_STATUS_WAITING", "REPLY_STATUS_REPLIED"]).toContain(message["status"]);

      // A repeat with the same key returns the first message and sends nothing, whatever it says.
      const again = (await (
        await post({ tag: "planner", text: "Something else", idempotencyKey: "billing-0007" })
      ).json()) as Record<string, unknown>;
      expect(again).toMatchObject({ taskId: message["taskId"], conversation: "billing" });
      expect(await store.listTasks()).toHaveLength(1);
      // The same key from another operator is that operator's own message.
      const hers = (await (
        await post({ tag: "planner", text: "Hers", idempotencyKey: "billing-0007" }, alice)
      ).json()) as Record<string, unknown>;
      expect(hers["taskId"]).not.toBe(message["taskId"]);
    });

    it("refuses what it cannot send with a stable reason", async () => {
      for (const [body, status, code, why] of [
        [{ tag: "planner", text: "   " }, 400, "invalid_argument", "INVALID_ARGUMENT"],
        [
          { tag: "planner", conversation: "a b", text: "hi" },
          400,
          "invalid_argument",
          "INVALID_ARGUMENT",
        ],
        [
          { tag: "planner", text: "hi", idempotencyKey: "has space" },
          400,
          "invalid_argument",
          "INVALID_ARGUMENT",
        ],
        [{ tag: "missing", text: "hi" }, 404, "not_found", "NOT_FOUND"],
      ] as const) {
        const response = await post(body);
        expect(response.status, JSON.stringify(body)).toBe(status);
        const refused = (await response.json()) as {
          code: string;
          details?: { type: string; value: string }[];
        };
        expect(refused.code).toBe(code);
        expect(reason(refused)).toBe(why);
      }
      expect(await store.listTasks()).toEqual([]);
    });

    it("lists each operator's own conversations and messages, newest first", async () => {
      const plan = await conversations().sendMessage({
        tag: "planner",
        conversation: "plan",
        text: "First plan",
      });
      await replied(ADMIN, plan.taskId);
      const later = await conversations().sendMessage({
        tag: "planner",
        conversation: "plan",
        text: "Second plan",
      });
      await replied(ADMIN, later.taskId);
      const other = await conversations().sendMessage({ tag: "planner", text: "Default" });
      const hers = await conversations(alice).sendMessage({
        tag: "planner",
        conversation: "plan",
        text: "Alice plan",
      });
      await replied(ADMIN, other.taskId);
      await replied(alice, hers.taskId);

      const mine = await conversations().listConversations({});
      expect(mine.conversations.map((conversation) => conversation.name)).toEqual([
        "default",
        "plan",
      ]);
      expect(mine.conversations[1]).toMatchObject({
        tag: "planner",
        sessionId: plan.sessionId,
        lastMessageText: "Hello from planner.",
        lastMessageAuthor: ConversationAuthor.TAG,
        openWorkSessionCount: 0,
      });
      expect(mine.nextPageToken).toBe("");
      const first = await conversations().listConversations({ tag: "planner", pageSize: 1 });
      expect(first.conversations.map((conversation) => conversation.name)).toEqual(["default"]);
      const second = await conversations().listConversations({
        pageSize: 1,
        pageToken: first.nextPageToken,
      });
      expect(second.conversations.map((conversation) => conversation.name)).toEqual(["plan"]);
      expect(second.nextPageToken).toBe("");
      expect(
        (await conversations(alice).listConversations({})).conversations.map(
          (conversation) => conversation.sessionId,
        ),
      ).toEqual([hers.sessionId]);

      const messages = await conversations().listMessages({ tag: "planner", conversation: "plan" });
      expect(messages.messages.map((message) => message.text)).toEqual([
        "Second plan",
        "First plan",
      ]);
      expect(messages.messages[0]).toMatchObject({
        status: ReplyStatus.REPLIED,
        reply: { text: "Hello from planner." },
      });
      const paged = await conversations().listMessages({
        tag: "planner",
        conversation: "plan",
        pageSize: 1,
      });
      expect(paged.messages.map((message) => message.taskId)).toEqual([later.taskId]);
      expect(
        (
          await conversations().listMessages({
            tag: "planner",
            conversation: "plan",
            pageToken: paged.nextPageToken,
          })
        ).messages.map((message) => message.taskId),
      ).toEqual([plan.taskId]);
      // The same conversation name is another Session for another operator.
      expect(
        (
          await conversations(alice).listMessages({ tag: "planner", conversation: "plan" })
        ).messages.map((message) => message.taskId),
      ).toEqual([hers.taskId]);
      await expect(
        conversations(alice).getMessage({ tag: "planner", taskId: plan.taskId }),
      ).rejects.toMatchObject({ code: Code.NotFound });
      await expect(conversations().listMessages({ tag: "missing" })).rejects.toMatchObject({
        code: Code.NotFound,
      });
      await expect(
        conversations().listConversations({ pageToken: "not-a-token" }),
      ).rejects.toMatchObject({ code: Code.InvalidArgument });
    });
  });
}
