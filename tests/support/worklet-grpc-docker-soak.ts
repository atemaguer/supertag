export interface SoakTaskObservation {
  readonly taskId: string;
  readonly hostId: string;
  readonly submittedAtMs: number;
  readonly completedAtMs?: number;
  readonly attemptCount: number;
  readonly journalSequences: readonly number[];
  readonly error?: string;
}

export interface SoakFaultObservation {
  readonly kind: "control-network-partition" | "control-plane-restart" | "worker-host-restart";
  readonly target: string;
  readonly taskId?: string;
  readonly downtimeMs: number;
  readonly reconnectLatencyMs: number;
  readonly recoveryLatencyMs?: number;
  readonly recovered: boolean;
}

export interface DockerSoakConfiguration {
  readonly durationSeconds: number;
  readonly maxTasks: number;
  readonly concurrency: number;
  readonly faultDowntimeMs: number;
  readonly taskTimeoutMs: number;
}

export function percentile(values: readonly number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)] ?? 0;
}

export function summarizeDockerSoak(input: {
  readonly startedAt: string;
  readonly endedAt: string;
  readonly configuration: DockerSoakConfiguration;
  readonly tasks: readonly SoakTaskObservation[];
  readonly faults: readonly SoakFaultObservation[];
  readonly effectCounts: Readonly<Record<string, number>>;
  readonly credentialsDistinct: boolean;
}) {
  const completed = input.tasks.filter((task) => task.completedAtMs !== undefined);
  const completionLatency = completed.map(
    (task) => (task.completedAtMs as number) - task.submittedAtMs,
  );
  const duplicateTaskIds = Object.entries(input.effectCounts)
    .filter(([, count]) => count > 1)
    .map(([taskId]) => taskId)
    .sort();
  const missingEffectTaskIds = input.tasks
    .filter((task) => (input.effectCounts[task.taskId] ?? 0) === 0)
    .map((task) => task.taskId)
    .sort();
  const duplicateAttempts = input.tasks
    .filter((task) => task.attemptCount > 1)
    .map((task) => task.taskId);
  const faultTaskIds = new Set(
    input.faults.flatMap((fault) => (fault.taskId === undefined ? [] : [fault.taskId])),
  );
  const journalFailures = input.tasks
    .filter(
      (task) =>
        (faultTaskIds.has(task.taskId) && task.journalSequences.length === 0) ||
        new Set(task.journalSequences).size !== task.journalSequences.length ||
        task.journalSequences.some((sequence, index) => sequence !== index + 1),
    )
    .map((task) => task.taskId);
  const failed = input.tasks.filter((task) => task.error !== undefined).map((task) => task.taskId);
  const passed =
    input.tasks.length > 0 &&
    completed.length === input.tasks.length &&
    failed.length === 0 &&
    duplicateTaskIds.length === 0 &&
    missingEffectTaskIds.length === 0 &&
    duplicateAttempts.length === 0 &&
    journalFailures.length === 0 &&
    input.credentialsDistinct &&
    input.faults.length === 3 &&
    input.faults.every((fault) => fault.recovered);
  return {
    schemaVersion: 1,
    startedAt: input.startedAt,
    endedAt: input.endedAt,
    configuration: input.configuration,
    topology: {
      physicalHosts: 1,
      dockerWorkerHosts: 2,
      independentWorkerCredentials: input.credentialsDistinct,
      executionEnvironment: "one shared Docker service",
      limitation:
        "All containers ran on one physical Docker host; this validates process and network boundaries, not multi-machine latency or failure independence.",
    },
    workload: {
      requested: input.tasks.length,
      completed: completed.length,
      failedTaskIds: failed,
      completionRate: completed.length / input.tasks.length,
      duplicateExecutionCount: duplicateTaskIds.length,
      duplicateTaskIds,
      missingExecutionEffectCount: missingEffectTaskIds.length,
      missingExecutionEffectTaskIds: missingEffectTaskIds,
      duplicateAttemptCount: duplicateAttempts.length,
      duplicateAttemptTaskIds: duplicateAttempts,
      durableJournalFailureCount: journalFailures.length,
      durableJournalFailureTaskIds: journalFailures,
    },
    latencyMs: {
      samples: completionLatency.length,
      p50: percentile(completionLatency, 0.5),
      p95: percentile(completionLatency, 0.95),
      max: Math.max(0, ...completionLatency),
    },
    faults: input.faults,
    gates: {
      expectedCompletionRate: 1,
      expectedDuplicateExecutions: 0,
      expectedDuplicateAttempts: 0,
      expectedDurableJournalFailures: 0,
      expectedRecoveredFaults: 3,
      passed,
    },
  } as const;
}
