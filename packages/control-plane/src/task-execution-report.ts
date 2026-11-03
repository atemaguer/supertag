import {
  estimatedCodexCost,
  parseTaskExecutionRequirements,
  plainCommandText,
  type Task,
  type TaskAttempt,
  type TaskEvent,
  type TaskExecutionRequirements,
} from "@supertag/core";
import {
  type AppliedHarnessExecutionLimits,
  EXECUTION_WARNING_SUMMARY,
  type ExecutionUsage,
  type RuntimeEnvironmentManifest,
  type RuntimeInputManifest,
} from "@supertag/worker-sdk";

type RequestedLimits = NonNullable<TaskExecutionRequirements["limits"]>;

export interface TaskExecutionLimitReport {
  readonly requested: RequestedLimits;
  readonly applied: AppliedHarnessExecutionLimits | null;
  readonly observed: {
    readonly usage: ExecutionUsage | null;
    readonly peakNativeAgents: number;
  };
  readonly completeness: {
    /** Every requested dimension has durable evidence of the effective Harness control. */
    readonly applied: boolean;
    /** Null when no requested or applied reported token or cost limit exists. */
    readonly usage: boolean | null;
    readonly terminal: boolean;
    /** The report can conclusively classify every requested or applied dimension. */
    readonly complete: boolean;
  };
  readonly outcome: {
    readonly status:
      | "not_requested"
      | "pending"
      | "within_limits"
      | "threshold_reached"
      | "unknown";
    /** Null means durable observations cannot yet determine the result. */
    readonly thresholdReached: {
      readonly maxNativeAgents: boolean | null;
      readonly maxReportedTokens: boolean | null;
      readonly maxReportedCost: boolean | null;
    };
  };
}

export interface TaskExecutionPlacementReport {
  readonly status: "not_started" | "pending" | "available" | "unknown";
  readonly mode: "colocated" | "split" | null;
  /** Worker terminal events are emitted only after both environment accesses close cleanly. */
  readonly cleanup: "not_started" | "pending" | "confirmed" | "unknown";
  readonly cleanupFailure: {
    readonly sequence: number;
    readonly at: string;
    readonly summary: string;
    readonly items: readonly {
      readonly id: string;
      readonly text: string;
      readonly status: "blocked";
    }[];
  } | null;
  readonly harness: RuntimeInputManifest["harness"] | null;
  readonly harnessRuntime: RuntimeEnvironmentManifest | null;
  readonly executionEnvironment: RuntimeEnvironmentManifest | null;
}

/**
 * Projects the latest durable runtime-input manifest into an operator-facing placement report.
 * Colocated Harnesses omit harnessRuntime on the wire, so the report resolves it to the
 * execution environment while preserving the explicit colocated mode.
 */
export function taskExecutionPlacementReport(
  attempt: TaskAttempt | undefined,
  events: readonly TaskEvent[],
): TaskExecutionPlacementReport {
  if (attempt === undefined)
    return {
      status: "not_started",
      mode: null,
      cleanup: "not_started",
      cleanupFailure: null,
      harness: null,
      harnessRuntime: null,
      executionEnvironment: null,
    };
  const attemptEvents = events
    .filter((event) => event.attemptId === attempt.id)
    .toSorted((a, b) => a.sequence - b.sequence);
  const manifest = latestRuntimeInputManifest(attemptEvents);
  const terminal = attemptEvents.findLast(
    (event) =>
      event.type === "execution.completed" ||
      event.type === "execution.failed" ||
      (event.type === "task.cancellation-cleanup-confirmed" &&
        event.payload?.["version"] === 1 &&
        ["completed", "failed", "cancelled", "not-started"].includes(
          String(event.payload["receiptStatus"]),
        )),
  );
  const failure = attemptEvents.findLast((event) => cleanupFailureEvidence(event) !== null);
  const cleanupFailure =
    failure && (!terminal || failure.sequence > terminal.sequence)
      ? cleanupFailureEvidence(failure)
      : null;
  const cleanup =
    cleanupFailure !== null
      ? ("unknown" as const)
      : terminal
        ? ("confirmed" as const)
        : attempt.status === "running"
          ? ("pending" as const)
          : ("unknown" as const);
  if (manifest === null)
    return {
      status: attempt.status === "running" ? "pending" : "unknown",
      mode: null,
      cleanup,
      cleanupFailure,
      harness: null,
      harnessRuntime: null,
      executionEnvironment: null,
    };
  return {
    status: "available",
    mode: manifest.harnessRuntime === undefined ? "colocated" : "split",
    cleanup,
    cleanupFailure,
    harness: manifest.harness,
    harnessRuntime: manifest.harnessRuntime ?? manifest.executionEnvironment,
    executionEnvironment: manifest.executionEnvironment,
  };
}

