import { expect, it } from "vitest";
import { coordinationTools, surfaceTools } from "../apps/cli/src/coordination-http.js";
import { SURFACE_COORDINATION_OPERATIONS } from "../packages/runtime/sdk/src/index.js";

const coordinationNames = [
  "read_objective",
  "read_team",
  "read_task",
  "list_tags",
  "assign_task",
  "update_task",
  "read_mailbox",
  "send_message",
  "read_workstream",
  "post_workstream",
  "wait_for",
  "escalate_task",
  "update_objective",
  "create_team",
  "update_team",
  "create_tag",
  "request_approval",
  "decide_approval",
] as const;

function schema(name: (typeof coordinationNames)[number]) {
  const tool = coordinationTools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`Missing ${name}`);
  return tool.inputSchema;
}

it("advertises only the adopted resource and communication primitives", () => {
  expect(coordinationTools.map((tool) => tool.name)).toEqual(coordinationNames);
  for (const removed of [
    "read_team_context",
    "read_commitments",
    "list_tasks",
    "review_task",
    "request_action_approval",
    "send_team_message",
    "propose_team_knowledge",
    "propose_team_governance_transfer",
    "propose_team_priority",
    "report_progress",
    "create_workstream",
    "update_workstream",
  ])
    expect(coordinationTools.some((tool) => tool.name === removed)).toBe(false);
});

it("keeps Task workflows composable through assign, read, and one-field updates", () => {
  expect(schema("assign_task")).toMatchObject({
    required: ["taskId", "teamId", "assignedTagId", "instruction", "acceptanceCriteria"],
    additionalProperties: false,
    properties: {
      requiresApproval: { type: "boolean" },
      dependencies: {
        type: "array",
        description: expect.stringContaining("accepted before this Task can run"),
      },
      inputArtifacts: {
        type: "array",
        maxItems: 20,
        description: expect.stringContaining("submitted, accepted, or rejected"),
      },
      execution: {
        properties: {
          requires: { description: expect.stringContaining("does not select a Worker role") },
          profile: { description: expect.stringContaining("exact advertised Worker Profile") },
          limits: {
            properties: {
              maxReportedCost: {
                type: "object",
                additionalProperties: false,
                required: ["amountMinor", "currency"],
                properties: {
                  amountMinor: { type: "integer", minimum: 0 },
                  currency: { type: "string", pattern: "^[A-Z]{3}$" },
                },
              },
            },
          },
        },
      },
    },
  });
  expect(schema("assign_task").properties.dependencies.description).toContain(
    "do not pass artifacts",
  );
  expect(schema("assign_task").properties.inputArtifacts.description).toContain(
    "exact source evidence",
  );
  expect(schema("update_task")).toMatchObject({
    required: ["taskId", "expectedStatus"],
    additionalProperties: false,
    properties: {
      priority: { enum: ["urgent", "high", "normal", "low"] },
      approval: { enum: ["approved"] },
      assessment: { type: "string" },
    },
  });
  expect(schema("update_task").properties.priority.description).toContain(
    "governing lead accepts a Mailbox proposal",
  );
  expect(schema("update_task").properties.finding).toMatchObject({
    type: "object",
    oneOf: [
      { required: ["id", "status", "fixedBy"], properties: { status: { const: "fixed" } } },
      { required: ["id", "status", "reason"], properties: { status: { const: "accepted" } } },
    ],
  });
  expect(schema("update_task").properties.finding.description).toContain("re-review");
  expect(coordinationTools.find((tool) => tool.name === "read_task")?.description).toContain(
    "dependency blockers",
  );
  expect(schema("wait_for")).toMatchObject({
    properties: {
      acceptedTaskIds: {
        description: expect.stringContaining("current manager must perform"),
      },
      submittedTaskIds: {
        description: expect.stringContaining("unaccepted dependency"),
      },
    },
  });
  expect(coordinationTools.find((tool) => tool.name === "wait_for")?.description).toContain(
    "blocked on manager action",
  );
  expect(coordinationTools.find((tool) => tool.name === "wait_for")?.description).toContain(
    "end the current turn immediately",
  );
  expect(coordinationTools.find((tool) => tool.name === "update_objective")?.description).toContain(
    "Mailbox messages to be processed or failed",
  );
});

it("uses one Mailbox primitive for Tag, Team, and Objective destinations", () => {
  expect(coordinationTools.find((tool) => tool.name === "read_team")?.description).toContain(
    "relationship-labeled authorized Mailbox destinations",
  );
  expect(schema("send_message")).toMatchObject({
    required: ["body", "idempotencyKey"],
    additionalProperties: false,
    anyOf: [
      { required: ["recipientTagId"] },
      { required: ["to"] },
      { required: ["recipientTeamId"] },
      { required: ["recipientObjectiveId"] },
    ],
  });
  // type is optional (note by default for Tag messages) but must stay in the schema.
  expect(schema("send_message").properties.type).toMatchObject({
    enum: expect.arrayContaining([
      "message",
      "priority.proposed",
      "priority.accepted",
      "priority.declined",
    ]),
    description: expect.stringContaining("{taskId, priority, rationale}"),
  });
  expect(schema("send_message").properties.body.description).toContain("do not mutate Tasks");
  expect(schema("send_message").properties.inReplyTo.description).toContain("correlated response");
  expect(schema("read_mailbox").properties).toHaveProperty("limit");
  expect(coordinationTools.find((tool) => tool.name === "send_message")?.description).toContain(
    "recipientTagId",
  );
});

