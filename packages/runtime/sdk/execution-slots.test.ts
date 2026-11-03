import { expect, it } from "vitest";
import { repositoryAttempt } from "../../../tests/support/repository-execution.js";
import {
  createWorker,
  type ExecutionEnvironment,
  type Harness,
  type TaskAttemptEvent,
  type TaskAttemptSpec,
} from "./src/index.js";

/** A single-slot Worker whose Attempts run until released. */
function singleSlotWorker() {
  const spec = repositoryAttempt("slots");
  let release!: () => void;
  const done = new Promise<void>((resolve) => {
    release = resolve;
  });
  const plan = {
    files: [],
    mounts: [],
    environmentVariables: {},
    secretBindings: [],
    network: { mode: "none" as const },
  };
  const environment: ExecutionEnvironment = {
    id: "fixture",
    placement: "local",
    rootDirectory: "/fixture",
    prepare: async () => {},
    read: async () => "",
    resolvePath: (path) => `/fixture/${path}`,
    spawn: async () => {
      throw new Error("unused");
    },
    dispose: async () => {},
  };
  const harness: Harness = {
    id: "slots",
    describe: async () => ({
      sessions: { resume: false, export: false, scope: "none" as const },
      id: "slots",
      version: "1",
      inputKinds: [],
      streaming: true,
      cancellation: true,
      sessionPersistence: "none",
    }),
    resolve: async () => ({ capabilities: await harness.describe() }),
    plan: async () => ({ runtime: plan, execution: plan }),
    start: async () => ({
      run: async function* () {
        await done;
        yield { type: "output.message", text: "finished" };
      },
      close: async () => {},
    }),
  };
  const worker = createWorker({
    id: "worker",
    maxConcurrency: 1,
    profiles: [
      {
        ref: spec.workerProfile,
        workerType: "slots",
        harness: { provider: "slots" },
        execution: { provider: "fixture", lifetime: { scope: "attempt" } },
      },
    ],
    harnesses: [harness],
    environments: [{ id: "fixture", capabilities: [], provision: async () => environment }],
  });
  return { spec, worker, release };
}

/** Starts an Attempt and reports whether it began before `ms` elapsed. */
async function startsWithin(
  events: AsyncIterator<TaskAttemptEvent>,
  ms = 100,
): Promise<{ readonly started: boolean; readonly first: Promise<unknown> }> {
  const first = events.next();
  const started = await Promise.race([
    first.then(() => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), ms)),
  ]);
  return { started, first };
}

it("runs an owner activation in the coordination slot of a single-slot Worker", async () => {
  const { spec, worker, release } = singleSlotWorker();
  const attempt = (id: string, coordinationSlot = false): TaskAttemptSpec => ({
    ...spec,
    taskId: id,
    attemptId: `${id}-attempt`,
    placement: {
      allowedWorkerHostIds: ["host"],
      ...(coordinationSlot ? { coordinationSlot } : {}),
    },
  });
  const builder = worker.execute(attempt("builder"))[Symbol.asyncIterator]();
  expect((await startsWithin(builder)).started).toBe(true);
  // Delegated work waits for the only ordinary slot.
  const delegated = worker.execute(attempt("delegated"))[Symbol.asyncIterator]();
  const waiting = await startsWithin(delegated);
  expect(waiting.started).toBe(false);
  // The owner's activation does not queue behind it.
  const owner = worker.execute(attempt("owner", true))[Symbol.asyncIterator]();
  expect((await startsWithin(owner)).started).toBe(true);
  // A second owner activation finds the coordination slot taken.
  const secondOwner = worker.execute(attempt("second-owner", true))[Symbol.asyncIterator]();
  const secondWaiting = await startsWithin(secondOwner);
  expect(secondWaiting.started).toBe(false);
  release();
  const drain = async (events: AsyncIterator<TaskAttemptEvent>) => {
    while (!(await events.next()).done);
  };
  // A freed slot goes to the waiting owner activation before delegated work.
  await Promise.all([drain(builder), drain(owner)]);
  await secondWaiting.first;
  const delegatedStarted = waiting.first.then(() => true);
  expect(
    await Promise.race([
      delegatedStarted,
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 50)),
    ]),
  ).toBe(false);
  await drain(secondOwner);
  await waiting.first;
  await drain(delegated);
});
