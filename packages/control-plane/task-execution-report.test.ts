import type { Task, TaskAttempt, TaskEvent } from "@supertag/core";
import { EXECUTION_WARNING_SUMMARY, executionWarningProgress } from "@supertag/worker-sdk";
import { describe, expect, it } from "vitest";
import {
  taskAttemptReportedCost,
  taskAttemptRunningCommand,
  taskAttemptWarnings,
  taskExecutionLimitReport,
  taskExecutionPlacementReport,
} from "./src/task-execution-report.js";

const task = {
  execution: {
    limits: {
      maxNativeAgents: 2,
      maxReportedTokens: 100,
      maxReportedCost: { amountMinor: 500, currency: "USD" },
    },
  },
} as Task;
const attempt = { id: "attempt", status: "completed" } as TaskAttempt;

function event(sequence: number, type: string, payload: TaskEvent["payload"]): TaskEvent {
  return {
    id: `event-${sequence}`,
    taskId: "task",
    attemptId: attempt.id,
    sequence,
    type,
    payload,
    createdAt: "2030-01-01T00:00:00.000Z",
  };
}

describe("Task execution limit report", () => {
  it("estimates a historical Codex report with tokens but no stored cost", () => {
    const codex = {
      ...attempt,
      workerSnapshot: { execution: { harness: "codex", model: "gpt-5.4" } },
    } as TaskAttempt;
    const events = [
      event(1, "usage.updated", {
        usage: {
          inputTokens: 1_000_000,
          cachedInputTokens: 500_000,
          outputTokens: 100_000,
          totalTokens: 1_100_000,
          complete: true,
        },
      }),
    ];
    expect(taskExecutionLimitReport(task, codex, events).observed.usage?.reportedCost).toEqual({
      amountMinor: 288,
      currency: "USD",
      estimated: true,
    });
    expect(taskAttemptReportedCost(codex, events)).toEqual({
      amountMinor: 288,
      currency: "USD",
      estimated: true,
    });
    const unpriced = {
      ...attempt,
      workerSnapshot: { execution: { harness: "codex", model: "gpt-7-preview" } },
    } as TaskAttempt;
    expect(
      taskExecutionLimitReport(task, unpriced, events).observed.usage?.reportedCost,
    ).toBeUndefined();
    expect(taskAttemptReportedCost(unpriced, events)).toBeNull();
  });
  it("does not attribute a renewed allocation to an earlier unlimited Attempt", () => {
    const report = taskExecutionLimitReport(task, attempt, [
      event(1, "execution.limits.applied", { requested: {}, applied: {} }),
    ]);
    expect(report.requested).toEqual({});
    expect(report.outcome.status).toBe("not_requested");
  });

  it("classifies complete durable observations without a live receipt", () => {
    const report = taskExecutionLimitReport(task, attempt, [
      event(1, "execution.limits.applied", {
        requested: task.execution.limits ?? {},
        applied: {
          maxNativeAgents: { limit: 2, method: "provider-native" },
          maxReportedTokens: { limit: 100, method: "interrupt-on-report" },
          maxReportedCost: {
            limit: { amountMinor: 500, currency: "USD" },
            method: "provider-budget",
          },
        },
      }),
      event(2, "execution.agent.updated", {
        agent: { id: "child", parentId: "root", status: "running" },
      }),
      event(3, "execution.agent.updated", {
        agent: { id: "child", parentId: "root", status: "completed" },
      }),
      event(4, "execution.usage.updated", {
        usage: {
          inputTokens: 40,
          outputTokens: 20,
          cachedInputTokens: 0,
          totalTokens: 60,
          complete: true,
          reportedCost: { amountMinor: 200, currency: "USD" },
        },
      }),
    ]);

    expect(report).toMatchObject({
      observed: { usage: { totalTokens: 60, complete: true }, peakNativeAgents: 1 },
      completeness: { applied: true, usage: true, terminal: true, complete: true },
      outcome: {
        status: "within_limits",
        thresholdReached: {
          maxNativeAgents: false,
          maxReportedTokens: false,
          maxReportedCost: false,
        },
      },
    });
  });

  it("reports a numeric threshold crossing even before the Attempt terminalizes", () => {
    const running = { ...attempt, status: "running" as const };
    const report = taskExecutionLimitReport(task, running, [
      event(1, "execution.limits.applied", {
        requested: task.execution.limits ?? {},
        applied: {
          maxNativeAgents: { limit: 2, method: "provider-native" },
          maxReportedTokens: { limit: 100, method: "interrupt-on-report" },
          maxReportedCost: {
            limit: { amountMinor: 500, currency: "USD" },
            method: "provider-budget",
          },
        },
      }),
      event(2, "usage.updated", {
        usage: {
          inputTokens: 90,
          outputTokens: 20,
          cachedInputTokens: 0,
          totalTokens: 110,
          complete: false,
        },
      }),
    ]);

    expect(report.completeness).toEqual({
      applied: true,
      usage: false,
      terminal: false,
      complete: false,
    });
    expect(report.outcome).toMatchObject({
      status: "threshold_reached",
      thresholdReached: { maxReportedTokens: true, maxReportedCost: null },
    });
  });

  it("classifies configured Harness ceilings without rewriting the Task request", () => {
    const configuredTask = { ...task, execution: {} } as Task;
    const report = taskExecutionLimitReport(configuredTask, attempt, [
      event(1, "execution.limits.applied", {
        requested: {},
        applied: {
          maxNativeAgents: { limit: 0, method: "harness-guard" },
          maxReportedTokens: { limit: 100, method: "interrupt-on-report" },
        },
      }),
      event(2, "usage.updated", {
        usage: {
          inputTokens: 90,
          outputTokens: 20,
          cachedInputTokens: 0,
          totalTokens: 110,
          complete: true,
        },
      }),
    ]);

    expect(report.requested).toEqual({});
    expect(report.completeness).toEqual({
      applied: true,
      usage: true,
      terminal: true,
      complete: true,
    });
    expect(report.outcome).toEqual({
      status: "threshold_reached",
      thresholdReached: {
        maxNativeAgents: false,
        maxReportedTokens: true,
        maxReportedCost: null,
      },
    });
  });

  it("keeps older Attempts with no applied-control event explicitly unknown", () => {
    const report = taskExecutionLimitReport(task, attempt, [
      event(1, "execution.failed", { error: { message: "reported token budget exceeded" } }),
    ]);

    expect(report.applied).toBeNull();
    expect(report.completeness).toEqual({
      applied: false,
      usage: false,
      terminal: true,
      complete: false,
    });
    expect(report.outcome).toEqual({
      status: "unknown",
      thresholdReached: {
        maxNativeAgents: null,
        maxReportedTokens: null,
        maxReportedCost: null,
      },
    });
  });
});

