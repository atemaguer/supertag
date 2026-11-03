import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startControlPlaneRuntime } from "../apps/cli/src/control-plane-runtime.ts";
import { LocalWorklet, StaticWorker } from "../packages/runtime/sdk/src/index.ts";
import { WorkletConnection } from "../packages/runtime/transport/src/index.ts";
import { FileGatewayCredentialVault } from "../packages/store/src/index.ts";
import { migrateSqlite } from "./support/database.ts";
import { durableTestWorklet } from "./support/durable-test-worklet.js";

interface Joined {
  readonly metadata: { readonly workerHostId: string };
  readonly credential: { readonly token: string };
  readonly status: { readonly ephemeral: boolean };
}

describe("Auth Key API", () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    await Promise.allSettled(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  async function runtime() {
    const directory = await mkdtemp(join(tmpdir(), "supertag-auth-key-runtime-"));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const databasePath = join(directory, "state.db");
    await migrateSqlite(databasePath);
    const adminToken = "auth-key-admin";
    const vaultPath = join(directory, "credentials.json");
    const started = await startControlPlaneRuntime({
      host: "127.0.0.1",
      port: 0,
      databaseUrl: `file:${databasePath}`,
      workletTransport: "remote",
      adminToken,
      credentialVault: new FileGatewayCredentialVault(vaultPath),
      reply: async () => {},
    });
    cleanups.push(() => started.close());
    const admin = { authorization: `Bearer ${adminToken}`, "content-type": "application/json" };
    const api = (path: string, init: RequestInit = {}) =>
      fetch(`${started.url}${path}`, { ...init, headers: { ...admin, ...init.headers } });
    return { url: started.url, api, vaultPath };
  }

  function createKey(
    api: (path: string, init?: RequestInit) => Promise<Response>,
    name: string,
    spec: Record<string, unknown>,
  ) {
    return api("/api/v1/auth-keys", {
      method: "POST",
      body: JSON.stringify({
        apiVersion: "supertag/v1",
        kind: "AuthKey",
        metadata: { name },
        spec,
      }),
    });
  }

  function joinHost(url: string, secret: string, name: string) {
    return fetch(`${url}/api/v1/worker-host-joins`, {
      method: "POST",
      headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
      body: JSON.stringify({
        apiVersion: "supertag/v1",
        kind: "WorkerHostJoin",
        metadata: { name },
        spec: {},
      }),
    });
  }

  it("issues a key once, joins a host bound to its Tags, and never shows the secret again", async () => {
    const { url, api, vaultPath } = await runtime();
    expect(
      (
        await api("/api/v1/tags", {
          method: "POST",
          body: JSON.stringify({
            apiVersion: "supertag/v1",
            kind: "Tag",
            metadata: { name: "builder" },
            spec: {},
          }),
        })
      ).status,
    ).toBe(201);

    // Only operators may manage keys.
    const anonymous = await fetch(`${url}/api/v1/auth-keys`);
    expect(anonymous.status).toBe(401);
    expect((await createKey(api, "laptop", { tags: ["missing"] })).status).toBe(400);

    const created = await createKey(api, "laptop", { tags: ["builder"] });
    expect(created.status).toBe(201);
    expect(created.headers.get("cache-control")).toBe("no-store");
    const issued = (await created.json()) as {
      secret: string;
      spec: Record<string, unknown>;
      status: Record<string, unknown>;
    };
    expect(issued.secret).toMatch(/^stak_[a-f0-9]{64}$/u);
    expect(issued.spec).toEqual({
      tags: ["builder"],
      labels: [],
      reusable: false,
      ephemeral: false,
    });
    expect(issued.status).toMatchObject({ phase: "active", redemptionCount: 0 });
    expect((await createKey(api, "laptop", { tags: ["builder"] })).status).toBe(409);

    const listed = await (await api("/api/v1/auth-keys")).text();
    const got = await (await api("/api/v1/auth-keys/laptop")).text();
    for (const body of [listed, got]) {
      expect(body).not.toContain(issued.secret);
      expect(body).not.toContain("secretDigest");
    }
    expect(await readFile(vaultPath, "utf8").catch(() => "")).not.toContain(issued.secret);

    expect((await joinHost(url, "stak_not-a-key", "laptop")).status).toBe(401);
    const joined = await joinHost(url, issued.secret, "laptop");
    expect(joined.status).toBe(201);
    const credential = (await joined.json()) as {
      kind: string;
      metadata: { workerHostId: string };
      credential: { token: string };
      status: Record<string, unknown>;
    };
    expect(credential).toMatchObject({
      kind: "WorkerHostCredential",
      metadata: { workerHostId: "laptop" },
      status: { authKey: "laptop", tags: ["builder"], ephemeral: false },
    });

    // A one-off key joins one host.
    const again = await joinHost(url, issued.secret, "desktop");
    expect(again.status).toBe(403);
    await expect(again.json()).resolves.toMatchObject({ message: expect.stringContaining("used") });
    await expect((await api("/api/v1/auth-keys/laptop")).json()).resolves.toMatchObject({
      status: { phase: "used", redemptionCount: 1, usedAt: expect.any(String) },
    });

    await expect((await api("/api/v1/tags/builder")).json()).resolves.toMatchObject({
      spec: { workerHosts: ["laptop"] },
    });
    await expect((await api("/api/v1/worker-hosts/laptop")).json()).resolves.toMatchObject({
      status: { authKey: "laptop", ephemeral: false },
    });

    const worklet = new LocalWorklet("laptop-worklet", "laptop", [
      new StaticWorker({ id: "laptop-worker", profile: { id: "general", revision: "1" } }),
    ]);
    const connection = new WorkletConnection({
      url: `${url.replace(/^http/u, "ws")}/worklets`,
      credential: credential.credential.token,
      worklet,
      durableWorklet: durableTestWorklet(worklet),
      reconnectIntervalMs: 5,
    });
    cleanups.unshift(() => connection.stop());
    await connection.start();
    await expect
      .poll(
        async () =>
          (
            (await (await api("/api/v1/worker-hosts/laptop")).json()) as {
              status: { phase: string };
            }
          ).status.phase,
      )
      .toBe("ready");
  });

  it("rejects revoked keys and lets reusable keys join hosts under NAME-2", async () => {
    const { url, api } = await runtime();
    await api("/api/v1/tags", {
      method: "POST",
      body: JSON.stringify({
        apiVersion: "supertag/v1",
        kind: "Tag",
        metadata: { name: "builder" },
        spec: {},
      }),
    });
    const issued = (await (
      await createKey(api, "ci", { tags: ["builder"], reusable: true, ephemeral: true })
    ).json()) as { secret: string };
    const first = (await (await joinHost(url, issued.secret, "runner")).json()) as Joined;
    const second = (await (await joinHost(url, issued.secret, "runner")).json()) as Joined;
    expect([first.metadata.workerHostId, second.metadata.workerHostId]).toEqual([
      "runner",
      "runner-2",
    ]);
    expect(second.status.ephemeral).toBe(true);

    const revoked = await api("/api/v1/auth-keys/ci/revoke", { method: "POST" });
    expect(revoked.status).toBe(200);
    await expect(revoked.json()).resolves.toMatchObject({
      status: { phase: "revoked", redemptionCount: 2 },
    });
    expect((await joinHost(url, issued.secret, "runner")).status).toBe(403);
    // Revocation blocks new joins only; joined hosts stay enrolled.
    await expect((await api("/api/v1/worker-hosts/runner-2")).json()).resolves.toMatchObject({
      status: { phase: "unreachable", ephemeral: true },
    });
    expect((await api("/api/v1/auth-keys/missing/revoke", { method: "POST" })).status).toBe(404);

    // A removed ephemeral host leaves the default list but stays readable by ID.
    const removed = await fetch(`${url}/api/v1/worker-hosts/runner-2/credential`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${second.credential.token}` },
    });
    expect(removed.status).toBe(204);
    const listed = (await (await api("/api/v1/worker-hosts")).json()) as {
      items: { metadata: { id: string } }[];
    };
    expect(listed.items.map((item) => item.metadata.id)).toEqual(["runner"]);
    expect((await api("/api/v1/worker-hosts/runner-2")).status).toBe(200);
  });

  it("lets a Worker Host revoke only itself with its own credential", async () => {
    const { url, api } = await runtime();
    await api("/api/v1/tags", {
      method: "POST",
      body: JSON.stringify({
        apiVersion: "supertag/v1",
        kind: "Tag",
        metadata: { name: "builder" },
        spec: {},
      }),
    });
    const issued = (await (
      await createKey(api, "fleet", { tags: ["builder"], reusable: true })
    ).json()) as { secret: string };
    const a = (await (await joinHost(url, issued.secret, "host-a")).json()) as Joined;
    const b = (await (await joinHost(url, issued.secret, "host-b")).json()) as Joined;

    const crossed = await fetch(`${url}/api/v1/worker-hosts/host-b/credential`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${a.credential.token}` },
    });
    expect(crossed.status).toBe(401);
    await expect((await api("/api/v1/worker-hosts/host-b")).json()).resolves.toMatchObject({
      status: { phase: "unreachable" },
    });
    // A host credential grants nothing else on the management API.
    expect(
      (
        await fetch(`${url}/api/v1/auth-keys`, {
          headers: { authorization: `Bearer ${a.credential.token}` },
        })
      ).status,
    ).toBe(401);

    const own = await fetch(`${url}/api/v1/worker-hosts/host-a/credential`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${a.credential.token}` },
    });
    expect(own.status).toBe(204);
    await expect((await api("/api/v1/worker-hosts/host-a")).json()).resolves.toMatchObject({
      status: { phase: "revoked", revocationReason: "SelfRevoked" },
    });
    expect(b.metadata.workerHostId).toBe("host-b");
  });
});
