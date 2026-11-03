import { emptyTagContextPlan } from "@supertag/core";
import { expect, it, vi } from "vitest";
import { repositoryAttempt } from "../../../tests/support/repository-execution.js";
import { WorkletPlacementReservations } from "./src/execution-selection.js";
import {
  collectTaskAttemptEvents,
  descriptorSupportsCoordination,
  descriptorSupportsExecution,
  descriptorSupportsRequiredContext,
  descriptorSupportsSurfaceCoordination,
  explainDescriptorExecutionIncompatibility,
  LocalWorklet,
  NATIVE_AGENT_LIMIT_CAPABILITY,
  profileAppliesEffort,
  profileDefaultModel,
  REPORTED_COST_LIMIT_CAPABILITY,
  REPORTED_TOKEN_LIMIT_CAPABILITY,
  selectDescriptorExecution,
  selectWorkletExecution,
  type WorkerDescriptor,
} from "./src/index.js";

const plan = emptyTagContextPlan();
const research = { id: "research", revision: "1" };
const coding = { id: "coding", revision: "2" };
const descriptor: WorkerDescriptor = {
  id: "worker",
  type: "test",
  maxConcurrency: 2,
  profiles: [research, coding],
  contextTypes: [],
  capabilities: [{ id: "write", version: 1 }],
  profileCapabilities: [
    {
      profile: research,
      harness: "opencode",
      contextTypes: [],
      capabilities: [{ id: "search", version: 1 }],
    },
    {
      profile: coding,
      harness: "codex",
      contextTypes: [],
      capabilities: [{ id: "write", version: 1 }],
    },
  ],
};