export interface TaskAttemptWarning {
  readonly sequence: number;
  readonly at: string;
  readonly text: string;
}

/** The native command a running Attempt reports as still running. */
export interface TaskAttemptRunningCommand {
  /** Plain, single-line command text; AI-authored, so never trust it beyond display. */
  readonly command: string;
  /** When the Control Plane recorded the command's start. */
  readonly startedAt: string;
}

/**
 * The command a running Attempt most recently started and has not reported ended, from its
 * `command.updated` events. Null when the Attempt is not running, its harness reports no
 * commands, or every reported command has ended. The text is cleaned again here, because stored
 * events come from Workers.
 */
export function taskAttemptRunningCommand(
  attempt: TaskAttempt | undefined,
  events: readonly TaskEvent[],
): TaskAttemptRunningCommand | null {
  if (attempt === undefined || attempt.status !== "running") return null;
  const running = new Map<string, TaskAttemptRunningCommand>();
  for (const event of events
    .filter((candidate) => candidate.attemptId === attempt.id)
    .toSorted((a, b) => a.sequence - b.sequence)) {
    if (event.type !== "command.updated") continue;
    const command = event.payload?.["command"];
    if (
      !isObject(command) ||
      typeof command["id"] !== "string" ||
      typeof command["command"] !== "string"
    )
      continue;
    const id = command["id"];
    if (command["status"] !== "running") {
      running.delete(id);
      continue;
    }
    const text = plainCommandText(command["command"]);
    if (!text) continue;
    const startedAt = running.get(id)?.startedAt ?? event.createdAt;
    running.delete(id);
    running.set(id, { command: text, startedAt });
  }
  return [...running.values()].at(-1) ?? null;
}

/**
 * Non-fatal problems a Worker recorded on an Attempt, such as an incomplete native Session
 * archive after execution completed. They never change the Attempt's outcome.
 */
export function taskAttemptWarnings(
  attempt: TaskAttempt | undefined,
  events: readonly TaskEvent[],
): readonly TaskAttemptWarning[] {
  if (attempt === undefined) return [];
  return events
    .filter((event) => event.attemptId === attempt.id && event.type === "progress.updated")
    .toSorted((a, b) => a.sequence - b.sequence)
    .flatMap((event) => {
      const progress = event.payload?.["progress"];
      if (
        !isObject(progress) ||
        progress["summary"] !== EXECUTION_WARNING_SUMMARY ||
        !Array.isArray(progress["items"])
      )
        return [];
      return progress["items"]
        .slice(0, 8)
        .flatMap((item) =>
          isObject(item) &&
          item["status"] === "blocked" &&
          typeof item["id"] === "string" &&
          /^warning-\d+$/u.test(item["id"]) &&
          typeof item["text"] === "string"
            ? [{ sequence: event.sequence, at: event.createdAt, text: item["text"].slice(0, 160) }]
            : [],
        );
    })
    .slice(-8);
}

