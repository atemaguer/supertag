import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerMailboxGrpcRoutes } from "../apps/cli/src/mailbox-grpc.js";
import { TagMailboxService } from "../packages/control-plane/src/mailbox.js";
import { MailboxService } from "../packages/runtime/transport/src/gen/supertag/mailbox/v1/mailbox_pb.js";
import {
  type RemoteWorkletServer,
  startWorkletGrpcServer,
} from "../packages/runtime/transport/src/index.js";
import { TagMailboxClient } from "../packages/runtime/transport/src/mailbox-client.js";
import { DrizzleStore, migrateDatabase } from "../packages/store/src/index.js";
import { createIsolatedPostgresDatabase } from "./support/database.js";

const transportRequire = createRequire(
  new URL("../packages/runtime/transport/package.json", import.meta.url),
);
const { createClient } = transportRequire("@connectrpc/connect");
const { createGrpcTransport } = transportRequire("@connectrpc/connect-node");

for (const dialect of ["sqlite", "postgresql"] as const) {
  describe.skipIf(dialect === "postgresql" && !process.env["SUPERTAG_POSTGRES_URL"])(
    `${dialect} mailbox gRPC`,
    () => {
      const cleanup: (() => Promise<void>)[] = [];
      afterEach(async () => {
        vi.restoreAllMocks();
        for (const close of cleanup.splice(0).reverse()) await close();
      });
      async function fixture() {
        const directory = await mkdtemp(join(tmpdir(), "mailbox-grpc-"));
        cleanup.push(() => rm(directory, { recursive: true, force: true }));
        const pg =
          dialect === "postgresql"
            ? await createIsolatedPostgresDatabase(process.env["SUPERTAG_POSTGRES_URL"] as string)
            : undefined;
        if (pg) cleanup.push(pg.cleanup);
        const url = pg?.url ?? `file:${join(directory, "state.db")}`;
        await migrateDatabase({ url });
        let store = new DrizzleStore({ url });
        await store.connect();
        cleanup.push(() => store.disconnect());
        let service = new TagMailboxService(store);
        const sender = await store.createTag({ name: "Sender" });
        const recipient = await store.createTag({ name: "Recipient" });
        const credentialA = await service.issueCredential(sender.id);
        const credentialB = await service.issueCredential(recipient.id);
        await store.setTagMessagingGrant({
          senderTagId: sender.id,
          recipientTagId: recipient.id,
          messageTypes: ["message"],
        });
        const open = (port = 0) =>
          startWorkletGrpcServer({
            port,
            remote: {} as RemoteWorkletServer,
            registerRoutes: (router) => registerMailboxGrpcRoutes(router, service),
          });
        let listener = await open();
        cleanup.push(() => listener.close());
        const baseUrl = listener.url;
        const client = (token: string) =>
          new TagMailboxClient({ controlPlaneUrl: baseUrl, token, transport: "grpc" });
        let a = client(credentialA.token),
          b = client(credentialB.token);
        const message = {
          recipientTagId: recipient.id,
          objectiveId: "objective",
          type: "message" as const,
          idempotencyKey: "stable-message",
          body: { text: "Retain this evidence", number: 0, flag: false },
        };
        return {
          get store() {
            return store;
          },
          get service() {
            return service;
          },
          get a() {
            return a;
          },
          get b() {
            return b;
          },
          client,
          sender,
          recipient,
          credentialA,
          credentialB,
          message,
          baseUrl,
          async restart() {
            await listener.close();
            await store.disconnect();
            store = new DrizzleStore({ url });
            await store.connect();
            service = new TagMailboxService(store);
            listener = await open(Number(new URL(baseUrl).port));
            a = client(credentialA.token);
            b = client(credentialB.token);
          },
        };
      }
      it("preserves message identities, history and lease fencing through listener/database restart", async () => {
        const f = await fixture();
        const sent = await f.a.send(f.message);
        expect(sent.duplicate).toBe(false);
        expect(await f.a.send(f.message)).toMatchObject({
          duplicate: true,
          message: { id: sent.message.id, body: f.message.body },
        });
        await expect(f.a.send({ ...f.message, body: { changed: true } })).rejects.toMatchObject({
          statusCode: 409,
        });
        const delivery = await f.b.receive({ leaseMs: 60_000 });
        if (!delivery) throw new Error("No delivery");
        await expect(f.a.acknowledge(delivery)).rejects.toMatchObject({ statusCode: 409 });
        await f.b.renew(delivery);
        await f.restart();
        await f.b.acknowledge(delivery);
        await f.b.acknowledge(delivery);
        expect(await f.b.receive()).toBeUndefined();
        expect(await f.a.history()).toMatchObject({
          items: [{ id: sent.message.id, status: "processed", body: f.message.body }],
        });
        await f.a.send({ ...f.message, idempotencyKey: "second" });
        const history = await f.a.history({ limit: 1 });
        expect(history.nextCursor).toBeDefined();
        expect((await f.a.history({ before: history.nextCursor, limit: 1 })).items[0]?.id).toBe(
          sent.message.id,
        );
      });
      it("preserves ongoing responsibility through gRPC and restart", async () => {
        const f = await fixture();
        const objective = await f.a.createObjective({
          id: "ongoing",
          outcome: "Maintain service",
          ongoing: true,
        });
        expect(objective.ongoing).toBe(true);
        await f.restart();
        expect((await f.a.getObjective(objective.id)).ongoing).toBe(true);
      });
      it("uses existing Objective permissions, revisions, and Team channel post receipts", async () => {
        const f = await fixture();
        await expect(
          f.a.createObjective({
            id: "forbidden",
            outcome: "No escalation",
            runtimeActions: [],
          }),
        ).rejects.toMatchObject({ statusCode: 403 });
        await expect(
          f.a.createObjective({
            id: "forbidden-observations",
            outcome: "Observe service",
            observations: [{ workstreamId: "measurements" }],
          }),
        ).rejects.toMatchObject({ statusCode: 403 });
        const objective = await f.a.createObjective({
          id: "objective",
          outcome: "Coordinate work",
          budgetLimitMinor: 0,
        });
        expect(objective).toMatchObject({ budgetLimitMinor: 0, ownerTagId: f.sender.id });
        expect(await f.a.getObjective(objective.id)).toEqual(objective);
        expect(await f.a.listObjectives()).toEqual([objective]);
        await expect(f.b.getObjective(objective.id)).rejects.toMatchObject({ statusCode: 404 });
        // The store creates a Team's channel with the Team; its ID is the Team ID.
        await f.store.createTeam({
          id: "stream",
          objectiveId: objective.id,
          name: "Shared work",
          leadTagId: f.sender.id,
          memberTagIds: [f.sender.id, f.recipient.id],
        });
        const workstream = await f.b.getWorkstream("stream");
        expect(workstream).toMatchObject({
          id: "stream",
          objectiveId: objective.id,
          title: "Shared work",
          ownerTagId: f.sender.id,
          participantTagIds: [f.sender.id, f.recipient.id].sort(),
        });
        expect(workstream).not.toHaveProperty("status");
        expect(workstream).not.toHaveProperty("revision");
        expect(await f.a.getWorkstream(workstream.id)).toEqual(workstream);
        expect(await f.b.listWorkstreams()).toEqual([workstream]);
        const postInput = {
          body: "Evidence found",
          type: "question" as const,
          to: [f.sender.id],
          references: ["artifact:result"],
          idempotencyKey: "post",
        };
        const post = await f.b.postWorkstream(workstream.id, postInput);
        expect(post).toMatchObject({ type: "question", to: [f.sender.id] });
        expect(await f.b.postWorkstream(workstream.id, postInput)).toEqual(post);
        expect(await f.a.workstreamPosts(workstream.id, { afterSequence: 0 })).toEqual([post]);
        expect(await f.a.workstreamPosts(workstream.id, { afterSequence: post.sequence })).toEqual(
          [],
        );
        // An omitted type is a note addressed to no one; a blocker without to reaches the lead.
        expect(
          await f.a.postWorkstream(workstream.id, { body: "Started", idempotencyKey: "note" }),
        ).toMatchObject({ type: "note", to: [] });
        expect(
          await f.b.postWorkstream(workstream.id, {
            body: "Need access",
            type: "blocker",
            idempotencyKey: "blocker",
          }),
        ).toMatchObject({ type: "blocker", to: [f.sender.id] });
        await expect(
          f.b.postWorkstream(workstream.id, {
            body: "Hello",
            to: ["stranger"],
            idempotencyKey: "stranger",
          }),
        ).rejects.toMatchObject({ statusCode: 400 });
        expect(
          await f.a.updateObjectiveStatus(objective.id, {
            expectedRevision: objective.revision,
            status: "blocked",
          }),
        ).toMatchObject({ status: "blocked" });
      });
      it("offers no RPC that creates, updates, or reads message history of a Workstream", async () => {
        const f = await fixture();
        const methods = MailboxService.methods.map((method) => method.name);
        expect(methods).toEqual(
          expect.arrayContaining(["GetWorkstream", "ListWorkstreams", "PostWorkstream"]),
        );
        for (const removed of [
          "CreateWorkstream",
          "UpdateWorkstream",
          "UpdateWorkstreamStatus",
          "WorkstreamMessages",
        ])
          expect(methods).not.toContain(removed);
        // A Mailbox message no longer names a Workstream.
        await expect(
          f.a.send({ ...f.message, workstreamId: "stream" } as typeof f.message),
        ).rejects.toThrow(/workstreamId/u);
      });
      it("cancels polling, checks revocation during polling and fences explicit failed release", async () => {
        const f = await fixture();
        const abort = new AbortController();
        const polling = f.b.receive({ waitMs: 20_000 }, abort.signal);
        const cancelled = expect(polling).rejects.toMatchObject({ statusCode: 499 });
        await new Promise((resolve) => setTimeout(resolve, 30));
        abort.abort();
        await cancelled;
        await f.a.send(f.message);
        const delivery = await f.b.receive();
        if (!delivery) throw new Error("Missing delivery");
        await f.b.release(delivery, false);
        expect((await f.b.history()).items[0]?.status).toBe("failed");
        expect(await f.b.receive()).toBeUndefined();
        const revoked = expect(f.b.receive({ waitMs: 20_000 })).rejects.toMatchObject({
          statusCode: 401,
        });
        await new Promise((resolve) => setTimeout(resolve, 30));
        await f.store.revokeTagMailboxCredential(f.credentialB.id);
        await revoked;
      });
      it("retries an ambiguous acknowledgement receipt without repeating the handler", async () => {
        const f = await fixture();
        await f.a.send(f.message);
        const original = f.service.settle.bind(f.service);
        let acknowledgements = 0;
        vi.spyOn(f.service, "settle").mockImplementation(async (...args) => {
          await original(...args);
          if (args[2] === "ack" && ++acknowledgements === 1)
            throw new Error("Lost acknowledgement");
        });
        const abort = new AbortController();
        const handler = vi.fn(async () => {});
        const loop = f.b.consume(handler, abort.signal);
        try {
          await vi.waitFor(() => expect(acknowledgements).toBe(2), { timeout: 3_000 });
        } finally {
          abort.abort();
          await loop;
        }
        expect(handler).toHaveBeenCalledTimes(1);
      });
      it("bounds requests, validates typed bodies and requires deadlines before domain dispatch", async () => {
        const f = await fixture();
        const raw = createClient(MailboxService, createGrpcTransport({ baseUrl: f.baseUrl }));
        const send = vi.spyOn(f.service, "send");
        await expect(
          raw.receive({}, { headers: { authorization: `Bearer ${f.credentialB.token}` } }),
        ).rejects.toMatchObject({ code: 3 });
        await expect(
          raw.send(
            { bodyJson: new TextEncoder().encode("{") },
            {
              timeoutMs: 1000,
              headers: { authorization: `Bearer ${f.credentialA.token}` },
            },
          ),
        ).rejects.toMatchObject({ code: 3 });
        await expect(
          f.a.send({ ...f.message, body: { content: "x".repeat(70_000) } }),
        ).rejects.toMatchObject({ statusCode: 400 });
        expect(send).not.toHaveBeenCalled();
        const stranger = await f.store.createTag({ name: "No grant" });
        await expect(f.a.send({ ...f.message, recipientTagId: stranger.id })).rejects.toMatchObject(
          { statusCode: 403 },
        );
      });
      it("receives a full 200-message history page with maximum-size bodies", async () => {
        const f = await fixture();
        const sent = await f.a.send(f.message);
        const body = { content: "x".repeat(65_520) };
        expect(Buffer.byteLength(JSON.stringify(body))).toBeLessThanOrEqual(65_536);
        const items = Array.from({ length: 200 }, (_, index) => ({
          ...sent.message,
          id: `history-${index}`,
          body,
        }));
        // Isolate framing capacity; authorization and database pagination are covered above.
        vi.spyOn(f.service, "history").mockResolvedValue({ items });
        expect(Buffer.byteLength(JSON.stringify(items))).toBeGreaterThan(8 * 1024 * 1024);
        const page = await f.a.history({ limit: 200 });
        expect(page.items).toHaveLength(200);
        expect(page.items[0]?.body).toEqual(body);
        expect(page.items[199]).toMatchObject({ id: "history-199", body });
      });
      it("reserves command capacity while long polls are saturated and releases aborted poll slots", async () => {
        const f = await fixture();
        const receive = vi
          .spyOn(f.service, "receive")
          .mockImplementation(async (_token, _input, signal) => {
            await new Promise<void>((resolve) =>
              signal?.addEventListener("abort", () => resolve(), { once: true }),
            );
            return undefined;
          });
        const abort = new AbortController();
        const polls = Array.from({ length: 64 }, () =>
          f.b.receive({ waitMs: 20_000 }, abort.signal).catch(() => undefined),
        );
        try {
          await vi.waitFor(() => expect(receive).toHaveBeenCalledTimes(64), { timeout: 3_000 });
          await expect(f.b.receive({ waitMs: 20_000 })).rejects.toMatchObject({ statusCode: 429 });
          await expect(f.a.send(f.message)).resolves.toMatchObject({ duplicate: false });
        } finally {
          abort.abort();
          await Promise.all(polls);
        }
        receive.mockRestore();
        await vi.waitFor(async () => expect(await f.b.receive()).toBeDefined());
      });
    },
  );
}
