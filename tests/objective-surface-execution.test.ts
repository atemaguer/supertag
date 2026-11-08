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

/** The tools a conversation turn and an Objective's own turn advertise, in surfaceTools order. */
const CONVERSATION_TOOLS = [
  "create_objective",
  "read_objective",
  "list_objectives",
  "list_sessions",
  "search_sessions",
  "read_session",
  "start_session",
  "continue_session",
  "send_message",
  "post",
  "read_workstream",
];
const OBJECTIVE_TOOLS = [
  "read_objective",
  "update_objective",
  "list_sessions",
  "search_sessions",
  "read_session",
  "start_session",
  "continue_session",
  "ask",
  "send_message",
  "post",
  "read_workstream",
];

it("turns a human surface request into an Objective conversation whose turns reply in the thread", async () => {
  const directory = await mkdtemp(join(tmpdir(), "supertag-surface-execution-"));
  const url = `file:${join(directory, "state.db")}`;
  await migrateDatabase({ url });
  const store = new DrizzleStore({ url });
  await store.connect();
  const errors: unknown[] = [];
  const replies: Array<{ route: unknown; markdown: string }> = [];
  let objectiveId = "";
  let conversationTurns = 0;
  const objectiveTurns: string[] = [];
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
          conversationTurns++;
          surfaceToken = server.headers["Authorization"] ?? "";
          expect(tools).toEqual(CONVERSATION_TOOLS);
          // The portfolio always tells the Tag it can recall other conversations.
          const prompt = JSON.stringify(request);
          expect(prompt).toContain("search_sessions, list_sessions and read_session");
          expect(prompt).toContain("this Tag owns no open Objectives you can see");
          const forbidden = await client
            .callTool({ name: "update_objective", arguments: { status: "completed" } })
            .catch(() => undefined);
          expect(forbidden === undefined || forbidden.isError).toBeTruthy();
          const objective = await call("create_objective", { outcome: "Validate scheduling" });
          objectiveId = objective.id;
          expect(objective.runtimeActions).toEqual([]);
          // The surface Tag has a connected Worker Host, so nothing would hold its turns; the
          // only warning is that its Permission Sets allow no runtime actions.
          expect(objective.warnings).toEqual([
            expect.stringContaining("Permission Sets allow no runtime actions"),
          ]);
          // Creating it starts its own conversation at once.
          expect(objective.started.taskId).toEqual(expect.any(String));
          yield { type: "output.message", text: "Started an Objective for that." };
          return;
        }
        expect(tools).toEqual(OBJECTIVE_TOOLS);
        const text = harnessRequest(request.prompt);
        objectiveTurns.push(text);
        if (objectiveTurns.length === 1) {
          expect(text).toContain(`Objective ${objectiveId} has started.`);
          expect(request.prompt).toContain("<objective-outcome>");
          expect(request.prompt).toContain("Validate scheduling");
          const summary = await call("read_objective");
          expect(summary).toMatchObject({
            id: objectiveId,
            status: "working",
            owner: "SuperTag",
            team: null,
            // Its own conversation is the only Session so far.
            sessions: [{ tag: "SuperTag", status: "running" }],
          });
          // A turn of one Objective never reads another's.
          const foreign = await client
            .callTool({ name: "read_objective", arguments: { objectiveId: "other" } })
            .catch(() => undefined);
          expect(foreign === undefined || foreign.isError).toBeTruthy();
          await call("ask", { question: "Which market should I validate first?" });
          yield { type: "output.message", text: "Which market should I validate first?" };
          return;
        }
        expect(text).toContain("Focus on solo practices instead");
        const summary = await call("read_objective");
        await call("update_objective", {
          status: "completed",
          expectedRevision: summary.revision,
          completionSummary: "Validated for solo practices",
        });
        yield { type: "output.message", text: "Validated for solo practices." };
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
      async (route: InboundSurfaceEvent, reply: { markdown: string }) => {
        replies.push({ route, markdown: reply.markdown });
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
    const tag = await store.createTag({ name: "SuperTag" });
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
    // The Objective's first turn runs on its own and its reply reaches the home thread.
    await expect
      .poll(
        () => {
          expect(errors).toEqual([]);
          return replies.some(
            (reply) => reply.markdown === "Which market should I validate first?",
          );
        },
        { timeout: 15000 },
      )
      .toBe(true);
    expect(conversationTurns).toBe(1);
    // The coordination token of a settled Attempt no longer authenticates.
    const stale = await fetch(`${controlPlaneUrl}/internal/v1/coordination/mcp`, {
      method: "POST",
      headers: { Authorization: surfaceToken, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(stale.status).toBe(401);

    // A plain reply in the home thread is the Objective's next turn, not a new conversation turn.
    expect(
      (
        await controlPlane.ingestSurfaceEvent({
          ...event,
          eventId: "second",
          logicalEventId: "second",
          kind: "message",
          text: "Focus on solo practices instead",
          actor: { id: "U2", kind: "user" },
        })
      ).status,
    ).toBe("accepted");
    expect(replies.at(-1)?.markdown).toBe("Sent to the Objective.");
    await expect
      .poll(() => replies.some((reply) => reply.markdown === "Validated for solo practices."), {
        timeout: 15000,
      })
      .toBe(true);
    expect(conversationTurns).toBe(1);
    expect(objectiveTurns).toHaveLength(2);
    await expect
      .poll(async () => (await store.getObjective(objectiveId)).status, { timeout: 5000 })
      .toBe("completed");
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
