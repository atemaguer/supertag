import { expect, it, vi } from "vitest";
import { repositoryAttempt } from "../../../tests/support/repository-execution.js";
import {
  type HarnessControlCommand,
  type HarnessExecutionControl,
  LocalHarnessExecutionControl,
  type LocalHarnessExecutionControlOptions,
} from "./src/harness-control.js";
import {
  collectTaskAttemptEvents,
  createWorker,
  ExecutionCleanupError,
  type ExecutionEnvironment,
  type Harness,
  type TaskAttemptSpec,
  WorkspaceResolverRegistry,
} from "./src/index.js";

const LONG_CLEANUP_CAUSE = new Error(
  `macOS process details failed after 3 attempts: ${"attempt detail ".repeat(40)}root cause`,
);

function fixture(
  declared = true,
  mismatchedInputMode = false,
  timeoutOnAbort = false,
  customControl = false,
  authorizeInputAtTake = false,
  failure?:
    | "process"
    | "ordinary"
    | "attempt-cleanup"
    | "host-cleanup"
    | "attempt-dispose"
    | "mixed-cleanup",
  onCleanupFailure?: (failure: { attemptId: string; diagnostics: readonly string[] }) => void,
) {
  const spec: TaskAttemptSpec = {
    ...repositoryAttempt("interactive"),
    ...(failure
      ? {
          workspacePlan: {
            version: 1,
            status: "workspace",
            workspace: "fixture",
            source: "https://example.com/repo.git",
            branch: "task",
            delivery: "branch",
            mcp: [],
          } as const,
        }
      : {}),
  };
  const finalize = vi.fn(async () => undefined);
  const dispatch = vi.fn<LocalHarnessExecutionControlOptions["dispatch"]>(
    async (_command, _signal, authorize) => ({
      status: authorize && !(await authorize()) ? "rejected" : "accepted",
    }),
  );
  const control = new LocalHarnessExecutionControl({
    taskId: spec.taskId,
    attemptId: spec.attemptId,
    capabilities: { version: 1, operations: ["input", "reply", "interrupt"], inputMode: "queue" },
    dispatch,
    authorizeInputAtTake,
  });
  control.registerRequest("question");
  const unsafeControl: HarnessExecutionControl = {
    taskId: spec.taskId,
    attemptId: spec.attemptId,
    capabilities: control.capabilities,
    send: async (command) => {
      await dispatch(command, new AbortController().signal);
      return {
        id: command.id,
        taskId: command.taskId,
        attemptId: command.attemptId,
        status: "accepted",
      };
    },
    close: async () => {},
  };
  let release!: () => void;
  const done = new Promise<void>((resolve) => {
    release = resolve;
  });
  const closed = vi.fn(async () => {});
  let disposals = 0;
  const disposed = vi.fn(async () => {
    if (disposals++ === 0 && (failure === "attempt-dispose" || failure === "mixed-cleanup"))
      throw new ExecutionCleanupError("Process stopped but output closure failed", {
        hostUnsafe: false,
      });
  });
  const environment: ExecutionEnvironment = {
    id: "fixture",
    placement: "local",
    rootDirectory: "/fixture",
    prepare: async () => {},
    prepareOutputDirectory: async () => {},
    read: async () => "",
    resolvePath: (path) => `/fixture/${path}`,
    spawn: async () => {
      throw new Error("unused");
    },
    dispose: disposed,
  };
  let runs = 0;
  const harness: Harness = {
    id: "interactive",
    describe: async () => ({
      sessions: { resume: false, export: false, scope: "none" as const },
      id: "interactive",
      version: "1",
      inputKinds: ["instruction"],
      streaming: true,
      cancellation: true,
      sessionPersistence: "none",
      ...(declared
        ? {
            control: {
              ...control.capabilities,
              inputMode: mismatchedInputMode ? ("steer" as const) : ("queue" as const),
            },
          }
        : {}),
    }),
    resolve: async () => ({ capabilities: await harness.describe() }),
    plan: async () => ({
      runtime: emptyEnvironmentPlan(),
      execution: emptyEnvironmentPlan(),
    }),
    start: async () => ({
      ...(failure ? {} : { control: customControl ? unsafeControl : control }),
      run: async function* (signal) {
        if (signal?.aborted) throw signal.reason;
        await Promise.race([
          done,
          new Promise<void>((resolve) =>
            signal?.addEventListener("abort", () => resolve(), { once: true }),
          ),
        ]);
        // A harness can report its own timeout once cancellation tears down its process.
        if (signal?.aborted) throw timeoutOnAbort ? new Error("Harness timed out") : signal.reason;
        runs++;
        if (
          runs === 1 &&
          (failure === "attempt-cleanup" ||
            failure === "host-cleanup" ||
            failure === "mixed-cleanup")
        )
          throw new ExecutionCleanupError(
            "Cleanup failed",
            failure === "attempt-cleanup"
              ? { hostUnsafe: false }
              : { cause: new Error("Process inventory failed", { cause: LONG_CLEANUP_CAUSE }) },
          );
        if (failure === "process") throw new ExecutionCleanupError("Process termination uncertain");
        if (failure === "ordinary") throw new Error("Ordinary failure");
        yield { type: "output.message", text: "finished" };
      },
      close: closed,
    }),
  };
  const worker = createWorker({
    id: "worker",
    ...(onCleanupFailure === undefined ? {} : { onCleanupFailure }),
    profiles: [
      {
        ref: spec.workerProfile,
        workerType: "interactive",
        harness: { provider: "interactive" },
        execution: { provider: "fixture", lifetime: { scope: "attempt" } },
      },
    ],
    harnesses: [harness],
    workspaceResolvers: new WorkspaceResolverRegistry([
      { id: "fixture", resolve: async () => [], finalize },
    ]),
    environments: [{ id: "fixture", capabilities: [], provision: async () => environment }],
  });
  const reply: HarnessControlCommand = {
    id: "reply",
    taskId: spec.taskId,
    attemptId: spec.attemptId,
    type: "reply",
    requestId: "question",
    response: { choice: "continue" },
  };
  return { spec, worker, control, reply, dispatch, release, closed, disposed, finalize };
}

