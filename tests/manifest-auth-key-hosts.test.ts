import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startControlPlaneRuntime } from "../apps/cli/src/control-plane-runtime.ts";
import { FileGatewayCredentialVault } from "../packages/store/src/index.ts";
import { migrateSqlite } from "./support/database.ts";

describe("Worker Hosts joined with an Auth Key", () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    await Promise.allSettled(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  it("stay bound to a Tag when its manifest is applied again", async () => {
    const directory = await mkdtemp(join(tmpdir(), "supertag-manifest-auth-key-"));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const databasePath = join(directory, "state.db");
    await migrateSqlite(databasePath);
    const adminToken = "manifest-auth-key-admin";
    const started = await startControlPlaneRuntime({
      host: "127.0.0.1",
      port: 0,
      databaseUrl: `file:${databasePath}`,
      workletTransport: "remote",
      adminToken,
      credentialVault: new FileGatewayCredentialVault(join(directory, "credentials.json")),
      reply: async () => {},
    });
    cleanups.push(() => started.close());
    const api = async <T>(path: string, init: RequestInit = {}): Promise<T> => {
      const response = await fetch(`${started.url}${path}`, {
        ...init,
        headers: { authorization: `Bearer ${adminToken}`, "content-type": "application/json" },
      });
      expect(response.ok).toBe(true);
      return (await response.json()) as T;
    };
    const applyTag = (workerHosts: readonly string[]) =>
      api<{ spec: { workerHosts: string[] } }>("/api/v1/tags", {
        method: "POST",
        body: JSON.stringify({
          apiVersion: "supertag/v1",
          kind: "Tag",
          metadata: { name: "builder" },
          spec: { workerHosts },
        }),
      });
    const join_ = async (key: string, name: string) => {
      const { secret } = await api<{ secret: string }>("/api/v1/auth-keys", {
        method: "POST",
        body: JSON.stringify({
          apiVersion: "supertag/v1",
          kind: "AuthKey",
          metadata: { name: key },
          spec: { tags: ["builder"] },
        }),
      });
      const response = await fetch(`${started.url}/api/v1/worker-host-joins`, {
        method: "POST",
        headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
        body: JSON.stringify({
          apiVersion: "supertag/v1",
          kind: "WorkerHostJoin",
          metadata: { name },
          spec: {},
        }),
      });
      expect(response.status).toBe(201);
      return ((await response.json()) as { metadata: { workerHostId: string } }).metadata
        .workerHostId;
    };

    await applyTag([]);
    const a = await join_("first", "host-a");
    // Declaring the joined host takes it over for apply.
    expect((await applyTag([a])).spec.workerHosts).toEqual([a]);

    // Redemption binds host b directly, outside apply, so b belongs to cli.
    const b = await join_("second", "host-b");
    expect((await applyTag([a])).spec.workerHosts).toEqual([a, b].toSorted());
    // Dropping a from the manifest removes only what apply owns.
    expect((await applyTag([])).spec.workerHosts).toEqual([b]);
  });
});
