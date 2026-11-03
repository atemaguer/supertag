import { spawn } from "node:child_process";
import { once } from "node:events";
import { expect, it } from "vitest";
import { repositoryAttempt } from "../../../tests/support/repository-execution.js";
import { runWorkerConformance } from "./src/conformance.js";
import {
  TASK_ATTEMPT_CANCELLATION_CAPABILITY,
  TASK_ATTEMPT_EVENT_STREAM_CAPABILITY,
  type TaskAttemptEvent,
  type Worker,
} from "./src/index.js";

it("cancels a running process and waits for reaping before passing live conformance", async () => {
  const attempt = repositoryAttempt("live-probe");
  let reaped = false;
  let children = 0;
  const worker: Worker = {
    describe: async () => ({
      profileCapabilities: [
        {
          profile: attempt.workerProfile,
          capabilities: [
            TASK_ATTEMPT_EVENT_STREAM_CAPABILITY,
            TASK_ATTEMPT_CANCELLATION_CAPABILITY,
          ],
          contextTypes: [],
        },
      ],
      id: "probe",
      type: "test",
      capabilities: [TASK_ATTEMPT_EVENT_STREAM_CAPABILITY, TASK_ATTEMPT_CANCELLATION_CAPABILITY],
      profiles: [attempt.workerProfile],
      contextTypes: [],
    }),
    async *execute(spec, signal) {
      const identity = {
        taskId: spec.taskId,
        attemptId: spec.attemptId,
        at: new Date().toISOString(),
      };
      yield { ...identity, type: "execution.started", workerId: "probe" };
      if (signal?.aborted) {
        yield {
          ...identity,
          type: "execution.failed",
          error: { name: "AbortError", message: "cancelled" },
        };
        return;
      }
      if (spec.attemptId !== "live") {
        yield { ...identity, type: "execution.completed" };
        return;
      }
      const child = spawn(
        process.execPath,
        ["-e", 'process.stdout.write("ready");setInterval(()=>{},1000)'],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      children++;
      const exited = once(child, "exit");
      try {
        if (!child.stdout) throw new Error("Probe requires piped stdout");
        await once(child.stdout, "data");
        yield { ...identity, type: "output.delta", text: "process ready" };
        if (!signal?.aborted)
          await new Promise<void>((resolve) =>
            signal?.addEventListener("abort", () => resolve(), { once: true }),
          );
      } finally {
        child.kill("SIGTERM");
        await exited;
        reaped = true;
      }
      yield {
        ...identity,
        type: "execution.failed",
        error: { name: "AbortError", message: "cancelled" },
      };
    },
  };
  const report = await runWorkerConformance({
    worker,
    attempt,
    liveCancellationAttempt: { ...attempt, attemptId: "live" },
  });
  expect(report).toMatchObject({ passed: true, findings: [] });
  expect(children).toBe(1);
  expect(reaped).toBe(true);
});

it("reports live cancellation failure when an adapter continues to successful completion", async () => {
  const attempt = repositoryAttempt("live-probe");
  const worker: Worker = {
    describe: async () => ({
      profileCapabilities: [
        {
          profile: attempt.workerProfile,
          capabilities: [TASK_ATTEMPT_EVENT_STREAM_CAPABILITY],
          contextTypes: [],
        },
      ],
      id: "probe",
      type: "test",
      capabilities: [TASK_ATTEMPT_EVENT_STREAM_CAPABILITY],
      profiles: [attempt.workerProfile],
      contextTypes: [],
    }),
    async *execute(spec) {
      const identity = {
        taskId: spec.taskId,
        attemptId: spec.attemptId,
        at: new Date().toISOString(),
      };
      yield { ...identity, type: "execution.started", workerId: "probe" };
      yield { ...identity, type: "output.delta", text: "running" };
      yield { ...identity, type: "execution.completed" };
    },
  };
  const report = await runWorkerConformance({
    worker,
    attempt,
    liveCancellationAttempt: { ...attempt, attemptId: "live" },
  });
  expect(report.passed).toBe(false);
  expect(report.findings.map((finding) => finding.code)).toContain(
    "worker.cancellation.live-not-honored",
  );
});

it("bounds a stalled live iterator even when its cleanup does not cooperate", async () => {
  const attempt = repositoryAttempt("live-probe");
  const worker: Worker = {
    describe: async () => ({
      profileCapabilities: [
        {
          profile: attempt.workerProfile,
          capabilities: [TASK_ATTEMPT_EVENT_STREAM_CAPABILITY],
          contextTypes: [],
        },
      ],
      id: "probe",
      type: "test",
      capabilities: [TASK_ATTEMPT_EVENT_STREAM_CAPABILITY],
      profiles: [attempt.workerProfile],
      contextTypes: [],
    }),
    execute(spec) {
      const identity = {
        taskId: spec.taskId,
        attemptId: spec.attemptId,
        at: new Date().toISOString(),
      };
      const events: TaskAttemptEvent[] = [
        { ...identity, type: "execution.started", workerId: "probe" },
        { ...identity, type: "output.delta", text: "ready" },
      ];
      if (spec.attemptId !== "live") events.push({ ...identity, type: "execution.completed" });
      return {
        [Symbol.asyncIterator]() {
          return {
            async next() {
              const event = events.shift();
              if (event) return { done: false as const, value: event };
              if (spec.attemptId === "live")
                return new Promise<IteratorResult<TaskAttemptEvent>>(() => {});
              return { done: true as const, value: undefined };
            },
            return() {
              return new Promise<IteratorResult<TaskAttemptEvent>>(() => {});
            },
          };
        },
      };
    },
  };
  const report = await runWorkerConformance({
    worker,
    attempt,
    liveCancellationAttempt: { ...attempt, attemptId: "live" },
    cancellationTimeoutMs: 10,
  });
  expect(report.passed).toBe(false);
  expect(report.findings).toContainEqual(
    expect.objectContaining({
      code: "worker.execute.threw",
      message: expect.stringContaining("did not settle"),
    }),
  );
});
