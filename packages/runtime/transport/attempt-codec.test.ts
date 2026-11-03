import { mountManifestDigest } from "@supertag/core";
import type { DurableWorklet } from "@supertag/worker-sdk";
import { expect, it, vi } from "vitest";
import WebSocket from "ws";
import { repositoryAttempt } from "../../../tests/support/repository-execution.js";
import { decodeTaskAttemptEvent, decodeTaskAttemptSpec } from "./src/attempt-codec.js";
import { DurableControlPlaneProtocol, DurableHostProtocol } from "./src/durable-protocol.js";

const identity = { taskId: "task", attemptId: "attempt", at: "legacy-time" };
const call = {
  id: "call",
  capabilityId: "capability",
  provider: "test",
  binding: { kind: "mcp", name: "test" },
  operation: "read",
  effect: "read",
  actions: [],
  resources: [],
};
const events = [
  { type: "execution.started", workerId: "worker" },
  {
    type: "execution.limits.applied",
    requested: {
      maxReportedTokens: 1_000,
      maxReportedCost: { amountMinor: 250, currency: "USD" },
    },
    applied: {
      maxNativeAgents: { limit: 0, method: "harness-guard" },
      maxReportedTokens: { limit: 800, method: "interrupt-on-report" },
      maxReportedCost: {
        limit: { amountMinor: 250, currency: "USD" },
        method: "provider-budget",
      },
    },
  },
  { type: "output.delta", text: "" },
  { type: "output.message", message: { role: "teammate", text: "answer" } },
  { type: "execution.failed", error: { name: "Error", message: "" } },
  { type: "artifact.created", artifact: { id: "artifact", uri: "file:///artifact" } },
  {
    type: "session.updated",
    sessionState: { id: "sessionState", format: "test", uri: "sessionState://test" },
  },
  {
    type: "result",
    result: {
      summary: "",
      decisions: [],
      changes: [],
      unresolved: [],
      findings: [],
      references: [],
      artifacts: [],
    },
  },
  { type: "tool.call.started", call },
  { type: "tool.call.completed", call, outcome: { references: [] } },
  { type: "tool.call.failed", call, error: { message: "" } },
  { type: "approval.requested", request: { id: "approval", description: "Approve" } },
  { type: "agent.updated", agent: { id: "agent", status: "running" } },
  { type: "command.updated", command: { id: "cmd", command: "pnpm test", status: "running" } },
  {
    type: "usage.updated",
    usage: {
      inputTokens: 1,
      outputTokens: 2,
      cachedInputTokens: 0,
      totalTokens: 3,
      complete: true,
    },
  },
  {
    type: "progress.updated",
    progress: { summary: "Working", items: [{ id: "step", text: "Step", status: "active" }] },
  },
  {
    type: "runtime-inputs.resolved",
    manifest: {
      workerProfile: { id: "profile", revision: "1" },
      harness: { id: "test", version: "1" },
      executionEnvironment: {
        id: "test-instance",
        provider: "test",
        placement: "local",
        guarantees: {
          filesystemIsolation: "sandbox",
          networkPolicy: "enforced",
          processTreeTermination: true,
          scopedHttp: false,
        },
        provenance: { sandboxId: "sandbox-1" },
      },
      inputs: [],
      omitted: [],
    },
  },
];

it("round-trips a partial mount output event and rejects an invalid digest", () => {
  const mounts = [
    {
      volume: "data",
      source: "file:///data",
      path: "/mnt/data",
      status: "partial",
      uploadedAt: "2026-10-07T00:00:00Z",
      objects: [{ key: "a", size: 1, sha256: `sha256:${"a".repeat(64)}` }],
      skipped: 0,
      error: { key: "b", reason: "upload failed" },
      notAttempted: ["b"],
    },
  ];
  expect(decodeTaskAttemptEvent({ ...identity, type: "workspace.mounts.written", mounts })).toEqual(
    {
      ...identity,
      type: "workspace.mounts.written",
      mounts,
    },
  );
  expect(() =>
    decodeTaskAttemptEvent({
      ...identity,
      type: "workspace.mounts.written",
      mounts: [{ ...mounts[0], objects: [{ key: "a", size: 1, sha256: "bad" }] }],
    }),
  ).toThrow(/sha256/u);
});

