import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DrizzleStore, migrateDatabase } from "../packages/store/src/index.js";

const postgres = process.env["SUPERTAG_POSTGRES_URL"];
for (const dialect of ["sqlite", "postgresql"] as const) {
  describe.skipIf(dialect === "postgresql" && !postgres)(`${dialect} Team channels`, () => {
    const cleanups: Array<() => Promise<void>> = [];
    afterEach(async () => {
      for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
    });
    /** An Objective owned by a Tag outside the Team, a Team of `count` Tags, and a second Team. */
    async function fixture(count = 3) {
      const dir = await mkdtemp(join(tmpdir(), "supertag-posts-"));
      cleanups.push(() => rm(dir, { recursive: true, force: true }));
      const url = dialect === "sqlite" ? `file:${join(dir, "state.db")}` : postgres;
      if (!url) throw new Error("Missing PostgreSQL");
      await migrateDatabase({ url });
      const stores = Array.from({ length: 4 }, () => new DrizzleStore({ url }));
      for (const store of stores) {
        await store.connect();
        cleanups.push(() => store.disconnect());
      }
      const store = required(stores[0]);
      const tag = () => store.createTag({ name: randomUUID() });
      const owner = await tag();
      const tags = await Promise.all(Array.from({ length: count }, tag));
      const outsider = await tag();
      const lead = required(tags[0]);
      const objective = await store.createObjective({
        id: randomUUID(),
        ownerTagId: owner.id,
        outcome: "Coordinate",
      });
      const team = await store.createTeam({
        id: `${objective.id}:build`,
        objectiveId: objective.id,
        name: "Build",
        leadTagId: lead.id,
        memberTagIds: tags.map((member) => member.id),
      });
      const otherTeam = await store.createTeam({
        id: `${objective.id}:review`,
        objectiveId: objective.id,
        name: "Review",
        leadTagId: outsider.id,
        memberTagIds: [outsider.id],
      });
      const post = {
        workstreamId: team.id,
        authorTagId: lead.id,
        body: "Finding",
        idempotencyKey: randomUUID(),
      };
      return { store, stores, owner, tags, lead, outsider, objective, team, otherTeam, post };
    }

    it("creates exactly one channel with each Team, sharing its ID and reading the Team", async () => {
      const f = await fixture();
      const leadership = await f.store.createTeam({
        id: `${f.objective.id}:leadership`,
        objectiveId: f.objective.id,
        name: "Leadership",
        leadTagId: f.owner.id,
        memberTagIds: [f.owner.id],
      });
      // Retrying creation returns the same Team and does not add a channel.
      await f.store.createTeam({
        id: f.team.id,
        objectiveId: f.objective.id,
        name: "Build",
        leadTagId: f.lead.id,
        memberTagIds: f.tags.map((member) => member.id),
      });
      expect(await f.store.getWorkstream(f.team.id, f.lead.id)).toEqual({
        id: f.team.id,
        objectiveId: f.objective.id,
        title: "Build",
        ownerTagId: f.lead.id,
        participantTagIds: f.tags.map((member) => member.id).sort(),
        createdAt: f.team.createdAt,
        updatedAt: f.team.updatedAt,
      });
      expect(await f.store.getWorkstream(leadership.id, f.owner.id)).toMatchObject({
        id: leadership.id,
        participantTagIds: [f.owner.id],
      });
      // The owner reads every channel in its Objective; members read only their Teams'.
      expect((await f.store.listWorkstreams(f.owner.id)).map((stream) => stream.id).sort()).toEqual(
        [leadership.id, f.otherTeam.id, f.team.id].sort(),
      );
      expect((await f.store.listWorkstreams(f.lead.id)).map((stream) => stream.id)).toEqual([
        f.team.id,
      ]);
      expect((await f.store.listWorkstreams(f.outsider.id)).map((stream) => stream.id)).toEqual([
        f.otherTeam.id,
      ]);
    });

    it("lets the owner of a linked Objective read a shared Team's channel, and only while linked", async () => {
      const f = await fixture();
      const linkedOwner = await f.store.createTag({ name: randomUUID() });
      const linked = await f.store.createObjective({
        id: randomUUID(),
        ownerTagId: linkedOwner.id,
        outcome: "Share the Build Team",
      });
      const shared = await f.store.updateTeam(f.team.id, {
        expectedRevision: f.team.revision,
        objectiveIds: [linked.id],
      });
      expect(await f.store.getWorkstream(f.team.id, linkedOwner.id)).toMatchObject({
        id: f.team.id,
      });
      expect(
        (await f.store.listWorkstreams(linkedOwner.id, 100, { objectiveId: linked.id })).map(
          (stream) => stream.id,
        ),
      ).toEqual([f.team.id]);
      // Linking grants nothing beyond the shared Team, and nothing to other Tags.
      await expect(f.store.getWorkstream(f.otherTeam.id, linkedOwner.id)).rejects.toMatchObject({
        statusCode: 404,
      });
      await expect(f.store.getWorkstream(f.team.id, f.outsider.id)).rejects.toMatchObject({
        statusCode: 404,
      });
      await expect(
        f.store.postWorkstream({ ...f.post, authorTagId: linkedOwner.id }),
      ).rejects.toMatchObject({ statusCode: 403 });
      expect((await f.store.listWorkstreams(linkedOwner.id)).map((stream) => stream.id)).toEqual([
        f.team.id,
      ]);
      await f.store.updateTeam(f.team.id, { expectedRevision: shared.revision, objectiveIds: [] });
      await expect(f.store.getWorkstream(f.team.id, linkedOwner.id)).rejects.toMatchObject({
        statusCode: 404,
      });
      expect(await f.store.listWorkstreams(linkedOwner.id)).toEqual([]);
    });

    it("filters channels by Objective in the query and pages past 100", async () => {
      const f = await fixture(1);
      const busy = await f.store.createObjective({
        id: randomUUID(),
        ownerTagId: f.owner.id,
        outcome: "Many Teams",
      });
      // 101 newer channels in another Objective the same Tag owns.
      for (let i = 0; i < 101; i += 1)
        await f.store.createTeam({
          id: `${busy.id}:team-${i}`,
          objectiveId: busy.id,
          name: `Team ${i}`,
          leadTagId: f.lead.id,
          memberTagIds: [f.lead.id],
        });
      const unfiltered = await f.store.listWorkstreams(f.owner.id, 100);
      expect(unfiltered.some((stream) => stream.objectiveId === f.objective.id)).toBe(false);
      expect(
        (await f.store.listWorkstreams(f.owner.id, 100, { objectiveId: f.objective.id }))
          .map((stream) => stream.id)
          .sort(),
      ).toEqual([f.team.id, f.otherTeam.id].sort());
      const first = await f.store.listWorkstreams(f.owner.id, 100, { objectiveId: busy.id });
      const rest = await f.store.listWorkstreams(f.owner.id, 100, {
        objectiveId: busy.id,
        offset: 100,
      });
      expect(first).toHaveLength(100);
      expect(rest).toHaveLength(1);
      expect(new Set([...first, ...rest].map((stream) => stream.id)).size).toBe(101);
    });

    it("serializes 100 authors and duplicate retries, with ordered incremental reads and no fanout", async () => {
      const f = await fixture(100);
      const inputs = f.tags.map((tag, i) => ({
        ...f.post,
        authorTagId: tag.id,
        body: `Finding ${i}`,
        idempotencyKey: randomUUID(),
      }));
      const results = await Promise.all(
        inputs.flatMap((input, i) => [
          required(f.stores[i % 4]).postWorkstream(input),
          required(f.stores[(i + 1) % 4]).postWorkstream(input),
        ]),
      );
      expect(new Set(results.map((post) => post.id)).size).toBe(100);
      const posts = [];
      let afterSequence = 0;
      while (true) {
        const page = await f.store.listWorkstreamPosts(f.team.id, required(f.tags[99]).id, {
          afterSequence,
          limit: 17,
        });
        if (!page.length) break;
        posts.push(...page);
        afterSequence = required(page.at(-1)).sequence;
      }
      expect(posts.map((post) => post.sequence)).toEqual(
        Array.from({ length: 100 }, (_, i) => i + 1),
      );
      // A post stores text only: no Mailbox message and no Task.
      expect(
        (await Promise.all(f.tags.map((tag) => f.store.listTagMessages(tag.id)))).flat(),
      ).toEqual([]);
      expect(await f.store.listTaskAssignments(f.objective.id)).toEqual([]);
    }, 30000);

    it("types and addresses posts within the Team", async () => {
      const f = await fixture();
      const builder = required(f.tags[1]).id;
      const reviewer = required(f.tags[2]).id;
      const note = await f.store.postWorkstream(f.post);
      expect(note).toMatchObject({ type: "note", to: [] });
      const question = await f.store.postWorkstream({
        ...f.post,
        authorTagId: builder,
        type: "question",
        to: [reviewer, reviewer, f.lead.id],
        idempotencyKey: randomUUID(),
      });
      expect(question).toMatchObject({ type: "question", to: [reviewer, f.lead.id].sort() });
      // A blocker without addressees goes to the lead, or to nobody when the lead raises it.
      const blocker = {
        ...f.post,
        authorTagId: builder,
        type: "blocker" as const,
        idempotencyKey: randomUUID(),
      };
      expect(await f.store.postWorkstream(blocker)).toMatchObject({ to: [f.lead.id] });
      expect((await f.store.postWorkstream(blocker)).to).toEqual([f.lead.id]);
      expect(await f.store.postWorkstream({ ...blocker, authorTagId: f.lead.id })).toMatchObject({
        type: "blocker",
        to: [],
      });
      for (const type of ["evidence", "decision"] as const)
        expect(
          await f.store.postWorkstream({ ...f.post, type, idempotencyKey: randomUUID() }),
        ).toMatchObject({ type });
      for (const bad of [
        { type: "approval" },
        { type: "" },
        { to: [f.outsider.id] },
        { to: [f.owner.id] },
        { to: Array.from({ length: 21 }, () => randomUUID()) },
        { to: "everyone" },
        { to: [""] },
        { to: [7] },
      ])
        await expect(
          f.store.postWorkstream({
            ...f.post,
            ...bad,
            idempotencyKey: randomUUID(),
          } as typeof f.post),
        ).rejects.toMatchObject({ statusCode: 400 });
      // A retry with another type or other addressees is a different post.
      await expect(f.store.postWorkstream({ ...f.post, type: "decision" })).rejects.toMatchObject({
        statusCode: 409,
      });
      await expect(f.store.postWorkstream({ ...f.post, to: [builder] })).rejects.toMatchObject({
        statusCode: 409,
      });
      const posts = await f.store.listWorkstreamPosts(f.team.id, reviewer);
      expect(posts.map((post) => post.type)).toEqual([
        "note",
        "question",
        "blocker",
        "blocker",
        "evidence",
        "decision",
      ]);
      expect(await f.store.listTaskAssignments(f.objective.id)).toEqual([]);
    });

    it("validates payloads, reply scope, and idempotency", async () => {
      const f = await fixture();
      const first = await f.store.postWorkstream({ ...f.post, references: ["opaque:artifact"] });
      expect(
        await required(f.stores[1]).postWorkstream({ ...f.post, references: ["opaque:artifact"] }),
      ).toEqual(first);
      await expect(f.store.postWorkstream({ ...f.post, body: "Changed" })).rejects.toMatchObject({
        statusCode: 409,
      });
      const reply = await f.store.postWorkstream({
        ...f.post,
        body: "A substantive reply",
        idempotencyKey: randomUUID(),
        replyTo: first.id,
      });
      expect(reply.replyTo).toBe(first.id);
      await expect(
        f.store.postWorkstream({
          ...f.post,
          authorTagId: f.outsider.id,
          workstreamId: f.otherTeam.id,
          replyTo: first.id,
        }),
      ).rejects.toMatchObject({ statusCode: 400 });
      for (const bad of [
        { body: " " },
        { body: "x".repeat(16385) },
        { references: Array(21).fill("a") },
        { references: ["x".repeat(2001)] },
        { references: [3] },
        { references: null },
        { authority: "approve" },
      ])
        await expect(
          f.store.postWorkstream({ ...f.post, ...bad } as typeof f.post),
        ).rejects.toMatchObject({ statusCode: 400 });
      for (const options of [{ limit: 101 }, { afterSequence: -1 }, { limit: 1.5 }])
        await expect(
          f.store.listWorkstreamPosts(f.team.id, f.lead.id, options),
        ).rejects.toMatchObject({ statusCode: 400 });
      for (const options of [{ limit: null }, { afterSequence: null }])
        await expect(
          f.store.listWorkstreamPosts(
            f.team.id,
            f.lead.id,
            options as unknown as Parameters<DrizzleStore["listWorkstreamPosts"]>[2],
          ),
        ).rejects.toMatchObject({ statusCode: 400 });
    });

    it("limits reading and posting to Team members and the Objective owner, following membership", async () => {
      const f = await fixture();
      const member = required(f.tags[1]);
      await f.store.postWorkstream(f.post);
      // Another Team's member neither reads nor posts here.
      await expect(f.store.getWorkstream(f.team.id, f.outsider.id)).rejects.toMatchObject({
        statusCode: 404,
      });
      await expect(f.store.listWorkstreamPosts(f.team.id, f.outsider.id)).rejects.toMatchObject({
        statusCode: 404,
      });
      await expect(
        f.store.postWorkstream({ ...f.post, authorTagId: f.outsider.id }),
      ).rejects.toMatchObject({ statusCode: 404 });
      // The owner reads every channel in its Objective but posts only where it is a member.
      expect(await f.store.listWorkstreamPosts(f.team.id, f.owner.id)).toHaveLength(1);
      await expect(
        f.store.postWorkstream({ ...f.post, authorTagId: f.owner.id }),
      ).rejects.toMatchObject({ statusCode: 403 });
      await expect(f.store.getWorkstream(randomUUID(), f.owner.id)).rejects.toMatchObject({
        statusCode: 404,
      });
      // Membership changes take effect on the next read or post.
      const moved = await f.store.updateTeam(f.team.id, {
        expectedRevision: f.team.revision,
        memberTagIds: f.tags.filter((tag) => tag.id !== member.id).map((tag) => tag.id),
      });
      await expect(f.store.listWorkstreamPosts(f.team.id, member.id)).rejects.toMatchObject({
        statusCode: 404,
      });
      await expect(
        f.store.postWorkstream({ ...f.post, authorTagId: member.id, idempotencyKey: randomUUID() }),
      ).rejects.toMatchObject({ statusCode: 404 });
      await expect(
        f.store.postWorkstream({ ...f.post, to: [member.id], idempotencyKey: randomUUID() }),
      ).rejects.toMatchObject({ statusCode: 400 });
      const joined = await f.store.updateTeam(f.team.id, {
        expectedRevision: moved.revision,
        memberTagIds: [...moved.memberTagIds, f.outsider.id],
      });
      expect(await f.store.listWorkstreamPosts(f.team.id, f.outsider.id)).toHaveLength(1);
      expect((await f.store.getWorkstream(f.team.id)).participantTagIds).toEqual(
        joined.memberTagIds,
      );
      // A dissolved Team's channel stays readable and takes no posts.
      await f.store.updateTeam(f.team.id, {
        expectedRevision: joined.revision,
        status: "dissolved",
      });
      expect(await f.store.listWorkstreamPosts(f.team.id, f.lead.id)).toHaveLength(1);
      await expect(
        f.store.postWorkstream({ ...f.post, idempotencyKey: randomUUID() }),
      ).rejects.toMatchObject({ statusCode: 403 });
    });
  });
}

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Missing fixture value");
  return value;
}
