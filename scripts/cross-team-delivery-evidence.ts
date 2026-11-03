import type {
  CapturedArtifact,
  Objective,
  TagMessage,
  TaskAssignment,
  Team,
} from "../packages/core/src/index.js";

/** Projection of stored records and independently downloaded bytes, never model self-scores. */
export interface CrossTeamDeliveryEvidence {
  readonly actors: {
    readonly managerTagId: string;
    readonly producerTagId: string;
    readonly reviewerTagId: string;
  };
  readonly objective: Pick<Objective, "id" | "status" | "ownerTagId">;
  readonly teams: readonly Team[];
  readonly tasks: readonly TaskAssignment[];
  readonly messages: readonly TagMessage[];
  readonly artifacts: readonly {
    readonly manifest: CapturedArtifact;
    /** JSON parsed only after the downloaded bytes match the manifest digest and size. */
    readonly values: Readonly<Record<string, unknown>>;
  }[];
  readonly recovery: {
    readonly taskId: string;
    readonly nativeIdsBefore: readonly string[];
    readonly nativeIdsAfter: readonly string[];
    readonly attemptIds: readonly string[];
    readonly workspaceDeleted: boolean;
    readonly stateDeleted: boolean;
  };
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function assessCrossTeamDelivery(e: CrossTeamDeliveryEvidence) {
  const { managerTagId: manager, producerTagId: producer, reviewerTagId: reviewer } = e.actors;
  const producerTeams = e.teams.filter(
    (t) => t.objectiveId === e.objective.id && t.leadTagId === producer,
  );
  const reviewerTeams = e.teams.filter(
    (t) => t.objectiveId === e.objective.id && t.leadTagId === reviewer,
  );
  const producerTeam = producerTeams[0];
  const reviewerTeam = reviewerTeams[0];
  const task = (id: string) => e.tasks.find((item) => item.taskId === id);
  const artifact = (id: string) => {
    const t = task(id);
    const selections = record(t?.result?.["taskResult"])["artifacts"];
    const path = id.startsWith("review-") ? "outputs/review.json" : "outputs/report.json";
    return e.artifacts.find(
      (item) =>
        item.manifest.taskId === id &&
        item.manifest.objectiveId === e.objective.id &&
        item.manifest.tagId === t?.assignedTagId &&
        Array.isArray(selections) &&
        selections.some((selection: unknown) => {
          const selected = record(selection);
          return (
            selected["artifactId"] === item.manifest.id &&
            Array.isArray(selected["paths"]) &&
            selected["paths"].includes(path)
          );
        }),
    );
  };
  const draft = artifact("draft");
  const revision = artifact("revision");
  const firstReview = artifact("review-draft");
  const finalReview = artifact("review-final");
  const value = (item: typeof draft, path: string) => record(item?.values[path]);
  const consumes = (consumer: typeof draft, source: typeof draft, path: string) =>
    !!source &&
    !!consumer?.manifest.inputs.some(
      (selection) => selection.artifactId === source.manifest.id && selection.paths.includes(path),
    );
  const revisionRequests = e.messages.filter(
    (message) =>
      message.objectiveId === e.objective.id &&
      message.senderTagId === reviewer &&
      message.recipientTagId === producer &&
      message.recipientTeamId === producerTeam?.id &&
      message.type === "message" &&
      message.status === "processed" &&
      message.body["kind"] === "revision.requested" &&
      message.body["taskId"] === "draft" &&
      message.body["artifactId"] === draft?.manifest.id &&
      message.body["requirement"] === "double",
  );
  const deliveryIds = ["draft", "review-draft", "revision", "review-final"];
  const expected = (id: string) => (id.startsWith("review-") ? reviewer : producer);
  const nativeBefore = [...new Set(e.recovery.nativeIdsBefore.filter(Boolean))];
  const nativeAfter = [...new Set(e.recovery.nativeIdsAfter.filter(Boolean))];
  const revisionTask = task("revision");
  const revisionParent = revisionTask?.parentTaskId ? task(revisionTask.parentTaskId) : undefined;
  const revisionDelegationAllowed =
    revisionTask?.requestedByTagId === manager ||
    (revisionTask?.requestedByTagId === producer &&
      revisionParent?.assignedTagId === producer &&
      revisionRequests.some((message) => message.id === revisionParent.sourceMessageId));
  const checks = {
    distinctActors: new Set([manager, producer, reviewer]).size === 3,
    twoDeliveryTeams:
      producerTeams.length === 1 &&
      reviewerTeams.length === 1 &&
      producerTeam?.id !== reviewerTeam?.id,
    deliveryRouting: deliveryIds.every((id) => {
      const t = task(id);
      return (
        t?.objectiveId === e.objective.id &&
        t.assignedTagId === expected(id) &&
        t.teamId === (id.startsWith("review-") ? reviewerTeam?.id : producerTeam?.id)
      );
    }),
    authorizedDelegation:
      revisionDelegationAllowed &&
      ["draft", "review-draft", "review-final"].every(
        (id) => task(id)?.requestedByTagId === manager,
      ),
    managerDelegation: deliveryIds.every((id) => {
      const t = task(id);
      return (
        t?.objectiveId === e.objective.id &&
        t.requestedByTagId === manager &&
        t.assignedTagId === expected(id) &&
        t.teamId === (id.startsWith("review-") ? reviewerTeam?.id : producerTeam?.id)
      );
    }),
    initialArtifact:
      value(draft, "outputs/report.json")["value"] === 7 &&
      value(draft, "outputs/report.json")["double"] === undefined,
    initialReviewConsumesDraft:
      consumes(firstReview, draft, "outputs/report.json") &&
      value(firstReview, "outputs/review.json")["passed"] === false &&
      value(firstReview, "outputs/review.json")["artifactId"] === draft?.manifest.id,
    durableRevisionRequest: revisionRequests.some(
      (message) => message.createdAt <= (task("revision")?.createdAt ?? ""),
    ),
    revisedArtifact:
      !!draft &&
      !!revision &&
      draft.manifest.id !== revision.manifest.id &&
      value(revision, "outputs/report.json")["value"] === 7 &&
      value(revision, "outputs/report.json")["double"] === 14 &&
      consumes(revision, draft, "outputs/report.json"),
    independentFinalReview:
      finalReview?.manifest.tagId === reviewer &&
      consumes(finalReview, revision, "outputs/report.json") &&
      value(finalReview, "outputs/review.json")["artifactId"] === revision?.manifest.id &&
      value(finalReview, "outputs/review.json")["passed"] === true &&
      value(finalReview, "outputs/review.json")["value"] === 7 &&
      value(finalReview, "outputs/review.json")["double"] === 14,
    managerAcceptance:
      task("draft")?.status === "rejected" &&
      task("draft")?.result?.["reviewedByTagId"] === manager &&
      ["revision", "review-final"].every(
        (id) =>
          task(id)?.status === "accepted" && task(id)?.result?.["reviewedByTagId"] === manager,
      ),
    mailboxSettled: e.messages.every((m) => m.status === "processed"),
    objectiveCompleted: e.objective.ownerTagId === manager && e.objective.status === "completed",
    freshWorkerRecovery:
      e.recovery.taskId === "draft" &&
      e.recovery.workspaceDeleted &&
      e.recovery.stateDeleted &&
      new Set(e.recovery.attemptIds).size >= 2 &&
      nativeBefore.length === 1 &&
      nativeAfter.length === 1 &&
      nativeBefore[0] === nativeAfter[0],
  };
  const extraDeliveryTasks = e.tasks.filter(
    (t) =>
      !t.sourceMessageId &&
      [producer, reviewer].includes(t.assignedTagId) &&
      !deliveryIds.includes(t.taskId),
  );
  const unfinishedTasks = e.tasks.filter((t) =>
    ["queued", "running", "waiting"].includes(t.status),
  );
  return {
    // Preserve the original prescribed-workflow result separately. A Team lead
    // may validly commission its revision from the received Mailbox request.
    coordinationPassed:
      Object.entries(checks).every(([name, passed]) => name === "managerDelegation" || passed) &&
      unfinishedTasks.length === 0,
    passed:
      Object.values(checks).every(Boolean) &&
      extraDeliveryTasks.length === 0 &&
      unfinishedTasks.length === 0,
    checks,
    metrics: {
      taskCount: e.tasks.length,
      messageCount: e.messages.length,
      revisionRequestCount: revisionRequests.length,
      extraDeliveryTaskIds: extraDeliveryTasks.map((t) => t.taskId),
      unfinishedTaskIds: unfinishedTasks.map((t) => t.taskId),
      failedTaskIds: e.tasks.filter((t) => t.status === "failed").map((t) => t.taskId),
      failedMessageIds: e.messages.filter((m) => m.status === "failed").map((m) => m.id),
    },
  };
}
