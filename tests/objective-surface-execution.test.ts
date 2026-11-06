import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { expect, it } from "vitest";
import { handleCoordinationRequest } from "../apps/cli/src/coordination-http.js";
import { ControlPlane } from "../packages/control-plane/src/index.js";
import type { InboundSurfaceEvent } from "../packages/core/src/index.js";
import { createCodexWorker } from "../packages/runtime/harnesses/codex/src/index.js";
import { LocalWorklet } from "../packages/runtime/sdk/src/index.js";
import {
  DrizzleStore,
  FileGatewayCredentialVault,
  migrateDatabase,
} from "../packages/store/src/index.js";
import { durableTestWorklet } from "./support/durable-test-worklet.js";
import { harnessRequest } from "./support/harness-request.js";

it("turns human surface requests into objective execution and routes durable progress and approval notices back", async () => {
  const directory = await mkdtemp(join(tmpdir(), "supertag-surface-execution-"));
  const url = `file:${join(directory, "state.db")}`;
  await migrateDatabase({ url });
  const store = new DrizzleStore({ url });
  await store.connect();
  const errors: unknown[] = [];
  const replies: Array<{ route: unknown; markdown: string }> = [];
  let objectiveId = "";
  let surfaceExecutions = 0;
  let updateExecuted = false;
  let surfaceToken = "";
  const worker = createCodexWorker({
    workspace: directory,
    runner: async function* (request) {
      const server = request.mcpServers.find((entry) => entry.name === "supertag-coordination");
      if (server?.transport !== "mcp-http") throw new Error("Missing coordination input");
      const client = new Client({ name: "surface-test", version: "1" });
      const transport = new StreamableHTTPClientTransport(new URL(server.url), {
        requestInit: { headers: server.headers },
      });
      // MCP SDK's optional sessionId differs under exactOptionalPropertyTypes.
      await client.connect(transport as Parameters<Client["connect"]>[0]);
      const call = async (name: string, args: Record<string, unknown> = {}) => {
        const response = await client.callTool({ name, arguments: args });
        expect(response.isError, JSON.stringify(response)).not.toBe(true);
        const block = (response.content as Array<{ type: string; text?: string }>).find(
          (part) => part.type === "text",
        );
        return JSON.parse(block?.text ?? "null");
      };
      try {
        const tools = (await client.listTools()).tools.map((tool) => tool.name);
        if (tools.includes("create_objective")) {
          surfaceExecutions++;
          surfaceToken = server.headers["Authorization"] ?? "";
          expect(tools).toEqual([
            "create_objective",
            "attach_objective",
            "select_objective",
            "read_objective",
            "list_tasks",
            "read_commitments",
            "start_objective",
            "instruct_objective",
            "list_sessions",
            "search_sessions",
            "read_session",
            "list_objectives",
          ]);
          // The portfolio lists the Tag's open Objectives once there is one.
          const prompt = JSON.stringify(request);
          if (surfaceExecutions === 1) expect(prompt).not.toContain("Tag portfolio");
          else {
            expect(prompt).toContain("Tag portfolio");
            expect(prompt).toContain(`- ${objectiveId} [`);
          }
          const forbidden = await client
            .callTool({ name: "approve_task", arguments: { taskId: "approval" } })
            .catch(() => undefined);
          expect(forbidden === undefined || forbidden.isError).toBeTruthy();
          if (surfaceExecutions === 1) {
            const objective = await call("create_objective", {
              outcome: "Validate scheduling",
            });
            objectiveId = objective.id;
            expect(objective.runtimeActions).toEqual([]);
            // The surface Tag has a connected Worker Host, so nothing would hold its Tasks; the
            // only warning is that its Permission Sets allow no runtime actions.
            expect(objective.warnings).toEqual([
              expect.stringContaining("Permission Sets allow no runtime actions"),
            ]);
            await call("start_objective");
          } else {
            expect((await call("select_objective")).id).toBe(objectiveId);
            await call("instruct_objective");
            await call("instruct_objective");
          }
        } else {
          expect(tools).toContain("send_message");
          expect(tools).not.toContain("create_objective");
          if (harnessRequest(request.prompt).includes("Assess this authenticated human update")) {
            expect(request.prompt).toContain("Focus on solo practices instead");
            updateExecuted = true;
            await call("send_message", {
              recipientObjectiveId: objectiveId,
              type: "progress.updated",
              body: { message: "Target market updated" },
              idempotencyKey: "human-update",
            });
          } else if (!harnessRequest(request.prompt).includes("A delegated Task changed state")) {
            await call("send_message", {
              recipientObjectiveId: objectiveId,
              type: "progress.updated",
              body: { message: "Research is underway" },
              idempotencyKey: "initial-progress",
            });
            await call("send_message", {
              recipientObjectiveId: objectiveId,
              type: "progress.updated",
              body: { message: "Research is underway" },
              idempotencyKey: "initial-progress",
            });
            const objective = await call("read_objective");
            await call("assign_task", {
              taskId: "approval",
              teamId: `${objectiveId}:leadership`,
              assignedTagId: objective.ownerTagId,
              instruction: "Publish the validated product",
              acceptanceCriteria: ["Human approved publication"],
              requiresApproval: true,
            });
          }
        }
        yield { type: "output.message", text: "Request handled" };
      } catch (error) {
        errors.push(error);
        throw error;
      } finally {
        await client.close();
      }
    },
  });
  const controlPlane = new ControlPlane({
    store,
    credentialVault: new FileGatewayCredentialVault(join(directory, "vault.json")),
    worklet: durableTestWorklet(new LocalWorklet("surface-worklet", "surface-host", [worker])),
    reply: Object.assign(
      async (
        route: InboundSurfaceEvent,
        reply: { markdown: string },
        _account: unknown,
        delivery: { replaceExternalMessageId?: string },
      ) => {
        replies.push({ route, markdown: reply.markdown });
        if (
          reply.markdown === "Research is underway" ||
          reply.markdown === "Target market updated" ||
          reply.markdown.startsWith("Approval required")
        )
          expect(delivery.replaceExternalMessageId).toBeUndefined();
        return { externalMessageId: `reply-${replies.length}` };
      },
      { capabilities: () => ({ replacement: true }) },
    ),
    dispatch: {
      pollIntervalMs: 10,
      leaseDurationMs: 10000,
      retryBaseMs: 10,
      maxAttempts: 1,
      onDispatchError: (error) => errors.push(error),
    },
  });
  const server = createServer((request, response) => {
    void handleCoordinationRequest(
      request,
      response,
      new URL(request.url ?? "/", "http://localhost"),
      controlPlane.objectives,
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing HTTP address");
  const controlPlaneUrl = `http://127.0.0.1:${address.port}`;
  controlPlane.objectives.activateCoordination({ url: controlPlaneUrl });
  try {
    await controlPlane.start();
    const account = await controlPlane.setupSurfaceAccount({
      provider: "slack",
      externalAccountId: "T-SURFACE",
      displayName: "Surface",
      authMethod: "slack-socket-mode",
      configuration: { transport: "socket" },
      secrets: { botToken: "xoxb-test", appToken: "xapp-test" },
    });
    const tag = await store.createTag({
      name: "SuperTag",
    });
    await store.bindTagWorkerHost(tag.id, "surface-host");
    await store.addTagRoute({
      tagId: tag.id,
      surfaceAccountId: account.id,
      scope: "channel:C1",
    });
    const event: InboundSurfaceEvent = {
      eventId: "first",
      logicalEventId: "first",
      provider: "slack",
      externalAccountId: "T-SURFACE",
      kind: "mention",
      scope: "channel:C1",
      sessionKey: "slack:T-SURFACE:C1:1.000",
      actor: { id: "U1", kind: "user" },
      text: "@SuperTag objective Launch and validate a scheduling product",
      occurredAt: new Date().toISOString(),
      callback: {
        provider: "slack",
        mode: "slack_thread",
        threadKey: "T-SURFACE|C1|1.000",
        target: { channelId: "C1", threadTs: "1.000" },
      },
      source: {},
      metadata: {},
    };
    expect((await controlPlane.ingestSurfaceEvent(event)).status).toBe("accepted");
    await expect
      .poll(
        () => {
          expect(errors).toEqual([]);
          return replies.some((reply) => reply.markdown.startsWith("Approval required"));
        },
        {
          timeout: 15000,
        },
      )
      .toBe(true);
    expect(errors).toEqual([]);
    expect(replies.filter((reply) => reply.markdown === "Research is underway")).toHaveLength(1);
    expect((await store.getTaskAssignment("approval"))?.approval).toBe("pending");
    const stale = await fetch(`${controlPlaneUrl}/internal/v1/coordination/mcp`, {
      method: "POST",
      headers: { Authorization: surfaceToken, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(stale.status).toBe(401);
    expect(
      (
        await controlPlane.ingestSurfaceEvent({
          ...event,
          eventId: "second",
          logicalEventId: "second",
          text: "Focus on solo practices instead",
          actor: { id: "U2", kind: "user" },
        })
      ).status,
    ).toBe("accepted");
    await expect
      .poll(() => replies.some((reply) => reply.markdown === "Target market updated"), {
        timeout: 15000,
      })
      .toBe(true);
    expect(updateExecuted).toBe(true);
    expect(surfaceExecutions).toBe(2);
    expect(
      (await store.listTaskAssignments(objectiveId)).filter((task) =>
        task.taskId.startsWith("surface-instruction:"),
      ),
    ).toHaveLength(1);
    expect(replies.filter((reply) => reply.markdown.startsWith("Approval required"))).toHaveLength(
      1,
    );
    for (const reply of replies) expect(reply.route).toMatchObject({ callback: event.callback });
    expect(errors).toEqual([]);
  } finally {
    await controlPlane.stop();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await store.disconnect();
    await rm(directory, { recursive: true, force: true });
  }
}, 40000);
