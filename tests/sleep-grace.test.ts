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

/**
 * Surface Attempts are the only leases a suspend affects now: `renewInboundEventLease` renews a
 * processing turn's lease without an expiry check, so after a reported wake the Control Plane's
 * own Attempts keep their coordination authority for the grace, and nobody else's do.
 */
describe("Surface lease grace after a suspend", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps this Control Plane's own Surface leases current after a reported wake", async () => {
    let wake: { sleptAt: number; wokeAt: number } | undefined;
    const controller = new ObjectiveController({} as never, undefined, () => {}, {
      systemWake: async () => wake,
      surfaceLeaseOwner: "surface-cp",
      surfaceAttemptsRunning: () => true,
    });
    const start = Date.now();
    vi.useFakeTimers({ toFake: ["Date"], now: start });
    const surfaceLease = { leaseOwner: "surface-cp", leaseExpiresAt: iso(start + 30_000) };
    expect(controller.surfaceLeaseCurrent(surfaceLease)).toBe(true);

    // The host sleeps 10 seconds in, after a stall, and wakes 20 minutes later. The sweep that
    // polls the wake runs before the clock is observed again.
    const woke = start + 20 * 60_000;
    wake = { sleptAt: start + 10_000, wokeAt: woke };
    vi.setSystemTime(woke + 1_000);
    await controller.pollSystemWake();

    expect(controller.surfaceLeaseCurrent(surfaceLease)).toBe(true);
    // Only this Control Plane's own Surface leases, valid when the host slept, get the grace.
    expect(controller.surfaceLeaseCurrent({ ...surfaceLease, leaseOwner: "other" })).toBe(false);
    expect(
      controller.surfaceLeaseCurrent({ ...surfaceLease, leaseExpiresAt: iso(start + 5_000) }),
    ).toBe(false);
    // A lease with no owner or no expiry is never current.
    expect(controller.surfaceLeaseCurrent({ leaseOwner: null, leaseExpiresAt: null })).toBe(false);

    // The grace ends while the Control Plane keeps sweeping, so no later gap counts as a suspend.
    for (let at = woke + 5_000; at <= woke + RESUME_GRACE_MS + 5_000; at += 5_000) {
      vi.setSystemTime(at);
      controller.suspend.observe();
    }
    expect(controller.surfaceLeaseCurrent(surfaceLease)).toBe(false);
  });

  it("polls the host's wake at most every ten seconds, and only while Attempts run", async () => {
    let reads = 0;
    let running = true;
    const controller = new ObjectiveController({} as never, undefined, () => {}, {
      systemWake: async () => {
        reads += 1;
        return undefined;
      },
      surfaceLeaseOwner: "surface-cp",
      surfaceAttemptsRunning: () => running,
    });
    const start = Date.now();
    vi.useFakeTimers({ toFake: ["Date"], now: start });
    await controller.pollSystemWake();
    await controller.pollSystemWake();
    expect(reads).toBe(1);
    vi.setSystemTime(start + 10_001);
    await controller.pollSystemWake();
    expect(reads).toBe(2);
    running = false;
    vi.setSystemTime(start + 30_000);
    await controller.pollSystemWake();
    expect(reads).toBe(2);
  });
});

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
