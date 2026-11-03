import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { startControlPlaneRuntime } from "../apps/cli/src/control-plane-runtime.ts";
import { ControlPlane } from "../packages/control-plane/src/index.ts";
import {
  createWorker,
  ExecutionBudgetExceededError,
  type Harness,
  LocalExecutionEnvironmentProvider,
  LocalWorklet,
  type SessionStateRef,
} from "../packages/runtime/sdk/src/index.ts";
import {
  DrizzleStore,
  FileGatewayCredentialVault,
  migrateDatabase,
} from "../packages/store/src/index.ts";
import { createIsolatedPostgresDatabase } from "./support/database.ts";
import { durableTestWorklet } from "./support/durable-test-worklet.js";

const postgres = process.env["SUPERTAG_POSTGRES_URL"];
for (const dialect of ["sqlite", "postgresql"] as const) {
  it.skipIf(dialect === "postgresql" && !postgres)(
    `${dialect} resumes an exhausted Worker only after authenticated inbox allocation approval`,
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "supertag-budget-e2e-"));
      const isolated =
        dialect === "postgresql" && postgres
          ? await createIsolatedPostgresDatabase(postgres)
          : undefined;
      const url = isolated?.url ?? `file:${join(directory, "state.db")}`;
      await migrateDatabase({ url });
      const store = new DrizzleStore({ url });
      await store.connect();
      const vault = new FileGatewayCredentialVault(join(directory, "vault.json"));
      let runtime: Awaited<ReturnType<typeof startControlPlaneRuntime>> | undefined;
      let bootstrap: ControlPlane | undefined;
      const executions: Array<{ taskId: string; sessionId?: string; limit?: number }> = [];
      let archived: SessionStateRef | undefined;
      let notices = 0;
      const harness: Harness = {
        id: "budget-fixture",
        describe: async () => ({
          sessions: { resume: true, export: true, scope: "local" as const },
          id: "budget-fixture",
          version: "1",
          inputKinds: ["instruction", "history", "tool"],
          streaming: false,
          cancellation: true,
          sessionPersistence: "native",
          toolIsolation: { managerOnly: true, schemaIsolation: "hard" },
          executionLimits: {
            maxReportedTokens: { minimum: 1, maximum: 10000, enforcement: "interrupt-on-report" },
          },
        }),
        plan: async () => {
          const environment = {
            files: [],
            mounts: [],
            environmentVariables: {},
            secretBindings: [],
            network: { mode: "none" as const },
          };
          return { runtime: environment, execution: environment };
        },
        start: async (_plan, _environment, input) => {
          const limit = input.attempt.execution.limits?.maxReportedTokens;
          executions.push({
            taskId: input.attempt.taskId,
            ...(input.continuity ? { sessionId: input.continuity.sessionId } : {}),
            ...(limit ? { limit } : {}),
          });
          const current = executions.length;
          let saved: SessionStateRef | undefined;
          return {
            appliedLimits: {
              maxReportedTokens: { limit: limit ?? 0, method: "interrupt-on-report" },
            },
            async *run() {
              if (current === 1) {
                expect(input.continuity?.priorSessionState).toBeUndefined();
                archived = {
                  id: randomUUID(),
                  format: "budget-fixture-v1",
                  uri: `supertag://sessionStates/${randomUUID()}`,
                };
                await input.sessionStateStore.save({
                  ref: archived,
                  harnessId: "budget-fixture",
                  data: {
                    completed: "verified intermediate result",
                    nativeId: "same-native-session",
                  },
                });
                saved = archived;
                yield {
                  type: "usage.updated" as const,
                  usage: {
                    inputTokens: 1000,
                    cachedInputTokens: 0,
                    outputTokens: 0,
                    totalTokens: 1000,
                    complete: true,
                  },
                };
                throw new ExecutionBudgetExceededError("Initial allocation exhausted");
              }
              expect(current).toBe(2);
              expect(limit).toBe(2000);
              expect(input.continuity?.priorSessionState).toEqual(archived);
              const recovered = await input.sessionStateStore.load(
                input.continuity?.priorSessionState as SessionStateRef,
              );
              expect(recovered?.data).toEqual({
                completed: "verified intermediate result",
                nativeId: "same-native-session",
              });
              yield {
                type: "usage.updated" as const,
                usage: {
                  inputTokens: 1200,
                  cachedInputTokens: 0,
                  outputTokens: 20,
                  totalTokens: 1220,
                  complete: true,
                },
              };
              yield {
                type: "output.message" as const,
                text: "Completed using verified intermediate result",
              };
            },
            sessionState: async () => saved,
            close: async () => {},
          };
        },
      };
      try {
        bootstrap = new ControlPlane({ store: new DrizzleStore({ url }), credentialVault: vault });
        await bootstrap.start();
        const account = await bootstrap.setupSurfaceAccount({
          provider: "slack",
          externalAccountId: "T-E2E",
          displayName: "Budget operator",
          authMethod: "slack-socket-mode",
          configuration: { transport: "socket" },
          secrets: { botToken: "xoxb-test", appToken: "xapp-test" },
        });
        const owner = await store.createTag({ name: `owner-${randomUUID()}` });
        await store.bindTagWorkerHost(owner.id, "unavailable-anchor-host");
        await store.addTagRoute({
          tagId: owner.id,
          surfaceAccountId: account.id,
          scope: "channel:C1",
        });
        const anchor = await bootstrap.ingestSurfaceEvent({
          eventId: "anchor",
          logicalEventId: "anchor",
          provider: "slack",
          externalAccountId: "T-E2E",
          kind: "mention",
          scope: "channel:C1",
          sessionKey: "slack:T-E2E:C1:1",
          actor: { id: "U1", kind: "user" },
          text: "Operator inbox",
          occurredAt: new Date().toISOString(),
          callback: {
            provider: "slack",
            mode: "slack_thread",
            threadKey: "T-E2E|C1|1",
            target: { channelId: "C1", threadTs: "1" },
          },
          source: {},
          metadata: {},
        });
        if (!anchor.taskId) throw new Error("Missing destination");
        await bootstrap.stop();
        bootstrap = undefined;
        // Ingress was injected above; do not open a real Slack socket in this fixture.
        await store.saveSurfaceAccount({ ...account, authMethod: "fixture-manual-ingress" });
        const workerTag = await store.createTag({ name: `worker-${randomUUID()}` });
        await store.bindTagWorkerHost(workerTag.id, "budget-host");
        const objective = await store.createObjective({
          id: randomUUID(),
          ownerTagId: owner.id,
          outcome: "Finish admitted work",
          notificationTaskId: anchor.taskId,
        });
        const team = await store.createTeam({
          id: randomUUID(),
          objectiveId: objective.id,
          name: "Delivery",
          leadTagId: owner.id,
          memberTagIds: [workerTag.id],
          maxConcurrency: 1,
        });
        const worker = createWorker({
          id: "budget-worker",
          profiles: [
            {
              ref: { id: "budget-profile", revision: "1" },
              workerType: "supertag",
              harness: { provider: "budget-fixture" },
              execution: { provider: "local-execution", lifetime: { scope: "attempt" } },
            },
          ],
          harnesses: [harness],
          environments: [new LocalExecutionEnvironmentProvider()],
        });
        runtime = await startControlPlaneRuntime({
          host: "127.0.0.1",
          port: 0,
          databaseUrl: url,
          credentialVault: vault,
          adminToken: "e2e-admin",
          worklet: durableTestWorklet(new LocalWorklet("budget-worklet", "budget-host", [worker])),
          reply: async (_route, reply) => {
            if (reply.markdown.includes("Budget decision required")) notices++;
          },
        });
        const command = async (tool: string, args: unknown, authenticated = true) =>
          fetch(`${runtime?.url}/api/v1/coordination/${tool}`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              ...(authenticated ? { authorization: "Bearer e2e-admin" } : {}),
            },
            body: JSON.stringify(args),
          });
        const readInbox = () =>
          fetch(
            `${runtime?.url}/api/v1/coordination/inbox?objectiveId=${objective.id}&kind=task_budget`,
            { headers: { authorization: "Bearer e2e-admin" } },
          );
        const taskId = randomUUID();
        const admitted = await command("assign_task", {
          objectiveId: objective.id,
          taskId,
          teamId: team.id,
          assignedTagId: workerTag.id,
          instruction: "Finish work and preserve progress",
          acceptanceCriteria: ["Final result"],
          execution: { limits: { maxReportedTokens: 1000 } },
        });
        expect(admitted.status, await admitted.text()).toBe(200);
        await expect
          .poll(async () => (await store.getTaskAssignment(taskId))?.status, { timeout: 10000 })
          .toBe("failed");
        await expect.poll(() => notices, { timeout: 5000 }).toBe(1);
        const inboxResponse = await readInbox();
        expect(inboxResponse.status).toBe(200);
        const inbox = await inboxResponse.json();
        const item = inbox.items.find(
          (candidate: { kind: string }) => candidate.kind === "task_budget",
        );
        expect(item).toBeDefined();
        const action = item.permittedActions[0];
        expect(action.requiredInputFields).toContain("executionLimits");
        const approval = { ...action.arguments, executionLimits: { maxReportedTokens: 2000 } };
        expect((await command(action.tool, approval, false)).status).toBe(401);
        expect((await store.getTaskAssignment(taskId))?.status).toBe("failed");
        expect(executions).toHaveLength(1);
        const persistedTask = await store.findTaskById(taskId);
        const states = await store.listSessionStates({
          sessionId: persistedTask?.sessionId as string,
          taskId,
        });
        expect(states).toEqual(
          expect.arrayContaining([expect.objectContaining({ status: "resumable" })]),
        );
        const approved = await command(action.tool, approval);
        expect(approved.status, await approved.text()).toBe(200);
        await expect
          .poll(async () => (await store.getTaskAssignment(taskId))?.status, { timeout: 10000 })
          .toBe("submitted");
        expect(executions).toHaveLength(2);
        expect(executions[0]?.sessionId).toEqual(expect.any(String));
        expect(executions[1]).toEqual({ taskId, sessionId: executions[0]?.sessionId, limit: 2000 });
        expect(JSON.stringify((await store.getTaskAssignment(taskId))?.result)).toContain(
          "Completed using verified intermediate result",
        );
        expect((await store.listTaskAttempts(taskId)).map((attempt) => attempt.status)).toEqual([
          "failed",
          "completed",
        ]);
        expect(
          (await store.listTaskEvents(taskId)).filter(
            (event) => event.type === "task.budget-renewed",
          ),
        ).toHaveLength(1);
        const finalInbox = await (await readInbox()).json();
        expect(finalInbox.items).toHaveLength(0);
        expect(notices).toBe(1);
      } finally {
        await bootstrap?.stop();
        await runtime?.close();
        await store.disconnect();
        await isolated?.cleanup();
        await rm(directory, { recursive: true, force: true });
      }
    },
    30000,
  );
}
