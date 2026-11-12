#!/usr/bin/env node
// Protocol fixture for the REAL Anthropic Agent SDK. No model or provider is contacted.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";

const args = process.argv.slice(2);
const arg = (name) => {
  const index = args.indexOf(name);
  return index < 0
    ? args.find((value) => value.startsWith(`${name}=`))?.slice(name.length + 1)
    : args[index + 1];
};
const resumed = arg("--resume");
const sessionId = resumed ?? randomUUID();
const config = process.env.CLAUDE_CONFIG_DIR;
const cwd = process.cwd();
const responses = new Map();
let hooks = [];
let sdkServers = [];
let started = false;
let waiting = false;
let waitingForInput = false;
let nativeChild;
const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
function requestControl(request) {
  const requestId = randomUUID();
  const promise = new Promise((resolve) => responses.set(requestId, resolve));
  send({ type: "control_request", request_id: requestId, request });
  return promise;
}
async function hook(tool, input, metadata = {}) {
  let denied = false;
  for (const callbackId of hooks) {
    const toolUseId = randomUUID();
    const response = await requestControl({
      subtype: "hook_callback",
      callback_id: callbackId,
      tool_use_id: toolUseId,
      input: {
        hook_event_name: "PreToolUse",
        session_id: sessionId,
        cwd,
        tool_name: tool,
        tool_input: input,
        tool_use_id: toolUseId,
        ...metadata,
      },
    });
    if (
      response.subtype !== "success" ||
      response.response?.hookSpecificOutput?.permissionDecision === "deny"
    )
      denied = true;
  }
  return !denied;
}

async function sdkMcp(method, params) {
  const response = await requestControl({
    subtype: "mcp_message",
    server_name: "supertag",
    message: { jsonrpc: "2.0", id: randomUUID(), method, params },
  });
  if (response.subtype !== "success" || !response.response?.mcp_response)
    throw new Error("SDK MCP server did not answer");
  return response.response.mcp_response;
}

