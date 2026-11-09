import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Code } from "@connectrpc/connect";
import { afterEach, describe, expect, it } from "vitest";
import { startControlPlaneRuntime } from "../apps/cli/src/control-plane-runtime.ts";
import { workerHostView } from "../apps/cli/src/host-protos.ts";
import { hostClient } from "../apps/cli/src/operator-client.ts";
import { getWorkerHostResource } from "../apps/cli/src/operator-resources.ts";
import { LocalWorklet, StaticWorker } from "../packages/runtime/sdk/src/index.ts";
import { WorkletConnection } from "../packages/runtime/transport/src/index.ts";
import { FileGatewayCredentialVault } from "../packages/store/src/index.ts";
import { migrateSqlite } from "./support/database.ts";
import { durableTestWorklet } from "./support/durable-test-worklet.ts";
import { enrollWorkerHost } from "./support/worker-host-enrollment.ts";

describe("Worker Host runtime lifecycle", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    await Promise.allSettled(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  it("persists enrollment and drain state, fences rotation, and enforces revocation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "supertag-worker-host-lifecycle-"));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const databasePath = join(directory, "state.db");
    const vaultPath = join(directory, "credentials.json");
    await migrateSqlite(databasePath);
    const databaseUrl = `file:${databasePath}`;
    const adminToken = "worker-host-lifecycle-admin";
    const start = () =>
      startControlPlaneRuntime({
        host: "127.0.0.1",
        port: 0,
        databaseUrl,
        workletTransport: "remote",
        adminToken,
        credentialVault: new FileGatewayCredentialVault(vaultPath),
        reply: async () => {},
      });
    let runtime = await start();
    cleanups.push(() => runtime.close());
    const admin = () => ({ url: runtime.url, token: adminToken });
    const headers = admin;
    const hostId = "build-east-1";
    const worklet = new LocalWorklet("build-worklet", hostId, [
      new StaticWorker({
        id: "build-worker",
        profile: { id: "build", revision: "1" },
      }),
    ]);
    const durableWorklet = durableTestWorklet(worklet);
    const credential = await enrollWorkerHost(runtime.url, adminToken, hostId);
    const rejected = new WorkletConnection({
      url: `${runtime.url.replace(/^http/u, "ws")}/worklets`,
      credential: "wrong-host-credential",
      worklet,
      durableWorklet,
      reconnectIntervalMs: 5,
    });
    await expect(rejected.start()).rejects.toThrow("Authentication failed");
    let connection = new WorkletConnection({
      url: `${runtime.url.replace(/^http/u, "ws")}/worklets`,
      credential,
      worklet,
      durableWorklet,
      reconnectIntervalMs: 5,
    });
    await connection.start();

    await expect
      .poll(async () => (await workerHost(headers, hostId)).status)
      .toMatchObject({
        phase: "ready",
        connectionGeneration: 1,
        connectionStatus: "connected",
        ready: true,
        availableSlots: 1,
        failedAuthenticationCount: 1,
        lastAuthenticationFailureAt: expect.any(String),
        lastAuthenticatedAt: expect.any(String),
      });
    const vaultContents = await readFile(vaultPath, "utf8");
    expect(vaultContents).not.toContain(credential);
    expect(vaultContents).toContain('"algorithm": "sha256"');

    const drained = workerHostView(await hostClient(admin()).drainWorkerHost({ id: hostId }));
    expect(drained).toMatchObject({
      spec: { draining: true },
      status: { phase: "draining", availableSlots: 0 },
    });
    expect(drained.status.storage).toBeUndefined();

    await connection.stop();
    await runtime.close();
    runtime = await start();
    await expect(workerHost(headers, hostId)).resolves.toMatchObject({
      spec: { draining: true },
      status: {
        phase: "unreachable",
        connectionGeneration: 1,
        connectionStatus: "disconnected",
      },
    });

    connection = new WorkletConnection({
      url: `${runtime.url.replace(/^http/u, "ws")}/worklets`,
      credential,
      worklet,
      durableWorklet,
      reconnectIntervalMs: 5,
    });
    await connection.start();
    await expect
      .poll(async () => (await workerHost(headers, hostId)).status)
      .toMatchObject({
        phase: "draining",
        connectionGeneration: 2,
        availableSlots: 0,
      });

    expect(
      workerHostView(await hostClient(admin()).resumeWorkerHost({ id: hostId })),
    ).toMatchObject({
      spec: { draining: false },
      status: { phase: "ready", ready: true, availableSlots: 1 },
    });

    const rotation = await hostClient(admin()).rotateWorkerHostCredential({
      id: hostId,
      expectedCredentialRevision: 1n,
    });
    expect(rotation.token).not.toBe(credential);
    // A retry of the same rotation is refused as stale and changes nothing.
    await expect(
      hostClient(admin()).rotateWorkerHostCredential({
        id: hostId,
        expectedCredentialRevision: 1n,
      }),
    ).rejects.toMatchObject({ code: Code.FailedPrecondition });
    await expect.poll(() => connection.isConnected).toBe(false);

    const stale = new WorkletConnection({
      url: `${runtime.url.replace(/^http/u, "ws")}/worklets`,
      credential,
      worklet,
      durableWorklet,
      reconnectIntervalMs: 5,
    });
    await expect(stale.start()).rejects.toThrow("Authentication failed");

    const current = new WorkletConnection({
      url: `${runtime.url.replace(/^http/u, "ws")}/worklets`,
      credential: rotation.token,
      worklet,
      durableWorklet,
      reconnectIntervalMs: 5,
    });
    await current.start();
    await expect
      .poll(async () => (await workerHost(headers, hostId)).status)
      .toMatchObject({ credentialRevision: 2, connectionGeneration: 4, phase: "ready" });

    expect(
      workerHostView(await hostClient(admin()).revokeWorkerHostCredential({ id: hostId })),
    ).toMatchObject({ status: { phase: "revoked" } });
    await expect.poll(() => current.isConnected).toBe(false);
    await expect(workerHost(headers, hostId)).resolves.toMatchObject({
      spec: { draining: true },
      status: { phase: "revoked", connectionGeneration: 5, ready: false },
    });

    const revokedCredential = new WorkletConnection({
      url: `${runtime.url.replace(/^http/u, "ws")}/worklets`,
      credential: rotation.token,
      worklet,
      durableWorklet,
      reconnectIntervalMs: 5,
    });
    // Revoking a revoked host returns it unchanged.
    await expect(
      hostClient(admin()).revokeWorkerHostCredential({ id: hostId }),
    ).resolves.toMatchObject({ connectionGeneration: 5n });
    await expect(revokedCredential.start()).rejects.toThrow("Authentication failed");
  });
});

async function workerHost(
  options: () => { readonly url: string; readonly token: string },
  id: string,
) {
  return getWorkerHostResource(options(), id);
}
