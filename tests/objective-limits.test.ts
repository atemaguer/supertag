import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ControlPlane } from "../packages/control-plane/src/index.js";
import { evaluateObjectiveLimits } from "../packages/control-plane/src/objective-limits.js";
import { objectiveLimitsView } from "../packages/control-plane/src/objective-summary.js";
import {
  type Objective,
  objectiveDeadlineGraceMs,
  objectiveDeadlineStopsRunning,
  objectiveDeadlineWarningMinutes,
  objectiveLimitEvents,
  readableDuration,
} from "../packages/core/src/index.js";
import {
  COORDINATION_CAPABILITY,
  REPORTED_COST_LIMIT_CAPABILITY,
  REPORTED_TOKEN_LIMIT_CAPABILITY,
  SURFACE_COORDINATION_CAPABILITY,
  type TaskAttemptEvent,
  type TaskAttemptSpec,
  type Worklet,
} from "../packages/runtime/sdk/src/index.js";
import {
  DrizzleStore,
  FileGatewayCredentialVault,
  migrateDatabase,
} from "../packages/store/src/index.js";
import { createIsolatedPostgresDatabase } from "./support/database.js";
import { startObjectiveSession } from "./support/objective-session.js";

const postgres = process.env["SUPERTAG_POSTGRES_URL"];
const minutesFromNow = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString();

const CAPABILITIES = [
  COORDINATION_CAPABILITY,
  SURFACE_COORDINATION_CAPABILITY,
  REPORTED_TOKEN_LIMIT_CAPABILITY,
  REPORTED_COST_LIMIT_CAPABILITY,
];

/**
 * A Worker that reports `cost()` minor units of provider cost for each turn and answers it,
 * holding only the Task selected by the fixture.
 */
function scriptedWorklet(cost: () => number | undefined, heldTaskId?: Promise<string | undefined>) {
  const blocked = Promise.withResolvers<void>();
  const abortedTaskIds: string[] = [];
  const worklet: Worklet = {
    id: "limits-worklet",
    describe: async () => ({
      id: "limits-worklet",
      protocolVersion: 1,
      host: {
        id: "limits-host",
        workers: [
          {
            id: "limits-worker",
            type: "deterministic",
            profiles: [{ id: "default", revision: "1" }],
            capabilities: CAPABILITIES,
            contextTypes: [],
            maxConcurrency: 4,
            profileCapabilities: [
              {
                profile: { id: "default", revision: "1" },
                capabilities: CAPABILITIES,
                contextTypes: [],
              },
            ],
          },
        ],
      },
    }),
    selectPlacement: async () => ({
      workerHostId: "limits-host",
      workletId: "limits-worklet",
      workerId: "limits-worker",
      workerProfile: { id: "default", revision: "1" },
    }),
    async *execute(spec: TaskAttemptSpec, signal): AsyncIterable<TaskAttemptEvent> {
      const identity = { taskId: spec.taskId, attemptId: spec.attemptId };
      const at = () => new Date().toISOString();
      yield { ...identity, at: at(), type: "execution.started", workerId: "limits-worker" };
      const amountMinor = cost();
      yield {
        ...identity,
        at: at(),
        type: "usage.updated",
        usage: {
          inputTokens: 10,
          outputTokens: 10,
          cachedInputTokens: 0,
          totalTokens: 20,
          complete: true,
          ...(amountMinor === undefined ? {} : { reportedCost: { amountMinor, currency: "USD" } }),
        },
      };
      if (heldTaskId && (await heldTaskId) === spec.taskId && !signal?.aborted)
        await new Promise<void>((resolve) => {
          void blocked.promise.then(resolve);
          signal?.addEventListener("abort", () => resolve(), { once: true });
        });
      if (signal?.aborted) {
        abortedTaskIds.push(spec.taskId);
        throw signal.reason;
      }
      yield {
        ...identity,
        at: at(),
        type: "output.message",
        message: { role: "teammate", text: "Working on it" },
      };
      yield { ...identity, at: at(), type: "execution.completed" };
    },
  };
  return { worklet, abortedTaskIds, release: blocked.resolve };
}

