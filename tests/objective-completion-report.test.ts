import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ControlPlane } from "../packages/control-plane/src/index.ts";
import { objectiveReportKey } from "../packages/control-plane/src/outbound-presentation.ts";
import type { Objective } from "../packages/core/src/index.ts";
import {
  DrizzleStore,
  FileGatewayCredentialVault,
  migrateDatabase,
} from "../packages/store/src/index.ts";
import { createIsolatedPostgresDatabase } from "./support/database.ts";

const postgres = process.env["SUPERTAG_POSTGRES_URL"];

for (const dialect of ["sqlite", "postgresql"] as const) {
  describe.skipIf(dialect === "postgresql" && !postgres)(
    `${dialect} Objective completion report`,
    { timeout: 30_000 },
    () => {
      const cleanups: Array<() => Promise<unknown> | unknown> = [];
      afterEach(async () => {
        for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
      });

      async function fixture() {
        const directory = await mkdtemp(join(tmpdir(), "supertag-completion-"));
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
        const replies: string[] = [];
        const controlPlane = new ControlPlane({
          store: new DrizzleStore({ url }),
          credentialVault: new FileGatewayCredentialVault(join(directory, "vault.json")),
          worklet: {
            id: "empty-host",
            describe: async () => ({
              id: "empty-host",
              protocolVersion: 1,
              host: { id: "unused-host", workers: [] },
            }),
            selectExecution: async () => undefined,
            execute: vi.fn(() => {
              throw new Error("No model may execute");
            }),
          },
          reply: async (_route, reply) => {
            replies.push(reply.markdown);
          },
          dispatch: { pollIntervalMs: 10, retryBaseMs: 1000, maxAttempts: 3 },
        });
        await controlPlane.start();
        cleanups.push(() => controlPlane.stop());
        const account = await controlPlane.setupSurfaceAccount({
          provider: "slack",
          externalAccountId: "T-DONE",
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
          eventId: "home-thread",
          logicalEventId: "home-thread",
          provider: "slack",
          externalAccountId: "T-DONE",
          kind: "mention",
          scope: "channel:C1",
          sessionKey: "slack:T-DONE:C1:1.000",
          actor: { id: "U1", kind: "user" },
          text: "Ship the release",
          occurredAt: new Date().toISOString(),
          callback: {
            provider: "slack",
            mode: "slack_thread",
            threadKey: "T-DONE|C1|1.000",
            target: { channelId: "C1", threadTs: "1.000" },
          },
          source: {},
          metadata: {},
        });
        if (!admission.taskId) throw new Error("Missing verified surface Task");
        const anchor = await store.getVerifiedSurfaceTask(admission.taskId);
        if (!anchor?.inboundEventId) throw new Error("Missing verified route");
        const inboundEventId = anchor.inboundEventId;
        /** Completes an Objective the way an operator approves a submitted result. */
        const complete = async (objective: Objective, summary: string) => {
          await store.updateObjectiveStatus(
            objective.id,
            {
              status: "ready_for_review",
              expectedRevision: (await store.getObjective(objective.id)).revision,
              completionSummary: summary,
            },
            owner.id,
          );
          return controlPlane.objectives.approveObjective({ objectiveId: objective.id });
        };
        const settle = (objective: Objective) =>
          (
            controlPlane.objectives as unknown as {
              settleCompletedObjective(
                objective: Objective,
                options: { readonly report: boolean },
              ): Promise<void>;
            }
          ).settleCompletedObjective(objective, { report: true });
        const completionReplies = () => replies.filter((text) => text.includes("is completed"));
        return {
          controlPlane,
          store,
          owner,
          homeTaskId: admission.taskId,
          inboundEventId,
          complete,
          settle,
          completionReplies,
        };
      }

      it("posts the completion summary once to the home Session's thread", async () => {
        const f = await fixture();
        const objective = await f.store.createObjective({
          id: randomUUID(),
          ownerTagId: f.owner.id,
          outcome: "Ship the release",
          notificationTaskId: f.homeTaskId,
        });
        const summary = `Released 1.0. ${"x".repeat(2000)}`;
        const completed = await f.complete(objective, summary);
        expect(completed.status).toBe("completed");
        const key = objectiveReportKey(objective.id, `objective-completed:${completed.revision}`);
        const outbound = await f.store.findOutboundReply(f.inboundEventId, key);
        expect(outbound).toMatchObject({ presentation: "status", deliveryKey: key });
        expect(outbound?.text).toContain(`Objective ${objective.id} is completed: Released 1.0.`);
        // The summary is bounded.
        expect(outbound?.text.length).toBeLessThan(1600);
        expect(outbound?.text.endsWith("…")).toBe(true);
        await expect.poll(() => f.completionReplies().length, { timeout: 5000 }).toBe(1);

        // Settling the same completion again, as a retry would, posts nothing more.
        await f.settle(completed);
        await f.settle(await f.store.getObjective(objective.id));
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(f.completionReplies()).toHaveLength(1);
        expect(await f.store.findOutboundReply(f.inboundEventId, key)).toMatchObject({
          id: outbound?.id,
        });
      });

      it("posts nothing more when an operator updates a completed Objective", async () => {
        const f = await fixture();
        const objective = await f.store.createObjective({
          id: randomUUID(),
          ownerTagId: f.owner.id,
          outcome: "Ship the release",
          notificationTaskId: f.homeTaskId,
        });
        const completed = await f.complete(objective, "Released");
        await expect.poll(() => f.completionReplies().length, { timeout: 5000 }).toBe(1);

        const updated = (await f.controlPlane.objectives.command("update_objective", {
          objectiveId: objective.id,
          expectedRevision: completed.revision,
          runtimeActions: [],
        })) as Objective;
        expect(updated.status).toBe("completed");
        expect(updated.revision).toBeGreaterThan(completed.revision);
        const again = (await f.controlPlane.objectives.command("update_objective", {
          objectiveId: objective.id,
          expectedRevision: updated.revision,
          status: "completed",
          completionSummary: "Released again",
        })) as Objective;
        expect(again.status).toBe("completed");
        await new Promise((resolve) => setTimeout(resolve, 200));
        expect(f.completionReplies()).toHaveLength(1);
      });

      it("completes an Objective that has no reporting destination", async () => {
        const f = await fixture();
        const objective = await f.store.createObjective({
          id: randomUUID(),
          ownerTagId: f.owner.id,
          outcome: "Tidy the backlog",
        });
        const completed = await f.complete(objective, "Backlog tidied");
        expect(completed.status).toBe("completed");
        expect((await f.store.getObjective(objective.id)).status).toBe("completed");
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(f.completionReplies()).toEqual([]);
      });
    },
  );
}
