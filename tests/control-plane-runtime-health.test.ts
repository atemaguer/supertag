import { createHmac } from "node:crypto";
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
import {
  DurableLocalWorklet,
  FileAttemptJournal,
  LocalWorklet,
  StaticWorker,
} from "../packages/runtime/sdk/src/index.ts";
import { WorkletConnection } from "../packages/runtime/transport/src/index.ts";
import { DrizzleStore, FileGatewayCredentialVault } from "../packages/store/src/index.ts";
import { migrateSqlite as migrateSqliteDatabase } from "./support/database.ts";
import { enrollWorkerHost } from "./support/worker-host-enrollment.ts";

describe("Control Plane runtime health", () => {
  it("reports liveness and readiness with an empty durable store", async () => {
    const directory = await mkdtemp(join(tmpdir(), "supertag-runtime-health-"));
    const databasePath = join(directory, "supertag.db");
    await migrateSqlite(databasePath);
    const runtime = await startControlPlaneRuntime({
      host: "127.0.0.1",
      port: 0,
      databaseUrl: `file:${databasePath}`,
      surfaceRefreshIntervalMs: 10,
    });

    try {
      const health = await fetch(`${runtime.url}/healthz`);
      expect(health.status).toBe(200);
      await expect(health.json()).resolves.toEqual({
        ok: true,
        version: expect.any(String),
        buildIdentity: expect.any(String),
      });

      const readiness = await fetch(`${runtime.url}/readyz`);
      expect(readiness.status).toBe(200);
      await expect(readiness.json()).resolves.toEqual({
        ok: true,
        controlPlane: "accepting",
        objectives: "ready",
        surfaces: { active: 0, errors: [] },
      });
    } finally {
      await runtime.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each(["websocket", "grpc"] as const)(
    "becomes ready and dispatches durable work over %s",
    async (transport) => {
      const directory = await mkdtemp(join(tmpdir(), "supertag-runtime-remote-worklet-"));
      const databasePath = join(directory, "supertag.db");
      await migrateSqlite(databasePath);
      const databaseUrl = `file:${databasePath}`;
      const seedStore = new DrizzleStore({ url: databaseUrl });
      await seedStore.connect();
      const account = await seedStore.saveSurfaceAccount({
        provider: "github",
        externalAccountId: "remote-runtime-test",
        displayName: "Remote Runtime Test",
        authMethod: "simulation",
        credentialId: "simulation-unused",
        status: "connected",
        configuration: {},
        verifiedAt: "2026-07-31T23:00:00.000Z",
      });
      const tag = await seedStore.createTag({ name: "Remote Runtime" });
      await seedStore.bindTagWorkerHost(tag.id, "host-static");
      const surface = await seedStore.addTagRoute({
        tagId: tag.id,
        surfaceAccountId: account.id,
        scope: remoteEvent().scope,
      });
      await seedStore.disconnect();

      const adminToken = "runtime-remote-admin-token";
      const runtime = await startControlPlaneRuntime({
        host: "127.0.0.1",
        port: 0,
        databaseUrl,
        surfaceRefreshIntervalMs: 10,
        workletTransport: "remote",
        ...(transport === "grpc" ? { workletGrpc: { port: 0 } } : {}),
        adminToken,
        reply: async () => {},
      });
      const worker = new StaticWorker({
        id: "host-static-worker",
        profile: { id: "default", revision: "1" },
        text: "executed on host",
      });
      const execute = vi.spyOn(worker, "execute");
      const worklet = new LocalWorklet("worklet-static", "host-static", [worker]);
      const durable = new DurableLocalWorklet(
        worklet,
        new FileAttemptJournal(join(directory, "journal")),
      );
      const credential = await enrollWorkerHost(runtime.url, adminToken, "host-static");
      const client = new WorkletConnection({
        url: runtime.workletGrpcUrl ?? `${runtime.url.replace("http://", "ws://")}/worklets`,
        transport,
        durableWorklet: durable,
        credential,
        worklet,
        reconnectIntervalMs: 5,
      });

      try {
        const before = await fetch(`${runtime.url}/readyz`);
        expect(before.status).toBe(503);
        await expect(before.json()).resolves.toMatchObject({
          ok: false,
          worklet: { status: "disconnected" },
        });

        await client.start();
        const ready = await fetch(`${runtime.url}/readyz`);
        expect(ready.status).toBe(200);
        await expect(ready.json()).resolves.toMatchObject({
          ok: true,
          controlPlane: "accepting",
          worklet: { status: "connected", id: "worklet-static" },
        });

        const admissionStore = new DrizzleStore({ url: databaseUrl });
        await admissionStore.connect();
        try {
          const inbound = remoteEvent();
          await admissionStore.admitInboundEvent({
            surfaceAccountId: account.id,
            tagRouteId: surface.id,
            tagId: tag.id,
            event: inbound,
            authorization: authorizationSnapshot(tag, surface, account, inbound),
            contextPlan: emptyTagContextPlan("2026-08-01T00:00:00.000Z"),
            maxAttempts: 3,
          });
        } finally {
          await admissionStore.disconnect();
        }

        await vi.waitFor(
          () => {
            expect(execute).toHaveBeenCalledWith(
              expect.objectContaining({
                version: 2,
                tag: { id: tag.id, name: tag.name },
                input: expect.objectContaining({
                  origin: expect.objectContaining({
                    scope: remoteEvent().scope,
                    sessionKey: remoteEvent().sessionKey,
                  }),
                }),
                workerProfile: { id: "default", revision: "1" },
              }),
              expect.any(AbortSignal),
            );
            expect(lifecycleRows(databasePath)).toEqual({
              inbound: { status: "completed" },
              outbound: {
                status: "delivered",
                workerId: "host-static-worker",
                text: "executed on host",
              },
            });
          },
          { timeout: 4_000, interval: 25 },
        );
      } finally {
        await client.stop();
        await durable.close();
        await runtime.close();
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  it("accepts a signed Linear mention and dispatches its reply through the durable lifecycle", async () => {
    const directory = await mkdtemp(join(tmpdir(), "supertag-runtime-linear-"));
    vi.stubEnv("SUPERTAG_STATE_DIR", join(directory, ".supertag"));
    const databasePath = join(directory, "supertag.db");
    await migrateSqlite(databasePath);
    const databaseUrl = `file:${databasePath}`;
    const seedStore = new DrizzleStore({ url: databaseUrl });
    const credentialVault = new FileGatewayCredentialVault();
    const workspaceId = "dc844923-f9a4-40a3-825c-dea7747e57d6";
    const teamId = "72b2a2dc-6f4f-4423-9d34-24b5bd10634a";
    const webhookSecret = "linear-webhook-secret";
    await seedStore.connect();
    const account = await seedStore.saveSurfaceAccount({
      provider: "linear",
      externalAccountId: workspaceId,
      displayName: "Acme",
      authMethod: "linear-api-key",
      credentialId: `surface/linear/${workspaceId}`,
      status: "connected",
      configuration: { apiBaseUrl: "https://api.linear.app/graphql" },
      verifiedAt: new Date().toISOString(),
    });
    const tag = await seedStore.createTag({ name: "Linear Runtime" });
    await seedStore.bindTagWorkerHost(tag.id, "control-plane-static-host");
    await seedStore.addTagRoute({
      tagId: tag.id,
      surfaceAccountId: account.id,
      scope: `team:${teamId}`,
    });
    await seedStore.disconnect();
    await credentialVault.store(`surface/linear/${workspaceId}`, {
      apiKey: "lin_api_test",
      webhookSecret,
    });
    const replies: Array<{ readonly event: InboundSurfaceEvent; readonly text: string }> = [];
    const runtime = await startControlPlaneRuntime({
      host: "127.0.0.1",
      port: 0,
      databaseUrl,
      surfaceRefreshIntervalMs: 10,
      reply: async (event, presentation) => {
        replies.push({ event, text: presentation.markdown });
      },
    });
    const eventTime = new Date();
    const rawBody = JSON.stringify({
      action: "create",
      actor: { id: "user-1", type: "user", name: "Atem" },
      data: {
        id: "issue-1",
        identifier: "ENG-42",
        title: "Exercise Linear ingress",
        description: "@supertag run the static worker",
        teamId,
      },
      type: "Issue",
      url: "https://linear.app/acme/issue/ENG-42/exercise-linear-ingress",
      createdAt: eventTime.toISOString(),
      organizationId: workspaceId,
      webhookTimestamp: eventTime.getTime(),
      webhookId: "webhook-1",
    });

    try {
      const response = await fetch(`${runtime.url}/webhooks/linear`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "linear-delivery": "linear-runtime-delivery",
          "linear-event": "Issue",
          "linear-signature": createHmac("sha256", webhookSecret).update(rawBody).digest("hex"),
        },
        body: rawBody,
      });

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({ status: "accepted" });
      await vi.waitFor(() => expect(replies).toHaveLength(2));
      expect(replies.filter((reply) => reply.text.startsWith("SuperTag received"))).toEqual([
        {
          event: expect.objectContaining({
            provider: "linear",
            scope: `team:${teamId}`,
            callback: {
              provider: "linear",
              mode: "linear_issue_comment",
              threadKey: "issue-1",
              target: { issueId: "issue-1" },
            },
          }),
          text: "SuperTag received your request. Control Plane and surface smoke test succeeded.",
        },
      ]);
      expect(lifecycleRowsForDelivery(databasePath, "linear-runtime-delivery")).toEqual({
        inbound: { status: "completed" },
        outbound: {
          status: "delivered",
          workerId: "control-plane-static-worker",
          text: "SuperTag received your request. Control Plane and surface smoke test succeeded.",
        },
      });
    } finally {
      await runtime.close();
      vi.unstubAllEnvs();
      await rm(directory, { recursive: true, force: true });
    }
  });
});

async function migrateSqlite(databasePath: string): Promise<void> {
  await migrateSqliteDatabase(databasePath);
}

function lifecycleRows(databasePath: string): {
  readonly inbound: { readonly status: string } | undefined;
  readonly outbound:
    | { readonly status: string; readonly workerId: string; readonly text: string }
    | undefined;
} {
  const database = new Database(databasePath, { readonly: true });
  try {
    return {
      inbound: database
        .prepare("SELECT status FROM DurableInboundEvent WHERE deliveryId = ?")
        .get("remote-runtime-delivery") as { status: string } | undefined,
      outbound: database
        .prepare(
          `SELECT status, workerId, text
             FROM OutboundReply
            WHERE inboundEventId = (
              SELECT id FROM DurableInboundEvent WHERE deliveryId = ?
            ) AND deliveryKey = 'final'`,
        )
        .get("remote-runtime-delivery") as
        | { status: string; workerId: string; text: string }
        | undefined,
    };
  } finally {
    database.close();
  }
}

function lifecycleRowsForDelivery(
  databasePath: string,
  deliveryId: string,
): ReturnType<typeof lifecycleRows> {
  const database = new Database(databasePath, { readonly: true });
  try {
    return {
      inbound: database
        .prepare("SELECT status FROM DurableInboundEvent WHERE deliveryId = ?")
        .get(deliveryId) as { status: string } | undefined,
      outbound: database
        .prepare(
          `SELECT status, workerId, text
             FROM OutboundReply
            WHERE inboundEventId = (
              SELECT id FROM DurableInboundEvent WHERE deliveryId = ?
            ) AND deliveryKey = 'final'`,
        )
        .get(deliveryId) as { status: string; workerId: string; text: string } | undefined,
    };
  } finally {
    database.close();
  }
}

function remoteEvent(): InboundSurfaceEvent {
  return {
    eventId: "remote-runtime-delivery",
    logicalEventId: "remote-runtime-logical",
    provider: "github",
    externalAccountId: "remote-runtime-test",
    kind: "mention",
    scope: "repository:supertag/remote-runtime",
    sessionKey: "github:supertag/remote-runtime:1",
    actor: { id: "runtime-user", kind: "user" },
    text: "execute on a remote Worker Host",
    occurredAt: "2026-07-31T23:00:00.000Z",
    callback: {
      provider: "github",
      mode: "github_issue_comment",
      threadKey: "supertag/remote-runtime#1",
      target: { repository: "supertag/remote-runtime", number: "1" },
    },
    source: { repository: "supertag/remote-runtime", issueNumber: "1" },
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
    capturedAt: "2026-08-01T00:00:00.000Z",
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
