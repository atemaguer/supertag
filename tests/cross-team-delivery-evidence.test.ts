import { describe, expect, it } from "vitest";
import {
  assessCrossTeamDelivery,
  type CrossTeamDeliveryEvidence,
} from "../scripts/cross-team-delivery-evidence.js";

/** These are projections: omitted storage fields are not consumed by the assessor. */
function evidence(): CrossTeamDeliveryEvidence {
  const ids = ["draft", "review-draft", "revision", "review-final"];
  return {
    actors: { managerTagId: "manager", producerTagId: "producer", reviewerTagId: "reviewer" },
    objective: { id: "delivery", ownerTagId: "manager", status: "completed" },
    teams: [
      { id: "production", objectiveId: "delivery", leadTagId: "producer" },
      { id: "review", objectiveId: "delivery", leadTagId: "reviewer" },
    ],
    tasks: ids.map((id) => ({
      taskId: id,
      objectiveId: "delivery",
      requestedByTagId: "manager",
      assignedTagId: id.startsWith("review-") ? "reviewer" : "producer",
      teamId: id.startsWith("review-") ? "review" : "production",
      status: id === "draft" ? "rejected" : "accepted",
      result: {
        reviewedByTagId: "manager",
        taskResult: {
          artifacts: [
            {
              artifactId: `artifact-${id}`,
              paths: [id.startsWith("review-") ? "outputs/review.json" : "outputs/report.json"],
            },
          ],
        },
      },
      createdAt: id === "revision" ? "2026-09-17T01:00:00Z" : "2026-09-17T00:00:00Z",
    })),
    messages: [
      {
        id: "request",
        objectiveId: "delivery",
        senderTagId: "reviewer",
        recipientTagId: "producer",
        recipientTeamId: "production",
        type: "message",
        status: "processed",
        createdAt: "2026-09-17T00:30:00Z",
        body: {
          kind: "revision.requested",
          taskId: "draft",
          artifactId: "artifact-draft",
          requirement: "double",
        },
      },
    ],
    artifacts: ids.map((id) => ({
      manifest: {
        id: `artifact-${id}`,
        taskId: id,
        objectiveId: "delivery",
        tagId: id.startsWith("review-") ? "reviewer" : "producer",
        inputs:
          id === "draft"
            ? []
            : [
                {
                  artifactId: `artifact-${id === "review-final" ? "revision" : "draft"}`,
                  paths: ["outputs/report.json"],
                },
              ],
      },
      values: id.startsWith("review-")
        ? {
            "outputs/review.json": {
              artifactId: id === "review-draft" ? "artifact-draft" : "artifact-revision",
              passed: id !== "review-draft",
              value: 7,
              double: 14,
            },
          }
        : { "outputs/report.json": { value: 7, ...(id === "revision" ? { double: 14 } : {}) } },
    })),
    recovery: {
      taskId: "draft",
      nativeIdsBefore: ["native-1"],
      nativeIdsAfter: ["native-1"],
      attemptIds: ["attempt-1", "attempt-2"],
      workspaceDeleted: true,
      stateDeleted: true,
    },
  } as CrossTeamDeliveryEvidence;
}