function emptyEnvironmentPlan() {
  return {
    files: [],
    mounts: [],
    environmentVariables: {},
    secretBindings: [],
    network: { mode: "none" as const },
  };
}

it("routes live Worker replies idempotently and rejects wrong or finished Attempts", async () => {
  const value = fixture();
  const running = collectTaskAttemptEvents(value.worker.execute(value.spec));
  await expect
    .poll(async () => {
      try {
        return (await value.worker.control?.(value.reply))?.status;
      } catch {
        return "not-ready";
      }
    })
    .toBe("accepted");
  expect((await value.worker.control?.(value.reply))?.status).toBe("accepted");
  expect(value.dispatch).toHaveBeenCalledOnce();
  await expect(
    value.worker.control?.({ ...value.reply, attemptId: "wrong" }),
  ).resolves.toMatchObject({ status: "rejected" });
  value.release();
  expect((await running).at(-1)?.type).toBe("execution.completed");
  await expect(
    value.worker.control?.({ ...value.reply, id: "after-close" }),
  ).resolves.toMatchObject({ status: "rejected" });
  await expect(value.control.send({ ...value.reply, id: "new" })).rejects.toThrow(/closed/);
  expect(value.closed).toHaveBeenCalledOnce();
  expect(value.disposed).toHaveBeenCalledOnce();
});

it("closes execution control when Worker cancellation completes", async () => {
  const value = fixture();
  const abort = new AbortController();
  const running = collectTaskAttemptEvents(value.worker.execute(value.spec, abort.signal));
  await expect
    .poll(async () => {
      try {
        return (await value.worker.control?.(value.reply))?.status;
      } catch {
        return "not-ready";
      }
    })
    .toBe("accepted");
  abort.abort(new Error("stop"));
  expect((await running).at(-1)?.type).toBe("execution.failed");
  await expect(value.control.send({ ...value.reply, id: "after-cancel" })).rejects.toThrow(
    /closed/,
  );
  expect(value.closed).toHaveBeenCalledOnce();
  expect(value.disposed).toHaveBeenCalledOnce();
});

