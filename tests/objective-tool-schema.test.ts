import { expect, it } from "vitest";
import { hiddenCoordinationTools, surfaceTools } from "../apps/cli/src/coordination-http.js";
import {
  INBOX_SENDS_PER_TASK,
  OBJECTIVE_UPDATE_STATUSES,
  TAG_MESSAGE_TEXT_MAX,
  WORK_SESSION_INSTRUCTION_MAX,
  WORK_SESSION_QUESTION_MAX,
  WORK_SESSION_TITLE_MAX,
  WORKSTREAM_POST_MAX_BODY,
  WORKSTREAM_POST_MAX_TO,
} from "../packages/core/src/index.js";
import { SURFACE_COORDINATION_OPERATIONS } from "../packages/runtime/sdk/src/index.js";

/** Every tool a turn may be offered, in the order the Control Plane defines them. */
const toolNames = [
  "create_objective",
  "read_objective",
  "update_objective",
  "list_objectives",
  "list_sessions",
  "search_sessions",
  "read_session",
  "start_session",
  "continue_session",
  "ask",
  "send_message",
  "post",
  "read_workstream",
] as const;

interface ToolSchema {
  readonly type: string;
  readonly properties: Record<string, unknown>;
  readonly required: readonly string[];
  readonly additionalProperties: boolean;
}
function tool(name: (typeof toolNames)[number]) {
  const found = surfaceTools.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`Missing ${name}`);
  return found;
}
const schema = (name: (typeof toolNames)[number]) => tool(name).inputSchema as ToolSchema;

it("advertises only the Session, Objective, Mailbox and Workstream primitives", () => {
  expect(surfaceTools.map((entry) => entry.name)).toEqual(toolNames);
  // The Objective controller's own tool family is gone; a Tag delegates with start_session.
  for (const removed of [
    "assign_task",
    "update_task",
    "read_task",
    "list_tasks",
    "read_commitments",
    "wait_for",
    "escalate_task",
    "read_mailbox",
    "post_workstream",
    "read_team",
    "update_team",
    "create_team",
    "create_tag",
    "list_tags",
    "request_approval",
    "decide_approval",
    "select_objective",
    "attach_objective",
    "start_objective",
    "instruct_objective",
  ])
    expect(surfaceTools.some((entry) => entry.name === removed)).toBe(false);
});

it("keeps request_action_approval callable by the Worker but never advertises it", () => {
  expect(hiddenCoordinationTools).toEqual(["request_action_approval"]);
  expect(surfaceTools.some((entry) => entry.name === "request_action_approval")).toBe(false);
});

it("delegates with start_session, to this Tag or to a Tag of the Objective's Team", () => {
  expect(schema("start_session")).toEqual({
    type: "object",
    additionalProperties: false,
    required: ["title", "instruction"],
    properties: {
      title: { type: "string", minLength: 1, maxLength: WORK_SESSION_TITLE_MAX },
      instruction: { type: "string", minLength: 1, maxLength: WORK_SESSION_INSTRUCTION_MAX },
      tag: { type: "string", minLength: 1, maxLength: 200 },
      workspace: { type: "string", pattern: "^[a-z0-9][a-z0-9_-]{0,62}$" },
    },
  });
  const description = tool("start_session").description;
  expect(description).toContain("set tag to a Tag name or ID from the Objective's Team");
  expect(description).toContain("draws on the Objective's budget");
  expect(tool("continue_session").description).toContain("work Sessions that are not running");
  expect(schema("continue_session").required).toEqual(["sessionId", "message"]);
});

it("asks a person with one question and ends the Task waiting on the answer", () => {
  expect(schema("ask")).toEqual({
    type: "object",
    additionalProperties: false,
    required: ["question"],
    properties: {
      question: { type: "string", minLength: 1, maxLength: WORK_SESSION_QUESTION_MAX },
    },
  });
  expect(tool("ask").description).toContain("ends this Task waiting on the answer");
});

it("sends plain text and can correlate a commit review", () => {
  expect(schema("send_message")).toEqual({
    type: "object",
    additionalProperties: false,
    required: ["to", "text"],
    properties: {
      to: { type: "string", minLength: 1, maxLength: 200 },
      text: { type: "string", minLength: 1, maxLength: TAG_MESSAGE_TEXT_MAX },
      review: {
        type: "object",
        additionalProperties: false,
        properties: {
          commit: { type: "string", pattern: "^(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$" },
          requestId: { type: "string", minLength: 1, maxLength: 200 },
          verdict: { type: "string", enum: ["approved", "changes_requested"] },
        },
      },
    },
  });
  for (const gone of ["type", "body", "inReplyTo", "idempotencyKey", "recipientTeamId"])
    expect(schema("send_message").properties).not.toHaveProperty(gone);
  expect(tool("send_message").description).toContain(
    `At most ${INBOX_SENDS_PER_TASK} new messages per Task`,
  );
  expect(tool("send_message").description).toContain("handles it in a later turn of its own");
});

it("posts untyped text to the Team's Workstream and wakes only the Tags it names", () => {
  expect(schema("post")).toEqual({
    type: "object",
    additionalProperties: false,
    required: ["text"],
    properties: {
      text: { type: "string", minLength: 1, maxLength: WORKSTREAM_POST_MAX_BODY },
      to: {
        type: "array",
        minItems: 1,
        maxItems: WORKSTREAM_POST_MAX_TO,
        uniqueItems: true,
        items: { type: "string", minLength: 1, maxLength: 200 },
      },
    },
  });
  // The Team is resolved from the turn, so no team or workstream argument is advertised.
  for (const gone of ["teamId", "workstreamId", "objectiveId", "type", "replyTo", "references"])
    expect(schema("post").properties).not.toHaveProperty(gone);
  expect(tool("post").description).toContain("A post wakes nobody");
  expect(Object.keys(schema("read_workstream").properties).sort()).toEqual([
    "afterSequence",
    "limit",
  ]);
  expect(tool("read_workstream").description).toContain("does not subscribe");
});

it("updates an Objective's status from its own conversation, with its revision", () => {
  expect(schema("update_objective")).toEqual({
    type: "object",
    additionalProperties: false,
    required: ["status", "expectedRevision"],
    properties: {
      status: { type: "string", enum: OBJECTIVE_UPDATE_STATUSES },
      expectedRevision: { type: "integer", minimum: 1 },
      completionSummary: { type: "string", minLength: 1, maxLength: 4000 },
    },
  });
  expect(tool("read_objective").description).toContain("its Sessions with their latest Tasks");
  expect(schema("read_objective").required).toEqual([]);
});

it("lets a Worker expose every conversation tool the Control Plane defines", () => {
  // A tool the Worker's list leaves out never reaches a real harness, even when the turn gets it.
  expect([...SURFACE_COORDINATION_OPERATIONS].sort()).toEqual(
    surfaceTools.map((entry) => entry.name).sort(),
  );
});