it("accepts oversized Worker progress and finding text by truncating it", () => {
  const progress = decodeTaskAttemptEvent({
    ...identity,
    type: "progress.updated",
    progress: {
      summary: "a".repeat(241),
      items: [{ id: "step", text: "b".repeat(161), status: "active" }],
    },
  });
  expect(progress).toMatchObject({
    progress: { summary: `${"a".repeat(239)}…`, items: [{ text: `${"b".repeat(159)}…` }] },
  });
  const result = decodeTaskAttemptEvent({
    ...identity,
    type: "result",
    result: {
      summary: "s".repeat(20_000),
      decisions: [],
      changes: [],
      unresolved: [],
      findings: [{ severity: "high", summary: "c".repeat(501), location: "d".repeat(501) }],
      references: [],
      artifacts: [],
    },
  });
  expect(result).toMatchObject({
    result: { findings: [{ summary: `${"c".repeat(499)}…`, location: `${"d".repeat(499)}…` }] },
  });
});

it.each(events)("checks required payload for $type while preserving extensions", (payload) => {
  const event = { ...identity, ...payload, futureExtension: { opaque: true } };
  expect(decodeTaskAttemptEvent(event)).toBe(event);
  expect(() => decodeTaskAttemptEvent({ ...identity, type: payload.type })).toThrow();
});

it.each([
  { type: "output.message", message: { role: "teammate", text: [] } },
  { type: "command.updated", command: { id: "cmd", command: "pnpm test", status: "hung" } },
  { type: "command.updated", command: { id: "cmd", command: ["pnpm"], status: "running" } },
  { type: "session.updated", sessionState: { id: "x", uri: "sessionState://x", format: 1 } },
  {
    type: "result",
    result: {
      summary: "ok",
      decisions: [],
      changes: [],
      unresolved: [],
      findings: [],
      references: [null],
      artifacts: [],
    },
  },
  {
    type: "runtime-inputs.resolved",
    manifest: {
      workerProfile: { id: "p", revision: "1" },
      harness: { id: "h", version: "1" },
      executionEnvironment: { id: "remote-instance", provider: "p", placement: "remote" },
      inputs: [],
      omitted: [{}],
    },
  },
  {
    type: "runtime-inputs.resolved",
    manifest: {
      workerProfile: { id: "p", revision: "1" },
      harness: { id: "h", version: "1" },
      executionEnvironment: {
        id: "remote-instance",
        provider: "p",
        placement: "remote",
        guarantees: {
          filesystemIsolation: "sandbox",
          networkPolicy: "best-effort",
          processTreeTermination: true,
          scopedHttp: false,
        },
      },
      inputs: [],
      omitted: [],
    },
  },
  { type: "tool.call.completed", call, outcome: { references: [42] } },
  {
    type: "execution.limits.applied",
    requested: { maxReportedTokens: 100 },
    applied: { maxReportedTokens: { limit: 101, method: "interrupt-on-report" } },
  },
  {
    type: "execution.limits.applied",
    requested: { maxReportedCost: { amountMinor: 100, currency: "USD" } },
    applied: {
      maxReportedCost: {
        limit: { amountMinor: 100, currency: "EUR" },
        method: "provider-budget",
      },
    },
  },
])("rejects malformed nested payload for $type", (event) => {
  expect(() => decodeTaskAttemptEvent({ ...identity, ...event })).toThrow();
});

it("rejects unknown event kinds and requires the current workspace plan", () => {
  const future = { ...identity, type: "future.extension", payload: { schema: 2 } };
  expect(() => decodeTaskAttemptEvent(future)).toThrow("Unsupported Task Attempt event type");
  expect(() =>
    decodeTaskAttemptSpec({ ...repositoryAttempt("test"), workspacePlan: undefined }),
  ).toThrow("workspacePlan");
  expect(decodeTaskAttemptEvent({ ...identity, type: "execution.completed" })).toMatchObject(
    identity,
  );
  const spec = { ...repositoryAttempt("test"), futureExtension: { opaque: true } };
  expect(decodeTaskAttemptSpec(spec)).toBe(spec);
  for (const version of [5, 4])
    expect(
      decodeTaskAttemptSpec({
        ...spec,
        authorization: {
          ...spec.authorization,
          version,
          ...(version === 4
            ? { origin: { kind: "internal", objectiveId: "objective", requestedByTagId: "tag" } }
            : {}),
        },
      }),
    ).toBeDefined();
  expect(() => decodeTaskAttemptSpec({ ...spec, execution: undefined })).toThrow();
  expect(
    decodeTaskAttemptSpec({
      ...spec,
      execution: {
        limits: {
          maxNativeAgents: 1,
          maxReportedTokens: 100,
          maxReportedCost: { amountMinor: 250, currency: "USD" },
        },
      },
    }),
  ).toBeDefined();
  for (const limits of [
    {},
    { maxNativeAgents: -1 },
    { maxReportedTokens: 0 },
    { maxReportedCost: { amountMinor: -1, currency: "USD" } },
    { maxReportedCost: { amountMinor: 1, currency: "usd" } },
    { maxReportedCost: { amountMinor: 1, currency: "USD", maxBudgetUsd: 1 } },
    { maxBudgetUsd: 1 },
    { unknown: 1 },
  ])
    expect(() => decodeTaskAttemptSpec({ ...spec, execution: { limits } })).toThrow();
});

