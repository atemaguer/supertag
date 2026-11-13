import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { access, appendFile, readdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(import.meta.url);
const fixture = dirname(script);
const key = "synthetic-cursor-provider-key";
for (const name of [
  "CURSOR_API_KEY",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "E2B_API_KEY",
  "E2B_DOMAIN",
  "SUPERTAG_E2B_TEMPLATE",
  "MODAL_TOKEN_ID",
  "MODAL_TOKEN_SECRET",
  "MODAL_SERVER_URL",
  "MODAL_CONFIG_PATH",
  "MODAL_ENVIRONMENT",
  "SUPERTAG_MODAL_WORKSPACE_APP",
  "SUPERTAG_MODAL_WORKSPACE_ENVIRONMENT",
  "SUPERTAG_MODAL_WORKSPACE_IMAGE",
  "SUPERTAG_GATEWAY_TOKEN",
  "SUPERTAG_OPERATOR_TOKEN",
  "SUPERTAG_HOST_TOKEN",
  "SUPERTAG_BOOTSTRAP_HOST_TOKEN",
  "SUPERTAG_PRIVATE_HARNESS_TOKEN",
  "SUPERTAG_EXECUTION_ADMIN_TOKEN",
  "SUPERTAG_WORKSPACE_DIRECTORY",
  "NODE_OPTIONS",
  "PYTHONPATH",
])
  assert.equal(process.env[name], undefined, `native process inherited ${name}`);

if (process.argv[2] === "--helper") {
  await writeFile(join(fixture, `helper-${process.argv[3]}.ready`), "ready", { mode: 0o600 });
  setInterval(() => {}, 1000);
} else {
  await runFixture();
}

async function waitFor(path) {
  const deadline = Date.now() + 25_000;
  for (;;) {
    if (
      await access(path).then(
        () => true,
        () => false,
      )
    )
      return;
    assert.ok(Date.now() < deadline, "fixture barrier timed out");
    await delay(15);
  }
}

async function runFixture() {
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const pending = new Map();
  let serial = 0;
  let helper;
  let helperExit;
  let execution;

  const emit = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
  const text = (value) =>
    emit({
      type: "event",
      event: { type: "assistant", message: { content: [{ type: "text", text: value }] } },
    });
  const trace = (value) =>
    appendFile(join(fixture, "calls.jsonl"), `${JSON.stringify(value)}\n`, {
      mode: 0o600,
    });
  const call = (name, value) =>
    new Promise((resolve) => {
      const id = `call-${++serial}`;
      pending.set(id, resolve);
      emit({ type: "workspace_call", id, name, input: value });
    });

  async function execute(frame) {
    assert.ok(frame.apiKey === key, "runner did not receive its key on stdin");
    const request = frame.request;
    assert.equal(request.model, "fixture-model");
    assert.ok(!request.prompt.includes(key));
    const current = request.prompt.replace(/<supertag-history>[\s\S]*?<\/supertag-history>/gu, "");
    const mode = /fixture:([a-z-]+)/u.exec(current)?.[1];
    assert.ok(
      [
        "first",
        "resume",
        "remote-first",
        "remote-resume",
        "remote-output-auto",
        "remote-output-declared",
        "remote-output-empty",
        "remote-output-missing",
        "remote-output-readonly",
        "remote-output-cap",
        "remote-output-tracked",
        "remote-output-git-capture",
        "remote-output-git-reference",
        "remote-input-producer",
        "remote-input-consumer",
        "remote-mcp",
        "shared-first",
        "shared-resume",
        "shared-command",
        "baseline",
        "cancel",
        "after-cancel",
      ].includes(mode),
    );
    const shared = mode.startsWith("shared-");
    const sharedCommand = mode === "shared-command";
    const output = mode.startsWith("remote-output-");
    const writes = mode === "first" || mode === "remote-first" || mode === "shared-first";
    const remoteInputs = mode.startsWith("remote-input-");
    const remoteMcp = mode === "remote-mcp";
    const writable =
      writes ||
      shared ||
      remoteInputs ||
      remoteMcp ||
      (output && mode !== "remote-output-readonly");
    const resumes = mode === "resume" || mode === "remote-resume" || mode === "shared-resume";
    assert.deepEqual(request.tools, ["mcp"]);
    for (const name of ["read", "edit", "shell", "grep", "glob", "ls", "task"])
      assert.ok(request.disallowedTools.includes(name), `native SDK tool ${name} is not denied`);
    assert.equal(request.localCommandTool, undefined);
    const toolNames = request.splitTools.map(({ name }) => name);
    assert.ok(toolNames.includes("read"));
    assert.equal(toolNames.includes("write"), writable);
    assert.equal(toolNames.includes("edit"), writable && !shared);
    assert.equal(toolNames.includes("command"), mode === "first" || sharedCommand);
    if (shared)
      assert.deepEqual(
        toolNames.sort(),
        sharedCommand ? ["command", "read", "write"] : ["read", "write"],
      );

    const cwd = await realpath(request.workspace);
    assert.notEqual(cwd, await realpath(process.cwd()));
    assert.equal(cwd, join(dirname(request.storeDirectory), "workspace"));
    assert.deepEqual(await readdir(cwd), []);
    assert.equal((await stat(cwd)).mode & 0o777, 0o700);
    assert.ok(process.env.HOME);

    const agentId = request.resumeAgentId ?? request.agentId;
    assert.match(agentId, /^agent-[\w-]+$/u);
    const agentsFile = join(request.storeDirectory, "agents.ndjson");
    let restoredFrom;
    if (resumes || mode === "remote-input-consumer" || ["cancel", "after-cancel"].includes(mode)) {
      assert.ok(request.resumeAgentId, "expected native Session restore");
      const agents = (await readFile(agentsFile, "utf8")).trim().split("\n").map(JSON.parse);
      const agent = agents.find((entry) => entry.agentId === agentId);
      assert.equal(agent?.cwd, cwd, "restored agent was not retargeted to this native cwd");
      restoredFrom = agent?.fixtureTurn;
      if (mode === "remote-input-consumer") {
        assert.ok(["remote-input-producer", mode].includes(restoredFrom));
      } else {
        assert.equal(restoredFrom, resumes ? mode.replace("resume", "first") : "baseline");
      }
    } else {
      assert.equal(request.resumeAgentId, undefined);
    }

    if (mode === "cancel") {
      helper = spawn(process.execPath, [script, "--helper", String(process.pid)], {
        detached: true,
        stdio: "ignore",
      });
      helperExit = once(helper, "exit");
      await trace({ type: "helper", helperPid: helper.pid });
      await waitFor(join(fixture, `helper-${process.pid}.ready`));
    }
    await trace({
      type: "started",
      mode,
      pid: process.pid,
      helperPid: helper?.pid,
      agentId,
      restoredFrom,
      cwd,
      home: process.env.HOME,
      toolNames,
    });
    emit({ type: "agent", agentId });
    // Cursor SDK activity, which the bridge reports as a `progress.updated` Task event.
    emit({ type: "event", event: { type: "thinking" } });

    const existing = await call("read", { file_path: "workspace.txt" });
    assert.equal(existing.isError, false, "admitted Workspace read failed");
    assert.ok(existing.text.includes(resumes ? "first-turn-content" : "initial-content"));
    assert.equal((await call("read", { file_path: "../outside.txt" })).isError, true);
    const command = await call("command", {
      command:
        'test -z "$CURSOR_API_KEY$OPENAI_API_KEY$SUPERTAG_HOST_TOKEN$SUPERTAG_OPERATOR_TOKEN$SUPERTAG_EXECUTION_ADMIN_TOKEN" && printf cursor-command-safe' +
        (sharedCommand ? " && sleep 6" : ""),
    });
    assert.equal(command.isError, !(mode === "first" || sharedCommand));
    if (mode === "first" || sharedCommand) assert.ok(command.text.includes("cursor-command-safe"));
    if (sharedCommand) {
      const blocked = await call("command", {
        command: "/usr/bin/setsid /bin/sh -c 'echo $$ > lease.pid; exec /bin/sleep 60' & wait",
        timeout: 50_000,
      });
      assert.equal(blocked.isError, true);
    }
    if (remoteMcp) {
      // The Task rewrites the server, its marker, and .mcp.json in its own checkout.
      for (const [file_path, content] of [
        ["marker.txt", "task\n"],
        ["mcp-server.js", "process.exit(7);\n"],
        [".mcp.json", '{"mcpServers":{"tools":{"command":"sh","args":["-c","exit 7"]}}}'],
      ])
        assert.equal((await call("write", { file_path, content })).isError, false);
      const servers = request.mcpServers;
      // Only the Task's granted server joins the Worker Host's own coordination server.
      assert.deepEqual(
        Object.keys(servers).filter((name) => name !== "supertag"),
        ["tools"],
      );
      const server = servers.tools;
      assert.equal(server.type, "http");
      assert.match(server.url, /^http:\/\/127\.0\.0\.1:\d+\/mcp\/tools$/u);
      // The harness sees neither the command nor where it runs.
      assert.ok(!JSON.stringify(server).includes("mcp-server.js"));
      let session;
      let id = 0;
      const rpc = async (method, params, notification = false) => {
        const response = await fetch(server.url, {
          method: "POST",
          headers: {
            ...server.headers,
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            ...(session ? { "mcp-session-id": session } : {}),
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            method,
            params,
            ...(notification ? {} : { id: ++id }),
          }),
        });
        session ??= response.headers.get("mcp-session-id") ?? undefined;
        if (notification) return undefined;
        assert.equal(response.status, 200);
        const body = await response.json();
        assert.equal(body.error, undefined, JSON.stringify(body.error));
        return body.result;
      };
      await rpc("initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "cursor-fixture", version: "1" },
      });
      await rpc("notifications/initialized", {}, true);
      const listed = (await rpc("tools/list", {})).tools.map(({ name }) => name);
      const tool = async (name) => {
        const result = await rpc("tools/call", { name, arguments: {} });
        return { isError: result.isError === true, text: result.content?.[0]?.text };
      };
      const first = await tool("read_marker");
      const approval = await tool("write_note");
      const hidden = await tool("hidden");
      const again = await tool("read_marker");
      await trace({
        type: "mcp",
        listed,
        toolNames: server.toolNames,
        first,
        approval,
        hidden,
        again,
      });
    } else if (mode === "remote-input-consumer") {
      const evidence =
        /inputs\/[0-9a-f]{64}\/artifact-[0-9a-f]{64}\/(?:[\w-]+\/)*evidence\.txt/u.exec(
          request.prompt,
        )?.[0];
      assert.ok(evidence, "accepted artifact path is missing from the native prompt");
      const read = await call("read", { file_path: evidence });
      assert.equal(read.isError, false);
      assert.equal(read.text, "remote staged evidence\n");
      const write = await call("write", { file_path: evidence, content: "must not overwrite" });
      assert.equal(write.isError, true);
    } else if (mode === "remote-input-producer") {
      const directory = /Task output directory: ([\w/-]+)/u.exec(request.prompt)?.[1];
      assert.ok(directory);
      const write = await call("write", {
        file_path: `${directory}/evidence.txt`,
        content: "remote staged evidence\n",
      });
      assert.equal(write.isError, false);
    } else if (output) {
      const directory = /Task output directory: ([\w/-]+)/u.exec(request.prompt)?.[1];
      assert.ok(directory, "the remote output path did not reach the model");
      assert.equal(process.env.SUPERTAG_OUTPUT_DIR, undefined);
      const writeOutput = async (file_path, content) => {
        const write = await call("write", { file_path, content });
        assert.equal(write.isError, !writable);
      };
      if (mode === "remote-output-auto") {
        assert.match(directory, /^outputs\/[0-9a-f]{64}$/u);
        await writeOutput(`${directory}/report.txt`, "frozen remote output\n");
        await writeOutput(`${directory}/.env`, "must not become an artifact\n");
      } else if (mode === "remote-output-declared") {
        assert.equal(directory, "deliverables");
        await writeOutput("reports/report.txt", "declared outside the default directory\n");
        await writeOutput(`${directory}/included.txt`, "declared inside\n");
        await writeOutput(`${directory}/private/skip.txt`, "excluded\n");
      } else if (mode.startsWith("remote-output-git-")) {
        await writeOutput("workspace.txt", "dirty remote output\n");
        await writeOutput(`${directory}/new.txt`, "new remote output\n");
      } else if (mode === "remote-output-readonly") {
        await writeOutput(`${directory}/not-permitted.txt`, "denied\n");
      } else if (mode === "remote-output-cap") {
        await writeOutput(`${directory}/oversized.txt`, "larger than accepted budget\n");
      }
    } else {
      const write = await call("write", {
        file_path: "workspace.txt",
        content: "first-turn-content\n",
      });
      assert.equal(write.isError, !writable);
    }

    for (const name of ["agents.ndjson", "runs.ndjson", "run_events.ndjson", "checkpoints.ndjson"])
      await writeFile(
        join(request.storeDirectory, name),
        `${JSON.stringify({
          agentId,
          cwd,
          fixtureTurn: mode,
        })}\n`,
        { mode: 0o600 },
      );
    text(`cursor-stream:${mode} ${key.slice(0, 13)}`);
    text(key.slice(13));
    if (writes && !shared) await waitFor(join(fixture, `release-${process.pid}`));
    if (mode === "cancel") return;

    const usage = {
      inputTokens: 7,
      cacheReadTokens: 2,
      cacheWriteTokens: 1,
      outputTokens: 5,
      totalTokens: 15,
    };
    emit({ type: "event", event: { type: "usage", usage } });
    emit({
      type: "result",
      status: "finished",
      result: `cursor-complete:${mode} ${key}`,
      model: "fixture-model",
      chargedCents: 6,
      usage,
    });
  }

  for await (const line of input) {
    const frame = JSON.parse(line);
    if (frame.type === "start") {
      assert.equal(execution, undefined);
      execution = execute(frame).catch(async (error) => {
        const message = String(error.message ?? error)
          .replaceAll(key, "[REDACTED]")
          .slice(0, 800);
        await trace({ type: "error", message });
        emit({ type: "error", code: "CURSOR_FIXTURE_FAILED", message });
        process.exitCode = 1;
        input.close();
      });
    } else if (frame.type === "workspace_result") {
      const settle = pending.get(frame.id);
      if (settle) {
        pending.delete(frame.id);
        settle(frame);
      }
    } else if (frame.type === "cancel") {
      await trace({ type: "cancel", pid: process.pid });
    } else if (frame.type === "close") {
      await execution;
      await helperExit;
      input.close();
      break;
    } else {
      throw new Error("unknown Cursor fixture frame");
    }
  }
  await execution;
}
