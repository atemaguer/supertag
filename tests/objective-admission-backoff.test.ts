import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  admissionRetryDelayMs,
  ObjectiveController,
} from "../packages/control-plane/src/objective-controller.js";
import { emptyTagContextPlan } from "../packages/core/src/index.js";
import type {
  AttemptInspection,
  AttemptReceipt,
  DurableWorklet,
  TaskAttemptEvent,
  TaskAttemptSpec,
  Worklet,
} from "../packages/runtime/sdk/src/index.js";
import { WorkletAdmissionRejectedError } from "../packages/runtime/sdk/src/index.js";
import { DrizzleStore, migrateDatabase } from "../packages/store/src/index.js";
import { durableTestWorklet } from "./support/durable-test-worklet.js";

describe("durable Worklet admission retry", () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });

  it("uses exponential delay with a finite ceiling", () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8, 100].map(admissionRetryDelayMs)).toEqual([
      500, 1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000,
    ]);
  });

  it("paces rejected Attempts and promptly retries the same durable Task", async () => {
    const directory = await mkdtemp(join(tmpdir(), "supertag-admission-backoff-"));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const url = `file:${join(directory, "state.db")}`;
    await migrateDatabase({ url });
    const store = new DrizzleStore({ url });
    await store.connect();
    cleanups.push(() => store.disconnect());

    const id = randomUUID();
    const profile = { id: "admission-backoff", revision: "1" };
    const owner = await store.createTag({ name: `owner-${id}` });
    await store.bindTagWorkerHost(owner.id, "backoff-host");
    await store.createObjective({
      id,
      ownerTagId: owner.id,
      outcome: "Retry rejected durable admission",
    });
    await store.createTeam({
      id,
      objectiveId: id,
      name: "Retry",
      leadTagId: owner.id,
      memberTagIds: [],
      maxConcurrency: 1,
    });
    const at = new Date().toISOString();
    await store.admitTaskAssignment({
      taskId: id,
      objectiveId: id,
      teamId: id,
      requestedByTagId: owner.id,
      assignedTagId: owner.id,
      instruction: "Complete after capacity returns",
      acceptanceCriteria: ["Execution accepted"],
      execution: { profile },
      authorizationSnapshot: {
        version: 4,
        capturedAt: at,
        tag: { id: owner.id, name: owner.name },
        origin: { kind: "internal", objectiveId: id, requestedByTagId: owner.id },
        requester: { id: owner.id, kind: "user" },
        permissionSets: [],
        resources: [],
        runtimeActions: [],
      },
      contextPlan: emptyTagContextPlan(at),
      workspacePlan: { version: 1, status: "none" },
    });

    const acceptTimes: number[] = [];
    const inspections = new Map<string, AttemptInspection>();
    const worklet: DurableWorklet = {
      id: "backoff-worklet",
      async describe() {
        return {
          id: "backoff-worklet",
          protocolVersion: 1,
          host: {
            id: "backoff-host",
            workers: [
              {
                profileCapabilities: [
                  {
                    profile: profile,
                    capabilities: [{ id: "supertag.coordination", version: 1 }],
                    contextTypes: [],
                  },
                ],
                id: "backoff-worker",
                type: "test",
                profiles: [profile],
                capabilities: [{ id: "supertag.coordination", version: 1 }],
                contextTypes: [],
                maxConcurrency: 1,
              },
            ],
          },
        };
      },
      async accept(spec: TaskAttemptSpec): Promise<AttemptReceipt> {
        acceptTimes.push(Date.now());
        if (acceptTimes.length < 3) throw new Error("Worker capacity changed before admission");
        const inspection: AttemptInspection = {
          taskId: spec.taskId,
          attemptId: spec.attemptId,
          specDigest: "accepted",
          status: "completed",
          lastSequence: 3,
          workerId: "selected-worker",
          workerHostId: "selected-host",
          workletId: "selected-worklet",
        };
        inspections.set(spec.attemptId, inspection);
        return inspection;
      },
      async inspect(attemptId: string) {
        return inspections.get(attemptId);
      },
      async *events(attemptId: string, after = 0) {
        const identity = { taskId: id, attemptId, at: new Date().toISOString() };
        if (after < 1)
          yield {
            sequence: 1,
            event: { ...identity, type: "execution.started" as const, workerId: "backoff-worker" },
          };
        if (after < 2)
          yield {
            sequence: 2,
            event: {
              ...identity,
              type: "output.message" as const,
              message: { role: "teammate" as const, text: "Capacity returned" },
            },
          };
        if (after < 3)
          yield { sequence: 3, event: { ...identity, type: "execution.completed" as const } };
      },
      async cancel(attemptId: string) {
        const inspection = inspections.get(attemptId);
        if (!inspection) throw new Error("Attempt not accepted");
        return inspection;
      },
      execute() {
        throw new Error("Legacy execution must not run");
      },
    };
    const onError = vi.fn();
    const controller = new ObjectiveController(store, worklet, onError);
    controller.activateCoordination({ url: "http://fixture.invalid" });
    controller.start();
    cleanups.push(() => controller.stop());

    await expect.poll(() => acceptTimes.length, { timeout: 4_000 }).toBe(3);
    await expect
      .poll(async () => (await store.getTaskAssignment(id))?.status, { timeout: 1_000 })
      .toBe("submitted");

    const [firstAccept, secondAccept, thirdAccept] = acceptTimes;
    if (firstAccept === undefined || secondAccept === undefined || thirdAccept === undefined)
      throw new Error("Expected three durable admission attempts");
    expect(secondAccept - firstAccept).toBeGreaterThanOrEqual(450);
    expect(thirdAccept - secondAccept).toBeGreaterThanOrEqual(950);
    expect(await store.listTaskAttempts(id)).toHaveLength(3);
    expect(await store.listTaskAttempts(id)).toEqual([
      expect.objectContaining({ attemptNumber: 1, status: "failed" }),
      expect.objectContaining({ attemptNumber: 2, status: "failed" }),
      expect.objectContaining({
        attemptNumber: 3,
        status: "completed",
        workerSnapshot: expect.objectContaining({
          workerHostId: "selected-host",
          workletId: "selected-worklet",
          workerId: "selected-worker",
          workerProfile: profile,
          kind: "assignment",
          durableExecution: true,
        }),
      }),
    ]);
    expect((await store.readCoordinationMetrics()).scheduling).toMatchObject({
      placedAttempts: 3,
      admissionRejections: 2,
    });
    expect(onError).not.toHaveBeenCalled();
  }, 6_000);

  it("requeues a transport rejection after scheduling without terminally failing the Task", async () => {
    const directory = await mkdtemp(join(tmpdir(), "supertag-transport-race-"));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const url = `file:${join(directory, "state.db")}`;
    await migrateDatabase({ url });
    const store = new DrizzleStore({ url });
    await store.connect();
    cleanups.push(() => store.disconnect());

    const id = randomUUID();
    const profile = { id: "transport-race", revision: "1" };
    const owner = await store.createTag({ name: `owner-${id}` });
    await store.bindTagWorkerHost(owner.id, "transport-race-host");
    await store.createObjective({
      id,
      ownerTagId: owner.id,
      outcome: "Retry after the transport reconnects",
    });
    await store.createTeam({
      id,
      objectiveId: id,
      name: "Transport",
      leadTagId: owner.id,
      memberTagIds: [],
      maxConcurrency: 1,
    });
    const at = new Date().toISOString();
    await store.admitTaskAssignment({
      taskId: id,
      objectiveId: id,
      teamId: id,
      requestedByTagId: owner.id,
      assignedTagId: owner.id,
      instruction: "Complete after reconnect",
      acceptanceCriteria: ["Execution accepted"],
      execution: { profile },
      authorizationSnapshot: {
        version: 4,
        capturedAt: at,
        tag: { id: owner.id, name: owner.name },
        origin: { kind: "internal", objectiveId: id, requestedByTagId: owner.id },
        requester: { id: owner.id, kind: "user" },
        permissionSets: [],
        resources: [],
        runtimeActions: [],
      },
      contextPlan: emptyTagContextPlan(at),
      workspacePlan: { version: 1, status: "none" },
    });

    let executions = 0;
    const worklet: Worklet = {
      id: "transport-race-worklet",
      async describe() {
        return {
          id: "transport-race-worklet",
          protocolVersion: 1,
          host: {
            id: "transport-race-host",
            workers: [
              {
                profileCapabilities: [
                  {
                    profile: profile,
                    capabilities: [{ id: "supertag.coordination", version: 1 }],
                    contextTypes: [],
                  },
                ],
                id: "transport-race-worker",
                type: "test",
                profiles: [profile],
                capabilities: [{ id: "supertag.coordination", version: 1 }],
                contextTypes: [],
                maxConcurrency: 1,
              },
            ],
          },
        };
      },
      async *execute(spec: TaskAttemptSpec): AsyncIterable<TaskAttemptEvent> {
        const identity = {
          taskId: spec.taskId,
          attemptId: spec.attemptId,
          at: new Date().toISOString(),
        };
        yield { ...identity, type: "execution.started", workerId: "transport-race-worker" };
        yield {
          ...identity,
          type: "output.message",
          message: { role: "teammate", text: "Transport reconnected" },
        };
        yield { ...identity, type: "execution.completed" };
      },
    };
    const onError = vi.fn();
    const durable = durableTestWorklet(worklet);
    const accept = durable.accept.bind(durable);
    vi.spyOn(durable, "accept").mockImplementation(async (spec) => {
      executions += 1;
      if (executions === 1) {
        await durable.releasePlacement({
          workerHostId: "transport-race-host",
          workletId: "transport-race-worklet",
          workerId: "transport-race-worker",
          workerProfile: spec.workerProfile,
          ...spec.placement,
        });
        throw new WorkletAdmissionRejectedError("Transport disconnected before dispatch");
      }
      return accept(spec);
    });
    const controller = new ObjectiveController(store, durable, onError);
    controller.activateCoordination({ url: "http://fixture.invalid" });
    controller.start();
    cleanups.push(() => controller.stop());

    await expect.poll(() => executions, { timeout: 2_000 }).toBe(2);
    await expect
      .poll(async () => (await store.getTaskAssignment(id))?.status, { timeout: 1_000 })
      .toBe("submitted");
    expect(await store.listTaskAttempts(id)).toEqual([
      expect.objectContaining({ attemptNumber: 1, status: "failed" }),
      expect.objectContaining({ attemptNumber: 2, status: "completed" }),
    ]);
    expect(onError).not.toHaveBeenCalled();
  }, 4_000);
});
