import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { handleSessionRequest } from "../apps/cli/src/session-http.js";
import type { SurfaceCoordinationCaller } from "../packages/control-plane/src/objective-controller.js";
import { SessionContinuity } from "../packages/control-plane/src/session-continuity.js";
import { SessionPersistence } from "../packages/control-plane/src/session-persistence.js";
import {
  type SurfaceTagAuthorizationSnapshot,
  TagMessagingError,
} from "../packages/core/src/index.js";
import { HttpSessionStateStore } from "../packages/runtime/sdk/src/session-state-store.js";
import { DrizzleStore, migrateDatabase } from "../packages/store/src/index.js";
import { createIsolatedPostgresDatabase } from "./support/database.js";

const postgres = process.env["SUPERTAG_POSTGRES_URL"];
const profile = { id: "native", revision: "1" };
for (const provider of ["sqlite", "postgresql"] as const) {
  describe.skipIf(provider === "postgresql" && !postgres)(
    `${provider} Session persistence HTTP`,
    () => {
      const cleanups: Array<() => Promise<void>> = [];
      afterEach(async () => {
        for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
      });
      async function fixture() {
        const directory = await mkdtemp(join(tmpdir(), "supertag-session-http-"));
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
        const rotated = new Map<string, string>();
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
        const server = createServer((request, response) => {
          const target = new URL(request.url ?? "/", "http://localhost");
          if (target.pathname === "/internal/v1/coordination/rebind") {
            const token = request.headers.authorization?.slice(7) ?? "";
            const replacement = rotated.get(token);
            response.writeHead(replacement ? 200 : 401, { "content-type": "application/json" });
            response.end(
              JSON.stringify(replacement ? { token: replacement } : { error: "expired" }),
            );
            return;
          }
          void handleSessionRequest(request, response, target, persistence);
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        cleanups.push(
          () =>
            new Promise<void>((resolve, reject) => {
              server.closeAllConnections();
              server.close((error) => (error ? reject(error) : resolve()));
            }),
        );
        const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
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
          const client = new HttpSessionStateStore({ controlPlaneUrl: base, token });
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
          rotated,
          async reopen() {
            await store.disconnect();
            store = new DrizzleStore({ url });
            await store.connect();
            persistence = new SessionPersistence(store, authority);
          },
          async request(
            token: string | undefined,
            operation: string,
            body: unknown,
            method = "POST",
          ) {
            return fetch(`${base}/internal/v1/sessions/${operation}`, {
              method,
              ...(method === "GET"
                ? {}
                : { body: typeof body === "string" ? body : JSON.stringify(body) }),
              headers: {
                ...(token ? { authorization: `Bearer ${token}` } : {}),
                "content-type": "application/json",
              },
            });
          },
        };
      }

      it("archives on Worker A, reopens the database, and restores on Worker B using the same Session", async () => {
        const f = await fixture();
        const a = await f.work();
        await a.client.save(a.state);
        await expect(a.client.load(a.state.ref)).resolves.toEqual(a.state);
        await a.finish();
        await f.reopen();
        const b = await f.work();
        expect(b.task.sessionId).toBe(a.task.sessionId);
        await expect(b.client.load(a.state.ref)).resolves.toEqual(a.state);
        expect((await f.store.findSessionState(a.state.ref.id))?.status).toBe("resumable");
        await expect(a.client.save(a.state)).rejects.toThrow("authority expired");
      });

      it("keeps partial state inspectable but prevents another Attempt from resuming it", async () => {
        const f = await fixture();
        const a = await f.work();
        await a.client.save(a.state);
        await a.finish(false);
        const b = await f.work();
        expect((await f.store.findSessionState(a.state.ref.id))?.data).toEqual(a.state.data);
        await expect(b.client.load(a.state.ref)).resolves.toBeUndefined();
        const stored = await f.store.listSessionStates({ sessionId: a.task.sessionId });
        expect(stored[0]?.status).toBe("stored");
      });

      it("enforces Session identity and reference metadata, not earlier policy", async () => {
        const f = await fixture();
        const a = await f.work();
        await a.client.save(a.state);
        await a.finish();
        const foreign = await f.work({ sessionKey: "unrelated" });
        await expect(foreign.client.load(a.state.ref)).resolves.toBeUndefined();
        // Each Task Attempt runs under its own admitted policy, so a policy change still resumes.
        const b = await f.work({ changedPolicy: true });
        await expect(b.client.load(a.state.ref)).resolves.toEqual(a.state);
        await expect(b.client.load({ ...a.state.ref, uri: "another" })).resolves.toBeUndefined();
        await expect(b.client.load({ ...a.state.ref, format: "another" })).resolves.toBeUndefined();
        await b.client.save(b.state);
        await expect(
          b.client.load({ ...b.state.ref, digest: "tampered" }),
        ).resolves.toBeUndefined();
        const forged = await f.request(b.token, "save", { ...b.state, taskId: a.task.id });
        expect(forged.status).toBe(400);
      });

      it.each(["role", "reply destination"] as const)(
        "resumes natively across a %s change only when the reply audience is unchanged",
        async (change) => {
          const f = await fixture();
          const a = await f.work();
          await a.client.save(a.state);
          await a.finish();
          const b = await f.work(
            change === "role" ? { roleRevision: 2 } : { callbackThread: "different-audience" },
          );
          expect(b.task.sessionId).toBe(a.task.sessionId);
          expect(b.task.authorizationSnapshot.resources).toEqual(
            a.task.authorizationSnapshot.resources,
          );
          if (change === "role") {
            await expect(
              new SessionContinuity(f.store).readTask(b.task, b.attempt.id),
            ).resolves.toEqual(a.state.ref);
            await expect(b.client.load(a.state.ref)).resolves.toEqual(a.state);
            return;
          }
          await expect(
            new SessionContinuity(f.store).readTask(b.task, b.attempt.id),
          ).resolves.toBeUndefined();
          await expect(b.client.load(a.state.ref)).resolves.toBeUndefined();
        },
      );

      it("returns typed HTTP failures and rejects stale credentials before accepting input", async () => {
        const f = await fixture();
        const a = await f.work();
        for (const [operation, body, method, expected] of [
          ["unknown", {}, "POST", 404],
          ["load", {}, "GET", 405],
          ["save", "{broken", "POST", 400],
          ["save", {}, "POST", 400],
        ] as const) {
          const response = await f.request(a.token, operation, body, method);
          expect(response.status).toBe(expected);
          expect(response.headers.get("cache-control")).toBe("no-store");
          expect(await response.json()).toMatchObject({ error: expect.any(String) });
        }
        const denied = await f.request(undefined, "save", a.state);
        expect(denied.status).toBe(401);
        await expect(
          f.persistence.command("load", { ref: a.state.ref }, "bad-token"),
        ).rejects.toMatchObject({ statusCode: 401 });
        f.callers.delete(a.token);
        await expect(a.client.save(a.state)).rejects.toThrow("authority expired");
        expect(await f.store.findSessionState(a.state.ref.id)).toBeUndefined();
      });

      it("rejects late HTTP writes without replacing a newer transcript", async () => {
        const f = await fixture();
        const a = await f.work();
        const newer = { ...a.state, data: { transcript: "newest" }, writeVersion: 2 };
        expect((await f.request(a.token, "save", newer)).status).toBe(200);
        expect((await f.request(a.token, "save", { ...a.state, writeVersion: 1 })).status).toBe(
          409,
        );
        expect((await f.request(a.token, "save", newer)).status).toBe(200);
        expect((await f.request(a.token, "save", { ...a.state, writeVersion: 2 })).status).toBe(
          409,
        );
        expect((await f.request(a.token, "save", a.state)).status).toBe(400);
        await expect(a.client.load(a.state.ref)).resolves.toMatchObject({ data: newer.data });
      });

      it("bounds HTTP requests and local serialization and refreshes expired authority", async () => {
        const f = await fixture();
        const a = await f.work();
        const large = { ...a.state, data: { text: "x".repeat(16 * 1024 * 1024) } };
        await expect(a.client.save(large)).rejects.toThrow("16 MiB");
        const response = await f.request(a.token, "save", large);
        expect(response.status).toBe(413);
        const caller = f.callers.get(a.token);
        if (!caller) throw new Error("Missing caller");
        const fresh = randomUUID();
        f.callers.set(fresh, caller);
        f.rotated.set(a.token, fresh);
        f.callers.delete(a.token);
        await a.client.save(a.state);
        await expect(a.client.load(a.state.ref)).resolves.toEqual(a.state);
        expect(f.authentications).toBeGreaterThan(2);
      });
    },
  );
}
