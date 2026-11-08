import { expect, it } from "vitest";
import { objectiveBlockedText } from "../packages/control-plane/src/objective-sessions.ts";
import { objectiveReportKey } from "../packages/control-plane/src/outbound-presentation.ts";
import { approvalArgumentsDigest } from "../packages/core/src/index.ts";
import { startObjectiveSession, startSessionHarness } from "./support/objective-session.ts";

/**
 * An Objective is a conversation with a goal: the owner Tag's `objective:<id>` Session. Every
 * turn of it is delivered — the start, a work Session's report, an operator's message, an
 * approval decision, the idle wake — and each ends done or waiting.
 */

it("delivers the start, runs the work in a work Session and reports its result back", async () => {
  const harness = await startSessionHarness({
    respond: async (turn) => {
      if (turn.kind === "work_session") return `Found the answer to ${turn.request}.`;
      if (turn.internal?.kind === "session_report") return "Accepted.";
      await turn.call("start_session", {
        title: "billing probe",
        instruction: "Measure the billing lag",
      });
      return "On it.";
    },
  });
  try {
    const owner = await harness.tag("planner");
    const session = await startObjectiveSession({
      store: harness.store,
      controlPlane: harness.controlPlane,
      ownerTagId: owner.id,
      objective: { outcome: "Ship the billing report" },
    });
    const start = await session.waitForOwnerTurn({ reason: "objective_start" });
    expect(start.task.id).toBe(session.startTaskId);
    expect(start.task.status).toBe("completed");
    expect(start.turn).toEqual({
      kind: "delivery",
      from: { kind: "supertag" },
      reason: "objective_start",
      objectiveId: session.objective.id,
    });

    // The Objective's own Session: the owner Tag's, a root Session, and the Objective's.
    const ownerSession = await harness.store.findObjectiveOwnerSession(session.objective.id);
    expect(ownerSession).toMatchObject({
      tagId: owner.id,
      sessionKey: `objective:${session.objective.id}`,
      objectiveId: session.objective.id,
    });
    expect(ownerSession?.parentSessionId).toBeUndefined();
    // The owner's Task belongs to the Objective, so its spend draws on the Objective's pool.
    expect(start.task.objectiveId).toBe(session.objective.id);
    expect((await harness.store.getObjective(session.objective.id)).executionStartedAt).toEqual(
      expect.any(String),
    );

    // The owner turn is told what the turn is, carries the outcome, and gets the owner tools.
    const [startTurn] = harness.turnsOf(ownerSession?.id ?? "");
    expect(startTurn?.system).toContain(
      `This is the conversation of Objective ${session.objective.id}`,
    );
    expect(startTurn?.system).toContain("The Objective just started");
    expect(startTurn?.request).toContain("<objective-outcome>\nShip the billing report");
    expect(startTurn?.request).toContain(`Objective ${session.objective.id} has started.`);
    expect(startTurn?.tools).toEqual([
      "read_objective",
      "update_objective",
      "list_sessions",
      "search_sessions",
      "read_session",
      "start_session",
      "continue_session",
      "ask",
      "send_message",
      "post",
      "read_workstream",
    ]);

    // The work Session: the owner Tag's, under the Objective, and it sees only its own work.
    const report = await session.waitForReport();
    expect(report.report).toMatchObject({
      kind: "session_report",
      title: "billing probe",
      status: "completed",
      startedByTaskId: session.startTaskId,
    });
    expect(report.report.result).toContain("Found the answer to Measure the billing lag.");
    const work = await harness.store.findSessionById(report.report.workSessionId);
    expect(work).toMatchObject({
      tagId: owner.id,
      parentSessionId: ownerSession?.id,
      objectiveId: session.objective.id,
    });
    const workTurn = harness.turns.find((turn) => turn.kind === "work_session");
    expect(workTurn?.tools).toEqual(["ask"]);
    expect(workTurn?.request).toBe("Measure the billing lag");

    // The report is a turn of the Objective's own Session, by the owner Tag.
    expect(report.task.sessionId).toBe(ownerSession?.id);
    expect(report.task.status).toBe("completed");
    const reportTurn = harness.turnsOf(ownerSession?.id ?? "")[1];
    expect(reportTurn?.system).toContain(
      'Work Session "billing probe" (' +
        report.report.workSessionId +
        "), which this Objective started, has completed.",
    );
    expect(reportTurn?.request).toContain("Found the answer to Measure the billing lag.");
    expect(harness.errors).toEqual([]);
  } finally {
    await harness.close();
  }
}, 60_000);

