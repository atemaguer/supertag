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
let initialized = {};
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

async function coordinationCall(tool, input) {
  const metadata = { mcp_server: { name: "supertag", source: "sdk" } };
  if (!(await hook(`mcp__supertag__${tool}`, input, metadata)))
    throw new Error(`Admitted ${tool} denied`);
  return (await sdkMcp("tools/call", { name: tool, arguments: input })).result;
}

async function directMailbox() {
  const tools = (await sdkMcp("tools/list", {})).result?.tools;
  if (tools?.map(({ name }) => name).join() !== "send_message")
    throw new Error("Unexpected direct Mailbox tool inventory");
  const result = await coordinationCall("send_message", {
    to: "lead",
    text: ` Private note ${process.env.ANTHROPIC_API_KEY} `,
  });
  if (result.isError || JSON.parse(result.content[0].text).messageId !== "direct-receipt")
    throw new Error("Private message receipt missing");
  return "fixture sent a direct message";
}

async function inspectSkillPackage() {
  const plugin = initialized.plugins?.[0];
  const root = plugin?.path ?? arg("--plugin-dir-no-mcp");
  const qualified = "supertag-context:release-runbook";
  if (!root || (plugin && !plugin.skipMcpDiscovery))
    throw new Error("Expected a Skill-only plugin");
  if (initialized.skills?.join() !== qualified)
    throw new Error(`Unexpected native Skill selection: ${JSON.stringify(initialized.skills)}`);
  const packages = await readdir(join(root, "skills"));
  if (packages.length !== 1) throw new Error("Unexpected number of Skill packages");
  const markdown = await readFile(join(root, "skills", packages[0], "SKILL.md"), "utf8");
  if (!markdown.includes("Use the release checklist.")) throw new Error("Expected pinned Skill");
  if (!(await hook("Skill", { skill: qualified }))) throw new Error("Admitted Skill denied");
  if (await hook("Skill", { skill: "ambient" })) throw new Error("Ambient Skill allowed");
  const reference = join(root, "skills", packages[0], "reference.md");
  if (!(await hook("Read", { file_path: reference }))) throw new Error("Skill reference denied");
  if ((await readFile(reference, "utf8")) !== "Pinned checklist details.")
    throw new Error("Skill reference was not pinned");
  if (await hook("Write", { file_path: reference, content: "changed" }))
    throw new Error("Skill package writable");
  if (await hook("Read", { file_path: join(root, ".claude-plugin", "plugin.json") }))
    throw new Error("Adapter state readable");
  if (await hook("Bash", { command: "echo unintended" })) throw new Error("Skill widened tools");
  return "fixture verified Skill package";
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

async function coordinationTools(workstream) {
  const metadata = { mcp_server: { name: "supertag", source: "sdk" } };
  const list = (await sdkMcp("tools/list", {})).result?.tools;
  const expected = workstream ? ["post", "read_mailbox", "read_workstream"] : ["read_mailbox"];
  if (
    sdkServers.join() !== "supertag" ||
    list
      ?.map(({ name }) => name)
      .sort()
      .join() !== expected.join() ||
    list.some(({ inputSchema }) => inputSchema.additionalProperties !== false)
  )
    throw new Error("Wrong coordination tool allowlist");
  const call = coordinationCall;
  const secret = process.env.ANTHROPIC_API_KEY;
  const mailbox = await call(
    "read_mailbox",
    workstream ? { limit: 3, cursor: "previous-mail" } : {},
  );
  const mailText = mailbox?.content?.[0]?.text ?? "";
  if (
    mailbox?.isError ||
    JSON.parse(mailText).trust !== "untrusted" ||
    !mailText.includes("Untrusted Mailbox text [REDACTED]") ||
    mailText.includes(secret)
  )
    throw new Error("Mailbox read was not safely presented");
  if (!workstream) {
    if (await hook("mcp__supertag__post", { text: "unexpected" }, metadata))
      throw new Error("Workstream tool was allowed without its capability");
    return "Mailbox only";
  }
  for (const [name, input, provenance] of [
    ["Bash", { command: "echo unwanted" }, {}],
    ["mcp__supertag__post", { text: "arbitrary Team", team_id: "elsewhere" }, metadata],
    ["mcp__supertag__post", { text: "child" }, { ...metadata, agent_id: "child" }],
    [
      "mcp__supertag__post",
      { text: "forged" },
      { mcp_server: { name: "supertag", source: "user" } },
    ],
    ["mcp__supertag__read_mailbox", { limit: 1, tag: "somebody-else" }, metadata],
  ]) {
    if (await hook(name, input, provenance)) throw new Error("Out-of-scope coordination allowed");
  }
  const timeline = await call("read_workstream", { limit: 2, afterSequence: "5" });
  const timelineText = timeline?.content?.[0]?.text ?? "";
  if (
    timeline?.isError ||
    JSON.parse(timelineText).trust !== "untrusted" ||
    !timelineText.includes("Untrusted Workstream text [REDACTED]") ||
    timelineText.includes(secret)
  )
    throw new Error("Workstream read was not safely presented");
  for (const [tool, cursor] of [
    ["read_workstream", "s7"],
    ["read_mailbox", "wrong-audience"],
  ]) {
    const invalid = await call(tool, { cursor });
    if (!invalid?.isError || invalid.content[0].text.includes("Untrusted"))
      throw new Error("A read returned a record from the wrong audience");
  }
  const text = `Pending post ${secret}`;
  for (const to of [
    ["lead", "builder", "lead"],
    ["builder", "lead"],
  ]) {
    const result = await call("post", { text: ` ${text} `, to });
    if (result?.isError || JSON.parse(result.content[0].text).status !== "pending")
      throw new Error("Workstream post did not ask for approval");
  }
  if (!(await call("post", { text: "Denied post" }))?.isError)
    throw new Error("Denied approval appeared to succeed");
  if (!(await call("post", { text: "Wrong receipt" }))?.isError)
    throw new Error("An approval for another Attempt appeared to succeed");
  const pending = await call("post", { text: "Confirmed post" });
  if (pending?.isError || JSON.parse(pending.content[0].text).status !== "pending")
    throw new Error("Expected a pending receipt before the post");
  const posted = await call("post", { text: "Confirmed post" });
  if (posted?.isError || JSON.parse(posted.content[0].text).status !== "posted")
    throw new Error("Workstream post receipt missing");
  return "Coordination complete";
}

async function workSessionTools() {
  const tools = (await sdkMcp("tools/list", {})).result?.tools;
  if (
    tools?.map(({ name }) => name).join() !== "start_session" ||
    tools[0].inputSchema.additionalProperties !== false
  )
    throw new Error("Unexpected Work Session tool or argument schema");
  const input = {
    title: "  Investigate   release  ",
    instruction: ` Inspect the pinned checkout ${process.env.ANTHROPIC_API_KEY} `,
    workspace: "release",
    tag: "actor",
  };
  const metadata = { mcp_server: { name: "supertag", source: "sdk" } };
  for (const [arguments_, origin] of [
    [{ ...input, attemptId: "forged" }, metadata],
    [{ ...input, title: " " }, metadata],
    [{ ...input, instruction: "x".repeat(8001) }, metadata],
    [input, { ...metadata, agent_id: "untrusted-child" }],
    [input, { mcp_server: { name: "supertag", source: "external" } }],
  ]) {
    if (await hook("mcp__supertag__start_session", arguments_, origin))
      throw new Error("Work Session tool accepted invalid arguments or origin");
  }
  const malformed = await sdkMcp("tools/call", {
    name: "start_session",
    arguments: { ...input, leaseToken: "forged" },
  });
  if (!malformed.error && !malformed.result?.isError)
    throw new Error("Work Session MCP schema accepted injected authority");
  const ids = new Set();
  for (let count = 0; count < 2; count++) {
    const result = await coordinationCall("start_session", input);
    const receipt = JSON.parse(result.content[0].text);
    if (
      result.isError ||
      receipt.status !== "accepted" ||
      !receipt.workSessionId.startsWith("work/") ||
      receipt.taskId !== "child-task" ||
      Object.keys(receipt).sort().join() !== "status,taskId,workSessionId"
    )
      throw new Error("Work Session returned an invalid provider receipt");
    ids.add(receipt.workSessionId);
  }
  if (ids.size !== 2) throw new Error("Distinct Work Session requests shared a receipt");
  for (const title of ["Wrong starter", "Wrong parent", "Wrong target", "Wrong child"]) {
    const result = await coordinationCall("start_session", { ...input, title });
    if (!result.isError || result.content[0].text.includes("other-"))
      throw new Error("Work Session tool exposed an unverified receipt");
  }
  return "fixture started two Work Sessions";
}

async function approvalAndQuestion(order) {
  const ask = () => coordinationCall("ask", { text: "Which branch should I use?" });
  const post = () => coordinationCall("post", { text: "Pending post" });
  if (order === "ask-first") {
    if (
      (await ask())?.content?.[0]?.text !== "Objective question recorded." ||
      !(await post())?.isError
    )
      throw new Error("A Workstream approval was possible after asking an Objective question");
  } else {
    const first = await post();
    if (
      first?.isError ||
      JSON.parse(first.content[0].text).status !== "pending" ||
      !(await ask())?.isError
    )
      throw new Error("An Objective question was possible while a Workstream approval was pending");
  }
  const work = await coordinationCall("start_session", {
    title: "Blocked",
    instruction: "Should wait for the operator",
  });
  if (!work?.isError) throw new Error("Work Session started while operator action was pending");
  return "Coordination kept one wait";
}

async function processCoordination(prompt) {
  const body = "The SDK fixture verified the release.";
  if (prompt.startsWith("This is this Tag's inbox.")) {
    const result = await coordinationCall("read_mailbox", {});
    const page = JSON.parse(result.content[0].text);
    if (
      result.isError ||
      page.trust !== "untrusted" ||
      page.messages.length !== 1 ||
      page.messages[0].from !== "claude" ||
      page.messages[0].text !== body ||
      !prompt.includes(body)
    )
      throw new Error("Addressed Workstream post did not arrive in the Mailbox");
    return "SDK fixture handled the addressed post";
  }
  const timeline = await coordinationCall("read_workstream", { afterSequence: 0 });
  const page = JSON.parse(timeline.content[0].text);
  if (
    timeline.isError ||
    page.trust !== "untrusted" ||
    page.team.id !== "release" ||
    page.posts.length !== 0
  )
    throw new Error("Initial Workstream scope was not the empty release Team");
  const post = () => coordinationCall("post", { text: body, to: ["recipient"] });
  const first = await post();
  const receipt = JSON.parse(first.content[0].text);
  if (prompt === "Process fixture Workstream approval") {
    if (resumed || first.isError || receipt.status !== "pending" || !receipt.approvalId)
      throw new Error("A post was visible before approval");
    return "fixture first turn awaiting Workstream approval";
  }
  if (!resumed || first.isError || receipt.status !== "posted" || receipt.duplicate)
    throw new Error("Approved post did not apply from the continued native Session");
  const again = await post();
  const duplicate = JSON.parse(again.content[0].text);
  if (again.isError || !duplicate.duplicate || duplicate.postId !== receipt.postId)
    throw new Error("Exact Workstream replay added another post");
  const refreshed = await coordinationCall("read_workstream", { afterSequence: 0 });
  const history = JSON.parse(refreshed.content[0].text);
  if (
    refreshed.isError ||
    history.posts.length !== 1 ||
    history.posts[0].id !== receipt.postId ||
    history.posts[0].text !== body
  )
    throw new Error("Workstream read did not show the single approved post");
  return "fixture resumed and posted one update";
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
  if (prompt.startsWith("coordination-"))
    result = await coordinationTools(prompt === "coordination-tools");
  if (prompt === "direct-mailbox") result = await directMailbox();
  if (prompt === "start-work-session") result = await workSessionTools();
  if (prompt === "work-session-disabled") {
    if (
      await hook(
        "mcp__supertag__start_session",
        { title: "Disallowed", instruction: "No capability" },
        { mcp_server: { name: "supertag", source: "sdk" } },
      )
    )
      throw new Error("Work Session capability was not required");
  }
  if (prompt === "inspect-skill-package") result = await inspectSkillPackage();
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
  if (prompt === "required-context-fixture")
    await writeFile(join(cwd, "native-started"), "started");
  if (prompt === "model-policy-fixture") result = `fixture model ${arg("--model")}`;
  if (prompt.startsWith("mixed-tools-"))
    result = await approvalAndQuestion(prompt.slice("mixed-tools-".length));
  if (
    prompt === "Process fixture Workstream approval" ||
    prompt.startsWith("The operator decided the approval requests") ||
    prompt.startsWith("This is this Tag's inbox.")
  )
    result = await processCoordination(prompt);
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
      initialized = message.request;
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
        response: {
          commands: (initialized.skills ?? []).map((name) => ({
            name,
            description: "",
            argumentHint: "",
          })),
          ...(initialized.plugins?.length ? { plugins_applied: true, hooks_applied: true } : {}),
          models: [],
          account: {},
          output_style: "default",
        },
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
