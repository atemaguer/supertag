import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SurfaceAccountInput } from "../packages/core/src/index.js";
import { DrizzleStore, migrateDatabase } from "../packages/store/src/index.js";
import { createIsolatedPostgresDatabase } from "./support/database.js";

const postgres = process.env["SUPERTAG_POSTGRES_URL"];

const slack = (externalAccountId: string, extra: Partial<SurfaceAccountInput> = {}) => ({
  provider: "slack" as const,
  externalAccountId,
  displayName: "Acme",
  authMethod: "slack-socket-mode",
  credentialId: `surface/slack/${externalAccountId}`,
  status: "connected" as const,
  configuration: { transport: "socket" },
  verifiedAt: new Date().toISOString(),
  ...extra,
});

for (const dialect of ["sqlite", "postgresql"] as const) {
  describe.skipIf(dialect === "postgresql" && !postgres)(`${dialect} Surface Accounts`, () => {
    const cleanups: Array<() => Promise<void>> = [];
    afterEach(async () => {
      for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
    });

    async function fixture() {
      const directory = await mkdtemp(join(tmpdir(), "supertag-surface-account-store-"));
      const isolated =
        dialect === "postgresql" && postgres
          ? await createIsolatedPostgresDatabase(postgres)
          : undefined;
      const url = isolated?.url ?? `file:${join(directory, "state.db")}`;
      await migrateDatabase({ url });
      const store = new DrizzleStore({ url });
      await store.connect();
      cleanups.push(async () => {
        await store.disconnect();
        await isolated?.cleanup();
        await rm(directory, { recursive: true, force: true });
      });
      return store;
    }

    it("stores a manifest name and secret references, and keeps them across interactive setup", async () => {
      const store = await fixture();
      const references = { appToken: { env: "SLACK_APP_TOKEN" }, botToken: { secretRef: "bot" } };
      const saved = await store.saveSurfaceAccount(
        slack("T1", { name: "acme-slack", secretReferences: references }),
      );
      expect(saved).toMatchObject({ name: "acme-slack", secretReferences: references });
      expect(await store.findSurfaceAccountByName("acme-slack")).toMatchObject({ id: saved.id });

      // `supertag setup surface` saves without a name; the declaration stays.
      const resaved = await store.saveSurfaceAccount(slack("T1", { displayName: "Renamed" }));
      expect(resaved).toMatchObject({
        id: saved.id,
        name: "acme-slack",
        displayName: "Renamed",
        secretReferences: references,
      });
      // An account set up interactively has neither.
      const plain = await store.saveSurfaceAccount(slack("T2"));
      expect(plain.name).toBeUndefined();
      expect(plain.secretReferences).toBeUndefined();
    });

    it("gives each name to one account", async () => {
      const store = await fixture();
      await store.saveSurfaceAccount(slack("T1", { name: "acme-slack" }));
      await expect(store.saveSurfaceAccount(slack("T2", { name: "acme-slack" }))).rejects.toThrow();
    });

    it("retires an account for history, frees its name, and reconnects it on the next save", async () => {
      const store = await fixture();
      const saved = await store.saveSurfaceAccount(
        slack("T1", { name: "acme-slack", secretReferences: { botToken: { env: "A" } } }),
      );
      const retired = await store.retireSurfaceAccount(saved.id);
      expect(retired).toMatchObject({ id: saved.id, status: "retired" });
      expect(retired?.name).toBeUndefined();
      expect(retired?.secretReferences).toBeUndefined();

      expect(await store.listSurfaceAccounts()).toEqual([]);
      expect(await store.findSurfaceAccount("slack", "T1")).toBeUndefined();
      expect(await store.findSurfaceAccountByName("acme-slack")).toBeUndefined();
      // History still resolves the account by ID.
      expect(await store.findSurfaceAccountById(saved.id)).toMatchObject({ status: "retired" });

      // The name is free for another account.
      await store.saveSurfaceAccount(slack("T2", { name: "acme-slack" }));
      // Setting up the same provider account again reconnects the retired row.
      const again = await store.saveSurfaceAccount(slack("T1"));
      expect(again).toMatchObject({ id: saved.id, status: "connected" });
      expect((await store.listSurfaceAccounts()).map((account) => account.id)).toContain(saved.id);
    });
  });
}