it("places shared knowledge and governance on Team and combines Workstream reads", () => {
  expect(schema("update_team")).toMatchObject({
    required: ["teamId", "expectedRevision"],
    properties: {
      context: { type: "object" },
      governingObjectiveId: { type: "string" },
    },
  });
  expect(schema("update_team").properties.context.description).toContain("review Task");
  expect(schema("update_team").properties.governingObjectiveId.description).toContain(
    "Mailbox negotiation",
  );
  expect(schema("read_workstream").properties).toMatchObject({
    afterSequence: { type: "integer", minimum: 0 },
    limit: { type: "integer", minimum: 1, maximum: 100 },
  });
  expect(surfaceTools.some((tool) => tool.name === "create_objective")).toBe(true);
});

it("posts typed, addressed text to a Team channel without granting authority", () => {
  expect(schema("post_workstream")).toEqual({
    type: "object",
    properties: {
      objectiveId: { type: "string", minLength: 1 },
      workstreamId: { type: "string", minLength: 1 },
      body: { type: "string", minLength: 1, maxLength: 16384 },
      type: { type: "string", enum: ["note", "question", "blocker", "evidence", "decision"] },
      to: { type: "array", maxItems: 20, items: { type: "string", minLength: 1 } },
      references: {
        type: "array",
        maxItems: 20,
        items: { type: "string", minLength: 1, maxLength: 2000 },
      },
      replyTo: { type: "string", minLength: 1 },
      idempotencyKey: { type: "string", minLength: 1 },
    },
    required: ["workstreamId", "body", "idempotencyKey"],
    additionalProperties: false,
  });
  const description =
    coordinationTools.find((tool) => tool.name === "post_workstream")?.description ?? "";
  expect(description).toContain("Team ID");
  expect(description).toContain("carries no authority and starts no work");
  expect(Object.keys(schema("read_workstream").properties).sort()).toEqual([
    "afterSequence",
    "limit",
    "objectiveId",
    "workstreamId",
  ]);
});

it("keeps Mailbox messages separate from Team channels", () => {
  expect(schema("send_message").additionalProperties).toBe(false);
  expect(schema("send_message").properties).not.toHaveProperty("workstreamId");
  // assign_task still names the channel that must include the assignee and requester.
  expect(schema("assign_task").properties).toHaveProperty("workstreamId");
});

it.each(["create_team", "update_team"] as const)(
  "advertises canonical Team scaling in %s",
  (name) => {
    expect(schema(name).properties.scaling).toMatchObject({
      type: "object",
      additionalProperties: false,
      properties: {
        maxBreadth: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
        maxDepth: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
      },
    });
    expect(schema(name).properties.scaling.required).toBeUndefined();
  },
);

it("explains observation subscriptions and alternative timer wake-ups", () => {
  const wait = coordinationTools.find((tool) => tool.name === "wait_for");
  expect(wait?.inputSchema).toMatchObject({
    properties: {
      mailbox: { description: expect.stringContaining("does not subscribe") },
      notBefore: { description: expect.stringContaining("may wake earlier") },
      workstreamPosts: {
        description: expect.stringContaining("any satisfied condition"),
        properties: {
          afterSequence: { description: expect.stringContaining("actually processed") },
        },
      },
    },
  });
});

it("advertises pagination and detail retrieval for Objective summaries", () => {
  expect(schema("read_objective")).toMatchObject({
    properties: { limit: { minimum: 1, maximum: 100 }, offset: { minimum: 0 } },
  });
  expect(coordinationTools.find((tool) => tool.name === "read_objective")?.description).toContain(
    "read_task",
  );
});

it("tells actors that Tasks start at low effort and how to raise it", () => {
  const assign = coordinationTools.find((tool) => tool.name === "assign_task");
  expect(assign?.description).toContain("Tasks start at low reasoning effort");
  expect(assign?.description).toContain("escalate_task");
  expect(assign?.description).toContain(
    "Tell assignees to clean up processes and services they start before finishing a Task.",
  );
  expect(schema("assign_task")).toMatchObject({
    properties: {
      execution: {
        properties: {
          effort: { description: expect.stringContaining("low unless the assignee sets another") },
        },
      },
    },
  });
  const escalate = coordinationTools.find((tool) => tool.name === "escalate_task");
  expect(escalate?.description).toContain("ends the current Task Attempt");
  expect(escalate?.description).toContain("after 2 escalations");
  expect(schema("escalate_task")).toMatchObject({
    required: ["reason"],
    additionalProperties: false,
    anyOf: [{ required: ["effort"] }, { required: ["model"] }],
    properties: {
      effort: { enum: ["low", "medium", "high"] },
      model: { type: "string", maxLength: 200 },
      reason: { maxLength: 2000 },
    },
  });
});

it("lets owners look up Tags by name before staffing or creating one", () => {
  expect(schema("list_tags")).toEqual({
    type: "object",
    properties: {
      objectiveId: { type: "string" },
      limit: { type: "integer", minimum: 1, maximum: 100 },
      offset: { type: "integer", minimum: 0 },
    },
    required: [],
    additionalProperties: false,
  });
  const description = (name: string) =>
    coordinationTools.find((tool) => tool.name === name)?.description ?? "";
  expect(description("list_tags")).toContain("bound Worker Hosts with connection state");
  expect(description("create_tag")).toContain("Check list_tags first");
  expect(description("create_team")).toContain("Tag names or IDs");
  expect(description("create_team")).toContain(
    "Omit maxConcurrency unless you deliberately throttle",
  );
  expect(description("update_team")).toContain("Tag names or IDs");
  expect(description("assign_task")).toContain("Tag name or ID");
  expect(description("send_message")).toContain("a Tag name or ID");
});

it("lets a Worker expose every conversation tool the Control Plane defines", () => {
  // A tool the Worker's list leaves out never reaches a real harness, even when the turn gets it.
  expect([...SURFACE_COORDINATION_OPERATIONS].sort()).toEqual(
    surfaceTools.map((tool) => tool.name).sort(),
  );
});
