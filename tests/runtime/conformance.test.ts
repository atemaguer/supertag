import { describe, expect, it } from "vitest";
import {
  emptyTagContextPlan,
  type TagAuthorizationSnapshot,
} from "../../packages/core/src/index.ts";
import {
  assertConformance,
  runEnvironmentConformance,
  runHarnessConformance,
  runToolAdapterConformance,
  runToolInvokerConformance,
  runWorkerConformance,
  validateTaskAttemptEvents,
  validateWorkerDescriptor,
} from "../../packages/runtime/sdk/src/conformance.ts";
import {
  type ExecutionContext,
  type ExecutionEnvironment,
  type ExecutionEnvironmentProvider,
  type Harness,
  type HarnessPlan,
  InMemorySessionStateStore,
  type SessionStateStore,
  TASK_ATTEMPT_CANCELLATION_CAPABILITY,
  TASK_ATTEMPT_EVENT_STREAM_CAPABILITY,
  type TaskAttemptEvent,
  type TaskAttemptSpec,
  type ToolAdapter,
  type ToolInput,
  type ToolInvoker,
  type Worker,
  type WorkerDescriptor,
} from "../../packages/runtime/sdk/src/index.ts";

describe("extension conformance kit", () => {
  const mixedDescriptor = (): WorkerDescriptor => ({
    id: "mixed",
    type: "custom",
    capabilities: [TASK_ATTEMPT_EVENT_STREAM_CAPABILITY],
    contextTypes: [],
    profiles: [
      { id: "coordinating", revision: "1" },
      { id: "plain", revision: "1" },
    ],
    profileCapabilities: [
      {
        profile: { id: "coordinating", revision: "1" },
        capabilities: [
          TASK_ATTEMPT_EVENT_STREAM_CAPABILITY,
          { id: "example.coordination", version: 1 },
        ],
        contextTypes: [{ type: "example.context", versions: [1, 2] }],
      },
      {
        profile: { id: "plain", revision: "1" },
        capabilities: [TASK_ATTEMPT_EVENT_STREAM_CAPABILITY],
        contextTypes: [],
      },
    ],
  });
  it("accepts profile-specific capabilities without promoting one profile's support", () => {
    expect(validateWorkerDescriptor(mixedDescriptor())).toMatchObject({
      passed: true,
      findings: [],
    });
  });
  it("requires profile maps and leaves profiles with missing entries unsupported", () => {
    const descriptor = mixedDescriptor();
    const { profileCapabilities, ...legacy } = descriptor;
    expect(validateWorkerDescriptor(legacy as WorkerDescriptor)).toMatchObject({
      passed: false,
      findings: [expect.objectContaining({ code: "worker.descriptor.profile-capabilities.shape" })],
    });
    expect(
      validateWorkerDescriptor({
        ...descriptor,
        profileCapabilities: profileCapabilities?.slice(0, 1),
      }).passed,
    ).toBe(true);
    expect(validateWorkerDescriptor({ ...descriptor, profileCapabilities: [] }).passed).toBe(true);
  });
  it("rejects duplicate and unadvertised profile capability entries", () => {
    const descriptor = mixedDescriptor();
    const first = descriptor.profileCapabilities?.[0];
    if (!first) throw new Error("Missing fixture profile");
    const report = validateWorkerDescriptor({
      ...descriptor,
      profileCapabilities: [
        first,
        first,
        { ...first, profile: { id: "unadvertised", revision: "1" } },
      ],
    });
    expect(report.passed).toBe(false);
    expect(report.findings.map((finding) => finding.code)).toEqual(
      expect.arrayContaining([
        "worker.descriptor.profile-capabilities.duplicate",
        "worker.descriptor.profile-capabilities.unknown",
      ]),
    );
  });
  it("reports malformed profile maps without throwing", () => {
    for (const profileCapabilities of [
      null,
      {},
      [null],
      ["invalid"],
      [{ profile: null }],
      [{ profile: { id: 1, revision: null }, capabilities: null, contextTypes: {} }],
    ]) {
      const descriptor = {
        ...mixedDescriptor(),
        profileCapabilities,
      } as unknown as WorkerDescriptor;
      expect(() => validateWorkerDescriptor(descriptor)).not.toThrow();
      expect(validateWorkerDescriptor(descriptor).passed).toBe(false);
    }
  });
  it("validates capability versions and context versions within each profile", () => {
    const descriptor = mixedDescriptor();
    const report = validateWorkerDescriptor({
      ...descriptor,
      profileCapabilities: [
        {
          profile: { id: "plain", revision: "1" },
          capabilities: [TASK_ATTEMPT_EVENT_STREAM_CAPABILITY, { id: "invalid", version: 0 }],
          contextTypes: [{ type: "context", versions: [0, 1, 1] }],
        },
      ],
    });
    expect(report.findings.map((finding) => finding.code)).toEqual(
      expect.arrayContaining([
        "worker.descriptor.profile-capabilities.capability.version",
        "worker.descriptor.profile-capabilities.context-type.versions",
        "worker.descriptor.profile-capabilities.context-types.duplicate",
      ]),
    );
    expect(report.passed).toBe(false);
  });
  it("requires the event protocol in each declared profile capability entry", () => {
    const descriptor = mixedDescriptor();
    const report = validateWorkerDescriptor({
      ...descriptor,
      profileCapabilities: [
        { profile: { id: "plain", revision: "1" }, capabilities: [], contextTypes: [] },
      ],
    });
    expect(report.findings.map((finding) => finding.code)).toContain(
      "worker.descriptor.profile-capabilities.capabilities.event-stream",
    );
  });
  it("compares profile identity as a tuple rather than an ambiguous delimiter", () => {
    const profiles = [
      { id: "a@b", revision: "c" },
      { id: "a", revision: "b@c" },
    ];
    expect(
      validateWorkerDescriptor({
        ...mixedDescriptor(),
        profiles,
        profileCapabilities: profiles.map((profile) => ({
          profile,
          capabilities: [TASK_ATTEMPT_EVENT_STREAM_CAPABILITY],
          contextTypes: [],
        })),
      }).passed,
    ).toBe(true);
  });

  it("accepts a Worker with a profile-addressed, terminal event lifecycle", async () => {
    const report = await runWorkerConformance({
      worker: conformingWorker(),
      attempt: taskAttemptSpec(),
      failureAttempt: taskAttemptSpec({ id: "missing", revision: "1" }),
    });

    expect(report).toEqual(expect.objectContaining({ passed: true, findings: [] }));
    expect(() => assertConformance(report)).not.toThrow();
  });

  it("reports descriptor, identity, ordering, and cancellation contract violations", async () => {
    const worker: Worker = {
      describe: async () => ({
        profileCapabilities: [
          {
            profile: profileRef,
            capabilities: [
              TASK_ATTEMPT_EVENT_STREAM_CAPABILITY,
              TASK_ATTEMPT_EVENT_STREAM_CAPABILITY,
              TASK_ATTEMPT_CANCELLATION_CAPABILITY,
            ],
            contextTypes: [],
          },
          {
            profile: profileRef,
            capabilities: [
              TASK_ATTEMPT_EVENT_STREAM_CAPABILITY,
              TASK_ATTEMPT_EVENT_STREAM_CAPABILITY,
              TASK_ATTEMPT_CANCELLATION_CAPABILITY,
            ],
            contextTypes: [],
          },
        ],
        id: "broken",
        type: "custom",
        capabilities: [
          TASK_ATTEMPT_EVENT_STREAM_CAPABILITY,
          TASK_ATTEMPT_EVENT_STREAM_CAPABILITY,
          TASK_ATTEMPT_CANCELLATION_CAPABILITY,
        ],
        profiles: [profileRef, profileRef],
        contextTypes: [],
      }),
      async *execute(spec) {
        yield event(spec, "output.message", {
          message: { role: "teammate", text: "out of order" },
        });
        yield event(spec, "execution.completed");
        yield event(spec, "output.delta", { text: "after terminal" });
      },
    };

    const report = await runWorkerConformance({ worker, attempt: taskAttemptSpec() });
    const codes = report.findings.map((finding) => finding.code);

    expect(report.passed).toBe(false);
    expect(codes).toEqual(
      expect.arrayContaining([
        "worker.descriptor.profiles.duplicate",
        "worker.descriptor.capabilities.duplicate",
        "worker.events.started",
        "worker.events.terminal-order",
        "worker.cancellation.not-honored",
      ]),
    );
    expect(() => assertConformance(report)).toThrow(/failed conformance/u);
  });

  it("validates a Harness declaration and a balanced tool lifecycle", async () => {
    const harness: Harness = {
      id: "example",
      describe: async () => ({
        sessions: { resume: false, export: false, scope: "none" as const },
        id: "example",
        version: "1.0.0",
        inputKinds: ["skill", "tool"],
        streaming: true,
        cancellation: true,
        sessionPersistence: "none",
        runtimePlacements: ["local"],
      }),
      plan: async () => emptyPlan,
      start: async () => ({
        async *run(signal) {
          if (signal?.aborted === true) return;
          yield { type: "tool.call.started" as const, call: toolCall };
          yield { type: "output.delta" as const, text: "working" };
          yield { type: "tool.call.completed" as const, call: toolCall };
          yield { type: "output.message" as const, text: "done" };
        },
        async close() {},
      }),
    };

    const report = await runHarnessConformance({
      harness,
      context: executionContext(),
      executionEnvironment: environment,
      expectedInputKinds: ["skill", "tool"],
      verifyCancellation: true,
    });

    expect(report).toEqual(expect.objectContaining({ passed: true, findings: [] }));
  });

  it("reports inaccurate Harness declarations and malformed tool events", async () => {
    const harness: Harness = {
      id: "implementation-id",
      describe: async () => ({
        sessions: { resume: false, export: false, scope: "none" as const },
        id: "described-id",
        version: "1",
        inputKinds: ["tool", "tool"],
        streaming: false,
        cancellation: false,
        sessionPersistence: "none",
      }),
      plan: async () => emptyPlan,
      start: async () => ({
        async *run() {
          yield { type: "output.delta" as const, text: "undeclared streaming" };
          yield { type: "tool.call.started" as const, call: toolCall };
        },
        async close() {},
      }),
    };

    const report = await runHarnessConformance({
      harness,
      context: executionContext(),
      executionEnvironment: environment,
      expectedInputKinds: ["skill"],
    });

    expect(report.findings.map((finding) => finding.code)).toEqual(
      expect.arrayContaining([
        "harness.capabilities.identity",
        "harness.capabilities.input-duplicate",
        "harness.capabilities.input-missing",
        "harness.capabilities.input-unexpected",
        "harness.capabilities.streaming",
        "harness.tools.unfinished",
      ]),
    );
  });

  it("exposes event validation separately for protocol fixture tests", () => {
    const spec = taskAttemptSpec();
    const report = validateTaskAttemptEvents(
      [event(spec, "execution.started", { workerId: "worker-1" }), event(spec, "execution.failed")],
      spec,
    );

    expect(report.passed).toBe(true);
  });

  it("verifies environment provisioning, preparation, placement, and cleanup", async () => {
    let disposed = false;
    const provider: ExecutionEnvironmentProvider = {
      id: "example-environment",
      capabilities: [{ id: "example.process", version: 1 }],
      async provision() {
        return {
          ...environment,
          dispose: async () => {
            disposed = true;
          },
        };
      },
    };

    const report = await runEnvironmentConformance({
      provider,
      spec: { task: taskAttemptSpec(), profile: executionContext().profile, plan: emptyPlan },
      expectedPlacement: "local",
    });

    expect(report.passed).toBe(true);
    expect(disposed).toBe(true);
  });

  it("verifies tool adapters and Worker-managed invokers", async () => {
    const input = nativeTool();
    const adapter: ToolAdapter<{ readonly adapter: string }> = {
      id: "native-adapter",
      supports: (candidate) => candidate.binding.kind === "native",
      adapt: () => ({ adapter: "example" }),
    };
    const invoker: ToolInvoker = {
      id: "native-invoker",
      supports: (candidate) => candidate.binding.kind === "native",
      invoke: async () => ({ content: { ok: true } }),
    };

    await expect(
      runToolAdapterConformance({ adapter, input, harnessId: "example" }),
    ).resolves.toMatchObject({ passed: true });
    await expect(
      runToolInvokerConformance({
        invoker,
        input,
        request: {
          id: "call-1",
          binding: { kind: "native", name: "example" },
          operation: "lookup",
        },
      }),
    ).resolves.toMatchObject({ passed: true });
  });
});

