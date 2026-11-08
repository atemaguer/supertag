import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { expect, it, vi } from "vitest";
import { BudgetNotifications } from "../packages/control-plane/src/budget-notifications.ts";
import { ControlPlane } from "../packages/control-plane/src/index.ts";
import { ObjectiveController } from "../packages/control-plane/src/objective-controller.js";
import {
  objectiveSessionKey,
  type SurfaceTagAuthorizationSnapshot,
} from "../packages/core/src/index.ts";
import {
  DrizzleStore,
  FileGatewayCredentialVault,
  migrateDatabase,
} from "../packages/store/src/index.ts";
import { createIsolatedPostgresDatabase } from "./support/database.ts";

/** The notice the Objective's home thread gets when its budget is spent. */
const NOTICE = "Its budget is used up, so it starts no new work.";

const postgres = process.env["SUPERTAG_POSTGRES_URL"];
for (const dialect of ["sqlite", "postgresql"] as const) {
  it.skipIf(dialect === "postgresql" && !postgres).each(["none", "account", "tag"] as const)(
    `${dialect} persists Gateway Objective budget delivery across restart, revoked=%s`,
    async (revocation) => {
      const revoked = revocation === "account" || revocation === "tag";
      const directory = await mkdtemp(join(tmpdir(), "supertag-budget-notice-"));
      const isolated =
        dialect === "postgresql" && postgres
          ? await createIsolatedPostgresDatabase(postgres)
          : undefined;
      const url = isolated?.url ?? `file:${join(directory, "state.db")}`;
      await migrateDatabase({ url });
      const store = new DrizzleStore({ url });
      await store.connect();
      let controlPlane: ControlPlane | undefined;
      let notificationTaskId: string | undefined;
      let deliveries = 0;
      const routes: unknown[] = [];
      const execute = vi.fn(() => {
        throw new Error("No model may execute");
      });
      const make = () =>
        new ControlPlane({
          store: new DrizzleStore({ url }),
          credentialVault: new FileGatewayCredentialVault(join(directory, "vault.json")),
          ...(notificationTaskId ? { operatorNotificationTaskId: notificationTaskId } : {}),
          worklet: {
            id: "empty-host",
            describe: async () => ({
              id: "empty-host",
              protocolVersion: 1,
              host: { id: "unused-host", workers: [] },
            }),
            selectExecution: async () => undefined,
            execute,
          },
          // Empty capacity: the notice must not depend on an agent turn.
          reply: async (route, reply) => {
            if (!reply.markdown.includes(NOTICE)) return;
            routes.push(route);
            deliveries++;
            expect(reply.markdown).toContain("supertag update objective");
            if (deliveries === 1) throw new Error("Temporary surface outage");
          },
          dispatch: { pollIntervalMs: 10, retryBaseMs: 1000, maxAttempts: 3 },
        });
      try {
        controlPlane = make();
        await controlPlane.start();
        // Capture a verified destination without any model capacity.
        const account = await controlPlane.setupSurfaceAccount({
          provider: "slack",
          externalAccountId: "T-NOTICE",
          displayName: "Operator",
          authMethod: "slack-socket-mode",
          configuration: { transport: "socket" },
          secrets: { botToken: "xoxb-test", appToken: "xapp-test" },
        });
        const owner = await store.createTag({ name: `owner-${randomUUID()}` });
        await store.bindTagWorkerHost(owner.id, "unused-host");
        const route = await store.addTagRoute({
          tagId: owner.id,
          surfaceAccountId: account.id,
          scope: "channel:C1",
        });
        const admission = await controlPlane.ingestSurfaceEvent({
          eventId: "operator-anchor",
          logicalEventId: "operator-anchor",
          provider: "slack",
          externalAccountId: "T-NOTICE",
          kind: "mention",
          scope: "channel:C1",
          sessionKey: "slack:T-NOTICE:C1:1.000",
          actor: { id: "U1", kind: "user" },
          text: "Operator inbox",
          occurredAt: new Date().toISOString(),
          callback: {
            provider: "slack",
            mode: "slack_thread",
            threadKey: "T-NOTICE|C1|1.000",
            target: { channelId: "C1", threadTs: "1.000" },
          },
          source: {},
          metadata: {},
        });
        if (!admission.taskId) throw new Error("Missing verified surface Task");
        notificationTaskId = admission.taskId;
        await controlPlane.stop();

        const objective = await store.createObjective({
          id: randomUUID(),
          ownerTagId: owner.id,
          outcome: "Work needs a decision",
          budgetLimitMinor: 10,
          budgetCurrency: "USD",
        });
        // One turn of the Objective's own Session marks it started, which the inbox requires.
        // Its event is never due, so no Attempt runs: the notice never depends on an agent.
        const at = new Date().toISOString();
        const authorization: SurfaceTagAuthorizationSnapshot = {
          version: 5,
          capturedAt: at,
          tag: { id: owner.id, name: owner.name },
          origin: {
            provider: "slack",
            surfaceAccountId: account.id,
            tagRouteId: route.id,
            scope: "channel:C1",
          },
          requester: { id: "supertag", kind: "bot" },
          roles: [],
          permissionSets: [],
          resources: [],
          runtimeActions: [],
        };
        const contextPlan = { version: 7, capturedAt: at, sets: [] } as const;
        const sessionKey = objectiveSessionKey(objective.id);
        const admitted = await store.admitInboundEvent({
          surfaceAccountId: account.id,
          tagRouteId: route.id,
          tagId: owner.id,
          authorization,
          contextPlan,
          availableAt: new Date(Date.now() + 3_600_000).toISOString(),
          event: {
            eventId: randomUUID(),
            logicalEventId: randomUUID(),
            provider: "slack",
            externalAccountId: "T-NOTICE",
            kind: "message",
            scope: "channel:C1",
            sessionKey,
            actor: { id: "supertag", displayName: "SuperTag", kind: "bot" },
            text: "Work needs a decision",
            occurredAt: at,
            callback: {
              provider: "slack",
              mode: "slack_thread",
              threadKey: "T-NOTICE|C1|1.000",
              target: { channelId: "C1", threadTs: "1.000" },
            },
            source: {},
            metadata: {},
            internal: {
              kind: "delivery",
              from: { kind: "supertag" },
              reason: "objective_start",
              objectiveId: objective.id,
            },
          },
        });
        const session = await store.openSession({
          tagId: owner.id,
          sessionKey,
          origin: {},
          objectiveId: objective.id,
          at,
        });
        await store.openTask({
          inboundEventId: admitted.work.id,
          tagId: owner.id,
          sessionId: session.id,
          execution: { limits: { maxReportedCost: { amountMinor: 10, currency: "USD" } } },
          actor: { id: "supertag", kind: "bot" },
          trigger: {},
          workspacePlan: { version: 1, status: "none" },
          sessionHistory: [],
          authorizationSnapshot: authorization,
          contextPlan,
          createdAt: at,
        });
        expect((await store.getObjective(objective.id)).executionStartedAt).toBeTruthy();
        // The limit sweep observed the pool spent.
        const exhausted = await store.recordObjectiveLimitState(
          objective.id,
          { budgetExhausted: { limitMinor: 10, spentMinor: 10, at } },
          (await store.getObjective(objective.id)).revision,
        );
        if (!exhausted) throw new Error("Could not record the exhausted budget");

        const anchor = await store.getVerifiedSurfaceTask(notificationTaskId);
        if (!anchor?.inboundEventId) throw new Error("Missing verified route");
        // The delivery key names the Objective, the inbox item and the home Task, so a restart
        // or a repeated sweep posts the same notice once.
        const key = `objective-budget:${encodeURIComponent(objective.id)}:${encodeURIComponent(
          "budget-exhausted-10",
        )}:${encodeURIComponent(anchor.id)}`;

        controlPlane = make();
        await controlPlane.start();
        await expect.poll(() => deliveries, { timeout: 5000 }).toBe(1);
        await controlPlane.stop();
        expect((await store.findOutboundReply(anchor.inboundEventId, key))?.status).not.toBe(
          "delivered",
        );
        if (revocation === "account") {
          // Simulate persisted surface revocation; no public revocation command exists yet.
          await expect(
            store.saveSurfaceAccount({ ...account, status: "revoked" as "connected" }),
          ).rejects.toThrow("Unsupported Surface Account status");
        }
        if (revocation === "tag") {
          // Persist revocation directly: Tag status is currently read-only in the public API.
          if (dialect === "sqlite") {
            const database = new Database(join(directory, "state.db"));
            try {
              database
                .prepare('UPDATE "Tag" SET status = ? WHERE id = ?')
                .run("inactive", owner.id);
            } finally {
              database.close();
            }
          } else {
            const { Pool } = createRequire(
              new URL("../packages/store/package.json", import.meta.url),
            )("pg");
            const pool = new Pool({ connectionString: url });
            try {
              await pool.query('UPDATE "Tag" SET status = $1 WHERE id = $2', [
                "inactive",
                owner.id,
              ]);
            } finally {
              await pool.end();
            }
          }
          expect((await store.findSurfaceAccountById(account.id))?.status).toBe("connected");
          expect(await store.getVerifiedSurfaceTask(notificationTaskId)).toBeUndefined();
        }
        controlPlane = make();
        await controlPlane.start();
        await expect
          .poll(
            async () =>
              (await store.findOutboundReply(anchor.inboundEventId as string, key))?.status,
            { timeout: 5000 },
          )
          .toBe(revoked ? "failed" : "delivered");
        await controlPlane.stop();
        if (revocation === "tag") {
          const outbound = await store.findOutboundReply(anchor.inboundEventId, key);
          expect(outbound).toMatchObject({ status: "failed", deliveryKey: key });
          expect(JSON.stringify(outbound)).toContain(
            "Operator notification was superseded, resolved, or its destination is no longer verified",
          );
        }
        expect(deliveries).toBe(revoked ? 1 : 2);
        if (!revoked) expect(routes[1]).toEqual(routes[0]);
        // A fresh reconciler and Control Plane share the same immutable delivery identity: a
        // repeated sweep over the same inbox item must not post the notice again.
        await new BudgetNotifications(store, notificationTaskId).reconcile();
        controlPlane = make();
        await controlPlane.start();
        await new BudgetNotifications(store, notificationTaskId).reconcile();
        await controlPlane.stop();
        expect(deliveries).toBe(revoked ? 1 : 2);
        expect(await store.listTaskAttempts(admitted.work.id)).toHaveLength(0);
        expect(execute).not.toHaveBeenCalled();

        // The operator raises the allocation from the inbox item's own permitted action, and the
        // notice then no longer applies to the home thread.
        const controller = new ObjectiveController(store, undefined);
        const principal = {
          operatorId: "budget-operator",
          scopes: {
            actions: ["read_coordination_inbox", "update_objective"],
            objectiveIds: [objective.id],
          },
        };
        const inbox = await controller.readCoordinationInbox(
          { objectiveId: objective.id, kind: "objective_budget" },
          principal,
        );
        expect(inbox.items).toHaveLength(1);
        expect(inbox.items[0]?.permittedActions[0]).toMatchObject({
          tool: "update_objective",
          arguments: { objectiveId: objective.id },
          requiredInputFields: ["budgetLimitMinor"],
        });
        const current = await store.getObjective(objective.id);
        await store.updateObjectiveStatus(objective.id, {
          expectedRevision: current.revision,
          budgetLimitMinor: 20,
        });
        // The observation named the old limit, so the raised budget retires it.
        expect(
          (
            await controller.readCoordinationInbox(
              { objectiveId: objective.id, kind: "objective_budget" },
              principal,
            )
          ).items,
        ).toEqual([]);
      } finally {
        await controlPlane?.stop();
        await store.disconnect();
        await isolated?.cleanup();
        await rm(directory, { recursive: true, force: true });
      }
    },
    20000,
  );
}
