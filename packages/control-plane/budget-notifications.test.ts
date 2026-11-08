import type { CoordinationInboxItem, Store } from "@supertag/core";
import { describe, expect, it, vi } from "vitest";
import { BudgetNotifications } from "./src/budget-notifications.js";
import { outboundPresentationPolicy } from "./src/outbound-presentation.js";

function fixture() {
  const item: CoordinationInboxItem = {
    projectionVersion: 8,
    key: "objective_budget:objective:budget-exhausted-100",
    kind: "objective_budget",
    status: "pending",
    objectiveId: "objective",
    nextActorTagIds: [],
    excludedActorTagIds: [],
    operatorEligible: true,
    actionableSince: "2026-09-18T00:00:00Z",
    ageSeconds: 0,
    deadline: null,
    evidence: [{ kind: "objective", id: "objective", revision: 1 }],
    permittedActions: [],
    redaction: { level: "metadata_only", omitted: ["result"] },
  };
  const objective = {
    id: "objective",
    status: "working",
    notificationTaskId: null as string | null,
    surfaceTaskId: "origin" as string | null,
    deadline: null as string | null,
    budgetLimitMinor: null as number | null,
    budgetCurrency: null as string | null,
    limitState: null as Record<string, unknown> | null,
    createdAt: "2026-09-17T00:00:00Z",
  };
  let reply: { status: string; text: string; deliveryKey: string } | undefined;
  const api = {
    readCoordinationInbox: vi.fn(async (query: { kind: string }) => ({
      projectionVersion: 8 as const,
      asOf: "2026-09-18T00:00:00Z",
      items: query.kind === item.kind ? [item] : [],
      truncatedKinds: [],
    })),
    getObjective: vi.fn(async () => objective),
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
  return { item, objective, api, notifier, store: api as unknown as Store, getReply: () => reply };
}

describe("Objective budget notices", () => {
  it("posts the notice to the operator's chosen home thread before the Objective's own", async () => {
    const f = fixture();
    f.objective.notificationTaskId = "override";
    await f.notifier.reconcile();
    expect(f.api.getVerifiedSurfaceTask).toHaveBeenCalledWith("override");
    expect(f.api.getVerifiedSurfaceTask).not.toHaveBeenCalledWith("origin");
    expect(f.api.enqueueOutboundReply).toHaveBeenCalledWith(
      // Error presentation is immutable in the outbox, so a repeated sweep posts once.
      expect.objectContaining({ inboundEventId: "inbound-override", presentation: "error" }),
    );
    expect(f.getReply()?.text).toContain('Objective "objective"');
    expect(f.getReply()?.text).toContain("supertag update objective");
  });

  it("falls back from the Objective's own thread to the deployment default", async () => {
    const f = fixture();
    await f.notifier.reconcile();
    expect(f.api.getVerifiedSurfaceTask).toHaveBeenCalledWith("origin");
    expect(f.api.getVerifiedSurfaceTask).not.toHaveBeenCalledWith("default");
    f.objective.surfaceTaskId = null;
    await f.notifier.reconcile();
    expect(f.api.getVerifiedSurfaceTask).toHaveBeenCalledWith("default");
  });

  it("reports a CLI home as unconfigured without delivering", async () => {
    const f = fixture();
    f.objective.surfaceTaskId = null;
    const notifier = new BudgetNotifications(f.store);
    expect(await notifier.describe(f.item)).toMatchObject({ status: "unconfigured" });
    await notifier.reconcile();
    expect(f.api.enqueueOutboundReply).not.toHaveBeenCalled();
  });

  it("fails closed for a revoked override rather than notifying a fallback", async () => {
    const f = fixture();
    f.objective.notificationTaskId = "revoked";
    f.api.getVerifiedSurfaceTask.mockRejectedValue(new Error("Revoked"));
    // A chosen destination that no longer verifies is reported as failed, not unconfigured.
    expect(await f.notifier.describe(f.item)).toMatchObject({
      status: "failed",
      reason: expect.stringContaining("could not be verified"),
    });
    await f.notifier.reconcile();
    expect(f.api.enqueueOutboundReply).not.toHaveBeenCalled();
  });

  it("reports an unavailable Objective and a closed one without delivering", async () => {
    const f = fixture();
    f.objective.status = "completed";
    expect(await f.notifier.describe(f.item)).toMatchObject({ status: "pending" });
    await f.notifier.reconcile();
    expect(f.api.enqueueOutboundReply).not.toHaveBeenCalled();
    f.api.getObjective.mockRejectedValue(new Error("gone"));
    expect(await f.notifier.describe(f.item)).toMatchObject({ status: "failed" });
  });

  it("uses one immutable outbox identity per item and home across restarts", async () => {
    const f = fixture();
    await f.notifier.reconcile();
    const first = f.getReply()?.deliveryKey;
    expect(first).toBe("objective-budget:objective:budget-exhausted-100:origin");
    await new BudgetNotifications(f.store, "default").reconcile();
    expect(f.api.enqueueOutboundReply.mock.calls[1]?.[0].deliveryKey).toBe(first);
    const reply = f.getReply();
    if (!reply) throw new Error("Missing notice");
    reply.status = "delivered";
    expect(await f.notifier.describe(f.item)).toEqual({ status: "delivered" });
    expect(outboundPresentationPolicy({ deliveryKey: first ?? "", presentation: "error" })).toEqual(
      { useAcknowledgement: false, waitForAcknowledgement: false },
    );
  });

  it("revokes a queued notice when the home thread or the Objective changes", async () => {
    const f = fixture();
    await f.notifier.reconcile();
    const deliveryKey = f.getReply()?.deliveryKey;
    if (!deliveryKey) throw new Error("Missing queued notification");
    const outbound = { deliveryKey, inboundEventId: "inbound-origin" };
    expect(await f.notifier.mayDeliver(outbound)).toBe(true);
    expect(await f.notifier.mayDeliver({ ...outbound, inboundEventId: "wrong-inbound" })).toBe(
      false,
    );
    f.objective.notificationTaskId = "replacement";
    expect(await f.notifier.mayDeliver(outbound)).toBe(false);
    f.objective.notificationTaskId = null;
    f.objective.status = "completed";
    expect(await f.notifier.mayDeliver(outbound)).toBe(false);
    f.objective.status = "working";
    f.api.getVerifiedSurfaceTask.mockResolvedValue(undefined);
    expect(await f.notifier.mayDeliver(outbound)).toBe(false);
    for (const key of ["objective-budget:old-format", "task-budget:objective:key:origin"])
      expect(await f.notifier.mayDeliver({ ...outbound, deliveryKey: key })).toBe(false);
  });

  it("drops a limit notice once the limit it names no longer applies", async () => {
    const f = fixture();
    const limit: CoordinationInboxItem = {
      ...f.item,
      kind: "objective_limit",
      key: "objective_limit:objective:deadline-60",
      reason: "The deadline is an hour away.",
    };
    f.api.readCoordinationInbox.mockImplementation(async (query: { kind: string }) => ({
      projectionVersion: 8 as const,
      asOf: "2026-09-18T00:00:00Z",
      items: query.kind === "objective_limit" ? [limit] : [],
      truncatedKinds: [],
    }));
    expect(await f.notifier.describe(limit)).toMatchObject({ status: "pending" });
    await f.notifier.reconcile();
    expect(f.api.enqueueOutboundReply).not.toHaveBeenCalled();
    expect(
      await f.notifier.mayDeliver({
        deliveryKey: "objective-limit:objective:deadline-60:origin",
        inboundEventId: "inbound-origin",
      }),
    ).toBe(false);
  });

  it("enriches only budget and limit items of an inbox page", async () => {
    const f = fixture();
    const question: CoordinationInboxItem = { ...f.item, kind: "question", key: "question:x" };
    const page = await f.notifier.enrich({
      projectionVersion: 8,
      asOf: "2026-09-18T00:00:00Z",
      items: [f.item, question],
      truncatedKinds: [],
    });
    expect(page.items[0]?.notification).toMatchObject({ status: "pending" });
    expect(page.items[1]?.notification).toBeUndefined();
  });
});
