import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startControlPlaneRuntime } from "../apps/cli/src/control-plane-runtime.ts";
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
    const headers = { authorization: `Bearer ${adminToken}` };
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
      .poll(async () => (await workerHost(runtime.url, headers, hostId)).status)
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

    const drained = await fetch(`${runtime.url}/api/v1/worker-hosts/${hostId}/drain`, {
      method: "POST",
      headers,
    });
    expect(drained.status).toBe(200);
    await expect(drained.json()).resolves.toMatchObject({
      spec: { draining: true },
      status: { phase: "draining", availableSlots: 0 },
    });

    await connection.stop();
    await runtime.close();
    runtime = await start();
    await expect(workerHost(runtime.url, headers, hostId)).resolves.toMatchObject({
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
      .poll(async () => (await workerHost(runtime.url, headers, hostId)).status)
      .toMatchObject({
        phase: "draining",
        connectionGeneration: 2,
        availableSlots: 0,
      });

    const resumed = await fetch(`${runtime.url}/api/v1/worker-hosts/${hostId}/resume`, {
      method: "POST",
      headers,
    });
    expect(resumed.status).toBe(200);
    await expect(resumed.json()).resolves.toMatchObject({
      spec: { draining: false },
      status: { phase: "ready", ready: true, availableSlots: 1 },
    });

    const rotated = await fetch(`${runtime.url}/api/v1/worker-hosts/${hostId}/credential`, {
      method: "POST",
      headers,
    });
    expect(rotated.status).toBe(200);
    const rotation = (await rotated.json()) as { credential: { token: string } };
    expect(rotation.credential.token).not.toBe(credential);
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
      credential: rotation.credential.token,
      worklet,
      durableWorklet,
      reconnectIntervalMs: 5,
    });
    await current.start();
    await expect
      .poll(async () => (await workerHost(runtime.url, headers, hostId)).status)
      .toMatchObject({ credentialRevision: 2, connectionGeneration: 4, phase: "ready" });

    const revoked = await fetch(`${runtime.url}/api/v1/worker-hosts/${hostId}/credential`, {
      method: "DELETE",
      headers,
    });
    expect(revoked.status).toBe(204);
    await expect.poll(() => current.isConnected).toBe(false);
    await expect(workerHost(runtime.url, headers, hostId)).resolves.toMatchObject({
      spec: { draining: true },
      status: { phase: "revoked", connectionGeneration: 5, ready: false },
    });

    const revokedCredential = new WorkletConnection({
      url: `${runtime.url.replace(/^http/u, "ws")}/worklets`,
      credential: rotation.credential.token,
      worklet,
      durableWorklet,
      reconnectIntervalMs: 5,
    });
    await expect(revokedCredential.start()).rejects.toThrow("Authentication failed");
  });
});

async function workerHost(
  url: string,
  headers: Readonly<Record<string, string>>,
  id: string,
): Promise<{
  readonly spec: { readonly draining: boolean };
  readonly status: Readonly<Record<string, unknown>>;
}> {
  const response = await fetch(`${url}/api/v1/worker-hosts/${encodeURIComponent(id)}`, { headers });
  expect(response.status).toBe(200);
  return response.json() as Promise<{
    readonly spec: { readonly draining: boolean };
    readonly status: Readonly<Record<string, unknown>>;
  }>;
}
