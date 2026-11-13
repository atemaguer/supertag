import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { Code, createControlPlaneClient } from "supertag-ai/control-plane-client";
import { openHarness, TaskState } from "supertag-ai/harness";

const token = "fixture-operator-token";
const hostToken = "fixture-worker-host-credential-12345";
const execute = promisify(execFile);
const loopback = "http://127.0.0.1:3434";
for (const url of [
  "https://user:pass@control-plane.invalid",
  "https://control-plane.invalid/path",
  `${loopback}\n`,
]) {
  assert.throws(() => createControlPlaneClient({ url, token }), /origin/);
}
assert.throws(
  () => createControlPlaneClient({ url: "http://control-plane.invalid", token }),
  /loopback/,
);
assert.throws(
  () => createControlPlaneClient({ url: loopback, token: `${token}\n` }),
  /operator token/,
);
const closed = createControlPlaneClient({ url: loopback, token });
assert.equal(typeof closed.operator.listTags, "function");
assert.equal(typeof closed.events.watch, "function");
closed.close();
await assert.rejects(async () => closed.operator.listTags({}), /closed/);
await assert.rejects(openHarness((async function* () {})()), /bootstrap/);
console.log("Control Plane client public package import passed.");

async function verifyRuntime(binary) {
  const root = await mkdtemp(join(tmpdir(), "supertag-control-plane-client-"));
  const children = [];
  const env = {
    SUPERTAG_DATABASE_URL: `sqlite://${join(root, "control.sqlite")}?mode=rwc`,
    SUPERTAG_GATEWAY_TOKEN: "fixture-private-gateway-token",
    SUPERTAG_OPERATOR_TOKEN: token,
    SUPERTAG_BOOTSTRAP_HOST_TOKEN: hostToken,
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
    const url = await start(["control-plane"]);
    const wrong = createControlPlaneClient({ url, token: "invalid-fixture-token" });
    try {
      await assert.rejects(wrong.operator.listTags({}, { timeoutMs: 3000 }), {
        code: Code.Unauthenticated,
      });
    } finally {
      wrong.close();
    }

    client = createControlPlaneClient({ url, token });
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
      prompt: "Verify the installed Control Plane client.",
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
    console.log("Control Plane authorization, Task replay, and streaming passed.");

    const adapter = join(root, "adapter.mjs");
    const harnessImport = import.meta.resolve("supertag-ai/harness");
    await writeFile(
      adapter,
      `import { EffectReceiptState, openHarness, receipt } from ${JSON.stringify(harnessImport)};
const harness = await openHarness(process.stdin);
try {
  const run = await receipt(() => harness.client.attach({}));
  if (!run.task || process.env.SUPERTAG_HOST_TOKEN) throw new Error("invalid execution scope");
  // Worker-managed effect receipts: a completed effect replays, an unsettled one is in doubt.
  const effect = { idempotencyKey: "ticket/1", operation: "create_ticket", argumentsJson: '{"title":"Release"}' };
  const begun = await harness.effects.begin(effect);
  if (begun.state !== EffectReceiptState.ACQUIRED) throw new Error("effect was not acquired");
  await harness.effects.complete({ ...effect, resultJson: '{"ticket":"T-1"}' });
  const replay = await harness.effects.begin(effect);
  if (replay.state !== EffectReceiptState.COMPLETED || !replay.replayed || replay.resultJson !== '{"ticket":"T-1"}')
    throw new Error("completed effect did not replay");
  const unsettled = { ...effect, idempotencyKey: "ticket/2" };
  await harness.effects.begin(unsettled);
  if ((await harness.effects.begin(unsettled)).state !== EffectReceiptState.IN_DOUBT)
    throw new Error("unsettled effect was not in doubt");
  const result = "Installed Node harness for " + run.task.tagId;
  const event = { sequence: 1n, text: result };
  await receipt(() => harness.client.publish(event));
  await receipt(() => harness.client.publish(event));
  await receipt(() => harness.client.complete({ succeeded: true, result }));
} finally {
  harness.close();
}`,
      { mode: 0o600 },
    );
    await execute(
      binary,
      [
        "worker-host",
        "--control-plane",
        url,
        "--state-directory",
        join(root, "host"),
        "--adapter",
        process.execPath,
        "--adapter-arg",
        adapter,
        "--once",
      ],
      { env: { SUPERTAG_HOST_TOKEN: hostToken, PATH: "/usr/bin:/bin" }, timeout: 30_000 },
    );
    const task = await client.operator.getTask({ taskId: accepted.taskId }, { timeoutMs: 3000 });
    assert.equal(task.state, TaskState.SUCCEEDED);
    assert.equal(task.result, "Installed Node harness for node-sdk");
    const events = await client.operator.listEvents(
      { taskId: accepted.taskId },
      { timeoutMs: 3000 },
    );
    assert.equal(events.events.filter((event) => event.text === task.result).length, 1);
    console.log(
      "Installed Node harness executed one Task with an exact event replay and effect receipts.",
    );
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
