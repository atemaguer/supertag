import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  laptopPowerWarning,
  parseDarwinPower,
  parseLinuxPower,
  readLaptopPower,
} from "../apps/cli/src/power.ts";
import { formatRows } from "../apps/cli/src/ps.ts";
import { ObjectiveController } from "../packages/control-plane/src/objective-controller.js";
import {
  parseDarwinWake,
  RESUME_GRACE_MS,
  SUSPEND_GAP_MS,
  SuspendDetector,
} from "../packages/control-plane/src/suspend-detector.js";
import { emptyTagContextPlan } from "../packages/core/src/index.js";
import { DrizzleStore, migrateDatabase } from "../packages/store/src/index.js";
import { createIsolatedPostgresDatabase } from "./support/database.js";

const t0 = Date.parse("2026-10-02T20:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

describe("suspend detection", () => {
  it("ignores ordinary ticks and starts a grace after a wall-clock jump", () => {
    const resumes: unknown[] = [];
    const detector = new SuspendDetector((resume) => resumes.push(resume));
    detector.observe(t0);
    detector.observe(t0 + 200);
    detector.observe(t0 + 5_200);
    expect(detector.renewableSince(t0 + 5_200)).toBeUndefined();
    expect(resumes).toEqual([]);

    const woke = t0 + 5_200 + 40 * 60_000;
    detector.observe(woke);
    expect(resumes).toEqual([{ suspendedAt: t0 + 5_200, resumedAt: woke, source: "clock-jump" }]);
    expect(detector.renewableSince(woke + 1_000)).toBe(iso(t0 + 5_200));
    expect(detector.renewableSince(woke + RESUME_GRACE_MS + 1)).toBeUndefined();
  });

  it("does not treat a gap up to the threshold as a suspend", () => {
    const detector = new SuspendDetector();
    detector.observe(t0);
    detector.observe(t0 + SUSPEND_GAP_MS);
    expect(detector.renewableSince(t0 + SUSPEND_GAP_MS)).toBeUndefined();
  });

  it("keeps a lease current during the grace only if it was valid when the suspend began", () => {
    const detector = new SuspendDetector();
    detector.observe(t0);
    const woke = t0 + 30 * 60_000;
    detector.observe(woke);
    // Expired during the sleep: still renewable.
    expect(detector.leaseCurrent(iso(t0 + 20_000), woke + 1_000)).toBe(true);
    // Already expired before the sleep: not renewable.
    expect(detector.leaseCurrent(iso(t0 - 1), woke + 1_000)).toBe(false);
    expect(detector.leaseCurrent(iso(t0 + 20_000), woke + RESUME_GRACE_MS + 1)).toBe(false);
    expect(detector.leaseCurrent(undefined, woke)).toBe(false);
  });

  it("starts a grace from a system wake the host reports", () => {
    const resumes: unknown[] = [];
    const detector = new SuspendDetector((resume) => resumes.push(resume));
    // An old wake only sets the baseline.
    detector.systemWake({ sleptAt: t0 - 7_200_000, wokeAt: t0 - 3_600_000 }, t0);
    expect(detector.renewableSince(t0)).toBeUndefined();
    detector.systemWake({ sleptAt: t0 - 7_200_000, wokeAt: t0 - 3_600_000 }, t0 + 1_000);
    expect(resumes).toEqual([]);

    detector.systemWake({ sleptAt: t0 + 10_000, wokeAt: t0 + 600_000 }, t0 + 605_000);
    expect(resumes).toEqual([
      { suspendedAt: t0 + 10_000, resumedAt: t0 + 600_000, source: "system-wake" },
    ]);
    expect(detector.renewableSince(t0 + 605_000)).toBe(iso(t0 + 10_000));
  });

  it("counts a clock jump and a wake report of one suspend once", () => {
    const resumes: unknown[] = [];
    const detector = new SuspendDetector((resume) => resumes.push(resume));
    detector.observe(t0);
    detector.observe(t0 + 600_000);
    detector.systemWake({ sleptAt: t0 + 1_000, wokeAt: t0 + 599_000 }, t0 + 601_000);
    expect(resumes).toHaveLength(1);
    expect(detector.renewableSince(t0 + 601_000)).toBe(iso(t0 + 1_000));
  });

  it("starts one suspend at the reported sleep time, not at an earlier stall", () => {
    // The process last ran at t0, stalled, and the host slept 10 seconds later. A lease that
    // expired during the stall, before the sleep, stays expired whichever report arrives first.
    for (const wakeFirst of [false, true]) {
      const detector = new SuspendDetector();
      detector.observe(t0);
      const wake = { sleptAt: t0 + 10_000, wokeAt: t0 + 599_000 };
      if (wakeFirst) detector.systemWake(wake, t0 + 600_000);
      detector.observe(t0 + 600_000);
      if (!wakeFirst) detector.systemWake(wake, t0 + 600_000);
      expect(detector.renewableSince(t0 + 600_000)).toBe(iso(t0 + 10_000));
      expect(detector.leaseCurrent(iso(t0 + 5_000), t0 + 600_000)).toBe(false);
      expect(detector.leaseCurrent(iso(t0 + 20_000), t0 + 600_000)).toBe(true);
    }
  });

  it("keeps the clock estimate when the wake report has no sleep time", () => {
    const detector = new SuspendDetector();
    detector.observe(t0);
    detector.observe(t0 + 600_000);
    detector.systemWake({ wokeAt: t0 + 599_000 }, t0 + 600_000);
    expect(detector.renewableSince(t0 + 600_000)).toBe(iso(t0));
  });

  it("parses macOS kern.sleeptime and kern.waketime", () => {
    expect(
      parseDarwinWake(
        "{ sec = 1790985324, usec = 656032 } Fri Oct  2 16:55:24 2026\n{ sec = 1790985539, usec = 715260 } Fri Oct  2 16:58:59 2026\n",
      ),
    ).toEqual({ sleptAt: 1790985324656, wokeAt: 1790985539715 });
    expect(parseDarwinWake("{ sec = 0, usec = 0 }\n{ sec = 0, usec = 0 }\n")).toBeUndefined();
    expect(parseDarwinWake("")).toBeUndefined();
  });
});

const postgres = process.env["SUPERTAG_POSTGRES_URL"];

/** The controller's lease identity and renewal input, read through an internal test seam. */
const internals = (controller: ObjectiveController) =>
  controller as unknown as {
    readonly instanceId: string;
    renewableSince(): { renewableSince?: string };
  };

for (const dialect of ["sqlite", "postgresql"] as const) {
  describe.skipIf(dialect === "postgresql" && !postgres)(
    `${dialect} lease renewal after a suspend`,
    { timeout: 30_000 },
    () => {
      const cleanups: Array<() => Promise<unknown> | unknown> = [];
      afterEach(async () => {
        vi.useRealTimers();
        for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
      });

      async function runningTask(
        leaseOwnerFor: (store: DrizzleStore) => string = () => "cp",
        workerSnapshot: Record<string, unknown> = {},
      ) {
        const directory = await mkdtemp(join(tmpdir(), "supertag-sleep-grace-"));
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
        });
        const team = await store.createTeam({
          id: `${objective.id}:leadership`,
          objectiveId: objective.id,
          name: "Leadership",
          leadTagId: owner.id,
          memberTagIds: [owner.id],
          maxConcurrency: 4,
        });
        const at = new Date().toISOString();
        await store.admitTaskAssignment({
          taskId: "owner",
          objectiveId: objective.id,
          teamId: team.id,
          requestedByTagId: owner.id,
          assignedTagId: owner.id,
          instruction: "Produce owner",
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
          startObjectiveExecution: true,
        });
        const claim = await store.claimTaskAssignment({
          taskId: "owner",
          leaseOwner: leaseOwnerFor(store),
          leaseSeconds: 30,
        });
        if (!claim) throw new Error("Could not claim owner");
        await store.createTaskAttempt({
          taskId: "owner",
          attemptNumber: claim.attemptCount,
          workerProfile: { id: "fixture", revision: "1" },
          workerSnapshot,
          startedAt: new Date().toISOString(),
        });
        await store.startTask({ taskId: "owner", startedAt: new Date().toISOString() });
        return { store, claim };
      }

      it("renews a lease that expired during the suspend, and only that one", async () => {
        const { store, claim } = await runningTask();
        const suspendedAt = new Date(Date.now() + 1_000).toISOString();
        vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 20 * 60_000 });
        const renew = (renewableSince?: string) =>
          store.renewTaskAssignment({
            taskId: "owner",
            leaseOwner: "cp",
            attemptCount: claim.attemptCount,
            leaseSeconds: 30,
            ...(renewableSince === undefined ? {} : { renewableSince }),
          });
        await expect(renew()).rejects.toThrow("Stale execution lease");
        // A lease that had already expired when the suspend began stays revoked.
        await expect(renew(new Date(Date.now() - 19 * 60_000).toISOString())).rejects.toThrow(
          "Stale execution lease",
        );
        const renewed = await renew(suspendedAt);
        expect(renewed.status).toBe("running");
        expect(Date.parse(renewed.leaseExpiresAt ?? "")).toBeGreaterThan(Date.now());
        // Another lease owner cannot use the grace.
        await expect(
          store.renewTaskAssignment({
            taskId: "owner",
            leaseOwner: "other",
            attemptCount: claim.attemptCount,
            renewableSince: suspendedAt,
          }),
        ).rejects.toThrow("Stale execution lease");
      });

      it("lets the controller renew Task and Surface leases after a reported wake", async () => {
        let wake: { sleptAt: number; wokeAt: number } | undefined;
        let controller: ObjectiveController | undefined;
        // The controller's own instance owns the Task lease, as when it dispatched the Attempt.
        const { store, claim } = await runningTask((store) => {
          controller = new ObjectiveController(store, undefined, () => {}, undefined, {
            systemWake: async () => wake,
            surfaceLeaseOwner: "surface-cp",
            surfaceAttemptsRunning: () => true,
          });
          return internals(controller).instanceId;
        });
        if (!controller) throw new Error("Controller was not created");
        const start = Date.now();
        vi.useFakeTimers({ toFake: ["Date"], now: start });
        const surfaceLease = { leaseOwner: "surface-cp", leaseExpiresAt: iso(start + 30_000) };
        expect(controller.surfaceLeaseCurrent(surfaceLease)).toBe(true);

        // The host sleeps 10 seconds in, after a stall, and wakes 20 minutes later. The tick
        // that polls the wake runs before the clock is observed again.
        const woke = start + 20 * 60_000;
        wake = { sleptAt: start + 10_000, wokeAt: woke };
        vi.setSystemTime(woke + 1_000);
        await controller.pollSystemWake();

        expect(controller.surfaceLeaseCurrent(surfaceLease)).toBe(true);
        // Only this Control Plane's own Surface leases, valid when the host slept, get the grace.
        expect(controller.surfaceLeaseCurrent({ ...surfaceLease, leaseOwner: "other" })).toBe(
          false,
        );
        expect(
          controller.surfaceLeaseCurrent({ ...surfaceLease, leaseExpiresAt: iso(start + 5_000) }),
        ).toBe(false);

        const renewableSince = internals(controller).renewableSince();
        expect(renewableSince).toEqual({ renewableSince: iso(start + 10_000) });
        const renewed = await store.renewTaskAssignment({
          taskId: "owner",
          leaseOwner: internals(controller).instanceId,
          attemptCount: claim.attemptCount,
          leaseSeconds: 30,
          ...renewableSince,
        });
        expect(Date.parse(renewed.leaseExpiresAt ?? "")).toBeGreaterThan(Date.now());

        // The grace ends while the controller keeps ticking, so no further gap counts as a suspend.
        for (let at = woke + 5_000; at <= woke + RESUME_GRACE_MS + 5_000; at += 5_000) {
          vi.setSystemTime(at);
          controller.suspend.observe();
        }
        expect(controller.surfaceLeaseCurrent(surfaceLease)).toBe(false);
      });

      it("recovers a durable Attempt whose own observer ended, even during a grace", async () => {
        const inspect = vi.fn(async () => undefined);
        let controller: ObjectiveController | undefined;
        const { store, claim } = await runningTask(
          (store) => {
            controller = new ObjectiveController(store, { inspect } as never, () => {});
            return internals(controller).instanceId;
          },
          { durableExecution: true },
        );
        if (!controller) throw new Error("Controller was not created");
        const [attempt] = await store.listTaskAttempts("owner");
        if (!attempt) throw new Error("Attempt was not created");
        controller.activateCoordination({ url: "http://127.0.0.1:1" });
        const seam = controller as unknown as { running: boolean; tick(): Promise<void> };
        seam.running = true;
        cleanups.push(() => controller?.stop());
        // The clock jumps past the lease, as after a settlement failure ended this controller's
        // observer: the jump starts a grace, but nothing is left to renew the lease.
        const start = Date.now();
        vi.useFakeTimers({ toFake: ["Date"], now: start });
        controller.suspend.observe();
        vi.setSystemTime(start + 31_000);
        expect(Date.parse(claim.leaseExpiresAt ?? "")).toBeLessThan(Date.now());
        await seam.tick();
        expect(internals(controller).renewableSince()).not.toEqual({});
        // Recovery asks the host about the Attempt instead of waiting out the grace.
        expect(inspect).toHaveBeenCalledWith(attempt.id);
      });
    },
  );
}

