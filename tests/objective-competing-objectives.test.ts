import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { ObjectiveController } from "../packages/control-plane/src/objective-controller.js";
import type { TaskAssignment } from "../packages/core/src/index.js";
import {
  COORDINATION_CAPABILITY,
  LocalWorklet,
  type TaskAttemptSpec,
  type Worker,
} from "../packages/runtime/sdk/src/index.js";
import { DrizzleStore, migrateDatabase } from "../packages/store/src/index.js";
import { durableTestWorklet } from "./support/durable-test-worklet.js";

it("shares one Team across Objectives while isolating budgets and authority on heterogeneous Workers", async () => {
  const directory = await mkdtemp(join(tmpdir(), "supertag-competing-"));
  const url = `file:${join(directory, "state.db")}`;
  await migrateDatabase({ url });
  const store = new DrizzleStore({ url });
  await store.connect();
  const starts = new Map<string, TaskAttemptSpec>();
  const releases = new Map<string, () => void>();
  const active = new Map<string, number>();
  const peaks = new Map<string, number>();
  let releasing = false;
  const worker = (id: string, capacity: number): Worker => ({
    async describe() {
      return {
        profileCapabilities: [
          {
            profile: { id, revision: "1" },
            capabilities: [COORDINATION_CAPABILITY],
            contextTypes: [],
          },
        ],
        id,
        type: "deterministic",
        capabilities: [COORDINATION_CAPABILITY],
        profiles: [{ id, revision: "1" }],
        contextTypes: [],
        maxConcurrency: capacity,
      };
    },
    async *execute(spec, signal) {
      const count = (active.get(id) ?? 0) + 1;
      active.set(id, count);
      peaks.set(id, Math.max(peaks.get(id) ?? 0, count));
      starts.set(spec.taskId, spec);
      try {
        await new Promise<void>((resolve) => {
          releases.set(spec.taskId, resolve);
          if (releasing || signal?.aborted) resolve();
          else signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        signal?.throwIfAborted();
        yield {
          taskId: spec.taskId,
          attemptId: spec.attemptId,
          at: new Date().toISOString(),
          type: "output.message",
          message: { role: "teammate", text: "Deterministic evidence" },
        };
        yield {
          taskId: spec.taskId,
          attemptId: spec.attemptId,
          at: new Date().toISOString(),
          type: "execution.completed",
        };
      } finally {
        active.set(id, (active.get(id) ?? 1) - 1);
        releases.delete(spec.taskId);
      }
    },
  });
  const controller = new ObjectiveController(
    store,
    durableTestWorklet(new LocalWorklet("shared", "host", [worker("a", 2), worker("b", 2)])),
  );
  controller.activateCoordination({ url: "http://127.0.0.1:3434" });
  try {
    const makeObjective = async (profile: string, budget: number) => {
      const tag = await store.createTag({
        name: randomUUID(),
      });
      await store.bindTagWorkerHost(tag.id, "host");
      const objective = await store.createObjective({
        id: randomUUID(),
        ownerTagId: tag.id,
        outcome: "Complete bounded work",
        budgetLimitMinor: budget,
      });
      const team = await store.createTeam({
        id: randomUUID(),
        objectiveId: objective.id,
        name: "Delivery",
        leadTagId: tag.id,
        memberTagIds: [],
        maxConcurrency: 3,
      });
      const assign = async (cost: number, approval = false) =>
        controller.command("assign_task", {
          objectiveId: objective.id,
          taskId: randomUUID(),
          teamId: team.id,
          assignedTagId: tag.id,
          execution: { profile: { id: profile, revision: "1" } },
          instruction: "Execute deterministic assignment",
          acceptanceCriteria: ["Execution completed"],
          maxCostMinor: cost,
          requiresApproval: approval,
        }) as Promise<TaskAssignment>;
      return { tag, objective, team, assign };
    };
    const a = await makeObjective("a", 10),
      b = await makeObjective("b", 30),
      c = await makeObjective("a", 10);
    const blocked = await a.assign(5, true);
    const aTask = await a.assign(5);
    const bTasks = await Promise.all([b.assign(10), b.assign(10), b.assign(10)]);
    await store.updateTeam(a.team.id, {
      expectedRevision: a.team.revision,
      objectiveIds: [c.objective.id],
      memberTagIds: [a.tag.id, c.tag.id],
      maxConcurrency: 1,
    });
    const cTask = (await controller.command("assign_task", {
      objectiveId: c.objective.id,
      taskId: randomUUID(),
      teamId: a.team.id,
      assignedTagId: c.tag.id,
      execution: { profile: { id: "a", revision: "1" } },
      instruction: "Execute the second Objective's commitment through the shared Team",
      acceptanceCriteria: ["Execution completed"],
      maxCostMinor: 5,
    })) as TaskAssignment;
    await expect(a.assign(1)).rejects.toMatchObject({ statusCode: 409 });
    controller.start();
    await vi.waitFor(() => {
      expect(starts.has(aTask.taskId)).toBe(true);
      expect(bTasks.filter((task) => starts.has(task.taskId))).toHaveLength(2);
    });
    expect(starts.has(cTask.taskId)).toBe(false);
    expect(starts.has(blocked.taskId)).toBe(false);
    const aSpec = starts.get(aTask.taskId);
    if (!aSpec?.coordination) throw new Error("Missing scoped credential");
    const caller = await controller.authenticate(aSpec.coordination.token);
    const visibleCommitments = await controller.command("read_commitments", {}, caller);
    expect(visibleCommitments).toMatchObject({
      objectiveId: a.objective.id,
      commitments: expect.arrayContaining([
        expect.objectContaining({ taskId: aTask.taskId, status: "running" }),
      ]),
    });
    expect(JSON.stringify(visibleCommitments)).not.toContain(cTask.taskId);
    expect(
      await controller.command("read_commitments", { objectiveId: c.objective.id }),
    ).toMatchObject({
      commitments: [expect.objectContaining({ taskId: cTask.taskId, status: "queued" })],
    });
    await expect(
      controller.command(
        "read_task",
        { objectiveId: b.objective.id, taskId: bTasks[0]?.taskId },
        caller,
      ),
    ).rejects.toMatchObject({ statusCode: 403 });
    await expect(
      controller.command("read_commitments", { objectiveId: c.objective.id }, caller),
    ).rejects.toMatchObject({ statusCode: 403 });
    releases.get(aTask.taskId)?.();
    await vi.waitFor(() => expect(starts.has(cTask.taskId)).toBe(true));
    expect(starts.has(blocked.taskId)).toBe(false);
    releasing = true;
    for (const release of releases.values()) release();
    const executing = [aTask, ...bTasks, cTask];
    await vi.waitFor(
      async () => {
        for (const task of executing) {
          const row = await store.getTaskAssignment(task.taskId);
          expect(row?.status, JSON.stringify(row?.result)).toBe("submitted");
        }
        expect(controller.activeCount).toBe(0);
      },
      { timeout: 3000 },
    );
    await expect(controller.authenticate(aSpec.coordination.token)).rejects.toMatchObject({
      statusCode: 401,
    });
    await controller.command("update_task", {
      objectiveId: a.objective.id,
      taskId: blocked.taskId,
      expectedStatus: "queued",
      status: "cancelled",
    });
    expect(await store.getObjective(a.objective.id)).toMatchObject({
      spentMinor: 5,
      reservedMinor: 0,
    });
    expect(await store.getObjective(b.objective.id)).toMatchObject({
      spentMinor: 30,
      reservedMinor: 0,
    });
    expect(await store.getObjective(c.objective.id)).toMatchObject({
      spentMinor: 5,
      reservedMinor: 0,
    });
    expect(peaks.get("a")).toBe(1);
    expect(peaks.get("b")).toBe(2);
    expect([...active.values()]).toEqual([0, 0]);
    expect(releases.size).toBe(0);
    await expect(b.assign(1)).rejects.toMatchObject({ statusCode: 409 });
    expect((await store.listTaskAssignments(c.objective.id)).map((task) => task.taskId)).toEqual([
      cTask.taskId,
    ]);
    await controller.stop();
    const restored = new ObjectiveController(
      store,
      durableTestWorklet(new LocalWorklet("restored", "host", [])),
    );
    expect(
      await restored.command("read_commitments", { objectiveId: c.objective.id }),
    ).toMatchObject({
      commitments: [
        expect.objectContaining({
          taskId: cTask.taskId,
          status: "submitted",
          resultState: "submitted",
          blockers: [{ kind: "review" }],
        }),
      ],
    });
  } finally {
    releasing = true;
    for (const release of releases.values()) release();
    await controller.stop();
    await store.disconnect();
    await rm(directory, { recursive: true, force: true });
  }
});
