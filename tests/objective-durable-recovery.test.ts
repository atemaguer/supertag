import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { startControlPlaneRuntime } from "../apps/cli/src/control-plane-runtime.js";
import { SessionContinuity } from "../packages/control-plane/src/session-continuity.js";
import { emptyTagContextPlan } from "../packages/core/src/index.js";
import {
  DurableLocalWorklet,
  defaultTaskResult,
  FileAttemptJournal,
  LocalWorklet,
  type TaskAttemptSpec,
  type Worker,
} from "../packages/runtime/sdk/src/index.js";
import { connectWorklet } from "../packages/runtime/transport/src/index.js";
import {
  DrizzleStore,
  FileGatewayCredentialVault,
  migrateDatabase,
} from "../packages/store/src/index.js";
import { captureTestArtifact } from "./support/captured-artifact.js";
import { enrollWorkerHost } from "./support/worker-host-enrollment.js";

const PostgresqlPool = createRequire(new URL("../packages/store/package.json", import.meta.url))(
  "pg",
).Pool as new (options: {
  connectionString: string;
  max: number;
}) => {
  query(text: string): Promise<unknown>;
  end(): Promise<void>;
};

for (const dialect of ["sqlite", "postgresql"] as const)
  for (const scenario of [
    "valid",
    "cancelled-accounting",
    "revoked",
    "invalid-artifact",
    "storage-outage",
    "budget-exhausted",
  ] as const)
    it.skipIf(dialect === "postgresql" && !process.env["SUPERTAG_POSTGRES_URL"])(
      `${dialect}: ${scenario === "cancelled-accounting" ? "replays only final accounting after administrative cancellation and restart" : scenario === "budget-exhausted" ? "settles recovered budget exhaustion without retrying or allocating more" : scenario === "revoked" ? "cancels recovered execution after its Objective deadline" : scenario === "invalid-artifact" ? "fails a recovered completed journal with invalid artifacts without reexecution" : scenario === "storage-outage" ? "retries transient settlement failure without reexecuting completed work" : "reconciles an accepted journal without changing its spec or charging twice"}`,
      async () => {
        const revoked = scenario === "revoked";
        const invalidArtifact = scenario === "invalid-artifact";
        const directory = await mkdtemp(join(tmpdir(), "supertag-recovery-"));
        let url = `file:${join(directory, "state.db")}`;
        let dropDatabase = async () => {};
        if (dialect === "postgresql") {
          const postgres = process.env["SUPERTAG_POSTGRES_URL"];
          if (!postgres) throw new Error("Missing database");
          const name = `supertag_recovery_${randomUUID().replaceAll("-", "")}`;
          const admin = new PostgresqlPool({ connectionString: postgres, max: 1 });
          try {
            await admin.query(`CREATE DATABASE "${name}"`);
          } finally {
            await admin.end();
          }
          const isolated = new URL(postgres);
          isolated.pathname = `/${name}`;
          url = isolated.toString();
          dropDatabase = async () => {
            const admin = new PostgresqlPool({ connectionString: postgres, max: 1 });
            try {
              await admin.query(`DROP DATABASE "${name}"`);
            } finally {
              await admin.end();
            }
          };
        }
        await migrateDatabase({ url });
        const store = new DrizzleStore({ url });
        await store.connect();
        const id = randomUUID();
        const profile = { id: `recovery-${id}`, revision: "1" };
        const owner = await store.createTag({ name: id });
        await store.createObjective({
          id,
          ownerTagId: owner.id,
          outcome: "Recover implementation evidence",
          budgetLimitMinor: 100,
          ...(revoked ? { deadline: new Date(Date.now() + 3000).toISOString() } : {}),
        });
        await store.createTeam({
          id,
          objectiveId: id,
          leadTagId: owner.id,
          memberTagIds: [],
          maxConcurrency: 1,
          name: id,
        });
        const at = new Date().toISOString();
        const admitted = await store.admitTaskAssignment({
          taskId: id,
          objectiveId: id,
          teamId: id,
          requestedByTagId: owner.id,
          assignedTagId: owner.id,
          instruction: "Implement the deterministic module",
          acceptanceCriteria: ["Artifact produced"],
          maxCostMinor: 7,
          execution: { profile: profile },
          authorizationSnapshot: {
            version: 4,
            capturedAt: at,
            tag: { id: owner.id, name: owner.name },
            origin: { kind: "internal", objectiveId: id, requestedByTagId: owner.id },
            requester: { id: owner.id, kind: "user" },
            permissionSets: [],
            resources: [],
            runtimeActions: [],
          },
          contextPlan: emptyTagContextPlan(at),
          workspacePlan: { version: 1, status: "none" },
        });
        const claimed = await store.claimTaskAssignment({
          taskId: id,
          leaseOwner: "lost-control-plane",
          // Long enough to outlast setup on a loaded runner; the clock is advanced past it below.
          leaseSeconds: 60,
        });
        if (!claimed) throw new Error("Missing claim");
        const attempt = await store.createTaskAttempt({
          workerProfile: { id: "default", revision: "1" },
          taskId: id,
          attemptNumber: 1,
          workerSnapshot: { durableExecution: true, kind: "assignment" },
          startedAt: at,
        });
        let release = () => {};
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        const captured = await captureTestArtifact(store, id, { attempt });
        const result = {
          ...defaultTaskResult("Implementation evidence"),
          artifacts: [
            {
              artifactId: invalidArtifact ? "not-a-captured-artifact" : captured.id,
              paths: ["output.json"],
            },
          ],
          references: [
            {
              provider: "github" as const,
              resourceType: "file" as const,
              reference: "implementation.ts",
              relationship: "produced" as const,
            },
          ],
        };
        const run = vi.fn();
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
              id: "recovery-worker",
              type: "test",
              profiles: [profile],
              contextTypes: [],
              capabilities: [{ id: "supertag.coordination", version: 1 }],
              maxConcurrency: 1,
            };
          },
          async *execute(spec) {
            run(spec.attemptId);
            const identity = { taskId: spec.taskId, attemptId: spec.attemptId, at };
            yield { ...identity, type: "execution.started", workerId: "recovery-worker" };
            await gate;
            if (scenario === "cancelled-accounting") {
              yield {
                ...identity,
                type: "output.message",
                message: { role: "teammate", text: "Do not publish late output" },
              };
              yield {
                ...identity,
                type: "usage.updated",
                usage: {
                  inputTokens: 12,
                  outputTokens: 4,
                  cachedInputTokens: 3,
                  totalTokens: 19,
                  complete: true,
                  reportedCost: { amountMinor: 2, currency: "USD" },
                },
              };
              yield { ...identity, type: "execution.completed" };
              return;
            }
            if (scenario === "budget-exhausted") {
              const ref = { id: `native-${id}`, format: "native-v1", uri: "supertag:session" };
              await store.putSessionState({
                taskId: id,
                attemptId: spec.attemptId,
                harnessId: "test",
                ref,
                data: { nativeId: "durable-budget-conversation" },
              });
              yield { ...identity, type: "session.updated", sessionState: ref };
              yield {
                ...identity,
                type: "execution.failed",
                error: {
                  name: "ExecutionBudgetExceededError",
                  message: "Reported token budget exhausted",
                },
              };
              return;
            }
            yield {
              ...identity,
              type: "output.message",
              message: { role: "teammate", text: "Implementation evidence" },
            };
            yield { ...identity, type: "result", result };
            yield { ...identity, type: "execution.completed" };
          },
        };
        const local = new LocalWorklet(`host-${id}`, `host-${id}`, [worker]);
        const durable = new DurableLocalWorklet(
          local,
          new FileAttemptJournal(join(directory, "journal")),
        );
        const accept = vi.spyOn(durable, "accept");
        const canonical = await store.findTaskById(id);
        if (!canonical) throw new Error("Missing Task");
        const spec: TaskAttemptSpec = {
          execution: {},
          version: 1,
          taskId: id,
          attemptId: attempt.id,
          tag: { id: owner.id, name: owner.name },
          workerProfile: profile,
          authorization: canonical.authorizationSnapshot,
          contextPlan: canonical.contextPlan,
          workspacePlan: canonical.workspacePlan,
          input: {
            origin: {
              // Recovery observes the accepted spec without admitting another execution.
              surface: "supertag.coordination",
              accountId: id,
              scope: id,
              sessionKey: canonical.sessionId,
              occurredAt: at,
            },
            messages: [{ id, role: "requester", text: admitted.instruction }],
          },
        };
        let runtime: Awaited<ReturnType<typeof startControlPlaneRuntime>> | undefined;
        let connection: Awaited<ReturnType<typeof connectWorklet>> | undefined;
        let credential: string | undefined;
        try {
          await durable.accept(spec);
          const observer = durable.events(attempt.id)[Symbol.asyncIterator]();
          const first = await observer.next();
          if (!first.value) throw new Error("Missing started event");
          await store.appendTaskAssignmentJournalEvent({
            taskId: id,
            attemptId: attempt.id,
            leaseOwner: "lost-control-plane",
            attemptCount: 1,
            sequence: first.value.sequence,
            type: first.value.event.type,
            payload: { ...first.value.event },
          });
          const replay = await store.appendTaskAssignmentJournalEvent({
            taskId: id,
            attemptId: attempt.id,
            leaseOwner: "lost-control-plane",
            attemptCount: 1,
            sequence: first.value.sequence,
            type: first.value.event.type,
            payload: { ...first.value.event },
          });
          expect(
            (await store.listTaskEvents(id)).filter((event) => event.id === replay.id),
          ).toHaveLength(1);
          await observer.return?.();
          if (revoked) {
            // Running Task Attempts keep authority for a grace period after the deadline.
            // Move the deadline past that grace period so recovery must cancel.
            const objective = await store.getObjective(id);
            await store.updateObjectiveStatus(
              id,
              {
                deadline: new Date(Date.now() - 16 * 60_000).toISOString(),
                expectedRevision: objective.revision,
              },
              undefined,
              undefined,
              { operatorId: "test" },
            );
          }
          // The lost Control Plane's lease expires before the new one starts.
          vi.useFakeTimers({ toFake: ["Date"] });
          vi.setSystemTime(Date.now() + 61_000);
          runtime = await startControlPlaneRuntime({
            host: "127.0.0.1",
            port: 0,
            databaseUrl: url,
            workletTransport: "remote",
            adminToken: "test-admin",
            credentialVault: new FileGatewayCredentialVault(join(directory, "vault")),
          });
          credential = await enrollWorkerHost(runtime.url, "test-admin", `host-${id}`);
          connection = await connectWorklet({
            url: `${runtime.url.replace(/^http/u, "ws")}/worklets`,
            credential,
            worklet: local,
            durableWorklet: durable,
          });
          if (scenario === "cancelled-accounting") {
            const response = await fetch(`${runtime.url}/api/v1/coordination/update_task`, {
              method: "POST",
              headers: { Authorization: "Bearer test-admin", "Content-Type": "application/json" },
              body: JSON.stringify({
                objectiveId: id,
                taskId: id,
                expectedStatus: "running",
                status: "cancelled",
              }),
            });
            expect(response.status, await response.text()).toBe(200);
            await expect
              .poll(async () => (await durable.inspect(attempt.id))?.cancellationRequested, {
                timeout: 12000,
              })
              .toBe(true);
            release();
            await expect
              .poll(async () => (await store.listTaskAttempts(id))[0]?.status, { timeout: 12000 })
              .toBe("cancelled");
            const events = await store.listTaskEvents(id);
            const usage = events.filter((e) => e.type === "usage.updated");
            expect(usage).toHaveLength(1);
            expect(usage[0]?.payload).toMatchObject({
              usage: {
                totalTokens: 19,
                complete: true,
                reportedCost: { amountMinor: 2, currency: "USD" },
              },
            });
            expect(
              events.some((e) => e.type === "output.message" || e.type === "execution.completed"),
            ).toBe(false);
            const port = Number(new URL(runtime.url).port);
            await runtime.close();
            runtime = await startControlPlaneRuntime({
              host: "127.0.0.1",
              port,
              databaseUrl: url,
              workletTransport: "remote",
              adminToken: "test-admin",
              credentialVault: new FileGatewayCredentialVault(join(directory, "vault")),
            });
            expect(
              (await store.listTaskEvents(id)).filter((e) => e.type === "usage.updated"),
            ).toEqual(usage);
            expect(run).toHaveBeenCalledOnce();
            return;
          }
          if (revoked) {
            await expect
              .poll(async () => (await durable.inspect(attempt.id))?.cancellationRequested, {
                timeout: 12000,
              })
              .toBe(true);
            expect(run).toHaveBeenCalledOnce();
            expect(accept).toHaveBeenCalledOnce();
            expect(await store.listTaskAttempts(id)).toHaveLength(1);
            return;
          }
          await expect
            .poll(async () => (await store.getTaskAssignment(id))?.leaseOwner, { timeout: 12000 })
            .not.toBe("lost-control-plane");
          await expect(
            store.appendTaskAssignmentJournalEvent({
              taskId: id,
              attemptId: attempt.id,
              leaseOwner: "lost-control-plane",
              attemptCount: 1,
              sequence: first.value.sequence,
              type: first.value.event.type,
              payload: { ...first.value.event },
            }),
          ).rejects.toMatchObject({ statusCode: 409 });
          // Closing a real Control Plane must detach the observer, not cancel work.
          const oldOwner = (await store.getTaskAssignment(id))?.leaseOwner;
          const port = Number(new URL(runtime.url).port);
          await runtime.close();
          expect(await durable.inspect(attempt.id)).toMatchObject({ status: "running" });
          expect((await durable.inspect(attempt.id))?.cancellationRequested).not.toBe(true);
          // Only the wall clock advances: the Worklet process and real socket reconnect.
          vi.useFakeTimers({ toFake: ["Date"] });
          vi.setSystemTime(Date.now() + 31_000);
          runtime = await startControlPlaneRuntime({
            host: "127.0.0.1",
            port,
            databaseUrl: url,
            workletTransport: "remote",
            adminToken: "test-admin",
            credentialVault: new FileGatewayCredentialVault(join(directory, "vault")),
          });
          if (revoked) {
            await expect
              .poll(async () => (await durable.inspect(attempt.id))?.cancellationRequested, {
                timeout: 12000,
              })
              .toBe(true);
            expect(run).toHaveBeenCalledOnce();
            expect(accept).toHaveBeenCalledOnce();
            expect(await store.listTaskAttempts(id)).toHaveLength(1);
            return;
          }
          await expect
            .poll(async () => (await store.getTaskAssignment(id))?.leaseOwner, { timeout: 12000 })
            .not.toBe(oldOwner);
          const settlement =
            scenario === "storage-outage"
              ? vi
                  .spyOn(DrizzleStore.prototype, "settleTaskAssignment")
                  .mockRejectedValueOnce(new Error("Temporary settlement storage outage"))
              : undefined;
          release();
          if (settlement) {
            await expect.poll(() => settlement.mock.calls.length).toBe(1);
            expect((await store.getTaskAssignment(id))?.status).toBe("running");
            expect((await store.listTaskAttempts(id))[0]?.status).toBe("running");
            vi.setSystemTime(Date.now() + 31_000);
          }
          await expect
            .poll(async () => (await store.getTaskAssignment(id))?.status, { timeout: 12000 })
            .toBe(invalidArtifact || scenario === "budget-exhausted" ? "failed" : "submitted");
          if (scenario === "budget-exhausted") {
            expect((await store.getTaskAssignment(id))?.result).toMatchObject({
              failureKind: "budget-exhausted",
              budgetExhaustion: { attemptId: attempt.id, requiresAuthorization: true },
            });
            expect(
              (await store.listTaskEvents(id)).filter(
                (event) => event.type === "task.budget-exhausted",
              ),
            ).toHaveLength(1);
            expect(await store.listTaskAttempts(id)).toHaveLength(1);
            expect(run).toHaveBeenCalledOnce();
            expect(accept).toHaveBeenCalledOnce();
            expect(
              (await store.listPendingTaskAssignments()).some((task) => task.taskId === id),
            ).toBe(false);
            const archive = await store.findSessionState(`native-${id}`);
            expect(archive).toMatchObject({
              status: "resumable",
              compatibility: expect.stringMatching(/^budget:/),
            });
            // Existing administrative update_task grants a new allocation; no failed
            // Worker credential is used and no automatic model invocation is needed.
            const renewed = await fetch(`${runtime.url}/api/v1/coordination/update_task`, {
              method: "POST",
              headers: { Authorization: "Bearer test-admin", "Content-Type": "application/json" },
              body: JSON.stringify({
                objectiveId: id,
                taskId: id,
                expectedStatus: "failed",
                status: "queued",
                executionLimits: { maxReportedTokens: 2000 },
              }),
            });
            expect(renewed.status, await renewed.text()).toBe(200);
            const renewedClaim = await store.claimTaskAssignment({
              taskId: id,
              leaseOwner: "renewed-observer",
            });
            expect(renewedClaim?.attemptCount).toBe(2);
            const nextAttempt = await store.createTaskAttempt({
              taskId: id,
              attemptNumber: 2,
              workerProfile: attempt.workerProfile,
              workerSnapshot: {},
              startedAt: new Date().toISOString(),
            });
            const renewedTask = await store.findTaskById(id);
            if (!renewedTask) throw new Error("Missing renewed Task");
            expect(
              await new SessionContinuity(store).readTask(renewedTask, nextAttempt.id),
            ).toMatchObject({ id: `native-${id}` });
            expect((await store.findSessionState(`native-${id}`))?.data).toEqual({
              nativeId: "durable-budget-conversation",
            });
            return;
          }
          expect(run).toHaveBeenCalledOnce();
          expect(accept).toHaveBeenCalledOnce();
          expect(await store.listTaskAttempts(id)).toEqual([
            expect.objectContaining({
              id: attempt.id,
              attemptNumber: 1,
              status: invalidArtifact ? "failed" : "completed",
              workerSnapshot: expect.objectContaining({
                workerHostId: `host-${id}`,
                workletId: `host-${id}`,
                workerId: "recovery-worker",
              }),
            }),
          ]);
          expect((await store.getTaskAssignment(id))?.result).toMatchObject(
            invalidArtifact
              ? {
                  error: "Submitted artifact must belong to this Task and Attempt",
                  failureKind: "invalid-artifact-result",
                }
              : {
                  text: "Implementation evidence",
                  taskResult: result,
                },
          );
          expect((await durable.inspect(attempt.id))?.status).toBe("completed");
          const journalEvents = (await store.listTaskEvents(id)).filter(
            (event) => event.payload?.["journalSequence"] !== undefined,
          );
          expect(journalEvents.map((event) => event.payload?.["journalSequence"])).toEqual([
            1, 2, 3, 4,
          ]);
          expect(await store.getObjective(id)).toMatchObject({ spentMinor: 7, reservedMinor: 0 });
        } finally {
          release();
          await connection?.stop();
          await runtime?.close();
          await durable.shutdown("Test cleanup");
          await store.disconnect();
          vi.useRealTimers();
          vi.restoreAllMocks();
          await dropDatabase();
          await rm(directory, { recursive: true, force: true });
        }
      },
      40000,
    );