it("validates provider-reported actual cost independently of token usage", () => {
  const event = {
    ...identity,
    type: "usage.updated",
    usage: {
      inputTokens: 1,
      outputTokens: 2,
      cachedInputTokens: 0,
      totalTokens: 3,
      complete: true,
      reportedCost: { amountMinor: 7, currency: "USD" },
    },
  };
  expect(decodeTaskAttemptEvent(event)).toBe(event);
  expect(() =>
    decodeTaskAttemptEvent({
      ...event,
      usage: { ...event.usage, reportedCost: { amountMinor: -1, currency: "usd" } },
    }),
  ).toThrow("reported cost");
});

it("validates the Workspace MCP digest event and the pinned digest on a Workspace plan", () => {
  const digest = `sha256:${"a".repeat(64)}`;
  const event = { ...identity, type: "workspace.mcp.resolved", digest };
  expect(decodeTaskAttemptEvent(event)).toBe(event);
  expect(() => decodeTaskAttemptEvent({ ...event, digest: "sha256:short" })).toThrow(
    "sha256 digest",
  );
  const spec = repositoryAttempt("workspace-mcp");
  const workspacePlan = {
    version: 1,
    status: "workspace",
    workspace: "app",
    branch: "supertag/objective/task",
    delivery: "branch",
    mcp: ["sentry"],
  };
  expect(
    decodeTaskAttemptSpec({ ...spec, workspacePlan: { ...workspacePlan, mcpPin: digest } }),
  ).toBeDefined();
  expect(() =>
    decodeTaskAttemptSpec({ ...spec, workspacePlan: { ...workspacePlan, mcpPin: "pin" } }),
  ).toThrow("mcpPin must be a sha256 digest");
});

it("carries only valid recorded Task branch names", () => {
  const spec = repositoryAttempt("workspace-branch-pin");
  const workspacePlan = {
    version: 1,
    status: "workspace",
    workspace: "app",
    branch: "supertag/objective/task",
    delivery: "branch",
  };
  const branchPin = "supertag/objective/task-deadbeef";
  const branchPinHead = "a".repeat(40);
  expect(
    decodeTaskAttemptSpec({
      ...spec,
      workspacePlan: { ...workspacePlan, branchPin, branchPinHead },
    }).workspacePlan,
  ).toMatchObject({ branchPin, branchPinHead });
  for (const invalid of ["main", "supertag/../foreign", "supertag/task.lock", 42])
    expect(() =>
      decodeTaskAttemptSpec({ ...spec, workspacePlan: { ...workspacePlan, branchPin: invalid } }),
    ).toThrow();
  for (const invalid of ["abc1234", "g".repeat(40), 42])
    expect(() =>
      decodeTaskAttemptSpec({
        ...spec,
        workspacePlan: { ...workspacePlan, branchPin, branchPinHead: invalid },
      }),
    ).toThrow();
  expect(() =>
    decodeTaskAttemptSpec({ ...spec, workspacePlan: { ...workspacePlan, branchPinHead } }),
  ).toThrow();
});

