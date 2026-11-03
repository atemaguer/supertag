import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { pathToFileURL } from "node:url";
import { type MountManifest, mountManifestDigest } from "@supertag/core";
import { openEnvironmentMcpBridge } from "./environment-mcp-bridge.js";
import { validateHarnessSessionCapabilities } from "./harness-resolution.js";
import type {
  CapabilityIdentifier,
  EnvironmentPlan,
  ExecutionContext,
  ExecutionEnvironment,
  ExecutionEnvironmentProvider,
  ExecutionEnvironmentSpec,
  Harness,
  HarnessCapabilities,
  HarnessEvent,
  HarnessPlan,
  RuntimeInput,
  TaskAttemptEvent,
  TaskAttemptSpec,
  ToolAdapter,
  ToolInput,
  ToolInvocationRequest,
  ToolInvoker,
  Worker,
  WorkerDescriptor,
} from "./index.js";
import {
  normalizeTaskProgress,
  validateHarnessExecutionLimitCapabilities,
  validateHarnessResolution,
} from "./index.js";
import type { VolumeResolver } from "./volume-copy.js";

import {
  type FinalizedWork,
  type GitObjects,
  type PreparedWorkspace,
  PreparedWorkspaceCache,
  preparedWorkspaceDigest,
  type TaskCheckout,
  type WorkspaceDefinition,
  type WorkspaceEnvironment,
} from "./workspace-environment.js";

const EVENT_STREAM_CAPABILITY = "supertag.task-attempt.events";
const CANCELLATION_CAPABILITY = "supertag.task-attempt.cancellation";

export interface ConformanceFinding {
  readonly code: string;
  readonly message: string;
}

export interface ConformanceReport {
  readonly subject: string;
  readonly passed: boolean;
  readonly findings: readonly ConformanceFinding[];
}

export interface WorkerConformanceOptions {
  readonly worker: Worker;
  /** A valid Attempt for one profile advertised by the Worker. */
  readonly attempt: TaskAttemptSpec;
  /** Optional invalid/unsupported Attempt that must end in execution.failed. */
  readonly failureAttempt?: TaskAttemptSpec;
  /** A separate fixture that remains live after runtime-inputs.resolved or an output event.
   * The probe cancels at that boundary and waits for terminal failure and iterator cleanup.
   */
  readonly liveCancellationAttempt?: TaskAttemptSpec;
  /** Defaults to 2 seconds per cancellation/cleanup wait. */
  readonly cancellationTimeoutMs?: number;
}

export interface HarnessConformanceOptions {
  readonly providerCapabilities?: readonly CapabilityIdentifier[];
  readonly harness: Harness;
  readonly context: ExecutionContext;
  readonly executionEnvironment: ExecutionEnvironment;
  /** Assert the input kinds the implementation intends to support. */
  readonly expectedInputKinds?: readonly RuntimeInput["kind"][];
  /** Exercise a second execution with an already-aborted signal. */
  readonly verifyCancellation?: boolean;
  readonly cancellationTimeoutMs?: number;
}

export interface EnvironmentConformanceOptions {
  readonly provider: ExecutionEnvironmentProvider;
  readonly spec: ExecutionEnvironmentSpec;
  readonly expectedPlacement?: ExecutionEnvironment["placement"];
}

export interface ToolAdapterConformanceOptions<TAdapted> {
  readonly adapter: ToolAdapter<TAdapted>;
  readonly input: ToolInput;
  readonly harnessId: string;
}

export interface ToolInvokerConformanceOptions {
  readonly invoker: ToolInvoker;
  readonly input: ToolInput;
  readonly request: ToolInvocationRequest;
}

/** Throws one compact error suitable for any JavaScript test runner. */
export function assertConformance(report: ConformanceReport): void {
  if (report.passed) return;
  const details = report.findings
    .map((finding) => `- [${finding.code}] ${finding.message}`)
    .join("\n");
  throw new Error(`${report.subject} failed conformance:\n${details}`);
}

