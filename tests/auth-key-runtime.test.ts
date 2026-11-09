import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Code } from "@connectrpc/connect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startControlPlaneRuntime } from "../apps/cli/src/control-plane-runtime.ts";
import { drainMarkerPath, resumeIfDrained } from "../apps/cli/src/drain.ts";
import { authKeyView } from "../apps/cli/src/host-protos.ts";
import { hostClient, organizationClient } from "../apps/cli/src/operator-client.ts";
import { getAuthKeyResource, getWorkerHostResource } from "../apps/cli/src/operator-resources.ts";
import { LocalWorklet, StaticWorker } from "../packages/runtime/sdk/src/index.ts";
import { WorkletConnection } from "../packages/runtime/transport/src/index.ts";
import { FileGatewayCredentialVault } from "../packages/store/src/index.ts";
import { migrateSqlite } from "./support/database.ts";
import { durableTestWorklet } from "./support/durable-test-worklet.js";
import { applyManifests, getResource } from "./support/resources.ts";

describe("Auth Key API", () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    vi.unstubAllEnvs();
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
    return hostClient({ url, token: secret }).joinWorkerHost({ name });
  }

  /** `HostService` as a Worker Host, with its own credential. */
  function asHost(url: string, workerHostId: string, token: string | undefined) {
    return hostClient({ url, token: token ?? "", workerHostId });
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

    await expect(joinHost(url, "stak_not-a-key", "laptop")).rejects.toMatchObject({
      code: Code.Unauthenticated,
    });
    // An unknown key is refused before the request is read, so nothing it sends is recorded.
    await expect(joinHost(url, `stak_${"0".repeat(64)}`, "Not A Name")).rejects.toMatchObject({
      code: Code.Unauthenticated,
      rawMessage: "Auth Key is invalid",
    });
    // An Auth Key only joins; an operator credential cannot.
    await expect(
      hostClient({ url, token: "auth-key-admin" }).joinWorkerHost({ name: "laptop" }),
    ).rejects.toMatchObject({ code: Code.Unauthenticated });
    await expect(joinHost(url, issued.secret, "Not A Name")).rejects.toMatchObject({
      code: Code.InvalidArgument,
    });
    const credential = await joinHost(url, issued.secret, "laptop");
    expect(credential).toMatchObject({
      credential: { workerHostId: "laptop", token: expect.any(String) },
      authKey: "laptop",
      tags: ["builder"],
      ephemeral: false,
    });

    // A one-off key joins one host.
    await expect(joinHost(url, issued.secret, "desktop")).rejects.toMatchObject({
      code: Code.PermissionDenied,
      rawMessage: expect.stringContaining("used"),
    });
    await expect(authKey("laptop")).resolves.toMatchObject({
      status: { phase: "used", redemptionCount: 1, usedAt: expect.any(String) },
    });
    await expect(hostClient({ url }).joinWorkerHost({ name: "laptop" })).rejects.toMatchObject({
      code: Code.Unauthenticated,
    });
    // Joins with an unknown key are not recorded; refusals of a known one keep only the kind.
    const { entries } = await organizationClient({
      url,
      token: "auth-key-admin",
    }).listAuditEntries({});
    expect(
      entries
        .filter((entry) => entry.action === "worker-host.join")
        .map(({ actor, target, status }) => ({ actor, target, status })),
    ).toEqual([
      { actor: "auth-key", target: "WorkerHost", status: 403 },
      { actor: "auth-key:laptop", target: "WorkerHost/laptop", status: 200 },
      { actor: "auth-key", target: "WorkerHost", status: 400 },
    ]);

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
      credential: credential.credential?.token ?? "",
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
    const first = await joinHost(url, issued.secret, "runner");
    const second = await joinHost(url, issued.secret, "runner");
    expect([first.credential?.workerHostId, second.credential?.workerHostId]).toEqual([
      "runner",
      "runner-2",
    ]);
    expect(second.ephemeral).toBe(true);

    const revoked = authKeyView(await hosts.revokeAuthKey({ name: "ci" }));
    expect(revoked).toMatchObject({ status: { phase: "revoked", redemptionCount: 2 } });
    // Revoking a revoked key returns it.
    expect(authKeyView(await hosts.revokeAuthKey({ name: "ci" })).status.revokedAt).toBe(
      revoked.status.revokedAt,
    );
    await expect(joinHost(url, issued.secret, "runner")).rejects.toMatchObject({
      code: Code.PermissionDenied,
    });
    // Revocation blocks new joins only; joined hosts stay enrolled.
    await expect(workerHost("runner-2")).resolves.toMatchObject({
      status: { phase: "unreachable", ephemeral: true },
    });
    await expect(hosts.revokeAuthKey({ name: "missing" })).rejects.toMatchObject({
      code: Code.NotFound,
    });

    // A removed ephemeral host leaves the default list but stays readable by ID.
    await expect(
      asHost(url, "runner-2", second.credential?.token).revokeWorkerHostCredential({
        id: "runner-2",
      }),
    ).resolves.toMatchObject({ revocationReason: "SelfRevoked" });
    const listed = await hosts.listWorkerHosts({});
    expect(listed.workerHosts.map((host) => host.metadata?.id)).toEqual(["runner"]);
    await expect(workerHost("runner-2")).resolves.toMatchObject({ status: { phase: "revoked" } });
  });

  it("returns the same host with a new credential when a join is retried", async () => {
    const { url, resources, hosts, workerHost } = await runtime();
    await applyManifests(resources, [
      { apiVersion: "supertag/v1", kind: "Tag", metadata: { name: "builder" }, spec: {} },
    ]);
    const join = (secret: string, name: string, idempotencyKey: string) =>
      hostClient({ url, token: secret }).joinWorkerHost({ name, idempotencyKey });
    const reusable = await hosts.createAuthKey({
      name: "fleet",
      tags: ["builder"],
      reusable: true,
    });
    const oneOff = await hosts.createAuthKey({ name: "single", tags: ["builder"] });
    await expect(join(reusable.secret, "runner", "has space")).rejects.toMatchObject({
      code: Code.InvalidArgument,
    });

    for (const [secret, name] of [
      [reusable.secret, "runner"],
      [oneOff.secret, "solo"],
    ] as const) {
      const first = await join(secret, name, `join-${name}`);
      const repeat = await join(secret, `${name}-renamed`, `join-${name}`);
      expect(repeat.credential?.workerHostId).toBe(name);
      expect(repeat.credential?.token).not.toBe(first.credential?.token);
      // The lost credential no longer works; the reissued one does.
      await expect(
        asHost(url, name, first.credential?.token).drainWorkerHost({ id: name }),
      ).rejects.toMatchObject({ code: Code.Unauthenticated });
      await expect(
        asHost(url, name, repeat.credential?.token).drainWorkerHost({ id: name }),
      ).resolves.toMatchObject({ draining: true });
    }
    expect((await hosts.listWorkerHosts({})).workerHosts.map((host) => host.metadata?.id)).toEqual([
      "runner",
      "solo",
    ]);
    await expect(hosts.getAuthKey({ name: "fleet" })).resolves.toMatchObject({
      redemptionCount: 1,
    });
    // Another idempotency key is another join.
    await expect(join(reusable.secret, "runner", "join-again")).resolves.toMatchObject({
      credential: { workerHostId: "runner-2" },
    });
    await expect(join(oneOff.secret, "solo", "join-again")).rejects.toMatchObject({
      code: Code.PermissionDenied,
    });

    // Once the host has connected, a repeat is refused and its credential keeps working.
    const connected = await join(reusable.secret, "laptop", "join-laptop");
    const worklet = new LocalWorklet("laptop-worklet", "laptop", [
      new StaticWorker({ id: "laptop-worker", profile: { id: "general", revision: "1" } }),
    ]);
    const connection = new WorkletConnection({
      url: `${url.replace(/^http/u, "ws")}/worklets`,
      credential: connected.credential?.token ?? "",
      worklet,
      durableWorklet: durableTestWorklet(worklet),
      reconnectIntervalMs: 5,
    });
    cleanups.unshift(() => connection.stop());
    await connection.start();
    await expect.poll(async () => (await workerHost("laptop")).status.phase).toBe("ready");
    await expect(join(reusable.secret, "laptop", "join-laptop")).rejects.toMatchObject({
      code: Code.AlreadyExists,
    });
    await expect(
      asHost(url, "laptop", connected.credential?.token).resumeWorkerHost({ id: "laptop" }),
    ).resolves.toMatchObject({ draining: false });
  });

  it("records no authentication failure for a wrong host credential on the operator API", async () => {
    const { url, resources, hosts, workerHost } = await runtime();
    await applyManifests(resources, [
      { apiVersion: "supertag/v1", kind: "Tag", metadata: { name: "builder" }, spec: {} },
    ]);
    const issued = await hosts.createAuthKey({ name: "quiet", tags: ["builder"] });
    await joinHost(url, issued.secret, "quiet-host");
    for (const call of [
      () => asHost(url, "quiet-host", "wrong").drainWorkerHost({ id: "quiet-host" }),
      () => asHost(url, "quiet-host", "wrong").listAuthKeys({}),
    ])
      await expect(call()).rejects.toMatchObject({ code: Code.Unauthenticated });
    const { status } = await workerHost("quiet-host");
    expect(status.failedAuthenticationCount).toBe(0);
    expect(status).not.toHaveProperty("lastAuthenticationFailureAt");
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
    const a = await joinHost(url, issued.secret, "host-a");
    const b = await joinHost(url, issued.secret, "host-b");
    const hostA = asHost(url, "host-a", a.credential?.token);

    // A credential names only its own host, and acts only on it.
    await expect(
      asHost(url, "host-b", a.credential?.token).revokeWorkerHostCredential({ id: "host-b" }),
    ).rejects.toMatchObject({ code: Code.Unauthenticated });
    await expect(hostA.revokeWorkerHostCredential({ id: "host-b" })).rejects.toMatchObject({
      code: Code.PermissionDenied,
    });
    await expect(hostA.drainWorkerHost({ id: "host-b" })).rejects.toMatchObject({
      code: Code.PermissionDenied,
    });
    await expect(workerHost("host-b")).resolves.toMatchObject({
      status: { phase: "unreachable" },
    });
    // A host credential grants nothing else on the management API.
    await expect(
      hostClient({ url, token: a.credential?.token ?? "" }).listAuthKeys({}),
    ).rejects.toMatchObject({ code: Code.Unauthenticated });
    for (const call of [
      () => hostA.listAuthKeys({}),
      () => hostA.getWorkerHost({ id: "host-a" }),
      () => hostA.rotateWorkerHostCredential({ id: "host-a", expectedCredentialRevision: 1n }),
    ])
      await expect(call()).rejects.toMatchObject({ code: Code.PermissionDenied });

    // It drains and resumes itself, as `supertag down` and `up` do.
    await expect(hostA.drainWorkerHost({ id: "host-a" })).resolves.toMatchObject({
      draining: true,
    });
    await expect(hostA.resumeWorkerHost({ id: "host-a" })).resolves.toMatchObject({
      draining: false,
    });

    await expect(hostA.revokeWorkerHostCredential({ id: "host-a" })).resolves.toMatchObject({
      revocationReason: "SelfRevoked",
    });
    await expect(workerHost("host-a")).resolves.toMatchObject({
      status: { phase: "revoked", revocationReason: "SelfRevoked" },
    });
    // Its credential stopped working.
    await expect(hostA.revokeWorkerHostCredential({ id: "host-a" })).rejects.toMatchObject({
      code: Code.Unauthenticated,
    });
    expect(b.credential?.workerHostId).toBe("host-b");

    const { entries } = await organizationClient({
      url,
      token: "auth-key-admin",
    }).listAuditEntries({});
    expect(
      entries
        .filter((entry) => entry.action.startsWith("worker-host."))
        .map(({ actor, action, target }) => ({ actor, action, target })),
    ).toEqual(
      expect.arrayContaining([
        { actor: "auth-key:fleet", action: "worker-host.join", target: "WorkerHost/host-a" },
        { actor: "worker-host:host-a", action: "worker-host.drain", target: "WorkerHost/host-a" },
        {
          actor: "worker-host:host-a",
          action: "worker-host.credential.revoke",
          target: "WorkerHost/host-a",
        },
        // A refused call acting on another host keeps only the kind.
        { actor: "worker-host:host-a", action: "worker-host.drain", target: "WorkerHost" },
      ]),
    );
  });

  it("resumes a host service that `up` or `down` drained, with the host's own credential", async () => {
    const { url, resources, hosts } = await runtime();
    await applyManifests(resources, [
      { apiVersion: "supertag/v1", kind: "Tag", metadata: { name: "builder" }, spec: {} },
    ]);
    const issued = await hosts.createAuthKey({ name: "service", tags: ["builder"] });
    const joined = await joinHost(url, issued.secret, "service-host");
    const credential = {
      workerHostId: "service-host",
      token: joined.credential?.token ?? "",
    };
    const state = await mkdtemp(join(tmpdir(), "supertag-auth-key-state-"));
    cleanups.push(() => rm(state, { recursive: true, force: true }));
    vi.stubEnv("SUPERTAG_STATE_DIR", state);

    // Without the marker `up` or `down` writes, nothing is resumed.
    await expect(resumeIfDrained("builder", url, credential)).resolves.toBe(false);
    await asHost(url, "service-host", credential.token).drainWorkerHost({ id: "service-host" });
    const marker = drainMarkerPath("builder");
    await mkdir(join(marker, ".."), { recursive: true });
    await writeFile(marker, "service-host\n");
    // A wrong credential leaves the host drained and the marker in place.
    await expect(
      resumeIfDrained("builder", url, { workerHostId: "service-host", token: "wrong" }),
    ).resolves.toBe(false);
    await expect(stat(marker)).resolves.toBeDefined();
    await expect(resumeIfDrained("builder", url, credential)).resolves.toBe(true);
    await expect(stat(marker)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(hosts.getWorkerHost({ id: "service-host" })).resolves.toMatchObject({
      draining: false,
    });
  });
});