for (const dialect of ["sqlite", "postgresql"] as const) {
  describe.skipIf(dialect === "postgresql" && !postgres)(
    `${dialect} Objective limits`,
    { timeout: 60_000 },
    () => {
      const cleanups: Array<() => Promise<unknown> | unknown> = [];
      afterEach(async () => {
        for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
      });

      async function fixture(
        definition: Record<string, unknown> = {},
        options: { readonly cost?: number; readonly holdStart?: boolean } = {},
      ) {
        const directory = await mkdtemp(join(tmpdir(), "supertag-limits-"));
        cleanups.push(() => rm(directory, { recursive: true, force: true }));
        const isolated =
          dialect === "postgresql"
            ? await createIsolatedPostgresDatabase(postgres as string)
            : undefined;
        if (isolated) cleanups.push(isolated.cleanup);
        const url = isolated?.url ?? `file:${join(directory, "state.db")}`;
        await migrateDatabase({ url });
        const store = new DrizzleStore({ url });
        await store.connect();
        cleanups.push(() => store.disconnect());
        let cost = options.cost;
        const heldTaskId = options.holdStart
          ? Promise.withResolvers<string | undefined>()
          : undefined;
        const script = scriptedWorklet(() => cost, heldTaskId?.promise);
        const controlPlane = new ControlPlane({
          store: new DrizzleStore({ url }),
          credentialVault: new FileGatewayCredentialVault(join(directory, "vault.json")),
          worklet: script.worklet,
          reply: async () => ({ externalMessageId: randomUUID() }),
          dispatch: { pollIntervalMs: 10, retryBaseMs: 50, maxAttempts: 1 },
        });
        await controlPlane.start();
        cleanups.push(() => controlPlane.stop());
        // Released before the Control Plane stops, so a failed test cannot hold its drain.
        cleanups.push(() => {
          heldTaskId?.resolve(undefined);
          script.release();
        });
        const owner = await store.createTag({ name: `owner-${randomUUID()}` });
        await store.bindTagWorkerHost(owner.id, "limits-host");
        const session = await startObjectiveSession({
          store,
          controlPlane,
          ownerTagId: owner.id,
          // Ongoing: the Objective is never woken for being idle, so each test controls
          // exactly which turns run and what they spend.
          objective: {
            ongoing: true,
            outcome: "Ship the release",
            ...definition,
          },
        });
        heldTaskId?.resolve(session.startTaskId);
        const objective = session.objective;
        const reload = () => store.getObjective(objective.id);
        const operator = async (update: Record<string, unknown>) =>
          store.updateObjectiveStatus(
            objective.id,
            { ...update, expectedRevision: (await reload()).revision } as never,
            undefined,
            undefined,
            { operatorId: "test-operator" },
          );
        const attention = async () =>
          (
            await controlPlane.objectives.readObjectiveOverview({ objectiveId: objective.id })
          ).attention.map((item) => item.kind);
        /** One more turn of the Objective's conversation, as an operator message. */
        const turn = (text: string) =>
          controlPlane.messageObjective({
            objectiveId: objective.id,
            text,
            operatorId: "admin",
            idempotencyKey: randomUUID(),
          });
        const sweep = () => controlPlane.objectives.sweepObjectiveLimits(true);
        return {
          store,
          controlPlane,
          owner,
          objective,
          session,
          script,
          reload,
          operator,
          attention,
          turn,
          sweep,
          setCost: (next: number | undefined) => {
            cost = next;
          },
        };
      }

      it("keeps an existing Objective unchanged until the Control Plane observes a limit", async () => {
        const f = await fixture({
          deadline: "2030-01-01T00:00:00Z",
          budgetLimitMinor: 500,
          budgetCurrency: "USD",
        });
        expect(await f.reload()).toMatchObject({
          deadline: "2030-01-01T00:00:00.000Z",
          budgetLimitMinor: 500,
          budgetCurrency: "USD",
          limitState: {},
        });
      });

      it("lets only operators move a deadline, and records the change", async () => {
        const f = await fixture({ deadline: minutesFromNow(60) });
        await expect(
          f.store.updateObjectiveStatus(
            f.objective.id,
            { deadline: minutesFromNow(120), expectedRevision: f.objective.revision },
            f.owner.id,
          ),
        ).rejects.toThrow("Only operators may change an Objective deadline");
        const next = minutesFromNow(120);
        const updated = await f.operator({ deadline: next });
        expect(updated.deadline).toBe(next);
        expect(updated.limitState?.deadlineSetAt?.deadline).toBe(next);
        const [change] = await f.store.listResourceChanges({
          resourceType: "objective",
          resourceId: f.objective.id,
        });
        expect(change).toMatchObject({
          operatorId: "test-operator",
          changes: { deadline: { previous: f.objective.deadline, next } },
        });
      });

      it("warns once at 80% of a monetary budget and counts turns without a reported cost", async () => {
        const f = await fixture(
          { budgetLimitMinor: 10_000, budgetCurrency: "USD" },
          { cost: 7000 },
        );
        await f.session.waitForOwnerTurn({ reason: "objective_start" });
        await f.sweep();
        expect((await f.reload()).limitState?.budgetWarnings).toBeUndefined();
        expect((await f.reload()).limitState?.reportedSpend?.amountMinor).toBe(7000);

        f.setCost(1500);
        await f.turn("How is it going?");
        await f.session.waitForOwnerTurn({ reason: "objective_message" });
        // The warning itself reaches the Objective as a turn; keep it free so the pool is
        // exactly what the two turns above reported.
        f.setCost(0);
        await f.sweep();
        const warned = await f.reload();
        expect(warned.limitState?.budgetWarnings).toMatchObject([
          { fraction: 0.8, limitMinor: 10_000, spentMinor: 8500 },
        ]);
        expect(warned.limitState?.reportedSpend?.amountMinor).toBe(8500);
        // Later sweeps do not repeat a recorded warning.
        await f.sweep();
        expect((await f.reload()).limitState?.budgetWarnings).toEqual(
          warned.limitState?.budgetWarnings,
        );
        const inbox = await f.store.readCoordinationInbox({
          objectiveId: f.objective.id,
          kind: "objective_limit",
        });
        expect(inbox.items.map((item) => item.key)).toEqual([
          `objective_limit:${f.objective.id}:budget-threshold-0.8-10000`,
        ]);
        expect(await f.attention()).toContain("objective_budget_threshold");

        // A turn that reported no cost counts as unknown, not zero.
        f.setCost(undefined);
        await f.turn("And now?");
        await f.session.waitForOwnerTurn({ reason: "objective_message" });
        await f.sweep();
        expect(
          ((await f.reload()).limitState?.reportedSpend?.unknownAttemptIds ?? []).length,
        ).toBeGreaterThan(0);
        expect(await f.attention()).toContain("budget_coverage_incomplete");
      });

      it("stops a spent monetary budget: refuses new turns until an operator raises it", async () => {
        const f = await fixture({ budgetLimitMinor: 500, budgetCurrency: "USD" }, { cost: 700 });
        await f.session.waitForOwnerTurn({ reason: "objective_start" });
        await f.sweep();
        expect((await f.reload()).limitState?.budgetExhausted).toMatchObject({
          limitMinor: 500,
          spentMinor: 700,
        });
        // Nothing of the Objective runs any more, so it is limited rather than working.
        expect((await f.reload()).status).toBe("limited");
        await expect(f.turn("Carry on")).rejects.toThrow("has spent its budget");
        expect(await f.attention()).toContain("objective_budget_exhausted");

        f.setCost(0);
        await f.operator({ budgetLimitMinor: 5000 });
        await expect(f.turn("Carry on")).resolves.toMatchObject({
          taskId: expect.any(String),
        });
      });

      it("lets a running turn overrun the budget instead of cancelling it", async () => {
        const f = await fixture(
          { budgetLimitMinor: 500, budgetCurrency: "USD" },
          { cost: 700, holdStart: true },
        );
        const running = await f.session.waitForOwnerTurn({
          reason: "objective_start",
          unsettled: true,
        });
        await expect
          .poll(async () => (await f.store.findTaskById(running.task.id))?.status, {
            timeout: 10_000,
          })
          .toBe("running");
        // The Task runs before its Worker reports the cost, so sweep until the spend is observed.
        await expect
          .poll(
            async () => {
              await f.sweep();
              return (await f.reload()).limitState?.budgetExhausted;
            },
            { timeout: 10_000 },
          )
          .toMatchObject({ spentMinor: 700 });
        // The running Attempt keeps its authority; a spent Objective is limited only once
        // nothing of it runs.
        expect((await f.reload()).status).toBe("working");
        expect(f.script.abortedTaskIds).toEqual([]);
        f.script.release();
        await expect
          .poll(async () => (await f.store.findTaskById(running.task.id))?.status, {
            timeout: 10_000,
          })
          .toBe("completed");
        await f.sweep();
        expect((await f.reload()).status).toBe("limited");
        expect(f.script.abortedTaskIds).toEqual([]);
      });

      it("stops a running turn once the deadline grace period ends, then limits the Objective", async () => {
        const f = await fixture({ deadline: minutesFromNow(60) }, { cost: 0, holdStart: true });
        const running = await f.session.waitForOwnerTurn({
          reason: "objective_start",
          unsettled: true,
        });
        await expect
          .poll(async () => (await f.store.findTaskById(running.task.id))?.status, {
            timeout: 10_000,
          })
          .toBe("running");
        // Inside the grace period the running Attempt keeps its authority.
        await f.operator({ deadline: minutesFromNow(-5) });
        await f.sweep();
        expect((await f.reload()).status).toBe("working");
        expect((await f.store.findTaskById(running.task.id))?.status).toBe("running");
        expect(f.script.abortedTaskIds).not.toContain(running.task.id);

        // Past it, SuperTag stops the Attempt and the Objective becomes limited.
        await f.operator({ deadline: minutesFromNow(-20) });
        await f.sweep();
        await expect
          .poll(async () => (await f.store.findTaskById(running.task.id))?.status, {
            timeout: 10_000,
          })
          .toBe("cancelled");
        // A queued notice may still be settling while the Objective drains.
        await expect
          .poll(
            async () => {
              await f.sweep();
              return (await f.reload()).status;
            },
            { timeout: 10_000 },
          )
          .toBe("limited");
        // A deadline notice is a separate Task. It may also be cancelled as the Objective drains.
        expect(f.script.abortedTaskIds.filter((id) => id === running.task.id)).toHaveLength(1);
        f.script.release();
      });

      it("keeps a budget without a currency as an allocation limit only", async () => {
        const f = await fixture({ budgetLimitMinor: 500 }, { cost: 9000 });
        await f.session.waitForOwnerTurn({ reason: "objective_start" });
        await f.sweep();
        expect((await f.reload()).limitState).toEqual({});
        expect((await f.reload()).status).toBe("working");
        await expect(f.turn("Carry on")).resolves.toMatchObject({ taskId: expect.any(String) });
      });

      it("records a passed deadline and limits the Objective once nothing runs", async () => {
        const f = await fixture({ deadline: minutesFromNow(60) }, { cost: 0 });
        await f.session.waitForOwnerTurn({ reason: "objective_start" });
        await f.operator({ deadline: minutesFromNow(-20) });
        await f.sweep();
        expect((await f.reload()).limitState?.deadlinePassed).toBeDefined();
        expect(await f.attention()).toContain("deadline_passed");
        // Past the grace period with nothing running, the Objective is limited.
        expect((await f.reload()).status).toBe("limited");
      });

      it("skips deadline warnings whose time had passed when the deadline was set", async () => {
        const f = await fixture({ deadline: minutesFromNow(45) }, { cost: 0 });
        await f.session.waitForOwnerTurn({ reason: "objective_start" });
        await f.sweep();
        expect((await f.reload()).limitState?.deadlineWarnings).toBeUndefined();
      });

      it("delivers a deadline warning to the Objective's conversation once", async () => {
        const f = await fixture({ deadline: minutesFromNow(60) }, { cost: 0 });
        await f.session.waitForOwnerTurn({ reason: "objective_start" });
        // 15 minutes before a 60-minute deadline.
        await f.operator({ deadline: minutesFromNow(15) });
        await f.sweep();
        expect((await f.reload()).limitState?.deadlineWarnings ?? []).toMatchObject([]);
        const notice = await f.session.waitForOwnerTurn({ reason: "objective_notice" });
        const event = await f.store.findInboundEventById(notice.task.inboundEventId ?? "");
        expect(event?.event.text).toContain("the Objective deadline");
        // Repeating the sweep delivers no second notice for the same event.
        await f.sweep();
        await f.sweep();
        const session = await f.store.findObjectiveOwnerSession(f.objective.id);
        const texts = await Promise.all(
          (await f.store.listSessionTaskIds(session?.id ?? "")).map(async (id) => {
            const task = await f.store.findTaskById(id);
            const inbound = task?.inboundEventId
              ? await f.store.findInboundEventById(task.inboundEventId)
              : undefined;
            return inbound?.event.text ?? "";
          }),
        );
        expect(texts.filter((text) => text === event?.event.text)).toHaveLength(1);
      });
    },
  );
}