it("holds, expires, and consumes host-local placement reservations exactly once", () => {
  let now = Date.parse("2026-01-01T00:00:00.000Z");
  const reservations = new WorkletPlacementReservations(1_000, () => now);
  const reservation = reservations.reserve("worker", coding);
  expect(reservations.count("worker")).toBe(1);
  expect(reservations.consume(reservation, "worker", coding)).toBe("accepted");
  expect(reservations.consume(reservation, "worker", coding)).toBe("missing");

  const expired = reservations.reserve("worker", coding);
  now += 1_001;
  expect(reservations.consume(expired, "worker", coding)).toBe("expired");
  expect(reservations.count("worker")).toBe(0);

  const mismatched = reservations.reserve("worker", coding);
  expect(reservations.consume(mismatched, "other", coding)).toBe("mismatch");
  expect(reservations.count("worker")).toBe(0);

  const declined = reservations.reserve("worker", coding);
  reservations.release(declined);
  expect(reservations.count("worker")).toBe(0);
  expect(reservations.consume(declined, "worker", coding)).toBe("missing");
});
it("gives an owner activation the coordination slot when delegated work fills a Worker", () => {
  const single = { ...descriptor, maxConcurrency: 1 };
  // A builder fills the only ordinary slot: delegated work waits, an owner still starts.
  expect(
    selectDescriptorExecution([single], { profile: coding }, plan, {}, () => 1),
  ).toBeUndefined();
  expect(
    selectDescriptorExecution(
      [single],
      { profile: coding },
      plan,
      { coordinationSlot: true },
      () => 1,
    ),
  ).toEqual(coding);
  // The coordination slot is one slot, not an unlimited bypass.
  expect(
    selectDescriptorExecution(
      [single],
      { profile: coding },
      plan,
      { coordinationSlot: true },
      () => 2,
    ),
  ).toBeUndefined();
  // Delegated work uses every configured slot of a multi-slot Worker.
  const wide = { ...descriptor, maxConcurrency: 4 };
  expect(selectDescriptorExecution([wide], { profile: coding }, plan, {}, () => 3)).toEqual(coding);
  expect(selectDescriptorExecution([wide], { profile: coding }, plan, {}, () => 4)).toBeUndefined();
});
it("places and runs an owner activation on a single-slot Worker that a builder fills", async () => {
  let releaseBuilder!: () => void;
  const builderDone = new Promise<void>((resolve) => {
    releaseBuilder = resolve;
  });
  const started: string[] = [];
  const worklet = new LocalWorklet("worklet", "host", [
    {
      async describe() {
        return { ...descriptor, maxConcurrency: 1 };
      },
      async *execute(spec) {
        started.push(spec.taskId);
        yield {
          type: "execution.started",
          taskId: spec.taskId,
          attemptId: spec.attemptId,
          at: new Date().toISOString(),
          workerId: "worker",
        };
        if (spec.taskId === "builder") await builderDone;
      },
    },
  ]);
  const attempt = (
    taskId: string,
    placement: NonNullable<Parameters<typeof worklet.execute>[0]["placement"]>,
  ) =>
    collectTaskAttemptEvents(
      worklet.execute({ ...repositoryAttempt(taskId), workerProfile: coding, placement }),
    );
  const builderPlacement = await worklet.selectPlacement({ profile: coding }, plan);
  if (!builderPlacement) throw new Error("Builder placement missing");
  const builder = attempt("builder", {
    allowedWorkerHostIds: ["host"],
    workerHostId: "host",
    workletId: "worklet",
    workerId: builderPlacement.workerId,
    ...(builderPlacement.reservation ? { reservation: builderPlacement.reservation } : {}),
  });
  await vi.waitFor(() => expect(started).toEqual(["builder"]));
  // Delegated work finds no slot; the owner's activation takes the coordination slot.
  expect(await worklet.selectPlacement({ profile: coding }, plan)).toBeUndefined();
  const ownerPlacement = await worklet.selectPlacement({ profile: coding }, plan, {
    coordinationSlot: true,
  });
  if (!ownerPlacement) throw new Error("Owner placement missing");
  await attempt("owner", {
    allowedWorkerHostIds: ["host"],
    workerHostId: "host",
    workletId: "worklet",
    workerId: ownerPlacement.workerId,
    coordinationSlot: true,
    ...(ownerPlacement.reservation ? { reservation: ownerPlacement.reservation } : {}),
  });
  expect(started).toEqual(["builder", "owner"]);
  releaseBuilder();
  await builder;
});
it("selects profile-local requirements and never borrows another profile's claims", () => {
  expect(
    selectDescriptorExecution([descriptor], { requires: [{ id: "search", version: 1 }] }, plan),
  ).toEqual(research);
  expect(
    descriptorSupportsExecution(descriptor, research, { requires: [{ id: "write", version: 1 }] }),
  ).toBe(false);
  expect(
    selectDescriptorExecution([descriptor], { requires: [{ id: "search", version: 2 }] }, plan),
  ).toBeUndefined();
  expect(selectDescriptorExecution([descriptor], { harness: "codex" }, plan)).toEqual(coding);
  expect(
    selectDescriptorExecution([descriptor], { profile: research, harness: "codex" }, plan),
  ).toBeUndefined();
});
it("ranks preferences, filters busy Workers, and freezes continuation compatibility", () => {
  const other = { ...descriptor, id: "other" };
  expect(
    selectDescriptorExecution([descriptor], { prefers: [{ id: "search", version: 1 }] }, plan),
  ).toEqual(research);
  expect(selectDescriptorExecution([descriptor], {}, plan, {}, () => 2)).toBeUndefined();
  expect(
    selectDescriptorExecution([descriptor, other], {}, plan, {}, (id) => (id === "worker" ? 2 : 0)),
  ).toEqual(coding);
  expect(
    selectDescriptorExecution([descriptor], { harness: "codex" }, plan, {
      compatibleProfile: research,
    }),
  ).toBeUndefined();
});
it("rejects absent profile capability maps instead of using Worker-wide claims", () => {
  const { profileCapabilities: _, ...wide } = descriptor;
  expect(() =>
    selectDescriptorExecution(
      [wide as WorkerDescriptor],
      { requires: [{ id: "write", version: 1 }] },
      plan,
    ),
  ).toThrow("profileCapabilities");
});

it("schedules execution limits only on profiles that advertise enforcement", () => {
  const capable: WorkerDescriptor = {
    ...descriptor,
    profileCapabilities: descriptor.profileCapabilities?.map((entry) =>
      entry.profile === coding
        ? {
            ...entry,
            capabilities: [
              ...entry.capabilities,
              NATIVE_AGENT_LIMIT_CAPABILITY,
              REPORTED_COST_LIMIT_CAPABILITY,
              REPORTED_TOKEN_LIMIT_CAPABILITY,
            ],
          }
        : entry,
    ),
  };
  expect(
    selectDescriptorExecution(
      [descriptor],
      {
        limits: {
          maxNativeAgents: 1,
          maxReportedTokens: 100,
          maxReportedCost: { amountMinor: 100, currency: "USD" },
        },
      },
      plan,
    ),
  ).toBeUndefined();
  expect(
    selectDescriptorExecution(
      [capable],
      {
        harness: "codex",
        limits: {
          maxNativeAgents: 1,
          maxReportedTokens: 100,
          maxReportedCost: { amountMinor: 100, currency: "USD" },
        },
      },
      plan,
    ),
  ).toEqual(coding);
});

