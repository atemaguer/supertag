/**
 * FIXTURE walkthrough of one Objective, run against a disposable local Control Plane.
 *
 * Everything here is synthetic: a temporary SQLite state directory, a scripted Worker instead of
 * a model, a simulated GitHub account with no credential, and made-up Tags. It never contacts a
 * live Control Plane, Worker Host, or their state files. Every printed event is labelled FIXTURE.
 *
 * Run from a checkout: pnpm exec tsx examples/objective-walkthrough/walkthrough.ts
 */
import { approvalArgumentsDigest } from "../../packages/core/src/index.ts";
import {
  type ScriptedTurn,
  startObjectiveSession,
  startSessionHarness,
} from "../../tests/support/objective-session.ts";

for (const name of ["SUPERTAG_URL", "SUPERTAG_CONTROL_PLANE_URL", "SUPERTAG_TOKEN"])
  if (process.env[name]) {
    console.error(`Refusing to run: ${name} is set. This walkthrough is local-only.`);
    process.exit(2);
  }

const log = (line: string) => console.log(`FIXTURE ${line}`);

const QUESTION = "Ship the CSV export behind a feature flag?";
const ANSWER = "Yes, behind the csv-export flag.";
let approvalAction: Record<string, unknown> = {};
const approvalCall = (turn: ScriptedTurn) =>
  turn.call("request_action_approval", {
    action: approvalAction,
    argumentsDigest: approvalArgumentsDigest({ pull: 42 }),
    summary: "github merge_pull_request on fixture/app #42",
  });
let interrupted = false;
const workSessions = new Map<string, string>();
const approvalStatus: string[] = [];
let approvalRequestId = "";
let failedWorkSessionId = "";
let resumeResult = "";

const harness = await startSessionHarness({
  respond: async (turn) => {
    if (turn.kind === "work_session" || (turn.kind === "conversation" && turn.tagName !== "lead")) {
      // The scripted Worker throws an injected error on the first Attempt of the API work.
      if (turn.request.includes("CSV API") && !interrupted) {
        interrupted = true;
        throw new Error("FIXTURE injected interruption: scripted Worker error");
      }
      return `${turn.tagName} finished: ${turn.request.split("\n")[0]}`;
    }
    const internal = turn.internal;
    if (internal?.kind === "delivery" && internal.reason === "objective_start") {
      for (const [title, tag, instruction] of [
        ["api", "builder-a", "Build the CSV API endpoint"],
        ["ui", "builder-b", "Add the export button"],
      ] as const) {
        const started = await turn.call("start_session", { title, instruction, tag });
        const id = (started.json as { sessionId?: string } | undefined)?.sessionId;
        if (id) workSessions.set(id, title);
      }
      return "Delegated api and ui.";
    }
    if (internal?.kind === "session_report") {
      if (internal.status === "failed") failedWorkSessionId = internal.workSessionId;
      return internal.status === "failed" ? "Noted the failure; will resume it." : "Accepted.";
    }
    if (internal?.kind === "delivery" && internal.reason === "objective_message") {
      if (turn.request.includes("Resume the interrupted")) {
        const resumed = await turn.call("continue_session", {
          sessionId: failedWorkSessionId,
          message: "Resume the CSV API work after the interruption.",
        });
        resumeResult = (resumed.json as { status?: string } | undefined)?.status ?? resumed.text;
        return "Resumed the interrupted work Session.";
      }
      if (!turn.request.includes(ANSWER)) {
        await turn.call("ask", { question: QUESTION });
        return "Waiting on the operator's answer.";
      }
      const result = await approvalCall(turn);
      const json = result.json as { status?: string; requestId?: string } | undefined;
      approvalStatus.push(json?.status ?? "?");
      approvalRequestId = json?.requestId ?? "";
      return "Waiting on the merge approval.";
    }
    if (internal?.kind === "delivery" && internal.reason === "approval_decision") {
      const result = await approvalCall(turn);
      approvalStatus.push((result.json as { status?: string } | undefined)?.status ?? "?");
      return "Merged.";
    }
    return "Nothing to do.";
  },
});

