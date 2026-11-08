import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { startObjectiveSession, startSessionHarness } from "./support/objective-session.ts";

/**
 * A Workstream is a Team's shared record of its members' posts. A post wakes nobody, except that
 * each Tag it addresses receives it in its Mailbox.
 */

it("records an unaddressed post without waking anyone, and wakes each Tag a post addresses", async () => {
  const results: Record<string, string> = {};
  const harness = await startSessionHarness({
    respond: async (turn) => {
      if (turn.kind !== "objective") return "Noted.";
      results["plain"] = (await turn.call("post", { text: "Checkout latency is 900ms" })).text;
      results["duplicate"] = (await turn.call("post", { text: "Checkout latency is 900ms" })).text;
      results["addressed"] = (
        await turn.call("post", { text: "Taking the refunds path", to: ["responder"] })
      ).text;
      results["outsider"] = (
        await turn.call("post", { text: "Not for you", to: ["outsider"] })
      ).text;
      results["read"] = (await turn.call("read_workstream", {})).text;
      return "Posted.";
    },
  });
  try {
    const owner = await harness.tag("planner");
    const responder = await harness.tag("responder");
    const quiet = await harness.tag("quiet");
    await harness.tag("outsider");
    const session = await startObjectiveSession({
      store: harness.store,
      controlPlane: harness.controlPlane,
      ownerTagId: owner.id,
      memberTagIds: [responder.id, quiet.id],
    });
    await session.waitForOwnerTurn({ reason: "objective_start" });

    // An unaddressed post is the Team's record and nothing else.
    const plain = JSON.parse(results["plain"] ?? "{}");
    expect(plain).toEqual({
      post: { id: expect.any(String), team: session.team.name, sequence: 1, to: [] },
      duplicate: false,
      delivered: [],
    });
    // The same text from the same Task again stores nothing new.
    expect(JSON.parse(results["duplicate"] ?? "{}")).toEqual({
      post: { id: plain.post.id, team: session.team.name, sequence: 1, to: [] },
      duplicate: true,
      delivered: [],
    });

    // An addressed post reaches that member's Mailbox, and only that member's.
    const addressed = JSON.parse(results["addressed"] ?? "{}");
    expect(addressed).toMatchObject({
      post: { sequence: 2, to: [responder.id] },
      duplicate: false,
      delivered: [{ messageId: expect.any(String), status: "queued" }],
    });
    expect(results["outsider"]).toContain(`is not a member of Team ${session.team.name}`);
    const inbox = await session.waitForInboxTurn(responder.id, { reason: "inbox" });
    const delivered = (await harness.store.listTagMessageHistory(responder.id)).items;
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatchObject({
      senderTagId: owner.id,
      recipientTagId: responder.id,
      text: "Taking the refunds path",
      workstreamPostId: addressed.post.id,
      objectiveId: session.objective.id,
      taskId: inbox.task.id,
      status: "handled",
    });
    expect(harness.turns.find((turn) => turn.taskId === inbox.task.id)?.request).toContain(
      'via="workstream post"',
    );
    // The member the posts did not address was never woken.
    expect((await harness.store.listTagMessageHistory(quiet.id)).items).toEqual([]);
    expect(
      await harness.store.findSessionByTagAndKey(quiet.id, `inbox:${quiet.id}`),
    ).toBeUndefined();

    // Every member reads the same Workstream, in sequence.
    expect(JSON.parse(results["read"] ?? "{}")).toMatchObject({
      team: session.team.name,
      posts: [
        { sequence: 1, body: "Checkout latency is 900ms", authorTagId: owner.id, to: [] },
        { sequence: 2, body: "Taking the refunds path", to: [responder.id] },
      ],
    });
    expect(await harness.store.listTeamPosts(session.team.id)).toHaveLength(2);
    expect(harness.errors).toEqual([]);
  } finally {
    await harness.close();
  }
}, 60_000);

it("posts to the Tag's own Team outside an Objective, and says so when there is not exactly one", async () => {
  const results: Record<string, string> = {};
  const harness = await startSessionHarness({
    respond: async (turn) => {
      if (turn.kind !== "conversation") return "Noted.";
      results[turn.request] = (
        await turn.call("post", { text: `Working on ${turn.request}` })
      ).text;
      return "Posted.";
    },
  });
  try {
    const alpha = await harness.tag("alpha");
    const beta = await harness.tag("beta");
    const say = async (text: string) => {
      await harness.controlPlane.messageTag({
        tagName: "alpha",
        operatorId: "admin",
        session: text,
        text,
      });
      await expect.poll(() => results[text], { timeout: 10_000, interval: 50 }).toBeDefined();
      return results[text] ?? "";
    };

    // A Tag in no Team has no Workstream.
    expect(await say("none")).toBe("This Tag is in no Team, so it has no Workstream");

    const platform = await harness.store.createTeam({
      id: randomUUID(),
      name: "platform",
      memberTagIds: [alpha.id, beta.id],
    });
    const only = JSON.parse(await say("one"));
    expect(only).toMatchObject({ post: { team: "platform", sequence: 1 }, duplicate: false });
    expect(await harness.store.listTeamPosts(platform.id)).toMatchObject([
      { authorTagId: alpha.id, body: "Working on one", to: [] },
    ]);

    // With several Teams only an Objective's turn knows which Workstream is meant.
    await harness.store.createTeam({
      id: randomUUID(),
      name: "billing",
      memberTagIds: [alpha.id],
    });
    expect(await say("several")).toBe(
      "This Tag is in several Teams (billing, platform); only an Objective's turn has one Workstream",
    );
    expect(harness.errors).toEqual([]);
  } finally {
    await harness.close();
  }
}, 60_000);
