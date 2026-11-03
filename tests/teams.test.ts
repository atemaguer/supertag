import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DrizzleStore, migrateDatabase } from "../packages/store/src/index.js";

const postgres = process.env["SUPERTAG_POSTGRES_URL"];
for (const dialect of ["sqlite", "postgresql"] as const) {
  describe.skipIf(dialect === "postgresql" && !postgres)(`${dialect} Teams`, () => {
    const cleanups: Array<() => Promise<void>> = [];
    afterEach(async () => {
      for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
    });
    async function fixture() {
      const directory = await mkdtemp(join(tmpdir(), "supertag-team-"));
      cleanups.push(() => rm(directory, { recursive: true, force: true }));
      const url = dialect === "sqlite" ? `file:${join(directory, "state.db")}` : postgres;
      if (!url) throw new Error("Test database missing");
      await migrateDatabase({ url });
      const store = new DrizzleStore({ url });
      await store.connect();
      cleanups.push(() => store.disconnect());
      const owner = await store.createTag({ name: `owner-${randomUUID()}` });
      const lead = await store.createTag({ name: `lead-${randomUUID()}` });
      const member = await store.createTag({ name: `member-${randomUUID()}` });
      const outsider = await store.createTag({ name: `outsider-${randomUUID()}` });
      const objective = await store.createObjective({
        id: randomUUID(),
        ownerTagId: owner.id,
        outcome: "Ship",
      });
      const input = {
        id: randomUUID(),
        objectiveId: objective.id,
        name: "Engineering",
        leadTagId: lead.id,
        memberTagIds: [member.id],
        maxConcurrency: 4,
      };
      return { store, owner, lead, member, outsider, objective, input };
    }
    it("creates idempotently, isolates membership and prevents delegated escalation", async () => {
      const f = await fixture();
      await expect(f.store.createTeam(f.input, f.outsider.id)).rejects.toMatchObject({
        statusCode: 403,
      });
      const team = await f.store.createTeam(f.input, f.owner.id);
      expect(team.memberTagIds).toEqual([f.lead.id, f.member.id].sort());
      expect(await f.store.createTeam(f.input, f.owner.id)).toEqual(team);
      await expect(
        f.store.createTeam({ ...f.input, name: "Changed" }, f.owner.id),
      ).rejects.toMatchObject({ statusCode: 409 });
      await expect(f.store.getTeam(team.id, f.outsider.id)).rejects.toMatchObject({
        statusCode: 404,
      });
      expect(await f.store.listTeams(f.objective.id, f.member.id)).toHaveLength(1);
      expect(await f.store.listTeams(f.objective.id, f.outsider.id)).toEqual([]);
      await expect(
        f.store.updateTeam(team.id, { expectedRevision: 1, maxConcurrency: 5 }, f.lead.id),
      ).rejects.toMatchObject({ statusCode: 403 });
      await expect(
        f.store.updateTeam(
          team.id,
          { expectedRevision: 1, memberTagIds: [f.outsider.id] },
          f.lead.id,
        ),
      ).rejects.toMatchObject({ statusCode: 403 });
      const updated = await f.store.updateTeam(
        team.id,
        { expectedRevision: 1, memberTagIds: [f.outsider.id] },
        f.owner.id,
      );
      expect(updated.revision).toBe(2);
      await expect(f.store.getTeam(team.id, f.member.id)).rejects.toMatchObject({
        statusCode: 404,
      });
    });
    it("serializes parent dissolution against subteam creation", async () => {
      const f = await fixture();
      const parent = await f.store.createTeam(f.input, f.owner.id);
      const childId = randomUUID();
      const results = await Promise.allSettled([
        f.store.createTeam(
          { ...f.input, id: childId, parentTeamId: parent.id, maxConcurrency: 2 },
          f.lead.id,
        ),
        f.store.updateTeam(parent.id, { expectedRevision: 1, status: "dissolved" }, f.owner.id),
      ]);
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      const current = await f.store.getTeam(parent.id);
      const teams = await f.store.listTeams(f.objective.id);
      expect(
        current.status === "dissolved" &&
          teams.some((team) => team.parentTeamId === parent.id && team.status === "active"),
      ).toBe(false);
    });
    it("bounds subteams and prevents stale writes and invalid dissolution", async () => {
      const f = await fixture();
      const parent = await f.store.createTeam(f.input, f.owner.id);
      const child = {
        ...f.input,
        id: randomUUID(),
        parentTeamId: parent.id,
        leadTagId: f.member.id,
        memberTagIds: [],
        maxConcurrency: 2,
      };
      // Concurrency does not nest, so a child's throttle may exceed its parent's.
      const wider = await f.store.createTeam(
        { ...child, id: randomUUID(), maxConcurrency: 5 },
        f.lead.id,
      );
      expect(wider.maxConcurrency).toBe(5);
      await f.store.updateTeam(wider.id, { expectedRevision: 1, status: "dissolved" }, f.lead.id);
      await expect(
        f.store.createTeam({ ...child, memberTagIds: [f.outsider.id] }, f.lead.id),
      ).rejects.toMatchObject({ statusCode: 403 });
      const created = await f.store.createTeam(child, f.lead.id);
      await expect(
        f.store.updateTeam(parent.id, { expectedRevision: 1, status: "dissolved" }, f.owner.id),
      ).rejects.toMatchObject({ statusCode: 409 });
      const writes = await Promise.allSettled(
        ["One", "Two"].map((name) =>
          f.store.updateTeam(created.id, { expectedRevision: 1, name }, f.lead.id),
        ),
      );
      expect(writes.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      await f.store.updateTeam(created.id, { expectedRevision: 2, status: "dissolved" }, f.lead.id);
      await f.store.updateTeam(parent.id, { expectedRevision: 1, status: "dissolved" }, f.owner.id);
      await expect(
        f.store.createTeam({ ...child, id: randomUUID() }, f.lead.id),
      ).rejects.toMatchObject({ statusCode: 409 });
      await expect(
        f.store.updateTeam(parent.id, { expectedRevision: 2, status: "active" }, f.owner.id),
      ).rejects.toMatchObject({ statusCode: 409 });
    });
    it("lets the Objective owner staff Teams below Leadership with hosted Tags", async () => {
      const f = await fixture();
      const leadership = await f.store.createTeam({
        id: `${f.objective.id}:leadership`,
        objectiveId: f.objective.id,
        name: "Leadership",
        leadTagId: f.owner.id,
        memberTagIds: [f.owner.id],
        maxConcurrency: 1,
      });
      await f.store.bindTagWorkerHost(f.member.id, `host-${randomUUID()}`);
      const delivery = {
        id: randomUUID(),
        objectiveId: f.objective.id,
        name: "Delivery",
        leadTagId: f.owner.id,
        memberTagIds: [f.member.id],
        parentTeamId: leadership.id,
        maxConcurrency: 3,
      };
      // A Tag without a Worker Host cannot run work, so Leadership does not delegate it.
      const unhosted = f.store.createTeam(
        { ...delivery, memberTagIds: [f.member.id, f.outsider.id] },
        f.owner.id,
      );
      await expect(unhosted).rejects.toMatchObject({ statusCode: 403 });
      await expect(unhosted).rejects.toThrow(
        `Tag ${f.outsider.name} (${f.outsider.id}) has no bound Worker Host`,
      );
      // Team concurrency is an optional local throttle, not delegated capacity.
      const unthrottled = await f.store.createTeam(
        { ...delivery, id: randomUUID(), maxConcurrency: undefined },
        f.owner.id,
      );
      expect(unthrottled.maxConcurrency).toBeNull();
      const wide = await f.store.createTeam(
        { ...delivery, id: randomUUID(), maxConcurrency: 12 },
        f.owner.id,
      );
      expect(wide.maxConcurrency).toBe(12);
      const team = await f.store.createTeam(delivery, f.owner.id);
      expect(team.memberTagIds).toEqual([f.owner.id, f.member.id].sort());
      // The same delegation applies when the owner grows the Team later.
      await f.store.bindTagWorkerHost(f.lead.id, `host-${randomUUID()}`);
      const grown = await f.store.updateTeam(
        team.id,
        { expectedRevision: 1, memberTagIds: [f.member.id, f.lead.id], maxConcurrency: 4 },
        f.owner.id,
      );
      expect(grown.memberTagIds).toContain(f.lead.id);
      await expect(
        f.store.updateTeam(
          team.id,
          { expectedRevision: 2, memberTagIds: [f.member.id, f.lead.id, f.outsider.id] },
          f.owner.id,
        ),
      ).rejects.toThrow("has no bound Worker Host");
      // Teams below a staffed Team keep the ordinary delegation from their own parent.
      await expect(
        f.store.createTeam(
          { ...delivery, id: randomUUID(), parentTeamId: team.id, memberTagIds: [f.outsider.id] },
          f.owner.id,
        ),
      ).rejects.toThrow("Team exceeds delegated membership");
    });
    it("makes Team concurrency optional and lets only managers raise or remove it", async () => {
      const f = await fixture();
      const parent = await f.store.createTeam({
        id: randomUUID(),
        objectiveId: f.objective.id,
        name: "Parent",
        leadTagId: f.owner.id,
        memberTagIds: [f.lead.id, f.member.id],
      });
      expect(parent.maxConcurrency).toBeNull();
      // A child may set any throttle; its count never includes the parent's work or vice versa.
      const child = await f.store.createTeam(
        {
          id: randomUUID(),
          objectiveId: f.objective.id,
          name: "Child",
          leadTagId: f.lead.id,
          memberTagIds: [f.member.id],
          parentTeamId: parent.id,
          maxConcurrency: 2,
        },
        f.owner.id,
      );
      expect(child.maxConcurrency).toBe(2);
      // The child's own lead may tighten its throttle but not raise or remove it.
      const tightened = await f.store.updateTeam(
        child.id,
        { expectedRevision: 1, maxConcurrency: 1 },
        f.lead.id,
      );
      expect(tightened.maxConcurrency).toBe(1);
      await expect(
        f.store.updateTeam(child.id, { expectedRevision: 2, maxConcurrency: null }, f.lead.id),
      ).rejects.toMatchObject({ statusCode: 403 });
      await expect(
        f.store.updateTeam(child.id, { expectedRevision: 2, maxConcurrency: 3 }, f.lead.id),
      ).rejects.toMatchObject({ statusCode: 403 });
      // The Objective owner removes it; host capacity is then the only limit.
      const removed = await f.store.updateTeam(
        child.id,
        { expectedRevision: 2, maxConcurrency: null },
        f.owner.id,
      );
      expect(removed.maxConcurrency).toBeNull();
    });
  });
}
