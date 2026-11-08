import { expect, it, vi } from "vitest";
import {
  profileHarness,
  SessionContinuity,
  sessionCompatibility,
  sessionPlacement,
} from "../packages/control-plane/src/session-continuity.js";
import type { Store, Task } from "../packages/core/src/index.js";

const profile = { id: "native", revision: "1" };
const at = "2026-09-15T00:00:00.000Z";
function internalTask(roleRevision = 1): Task {
  return {
    id: "internal-task",
    sessionId: "internal-session",
    tagId: "manager",
    inboundEventId: null,
    actor: { id: "owner", kind: "bot" },
    trigger: {},
    execution: {},
    workspacePlan: { version: 1, status: "none" },
    sessionHistory: [],
    authorizationSnapshot: {
      version: 4,
      capturedAt: at,
      tag: { id: "manager", name: "Manager" },
      origin: { kind: "internal", objectiveId: "objective", requestedByTagId: "owner" },
      requester: { id: "owner", kind: "bot" },
      resources: [],
      permissionSets: [],
      runtimeActions: [],
      roles: [
        {
          assignmentId: "assigned-role",
          assignmentRevision: 1,
          role: {
            id: "architect",
            name: "Architect",
            purpose: "Design the organization",
            instructions: "Use the current policy",
            revision: roleRevision,
            origin: "user",
            contextSetIds: [],
            permissionSetIds: [],
          },
        },
      ],
    },
    contextPlan: { version: 7, capturedAt: at, sets: [] },
    status: "running",
    createdAt: at,
    updatedAt: at,
  };
}
function fixture() {
  const task = internalTask();
  const ref = { id: "native-state", format: "native-v1", uri: "supertag:session" };
  const listTaskAttempts = vi.fn(async () => [
    { id: "first", attemptNumber: 1, status: "completed" },
    { id: "current", attemptNumber: 2, status: "running" },
  ]);
  const listSessionStates = vi.fn(async () => [
    {
      ref,
      id: ref.id,
      sessionId: task.sessionId,
      taskId: task.id,
      attemptId: "first",
      harnessId: "claude-code",
      workerProfile: profile,
      compatibility: sessionCompatibility(task),
      status: "resumable",
    },
  ]);
  const findInboundEventById = vi.fn(async () => undefined);
  const store = {
    findLatestSessionExecutionTask: vi.fn(async () => undefined),
    findTaskById: vi.fn(async () => task),
    listTaskAttempts,
    listSessionStates,
    findSessionState: vi.fn(async () => undefined),
    promoteSessionState: vi.fn(async () => {}),
    findInboundEventById,
  } as unknown as Store;
  return {
    task,
    ref,
    listTaskAttempts,
    listSessionStates,
    findInboundEventById,
    store,
    continuity: new SessionContinuity(store),
  };
}

it("resumes Objective retries across a Role revision without requiring a surface event", async () => {
  const f = fixture();
  await expect(f.continuity.readTask(f.task, "current")).resolves.toEqual(f.ref);
  await expect(f.continuity.readTask(internalTask(2), "current")).resolves.toEqual(f.ref);
  expect(f.findInboundEventById).not.toHaveBeenCalled();
});

it("resumes natively across permission, Context Set, workspace and execution changes", async () => {
  const f = fixture();
  const changed: Task = {
    ...f.task,
    authorizationSnapshot: {
      ...f.task.authorizationSnapshot,
      permissionSets: [{ id: "writer", name: "Writer" }],
      runtimeActions: ["files:write"],
    },
    contextPlan: {
      ...f.task.contextPlan,
      sets: [{ id: "docs", name: "Docs", items: [] }],
    },
    workspacePlan: { version: 1, status: "unavailable", requested: ["repo"] },
    execution: { model: "other-model", limits: { maxNativeAgents: 1 } },
  };
  await expect(f.continuity.readTask(changed, "current")).resolves.toEqual(f.ref);
});