it("carries dependency branches in the Workspace plan and refuses other shapes", () => {
  const spec = repositoryAttempt("workspace-dependency-branches");
  const workspacePlan = {
    version: 1,
    status: "workspace",
    workspace: "app",
    branch: "supertag/objective/task",
    delivery: "branch",
  };
  const decode = (dependencyBranches: unknown) =>
    decodeTaskAttemptSpec({ ...spec, workspacePlan: { ...workspacePlan, dependencyBranches } });
  const head = "a".repeat(40);
  expect(decode([{ taskId: "x", branch: "supertag/objective/x", head }])).toBeDefined();
  expect(() => decode([{ taskId: "x", branch: "main", head }])).toThrow(
    "dependency branch must be a SuperTag Task branch",
  );
  expect(() => decode([{ taskId: "x", branch: "supertag/objective/x", head: "abc" }])).toThrow(
    "dependency head must be a full commit id",
  );
  expect(() =>
    decode([{ taskId: "x", branch: "supertag/objective/x", head, path: "/etc" }]),
  ).toThrow("carry only taskId, branch, and head");
  expect(() => decode({})).toThrow("dependencyBranches must be an array");
});

it("revalidates operator mounts carried in the Worklet Workspace plan", () => {
  const spec = repositoryAttempt("workspace-mount-codec");
  const workspacePlan = {
    version: 1,
    status: "workspace",
    workspace: "app",
    branch: "supertag/objective/task",
    delivery: "branch",
    mounts: [{ volume: "data", path: "/mnt/data" }],
  };
  expect(decodeTaskAttemptSpec({ ...spec, workspacePlan })).toBeDefined();
  expect(() =>
    decodeTaskAttemptSpec({
      ...spec,
      workspacePlan: { ...workspacePlan, mounts: [{ volume: "data", path: "/mnt/data/" }] },
    }),
  ).toThrow(/end in/u);
  expect(() =>
    decodeTaskAttemptSpec({
      ...spec,
      workspacePlan: {
        ...workspacePlan,
        mounts: [{ volume: "data", path: "/mnt/data", credential: "secret" }],
      },
    }),
  ).toThrow(/unknown fields/u);
  expect(
    decodeTaskAttemptSpec({
      ...spec,
      workspacePlan: {
        ...workspacePlan,
        mounts: [{ volume: "data", path: "/mnt/data", access: "read-write" }],
      },
    }),
  ).toMatchObject({ workspacePlan: { mounts: [{ access: "read-write" }] } });
});

it("validates the copied mount manifests and rejects one whose digest does not match", () => {
  const source = "s3://datasets/prefix/";
  const objects = [{ key: "a.csv", size: 1024, etag: '"abc"' }];
  const manifest = {
    volume: "datasets",
    source,
    path: "/mnt/datasets",
    strategy: "copy",
    access: "read-only",
    objectCount: 1,
    totalBytes: 1024,
    digest: mountManifestDigest(source, objects),
    copiedAt: "2026-10-04T00:00:00.000Z",
    objects,
  };
  const event = { ...identity, type: "workspace.mounts.copied", mounts: [manifest] };
  expect(decodeTaskAttemptEvent(event)).toBe(event);
  expect(() =>
    decodeTaskAttemptEvent({
      ...event,
      mounts: [{ ...manifest, digest: `sha256:${"0".repeat(64)}` }],
    }),
  ).toThrow("Worklet protocol workspace.mounts.copied: Mount manifest 0 digest does not match");
  expect(() => decodeTaskAttemptEvent({ ...event, mounts: "nope" })).toThrow("Worklet protocol");
});

it("rejects a malformed durable event before exposing it to an observer", async () => {
  const send = vi.fn();
  const socket = { readyState: WebSocket.OPEN, send } as unknown as WebSocket;
  const protocol = new DurableControlPlaneProtocol(1000);
  const stream = protocol.events(socket, "attempt")[Symbol.asyncIterator]();
  const pending = stream.next();
  const request = JSON.parse(send.mock.calls[0]?.[0] as string);
  protocol.receive(socket, {
    type: "durable_event",
    requestId: request.requestId,
    item: { sequence: 1, event: { ...identity, type: "session.updated", sessionState: null } },
  });
  await expect(pending).rejects.toThrow("must be an object");
});

it("decodes durable acceptance before calling a custom Worklet", async () => {
  const accept = vi.fn();
  const send = vi.fn();
  const socket = { readyState: WebSocket.OPEN, send } as unknown as WebSocket;
  const protocol = new DurableHostProtocol({ accept } as unknown as DurableWorklet);
  await protocol.receive(socket, {
    type: "durable_request",
    operation: "accept",
    requestId: "request",
    spec: { version: 1 },
  });
  expect(accept).not.toHaveBeenCalled();
  expect(JSON.parse(send.mock.calls[0]?.[0] as string)).toMatchObject({
    type: "durable_reply",
    requestId: "request",
    error: expect.any(String),
  });
});

