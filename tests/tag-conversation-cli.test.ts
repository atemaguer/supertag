import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeActionFirstCommand } from "../apps/cli/src/action-command.ts";
import { ControlPlaneClient } from "../apps/cli/src/control-plane-client.ts";
import { startControlPlaneRuntime } from "../apps/cli/src/control-plane-runtime.ts";
import { main } from "../apps/cli/src/index.ts";
import {
  runTagConversationCommand,
  type TagMessageRecord,
} from "../apps/cli/src/tag-conversation.ts";
import { LocalWorklet, StaticWorker } from "../packages/runtime/sdk/src/index.ts";
import { DrizzleStore, migrateDatabase } from "../packages/store/src/index.ts";
import { createIsolatedPostgresDatabase } from "./support/database.ts";

const postgres = process.env["SUPERTAG_POSTGRES_URL"];
const ADMIN = "test-administrative-token";

it("routes message tag to the CLI conversation", () => {
  expect(
    normalizeActionFirstCommand(["message", "tag", "planner", "hi", "--session", "plan"]),
  ).toEqual(["tag", "message", "planner", "hi", "--session", "plan"]);
});

for (const dialect of ["sqlite", "postgresql"] as const) {
  describe.skipIf(dialect === "postgresql" && !postgres)(`message tag (${dialect})`, () => {
    let directory: string;
    let runtime: Awaited<ReturnType<typeof startControlPlaneRuntime>>;
    let store: DrizzleStore;
    let cleanup: (() => Promise<void>) | undefined;
    let output: string[];

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
      output = [];
      vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
        output.push(String(chunk));
        return true;
      });
      vi.stubEnv("SUPERTAG_STATE_DIR", join(directory, "client"));
      vi.stubEnv("SUPERTAG_ADMIN_TOKEN", ADMIN);
      await expect(main(["connect", "control-plane", runtime.url])).resolves.toBe(0);
    });

    afterEach(async () => {
      await store.disconnect();
      await runtime.close();
      await cleanup?.();
      await rm(directory, { recursive: true, force: true });
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
    });

    const send = async (token: string, ...args: string[]) =>
      JSON.parse(
        await runTagConversationCommand({ url: runtime.url, token }, [
          "planner",
          ...args,
          "--output",
          "json",
        ]),
      ) as TagMessageRecord;

    it("prints the Tag's reply and keeps the conversation's history", async () => {
      output.length = 0;
      await expect(main(["message", "tag", "planner", "What are you working on?"])).resolves.toBe(
        0,
      );
      expect(output.join("")).toBe("Hello from planner.\n");

      const first = await send(ADMIN, "First request", "--session", "plan");
      expect(first).toMatchObject({
        kind: "TagMessage",
        tag: "planner",
        session: "plan",
        status: "replied",
        reply: { presentation: "final-result", text: "Hello from planner." },
      });
      const second = await send(ADMIN, "Second request", "--session", "plan");
      expect(second.sessionId).toBe(first.sessionId);
      const task = await store.findTaskById(second.taskId);
      expect(task?.sessionHistory.map((entry) => entry.requestText)).toEqual(["First request"]);
      expect(task?.actor).toMatchObject({ id: "admin", kind: "user" });

      // The default conversation is a different Session.
      const other = await send(ADMIN, "Unrelated");
      expect(other.session).toBe("default");
      expect(other.sessionId).not.toBe(first.sessionId);

      // A CLI conversation is direct; its reply is recorded as delivered, not posted anywhere.
      const inbound = await store.findInboundEventById(task?.inboundEventId ?? "");
      expect(inbound?.event).toMatchObject({
        provider: "cli",
        direct: true,
        sessionKey: "cli:admin:plan",
      });
      expect(inbound?.authorization.permissionSets).toEqual([]);
      await vi.waitFor(async () =>
        expect((await store.findOutboundReply(task?.inboundEventId ?? "", "final"))?.status).toBe(
          "delivered",
        ),
      );
      // The built-in CLI account is not a connected surface.
      expect(await store.listSurfaceAccounts()).toEqual([]);
    });

    it("keeps each operator's conversations private", async () => {
      const issued = await new ControlPlaneClient({ url: runtime.url, token: ADMIN }).request<{
        secret: string;
      }>("/api/v1/operator-tokens", {
        method: "POST",
        body: JSON.stringify({ kind: "OperatorToken", metadata: { name: "alice" } }),
      });
      const mine = await send(ADMIN, "Admin request", "--session", "plan");
      const hers = await send(issued.secret, "Alice request", "--session", "plan");
      expect(hers.sessionId).not.toBe(mine.sessionId);
      const task = await store.findTaskById(hers.taskId);
      expect(task?.sessionHistory).toEqual([]);
      expect(task?.actor).toMatchObject({ id: "token:alice", kind: "user" });
      await expect(
        new ControlPlaneClient({ url: runtime.url, token: issued.secret }).request(
          `/api/v1/tags/planner/messages/${mine.taskId}`,
        ),
      ).rejects.toMatchObject({ status: 404 });
    });

    it("rejects an empty message and an invalid session name", async () => {
      await expect(send(ADMIN, "   ")).rejects.toThrow("The message is empty");
      await expect(send(ADMIN, "hi", "--session", "a b")).rejects.toThrow("session name");
      await expect(
        runTagConversationCommand({ url: runtime.url, token: ADMIN }, ["missing", "hi"]),
      ).rejects.toThrow("Tag missing does not exist");
    });
  });
}
