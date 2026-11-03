import { randomUUID } from "node:crypto";
import type { DrizzleStore } from "../../packages/store/src/index.js";

/** A persisted running Task Attempt placed on a particular artifact-producing host. */
export async function artifactProducer(store: DrizzleStore, workerHostId: string) {
  const at = new Date().toISOString();
  const tag = await store.createTag({ name: `producer-${randomUUID()}` });
  const objective = await store.createObjective({
    id: randomUUID(),
    ownerTagId: tag.id,
    outcome: "Store artifacts",
  });
  const team = await store.createTeam(
    {
      id: randomUUID(),
      objectiveId: objective.id,
      name: "Artifacts",
      leadTagId: tag.id,
      memberTagIds: [],
      maxConcurrency: 1,
    },
    tag.id,
  );
  const assignment = await store.admitTaskAssignment({
    taskId: randomUUID(),
    teamId: team.id,
    objectiveId: objective.id,
    requestedByTagId: tag.id,
    assignedTagId: tag.id,
    instruction: "Store artifacts",
    acceptanceCriteria: ["Saved"],
    execution: {},
    workspacePlan: { version: 1, status: "none" },
    contextPlan: { version: 7, capturedAt: at, sets: [] },
    authorizationSnapshot: {
      version: 4,
      capturedAt: at,
      tag: { id: tag.id, name: tag.name },
      origin: { kind: "internal", objectiveId: objective.id, requestedByTagId: tag.id },
      requester: { id: tag.id, kind: "bot" },
      permissionSets: [],
      resources: [],
      runtimeActions: [],
    },
  });
  return store.createTaskAttempt({
    taskId: assignment.taskId,
    attemptNumber: 1,
    workerProfile: { id: "test", revision: "1" },
    workerSnapshot: { workerHostId, connectionGeneration: 1 },
    startedAt: at,
  });
}