export function validateWorkerDescriptor(descriptor: WorkerDescriptor): ConformanceReport {
  const findings: ConformanceFinding[] = [];
  const value = objectRecord(descriptor);
  if (!value)
    return makeReport("Worker <unknown>", [
      { code: "worker.descriptor.shape", message: "Worker descriptor must be an object" },
    ]);
  requireText(findings, "worker.descriptor.id", value["id"], "Worker id");
  requireText(findings, "worker.descriptor.type", value["type"], "Worker type");
  const profiles = Array.isArray(value["profiles"]) ? value["profiles"] : [];
  if (profiles.length === 0)
    add(findings, "worker.descriptor.profiles.empty", "Worker must advertise at least one profile");
  const profileKeys: string[] = [];
  for (const profile of profiles) {
    const record = objectRecord(profile);
    requireText(findings, "worker.descriptor.profile.id", record?.["id"], "Worker profile id");
    requireText(
      findings,
      "worker.descriptor.profile.revision",
      record?.["revision"],
      "Worker profile revision",
    );
    if (record) profileKeys.push(JSON.stringify([record["id"], record["revision"]]));
  }
  for (const key of duplicateValues(profileKeys))
    add(findings, "worker.descriptor.profiles.duplicate", `Duplicate Worker profile ${key}`);
  validateDescriptorCapabilities(findings, value["capabilities"], "worker.descriptor");
  validateDescriptorContextTypes(findings, value["contextTypes"], "worker.descriptor");
  const overrides = value["profileCapabilities"];
  if (!Array.isArray(overrides))
    add(
      findings,
      "worker.descriptor.profile-capabilities.shape",
      "profileCapabilities must be an array",
    );
  else {
    const keys: string[] = [];
    for (const entry of overrides) {
      const record = objectRecord(entry),
        profile = objectRecord(record?.["profile"]);
      if (!record || !profile) {
        add(
          findings,
          "worker.descriptor.profile-capabilities.shape",
          "Each profileCapabilities entry must contain a profile object",
        );
        continue;
      }
      requireText(
        findings,
        "worker.descriptor.profile-capabilities.profile.id",
        profile["id"],
        "Capability profile id",
      );
      requireText(
        findings,
        "worker.descriptor.profile-capabilities.profile.revision",
        profile["revision"],
        "Capability profile revision",
      );
      const key = JSON.stringify([profile["id"], profile["revision"]]);
      keys.push(key);
      if (!profileKeys.includes(key))
        add(
          findings,
          "worker.descriptor.profile-capabilities.unknown",
          `Capabilities reference an unadvertised profile ${key}`,
        );
      validateDescriptorCapabilities(
        findings,
        record["capabilities"],
        "worker.descriptor.profile-capabilities",
      );
      validateDescriptorContextTypes(
        findings,
        record["contextTypes"],
        "worker.descriptor.profile-capabilities",
      );
    }
    for (const key of duplicateValues(keys))
      add(
        findings,
        "worker.descriptor.profile-capabilities.duplicate",
        `Duplicate capability entry for profile ${key}`,
      );
    // A missing entry intentionally makes that profile ineligible. Do not fall
    // back to Worker-wide declarations when this explicit map is present.
  }
  if (value["maxConcurrency"] !== undefined && (value["maxConcurrency"] as number) < 1)
    add(
      findings,
      "worker.descriptor.max-concurrency",
      "Worker maxConcurrency must be at least one",
    );
  return makeReport(
    `Worker ${typeof value["id"] === "string" && value["id"] ? value["id"] : "<unknown>"}`,
    findings,
  );
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
function validateDescriptorCapabilities(
  findings: ConformanceFinding[],
  value: unknown,
  prefix: string,
): void {
  if (!Array.isArray(value)) {
    add(findings, `${prefix}.capabilities.shape`, "Capabilities must be an array");
    return;
  }
  const keys: string[] = [];
  let eventStream = false;
  for (const entry of value) {
    const record = objectRecord(entry);
    requireText(findings, `${prefix}.capability.id`, record?.["id"], "Capability id");
    const version = record?.["version"];
    if (!Number.isInteger(version) || (version as number) < 1)
      add(
        findings,
        `${prefix}.capability.version`,
        "Capability must have a positive integer version",
      );
    if (record) {
      keys.push(JSON.stringify([record["id"], version]));
      if (record["id"] === EVENT_STREAM_CAPABILITY) eventStream = true;
    }
  }
  for (const key of duplicateValues(keys))
    add(findings, `${prefix}.capabilities.duplicate`, `Duplicate capability ${key}`);
  if (!eventStream)
    add(
      findings,
      `${prefix}.capabilities.event-stream`,
      `Worker must advertise ${EVENT_STREAM_CAPABILITY}`,
    );
}
function validateDescriptorContextTypes(
  findings: ConformanceFinding[],
  value: unknown,
  prefix: string,
): void {
  if (!Array.isArray(value)) {
    add(findings, `${prefix}.context-types.shape`, "Context types must be an array");
    return;
  }
  const keys: string[] = [];
  for (const entry of value) {
    const record = objectRecord(entry),
      versions = record?.["versions"];
    requireText(findings, `${prefix}.context-type.type`, record?.["type"], "Context type");
    if (
      !Array.isArray(versions) ||
      versions.length === 0 ||
      versions.some((version) => !Number.isInteger(version) || version < 1)
    )
      add(
        findings,
        `${prefix}.context-type.versions`,
        "Context types must advertise positive integer versions",
      );
    if (Array.isArray(versions))
      for (const version of versions) keys.push(JSON.stringify([record?.["type"], version]));
  }
  for (const key of duplicateValues(keys))
    add(findings, `${prefix}.context-types.duplicate`, `Duplicate Context type ${key}`);
}

export function validateTaskAttemptEvents(
  events: readonly TaskAttemptEvent[],
  attempt: TaskAttemptSpec,
): ConformanceReport {
  const findings: ConformanceFinding[] = [];
  if (events.length === 0) {
    add(findings, "worker.events.empty", "Worker emitted no Task Attempt events");
    return makeReport(`Task Attempt ${attempt.attemptId}`, findings);
  }

  events.forEach((event, index) => {
    if (event.taskId !== attempt.taskId || event.attemptId !== attempt.attemptId) {
      add(
        findings,
        "worker.events.identity",
        `Event ${index} does not preserve the Task and Attempt identity`,
      );
    }
    if (Number.isNaN(Date.parse(event.at))) {
      add(findings, "worker.events.timestamp", `Event ${index} has an invalid timestamp`);
    }
    if (index > 0) {
      const prior = events[index - 1];
      if (prior !== undefined && Date.parse(event.at) < Date.parse(prior.at)) {
        add(
          findings,
          "worker.events.timestamp-order",
          `Event ${index} has a timestamp earlier than the preceding event`,
        );
      }
    }
  });

  const starts = indexesOf(events, "execution.started");
  if (starts.length !== 1 || starts[0] !== 0) {
    add(
      findings,
      "worker.events.started",
      "A Worker must emit execution.started exactly once as its first event",
    );
  }
  const terminals = events
    .map((event, index) => ({ event, index }))
    .filter(
      ({ event }) => event.type === "execution.completed" || event.type === "execution.failed",
    );
  if (terminals.length !== 1) {
    add(
      findings,
      "worker.events.terminal-count",
      "A Worker must emit exactly one terminal execution event",
    );
  } else if (terminals[0]?.index !== events.length - 1) {
    add(
      findings,
      "worker.events.terminal-order",
      "The terminal execution event must be the final event",
    );
  }
  return makeReport(`Task Attempt ${attempt.attemptId}`, findings);
}

export async function runWorkerConformance(
  options: WorkerConformanceOptions,
): Promise<ConformanceReport> {
  const findings: ConformanceFinding[] = [];
  let descriptor: WorkerDescriptor;
  try {
    descriptor = await options.worker.describe();
  } catch (error) {
    add(findings, "worker.describe.threw", `describe() threw: ${errorMessage(error)}`);
    return makeReport("Worker", findings);
  }
  findings.push(...validateWorkerDescriptor(descriptor).findings);

  const profile = options.attempt.workerProfile;
  if (
    !descriptor.profiles.some(
      (candidate) => candidate.id === profile.id && candidate.revision === profile.revision,
    )
  ) {
    add(
      findings,
      "worker.profile.not-advertised",
      `The exercised profile ${profile.id}@${profile.revision} is not advertised by describe()`,
    );
  }

  const normalEvents = await collectWorkerEvents(
    options.worker,
    options.attempt,
    undefined,
    findings,
  );
  if (normalEvents !== undefined) {
    findings.push(...validateTaskAttemptEvents(normalEvents, options.attempt).findings);
  }

  if (options.failureAttempt !== undefined) {
    const failureEvents = await collectWorkerEvents(
      options.worker,
      options.failureAttempt,
      undefined,
      findings,
    );
    if (failureEvents !== undefined) {
      findings.push(...validateTaskAttemptEvents(failureEvents, options.failureAttempt).findings);
      if (failureEvents.at(-1)?.type !== "execution.failed") {
        add(
          findings,
          "worker.failure.terminal",
          "The supplied failureAttempt did not end in execution.failed",
        );
      }
    }
  }

  if (descriptor.capabilities.some((capability) => capability.id === CANCELLATION_CAPABILITY)) {
    const controller = new AbortController();
    controller.abort(new Error("SuperTag conformance cancellation probe"));
    const cancellationEvents = await collectWorkerEvents(
      options.worker,
      options.attempt,
      controller.signal,
      findings,
      options.cancellationTimeoutMs ?? 2_000,
    );
    if (cancellationEvents !== undefined) {
      findings.push(...validateTaskAttemptEvents(cancellationEvents, options.attempt).findings);
      if (cancellationEvents.at(-1)?.type !== "execution.failed") {
        add(
          findings,
          "worker.cancellation.not-honored",
          `Worker advertises ${CANCELLATION_CAPABILITY} but completed an already-aborted Attempt`,
        );
      }
    }
  }
  if (options.liveCancellationAttempt !== undefined) {
    const controller = new AbortController();
    try {
      const events = await collectWorkerEvents(
        options.worker,
        options.liveCancellationAttempt,
        controller.signal,
        findings,
        options.cancellationTimeoutMs ?? 2_000,
        (event) => {
          if (["runtime-inputs.resolved", "output.delta", "output.message"].includes(event.type))
            controller.abort(new Error("SuperTag live cancellation probe"));
        },
      );
      if (!controller.signal.aborted)
        add(
          findings,
          "worker.cancellation.no-live-boundary",
          "Live cancellation fixture must publish resolved inputs or output before waiting",
        );
      if (events !== undefined) {
        findings.push(
          ...validateTaskAttemptEvents(events, options.liveCancellationAttempt).findings,
        );
        if (events.at(-1)?.type !== "execution.failed")
          add(
            findings,
            "worker.cancellation.live-not-honored",
            "Live cancellation did not terminate with execution.failed",
          );
      }
    } finally {
      controller.abort(new Error("SuperTag live cancellation probe ended"));
    }
  }
  return makeReport(`Worker ${descriptor.id || "<unknown>"}`, findings);
}

export function validateHarnessCapabilities(
  harness: Harness,
  capabilities: HarnessCapabilities,
  expectedInputKinds?: readonly RuntimeInput["kind"][],
): ConformanceReport {
  const findings: ConformanceFinding[] = [];
  try {
    validateHarnessExecutionLimitCapabilities(capabilities);
  } catch (error) {
    add(findings, "harness.capabilities.execution-limits", errorMessage(error));
  }
  try {
    validateHarnessSessionCapabilities(capabilities);
  } catch (error) {
    add(findings, "harness.capabilities.sessions", errorMessage(error));
  }
  requireText(findings, "harness.capabilities.id", capabilities.id, "Harness capability id");
  requireText(findings, "harness.capabilities.version", capabilities.version, "Harness version");
  if (capabilities.id !== harness.id) {
    add(
      findings,
      "harness.capabilities.identity",
      `Harness id ${harness.id} does not match described id ${capabilities.id}`,
    );
  }
  for (const kind of duplicateValues(capabilities.inputKinds)) {
    add(findings, "harness.capabilities.input-duplicate", `Duplicate input ${kind}`);
  }
  for (const placement of duplicateValues(capabilities.runtimePlacements ?? [])) {
    add(findings, "harness.capabilities.placement-duplicate", `Duplicate placement ${placement}`);
  }
  if (expectedInputKinds !== undefined) {
    const expected = new Set(expectedInputKinds);
    const actual = new Set(capabilities.inputKinds);
    for (const kind of expected) {
      if (!actual.has(kind)) {
        add(
          findings,
          "harness.capabilities.input-missing",
          `Harness does not declare expected input kind ${kind}`,
        );
      }
    }
    for (const kind of actual) {
      if (!expected.has(kind)) {
        add(
          findings,
          "harness.capabilities.input-unexpected",
          `Harness declares unexpected input kind ${kind}`,
        );
      }
    }
  }
  return makeReport(`Harness ${harness.id}`, findings);
}

export function validateHarnessEvents(
  events: readonly HarnessEvent[],
  capabilities: HarnessCapabilities,
): ConformanceReport {
  const findings: ConformanceFinding[] = [];
  if (!capabilities.streaming && events.some((event) => event.type === "output.delta")) {
    add(
      findings,
      "harness.capabilities.streaming",
      "Harness emitted output.delta while declaring streaming=false",
    );
  }

  const openCalls = new Set<string>();
  for (const event of events) {
    if (event.type === "progress.updated") {
      try {
        normalizeTaskProgress(event.progress);
      } catch (error) {
        add(
          findings,
          "harness.progress.invalid",
          error instanceof Error ? error.message : String(error),
        );
      }
    }
    if (event.type === "tool.call.started") {
      if (openCalls.has(event.call.id)) {
        add(
          findings,
          "harness.tools.duplicate-start",
          `Tool call ${event.call.id} was started more than once`,
        );
      }
      openCalls.add(event.call.id);
    }
    if (event.type === "tool.call.completed" || event.type === "tool.call.failed") {
      if (!openCalls.delete(event.call.id)) {
        add(
          findings,
          "harness.tools.terminal-without-start",
          `Tool call ${event.call.id} ended without a matching start`,
        );
      }
    }
  }
  for (const callId of openCalls) {
    add(findings, "harness.tools.unfinished", `Tool call ${callId} has no terminal event`);
  }
  return makeReport(`Harness ${capabilities.id}`, findings);
}

export async function runHarnessConformance(
  options: HarnessConformanceOptions,
): Promise<ConformanceReport> {
  const findings: ConformanceFinding[] = [];
  let capabilities: HarnessCapabilities;
  try {
    capabilities = await conformanceOperation(() => options.harness.describe());
  } catch (error) {
    add(findings, "harness.describe.threw", `describe() threw: ${errorMessage(error)}`);
    return makeReport(`Harness ${options.harness.id}`, findings);
  }
  findings.push(
    ...validateHarnessCapabilities(options.harness, capabilities, options.expectedInputKinds)
      .findings,
  );
  if (
    capabilities.runtimePlacements !== undefined &&
    !capabilities.runtimePlacements.includes(options.executionEnvironment.placement)
  ) {
    add(
      findings,
      "harness.capabilities.placement",
      `Harness does not declare support for the exercised ${options.executionEnvironment.placement} placement`,
    );
  }

  let plan: HarnessPlan;
  try {
    plan = await conformanceOperation(() => options.harness.plan(options.context));
  } catch (error) {
    add(findings, "harness.plan.threw", `plan() threw: ${errorMessage(error)}`);
    return makeReport(`Harness ${options.harness.id}`, findings);
  }
  if (options.harness.resolve) {
    const resolve = options.harness.resolve.bind(options.harness);
    try {
      const resolved = await conformanceOperation(() =>
        resolve({
          context: options.context,
          environments: {
            runtime: options.executionEnvironment,
            execution: options.executionEnvironment,
          },
          plan,
        }),
      );
      validateHarnessResolution(
        capabilities,
        resolved,
        options.executionEnvironment,
        options.providerCapabilities ?? [],
      );
      capabilities = resolved.capabilities;
    } catch (error) {
      add(findings, "harness.resolve.threw", `resolve() threw: ${errorMessage(error)}`);
      return makeReport(`Harness ${options.harness.id}`, findings);
    }
  }
  const events = await executeHarness(
    options.harness,
    plan,
    options.executionEnvironment,
    options.context,
    undefined,
    findings,
  );
  if (events !== undefined) {
    findings.push(...validateHarnessEvents(events, capabilities).findings);
  }

  if (options.verifyCancellation === true && capabilities.cancellation) {
    const controller = new AbortController();
    controller.abort(new Error("SuperTag conformance cancellation probe"));
    const cancelledEvents = await executeHarness(
      options.harness,
      plan,
      options.executionEnvironment,
      options.context,
      controller.signal,
      findings,
      options.cancellationTimeoutMs ?? 2_000,
      true,
    );
    if (cancelledEvents !== undefined && cancelledEvents.length > 0) {
      add(
        findings,
        "harness.cancellation.not-honored",
        "Harness emitted events after receiving an already-aborted signal",
      );
    }
  }
  return makeReport(`Harness ${options.harness.id}`, findings);
}

/**
 * Exercises provisioning, preparation, advertised placement, and cleanup.
 * Environment provisioning has no shared timeout contract; callers must configure
 * their test runner deadline and provider cleanup for the exercised environment.
 */
export async function runEnvironmentConformance(
  options: EnvironmentConformanceOptions,
): Promise<ConformanceReport> {
  const findings: ConformanceFinding[] = [];
  requireText(findings, "environment.provider.id", options.provider.id, "Environment provider id");
  for (const duplicate of duplicateValues(
    options.provider.capabilities.map((capability) => `${capability.id}@${capability.version}`),
  )) {
    add(findings, "environment.provider.capability-duplicate", `Duplicate capability ${duplicate}`);
  }

  let environment: ExecutionEnvironment | undefined;
  try {
    environment = await options.provider.provision(options.spec);
    requireText(findings, "environment.id", environment.id, "Environment id");
    requireText(
      findings,
      "environment.root",
      environment.rootDirectory,
      "Environment root directory",
    );
    if (
      options.expectedPlacement !== undefined &&
      environment.placement !== options.expectedPlacement
    ) {
      add(
        findings,
        "environment.placement",
        `Expected ${options.expectedPlacement} placement, received ${environment.placement}`,
      );
    }
    await environment.prepare(options.spec.plan);
  } catch (error) {
    add(
      findings,
      "environment.lifecycle.threw",
      `Environment lifecycle threw: ${errorMessage(error)}`,
    );
  } finally {
    if (environment !== undefined) {
      try {
        await environment.dispose(findings.length === 0 ? "completed" : "failed");
      } catch (error) {
        add(findings, "environment.dispose.threw", `dispose() threw: ${errorMessage(error)}`);
      }
    }
  }
  return makeReport(`Environment provider ${options.provider.id || "<unknown>"}`, findings);
}

/**
 * The repository {@link runWorkspaceEnvironmentConformance} builds for a provider. `main` holds
 * the trusted commit, whose `setup.sh` writes `prepared.txt` (ignored by git). `task` is a Task
 * branch commit on top of it whose `setup.sh` would write `canary.txt`, and which adds
 * `task.txt`.
 */
export interface WorkspaceEnvironmentConformanceRepository {
  /** A non-bare repository on the host. */
  readonly path: string;
  /** Its `file:` URL. */
  readonly source: string;
  readonly workspace: string;
  readonly trusted: string;
  readonly task: string;
  /** Runs `setup.sh` in the checkout. */
  readonly setup: string;
}

/** A definition a provider must refuse, and the property its reason must name. */
export interface WorkspaceEnvironmentRefusalCase {
  readonly name: string;
  readonly definition: (supported: WorkspaceDefinition) => WorkspaceDefinition;
  readonly property: string;
}

/** One provider, set up against the conformance repository. */
export interface WorkspaceEnvironmentConformanceFixture {
  readonly environment: WorkspaceEnvironment;
  /**
   * The definition the Worker would build for a Task from the repository at a trusted commit.
   * `secret` is a host credential the Worker holds for this Workspace, such as the token a
   * selected MCP server's headers resolve to. Build the definition through the Worker's own path
   * with it in place; it must never reach `refuse`, `prepare`, or `start`.
   */
  define(input: {
    readonly taskId: string;
    readonly trustedCommit: string;
    readonly setup?: string;
    readonly secret: string;
  }): Promise<WorkspaceDefinition>;
  /** Objects `start` needs to reach `head`, for providers that start away from the host. */
  objects?(input: {
    readonly trustedCommit: string;
    readonly head: string;
  }): Promise<GitObjects | undefined>;
  /** Lands returned work on the host's Task branch, for providers whose `finalize` returns objects. */
  deliver?(branch: string, finalized: FinalizedWork): Promise<void>;
  /** Definitions this provider must refuse. */
  readonly refusals?: readonly WorkspaceEnvironmentRefusalCase[];
  /** Provider calls made so far, such as the SDK requests a fake records. `refuse` makes none. */
  providerCalls?(): number;
  /**
   * For providers whose `capabilities.mcpStdio` is `sandbox`: the Node.js command inside a Task
   * sandbox that runs the environment MCP bridge and the conformance stdio server. Default: `node`.
   */
  readonly nodeCommand?: string;
  /**
   * For providers that enforce a Task network policy: a setup command that writes `network.txt`
   * containing `reachable` only when it reaches the network, and a probe that reports whether a
   * started Task under network mode `none` can.
   */
  readonly network?: {
    readonly setup: string;
    reachable(environment: Awaited<ReturnType<WorkspaceEnvironment["start"]>>): Promise<boolean>;
  };
  /**
   * For providers that serve Workspace `copy` mounts: an absolute mount path outside the
   * checkout, and how to inspect a started Task's environment there. The suite copies a small
   * `file://` Volume, with a symbolic link that points outside it, into a Task at `path`.
   */
  readonly copyMount?: {
    readonly path: string;
    /** The text of the file at `relative` under `path`, or undefined when there is none. */
    read(
      environment: Awaited<ReturnType<WorkspaceEnvironment["start"]>>,
      relative: string,
    ): Promise<string | undefined>;
    /** True when anything at `relative` under `path` has a write permission bit set. */
    writable(
      environment: Awaited<ReturnType<WorkspaceEnvironment["start"]>>,
      relative: string,
    ): Promise<boolean>;
    /** True when anything exists at `relative` under `path`, including a symbolic link. */
    exists(
      environment: Awaited<ReturnType<WorkspaceEnvironment["start"]>>,
      relative: string,
    ): Promise<boolean>;
  };
  cleanup?(): Promise<void>;
}

export type WorkspaceEnvironmentConformanceFactory = (
  repository: WorkspaceEnvironmentConformanceRepository,
) => Promise<WorkspaceEnvironmentConformanceFixture>;

const CONFORMANCE_PLAN: EnvironmentPlan = {
  files: [],
  mounts: [],
  environmentVariables: {},
  secretBindings: [],
  network: { mode: "none" },
};

/**
 * Checks one Workspace environment provider against the design's properties: `prepare` sees only
 * the trusted commit; one definition prepares once and every input changes its digest; a host
 * credential never reaches `refuse`, `prepare`, or `start`; `start` checks out exactly `head` for
 * a new branch, an existing branch at that head, and a reviewed commit, and never another commit
 * when an existing branch is elsewhere; a
 * Task's writes to setup outputs never reach a later Task; `finalize` commits for every outcome,
 * skips ignored files, and commits nothing without changes; `refuse` names each unsupported
 * property before any provider call; where the provider enforces it, setup reaches the
 * network while the Task does not; and, where stdio MCP servers run in the sandbox, a server runs
 * from the trusted copy, so a Task's edits to `.mcp.json` or the server change nothing; and,
 * where the provider serves `copy` mounts, `start` copies a Volume read-only at the mount path,
 * outside the checkout and the prepared artifact, never follows a link out of it, refuses one
 * over its `maxBytes`, and records a manifest. Requires
 * `git` on the host, and Node.js in the sandbox for that last check. Runs against local here and
 * against provider fakes in CI.
 */
export async function runWorkspaceEnvironmentConformance(
  factory: WorkspaceEnvironmentConformanceFactory,
): Promise<ConformanceReport> {
  const findings: ConformanceFinding[] = [];
  const scratch = await mkdtemp(join(tmpdir(), "supertag-workspace-conformance-"));
  let fixture: WorkspaceEnvironmentConformanceFixture | undefined;
  const prepared: PreparedWorkspace[] = [];
  let subject = "Workspace environment <unknown>";
  try {
    const repository = await conformanceRepository(join(scratch, "source"));
    fixture = await factory(repository);
    const secret = `supertag-conformance-canary-${randomUUID()}`;
    // Every input `refuse`, `prepare`, and `start` receive, to check that `secret` never appears.
    const inputs: { readonly method: string; readonly text: string }[] = [];
    const environment = observedEnvironment(fixture.environment, (method, input) => {
      inputs.push({ method, text: JSON.stringify(input) ?? "" });
    });
    subject = `Workspace environment ${environment.provider || "<unknown>"}`;
    const cache = new PreparedWorkspaceCache({ root: join(scratch, "cache") });
    const capabilities = environment.capabilities;
    requireText(findings, "workspace.provider", environment.provider, "Provider name");
    for (const key of [
      "sharedPrepare",
      "setupOnHost",
      "declaredCheckouts",
      "devcontainer",
    ] as const)
      if (typeof capabilities[key] !== "boolean")
        add(findings, "workspace.capabilities", `capabilities.${key} must be a boolean`);
    if (capabilities.mcpStdio !== "host" && capabilities.mcpStdio !== "sandbox")
      add(findings, "workspace.capabilities", "capabilities.mcpStdio must be host or sandbox");
    if ((capabilities.mcpStdio === "sandbox") !== (environment.mcpDirectory !== undefined))
      add(
        findings,
        "workspace.capabilities",
        "mcpDirectory must be set exactly when capabilities.mcpStdio is sandbox",
      );

    const define = (taskId: string, setup: string | undefined = repository.setup) =>
      (fixture as WorkspaceEnvironmentConformanceFixture).define({
        taskId,
        trustedCommit: repository.trusted,
        ...(setup === undefined ? {} : { setup }),
        secret,
      });
    const checkout = async (
      taskId: string,
      input: { readonly base: string; readonly head: string },
    ): Promise<TaskCheckout> => {
      const objects = await fixture?.objects?.({
        trustedCommit: repository.trusted,
        head: input.head,
      });
      return {
        taskId,
        attemptId: `${taskId}-attempt`,
        branch: `supertag/conformance/${taskId}`,
        base: input.base,
        head: input.head,
        ...(objects === undefined ? {} : { objects }),
        plan: CONFORMANCE_PLAN,
      };
    };
    const prepare = async (definition: WorkspaceDefinition) => {
      const result = await cache.prepare(environment, definition);
      prepared.push(result.prepared);
      return result.prepared;
    };
    const commit = {
      message: "Conformance commit",
      author: { name: "SuperTag", email: "supertag@localhost" },
    };
    const absent = async (read: () => Promise<unknown>) =>
      read().then(
        () => false,
        () => true,
      );

    // refuse: a supported definition passes; each unsupported property is named, with no provider call.
    const supported = await define("refuse");
    const reason = environment.refuse(supported);
    if (reason !== undefined)
      add(
        findings,
        "workspace.refuse.supported",
        `refuse() refused a supported definition: ${reason}`,
      );
    for (const refusal of fixture.refusals ?? []) {
      const calls = fixture.providerCalls?.();
      const refused = environment.refuse(refusal.definition(supported));
      if (refused === undefined || !refused.includes(refusal.property))
        add(
          findings,
          "workspace.refuse.property",
          `refuse() for ${refusal.name} must name ${refusal.property}; returned ${refused ?? "undefined"}`,
        );
      if (calls !== undefined && fixture.providerCalls?.() !== calls)
        add(
          findings,
          "workspace.refuse.provider-call",
          `refuse() for ${refusal.name} called the provider`,
        );
    }

    // Digests: every input changes the digest.
    const digest = preparedWorkspaceDigest(environment, supported);
    const variations: [
      string,
      WorkspaceDefinition | undefined,
      Pick<WorkspaceEnvironment, "provider" | "base" | "capabilities">?,
    ][] = [
      ["source", { ...supported, source: `${supported.source}-other` }],
      ["trustedCommit", { ...supported, trustedCommit: repository.task }],
      ["setup", { ...supported, setup: `${supported.setup ?? ""} # changed` }],
      ["devcontainer", { ...supported, devcontainer: { image: "conformance:other" } }],
      ["mcp", { ...supported, mcp: { digest: "sha256:other", servers: [] } }],
      [
        "harness",
        { ...supported, harness: { commands: [...supported.harness.commands, "other"] } },
      ],
      ["harness install", { ...supported, harness: { ...supported.harness, install: "other" } }],
      [
        "provider base",
        undefined,
        { ...pickEnvironment(environment), base: `${environment.base ?? ""}-other` },
      ],
      ...(capabilities.sharedPrepare
        ? []
        : ([["taskId", { ...supported, taskId: "other" }]] as [string, WorkspaceDefinition][])),
    ];
    for (const [name, definition, provider] of variations)
      if (preparedWorkspaceDigest(provider ?? environment, definition ?? supported) === digest)
        add(
          findings,
          "workspace.digest.input",
          `Changing ${name} did not change the prepared digest`,
        );

    // Prepare sees only the trusted commit, and start checks out exactly a new branch's head.
    const first = await prepare(await define("first"));
    if (first.digest !== preparedWorkspaceDigest(environment, await define("first")))
      add(
        findings,
        "workspace.prepare.digest",
        "prepare() returned a digest other than the definition's",
      );
    if (first.trustedCommit !== repository.trusted || first.provider !== environment.provider)
      add(
        findings,
        "workspace.prepare.identity",
        "prepare() must record its provider and trusted commit",
      );
    const started = await environment.start(
      first,
      await checkout("first", { base: repository.trusted, head: repository.task }),
    );
    if ((await started.read("prepared.txt").catch(() => "")) !== "trusted\n")
      add(
        findings,
        "workspace.prepare.setup",
        "Setup from the trusted commit did not leave prepared.txt",
      );
    if (!(await absent(() => started.read("canary.txt"))))
      add(
        findings,
        "workspace.prepare.trusted-only",
        "Setup ran the Task branch's setup.sh: canary.txt exists",
      );
    if ((await started.read("task.txt").catch(() => "")) !== "task\n")
      add(
        findings,
        "workspace.start.head",
        "start() did not check out the Task head for a new branch",
      );

    // finalize: nothing to commit, then a change and an ignored file.
    const unchanged = await environment.finalize(started, commit);
    if (
      unchanged.committed ||
      unchanged.head !== repository.task ||
      unchanged.objects !== undefined
    )
      add(
        findings,
        "workspace.finalize.unchanged",
        "finalize() without changes must return the head, committed false, and no objects",
      );
    await started.prepare({
      ...CONFORMANCE_PLAN,
      files: [
        { path: "work.txt", content: "work\n" },
        { path: "debug.log", content: "ignored\n" },
        { path: "prepared.txt", content: "tampered\n" },
      ],
    });
    const changed = await environment.finalize(started, commit);
    if (!changed.committed || changed.head === repository.task)
      add(findings, "workspace.finalize.commit", "finalize() did not commit the Task's change");
    await fixture.deliver?.(`supertag/conformance/first`, changed);
    if (!capabilities.sharedPrepare) {
      await environment.evict(first);
      prepared.splice(prepared.indexOf(first), 1);
    }

    // An existing branch restarts at its head, without ignored files or a Task's setup-output writes.
    const again = capabilities.sharedPrepare ? first : await prepare(await define("first"));
    const resumed = await environment.start(
      again,
      await checkout("first", { base: repository.trusted, head: changed.head }),
    );
    if ((await resumed.read("work.txt").catch(() => "")) !== "work\n")
      add(
        findings,
        "workspace.start.existing-branch",
        "start() did not check out an existing branch's head",
      );
    if (!(await absent(() => resumed.read("debug.log"))))
      add(findings, "workspace.finalize.ignored", "finalize() committed a file git ignores");
    if ((await resumed.read("prepared.txt").catch(() => "")) !== "trusted\n")
      add(
        findings,
        "workspace.isolation",
        "A Task's write to a setup output reached a later start",
      );
    const resumedWork = await environment.finalize(resumed, commit);
    if (resumedWork.head !== changed.head || resumedWork.committed)
      add(
        findings,
        "workspace.start.existing-branch",
        "start() on an existing branch must reach exactly its head",
      );

    // A reviewed commit is checked out exactly, and measured from itself.
    const review = await prepare(await define("review"));
    const reviewed = await environment.start(
      review,
      await checkout("review", { base: repository.task, head: repository.task }),
    );
    const reviewWork = await environment.finalize(reviewed, commit);
    if (reviewWork.head !== repository.task || reviewWork.committed)
      add(
        findings,
        "workspace.start.review",
        "start() did not check out exactly the reviewed commit",
      );

    // One definition prepares once under concurrency; per-Task providers never prepare it concurrently.
    let calls = 0;
    let active = 0;
    let overlapped = false;
    const counting: WorkspaceEnvironment = {
      provider: environment.provider,
      ...(environment.base === undefined ? {} : { base: environment.base }),
      capabilities,
      refuse: (definition) => environment.refuse(definition),
      prepare: async (definition, signal) => {
        calls += 1;
        active += 1;
        overlapped ||= active > 1;
        try {
          return await environment.prepare(definition, signal);
        } finally {
          active -= 1;
        }
      },
      start: (artifact, task, signal) => environment.start(artifact, task, signal),
      finalize: (started, message, signal) => environment.finalize(started, message, signal),
      evict: (artifact) => environment.evict(artifact),
    };
    // A fresh cache, so a shared provider's earlier artifact for the same digest is not reused.
    const concurrentCache = new PreparedWorkspaceCache({ root: join(scratch, "cache-concurrent") });
    const concurrent = await define("concurrent");
    const results = await Promise.all([
      concurrentCache.prepare(counting, concurrent),
      concurrentCache.prepare(counting, concurrent),
    ]);
    for (const result of results)
      if (!prepared.some((item) => item.artifact === result.prepared.artifact))
        prepared.push(result.prepared);
    if (results[0].prepared.digest !== results[1].prepared.digest)
      add(
        findings,
        "workspace.prepare.concurrent",
        "Concurrent prepares of one definition returned different digests",
      );
    if (capabilities.sharedPrepare ? calls !== 1 : overlapped)
      add(
        findings,
        "workspace.prepare.concurrent",
        capabilities.sharedPrepare
          ? `One definition prepared ${calls} times under concurrent Tasks`
          : "One Task's definition was prepared concurrently",
      );

    // An existing branch elsewhere never moves start off `head`: it starts there or refuses.
    if (!capabilities.sharedPrepare) {
      await environment.evict(again);
      prepared.splice(prepared.indexOf(again), 1);
    }
    const elsewhere = capabilities.sharedPrepare ? first : await prepare(await define("first"));
    const stale = await environment
      .start(
        elsewhere,
        await checkout("first", { base: repository.trusted, head: repository.task }),
      )
      .catch(() => undefined);
    if (stale !== undefined) {
      const staleWork = await environment.finalize(stale, commit);
      if (staleWork.head !== repository.task || staleWork.committed)
        add(
          findings,
          "workspace.start.exact-head",
          "start() checked out an existing branch's head instead of the Task Attempt's head",
        );
    }

    // Network: setup reaches it at prepare; the Task under `none` does not.
    if (fixture.network !== undefined) {
      const networked = await prepare(await define("network", fixture.network.setup));
      const task = await environment.start(
        networked,
        await checkout("network", { base: repository.trusted, head: repository.trusted }),
      );
      if ((await task.read("network.txt").catch(() => "")).trim() !== "reachable")
        add(findings, "workspace.network.prepare", "Setup did not reach the network at prepare");
      if (await fixture.network.reachable(task))
        add(
          findings,
          "workspace.network.task",
          "A Task under network mode none reached the network",
        );
      await environment.finalize(task, commit);
    }
    // stdio MCP inside the sandbox: the server runs from the trusted copy, so the Task branch's
    // edits to .mcp.json and the server script change nothing.
    if (capabilities.mcpStdio === "sandbox" && environment.mcpDirectory !== undefined) {
      const directory = environment.mcpDirectory;
      const node = fixture.nodeCommand ?? "node";
      const base = await define("mcp");
      const artifact = await prepare({
        ...base,
        mcp: {
          digest: `sha256:${"c".repeat(64)}`,
          servers: [
            {
              name: "conformance",
              transport: "stdio",
              command: node,
              args: ["mcp-server.js"],
              env: {},
            },
          ],
        },
      });
      const task = await environment.start(
        artifact,
        await checkout("mcp", { base: repository.trusted, head: repository.task }),
      );
      const relativeToCheckout = posix.relative(task.rootDirectory, directory);
      if (
        !posix.isAbsolute(directory) ||
        relativeToCheckout === "" ||
        !relativeToCheckout.startsWith("..")
      )
        add(
          findings,
          "workspace.mcp.directory",
          `mcpDirectory ${directory} must be an absolute path outside the checkout`,
        );
      let tools: string[] = [];
      try {
        const bridge = await openEnvironmentMcpBridge(
          task,
          {
            server: {
              transport: "mcp-stdio",
              command: node,
              args: ["mcp-server.js"],
              cwd: directory,
            },
            listOnly: true,
          },
          { nodeCommand: node, timeoutMs: 30_000 },
        );
        tools = bridge.tools.map((tool) => String(tool["name"]));
        await bridge.close();
      } catch (error) {
        add(
          findings,
          "workspace.mcp.run",
          `The stdio server did not run from the trusted copy: ${errorMessage(error)}`,
        );
      }
      if (tools.length > 0 && (tools.length !== 1 || tools[0] !== "trusted_tool"))
        add(
          findings,
          "workspace.mcp.trusted-copy",
          `The stdio server ran from the Task's content: it advertised ${tools.join(", ")}`,
        );
      await environment.finalize(task, commit);
    }
    // Copy mounts: start copies the Volume after setup, read-only, outside the checkout and the
    // prepared artifact, without following a link out of it, and records its manifest.
    if (fixture.copyMount !== undefined) {
      const mount = fixture.copyMount;
      const volumeDirectory = join(scratch, "volume");
      await mkdir(join(volumeDirectory, "nested"), { recursive: true });
      await writeFile(join(volumeDirectory, "alpha.txt"), "alpha\n");
      await writeFile(join(volumeDirectory, "nested", "beta.txt"), "beta\n");
      await writeFile(join(scratch, "outside.txt"), `${secret}\n`);
      await symlink(join(scratch, "outside.txt"), join(volumeDirectory, "escape"));
      await symlink(scratch, join(volumeDirectory, "escape-directory"));
      let credentialReads = 0;
      const volumes: VolumeResolver = {
        resolve: async (volume) => ({
          volume,
          source: pathToFileURL(volumeDirectory).href,
          credentials: async () => {
            credentialReads += 1;
            return { accessKeyId: "unused", secretAccessKey: secret };
          },
        }),
      };
      const dataMount = {
        volume: "data",
        path: mount.path,
        access: "read-only",
        strategy: "copy",
      } as const;
      const mounts = [dataMount];
      const artifact = await prepare(await define("mount"));
      const copied = await environment.start(artifact, {
        ...(await checkout("mount", { base: repository.trusted, head: repository.trusted })),
        mounts,
        volumes,
      });
      if (
        (await mount.read(copied, "alpha.txt")) !== "alpha\n" ||
        (await mount.read(copied, "nested/beta.txt")) !== "beta\n"
      )
        add(findings, "workspace.mount.copy", "start() did not copy the Volume to the mount path");
      if ((await mount.writable(copied, "alpha.txt")) || (await mount.writable(copied, "nested")))
        add(findings, "workspace.mount.read-only", "A copied mount is writable");
      if (
        (await mount.exists(copied, "escape")) ||
        (await mount.exists(copied, "escape-directory"))
      )
        add(
          findings,
          "workspace.mount.symlink",
          "start() followed or recreated a symbolic link from the Volume",
        );
      const manifests = (copied as { readonly mountManifests?: readonly MountManifest[] })
        .mountManifests;
      const manifest = manifests?.[0];
      if (
        manifests?.length !== 1 ||
        manifest?.path !== mount.path ||
        manifest.objectCount !== 2 ||
        manifest.digest !== mountManifestDigest(manifest.source, manifest.objects) ||
        manifest.objects.some((object) => object.key.startsWith("escape"))
      )
        add(
          findings,
          "workspace.mount.manifest",
          "start() must record a manifest of exactly the copied files",
        );
      if (credentialReads !== 0)
        add(findings, "workspace.mount.credential", "start() read a credential for file://");
      if (!(await absent(() => copied.read("alpha.txt"))))
        add(findings, "workspace.mount.checkout", "A mount's content landed in the checkout");
      const mountWork = await environment.finalize(copied, commit);
      if (mountWork.committed)
        add(findings, "workspace.mount.checkout", "finalize() committed a mount's content");
      // A later Task from the same prepared artifact sees no earlier copy.
      const later = capabilities.sharedPrepare ? artifact : await prepare(await define("mount-2"));
      const fresh = await environment.start(
        later,
        await checkout(capabilities.sharedPrepare ? "mount" : "mount-2", {
          base: repository.trusted,
          head: repository.trusted,
        }),
      );
      if (await mount.exists(fresh, "alpha.txt"))
        add(
          findings,
          "workspace.mount.isolation",
          "A copy reached a later Task Attempt or the prepared artifact",
        );
      await environment.finalize(fresh, commit);
      // Size limits hold before anything is copied.
      const limitArtifact = capabilities.sharedPrepare
        ? artifact
        : await prepare(await define("mount-limit"));
      const limited = await environment
        .start(limitArtifact, {
          ...(await checkout(capabilities.sharedPrepare ? "mount" : "mount-limit", {
            base: repository.trusted,
            head: repository.trusted,
          })),
          mounts: [{ ...dataMount, maxBytes: 4 }],
          volumes,
        })
        .then(
          async (started) => {
            await environment.finalize(started, commit).catch(() => undefined);
            return "started";
          },
          (error: unknown) => errorMessage(error),
        );
      if (limited === "started" || !limited.includes("data"))
        add(
          findings,
          "workspace.mount.limit",
          `start() must refuse a Volume over the mount's maxBytes, naming it; got ${limited}`,
        );
    }
    for (const input of inputs)
      if (input.text.includes(secret))
        add(
          findings,
          "workspace.secret",
          `A host credential reached ${input.method}() in its input`,
        );
  } catch (error) {
    add(
      findings,
      "workspace.lifecycle.threw",
      `Workspace environment lifecycle threw: ${errorMessage(error)}`,
    );
  } finally {
    for (const artifact of prepared)
      await fixture?.environment
        .evict(artifact)
        .catch((error: unknown) =>
          add(findings, "workspace.evict.threw", `evict() threw: ${errorMessage(error)}`),
        );
    await fixture?.cleanup?.().catch(() => undefined);
    await rm(scratch, { recursive: true, force: true });
  }
  return makeReport(subject, findings);
}

/** The environment with every `refuse`, `prepare`, and `start` input reported first. */
function observedEnvironment(
  environment: WorkspaceEnvironment,
  observe: (method: string, input: unknown) => void,
): WorkspaceEnvironment {
  return {
    provider: environment.provider,
    ...(environment.base === undefined ? {} : { base: environment.base }),
    capabilities: environment.capabilities,
    ...(environment.mcpDirectory === undefined ? {} : { mcpDirectory: environment.mcpDirectory }),
    refuse: (definition) => {
      observe("refuse", definition);
      return environment.refuse(definition);
    },
    prepare: (definition, signal) => {
      observe("prepare", definition);
      return environment.prepare(definition, signal);
    },
    start: (artifact, task, signal) => {
      observe("start", { artifact, task });
      return environment.start(artifact, task, signal);
    },
    finalize: (started, message, signal) => environment.finalize(started, message, signal),
    evict: (artifact) => environment.evict(artifact),
  };
}

function pickEnvironment(
  environment: WorkspaceEnvironment,
): Pick<WorkspaceEnvironment, "provider" | "base" | "capabilities"> {
  return {
    provider: environment.provider,
    ...(environment.base === undefined ? {} : { base: environment.base }),
    capabilities: environment.capabilities,
  };
}

/** Builds the conformance repository with host config, hooks, and signing kept out. */
async function conformanceRepository(
  path: string,
): Promise<WorkspaceEnvironmentConformanceRepository> {
  const git = (...args: string[]) =>
    new Promise<string>((resolvePromise, reject) =>
      execFile(
        "git",
        ["-C", path, "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            GIT_CONFIG_GLOBAL: "/dev/null",
            GIT_CONFIG_NOSYSTEM: "1",
            GIT_AUTHOR_NAME: "SuperTag",
            GIT_AUTHOR_EMAIL: "supertag@localhost",
            GIT_COMMITTER_NAME: "SuperTag",
            GIT_COMMITTER_EMAIL: "supertag@localhost",
          },
        },
        (error, stdout) => (error ? reject(error) : resolvePromise(stdout.trim())),
      ),
    );
  await mkdir(path, { recursive: true });
  await git("init", "--quiet", "-b", "main");
  await writeFile(join(path, ".gitignore"), "prepared.txt\n*.log\nnetwork.txt\n");
  await writeFile(join(path, "README.md"), "# Conformance\n");
  await writeFile(join(path, "setup.sh"), "printf 'trusted\\n' > prepared.txt\n");
  await writeFile(join(path, "mcp-server.js"), conformanceMcpServer("trusted_tool"));
  await writeFile(join(path, ".mcp.json"), conformanceMcpJson("mcp-server.js"));
  await git("add", "-A");
  await git("commit", "--quiet", "-m", "Trusted");
  const trusted = await git("rev-parse", "HEAD");
  await git("checkout", "--quiet", "-b", "task");
  await writeFile(
    join(path, "setup.sh"),
    "printf 'hostile\\n' > canary.txt\nprintf 'hostile\\n' > prepared.txt\n",
  );
  await writeFile(join(path, "task.txt"), "task\n");
  await writeFile(join(path, "mcp-server.js"), conformanceMcpServer("task_tool"));
  await writeFile(join(path, ".mcp.json"), conformanceMcpJson("hostile.js"));
  await git("add", "-A");
  await git("commit", "--quiet", "-m", "Task");
  const task = await git("rev-parse", "HEAD");
  await git("checkout", "--quiet", "main");
  return {
    path,
    source: pathToFileURL(path).href,
    workspace: "conformance",
    trusted,
    task,
    setup: "sh setup.sh",
  };
}

