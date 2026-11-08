import { expect, it } from "vitest";
import { startObjectiveSession, startSessionHarness } from "./support/objective-session.ts";

/**
 * Delegation is `start_session {tag}`: a Tag's work for another Tag is an ordinary work Session
 * whose parent is the Objective's own Session. Only an Objective's turn may delegate, and only
 * to an active member of its Team that a Worker Host can run.
 */

it("starts a Team member's work Session from an Objective's turn and reports it back", async () => {
  const refusals: Record<string, string> = {};
  const harness = await startSessionHarness({
    respond: async (turn) => {
      if (turn.kind === "work_session") return `${turn.tagName} did ${turn.request}.`;
      if (turn.internal?.kind === "session_report") return "Accepted.";
      if (turn.kind === "conversation") {
        refusals["conversation"] = (
          await turn.call("start_session", {
            title: "from a conversation",
            instruction: "Measure it",
            tag: "researcher",
          })
        ).text;
        return "Not from here.";
      }
      for (const [key, tag] of [
        ["outsider", "outsider"],
        ["unbound", "unbound"],
        ["retired", "retired"],
        ["missing", "nobody"],
      ] as const)
        refusals[key] = (
          await turn.call("start_session", { title: key, instruction: "Measure it", tag })
        ).text;
      await turn.call("start_session", {
        title: "latency study",
        instruction: "Measure the checkout latency",
        tag: "researcher",
      });
      return "Delegated.";
    },
  });
  try {
    const owner = await harness.tag("planner");
    const researcher = await harness.tag("researcher");
    const outsider = await harness.tag("outsider");
    const retired = await harness.tag("retired");
    // A retired Tag is no target at all, and a member with no Worker Host binding cannot run.
    const unbound = await harness.store.createTag({ name: "unbound" });
    await harness.store.retireTag(retired.id);
    const session = await startObjectiveSession({
      store: harness.store,
      controlPlane: harness.controlPlane,
      ownerTagId: owner.id,
      memberTagIds: [researcher.id, unbound.id],
      objective: { outcome: "Cut checkout latency" },
    });
    await session.waitForOwnerTurn({ reason: "objective_start" });

    // The target must be a member of the Objective's Team, active, and able to run Tasks.
    expect(refusals["outsider"]).toContain(
      `Tag ${outsider.name} is not a member of Team ${session.team.name}`,
    );
    expect((refusals["outsider"] ?? "").split("; members: ")[1]?.split(", ").toSorted()).toEqual([
      "planner",
      "researcher",
      "unbound",
    ]);
    expect(refusals["unbound"]).toBe(
      "Tag unbound cannot accept Tasks because it has no Worker Host binding",
    );
    expect(refusals["retired"]).toBe("Tag retired does not exist");
    expect(refusals["missing"]).toBe("Tag nobody does not exist");

    // The delegated work is an ordinary work Session: the member's Tag, the Objective's Session
    // as its parent, and its result returns to the Objective as a report turn.
    const report = await session.waitForReport();
    expect(report.report.title).toBe("latency study");
    const work = await harness.store.findSessionById(report.report.workSessionId);
    const ownerSession = await harness.store.findObjectiveOwnerSession(session.objective.id);
    expect(work).toMatchObject({
      tagId: researcher.id,
      parentSessionId: ownerSession?.id,
      objectiveId: session.objective.id,
    });
    expect(work?.sessionKey).toMatch(new RegExp(`^work:${ownerSession?.id}:`, "u"));
    const workTurn = harness.turns.find((turn) => turn.kind === "work_session");
    expect(workTurn?.tagName).toBe("researcher");
    expect(workTurn?.request).toBe("Measure the checkout latency");
    expect(report.report.result).toContain("researcher did Measure the checkout latency.");
    // It runs as the member Tag under the Objective's authorization, not the owner's.
    const workTask = await harness.store.findTaskById(workTurn?.taskId ?? "");
    expect(workTask?.authorizationSnapshot.tag).toMatchObject({ id: researcher.id });
    expect(workTask?.objectiveId).toBe(session.objective.id);

    // A conversation turn of the same Tag may not delegate: it has no Objective and no pool.
    await harness.controlPlane.messageTag({
      tagName: "planner",
      operatorId: "admin",
      session: "chat",
      text: "Can you hand this to researcher?",
    });
    await expect
      .poll(() => refusals["conversation"], { timeout: 10_000, interval: 50 })
      .toContain("Only an Objective's turn starts a work Session of another Tag");
    expect(harness.errors).toEqual([]);
  } finally {
    await harness.close();
  }
}, 60_000);

