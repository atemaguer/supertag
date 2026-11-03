/** Opt-in subscription test: native Session restore with rotated MCP server credentials. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs, promisify } from "node:util";
import { createClaudeCodeWorker } from "../packages/runtime/harnesses/claude-code/src/index.js";
import { createCodexWorker } from "../packages/runtime/harnesses/codex/src/index.js";
import {
  FileSessionStateStore,
  LocalExecutionEnvironmentProvider,
  type SessionStateRef,
  type TaskAttemptEvent,
  ToolProviderRegistry,
  terminalOutputText,
} from "../packages/runtime/sdk/src/index.js";
import { repositoryAttempt } from "../tests/support/repository-execution.js";

const { values } = parseArgs({
  options: {
    live: { type: "boolean" },
    output: { type: "string" },
    child: { type: "string" },
    provider: { type: "string" },
  },
});
assert(values.live, "Pass --live to authorize subscription testing");
assert(values.output);
const provider = values.provider ?? "codex";
assert(provider === "codex" || provider === "claude");
const directory = resolve(values.output);
await mkdir(directory, { recursive: true, mode: 0o700 });
delete process.env["CODEX_API_KEY"];
delete process.env["OPENAI_API_KEY"];
const authFile = join(homedir(), ".codex/auth.json");
delete process.env["ANTHROPIC_API_KEY"];
delete process.env["ANTHROPIC_AUTH_TOKEN"];
if (provider === "codex") {
  const auth = JSON.parse(await readFile(authFile, "utf8"));
  assert(!auth.OPENAI_API_KEY && (auth.auth_mode === "chatgpt" || auth.tokens));
}
const source = join(directory, "source");
await mkdir(source, { recursive: true });

if (values.child) {
  const phase = values.child;
  assert(phase === "initial" || phase === "resume" || phase === "changed-policy");
  const configuration = JSON.parse(
    await readFile(join(directory, `${phase}-configuration.json`), "utf8"),
  ) as { url: string; token: string };
  const runtime = join(directory, `runtime-${phase}`);
  await mkdir(runtime, { recursive: true });
  const states = new FileSessionStateStore(join(directory, "states"));
  const ref: SessionStateRef | undefined =
    phase !== "initial"
      ? JSON.parse(await readFile(join(directory, "initial-ref.json"), "utf8"))
      : undefined;
  const tools = new ToolProviderRegistry([
    {
      provider: "session-test",
      resolve: async () => ({
        provider: "session-test",
        inputs: [
          {
            id: "session-read",
            kind: "tool",
            required: true,
            audience: "manager",
            capability: {
              id: "session-read",
              provider: "session-test",
              operations: [
                {
                  name: "read_note",
                  effect: "read",
                  actions: ["notes:read"],
                  resourceArgumentPolicies: [
                    {
                      match: "scope",
                      prefix: "collection:",
                      components: [{ arguments: ["collection"] }],
                    },
                  ],
                },
              ],
              authorization: {
                provider: "session-test",
                resources: [
                  {
                    surfaceAccountId: "fixture",
                    scope: phase === "changed-policy" ? "collection:public" : "collection:docs",
                  },
                ],
              },
            },
            binding: {
              kind: "mcp-http",
              name: "session_notes",
              url: configuration.url,
              runtimeHeaders: { Authorization: `Bearer ${configuration.token}` },
            },
          },
        ],
      }),
    },
  ]);
  const common = {
    workspace: source,
    timeoutMs: 120_000,
    profileId: "session-mcp",
    executionEnvironment: new LocalExecutionEnvironmentProvider({ temporaryDirectory: runtime }),
    sessionStateStore: states,
    toolProviders: tools,
  };
  const worker =
    provider === "codex"
      ? createCodexWorker({
          ...common,
          executionMode: "app-server",
          model: "gpt-5.6-luna",
          maxNativeAgents: 0,
          authFile,
        })
      : createClaudeCodeWorker({ ...common, model: "haiku", maxTurns: 8 });
  const base = repositoryAttempt(`mcp-${phase}-${randomUUID()}`);
  const prompt =
    phase === "changed-policy"
      ? "Without calling any tools, state the private fact from our previous conversation if available, otherwise say UNKNOWN. Do not guess."
      : phase === "initial"
        ? 'Call the supplied session_notes read_note MCP tool exactly once with collection="docs". Remember its private fact for our next conversation. Reply with the fact. Use no other tools.'
        : 'First state the exact private fact learned from the MCP tool in our previous conversation. It is deliberately absent from this message. Then call session_notes read_note exactly once with collection="private": this is an intentional authorization test and must be denied. Then call it exactly once with collection="docs" to retrieve the new note from the reconnected server. Reply with both the remembered private fact and new note. Do not try other tools or retry the denied collection.';
  const spec = {
    ...base,
    workerProfile: { id: "session-mcp", revision: "1" },
    authorization: { ...base.authorization, runtimeActions: [] },
    session: { id: "session-mcp", ...(ref ? { sessionState: ref } : {}) },
    input: { ...base.input, messages: [{ id: phase, role: "requester" as const, text: prompt }] },
  };
  const events: TaskAttemptEvent[] = [];
  for await (const event of worker.execute(spec)) events.push(event);
  const serialized = JSON.stringify(events, null, 2);
  assert(!serialized.includes(configuration.token), "MCP credential leaked into public events");
  await writeFile(join(directory, `${phase}-events.json`), serialized, { mode: 0o600 });
  assert.equal(events.at(-1)?.type, "execution.completed", JSON.stringify(events.at(-1)));
  const updated = events.findLast((event) => event.type === "session.updated");
  assert(updated?.type === "session.updated");
  const saved = await states.load(updated.sessionState);
  assert(saved);
  const nativeId = saved.data["threadId"] ?? saved.data["claudeSessionId"];
  assert(typeof nativeId === "string" && nativeId.length > 0, "Native session identity required");
  assert(
    !JSON.stringify(saved).includes(configuration.token),
    "MCP credential leaked into native archive",
  );
  const denialRecorded = JSON.stringify(saved).includes("outside this Task's admitted capability");
  if (phase === "resume")
    assert(denialRecorded, "Native transcript must prove denied tool call occurred");
  await writeFile(join(directory, `${phase}-ref.json`), JSON.stringify(updated.sessionState), {
    mode: 0o600,
  });
  const remaining = await readdir(runtime);
  for (const name of remaining) {
    assert(name.startsWith(".supertag-attempt-owners-"));
    assert.deepEqual(await readdir(join(runtime, name)), []);
  }
  await writeFile(
    join(directory, `${phase}-result.json`),
    JSON.stringify({
      pid: process.pid,
      nativeId,
      text: terminalOutputText(events),
      runtimeDestroyed: true,
      noHistoryReplay: true,
      denialRecorded,
    }),
    { mode: 0o600 },
  );
} else {
  const originalFact = `original-${randomUUID()}`,
    newFact = `new-${randomUUID()}`;
  const phases = [];
  for (const phase of ["initial", "resume", "changed-policy"] as const) {
    const token = randomUUID(),
      sessions = new Set<string>(),
      calls: string[] = [];
    let closed = 0,
      initialized = 0;
    const server = createServer(async (request, response) => {
      if (request.headers.authorization !== `Bearer ${token}`) {
        response.writeHead(401).end();
        return;
      }
      if (request.method === "DELETE") {
        sessions.delete(String(request.headers["mcp-session-id"]));
        closed++;
        response.writeHead(200).end();
        return;
      }
      if (request.method !== "POST") {
        response.writeHead(405).end();
        return;
      }
      let body = "";
      for await (const chunk of request) body += chunk;
      const message = JSON.parse(body);
      if (message.id === undefined) {
        response.writeHead(202).end();
        return;
      }
      let result: unknown, session: string | undefined;
      if (message.method === "initialize") {
        session = randomUUID();
        sessions.add(session);
        initialized++;
        result = {
          protocolVersion: "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "session-notes", version: "1" },
        };
      } else {
        if (!sessions.has(String(request.headers["mcp-session-id"]))) {
          response.writeHead(404).end();
          return;
        }
        if (message.method === "tools/list")
          result = {
            tools: [
              {
                name: "read_note",
                description: "Read the note in an admitted collection",
                inputSchema: {
                  type: "object",
                  properties: { collection: { type: "string" } },
                  required: ["collection"],
                  additionalProperties: false,
                },
              },
            ],
          };
        else if (message.method === "tools/call") {
          const collection = message.params.arguments.collection;
          calls.push(collection);
          result = {
            content: [{ type: "text", text: phase === "initial" ? originalFact : newFact }],
          };
        }
      }
      response.writeHead(200, {
        "content-type": "application/json",
        ...(session ? { "mcp-session-id": session } : {}),
      });
      response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
    });
    await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
    const address = server.address();
    assert(address && typeof address !== "string");
    await writeFile(
      join(directory, `${phase}-configuration.json`),
      JSON.stringify({ url: `http://127.0.0.1:${address.port}/mcp`, token }),
      { mode: 0o600 },
    );
    try {
      await promisify(execFile)(
        "pnpm",
        [
          "exec",
          "tsx",
          "--conditions=development",
          "scripts/session-mcp-live.ts",
          "--provider",
          provider,
          "--live",
          "--output",
          directory,
          "--child",
          phase,
        ],
        { cwd: resolve(import.meta.dirname, ".."), timeout: 150_000, maxBuffer: 1024 * 1024 },
      );
      const result = JSON.parse(await readFile(join(directory, `${phase}-result.json`), "utf8"));
      if (phase === "changed-policy") {
        assert(
          !result.text.includes(originalFact),
          "Changed policy must not recover original fact",
        );
        assert.notEqual(
          result.nativeId,
          phases[0]?.nativeId,
          "Changed resource policy must create a fresh native thread",
        );
      } else assert(result.text.includes(originalFact), "Original MCP fact was not retained");
      if (phase === "resume") assert(result.text.includes(newFact), "Fresh MCP server not used");
      assert.deepEqual(
        calls,
        phase === "changed-policy" ? [] : ["docs"],
        "Denied collection must not reach MCP provider; allowed call exactly once",
      );
      assert.equal(initialized, 1);
      assert.equal(closed, 1);
      phases.push({
        phase,
        pid: result.pid,
        nativeId: result.nativeId,
        runtimeDestroyed: result.runtimeDestroyed,
        noHistoryReplay: result.noHistoryReplay,
        denialRecorded: result.denialRecorded,
        initialized,
        closed,
        calls,
      });
    } finally {
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
    }
  }
  assert.equal(phases[0]?.nativeId, phases[1]?.nativeId);
  assert.notEqual(phases[0]?.pid, phases[1]?.pid);
  const report = {
    provider,
    verified: true,
    factLearnedOnlyFromMcp: true,
    endpointAndCredentialRotated: true,
    unauthorizedCallReachedProvider: false,
    changedResourcePolicyStartsFreshThread: true,
    phases,
  };
  await writeFile(join(directory, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
