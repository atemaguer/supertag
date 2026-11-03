import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AdmitInboundEventInput, GatewayCredentialVault } from "@supertag/core";
import { afterEach, describe, expect, it } from "vitest";
import { ControlPlane } from "../packages/control-plane/src/index.js";
import type {
  DurableWorklet,
  TaskAttemptEvent,
  TaskAttemptSpec,
} from "../packages/runtime/sdk/src/index.js";
import { DrizzleStore, migrateDatabase } from "../packages/store/src/index.js";
import { createIsolatedPostgresDatabase } from "./support/database.js";

const postgres = process.env["SUPERTAG_POSTGRES_URL"];
const vault: GatewayCredentialVault = {
  async store() {},
  async resolve() {
    return undefined;
  },
  async delete() {},
};

for (const provider of ["sqlite", "postgresql"] as const) {
  describe.skipIf(provider === "postgresql" && !postgres)(
    `${provider} Task execution report`,
    () => {
      const cleanups: Array<() => Promise<void>> = [];
      afterEach(async () => {
        for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
      });

      it("replays placement, requested limits, applied limits, and usage after recovery", async () => {
        const directory = await mkdtemp(join(tmpdir(), "supertag-limit-report-"));
        const isolated =
          provider === "postgresql" && postgres
            ? await createIsolatedPostgresDatabase(postgres)
            : undefined;
        const url = isolated?.url ?? `file:${join(directory, "state.db")}`;
        await migrateDatabase({ url });
        let store = new DrizzleStore({ url });
        await store.connect();
        cleanups.push(async () => {
          await store.disconnect();
          await isolated?.cleanup();
          await rm(directory, { recursive: true, force: true });
        });
        const worker = await store.createTag({ name: `worker-${randomUUID()}` });
        const now = "2030-01-01T00:00:00.000Z";
        const account = await store.saveSurfaceAccount({
          provider: "slack",
          externalAccountId: randomUUID(),
          displayName: "Limit reporting",
          authMethod: "test",
          credentialId: "test",
          status: "connected",
          configuration: {},
          verifiedAt: now,
        });
        const route = await store.addTagRoute({
          tagId: worker.id,
          surfaceAccountId: account.id,
          scope: "channel:limits",
        });
        const execution = {
          limits: {
            maxNativeAgents: 2,
            maxReportedTokens: 100,
            maxReportedCost: { amountMinor: 500, currency: "USD" },
          },
        } as const;
        const admission: AdmitInboundEventInput = {
          surfaceAccountId: account.id,
          tagRouteId: route.id,
          tagId: worker.id,
          execution,
          authorization: {
            version: 5,
            capturedAt: now,
            tag: { id: worker.id, name: worker.name },
            origin: {
              surfaceAccountId: account.id,
              tagRouteId: route.id,
              provider: "slack",
              scope: "channel:limits",
            },
            requester: { id: "human", kind: "user" },
            permissionSets: [],
            resources: [],
            runtimeActions: [],
          },
          contextPlan: { version: 7, capturedAt: "2030-01-01T00:00:00.000Z", sets: [] },
          event: {
            eventId: randomUUID(),
            logicalEventId: randomUUID(),
            provider: "slack",
            externalAccountId: account.externalAccountId,
            kind: "message",
            scope: "channel:limits",
            sessionKey: "limits-thread",
            actor: { id: "human", kind: "user" },
            text: "Report limits",
            occurredAt: now,
            callback: {
              provider: "slack",
              mode: "slack_thread",
              threadKey: "limits-thread",
              target: { channelId: "limits", threadTs: "limits-thread" },
            },
            source: {},
            metadata: {},
          },
        };
        const admitted = await store.admitInboundEvent(admission);
        const session = await store.openSession({
          tagId: worker.id,
          sessionKey: admission.event.sessionKey,
          origin: {},
          at: now,
        });
        const task = await store.openTask({
          inboundEventId: admitted.work.id,
          tagId: worker.id,
          sessionId: session.id,
          execution,
          actor: admission.event.actor,
          trigger: {},
          workspacePlan: { version: 1, status: "none" },
          sessionHistory: [],
          authorizationSnapshot: admission.authorization,
          contextPlan: admission.contextPlan,
          createdAt: now,
        });
        const taskId = task.id;
        const attempt = await store.createTaskAttempt({
          taskId,
          attemptNumber: 1,
          workerProfile: { id: "limit-test", revision: "1" },
          workerSnapshot: { durableExecution: true },
          startedAt: "2030-01-01T00:00:01.000Z",
        });
        const identity = {
          taskId,
          attemptId: attempt.id,
          at: "2030-01-01T00:00:01.000Z",
        };
        const journal: readonly TaskAttemptEvent[] = [
          { type: "execution.started", ...identity, workerId: "limit-test" },
          {
            type: "execution.limits.applied",
            ...identity,
            requested: execution.limits,
            applied: {
              maxNativeAgents: { limit: 2, method: "provider-native" },
              maxReportedTokens: { limit: 100, method: "interrupt-on-report" },
              maxReportedCost: {
                limit: { amountMinor: 500, currency: "USD" },
                method: "provider-budget",
              },
            },
          },
          {
            type: "runtime-inputs.resolved",
            ...identity,
            manifest: {
              workerProfile: { id: "limit-test", revision: "1" },
              harness: {
                id: "codex",
                version: "0.42.0",
                provenance: {
                  protocol: "codex-exec-server",
                  protocolVersion: 1,
                  mcpClients: [
                    {
                      client: "execution-environment",
                      server: "shared_stdio",
                      transport: "mcp-stdio",
                    },
                    {
                      client: "execution-environment",
                      server: "shared_http",
                      transport: "mcp-http",
                    },
                  ],
                },
              },
              executionEnvironment: {
                id: "shared:workspace-1:access-1",
                provider: "shared-execution:workspace-1",
                placement: "remote",
                guarantees: {
                  filesystemIsolation: "sandbox",
                  networkPolicy: "enforced",
                  processTreeTermination: true,
                  scopedHttp: false,
                },
                provenance: {
                  environmentId: "workspace-1",
                  incarnationId: "incarnation-1",
                  accessId: "access-1",
                  expiresAt: "2030-01-01T01:00:00.000Z",
                },
              },
              harnessRuntime: {
                id: "local:/worker",
                provider: "local-harness-runtime",
                placement: "local",
                guarantees: {
                  filesystemIsolation: "none",
                  networkPolicy: "none",
                  processTreeTermination: false,
                  scopedHttp: false,
                },
              },
              inputs: [],
              omitted: [],
            },
          },
          {
            type: "agent.updated",
            ...identity,
            agent: { id: "child", parentId: "root", status: "running" },
          },
          {
            type: "agent.updated",
            ...identity,
            agent: { id: "child", parentId: "root", status: "completed" },
          },
          {
            type: "usage.updated",
            ...identity,
            usage: {
              inputTokens: 40,
              outputTokens: 20,
              cachedInputTokens: 0,
              totalTokens: 60,
              complete: true,
              reportedCost: { amountMinor: 200, currency: "USD" },
            },
          },
          { type: "execution.completed", ...identity },
        ];
        await store.closeTaskAttempt({
          attemptId: attempt.id,
          status: "completed",
          endedAt: "2030-01-01T00:00:02.000Z",
        });

        await store.disconnect();
        store = new DrizzleStore({ url });
        await store.connect();
        expect(await store.listTaskEvents(taskId)).toEqual([]);
        const worklet = journalWorklet(attempt.id, taskId, journal);
        const recovered = new ControlPlane({
          store,
          credentialVault: vault,
          worklet,
          reply: async () => {},
        });
        const [report, concurrentReport] = await Promise.all([
          recovered.inspectTaskExecution(taskId),
          recovered.inspectTaskExecution(taskId),
        ]);

        expect(report).toMatchObject({
          availability: "available",
          attemptId: attempt.id,
          receipt: { status: "completed", lastSequence: journal.length },
          limits: {
            requested: execution.limits,
            applied: { maxReportedTokens: { limit: 100, method: "interrupt-on-report" } },
            observed: {
              usage: { totalTokens: 60, complete: true },
              peakNativeAgents: 1,
            },
            completeness: { applied: true, usage: true, terminal: true, complete: true },
            outcome: { status: "within_limits" },
          },
          placement: {
            status: "available",
            mode: "split",
            cleanup: "confirmed",
            harness: {
              id: "codex",
              version: "0.42.0",
              provenance: {
                mcpClients: [
                  {
                    client: "execution-environment",
                    server: "shared_stdio",
                    transport: "mcp-stdio",
                  },
                  { client: "execution-environment", server: "shared_http", transport: "mcp-http" },
                ],
              },
            },
            harnessRuntime: {
              id: "local:/worker",
              provider: "local-harness-runtime",
              placement: "local",
            },
            executionEnvironment: {
              id: "shared:workspace-1:access-1",
              provider: "shared-execution:workspace-1",
              placement: "remote",
              provenance: {
                environmentId: "workspace-1",
                incarnationId: "incarnation-1",
                accessId: "access-1",
              },
            },
          },
        });
        expect(concurrentReport).toMatchObject({
          availability: "available",
          limits: { outcome: { status: "within_limits" } },
          placement: { status: "available", mode: "split", cleanup: "confirmed" },
        });
        expect(
          (await store.listTaskEvents(taskId)).map((event) => ({
            type: event.type,
            journalSequence: event.payload?.["journalSequence"],
          })),
        ).toEqual([
          { type: "execution.started", journalSequence: 1 },
          { type: "execution.limits.applied", journalSequence: 2 },
          { type: "execution.runtime-inputs.resolved", journalSequence: 3 },
          { type: "execution.agent.updated", journalSequence: 4 },
          { type: "execution.agent.updated", journalSequence: 5 },
          { type: "execution.usage.updated", journalSequence: 6 },
          { type: "execution.completed", journalSequence: 7 },
        ]);
      });
    },
  );
}

function journalWorklet(
  attemptId: string,
  taskId: string,
  journal: readonly TaskAttemptEvent[],
): DurableWorklet {
  const receipt = {
    attemptId,
    taskId,
    specDigest: "sha256:test",
    status: "completed" as const,
    lastSequence: journal.length,
  };
  return {
    id: "recovered-worklet",
    async describe() {
      return { id: "recovered-worklet", protocolVersion: 1, host: { id: "host", workers: [] } };
    },
    async *execute(_spec: TaskAttemptSpec) {},
    async accept() {
      return receipt;
    },
    async inspect(id) {
      return id === attemptId ? receipt : undefined;
    },
    async *events(id, after = 0) {
      if (id !== attemptId) return;
      for (const [index, event] of journal.entries()) {
        const sequence = index + 1;
        if (sequence > after) yield { sequence, event };
      }
    },
    async cancel() {
      return receipt;
    },
  };
}