it("lets any profile of the producing harness resume, preferring the producing profile", async () => {
  const f = fixture();
  // A Worker Profile revision bump does not matter: only the harness gates the state.
  await expect(f.continuity.readTask(f.task, "current", "claude-code")).resolves.toEqual(f.ref);
  await expect(f.continuity.readTask(f.task, "current", "codex")).resolves.toBeUndefined();
  f.listTaskAttempts.mockResolvedValue([{ id: "first", attemptNumber: 1, status: "completed" }]);
  vi.mocked(f.store.findLatestSessionExecutionTask).mockResolvedValue({
    ...f.task,
    id: "earlier-task",
    status: "completed",
  });
  f.listSessionStates.mockResolvedValue(
    (await f.listSessionStates()).map((state) => ({ ...state, taskId: "earlier-task" })),
  );
  await expect(
    f.continuity.preferredProfile({} as never, { ...f.task, id: "next-task" }),
  ).resolves.toEqual({ workerProfile: profile, harnessId: "claude-code" });
});

it("does not resume for a different reply audience or a stale compatibility hash", async () => {
  const f = fixture();
  const work = (scope: string) => ({
    id: "inbound",
    tagId: f.task.tagId,
    surfaceAccountId: "slack-account",
    event: {
      provider: "slack",
      scope,
      sessionKey: "thread-1",
      callback: { target: { channel: scope } },
    },
  });
  const surfaceTask = { ...f.task, inboundEventId: "inbound" };
  f.findInboundEventById.mockResolvedValue(work("C1") as never);
  const compatibility = await f.continuity.compatibility(surfaceTask);
  f.listSessionStates.mockResolvedValue(
    (await f.listSessionStates()).map((state) => ({ ...state, compatibility })),
  );
  await expect(f.continuity.readTask(surfaceTask, "current")).resolves.toEqual(f.ref);
  f.findInboundEventById.mockResolvedValue(work("C2") as never);
  await expect(f.continuity.readTask(surfaceTask, "current")).resolves.toBeUndefined();
  f.listSessionStates.mockResolvedValue(
    (await f.listSessionStates()).map((state) => ({ ...state, compatibility: "sha256:old" })),
  );
  f.findInboundEventById.mockResolvedValue(work("C1") as never);
  await expect(f.continuity.readTask(surfaceTask, "current")).resolves.toBeUndefined();
});

it("places a Session on its producing profile, then its harness, then anywhere", () => {
  const plan = { version: 7 as const, capturedAt: at, sets: [] };
  const worker = (id: string, entries: { profile: typeof profile; harness: string }[]) => ({
    id,
    profiles: entries.map((entry) => entry.profile),
    profileCapabilities: entries.map((entry) => ({
      ...entry,
      capabilities: [],
      contextTypes: [],
    })),
  });
  const descriptor = (workers: ReturnType<typeof worker>[]) =>
    ({ id: "worklet", protocolVersion: 1, host: { id: "host", workers } }) as never;
  const preferred = { workerProfile: profile, harnessId: "claude-code" };
  const bumped = { id: "native", revision: "2" };
  const codex = { id: "codex", revision: "1" };
  const one = (allowedWorkerHostIds: string[]) => [{ allowedWorkerHostIds, requirements: {} }];
  expect(
    sessionPlacement(
      descriptor([worker("w", [{ profile, harness: "claude-code" }])]),
      one(["host"]),
      plan,
      preferred,
    ),
  ).toEqual([{ requirements: {}, compatibleProfile: profile }]);
  expect(
    sessionPlacement(
      descriptor([
        worker("w", [
          { profile: bumped, harness: "claude-code" },
          { profile: codex, harness: "codex" },
        ]),
      ]),
      one(["host"]),
      plan,
      preferred,
    ),
  ).toEqual([{ requirements: { harness: "claude-code" } }]);
  expect(
    sessionPlacement(
      descriptor([worker("w", [{ profile: codex, harness: "codex" }])]),
      one(["host"]),
      plan,
      preferred,
    ),
  ).toEqual([{ requirements: {} }]);
  expect(
    sessionPlacement(
      descriptor([worker("w", [{ profile, harness: "claude-code" }])]),
      one(["other-host"]),
      plan,
      preferred,
    ),
  ).toEqual([{ requirements: {} }]);
});

