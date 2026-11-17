// The real Claude Code binary bundled with the Agent SDK applies SuperTag's native deny rules to
// Grep and Glob. A scripted local Messages API stands in for the model, so nothing leaves the
// machine: it asks for one Grep and one Glob over the Workspace, then records what the tools
// returned.
import { once } from "node:events";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { afterEach, expect, it } from "vitest";
import { nativeDenyRules } from "./src/rust-adapter/adapter.js";

const cleanup: string[] = [];
afterEach(async () => {
  for (const path of cleanup.splice(0)) await rm(path, { recursive: true, force: true });
});

interface ApiMessage {
  readonly role: string;
  readonly content: string | readonly { type: string; tool_use_id?: string; content?: unknown }[];
}

/** One streamed assistant message in the Messages API's server-sent event format. */
function stream(response: ServerResponse, block: Record<string, unknown>, stop: string): void {
  const events: [string, Record<string, unknown>][] = [
    [
      "message_start",
      {
        type: "message_start",
        message: {
          id: "msg_fixture",
          type: "message",
          role: "assistant",
          model: "claude-fixture",
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      },
    ],
  ];
  if (block["type"] === "tool_use") {
    const { input, ...start } = block;
    events.push(
      [
        "content_block_start",
        { type: "content_block_start", index: 0, content_block: { ...start, input: {} } },
      ],
      [
        "content_block_delta",
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "input_json_delta", partial_json: JSON.stringify(input) },
        },
      ],
    );
  } else {
    events.push(
      [
        "content_block_start",
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      ],
      [
        "content_block_delta",
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: block["text"] },
        },
      ],
    );
  }
  events.push(
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    [
      "message_delta",
      {
        type: "message_delta",
        delta: { stop_reason: stop, stop_sequence: null },
        usage: { output_tokens: 1 },
      },
    ],
    ["message_stop", { type: "message_stop" }],
  );
  response.writeHead(200, { "content-type": "text/event-stream" });
  for (const [name, data] of events)
    response.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
  response.end();
}

async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? (JSON.parse(text) as Record<string, unknown>) : {};
}

/** Run one turn that searches `cwd` with Grep and Glob; return each tool's result text. */
async function search(cwd: string, deny: string[]): Promise<{ grep: string; glob: string }> {
  const results = new Map<string, string>();
  const server = createServer(async (request, response) => {
    const payload = await body(request);
    if (!request.url?.startsWith("/v1/messages") || request.url.includes("count_tokens")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ input_tokens: 1 }));
      return;
    }
    const messages = (payload["messages"] ?? []) as ApiMessage[];
    for (const message of messages) {
      if (typeof message.content === "string") continue;
      for (const part of message.content) {
        if (part.type !== "tool_result" || !part.tool_use_id) continue;
        results.set(part.tool_use_id, JSON.stringify(part.content));
      }
    }
    const tools = ((payload["tools"] ?? []) as { name?: string }[]).map((tool) => tool.name);
    if (!tools.includes("Grep")) {
      stream(response, { type: "text", text: "fixture" }, "end_turn");
    } else if (!results.has("toolu_grep")) {
      stream(
        response,
        {
          type: "tool_use",
          id: "toolu_grep",
          name: "Grep",
          input: { pattern: "NEEDLE", path: cwd, output_mode: "content" },
        },
        "tool_use",
      );
    } else if (!results.has("toolu_glob")) {
      stream(
        response,
        { type: "tool_use", id: "toolu_glob", name: "Glob", input: { pattern: "**/*", path: cwd } },
        "tool_use",
      );
    } else {
      stream(response, { type: "text", text: "done" }, "end_turn");
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  const config = await mkdtemp(join(tmpdir(), "supertag-claude-config-"));
  cleanup.push(config);
  try {
    for await (const _ of query({
      prompt: "Search the Workspace.",
      options: {
        cwd,
        model: "claude-fixture",
        tools: ["Grep", "Glob"],
        allowedTools: ["Grep", "Glob"],
        permissionMode: "dontAsk",
        settingSources: [],
        settings: { permissions: { deny } },
        maxTurns: 4,
        env: {
          PATH: process.env["PATH"] ?? "/usr/bin:/bin",
          HOME: config,
          CLAUDE_CONFIG_DIR: config,
          ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
          ANTHROPIC_API_KEY: "fixture-key-not-a-secret",
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
          DISABLE_AUTOUPDATER: "1",
        },
        stderr: () => {},
      },
    })) {
      // Drain the turn.
    }
  } finally {
    server.close();
  }
  return { grep: results.get("toolu_grep") ?? "", glob: results.get("toolu_glob") ?? "" };
}

it("the bundled Claude Code leaves hidden paths out of Grep and Glob results", async () => {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "supertag-claude-search-")));
  cleanup.push(cwd);
  await mkdir(join(cwd, "secrets"));
  await mkdir(join(cwd, "apps/web"), { recursive: true });
  await writeFile(join(cwd, "visible.txt"), "NEEDLE public\n");
  await writeFile(join(cwd, "secrets/key.txt"), "NEEDLE secret-dir\n");
  await writeFile(join(cwd, ".env"), "NEEDLE root-env\n");
  await writeFile(join(cwd, "apps/web/.env"), "NEEDLE nested-env\n");
  // Without deny rules, both tools see every file, so the fixture itself is sound.
  const open = await search(cwd, []);
  for (const text of ["public", "secret-dir", "root-env", "nested-env"])
    expect(open.grep, text).toContain(text);
  expect(open.glob).toContain("key.txt");
  // With the scope's deny rules, neither reports a hidden file.
  const scoped = await search(
    cwd,
    nativeDenyRules(cwd, {
      write: [],
      readOnly: [],
      hidden: ["**/.env", "secrets/"],
      outsideWrite: [],
      outsideRead: [],
    }),
  );
  expect(scoped.grep).toContain("public");
  for (const text of ["secret-dir", "root-env", "nested-env"])
    expect(scoped.grep, text).not.toContain(text);
  expect(scoped.glob).toContain("visible.txt");
  expect(scoped.glob).not.toContain("key.txt");
  expect(scoped.glob).not.toMatch(/\.env/u);
}, 60_000);
