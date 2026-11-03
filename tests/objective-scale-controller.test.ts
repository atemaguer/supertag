import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ObjectiveController } from "../packages/control-plane/src/objective-controller.js";
import { taskFollowupId } from "../packages/core/src/task-assignment.js";
import type { Worklet } from "../packages/runtime/sdk/src/index.js";
import { COORDINATION_CAPABILITY } from "../packages/runtime/sdk/src/index.js";
import { DrizzleStore, migrateDatabase } from "../packages/store/src/index.js";
import { durableTestWorklet } from "./support/durable-test-worklet.js";

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
describe("Objective controller scale and lifecycle", () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
    vi.restoreAllMocks();
  });
  async function fixture() {
    const directory = await mkdtemp(join(tmpdir(), "supertag-controller-scale-"));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const url = `file:${join(directory, "state.db")}`;
    await migrateDatabase({ url });
    const store = new DrizzleStore({ url });
    await store.connect();
    cleanups.push(() => store.disconnect());
    const owner = await store.createTag({
      name: randomUUID(),
    });
    const other = await store.createTag({
      name: randomUUID(),
    });
    await store.bindTagWorkerHost(owner.id, "host");
    await store.bindTagWorkerHost(other.id, "host");
    const objective = await store.createObjective({
      id: randomUUID(),
      ownerTagId: owner.id,
      outcome: "Parallel work",
    });
    const team = await store.createTeam({
      id: randomUUID(),
      objectiveId: objective.id,
      name: "Parallel",
      leadTagId: owner.id,
      memberTagIds: [other.id],
      maxConcurrency: 100,
    });
    const started: string[] = [];
    const release = gate();
    const worklet: Worklet = {
      async describe() {
        return {
          id: "test",
          protocolVersion: 1,
          host: {
            id: "host",
            workers: ["a", "b"].map((id) => ({
              profileCapabilities: [
                {
                  profile: { id, revision: "1" },
                  capabilities: [COORDINATION_CAPABILITY],
                  contextTypes: [],
                },
              ],
              id,
              type: "test",
              capabilities: [COORDINATION_CAPABILITY],
              profiles: [{ id, revision: "1" }],
              contextTypes: [],
              maxConcurrency: 1,
            })),
          },
        };
      },
      async *execute(spec, signal) {
        started.push(spec.workerProfile.id);
        await Promise.race([
          release.promise,
          new Promise<void>((resolve) => {
            if (signal?.aborted) resolve();
            else signal?.addEventListener("abort", () => resolve(), { once: true });
          }),
        ]);
        signal?.throwIfAborted();
        yield {
          taskId: spec.taskId,
          attemptId: spec.attemptId,
          at: new Date().toISOString(),
          type: "execution.completed",
        };
      },
    };
    const controller = new ObjectiveController(
      store,
      durableTestWorklet({
        ...worklet,
        describe: () => worklet.describe(),
        executeOnWorker: (
          _workerId: string,
          spec: Parameters<Worklet["execute"]>[0],
          signal?: AbortSignal,
        ) => worklet.execute(spec, signal),
      } as Worklet),
    );
    controller.activateCoordination({ url: "http://127.0.0.1:3434" });
    cleanups.push(async () => {
      release.resolve();
      await controller.stop();
    });
    const assign = (assignedTagId: string) =>
      controller.command("assign_task", {
        objectiveId: objective.id,
        taskId: randomUUID(),
        teamId: team.id,
        assignedTagId,
        execution: { profile: { id: assignedTagId === owner.id ? "a" : "b", revision: "1" } },
        instruction: "Run",
        acceptanceCriteria: ["Finished"],
      });
    return { store, owner, other, objective, controller, started, release, assign, worklet };
  }
  it("keeps follow-up IDs bounded and deterministic for maximum-length Task IDs", async () => {
    expect(await taskFollowupId("ordinary")).toBe("ordinary:followup");
    const source = "x".repeat(200);
    const result = await taskFollowupId(source);
    expect(result.length).toBeLessThanOrEqual(200);
    expect(result).toBe(await taskFollowupId(source));
    expect(result).not.toBe(await taskFollowupId(`${source.slice(0, -1)}y`));
  });
  it("does not let one occupied profile suppress independent profile capacity", async () => {
    const f = await fixture();
    await f.assign(f.owner.id);
    await f.assign(f.other.id);
    f.controller.start();
    await vi.waitFor(() => expect(f.started.sort()).toEqual(["a", "b"]), {
      timeout: 1500,
      interval: 20,
    });
  });
  it("starts several independent delegated Tasks together on one host", async () => {
    const f = await fixture();
    vi.spyOn(f.worklet, "describe").mockResolvedValue({
      id: "parallel",
      protocolVersion: 1,
      host: {
        id: "host",
        workers: [
          {
            profileCapabilities: [
              {
                profile: { id: "b", revision: "1" },
                capabilities: [COORDINATION_CAPABILITY],
                contextTypes: [],
              },
            ],
            id: "delegated",
            type: "test",
            capabilities: [COORDINATION_CAPABILITY],
            profiles: [{ id: "b", revision: "1" }],
            contextTypes: [],
            maxConcurrency: 4,
          },
        ],
      },
    });
    const assignments = await Promise.all([
      f.assign(f.other.id),
      f.assign(f.other.id),
      f.assign(f.other.id),
    ]);
    f.controller.start();
    await vi.waitFor(() => expect(f.started).toHaveLength(3), { timeout: 3000 });
    expect(
      await Promise.all(
        assignments.map((assignment) =>
          f.store.getTaskAssignment((assignment as { taskId: string }).taskId),
        ),
      ),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ status: "running" }),
        expect.objectContaining({ status: "running" }),
        expect.objectContaining({ status: "running" }),
      ]),
    );
  });
  it("starts an owner activation in the coordination slot when delegated Tasks fill every slot", async () => {
    const f = await fixture();
    vi.spyOn(f.worklet, "describe").mockResolvedValue({
      id: "parallel",
      protocolVersion: 1,
      host: {
        id: "host",
        workers: [
          {
            profileCapabilities: [
              {
                profile: { id: "a", revision: "1" },
                capabilities: [COORDINATION_CAPABILITY],
                contextTypes: [],
              },
              {
                profile: { id: "b", revision: "1" },
                capabilities: [COORDINATION_CAPABILITY],
                contextTypes: [],
              },
            ],
            id: "shared",
            type: "test",
            capabilities: [COORDINATION_CAPABILITY],
            profiles: [
              { id: "a", revision: "1" },
              { id: "b", revision: "1" },
            ],
            contextTypes: [],
            maxConcurrency: 4,
          },
        ],
      },
    });
    await Promise.all(Array.from({ length: 5 }, () => f.assign(f.other.id)));
    f.controller.start();
    // Delegated Tasks use all four configured slots; the fifth waits.
    await vi.waitFor(() => expect(f.started).toHaveLength(4), { timeout: 3000 });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(f.started).toHaveLength(4);
    await f.controller.command("start_objective", { objectiveId: f.objective.id });
    await vi.waitFor(() => expect(f.started).toContain("a"), { timeout: 3000 });
    expect(f.started).toHaveLength(5);
  });
  it("counts overlapping profiles against their shared Worker capacity", async () => {
    const f = await fixture();
    vi.spyOn(f.worklet, "describe").mockResolvedValue({
      id: "shared",
      protocolVersion: 1,
      host: {
        id: "host",
        workers: [
          {
            profileCapabilities: [
              {
                profile: { id: "a", revision: "1" },
                capabilities: [COORDINATION_CAPABILITY],
                contextTypes: [],
              },
              {
                profile: { id: "b", revision: "1" },
                capabilities: [COORDINATION_CAPABILITY],
                contextTypes: [],
              },
            ],
            id: "shared",
            type: "test",
            capabilities: [COORDINATION_CAPABILITY],
            profiles: [
              { id: "a", revision: "1" },
              { id: "b", revision: "1" },
            ],
            contextTypes: [],
            maxConcurrency: 1,
          },
        ],
      },
    });
    await f.assign(f.owner.id);
    await f.assign(f.other.id);
    f.controller.start();
    await vi.waitFor(() => expect(f.started).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(f.started).toHaveLength(1);
    f.release.resolve();
    await vi.waitFor(() => expect(f.started.sort()).toEqual(["a", "b"]));
  });
  it("does not launch an execution after stop begins during an in-flight claim", async () => {
    const f = await fixture();
    await f.assign(f.owner.id);
    const entered = gate(),
      releaseClaim = gate();
    const original = f.store.claimTaskAssignment.bind(f.store);
    vi.spyOn(f.store, "claimTaskAssignment").mockImplementation(async (input) => {
      entered.resolve();
      await releaseClaim.promise;
      return original(input);
    });
    f.controller.start();
    await entered.promise;
    const stopping = f.controller.stop();
    releaseClaim.resolve();
    await stopping;
    expect(f.started).toEqual([]);
    expect(f.controller.activeCount).toBe(0);
  });
});
