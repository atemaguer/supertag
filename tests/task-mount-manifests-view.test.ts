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
  const account = await store.saveSurfaceAccount({
    provider: "slack",
    externalAccountId: randomUUID(),
    displayName: "Slack",
    authMethod: "test",
    credentialId: "test",
    status: "connected",
    configuration: {},
    verifiedAt: at,
  });
  const route = await store.addTagRoute({
    tagId: owner.id,
    surfaceAccountId: account.id,
    scope: "channel:data",
  });
  const authorization = {
    version: 5,
    capturedAt: at,
    tag: { id: owner.id, name: owner.name },
    origin: {
      provider: "slack",
      surfaceAccountId: account.id,
      tagRouteId: route.id,
      scope: "channel:data",
    },
    requester: { id: "human", kind: "user" },
    roles: [],
    permissionSets: [],
    resources: [],
    runtimeActions: [],
  } as const;
  const contextPlan = { version: 7, capturedAt: at, sets: [] } as const;
  const event = {
    eventId: randomUUID(),
    logicalEventId: randomUUID(),
    provider: "slack",
    externalAccountId: account.externalAccountId,
    kind: "message",
    scope: "channel:data",
    sessionKey: "conversation",
    actor: { id: "human", kind: "user" },
    text: "Train on the datasets",
    occurredAt: at,
    callback: {
      provider: "slack",
      mode: "slack_thread",
      threadKey: "conversation",
      target: { channelId: "data", threadTs: "conversation" },
    },
    source: {},
    metadata: {},
  } as const;
  const admitted = await store.admitInboundEvent({
    surfaceAccountId: account.id,
    tagRouteId: route.id,
    tagId: owner.id,
    authorization,
    contextPlan,
    event,
  });
  const session = await store.openSession({
    tagId: owner.id,
    sessionKey: "conversation",
    origin: {},
    at,
  });
  const opened = await store.openTask({
    inboundEventId: admitted.work.id,
    tagId: owner.id,
    sessionId: session.id,
    execution: {},
    actor: event.actor,
    trigger: {},
    workspacePlan: { version: 1, status: "none" },
    sessionHistory: [],
    authorizationSnapshot: authorization,
    contextPlan,
    createdAt: at,
  });
  const attempt = await store.createTaskAttempt({
    taskId: opened.id,
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
  await store.recordTaskAttemptMountManifests(opened.id, attempt.id, [manifest]);
  const liveMount = {
    volume: "live-data",
    source: "s3://datasets/prefix/",
    prefix: "prefix/",
    path: "/mnt/live-data",
    strategy: "mount" as const,
    access: "read-only" as const,
    attachedAt: "2026-10-06T14:00:00.000Z",
  };
  await store.recordTaskAttemptLiveMounts(opened.id, attempt.id, [liveMount]);
  const task = await store.findTaskById(opened.id);
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
