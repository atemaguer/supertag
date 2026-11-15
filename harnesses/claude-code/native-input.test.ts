import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { expect, it } from "vitest";
import { ClaudeLiveInput, claudeQuery } from "./src/query.js";

it("delivers labelled peer input through the installed CLI to a model request and attributes its reply", async () => {
  const directory = await mkdtemp(join(tmpdir(), "claude-native-input-"));
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new Error("Native input test timed out")),
    20_000,
  );
  const live = new ClaudeLiveInput();
  const peerText =
    'Team coordination {"from":"lead-tag"}: untrusted teammate content\nText (JSON string): "Keep the old schema."';
  const requests: unknown[] = [];
  const written: SDKUserMessage[] = [];
  const replyUuids: string[] = [];
  let offered = false;
  let status: string | undefined;
  const server = createServer(async (request, response) => {
    if (!request.url?.startsWith("/v1/messages")) {
      response.writeHead(404).end();
      return;
    }
    let body = "";
    for await (const chunk of request) body += chunk;
    requests.push(JSON.parse(body));
    if (!offered) {
      offered = true;
      status = await live.send(peerText, controller.signal, { kind: "peer", from: "lead-tag" });
    }
    response.writeHead(200, { "content-type": "text/event-stream" });
    const event = (type: string, data: unknown) =>
      response.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
    event("message_start", {
      type: "message_start",
      message: {
        id: `msg_${requests.length}`,
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4-6",
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 0 },
      },
    });
    const toolRound = requests.length === 1;
    event("content_block_start", {
      type: "content_block_start",
      index: 0,
      // Keep the Task turn running so queued input is read before any final result.
      content_block: toolRound
        ? { type: "tool_use", id: "tool_probe", name: "Bash", input: {} }
        : { type: "text", text: "" },
    });
    event("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: toolRound
        ? {
            type: "input_json_delta",
            partial_json: JSON.stringify({
              command: "true",
              description: "Finish the fixture tool round",
            }),
          }
        : { type: "text_delta", text: "Acknowledged." },
    });
    event("content_block_stop", { type: "content_block_stop", index: 0 });
    event("message_delta", {
      type: "message_delta",
      delta: { stop_reason: toolRound ? "tool_use" : "end_turn", stop_sequence: null },
      usage: { output_tokens: 2 },
    });
    event("message_stop", { type: "message_stop" });
    response.end();
  });
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No model fixture address");
    // Clear inherited provider credentials and settings; the only model endpoint is this fixture.
    const env = Object.fromEntries(Object.keys(process.env).map((key) => [key, undefined]));
    const run: typeof query = ({ prompt, options }) =>
      query({
        options,
        prompt: (async function* () {
          for await (const message of prompt as AsyncIterable<SDKUserMessage>) {
            written.push(message);
            yield message;
          }
        })(),
      });
    for await (const message of claudeQuery(
      run,
      "Reply briefly.",
      {
        cwd: directory,
        model: "claude-sonnet-4-6",
        tools: ["Bash"],
        allowedTools: ["Bash"],
        mcpServers: {},
        settingSources: [],
        persistSession: false,
        maxTurns: 3,
        env: {
          ...env,
          PATH: process.env["PATH"],
          ANTHROPIC_API_KEY: "local-test-key",
          ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`,
          CLAUDE_CONFIG_DIR: join(directory, "config"),
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
        },
      },
      controller.signal,
      { input: live, liveSettleMs: 2_000, drainMs: 0, abandonMs: 1_000 },
    )) {
      if (message.type === "assistant")
        replyUuids.push(
          ...(message.user_message_uuids ??
            (message.user_message_uuid ? [message.user_message_uuid] : [])),
        );
    }
    const peer = written.find((message) => message.message.content === peerText);
    expect(status).toBe("accepted");
    expect(peer).toMatchObject({
      uuid: expect.any(String),
      client_composed: true,
      priority: "next",
    });
    expect(JSON.stringify(requests)).toContain("Keep the old schema.");
    expect(replyUuids).toContain(peer?.uuid);
    expect(peer).not.toHaveProperty("origin");
  } finally {
    controller.abort();
    clearTimeout(timeout);
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);