const baseSpec = repositoryAttempt("nested-spec");
it.each(["accept", "select_placement", "release_placement"])(
  "F5 redacts host %s failures before transport",
  async (operation) => {
    vi.stubEnv("PROVIDER_KEY", "host-private-key");
    const fail = vi.fn(async () => {
      throw new Error(
        "failed host-private-key https://user:pass/word@example.test/path?access_token=query-private",
      );
    });
    const worklet = {
      accept: fail,
      describe: fail,
      releasePlacement: fail,
    } as unknown as DurableWorklet;
    const protocol = new DurableHostProtocol(worklet);
    const send = vi.fn();
    const socket = { readyState: WebSocket.OPEN, send } as unknown as WebSocket;
    try {
      await protocol.receive(socket, {
        type: "durable_request",
        operation,
        requestId: "request",
        spec: baseSpec,
        requirements: {},
        contextPlan: baseSpec.contextPlan,
        options: {},
        placement: {
          workerHostId: "host",
          workletId: "worklet",
          workerId: "worker",
          reservation: { id: "reservation", expiresAt: "2099-01-01T00:00:00Z" },
        },
      });
      expect(fail).toHaveBeenCalledOnce();
      expect(JSON.parse(send.mock.calls[0]?.[0] as string)).toMatchObject({
        type: "durable_reply",
        requestId: "request",
        error: "failed [REDACTED] https://[REDACTED]@example.test/path?access_token=[REDACTED]",
      });
    } finally {
      vi.unstubAllEnvs();
    }
  },
);

it("decodes canonical Task history with artifact references and rejects malformed results", () => {
  const entry = {
    taskId: "prior-task",
    sessionId: "session",
    tagId: "tag",
    requestText: "Research scheduling",
    completedAt: "2026-09-15T00:00:00Z",
    result: {
      summary: "Research complete",
      decisions: [],
      changes: [],
      unresolved: [],
      findings: [],
      references: [],
      artifacts: [{ artifactId: "artifact-report", paths: ["report.md"] }],
    },
  };
  const spec = { ...baseSpec, session: { id: "session", history: [entry] } };
  expect(decodeTaskAttemptSpec(spec).session?.history).toEqual([entry]);
  for (const invalid of [
    { ...entry, result: null },
    { ...entry, requestText: 42 },
  ]) {
    expect(() =>
      decodeTaskAttemptSpec({
        ...spec,
        session: { id: "session", history: [invalid] },
      }),
    ).toThrow();
  }
});
const validInput = {
  ...baseSpec.input,
  messages: [{ id: "message", role: "requester", text: "", actor: { id: "actor", kind: "user" } }],
};
const validResource = {
  provider: "github",
  surfaceAccountId: "account",
  scope: "repository:test",
  actions: ["read"],
  sources: ["origin"],
};
const validContextItem = {
  id: "context",
  itemKey: "set:item",
  type: "custom.context",
  version: 1,
  required: true,
  config: { providerSpecific: { arbitrary: [null, 1, "value"] } },
  snapshot: { futureShape: [1, 2] },
};
const contextWith = (item: unknown) => ({
  ...baseSpec.contextPlan,
  sets: [{ id: "set", name: "Context", items: [item] }],
});