function cleanupFailureEvidence(event: TaskEvent): TaskExecutionPlacementReport["cleanupFailure"] {
  if (event.type !== "progress.updated") return null;
  const progress = event.payload?.["progress"];
  if (
    !isObject(progress) ||
    progress["summary"] !==
      "Execution cleanup could not be confirmed; execution remains uncertain." ||
    !Array.isArray(progress["items"])
  )
    return null;
  const items = progress["items"].slice(0, 8).flatMap((item) => {
    if (
      !isObject(item) ||
      item["status"] !== "blocked" ||
      typeof item["id"] !== "string" ||
      !/^cleanup-\d+$/u.test(item["id"]) ||
      typeof item["text"] !== "string"
    )
      return [];
    return [
      {
        id: item["id"].slice(0, 128),
        text: item["text"].slice(0, 160),
        status: "blocked" as const,
      },
    ];
  });
  return items.length === 0
    ? null
    : { sequence: event.sequence, at: event.createdAt, summary: progress["summary"], items };
}

/**
 * Builds an operator projection only from durable Task, Attempt, and TaskEvent state.
 * A live Worklet receipt may enrich the surrounding response but is never required here.
 */
export function taskExecutionLimitReport(
  task: Task | undefined,
  attempt: TaskAttempt | undefined,
  events: readonly TaskEvent[],
): TaskExecutionLimitReport {
  let requested = task?.execution.limits ?? {};
  const attemptEvents = attempt
    ? events
        .filter((event) => event.attemptId === attempt.id)
        .toSorted((a, b) => a.sequence - b.sequence)
    : [];
  // Allocation updates must never rewrite earlier Attempt reports.
  const recorded = attemptEvents.findLast((event) => event.type === "execution.limits.applied");
  const renewal =
    attempt &&
    events
      .toSorted((a, b) => a.sequence - b.sequence)
      .find(
        (event) =>
          event.type === "task.budget-renewed" &&
          typeof event.payload?.["previousAttemptCount"] === "number" &&
          event.payload["previousAttemptCount"] >= attempt.attemptNumber,
      );
  const historical = recorded?.payload?.["requested"] ?? renewal?.payload?.["previousLimits"];
  if (historical !== undefined) {
    try {
      requested =
        typeof historical === "object" &&
        historical !== null &&
        !Array.isArray(historical) &&
        Object.keys(historical).length === 0
          ? {}
          : (parseTaskExecutionRequirements({ limits: historical }).limits ?? requested);
    } catch {
      /* Malformed evidence cannot replace validated Task requirements. */
    }
  }
  const applied = latestAppliedLimits(attemptEvents);
  const usage = attemptUsage(attempt, attemptEvents);
  const terminal = attempt !== undefined && attempt.status !== "running";
  const peakNativeAgents = nativeAgentPeak(attemptEvents);
  const appliedComplete = requestedLimitsApplied(requested, applied);
  const usageRelevant =
    requested.maxReportedTokens !== undefined ||
    requested.maxReportedCost !== undefined ||
    applied?.maxReportedTokens !== undefined ||
    applied?.maxReportedCost !== undefined;
  const usageComplete = usageRelevant ? usage?.complete === true : null;
  const thresholdReached = {
    maxNativeAgents: nativeAgentThreshold(requested, applied, peakNativeAgents, terminal),
    maxReportedTokens: tokenThreshold(requested, applied, usage, terminal),
    maxReportedCost: costThreshold(requested, applied, usage, terminal),
  };
  const activeOutcomes = [
    requested.maxNativeAgents === undefined && applied?.maxNativeAgents === undefined
      ? undefined
      : thresholdReached.maxNativeAgents,
    requested.maxReportedTokens === undefined && applied?.maxReportedTokens === undefined
      ? undefined
      : thresholdReached.maxReportedTokens,
    requested.maxReportedCost === undefined && applied?.maxReportedCost === undefined
      ? undefined
      : thresholdReached.maxReportedCost,
  ].filter((value): value is boolean | null => value !== undefined);
  const complete =
    activeOutcomes.length === 0 ||
    (terminal && appliedComplete && activeOutcomes.every((value) => value !== null));
  const status =
    activeOutcomes.length === 0
      ? ("not_requested" as const)
      : activeOutcomes.some((value) => value === true)
        ? ("threshold_reached" as const)
        : !terminal
          ? ("pending" as const)
          : complete
            ? ("within_limits" as const)
            : ("unknown" as const);

  return {
    requested,
    applied,
    observed: { usage, peakNativeAgents },
    completeness: {
      applied: appliedComplete,
      usage: usageComplete,
      terminal,
      complete,
    },
    outcome: { status, thresholdReached },
  };
}