async function objectiveQuestion(allowed) {
  const name = "mcp__supertag__ask";
  const metadata = { mcp_server: { name: "supertag", source: "sdk" } };
  const valid = { text: `  Confirm the target branch. ${process.env.ANTHROPIC_API_KEY}  ` };
  if (!allowed) {
    if (sdkServers.length || (await hook(name, valid, metadata)))
      throw new Error("Unadmitted Objective question was enabled");
    return "Objective question unavailable";
  }
  if (sdkServers.join() !== "supertag") throw new Error("Objective question server missing");
  const list = await sdkMcp("tools/list", {});
  if (
    list.result?.tools?.map(({ name }) => name).join() !== "ask" ||
    list.result.tools[0].inputSchema.additionalProperties !== false
  )
    throw new Error("SDK exposed an unexpected Objective tool or argument schema");

  for (const [tool, args, origin] of [
    [name, { text: "   " }, metadata],
    [name, { ...valid, objective_id: "other" }, metadata],
    [name, valid, { ...metadata, agent_id: "child" }],
    [name, valid, { mcp_server: { name: "supertag", source: "user" } }],
    [name, valid, {}],
    ["mcp__supertag__other", valid, metadata],
  ]) {
    if (await hook(tool, args, origin)) throw new Error("Unsupported Objective tool was allowed");
  }
  const malformed = await sdkMcp("tools/call", {
    name: "ask",
    arguments: { ...valid, task_id: "other" },
  });
  if (!malformed.error && !malformed.result?.isError)
    throw new Error("SDK accepted unexpected arguments");

  async function ask(input) {
    if (!(await hook(name, input, metadata))) throw new Error("Admitted Objective question denied");
    return sdkMcp("tools/call", { name: "ask", arguments: input });
  }
  const first = (await ask(valid)).result;
  const second = (await ask(valid)).result;
  if (
    first?.isError ||
    first?.content?.[0]?.text !== "Objective question recorded." ||
    JSON.stringify(first) !== JSON.stringify(second)
  )
    throw new Error("An exact Objective question replay did not return the same acknowledgment");
  const conflict = (await ask({ text: "A different question" })).result;
  if (!conflict?.isError || JSON.stringify(conflict).includes("private refusal details"))
    throw new Error("Objective question conflict was not returned safely");
  return first.content[0].text;
}
async function histories(path) {
  const files = [];
  for (const entry of await readdir(path, { withFileTypes: true }).catch(() => [])) {
    const next = join(path, entry.name);
    if (entry.isDirectory()) files.push(...(await histories(next)));
    else if (entry.name.endsWith(".jsonl")) files.push(await readFile(next, "utf8"));
  }
  return files;
}
const usage = {
  input_tokens: 10,
  cache_creation_input_tokens: 2,
  cache_read_input_tokens: 3,
  output_tokens: 4,
};
async function turn(message) {
  const prompt =
    typeof message.message.content === "string"
      ? message.message.content
      : message.message.content.map((part) => part.text ?? "").join("");
  if (
    process.env.SUPERTAG_CONTROLPLANE_TOKEN ||
    process.env.NODE_OPTIONS ||
    process.env.AWS_SECRET_ACCESS_KEY
  )
    throw new Error("Ambient service environment leaked");
  let previous = [];
  if (resumed) {
    previous = await histories(join(config, "projects"));
    if (!previous.some((text) => text.includes("fixture first turn")))
      throw new Error("Approved transcript was not materialized by the SDK");
  }
  send({
    type: "system",
    subtype: "init",
    session_id: sessionId,
    cwd,
    tools: [],
    mcp_servers: [],
    model: "fixture-claude",
    permissionMode: "dontAsk",
    slash_commands: [],
    apiKeySource: "none",
    uuid: randomUUID(),
  });
  if (prompt.includes("live-input")) {
    waitingForInput = true;
    return;
  }
  if (prompt.includes("wait")) {
    nativeChild = spawn(process.execPath, ["-e", "setInterval(()=>{}, 1000)"], {
      detached: true,
      stdio: "ignore",
      env: process.env,
    });
    nativeChild.unref();
    await writeFile(join(cwd, "native-child.pid"), `${nativeChild.pid}`);
    waiting = true;
    send({
      type: "assistant",
      session_id: sessionId,
      parent_tool_use_id: null,
      uuid: randomUUID(),
      message: {
        id: "waiting",
        type: "message",
        role: "assistant",
        model: "fixture-claude",
        content: [{ type: "text", text: "fixture waiting" }],
        usage,
      },
    });
    return;
  }
  let result = resumed ? "fixture resumed turn" : "fixture first turn";
  if (prompt.startsWith("objective-question"))
    result = await objectiveQuestion(prompt === "objective-question");
  if (message.uuid) result += `; input: ${prompt}`;
  if (prompt.includes("write")) {
    if (!(await hook("Write", { file_path: join(cwd, "answer.txt"), content: result })))
      throw new Error("Admitted write was denied");
    await writeFile(join(cwd, "answer.txt"), `${result}\n`);
  }
  if (prompt.includes("denied")) {
    if (await hook("Bash", { command: "touch escaped" }))
      throw new Error("Unadmitted Bash was allowed");
    if (await hook("Write", { file_path: join(cwd, "..", "escaped"), content: "escape" }))
      throw new Error("Outside write was allowed");
    result += "; unadmitted tools denied";
  }
  if (prompt.includes("secret")) result += ` ${process.env.ANTHROPIC_API_KEY}`;
  const entry = {
    type: "assistant",
    uuid: randomUUID(),
    sessionId,
    cwd,
    message: { role: "assistant", content: [{ type: "text", text: result }] },
  };
  const projectKey = cwd.replace(/[^a-zA-Z0-9]/g, "-");
  const project = join(config, "projects", projectKey);
  await mkdir(project, { recursive: true });
  send({
    type: "transcript_mirror",
    filePath: join(project, `${sessionId}.jsonl`),
    entries: [entry],
  });
  send({
    type: "assistant",
    ...(message.uuid ? { user_message_uuid: message.uuid } : {}),
    session_id: sessionId,
    parent_tool_use_id: null,
    uuid: entry.uuid,
    message: {
      id: "fixture-message",
      type: "message",
      role: "assistant",
      model: "fixture-claude",
      content: [{ type: "text", text: result }],
      usage,
    },
  });
  if (prompt.includes("mirror-failure"))
    send({
      type: "system",
      subtype: "mirror_error",
      session_id: sessionId,
      error: "fixture mirror failed",
    });
  send({
    type: "result",
    subtype: "success",
    result,
    is_error: false,
    session_id: sessionId,
    uuid: randomUUID(),
    duration_ms: 1,
    duration_api_ms: 1,
    num_turns: 1,
    total_cost_usd: 0.01,
    usage,
    modelUsage: {},
    permission_denials: [],
  });
}

const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.type === "control_response") {
    const callback = responses.get(message.response.request_id);
    responses.delete(message.response.request_id);
    callback?.(message.response);
  } else if (message.type === "control_request") {
    if (message.request.subtype === "initialize") {
      hooks = (message.request.hooks?.PreToolUse ?? []).flatMap(
        (matcher) => matcher.hookCallbackIds,
      );
      sdkServers = message.request.sdkMcpServers ?? [];
    }
    send({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: message.request_id,
        response: { commands: [], models: [], account: {}, output_style: "default" },
      },
    });
    if (message.request.subtype === "interrupt" && waiting) {
      // Deliberately leave the detached child for the adapter's process identity cleanup.
      setTimeout(() => process.exit(0), 10);
    }
  } else if (message.type === "user" && (!started || waitingForInput)) {
    started = true;
    waitingForInput = false;
    void turn(message).catch(async (error) => {
      await writeFile(join(cwd, "fixture-error.txt"), String(error));
      process.exitCode = 2;
      lines.close();
      process.stdin.destroy();
    });
  }
});
lines.on("close", () => {
  if (!waiting) process.exit(0);
});
