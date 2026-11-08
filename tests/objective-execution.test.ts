import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { expect, it, vi } from "vitest";
import { startControlPlaneRuntime } from "../apps/cli/src/control-plane-runtime.js";
import { createCodexWorker } from "../packages/runtime/harnesses/codex/src/index.js";
import {
  COORDINATION_CAPABILITY,
  LocalWorklet,
  SURFACE_COORDINATION_CAPABILITY,
  type Worker,
} from "../packages/runtime/sdk/src/index.js";
import {
  DrizzleStore,
  FileGatewayCredentialVault,
  migrateDatabase,
} from "../packages/store/src/index.js";
import { durableTestWorklet } from "./support/durable-test-worklet.js";

/** Applies an Objective manifest; apply starts an Objective that has not started yet. */
async function applyObjective(
  url: string,
  token: string,
  name: string,
  spec: Record<string, unknown>,
) {
  const response = await fetch(`${url}/api/v1/objectives`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      apiVersion: "supertag/v1",
      kind: "Objective",
      metadata: { name },
      spec,
    }),
  });
  expect([200, 201], await response.clone().text()).toContain(response.status);
  return (await response.json()) as Record<string, unknown>;
}

/** The Tasks of an Objective's own conversation, oldest first. */
async function ownerTaskIds(store: DrizzleStore, objectiveId: string) {
  const session = await store.findObjectiveOwnerSession(objectiveId);
  return session ? await store.listSessionTaskIds(session.id) : [];
}

