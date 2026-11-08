import { randomUUID } from "node:crypto";
import type {
  JsonRecord,
  SurfaceTagAuthorizationSnapshot,
  TagContextPlan,
  Task,
} from "../../packages/core/src/index.js";
import type { DrizzleStore } from "../../packages/store/src/index.js";

export interface TestTaskOptions {
  /** The Tag whose Session the Task belongs to. Created when absent. */
  readonly tagId?: string;
  readonly tagName?: string;
  /** The Objective a new Session belongs to; the Task copies it when it opens. */
  readonly objectiveId?: string;
  /** Reuses an open Session instead of opening one for this Task. */
  readonly sessionId?: string;
  readonly sessionKey?: string;
  readonly contextPlan?: TagContextPlan;
  /** The admitted turn, which carries `inputArtifacts` for artifact inputs. */
  readonly trigger?: JsonRecord;
  readonly requestText?: string;
  readonly runtimeActions?: readonly string[];
}

/**
 * Opens one pending Task of a Tag's Session, the way an inbound surface message does. Tests that
 * need a durable Task without running the Control Plane use this instead of a fixture of their
 * own.
 */
export async function openTestTask(store: DrizzleStore, options: TestTaskOptions = {}) {
  const at = new Date().toISOString();
  const tagId =
    options.tagId ?? (await store.createTag({ name: options.tagName ?? `tag-${randomUUID()}` })).id;
  const tagName = options.tagName ?? (await store.findTagById(tagId))?.name ?? "tag";
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
  const scope = `channel:${randomUUID().slice(0, 8)}`;
  const route = await store.addTagRoute({ tagId, surfaceAccountId: account.id, scope });
  const authorization: SurfaceTagAuthorizationSnapshot = {
    version: 5,
    capturedAt: at,
    tag: { id: tagId, name: tagName },
    origin: { provider: "slack", surfaceAccountId: account.id, tagRouteId: route.id, scope },
    requester: { id: "operator", kind: "user" },
    roles: [],
    permissionSets: [],
    resources: [],
    runtimeActions: [...(options.runtimeActions ?? [])],
  };
  const contextPlan: TagContextPlan = options.contextPlan ?? {
    version: 7,
    capturedAt: at,
    sets: [],
  };
  const sessionKey = options.sessionKey ?? `conversation-${randomUUID()}`;
  const actor = { id: "operator", kind: "user" } as const;
  const admitted = await store.admitInboundEvent({
    surfaceAccountId: account.id,
    tagRouteId: route.id,
    tagId,
    authorization,
    contextPlan,
    event: {
      eventId: randomUUID(),
      logicalEventId: randomUUID(),
      provider: "slack",
      externalAccountId: account.externalAccountId,
      kind: "message",
      scope,
      sessionKey,
      actor,
      text: options.requestText ?? "Do the work",
      occurredAt: at,
      callback: {
        provider: "slack",
        mode: "slack_thread",
        threadKey: sessionKey,
        target: { channelId: scope, threadTs: sessionKey },
      },
      source: {},
      metadata: {},
    },
  });
  const sessionId =
    options.sessionId ??
    (
      await store.openSession({
        tagId,
        sessionKey,
        origin: {},
        ...(options.objectiveId === undefined ? {} : { objectiveId: options.objectiveId }),
        at,
      })
    ).id;
  const task: Task = await store.openTask({
    inboundEventId: admitted.work.id,
    tagId,
    sessionId,
    execution: {},
    actor,
    trigger: options.trigger ?? {},
    ...(options.requestText === undefined ? {} : { requestText: options.requestText }),
    workspacePlan: { version: 1, status: "none" },
    sessionHistory: [],
    authorizationSnapshot: authorization,
    contextPlan,
    createdAt: at,
  });
  return { task, tagId, tagName, sessionId, authorization, contextPlan, account, route };
}

/** A persisted running Task Attempt placed on a particular artifact-producing host. */
export async function artifactProducer(store: DrizzleStore, workerHostId: string) {
  const tag = await store.createTag({ name: `producer-${randomUUID()}` });
  const objective = await store.createObjective({
    id: randomUUID(),
    ownerTagId: tag.id,
    outcome: "Store artifacts",
  });
  const { task } = await openTestTask(store, {
    tagId: tag.id,
    tagName: tag.name,
    objectiveId: objective.id,
    requestText: "Store artifacts",
  });
  return store.createTaskAttempt({
    taskId: task.id,
    attemptNumber: 1,
    workerProfile: { id: "test", revision: "1" },
    workerSnapshot: { workerHostId, connectionGeneration: 1 },
    startedAt: new Date().toISOString(),
  });
}