const profileRef = { id: "default", revision: "1" };

function conformingWorker(): Worker {
  return {
    describe: async () => ({
      profileCapabilities: [
        {
          profile: profileRef,
          capabilities: [
            TASK_ATTEMPT_EVENT_STREAM_CAPABILITY,
            TASK_ATTEMPT_CANCELLATION_CAPABILITY,
          ],
          contextTypes: [],
        },
      ],
      id: "worker-1",
      type: "custom",
      capabilities: [TASK_ATTEMPT_EVENT_STREAM_CAPABILITY, TASK_ATTEMPT_CANCELLATION_CAPABILITY],
      profiles: [profileRef],
      contextTypes: [],
    }),
    async *execute(spec, signal) {
      yield event(spec, "execution.started", { workerId: "worker-1" });
      if (
        signal?.aborted === true ||
        spec.workerProfile.id !== profileRef.id ||
        spec.workerProfile.revision !== profileRef.revision
      ) {
        yield event(spec, "execution.failed", {
          error: { name: "ExecutionUnavailableError", message: "Attempt cannot be executed" },
        });
        return;
      }
      yield event(spec, "output.message", { message: { role: "teammate", text: "done" } });
      yield event(spec, "execution.completed");
    },
  };
}

function taskAttemptSpec(workerProfile = profileRef): TaskAttemptSpec {
  const capturedAt = "2026-08-13T00:00:00.000Z";
  const authorization: TagAuthorizationSnapshot = {
    version: 5,
    capturedAt,
    tag: { id: "tag-1", name: "Engineering" },
    origin: {
      tagRouteId: "route-1",
      surfaceAccountId: "slack-1",
      provider: "slack",
      scope: "channel:engineering",
    },
    requester: { id: "user-1", kind: "user" },
    permissionSets: [],
    resources: [],
    runtimeActions: [],
  };
  return {
    execution: {},
    version: 1,
    taskId: "task-1",
    attemptId: "attempt-1",
    tag: { id: "tag-1", name: "Engineering" },
    input: {
      origin: {
        surface: "slack",
        accountId: "slack-1",
        scope: "channel:engineering",
        sessionKey: "slack:engineering:thread-1",
        occurredAt: capturedAt,
      },
      messages: [{ id: "message-1", role: "requester", text: "Review this" }],
    },
    authorization,
    contextPlan: emptyTagContextPlan(capturedAt),
    workspacePlan: { version: 1, status: "none" },
    workerProfile,
  };
}

