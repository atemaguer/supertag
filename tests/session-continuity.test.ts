import { expect, it, vi } from "vitest";
import {
  SessionContinuity,
  sessionCompatibility,
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
      compatibility: sessionCompatibility(task, profile),
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
    hasUnconfirmedTeamLiveDelivery: vi.fn(async () => false),
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

it("checks Role revisions for Objective retries without requiring a surface event", async () => {
  const f = fixture();
  await expect(f.continuity.readTask(f.task, profile, "current")).resolves.toEqual(f.ref);
  await expect(f.continuity.readTask(internalTask(2), profile, "current")).resolves.toBeUndefined();
  expect(f.findInboundEventById).not.toHaveBeenCalled();
});

it("does not skip a failed predecessor to resume an older successful Attempt", async () => {
  const f = fixture();
  f.listTaskAttempts.mockResolvedValue([
    { id: "first", attemptNumber: 1, status: "completed" },
    { id: "failed", attemptNumber: 2, status: "failed" },
    { id: "current", attemptNumber: 3, status: "running" },
  ]);
  await expect(f.continuity.readTask(f.task, profile, "current")).resolves.toBeUndefined();
});

it("rejects surface continuity when the immutable inbound audience cannot be recovered", async () => {
  const f = fixture();
  const task = { ...f.task, inboundEventId: "missing-inbound" };
  await expect(f.continuity.readTask(task, profile, "current")).resolves.toBeUndefined();
  expect(f.findInboundEventById).toHaveBeenCalledWith("missing-inbound");
});

it("resumes a promoted cancelled predecessor but rejects an unpromoted archive", async () => {
  const f = fixture();
  f.listTaskAttempts.mockResolvedValue([
    { id: "first", attemptNumber: 1, status: "cancelled" },
    { id: "current", attemptNumber: 2, status: "running" },
  ]);
  await expect(f.continuity.readTask(f.task, profile, "current")).resolves.toBeUndefined();
  const states = (await f.listSessionStates()).map((state) => ({
    ...state,
    compatibility: `wait:${state.compatibility}`,
  }));
  f.listSessionStates.mockResolvedValue(states);
  await expect(f.continuity.readTask(f.task, profile, "current")).resolves.toEqual(f.ref);
  f.listSessionStates.mockResolvedValue(states.map((state) => ({ ...state, status: "stored" })));
  await expect(f.continuity.readTask(f.task, profile, "current")).resolves.toBeUndefined();
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
      profile,
      "current",
    ),
  ).resolves.toEqual(f.ref);
  await expect(
    f.continuity.readTask(
      { ...task, execution: { limits: { maxReportedTokens: 500, maxNativeAgents: 1 } } },
      profile,
      "current",
    ),
  ).resolves.toBeUndefined();
  await expect(
    f.continuity.readTask(
      { ...task, authorizationSnapshot: internalTask(2).authorizationSnapshot },
      profile,
      "current",
    ),
  ).resolves.toBeUndefined();
  await expect(f.continuity.readTask(task, profile)).resolves.toBeUndefined();
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

it.each(["completed", "budget"] as const)(
  "refuses %s session promotion when durable teammate delivery is unconfirmed",
  async (terminal) => {
    const f = fixture();
    vi.mocked(f.store.findSessionState).mockResolvedValue({
      ...(await f.listSessionStates())[0],
      status: "stored",
    } as never);
    vi.mocked(f.store.hasUnconfirmedTeamLiveDelivery).mockResolvedValue(true);
    await f.continuity.saveTask(f.task, profile, [
      { type: "session.updated", taskId: f.task.id, attemptId: "first", at, sessionState: f.ref },
      terminal === "completed"
        ? { type: "execution.completed", taskId: f.task.id, attemptId: "first", at }
        : {
            type: "execution.failed",
            taskId: f.task.id,
            attemptId: "first",
            at,
            error: { name: "ExecutionBudgetExceededError", message: "Exhausted" },
          },
    ]);
    expect(f.store.promoteSessionState).not.toHaveBeenCalled();
    expect(f.store.hasUnconfirmedTeamLiveDelivery).toHaveBeenCalledWith(f.task.id, "first");
  },
);

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