it.each([
  [
    "message",
    { input: { ...validInput, messages: [{ id: "message", role: "requester", text: 4 }] } },
  ],
  [
    "actor",
    {
      input: {
        ...validInput,
        messages: [
          { id: "message", role: "requester", text: "", actor: { id: "actor", kind: "invalid" } },
        ],
      },
    },
  ],
  ["input origin", { input: { ...validInput, origin: {} } }],
  [
    "permission set",
    { authorization: { ...baseSpec.authorization, permissionSets: [{ id: "set" }] } },
  ],
  [
    "resource actions",
    {
      authorization: { ...baseSpec.authorization, resources: [{ ...validResource, actions: [4] }] },
    },
  ],
  [
    "resource sources",
    {
      authorization: {
        ...baseSpec.authorization,
        resources: [{ ...validResource, sources: undefined }],
      },
    },
  ],
  ["runtime actions", { authorization: { ...baseSpec.authorization, runtimeActions: [4] } }],
  [
    "approval target",
    {
      authorization: {
        ...baseSpec.authorization,
        approvals: [{ target: "shell", action: "x", permissionSets: [], approvers: [] }],
      },
    },
  ],
  [
    "removed connector approval target",
    {
      authorization: {
        ...baseSpec.authorization,
        approvals: [
          {
            target: "connector",
            surfaceAccountId: "account",
            scope: "repository:1",
            action: "merge",
            permissionSets: ["release"],
            approvers: [],
          },
        ],
      },
    },
  ],
  [
    "removed connectorAccountId approval field",
    {
      authorization: {
        ...baseSpec.authorization,
        approvals: [
          {
            target: "surface",
            connectorAccountId: "account",
            scope: "repository:1",
            action: "merge",
            permissionSets: ["release"],
            approvers: [],
          },
        ],
      },
    },
  ],
  [
    "surface approval scope",
    {
      authorization: {
        ...baseSpec.authorization,
        approvals: [
          { target: "surface", action: "merge", permissionSets: ["release"], approvers: [] },
        ],
      },
    },
  ],
  [
    "Role provenance",
    {
      authorization: {
        ...baseSpec.authorization,
        roles: [
          {
            assignmentId: "assignment",
            assignmentRevision: 1,
            role: {
              id: "role",
              name: "Forged",
              purpose: "Invalid",
              instructions: "",
              origin: "user",
              systemKey: "org-architect",
              revision: 1,
              contextSetIds: [],
              permissionSetIds: [],
            },
          },
        ],
      },
    },
  ],
  ["internal origin", { authorization: { ...baseSpec.authorization, version: 4 } }],
  ["context item", { contextPlan: contextWith(null) }],
  ["context required", { contextPlan: contextWith({ ...validContextItem, required: "true" }) }],
  ["context version", { contextPlan: contextWith({ ...validContextItem, version: 0 }) }],
  ["context config", { contextPlan: contextWith({ ...validContextItem, config: [] }) }],
  ["context snapshot", { contextPlan: contextWith({ ...validContextItem, snapshot: [] }) }],
  [
    "workspace target",
    { workspacePlan: { version: 1, status: "selected", selectedBy: "request" } },
  ],
  [
    "session sessionState",
    {
      session: { id: "session", sessionState: { id: "sessionState", uri: "sessionState://test" } },
    },
  ],
  ["session history", { session: { id: "session", history: [{}] } }],
])("rejects invalid nested %s before admitting a spec", (_name, override) => {
  expect(() => decodeTaskAttemptSpec({ ...baseSpec, ...override })).toThrow();
});

it("preserves opaque provider data while decoding current nested contracts", () => {
  const spec = {
    ...baseSpec,
    input: validInput,
    contextPlan: contextWith(validContextItem),
    authorization: {
      ...baseSpec.authorization,
      resources: [validResource],
      permissionSets: [
        { id: "permission", name: "Permissions", approvers: ["tag:release-manager"] },
      ],
      approvals: [
        {
          target: "surface",
          surfaceAccountId: validResource.surfaceAccountId,
          scope: validResource.scope,
          action: "pull-requests:merge",
          permissionSets: ["Permissions"],
          approvers: ["tag:release-manager"],
        },
        {
          target: "runtime",
          action: "commands:execute",
          permissionSets: ["Permissions"],
          approvers: [],
        },
      ],
    },
    futureField: { unknown: true },
  };
  expect(decodeTaskAttemptSpec(spec)).toBe(spec);
  expect(spec.contextPlan.sets[0]?.items[0]).toBe(validContextItem);
  for (const workspacePlan of [
    { version: 1, status: "none" },
    { version: 1, status: "selected", selectedBy: "origin", target: validResource },
    { version: 1, status: "selection-required", choices: [validResource] },
    { version: 1, status: "unavailable", requested: ["repository:missing"] },
  ])
    expect(decodeTaskAttemptSpec({ ...spec, workspacePlan })).toBeDefined();
});