function event<T extends TaskAttemptEvent["type"]>(
  spec: TaskAttemptSpec,
  type: T,
  fields: Record<string, unknown> = {},
): Extract<TaskAttemptEvent, { type: T }> {
  return {
    type,
    taskId: spec.taskId,
    attemptId: spec.attemptId,
    at: "2026-08-13T00:00:00.000Z",
    ...fields,
  } as Extract<TaskAttemptEvent, { type: T }>;
}

const emptyPlan: HarnessPlan = {
  files: [],
  mounts: [],
  environmentVariables: {},
  secretBindings: [],
  network: { mode: "none" },
};

const toolCall = {
  id: "call-1",
  capabilityId: "github:issues",
  provider: "github",
  binding: { kind: "mcp-http" as const, name: "github" },
  operation: "get_issue",
  effect: "read" as const,
  actions: ["issues:read"],
  resources: [{ surfaceAccountId: "github-1", scope: "repo:acme/supertag" }],
};

function executionContext(
  sessionStateStore: SessionStateStore = new InMemorySessionStateStore(),
): ExecutionContext {
  return {
    attempt: taskAttemptSpec(),
    profile: {
      ref: profileRef,
      workerType: "supertag",
      harness: { provider: "example" },
      execution: { provider: "local", lifetime: { scope: "attempt" } },
    },
    context: { instructions: [], skills: [], history: [], resources: [] },
    tools: [],
    secrets: [],
    sessionStates: [],
    extensions: [],
    sessionStateStore,
  };
}

const environment: ExecutionEnvironment = {
  id: "local",
  placement: "local",
  rootDirectory: "/tmp/supertag-conformance",
  async prepare() {},
  resolvePath: (path) => path,
  async read() {
    return "";
  },
  async spawn() {
    throw new Error("not used by conformance fixture");
  },
  async dispose() {},
};

function nativeTool(): ToolInput {
  return {
    id: "example-tool",
    kind: "tool",
    required: true,
    capability: {
      id: "example.lookup",
      provider: "example",
      operations: [{ name: "lookup", effect: "read", actions: ["example:read"] }],
      authorization: {
        provider: "example",
        resources: [{ surfaceAccountId: "example-1", scope: "resource:one" }],
      },
    },
    binding: {
      kind: "native",
      name: "example",
      adapter: "example-sdk",
      configuration: {},
      secretRefs: [],
    },
  };
}
