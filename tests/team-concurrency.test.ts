import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { formatObjectiveOverview } from "../apps/cli/src/objective-overview.js";
import { ObjectiveController } from "../packages/control-plane/src/objective-controller.js";
import {
  type DurableInboundEvent,
  objectiveSessionKey,
  type SurfaceTagAuthorizationSnapshot,
} from "../packages/core/src/index.js";
import { DrizzleStore, migrateDatabase } from "../packages/store/src/index.js";
import { createIsolatedPostgresDatabase } from "./support/database.js";
import { overviewViewOf } from "./support/objective-overview-view.js";

const postgres = process.env["SUPERTAG_POSTGRES_URL"];

/**
 * A Team's `maxConcurrency` is a clause of `listDueInboundEvents`: turns of the Sessions of every
 * Objective naming the Team stay within it, and events over the limit stay pending.
 */
for (const dialect of ["sqlite", "postgresql"] as const) {
  describe.skipIf(dialect === "postgresql" && !postgres)(`${dialect} Team concurrency`, () => {
    const cleanups: Array<() => Promise<unknown>> = [];
    afterEach(async () => {
      for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
    });

    async function fixture() {
      const directory = await mkdtemp(join(tmpdir(), "supertag-team-concurrency-"));
      cleanups.push(() => rm(directory, { recursive: true, force: true }));
      const isolated =
        dialect === "postgresql"
          ? await createIsolatedPostgresDatabase(postgres as string)
          : undefined;
      if (isolated) cleanups.push(isolated.cleanup);
      const url = isolated?.url ?? `file:${join(directory, "state.db")}`;
      await migrateDatabase({ url });
      const store = new DrizzleStore({ url });
      await store.connect();
      cleanups.push(() => store.disconnect());
      const owner = await store.createTag({ name: `owner-${randomUUID()}` });
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
        scope: "channel:work",
      });
      const at = new Date().toISOString();
      const authorization: SurfaceTagAuthorizationSnapshot = {
        version: 5,
        capturedAt: at,
        tag: { id: owner.id, name: owner.name },
        origin: {
          provider: "slack",
          surfaceAccountId: account.id,
          tagRouteId: route.id,
          scope: "channel:work",
        },
        requester: { id: "supertag", kind: "bot" },
        roles: [],
        permissionSets: [],
        resources: [],
        runtimeActions: [],
      };
      const contextPlan = { version: 7, capturedAt: at, sets: [] } as const;

      const createObjective = (teamId: string | null) =>
        store.createObjective({
          id: randomUUID(),
          ownerTagId: owner.id,
          outcome: "Deliver independent items at once",
          ...(teamId === null ? {} : { teamId }),
        });

      /** Admits one turn of an Objective's own Session and opens its Task, as the start does. */
      async function admitTurn(objectiveId: string): Promise<DurableInboundEvent> {
        const sessionKey = objectiveSessionKey(objectiveId);
        const admitted = await store.admitInboundEvent({
          surfaceAccountId: account.id,
          tagRouteId: route.id,
          tagId: owner.id,
          authorization,
          contextPlan,
          event: {
            eventId: randomUUID(),
            logicalEventId: randomUUID(),
            provider: "slack",
            externalAccountId: account.externalAccountId,
            kind: "message",
            scope: "channel:work",
            sessionKey,
            actor: { id: "supertag", displayName: "SuperTag", kind: "bot" },
            text: "Deliver independent items at once",
            occurredAt: new Date().toISOString(),
            callback: {
              provider: "slack",
              mode: "slack_thread",
              threadKey: sessionKey,
              target: { channelId: "work", threadTs: "1.000" },
            },
            source: {},
            metadata: {},
            internal: {
              kind: "delivery",
              from: { kind: "supertag" },
              reason: "objective_start",
              objectiveId,
            },
          },
        });
        const session = await store.openSession({
          tagId: owner.id,
          sessionKey,
          origin: {},
          objectiveId,
          at: new Date().toISOString(),
        });
        await store.openTask({
          inboundEventId: admitted.work.id,
          tagId: owner.id,
          sessionId: session.id,
          execution: {},
          actor: { id: "supertag", kind: "bot" },
          trigger: {},
          workspacePlan: { version: 1, status: "none" },
          sessionHistory: [],
          authorizationSnapshot: authorization,
          contextPlan,
          createdAt: new Date().toISOString(),
        });
        return admitted.work;
      }

      const due = () =>
        store
          .listDueInboundEvents({ now: new Date().toISOString(), limit: 50 })
          .then((events) => events.map((event) => event.id));
      const claim = (inboundEventId: string) =>
        store.claimDueInboundEvent({
          inboundEventId,
          leaseOwner: "test",
          now: new Date().toISOString(),
          leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
        });
      const finish = (inboundEventId: string) =>
        store.completeInboundEvent({
          inboundEventId,
          leaseOwner: "test",
          workerId: "test",
          responseText: "done",
          completedAt: new Date().toISOString(),
        });
      const controller = new ObjectiveController(store, undefined);
      return { store, owner, createObjective, admitTurn, due, claim, finish, controller };
    }

    it("runs every Objective's turn at once when the Team sets no limit", async () => {
      const f = await fixture();
      const team = await f.store.createTeam({
        id: randomUUID(),
        name: `delivery-${randomUUID()}`,
        memberTagIds: [f.owner.id],
      });
      expect(team.maxConcurrency).toBeNull();
      const objectives = await Promise.all([
        f.createObjective(team.id),
        f.createObjective(team.id),
        f.createObjective(team.id),
      ]);
      const events = [];
      for (const objective of objectives) events.push(await f.admitTurn(objective.id));
      expect((await f.due()).toSorted()).toEqual(events.map((event) => event.id).toSorted());
      for (const event of events) expect((await f.claim(event.id))?.status).toBe("processing");

      const view = await f.controller.readObjectiveOverview({
        objectiveId: objectives[0]?.id as string,
      });
      expect(view.team).toMatchObject({ id: team.id, maxConcurrency: null });
      expect(formatObjectiveOverview(overviewViewOf(view))).toContain(
        "limited only by Worker Host capacity",
      );
    });

    it("holds turns over the Team's limit, counting every Objective that names it", async () => {
      const f = await fixture();
      const team = await f.store.createTeam({
        id: randomUUID(),
        name: `throttled-${randomUUID()}`,
        memberTagIds: [f.owner.id],
        maxConcurrency: 1,
      });
      const here = await f.createObjective(team.id);
      const elsewhere = await f.createObjective(team.id);
      const first = await f.admitTurn(here.id);
      const second = await f.admitTurn(elsewhere.id);
      // Both Sessions have a due turn, but only one may run at a time.
      expect((await f.due()).toSorted()).toEqual([first.id, second.id].toSorted());
      expect((await f.claim(first.id))?.status).toBe("processing");
      expect(await f.due()).toEqual([]);
      expect(await f.claim(second.id)).toBeUndefined();
      // The slot frees when the running turn ends.
      await f.finish(first.id);
      expect(await f.due()).toEqual([second.id]);
      expect((await f.claim(second.id))?.status).toBe("processing");

      const view = await f.controller.readObjectiveOverview({ objectiveId: here.id });
      expect(view.team).toMatchObject({ maxConcurrency: 1 });
      expect(formatObjectiveOverview(overviewViewOf(view))).toContain(
        "at most 1 turns at once across its Objectives",
      );
    });

    it("counts only the Objectives that name the same Team", async () => {
      const f = await fixture();
      const throttled = await f.store.createTeam({
        id: randomUUID(),
        name: `throttled-${randomUUID()}`,
        memberTagIds: [f.owner.id],
        maxConcurrency: 1,
      });
      const other = await f.store.createTeam({
        id: randomUUID(),
        name: `other-${randomUUID()}`,
        memberTagIds: [f.owner.id],
        maxConcurrency: 1,
      });
      const held = await f.admitTurn((await f.createObjective(throttled.id)).id);
      const unrelated = await f.admitTurn((await f.createObjective(other.id)).id);
      const teamless = await f.admitTurn((await f.createObjective(null)).id);
      expect((await f.claim(held.id))?.status).toBe("processing");
      // The other Team's limit and an Objective without a Team are untouched by it.
      expect((await f.due()).toSorted()).toEqual([teamless.id, unrelated.id].toSorted());
    });
  });
}