it("validates custom Worklet selections against requirements and Session state compatibility", async () => {
  const worklet = {
    id: "custom",
    describe: async () => ({
      id: "custom",
      protocolVersion: 1 as const,
      host: { id: "host", workers: [descriptor] },
    }),
    selectExecution: async () => coding,
    execute() {
      throw new Error("Selection does not execute work");
    },
  };
  expect(
    await selectWorkletExecution(worklet, { requires: [{ id: "search", version: 1 }] }, plan),
  ).toBeUndefined();
  expect(
    await selectWorkletExecution(worklet, {}, plan, { compatibleProfile: research }),
  ).toBeUndefined();
  expect(await selectWorkletExecution(worklet, { harness: "codex" }, plan)).toEqual(coding);
});

it.each(["describe", "selectExecution", "canExecute"] as const)(
  "bounds stalled %s during selection",
  async (method) => {
    vi.useFakeTimers();
    try {
      const worklet = {
        id: "custom",
        describe: async () => ({
          id: "custom",
          protocolVersion: 1 as const,
          host: { id: "host", workers: [descriptor] },
        }),
        execute() {
          throw new Error("not invoked");
        },
        ...(method === "selectExecution"
          ? { selectExecution: () => new Promise<never>(() => {}) }
          : {}),
        ...(method === "canExecute" ? { canExecute: () => new Promise<never>(() => {}) } : {}),
      };
      if (method === "describe") worklet.describe = () => new Promise(() => {});
      const result = selectWorkletExecution(worklet, {}, plan);
      const assertion = expect(result).rejects.toThrow("Worklet capability discovery timed out");
      await vi.advanceTimersByTimeAsync(5000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  },
);

it("requires explicit profile-local output collection support", () => {
  const execution = { outputs: { required: ["outputs/report.md"] } };
  expect(descriptorSupportsExecution(descriptor, research, execution)).toBe(false);
  const capable: WorkerDescriptor = {
    ...descriptor,
    capabilities: [
      ...descriptor.capabilities,
      { id: "supertag.artifacts.output-policy", version: 1 },
    ],
    profileCapabilities:
      descriptor.profileCapabilities?.map((entry) => ({
        ...entry,
        capabilities:
          entry.profile.id === coding.id
            ? [...entry.capabilities, { id: "supertag.artifacts.output-policy", version: 1 }]
            : entry.capabilities,
      })) ?? [],
  };
  expect(descriptorSupportsExecution(capable, research, execution)).toBe(false);
  expect(descriptorSupportsExecution(capable, coding, execution)).toBe(true);
});

it("places a Task that names a model only on a profile that advertises it", () => {
  const serving: WorkerDescriptor = {
    ...descriptor,
    profileCapabilities: (descriptor.profileCapabilities ?? []).map((support) =>
      support.profile.id === coding.id
        ? { ...support, models: ["gpt-6-sol", "gpt-6-max"], efforts: ["medium", "high"] }
        : support,
    ),
  };
  expect(
    selectDescriptorExecution([serving], { harness: "codex", model: "gpt-6-max" }, plan),
  ).toEqual(coding);
  expect(selectDescriptorExecution([serving], { model: "gpt-5" }, plan)).toBeUndefined();
  // A profile that lists no models serves none by name.
  expect(selectDescriptorExecution([descriptor], { model: "gpt-6-sol" }, plan)).toBeUndefined();
  expect(
    explainDescriptorExecutionIncompatibility(
      [serving],
      { harness: "codex", model: "gpt-5" },
      plan,
    ),
  ).toMatchObject({ status: "incompatible", unmetRequirements: ["execution.model"] });
  // Effort never blocks placement; a harness without it ignores it.
  expect(
    selectDescriptorExecution([serving], { harness: "opencode", effort: "high" }, plan),
  ).toEqual(research);
  expect(profileDefaultModel(serving, coding)).toBe("gpt-6-sol");
  expect(profileAppliesEffort(serving, coding, "high")).toBe(true);
  expect(profileAppliesEffort(serving, research, "high")).toBe(false);
});

it("requires a profile for capability and context checks", () => {
  // JavaScript consumers must not recover Worker-wide claims by omitting the profile.
  // @ts-expect-error A profile is required.
  expect(() => descriptorSupportsCoordination(descriptor)).toThrow();
  // @ts-expect-error A profile is required.
  expect(() => descriptorSupportsSurfaceCoordination(descriptor)).toThrow();
  // @ts-expect-error A profile is required.
  expect(() => descriptorSupportsRequiredContext(descriptor, plan)).toThrow();
});
