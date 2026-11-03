import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { taskResourceFromStore } from "../apps/cli/src/control-plane-resources.ts";
import { describeTask } from "../apps/cli/src/resources.ts";
import { mountManifestDigest } from "../packages/core/src/index.js";
import { DrizzleStore, migrateDatabase } from "../packages/store/src/index.js";

const at = "2026-10-04T00:00:00.000Z";
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

it("carries each Attempt's recorded mount manifests on the Task view, listing the first objects", async () => {
  const directory = await mkdtemp(join(tmpdir(), "supertag-mount-view-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const url = `file:${join(directory, "state.db")}`;
  await migrateDatabase({ url });
  const store = new DrizzleStore({ url });
  await store.connect();
  cleanups.push(() => store.disconnect());
  const owner = await store.createTag({ name: "Owner" });
  const objective = await store.createObjective({
    id: randomUUID(),
    ownerTagId: owner.id,
    outcome: "Train on datasets",
  });
  const team = await store.createTeam(
    {
      id: randomUUID(),
      objectiveId: objective.id,
      name: "Data",
      leadTagId: owner.id,
      memberTagIds: [],
      maxConcurrency: 1,
    },
    owner.id,
  );
  const assignment = await store.admitTaskAssignment({
    taskId: randomUUID(),
    teamId: team.id,
    objectiveId: objective.id,
    requestedByTagId: owner.id,
    assignedTagId: owner.id,
    instruction: "Train",
    acceptanceCriteria: ["Done"],
    execution: {},
    workspacePlan: { version: 1, status: "none" },
    contextPlan: { version: 7, capturedAt: at, sets: [] },
    authorizationSnapshot: {
      version: 4,
      capturedAt: at,
      tag: { id: owner.id, name: owner.name },
      origin: { kind: "internal", objectiveId: objective.id, requestedByTagId: owner.id },
      requester: { id: owner.id, kind: "bot" },
      permissionSets: [],
      resources: [],
      runtimeActions: [],
    },
  });
  const attempt = await store.createTaskAttempt({
    taskId: assignment.taskId,
    attemptNumber: 1,
    workerProfile: { id: "default", revision: "1" },
    workerSnapshot: {},
    startedAt: at,
  });
  const source = "file:///data/";
  const objects = Array.from({ length: 25 }, (_, index) => ({
    key: `part-${String(index).padStart(2, "0")}.csv`,
    size: 10,
    sha256: `sha256:${"a".repeat(64)}`,
  }));
  const manifest = {
    volume: "datasets",
    source,
    path: "/mnt/datasets",
    strategy: "copy" as const,
    access: "read-only" as const,
    objectCount: objects.length,
    totalBytes: 250,
    digest: mountManifestDigest(source, objects),
    copiedAt: at,
    objects,
  };
  await store.recordTaskAttemptMountManifests(assignment.taskId, attempt.id, [manifest]);
  const liveMount = {
    volume: "live-data",
    source: "s3://datasets/prefix/",
    prefix: "prefix/",
    path: "/mnt/live-data",
    strategy: "mount" as const,
    access: "read-only" as const,
    attachedAt: "2026-10-06T14:00:00.000Z",
  };
  await store.recordTaskAttemptLiveMounts(assignment.taskId, attempt.id, [liveMount]);
  const task = await store.findTaskById(assignment.taskId);
  if (!task) throw new Error("Missing Task");
  const view = await taskResourceFromStore(store, task);
  expect(view.status.attempts?.[0]?.liveMounts).toEqual([liveMount]);
  const described = describeTask(view);
  expect(described).toContain("live-data  /mnt/live-data  mount read-only  live");
  expect(described).toContain("attached 2026-10-06T14:00:00.000Z");
  expect(view.status.attempts?.[0]?.mountManifests).toEqual([
    { ...manifest, objects: objects.slice(0, 20) },
  ]);
});
