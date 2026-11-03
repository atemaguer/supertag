import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { startControlPlaneRuntime } from "../apps/cli/src/control-plane-runtime.js";
import {
  DurableLocalWorklet,
  FileAttemptJournal,
  LocalWorklet,
  type Worker,
} from "../packages/runtime/sdk/src/index.js";
import { connectWorklet } from "../packages/runtime/transport/src/index.js";
import {
  DrizzleStore,
  FileGatewayCredentialVault,
  migrateDatabase,
} from "../packages/store/src/index.js";
import { enrollWorkerHost } from "./support/worker-host-enrollment.js";

it("enforces waits only with confirmed cleanup", async () => {
  const directory = await mkdtemp(join(tmpdir(), "supertag-enforced-wait-"));
  const databaseUrl = `file:${join(directory, "state.db")}`;
  await migrateDatabase({ url: databaseUrl });
  const store = new DrizzleStore({ url: databaseUrl });
  await store.connect();
  let runtime: Awaited<ReturnType<typeof startControlPlaneRuntime>> | undefined;
  let connection: Awaited<ReturnType<typeof connectWorklet>> | undefined;
  let durable: DurableLocalWorklet | undefined;
  let releaseCleanup = () => {};
  const cleanup = new Promise<void>((resolve) => {
    releaseCleanup = resolve;
  });
  let cleanupStarted = false;
  let waitingToken = "";
  const executions: string[] = [];
  const requests: Promise<unknown>[] = [];
  try {
    const profile = { id: "wait-test", revision: "1" };
    const owner = await store.createTag({ name: "Wait leader" });
    await store.bindTagWorkerHost(owner.id, "wait-host");
    await store.createObjective({
      id: "wait",
      ownerTagId: owner.id,
      outcome: "Wait and resume",
    });
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
          id: "wait-worker",
          type: "test",
          profiles: [profile],
          capabilities: [{ id: "supertag.coordination", version: 1 }],
          contextTypes: [],
          maxConcurrency: 1,
        };
      },
      async *execute(spec, signal) {
        executions.push(spec.attemptId);
        const identity = {
          taskId: spec.taskId,
          attemptId: spec.attemptId,
          at: new Date().toISOString(),
        };
        yield { ...identity, type: "execution.started", workerId: "wait-worker" };
        if (executions.length === 1) {
          if (!spec.coordination) throw new Error("Missing coordination");
          waitingToken = spec.coordination.token;
          const stopped = new Promise<void>((resolve) =>
            signal.addEventListener("abort", () => resolve(), { once: true }),
          );
          requests.push(
            fetch(`${spec.coordination.controlPlaneUrl}/internal/v1/coordination/mcp`, {
              method: "POST",
              headers: {
                Authorization: `Bearer ${spec.coordination.token}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                jsonrpc: "2.0",
                id: 1,
                method: "tools/call",
                params: {
                  name: "wait_for",
                  arguments: { notBefore: new Date().toISOString() },
                },
              }),
            }).then((response) => response.json()),
          );
          // Never voluntarily completes after wait_for. Only host cancellation
          // releases execution, and cleanup is deliberately held for assertions.
          await stopped;
          cleanupStarted = true;
          await cleanup;
          yield {
            ...identity,
            type: "usage.updated",
            usage: {
              inputTokens: 30,
              outputTokens: 10,
              cachedInputTokens: 0,
              totalTokens: 40,
              complete: true,
              reportedCost: { amountMinor: 7, currency: "USD" },
            },
          };
          yield { ...identity, type: "execution.completed" };
          signal.throwIfAborted();
        }
        yield {
          ...identity,
          type: "output.message",
          message: { role: "teammate", text: "Resumed once" },
        };
        yield { ...identity, type: "execution.completed" };
      },
    };
    const local = new LocalWorklet("wait-host", "wait-host", [worker]);
    durable = new DurableLocalWorklet(local, new FileAttemptJournal(join(directory, "journal")));
    runtime = await startControlPlaneRuntime({
      host: "127.0.0.1",
      port: 0,
      databaseUrl,
      workletTransport: "remote",
      adminToken: "test-admin",
      credentialVault: new FileGatewayCredentialVault(join(directory, "vault")),
    });
    const credential = await enrollWorkerHost(runtime.url, "test-admin", "wait-host");
    connection = await connectWorklet({
      url: `${runtime.url.replace(/^http/u, "ws")}/worklets`,
      credential,
      worklet: local,
      durableWorklet: durable,
    });
    const started = await fetch(`${runtime.url}/api/v1/coordination/start_objective`, {
      method: "POST",
      headers: { Authorization: "Bearer test-admin", "Content-Type": "application/json" },
      body: JSON.stringify({ objectiveId: "wait" }),
    });
    expect(started.status).toBe(200);
    await expect.poll(() => cleanupStarted).toBe(true);
    const revoked = await fetch(`${runtime.url}/internal/v1/coordination/mcp`, {
      method: "POST",
      headers: { Authorization: `Bearer ${waitingToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
    });
    expect(revoked.status).toBe(401);
    expect((await store.getTaskAssignment("wait:start"))?.waitState?.attemptCount).toBe(1);
    expect((await store.getTaskAssignment("wait:start"))?.status).toBe("running");
    const firstAttempt = executions[0];
    if (!firstAttempt) throw new Error("Missing first Attempt");
    expect((await durable.inspect(firstAttempt))?.status).toBe("running");
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(executions).toHaveLength(1);
    // Losing the host while cleanup is pending is not a terminal receipt.
    await connection.stop();
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect((await store.getTaskAssignment("wait:start"))?.status).toBe("running");
    expect(await store.listTaskAttempts("wait:start")).toHaveLength(1);
    expect(executions).toHaveLength(1);
    connection = await connectWorklet({
      url: `${runtime.url.replace(/^http/u, "ws")}/worklets`,
      credential,
      worklet: local,
      durableWorklet: durable,
    });
    expect((await durable.inspect(firstAttempt))?.status).toBe("running");
    expect((await store.getTaskAssignment("wait:start"))?.status).toBe("running");
    releaseCleanup();
    await expect
      .poll(async () => (await store.getTaskAssignment("wait:start"))?.status, {
        timeout: 10000,
      })
      .toBe("accepted");
    expect(executions).toHaveLength(2);
    expect(new Set(executions).size).toBe(2);
    expect((await store.listTaskAttempts("wait:start")).map((a) => a.status)).toEqual([
      "cancelled",
      "completed",
    ]);
    const firstAttemptEvents = (await store.listTaskEvents("wait:start")).filter(
      (event) => event.attemptId === firstAttempt,
    );
    expect(firstAttemptEvents.map((event) => event.type)).toEqual(
      expect.arrayContaining(["usage.updated", "execution.completed"]),
    );
    const readResponse = await fetch(`${runtime.url}/api/v1/coordination/read_task`, {
      method: "POST",
      headers: { Authorization: "Bearer test-admin", "Content-Type": "application/json" },
      body: JSON.stringify({ objectiveId: "wait", taskId: "wait:start" }),
    });
    const readBody = await readResponse.text();
    expect(readResponse.status, readBody).toBe(200);
    const attempts = (
      JSON.parse(readBody) as {
        budget: { provider: { attempts: Array<Record<string, unknown>> } };
      }
    ).budget.provider.attempts;
    expect(attempts.find((attempt) => attempt["attemptId"] === firstAttempt)).toMatchObject({
      attemptId: firstAttempt,
      status: "cancelled",
      limits: {
        observed: {
          usage: {
            totalTokens: 40,
            complete: true,
            reportedCost: { amountMinor: 7, currency: "USD" },
          },
        },
      },
      observedCost: { amountMinor: 7, currency: "USD" },
    });
    expect((await store.getTaskAssignment("wait:start"))?.waitState?.wake?.reason).toBe("time");
  } finally {
    releaseCleanup();
    await Promise.allSettled(requests);
    await connection?.stop();
    await runtime?.close();
    await durable?.shutdown("Test cleanup");
    await store.disconnect();
    await rm(directory, { recursive: true, force: true });
  }
}, 20000);
