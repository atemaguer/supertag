import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderListTable } from "../apps/cli/src/list-command.js";
import { teamDigestBriefLines } from "../packages/control-plane/src/activation-digest.js";
import { decodePost, encodePost } from "../packages/runtime/transport/src/mailbox-codec.js";
import { DrizzleStore, migrateDatabase } from "../packages/store/src/index.js";
import { TEAM_REPLY_COALESCE_WINDOW_MS } from "../packages/store/src/team-reply-triggers.js";
import { createIsolatedPostgresDatabase } from "./support/database.js";

const postgres = process.env["SUPERTAG_POSTGRES_URL"];
for (const dialect of ["sqlite", "postgresql"] as const) {
  describe.skipIf(dialect === "postgresql" && !postgres)(
    `${dialect} Team reply loop brakes`,
    () => {
      const cleanups: Array<() => Promise<void>> = [];
      afterEach(async () => {
        vi.useRealTimers();
        for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
      });

      async function fixture(held = false, observed = false) {
        const teamId = randomUUID();
        const directory = await mkdtemp(join(tmpdir(), "supertag-loop-brakes-"));
        cleanups.push(() => rm(directory, { recursive: true, force: true }));
        let url = `file:${join(directory, "state.db")}`;
        if (dialect === "postgresql") {
          const isolated = await createIsolatedPostgresDatabase(postgres as string);
          url = isolated.url;
          cleanups.push(isolated.cleanup);
        }
        await migrateDatabase({ url });
        const store = new DrizzleStore({ url });
        const other = new DrizzleStore({ url });
        for (const connection of [store, other]) {
          await connection.connect();
          cleanups.push(() => connection.disconnect());
        }
        const owner = await store.createTag({ name: randomUUID() });
        const a = await store.createTag({ name: randomUUID() });
        const b = await store.createTag({ name: randomUUID() });
        const c = await store.createTag({ name: randomUUID() });
        if (held) {
          const set = await store.createTagPermissionSet({ name: randomUUID() });
          await store.addTagPermission({
            permissionSetId: set.id,
            target: "runtime",
            action: "commands:execute",
            approval: "required",
          });
          const role = await store.createRole({
            name: randomUUID(),
            purpose: "Approval required",
            instructions: "",
            contextSetIds: [],
            permissionSetIds: [set.id],
          });
          await store.assignRole({ roleId: role.id, tagId: b.id });
          await store.assignRole({ roleId: role.id, tagId: a.id });
        }
        const objective = await store.createObjective({
          id: randomUUID(),
          ownerTagId: owner.id,
          outcome: "Bound Team replies",
          observations: observed ? [{ workstreamId: teamId }] : [],
          budgetLimitMinor: 10000,
          budgetCurrency: "USD",
          runtimeActions: held ? ["commands:execute"] : [],
        });
        const team = await store.createTeam({
          id: teamId,
          objectiveId: objective.id,
          name: "Build",
          leadTagId: owner.id,
          memberTagIds: [a.id, b.id, c.id],
        });
        for (const tag of [owner, a, b, c]) await store.bindTagWorkerHost(tag.id, "reply-host");
        const assign = (
          tag = a,
          startObjectiveExecution = false,
          targetObjective = objective,
          targetTeam = team,
        ) =>
          store.admitTaskAssignment({
            taskId: randomUUID(),
            objectiveId: targetObjective.id,
            teamId: targetTeam.id,
            requestedByTagId: owner.id,
            assignedTagId: tag.id,
            startObjectiveExecution,
            instruction: "Work",
            acceptanceCriteria: ["Done"],
            execution: {},
            authorizationSnapshot: {
              version: 4,
              capturedAt: new Date().toISOString(),
              tag: { id: tag.id, name: tag.name },
              origin: {
                kind: "internal",
                objectiveId: targetObjective.id,
                requestedByTagId: owner.id,
              },
              requester: { id: owner.id, kind: "bot" },
              permissionSets: [],
              resources: [],
              runtimeActions: [],
            },
            contextPlan: { version: 7, capturedAt: new Date().toISOString(), sets: [] },
            workspacePlan: { version: 1, status: "none" },
          });
        const start = await assign(owner, true);
        await store.cancelTaskAssignment(start.taskId, owner.id);
        const post = (
          sourceTaskId?: string,
          sender = a,
          recipient = b,
          body = randomUUID(),
          connection = store,
        ) =>
          connection.postWorkstream(
            {
              workstreamId: team.id,
              authorTagId: sender.id,
              type: "question",
              to: [recipient.id],
              body,
              idempotencyKey: randomUUID(),
            },
            sourceTaskId,
          );
        const message = (body: Record<string, unknown>, connection = store) =>
          connection.enqueueTagMessage({
            senderTagId: a.id,
            recipientTagId: b.id,
            objectiveId: objective.id,
            type: "question",
            body,
            idempotencyKey: randomUUID(),
          });
        // Admission waits for the coalescing window to close, so advance the clock past it.
        const admit = async () => {
          if (!vi.isFakeTimers()) vi.useFakeTimers({ toFake: ["Date"] });
          vi.setSystemTime(Date.now() + TEAM_REPLY_COALESCE_WINDOW_MS);
          return (
            await Promise.all([
              store.admitMailboxTaskAssignments(),
              other.admitMailboxTaskAssignments(),
            ])
          ).flat();
        };
        const finish = (taskId: string) => store.cancelTaskAssignment(taskId, owner.id);
        return {
          store,
          other,
          a,
          b,
          c,
          owner,
          objective,
          team,
          assign,
          post,
          message,
          admit,
          finish,
        };
      }

      it.each(["system", "SYSTEM", "  SyStEm  "])(
        "reserves the system notice author name (%s)",
        async (name) => {
          const f = await fixture();
          await expect(f.store.createTag({ name })).rejects.toThrow(
            'Tag name "system" is reserved for system notices',
          );
          await expect(f.store.createTag({ name: "system-builder" })).resolves.toMatchObject({
            name: "system-builder",
          });
        },
      );

      it.each([false, true])(
        "keeps a capped pair braked when a third member wakes the recipient (revoked=%s)",
        async (revoked) => {
          const f = await fixture();
          const root = await f.assign();
          await f.finish(root.taskId);
          let sourceTaskId = root.taskId;
          let lastA = root.taskId;
          for (let index = 0; index < 3; index++) {
            const fromA = index % 2 === 0;
            await f.post(sourceTaskId, fromA ? f.a : f.b, fromA ? f.b : f.a);
            const replies = await f.admit();
            expect(replies).toHaveLength(1);
            if (!replies[0]) throw new Error("Missing reply");
            sourceTaskId = replies[0].taskId;
            if (!fromA) lastA = sourceTaskId;
            await f.finish(sourceTaskId);
          }
          // Pair a<->b has 3 wakes rooted in root. a's next post is braked...
          const cTask = await f.assign(f.c);
          await f.finish(cTask.taskId);
          const [brakedPost] = await Promise.all([
            f.post(lastA, f.a, f.b),
            // ...but a colluding third member's question lands in the same window.
            f.post(cTask.taskId, f.c, f.b, randomUUID(), f.other),
          ]);
          const batch = await f.admit();
          expect(batch).toHaveLength(1);
          if (!batch[0]) throw new Error("Missing reply");
          expect(batch[0].assignedTagId).toBe(f.b.id);
          if (revoked) {
            const team = await f.store.getTeam(f.team.id);
            await f.store.updateTeam(team.id, {
              expectedRevision: team.revision,
              memberTagIds: team.memberTagIds.filter((id) => id !== f.c.id),
            });
            // A digest-only source cannot authorize the third member's revoked wake.
            expect(
              await f.store.claimTaskAssignment({
                taskId: batch[0].taskId,
                leaseOwner: "test",
              }),
            ).toBeUndefined();
            expect(await f.store.getTaskAssignment(batch[0].taskId)).toMatchObject({
              status: "cancelled",
              reservedMinor: 0,
            });
            return;
          }
          await f.finish(batch[0].taskId);
          const notices = (await f.store.listWorkstreamPosts(f.team.id, f.owner.id)).filter(
            (post) => post.authorTagId === null,
          );
          expect(notices).toHaveLength(1);
          // Answering a's digest item must retain the original pair scope.
          const digest = await f.store.deliverActivationDigest({
            tagId: f.b.id,
            objectiveId: f.objective.id,
          });
          expect(digest.items.map((item) => item.id)).toContain(brakedPost.id);
          await f.post(batch[0].taskId, f.b, f.a);
          expect(await f.admit()).toEqual([]);
          expect(
            (await f.store.listWorkstreamPosts(f.team.id, f.owner.id)).filter(
              (post) => post.authorTagId === null,
            ),
          ).toHaveLength(1);
        },
      );
      it("caps both directions at three admissions rooted in the original Task and posts one inert lead blocker", async () => {
        const f = await fixture();
        const root = await f.assign();
        await f.finish(root.taskId);
        let sourceTaskId = root.taskId;
        for (let index = 0; index < 3; index++) {
          await f.post(sourceTaskId, index % 2 ? f.b : f.a, index % 2 ? f.a : f.b);
          const replies = await f.admit();
          expect(replies).toHaveLength(1);
          if (!replies[0]) throw new Error("Missing reply");
          sourceTaskId = replies[0].taskId;
          await f.finish(sourceTaskId);
        }
        const queued = await Promise.all([
          f.post(sourceTaskId, f.b, f.a),
          f.post(root.taskId, f.a, f.b, randomUUID(), f.other),
        ]);
        expect(await f.admit()).toEqual([]);
        await f.post(sourceTaskId, f.b, f.a);
        expect(await f.admit()).toEqual([]);
        const posts = await f.store.listWorkstreamPosts(f.team.id, f.owner.id);
        const blockers = posts.filter((post) => post.type === "blocker");
        expect(blockers).toHaveLength(1);
        expect(blockers[0]).toMatchObject({ to: [f.owner.id] });
        expect(blockers[0]?.body).toContain(f.a.id);
        expect(blockers[0]?.body).toContain(f.b.id);
        const leadDigest = await f.store.deliverActivationDigest({
          tagId: f.owner.id,
          objectiveId: f.objective.id,
        });
        expect(leadDigest.items.map((item) => item.id)).toContain(blockers[0]?.id);
        const digest = await f.store.deliverActivationDigest({
          tagId: f.a.id,
          objectiveId: f.objective.id,
        });
        expect(digest.items.map((item) => item.id)).toContain(queued[0]?.id);
        // An independently assigned Task has a new allowance; generated reply Tasks do not.
        const fresh = await f.assign();
        await f.finish(fresh.taskId);
        await f.post(fresh.taskId);
        expect(await f.admit()).toHaveLength(1);
      });

      it.each([false, true])(
        "caps a recipient at four admissions in a rolling hour across Tasks (held=%s)",
        async (held) => {
          const f = await fixture(held);
          vi.useFakeTimers({ toFake: ["Date"] });
          const now = Date.now();
          vi.setSystemTime(now);
          for (let index = 0; index < 4; index++) {
            const source = await f.assign();
            await f.finish(source.taskId);
            await f.post(source.taskId);
            const replies = await f.admit();
            expect(replies).toHaveLength(1);
            expect(replies[0]?.approval).toBe(held ? "pending" : "approved");
            if (!replies[0]) throw new Error("Missing reply");
            await f.finish(replies[0].taskId);
            vi.setSystemTime(now + (index + 1) * 1000);
          }
          const source = await f.assign();
          await f.finish(source.taskId);
          await Promise.all([
            f.post(source.taskId),
            f.post(source.taskId, f.a, f.b, randomUUID(), f.other),
          ]);
          expect(await f.admit()).toEqual([]);
          vi.setSystemTime(now + 60 * 60 * 1000 - 1);
          await f.post(source.taskId);
          expect(await f.admit()).toEqual([]);
          vi.setSystemTime(now + 60 * 60 * 1000);
          await f.post(source.taskId);
          expect(await f.admit()).toHaveLength(1);
        },
      );

      it.each(["pair", "hour"] as const)(
        "serializes concurrent held replies at the %s boundary",
        async (limit) => {
          const f = await fixture(true);
          const root = await f.assign();
          await f.finish(root.taskId);
          let lastReplyId = "";
          for (let index = 0; index < (limit === "pair" ? 2 : 3); index++) {
            const source = limit === "pair" ? root : await f.assign();
            if (limit !== "pair") await f.finish(source.taskId);
            await f.post(source.taskId);
            const [reply] = await f.admit();
            if (!reply) throw new Error("Missing reply");
            expect(reply.approval).toBe("pending");
            lastReplyId = reply.taskId;
            await f.finish(reply.taskId);
          }
          await Promise.all([
            f.post(root.taskId),
            limit === "pair"
              ? f.post(lastReplyId, f.b, f.a, randomUUID(), f.other)
              : f.post(root.taskId, f.a, f.b, randomUUID(), f.other),
          ]);
          const replies = await f.admit();
          expect(replies).toHaveLength(1);
          expect(replies.every((reply) => reply.approval === "pending")).toBe(true);
          if (!replies[0]) throw new Error("Missing reply");
          await f.finish(replies[0].taskId);
          await f.post(root.taskId);
          expect(await f.admit()).toEqual([]);
        },
      );

      it("shares the hourly limit across Teams but isolates Objectives for the same Tag", async () => {
        const f = await fixture();
        const secondTeam = await f.store.createTeam({
          id: randomUUID(),
          objectiveId: f.objective.id,
          name: "Second Team",
          leadTagId: f.owner.id,
          memberTagIds: [f.a.id, f.b.id],
        });
        for (let index = 0; index < 4; index++) {
          const source = await f.assign();
          await f.finish(source.taskId);
          await f.store.postWorkstream(
            {
              workstreamId: index % 2 ? secondTeam.id : f.team.id,
              authorTagId: f.a.id,
              to: [f.b.id],
              type: "question",
              body: `Question ${index}`,
              idempotencyKey: randomUUID(),
            },
            source.taskId,
          );
          const [reply] = await f.admit();
          if (!reply) throw new Error("Missing reply");
          await f.finish(reply.taskId);
        }
        await f.post();
        expect(await f.admit()).toEqual([]);
        const objective = await f.store.createObjective({
          id: randomUUID(),
          ownerTagId: f.owner.id,
          outcome: "Other Objective",
          runtimeActions: [],
          budgetLimitMinor: 1000,
          budgetCurrency: "USD",
        });
        const team = await f.store.getTeam(f.team.id);
        await f.store.updateTeam(team.id, {
          expectedRevision: team.revision,
          objectiveIds: [objective.id],
        });
        const start = await f.assign(f.owner, true, objective);
        await f.finish(start.taskId);
        // Same sender, type, to and body in the same Team; a different Objective is independent.
        await f.store.postWorkstream({
          workstreamId: team.id,
          objectiveId: objective.id,
          authorTagId: f.a.id,
          to: [f.b.id],
          type: "question",
          body: "Question 0",
          idempotencyKey: randomUUID(),
        });
        const replies = await f.admit();
        expect(replies).toHaveLength(1);
        expect(replies[0]?.objectiveId).toBe(objective.id);
      });

      it("drops identical channel posts concurrently even with different keys, references, and recipient order", async () => {
        const f = await fixture();
        const input = {
          workstreamId: f.team.id,
          authorTagId: f.a.id,
          type: "note",
          body: "Same",
          to: [f.b.id, f.owner.id],
        };
        const [first, second] = await Promise.all([
          f.store.postWorkstream({ ...input, idempotencyKey: randomUUID() }),
          f.other.postWorkstream({
            ...input,
            to: [...input.to].reverse(),
            references: ["file.ts"],
            idempotencyKey: randomUUID(),
          }),
        ]);
        expect(first.id).toBe(second.id);
        expect(await f.store.listWorkstreamPosts(f.team.id, f.owner.id)).toHaveLength(1);
        await f.store.postWorkstream({ ...input, type: "evidence", idempotencyKey: randomUUID() });
        await f.store.postWorkstream({ ...input, to: [f.b.id], idempotencyKey: randomUUID() });
        await f.store.postWorkstream({ ...input, body: "Different", idempotencyKey: randomUUID() });
        await f.store.postWorkstream({
          ...input,
          authorTagId: f.owner.id,
          idempotencyKey: randomUUID(),
        });
        expect(await f.store.listWorkstreamPosts(f.team.id, f.owner.id)).toHaveLength(5);
      });

      it("drops identical direct messages and cannot re-wake after the original is delivered", async () => {
        const f = await fixture();
        const [first, second] = await Promise.all([
          f.message({ message: "Same", context: { b: 2, a: 1 } }),
          f.message({ context: { a: 1, b: 2 }, message: "Same" }, f.other),
        ]);
        expect(first.message.id).toBe(second.message.id);
        expect([first.duplicate, second.duplicate].sort()).toEqual([false, true]);
        const [reply] = await f.admit();
        await f.store.deliverActivationDigest({ tagId: f.b.id, objectiveId: f.objective.id });
        if (!reply) throw new Error("Missing reply");
        await f.finish(reply.taskId);
        expect((await f.message(first.message.body)).duplicate).toBe(true);
        expect(await f.admit()).toEqual([]);
        await f.store.pruneTagMessageBodies({ before: new Date(Date.now() + 1).toISOString() });
        expect((await f.message(first.message.body)).duplicate).toBe(true);
        expect(await f.admit()).toEqual([]);
      });

      it.each(["post", "message", "pruned message"] as const)(
        "bounds identical %s suppression to five minutes without extending the window",
        async (kind) => {
          const f = await fixture();
          vi.useFakeTimers({ toFake: ["Date"] });
          const now = Date.now();
          vi.setSystemTime(now);
          const send = async () =>
            kind === "post"
              ? (await f.post(undefined, f.a, f.b, "Still blocked")).id
              : (await f.message({ message: "Still blocked" })).message.id;
          const first = await send();
          const [reply] = await f.admit();
          if (!reply) throw new Error("Missing reply");
          await f.store.deliverActivationDigest({ tagId: f.b.id, objectiveId: f.objective.id });
          await f.finish(reply.taskId);
          if (kind === "pruned message")
            await f.store.pruneTagMessageBodies({ before: new Date(now + 1).toISOString() });
          vi.setSystemTime(now + 5 * 60 * 1000 - 1);
          expect(await send()).toBe(first);
          expect(await f.admit()).toEqual([]);
          vi.setSystemTime(now + 5 * 60 * 1000);
          expect(await send()).not.toBe(first);
          expect(await f.admit()).toHaveLength(1);
        },
      );

      async function exhaust(f: Awaited<ReturnType<typeof fixture>>, kind: "pair" | "hour") {
        const root = await f.assign();
        await f.finish(root.taskId);
        for (let index = 0; index < (kind === "pair" ? 3 : 4); index++) {
          const source = kind === "pair" ? root : await f.assign();
          if (source !== root) await f.finish(source.taskId);
          await f.post(source.taskId);
          const [reply] = await f.admit();
          if (!reply) throw new Error("Missing reply");
          await f.finish(reply.taskId);
        }
        return root;
      }

      it("attributes pair notices to the system in posts and the lead digest", async () => {
        const f = await fixture();
        const root = await exhaust(f, "pair");
        await f.post(root.taskId);
        expect(await f.admit()).toEqual([]);
        const notices = (await f.store.listOpenWorkstreamPosts(f.team.id, f.objective.id)).filter(
          (post) => post.type === "blocker",
        );
        expect(notices).toHaveLength(1);
        expect(notices[0]).toMatchObject({ authorTagId: null, to: [f.owner.id] });
        const digest = await f.store.deliverActivationDigest({
          tagId: f.owner.id,
          objectiveId: f.objective.id,
        });
        expect(digest.items.find((item) => item.id === notices[0]?.id)?.from).toBe("system");
        expect(teamDigestBriefLines(digest).join("\n")).toContain("blocker from system in");
        expect(renderListTable("workstream-post", notices)).toContain("system");
        if (!notices[0]) throw new Error("Missing notice");
        expect(decodePost(encodePost(notices[0]))).toMatchObject({ authorTagId: null });
        await expect(
          f.store.postWorkstream({
            workstreamId: f.team.id,
            authorTagId: null,
            body: "Forged system notice",
            idempotencyKey: randomUUID(),
          } as never),
        ).rejects.toMatchObject({ statusCode: 400 });
      });

      it("posts one hourly notice per suppression period, including concurrent suppression", async () => {
        const f = await fixture();
        vi.useFakeTimers({ toFake: ["Date"] });
        const now = Date.now();
        vi.setSystemTime(now);
        for (let period = 0; period < 2; period++) {
          const root = await exhaust(f, "hour");
          await Promise.all([
            f.post(root.taskId),
            f.post(root.taskId, f.a, f.b, randomUUID(), f.other),
          ]);
          expect(await f.admit()).toEqual([]);
          vi.setSystemTime(now + period * 60 * 60 * 1000 + 59 * 60 * 1000);
          await f.post(root.taskId, f.owner, f.b);
          expect(await f.admit()).toEqual([]);
          const notices = (await f.store.listWorkstreamPosts(f.team.id, f.owner.id)).filter(
            (post) => post.type === "blocker",
          );
          expect(notices).toHaveLength(period + 1);
          expect(notices.at(-1)).toMatchObject({ authorTagId: null, to: [f.owner.id] });
          expect(notices.at(-1)?.body).toContain(f.b.id);
          expect(notices.at(-1)?.body).toContain("4 reply activations");
          const digest = await f.store.readActivationDigest({
            tagId: f.owner.id,
            objectiveId: f.objective.id,
          });
          expect(digest.items.map((item) => item.id)).toContain(notices.at(-1)?.id);
          vi.setSystemTime(now + (period + 1) * 60 * 60 * 1000);
        }
      });

      it.each(["pair", "hour"] as const)(
        "keeps %s notices from waking Workstream waiters",
        async (kind) => {
          const f = await fixture();
          const root = await exhaust(f, kind);
          // Adapted from reviewer proof artifact 4b3950c0-7102-4d33-a043-8c0200317fe3.
          // Register after the triggering question, before admission writes the system notice.
          const question = await f.post(root.taskId);
          const waiting = await f.assign(f.owner);
          await f.store.claimTaskAssignment({ taskId: waiting.taskId, leaseOwner: "lead" });
          await f.store.registerTaskAssignmentWait({
            taskId: waiting.taskId,
            leaseOwner: "lead",
            attemptCount: 1,
            workstreamPosts: { workstreamId: f.team.id, afterSequence: question.sequence },
          });
          await f.store.settleTaskAssignment({
            taskId: waiting.taskId,
            leaseOwner: "lead",
            attemptCount: 1,
            result: {},
          });
          expect(await f.admit()).toEqual([]);
          expect(await f.store.wakeWaitingTaskAssignments()).toEqual([]);
          expect((await f.store.getTaskAssignment(waiting.taskId))?.status).toBe("waiting");
          const notices = await f.store.listWorkstreamPosts(f.team.id, f.owner.id, {
            afterSequence: question.sequence,
          });
          expect(notices).toHaveLength(1);
          expect(notices[0]?.id).toMatch(/^team-reply-loop:/);
          expect(notices[0]?.type).toBe("blocker");
          // A later member post still satisfies the same wait and keeps sequence numbering intact.
          const realPost = await f.post(root.taskId, f.a, f.owner);
          const wakes = await f.store.wakeWaitingTaskAssignments();
          expect(wakes.map((task) => task.taskId)).toContain(waiting.taskId);
          expect(
            wakes.find((task) => task.taskId === waiting.taskId)?.waitState?.wake,
          ).toMatchObject({ reason: "workstream_posts", throughSequence: realPost.sequence });
        },
      );

      it("does not turn system notices into observation assessments", async () => {
        const f = await fixture(false, true);
        // Direct messages exhaust the fallback scope without writing channel posts.
        for (let index = 0; index < 3; index++) {
          await f.message({ message: `Question ${index}` });
          const [reply] = await f.admit();
          if (!reply) throw new Error("Missing reply");
          await f.finish(reply.taskId);
        }
        await f.message({ message: "Limit exceeded" });
        expect(await f.admit()).toEqual([]);
        expect(await f.store.listWorkstreamPosts(f.team.id, f.owner.id)).toHaveLength(1);
        await f.store.reconcileObjectiveObservations();
        expect(await f.store.listTagMessages(f.owner.id)).toEqual([]);
        expect(
          (await f.store.getObjective(f.objective.id)).observationState?.pending,
        ).toBeUndefined();
        await f.post();
        await f.store.reconcileObjectiveObservations();
        expect(
          (await f.store.getObjective(f.objective.id)).observationState?.pending,
        ).toBeDefined();
      });

      it("shares an Objective fallback cap for unattributed direct messages", async () => {
        const f = await fixture();
        for (let index = 0; index < 3; index++) {
          await f.message({ message: `Question ${index}` });
          const [reply] = await f.admit();
          expect(reply).toBeDefined();
          if (!reply) throw new Error("Missing reply");
          await f.finish(reply.taskId);
        }
        await f.message({ message: "One too many" });
        expect(await f.admit()).toEqual([]);
        expect(
          (await f.store.listWorkstreamPosts(f.team.id, f.owner.id)).filter(
            (p) => p.type === "blocker",
          ),
        ).toHaveLength(1);
      });
    },
  );
}