describe("cross-Team delivery evidence", () => {
  it("requires linked durable delegation, revision, independent review, acceptance and recovery", () => {
    expect(assessCrossTeamDelivery(evidence())).toMatchObject({ passed: true });
  });
  it("allows agent-selected Team IDs while requiring the same ownership and routing", () => {
    const e = evidence();
    const rename = (id: string) => `delivery:${id}`;
    expect(
      assessCrossTeamDelivery({
        ...e,
        teams: e.teams.map((t) => ({ ...t, id: rename(t.id) })),
        tasks: e.tasks.map((t) => ({ ...t, teamId: rename(t.teamId) })),
        messages: e.messages.map((m) => ({
          ...m,
          recipientTeamId: rename(m.recipientTeamId ?? ""),
        })),
      }).passed,
    ).toBe(true);
  });
  it("separates valid Team-lead revision from adherence to the manager-only fixture", () => {
    const e = evidence();
    const assessment = assessCrossTeamDelivery({
      ...e,
      tasks: [
        ...e.tasks.map((t) =>
          t.taskId === "revision"
            ? { ...t, requestedByTagId: "producer", parentTaskId: "message:request" }
            : t,
        ),
        {
          ...(e.tasks.find(
            (t) => t.taskId === "draft",
          ) as CrossTeamDeliveryEvidence["tasks"][number]),
          taskId: "message:request",
          sourceMessageId: "request",
          status: "accepted",
        },
      ],
    });
    expect(assessment.coordinationPassed).toBe(true);
    expect(assessment.passed).toBe(false);
    expect(assessment.checks.managerDelegation).toBe(false);
  });
  it("does not infer authorized Team-lead revision without its parent Mailbox evidence", () => {
    const e = evidence();
    expect(
      assessCrossTeamDelivery({
        ...e,
        tasks: e.tasks.map((t) =>
          t.taskId === "revision" ? { ...t, requestedByTagId: "producer" } : t,
        ),
      }).coordinationPassed,
    ).toBe(false);
  });
  it.each([
    [
      "unsubmitted artifact",
      (e: CrossTeamDeliveryEvidence) => ({
        ...e,
        tasks: e.tasks.map((t) => ({ ...t, result: { reviewedByTagId: "manager" } })),
      }),
    ],
    [
      "wrong artifact producer",
      (e: CrossTeamDeliveryEvidence) => ({
        ...e,
        artifacts: e.artifacts.map((a) => ({
          ...a,
          manifest: { ...a.manifest, tagId: "outsider" },
        })),
      }),
    ],
    [
      "failed mailbox delivery",
      (e: CrossTeamDeliveryEvidence) => ({
        ...e,
        messages: e.messages.map((m) => ({ ...m, status: "failed" as const })),
      }),
    ],
    ["prose-only revision", (e: CrossTeamDeliveryEvidence) => ({ ...e, messages: [] })],
    [
      "wrong artifact in revision request",
      (e: CrossTeamDeliveryEvidence) => ({
        ...e,
        messages: e.messages.map((m) => ({ ...m, body: { ...m.body, artifactId: "unrelated" } })),
      }),
    ],
    [
      "revision created before request",
      (e: CrossTeamDeliveryEvidence) => ({
        ...e,
        messages: e.messages.map((m) => ({ ...m, createdAt: "2026-09-18T00:00:00Z" })),
      }),
    ],
    [
      "same-team review",
      (e: CrossTeamDeliveryEvidence) => ({
        ...e,
        tasks: e.tasks.map((t) =>
          t.taskId === "review-final" ? { ...t, teamId: "production" } : t,
        ),
      }),
    ],
    [
      "review of stale draft",
      (e: CrossTeamDeliveryEvidence) => ({
        ...e,
        artifacts: e.artifacts.map((a) =>
          a.manifest.taskId === "review-final"
            ? {
                ...a,
                manifest: {
                  ...a.manifest,
                  inputs: [{ artifactId: "artifact-draft", paths: ["outputs/report.json"] }],
                },
              }
            : a,
        ),
      }),
    ],
    [
      "wrong selected path",
      (e: CrossTeamDeliveryEvidence) => ({
        ...e,
        artifacts: e.artifacts.map((a) => ({
          ...a,
          manifest: {
            ...a.manifest,
            inputs: a.manifest.inputs.map((i) => ({ ...i, paths: ["unrelated.json"] })),
          },
        })),
      }),
    ],
    [
      "self-acceptance",
      (e: CrossTeamDeliveryEvidence) => ({
        ...e,
        tasks: e.tasks.map((t) => ({ ...t, result: { reviewedByTagId: t.assignedTagId } })),
      }),
    ],
    [
      "different native session",
      (e: CrossTeamDeliveryEvidence) => ({
        ...e,
        recovery: { ...e.recovery, nativeIdsAfter: ["native-2"] },
      }),
    ],
    [
      "no fresh Worker state",
      (e: CrossTeamDeliveryEvidence) => ({
        ...e,
        recovery: { ...e.recovery, stateDeleted: false },
      }),
    ],
    [
      "same attempt replay",
      (e: CrossTeamDeliveryEvidence) => ({
        ...e,
        recovery: { ...e.recovery, attemptIds: ["attempt-1", "attempt-1"] },
      }),
    ],
    [
      "unfinished dependency",
      (e: CrossTeamDeliveryEvidence) => ({
        ...e,
        tasks: [
          ...e.tasks,
          {
            ...(e.tasks.find(
              (t) => t.taskId === "draft",
            ) as CrossTeamDeliveryEvidence["tasks"][number]),
            taskId: "blocked",
            status: "waiting" as const,
          },
        ],
      }),
    ],
    [
      "duplicate delivery",
      (e: CrossTeamDeliveryEvidence) => ({
        ...e,
        tasks: [
          ...e.tasks,
          {
            ...(e.tasks.find(
              (t) => t.taskId === "draft",
            ) as CrossTeamDeliveryEvidence["tasks"][number]),
            taskId: "duplicate",
          },
        ],
      }),
    ],
  ] as const)("does not pass with %s", (_label, change) => {
    const assessment = assessCrossTeamDelivery(change(evidence()));
    expect(assessment.passed).toBe(false);
    if (_label !== "duplicate delivery") expect(assessment.coordinationPassed).toBe(false);
  });
});
