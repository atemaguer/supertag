import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ObjectiveController } from "../packages/control-plane/src/objective-controller.js";
import type { TaskAssignment, Team } from "../packages/core/src/index.js";
import {
  COORDINATION_CAPABILITY,
  LocalWorklet,
  type TaskAttemptSpec,
  type Worker,
} from "../packages/runtime/sdk/src/index.js";
import { DrizzleStore, migrateDatabase } from "../packages/store/src/index.js";
import { createIsolatedPostgresDatabase } from "./support/database.js";
import { durableTestWorklet } from "./support/durable-test-worklet.js";

function gate() {
  let release = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
const postgres = process.env["SUPERTAG_POSTGRES_URL"];
for (const dialect of ["sqlite", "postgresql"] as const) {
  describe.skipIf(dialect === "postgresql" && !postgres)(
    `${dialect} reobjective during active execution`,
    () => {
      const cleanups: Array<() => Promise<void>> = [];
      afterEach(async () => {
        for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
      });
      it("cancels obsolete work, explicitly replaces dependencies, reallocates capacity and preserves unrelated execution", async () => {
        const directory = await mkdtemp(join(tmpdir(), "supertag-reobjective-"));
        cleanups.push(() => rm(directory, { recursive: true, force: true }));
        let url = `file:${join(directory, "state.db")}`;
        if (dialect === "postgresql") {
          if (!postgres) throw new Error("Missing PostgreSQL test database");
          const isolated = await createIsolatedPostgresDatabase(postgres);
          url = isolated.url;
          cleanups.push(isolated.cleanup);
        }
        if (!url) throw new Error("PostgreSQL test URL missing");
        await migrateDatabase({ url });
        const store = new DrizzleStore({ url });
        await store.connect();
        cleanups.push(() => store.disconnect());
        const observer = new DrizzleStore({ url });
        await observer.connect();
        cleanups.push(() => observer.disconnect());
        const profile = { id: "reobjective-test", revision: "1" };
        const owner = await store.createTag({
          name: `Owner-${randomUUID()}`,
        });
        const obsolete = await store.createTag({
          name: `Original-${randomUUID()}`,
        });
        const replacement = await store.createTag({
          name: `Replacement-${randomUUID()}`,
        });
        const independent = await store.createTag({
          name: `Independent-${randomUUID()}`,
        });
        for (const tag of [owner, obsolete, replacement, independent])
          await store.bindTagWorkerHost(tag.id, "reobjective-host");
        const objective = await store.createObjective({
          id: randomUUID(),
          ownerTagId: owner.id,
          outcome: "Validate revised customer assumptions",
          budgetLimitMinor: 100,
        });
        let product = await store.createTeam({
          id: randomUUID(),
          objectiveId: objective.id,
          name: "Product",
          leadTagId: owner.id,
          memberTagIds: [obsolete.id],
          maxConcurrency: 2,
        });
        const analytics = await store.createTeam({
          id: randomUUID(),
          objectiveId: objective.id,
          name: "Analytics",
          leadTagId: owner.id,
          memberTagIds: [independent.id],
          maxConcurrency: 1,
        });
        // The Product Team's channel follows its membership, so replacing members replaces readers.
        const stream = { id: product.id };
        const barriers = new Map<string, ReturnType<typeof gate>>();
        const started = new Map<string, TaskAttemptSpec>();
        const aborted = new Set<string>();
        const executionErrors: unknown[] = [];
        const worker: Worker = {
          async describe() {
            return {
              profileCapabilities: [
                { profile: profile, capabilities: [COORDINATION_CAPABILITY], contextTypes: [] },
              ],
              id: "reobjective-worker",
              type: "scripted",
              capabilities: [COORDINATION_CAPABILITY],
              profiles: [profile],
              contextTypes: [],
              maxConcurrency: 6,
            };
          },
          async *execute(spec, signal) {
            const barrier = barriers.get(spec.taskId);
            if (!barrier) throw new Error("Unexpected assignment admitted");
            started.set(spec.taskId, spec);
            yield {
              taskId: spec.taskId,
              attemptId: spec.attemptId,
              at: new Date().toISOString(),
              type: "execution.started",
              workerId: "reobjective-worker",
            };
            let stop = () => {};
            const interrupted = new Promise<void>((resolve) => {
              stop = () => {
                aborted.add(spec.taskId);
                resolve();
              };
              if (signal?.aborted) stop();
              else signal?.addEventListener("abort", stop, { once: true });
            });
            try {
              await Promise.race([barrier.promise, interrupted]);
              signal?.throwIfAborted();
              yield {
                taskId: spec.taskId,
                attemptId: spec.attemptId,
                at: new Date().toISOString(),
                type: "output.message",
                message: { role: "teammate", text: `Evidence for ${spec.taskId}` },
              };
              yield {
                taskId: spec.taskId,
                attemptId: spec.attemptId,
                at: new Date().toISOString(),
                type: "execution.completed",
              };
            } finally {
              signal?.removeEventListener("abort", stop);
            }
          },
        };
        const controller = new ObjectiveController(
          store,
          durableTestWorklet(new LocalWorklet("reobjective-worklet", "reobjective-host", [worker])),
          (error) => executionErrors.push(error),
        );
        controller.activateCoordination({ url: "http://127.0.0.1:3434" });
        cleanups.push(async () => {
          for (const barrier of barriers.values()) barrier.release();
          await controller.stop();
        });
        const command = (name: string, input: Record<string, unknown>) =>
          controller.command(name, { objectiveId: objective.id, ...input });
        const assign = async (
          team: Team,
          assignedTagId: string,
          instruction: string,
          extra: Record<string, unknown> = {},
        ) => {
          const taskId = randomUUID();
          barriers.set(taskId, gate());
          return (await command("assign_task", {
            taskId,
            teamId: team.id,
            assignedTagId,
            instruction,
            acceptanceCriteria: ["Evidence matches the current assignment"],
            maxCostMinor: 10,
            ...extra,
          })) as TaskAssignment;
        };
        const oldA = await assign(product, obsolete.id, "Original product design", {
          workstreamId: stream.id,
        });
        const oldB = await assign(product, obsolete.id, "Original onboarding", {
          workstreamId: stream.id,
        });
        const unrelated = await assign(analytics, independent.id, "Independent usage analysis");
        const dependent = await assign(product, obsolete.id, "Campaign based on original design", {
          dependencies: [oldA.taskId],
          workstreamId: stream.id,
        });
        controller.start();
        await vi.waitFor(() => expect(started.size).toBe(3), { timeout: 5000, interval: 20 });
        const oldClaim = await observer.getTaskAssignment(oldA.taskId);
        const oldSpec = started.get(oldA.taskId);
        if (!oldClaim?.leaseOwner || !oldSpec?.coordination)
          throw new Error("Original assignment did not execute");
        expect(await controller.authenticate(oldSpec.coordination.token)).toMatchObject({
          taskId: oldA.taskId,
        });
        expect(started.has(dependent.taskId)).toBe(false);
        await expect(
          command("update_team", {
            teamId: product.id,
            expectedRevision: 1,
            memberTagIds: [replacement.id],
          }),
        ).rejects.toMatchObject({ statusCode: 409 });
        product = (await command("update_team", {
          teamId: product.id,
          expectedRevision: 1,
          maxConcurrency: 1,
        })) as Team;
        expect((await observer.getTaskAssignment(unrelated.taskId))?.status).toBe("running");
        await Promise.all(
          [oldA, oldB].map((task) =>
            command("update_task", {
              taskId: task.taskId,
              expectedStatus: "running",
              status: "cancelled",
            }),
          ),
        );
        await vi.waitFor(() => expect(aborted).toEqual(new Set([oldA.taskId, oldB.taskId])), {
          timeout: 5000,
          interval: 20,
        });
        await expect(controller.authenticate(oldSpec.coordination.token)).rejects.toMatchObject({
          statusCode: 401,
        });
        await expect(
          observer.settleTaskAssignment({
            taskId: oldA.taskId,
            leaseOwner: oldClaim.leaseOwner,
            attemptCount: oldClaim.attemptCount,
            result: { obsolete: true },
          }),
        ).rejects.toMatchObject({ statusCode: 409 });
        expect((await observer.getTaskAssignment(dependent.taskId))?.status).toBe("queued");
        expect(
          await observer.claimTaskAssignment({
            taskId: dependent.taskId,
            leaseOwner: "cannot-reuse-cancelled-dependency",
          }),
        ).toBeUndefined();
        await command("update_task", {
          taskId: dependent.taskId,
          expectedStatus: "queued",
          status: "cancelled",
        });
        product = (await command("update_team", {
          teamId: product.id,
          expectedRevision: product.revision,
          memberTagIds: [replacement.id],
        })) as Team;
        expect((await observer.getWorkstream(stream.id, owner.id)).participantTagIds).toEqual(
          [owner.id, replacement.id].sort(),
        );
        const revisedA = await assign(product, replacement.id, "Revised product design", {
          workstreamId: stream.id,
        });
        const revisedB = await assign(product, replacement.id, "Revised onboarding", {
          workstreamId: stream.id,
        });
        await vi.waitFor(
          () =>
            expect([revisedA, revisedB].filter((task) => started.has(task.taskId))).toHaveLength(1),
          { timeout: 5000, interval: 20 },
        );
        const pending = [revisedA, revisedB].find((task) => !started.has(task.taskId));
        if (!pending) throw new Error("Reduced Team capacity was exceeded");
        expect(
          await observer.claimTaskAssignment({
            taskId: pending.taskId,
            leaseOwner: "cannot-exceed-revised-capacity",
          }),
        ).toBeUndefined();
        expect(aborted.has(unrelated.taskId)).toBe(false);
        barriers.get(unrelated.taskId)?.release();
        await vi.waitFor(
          async () =>
            expect((await observer.getTaskAssignment(unrelated.taskId))?.status).toBe("submitted"),
          { timeout: 5000, interval: 20 },
        );
        await command("update_task", {
          taskId: unrelated.taskId,
          expectedStatus: "submitted",
          status: "accepted",
          assessment: "Independent analysis remains valid",
        });
        expect((await observer.getTaskAssignment(pending.taskId))?.status).toBe("queued");
        product = (await command("update_team", {
          teamId: product.id,
          expectedRevision: product.revision,
          maxConcurrency: 2,
        })) as Team;
        await vi.waitFor(
          () => expect([revisedA, revisedB].every((task) => started.has(task.taskId))).toBe(true),
          { timeout: 5000, interval: 20 },
        );
        for (const task of [revisedA, revisedB]) barriers.get(task.taskId)?.release();
        await vi.waitFor(
          async () =>
            expect(
              (await observer.listTaskAssignments(objective.id)).filter(
                (task) => task.status === "submitted",
              ),
            ).toHaveLength(2),
          { timeout: 5000, interval: 20 },
        );
        for (const task of [revisedA, revisedB])
          await command("update_task", {
            taskId: task.taskId,
            expectedStatus: "submitted",
            status: "accepted",
            assessment: "Evidence supports revised assumptions",
          });
        expect((await observer.getTaskAssignment(oldA.taskId))?.result).toBeNull();
        expect((await observer.findTaskById(oldA.taskId))?.status).toBe("cancelled");
        expect(
          (await observer.listTaskAssignments(objective.id)).filter(
            (task) => task.status === "accepted",
          ),
        ).toHaveLength(3);
        expect(await observer.getObjective(objective.id)).toMatchObject({
          spentMinor: 50,
          reservedMinor: 0,
        });
        expect(executionErrors).toEqual([]);
        await command("update_team", {
          teamId: product.id,
          expectedRevision: product.revision,
          status: "dissolved",
        });
        expect((await observer.getTeam(analytics.id)).status).toBe("active");
      }, 20000);
    },
  );
}