/** A dependency-free stdio MCP server that advertises one tool, `name`. */
function conformanceMcpServer(name: string): string {
  return `const readline = require("node:readline");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  const result =
    message.method === "initialize"
      ? { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "conformance", version: "1" } }
      : message.method === "tools/list"
        ? { tools: [{ name: ${JSON.stringify(name)}, inputSchema: { type: "object" } }] }
        : { content: [{ type: "text", text: ${JSON.stringify(name)} }] };
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\\n");
});
`;
}

function conformanceMcpJson(script: string): string {
  return `${JSON.stringify({ mcpServers: { conformance: { command: "node", args: [script] } } }, null, 2)}\n`;
}

/** Verifies that a Tool Adapter accurately claims and adapts one binding. */
export async function runToolAdapterConformance<TAdapted>(
  options: ToolAdapterConformanceOptions<TAdapted>,
): Promise<ConformanceReport> {
  const findings: ConformanceFinding[] = [];
  requireText(findings, "tool.adapter.id", options.adapter.id, "Tool Adapter id");
  const context = { harnessId: options.harnessId };
  try {
    if (!options.adapter.supports(options.input, context)) {
      add(
        findings,
        "tool.adapter.unsupported",
        `Adapter does not support the supplied ${options.input.binding.kind} input`,
      );
    } else if ((await options.adapter.adapt(options.input, context)) === undefined) {
      add(findings, "tool.adapter.empty", "Adapter returned undefined for a supported tool");
    }
  } catch (error) {
    add(findings, "tool.adapter.threw", `adapt() threw: ${errorMessage(error)}`);
  }
  return makeReport(`Tool Adapter ${options.adapter.id || "<unknown>"}`, findings);
}

