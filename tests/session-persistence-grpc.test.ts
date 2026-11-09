import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import { registerSessionGrpcRoutes } from "../apps/cli/src/session-grpc.js";
import type { SurfaceCoordinationCaller } from "../packages/control-plane/src/objective-controller.js";
import { SessionContinuity } from "../packages/control-plane/src/session-continuity.js";
import { SessionPersistence } from "../packages/control-plane/src/session-persistence.js";
import {
  type SurfaceTagAuthorizationSnapshot,
  TagMessagingError,
} from "../packages/core/src/index.js";
import {
  type RemoteWorkletServer,
  startWorkletGrpcServer,
} from "../packages/runtime/transport/src/index.js";
import { GrpcSessionStateStore } from "../packages/runtime/transport/src/session-client.js";
import {
  encodeSessionArchive,
  encodeSessionRef,
  SessionService,
  sessionArchiveDigest,
} from "../packages/runtime/transport/src/session-codec.js";
import { DrizzleStore, migrateDatabase } from "../packages/store/src/index.js";
import { createIsolatedPostgresDatabase } from "./support/database.js";

const postgres = process.env["SUPERTAG_POSTGRES_URL"];
const transportRequire = createRequire(
  new URL("../packages/runtime/transport/package.json", import.meta.url),
);
const { createClient } = transportRequire("@connectrpc/connect");
const { createGrpcTransport } = transportRequire("@connectrpc/connect-node");
const profile = { id: "native", revision: "1" };
for (const provider of ["sqlite", "postgresql"] as const) {
  describe.skipIf(provider === "postgresql" && !postgres)(
    `${provider} Session persistence gRPC`,
    () => {
      const cleanups: Array<() => Promise<void>> = [];
      afterEach(async () => {
        for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
      });
      async function fixture() {
        const directory = await mkdtemp(join(tmpdir(), "supertag-session-grpc-"));
        const isolated =
          provider === "postgresql"
            ? await createIsolatedPostgresDatabase(postgres as string)
            : undefined;
        const url = isolated?.url ?? `file:${join(directory, "state.db")}`;
        await migrateDatabase({ url });
        let store = new DrizzleStore({ url });
        await store.connect();
        cleanups.push(async () => {
          await store.disconnect();
          await isolated?.cleanup();
          await rm(directory, { recursive: true, force: true });
        });
        const tag = await store.createTag({ name: randomUUID() });
        const account = await store.saveSurfaceAccount({
          provider: "slack",
          externalAccountId: randomUUID(),
          displayName: "Session persistence",
          authMethod: "test",
          credentialId: "test",
          status: "connected",
          configuration: {},
          verifiedAt: new Date().toISOString(),
        });
        const route = await store.addTagRoute({
          tagId: tag.id,
          surfaceAccountId: account.id,
          scope: "channel:sessions",
        });
        const callers = new Map<string, SurfaceCoordinationCaller>();
        let authentications = 0;
        const authority = {
          async authenticateExecution(token: string | undefined) {
            authentications++;
            const caller = token === undefined ? undefined : callers.get(token);
            if (!caller) throw new TagMessagingError(401, "Invalid execution credential");
            return caller;
          },
        };
        let persistence = new SessionPersistence(store, authority);
        const openListener = (port = 0) =>
          startWorkletGrpcServer({
            port,
            remote: {} as RemoteWorkletServer,
            registerRoutes: (router) => {
              registerSessionGrpcRoutes(router, {
                execution: (token) => persistence.execution(token),
                command: (operation, value, token) => persistence.command(operation, value, token),
              } as SessionPersistence);
            },
          });
        let listener = await openListener();
        cleanups.push(() => listener.close());
        const base = listener.url;
        let sequence = 0;
        async function work(
          options: {
            sessionKey?: string;
            changedPolicy?: boolean;
            callbackThread?: string;
            roleRevision?: number;
          } = {},
        ) {
          const at = new Date(Date.now() + sequence++).toISOString();
          const sessionKey = options.sessionKey ?? "conversation";
          const authorization: SurfaceTagAuthorizationSnapshot = {
            version: 5,
            capturedAt: at,
            tag: { id: tag.id, name: tag.name },
            origin: {
              provider: "slack",
              surfaceAccountId: account.id,
              tagRouteId: route.id,
              scope: "channel:sessions",
            },
            requester: { id: "human", kind: "user" },
            roles: [
              {
                assignmentId: "stable-assignment",
                assignmentRevision: 1,
                role: {
                  id: "reviewer",
                  name: "Reviewer",
                  purpose: "Review evidence",
                  instructions: "Apply reviewed policy",
                  origin: "user",
                  revision: options.roleRevision ?? 1,
                  contextSetIds: [],
                  permissionSetIds: [],
                },
              },
            ],
            permissionSets: [],
            resources: [],
            runtimeActions: options.changedPolicy ? ["files:write"] : [],
          };
          const contextPlan = { version: 7, capturedAt: at, sets: [] } as const;
          const event = {
            eventId: randomUUID(),
            logicalEventId: randomUUID(),
            provider: "slack",
            externalAccountId: account.externalAccountId,
            kind: "message",
            scope: "channel:sessions",
            sessionKey,
            actor: { id: "human", kind: "user" },
            text: "Continue research",
            occurredAt: at,
            callback: {
              provider: "slack",
              mode: "slack_thread",
              threadKey: sessionKey,
              target: { channelId: "sessions", threadTs: options.callbackThread ?? sessionKey },
            },
            source: {},
            metadata: {},
          } as const;
          const admitted = await store.admitInboundEvent({
            surfaceAccountId: account.id,
            tagRouteId: route.id,
            tagId: tag.id,
            authorization,
            contextPlan,
            event,
          });
          const session = await store.openSession({ tagId: tag.id, sessionKey, origin: {}, at });
          const pending = await store.openTask({
            inboundEventId: admitted.work.id,
            tagId: tag.id,
            sessionId: session.id,
            execution: {},
            actor: event.actor,
            trigger: {},
            workspacePlan: { version: 1, status: "none" },
            sessionHistory: [],
            authorizationSnapshot: authorization,
            contextPlan,
            createdAt: at,
          });
          const task = await store.startTask({ taskId: pending.id, startedAt: at });
          const attempt = await store.createTaskAttempt({
            taskId: task.id,
            attemptNumber: 1,
            workerProfile: profile,
            workerSnapshot: {},
            startedAt: at,
          });
          const token = randomUUID();
          callers.set(token, { kind: "surface", taskId: task.id, attemptId: attempt.id });
          const client = new GrpcSessionStateStore({ baseUrl: base, token });
          const state = {
            harnessId: "codex",
            ref: {
              id: randomUUID(),
              uri: "supertag:session:test",
              format: "codex.native.v1",
              digest: "sha256:test",
              provenance: { threadId: randomUUID() },
            },
            data: {
              threadId: randomUUID(),
              portable: { transcripts: [{ path: "native.jsonl", text: "native transcript" }] },
            },
          };
          async function finish(promote = true) {
            if (promote)
              await new SessionContinuity(store).saveTask(task, profile, [
                {
                  taskId: task.id,
                  attemptId: attempt.id,
                  at,
                  type: "session.updated",
                  sessionState: state.ref,
                },
                { taskId: task.id, attemptId: attempt.id, at, type: "execution.completed" },
              ]);
            await store.closeTaskAttempt({
              attemptId: attempt.id,
              status: "completed",
              endedAt: at,
            });
            await store.closeTask({ taskId: task.id, status: "completed", endedAt: at });
          }
          return { task, attempt, token, client, state, finish };
        }
        return {
          get store() {
            return store;
          },
          get persistence() {
            return persistence;
          },
          get authentications() {
            return authentications;
          },
          work,
          base,
          callers,
          async reopen() {
            await listener.close();
            await store.disconnect();
            store = new DrizzleStore({ url });
            await store.connect();
            persistence = new SessionPersistence(store, authority);
            listener = await openListener(Number(new URL(base).port));
          },
        };
      }

      it("archives on Worker A, reopens persistence, and restores on Worker B in the same Session", async () => {
        const f = await fixture();
        const a = await f.work();
        // Force multiple chunks; archive data stays outside metadata messages.
        a.state.data.portable.transcripts = [
          { path: "native.jsonl", text: "native transcript ".repeat(40_000) },
        ];
        await a.client.save(a.state);
        await expect(a.client.load(a.state.ref)).resolves.toEqual(a.state);
        await a.finish();
        await f.reopen();
        const b = await f.work();
        expect(b.task.sessionId).toBe(a.task.sessionId);
        await expect(b.client.load(a.state.ref)).resolves.toEqual(a.state);
        expect((await f.store.findSessionState(a.state.ref.id))?.status).toBe("resumable");
        await expect(a.client.save(a.state)).rejects.toThrow();
      });

      it("prevents resuming partial state and foreign Sessions", async () => {
        const f = await fixture();
        const a = await f.work();
        await a.client.save(a.state);
        await a.finish(false);
        const b = await f.work();
        await expect(b.client.load(a.state.ref)).resolves.toBeUndefined();
        const foreign = await f.work({ sessionKey: "foreign" });
        await expect(foreign.client.load(a.state.ref)).resolves.toBeUndefined();
      });

      it.each(["permissions", "role"] as const)(
        "restores another Attempt's native state across a %s change",
        async (change) => {
          const f = await fixture();
          const a = await f.work();
          await a.client.save(a.state);
          await a.finish();
          const b = await f.work(
            change === "permissions" ? { changedPolicy: true } : { roleRevision: 2 },
          );
          await expect(b.client.load(a.state.ref)).resolves.toEqual(a.state);
        },
      );

      it("checks the reply destination before restoring another Attempt's native state", async () => {
        const f = await fixture();
        const a = await f.work();
        await a.client.save(a.state);
        await a.finish();
        const b = await f.work({ callbackThread: "other" });
        await expect(b.client.load(a.state.ref)).resolves.toBeUndefined();
      });

      it("rejects revoked credentials and changed reference metadata", async () => {
        const f = await fixture();
        const a = await f.work();
        await a.client.save(a.state);
        await expect(
          a.client.load({ ...a.state.ref, digest: "tampered" }),
        ).resolves.toBeUndefined();
        f.callers.delete(a.token);
        await expect(a.client.load(a.state.ref)).rejects.toThrow();
        await expect(a.client.save(a.state)).rejects.toThrow();
      });

      it("bounds native archives before upload", async () => {
        const f = await fixture();
        const a = await f.work();
        await expect(
          a.client.save({ ...a.state, data: { text: "x".repeat(16 * 1024 * 1024) } }),
        ).rejects.toThrow("16 MiB");
        expect(await f.store.findSessionState(a.state.ref.id)).toBeUndefined();
      });

      it("replays an exact write after reopen and rejects conflicting or stale versions", async () => {
        const f = await fixture();
        const a = await f.work();
        let raw = createClient(SessionService, createGrpcTransport({ baseUrl: f.base }));
        const options = { headers: { authorization: `Bearer ${a.token}` }, timeoutMs: 5000 };
        const bytes = encodeSessionArchive(a.state.data);
        const header = {
          ref: encodeSessionRef(a.state.ref),
          harnessId: a.state.harnessId,
          writeVersion: 2n,
          archiveSize: bytes.length,
          archiveSha256: sessionArchiveDigest(bytes),
        };
        async function* frames(writeVersion = 2n, archive = bytes) {
          yield {
            frame: {
              case: "header",
              value: {
                ...header,
                writeVersion,
                archiveSize: archive.length,
                archiveSha256: sessionArchiveDigest(archive),
              },
            },
          };
          yield { frame: { case: "chunk", value: archive } };
        }
        await expect(raw.save(frames(), options)).resolves.toMatchObject({ writeVersion: 2n });
        await f.reopen();
        raw = createClient(SessionService, createGrpcTransport({ baseUrl: f.base }));
        await expect(raw.save(frames(), options)).resolves.toMatchObject({ writeVersion: 2n });
        await expect(raw.save(frames(1n), options)).rejects.toMatchObject({ code: 9 });
        await expect(
          raw.save(frames(2n, encodeSessionArchive({ text: "changed" })), options),
        ).rejects.toMatchObject({ code: 9 });
        const restored = new GrpcSessionStateStore({ baseUrl: f.base, token: a.token });
        await expect(restored.load(a.state.ref)).resolves.toEqual(a.state);
      });

      it("rejects incomplete, repeated-header, invalid JSON, and oversized streams without committing", async () => {
        const f = await fixture();
        const a = await f.work();
        const raw = createClient(SessionService, createGrpcTransport({ baseUrl: f.base }));
        const options = { headers: { authorization: `Bearer ${a.token}` }, timeoutMs: 5000 };
        const bytes = encodeSessionArchive(a.state.data);
        const header = {
          ref: encodeSessionRef(a.state.ref),
          harnessId: a.state.harnessId,
          writeVersion: 1n,
          archiveSize: bytes.length,
          archiveSha256: sessionArchiveDigest(bytes),
        };
        for (const mode of ["truncated", "repeated", "oversized", "json", "checksum"] as const) {
          async function* frames() {
            const data = mode === "json" ? Buffer.from("[]") : bytes;
            yield {
              frame: {
                case: "header",
                value: {
                  ...header,
                  archiveSize: mode === "oversized" ? 17 * 1024 * 1024 : data.length,
                  archiveSha256: mode === "checksum" ? "0".repeat(64) : sessionArchiveDigest(data),
                },
              },
            };
            if (mode === "repeated") yield { frame: { case: "header", value: header } };
            if (mode !== "truncated") yield { frame: { case: "chunk", value: data } };
          }
          await expect(raw.save(frames(), options)).rejects.toMatchObject({
            code: mode === "oversized" ? 8 : 3,
          });
          expect(await f.store.findSessionState(a.state.ref.id)).toBeUndefined();
        }
      });

      it("rechecks Attempt authority after receiving the archive and denies host tokens", async () => {
        const f = await fixture();
        const a = await f.work();
        const raw = createClient(SessionService, createGrpcTransport({ baseUrl: f.base }));
        const bytes = encodeSessionArchive(a.state.data);
        async function* frames(revoke = false) {
          const before = f.authentications;
          yield {
            frame: {
              case: "header",
              value: {
                ref: encodeSessionRef(a.state.ref),
                harnessId: a.state.harnessId,
                writeVersion: 1n,
                archiveSize: bytes.length,
                archiveSha256: sessionArchiveDigest(bytes),
              },
            },
          };
          if (revoke) {
            while (f.authentications === before) await delay(1);
            f.callers.delete(a.token);
          }
          yield { frame: { case: "chunk", value: bytes } };
        }
        await expect(
          raw.save(frames(), {
            headers: { authorization: "Bearer worker-host-token" },
            timeoutMs: 5000,
          }),
        ).rejects.toMatchObject({ code: 16 });
        await expect(
          raw.save(frames(true), {
            headers: { authorization: `Bearer ${a.token}` },
            timeoutMs: 5000,
          }),
        ).rejects.toMatchObject({ code: 16 });
        expect(await f.store.findSessionState(a.state.ref.id)).toBeUndefined();
      });

      it("refuses an expired per-Attempt credential without writing", async () => {
        const f = await fixture();
        const a = await f.work();
        f.callers.delete(a.token);
        const client = new GrpcSessionStateStore({ baseUrl: f.base, token: a.token });
        await expect(client.save(a.state)).rejects.toMatchObject({ code: 16 });
        expect(await f.store.findSessionState(a.state.ref.id)).toBeUndefined();
      });

      it("requires a bounded deadline before accepting archive frames", async () => {
        const f = await fixture();
        const a = await f.work();
        const raw = createClient(SessionService, createGrpcTransport({ baseUrl: f.base }));
        async function* frames() {
          yield { frame: { case: "chunk", value: Buffer.from("{}") } };
        }
        await expect(
          raw.save(frames(), { headers: { authorization: `Bearer ${a.token}` } }),
        ).rejects.toMatchObject({ code: 3 });
        await expect(
          raw.save(frames(), {
            headers: { authorization: `Bearer ${a.token}` },
            timeoutMs: 120_000,
          }),
        ).rejects.toMatchObject({ code: 3 });
        expect(await f.store.findSessionState(a.state.ref.id)).toBeUndefined();
      });
    },
  );
}
