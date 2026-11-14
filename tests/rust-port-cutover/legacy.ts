/** Synthetic fixture driven only against an isolated, exact legacy source snapshot. */
import { strict as assert } from "node:assert";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { ControlPlane } from "../../packages/control-plane/src/index.ts";
import {
  COORDINATION_CAPABILITY,
  DurableLocalWorklet,
  FileAttemptJournal,
  FileSessionStateStore,
  SURFACE_COORDINATION_CAPABILITY,
  type Worklet,
} from "../../packages/runtime/sdk/src/index.ts";
import {
  DrizzleStore,
  FileGatewayCredentialVault,
  migrateDatabase,
} from "../../packages/store/src/index.ts";

const [action, directory, connectionFile] = process.argv.slice(2);
if (!directory || !connectionFile || !["seed", "restore"].includes(action ?? ""))
  throw new Error("Use seed|restore with a disposable directory and private database binding file");
const url = (await readFile(connectionFile, "utf8")).trim();
const capabilities = [COORDINATION_CAPABILITY, SURFACE_COORDINATION_CAPABILITY];
let executions = 0;
const worklet: Worklet = {
  id: "synthetic-cutover-worklet",
  async describe() {
    return {
      id: this.id,
      protocolVersion: 1,
      host: {
        id: "synthetic-cutover-host",
        workers: [
          {
            id: "synthetic-worker",
            type: "cutover-fixture",
            profiles: [{ id: "default", revision: "1" }],
            capabilities,
            contextTypes: [],
            maxConcurrency: 1,
            profileCapabilities: [
              { profile: { id: "default", revision: "1" }, capabilities, contextTypes: [] },
            ],
          },
        ],
      },
    };
  },
  selectPlacement: async () => ({
    workerHostId: "synthetic-cutover-host",
    workletId: "synthetic-cutover-worklet",
    workerId: "synthetic-worker",
    workerProfile: { id: "default", revision: "1" },
  }),
  async *execute(spec) {
    executions++;
    const identity = {
      taskId: spec.taskId,
      attemptId: spec.attemptId,
      at: new Date().toISOString(),
    };
    yield { ...identity, type: "execution.started", workerId: "synthetic-worker" };
    yield {
      ...identity,
      type: "output.message",
      message: { role: "teammate", text: "Legacy synthetic work completed" },
    };
    yield { ...identity, type: "execution.completed" };
  },
};
await mkdir(directory, { recursive: true, mode: 0o700 });
if (action === "seed") await migrateDatabase({ url });
const store = new DrizzleStore({ url });
await store.connect();
const journal = new FileAttemptJournal(join(directory, "host-journal"));
const durable = new DurableLocalWorklet(worklet, journal);
const control = new ControlPlane({
  store: new DrizzleStore({ url }),
  credentialVault: new FileGatewayCredentialVault(join(directory, "vault.json")),
  worklet: durable,
  reply: async () => ({ externalMessageId: randomUUID() }),
  dispatch: { pollIntervalMs: 10, retryBaseMs: 50, maxAttempts: 1 },
});
const checkpointStore = new FileSessionStateStore(join(directory, "native-sessions"));
const checkpoint = {
  ref: {
    id: "synthetic-native-session",
    uri: "fixture://native-session",
    format: "synthetic-native-session-v1",
  },
  harnessId: "synthetic-cutover-harness",
  data: { transcript: "Opaque synthetic native history retained only in the legacy archive." },
};
let result: Record<string, unknown>;
try {
  await control.start();
  if (action === "seed") {
    const tag = await store.createTag({ name: "legacy-engineer" });
    await store.bindTagWorkerHost(tag.id, "synthetic-cutover-host");
    const permissions = await store.createTagPermissionSet({ name: "Cutover reviewed actions" });
    await store.addTagPermission({
      permissionSetId: permissions.id,
      target: "runtime",
      action: "files:read",
    });
    const role = await store.createRole({
      name: "Cutover engineer",
      purpose: "Synthetic verification",
      instructions: "Complete synthetic cutover Tasks",
      contextSetIds: [],
      permissionSetIds: [permissions.id],
    });
    await store.assignRole({ roleId: role.id, tagId: tag.id });
    const receipt = await control.messageTag({
      tagName: tag.name,
      operatorId: "synthetic-operator",
      session: "archive-session",
      text: "Complete the legacy fixture",
      idempotencyKey: "cutover-final-request",
    });
    assert.ok(receipt.taskId);
    const deadline = performance.now() + 20_000;
    let task = await store.findTaskById(receipt.taskId);
    while (task?.status !== "completed") {
      assert.ok(performance.now() < deadline, "legacy fixture did not drain");
      await delay(10);
      task = await store.findTaskById(receipt.taskId);
    }
    await checkpointStore.save(checkpoint);
    const sessions = await store.listSessions({ tagId: tag.id });
    result = {
      tagId: tag.id,
      tagName: tag.name,
      taskId: task.id,
      sessionId: sessions[0]?.id,
      status: task.status,
      authorizationSha256: createHash("sha256")
        .update(JSON.stringify(task.authorizationSnapshot))
        .digest("hex"),
      executions,
    };
    await writeFile(join(directory, "expected.json"), `${JSON.stringify(result)}\n`, {
      mode: 0o600,
    });
    await writeFile(
      join(directory, "configuration.json"),
      `${JSON.stringify({ tagName: tag.name, instructions: "Complete synthetic cutover Tasks", allowedActions: ["files:read"], ingress: "none: synthetic in-process fixture", connectorConsumers: [] })}\n`,
      { mode: 0o600 },
    );
    await writeFile(
      join(directory, "synthetic-credentials.json"),
      '{"fixture_only_secret":"synthetic-private-cutover-value"}\n',
      { mode: 0o600 },
    );
  } else {
    const expected = JSON.parse(await readFile(join(directory, "expected.json"), "utf8"));
    const task = await store.findTaskById(expected.taskId);
    assert.equal(task?.status, "completed");
    assert.equal(
      createHash("sha256").update(JSON.stringify(task?.authorizationSnapshot)).digest("hex"),
      expected.authorizationSha256,
    );
    assert.equal((await store.findSessionById(expected.sessionId))?.tagId, expected.tagId);
    assert.equal((await store.listTasks({ tagId: expected.tagId })).length, 1);
    assert.deepEqual(await checkpointStore.load(checkpoint.ref), checkpoint);
    const replay = await control.messageTag({
      tagName: expected.tagName,
      operatorId: "synthetic-operator",
      session: "archive-session",
      text: "Complete the legacy fixture",
      idempotencyKey: "cutover-final-request",
    });
    assert.equal(replay.taskId, expected.taskId);
    assert.equal(executions, 0, "restored completed work executed again");
    result = {
      taskId: task?.id,
      taskCount: 1,
      authorizationPreserved: true,
      sessionPreserved: true,
      checkpointPreserved: true,
      dedupPreserved: true,
      executions,
    };
  }
  const records = await journal.readAll();
  assert.equal(records.length, 1);
  assert.equal(records[0]?.inspection.status, "completed");
  assert.ok(records[0]?.events.some(({ event }) => event.type === "execution.completed"));
  result.journalPreserved = true;
  result.journalEvents = records[0]?.events.length;
} finally {
  await control.stop();
  await durable.close();
  await store.disconnect();
}
// This receipt is emitted only after every old writer and journal owner is closed.
process.stdout.write(`CUTOVER_LEGACY ${JSON.stringify({ ...result, writersStopped: true })}\n`);
