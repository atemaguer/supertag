import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ONE_OFF_AUTH_KEY_LIFETIME_MS,
  REUSABLE_AUTH_KEY_LIFETIME_MS,
} from "../packages/core/src/index.js";
import { DrizzleStore, migrateDatabase } from "../packages/store/src/index.js";
import { createIsolatedPostgresDatabase } from "./support/database.js";

const postgres = process.env["SUPERTAG_POSTGRES_URL"];

function secret() {
  const lookupId = randomBytes(8).toString("hex");
  const value = `stak_${lookupId}${randomBytes(24).toString("hex")}`;
  return { lookupId, secretDigest: createHash("sha256").update(value).digest("hex") };
}

for (const dialect of ["sqlite", "postgresql"] as const) {
  describe.skipIf(dialect === "postgresql" && !postgres)(`${dialect} Auth Keys`, () => {
    const cleanups: Array<() => Promise<void>> = [];
    afterEach(async () => {
      for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
    });

    async function fixture() {
      const directory = await mkdtemp(join(tmpdir(), "supertag-auth-key-store-"));
      const isolated =
        dialect === "postgresql" && postgres
          ? await createIsolatedPostgresDatabase(postgres)
          : undefined;
      const url = isolated?.url ?? `file:${join(directory, "state.db")}`;
      await migrateDatabase({ url });
      const stores = [new DrizzleStore({ url }), new DrizzleStore({ url })] as const;
      for (const store of stores) await store.connect();
      cleanups.push(async () => {
        for (const store of stores) await store.disconnect();
        await isolated?.cleanup();
        await rm(directory, { recursive: true, force: true });
      });
      return stores;
    }

    function redemption(key: ReturnType<typeof secret>, workerHostName = "laptop") {
      return {
        ...key,
        workerHostName,
        credentialId: `test/credential/${randomUUID()}`,
        redeemedAt: new Date().toISOString(),
      };
    }

    it("creates, lists, and revokes keys with fixed expiry and no stored secret", async () => {
      const [store] = await fixture();
      const builder = await store.createTag({ name: "builder" });
      const createdAt = new Date().toISOString();
      const oneOff = await store.createAuthKey({
        name: "laptop-key",
        tagIds: [builder.id],
        reusable: false,
        ephemeral: false,
        createdAt,
        ...secret(),
      });
      expect(Date.parse(oneOff.expiresAt) - Date.parse(createdAt)).toBe(
        ONE_OFF_AUTH_KEY_LIFETIME_MS,
      );
      const reusable = await store.createAuthKey({
        name: "ci",
        tagIds: [builder.id],
        reusable: true,
        ephemeral: true,
        createdAt,
        ...secret(),
      });
      expect(Date.parse(reusable.expiresAt) - Date.parse(createdAt)).toBe(
        REUSABLE_AUTH_KEY_LIFETIME_MS,
      );
      expect(reusable).toMatchObject({ reusable: true, ephemeral: true, redemptionCount: 0 });
      expect(JSON.stringify(reusable)).not.toContain("secret");
      // Keys created at the same time list by name.
      expect((await store.listAuthKeys()).map((key) => key.name)).toEqual(["ci", "laptop-key"]);

      await expect(
        store.createAuthKey({
          name: "ci",
          tagIds: [builder.id],
          reusable: true,
          ephemeral: false,
          createdAt,
          ...secret(),
        }),
      ).rejects.toMatchObject({ statusCode: 409 });
      await expect(
        store.createAuthKey({
          name: "ghost",
          tagIds: [randomUUID()],
          reusable: false,
          ephemeral: false,
          createdAt,
          ...secret(),
        }),
      ).rejects.toMatchObject({ statusCode: 400 });
      await expect(
        store.createAuthKey({
          name: "Bad Name",
          tagIds: [builder.id],
          reusable: false,
          ephemeral: false,
          createdAt,
          ...secret(),
        }),
      ).rejects.toMatchObject({ statusCode: 400 });

      const revokedAt = new Date().toISOString();
      const revoked = await store.revokeAuthKey("ci", revokedAt);
      expect(revoked?.revokedAt).toBe(revokedAt);
      // Revocation is idempotent and keeps the first revocation time.
      expect((await store.revokeAuthKey("ci", new Date().toISOString()))?.revokedAt).toBe(
        revokedAt,
      );
      expect(await store.revokeAuthKey("missing", revokedAt)).toBeUndefined();
      expect(await store.findAuthKeyByName("missing")).toBeUndefined();
    });

    it("redeems a one-off key once, enrolls the host, and binds the key's Tags", async () => {
      const [store] = await fixture();
      const builder = await store.createTag({ name: "builder" });
      const reviewer = await store.createTag({ name: "reviewer" });
      const key = secret();
      await store.createAuthKey({
        name: "laptop-key",
        tagIds: [builder.id, reviewer.id],
        reusable: false,
        ephemeral: false,
        createdAt: new Date().toISOString(),
        ...key,
      });

      expect(
        await store.redeemAuthKey(redemption({ ...key, secretDigest: "0".repeat(64) })),
      ).toEqual({ status: "invalid" });
      expect(await store.redeemAuthKey(redemption({ ...key, lookupId: "0".repeat(16) }))).toEqual({
        status: "invalid",
      });

      const redeemed = await store.redeemAuthKey(redemption(key));
      expect(redeemed).toMatchObject({
        status: "redeemed",
        authKey: { name: "laptop-key", redemptionCount: 1, usedAt: expect.any(String) },
        workerHost: {
          id: "laptop",
          enrollmentStatus: "active",
          ephemeral: false,
          authKey: "laptop-key",
          credentialRevision: 1,
        },
      });
      expect(
        (await store.listTagWorkerHostBindings(builder.id)).map((b) => b.workerHostId),
      ).toEqual(["laptop"]);
      expect(
        (await store.listTagWorkerHostBindings(reviewer.id)).map((b) => b.workerHostId),
      ).toEqual(["laptop"]);
      expect(await store.redeemAuthKey(redemption(key, "other"))).toEqual({ status: "used" });
      expect(await store.findWorkerHostById("other")).toBeUndefined();
    });

    it("rejects expired and revoked keys", async () => {
      const [store] = await fixture();
      const builder = await store.createTag({ name: "builder" });
      const expired = secret();
      await store.createAuthKey({
        name: "old",
        tagIds: [builder.id],
        reusable: false,
        ephemeral: false,
        createdAt: new Date(Date.now() - ONE_OFF_AUTH_KEY_LIFETIME_MS - 1000).toISOString(),
        ...expired,
      });
      expect(await store.redeemAuthKey(redemption(expired))).toEqual({ status: "expired" });

      const revoked = secret();
      await store.createAuthKey({
        name: "revoked",
        tagIds: [builder.id],
        reusable: true,
        ephemeral: false,
        createdAt: new Date().toISOString(),
        ...revoked,
      });
      expect((await store.redeemAuthKey(redemption(revoked, "first"))).status).toBe("redeemed");
      await store.revokeAuthKey("revoked", new Date().toISOString());
      expect(await store.redeemAuthKey(redemption(revoked, "second"))).toEqual({
        status: "revoked",
      });
      // Hosts that joined before revocation keep their enrollment.
      expect((await store.findWorkerHostById("first"))?.enrollmentStatus).toBe("active");
      expect(await store.listWorkerHosts()).toHaveLength(1);
    });

    it("joins many ephemeral hosts with a reusable key and picks NAME-2 on collision", async () => {
      const [store] = await fixture();
      const builder = await store.createTag({ name: "builder" });
      const key = secret();
      await store.createAuthKey({
        name: "ci",
        tagIds: [builder.id],
        reusable: true,
        ephemeral: true,
        createdAt: new Date().toISOString(),
        ...key,
      });
      const ids: string[] = [];
      for (let index = 0; index < 3; index += 1) {
        const result = await store.redeemAuthKey(redemption(key, "runner"));
        if (result.status !== "redeemed") throw new Error(result.status);
        expect(result.workerHost.ephemeral).toBe(true);
        ids.push(result.workerHost.id);
      }
      expect(ids).toEqual(["runner", "runner-2", "runner-3"]);
      expect((await store.findAuthKeyByName("ci"))?.redemptionCount).toBe(3);
      expect(
        (await store.listTagWorkerHostBindings(builder.id)).map((b) => b.workerHostId).sort(),
      ).toEqual(["runner", "runner-2", "runner-3"]);
    });

    it("finds a key by its secret only, and enrolls one host for one join request", async () => {
      const stores = await fixture();
      const builder = await stores[0].createTag({ name: "builder" });
      const key = secret();
      await stores[0].createAuthKey({
        name: "retry",
        tagIds: [builder.id],
        reusable: true,
        ephemeral: false,
        createdAt: new Date().toISOString(),
        ...key,
      });
      await expect(stores[0].findAuthKeyBySecret(key)).resolves.toMatchObject({ name: "retry" });
      await expect(
        stores[0].findAuthKeyBySecret({ ...key, secretDigest: "0".repeat(64) }),
      ).resolves.toBeUndefined();

      const prefix = `join/${randomBytes(8).toString("hex")}/`;
      const request = (store: (typeof stores)[number], name: string) =>
        store.redeemAuthKey({
          ...redemption(key, name),
          credentialId: `${prefix}${randomUUID()}`,
          joinCredentialPrefix: prefix,
        });
      const results = await Promise.all(
        Array.from({ length: 4 }, (_, index) => request(stores[index % 2], `same-${index}`)),
      );
      expect(results.filter((result) => result.status === "redeemed")).toHaveLength(1);
      expect(results.filter((result) => result.status === "repeated")).toHaveLength(3);
      const ids = new Set(
        results.map((result) => ("workerHost" in result ? result.workerHost.id : result.status)),
      );
      expect(ids.size).toBe(1);
      expect(await stores[0].listWorkerHosts()).toHaveLength(1);
      expect((await stores[0].findAuthKeyByName("retry"))?.redemptionCount).toBe(1);
      expect((await request(stores[0], "later")).status).toBe("repeated");
      expect((await stores[0].redeemAuthKey(redemption(key, "other"))).status).toBe("redeemed");
    });

    it("lets exactly one concurrent redemption of a one-off key succeed", async () => {
      const stores = await fixture();
      const builder = await stores[0].createTag({ name: "builder" });
      const key = secret();
      await stores[0].createAuthKey({
        name: "race",
        tagIds: [builder.id],
        reusable: false,
        ephemeral: false,
        createdAt: new Date().toISOString(),
        ...key,
      });
      const results = await Promise.all(
        Array.from({ length: 6 }, (_, index) =>
          stores[index % 2].redeemAuthKey(redemption(key, `racer-${index}`)),
        ),
      );
      expect(results.filter((result) => result.status === "redeemed")).toHaveLength(1);
      expect(results.filter((result) => result.status === "used")).toHaveLength(5);
      expect(await stores[0].listWorkerHosts()).toHaveLength(1);
      expect((await stores[0].findAuthKeyByName("race"))?.redemptionCount).toBe(1);
    });
  });
}