it("holds every Session of a paused Objective, and runs them when it resumes", async () => {
  const harness = await startSessionHarness({
    respond: async (turn) => {
      if (turn.kind === "work_session") return "Measured.";
      if (turn.internal?.kind === "session_report") return "Accepted.";
      if (turn.internal?.kind === "delivery" && turn.internal.reason === "objective_start") {
        // Pausing first makes the work Session's turn one the pause must hold.
        await harness.controlPlane.objectives.pauseObjective({
          objectiveId: turn.objectiveId ?? "",
        });
        await turn.call("start_session", { title: "probe", instruction: "Measure it" });
        return "Paused, with work queued.";
      }
      return "Carrying on.";
    },
  });
  try {
    const owner = await harness.tag("planner");
    const session = await startObjectiveSession({
      store: harness.store,
      controlPlane: harness.controlPlane,
      ownerTagId: owner.id,
    });
    await session.waitForOwnerTurn({ reason: "objective_start" });

    // An operator's message while paused is admitted but waits with everything else.
    const message = await harness.controlPlane.messageObjective({
      objectiveId: session.objective.id,
      text: "Add the EU region",
      operatorId: "admin",
      idempotencyKey: "paused-1",
    });
    await new Promise((resolve) => setTimeout(resolve, 500));
    const ownerSession = await harness.store.findObjectiveOwnerSession(session.objective.id);
    const work = (await harness.store.listObjectiveSessions(session.objective.id)).find(
      (entry) => entry.parentSessionId !== undefined,
    );
    expect((await harness.store.findTaskById(message.taskId))?.status).toBe("pending");
    expect(work?.task?.status).toBe("pending");
    expect(harness.turnsOf(ownerSession?.id ?? "")).toHaveLength(1);
    expect(harness.turns.some((turn) => turn.kind === "work_session")).toBe(false);

    // Resuming releases the whole tree and tells the Objective what it missed.
    const resumed = await harness.controlPlane.objectives.resumeObjective({
      objectiveId: session.objective.id,
    });
    expect(resumed.changed).toBe(true);
    expect(resumed.summary).toContain("paused");
    await expect
      .poll(async () => (await harness.store.findTaskById(message.taskId))?.status, {
        timeout: 15_000,
        interval: 50,
      })
      .toBe("completed");
    const report = await session.waitForReport();
    expect(report.report.result).toContain("Measured.");
    const notice = await session.waitForOwnerTurn({
      reason: "objective_message",
      from: "supertag",
    });
    expect(harness.turns.find((turn) => turn.taskId === notice.task.id)?.request).toContain(
      resumed.summary ?? "",
    );
    expect(harness.errors).toEqual([]);
  } finally {
    await harness.close();
  }
}, 60_000);

it("runs at most the Team's maxConcurrency turns across the Objectives that name it", async () => {
  for (const [maxConcurrency, expected] of [
    [1, 1],
    [3, 2],
  ] as const) {
    let running = 0;
    let peak = 0;
    const harness = await startSessionHarness({
      respond: async (turn) => {
        running += 1;
        peak = Math.max(peak, running);
        try {
          await new Promise((resolve) => setTimeout(resolve, 150));
          if (turn.kind === "work_session") return "Measured.";
          if (turn.internal?.kind === "session_report") return "Accepted.";
          if (turn.internal?.kind === "delivery" && turn.internal.reason === "objective_start") {
            for (const title of ["first", "second"])
              await turn.call("start_session", { title, instruction: `Measure ${title}` });
            return "Two in flight.";
          }
          return "Carrying on.";
        } finally {
          running -= 1;
        }
      },
    });
    try {
      const owner = await harness.tag("planner");
      const session = await startObjectiveSession({
        store: harness.store,
        controlPlane: harness.controlPlane,
        ownerTagId: owner.id,
        maxConcurrency,
        objective: { outcome: "Measure everything" },
      });
      await session.waitForOwnerTurn({ reason: "objective_start" });
      const first = await session.waitForReport();
      const second = await session.waitForReport();
      expect([first, second].map((report) => report.report.status)).toEqual([
        "completed",
        "completed",
      ]);
      expect(peak).toBe(expected);
      expect(harness.errors).toEqual([]);
    } finally {
      await harness.close();
    }
  }
}, 90_000);
