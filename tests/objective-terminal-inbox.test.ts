import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ObjectiveController } from "../packages/control-plane/src/objective-controller.js";
import {
  objectiveSessionKey,
  type SurfaceTagAuthorizationSnapshot,
} from "../packages/core/src/index.js";
import { DrizzleStore, migrateDatabase } from "../packages/store/src/index.js";
import { createIsolatedPostgresDatabase } from "./support/database.js";

const postgres = process.env["SUPERTAG_POSTGRES_URL"];
for (const dialect of ["sqlite", "postgresql"] as const)
  describe.skipIf(dialect === "postgresql" && !postgres)(
    `${dialect} operator inbox when an Objective closes`,
    () => {
      async function fixture() {
        const directory = await mkdtemp(join(tmpdir(), "terminal-inbox-"));
        const isolated =
          dialect === "postgresql"
            ? await createIsolatedPostgresDatabase(postgres as string)
            : undefined;
        const url = isolated?.url ?? `file:${join(directory, "state.db")}`;
        await migrateDatabase({ url });
        const store = new DrizzleStore({ url });
        await store.connect();
        const owner = await store.createTag({ name: randomUUID() });
        const team = await store.createTeam({
          id: randomUUID(),
          name: `team-${randomUUID()}`,
          memberTagIds: [owner.id],
        });
        const objective = await store.createObjective({
          id: randomUUID(),
          ownerTagId: owner.id,
          teamId: team.id,
          outcome: "Repair the service",
          budgetLimitMinor: 1000,
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
          scope: "channel:repair",
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
            scope: "channel:repair",
          },
          requester: { id: "supertag", kind: "bot" },
          roles: [],
          permissionSets: [],
          resources: [],
          runtimeActions: [],
        };
        const contextPlan = { version: 7, capturedAt: at, sets: [] } as const;
        const sessionKey = objectiveSessionKey(objective.id);
        /** One turn of the Objective's own Session, settled with the outcome given. */
        const ownerTurn = async (text: string, outcome: Record<string, unknown>) => {
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
              scope: "channel:repair",
              sessionKey,
              actor: { id: "supertag", displayName: "SuperTag", kind: "bot" },
              text,
              occurredAt: new Date().toISOString(),
              callback: {
                provider: "slack",
                mode: "slack_thread",
                threadKey: sessionKey,
                target: { channelId: "repair", threadTs: "1.000" },
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
          const task = await store.openTask({
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
          await store.startTask({ taskId: task.id, startedAt: new Date().toISOString() });
          return store.closeTask({
            taskId: task.id,
            status: "completed",
            outcome,
            endedAt: new Date().toISOString(),
          });
        };

        // The Objective's turn asked the operator a question and waits on the answer.
        const asked = await ownerTurn("Repair the service", {
          question: "Raise the budget to 2000?",
        });
        const approval = await store.createApprovalRequest({
          objectiveId: objective.id,
          taskId: asked.id,
          requestingTagId: owner.id,
          kind: "surface-action",
          actions: [{ target: "runtime", action: "deploy" }],
          summary: "Deploy the repair",
          ruleSources: ["release"],
          approvers: [],
        });
        return {
          store,
          owner,
          objective,
          asked,
          approval,
          ownerTurn,
          controller: new ObjectiveController(store, undefined),
          async close() {
            await store.disconnect();
            await isolated?.cleanup();
            await rm(directory, { recursive: true, force: true });
          },
        };
      }

      it("drops the owner's question and expires approvals when the operator cancels", async () => {
        const f = await fixture();
        try {
          const before = await f.controller.readCoordinationInbox({ objectiveId: f.objective.id });
          expect(before.items.map((item) => item.kind).toSorted()).toEqual([
            "approval",
            "question",
          ]);
          expect(before.items.find((item) => item.kind === "question")).toMatchObject({
            objectiveId: f.objective.id,
            question: { text: "Raise the budget to 2000?" },
          });

          await f.store.cancelObjective(
            f.objective.id,
            { reason: "No longer needed" },
            { operatorId: "test-operator" },
          );

          const after = await f.controller.readCoordinationInbox({ objectiveId: f.objective.id });
          expect(after.items).toEqual([]);
          const [request] = await f.store.listApprovalRequests({ objectiveId: f.objective.id });
          expect(request).toMatchObject({
            id: f.approval.id,
            status: "expired",
            reason: "Objective cancelled",
          });
          expect((await f.store.getObjective(f.objective.id)).status).toBe("cancelled");
        } finally {
          await f.close();
        }
      });

      it("expires pending approvals when the Objective completes", async () => {
        const f = await fixture();
        try {
          const current = await f.store.getObjective(f.objective.id);
          await f.store.updateObjectiveStatus(f.objective.id, {
            expectedRevision: current.revision,
            status: "completed",
            completionSummary: "Repaired.",
          });

          const after = await f.controller.readCoordinationInbox({ objectiveId: f.objective.id });
          expect(after.items).toEqual([]);
          const [request] = await f.store.listApprovalRequests({ objectiveId: f.objective.id });
          expect(request).toMatchObject({ status: "expired", reason: "Objective completed" });
        } finally {
          await f.close();
        }
      });

      it("leaves decided approvals unchanged and drops a question a later turn replaced", async () => {
        const f = await fixture();
        try {
          await f.store.decideApprovalRequest({
            id: f.approval.id,
            decision: "deny",
            decidedBy: "test-operator",
            decidedByKind: "operator",
            reason: "Not now",
          });
          // The operator answered, so the Objective's next turn carries no question.
          await f.ownerTurn("Yes, raise it", { summary: "Budget raised." });
          const inbox = await f.controller.readCoordinationInbox({ objectiveId: f.objective.id });
          expect(inbox.items).toEqual([]);

          await f.store.cancelObjective(f.objective.id, {}, { operatorId: "test-operator" });
          const [request] = await f.store.listApprovalRequests({ objectiveId: f.objective.id });
          expect(request).toMatchObject({ status: "denied", reason: "Not now" });
        } finally {
          await f.close();
        }
      });
    },
  );
