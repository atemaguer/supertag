import type { CoordinationInboxItem, Store } from "@supertag/core";
import { describe, expect, it, vi } from "vitest";
import { BudgetNotifications } from "./src/budget-notifications.js";
import { outboundPresentationPolicy } from "./src/outbound-presentation.js";

function fixture() {
  const item: CoordinationInboxItem = {
    projectionVersion: 7,
    key: "task_budget:task",
    kind: "task_budget",
    status: "pending",
    objectiveId: "objective",
    teamId: "team",
    nextActorTagIds: ["manager"],
    excludedActorTagIds: ["worker"],
    operatorEligible: true,
    actionableSince: "2026-09-18T00:00:00Z",
    ageSeconds: 0,
    deadline: null,
    evidence: [
      {
        kind: "task",
        id: "task",
        status: "failed",
        attemptCount: 1,
        updatedAt: "2026-09-18T00:00:00Z",
      },
    ],
    permittedActions: [],
    redaction: { level: "metadata_only", omitted: ["result"] },
  };
  const task = {
    taskId: "task",
    objectiveId: "objective",
    status: "failed",
    attemptCount: 1,
    parentTaskId: null as string | null,
    result: { failureKind: "budget-exhausted" },
    assignedTagId: "worker",
  };
  const objective = {
    id: "objective",
    status: "working",
    notificationTaskId: null as string | null,
  };
  let reply: { status: string; text: string; deliveryKey: string } | undefined;
  const api = {
    readCoordinationInbox: vi.fn(async (query: { kind: string }) => ({
      projectionVersion: 7 as const,
      asOf: "2026-09-18T00:00:00Z",
      items: query.kind === item.kind ? [item] : [],
      truncatedKinds: [],
    })),
    getTaskAssignment: vi.fn(async (_id: string) => task),
    findTagById: vi.fn(async () => ({ status: "active" })),
    getTeam: vi.fn(async () => ({ status: "active", memberTagIds: ["manager"] })),
    getObjective: vi.fn(async () => objective),
    getObjectiveSurfaceTask: vi.fn(async () => ({ id: "origin" }) as { id: string } | undefined),
    getVerifiedSurfaceTask: vi.fn(
      async (id: string) =>
        ({ id, inboundEventId: `inbound-${id}` }) as
          | { id: string; inboundEventId: string }
          | undefined,
    ),
    findOutboundReply: vi.fn(async () => reply),
    enqueueOutboundReply: vi.fn(async (input: { text: string; deliveryKey: string }) => {
      reply ??= { ...input, status: "pending" };
      return reply;
    }),
  };
  const notifier = new BudgetNotifications(api as unknown as Store, "default");
  return {
    item,
    task,
    objective,
    api,
    notifier,
    store: api as unknown as Store,
    getReply: () => reply,
  };
}

