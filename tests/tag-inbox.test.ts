import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { INBOX_MAX_HOPS, inboxSessionKey } from "../packages/core/src/index.ts";
import { startObjectiveSession, startSessionHarness } from "./support/objective-session.ts";

/**
 * A Tag's Mailbox is its own inbox conversation: `send_message` stores a message and wakes the
 * recipient's inbox Session, and every message waiting when a turn starts is handled in that one
 * turn.
 */

it("handles the messages waiting for a Tag in one inbox turn, and sends its reply one hop on", async () => {
  const sent: Record<string, string> = {};
  const harness = await startSessionHarness({
    respond: async (turn) => {
      if (turn.kind === "inbox" && turn.tagName === "responder") {
        sent["reply"] = (
          await turn.call("send_message", { to: "planner", text: "All three are in hand." })
        ).text;
        return "Handled the Mailbox.";
      }
      if (turn.kind !== "objective") return "Noted.";
      for (const [key, text] of [
        ["first", "Check the invoices"],
        ["second", "Then the refunds"],
        ["third", "Then the chargebacks"],
        ["fourth", "One more thing"],
      ] as const)
        sent[key] = (await turn.call("send_message", { to: "responder", text })).text;
      return "Asked the responder.";
    },
  });
  try {
    const owner = await harness.tag("planner");
    const responder = await harness.tag("responder");
    // The responder's turns cannot be placed yet, so its first inbox turn waits and the later
    // messages batch into it.
    await harness.store.setTagRunsOn(responder.id, ["gpu"]);
    const session = await startObjectiveSession({
      store: harness.store,
      controlPlane: harness.controlPlane,
      ownerTagId: owner.id,
      memberTagIds: [responder.id],
    });
    await session.waitForOwnerTurn({ reason: "objective_start" });

    // The first message wakes the inbox; the next two join the turn already waiting to start.
    expect(JSON.parse(sent["first"] ?? "{}")).toEqual({
      messageId: expect.any(String),
      session: inboxSessionKey(responder.id),
      status: "queued",
    });
    expect(JSON.parse(sent["second"] ?? "{}").status).toBe("batched");
    expect(JSON.parse(sent["third"] ?? "{}").status).toBe("batched");
    // One turn may send three messages; the fourth is refused.
    expect(sent["fourth"]).toContain("This turn already sent 3 messages");

    await harness.store.setTagRunsOn(responder.id, []);
    const inbox = await session.waitForInboxTurn(responder.id, { reason: "inbox" });
    expect(inbox.task.status).toBe("completed");
    const turn = harness.turns.find((entry) => entry.taskId === inbox.task.id);
    expect(turn?.sessionKey).toBe(inboxSessionKey(responder.id));
    expect(turn?.request.match(/<tag-message from="planner"/gu)).toHaveLength(3);
    for (const text of ["Check the invoices", "Then the refunds", "Then the chargebacks"])
      expect(turn?.request).toContain(text);
    expect(turn?.system).toContain("This is this Tag's inbox");
    expect(turn?.tools).toEqual([
      "read_objective",
      "list_objectives",
      "list_sessions",
      "search_sessions",
      "read_session",
      "start_session",
      "continue_session",
      "send_message",
      "post",
      "read_workstream",
    ]);

    // The three messages are handled by that one Task; the reply carries one more hop.
    const history = (await harness.store.listTagMessageHistory(responder.id)).items;
    const received = history.filter((message) => message.recipientTagId === responder.id);
    expect(received).toHaveLength(3);
    expect(new Set(received.map((message) => message.taskId))).toEqual(new Set([inbox.task.id]));
    expect(received.map((message) => message.status)).toEqual(["handled", "handled", "handled"]);
    expect(received.map((message) => message.hops)).toEqual([0, 0, 0]);
    const reply = history.find((message) => message.senderTagId === responder.id);
    expect(reply).toMatchObject({
      recipientTagId: owner.id,
      text: "All three are in hand.",
      hops: 1,
      sourceTaskId: inbox.task.id,
    });
    expect(JSON.parse(sent["reply"] ?? "{}").status).toBe("queued");
    expect(harness.errors).toEqual([]);
  } finally {
    await harness.close();
  }
}, 60_000);

it("refuses a message that would pass through more inboxes than the hop limit", async () => {
  let refusal = "";
  const harness = await startSessionHarness({
    respond: async (turn) => {
      if (turn.kind === "inbox" && turn.tagName === "responder") {
        refusal = (await turn.call("send_message", { to: "planner", text: "Passing it on" })).text;
        return "Stopped the chain.";
      }
      if (turn.kind !== "objective") return "Noted.";
      await turn.call("send_message", { to: "responder", text: "Fresh request" });
      return "Asked the responder.";
    },
  });
  try {
    const owner = await harness.tag("planner");
    const responder = await harness.tag("responder");
    const session = await startObjectiveSession({
      store: harness.store,
      controlPlane: harness.controlPlane,
      ownerTagId: owner.id,
      memberTagIds: [responder.id],
    });
    // A message that already passed through the whole chain of inboxes, waiting for the turn
    // the Objective's own message wakes.
    const deep = await session.deliverMessage({
      from: owner.id,
      to: responder.id,
      text: "The end of a long chain",
      hops: INBOX_MAX_HOPS,
    });
    await session.waitForOwnerTurn({ reason: "objective_start" });
    const inbox = await session.waitForInboxTurn(responder.id, { reason: "inbox" });

    expect(
      (await harness.store.listTagMessageHistory(responder.id)).items
        .filter((message) => message.taskId === inbox.task.id)
        .map((message) => message.id),
    ).toContain(deep.id);
    expect(refusal).toBe(
      `This message would continue a chain of messages through more than ${INBOX_MAX_HOPS} inboxes; answer in your reply instead`,
    );
    // Nothing was stored for the refused message.
    expect(
      (await harness.store.listTagMessageHistory(owner.id)).items.some(
        (message) => message.senderTagId === responder.id,
      ),
    ).toBe(false);
    expect(harness.errors).toEqual([]);
  } finally {
    await harness.close();
  }
}, 60_000);