it("decides a Session's placement across every tier before trying the first", () => {
  const plan = { version: 7 as const, capturedAt: at, sets: [] };
  const worker = (id: string, entries: { profile: typeof profile; harness: string }[]) => ({
    id,
    profiles: entries.map((entry) => entry.profile),
    profileCapabilities: entries.map((entry) => ({
      ...entry,
      capabilities: [],
      contextTypes: [],
    })),
  });
  const descriptor = (workers: ReturnType<typeof worker>[]) =>
    ({ id: "worklet", protocolVersion: 1, host: { id: "worklet", workers } }) as never;
  const preferred = { workerProfile: profile, harnessId: "claude-code" };
  const bumped = { id: "native", revision: "2" };
  const codex = { id: "codex", revision: "1" };
  const clone = { allowedWorkerHostIds: ["clone"], requirements: {} };
  const tiers = [{ allowedWorkerHostIds: ["in-place"], requirements: {} }, clone];
  // Only the second tier has the producing profile: the first tier must not replay on codex.
  expect(
    sessionPlacement(
      descriptor([
        worker("in-place/w", [{ profile: codex, harness: "codex" }]),
        worker("clone/w", [{ profile, harness: "claude-code" }]),
      ]),
      tiers,
      plan,
      preferred,
    ),
  ).toEqual([
    { requirements: {}, compatibleProfile: profile },
    { requirements: {}, compatibleProfile: profile },
  ]);
  // Only the second tier has the producing harness: both tiers are narrowed to it.
  expect(
    sessionPlacement(
      descriptor([
        worker("in-place/w", [{ profile: codex, harness: "codex" }]),
        worker("clone/w", [{ profile: bumped, harness: "claude-code" }]),
      ]),
      tiers,
      plan,
      preferred,
    ),
  ).toEqual([
    { requirements: { harness: "claude-code" } },
    { requirements: { harness: "claude-code" } },
  ]);
  // A tier that requires another harness cannot resume, so it is skipped.
  expect(
    sessionPlacement(
      descriptor([
        worker("in-place/w", [{ profile: codex, harness: "codex" }]),
        worker("clone/w", [{ profile: bumped, harness: "claude-code" }]),
      ]),
      [{ allowedWorkerHostIds: ["in-place"], requirements: { harness: "codex" } }, clone],
      plan,
      preferred,
    ),
  ).toEqual([undefined, { requirements: { harness: "claude-code" } }]);
  // No tier has the harness: every tier is unconstrained and the Session replays.
  expect(
    sessionPlacement(
      descriptor([worker("in-place/w", [{ profile: codex, harness: "codex" }])]),
      tiers,
      plan,
      preferred,
    ),
  ).toEqual([{ requirements: {} }, { requirements: {} }]);
});

it("finds the harness a Worker advertises for a profile", () => {
  const workers = [
    {
      id: "w",
      profiles: [profile],
      profileCapabilities: [{ profile, harness: "codex", capabilities: [], contextTypes: [] }],
    },
  ] as never;
  expect(profileHarness(workers, profile)).toBe("codex");
  expect(profileHarness(workers, { id: "native", revision: "2" })).toBeUndefined();
});

it("does not skip a failed predecessor to resume an older successful Attempt", async () => {
  const f = fixture();
  f.listTaskAttempts.mockResolvedValue([
    { id: "first", attemptNumber: 1, status: "completed" },
    { id: "failed", attemptNumber: 2, status: "failed" },
    { id: "current", attemptNumber: 3, status: "running" },
  ]);
  await expect(f.continuity.readTask(f.task, "current")).resolves.toBeUndefined();
});

it("replays after a resumed turn fails at runtime instead of resuming its state", async () => {
  const f = fixture();
  vi.mocked(f.store.findLatestSessionExecutionTask).mockResolvedValue({
    ...f.task,
    id: "failed-task",
    status: "failed",
  });
  f.listTaskAttempts.mockResolvedValue([{ id: "first", attemptNumber: 1, status: "failed" }]);
  // Neither a later Task nor a retry of the failed Task gets native state, so both replay.
  await expect(f.continuity.readTask({ ...f.task, id: "next-task" })).resolves.toBeUndefined();
  f.listTaskAttempts.mockResolvedValue([
    { id: "first", attemptNumber: 1, status: "failed" },
    { id: "current", attemptNumber: 2, status: "running" },
  ]);
  await expect(f.continuity.readTask(f.task, "current")).resolves.toBeUndefined();
});

it("rejects surface continuity when the immutable inbound audience cannot be recovered", async () => {
  const f = fixture();
  const task = { ...f.task, inboundEventId: "missing-inbound" };
  await expect(f.continuity.readTask(task, "current")).resolves.toBeUndefined();
  expect(f.findInboundEventById).toHaveBeenCalledWith("missing-inbound");
});

