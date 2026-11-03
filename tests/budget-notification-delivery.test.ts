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
  DrizzleStore,
  FileGatewayCredentialVault,
  migrateDatabase,
} from "../packages/store/src/index.ts";
import { createIsolatedPostgresDatabase } from "./support/database.ts";

const postgres = process.env["SUPERTAG_POSTGRES_URL"];
for (const dialect of ["sqlite", "postgresql"] as const) {
  it
    .skipIf(dialect === "postgresql" && !postgres)
    .each(["none", "account", "tag", "objective"] as const)(
    `${dialect} persists Gateway budget delivery across restart, revoked=%s`,
    async (revocation) => {
      const revoked = revocation === "account" || revocation === "tag";
      const objectiveBudget = revocation === "objective";
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
          // Empty capacity: neither escalation nor delivery may depend on an agent turn.
          reply: async (route, reply) => {
            if (
              !reply.markdown.includes("Budget decision required") &&
              !reply.markdown.includes("Objective allocation decision required")
            )
              return;
            routes.push(route);
            deliveries++;
            expect(reply.markdown).toContain("A reply to this notification is not approval");
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
        await store.addTagRoute({
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
        const measurementId = randomUUID();
        const objective = await store.createObjective({
          id: randomUUID(),
          ownerTagId: owner.id,
          outcome: "Work needs a decision",
          ...(objectiveBudget
            ? {
                budgetLimitMinor: 10,
                budgetCurrency: "USD",
                ongoing: true,
                observations: [{ workstreamId: measurementId }],
              }
            : {}),
        });
        if (objectiveBudget)
          await store.createTeam({
            id: measurementId,
            objectiveId: objective.id,
            name: "Measurements",
            leadTagId: owner.id,
            memberTagIds: [owner.id],
          });
        const team = await store.createTeam({
          id: objectiveBudget ? `${objective.id}:leadership` : randomUUID(),
          objectiveId: objective.id,
          name: "Leadership",
          leadTagId: owner.id,
          memberTagIds: [owner.id],
          maxConcurrency: 1,
        });
        const taskId = randomUUID();
        await store.admitTaskAssignment({
          taskId,
          objectiveId: objective.id,
          teamId: team.id,
          requestedByTagId: owner.id,
          assignedTagId: owner.id,
          instruction: "Complete work",
          acceptanceCriteria: ["Reviewed"],
          ...(objectiveBudget ? { startObjectiveExecution: true, maxCostMinor: 10 } : {}),
          execution: {
            limits: objectiveBudget
              ? { maxReportedCost: { amountMinor: 10, currency: "USD" } }
              : { maxReportedTokens: 1000 },
          },
          authorizationSnapshot: {
            version: 4,
            capturedAt: new Date().toISOString(),
            tag: { id: owner.id, name: owner.name },
            origin: { kind: "internal", objectiveId: objective.id, requestedByTagId: owner.id },
            requester: { id: owner.id, kind: "bot" },
            permissionSets: [],
            resources: [],
            runtimeActions: [],
          },
          contextPlan: { version: 7, capturedAt: new Date().toISOString(), sets: [] },
          workspacePlan: { version: 1, status: "none" },
        });
        await store.claimTaskAssignment({ taskId, leaseOwner: "fixture" });
        if (objectiveBudget)
          await store.registerTaskAssignmentWait({
            taskId,
            leaseOwner: "fixture",
            attemptCount: 1,
            mailbox: true,
            reason: "Need new observations",
          });
        await store.settleTaskAssignment({
          taskId,
          leaseOwner: "fixture",
          attemptCount: 1,
          failed: !objectiveBudget,
          result: objectiveBudget
            ? {}
            : {
                failureKind: "budget-exhausted",
                budgetExhaustion: { requiresAuthorization: true },
              },
        });
        if (objectiveBudget) {
          // Exercise the standalone fallback. An active root owner now reuses its existing
          // activation and therefore needs no additional Objective allocation.
          await store.cancelTaskAssignment(taskId, owner.id);
          await store.postWorkstream({
            workstreamId: measurementId,
            authorTagId: owner.id,
            body: "Changed workload",
            idempotencyKey: "measurement",
          });
          await store.reconcileObjectiveObservations();
          expect(await store.admitMailboxTaskAssignments()).toEqual([]);
        }
        const anchor = await store.getVerifiedSurfaceTask(notificationTaskId);
        if (!anchor?.inboundEventId) throw new Error("Missing verified route");
        const key = objectiveBudget
          ? `objective-budget:${encodeURIComponent(objective.id)}:1:${encodeURIComponent(anchor.id)}`
          : `task-budget:${encodeURIComponent(taskId)}:1:${encodeURIComponent(anchor.id)}`;
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
        // A fresh reconciler and Control Plane share the same immutable delivery identity.
        await new BudgetNotifications(store, notificationTaskId).reconcile();
        controlPlane = make();
        await controlPlane.start();
        await new BudgetNotifications(store, notificationTaskId).reconcile();
        await controlPlane.stop();
        expect(deliveries).toBe(revoked ? 1 : 2);
        expect(await store.getTaskAssignment(taskId)).toMatchObject({
          status: objectiveBudget ? "cancelled" : "failed",
          attemptCount: 1,
        });
        expect((await store.findTaskById(taskId))?.execution.limits).toEqual(
          objectiveBudget
            ? { maxReportedCost: { amountMinor: 10, currency: "USD" } }
            : { maxReportedTokens: 1000 },
        );
        expect(
          (await store.listTaskEvents(taskId)).some(
            (event) => event.type === "task.budget-renewed",
          ),
        ).toBe(false);
        expect(await store.listTaskAttempts(taskId)).toHaveLength(0);
        expect(execute).not.toHaveBeenCalled();
        if (objectiveBudget) {
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
          const decision = inbox.items[0]?.permittedActions[0];
          if (!decision) throw new Error("Missing allocation decision");
          await expect(
            controller.commandAsAdministrator(
              decision.tool,
              { ...decision.arguments, budgetLimitMinor: 20 },
              {
                ...principal,
                scopes: { ...principal.scopes, objectiveIds: ["another-objective"] },
              },
            ),
          ).rejects.toMatchObject({ statusCode: 403 });
          expect((await store.getObjective(objective.id)).budgetLimitMinor).toBe(10);
          await controller.commandAsAdministrator(
            decision.tool,
            { ...decision.arguments, budgetLimitMinor: 20 },
            principal,
          );
          expect(
            await new BudgetNotifications(store, notificationTaskId).mayDeliver({
              deliveryKey: key,
              inboundEventId: anchor.inboundEventId,
            }),
          ).toBe(false);
          await store.reconcileObjectiveObservations();
          const [assessment] = await store.admitMailboxTaskAssignments();
          if (!assessment) throw new Error("Missing resumed observation");
          await store.claimTaskAssignment({ taskId: assessment.taskId, leaseOwner: "assessment" });
          await store.settleTaskAssignment({
            taskId: assessment.taskId,
            leaseOwner: "assessment",
            attemptCount: 1,
            result: { text: "Measurement assessed" },
          });
          await store.reconcileObjectiveObservations();
          expect(
            (await store.getObjective(objective.id)).observationState?.cursors[measurementId],
          ).toBe(1);
          expect(
            (
              await controller.readCoordinationInbox(
                { objectiveId: objective.id, kind: "objective_budget" },
                principal,
              )
            ).items,
          ).toEqual([]);
        }
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