describe("Task execution placement report", () => {
  it("retains latest-Attempt cleanup uncertainty without trusting ordinary progress or stale terminal state", () => {
    const running = { ...attempt, status: "running" as const };
    const cleanup = event(2, "progress.updated", {
      progress: {
        summary: "Execution cleanup could not be confirmed; execution remains uncertain.",
        items: [
          { id: "cleanup-1", status: "blocked", text: "Original execution error: timeout" },
          { id: "cleanup-2", status: "blocked", text: "release failed", secret: "omitted" },
        ],
      },
    });
    const ordinary = event(3, "progress.updated", {
      progress: {
        summary: "Still working",
        items: [{ id: "cleanup-1", status: "blocked", text: "private model progress" }],
      },
    });
    expect(taskExecutionPlacementReport(running, [ordinary]).cleanupFailure).toBeNull();
    const report = taskExecutionPlacementReport(running, [ordinary, cleanup]);
    expect(report.cleanup).toBe("unknown");
    expect(report.cleanupFailure).toMatchObject({
      sequence: 2,
      items: [{ text: "Original execution error: timeout" }, { text: "release failed" }],
    });
    expect(JSON.stringify(report)).not.toContain("omitted");
    expect(JSON.stringify(report)).not.toContain("private model progress");
    expect(
      taskExecutionPlacementReport({ ...running, id: "next" }, [cleanup]).cleanupFailure,
    ).toBeNull();
    expect(
      taskExecutionPlacementReport(running, [event(1, "execution.completed", {}), cleanup]).cleanup,
    ).toBe("unknown");
    expect(
      taskExecutionPlacementReport(running, [cleanup, event(4, "execution.completed", {})]),
    ).toMatchObject({ cleanup: "confirmed", cleanupFailure: null });
  });
  it("reports split Harness and workspace placement from durable evidence", () => {
    const report = taskExecutionPlacementReport(attempt, [
      event(1, "execution.runtime-inputs.resolved", {
        manifest: runtimeManifest({
          harnessRuntime: {
            id: "local:/worker",
            provider: "local-harness-runtime",
            placement: "local",
            guarantees: guarantees("none"),
          },
        }),
      }),
    ]);

    expect(report).toEqual({
      status: "available",
      mode: "split",
      cleanup: "unknown",
      cleanupFailure: null,
      harness: {
        id: "codex",
        version: "0.42.0",
        provenance: { protocol: "codex-exec-server", protocolVersion: 1 },
      },
      harnessRuntime: {
        id: "local:/worker",
        provider: "local-harness-runtime",
        placement: "local",
        guarantees: guarantees("none"),
      },
      executionEnvironment: {
        id: "shared:workspace-1:access-1",
        provider: "shared-execution:workspace-1",
        placement: "remote",
        guarantees: guarantees("sandbox"),
        provenance: {
          environmentId: "workspace-1",
          incarnationId: "incarnation-1",
          accessId: "access-1",
          expiresAt: "2030-01-01T01:00:00.000Z",
        },
      },
    });
  });

  it("resolves a colocated Harness runtime to its execution environment", () => {
    const report = taskExecutionPlacementReport(attempt, [
      event(1, "runtime-inputs.resolved", { manifest: runtimeManifest() }),
    ]);

    expect(report.status).toBe("available");
    expect(report.mode).toBe("colocated");
    expect(report.cleanup).toBe("unknown");
    expect(report.harnessRuntime).toEqual(report.executionEnvironment);
  });

  it("keeps missing placement evidence pending or unknown", () => {
    expect(taskExecutionPlacementReport({ ...attempt, status: "running" }, [])).toMatchObject({
      status: "pending",
      mode: null,
      cleanup: "pending",
    });
    expect(taskExecutionPlacementReport(attempt, [])).toMatchObject({
      status: "unknown",
      mode: null,
      cleanup: "unknown",
    });
  });

  it("confirms cleanup only from a Worker terminal event", () => {
    const report = taskExecutionPlacementReport(attempt, [
      event(1, "runtime-inputs.resolved", { manifest: runtimeManifest() }),
      event(2, "execution.completed", {}),
    ]);

    expect(report.cleanup).toBe("confirmed");
  });
});

