import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ObjectiveController } from "../packages/control-plane/src/objective-controller.js";
import type { TaskAssignment, WorkstreamPost } from "../packages/core/src/index.js";
import { DrizzleStore, migrateDatabase } from "../packages/store/src/index.js";

const postgres = process.env["SUPERTAG_POSTGRES_URL"];
for (const dialect of ["sqlite", "postgresql"] as const) {
  describe.skipIf(dialect === "postgresql" && !postgres)(
    `${dialect} Team channel posts scoped to their Objective`,
    () => {
      const cleanups: Array<() => Promise<void>> = [];
      afterEach(async () => {
        for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
      });

      /**
       * A Build Team governed by Objective A, with A's owner leading a Leadership Team, and an
       * Objective B with another owner and its own Leadership Team. The Build Team is not linked
       * to B until a test links it.
       */
      async function fixture() {
        const directory = await mkdtemp(join(tmpdir(), "supertag-post-scope-"));
        cleanups.push(() => rm(directory, { recursive: true, force: true }));
        const url = dialect === "sqlite" ? `file:${join(directory, "state.db")}` : postgres;
        if (!url) throw new Error("Missing PostgreSQL");
        await migrateDatabase({ url });
        const store = new DrizzleStore({ url });
        await store.connect();
        cleanups.push(() => store.disconnect());
        const [ownerA, ownerB, lead, builder, reviewer] = await Promise.all(
          ["owner-a", "owner-b", "lead", "builder", "reviewer"].map((name) =>
            store.createTag({ name: `${name}-${randomUUID()}` }),
          ),
        );
        if (!ownerA || !ownerB || !lead || !builder || !reviewer)
          throw new Error("Missing fixture Tags");
        for (const tag of [ownerA, ownerB, lead, builder, reviewer])
          await store.bindTagWorkerHost(tag.id, "scope-host");
        const a = await store.createObjective({
          id: `a-${randomUUID()}`,
          ownerTagId: ownerA.id,
          outcome: "Objective A",
          runtimeActions: [],
        });
        const b = await store.createObjective({
          id: `b-${randomUUID()}`,
          ownerTagId: ownerB.id,
          outcome: "Objective B",
          runtimeActions: [],
        });
        const leadershipA = await store.createTeam({
          id: `${a.id}:leadership`,
          objectiveId: a.id,
          name: "Leadership A",
          leadTagId: ownerA.id,
          memberTagIds: [ownerA.id],
        });
        const leadershipB = await store.createTeam({
          id: `${b.id}:leadership`,
          objectiveId: b.id,
          name: "Leadership B",
          leadTagId: ownerB.id,
          memberTagIds: [ownerB.id],
        });
        const build = await store.createTeam({
          id: `${a.id}:build`,
          objectiveId: a.id,
          name: "Build",
          leadTagId: lead.id,
          memberTagIds: [builder.id, reviewer.id],
        });
        const controller = new ObjectiveController(store, undefined);
        controller.activateCoordination({ url: "http://fixture.invalid" });
        const leaseOwner = controller["instanceId"];
        /** A running Task Attempt in the Objective, usable as a coordination caller. */
        const running = async (objectiveId: string, teamId: string, assignedTagId: string) => {
          const task = (await controller.command("assign_task", {
            objectiveId,
            taskId: `task-${randomUUID()}`,
            teamId,
            assignedTagId,
            instruction: "Work",
            acceptanceCriteria: ["Done"],
          })) as TaskAssignment;
          const claimed = await store.claimTaskAssignment({ taskId: task.taskId, leaseOwner });
          if (!claimed) throw new Error("Fixture assignment could not be claimed");
          await store.createTaskAttempt({
            workerProfile: { id: "default", revision: "1" },
            taskId: task.taskId,
            attemptNumber: claimed.attemptCount,
            workerSnapshot: {},
            startedAt: new Date().toISOString(),
          });
          await store.startTask({ taskId: task.taskId, startedAt: new Date().toISOString() });
          return claimed;
        };
        const as = (caller: TaskAssignment) => (name: string, input: Record<string, unknown>) =>
          controller.command(name, { objectiveId: caller.objectiveId, ...input }, caller);
        const link = async () => {
          const current = await store.getTeam(build.id);
          return store.updateTeam(build.id, {
            expectedRevision: current.revision,
            objectiveIds: [b.id],
          });
        };
        return {
          store,
          controller,
          a,
          b,
          ownerA,
          ownerB,
          lead,
          builder,
          reviewer,
          leadershipA,
          leadershipB,
          build,
          running,
          as,
          link,
        };
      }

      const ids = (posts: readonly { id: string }[]) => posts.map((post) => post.id).sort();
      const read = async (
        caller: (name: string, input: Record<string, unknown>) => Promise<unknown>,
        workstreamId: string,
      ) =>
        ((await caller("read_workstream", { workstreamId })) as { posts: WorkstreamPost[] }).posts;

      it("bounds within-Team messages per Objective, so one Objective's backlog spares another", async () => {
        const f = await fixture();
        await f.link();
        const builderA = f.as(await f.running(f.a.id, f.build.id, f.builder.id));
        const builderB = f.as(await f.running(f.b.id, f.build.id, f.builder.id));
        const send = (caller: typeof builderA, key: string) =>
          caller("send_message", {
            recipientTagId: f.reviewer.id,
            body: { message: key },
            idempotencyKey: key,
          });
        for (let index = 0; index < 100; index++) await send(builderB, `b-${index}`);
        await expect(send(builderB, "b-over")).rejects.toMatchObject({ statusCode: 429 });
        // Objective B's undelivered backlog does not count against the same pair in A.
        await expect(send(builderA, "a-first")).resolves.toMatchObject({ duplicate: false });
      }, 60000);

      it("discloses no pre-link post to the owner of a later-linked Objective", async () => {
        const f = await fixture();
        const builderA = f.as(await f.running(f.a.id, f.build.id, f.builder.id));
        const preLink = (await builderA("post_workstream", {
          workstreamId: f.build.id,
          type: "decision",
          body: "Written for Objective A before any link",
          idempotencyKey: "pre-link",
        })) as WorkstreamPost;
        await f.link();
        const ownerB = f.as(await f.running(f.b.id, f.leadershipB.id, f.ownerB.id));
        expect(await read(ownerB, f.build.id)).toEqual([]);
        // Nor through the Tag's own Mailbox credential, the digest, the brief, or operator views.
        expect(await f.store.listWorkstreamPosts(f.build.id, f.ownerB.id)).toEqual([]);
        const digest = await f.store.readActivationDigest({
          tagId: f.ownerB.id,
          objectiveId: f.b.id,
        });
        expect(digest.items.map((item) => item.id)).not.toContain(preLink.id);
        const overview = await f.controller.readObjectiveOverview({ objectiveId: f.b.id });
        expect(overview.coordination?.posts ?? []).toEqual([]);
      });

      it("shows each reader only the posts of the Objectives it is authorized for", async () => {
        const f = await fixture();
        const builderA = f.as(await f.running(f.a.id, f.build.id, f.builder.id));
        const blockerA = (await builderA("post_workstream", {
          workstreamId: f.build.id,
          type: "blocker",
          body: "A is blocked",
          idempotencyKey: "a-blocker",
        })) as WorkstreamPost;
        await f.link();
        const questionA = (await builderA("post_workstream", {
          workstreamId: f.build.id,
          type: "question",
          to: [f.reviewer.id],
          body: "A question after the link",
          idempotencyKey: "a-question",
        })) as WorkstreamPost;
        const builderB = f.as(await f.running(f.b.id, f.build.id, f.builder.id));
        const decisionB = (await builderB("post_workstream", {
          workstreamId: f.build.id,
          type: "decision",
          to: [f.reviewer.id],
          body: "B decision",
          idempotencyKey: "b-decision",
        })) as WorkstreamPost;
        // Each Objective numbers its own posts, so a sequence reveals nothing about the other.
        expect(decisionB).toMatchObject({ objectiveId: f.b.id, sequence: 1 });
        expect(blockerA).toMatchObject({ objectiveId: f.a.id, sequence: 1 });
        expect(questionA).toMatchObject({ objectiveId: f.a.id, sequence: 2 });
        // A reply stays in the Objective of the post it answers.
        await expect(
          builderB("post_workstream", {
            workstreamId: f.build.id,
            body: "Answering A from B",
            replyTo: questionA.id,
            idempotencyKey: "cross-reply",
          }),
        ).rejects.toMatchObject({ statusCode: 400 });
        // The same idempotency key under another Objective is another post, not a replay.
        await expect(
          builderB("post_workstream", {
            workstreamId: f.build.id,
            type: "blocker",
            body: "A is blocked",
            idempotencyKey: "a-blocker",
          }),
        ).rejects.toMatchObject({ statusCode: 409 });

        const ownerA = f.as(await f.running(f.a.id, f.leadershipA.id, f.ownerA.id));
        const ownerB = f.as(await f.running(f.b.id, f.leadershipB.id, f.ownerB.id));
        const reviewerA = f.as(await f.running(f.a.id, f.build.id, f.reviewer.id));
        const reviewerB = f.as(await f.running(f.b.id, f.build.id, f.reviewer.id));
        const inA = ids([blockerA, questionA]);
        const inB = ids([decisionB]);
        // read_workstream: an execution reads only its own Objective's posts.
        expect(ids(await read(ownerA, f.build.id))).toEqual(inA);
        expect(ids(await read(builderA, f.build.id))).toEqual(inA);
        expect(ids(await read(ownerB, f.build.id))).toEqual(inB);
        expect(ids(await read(reviewerB, f.build.id))).toEqual(inB);
        // Without an Objective, a read takes one: the Team's governing Objective, or the one
        // linked Objective an owner outside the Team owns. Members and administrators name
        // another Objective to read its posts; owning another Objective is not enough.
        expect(ids(await f.store.listWorkstreamPosts(f.build.id, f.ownerA.id))).toEqual(inA);
        expect(ids(await f.store.listWorkstreamPosts(f.build.id, f.ownerB.id))).toEqual(inB);
        expect(ids(await f.store.listWorkstreamPosts(f.build.id, f.reviewer.id))).toEqual(inA);
        expect(ids(await f.store.listWorkstreamPosts(f.build.id))).toEqual(inA);
        expect(
          ids(
            await f.store.listWorkstreamPosts(f.build.id, f.reviewer.id, { objectiveId: f.b.id }),
          ),
        ).toEqual(inB);
        expect(
          ids(await f.store.listWorkstreamPosts(f.build.id, undefined, { objectiveId: f.b.id })),
        ).toEqual(inB);
        for (const [viewer, objectiveId] of [
          [f.ownerB.id, f.a.id],
          [f.ownerA.id, f.b.id],
        ] as const)
          await expect(
            f.store.listWorkstreamPosts(f.build.id, viewer, { objectiveId }),
          ).rejects.toMatchObject({ statusCode: 404 });
        // Within an Objective, owning another Objective the Team serves lists no channel.
        expect(
          (await f.store.listWorkstreams(f.ownerB.id, 100, { objectiveId: f.a.id })).map(
            (stream) => stream.id,
          ),
        ).toEqual([]);
        // A cursor counts only the Objective's own posts.
        expect(
          ids(
            (
              (await reviewerA("read_workstream", {
                workstreamId: f.build.id,
                afterSequence: 1,
              })) as { posts: WorkstreamPost[] }
            ).posts,
          ),
        ).toEqual([questionA.id]);

        // Digests, and the owner's brief built from them.
        const digest = async (tagId: string, objectiveId: string) =>
          (await f.store.readActivationDigest({ tagId, objectiveId })).items
            .map((item) => item.id)
            .sort();
        expect(await digest(f.reviewer.id, f.a.id)).toEqual(inA);
        expect(await digest(f.reviewer.id, f.b.id)).toEqual(inB);
        expect(await digest(f.ownerA.id, f.a.id)).toEqual(inA);
        expect(await digest(f.ownerB.id, f.b.id)).toEqual(inB);

        // Operator views of each Objective.
        const overview = async (objectiveId: string) =>
          ids(
            (await f.controller.readObjectiveOverview({ objectiveId })).coordination?.posts ?? [],
          );
        expect(await overview(f.a.id)).toEqual(inA);
        expect(await overview(f.b.id)).toEqual(inB);
        // reviewerA and reviewerB keep the Tasks running; they are only readers here.
        expect(reviewerA).toBeTypeOf("function");
      });

      it("wakes a waiting Task only for posts in its own Objective", async () => {
        const f = await fixture();
        await f.link();
        const builderA = f.as(await f.running(f.a.id, f.build.id, f.builder.id));
        const waiting = await f.running(f.b.id, f.build.id, f.reviewer.id);
        await f.store.registerTaskAssignmentWait({
          taskId: waiting.taskId,
          leaseOwner: required(waiting.leaseOwner),
          attemptCount: waiting.attemptCount,
          workstreamPosts: { workstreamId: f.build.id, afterSequence: 0 },
          reason: "Waiting for a teammate in B",
        });
        await f.store.settleTaskAssignment({
          taskId: waiting.taskId,
          leaseOwner: required(waiting.leaseOwner),
          attemptCount: waiting.attemptCount,
          result: {},
        });
        expect((await f.store.getTaskAssignment(waiting.taskId))?.status).toBe("waiting");
        await builderA("post_workstream", {
          workstreamId: f.build.id,
          type: "blocker",
          body: "Only for A",
          idempotencyKey: "a-only",
        });
        expect(
          (await f.store.wakeWaitingTaskAssignments()).map((task) => task.taskId),
        ).not.toContain(waiting.taskId);
        expect((await f.store.getTaskAssignment(waiting.taskId))?.status).toBe("waiting");
        const builderB = f.as(await f.running(f.b.id, f.build.id, f.builder.id));
        await builderB("post_workstream", {
          workstreamId: f.build.id,
          body: "For B",
          idempotencyKey: "b-post",
        });
        expect((await f.store.wakeWaitingTaskAssignments()).map((task) => task.taskId)).toContain(
          waiting.taskId,
        );
      });
    },
  );
}

function required<T>(value: T | null | undefined): T {
  if (value === undefined || value === null) throw new Error("Missing fixture value");
  return value;
}
