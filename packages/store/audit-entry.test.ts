import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createIsolatedPostgresDatabase } from "../../tests/support/database.js";
import { DrizzleStore, migrateDatabase } from "./src/index.js";

const postgres = process.env["SUPERTAG_POSTGRES_URL"];

for (const dialect of ["sqlite", "postgresql"] as const)
  describe.skipIf(dialect === "postgresql" && !postgres)(`${dialect} audit trail`, () => {
    const cleanups: Array<() => Promise<void>> = [];

    afterEach(async () => {
      for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
    });

    async function fixture() {
      const directory = await mkdtemp(join(tmpdir(), "supertag-audit-"));
      cleanups.push(() => rm(directory, { recursive: true, force: true }));
      let url = `file:${join(directory, "store.db")}`;
      if (dialect === "postgresql") {
        const isolated = await createIsolatedPostgresDatabase(postgres as string);
        url = isolated.url;
        cleanups.push(isolated.cleanup);
      }
      await migrateDatabase({ url });
      const store = new DrizzleStore({ url });
      await store.connect();
      cleanups.push(() => store.disconnect());
      return { url, store };
    }

    const at = (minute: number) => `2030-01-01T00:${minute.toString().padStart(2, "0")}:00.000Z`;

    it("stores entries durably and lists them newest first with filters", async () => {
      const { url, store } = await fixture();
      const recorded = await store.recordAuditEntry({
        at: at(1),
        actor: "control-plane-break-glass",
        action: "operator-token.create",
        target: "OperatorToken/laptop-2",
        outcome: "succeeded",
        status: 201,
        source: "api",
        method: "POST",
        path: "/api/v1/operator-tokens",
      });
      expect(recorded).toEqual({
        id: expect.any(String),
        at: at(1),
        actor: "control-plane-break-glass",
        action: "operator-token.create",
        target: "OperatorToken/laptop-2",
        outcome: "succeeded",
        status: 201,
        source: "api",
        method: "POST",
        path: "/api/v1/operator-tokens",
      });
      await store.recordAuditEntry({
        at: at(2),
        actor: "token:laptop-2",
        action: "apply",
        target: "Tag/builder",
        outcome: "failed",
        status: 400,
        source: "api",
        method: "POST",
        path: "/api/v1/tags",
      });
      await store.recordAuditEntry({
        at: at(3),
        actor: "slack:U123",
        action: "objective.approve",
        target: "Objective/release",
        outcome: "succeeded",
        source: "gateway",
      });

      // A second connection reads what the first wrote.
      const other = new DrizzleStore({ url });
      await other.connect();
      cleanups.push(() => other.disconnect());
      const all = await other.listAuditEntries();
      expect(all.map((entry) => entry.target)).toEqual([
        "Objective/release",
        "Tag/builder",
        "OperatorToken/laptop-2",
      ]);
      expect(all[0]).toEqual({
        id: expect.any(String),
        at: at(3),
        actor: "slack:U123",
        action: "objective.approve",
        target: "Objective/release",
        outcome: "succeeded",
        source: "gateway",
      });
      expect((await other.listAuditEntries({ since: at(2) })).map((entry) => entry.action)).toEqual(
        ["objective.approve", "apply"],
      );
      expect(
        (await other.listAuditEntries({ actor: "token:laptop-2" })).map((entry) => entry.at),
      ).toEqual([at(2)]);
      expect(await other.listAuditEntries({ actor: "token:laptop-2", since: at(3) })).toEqual([]);
      expect((await other.listAuditEntries({ limit: 1 })).map((entry) => entry.at)).toEqual([
        at(3),
      ]);
    });

    it("refuses incomplete entries and out-of-range limits", async () => {
      const { store } = await fixture();
      const valid = {
        at: at(1),
        actor: "token:laptop-2",
        action: "delete",
        target: "Role/reviewer",
        outcome: "succeeded",
        source: "api",
      } as const;
      await expect(store.recordAuditEntry({ ...valid, actor: " " })).rejects.toThrow(/actor/u);
      await expect(store.recordAuditEntry({ ...valid, at: "yesterday" })).rejects.toThrow(/time/u);
      await expect(
        store.recordAuditEntry({ ...valid, outcome: "maybe" as "succeeded" }),
      ).rejects.toThrow(/outcome/u);
      await expect(store.listAuditEntries({ limit: 0 })).rejects.toThrow(/limit/u);
      await expect(store.listAuditEntries({ limit: 501 })).rejects.toThrow(/limit/u);
      expect(await store.listAuditEntries()).toEqual([]);
    });
  });