try {
  log("disposable Control Plane started (temporary SQLite state, scripted Worker)");
  const lead = await harness.tag("lead");
  const builderA = await harness.tag("builder-a");
  const builderB = await harness.tag("builder-b");
  const account = await harness.store.saveSurfaceAccount({
    provider: "github",
    externalAccountId: "fixture-github",
    displayName: "FIXTURE GitHub",
    authMethod: "simulation",
    credentialId: "fixture-no-credential",
    status: "connected",
    configuration: {},
    verifiedAt: new Date().toISOString(),
  });
  const set = await harness.store.createTagPermissionSet({ name: "fixture-release" });
  await harness.store.addTagPermission({
    permissionSetId: set.id,
    target: "surface",
    surfaceAccountId: account.id,
    scope: "repository:1",
    reference: "fixture/app",
    action: "pull-requests:merge",
    approval: "required",
  });
  const role = await harness.store.createRole({
    name: "Lead",
    purpose: "Own the Objective",
    instructions: "Delegate, integrate, merge reviewed changes.",
    contextSetIds: [],
    permissionSetIds: [set.id],
  });
  await harness.store.assignRole({ roleId: role.id, tagId: lead.id });
  approvalAction = {
    target: "surface",
    surfaceAccountId: account.id,
    scope: "repository:1",
    action: "pull-requests:merge",
    provider: "github",
    toolName: "merge_pull_request",
  };
  log("Tags lead, builder-a, builder-b on one Team; merge requires approval");

  const session = await startObjectiveSession({
    store: harness.store,
    controlPlane: harness.controlPlane,
    ownerTagId: lead.id,
    memberTagIds: [builderA.id, builderB.id],
    objective: { outcome: "FIXTURE: add CSV export to the reports page" },
  });
  log("Objective started: add CSV export to the reports page");
  await session.waitForOwnerTurn({ reason: "objective_start" });
  log(
    `lead split the outcome into ${workSessions.size} work Sessions: api -> builder-a, ui -> builder-b`,
  );

  // Both first reports arrive in any order: api's failed Attempt and ui's completed one.
  const reports = new Map<string, string>();
  while (reports.size < 2) {
    const { report } = await session.waitForReport();
    reports.set(workSessions.get(report.workSessionId) ?? "?", report.status);
  }
  log(`work Session ui reported: ${reports.get("ui")}`);
  log(
    `INTERRUPTION injected: scripted Worker threw an error on the api Task Attempt; report status ${reports.get("api")}`,
  );

  // Recovery: the operator tells the lead to resume; the lead continues the same work Session.
  await harness.controlPlane.messageObjective({
    objectiveId: session.objective.id,
    text: "Resume the interrupted api work.",
    operatorId: "fixture-operator",
    idempotencyKey: "fixture-resume",
  });
  await session.waitForOwnerTurn({ reason: "objective_message" });
  log(`lead continued work Session api: ${resumeResult}`);
  const resumed = await session.waitForReport(failedWorkSessionId);
  log(
    `RECOVERY observed: work Session api resumed in the same Session and reported ${resumed.report.status}`,
  );

  // A human question: the operator prompts, the lead asks, the question surfaces, it is answered.
  await harness.controlPlane.messageObjective({
    objectiveId: session.objective.id,
    text: "Before merging, ask me how to ship it.",
    operatorId: "fixture-operator",
    idempotencyKey: "fixture-prompt",
  });
  const asked = await session.waitForOwnerTurn({ reason: "objective_message" });
  const questions = await harness.controlPlane.objectives.readCoordinationInbox({
    kind: "question",
  });
  log(
    `QUESTION surfaced in coordination inbox (${questions.items.length} item): "${asked.task.outcome?.["question"]}"`,
  );
  await harness.controlPlane.messageObjective({
    objectiveId: session.objective.id,
    text: ANSWER,
    operatorId: "fixture-operator",
    idempotencyKey: "fixture-answer",
  });
  await session.waitForOwnerTurn({ reason: "objective_message" });
  log(`QUESTION answered by operator: "${ANSWER}"`);

  // An approval: the lead's merge needs a person's decision.
  const approvals = await harness.controlPlane.objectives.readCoordinationInbox({
    kind: "approval",
  });
  log(
    `APPROVAL surfaced in coordination inbox (${approvals.items.length} item): merge fixture/app #42, status ${approvalStatus[0]}`,
  );
  await harness.controlPlane.objectives.decideApprovalRequest({
    requestId: approvalRequestId,
    decision: "approve",
  });
  await session.waitForOwnerTurn({ reason: "approval_decision" });
  log(`APPROVAL resolved: approved; the lead's retried merge was ${approvalStatus[1]}`);
  const injected = harness.errors.filter((error) =>
    String(error).includes("FIXTURE injected interruption"),
  ).length;
  log(`dispatch errors: ${harness.errors.length} (injected: ${injected})`);
  if (harness.errors.length !== injected) process.exitCode = 1;
} finally {
  await harness.close();
  log("disposable state removed");
}
