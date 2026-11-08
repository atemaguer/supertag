import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { objectiveSessionKey } from "@supertag/core";
import { afterEach, describe, expect, it } from "vitest";
import { createIsolatedPostgresDatabase } from "../../tests/support/database.js";
import { DrizzleStore, migrateDatabase } from "./src/index.js";
import {
  parseResourceChangeListInput,
  RESOURCE_CHANGE_MAX_BYTES,
  resourceChangeDelta,
} from "./src/resource-change.js";

const postgres = process.env["SUPERTAG_POSTGRES_URL"];

describe("resource change definition", () => {
  it("records only changed fields in stable order", () => {
    expect(
      resourceChangeDelta(
        { maxConcurrency: 2, memberTagIds: ["a"], name: "Same" },
        { maxConcurrency: 5, memberTagIds: ["a"], name: "Same" },
        ["name", "maxConcurrency", "memberTagIds"],
      ),
    ).toEqual({ maxConcurrency: { previous: 2, next: 5 } });
  });

  it("uses null as the pre-creation value", () => {
    expect(resourceChangeDelta(null, { name: "Research" }, ["name"])).toEqual({
      name: { previous: null, next: "Research" },
    });
  });

  it("bounds delta payload size and revision pagination", () => {
    expect(() =>
      resourceChangeDelta(
        { name: "a".repeat(RESOURCE_CHANGE_MAX_BYTES) },
        { name: "b".repeat(RESOURCE_CHANGE_MAX_BYTES) },
        ["name"],
      ),
    ).toThrow("Resource change exceeds 192 KiB");
    expect(
      parseResourceChangeListInput({
        resourceType: "team",
        resourceId: "research",
        afterRevision: 2,
        limit: 10,
      }),
    ).toEqual({ resourceType: "team", resourceId: "research", afterRevision: 2, limit: 10 });
  });
});

