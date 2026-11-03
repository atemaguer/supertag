import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import {
  CONTROL_PLANE_COORDINATION_KEY_ID,
  loadControlPlaneCoordinationKey,
} from "../apps/cli/src/coordination-key.js";
import type { GatewayCredentialVault } from "../packages/core/src/index.js";
import {
  FileGatewayCredentialVault,
  VaultGatewayCredentialVault,
} from "../packages/store/src/index.js";

it("concurrent file vault bootstraps share one stable private signing key", async () => {
  const directory = await mkdtemp(join(tmpdir(), "coordination-key-"));
  const path = join(directory, "credentials.json");
  try {
    const keys = await Promise.all(
      Array.from({ length: 12 }, () =>
        loadControlPlaneCoordinationKey(new FileGatewayCredentialVault(path)),
      ),
    );
    expect(
      keys.every((key) => key.length === 32 && Buffer.from(key).equals(Buffer.from(keys[0] ?? []))),
    ).toBe(true);
    expect(await loadControlPlaneCoordinationKey(new FileGatewayCredentialVault(path))).toEqual(
      keys[0],
    );
    expect((await stat(path)).mode & 0o077).toBe(0);
    const vault = new FileGatewayCredentialVault(path);
    await vault.store("other/credential", { token: "preserved" });
    await loadControlPlaneCoordinationKey(vault);
    expect(await vault.resolve("other/credential")).toEqual({ token: "preserved" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("custom vaults require preprovisioning instead of unsafe unconditional bootstrap", async () => {
  const store = vi.fn(async () => {});
  const vault: GatewayCredentialVault = {
    store,
    resolve: async () => undefined,
    delete: async () => {},
  };
  await expect(loadControlPlaneCoordinationKey(vault)).rejects.toThrow(/preprovision/);
  expect(store).not.toHaveBeenCalled();
  const encoded = Buffer.alloc(32, 7).toString("base64url");
  expect(
    await loadControlPlaneCoordinationKey({ ...vault, resolve: async () => ({ key: encoded }) }),
  ).toEqual(Buffer.alloc(32, 7));
  for (const key of ["", "not-a-key", Buffer.alloc(31).toString("base64url"), `${encoded}=`]) {
    await expect(
      loadControlPlaneCoordinationKey({ ...vault, resolve: async () => ({ key }) }),
    ).rejects.toThrow("Invalid persisted Control Plane coordination signing key");
  }
});

it("Vault KV v2 bootstrap uses CAS zero and reads the winner without overwriting", async () => {
  const winner = { key: Buffer.alloc(32, 9).toString("base64url") };
  const requests: Array<{ method: string; body?: string }> = [];
  const request = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    requests.push({
      method: init?.method ?? "GET",
      ...(typeof init?.body === "string" ? { body: init.body } : {}),
    });
    if (init?.method === "POST") return new Response("conflict", { status: 400 });
    return new Response(JSON.stringify({ data: { data: winner } }), { status: 200 });
  });
  const vault = new VaultGatewayCredentialVault({
    address: "https://vault.example",
    token: "test-token",
    request: request as typeof fetch,
  });
  expect(await vault.storeIfAbsent(CONTROL_PLANE_COORDINATION_KEY_ID, { key: "loser" })).toEqual(
    winner,
  );
  expect(requests).toEqual([
    { method: "POST", body: JSON.stringify({ options: { cas: 0 }, data: { key: "loser" } }) },
    { method: "GET" },
  ]);
});
