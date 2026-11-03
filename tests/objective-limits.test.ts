import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ObjectiveController } from "../packages/control-plane/src/objective-controller.js";
import { evaluateObjectiveLimits } from "../packages/control-plane/src/objective-limits.js";
import { objectiveLimitsView } from "../packages/control-plane/src/objective-summary.js";
import {
  emptyTagContextPlan,
  type Objective,
  objectiveDeadlineGraceMs,
  objectiveDeadlineStopsRunning,
  objectiveDeadlineWarningMinutes,
  objectiveLimitEvents,
  readableDuration,
} from "../packages/core/src/index.js";
import { LocalWorklet, type Worker } from "../packages/runtime/sdk/src/index.js";
import { DrizzleStore, migrateDatabase } from "../packages/store/src/index.js";
import { createIsolatedPostgresDatabase } from "./support/database.js";
import { durableTestWorklet } from "./support/durable-test-worklet.js";

const postgres = process.env["SUPERTAG_POSTGRES_URL"];
const minutesFromNow = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString();

for (const dialect of ["sqlite", "postgresql"] as const) {
  describe.skipIf(dialect === "postgresql" && !postgres)(
    `${dialect} Objective limits`,
    { timeout: 30_000 },
    () => {
      const cleanups: Array<() => Promise<unknown> | unknown> = [];
      afterEach(async () => {
        for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
      });
      async function fixture(definition: Record<string, unknown> = {}) {
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
        const owner = await store.createTag({ name: `owner-${randomUUID()}` });
        const objective = await store.createObjective({
          id: randomUUID(),
          ownerTagId: owner.id,
          outcome: "Ship the release",
          ...definition,
        });
        const team = await store.createTeam({
          id: `${objective.id}:leadership`,
          objectiveId: objective.id,
          name: "Leadership",
          leadTagId: owner.id,
          memberTagIds: [owner.id],
          maxConcurrency: 4,
        });
        const controller = new ObjectiveController(store, undefined);
        async function admit(id: string, start = false) {
          const at = new Date().toISOString();
          return store.admitTaskAssignment({
            taskId: id,
            objectiveId: objective.id,
            teamId: team.id,
            requestedByTagId: owner.id,
            assignedTagId: owner.id,
            instruction: `Produce ${id}`,
            acceptanceCriteria: ["Reviewed"],
            requiresApproval: false,
            dependencies: [],
            maxCostMinor: 0,
            execution: {},
            workspacePlan: { version: 1, status: "none" },
            contextPlan: emptyTagContextPlan(at),
            authorizationSnapshot: {
              version: 4,
              capturedAt: at,
              tag: { id: owner.id, name: owner.name },
              origin: { kind: "internal", objectiveId: objective.id, requestedByTagId: owner.id },
              requester: { id: owner.id, kind: "bot" },
              permissionSets: [],
              resources: [],
              runtimeActions: [],
            },
            ...(start ? { startObjectiveExecution: true } : {}),
          });
        }
        /** Claims a Task and opens its running Task Attempt, as the controller would. */
        async function run(id: string, leaseOwner = "test") {
          const claim = await store.claimTaskAssignment({
            taskId: id,
            leaseOwner,
            leaseSeconds: 300,
          });
          if (!claim) throw new Error(`Could not claim ${id}`);
          const attempt = await store.createTaskAttempt({
            taskId: id,
            attemptNumber: claim.attemptCount,
            workerProfile: { id: "fixture", revision: "1" },
            workerSnapshot: {},
            startedAt: new Date().toISOString(),
          });
          await store.startTask({ taskId: id, startedAt: new Date().toISOString() });
          return { claim, attempt };
        }
        async function usage(
          taskId: string,
          attemptId: string,
          reportedCost?: { amountMinor: number; currency: string; estimated?: boolean },
        ) {
          await store.appendTaskEvent({
            taskId,
            attemptId,
            type: "usage.updated",
            payload: {
              usage: {
                inputTokens: 10,
                outputTokens: 10,
                cachedInputTokens: 0,
                totalTokens: 20,
                complete: true,
                ...(reportedCost ? { reportedCost } : {}),
              },
            },
          });
        }
        async function fail(
          id: string,
          run: { claim: { attemptCount: number }; attempt: { id: string } },
        ) {
          await store.settleTaskAssignment({
            taskId: id,
            leaseOwner: "test",
            attemptCount: run.claim.attemptCount,
            failed: true,
            result: { error: "Harness failure" },
            terminalAttempt: { id: run.attempt.id, status: "failed" },
          });
        }
        const operator = async (update: Record<string, unknown>) => {
          const current = await store.getObjective(objective.id);
          return store.updateObjectiveStatus(
            objective.id,
            { ...update, expectedRevision: current.revision } as never,
            undefined,
            undefined,
            { operatorId: "test-operator" },
          );
        };
        const reload = () => store.getObjective(objective.id);
        const attention = async () =>
          (await controller.readObjectiveOverview({ objectiveId: objective.id })).attention.map(
            (item) => item.kind,
          );
        return {
          store,
          owner,
          objective,
          controller,
          admit,
          run,
          usage,
          fail,
          operator,
          reload,
          attention,
        };
      }

      it("keeps existing Objectives unchanged until the Control Plane observes a limit", async () => {
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
        await expect(
          f.store.createObjective({
            id: f.objective.id,
            ownerTagId: f.owner.id,
            outcome: "Ship the release",
            deadline: "2030-01-01T00:00:00Z",
            budgetLimitMinor: 500,
            budgetCurrency: "USD",
          }),
        ).resolves.toMatchObject({ id: f.objective.id });
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

      it("warns once at 80% of a monetary budget and reports Task Attempts without cost", async () => {
        const f = await fixture({ budgetLimitMinor: 1000, budgetCurrency: "USD" });
        await f.admit("first", true);
        const first = await f.run("first");
        await f.usage("first", first.attempt.id, { amountMinor: 700, currency: "USD" });
        await f.controller.sweepObjectiveLimits(true);
        expect((await f.reload()).limitState?.budgetWarnings).toBeUndefined();
        await f.store.settleTaskAssignment({
          taskId: "first",
          leaseOwner: "test",
          attemptCount: first.claim.attemptCount,
          terminalAttempt: { id: first.attempt.id, status: "completed" },
          result: {},
        });
        await f.admit("second");
        const second = await f.run("second");
        await f.usage("second", second.attempt.id, {
          amountMinor: 150,
          currency: "USD",
          estimated: true,
        });
        await f.controller.sweepObjectiveLimits(true);
        const warned = await f.reload();
        expect(warned.limitState?.budgetWarnings).toMatchObject([
          { fraction: 0.8, limitMinor: 1000, spentMinor: 850 },
        ]);
        expect(warned.limitState?.reportedSpend?.amountMinor).toBe(850);
        expect(warned.limitState?.reportedSpend?.estimatedCostAttempts).toBe(1);
        // Later sweeps do not repeat a recorded warning.
        await f.controller.sweepObjectiveLimits(true);
        expect((await f.reload()).limitState?.budgetWarnings).toEqual(
          warned.limitState?.budgetWarnings,
        );
        const inbox = await f.store.readCoordinationInbox({
          objectiveId: f.objective.id,
          kind: "objective_limit",
        });
        expect(inbox.items.map((item) => item.key)).toEqual([
          `objective_limit:${f.objective.id}:budget-threshold-0.8-1000`,
        ]);
        expect(await f.attention()).toContain("objective_budget_threshold");
        await f.store.settleTaskAssignment({
          taskId: "second",
          leaseOwner: "test",
          attemptCount: second.claim.attemptCount,
          terminalAttempt: { id: second.attempt.id, status: "completed" },
          result: {},
        });
        // An executed Task Attempt without cost counts as unknown, not zero.
        await f.admit("third");
        const third = await f.run("third");
        await f.usage("third", third.attempt.id);
        await f.fail("third", third);
        await f.controller.sweepObjectiveLimits(true);
        expect((await f.reload()).limitState?.reportedSpend?.unknownAttemptIds).toEqual([
          third.attempt.id,
        ]);
        expect(await f.attention()).toContain("budget_coverage_incomplete");
      });

      it("stops a spent monetary budget: lets running work finish and refuses admission until raised", async () => {
        const f = await fixture({ budgetLimitMinor: 500, budgetCurrency: "USD" });
        await f.admit("first", true);
        await f.admit("queued");
        const first = await f.run("first");
        await f.usage("first", first.attempt.id, { amountMinor: 700, currency: "USD" });
        await f.controller.sweepObjectiveLimits(true);
        expect((await f.reload()).limitState?.budgetExhausted).toMatchObject({
          limitMinor: 500,
          spentMinor: 700,
        });
        expect((await f.store.getTaskAssignment("first"))?.status).toBe("running");
        expect((await f.store.listTaskEvents("first")).map((event) => event.type)).not.toContain(
          "objective.budget-stop",
        );
        await expect(f.admit("later")).rejects.toThrow("Objective budget exhausted");
        expect(await f.store.claimTaskAssignment({ taskId: "queued", leaseOwner: "x" })).toBe(
          undefined,
        );
        expect(await f.attention()).toContain("objective_budget_exhausted");
        await f.operator({ budgetLimitMinor: 5000 });
        await expect(f.admit("later")).resolves.toMatchObject({ status: "queued" });
      });

      it("keeps a budget without a currency as an allocation limit only", async () => {
        const f = await fixture({ budgetLimitMinor: 500 });
        await f.admit("first", true);
        const first = await f.run("first");
        await f.usage("first", first.attempt.id, { amountMinor: 9000, currency: "USD" });
        await f.controller.sweepObjectiveLimits(true);
        expect((await f.reload()).limitState).toEqual({});
        expect((await f.store.getTaskAssignment("first"))?.status).toBe("running");
        await expect(f.admit("later")).resolves.toMatchObject({ status: "queued" });
      });

      it("refuses new work after the deadline and lets the owner complete during the grace period", async () => {
        const f = await fixture({ deadline: minutesFromNow(60) });
        await f.admit("owner", true);
        const { claim } = await f.run("owner");
        await f.admit("queued");
        await f.operator({ deadline: minutesFromNow(-1) });
        await expect(f.admit("later")).rejects.toThrow("past its deadline");
        expect(await f.store.claimTaskAssignment({ taskId: "queued", leaseOwner: "x" })).toBe(
          undefined,
        );
        await f.controller.sweepObjectiveLimits(true);
        expect((await f.reload()).limitState?.deadlinePassed).toBeDefined();
        expect(await f.attention()).toContain("deadline_passed");
        await f.store.cancelTaskAssignment("queued", f.owner.id);
        const complete = async () =>
          f.store.updateObjectiveStatus(
            f.objective.id,
            {
              status: "completed",
              completionSummary: "Released with evidence",
              expectedRevision: (await f.reload()).revision,
            },
            f.owner.id,
            { taskId: "owner", attemptCount: claim.attemptCount, leaseOwner: "test" },
          );
        // Past the grace period, running authority is gone.
        await f.operator({ deadline: minutesFromNow(-20) });
        await expect(complete()).rejects.toThrow("Completion execution authority revoked");
        await f.operator({ deadline: minutesFromNow(-1) });
        await expect(complete()).resolves.toMatchObject({ status: "completed" });
      });

      it("resumes owner continuation when an operator extends a passed deadline", async () => {
        const f = await fixture({ deadline: minutesFromNow(60) });
        await f.admit("owner", true);
        const run = await f.run("owner");
        await f.fail("owner", run);
        expect((await f.store.listStalledObjectiveOwnerTasks()).map((task) => task.taskId)).toEqual(
          ["owner"],
        );
        await f.operator({ deadline: minutesFromNow(-5) });
        expect(await f.store.listStalledObjectiveOwnerTasks()).toEqual([]);
        await f.operator({ deadline: minutesFromNow(90) });
        expect((await f.store.listStalledObjectiveOwnerTasks()).map((task) => task.taskId)).toEqual(
          ["owner"],
        );
        await expect(f.admit("after-extension")).resolves.toMatchObject({ status: "queued" });
      });

      it("skips deadline warnings whose time had passed when the deadline was set", async () => {
        const f = await fixture({ deadline: minutesFromNow(45) });
        await f.admit("owner", true);
        await f.controller.sweepObjectiveLimits(true);
        expect((await f.reload()).limitState?.deadlineWarnings).toBeUndefined();
      });

      describe("with a fake clock", () => {
        const start = Date.parse("2031-03-01T10:00:00.000Z");
        const clock = (minutes: number) => vi.setSystemTime(start + minutes * 60_000);
        const iso = (minutes: number) => new Date(start + minutes * 60_000).toISOString();
        afterEach(() => vi.useRealTimers());
        const notices = async (f: Awaited<ReturnType<typeof fixture>>) =>
          (await f.store.listTagMessages(f.owner.id, 100))
            .filter((message) => message.objectiveId === f.objective.id)
            .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
            .map((message) => ({
              status: message.status,
              operatorId: message.operatorId,
              ...(message.body as { kind: string; message: string }),
            }));

        it("tells the owner when 15 minutes of a 60-minute deadline remain, once", async () => {
          vi.useFakeTimers({ toFake: ["Date"] });
          clock(0);
          const f = await fixture({ deadline: iso(60) });
          await f.admit("owner", true);
          clock(44);
          await f.controller.sweepObjectiveLimits(true);
          expect(await notices(f)).toEqual([]);
          clock(45);
          await f.controller.sweepObjectiveLimits(true);
          await f.controller.sweepObjectiveLimits(true);
          expect((await f.reload()).limitState?.deadlineWarnings).toMatchObject([
            { minutesBefore: 15 },
          ]);
          expect(await notices(f)).toEqual([
            {
              status: "processed",
              operatorId: "supertag:objective-limits",
              kind: "objective_deadline_approaching",
              deadline: iso(60),
              message: `The Objective deadline ${iso(60)} is near: about 15 minutes left.`,
            },
          ]);
        });

        it("wakes a waiting owner and attaches the warning to a running owner's next tool result", async () => {
          vi.useFakeTimers({ toFake: ["Date"] });
          clock(0);
          const f = await fixture({ deadline: iso(60) });
          await f.admit("owner", true);
          clock(41);
          // Coordination calls accept only leases held by this controller instance.
          const leaseOwner = (f.controller as unknown as { instanceId: string }).instanceId;
          const owner = await f.run("owner", leaseOwner);
          clock(45);
          await f.controller.sweepObjectiveLimits(true);
          const read = (await f.controller.commandAsAttempt("read_objective", {}, owner.claim)) as {
            deadlineNotices?: unknown;
            limits: { deadline: Record<string, unknown> };
          };
          expect(read.deadlineNotices).toMatchObject([
            {
              kind: "objective_deadline_approaching",
              message: expect.stringContaining("about 15 minutes left"),
            },
          ]);
          expect(read.limits.deadline).toMatchObject({
            remaining: "about 15 minutes left",
            graceMinutes: 15,
          });
          const again = (await f.controller.commandAsAttempt(
            "read_objective",
            {},
            owner.claim,
          )) as {
            deadlineNotices?: unknown;
          };
          expect(again.deadlineNotices).toBeUndefined();
          // A wait that began after the warning is not woken by it; a later move wakes it.
          clock(45.5);
          await f.store.registerTaskAssignmentWait({
            taskId: "owner",
            leaseOwner,
            attemptCount: owner.claim.attemptCount,
            notBefore: iso(120),
          });
          await f.store.settleTaskAssignment({
            taskId: "owner",
            leaseOwner,
            attemptCount: owner.claim.attemptCount,
            result: {},
          });
          expect((await f.store.getTaskAssignment("owner"))?.status).toBe("waiting");
          expect(await f.store.wakeWaitingTaskAssignments()).toEqual([]);
          clock(46);
          await f.operator({ deadline: iso(90) });
          const woken = await f.store.wakeWaitingTaskAssignments();
          expect(woken.map((task) => [task.taskId, task.waitState?.wake?.reason])).toEqual([
            ["owner", "deadline"],
          ]);
        });

        it("tells the owner the new deadline once when it moves, and recomputes warnings", async () => {
          vi.useFakeTimers({ toFake: ["Date"] });
          clock(0);
          const f = await fixture({ deadline: iso(60) });
          await f.admit("owner", true);
          clock(45);
          await f.controller.sweepObjectiveLimits(true);
          clock(46);
          await f.operator({ deadline: iso(85) });
          await f.operator({ deadline: iso(85) });
          await f.controller.sweepObjectiveLimits(true);
          // The new 39-minute window drops the old warning; its quarter rounds to 10 minutes.
          expect((await f.reload()).limitState?.deadlineWarnings).toBeUndefined();
          const moved = (await notices(f)).filter((n) => n.kind === "objective_deadline_set");
          expect(moved).toEqual([
            {
              status: "processed",
              operatorId: "test-operator",
              kind: "objective_deadline_set",
              deadline: iso(85),
              message: `An operator moved the Objective deadline from ${iso(60)} to ${iso(85)}: about 39 minutes left. Deadline warnings now follow this deadline. Plan the remaining work to finish before it.`,
            },
          ]);
          clock(74);
          await f.controller.sweepObjectiveLimits(true);
          expect((await f.reload()).limitState?.deadlineWarnings).toBeUndefined();
          clock(75);
          await f.controller.sweepObjectiveLimits(true);
          expect((await f.reload()).limitState?.deadlineWarnings).toMatchObject([
            { minutesBefore: 10, deadline: iso(85) },
          ]);
          expect((await notices(f)).map((n) => n.message)).toEqual([
            `The Objective deadline ${iso(60)} is near: about 15 minutes left.`,
            expect.stringContaining(`to ${iso(85)}: about 39 minutes left`),
            `The Objective deadline ${iso(85)} is near: about 10 minutes left.`,
          ]);
        });

        it("caps the grace for a 20-minute deadline at 5 minutes", async () => {
          vi.useFakeTimers({ toFake: ["Date"] });
          clock(0);
          const f = await fixture({ deadline: iso(20) });
          await f.admit("owner", true);
          clock(19);
          const { claim } = await f.run("owner");
          const complete = async () =>
            f.store.updateObjectiveStatus(
              f.objective.id,
              {
                status: "completed",
                completionSummary: "Released with evidence",
                expectedRevision: (await f.reload()).revision,
              },
              f.owner.id,
              { taskId: "owner", attemptCount: claim.attemptCount, leaseOwner: "test" },
            );
          clock(23);
          await f.store.renewTaskAssignment({
            taskId: "owner",
            leaseOwner: "test",
            attemptCount: claim.attemptCount,
            leaseSeconds: 300,
          });
          // Under a fixed 15-minute grace this would still be allowed.
          clock(25);
          await expect(complete()).rejects.toThrow("Completion execution authority revoked");
          clock(24);
          await expect(complete()).resolves.toMatchObject({ status: "completed" });
        });
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

describe("Objective limits during execution", () => {
  const cleanups: Array<() => Promise<unknown> | unknown> = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });
  async function fixture(
    definition: Record<string, unknown>,
    cost: number,
    options: { deadlineGraceMs?: number } = {},
  ) {
    const directory = await mkdtemp(join(tmpdir(), "supertag-limits-run-"));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const url = `file:${join(directory, "state.db")}`;
    await migrateDatabase({ url });
    const store = new DrizzleStore({ url });
    await store.connect();
    cleanups.push(() => store.disconnect());
    const owner = await store.createTag({ name: `owner-${randomUUID()}` });
    await store.bindTagWorkerHost(owner.id, "fixture");
    const objective = await store.createObjective({
      id: randomUUID(),
      ownerTagId: owner.id,
      outcome: "Resolve the backlog",
      ...definition,
    });
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const seen = { started: 0, aborted: 0, completed: 0 };
    const worker: Worker = {
      async describe() {
        return {
          profileCapabilities: [
            {
              profile: { id: "default", revision: "1" },
              capabilities: [{ id: "supertag.coordination", version: 1 }],
              contextTypes: [],
            },
          ],
          id: "fixture-worker",
          type: "test",
          profiles: [{ id: "default", revision: "1" }],
          capabilities: [{ id: "supertag.coordination", version: 1 }],
          contextTypes: [],
          maxConcurrency: 1,
        };
      },
      async *execute(spec, signal) {
        const identity = { taskId: spec.taskId, attemptId: spec.attemptId };
        const at = () => new Date().toISOString();
        seen.started++;
        yield { ...identity, type: "execution.started", at: at(), workerId: "fixture-worker" };
        yield {
          ...identity,
          type: "usage.updated",
          at: at(),
          usage: {
            inputTokens: 10,
            outputTokens: 10,
            cachedInputTokens: 0,
            totalTokens: 20,
            complete: false,
            reportedCost: { amountMinor: cost, currency: "USD" },
          },
        };
        await new Promise<void>((resolve) => {
          void released.then(resolve);
          signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        if (signal?.aborted) {
          seen.aborted++;
          throw signal.reason;
        }
        seen.completed++;
        yield {
          ...identity,
          type: "output.message",
          at: at(),
          message: { role: "teammate", text: "Finished." },
        };
        yield { ...identity, type: "execution.completed", at: at() };
      },
    };
    const controller = new ObjectiveController(
      store,
      durableTestWorklet(new LocalWorklet("fixture", "fixture", [worker])),
      () => {},
      undefined,
      { limitSweepIntervalMs: 0, ...options },
    );
    controller.activateCoordination({ url: "http://fixture.invalid" });
    cleanups.push(() => controller.stop());
    cleanups.push(() => release());
    const start = () => store.getTaskAssignment(`${objective.id}:start`);
    const assign = () =>
      controller.commandAsAdministrator("assign_task", {
        objectiveId: objective.id,
        taskId: randomUUID(),
        teamId: `${objective.id}:leadership`,
        assignedTagId: owner.id,
        instruction: "More work",
        acceptanceCriteria: ["Done"],
      });
    return { store, controller, objective, seen, release, start, assign };
  }

  it("lets a running Task Attempt finish when provider-reported spend reaches the budget", async () => {
    const f = await fixture({ budgetLimitMinor: 500, budgetCurrency: "USD" }, 700);
    await f.controller.command("start_objective", { objectiveId: f.objective.id });
    f.controller.start();
    await expect
      .poll(async () => (await f.store.getObjective(f.objective.id)).limitState?.budgetExhausted, {
        timeout: 20000,
      })
      .toMatchObject({ spentMinor: 700 });
    await expect(f.assign()).rejects.toThrow("Objective budget exhausted");
    // The running Attempt overruns the budget instead of being cancelled.
    expect((await f.start())?.status).toBe("running");
    expect(f.seen.aborted).toBe(0);
    f.release();
    await expect.poll(() => f.seen.completed, { timeout: 20000 }).toBe(1);
    expect(f.seen.aborted).toBe(0);
    // Once nothing is running, the spent Objective becomes limited instead of continuing.
    await expect
      .poll(async () => (await f.store.getObjective(f.objective.id)).status, { timeout: 20000 })
      .toBe("limited");
    // The owner records its limit summary, even on a harness that enforces no token limit.
    await expect
      .poll(
        async () => {
          await f.controller.sweepObjectiveLimits(true);
          return (await f.store.getObjective(f.objective.id)).limitState?.summary;
        },
        { timeout: 20000 },
      )
      .toBeDefined();
    // Raising the budget resumes the owner from that summary.
    const startedBeforeRaise = f.seen.started;
    const limited = await f.store.getObjective(f.objective.id);
    await f.store.updateObjectiveStatus(
      f.objective.id,
      { budgetLimitMinor: 5000, expectedRevision: limited.revision },
      undefined,
      undefined,
      { operatorId: "test" },
    );
    await expect
      .poll(async () => (await f.store.getObjective(f.objective.id)).status, { timeout: 20000 })
      .toBe("working");
    await expect.poll(() => f.seen.started, { timeout: 20000 }).toBeGreaterThan(startedBeforeRaise);
  }, 60000);

  it("lets a running Task Attempt finish during the deadline grace period", async () => {
    const f = await fixture({ deadline: new Date(Date.now() + 2000).toISOString() }, 0, {
      deadlineGraceMs: 60_000,
    });
    await f.controller.command("start_objective", { objectiveId: f.objective.id });
    f.controller.start();
    await expect.poll(() => f.seen.started, { timeout: 20000 }).toBe(1);
    // Past the deadline and at least one lease renewal.
    await new Promise((resolve) => setTimeout(resolve, 7000));
    expect(f.seen.aborted).toBe(0);
    await expect(f.assign()).rejects.toThrow("past its deadline");
    f.release();
    await expect.poll(async () => (await f.start())?.status, { timeout: 20000 }).toBe("accepted");
    expect(f.seen).toMatchObject({ started: 1, aborted: 0, completed: 1 });
  }, 60000);

  it("revokes a running Task Attempt's authority when the grace period ends", async () => {
    const f = await fixture({ deadline: new Date(Date.now() + 1000).toISOString() }, 0, {
      deadlineGraceMs: 1000,
    });
    await f.controller.command("start_objective", { objectiveId: f.objective.id });
    f.controller.start();
    await expect.poll(() => f.seen.started, { timeout: 20000 }).toBe(1);
    await expect.poll(() => f.seen.aborted, { timeout: 20000 }).toBe(1);
    expect(f.seen.completed).toBe(0);
  }, 60000);

  it("stops a running Task Attempt when a moved deadline's grace period has already ended", async () => {
    const f = await fixture({ deadline: new Date(Date.now() + 2 * 3_600_000).toISOString() }, 0);
    await f.controller.command("start_objective", { objectiveId: f.objective.id });
    f.controller.start();
    await expect.poll(() => f.seen.started, { timeout: 20000 }).toBe(1);
    const objective = await f.store.getObjective(f.objective.id);
    // The default 15-minute grace ended five minutes before the new deadline was recorded.
    await f.store.updateObjectiveStatus(
      f.objective.id,
      {
        deadline: new Date(Date.now() - 20 * 60_000).toISOString(),
        expectedRevision: objective.revision,
      },
      undefined,
      undefined,
      { operatorId: "test" },
    );
    await expect.poll(() => f.seen.aborted, { timeout: 20000 }).toBe(1);
    expect(f.seen.completed).toBe(0);
    await expect
      .poll(async () => (await f.start())?.status, { timeout: 20000 })
      .not.toBe("running");
  }, 60000);

  it("keeps a running Task Attempt when the deadline moves later before its grace period ends", async () => {
    const f = await fixture({ deadline: new Date(Date.now() + 1000).toISOString() }, 0, {
      deadlineGraceMs: 2000,
    });
    await f.controller.command("start_objective", { objectiveId: f.objective.id });
    f.controller.start();
    await expect.poll(() => f.seen.started, { timeout: 20000 }).toBe(1);
    const objective = await f.store.getObjective(f.objective.id);
    await f.store.updateObjectiveStatus(
      f.objective.id,
      {
        deadline: new Date(Date.now() + 3_600_000).toISOString(),
        expectedRevision: objective.revision,
      },
      undefined,
      undefined,
      { operatorId: "test" },
    );
    // Past the original grace end and at least one authority check.
    await new Promise((resolve) => setTimeout(resolve, 7000));
    expect(f.seen.aborted).toBe(0);
    f.release();
    await expect.poll(async () => (await f.start())?.status, { timeout: 20000 }).toBe("accepted");
  }, 60000);
});
