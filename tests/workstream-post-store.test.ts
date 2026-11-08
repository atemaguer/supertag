import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DrizzleStore, migrateDatabase } from "../packages/store/src/index.js";

const postgres = process.env["SUPERTAG_POSTGRES_URL"];
for (const dialect of ["sqlite", "postgresql"] as const) {
  describe.skipIf(dialect === "postgresql" && !postgres)(`${dialect} Team Workstreams`, () => {
    const cleanups: Array<() => Promise<void>> = [];
    afterEach(async () => {
      for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
    });
    /** A Team of `count` Tags, a second Team of one outsider, and an Objective naming the first. */
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
      const team = await store.createTeam({
        id: randomUUID(),
        name: `Build ${randomUUID()}`,
        memberTagIds: tags.map((member) => member.id),
      });
      const otherTeam = await store.createTeam({
        id: randomUUID(),
        name: `Review ${randomUUID()}`,
        memberTagIds: [outsider.id],
      });
      const objective = await store.createObjective({
        id: randomUUID(),
        ownerTagId: owner.id,
        outcome: "Coordinate",
        teamId: team.id,
      });
      const account = await store.saveSurfaceAccount({
        provider: "slack",
        externalAccountId: randomUUID(),
        displayName: "Slack",
        authMethod: "test",
        credentialId: "test",
        status: "connected",
        configuration: {},
        verifiedAt: new Date().toISOString(),
      });
      const route = await store.addTagRoute({
        tagId: lead.id,
        surfaceAccountId: account.id,
        scope: "channel:build",
      });
      /** A Task of the Team's Objective, as the Task that posts. */
      async function taskId(): Promise<string> {
        const at = new Date().toISOString();
        const session = await store.openSession({
          tagId: lead.id,
          sessionKey: `work:${objective.id}:${randomUUID()}`,
          origin: {},
          objectiveId: objective.id,
          at,
        });
        const authorization = {
          version: 5,
          capturedAt: at,
          tag: { id: lead.id, name: lead.name },
          origin: {
            tagRouteId: route.id,
            surfaceAccountId: account.id,
            provider: "slack",
            scope: "channel:build",
          },
          requester: { id: lead.id, kind: "bot" },
          permissionSets: [],
          resources: [],
          runtimeActions: [],
        } as const;
        const eventId = randomUUID();
        const admitted = await store.admitInboundEvent({
          surfaceAccountId: account.id,
          tagRouteId: route.id,
          tagId: lead.id,
          authorization,
          contextPlan: { version: 7, capturedAt: at, sets: [] },
          event: {
            eventId,
            logicalEventId: eventId,
            provider: "slack",
            externalAccountId: account.externalAccountId,
            kind: "message",
            scope: "channel:build",
            sessionKey: session.sessionKey,
            actor: { id: lead.id, kind: "bot" },
            internal: {
              kind: "work_session",
              startedByTaskId: eventId,
              parentSessionId: session.id,
              title: "post",
            },
            text: "Post a finding",
            occurredAt: at,
            callback: {
              provider: "slack",
              mode: "slack_thread",
              threadKey: "build",
              target: { channelId: "build", threadTs: "build" },
            },
            source: {},
            metadata: {},
          },
        });
        const task = await store.openTask({
          inboundEventId: admitted.work.id,
          tagId: lead.id,
          sessionId: session.id,
          execution: {},
          actor: { id: lead.id, kind: "bot" },
          trigger: { origin: "work_session" },
          workspacePlan: { version: 1, status: "none" },
          sessionHistory: [],
          authorizationSnapshot: authorization,
          contextPlan: { version: 7, capturedAt: at, sets: [] },
          createdAt: at,
        });
        return task.id;
      }
      const post = { teamId: team.id, authorTagId: lead.id, body: "Finding" };
      return {
        store,
        stores,
        owner,
        tags,
        lead,
        outsider,
        objective,
        team,
        otherTeam,
        post,
        taskId,
      };
    }

    it("stores a post in the Team's own sequence and wakes nobody by itself", async () => {
      const f = await fixture();
      const builder = required(f.tags[1]).id;
      const first = await f.store.post(f.post);
      expect(first).toMatchObject({
        duplicate: false,
        post: {
          teamId: f.team.id,
          authorTagId: f.lead.id,
          body: "Finding",
          to: [],
          sequence: 1,
        },
      });
      const addressed = await f.store.post({
        ...f.post,
        authorTagId: builder,
        body: "Need a review",
        to: [f.lead.id, builder, f.lead.id],
      });
      expect(addressed.post).toMatchObject({ sequence: 2, to: [builder, f.lead.id].sort() });
      // Each Team's Workstream has its own sequence.
      expect(
        (await f.store.post({ teamId: f.otherTeam.id, authorTagId: f.outsider.id, body: "Other" }))
          .post.sequence,
      ).toBe(1);
      // A post is a record, not a wake: the store stores no Mailbox message for it.
      expect(
        (
          await Promise.all(
            [...f.tags, f.outsider].map((tag) => f.store.listTagMessageHistory(tag.id)),
          )
        ).flatMap((page) => page.items),
      ).toEqual([]);
    });

    it("derives idempotency from the posting Task, the addressees and the text", async () => {
      const f = await fixture();
      const sourceTaskId = await f.taskId();
      const first = await f.store.post({ ...f.post, sourceTaskId });
      expect(first.duplicate).toBe(false);
      // A retried Attempt posting the same text to the same Tags stores nothing new.
      const retry = await required(f.stores[1]).post({ ...f.post, sourceTaskId });
      expect(retry).toEqual({ post: first.post, duplicate: true });
      // Different text, different addressees, or another Task is a different post.
      for (const change of [
        { body: "Changed" },
        { to: [required(f.tags[1]).id] },
        { sourceTaskId: await f.taskId() },
      ])
        expect((await f.store.post({ ...f.post, sourceTaskId, ...change })).duplicate).toBe(false);
      // Without a Task every post stands on its own.
      expect((await f.store.post(f.post)).duplicate).toBe(false);
      expect((await f.store.post(f.post)).duplicate).toBe(false);
      expect(await f.store.listTeamPosts(f.team.id)).toHaveLength(6);
    });

    it("limits posting to active Team members and addresses only members", async () => {
      const f = await fixture();
      const member = required(f.tags[1]);
      await f.store.post(f.post);
      await expect(f.store.post({ ...f.post, authorTagId: f.outsider.id })).rejects.toMatchObject({
        statusCode: 403,
      });
      await expect(f.store.post({ ...f.post, authorTagId: f.owner.id })).rejects.toMatchObject({
        statusCode: 403,
      });
      await expect(f.store.post({ ...f.post, to: [f.outsider.id] })).rejects.toMatchObject({
        statusCode: 400,
      });
      await expect(f.store.post({ ...f.post, teamId: randomUUID() })).rejects.toMatchObject({
        statusCode: 404,
      });
      // Membership changes take effect on the next post.
      await f.store.updateTeam(f.team.id, {
        expectedRevision: f.team.revision,
        memberTagIds: f.tags.filter((tag) => tag.id !== member.id).map((tag) => tag.id),
      });
      await expect(f.store.post({ ...f.post, authorTagId: member.id })).rejects.toMatchObject({
        statusCode: 403,
      });
      await expect(f.store.post({ ...f.post, to: [member.id] })).rejects.toMatchObject({
        statusCode: 400,
      });
      // A retired Tag stops posting even while the Team still lists it.
      await f.store.retireTag(f.lead.id);
      await expect(f.store.post(f.post)).rejects.toMatchObject({ statusCode: 403 });
    });

    it("validates the text, the addressees and the read options", async () => {
      const f = await fixture();
      for (const bad of [
        { body: " " },
        { body: "x".repeat(16_385) },
        { to: Array.from({ length: 21 }, () => randomUUID()) },
        { to: "everyone" },
        { to: [""] },
        { to: [7] },
      ])
        await expect(f.store.post({ ...f.post, ...bad } as typeof f.post)).rejects.toMatchObject({
          statusCode: 400,
        });
      for (const options of [{ limit: 201 }, { afterSequence: -1 }, { limit: 1.5 }])
        await expect(f.store.listTeamPosts(f.team.id, options)).rejects.toMatchObject({
          statusCode: 400,
        });
      await expect(f.store.listTeamPosts(randomUUID())).rejects.toMatchObject({ statusCode: 404 });
    });

    it("serializes 100 authors and duplicate retries, with ordered incremental reads", async () => {
      const f = await fixture(100);
      const sourceTaskId = await f.taskId();
      const inputs = f.tags.map((tag, i) => ({
        ...f.post,
        authorTagId: tag.id,
        body: `Finding ${i}`,
        sourceTaskId,
      }));
      const results = await Promise.all(
        inputs.flatMap((input, i) => [
          required(f.stores[i % 4]).post(input),
          required(f.stores[(i + 1) % 4]).post(input),
        ]),
      );
      expect(new Set(results.map((result) => result.post.id)).size).toBe(100);
      expect(results.filter((result) => result.duplicate)).toHaveLength(100);
      const posts = [];
      let afterSequence = 0;
      while (true) {
        const page = await f.store.listTeamPosts(f.team.id, { afterSequence, limit: 17 });
        if (!page.length) break;
        posts.push(...page);
        afterSequence = required(page.at(-1)).sequence;
      }
      expect(posts.map((post) => post.sequence)).toEqual(
        Array.from({ length: 100 }, (_, i) => i + 1),
      );
      // Without a cursor a read returns the newest posts, oldest first.
      const newest = await f.store.listTeamPosts(f.team.id, { limit: 3 });
      expect(newest.map((post) => post.sequence)).toEqual([98, 99, 100]);
    }, 30_000);

    it("deletes a Team's posts with the Team, and only once no open Objective names it", async () => {
      const f = await fixture();
      await f.store.post(f.post);
      await expect(f.store.deleteTeam(f.team.id)).rejects.toMatchObject({ statusCode: 409 });
      await f.store.cancelObjective(f.objective.id, {}, { operatorId: "operator" });
      expect(await f.store.deleteTeam(f.team.id)).toBe(true);
      await expect(f.store.listTeamPosts(f.team.id)).rejects.toMatchObject({ statusCode: 404 });
      expect(await f.store.deleteTeam(f.team.id)).toBe(false);
    });
  });
}

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Missing fixture value");
  return value;
}
