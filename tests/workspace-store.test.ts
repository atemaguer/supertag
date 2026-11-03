import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DrizzleStore, migrateDatabase } from "../packages/store/src/index.js";
import { createIsolatedPostgresDatabase } from "./support/database.js";

const postgres = process.env["SUPERTAG_POSTGRES_URL"];

for (const dialect of ["sqlite", "postgresql"] as const) {
  describe.skipIf(dialect === "postgresql" && !postgres)(`${dialect} Workspaces`, () => {
    const cleanups: Array<() => Promise<void>> = [];
    afterEach(async () => {
      for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
    });

    async function fixture() {
      const directory = await mkdtemp(join(tmpdir(), "supertag-workspace-store-"));
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

    it("creates, replaces, and lists Workspaces, and stores Objective workspaces", async () => {
      const store = await fixture();
      const created = await store.applyWorkspace({
        name: "app",
        source: "https://github.com/acme/app.git",
        ref: "main",
        setup: "npm ci",
        mcp: ["sentry"],
        skillCatalog: {
          repository: "acme/skills",
          path: "catalog",
          revision: "main",
          skills: ["review"],
        },
        mounts: [
          {
            volume: "datasets",
            path: "/mnt/datasets",
            access: "read-only",
            strategy: "copy",
            maxBytes: 1024,
          },
        ],
        delivery: "patch",
      });
      expect(created).toMatchObject({
        created: true,
        workspace: {
          name: "app",
          ref: "main",
          setup: "npm ci",
          mcp: ["sentry"],
          skillCatalog: {
            repository: "acme/skills",
            path: "catalog",
            revision: "main",
            skills: ["review"],
          },
          mounts: [
            {
              volume: "datasets",
              path: "/mnt/datasets",
              access: "read-only",
              strategy: "copy",
              maxBytes: 1024,
            },
          ],
          delivery: "patch",
          revision: 1,
        },
      });
      const unchanged = await store.applyWorkspace({
        name: "app",
        source: "https://github.com/acme/app.git",
        ref: "main",
        setup: "npm ci",
        mcp: ["sentry"],
        skillCatalog: {
          repository: "acme/skills",
          path: "catalog",
          revision: "main",
          skills: ["review"],
        },
        mounts: [
          {
            volume: "datasets",
            path: "/mnt/datasets",
            access: "read-only",
            strategy: "copy",
            maxBytes: 1024,
          },
        ],
        delivery: "patch",
      });
      expect(unchanged).toMatchObject({ created: false, workspace: { revision: 1 } });
      // Absent optional fields are cleared on replace.
      const replaced = await store.applyWorkspace({ name: "app", delivery: "branch" });
      expect(replaced.workspace).toMatchObject({ revision: 2, delivery: "branch" });
      expect(replaced.workspace).not.toHaveProperty("setup");
      expect(replaced.workspace).not.toHaveProperty("mcp");
      expect(replaced.workspace).not.toHaveProperty("skillCatalog");
      expect(replaced.workspace).not.toHaveProperty("source");
      expect(replaced.workspace).not.toHaveProperty("mounts");
      await store.applyWorkspace({ name: "docs", delivery: "branch" });
      expect((await store.listWorkspaces()).map((workspace) => workspace.name)).toEqual([
        "app",
        "docs",
      ]);
      expect(await store.findWorkspaceByName("missing")).toBeUndefined();
      await expect(store.applyWorkspace({ name: "web", delivery: "pull-request" })).rejects.toThrow(
        "needs spec.source naming a GitHub repository",
      );
      const github = await store.applyWorkspace({
        name: "web",
        source: "https://github.com/acme/web.git",
        delivery: "pull-request",
      });
      expect(github.workspace).toMatchObject({ delivery: "pull-request" });

      const owner = await store.createTag({ name: `owner-${randomUUID()}` });
      const objective = await store.createObjective({
        id: randomUUID(),
        ownerTagId: owner.id,
        outcome: "Ship it.",
        workspaces: ["app", "docs"],
      });
      expect((await store.getObjective(objective.id)).workspaces).toEqual(["app", "docs"]);
      // Retrying with different workspaces is a different definition.
      await expect(
        store.createObjective({
          id: objective.id,
          ownerTagId: owner.id,
          outcome: "Ship it.",
          workspaces: ["app"],
        }),
      ).rejects.toMatchObject({ statusCode: 409 });
      const plain = await store.createObjective({
        id: randomUUID(),
        ownerTagId: owner.id,
        outcome: "No repository.",
      });
      expect((await store.getObjective(plain.id)).workspaces).toEqual([]);
    });
  });
}