it("ends an inbox turn without running it when an earlier turn already took its messages", async () => {
  let claimed!: () => void;
  const claimedInbox = new Promise<void>((resolve) => {
    claimed = resolve;
  });
  let secondSent!: () => void;
  const sentSecond = new Promise<void>((resolve) => {
    secondSent = resolve;
  });
  const harness = await startSessionHarness({
    respond: async (turn) => {
      if (turn.kind !== "objective") return "Noted.";
      await turn.call("send_message", { to: "responder", text: "First" });
      // Sent once the first turn is claimed, so that turn takes this message too.
      await claimedInbox;
      await turn.call("send_message", { to: "responder", text: "Second" });
      secondSent();
      return "Both sent.";
    },
  });
  try {
    const owner = await harness.tag("planner");
    const responder = await harness.tag("responder");
    const inboxKey = inboxSessionKey(responder.id);
    // The window the empty turn needs: the Control Plane claims an inbox turn, then binds the
    // messages waiting for it. A message delivered in between is admitted as a turn of its own
    // and then taken by the turn already claimed.
    const claim = harness.store.claimDueInboundEvent.bind(harness.store);
    let widened = false;
    harness.store.claimDueInboundEvent = async (input) => {
      const event = await claim(input);
      if (event?.sessionKey === inboxKey && !widened) {
        widened = true;
        claimed();
        await sentSecond;
      }
      return event;
    };
    const session = await startObjectiveSession({
      store: harness.store,
      controlPlane: harness.controlPlane,
      ownerTagId: owner.id,
      memberTagIds: [responder.id],
    });
    await session.waitForOwnerTurn({ reason: "objective_start" });
    const inbox = await session.waitForInboxTurn(responder.id, { reason: "inbox" });

    // One turn ran, with both messages.
    const ran = harness.turns.find((turn) => turn.taskId === inbox.task.id);
    expect(ran?.request.match(/<tag-message /gu)).toHaveLength(2);
    expect(harness.turns.filter((turn) => turn.sessionKey === inboxKey)).toHaveLength(1);
    const history = (await harness.store.listTagMessageHistory(responder.id)).items;
    expect(history.map((message) => message.taskId)).toEqual([inbox.task.id, inbox.task.id]);

    // The second turn found nothing to do: it never ran and never reached a Worker.
    const inboxSession = await harness.store.findSessionByTagAndKey(responder.id, inboxKey);
    const taskIds = await harness.store.listSessionTaskIds(inboxSession?.id ?? "");
    expect(taskIds).toHaveLength(2);
    const empty = await harness.store.findTaskById(taskIds[1] ?? "");
    expect(empty?.status).toBe("cancelled");
    expect(
      (await harness.store.listTaskEvents(empty?.id ?? ""))
        .filter((event) => event.type === "task.cancelled")
        .map((event) => event.payload?.["reason"]),
    ).toEqual(["inbox-empty"]);
    expect(await harness.store.listTaskAttempts(empty?.id ?? "")).toEqual([]);
    expect(harness.errors).toEqual([]);
  } finally {
    await harness.close();
  }
}, 60_000);

it("delivers only between Tags that share a Team or that the recipient accepts", async () => {
  const sent: Record<string, string> = {};
  const harness = await startSessionHarness({
    respond: async (turn) => {
      if (turn.kind !== "conversation") return "Noted.";
      sent[turn.request] = (
        await turn.call("send_message", { to: turn.request.split(" ")[1] ?? "", text: "Hello" })
      ).text;
      return "Tried.";
    },
  });
  try {
    const alpha = await harness.tag("alpha");
    const beta = await harness.tag("beta");
    const gamma = await harness.tag("gamma");
    await harness.store.createTeam({
      id: randomUUID(),
      name: "platform",
      memberTagIds: [alpha.id, gamma.id],
    });
    expect(await harness.store.mayMessage(alpha.id, gamma.id)).toBe(true);
    expect(await harness.store.mayMessage(alpha.id, beta.id)).toBe(false);

    const say = async (text: string) => {
      await harness.controlPlane.messageTag({
        tagName: "alpha",
        operatorId: "admin",
        session: text,
        text,
      });
      await expect.poll(() => sent[text], { timeout: 10_000, interval: 50 }).toBeDefined();
      return sent[text] ?? "";
    };
    // A Team they share is enough; without one the recipient must accept the sender.
    expect(JSON.parse(await say("message gamma")).status).toBe("queued");
    expect(await say("message beta")).toBe(
      "Tag beta does not accept messages from this Tag: they share no Team, and it has no grant for this Tag",
    );

    await harness.store.setTagMessagingGrants(beta.id, [alpha.id]);
    expect(await harness.store.mayMessage(alpha.id, beta.id)).toBe(true);
    // A grant is one recipient accepting one sender, not a channel between them.
    expect(await harness.store.mayMessage(beta.id, alpha.id)).toBe(false);
    expect(JSON.parse(await say("message beta again")).status).toBe("queued");
    await expect
      .poll(
        async () =>
          (await harness.store.listTagMessageHistory(beta.id)).items.map(
            (message) => message.status,
          ),
        { timeout: 10_000, interval: 50 },
      )
      .toEqual(["handled"]);
    expect(harness.errors).toEqual([]);
  } finally {
    await harness.close();
  }
}, 60_000);
