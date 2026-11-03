import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import Database from "better-sqlite3";
import { expect, it, vi } from "vitest";
import { startControlPlaneRuntime } from "../apps/cli/src/control-plane-runtime.js";
import { createCodexWorker } from "../packages/runtime/harnesses/codex/src/index.js";
import { LocalWorklet, type Worker } from "../packages/runtime/sdk/src/index.js";
import {
  DrizzleStore,
  FileGatewayCredentialVault,
  migrateDatabase,
} from "../packages/store/src/index.js";
import { connectDurableTestWorklet } from "./support/durable-test-connection.js";
import { durableTestWorklet } from "./support/durable-test-worklet.js";
import { harnessRequest } from "./support/harness-request.js";
import { enrollWorkerHost } from "./support/worker-host-enrollment.js";

it("operates an Objective through HTTP, remote Worklet, Harness, local process, approval, restart and autonomous reobjective", async () => {
  const directory = await mkdtemp(join(tmpdir(), "supertag-objective-execution-"));
  const databaseUrl = `file:${join(directory, "state.db")}`;
  await migrateDatabase({ url: databaseUrl });
  const store = new DrizzleStore({ url: databaseUrl });
  await store.connect();
  let runtime: Awaited<ReturnType<typeof startControlPlaneRuntime>> | undefined;
  let connection: Awaited<ReturnType<typeof connectDurableTestWorklet>> | undefined;
  try {
    const leader = await store.createTag({
      name: "Executive",
    });
    const researcher = await store.createTag({
      name: "Research",
    });
    await store.bindTagWorkerHost(leader.id, "objective-host");
    await store.bindTagWorkerHost(researcher.id, "objective-host");
    await store.createObjective({
      id: "demo",
      outcome: "Validate the product. No external outreach.",
      ownerTagId: leader.id,
      budgetLimitMinor: 2000,
      runtimeActions: ["commands:execute"],
    });
    let researchToken = "";
    const worker = createCodexWorker({
      workspace: directory,
      runner: async function* (request, environment) {
        const server = request.mcpServers.find((server) => server.name === "supertag-coordination");
        if (server?.transport !== "mcp-http") throw new Error("Missing coordination MCP input");
        if (
          harnessRequest(request.prompt).includes("Run the local research probe") &&
          !harnessRequest(request.prompt).includes("A delegated Task changed state")
        )
          researchToken = server.headers["Authorization"] ?? "";
        const client = new Client({ name: "objective-test", version: "1" });
        await client.connect(
          new StreamableHTTPClientTransport(new URL(server.url), {
            requestInit: { headers: server.headers },
          }),
        );
        expect((await client.listTools()).tools.map((tool) => tool.name)).toContain("assign_task");
        const call = async (name: string, args: Record<string, unknown>) => {
          const result = await client.callTool({ name, arguments: args });
          expect(result.isError, JSON.stringify(result)).not.toBe(true);
          const text = (result.content as Array<{ type: string; text?: string }>).find(
            (block) => block.type === "text",
          )?.text;
          return text === undefined ? undefined : JSON.parse(text);
        };
        try {
          if (harnessRequest(request.prompt).includes("A delegated Task changed state")) {
            // An open owner activation receives later changes in another Attempt with the same
            // instruction, so act only on what is still pending, as a model reading state would.
            if (harnessRequest(request.prompt).includes("Task research-task is")) {
              const research = await call("read_task", { taskId: "research-task" });
              expect(research.result).toMatchObject({
                text: "local evidence",
                taskResult: { summary: "local evidence" },
              });
              if (research.status === "submitted")
                await call("update_task", {
                  taskId: "research-task",
                  expectedStatus: "submitted",
                  status: "accepted",
                  assessment:
                    "The evidence invalidates the original campaign; revise resource allocation",
                });
              if ((await call("read_task", { taskId: "obsolete-campaign" })).status === "queued")
                await call("update_task", {
                  taskId: "obsolete-campaign",
                  expectedStatus: "queued",
                  status: "cancelled",
                });
              const team = (await call("read_objective", {})).teams.find(
                (item: { id: string }) => item.id === "research",
              );
              if (team?.revision === 1)
                await call("update_team", {
                  teamId: "research",
                  expectedRevision: 1,
                  maxConcurrency: 2,
                });
            }
          } else if (harnessRequest(request.prompt).startsWith("Coordinate this Objective")) {
            expect(request.prompt).toContain("No external outreach");
            await call("create_team", {
              id: "research",
              name: "Research",
              leadTagId: researcher.id,
              memberTagIds: [researcher.id],
              maxConcurrency: 1,
            });
            await call("assign_task", {
              taskId: "research-task",
              teamId: "research",
              // The Research Team's channel; the owner reads it as the Objective owner.
              workstreamId: "research",
              assignedTagId: researcher.id,
              instruction: "Run the local research probe",
              acceptanceCriteria: ["Probe returns evidence"],
              maxCostMinor: 10,
              requiresApproval: true,
            });
            await call("assign_task", {
              taskId: "obsolete-campaign",
              teamId: "research",
              workstreamId: "research",
              assignedTagId: researcher.id,
              instruction: "Prepare the original campaign",
              acceptanceCriteria: ["Campaign matches original assumptions"],
              maxCostMinor: 10,
              requiresApproval: true,
            });
          } else {
            await call("read_objective", {});
          }
          const process = await environment.spawn({
            command: globalThis.process.execPath,
            args: ["-e", "process.stdout.write('local evidence')"],
            timeoutMs: 1000,
          });
          const result = await process.wait();
          expect(result.exitCode).toBe(0);
          yield { type: "output.message", text: result.stdout };
        } finally {
          await client.close();
        }
      },
    });
    const worklet = new LocalWorklet("objective-worklet", "objective-host", [worker]);
    const durableWorklet = durableTestWorklet(worklet);
    runtime = await startControlPlaneRuntime({
      host: "127.0.0.1",
      port: 0,
      databaseUrl,
      workletTransport: "remote",
      adminToken: "admin-test",
      credentialVault: new FileGatewayCredentialVault(join(directory, "vault.json")),
    });
    const credential = await enrollWorkerHost(runtime.url, "admin-test", "objective-host");
    connection = await connectDurableTestWorklet({
      url: `${runtime.url.replace(/^http/u, "ws")}/worklets`,
      credential,
      worklet,
      durableWorklet,
    });
    expect(connection.negotiatedProtocolVersion).toBe(18);
    const admin = async (command: string, input: Record<string, unknown>) => {
      const response = await fetch(`${runtime?.url}/api/v1/coordination/${command}`, {
        method: "POST",
        headers: { Authorization: "Bearer admin-test", "Content-Type": "application/json" },
        body: JSON.stringify({ objectiveId: "demo", ...input }),
      });
      expect(response.status, await response.text()).toBe(200);
    };
    await admin("start_objective", {});
    await expect
      .poll(async () => (await store.getTaskAssignment("demo:start"))?.status, { timeout: 10000 })
      .toBe("accepted");
    expect((await store.getTaskAssignment("research-task"))?.approval).toBe("pending");
    // Restart the Control Plane while the durable child assignment awaits approval.
    await connection.stop();
    await runtime.close();
    runtime = await startControlPlaneRuntime({
      host: "127.0.0.1",
      port: 0,
      databaseUrl,
      workletTransport: "remote",
      adminToken: "admin-test",
      credentialVault: new FileGatewayCredentialVault(join(directory, "vault.json")),
    });
    connection = await connectDurableTestWorklet({
      url: `${runtime.url.replace(/^http/u, "ws")}/worklets`,
      credential,
      worklet,
      durableWorklet,
    });
    expect((await store.getTaskAssignment("research-task"))?.approval).toBe("pending");
    await admin("update_task", {
      taskId: "research-task",
      expectedStatus: "queued",
      approval: "approved",
    });
    await expect
      .poll(async () => (await store.getTaskAssignment("research-task:followup"))?.status, {
        timeout: 10000,
      })
      .toBe("accepted");
    expect((await store.getTaskAssignment("research-task"))?.status).toBe("accepted");
    expect((await store.getTaskAssignment("obsolete-campaign"))?.status).toBe("cancelled");
    expect((await store.getTaskAssignment("obsolete-campaign"))?.attemptCount).toBe(0);
    expect((await store.getTeam("research")).maxConcurrency).toBe(2);
    expect((await store.getObjective("demo")).status).toBe("working");
    const revoked = await fetch(`${runtime.url}/internal/v1/coordination/mcp`, {
      method: "POST",
      headers: { Authorization: researchToken, "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(revoked.status).toBe(401);
  } finally {
    await connection?.stop();
    await runtime?.close();
    await store.disconnect();
    await rm(directory, { recursive: true, force: true });
  }
}, 20000);

it.each(["deadline", "cancellation", "membership revocation"] as const)(
  "finishing an Objective does not exempt its completing Attempt from %s",
  async (revocation) => {
    const directory = await mkdtemp(join(tmpdir(), "supertag-finishing-authority-"));
    const databaseUrl = `file:${join(directory, "state.db")}`;
    await migrateDatabase({ url: databaseUrl });
    const store = new DrizzleStore({ url: databaseUrl });
    await store.connect();
    let runtime: Awaited<ReturnType<typeof startControlPlaneRuntime>> | undefined;
    let aborted = false;
    let finish = () => {};
    const released = new Promise<void>((resolve) => {
      finish = resolve;
    });
    try {
      const profile = { id: "finishing-test", revision: "1" };
      const tag = await store.createTag({ name: "Finishing leader" });
      await store.bindTagWorkerHost(tag.id, "finishing-host");
      await store.createObjective({
        id: "finishing",
        ownerTagId: tag.id,
        outcome: "Finish",
        deadline: new Date(
          Date.now() + (revocation === "deadline" ? 12_000 : 60_000),
        ).toISOString(),
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
            id: "finisher",
            type: "test",
            profiles: [profile],
            capabilities: [{ id: "supertag.coordination", version: 1 }],
            contextTypes: [],
            maxConcurrency: 1,
          };
        },
        async *execute(spec, signal) {
          const identity = {
            taskId: spec.taskId,
            attemptId: spec.attemptId,
            at: new Date().toISOString(),
          };
          yield { ...identity, type: "execution.started", workerId: "finisher" };
          if (!spec.coordination || !runtime) throw new Error("Missing coordination");
          const response = await fetch(
            `${spec.coordination.controlPlaneUrl}/internal/v1/coordination/mcp`,
            {
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
                  name: "update_objective",
                  arguments: {
                    status: "completed",
                    expectedRevision: 1,
                    completionSummary: "Success criteria satisfied",
                  },
                },
              }),
            },
          );
          expect(response.status).toBe(200);
          expect((await response.json()).result?.isError).not.toBe(true);
          const revoked = await fetch(
            `${spec.coordination.controlPlaneUrl}/internal/v1/coordination/mcp`,
            {
              method: "POST",
              headers: {
                Authorization: `Bearer ${spec.coordination.token}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
            },
          );
          expect(revoked.status).toBe(403);
          signal.addEventListener(
            "abort",
            () => {
              aborted = true;
              finish();
            },
            { once: true },
          );
          await released;
          signal.throwIfAborted();
          yield { ...identity, type: "execution.completed" };
        },
      };
      runtime = await startControlPlaneRuntime({
        host: "127.0.0.1",
        port: 0,
        databaseUrl,
        worklet: durableTestWorklet(
          new LocalWorklet("finishing-worklet", "finishing-host", [worker]),
        ),
        credentialVault: new FileGatewayCredentialVault(join(directory, "vault")),
        adminToken: "test-admin",
      });
      const started = await fetch(`${runtime.url}/api/v1/coordination/start_objective`, {
        method: "POST",
        headers: { Authorization: "Bearer test-admin", "Content-Type": "application/json" },
        body: JSON.stringify({ objectiveId: "finishing" }),
      });
      expect(started.status).toBe(200);
      await expect
        .poll(async () => (await store.getObjective("finishing")).status)
        .toBe("completed");
      const firstLease = (await store.getTaskAssignment("finishing:start"))?.leaseExpiresAt;
      // A real renewal after completion demonstrates that the exception is active.
      await expect
        .poll(async () => (await store.getTaskAssignment("finishing:start"))?.leaseExpiresAt, {
          timeout: 8000,
        })
        .not.toBe(firstLease);
      expect(aborted).toBe(false);
      if (revocation === "deadline") {
        // Place the deadline beyond its grace period while the renewed 30s lease is still
        // valid. A completed Objective's deadline cannot change through the API.
        const db = new Database(databaseUrl.slice(5));
        try {
          db.prepare('UPDATE "Objective" SET "deadline" = ? WHERE "id" = ?').run(
            new Date(Date.now() - 16 * 60_000).toISOString(),
            "finishing",
          );
        } finally {
          db.close();
        }
        const lease = (await store.getTaskAssignment("finishing:start"))?.leaseExpiresAt;
        expect(lease && new Date(lease).getTime() > Date.now()).toBe(true);
      } else if (revocation === "membership revocation") {
        // There is no public Tag deactivation method; simulate the persisted
        // administrative revocation, as the admission revocation tests do.
        const db = new Database(databaseUrl.slice(5));
        try {
          db.prepare('UPDATE "Tag" SET "status" = ? WHERE "id" = ?').run("inactive", tag.id);
        } finally {
          db.close();
        }
      } else {
        await store.cancelTaskAssignment("finishing:start", tag.id);
      }
      await expect.poll(() => aborted, { timeout: 8000 }).toBe(true);
    } finally {
      finish();
      await runtime?.close();
      vi.useRealTimers();
      await store.disconnect();
      await rm(directory, { recursive: true, force: true });
    }
  },
  20000,
);