/** Verifies one Worker-managed tool invocation and its portable result envelope. */
export async function runToolInvokerConformance(
  options: ToolInvokerConformanceOptions,
): Promise<ConformanceReport> {
  const findings: ConformanceFinding[] = [];
  requireText(findings, "tool.invoker.id", options.invoker.id, "Tool Invoker id");
  try {
    if (!options.invoker.supports(options.input)) {
      add(
        findings,
        "tool.invoker.unsupported",
        `Invoker does not support the supplied ${options.input.binding.kind} input`,
      );
    } else {
      const result = await options.invoker.invoke(options.input, options.request);
      if (result.content === null || typeof result.content !== "object") {
        add(findings, "tool.invoker.result", "Invoker result content must be a JSON object");
      }
    }
  } catch (error) {
    add(findings, "tool.invoker.threw", `invoke() threw: ${errorMessage(error)}`);
  }
  return makeReport(`Tool Invoker ${options.invoker.id || "<unknown>"}`, findings);
}

async function collectWorkerEvents(
  worker: Worker,
  attempt: TaskAttemptSpec,
  signal: AbortSignal | undefined,
  findings: ConformanceFinding[],
  timeoutMs?: number,
  onEvent?: (event: TaskAttemptEvent) => void,
): Promise<readonly TaskAttemptEvent[] | undefined> {
  try {
    return await collect(worker.execute(attempt, signal), timeoutMs, onEvent);
  } catch (error) {
    add(findings, "worker.execute.threw", `execute() threw: ${errorMessage(error)}`);
    return undefined;
  }
}

