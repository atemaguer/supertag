import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DrizzleStore, migrateDatabase } from "../packages/store/src/index.js";
import { createIsolatedPostgresDatabase } from "./support/database.js";

const postgres = process.env["SUPERTAG_POSTGRES_URL"];
for (const dialect of ["sqlite", "postgresql"] as const) {
  describe.skipIf(dialect === "postgresql" && !postgres)(`${dialect} Teams`, () => {
    const cleanups: Array<() => Promise<void>> = [];
    afterEach(async () => {
      for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
    }, 30_000);
    async function fixture() {
      const directory = await mkdtemp(join(tmpdir(), "supertag-team-"));
      cleanups.push(() => rm(directory, { recursive: true, force: true }));
      let url = `file:${join(directory, "state.db")}`;
      if (dialect === "postgresql") {
        const isolated = await createIsolatedPostgresDatabase(postgres as string);
        url = isolated.url;
        cleanups.push(isolated.cleanup);
      }
      await migrateDatabase({ url });
      const store = new DrizzleStore({ url });
      await store.connect();
      cleanups.push(() => store.disconnect());
      const owner = await store.createTag({ name: `owner-${randomUUID()}` });
      const member = await store.createTag({ name: `member-${randomUUID()}` });
      const outsider = await store.createTag({ name: `outsider-${randomUUID()}` });
      const input = {
        id: randomUUID(),
        name: `engineering-${randomUUID()}`,
        memberTagIds: [owner.id, member.id],
        maxConcurrency: 4,
      };
      return { store, owner, member, outsider, input };
    }

    it("creates a flat Team idempotently and refuses a changed definition or a taken name", async () => {
      const f = await fixture();
      const team = await f.store.createTeam(f.input);
      expect(team).toMatchObject({
        id: f.input.id,
        name: f.input.name,
        maxConcurrency: 4,
        revision: 1,
      });
      expect(team.memberTagIds).toEqual([f.owner.id, f.member.id].toSorted());
      // Repeating the same definition returns the same Team, so apply is idempotent.
      expect(await f.store.createTeam(f.input)).toEqual(team);
      await expect(
        f.store.createTeam({ ...f.input, memberTagIds: [f.owner.id] }),
      ).rejects.toMatchObject({ statusCode: 409 });
      await expect(f.store.createTeam({ ...f.input, id: randomUUID() })).rejects.toMatchObject({
        statusCode: 409,
      });
      // Every member must be an active Tag.
      await expect(
        f.store.createTeam({
          id: randomUUID(),
          name: `ghosts-${randomUUID()}`,
          memberTagIds: [f.owner.id, "missing-tag"],
        }),
      ).rejects.toMatchObject({ statusCode: 404 });
    }, 30_000);

    it("has no concurrency limit unless one is set, and removes it with null", async () => {
      const f = await fixture();
      const team = await f.store.createTeam({
        id: randomUUID(),
        name: `unlimited-${randomUUID()}`,
        memberTagIds: [f.owner.id],
      });
      expect(team.maxConcurrency).toBeNull();
      const limited = await f.store.updateTeam(team.id, {
        expectedRevision: 1,
        maxConcurrency: 2,
      });
      expect(limited).toMatchObject({ maxConcurrency: 2, revision: 2 });
      expect(
        (await f.store.updateTeam(team.id, { expectedRevision: 2, maxConcurrency: null }))
          .maxConcurrency,
      ).toBeNull();
      await expect(
        f.store.updateTeam(team.id, { expectedRevision: 3, maxConcurrency: 0 }),
      ).rejects.toMatchObject({ statusCode: 400 });
    }, 30_000);

    it("replaces the member list, fences updates on the revision, and lists a Tag's Teams", async () => {
      const f = await fixture();
      const team = await f.store.createTeam(f.input);
      const updated = await f.store.updateTeam(team.id, {
        expectedRevision: 1,
        memberTagIds: [f.owner.id, f.outsider.id],
      });
      expect(updated.memberTagIds).toEqual([f.owner.id, f.outsider.id].toSorted());
      expect(updated.revision).toBe(2);
      await expect(
        f.store.updateTeam(team.id, { expectedRevision: 1, name: "Stale" }),
      ).rejects.toMatchObject({ statusCode: 409 });
      // Only one of two concurrent writers at the same revision wins.
      const writes = await Promise.allSettled(
        ["One", "Two"].map((name) =>
          f.store.updateTeam(team.id, { expectedRevision: 2, name: `${name}-${team.id}` }),
        ),
      );
      expect(writes.filter((write) => write.status === "fulfilled")).toHaveLength(1);
      expect((await f.store.listTeamsOfTag(f.owner.id)).map((item) => item.id)).toEqual([team.id]);
      expect(await f.store.listTeamsOfTag(f.member.id)).toEqual([]);
      expect((await f.store.listTeams()).map((item) => item.id)).toContain(team.id);
      await expect(
        f.store.updateTeam(randomUUID(), { expectedRevision: 1, name: "Nobody" }),
      ).rejects.toMatchObject({ statusCode: 404 });
    }, 30_000);

    it("refuses to delete a Team an open Objective names, and keeps closed Objectives", async () => {
      const f = await fixture();
      const team = await f.store.createTeam(f.input);
      const objective = await f.store.createObjective({
        id: randomUUID(),
        ownerTagId: f.owner.id,
        outcome: "Ship",
        teamId: team.id,
      });
      await expect(f.store.deleteTeam(team.id)).rejects.toMatchObject({ statusCode: 409 });
      await f.store.post({ teamId: team.id, authorTagId: f.owner.id, body: "Starting." });
      await f.store.cancelObjective(
        objective.id,
        { reason: "Done with it" },
        { operatorId: "ops" },
      );
      expect(await f.store.deleteTeam(team.id)).toBe(true);
      // The closed Objective keeps its history without the Team, and the posts are gone.
      expect((await f.store.getObjective(objective.id)).teamId ?? null).toBeNull();
      expect(await f.store.getTeam(team.id)).toBeUndefined();
      expect(await f.store.deleteTeam(team.id)).toBe(false);
    }, 30_000);
  });
}
