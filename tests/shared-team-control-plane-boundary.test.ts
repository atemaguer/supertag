import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { startControlPlaneRuntime } from "../apps/cli/src/control-plane-runtime.js";
import {
  LocalWorklet,
  type TaskAttemptSpec,
  type Worker,
} from "../packages/runtime/sdk/src/index.js";
import {
  DrizzleStore,
  FileGatewayCredentialVault,
  migrateDatabase,
} from "../packages/store/src/index.js";
import { captureTestArtifact } from "./support/captured-artifact.js";
import { createIsolatedPostgresDatabase } from "./support/database.js";
import { connectDurableTestWorklet } from "./support/durable-test-connection.js";
import { enrollWorkerHost } from "./support/worker-host-enrollment.js";

const postgres = process.env["SUPERTAG_POSTGRES_URL"];
for (const dialect of ["sqlite", "postgresql"] as const) {
  describe.skipIf(dialect === "postgresql" && !postgres)(
    `${dialect} shared Team Control Plane boundary`,
    () => {
      it("authenticates independent priority and governance decisions and restricts accepted knowledge", async () => {
        const directory = await mkdtemp(join(tmpdir(), "supertag-shared-control-plane-"));
        const isolated =
          dialect === "postgresql" && postgres
            ? await createIsolatedPostgresDatabase(postgres)
            : undefined;
        const databaseUrl = isolated?.url ?? `file:${join(directory, "state.db")}`;
        let runtime: Awaited<ReturnType<typeof startControlPlaneRuntime>> | undefined;
        let connection: Awaited<ReturnType<typeof connectDurableTestWorklet>> | undefined;
        let store: DrizzleStore | undefined;
        let release = () => {};
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        const captured = new Map<string, TaskAttemptSpec>();
        const profile = { id: "boundary-manager", revision: "1" };
        const worker: Worker = {
          async describe() {
            return {
              profileCapabilities: [
                {
                  profile: profile,
                  capabilities: [{ id: "supertag.coordination", version: 1 }],
                  contextTypes: [],
                },
              ],
              id: "boundary-worker",
              type: "test",
              profiles: [profile],
              capabilities: [{ id: "supertag.coordination", version: 1 }],
              contextTypes: [],
              maxConcurrency: 3,
            };
          },
          async *execute(spec) {
            captured.set(spec.taskId, spec);
            yield {
              type: "execution.started",
              taskId: spec.taskId,
              attemptId: spec.attemptId,
              at: new Date().toISOString(),
              workerId: "boundary-worker",
            };
            await gate;
            yield {
              type: "output.message",
              taskId: spec.taskId,
              attemptId: spec.attemptId,
              at: new Date().toISOString(),
              message: { role: "teammate", text: "Coordination verified" },
            };
            yield {
              type: "execution.completed",
              taskId: spec.taskId,
              attemptId: spec.attemptId,
              at: new Date().toISOString(),
            };
          },
        };
        try {
          await migrateDatabase({ url: databaseUrl });
          store = new DrizzleStore({ url: databaseUrl });
          await store.connect();
          const sourceOwner = await store.createTag({ name: "Source owner" });
          const targetOwner = await store.createTag({ name: "Target owner" });
          const outsider = await store.createTag({ name: "Other owner" });
          const author = await store.createTag({ name: "Evidence author" });
          for (const tag of [sourceOwner, targetOwner, outsider, author])
            await store.bindTagWorkerHost(tag.id, "boundary-host");
          for (const [id, owner] of [
            ["source", sourceOwner],
            ["target", targetOwner],
            ["other", outsider],
          ] as const) {
            await store.createObjective({
              id,
              ownerTagId: owner.id,
              outcome: `Deliver ${id}`,
            });
          }
          const team = await store.createTeam({
            id: "shared",
            objectiveId: "source",
            objectiveIds: ["target"],
            name: "Shared Team",
            leadTagId: sourceOwner.id,
            memberTagIds: [targetOwner.id, author.id],
            maxConcurrency: 3,
          });
          await store.createTeam({
            id: "other",
            objectiveId: "other",
            name: "Other Team",
            leadTagId: outsider.id,
            memberTagIds: [],
            maxConcurrency: 1,
          });
          // Seed independently accepted evidence; every coordination action below crosses HTTP.
          await store.admitTaskAssignment({
            taskId: "evidence",
            objectiveId: "source",
            teamId: team.id,
            requestedByTagId: sourceOwner.id,
            assignedTagId: author.id,
            instruction: "PRIVATE evidence instructions",
            acceptanceCriteria: ["Reviewed"],
            execution: {},
            authorizationSnapshot: {
              version: 4,
              capturedAt: new Date().toISOString(),
              tag: { id: author.id, name: author.name },
              origin: { kind: "internal", objectiveId: "source", requestedByTagId: sourceOwner.id },
              requester: { id: sourceOwner.id, kind: "bot" },
              permissionSets: [],
              resources: [],
              runtimeActions: [],
            },
            contextPlan: { version: 7, capturedAt: new Date().toISOString(), sets: [] },
            workspacePlan: { version: 1, status: "none" },
          });
          const evidence = await store.claimTaskAssignment({
            taskId: "evidence",
            leaseOwner: "seed",
          });
          const evidenceAttempt = await store.createTaskAttempt({
            taskId: "evidence",
            attemptNumber: evidence?.attemptCount ?? 0,
            workerProfile: profile,
            workerSnapshot: {},
            startedAt: new Date().toISOString(),
          });
          const capturedArtifact = await captureTestArtifact(store, "evidence", {
            attempt: evidenceAttempt,
          });
          const digest = capturedArtifact.entries[0]?.digest;
          if (!digest) throw new Error("Missing captured digest");
          await store.settleTaskAssignment({
            taskId: "evidence",
            leaseOwner: "seed",
            attemptCount: evidence?.attemptCount ?? 0,
            terminalAttempt: { id: evidenceAttempt.id, status: "completed" },
            result: {
              taskResult: {
                privateTranscript: "PRIVATE transcript",
                artifacts: [{ artifactId: capturedArtifact.id, paths: ["output.json"] }],
              },
            },
          });
          await store.reviewTaskAssignment(
            "evidence",
            sourceOwner.id,
            true,
            "Independently reviewed",
          );
          runtime = await startControlPlaneRuntime({
            host: "127.0.0.1",
            port: 0,
            databaseUrl,
            workletTransport: "remote",
            adminToken: "boundary-admin",
            credentialVault: new FileGatewayCredentialVault(join(directory, "vault.json")),
          });
          const credential = await enrollWorkerHost(runtime.url, "boundary-admin", "boundary-host");
          connection = await connectDurableTestWorklet({
            url: `${runtime.url.replace(/^http/u, "ws")}/worklets`,
            credential,
            worklet: new LocalWorklet("boundary-worklet", "boundary-host", [worker]),
          });
          const admin = async (action: string, input: Record<string, unknown>) => {
            const response = await fetch(`${runtime?.url}/api/v1/coordination/${action}`, {
              method: "POST",
              headers: {
                authorization: "Bearer boundary-admin",
                "content-type": "application/json",
              },
              body: JSON.stringify(input),
            });
            const body = await response.json();
            expect(response.status, JSON.stringify(body)).toBe(200);
            return body;
          };
          for (const [id, owner] of [
            ["source", sourceOwner],
            ["target", targetOwner],
            ["other", outsider],
          ] as const) {
            await admin("assign_task", {
              objectiveId: id,
              taskId: `${id}-manager`,
              teamId: id === "other" ? "other" : team.id,
              assignedTagId: owner.id,
              instruction: "Coordinate across Team boundaries",
              acceptanceCriteria: ["Durable coordination"],
              execution: { profile },
            });
          }
          await expect.poll(() => captured.size, { timeout: 10_000 }).toBe(3);
          const call = async (
            actor: string,
            name: string,
            args: Record<string, unknown> = {},
            expectedError = false,
          ) => {
            const token = captured.get(`${actor}-manager`)?.coordination?.token;
            expect(token).toBeTruthy();
            const response = await fetch(`${runtime?.url}/internal/v1/coordination/mcp`, {
              method: "POST",
              headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
              body: JSON.stringify({
                jsonrpc: "2.0",
                id: 1,
                method: "tools/call",
                params: { name, arguments: args },
              }),
            });
            const body = await response.json();
            if (expectedError) {
              expect(
                response.status >= 400 || Boolean(body.error) || body.result?.isError === true,
                JSON.stringify(body),
              ).toBe(true);
              return undefined;
            }
            expect(response.status, JSON.stringify(body)).toBe(200);
            expect(body.error, JSON.stringify(body)).toBeUndefined();
            expect(body.result?.isError, JSON.stringify(body)).not.toBe(true);
            return JSON.parse(
              body.result.content.find((item: { type: string }) => item.type === "text").text,
            );
          };
          await admin("assign_task", {
            objectiveId: "target",
            taskId: "urgent-work",
            teamId: team.id,
            assignedTagId: author.id,
            instruction: "Urgent delivery",
            acceptanceCriteria: ["Accepted"],
            requiresApproval: true,
          });
          expect(await store.getTaskAssignment("urgent-work")).toMatchObject({
            priority: "normal",
          });
          await store.setTagMessagingGrant({
            senderTagId: targetOwner.id,
            recipientTagId: sourceOwner.id,
            messageTypes: ["message"],
          });
          const request = await call("target", "send_message", {
            recipientTeamId: team.id,
            type: "message",
            body: {
              request: "Prioritize urgent-work",
              rationale: "Customer deadline",
            },
            idempotencyKey: "urgent-work-priority",
          });
          expect(request.message.recipientTeamId).toBe(team.id);
          expect((await call("target", "read_mailbox")).messages).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                id: request.message.id,
                body: expect.objectContaining({ request: "Prioritize urgent-work" }),
              }),
            ]),
          );
          await call("target", "update_task", {
            taskId: "urgent-work",
            expectedStatus: "queued",
            priority: "urgent",
          });
          expect(await store.getTaskAssignment("urgent-work")).toMatchObject({
            priority: "urgent",
          });
          const currentTeam = await call("source", "read_team", {
            teamId: team.id,
          });
          await call("source", "update_team", {
            teamId: team.id,
            expectedRevision: currentTeam.revision,
            context: {
              runbook: {
                summary: "Reuse the independently accepted evidence artifact",
                references: [`supertag-artifact:${digest}`],
              },
            },
          });
          const context = await call("target", "read_team", { teamId: team.id });
          expect(context.context).toEqual({
            runbook: {
              summary: "Reuse the independently accepted evidence artifact",
              references: [`supertag-artifact:${digest}`],
            },
          });
          expect(context.tasks).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                taskId: "evidence",
                objectiveId: "source",
                teamId: team.id,
                assignedTagId: author.id,
                status: "accepted",
              }),
              expect.objectContaining({
                taskId: "urgent-work",
                objectiveId: "target",
                teamId: team.id,
                status: "queued",
              }),
            ]),
          );
          expect(
            context.tasks.some((task: { taskId: string }) => task.taskId === "other-manager"),
          ).toBe(false);
          const foreignEvidence = context.tasks.find(
            (task: { taskId: string }) => task.taskId === "evidence",
          );
          expect(foreignEvidence).not.toHaveProperty("instruction");
          expect(foreignEvidence).not.toHaveProperty("acceptanceCriteria");
          expect(foreignEvidence).not.toHaveProperty("result");
          expect(foreignEvidence).not.toHaveProperty("waitState");
          expect(foreignEvidence).not.toHaveProperty("leaseOwner");
          expect(foreignEvidence).not.toHaveProperty("approval");
          expect(foreignEvidence).not.toHaveProperty("chargedMinor");
          expect(
            context.tasks.find((task: { taskId: string }) => task.taskId === "urgent-work"),
          ).toHaveProperty("instruction", "Urgent delivery");
          expect(JSON.stringify(context)).not.toContain("PRIVATE");
          await call("target", "read_task", { taskId: "evidence" }, true);
          await call(
            "target",
            "update_task",
            { taskId: "evidence", expectedStatus: "accepted", priority: "urgent" },
            true,
          );
          expect(await store.getTaskAssignment("evidence")).toMatchObject({
            status: "accepted",
            priority: "normal",
          });
          await call(
            "other",
            "read_team",
            {
              teamId: team.id,
            },
            true,
          );
          await call("target", "send_message", {
            recipientTeamId: team.id,
            type: "message",
            body: { request: "Transfer Team governance to target" },
            idempotencyKey: "governance-request",
          });
          const beforeTransfer = await call("source", "read_team", {
            teamId: team.id,
          });
          await call(
            "target",
            "update_team",
            {
              teamId: team.id,
              expectedRevision: beforeTransfer.revision,
              governingObjectiveId: "target",
            },
            true,
          );
          await call("source", "update_team", {
            teamId: team.id,
            expectedRevision: beforeTransfer.revision,
            governingObjectiveId: "target",
          });
          await call(
            "source",
            "update_team",
            {
              teamId: team.id,
              expectedRevision: beforeTransfer.revision,
              governingObjectiveId: "source",
            },
            true,
          );
          expect(await store.getTeam(team.id)).toMatchObject({
            objectiveId: "target",
            context: context.context,
          });
          await call(
            "source",
            "update_team",
            {
              teamId: team.id,
              expectedRevision: (await store.getTeam(team.id)).revision,
              governingObjectiveId: "source",
            },
            true,
          );
          await store.cancelTaskAssignment("other-manager", outsider.id);
          await call("other", "read_team", {}, true);
        } finally {
          release();
          await connection?.stop();
          await runtime?.close();
          await store?.disconnect();
          await isolated?.cleanup();
          await rm(directory, { recursive: true, force: true });
        }
      }, 30_000);
    },
  );
}