async function executeHarness(
  harness: Harness,
  plan: HarnessPlan,
  executionEnvironment: ExecutionEnvironment,
  context: ExecutionContext,
  signal: AbortSignal | undefined,
  findings: ConformanceFinding[],
  timeoutMs?: number,
  cancellationProbe = false,
): Promise<readonly HarnessEvent[] | undefined> {
  let execution: Awaited<ReturnType<Harness["start"]>> | undefined;
  try {
    execution = await conformanceOperation(
      () =>
        harness.start(
          plan,
          { runtime: executionEnvironment, execution: executionEnvironment },
          context,
        ),
      timeoutMs,
    );
    return await collect(execution.run(signal), timeoutMs);
  } catch (error) {
    if (
      cancellationProbe &&
      signal?.aborted === true &&
      (error === signal.reason || (error instanceof Error && error.name === "AbortError"))
    )
      return [];
    add(findings, "harness.execution.threw", `Harness execution threw: ${errorMessage(error)}`);
    return undefined;
  } finally {
    // Each cleanup stage is attempted even if the preceding stage fails or stalls.
    for (const close of [() => execution?.control?.close(), () => execution?.close()]) {
      try {
        await conformanceOperation(close, timeoutMs);
      } catch (error) {
        add(findings, "harness.close.threw", `close() threw: ${errorMessage(error)}`);
      }
    }
  }
}

