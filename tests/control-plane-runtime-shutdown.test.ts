import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import { startControlPlaneRuntime } from "../apps/cli/src/control-plane-runtime.ts";
import {
  emptyTagContextPlan,
  type InboundSurfaceEvent,
  type Tag,
  type TagAuthorizationSnapshot,
} from "../packages/core/src/index.ts";
import { LocalWorklet, StaticWorker } from "../packages/runtime/sdk/src/index.ts";
import { DrizzleStore, FileGatewayCredentialVault } from "../packages/store/src/index.ts";
import { migrateSqlite } from "./support/database.ts";
import { createDurableTestConnection } from "./support/durable-test-connection.js";
import { enrollWorkerHost } from "./support/worker-host-enrollment.ts";

describe("Control Plane runtime shutdown", () => {
  it("keeps the remote Worklet connected until accepted work has drained", async () => {
    const directory = await mkdtemp(join(tmpdir(), "supertag-runtime-shutdown-"));
    const databasePath = join(directory, "supertag.db");
    const databaseUrl = `file:${databasePath}`;
    await migrateSqlite(databasePath);

    const seedStore = new DrizzleStore({ url: databaseUrl });
    await seedStore.connect();
    const event = remoteEvent();
    const account = await seedStore.saveSurfaceAccount({
      provider: "github",
      externalAccountId: event.externalAccountId,
      displayName: "Shutdown Test",
      authMethod: "simulation",
      credentialId: "simulation-unused",
      status: "connected",
      configuration: {},
      verifiedAt: event.occurredAt,
    });
    const tag = await seedStore.createTag({ name: "Shutdown Test" });
    await seedStore.bindTagWorkerHost(tag.id, "shutdown-host");
    const surface = await seedStore.addTagRoute({
      tagId: tag.id,
      surfaceAccountId: account.id,
      scope: event.scope,
    });
    await seedStore.disconnect();

    const adminToken = "runtime-shutdown-admin-token";
    const runtime = await startControlPlaneRuntime({
      host: "127.0.0.1",
      port: 0,
      databaseUrl,
      surfaceRefreshIntervalMs: 10,
      workletTransport: "remote",
      adminToken,
      credentialVault: new FileGatewayCredentialVault(join(directory, "vault.json")),
      reply: async () => {},
    });
    const executionAccepted = deferred<void>();
    const releaseExecution = deferred<void>();
    const worker = new StaticWorker({
      id: "shutdown-worker",
      profile: { id: "default", revision: "1" },
      text: "completed during shutdown",
    });
    const execute = worker.execute.bind(worker);
    let internalApiStatus: number | undefined;
    vi.spyOn(worker, "execute").mockImplementation(async function* (spec, signal) {
      executionAccepted.resolve();
      await releaseExecution.promise;
      internalApiStatus = (
        await fetch(`${runtime.url}/internal/v1/mailbox/receive`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        })
      ).status;
      yield* execute(spec, signal);
    });
    const credential = await enrollWorkerHost(runtime.url, adminToken, "shutdown-host");
    const client = createDurableTestConnection({
      url: `${runtime.url.replace("http://", "ws://")}/worklets`,
      credential,
      worklet: new LocalWorklet("shutdown-worklet", "shutdown-host", [worker]),
      reconnectIntervalMs: 5,
    });
    let runtimeClosed = false;

    try {
      await client.start();
      const admissionStore = new DrizzleStore({ url: databaseUrl });
      await admissionStore.connect();
      try {
        await admissionStore.admitInboundEvent({
          surfaceAccountId: account.id,
          tagRouteId: surface.id,
          tagId: tag.id,
          event,
          authorization: authorizationSnapshot(tag, surface, account, event),
          contextPlan: emptyTagContextPlan("2026-09-14T00:00:01.000Z"),
          maxAttempts: 3,
        });
      } finally {
        await admissionStore.disconnect();
      }

      await executionAccepted.promise;
      let closeResolved = false;
      const close = Promise.all([runtime.close(), runtime.close()]).then(() => {
        closeResolved = true;
        runtimeClosed = true;
      });
      await Promise.resolve();

      expect(closeResolved).toBe(false);
      expect(client.isConnected).toBe(true);

      releaseExecution.resolve();
      await close;
      expect(internalApiStatus).toBe(401);
      expect(lifecycleRows(databasePath)).toEqual({
        inboundStatus: "completed",
        outboundStatus: "delivered",
        text: "completed during shutdown",
      });
    } finally {
      releaseExecution.resolve();
      await client.stop();
      if (!runtimeClosed) await runtime.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});

function remoteEvent(): InboundSurfaceEvent {
  return {
    eventId: "runtime-shutdown-delivery",
    logicalEventId: "runtime-shutdown-logical",
    provider: "github",
    externalAccountId: "runtime-shutdown-test",
    kind: "mention",
    scope: "repository:supertag/runtime-shutdown",
    sessionKey: "github:supertag/runtime-shutdown:1",
    actor: { id: "runtime-user", kind: "user" },
    text: "complete this accepted Task during shutdown",
    occurredAt: "2026-09-14T00:00:00.000Z",
    callback: {
      provider: "github",
      mode: "github_issue_comment",
      threadKey: "supertag/runtime-shutdown#1",
      target: { repository: "supertag/runtime-shutdown", number: "1" },
    },
    source: { repository: "supertag/runtime-shutdown", issueNumber: "1" },
    metadata: { simulation: true },
  };
}

function authorizationSnapshot(
  tag: Pick<Tag, "id" | "name" | "workerProfile">,
  surface: { readonly id: string; readonly scope: string },
  account: { readonly id: string; readonly provider: "github" },
  event: InboundSurfaceEvent,
): TagAuthorizationSnapshot {
  return {
    version: 5,
    capturedAt: "2026-09-14T00:00:01.000Z",
    tag: { id: tag.id, name: tag.name },
    origin: {
      tagRouteId: surface.id,
      surfaceAccountId: account.id,
      provider: account.provider,
      scope: surface.scope,
    },
    requester: event.actor,
    permissionSets: [],
    resources: [],
    runtimeActions: [],
  };
}

function lifecycleRows(databasePath: string): {
  readonly inboundStatus: string | undefined;
  readonly outboundStatus: string | undefined;
  readonly text: string | undefined;
} {
  const database = new Database(databasePath, { readonly: true });
  try {
    const inbound = database
      .prepare("SELECT id, status FROM DurableInboundEvent WHERE deliveryId = ?")
      .get("runtime-shutdown-delivery") as { id: string; status: string } | undefined;
    const outbound = database
      .prepare("SELECT status, text FROM OutboundReply WHERE inboundEventId = ?")
      .get(inbound?.id) as { status: string; text: string } | undefined;
    return {
      inboundStatus: inbound?.status,
      outboundStatus: outbound?.status,
      text: outbound?.text,
    };
  } finally {
    database.close();
  }
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value?: T) => void;
} {
  let resolve: ((value: T | PromiseLike<T>) => void) | undefined;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve: (value) => resolve?.(value as T) };
}
