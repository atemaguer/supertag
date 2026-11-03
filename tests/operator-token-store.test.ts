import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  isOperatorTokenSecret,
  OPERATOR_TOKEN_LIFETIME_MS,
  operatorTokenLookupId,
  operatorTokenOperatorId,
  operatorTokenPhase,
  parseOperatorTokenName,
} from "../packages/core/src/index.js";
import { DrizzleStore, migrateDatabase } from "../packages/store/src/index.js";
import { createIsolatedPostgresDatabase } from "./support/database.js";

const postgres = process.env["SUPERTAG_POSTGRES_URL"];

function secret() {
  const lookupId = randomBytes(8).toString("hex");
  const value = `stop_${lookupId}${randomBytes(24).toString("hex")}`;
  return { value, lookupId, secretDigest: createHash("sha256").update(value).digest("hex") };
}

describe("Operator Token values", () => {
  it("recognizes secrets, derives the lookup part, and names the operator", () => {
    const { value, lookupId } = secret();
    expect(isOperatorTokenSecret(value)).toBe(true);
    expect(isOperatorTokenSecret(`stak_${value.slice(5)}`)).toBe(false);
    expect(operatorTokenLookupId(value)).toBe(lookupId);
    expect(() => operatorTokenLookupId("stop_short")).toThrow("invalid");
    expect(operatorTokenOperatorId("laptop-2")).toBe("token:laptop-2");
    expect(() => parseOperatorTokenName("Laptop 2")).toThrow("lowercase");
    const now = new Date().toISOString();
    const token = { id: "1", name: "a", expiresAt: now, createdAt: now, updatedAt: now };
    expect(operatorTokenPhase(token, new Date(Date.parse(now) - 1).toISOString())).toBe("active");
    expect(operatorTokenPhase(token, now)).toBe("expired");
    expect(operatorTokenPhase({ ...token, revokedAt: now }, now)).toBe("revoked");
  });
});

for (const dialect of ["sqlite", "postgresql"] as const) {
  describe.skipIf(dialect === "postgresql" && !postgres)(`${dialect} Operator Tokens`, () => {
    const cleanups: Array<() => Promise<void>> = [];
    afterEach(async () => {
      for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
    });

    async function fixture() {
      const directory = await mkdtemp(join(tmpdir(), "supertag-operator-token-store-"));
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

    it("creates, lists, and revokes tokens with fixed expiry and no stored secret", async () => {
      const store = await fixture();
      const createdAt = new Date().toISOString();
      const issued = secret();
      const token = await store.createOperatorToken({
        name: "laptop-2",
        lookupId: issued.lookupId,
        secretDigest: issued.secretDigest,
        createdAt,
      });
      expect(Date.parse(token.expiresAt) - Date.parse(createdAt)).toBe(OPERATOR_TOKEN_LIFETIME_MS);
      expect(token).not.toHaveProperty("lastUsedAt");
      expect(JSON.stringify(token)).not.toContain(issued.secretDigest);
      await expect(
        store.createOperatorToken({ name: "laptop-2", ...secret(), createdAt }),
      ).rejects.toThrow("names are never reused");
      await store.createOperatorToken({ name: "ci", ...secret(), createdAt });
      expect((await store.listOperatorTokens()).map((item) => item.name)).toEqual([
        "ci",
        "laptop-2",
      ]);

      const revokedAt = new Date().toISOString();
      const revoked = await store.revokeOperatorToken("laptop-2", revokedAt);
      expect(revoked?.revokedAt).toBe(revokedAt);
      // Revoking again keeps the first revocation time.
      expect((await store.revokeOperatorToken("laptop-2", createdAt))?.revokedAt).toBe(revokedAt);
      expect(await store.revokeOperatorToken("missing", revokedAt)).toBeUndefined();
      // Revoked names stay taken.
      await expect(
        store.createOperatorToken({ name: "laptop-2", ...secret(), createdAt }),
      ).rejects.toThrow("already exists");
    });

    it("authenticates by constant-time digest and refuses revoked and expired tokens", async () => {
      const store = await fixture();
      const createdAt = new Date().toISOString();
      const issued = secret();
      const token = await store.createOperatorToken({
        name: "laptop-2",
        lookupId: issued.lookupId,
        secretDigest: issued.secretDigest,
        createdAt,
      });
      const at = (offset: number) => new Date(Date.parse(createdAt) + offset).toISOString();
      const first = await store.authenticateOperatorToken({
        lookupId: issued.lookupId,
        secretDigest: issued.secretDigest,
        authenticatedAt: at(1_000),
      });
      expect(first).toMatchObject({
        status: "authenticated",
        operatorToken: { name: "laptop-2", lastUsedAt: at(1_000) },
      });
      // lastUsedAt is refreshed at most once a minute.
      const soon = await store.authenticateOperatorToken({
        lookupId: issued.lookupId,
        secretDigest: issued.secretDigest,
        authenticatedAt: at(30_000),
      });
      expect(soon).toMatchObject({ operatorToken: { lastUsedAt: at(1_000) } });
      const later = await store.authenticateOperatorToken({
        lookupId: issued.lookupId,
        secretDigest: issued.secretDigest,
        authenticatedAt: at(120_000),
      });
      expect(later).toMatchObject({ operatorToken: { lastUsedAt: at(120_000) } });

      for (const wrong of [
        { lookupId: issued.lookupId, secretDigest: secret().secretDigest },
        { lookupId: issued.lookupId, secretDigest: "not-a-digest" },
        { lookupId: "0000000000000000", secretDigest: issued.secretDigest },
      ])
        expect(
          await store.authenticateOperatorToken({ ...wrong, authenticatedAt: at(1_000) }),
        ).toEqual({ status: "invalid" });

      expect(
        await store.authenticateOperatorToken({
          lookupId: issued.lookupId,
          secretDigest: issued.secretDigest,
          authenticatedAt: token.expiresAt,
        }),
      ).toEqual({ status: "expired" });

      await store.revokeOperatorToken("laptop-2", at(200_000));
      expect(
        await store.authenticateOperatorToken({
          lookupId: issued.lookupId,
          secretDigest: issued.secretDigest,
          authenticatedAt: at(300_000),
        }),
      ).toEqual({ status: "revoked" });
    });
  });
}