function latestAppliedLimits(events: readonly TaskEvent[]): AppliedHarnessExecutionLimits | null {
  for (const event of events.toReversed()) {
    if (event.type !== "execution.limits.applied") continue;
    const applied = event.payload?.["applied"];
    if (isObject(applied)) return applied as AppliedHarnessExecutionLimits;
  }
  return null;
}

type RuntimePlacementEvidence = Readonly<{
  harness: RuntimeInputManifest["harness"];
  executionEnvironment: RuntimeEnvironmentManifest;
  harnessRuntime?: RuntimeEnvironmentManifest;
}>;

function latestRuntimeInputManifest(events: readonly TaskEvent[]): RuntimePlacementEvidence | null {
  for (const event of events.toReversed()) {
    if (
      event.type !== "execution.runtime-inputs.resolved" &&
      event.type !== "runtime-inputs.resolved"
    )
      continue;
    const manifest = event.payload?.["manifest"];
    if (!isObject(manifest)) continue;
    const harness = manifest["harness"];
    const executionEnvironment = runtimeEnvironmentManifest(manifest["executionEnvironment"]);
    const harnessRuntime = runtimeEnvironmentManifest(manifest["harnessRuntime"]);
    if (
      !isObject(harness) ||
      typeof harness["id"] !== "string" ||
      typeof harness["version"] !== "string" ||
      executionEnvironment === null ||
      (manifest["harnessRuntime"] !== undefined && harnessRuntime === null)
    )
      continue;
    return {
      harness: harness as RuntimeInputManifest["harness"],
      executionEnvironment,
      ...(harnessRuntime === null ? {} : { harnessRuntime }),
    };
  }
  return null;
}

function runtimeEnvironmentManifest(value: unknown): RuntimeEnvironmentManifest | null {
  if (
    !isObject(value) ||
    typeof value["id"] !== "string" ||
    typeof value["provider"] !== "string" ||
    !["local", "remote", "managed"].includes(String(value["placement"]))
  )
    return null;
  const guarantees = value["guarantees"];
  if (guarantees !== undefined && !validEnvironmentGuarantees(guarantees)) return null;
  const provenance = value["provenance"];
  if (provenance !== undefined && !isObject(provenance)) return null;
  return value as unknown as RuntimeEnvironmentManifest;
}

function validEnvironmentGuarantees(value: unknown): boolean {
  return (
    isObject(value) &&
    ["none", "sandbox"].includes(String(value["filesystemIsolation"])) &&
    ["none", "enforced"].includes(String(value["networkPolicy"])) &&
    typeof value["processTreeTermination"] === "boolean" &&
    typeof value["scopedHttp"] === "boolean"
  );
}

/**
 * The provider-reported cost of one Task Attempt, from its latest usage report, or null when the
 * Attempt reported none.
 */
export function taskAttemptReportedCost(
  attempt: TaskAttempt,
  events: readonly TaskEvent[],
): NonNullable<ExecutionUsage["reportedCost"]> | null {
  return (
    attemptUsage(
      attempt,
      events
        .filter((event) => event.attemptId === attempt.id)
        .toSorted((a, b) => a.sequence - b.sequence),
    )?.reportedCost ?? null
  );
}

function attemptUsage(
  attempt: TaskAttempt | undefined,
  events: readonly TaskEvent[],
): ExecutionUsage | null {
  const usage = latestUsage(events);
  if (!usage || usage.reportedCost || !attempt) return usage;
  const execution = attempt.workerSnapshot?.["execution"];
  if (!isObject(execution) || execution["harness"] !== "codex") return usage;
  const model = execution["model"];
  if (typeof model !== "string" || model.length === 0) return usage;
  const reportedCost = estimatedCodexCost(model, usage);
  return reportedCost ? { ...usage, reportedCost } : usage;
}