async function collect<T>(
  events: AsyncIterable<T>,
  timeoutMs?: number,
  onEvent?: (event: T) => void,
): Promise<readonly T[]> {
  const values: T[] = [];
  const iterator = events[Symbol.asyncIterator]();
  while (true) {
    const next =
      timeoutMs === undefined
        ? await iterator.next()
        : await withTimeout(iterator.next(), timeoutMs, iterator);
    if (next.done) return values;
    values.push(next.value);
    onEvent?.(next.value);
  }
}

async function withTimeout<T>(
  promise: Promise<IteratorResult<T>>,
  timeoutMs: number,
  iterator: AsyncIterator<T>,
): Promise<IteratorResult<T>> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`did not settle within ${timeoutMs}ms`)),
          timeoutMs,
        );
        timer.unref();
      }),
    ]);
  } catch (error) {
    // A non-cooperating iterator must fail conformance without hanging the verifier.
    let cleanupTimer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        Promise.resolve().then(() => iterator.return?.()),
        new Promise<never>((_, reject) => {
          cleanupTimer = setTimeout(
            () => reject(new Error(`Iterator cleanup did not settle within ${timeoutMs}ms`)),
            timeoutMs,
          );
          cleanupTimer.unref();
        }),
      ]);
    } catch (cleanupError) {
      throw new Error(
        `Iterator cleanup failed after ${errorMessage(error)}: ${errorMessage(cleanupError)}`,
      );
    } finally {
      if (cleanupTimer) clearTimeout(cleanupTimer);
    }
    throw error;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function indexesOf(events: readonly TaskAttemptEvent[], type: TaskAttemptEvent["type"]): number[] {
  return events.flatMap((event, index) => (event.type === type ? [index] : []));
}

function duplicateValues<T>(values: readonly T[]): T[] {
  const seen = new Set<T>();
  const duplicates = new Set<T>();
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    else seen.add(value);
  }
  return [...duplicates];
}

function requireText(
  findings: ConformanceFinding[],
  code: string,
  value: unknown,
  label: string,
): void {
  if (typeof value !== "string" || value.trim().length === 0)
    add(findings, code, `${label} must be nonempty text`);
}

function add(findings: ConformanceFinding[], code: string, message: string): void {
  findings.push({ code, message });
}

function makeReport(subject: string, findings: ConformanceFinding[]): ConformanceReport {
  return { subject, passed: findings.length === 0, findings };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Bounds verifier latency; a timed-out extension remains responsible for its resources. */
async function conformanceOperation<T>(
  operation: () => T | Promise<T>,
  timeoutMs = 5000,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`did not settle within ${timeoutMs}ms`)),
          timeoutMs,
        );
        timer.unref();
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