it("records the Control Plane cancellation cause instead of the harness timeout", async () => {
  const value = fixture(true, false, true);
  const abort = new AbortController();
  const running = collectTaskAttemptEvents(value.worker.execute(value.spec, abort.signal));
  await expect
    .poll(async () => {
      try {
        return (await value.worker.control?.(value.reply))?.status;
      } catch {
        return "not-ready";
      }
    })
    .toBe("accepted");
  // The durable Worklet forwards the Control Plane's reason under the AbortError name.
  abort.abort(new DOMException("Objective is no longer executing", "AbortError"));
  expect((await running).at(-1)).toMatchObject({
    type: "execution.failed",
    error: { message: "Objective is no longer executing" },
  });
});

it("keeps the harness error when cancellation carries no cause", async () => {
  const value = fixture(true, false, true);
  const abort = new AbortController();
  const running = collectTaskAttemptEvents(value.worker.execute(value.spec, abort.signal));
  await expect
    .poll(async () => {
      try {
        return (await value.worker.control?.(value.reply))?.status;
      } catch {
        return "not-ready";
      }
    })
    .toBe("accepted");
  abort.abort();
  expect((await running).at(-1)).toMatchObject({
    type: "execution.failed",
    error: { message: "Harness timed out" },
  });
});

it("rejects an undeclared execution control channel and cleans up before failure", async () => {
  const value = fixture(false);
  const events = await collectTaskAttemptEvents(value.worker.execute(value.spec));
  expect(events.at(-1)).toMatchObject({
    type: "execution.failed",
    error: { message: expect.stringContaining("undeclared control") },
  });
  expect(value.dispatch).not.toHaveBeenCalled();
  expect(value.closed).toHaveBeenCalledOnce();
  expect(value.disposed).toHaveBeenCalledOnce();
  await expect(value.control.send(value.reply)).rejects.toThrow(/closed/);
});

it("rejects live input semantics that differ from resolved support before publishing control", async () => {
  const value = fixture(true, true);
  const events = await collectTaskAttemptEvents(value.worker.execute(value.spec));
  expect(events.at(-1)).toMatchObject({
    type: "execution.failed",
    error: { message: expect.stringContaining("input control semantics") },
  });
  expect(events.some((event) => event.type === "runtime-inputs.resolved")).toBe(false);
  expect(
    await value.worker.controlCapabilities?.(value.spec.taskId, value.spec.attemptId),
  ).toBeUndefined();
  expect(value.dispatch).not.toHaveBeenCalled();
  expect(value.closed).toHaveBeenCalledOnce();
  expect(value.disposed).toHaveBeenCalledOnce();
  await expect(value.control.send(value.reply)).rejects.toThrow(/closed/);
});

it.each(["process", "ordinary"] as const)(
  "finalizes a failed workspace only when process cleanup is confirmed (%s)",
  async (failure) => {
    const value = fixture(true, false, false, false, false, failure);
    value.release();
    const outcome = collectTaskAttemptEvents(value.worker.execute(value.spec));
    if (failure === "process") {
      await expect(outcome).rejects.toBeInstanceOf(ExecutionCleanupError);
      expect(value.finalize).not.toHaveBeenCalled();
    } else {
      expect((await outcome).at(-1)?.type).toBe("execution.failed");
      expect(value.finalize).toHaveBeenCalledOnce();
    }
    expect(value.closed).toHaveBeenCalledOnce();
    expect(value.disposed).toHaveBeenCalledOnce();
  },
);