function guarantees(filesystemIsolation: "none" | "sandbox") {
  return {
    filesystemIsolation,
    networkPolicy: filesystemIsolation === "sandbox" ? ("enforced" as const) : ("none" as const),
    processTreeTermination: filesystemIsolation === "sandbox",
    scopedHttp: false,
  };
}

function runtimeManifest(options: Readonly<Record<string, unknown>> = {}) {
  return {
    workerProfile: { id: "profile", revision: "1" },
    harness: {
      id: "codex",
      version: "0.42.0",
      provenance: { protocol: "codex-exec-server", protocolVersion: 1 },
    },
    executionEnvironment: {
      id: "shared:workspace-1:access-1",
      provider: "shared-execution:workspace-1",
      placement: "remote",
      guarantees: guarantees("sandbox"),
      provenance: {
        environmentId: "workspace-1",
        incarnationId: "incarnation-1",
        accessId: "access-1",
        expiresAt: "2030-01-01T01:00:00.000Z",
      },
    },
    inputs: [],
    omitted: [],
    ...options,
  };
}

describe("cancelled execution cleanup evidence", () => {
  it.each(["completed", "failed", "cancelled", "not-started"])(
    "accepts authoritative %s receipt confirmation",
    (receiptStatus) => {
      const cancelled = { ...attempt, status: "cancelled" as const };
      const priorFailure = event(1, "progress.updated", {
        progress: {
          summary: "Execution cleanup could not be confirmed; execution remains uncertain.",
          items: [{ id: "cleanup-1", status: "blocked", text: "release failed" }],
        },
      });
      const confirmation = event(2, "task.cancellation-cleanup-confirmed", {
        version: 1,
        receiptStatus,
      });
      expect(taskExecutionPlacementReport(cancelled, [priorFailure, confirmation])).toMatchObject({
        cleanup: "confirmed",
        cleanupFailure: null,
      });
      expect(
        taskExecutionPlacementReport(cancelled, [confirmation, { ...priorFailure, sequence: 3 }]),
      ).toMatchObject({ cleanup: "unknown" });
    },
  );
  it.each([
    { version: 1, receiptStatus: "unknown" },
    { version: 1, receiptStatus: "running" },
    { receiptStatus: "cancelled" },
    { version: 2, receiptStatus: "cancelled" },
  ])("does not promote unsupported confirmation %j", (payload) => {
    const cancelled = { ...attempt, status: "cancelled" as const };
    expect(
      taskExecutionPlacementReport(cancelled, [
        event(1, "task.cancellation-cleanup-confirmed", payload),
      ]),
    ).toMatchObject({ cleanup: "unknown" });
  });
  it("does not attribute another Attempt's confirmation", () => {
    expect(
      taskExecutionPlacementReport({ ...attempt, status: "cancelled" }, [
        {
          ...event(1, "task.cancellation-cleanup-confirmed", {
            version: 1,
            receiptStatus: "cancelled",
          }),
          attemptId: "other",
        },
      ]),
    ).toMatchObject({ cleanup: "unknown" });
  });
});