for (const dialect of ["sqlite", "postgresql"] as const) {
  describe.skipIf(dialect === "postgresql" && !postgres)(`${dialect} resource changes`, () => {
    const cleanups: Array<() => Promise<void>> = [];
    afterEach(async () => {
      for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
    });

    async function fixture() {
      const directory = await mkdtemp(join(tmpdir(), "supertag-resource-change-"));
      const isolated =
        dialect === "postgresql" && postgres
          ? await createIsolatedPostgresDatabase(postgres)
          : undefined;
      const url = isolated?.url ?? `file:${join(directory, "state.db")}`;
      await migrateDatabase({ url });
      const store = new DrizzleStore({ url });
      const reopened = new DrizzleStore({ url });
      await store.connect();
      await reopened.connect();
      cleanups.push(async () => {
        await reopened.disconnect();
        await store.disconnect();
        await isolated?.cleanup();
        await rm(directory, { recursive: true, force: true });
      });
      const owner = await store.createTag({ name: `owner-${randomUUID()}` });
      const lead = await store.createTag({ name: `lead-${randomUUID()}` });
      const team = await store.createTeam({
        id: randomUUID(),
        name: `Research ${randomUUID()}`,
        memberTagIds: [owner.id, lead.id],
        maxConcurrency: 2,
      });
      const objective = await store.createObjective({
        id: randomUUID(),
        ownerTagId: owner.id,
        outcome: "Retain Team changes",
        teamId: team.id,
      });
      const account = await store.saveSurfaceAccount({
        provider: "slack",
        externalAccountId: randomUUID(),
        displayName: "Slack",
        authMethod: "test",
        credentialId: "test",
        status: "connected",
        configuration: {},
        verifiedAt: new Date().toISOString(),
      });
      const route = await store.addTagRoute({
        tagId: owner.id,
        surfaceAccountId: account.id,
        scope: "channel:research",
      });
      /** One turn of the Objective's own Session, as the Control Plane admits it. */
      async function objectiveTask(): Promise<string> {
        const at = new Date().toISOString();
        const authorization = {
          version: 5,
          capturedAt: at,
          tag: { id: owner.id, name: owner.name },
          origin: {
            tagRouteId: route.id,
            surfaceAccountId: account.id,
            provider: "slack",
            scope: "channel:research",
          },
          requester: { id: owner.id, kind: "bot" },
          permissionSets: [],
          resources: [],
          runtimeActions: [],
        } as const;
        const eventId = randomUUID();
        const admitted = await store.admitInboundEvent({
          surfaceAccountId: account.id,
          tagRouteId: route.id,
          tagId: owner.id,
          authorization,
          contextPlan: { version: 7, capturedAt: at, sets: [] },
          event: {
            eventId,
            logicalEventId: eventId,
            provider: "slack",
            externalAccountId: account.externalAccountId,
            kind: "message",
            scope: "channel:research",
            sessionKey: objectiveSessionKey(objective.id),
            actor: { id: owner.id, kind: "bot" },
            internal: { kind: "delivery", from: { kind: "supertag" }, reason: "objective_start" },
            text: "Retain Team changes",
            occurredAt: at,
            callback: {
              provider: "slack",
              mode: "slack_thread",
              threadKey: "research",
              target: { channelId: "research", threadTs: "research" },
            },
            source: {},
            metadata: {},
          },
        });
        const session = await store.openSession({
          tagId: owner.id,
          sessionKey: objectiveSessionKey(objective.id),
          origin: {},
          objectiveId: objective.id,
          at,
        });
        const task = await store.openTask({
          inboundEventId: admitted.work.id,
          tagId: owner.id,
          sessionId: session.id,
          execution: {},
          actor: { id: owner.id, kind: "bot" },
          trigger: { origin: "objective_start" },
          workspacePlan: { version: 1, status: "none" },
          sessionHistory: [],
          authorizationSnapshot: authorization,
          contextPlan: { version: 7, capturedAt: at, sets: [] },
          createdAt: at,
        });
        return task.id;
      }
      return { store, reopened, owner, lead, objective, team, objectiveTask };
    }

    it("records a Team's creation and only its changed fields", async () => {
      const f = await fixture();
      await f.store.updateTeam(f.team.id, { expectedRevision: 1, maxConcurrency: 5 });

      const changes = await f.reopened.listResourceChanges({
        resourceType: "team",
        resourceId: f.team.id,
      });
      expect(changes).toHaveLength(2);
      expect(changes[0]).toMatchObject({ fromRevision: 0, toRevision: 1, sourceTaskId: null });
      // JSONB preserves the changed fields, but does not preserve object key order.
      expect(Object.keys(changes[0]?.changes ?? {}).sort()).toEqual([
        "maxConcurrency",
        "memberTagIds",
        "name",
      ]);
      expect(changes[1]).toMatchObject({
        fromRevision: 1,
        toRevision: 2,
        changes: { maxConcurrency: { previous: 2, next: 5 } },
      });
      expect(Object.keys(changes[1]?.changes ?? {}).sort()).toEqual(["maxConcurrency"]);
    });

    it("records the Tag and Task behind an Objective change", async () => {
      const f = await fixture();
      const sourceTaskId = await f.objectiveTask();
      await f.store.updateObjectiveStatus(
        f.objective.id,
        { expectedRevision: f.objective.revision, status: "blocked" },
        f.owner.id,
        undefined,
        { taskId: sourceTaskId },
      );

      const changes = await f.reopened.listResourceChanges({
        resourceType: "objective",
        resourceId: f.objective.id,
      });
      expect(changes.at(-1)).toMatchObject({
        actorTagId: f.owner.id,
        operatorId: null,
        sourceTaskId,
        changes: { status: { previous: "working", next: "blocked" } },
      });
    });

    it("pages by revision and does not journal rejected writes", async () => {
      const f = await fixture();
      await f.store.updateTeam(f.team.id, { expectedRevision: 1, name: "Revision two" });
      await expect(
        f.store.updateTeam(f.team.id, { expectedRevision: 1, name: "Stale" }),
      ).rejects.toMatchObject({ statusCode: 409 });
      await f.store.updateTeam(f.team.id, { expectedRevision: 2, name: "Revision three" });

      const second = await f.reopened.listResourceChanges({
        resourceType: "team",
        resourceId: f.team.id,
        afterRevision: 1,
        limit: 1,
      });
      expect(second.map((change) => change.toRevision)).toEqual([2]);
      const third = await f.reopened.listResourceChanges({
        resourceType: "team",
        resourceId: f.team.id,
        afterRevision: 2,
        limit: 10,
      });
      expect(third.map((change) => change.toRevision)).toEqual([3]);
    });
  });
}