describe("laptop power warning in supertag ps", () => {
  const macBattery = (source: string) =>
    `Now drawing from '${source}'\n -InternalBattery-0 (id=35848291)\t80%; discharging; 3:10 remaining present: true\n`;

  it("reads macOS battery and lid sleep from pmset", () => {
    expect(parseDarwinPower(macBattery("Battery Power"), " sleep 1\n")).toEqual({
      onBattery: true,
      lidSleep: true,
    });
    expect(parseDarwinPower(macBattery("AC Power"), " SleepDisabled\t\t1\n sleep 0\n")).toEqual({
      onBattery: false,
      lidSleep: false,
    });
    // A desktop Mac has no internal battery.
    expect(parseDarwinPower("Now drawing from 'AC Power'\n", "")).toBeUndefined();
  });

  it("reads Linux power supplies and logind lid settings", () => {
    const battery = { type: "Battery\n" };
    expect(parseLinuxPower([battery, { type: "Mains", online: "0\n" }], "")).toEqual({
      onBattery: true,
      lidSleep: true,
    });
    expect(
      parseLinuxPower(
        [battery, { type: "Mains", online: "1\n" }],
        "[Login]\nHandleLidSwitch=suspend\nHandleLidSwitchExternalPower=ignore\n",
      ),
    ).toEqual({ onBattery: false, lidSleep: false });
    expect(parseLinuxPower([battery], "HandleLidSwitch=lock\n")).toEqual({
      onBattery: true,
      lidSleep: false,
    });
    expect(parseLinuxPower([{ type: "Mains", online: "1" }], "")).toBeUndefined();
  });

  it("reads through replaceable readers and fails quietly", async () => {
    await expect(
      readLaptopPower("darwin", {
        run: async (_command, args) => (args.length === 2 ? macBattery("Battery Power") : ""),
      }),
    ).resolves.toEqual({ onBattery: true, lidSleep: true });
    await expect(
      readLaptopPower("darwin", {
        run: async () => {
          throw new Error("pmset missing");
        },
      }),
    ).resolves.toBeUndefined();
    await expect(readLaptopPower("win32")).resolves.toBeUndefined();
  });

  it("names each risk and stays quiet when there is none", () => {
    expect(laptopPowerWarning({ onBattery: true, lidSleep: true })).toBe(
      "warning: Task Attempts are running, but the laptop is on battery power and closing the lid will sleep it. A long sleep can fail them; plug in and keep the lid open.",
    );
    expect(laptopPowerWarning({ onBattery: false, lidSleep: true })).toContain(
      "but closing the lid will sleep it.",
    );
    expect(laptopPowerWarning({ onBattery: false, lidSleep: false })).toBeUndefined();
    expect(laptopPowerWarning(undefined)).toBeUndefined();
  });

  it("prints the warning under the host row", () => {
    const text = formatRows([
      {
        service: "laptop",
        type: "host",
        state: "running",
        configured: true,
        workerHostId: "laptop",
        connected: true,
        attempts: 2,
        powerWarning: "warning: Task Attempts are running, but closing the lid will sleep it.",
      },
    ]);
    expect(text).toContain(
      "  Worker Host laptop; connected; Task Attempts running: 2\n  warning: Task Attempts are running, but closing the lid will sleep it.\n",
    );
  });
});
