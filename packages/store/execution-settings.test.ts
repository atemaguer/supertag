import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createIsolatedPostgresDatabase } from "../../tests/support/database.js";
import { DrizzleStore, migrateDatabase } from "./src/index.js";

const postgres = process.env["SUPERTAG_POSTGRES_URL"];

for (const dialect of ["sqlite", "postgresql"] as const) {
  describe.skipIf(dialect === "postgresql" && !postgres)(
    `${dialect} Role and Tag execution settings`,
    () => {
      const cleanups: Array<() => Promise<void>> = [];
      afterEach(async () => {
        for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
      });

      async function fixture() {
        const directory = await mkdtemp(join(tmpdir(), "supertag-execution-settings-"));
        cleanups.push(() => rm(directory, { recursive: true, force: true }));
        let url = `file:${join(directory, "state.db")}`;
        if (dialect === "postgresql") {
          const isolated = await createIsolatedPostgresDatabase(postgres as string);
          url = isolated.url;
          cleanups.push(isolated.cleanup);
        }
        await migrateDatabase({ url });
        const store = new DrizzleStore({ url });
        const reader = new DrizzleStore({ url });
        await store.connect();
        await reader.connect();
        cleanups.push(
          () => store.disconnect(),
          () => reader.disconnect(),
        );
        return { store, reader };
      }

      it("stores, replaces, and clears a Role's execution settings", async () => {
        const { store, reader } = await fixture();
        const created = await store.createRole({
          name: `Reviewer ${randomUUID()}`,
          purpose: "Review changes.",
          execution: { harness: "codex", model: ["gpt-6-sol"], effort: ["medium", "high"] },
        });
        expect(created.execution).toEqual({
          harness: "codex",
          model: ["gpt-6-sol"],
          effort: ["medium", "high"],
        });
        expect((await reader.findRoleById(created.id))?.execution).toEqual(created.execution);
        const unchanged = await store.updateRole(created.id, {
          expectedRevision: created.revision,
          execution: created.execution ?? null,
        });
        expect(unchanged.revision).toBe(created.revision);
        const replaced = await store.updateRole(created.id, {
          expectedRevision: created.revision,
          execution: { effort: ["high"] },
        });
        expect(replaced).toMatchObject({
          revision: created.revision + 1,
          execution: { effort: ["high"] },
        });
        const kept = await store.updateRole(created.id, {
          expectedRevision: replaced.revision,
          purpose: "Review every change.",
        });
        expect(kept.execution).toEqual({ effort: ["high"] });
        const cleared = await store.updateRole(created.id, {
          expectedRevision: kept.revision,
          execution: null,
        });
        expect(cleared.execution).toBeUndefined();
        expect((await reader.findRoleById(created.id))?.execution).toBeUndefined();
        await expect(
          store.createRole({
            name: `Broken ${randomUUID()}`,
            purpose: "Invalid.",
            execution: { effort: ["maximum"] } as never,
          }),
        ).rejects.toThrow("low, medium, high");
      });

      it("stores and clears a Tag's execution settings", async () => {
        const { store, reader } = await fixture();
        const tag = await store.createTag({ name: randomUUID() });
        expect(tag.execution).toBeUndefined();
        const updated = await store.setTagExecution(tag.id, {
          harness: "claude-code",
          model: ["claude-opus-5-5", "claude-sonnet-5-5"],
        });
        expect(updated.execution).toEqual({
          harness: "claude-code",
          model: ["claude-opus-5-5", "claude-sonnet-5-5"],
        });
        expect((await reader.findTagById(tag.id))?.execution).toEqual(updated.execution);
        const cleared = await store.setTagExecution(tag.id, undefined);
        expect(cleared.execution).toBeUndefined();
        expect((await reader.findTagById(tag.id))?.execution).toBeUndefined();
      });
    },
  );
}