function latestUsage(events: readonly TaskEvent[]): ExecutionUsage | null {
  for (const event of events.toReversed()) {
    if (event.type !== "execution.usage.updated" && event.type !== "usage.updated") continue;
    const usage = event.payload?.["usage"];
    if (
      isObject(usage) &&
      integer(usage["inputTokens"]) &&
      integer(usage["outputTokens"]) &&
      integer(usage["cachedInputTokens"]) &&
      integer(usage["totalTokens"]) &&
      typeof usage["complete"] === "boolean"
    )
      return usage as unknown as ExecutionUsage;
  }
  return null;
}

function nativeAgentPeak(events: readonly TaskEvent[]): number {
  const children = new Set<string>();
  const running = new Set<string>();
  let peak = 0;
  for (const event of events) {
    if (event.type !== "execution.agent.updated" && event.type !== "agent.updated") continue;
    const agent = event.payload?.["agent"];
    if (!isObject(agent) || typeof agent["id"] !== "string") continue;
    if (typeof agent["parentId"] === "string") children.add(agent["id"]);
    if (!children.has(agent["id"])) continue;
    if (agent["status"] === "running") running.add(agent["id"]);
    else running.delete(agent["id"]);
    peak = Math.max(peak, running.size);
  }
  return peak;
}

function requestedLimitsApplied(
  requested: RequestedLimits,
  applied: AppliedHarnessExecutionLimits | null,
): boolean {
  if (Object.keys(requested).length === 0) return true;
  if (applied === null) return false;
  return (
    (requested.maxNativeAgents === undefined ||
      (applied.maxNativeAgents !== undefined &&
        applied.maxNativeAgents.limit <= requested.maxNativeAgents)) &&
    (requested.maxReportedTokens === undefined ||
      (applied.maxReportedTokens !== undefined &&
        applied.maxReportedTokens.limit <= requested.maxReportedTokens)) &&
    (requested.maxReportedCost === undefined ||
      (applied.maxReportedCost !== undefined &&
        applied.maxReportedCost.limit.currency === requested.maxReportedCost.currency &&
        applied.maxReportedCost.limit.amountMinor <= requested.maxReportedCost.amountMinor))
  );
}

function nativeAgentThreshold(
  requested: RequestedLimits,
  applied: AppliedHarnessExecutionLimits | null,
  peak: number,
  terminal: boolean,
): boolean | null {
  if (requested.maxNativeAgents === undefined && applied?.maxNativeAgents === undefined)
    return null;
  const limit = applied?.maxNativeAgents?.limit;
  if (limit === undefined) return null;
  if (peak > limit || (limit > 0 && peak === limit)) return true;
  return terminal ? false : null;
}

function tokenThreshold(
  requested: RequestedLimits,
  applied: AppliedHarnessExecutionLimits | null,
  usage: ExecutionUsage | null,
  terminal: boolean,
): boolean | null {
  if (requested.maxReportedTokens === undefined && applied?.maxReportedTokens === undefined)
    return null;
  const limit = applied?.maxReportedTokens?.limit;
  if (limit === undefined || usage === null) return null;
  if (usage.totalTokens >= limit) return true;
  return terminal && usage?.complete === true ? false : null;
}

function costThreshold(
  requested: RequestedLimits,
  applied: AppliedHarnessExecutionLimits | null,
  usage: ExecutionUsage | null,
  terminal: boolean,
): boolean | null {
  if (requested.maxReportedCost === undefined && applied?.maxReportedCost === undefined)
    return null;
  const limit = applied?.maxReportedCost?.limit;
  const observed = usage?.reportedCost;
  if (limit === undefined || observed === undefined || observed.currency !== limit.currency)
    return null;
  if (observed.amountMinor >= limit.amountMinor) return true;
  return terminal && usage?.complete === true ? false : null;
}

function isObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function integer(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}
