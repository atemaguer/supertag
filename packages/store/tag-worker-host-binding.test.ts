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
    `${dialect} Tag Worker Host bindings`,
    () => {
      const cleanups: Array<() => Promise<void>> = [];
      afterEach(async () => {
        for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
      });

      async function fixture() {
        const directory = await mkdtemp(join(tmpdir(), "supertag-tag-worker-host-"));
        cleanups.push(() => rm(directory, { recursive: true, force: true }));
        let url = `file:${join(directory, "state.db")}`;
        if (dialect === "postgresql") {
          const isolated = await createIsolatedPostgresDatabase(postgres as string);
          url = isolated.url;
          cleanups.push(isolated.cleanup);
        }
        await migrateDatabase({ url });
        const store = new DrizzleStore({ url });
        const recovered = new DrizzleStore({ url });
        await store.connect();
        await recovered.connect();
        cleanups.push(
          () => store.disconnect(),
          () => recovered.disconnect(),
        );
        return { store, recovered };
      }

      it("persists an idempotent host pool and permits a temporarily unbound Tag", async () => {
        const { store, recovered } = await fixture();
        const tag = await store.createTag({ name: randomUUID() });
        const first = await store.bindTagWorkerHost(tag.id, "host-a");
        expect(await recovered.bindTagWorkerHost(tag.id, "host-a")).toEqual(first);
        await store.bindTagWorkerHost(tag.id, "host-b");
        expect(await recovered.listTagWorkerHostBindings(tag.id)).toMatchObject([
          { tagId: tag.id, workerHostId: "host-a" },
          { tagId: tag.id, workerHostId: "host-b" },
        ]);
        await recovered.unbindTagWorkerHost(tag.id, "host-a");
        await recovered.unbindTagWorkerHost(tag.id, "host-b");
        expect(await store.listTagWorkerHostBindings(tag.id)).toEqual([]);
      });
    },
  );
}