it("delivers an operator's message as the next turn and puts a blocked Objective back to work", async () => {
  const harness = await startSessionHarness({ respond: async () => "Noted." });
  try {
    const owner = await harness.tag("planner");
    const session = await startObjectiveSession({
      store: harness.store,
      controlPlane: harness.controlPlane,
      ownerTagId: owner.id,
    });
    await session.waitForOwnerTurn({ reason: "objective_start" });
    const objective = await harness.store.getObjective(session.objective.id);
    await harness.store.updateObjectiveStatus(objective.id, {
      status: "blocked",
      expectedRevision: objective.revision,
    });

    const sent = await harness.controlPlane.messageObjective({
      objectiveId: session.objective.id,
      text: "Focus on solo practices instead",
      operatorId: "admin",
      idempotencyKey: "direction-1",
    });
    expect(sent).toMatchObject({ duplicate: false, statusChange: "blocked" });
    expect((await harness.store.getObjective(session.objective.id)).status).toBe("working");

    const turn = await session.waitForOwnerTurn({ reason: "objective_message" });
    expect(turn.task.id).toBe(sent.taskId);
    expect(turn.turn).toMatchObject({
      kind: "delivery",
      reason: "objective_message",
      from: { kind: "person", id: "admin" },
      objectiveId: session.objective.id,
    });
    const delivered = harness.turns.find((entry) => entry.taskId === sent.taskId);
    expect(delivered?.request).toContain("Focus on solo practices instead");
    expect(delivered?.system).toContain("An operator wrote to this Objective");

    // The same idempotency key is the same turn, not a second one.
    const repeat = await harness.controlPlane.messageObjective({
      objectiveId: session.objective.id,
      text: "Focus on solo practices instead",
      operatorId: "admin",
      idempotencyKey: "direction-1",
    });
    expect(repeat).toEqual({ duplicate: true, taskId: sent.taskId });
    expect(
      (await harness.store.listSessionTaskIds(turn.task.sessionId)).filter(
        (id) => id === sent.taskId,
      ),
    ).toEqual([sent.taskId]);
    expect(harness.errors).toEqual([]);
  } finally {
    await harness.close();
  }
}, 60_000);

it("ends an owner turn waiting on ask, tells the operator, and continues with their answer", async () => {
  const asked: string[] = [];
  const harness = await startSessionHarness({
    respond: async (turn) => {
      if (turn.internal?.kind !== "delivery" || turn.internal.reason !== "objective_start")
        return "Thanks, carrying on.";
      const result = await turn.call("ask", { question: "Which region should I start in?" });
      asked.push(result.text);
      return "I need the region.";
    },
  });
  try {
    const owner = await harness.tag("planner");
    const session = await startObjectiveSession({
      store: harness.store,
      controlPlane: harness.controlPlane,
      ownerTagId: owner.id,
    });
    const start = await session.waitForOwnerTurn({ reason: "objective_start" });
    expect(start.task.status).toBe("completed");
    expect(start.task.outcome?.["question"]).toBe("Which region should I start in?");
    expect(asked[0]).toContain("their answer arrives as this conversation's next turn");

    // The operator sees the question in the coordination inbox, not a Task of their own.
    const inbox = await harness.controlPlane.objectives.readCoordinationInbox({ kind: "question" });
    expect(inbox.items).toMatchObject([
      {
        kind: "question",
        objectiveId: session.objective.id,
        reason: `Objective ${session.objective.id} asked a question and waits on the answer.`,
      },
    ]);
    expect(JSON.stringify(inbox.items)).toContain("Which region should I start in?");

    // The answer is an operator message: the Objective's next turn, in the same Session.
    const answered = await harness.controlPlane.messageObjective({
      objectiveId: session.objective.id,
      text: "Start in EU.",
      operatorId: "admin",
      idempotencyKey: "answer-1",
    });
    const next = await session.waitForOwnerTurn({ reason: "objective_message" });
    expect(next.task.id).toBe(answered.taskId);
    expect(next.task.sessionId).toBe(start.task.sessionId);
    expect(harness.turns.find((turn) => turn.taskId === answered.taskId)?.request).toContain(
      "Start in EU.",
    );
    expect(harness.errors).toEqual([]);
  } finally {
    await harness.close();
  }
}, 60_000);

