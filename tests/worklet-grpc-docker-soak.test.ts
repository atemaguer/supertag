import { describe, expect, it } from "vitest";
import { percentile, summarizeDockerSoak } from "./support/worklet-grpc-docker-soak.js";

const configuration = {
  durationSeconds: 120,
  maxTasks: 100,
  concurrency: 2,
  faultDowntimeMs: 2500,
  taskTimeoutMs: 45_000,
};
const faults = [
  {
    kind: "control-network-partition" as const,
    target: "worker-a",
    taskId: "partition",
    downtimeMs: 2500,
    reconnectLatencyMs: 150,
    recoveryLatencyMs: 500,
    recovered: true,
  },
  {
    kind: "control-plane-restart" as const,
    target: "control-plane",
    taskId: "restart",
    downtimeMs: 900,
    reconnectLatencyMs: 900,
    recoveryLatencyMs: 1200,
    recovered: true,
  },
  {
    kind: "worker-host-restart" as const,
    target: "worker-a",
    taskId: "postrestart",
    downtimeMs: 700,
    reconnectLatencyMs: 700,
    recoveryLatencyMs: 850,
    recovered: true,
  },
];

describe("Docker Worklet soak report", () => {
  it("uses nearest-rank percentiles and passes only complete exact durable evidence", () => {
    expect(percentile([50, 10, 40, 20, 30], 0.5)).toBe(30);
    expect(percentile([50, 10, 40, 20, 30], 0.95)).toBe(50);
    const report = summarizeDockerSoak({
      startedAt: "2026-09-17T00:00:00.000Z",
      endedAt: "2026-09-17T00:02:00.000Z",
      configuration,
      tasks: [
        {
          taskId: "partition",
          hostId: "worker-a",
          submittedAtMs: 0,
          completedAtMs: 50,
          attemptCount: 1,
          journalSequences: [1, 2, 3],
        },
        {
          taskId: "restart",
          hostId: "worker-b",
          submittedAtMs: 0,
          completedAtMs: 100,
          attemptCount: 1,
          journalSequences: [1, 2],
        },
      ],
      faults,
      effectCounts: { partition: 1, restart: 1 },
      credentialsDistinct: true,
    });
    expect(report.gates.passed).toBe(true);
    expect(report.workload).toMatchObject({
      requested: 2,
      completed: 2,
      completionRate: 1,
      duplicateExecutionCount: 0,
      missingExecutionEffectCount: 0,
      duplicateAttemptCount: 0,
      durableJournalFailureCount: 0,
    });
    expect(report.topology.physicalHosts).toBe(1);
  });

  it("fails duplicate effects, attempts, journal gaps, incomplete tasks, and a fault miss", () => {
    const report = summarizeDockerSoak({
      startedAt: "2026-09-17T00:00:00.000Z",
      endedAt: "2026-09-17T00:02:00.000Z",
      configuration,
      tasks: [
        {
          taskId: "duplicate",
          hostId: "worker-a",
          submittedAtMs: 0,
          completedAtMs: 50,
          attemptCount: 2,
          journalSequences: [1, 3],
        },
        {
          taskId: "incomplete",
          hostId: "worker-b",
          submittedAtMs: 0,
          attemptCount: 1,
          journalSequences: [],
          error: "deadline",
        },
      ],
      faults: faults.map((fault, index) => (index === 1 ? { ...fault, recovered: false } : fault)),
      effectCounts: { duplicate: 2 },
      credentialsDistinct: true,
    });
    expect(report.gates.passed).toBe(false);
    expect(report.workload).toMatchObject({
      completed: 1,
      failedTaskIds: ["incomplete"],
      duplicateTaskIds: ["duplicate"],
      missingExecutionEffectTaskIds: ["incomplete"],
      duplicateAttemptTaskIds: ["duplicate"],
      durableJournalFailureTaskIds: ["duplicate"],
    });
  });
});