it("resumes a promoted cancelled predecessor but rejects an unpromoted archive", async () => {
  const f = fixture();
  f.listTaskAttempts.mockResolvedValue([
    { id: "first", attemptNumber: 1, status: "cancelled" },
    { id: "current", attemptNumber: 2, status: "running" },
  ]);
  await expect(f.continuity.readTask(f.task, "current")).resolves.toBeUndefined();
  const states = (await f.listSessionStates()).map((state) => ({
    ...state,
    compatibility: `wait:${state.compatibility}`,
  }));
  f.listSessionStates.mockResolvedValue(states);
  await expect(f.continuity.readTask(f.task, "current")).resolves.toEqual(f.ref);
  f.listSessionStates.mockResolvedValue(states.map((state) => ({ ...state, status: "stored" })));
  await expect(f.continuity.readTask(f.task, "current")).resolves.toBeUndefined();
});

it("resumes only explicitly archived budget stops across an authorized allocation change", async () => {
  const f = fixture();
  const task = { ...f.task, execution: { limits: { maxReportedTokens: 1000 } } };
  vi.mocked(f.store.findSessionState).mockResolvedValue({
    ...(await f.listSessionStates())[0],
    status: "stored",
  } as never);
  await f.continuity.saveTask(task, profile, [
    { type: "session.updated", taskId: task.id, attemptId: "first", at, sessionState: f.ref },
    {
      type: "execution.failed",
      taskId: task.id,
      attemptId: "first",
      at,
      error: { name: "ExecutionBudgetExceededError", message: "budget exhausted" },
    },
  ]);
  const promotion = vi.mocked(f.store.promoteSessionState).mock.calls[0]?.[0];
  if (!promotion) throw new Error("Expected archived budget state promotion");
  expect(promotion.compatibility).toMatch(/^budget:/);
  f.listTaskAttempts.mockResolvedValue([
    { id: "first", attemptNumber: 1, status: "failed" },
    { id: "current", attemptNumber: 2, status: "running" },
  ]);
  f.listSessionStates.mockResolvedValue(
    (await f.listSessionStates()).map((state) => ({
      ...state,
      compatibility: promotion.compatibility,
    })),
  );
  await expect(
    f.continuity.readTask(
      { ...task, execution: { limits: { maxReportedTokens: 500 } } },
      "current",
    ),
  ).resolves.toEqual(f.ref);
  await expect(
    f.continuity.readTask(
      { ...task, execution: { limits: { maxReportedTokens: 500, maxNativeAgents: 1 } } },
      "current",
    ),
  ).resolves.toEqual(f.ref);
  await expect(
    f.continuity.readTask(
      { ...task, authorizationSnapshot: internalTask(2).authorizationSnapshot },
      "current",
    ),
  ).resolves.toEqual(f.ref);
  // A budget stop resumes only its own Task's next Task Attempt, never a later Task.
  await expect(f.continuity.readTask(task)).resolves.toBeUndefined();
});

it("does not promote ordinary failures even when partial state was archived", async () => {
  const f = fixture();
  await f.continuity.saveTask(f.task, profile, [
    { type: "session.updated", taskId: f.task.id, attemptId: "first", at, sessionState: f.ref },
    {
      type: "execution.failed",
      taskId: f.task.id,
      attemptId: "first",
      at,
      error: { name: "Error", message: "budget exhausted" },
    },
  ]);
  expect(f.store.promoteSessionState).not.toHaveBeenCalled();
});

it("refuses promotion on a withdrawal event even without a surviving delivery record", async () => {
  const f = fixture();
  vi.mocked(f.store.findSessionState).mockResolvedValue({
    ...(await f.listSessionStates())[0],
    status: "stored",
  } as never);
  await f.continuity.saveTask(f.task, profile, [
    {
      type: "input.withdrawn",
      taskId: f.task.id,
      attemptId: "first",
      at,
      commandId: "team-input:removed",
    },
    { type: "session.updated", taskId: f.task.id, attemptId: "first", at, sessionState: f.ref },
    { type: "execution.completed", taskId: f.task.id, attemptId: "first", at },
  ]);
  expect(f.store.promoteSessionState).not.toHaveBeenCalled();
});
