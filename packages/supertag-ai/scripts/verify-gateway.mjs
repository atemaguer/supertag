import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { Code, createGatewayClient } from "supertag-ai/gateway";

const token = "fixture-operator-token";
const loopback = "http://127.0.0.1:3434";
for (const url of [
  "https://user:pass@gateway.invalid",
  "https://gateway.invalid/path",
  `${loopback}\n`,
]) {
  assert.throws(() => createGatewayClient({ url, token }), /origin/);
}
assert.throws(() => createGatewayClient({ url: "http://gateway.invalid", token }), /loopback/);
assert.throws(() => createGatewayClient({ url: loopback, token: `${token}\n` }), /operator token/);
const closed = createGatewayClient({ url: loopback, token });
assert.equal(typeof closed.operator.listTags, "function");
assert.equal(typeof closed.events.watch, "function");
closed.close();
await assert.rejects(async () => closed.operator.listTags({}), /closed/);
console.log("Gateway public package import passed.");

async function verifyRuntime(binary) {
  const root = await mkdtemp(join(tmpdir(), "supertag-gateway-client-"));
  const children = [];
  const env = {
    SUPERTAG_DATABASE_URL: `sqlite://${join(root, "control.sqlite")}?mode=rwc`,
    SUPERTAG_GATEWAY_TOKEN: "fixture-private-gateway-token",
    SUPERTAG_OPERATOR_TOKEN: token,
  };
  const abort = new AbortController();
  let client;
  try {
    async function start(args) {
      const child = spawn(binary, args, { env, stdio: ["ignore", "pipe", "inherit"] });
      children.push(child);
      const lines = createInterface({ input: child.stdout });
      const [endpoint] = await once(lines, "line", { signal: AbortSignal.timeout(10_000) });
      assert.match(endpoint, /^127\.0\.0\.1:[1-9][0-9]*$/u);
      return `http://${endpoint}`;
    }
    const control = await start(["control-plane"]);
    const url = await start(["gateway", "--control-plane", control]);
    const wrong = createGatewayClient({ url, token: "invalid-fixture-token" });
    try {
      await assert.rejects(wrong.operator.listTags({}, { timeoutMs: 3000 }), {
        code: Code.Unauthenticated,
      });
    } finally {
      wrong.close();
    }

    client = createGatewayClient({ url, token });
    await assert.rejects(
      client.artifactPublications.listPublications({ objectiveId: "unknown" }, { timeoutMs: 3000 }),
      { code: Code.NotFound },
    );
    const watch = client.events
      .watch({}, { signal: abort.signal, timeoutMs: 10_000 })
      [Symbol.asyncIterator]();
    const first = (await watch.next()).value;
    assert.equal(first.update.case, "heartbeat");
    const tag = await client.operator.putTag(
      { tagId: "node-sdk", instructions: "Build release notes." },
      { timeoutMs: 3000 },
    );
    const change = (await watch.next()).value;
    assert.equal(change.update.value.id, tag.tagId);
    assert.notEqual(change.resumeToken, first.resumeToken);

    const submission = {
      tagId: tag.tagId,
      sessionId: "fixture",
      operationId: "sdk-conformance",
      prompt: "Verify the installed Gateway client.",
    };
    const accepted = await client.operator.submitTask(submission, { timeoutMs: 3000 });
    const replay = await client.operator.submitTask(submission, { timeoutMs: 3000 });
    assert.ok(accepted.taskId);
    assert.equal(replay.taskId, accepted.taskId);
    const missing = client.downloadArtifactFile(
      { artifactId: "unknown", path: "evidence.txt" },
      { timeoutMs: 3000 },
    );
    await assert.rejects(async () => missing[Symbol.asyncIterator]().next(), {
      code: Code.NotFound,
    });
    console.log("Gateway authorization, Task replay, and streaming passed.");
  } finally {
    abort.abort();
    client?.close();
    for (const child of children.reverse()) {
      if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) continue;
      const stopped = once(child, "exit");
      child.kill();
      await Promise.race([stopped, delay(5000, undefined, { ref: false })]);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await stopped;
      }
    }
    await rm(root, { recursive: true, force: true });
  }
}

if (process.env.SUPERTAG_RUST_TEST_CLI) await verifyRuntime(process.env.SUPERTAG_RUST_TEST_CLI);