it("accepts exact catalog output selections and rejects legacy bytes and ambiguous entry paths", () => {
  const event = {
    type: "result",
    taskId: "task",
    attemptId: "attempt",
    at: "2026-09-15T00:00:00Z",
    result: {
      summary: "Done",
      decisions: [],
      changes: [],
      unresolved: [],
      findings: [],
      references: [],
      artifacts: [{ artifactId: "report", paths: ["research/findings.md"] }],
    },
  };
  expect(decodeTaskAttemptEvent(event)).toEqual(event);
  for (const artifact of [
    { uri: "supertag-artifact:sha256:abc" },
    { artifactId: "report", paths: [] },
    { artifactId: "report", paths: ["../private"] },
    { artifactId: "report", paths: ["same", "same"] },
    { artifactId: "report", paths: ["report.md"], uri: "ignored-authority" },
  ])
    expect(() =>
      decodeTaskAttemptEvent({ ...event, result: { ...event.result, artifacts: [artifact] } }),
    ).toThrow();
});

it("accepts strictly valid result findings and refuses findings that name another Task", () => {
  const finding = {
    id: "F1",
    severity: "high",
    summary: "The export skips tenant scoping.",
    location: "src/query.ts:42",
    status: "open",
  };
  const event = {
    type: "result",
    taskId: "task",
    attemptId: "attempt",
    at: "2026-10-04T00:00:00Z",
    result: {
      summary: "Reviewed",
      decisions: [],
      changes: [],
      unresolved: [],
      findings: [finding],
      references: [],
      artifacts: [],
    },
  };
  expect(decodeTaskAttemptEvent(event)).toEqual(event);
  // The Control Plane assigns ids and status, so a Worker may omit them, and any it sends are
  // ignored rather than validated.
  for (const findings of [
    [{ severity: "high", summary: "The export skips tenant scoping." }],
    [{ severity: "low", summary: "Typo.", location: "README.md:3" }],
    [{ ...finding, status: "accepted" }],
    [{ ...finding, id: "not-an-id", status: "closed", reason: "Ignored" }],
    [finding, finding],
  ]) {
    const reported = { ...event, result: { ...event.result, findings } };
    expect(decodeTaskAttemptEvent(reported)).toEqual(reported);
  }
  for (const findings of [
    undefined,
    { severity: "high", summary: "Not a list." },
    [{ ...finding, taskId: "other-task" }],
    [{ ...finding, severity: "critical" }],
    [{ severity: "high" }],
    [{ ...finding, summary: "" }],
    [{ ...finding, summary: "Hidden\u202e text." }],
  ])
    expect(() =>
      decodeTaskAttemptEvent({ ...event, result: { ...event.result, findings } }),
    ).toThrow();
  const reReview = {
    ...event,
    result: { ...event.result, fixedFindings: [{ taskId: "review", findingId: "F1" }] },
  };
  expect(decodeTaskAttemptEvent(reReview)).toEqual(reReview);
  for (const fixedFindings of [
    { taskId: "review", findingId: "F1" },
    [{ taskId: "review" }],
    [{ taskId: "review", findingId: "F1", status: "fixed" }],
  ])
    expect(() =>
      decodeTaskAttemptEvent({ ...event, result: { ...event.result, fixedFindings } }),
    ).toThrow();
});

it("preserves Session-only persistence without granting coordination", () => {
  const persistence = {
    controlPlaneUrl: "https://control-plane.example",
    token: "session-only-token",
  };
  const spec = { ...baseSpec, session: { id: "session", persistence } };
  const decoded = decodeTaskAttemptSpec(spec);
  expect(decoded.session?.persistence).toEqual(persistence);
  expect(decoded.coordination).toBeUndefined();
  for (const invalid of [
    null,
    {},
    { ...persistence, token: "" },
    { ...persistence, token: 42 },
    { ...persistence, extra: true },
  ]) {
    expect(() =>
      decodeTaskAttemptSpec({ ...spec, session: { id: "session", persistence: invalid } }),
    ).toThrow();
  }
});

it("validates live mount events without accepting copy manifests or credentials", () => {
  const mount = {
    volume: "datasets",
    source: "s3://datasets/prefix/",
    prefix: "prefix/",
    path: "/mnt/datasets",
    strategy: "mount",
    access: "read-only",
    attachedAt: "2026-10-06T14:00:00.000Z",
  };
  const event = { ...identity, type: "workspace.mounts.attached", mounts: [mount] };
  expect(decodeTaskAttemptEvent(event)).toEqual(event);
  for (const change of [{ attachedAt: "invalid" }, { credential: "secret" }, { objects: [] }])
    expect(() => decodeTaskAttemptEvent({ ...event, mounts: [{ ...mount, ...change }] })).toThrow();
});