describe("budget operator notifications", () => {
  it("uses explicit verified destination without changing Objective origin", async () => {
    const f = fixture();
    f.objective.notificationTaskId = "override";
    await f.notifier.reconcile();
    expect(f.api.getVerifiedSurfaceTask).toHaveBeenCalledWith("override");
    expect(f.api.getObjectiveSurfaceTask).not.toHaveBeenCalled();
    expect(f.api.enqueueOutboundReply).toHaveBeenCalledWith(
      expect.objectContaining({ inboundEventId: "inbound-override", presentation: "error" }),
    );
    expect(f.getReply()?.text).not.toContain("secret");
    expect(f.getReply()?.text).toContain("not approval");
  });
  it("uses the originating conversation before the deployment default", async () => {
    const f = fixture();
    await f.notifier.reconcile();
    expect(f.api.getVerifiedSurfaceTask).toHaveBeenCalledWith("origin");
    f.api.getObjectiveSurfaceTask.mockResolvedValue(undefined);
    await f.notifier.reconcile();
    expect(f.api.getVerifiedSurfaceTask).toHaveBeenCalledWith("default");
  });
  it("reports missing routes explicitly without delivering", async () => {
    const f = fixture();
    f.api.getObjectiveSurfaceTask.mockResolvedValue(undefined);
    const notifier = new BudgetNotifications(f.store);
    expect(await notifier.describe(f.item)).toMatchObject({ status: "unconfigured" });
    await notifier.reconcile();
    expect(f.api.enqueueOutboundReply).not.toHaveBeenCalled();
  });
  it("fails closed for a revoked override rather than notifying a fallback", async () => {
    const f = fixture();
    f.objective.notificationTaskId = "revoked";
    f.api.getVerifiedSurfaceTask.mockRejectedValue(new Error("Revoked"));
    expect(await f.notifier.describe(f.item)).toMatchObject({ status: "failed" });
    await f.notifier.reconcile();
    expect(f.api.enqueueOutboundReply).not.toHaveBeenCalled();
    expect(f.api.getVerifiedSurfaceTask.mock.calls.every(([id]) => id === "revoked")).toBe(true);
  });
  it("leaves a capable authorized parent to the existing manager coordination path", async () => {
    const f = fixture();
    f.task.parentTaskId = "parent";
    f.api.getTaskAssignment.mockImplementation(async (id) =>
      id === "parent" ? { ...f.task, status: "waiting", assignedTagId: "manager" } : f.task,
    );
    expect(await f.notifier.describe(f.item)).toMatchObject({ status: "manager" });
    await f.notifier.reconcile();
    expect(f.api.enqueueOutboundReply).not.toHaveBeenCalled();
    f.api.getTaskAssignment.mockImplementation(async (id) =>
      id === "parent" ? { ...f.task, assignedTagId: "manager" } : f.task,
    );
    await f.notifier.reconcile();
    expect(f.api.enqueueOutboundReply).toHaveBeenCalledOnce();
  });
  it("uses a stable per-Attempt immutable outbox identity across restarts", async () => {
    const f = fixture();
    await f.notifier.reconcile();
    const first = f.getReply()?.deliveryKey;
    await new BudgetNotifications(f.store, "default").reconcile();
    expect(f.api.enqueueOutboundReply.mock.calls[1]?.[0].deliveryKey).toBe(first);
    const reply = f.getReply();
    if (!reply) throw new Error("Missing notice");
    reply.status = "delivered";
    expect(await f.notifier.describe(f.item)).toEqual({ status: "delivered" });
    f.task.attemptCount = 2;
    await f.notifier.reconcile();
    expect(f.api.enqueueOutboundReply.mock.calls[2]?.[0].deliveryKey).not.toBe(first);
    expect(outboundPresentationPolicy({ deliveryKey: first ?? "", presentation: "error" })).toEqual(
      { useAcknowledgement: false, waitForAcknowledgement: false },
    );
  });
  it("revokes queued notices when routing, allocation, or Objective state changes", async () => {
    const f = fixture();
    f.task.taskId = "task:with/segments";
    await f.notifier.reconcile();
    const deliveryKey = f.getReply()?.deliveryKey;
    if (!deliveryKey) throw new Error("Missing queued notification");
    expect(deliveryKey).toBe("task-budget:task%3Awith%2Fsegments:1:origin");
    const outbound = { deliveryKey, inboundEventId: "inbound-origin" };
    expect(await f.notifier.mayDeliver(outbound)).toBe(true);
    expect(await f.notifier.mayDeliver({ ...outbound, inboundEventId: "wrong-inbound" })).toBe(
      false,
    );
    f.objective.notificationTaskId = "replacement";
    expect(await f.notifier.mayDeliver(outbound)).toBe(false);
    f.objective.notificationTaskId = null;
    f.task.attemptCount = 2;
    expect(await f.notifier.mayDeliver(outbound)).toBe(false);
    f.task.attemptCount = 1;
    f.task.status = "queued";
    expect(await f.notifier.mayDeliver(outbound)).toBe(false);
    f.task.status = "failed";
    f.objective.status = "completed";
    expect(await f.notifier.mayDeliver(outbound)).toBe(false);
    f.objective.status = "working";
    f.api.getVerifiedSurfaceTask.mockResolvedValue(undefined);
    expect(await f.notifier.mayDeliver(outbound)).toBe(false);
    for (const key of [
      "task-budget:old-format:hash",
      "task-budget:%broken:1:origin",
      "task-budget:task:NaN:origin",
    ])
      expect(await f.notifier.mayDeliver({ ...outbound, deliveryKey: key })).toBe(false);
  });
  it("does not enqueue stale resolved rows", async () => {
    const f = fixture();
    f.objective.status = "completed";
    await f.notifier.reconcile();
    expect(f.api.enqueueOutboundReply).not.toHaveBeenCalled();
    f.objective.status = "working";
    f.task.status = "queued";
    await f.notifier.reconcile();
    expect(f.api.enqueueOutboundReply).not.toHaveBeenCalled();
  });
});