describe("Objective limit evaluation", () => {
  const base = {
    id: "o",
    outcome: "Ship",
    ownerTagId: "t",
    status: "working",
    revision: 1,
    completionSummary: null,
    spentMinor: 0,
    reservedMinor: 0,
    createdAt: "2030-01-01T00:00:00.000Z",
    updatedAt: "2030-01-01T00:00:00.000Z",
    limitState: {},
  } as unknown as Objective;

  it("warns 24 hours and 1 hour before a deadline, once each", () => {
    const objective = { ...base, deadline: "2030-01-05T00:00:00.000Z" } as Objective;
    const dayBefore = evaluateObjectiveLimits(objective, "2030-01-04T00:30:00.000Z", undefined);
    expect(dayBefore.deadlineWarnings?.map((entry) => entry.minutesBefore)).toEqual([1440]);
    const again = evaluateObjectiveLimits(
      { ...objective, limitState: dayBefore },
      "2030-01-04T01:00:00.000Z",
      undefined,
    );
    expect(again.deadlineWarnings).toEqual(dayBefore.deadlineWarnings);
    const hourBefore = evaluateObjectiveLimits(
      { ...objective, limitState: again },
      "2030-01-04T23:30:00.000Z",
      undefined,
    );
    expect(hourBefore.deadlineWarnings?.map((entry) => entry.minutesBefore)).toEqual([1440, 60]);
    const passed = evaluateObjectiveLimits(
      { ...objective, limitState: hourBefore },
      "2030-01-05T00:00:01.000Z",
      undefined,
    );
    expect(passed.deadlinePassed?.deadline).toBe(objective.deadline);
  });

  it("starts a fresh set of observations when the deadline moves", () => {
    const objective = {
      ...base,
      deadline: "2030-01-05T00:00:00.000Z",
      limitState: {
        deadlineWarnings: [{ minutesBefore: 1440, deadline: "2030-01-02T00:00:00.000Z", at: "x" }],
        deadlinePassed: { deadline: "2030-01-02T00:00:00.000Z", at: "y" },
        deadlineSetAt: { deadline: "2030-01-05T00:00:00.000Z", at: "2030-01-04T12:00:00.000Z" },
      },
    } as unknown as Objective;
    // Set 12 hours before the new deadline: the 24-hour warning was already due, so it is
    // skipped. A quarter of the 12-hour window is 3 hours.
    const state = evaluateObjectiveLimits(objective, "2030-01-04T23:30:00.000Z", undefined);
    expect(state.deadlinePassed).toBeUndefined();
    expect(state.deadlineWarnings?.map((entry) => entry.minutesBefore)).toEqual([180, 60]);
  });

  /** Evaluates the Objective at each time in turn, carrying the recorded state forward. */
  function sweep(objective: Objective, times: readonly string[]) {
    let state = objective.limitState ?? {};
    const seen: { at: string; minutesBefore: number[] }[] = [];
    for (const at of times) {
      state = evaluateObjectiveLimits({ ...objective, limitState: state }, at, undefined);
      seen.push({ at, minutesBefore: (state.deadlineWarnings ?? []).map((e) => e.minutesBefore) });
    }
    return { state, seen };
  }
  const at = (start: string, minutes: number) =>
    new Date(Date.parse(start) + minutes * 60_000).toISOString();

  it("warns a 60-minute deadline when 15 minutes are left", () => {
    const setAt = "2030-01-01T10:00:00.000Z";
    const deadline = at(setAt, 60);
    const objective = {
      ...base,
      deadline,
      limitState: { deadlineSetAt: { deadline, at: setAt } },
    } as unknown as Objective;
    expect(objectiveDeadlineWarningMinutes(deadline, setAt)).toEqual([15]);
    const { state, seen } = sweep(objective, [at(setAt, 1), at(setAt, 44), at(setAt, 45)]);
    // The 1-hour warning was due the moment the deadline was set, so it is skipped.
    expect(seen.map((entry) => entry.minutesBefore)).toEqual([[], [], [15]]);
    expect(objectiveLimitEvents({ ...objective, limitState: state })).toMatchObject([
      {
        kind: "objective_deadline_approaching",
        message: `The Objective deadline ${deadline} is near: about 15 minutes left.`,
      },
    ]);
  });

  it("warns a 2-day deadline at 24 hours, 12 hours, and 1 hour left", () => {
    const deadline = at(base.createdAt, 2 * 1440);
    const objective = { ...base, deadline } as Objective;
    expect(objectiveDeadlineWarningMinutes(deadline, base.createdAt)).toEqual([1440, 720, 60]);
    const { seen } = sweep(objective, [
      at(base.createdAt, 1439),
      at(base.createdAt, 1440),
      at(base.createdAt, 2160),
      at(base.createdAt, 2820),
    ]);
    expect(seen.map((entry) => entry.minutesBefore)).toEqual([
      [],
      [1440],
      [1440, 720],
      [1440, 720, 60],
    ]);
    expect(
      objectiveLimitEvents({ ...objective, limitState: sweep(objective, [deadline]).state }),
    ).toMatchObject([{ kind: "deadline_passed" }]);
  });

  it("states remaining time in readable units", () => {
    expect(readableDuration(30_000)).toBe("less than a minute");
    expect(readableDuration(60_000)).toBe("about 1 minute");
    expect(readableDuration(15 * 60_000)).toBe("about 15 minutes");
    expect(readableDuration(60 * 60_000)).toBe("about 1 hour");
    expect(readableDuration(12 * 3_600_000)).toBe("about 12 hours");
    expect(readableDuration(3 * 86_400_000)).toBe("about 3 days");
  });

  it("caps the 15-minute grace at a quarter of a short deadline window", () => {
    const grace = (minutes: number) => {
      const deadline = at(base.createdAt, minutes);
      return objectiveDeadlineGraceMs({ ...base, deadline }) / 60_000;
    };
    expect(grace(2 * 1440)).toBe(15);
    expect(grace(60)).toBe(15);
    expect(grace(20)).toBe(5);
    expect(grace(2)).toBe(1);
    // A moved deadline measures its window from when it was set.
    const setAt = at(base.createdAt, 600);
    const deadline = at(setAt, 20);
    const moved = { ...base, deadline, limitState: { deadlineSetAt: { deadline, at: setAt } } };
    expect(objectiveDeadlineGraceMs(moved)).toBe(5 * 60_000);
    expect(objectiveDeadlineStopsRunning(moved, at(deadline, 4))).toBe(false);
    expect(objectiveDeadlineStopsRunning(moved, at(deadline, 5))).toBe(true);
    // A deadline set after it had already passed has no window and keeps the full grace.
    const past = {
      ...base,
      deadline,
      limitState: { deadlineSetAt: { deadline, at: at(deadline, 1) } },
    };
    expect(objectiveDeadlineGraceMs(past)).toBe(15 * 60_000);
  });

  it("states the deadline and minutes remaining in every activation's current work", () => {
    const now = "2030-01-01T00:00:00.000Z";
    const view = objectiveLimitsView(
      {
        ...base,
        deadline: "2030-01-01T01:30:00.000Z",
        budgetLimitMinor: 1000,
        budgetCurrency: "USD",
        limitState: {
          reportedSpend: {
            amountMinor: 400,
            currency: "USD",
            unknownAttemptIds: [],
            observedAt: now,
          },
        },
      } as Objective,
      now,
    );
    expect(view.deadline).toMatchObject({
      at: "2030-01-01T01:30:00.000Z",
      minutesRemaining: 90,
      remaining: "about 2 hours left",
      passed: false,
      graceMinutes: 15,
    });
    expect(view.budget).toMatchObject({
      measure: "provider_reported_cost",
      reportedSpentMinor: 400,
      exhausted: false,
    });
  });
});
