import { describe, expect, it } from "vitest";
import { buildCommitmentView, type TaskAssignment } from "../packages/core/src/index.js";

const timestamp = "2026-09-11T00:00:00.000Z";
function task(taskId: string, extra: Partial<TaskAssignment> = {}): TaskAssignment {
  return {
    taskId,
    objectiveId: "objective",
    teamId: "team",
    workstreamId: null,
    parentTaskId: null,
    sourceMessageId: null,
    waitState: null,
    requestedByTagId: "owner",
    assignedTagId: "worker",
    instruction: "Ship the interface",
    acceptanceCriteria: ["Consumer can use the artifact"],
    dependencies: [],
    status: "queued",
    approval: "approved",
    attemptCount: 1,
    reservedMinor: 1,
    chargedMinor: null,
    availableAt: timestamp,
    leaseOwner: null,
    leaseExpiresAt: null,
    result: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    ...extra,
  };
}
function view(tasks: readonly TaskAssignment[]) {
  return buildCommitmentView({
    objectiveId: "objective",
    objectiveOwnerTagId: "owner",
    teams: [{ id: "team", leadTagId: "lead" }],
    tasks,
    now: timestamp,
  }).commitments;
}

describe("durable commitment view", () => {
  it("does not request review when a submitted wait group already permits a wake", () => {
    const waitState: NonNullable<TaskAssignment["waitState"]> = {
      acceptedTaskIds: ["not-accepted"],
      submittedTaskIds: ["submitted"],
      mailbox: false,
      notBefore: null,
      registeredAt: timestamp,
      attemptCount: 1,
      mailboxTaskIds: [],
      consumedMailboxTaskIds: [],
    };
    const entries = view([
      task("not-accepted", { status: "submitted" }),
      task("submitted", { status: "cancelled" }),
      task("waiting", { status: "waiting", waitState }),
    ]);
    expect(entries[2]?.nextActorTagIds).toEqual([]);
    const unresolved = view([
      task("not-accepted", { status: "submitted" }),
      task("waiting", { status: "waiting", waitState: { ...waitState, submittedTaskIds: [] } }),
    ]);
    expect(unresolved[1]?.nextActorTagIds).toEqual(["owner", "lead"]);
  });
  it("keeps a submitted dependency blocked until review accepts it", () => {
    const source = task("source", { status: "submitted" });
    const consumer = task("consumer", { dependencies: ["source"] });
    const pending = view([source, consumer]);
    expect(pending[1]?.blockers).toEqual([{ kind: "dependency", taskId: "source" }]);
    expect(pending[1]?.nextActorTagIds).toEqual(["owner", "lead"]);
    expect(pending[1]?.dependencies[0]?.state).toBe("pending");
    const accepted = view([{ ...source, status: "accepted" }, consumer]);
    expect(accepted[1]?.dependencies[0]?.state).toBe("accepted");
    expect(accepted[1]?.blockers).toEqual([]);
    expect(accepted[1]?.nextActorTagIds).toEqual(["worker"]);
  });

  it("does not infer hidden or cross-Objective dependencies or mailbox promises", () => {
    const entries = view([
      task("foreign", { objectiveId: "other", status: "accepted" }),
      task("delivery", { sourceMessageId: "request", dependencies: ["foreign", "hidden"] }),
    ]);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.kind).toBe("mailbox_delivery");
    expect(entries[0]?.dependencies).toEqual([
      { taskId: "foreign", state: "unavailable", status: null, nextActorTagIds: ["owner"] },
      { taskId: "hidden", state: "unavailable", status: null, nextActorTagIds: ["owner"] },
    ]);
    expect(entries[0]?.nextActorTagIds).toEqual(["owner"]);
  });

  it("distinguishes catalog-selected reviewed artifacts from submissions and ordinary links", () => {
    const digest = `sha256:${"a".repeat(64)}`;
    const result = {
      taskResult: {
        artifacts: [
          { artifactId: "captured-output", paths: ["output.txt"] },
          { uri: "https://example.com/output", digest },
          { uri: "supertag-artifact:broken", digest: "broken" },
          null,
        ],
      },
    };
    const entries = view([
      task("proposal", { status: "submitted", result }),
      task("accepted", {
        status: "accepted",
        attemptCount: 2,
        result: { ...result, reviewedByTagId: "owner", assessment: "Compatible" },
      }),
      task("repair", { status: "rejected", result }),
      task("running", { status: "running", result }),
    ]);
    expect(entries.map((entry) => entry.resultState)).toEqual([
      "submitted",
      "accepted",
      "rejected",
      "none",
    ]);
    expect(entries[0]?.artifacts).toHaveLength(1);
    expect(entries[0]?.artifacts[0]?.reviewState).toBe("submitted");
    expect(entries[1]?.artifacts[0]).toMatchObject({
      taskId: "accepted",
      attemptCount: 2,
      artifactId: "captured-output",
      paths: ["output.txt"],
      reviewState: "accepted",
    });
    expect(entries[1]?.review.reviewedByTagId).toBe("owner");
    expect(entries[2]?.nextActorTagIds).toEqual(["owner"]);
    expect(entries[3]?.artifacts).toEqual([]);
  });

  it("identifies eligible reviewers without allowing delegated self-review", () => {
    const delegated = view([task("delegated", { assignedTagId: "lead", status: "submitted" })]);
    expect(delegated[0]?.review.eligibleTagIds).toEqual(["owner"]);
    const selfAssigned = view([
      task("self", { assignedTagId: "lead", requestedByTagId: "lead", status: "submitted" }),
    ]);
    expect(selfAssigned[0]?.review.eligibleTagIds).toEqual(["owner", "lead"]);
  });

  it("reports durable waits and schedules without claiming a dispatch diagnosis", () => {
    const entries = view([
      task("later", { approval: "pending", availableAt: "2026-09-12T00:00:00.000Z" }),
      task("waiting", { status: "waiting" }),
      task("running", { status: "running", dependencies: ["unknown"] }),
      task("cancelled", { status: "cancelled" }),
    ]);
    expect(entries[0]?.blockers).toEqual([
      { kind: "approval", requiresOperator: true },
      { kind: "schedule" },
    ]);
    expect(entries[0]?.nextActorTagIds).toEqual([]);
    expect(entries[1]?.blockers).toEqual([{ kind: "wait" }]);
    expect(entries[2]?.blockers).toEqual([]);
    expect(entries[3]?.nextActorTagIds).toEqual([]);
  });

  it("routes cancelled dependencies to repair and hides forged unreviewed reviewer fields", () => {
    const entries = view([
      task("cancelled", { status: "cancelled" }),
      task("consumer", { dependencies: ["cancelled"], requestedByTagId: "requester" }),
      task("submitted", {
        status: "submitted",
        result: { reviewedByTagId: "fake", assessment: "fake" },
      }),
    ]);
    expect(entries[1]?.nextActorTagIds).toEqual(["requester"]);
    expect(entries[2]?.review.reviewedByTagId).toBeNull();
    expect(entries[2]?.review.assessment).toBeNull();
  });

  it("preserves pinned review state without substituting the source's current state", () => {
    const digest = `sha256:${"b".repeat(64)}`;
    const artifacts = [
      {
        artifactId: "captured-output",
        path: "output.txt",
        uri: `supertag-artifact:${digest}`,
        digest,
        provenance: {
          taskId: "source",
          attemptCount: 1,
          statusAtAdmission: "submitted",
        },
      },
      {
        artifactId: "captured-output",
        path: "output.txt",
        uri: `supertag-artifact:${digest}`,
        digest,
        provenance: {
          taskId: "legacy",
          attemptCount: 1,
        },
      },
    ];
    const entries = buildCommitmentView({
      objectiveId: "objective",
      objectiveOwnerTagId: "owner",
      teams: [],
      tasks: [task("source", { status: "accepted" }), task("consumer")],
      inputArtifactsByTaskId: new Map([["consumer", artifacts]]),
    }).commitments;
    expect(entries[1]?.consumedArtifacts[0]?.provenance).toEqual({
      taskId: "source",
      attemptCount: 1,
      statusAtAdmission: "submitted",
      reviewedByTagId: null,
    });
    expect(entries[1]?.consumedArtifacts[1]?.provenance.statusAtAdmission).toBeNull();
  });
});