describe("Task Attempt warnings", () => {
  it("projects recorded warnings for the Attempt without trusting ordinary progress", () => {
    const warning = event(2, "progress.updated", {
      progress: executionWarningProgress([
        "Native Session archive incomplete: session file exceeds size limit.",
      ]) as unknown as Record<string, unknown>,
    });
    const ordinary = event(3, "progress.updated", {
      progress: {
        summary: "Still working",
        items: [{ id: "warning-1", status: "blocked", text: "private model progress" }],
      },
    });
    const forged = event(4, "progress.updated", {
      progress: {
        summary: EXECUTION_WARNING_SUMMARY,
        items: [{ id: "other", status: "blocked", text: "not a warning item" }],
      },
    });
    const warnings = taskAttemptWarnings(attempt, [
      event(1, "execution.started", {}),
      warning,
      ordinary,
      forged,
      event(5, "execution.completed", {}),
    ]);
    expect(warnings).toEqual([
      {
        sequence: 2,
        at: "2030-01-01T00:00:00.000Z",
        text: "Native Session archive incomplete: session file exceeds size limit.",
      },
    ]);
    expect(taskAttemptWarnings({ ...attempt, id: "next" }, [warning])).toEqual([]);
    expect(taskAttemptWarnings(undefined, [warning])).toEqual([]);
  });
});

describe("Task Attempt running command", () => {
  const running = { id: "attempt", status: "running" } as TaskAttempt;
  const command = (
    sequence: number,
    id: string,
    text: string,
    status: string,
    createdAt = "2030-01-01T00:00:00.000Z",
  ): TaskEvent => ({
    ...event(sequence, "command.updated", { command: { id, command: text, status } }),
    createdAt,
  });

  it("reports the latest started command that has not ended", () => {
    expect(
      taskAttemptRunningCommand(running, [
        command(1, "a", "pnpm install", "running", "2030-01-01T00:00:00.000Z"),
        command(2, "b", "pnpm test:verify", "running", "2030-01-01T00:01:00.000Z"),
        event(3, "progress.updated", { progress: { summary: "Testing" } }),
      ]),
    ).toEqual({ command: "pnpm test:verify", startedAt: "2030-01-01T00:01:00.000Z" });
  });

  it("falls back to a command still running after a later one ends", () => {
    expect(
      taskAttemptRunningCommand(running, [
        command(1, "a", "pnpm test:verify", "running", "2030-01-01T00:00:00.000Z"),
        command(2, "b", "git status", "running", "2030-01-01T00:01:00.000Z"),
        command(3, "b", "git status", "completed", "2030-01-01T00:01:01.000Z"),
      ]),
    ).toEqual({ command: "pnpm test:verify", startedAt: "2030-01-01T00:00:00.000Z" });
  });

  it("reports nothing once every command ended or the Attempt stopped", () => {
    const events = [
      command(1, "a", "pnpm test", "running"),
      command(2, "a", "pnpm test", "failed"),
    ];
    expect(taskAttemptRunningCommand(running, events)).toBeNull();
    expect(
      taskAttemptRunningCommand(attempt, [command(1, "a", "pnpm test", "running")]),
    ).toBeNull();
    expect(taskAttemptRunningCommand(undefined, events)).toBeNull();
    expect(
      taskAttemptRunningCommand({ ...running, id: "next" }, [
        command(1, "a", "pnpm test", "running"),
      ]),
    ).toBeNull();
  });

  it("cleans stored command text and ignores malformed records", () => {
    expect(
      taskAttemptRunningCommand(running, [
        command(1, "a", "\x1b]0;title\x07echo \x1b[31mhi\u202e\nrm", "running"),
        event(2, "command.updated", { command: { id: "b", status: "running" } }),
        command(3, "c", "\x1b[0m\x00", "running"),
      ]),
    ).toEqual({ command: "echo hi rm", startedAt: "2030-01-01T00:00:00.000Z" });
  });
});