it.each([false, true])(
  "refuses guarded input before a custom adapter dispatches (callback: %s)",
  async (callback) => {
    const value = fixture(true, false, false, true);
    const running = collectTaskAttemptEvents(value.worker.execute(value.spec));
    try {
      await expect
        .poll(() => value.worker.controlCapabilities?.(value.spec.taskId, value.spec.attemptId))
        .toBeDefined();
      const authorizeInput = vi.fn(async () => false);
      expect(
        await value.worker.control?.(
          {
            id: "guarded",
            taskId: value.spec.taskId,
            attemptId: value.spec.attemptId,
            type: "input",
            text: "Revoked teammate input",
            requiresInputAuthorization: true,
          },
          callback ? { authorizeInput } : undefined,
        ),
      ).toMatchObject({ status: "rejected" });
      expect(value.dispatch).not.toHaveBeenCalled();
      expect(authorizeInput).not.toHaveBeenCalled();
    } finally {
      value.release();
      await running;
    }
  },
);

it.each([false, true])(
  "preserves the local control take-time guard (authorized: %s)",
  async (allowed) => {
    const value = fixture(true, false, false, false, true);
    const running = collectTaskAttemptEvents(value.worker.execute(value.spec));
    try {
      await expect
        .poll(() => value.worker.controlCapabilities?.(value.spec.taskId, value.spec.attemptId))
        .toBeDefined();
      const authorizeInput = vi.fn(async () => allowed);
      expect(
        await value.worker.control?.(
          {
            id: "guarded",
            taskId: value.spec.taskId,
            attemptId: value.spec.attemptId,
            type: "input",
            text: "Team input",
            requiresInputAuthorization: true,
          },
          { authorizeInput },
        ),
      ).toMatchObject({ status: allowed ? "accepted" : "rejected" });
      expect(authorizeInput).toHaveBeenCalledOnce();
    } finally {
      value.release();
      await running;
    }
  },
);

it.each(["attempt-cleanup", "host-cleanup", "attempt-dispose", "mixed-cleanup"] as const)(
  "only blocks later executions when cleanup leaves the host unsafe (%s)",
  async (failure) => {
    const cleanupLog = vi.fn();
    const value = fixture(true, false, false, false, false, failure, cleanupLog);
    value.release();
    await expect(collectTaskAttemptEvents(value.worker.execute(value.spec))).rejects.toBeInstanceOf(
      ExecutionCleanupError,
    );
    expect(value.finalize).toHaveBeenCalledTimes(failure === "attempt-dispose" ? 1 : 0);
    const next = collectTaskAttemptEvents(
      value.worker.execute({
        ...value.spec,
        attemptId: `${value.spec.attemptId}-next`,
        taskId: `${value.spec.taskId}-next`,
      }),
    );
    if (failure === "host-cleanup" || failure === "mixed-cleanup") {
      await expect(next).rejects.toMatchObject({
        name: "ExecutionCleanupError",
        hostUnsafe: false,
        message: expect.stringContaining("before this Task Attempt started"),
      });
      expect(value.closed).toHaveBeenCalledOnce();
      expect(cleanupLog).toHaveBeenCalledWith({
        attemptId: value.spec.attemptId,
        diagnostics: expect.arrayContaining([expect.stringContaining("Cleanup failed")]),
      });
      if (failure === "mixed-cleanup")
        expect(cleanupLog).toHaveBeenCalledWith({
          attemptId: value.spec.attemptId,
          diagnostics: expect.arrayContaining([
            expect.stringContaining("Process stopped but output closure failed"),
          ]),
        });
      expect(cleanupLog).toHaveBeenCalledWith({
        attemptId: `${value.spec.attemptId}-next`,
        diagnostics: expect.arrayContaining([
          expect.stringContaining("before this Task Attempt started"),
        ]),
      });
      // The host log keeps the root cause whole, past the Control Plane progress bound.
      for (const attemptId of [value.spec.attemptId, `${value.spec.attemptId}-next`])
        expect(cleanupLog).toHaveBeenCalledWith({
          attemptId,
          diagnostics: expect.arrayContaining([`Error: ${LONG_CLEANUP_CAUSE.message}`]),
        });
    } else {
      expect((await next).at(-1)?.type).toBe("execution.completed");
      expect(value.closed).toHaveBeenCalledTimes(2);
      expect(value.finalize).toHaveBeenCalledTimes(failure === "attempt-dispose" ? 2 : 1);
    }
  },
);