it("runs an Objective through the Harness: it delegates to a Team member, reviews and completes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "supertag-objective-execution-"));
  const databaseUrl = `file:${join(directory, "state.db")}`;
  await migrateDatabase({ url: databaseUrl });
  const store = new DrizzleStore({ url: databaseUrl });
  await store.connect();
  let runtime: Awaited<ReturnType<typeof startControlPlaneRuntime>> | undefined;
  const errors: unknown[] = [];
  try {
    const leader = await store.createTag({ name: "Executive" });
    const researcher = await store.createTag({ name: "Research" });
    for (const tag of [leader, researcher]) await store.bindTagWorkerHost(tag.id, "objective-host");
    let researchToken = "";
    let delegatedSessionId = "";
    const ownerTurns: string[] = [];
    const worker = createCodexWorker({
      workspace: directory,
      runner: async function* (request, environment) {
        const server = request.mcpServers.find((entry) => entry.name === "supertag-coordination");
        if (server?.transport !== "mcp-http") throw new Error("Missing coordination MCP input");
        const client = new Client({ name: "objective-test", version: "1" });
        await client.connect(
          new StreamableHTTPClientTransport(new URL(server.url), {
            requestInit: { headers: server.headers },
          }),
        );
        const call = async (name: string, args: Record<string, unknown> = {}) => {
          const result = await client.callTool({ name, arguments: args });
          expect(result.isError, JSON.stringify(result)).not.toBe(true);
          const text = (result.content as Array<{ type: string; text?: string }>).find(
            (block) => block.type === "text",
          )?.text;
          return text === undefined ? undefined : JSON.parse(text);
        };
        try {
          const tools = (await client.listTools()).tools.map((tool) => tool.name);
          if (!tools.includes("update_objective")) {
            // A work Session sees only its own work: it may ask, nothing more.
            expect(tools).toEqual(["ask"]);
            researchToken = server.headers["Authorization"] ?? "";
            const process = await environment.spawn({
              command: globalThis.process.execPath,
              args: ["-e", "process.stdout.write('local evidence')"],
              timeoutMs: 5000,
            });
            const result = await process.wait();
            expect(result.exitCode).toBe(0);
            yield { type: "output.message", text: result.stdout };
            return;
          }
          ownerTurns.push(request.prompt);
          if (ownerTurns.length === 1) {
            expect(request.prompt).toContain("No external outreach");
            const started = await call("start_session", {
              title: "Research probe",
              instruction: "Run the local research probe",
              tag: "Research",
            });
            delegatedSessionId = started.sessionId;
            yield { type: "output.message", text: "Delegated the probe." };
            return;
          }
          // The delegated work Session's result comes back as a turn of this conversation.
          expect(request.prompt).toContain("local evidence");
          const objective = await call("read_objective");
          expect(objective.sessions).toContainEqual(
            expect.objectContaining({
              sessionId: delegatedSessionId,
              tag: "Research",
              title: "Research probe",
              status: "completed",
            }),
          );
          await call("update_objective", {
            status: "completed",
            expectedRevision: objective.revision,
            completionSummary: "Validated with local evidence",
          });
          yield { type: "output.message", text: "Validated with local evidence." };
        } catch (error) {
          errors.push(error);
          throw error;
        } finally {
          await client.close();
        }
      },
    });
    runtime = await startControlPlaneRuntime({
      host: "127.0.0.1",
      port: 0,
      databaseUrl,
      worklet: durableTestWorklet(
        new LocalWorklet("objective-worklet", "objective-host", [worker]),
      ),
      adminToken: "admin-test",
      credentialVault: new FileGatewayCredentialVault(join(directory, "vault.json")),
    });

    await applyObjective(runtime.url, "admin-test", "demo", {
      owner: "Executive",
      outcome: "Validate the product. No external outreach.",
      runtimeActions: ["commands:execute"],
      team: { name: "research", members: ["Executive", "Research"] },
    });

    await expect
      .poll(
        async () => {
          expect(errors).toEqual([]);
          return (await store.getObjective("demo")).status;
        },
        { timeout: 20_000 },
      )
      .toBe("completed");
    expect(await ownerTaskIds(store, "demo")).toHaveLength(2);
    expect((await store.getObjective("demo")).completionSummary).toBe(
      "Validated with local evidence",
    );
    // The delegated work Session belongs to the Objective and ran as the other Tag.
    const sessions = await store.listObjectiveSessions("demo");
    expect(sessions.map((session) => session.title)).toContain("Research probe");

    // A settled Attempt's coordination token no longer authenticates.
    const revoked = await fetch(`${runtime.url}/internal/v1/coordination/mcp`, {
      method: "POST",
      headers: { Authorization: researchToken, "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(revoked.status).toBe(401);
  } finally {
    await runtime?.close();
    await store.disconnect();
    await rm(directory, { recursive: true, force: true });
  }
}, 40000);

it("finishing an Objective does not exempt its completing Attempt from cancellation", async () => {
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
    const worker: Worker = {
      async describe() {
        return {
          profileCapabilities: [
            {
              profile: profile,
              capabilities: [COORDINATION_CAPABILITY, SURFACE_COORDINATION_CAPABILITY],
              contextTypes: [],
            },
          ],
          id: "finisher",
          type: "test",
          profiles: [profile],
          capabilities: [COORDINATION_CAPABILITY, SURFACE_COORDINATION_CAPABILITY],
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
        const mcp = (id: number, body: Record<string, unknown>) =>
          fetch(`${spec.coordination?.controlPlaneUrl}/internal/v1/coordination/mcp`, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${spec.coordination?.token}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ jsonrpc: "2.0", id, ...body }),
          });
        const objective = await store.getObjective("finishing");
        const response = await mcp(1, {
          method: "tools/call",
          params: {
            name: "update_objective",
            arguments: {
              status: "completed",
              expectedRevision: objective.revision,
              completionSummary: "Success criteria satisfied",
            },
          },
        });
        expect(response.status).toBe(200);
        expect((await response.json()).result?.isError).not.toBe(true);
        // Completing the Objective does not end this Attempt; it keeps its own coordination.
        expect((await mcp(2, { method: "tools/list" })).status).toBe(200);
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
    await applyObjective(runtime.url, "test-admin", "finishing", {
      owner: "Finishing leader",
      outcome: "Finish",
      deadline: new Date(Date.now() + 60_000).toISOString(),
    });
    await expect
      .poll(async () => (await store.getObjective("finishing")).status, { timeout: 20_000 })
      .toBe("completed");
    const [ownerTaskId] = await ownerTaskIds(store, "finishing");
    if (!ownerTaskId) throw new Error("Missing the Objective's own Task");
    // Completion leaves the Attempt that recorded it running, not aborted.
    expect((await store.findTaskById(ownerTaskId))?.status).toBe("running");
    expect(aborted).toBe(false);
    {
      const cancelled = await fetch(
        `${runtime.url}/api/v1/tasks/${encodeURIComponent(ownerTaskId)}/cancel`,
        {
          method: "POST",
          headers: { Authorization: "Bearer test-admin", "Content-Type": "application/json" },
          body: JSON.stringify({}),
        },
      );
      expect(cancelled.status, await cancelled.text()).toBe(202);
    }
    await expect.poll(() => aborted, { timeout: 25_000 }).toBe(true);
  } finally {
    finish();
    await runtime?.close();
    vi.useRealTimers();
    await store.disconnect();
    await rm(directory, { recursive: true, force: true });
  }
}, 40000);