it("ends an owner turn waiting on an approval request and continues it with the decision", async () => {
  let action: Record<string, unknown> = {};
  const requests: string[] = [];
  const harness = await startSessionHarness({
    respond: async (turn) => {
      const result = await turn.call("request_action_approval", {
        action,
        argumentsDigest: approvalArgumentsDigest({ pull: 7 }),
        summary: "github merge_pull_request on acme/repo #7",
      });
      requests.push(result.text);
      return (result.json as { status?: string } | undefined)?.status === "pending"
        ? "Waiting on the approval."
        : "Merged.";
    },
  });
  try {
    const owner = await harness.tag("planner");
    const account = await harness.store.saveSurfaceAccount({
      provider: "github",
      externalAccountId: "github-objective-sessions",
      displayName: "GitHub",
      authMethod: "simulation",
      credentialId: "unused",
      status: "connected",
      configuration: {},
      verifiedAt: new Date().toISOString(),
    });
    const set = await harness.store.createTagPermissionSet({ name: "release" });
    await harness.store.addTagPermission({
      permissionSetId: set.id,
      target: "surface",
      surfaceAccountId: account.id,
      scope: "repository:1",
      reference: "acme/repo",
      action: "pull-requests:merge",
      approval: "required",
    });
    const role = await harness.store.createRole({
      name: "Release",
      purpose: "Release",
      instructions: "Merge reviewed changes.",
      contextSetIds: [],
      permissionSetIds: [set.id],
    });
    await harness.store.assignRole({ roleId: role.id, tagId: owner.id });
    action = {
      target: "surface",
      surfaceAccountId: account.id,
      scope: "repository:1",
      action: "pull-requests:merge",
      provider: "github",
      toolName: "merge_pull_request",
    };
    const session = await startObjectiveSession({
      store: harness.store,
      controlPlane: harness.controlPlane,
      ownerTagId: owner.id,
    });

    const start = await session.waitForOwnerTurn({ reason: "objective_start" });
    const pending = JSON.parse(requests[0] ?? "{}") as { status: string; requestId: string };
    expect(pending.status).toBe("pending");
    expect(start.task.status).toBe("completed");
    expect(start.task.outcome?.["approvals"]).toEqual([pending.requestId]);
    expect(requests[0]).toContain(
      `This Task ends waiting on approval of request ${pending.requestId}`,
    );

    // The decision continues the Objective's own Session, and the retried call is granted.
    await harness.controlPlane.objectives.decideApprovalRequest({
      requestId: pending.requestId,
      decision: "approve",
    });
    const resumed = await session.waitForOwnerTurn({ reason: "approval_decision" });
    expect(resumed.task.sessionId).toBe(start.task.sessionId);
    expect(resumed.turn).toMatchObject({
      kind: "delivery",
      reason: "approval_decision",
      objectiveId: session.objective.id,
    });
    const resumedTurn = harness.turns.find((turn) => turn.taskId === resumed.task.id);
    expect(resumedTurn?.system).toContain(
      "An approval request your last turn waited on was decided",
    );
    expect(resumedTurn?.request).toContain(pending.requestId);
    expect((JSON.parse(requests[1] ?? "{}") as { status: string }).status).toBe("granted");
    expect(harness.errors).toEqual([]);
  } finally {
    await harness.close();
  }
}, 60_000);

it("wakes an idle Objective once, then blocks it; an ongoing Objective is left alone", async () => {
  const harness = await startSessionHarness({ respond: async () => "Nothing to do." });
  try {
    const owner = await harness.tag("planner");
    const common = { store: harness.store, controlPlane: harness.controlPlane } as const;
    const session = await startObjectiveSession({ ...common, ownerTagId: owner.id });
    const ongoing = await startObjectiveSession({
      ...common,
      ownerTagId: owner.id,
      objective: { outcome: "Watch the error rate", ongoing: true },
    });
    await session.waitForOwnerTurn({ reason: "objective_start" });
    await ongoing.waitForOwnerTurn({ reason: "objective_start" });

    // Nothing runs and nothing was asked, so the Objective is woken exactly once.
    const idle = await session.waitForOwnerTurn({ reason: "objective_idle" });
    const woken = harness.turns.find((turn) => turn.taskId === idle.task.id);
    expect(woken?.request).toContain(`Nothing is running in Objective ${session.objective.id}`);
    expect(woken?.system).toContain("the Objective is blocked and the operator is told");

    // The wake also ended idle, so the Objective is blocked and told so in its home thread.
    await expect
      .poll(async () => (await harness.store.getObjective(session.objective.id)).status, {
        timeout: 30_000,
        interval: 200,
      })
      .toBe("blocked");
    const anchor = (await harness.store.findTaskById(session.startTaskId))?.inboundEventId ?? "";
    const notice = await harness.store.findOutboundReply(
      anchor,
      objectiveReportKey(session.objective.id, `objective-blocked:${idle.task.id}`),
    );
    expect(notice?.text).toBe(objectiveBlockedText(session.objective.id));
    // No third owner turn: a blocked Objective waits for an operator.
    expect(
      harness.turnsOf(idle.task.sessionId).filter((turn) => turn.kind === "objective"),
    ).toHaveLength(2);

    // The ongoing Objective is exempt from the stall rule: it keeps its one turn and its status.
    const ongoingSession = await harness.store.findObjectiveOwnerSession(ongoing.objective.id);
    expect(harness.turnsOf(ongoingSession?.id ?? "")).toHaveLength(1);
    expect((await harness.store.getObjective(ongoing.objective.id)).status).toBe("working");
  } finally {
    await harness.close();
  }
}, 90_000);
