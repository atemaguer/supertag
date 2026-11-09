import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Code } from "@connectrpc/connect";
import { afterEach, describe, expect, it } from "vitest";
import { startControlPlaneRuntime } from "../apps/cli/src/control-plane-runtime.ts";
import { authKeyView } from "../apps/cli/src/host-protos.ts";
import { hostClient } from "../apps/cli/src/operator-client.ts";
import { getAuthKeyResource, getWorkerHostResource } from "../apps/cli/src/operator-resources.ts";
import { LocalWorklet, StaticWorker } from "../packages/runtime/sdk/src/index.ts";
import { WorkletConnection } from "../packages/runtime/transport/src/index.ts";
import { FileGatewayCredentialVault } from "../packages/store/src/index.ts";
import { migrateSqlite } from "./support/database.ts";
import { durableTestWorklet } from "./support/durable-test-worklet.js";
import { applyManifests, getResource } from "./support/resources.ts";

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
    const options = { url: started.url, token: adminToken };
    return {
      url: started.url,
      resources: { operator: options },
      vaultPath,
      hosts: hostClient(options),
      workerHost: (id: string) => getWorkerHostResource(options, id),
      authKey: (name: string) => getAuthKeyResource(options, name),
    };
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
    const { url, resources, vaultPath, hosts, workerHost, authKey } = await runtime();
    expect(
      (
        await applyManifests(resources, [
          {
            apiVersion: "supertag/v1",
            kind: "Tag",
            metadata: { name: "builder" },
            spec: {},
          },
        ])
      ).complete,
    ).toBe(true);

    // Only operators may manage keys.
    await expect(hostClient({ url }).listAuthKeys({})).rejects.toMatchObject({
      code: Code.Unauthenticated,
    });
    await expect(hosts.createAuthKey({ name: "laptop", tags: ["missing"] })).rejects.toMatchObject({
      code: Code.NotFound,
    });

    const created = await hosts.createAuthKey({ name: "laptop", tags: ["builder"] });
    const issued = { secret: created.secret, ...authKeyView(created.authKey as never) };
    expect(issued.secret).toMatch(/^stak_[a-f0-9]{64}$/u);
    expect(issued.spec).toEqual({
      tags: ["builder"],
      labels: [],
      reusable: false,
      ephemeral: false,
    });
    expect(issued.status).toMatchObject({ phase: "active", redemptionCount: 0 });
    await expect(hosts.createAuthKey({ name: "laptop", tags: ["builder"] })).rejects.toMatchObject({
      code: Code.AlreadyExists,
    });

    const listed = JSON.stringify(await hosts.listAuthKeys({}), (_key, value) =>
      typeof value === "bigint" ? String(value) : value,
    );
    const got = JSON.stringify(await authKey("laptop"));
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
    await expect(authKey("laptop")).resolves.toMatchObject({
      status: { phase: "used", redemptionCount: 1, usedAt: expect.any(String) },
    });

    await expect(getResource(resources, "tags", "builder")).resolves.toMatchObject({
      spec: { workerHosts: ["laptop"] },
    });
    await expect(workerHost("laptop")).resolves.toMatchObject({
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
    await expect.poll(async () => (await workerHost("laptop")).status.phase).toBe("ready");
  });

  it("rejects revoked keys and lets reusable keys join hosts under NAME-2", async () => {
    const { url, resources, hosts, workerHost } = await runtime();
    await applyManifests(resources, [
      {
        apiVersion: "supertag/v1",
        kind: "Tag",
        metadata: { name: "builder" },
        spec: {},
      },
    ]);
    const issued = await hosts.createAuthKey({
      name: "ci",
      tags: ["builder"],
      reusable: true,
      ephemeral: true,
    });
    const first = (await (await joinHost(url, issued.secret, "runner")).json()) as Joined;
    const second = (await (await joinHost(url, issued.secret, "runner")).json()) as Joined;
    expect([first.metadata.workerHostId, second.metadata.workerHostId]).toEqual([
      "runner",
      "runner-2",
    ]);
    expect(second.status.ephemeral).toBe(true);

    const revoked = authKeyView(await hosts.revokeAuthKey({ name: "ci" }));
    expect(revoked).toMatchObject({ status: { phase: "revoked", redemptionCount: 2 } });
    // Revoking a revoked key returns it.
    expect(authKeyView(await hosts.revokeAuthKey({ name: "ci" })).status.revokedAt).toBe(
      revoked.status.revokedAt,
    );
    expect((await joinHost(url, issued.secret, "runner")).status).toBe(403);
    // Revocation blocks new joins only; joined hosts stay enrolled.
    await expect(workerHost("runner-2")).resolves.toMatchObject({
      status: { phase: "unreachable", ephemeral: true },
    });
    await expect(hosts.revokeAuthKey({ name: "missing" })).rejects.toMatchObject({
      code: Code.NotFound,
    });

    // A removed ephemeral host leaves the default list but stays readable by ID.
    const removed = await fetch(`${url}/api/v1/worker-hosts/runner-2/credential`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${second.credential.token}` },
    });
    expect(removed.status).toBe(204);
    const listed = await hosts.listWorkerHosts({});
    expect(listed.workerHosts.map((host) => host.metadata?.id)).toEqual(["runner"]);
    await expect(workerHost("runner-2")).resolves.toMatchObject({ status: { phase: "revoked" } });
  });

  it("lets a Worker Host revoke only itself with its own credential", async () => {
    const { url, resources, hosts, workerHost } = await runtime();
    await applyManifests(resources, [
      {
        apiVersion: "supertag/v1",
        kind: "Tag",
        metadata: { name: "builder" },
        spec: {},
      },
    ]);
    const issued = await hosts.createAuthKey({ name: "fleet", tags: ["builder"], reusable: true });
    const a = (await (await joinHost(url, issued.secret, "host-a")).json()) as Joined;
    const b = (await (await joinHost(url, issued.secret, "host-b")).json()) as Joined;

    const crossed = await fetch(`${url}/api/v1/worker-hosts/host-b/credential`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${a.credential.token}` },
    });
    expect(crossed.status).toBe(401);
    await expect(workerHost("host-b")).resolves.toMatchObject({
      status: { phase: "unreachable" },
    });
    // A host credential grants nothing else on the management API.
    await expect(
      hostClient({ url, token: a.credential.token }).listAuthKeys({}),
    ).rejects.toMatchObject({ code: Code.Unauthenticated });

    const own = await fetch(`${url}/api/v1/worker-hosts/host-a/credential`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${a.credential.token}` },
    });
    expect(own.status).toBe(204);
    await expect(workerHost("host-a")).resolves.toMatchObject({
      status: { phase: "revoked", revocationReason: "SelfRevoked" },
    });
    expect(b.metadata.workerHostId).toBe("host-b");
  });
});
