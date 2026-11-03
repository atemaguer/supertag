import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CreateTeamInput, TeamScaling } from "@supertag/core";
import { afterEach, describe, expect, it } from "vitest";
import { createIsolatedPostgresDatabase } from "../../tests/support/database.js";
import { DrizzleStore, migrateDatabase } from "./src/index.js";

const postgres = process.env["SUPERTAG_POSTGRES_URL"];
for (const dialect of ["sqlite", "postgresql"] as const) {
  describe.skipIf(dialect === "postgresql" && !postgres)(`${dialect} Team scaling`, () => {
    const cleanups: Array<() => Promise<void>> = [];
    afterEach(async () => {
      for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
    });
    async function fixture() {
      const directory = await mkdtemp(join(tmpdir(), "supertag-team-scaling-"));
      cleanups.push(() => rm(directory, { recursive: true, force: true }));
      let url = `file:${join(directory, "store.db")}`;
      if (dialect === "postgresql") {
        const isolated = await createIsolatedPostgresDatabase(postgres as string);
        url = isolated.url;
        cleanups.push(isolated.cleanup);
      }
      await migrateDatabase({ url });
      const store = new DrizzleStore({ url }),
        other = new DrizzleStore({ url });
      await store.connect();
      await other.connect();
      cleanups.push(
        () => store.disconnect(),
        () => other.disconnect(),
      );
      const owner = await store.createTag({ name: randomUUID() });
      const objective = await store.createObjective({
        id: randomUUID(),
        ownerTagId: owner.id,
        outcome: "Ship",
      });
      const second = await store.createObjective({
        id: randomUUID(),
        ownerTagId: owner.id,
        outcome: "Share",
      });
      const input = (parentTeamId?: string, scaling?: TeamScaling): CreateTeamInput => ({
        id: randomUUID(),
        objectiveId: objective.id,
        name: "Team",
        leadTagId: owner.id,
        memberTagIds: [owner.id],
        maxConcurrency: 4,
        ...(parentTeamId ? { parentTeamId } : {}),
        ...(scaling ? { scaling } : {}),
      });
      return { store, other, owner, objective, second, input };
    }
    it("inherits breadth at each level and counts only active direct children", async () => {
      const f = await fixture();
      const root = await f.store.createTeam(f.input(undefined, { maxBreadth: 1 }));
      const first = await f.store.createTeam(f.input(root.id));
      const childInput = f.input(first.id, { maxBreadth: 100 });
      const grandchild = await f.store.createTeam(childInput);
      expect(await f.store.createTeam(childInput)).toEqual(grandchild);
      await expect(f.store.createTeam(f.input(root.id))).rejects.toThrow("maxBreadth");
      await expect(f.store.createTeam(f.input(first.id))).rejects.toThrow("maxBreadth");
      await f.store.updateTeam(grandchild.id, { expectedRevision: 1, status: "dissolved" });
      expect(await f.store.createTeam(f.input(first.id))).toMatchObject({ scaling: {} });
    });
    it("replays a dissolved child without consuming the replacement child's scaling slot", async () => {
      const f = await fixture();
      const root = await f.store.createTeam(f.input(undefined, { maxBreadth: 1 }));
      const originalInput = f.input(root.id);
      const original = await f.store.createTeam(originalInput);
      const dissolved = await f.store.updateTeam(original.id, {
        expectedRevision: 1,
        status: "dissolved",
      });
      await f.store.createTeam(f.input(root.id));
      expect(await f.other.createTeam(originalInput)).toEqual(dissolved);
      await expect(f.other.createTeam({ ...originalInput, name: "Different" })).rejects.toThrow(
        "different definition",
      );
      const active = (await f.store.listTeams(f.objective.id)).filter(
        (team) => team.parentTeamId === root.id && team.status === "active",
      );
      expect(active).toHaveLength(1);
    });
    it("decrements ancestor depth and honors stricter local depth including zero", async () => {
      const f = await fixture();
      const root = await f.store.createTeam(f.input(undefined, { maxDepth: 2 }));
      const child = await f.store.createTeam(f.input(root.id, { maxDepth: 100 }));
      const leaf = await f.store.createTeam(f.input(child.id));
      await expect(f.store.createTeam(f.input(leaf.id))).rejects.toThrow("maxDepth");
      const strict = await f.store.createTeam(f.input(root.id, { maxDepth: 0 }));
      await expect(f.store.createTeam(f.input(strict.id))).rejects.toThrow("maxDepth");
    });
    it("merges policy updates and rejects limits that invalidate existing descendants", async () => {
      const f = await fixture();
      const root = await f.store.createTeam(f.input(undefined, { maxBreadth: 2, maxDepth: 3 }));
      const child = await f.store.createTeam(f.input(root.id));
      await f.store.createTeam(f.input(child.id));
      await f.store.createTeam(f.input(child.id));
      await expect(
        f.store.updateTeam(root.id, { expectedRevision: 1, scaling: { maxBreadth: 1 } }),
      ).rejects.toThrow("maxBreadth");
      await expect(
        f.store.updateTeam(root.id, { expectedRevision: 1, scaling: { maxDepth: 1 } }),
      ).rejects.toThrow("maxDepth");
      const updated = await f.store.updateTeam(root.id, {
        expectedRevision: 1,
        scaling: { maxDepth: 2 },
      });
      expect(updated.scaling).toEqual({ maxBreadth: 2, maxDepth: 2 });
      expect(
        (await f.store.updateTeam(root.id, { expectedRevision: 2, scaling: {} })).scaling,
      ).toEqual(updated.scaling);
    });
    it("serializes last-slot admissions across shared Objectives and retains limits after governance transfer", async () => {
      const f = await fixture();
      const root = await f.store.createTeam({
        ...f.input(undefined, { maxBreadth: 1, maxDepth: 1 }),
        objectiveIds: [f.second.id],
      });
      const claims = await Promise.allSettled([
        f.store.createTeam(f.input(root.id)),
        f.other.createTeam({ ...f.input(root.id), objectiveId: f.second.id }),
      ]);
      expect(claims.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      const transferred = await f.store.updateTeam(root.id, {
        expectedRevision: 1,
        objectiveId: f.second.id,
      });
      expect(transferred.scaling).toEqual(root.scaling);
      await expect(
        f.store.createTeam({ ...f.input(root.id), objectiveId: f.second.id }),
      ).rejects.toThrow("maxBreadth");
    });
    it("serializes policy tightening against concurrent child creation", async () => {
      const f = await fixture();
      const root = await f.store.createTeam(f.input());
      const results = await Promise.allSettled([
        f.store.updateTeam(root.id, { expectedRevision: 1, scaling: { maxDepth: 0 } }),
        f.other.createTeam(f.input(root.id)),
      ]);
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      const current = await f.store.getTeam(root.id);
      const children = (await f.store.listTeams(f.objective.id)).filter(
        (team) => team.parentTeamId === root.id,
      );
      expect(current.scaling.maxDepth === 0 && children.length > 0).toBe(false);
    });
  });
}
