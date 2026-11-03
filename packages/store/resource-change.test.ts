import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
        { context: { old: true }, leadTagId: "lead", name: "Same" },
        { context: { current: true }, leadTagId: "next", name: "Same" },
        ["name", "leadTagId", "context"],
      ),
    ).toEqual({
      context: { previous: { old: true }, next: { current: true } },
      leadTagId: { previous: "lead", next: "next" },
    });
  });

  it("uses null as the pre-creation value", () => {
    expect(resourceChangeDelta(null, { name: "Research" }, ["name"])).toEqual({
      name: { previous: null, next: "Research" },
    });
  });

  it("bounds delta payload size and revision pagination", () => {
    expect(() =>
      resourceChangeDelta(
        { context: { value: "a".repeat(RESOURCE_CHANGE_MAX_BYTES) } },
        { context: { value: "b".repeat(RESOURCE_CHANGE_MAX_BYTES) } },
        ["context"],
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
      const objective = await store.createObjective({
        id: randomUUID(),
        ownerTagId: owner.id,
        outcome: "Retain Team changes",
      });
      const team = await store.createTeam(
        {
          id: randomUUID(),
          objectiveId: objective.id,
          name: "Research",
          leadTagId: lead.id,
          memberTagIds: [],
          maxConcurrency: 2,
        },
        owner.id,
      );
      return { store, reopened, owner, lead, objective, team };
    }

    it("persists creation and changed-field deltas with provenance", async () => {
      const f = await fixture();
      await f.store.setTagMessagingGrant({
        senderTagId: f.lead.id,
        recipientTagId: f.owner.id,
        messageTypes: ["message"],
      });
      const sourceMessage = (
        await f.store.enqueueTagMessage({
          senderTagId: f.lead.id,
          recipientTagId: f.owner.id,
          objectiveId: f.objective.id,
          type: "message",
          body: { requestedChange: "Update shared context" },
          idempotencyKey: randomUUID(),
        })
      ).message;
      const sourceTaskId = randomUUID();
      await f.store.admitTaskAssignment({
        taskId: sourceTaskId,
        objectiveId: f.objective.id,
        teamId: f.team.id,
        requestedByTagId: f.owner.id,
        assignedTagId: f.lead.id,
        instruction: "Maintain Team context",
        acceptanceCriteria: ["Context is current"],
        execution: {},
        authorizationSnapshot: {
          version: 4,
          capturedAt: new Date().toISOString(),
          tag: { id: f.lead.id, name: f.lead.name },
          origin: {
            kind: "internal",
            objectiveId: f.objective.id,
            requestedByTagId: f.owner.id,
          },
          requester: { id: f.owner.id, kind: "bot" },
          permissionSets: [],
          resources: [],
          runtimeActions: [],
        },
        contextPlan: { version: 7, capturedAt: new Date().toISOString(), sets: [] },
        workspacePlan: { version: 1, status: "none" },
      });
      await f.store.updateTeam(
        f.team.id,
        {
          expectedRevision: 1,
          name: "Research and Review",
          context: { policy: "reviewed artifacts only" },
        },
        f.lead.id,
        { sourceTaskId, sourceMessageId: sourceMessage.id },
      );

      const changes = await f.reopened.listResourceChanges({
        resourceType: "team",
        resourceId: f.team.id,
      });
      expect(changes).toHaveLength(2);
      expect(changes[0]).toMatchObject({
        fromRevision: 0,
        toRevision: 1,
        actorTagId: f.owner.id,
        sourceTaskId: null,
        sourceMessageId: null,
      });
      // JSONB preserves the changed fields, but does not preserve object key order.
      expect(Object.keys(changes[0]?.changes ?? {}).sort()).toEqual([
        "context",
        "leadTagId",
        "maxConcurrency",
        "memberTagIds",
        "name",
        "objectiveId",
        "objectiveIds",
        "parentTeamId",
        "scaling",
        "status",
      ]);
      expect(changes[1]).toMatchObject({
        fromRevision: 1,
        toRevision: 2,
        actorTagId: f.lead.id,
        sourceTaskId,
        sourceMessageId: sourceMessage.id,
        changes: {
          context: { previous: {}, next: { policy: "reviewed artifacts only" } },
          name: { previous: "Research", next: "Research and Review" },
        },
      });
      expect(Object.keys(changes[1]?.changes ?? {}).sort()).toEqual(["context", "name"]);
    });

    it("pages by revision and does not journal rejected writes", async () => {
      const f = await fixture();
      await f.store.updateTeam(f.team.id, { expectedRevision: 1, name: "Revision two" }, f.lead.id);
      await expect(
        f.store.updateTeam(f.team.id, { expectedRevision: 1, name: "Stale" }, f.lead.id),
      ).rejects.toMatchObject({ statusCode: 409 });
      await f.store.updateTeam(
        f.team.id,
        { expectedRevision: 2, name: "Revision three" },
        f.lead.id,
      );

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
