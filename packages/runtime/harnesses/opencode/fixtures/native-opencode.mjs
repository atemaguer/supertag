// Executed only by Rust split-service tests, with synthetic provider credentials.
import assert from "node:assert/strict";
import { appendFileSync } from "node:fs";
import { access, appendFile, readFile, stat } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
process.on("uncaughtExceptionMonitor", (error) => {
  const message = String(error.stack ?? error)
    .replaceAll("synthetic-opencode-provider-key", "[REDACTED]")
    .slice(0, 4096);
  appendFileSync(join(root, "errors.log"), `${message}\n`, { mode: 0o600 });
});
const args = process.argv.slice(2);
if (args[0] === "--pure") {
  assert.deepEqual(args, ["--pure", "export", "ses_fixtureFallback"]);
  let input = "";
  for await (const chunk of process.stdin) input += chunk.toString("utf8");
  assert.equal(input, "");
  for (const key of Object.keys(process.env)) {
    if (
      /API_KEY|OAUTH_TOKEN/u.test(key) ||
      (key.startsWith("SUPERTAG_") && key !== "SUPERTAG_INTERNAL_PROCESS_MARKER")
    )
      assert.fail(`export inherited credential or runtime authority: ${key}`);
  }
  const calls = (await readFile(join(root, "calls.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const preceding = calls.at(-1);
  assert.equal(preceding.mode, "fallback");
  assert.equal(preceding.credentialSource, "file");
  assert.equal(process.env.HOME, preceding.home);
  assert.deepEqual(
    [process.env.XDG_CONFIG_HOME, process.env.XDG_DATA_HOME, process.env.XDG_CACHE_HOME],
    preceding.xdg,
  );
  await assert.rejects(readFile(join(process.env.XDG_DATA_HOME, "opencode", "auth.json")), {
    code: "ENOENT",
  });
  assert.notEqual(process.cwd(), preceding.cwd);
  const relativeCwd = relative(dirname(preceding.home), process.cwd());
  assert.ok(relativeCwd && relativeCwd !== ".." && !relativeCwd.startsWith(`..${sep}`));
  await appendFile(
    join(root, "exports.jsonl"),
    `${JSON.stringify({ pid: process.pid, args, cwd: process.cwd(), home: process.env.HOME })}\n`,
    { mode: 0o600 },
  );
  process.stdout.write(
    `${JSON.stringify({ info: { id: "ses_fixtureFallback" }, messages: [{ info: { id: "msg_fixtureFinal", sessionID: "ses_fixtureFallback", role: "assistant", finish: "stop", time: { completed: 1 } }, parts: [{ id: "prt_fixtureFinal", sessionID: "ses_fixtureFallback", messageID: "msg_fixtureFinal", type: "text", text: "native-fallback-complete" }] }] })}\n`,
  );
  process.exit(0);
}
assert.deepEqual(args, [
  "run",
  "--format",
  "json",
  "--model",
  "openai/fixture-model",
  "--agent",
  "build",
  "--pure",
]);
const credentialSource = process.env.OPENAI_API_KEY === undefined ? "file" : "environment";
if (credentialSource === "file") {
  const authPath = join(process.env.XDG_DATA_HOME, "opencode", "auth.json");
  const auth = JSON.parse(await readFile(authPath, "utf8"));
  assert.deepEqual(auth, { openai: { type: "api", key: "synthetic-opencode-provider-key" } });
  assert.equal((await stat(authPath)).mode & 0o777, 0o600);
} else {
  assert.equal(process.env.OPENAI_API_KEY, "synthetic-opencode-provider-key");
}
for (const key of [
  "ANTHROPIC_API_KEY",
  "CODEX_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "SUPERTAG_HOST_TOKEN",
  "SUPERTAG_BOOTSTRAP_HOST_TOKEN",
  "SUPERTAG_GATEWAY_TOKEN",
  "SUPERTAG_OPERATOR_TOKEN",
  "SUPERTAG_PRIVATE_HARNESS_TOKEN",
  "NODE_OPTIONS",
  "PYTHONPATH",
]) {
  assert.equal(process.env[key], undefined, `native process inherited forbidden key ${key}`);
}
assert.ok(process.env.HOME && process.env.HOME !== process.env.OPERATOR_HOME);
for (const key of [
  "OPENCODE_DISABLE_AUTOUPDATE",
  "OPENCODE_DISABLE_DEFAULT_PLUGINS",
  "OPENCODE_DISABLE_CLAUDE_CODE",
  "OPENCODE_DISABLE_PROJECT_CONFIG",
  "OPENCODE_DISABLE_LSP_DOWNLOAD",
])
  assert.equal(process.env[key], "true", `${key} must be locked down`);
const config = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT ?? "{}");
assert.equal(config.model, "openai/fixture-model");
assert.deepEqual(config.plugin, []);
assert.equal(config.share, "disabled");
assert.equal(config.autoupdate, false);
assert.equal(config.permission["*"], "deny");
assert.equal(config.permission.external_directory, "deny");
assert.equal(config.permission.read, "allow");
assert.equal(config.permission.edit, "deny");
let prompt = "";
for await (const chunk of process.stdin) prompt += chunk.toString("utf8");
assert.ok(prompt.includes("fixture:"));
assert.ok(!prompt.includes("synthetic-opencode-provider-key"));
const currentPrompt = prompt.replace(/<supertag-history>[\s\S]*?<\/supertag-history>/gu, "");
const mode = /fixture:([a-z-]+)/u.exec(currentPrompt)?.[1];
await appendFile(
  join(root, "calls.jsonl"),
  `${JSON.stringify({ pid: process.pid, args, cwd: process.cwd(), home: process.env.HOME, credentialSource, xdg: [process.env.XDG_CONFIG_HOME, process.env.XDG_DATA_HOME, process.env.XDG_CACHE_HOME], mode, priorPrompt: prompt.includes("fixture:stream"), priorResult: prompt.includes("native-complete:"), permissions: config.permission, agents: config.agent, mcpNames: Object.keys(config.mcp ?? {}) })}\n`,
  { mode: 0o600 },
);
const emit = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
if (mode === "bad-json") {
  process.stdout.write("malformed fixture line\n");
  process.exit(0);
}
if (mode === "native-error") {
  emit({ type: "error", error: { message: "synthetic failure" } });
  process.exit(0);
}
if (mode === "coordination") {
  const server = config.mcp?.supertag;
  const endpoint = new URL(server.url);
  assert.equal(endpoint.protocol, "http:");
  assert.equal(endpoint.hostname, "127.0.0.1");
  assert.equal(endpoint.pathname, "/mcp");
  assert.ok(endpoint.port);
  assert.equal(server.oauth, false);
  for (const child of [config.agent.general, config.agent.explore]) {
    for (const tool of ["supertag_*", "bash", "webfetch", "websearch", "task"])
      assert.equal(child.permission[tool], "deny", `child gained ${tool}`);
  }
  let sessionId;
  let protocolVersion = "2024-11-05";
  const rpc = async (id, method, params) => {
    const response = await fetch(server.url, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(5000),
      headers: {
        ...server.headers,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": protocolVersion,
        ...(sessionId ? { "mcp-session-id": sessionId } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    });
    sessionId = response.headers.get("mcp-session-id") ?? sessionId;
    if (id === undefined) {
      assert.equal(response.status, 202);
      return;
    }
    assert.equal(response.status, 200);
    const body = await response.text();
    const json = body.startsWith("data:")
      ? JSON.parse(
          body
            .split("\n")
            .find((line) => line.startsWith("data:"))
            .slice(5)
            .trim(),
        )
      : JSON.parse(body);
    assert.equal(json.error, undefined);
    return json.result;
  };
  const initialized = await rpc(1, "initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "supertag-fixture", version: "1" },
  });
  protocolVersion = initialized.protocolVersion;
  await rpc(undefined, "notifications/initialized", {});
  const listed = await rpc(2, "tools/list", {});
  const read = listed.tools.find((tool) => tool.name === "read_mailbox");
  assert.ok(read, "manager cannot read the scoped mailbox");
  const result = await rpc(3, "tools/call", { name: read.name, arguments: {} });
  assert.notEqual(result.isError, true);
  emit({ type: "text", part: { text: "native-coordination-ok" } });
}
emit({
  type: "text",
  ...(mode === "fallback" ? { sessionID: "ses_fixtureFallback" } : {}),
  part: { text: `native-partial:${process.pid} synthetic-opencode-provider-key` },
});
if (mode === "stream" || mode === "wait") {
  const deadline = Date.now() + 45_000;
  while (true) {
    try {
      await access(join(root, `release-${process.pid}`));
      break;
    } catch {}
    assert.ok(Date.now() < deadline, "fixture release timed out");
    await delay(10);
  }
}
if (mode === "missing-terminal" || mode === "fallback") process.exit(0);
emit({ type: "text", part: { text: `native-complete:${process.pid}` } });
emit({
  type: "step_finish",
  part: {
    reason: "stop",
    tokens: { input: 11, output: 5, reasoning: 0, cache: { read: 2, write: 0 } },
    cost: 0.0016,
  },
});

if (mode === "process-failure") process.exit(7);
