import type { ObjectiveMailboxMessage, Store } from "@supertag/core";
import { describe, expect, it, vi } from "vitest";
import { ObjectiveMessages } from "./src/objective-messages.js";
import { outboundPresentationPolicy } from "./src/outbound-presentation.js";

function fixture(count = 1) {
  const messages: ObjectiveMailboxMessage[] = Array.from({ length: count }, (_, n) => ({
    id: `m-${String(n).padStart(3, "0")}`,
    objectiveId: "objective",
    senderTagId: "owner",
    sourceTaskId: "source",
    type: "message",
    body: { message: `Request ${n}` },
    idempotencyKey: `key-${n}`,
    status: "pending",
    replyMessageId: null,
    repliedByOperatorId: null,
    createdAt: "2026-09-19T00:00:00Z",
    updatedAt: "2026-09-19T00:00:00Z",
  }));
  const outbox = new Map<string, { status: string; text: string }>();
  const state = { destination: "anchor" as string | null, revoked: false };
  const api = {
    listObjectiveMessages: vi.fn(async (input: { limit: number; after?: { id: string } }) =>
      messages
        .filter((m) => m.status === "pending" && (!input.after || m.id > input.after.id))
        .slice(0, input.limit),
    ),
    getObjectiveMessage: vi.fn(async (id: string) => messages.find((m) => m.id === id)),
    getObjective: vi.fn(async () => ({ id: "objective", notificationTaskId: state.destination })),
    getObjectiveSurfaceTask: vi.fn(async () => undefined),
    getVerifiedSurfaceTask: vi.fn(async (id: string) => {
      if (state.revoked) throw new Error("revoked");
      return { id, inboundEventId: `event-${id}` };
    }),
    enqueueOutboundReply: vi.fn(async (input: { deliveryKey: string; text: string }) => {
      if (!outbox.has(input.deliveryKey))
        outbox.set(input.deliveryKey, { status: "pending", text: input.text });
    }),
    findOutboundReply: vi.fn(async (_event: string, key: string) => outbox.get(key)),
  };
  return { state, api, messages, outbox, store: api as unknown as Store };
}
describe("optional operator-message delivery", () => {
  it("retries an unavailable route, keeps immutable identity over restart, and suppresses answered or redirected notices", async () => {
    const f = fixture();
    f.state.destination = null;
    const controller = new ObjectiveMessages(f.store);
    await controller.reconcile();
    expect(f.outbox.size).toBe(0);
    expect(f.messages[0]?.status).toBe("pending");
    f.state.destination = "anchor";
    await controller.reconcile();
    await new ObjectiveMessages(f.store).reconcile();
    expect(f.outbox.size).toBe(1);
    const outbound = { deliveryKey: "operator-message:m-000", inboundEventId: "event-anchor" };
    expect(await controller.mayDeliver(outbound)).toBe(true);
    f.state.revoked = true;
    expect(await controller.mayDeliver(outbound)).toBe(false);
    f.state.revoked = false;
    f.state.destination = "replacement";
    expect(await controller.mayDeliver(outbound)).toBe(false);
    f.state.destination = "anchor";
    const message = f.messages[0];
    if (!message) throw new Error("Missing fixture");
    f.messages[0] = {
      ...message,
      status: "replied",
      replyMessageId: "reply",
      repliedByOperatorId: "operator",
    };
    expect(await controller.mayDeliver(outbound)).toBe(false);
    expect(
      outboundPresentationPolicy({ deliveryKey: outbound.deliveryKey, presentation: "status" }),
    ).toEqual({ useAcknowledgement: false, waitForAcknowledgement: false });
  });
  it("pages across more than one sweep without starving later messages", async () => {
    const f = fixture(53);
    const controller = new ObjectiveMessages(f.store);
    await controller.reconcile();
    expect(f.outbox.size).toBe(50);
    await controller.reconcile();
    expect(f.outbox.size).toBe(53);
    await controller.reconcile();
    expect(f.outbox.size).toBe(53);
  });
});
