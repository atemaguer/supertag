/** Opt-in local operator journey. Runs real subscription-backed Harnesses; never contacts a cloud Control Plane. */
import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { conversationClient } from "../apps/cli/src/operator-client.js";
import { ReplyStatus } from "../packages/operator-api/src/index.js";

const { values } = parseArgs({
  options: { live: { type: "boolean" }, provider: { type: "string", default: "codex" } },
});
if (!values.live) throw new Error("Pass --live to use local subscription credentials");
const provider = values.provider;
if (provider !== "codex" && provider !== "claude-code")
  throw new Error("--provider must be codex or claude-code");
const root = resolve(import.meta.dirname, "..");
const directory = await mkdtemp(join(tmpdir(), "supertag-cli-live-"));
const environment = { ...process.env };
for (const key of Object.keys(environment))
  if (
    key.startsWith("SUPERTAG_") ||
    [
      "DATABASE_URL",
      "PORT",
      "ANTHROPIC_API_KEY",
      "OPENAI_API_KEY",
      "CODEX_API_KEY",
      "ANTHROPIC_AUTH_TOKEN",
      "ANTHROPIC_BASE_URL",
      "OPENAI_BASE_URL",
    ].includes(key)
  )
    delete environment[key];
const cpState = join(directory, "control-plane");
const workerState = join(directory, "worker");
const workspace = join(directory, "workspace");
await mkdir(workspace, { recursive: true });
const port = await new Promise<number>((done, reject) => {
  const server = createServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const a = server.address();
    assert.ok(a && typeof a !== "string");
    server.close(() => done(a.port));
  });
});
const origin = `http://127.0.0.1:${port}`;
const admin = randomUUID();
const env = {
  ...environment,
  SUPERTAG_STATE_DIR: cpState,
  SUPERTAG_DATABASE_URL: `file:${join(cpState, "test.db")}`,
  SUPERTAG_ADMIN_TOKEN: admin,
  SUPERTAG_CONTROL_PLANE: origin,
  SUPERTAG_WORKLET_TRANSPORT: "remote",
};
const prefix = ["--import", "tsx", "--conditions=development", "apps/cli/src/index.ts"];
const children: ChildProcess[] = [];
const deadline = Date.now() + 600000;
let counter = 0;
async function cli(args: string[]) {
  return new Promise<string>((done, reject) => {
    const child = spawn(process.execPath, [...prefix, ...args], {
      cwd: root,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "",
      err = "";
    child.stdout.on("data", (x) => (out += x));
    child.stderr.on("data", (x) => (err += x));
    const timer = setTimeout(
      () => child.kill("SIGKILL"),
      Math.max(1, Math.min(30_000, deadline - Date.now())),
    );
    child.once("error", reject);
    child.once("exit", (code) => {
      clearTimeout(timer);
      void writeFile(join(directory, `command-${++counter}.log`), out + err, { mode: 0o600 });
      code === 0
        ? done(out)
        : reject(
            new Error(`CLI ${args.slice(0, 2).join(" ")} exited ${code}; private log ${counter}`),
          );
    });
  });
}
async function background(args: string[], override: NodeJS.ProcessEnv, name: string) {
  const log = createWriteStream(join(directory, `${name}.log`), { mode: 0o600 });
  await new Promise<void>((done, reject) => {
    log.once("open", () => done());
    log.once("error", reject);
  });
  const child = spawn(process.execPath, [...prefix, ...args], {
    cwd: root,
    env: override,
    stdio: ["ignore", log, log],
  });
  children.push(child);
  return child;
}
async function poll<T>(fn: () => Promise<T | undefined>): Promise<T> {
  while (Date.now() < deadline) {
    const value = await fn();
    if (value !== undefined) return value;
    await delay(500);
  }
  throw new Error("Operator journey exceeded 600 seconds");
}
const report: Record<string, unknown> = {
  provider,
  directory,
  startedAt: new Date().toISOString(),
  result: "failed",
  recovery: "not exercised in this bounded artifact journey",
};
try {
  await mkdir(cpState, { recursive: true });
  await cli(["migrate", "database"]);
  await background(
    ["start", "control-plane", "--host", "127.0.0.1", "--port", String(port)],
    env,
    "control-plane",
  );
  await poll(async () => {
    try {
      await cli(["status", "control-plane"]);
      return true;
    } catch {
      return undefined;
    }
  });
  const credential = join(directory, "host.json");
  await cli(["enroll", "worker-host", "host", "--out", credential]);
  const workerEnv = { ...environment, SUPERTAG_STATE_DIR: workerState };
  await installCredential(credential, "host", String(workerEnv["SUPERTAG_STATE_DIR"]));
  for (const resource of [
    {
      kind: "PermissionSet",
      metadata: { name: "runtime" },
      spec: {
        permissions: ["files:read", "files:write", "commands:execute"].map((action) => ({
          target: "runtime",
          action,
        })),
      },
    },
    {
      kind: "Role",
      metadata: { name: "worker" },
      spec: {
        purpose: "Bounded operator validation",
        instructions: "Do only what each message asks. Do not start work Sessions.",
        permissionSets: ["runtime"],
        contextSets: [],
      },
    },
    {
      kind: "Tag",
      metadata: { name: "operator-worker" },
      spec: { roles: ["worker"], workerHosts: [] },
    },
  ]) {
    const path = join(directory, `${resource.kind}.json`);
    await writeFile(path, JSON.stringify({ apiVersion: "supertag/v1", ...resource }), {
      mode: 0o600,
    });
    await cli(["apply", "-f", path]);
  }
  await cli(["update", "tag", "operator-worker", "--add-worker-host", "host"]);
  await cli(["get", "tag", "operator-worker"]);
  const workerArgs = [
    "connect",
    "worklet",
    "--worklet-url",
    `ws://127.0.0.1:${port}/worklets`,
    "--transport",
    "websocket",
    "--harness",
    provider,
    "--workspace",
    workspace,
    "--worker-host",
    "host",
    "--worker-id",
    "worker",
    "--worklet-id",
    "worklet",
    "--worker-profile",
    "test-profile",
    "--worker-profile-revision",
    "1",
    ...(provider === "codex" ? ["--model", "gpt-5.6-luna"] : []),
  ];
  const worker = await background(workerArgs, workerEnv, "worker");
  await poll(async () => {
    const host = JSON.parse(await cli(["get", "worker-host", "host"]));
    return host.status.connectionStatus === "connected" ? true : undefined;
  });
  const conversations = conversationClient({ url: origin, token: admin });
  /** One operator conversation turn, followed until its reply and work reports. */
  const message = async (conversation: string, text: string) => {
    const sent = await conversations.sendMessage({ tag: "operator-worker", conversation, text });
    const request = { tag: sent.tag, taskId: sent.taskId };
    for await (const { part } of conversations.followMessage(request, {
      timeoutMs: Math.max(1, Math.min(300000, deadline - Date.now())),
    })) {
      if (part.case === "end" || part.case === "error") break;
      if (part.case !== "finish" && part.case !== "workSessionChanged") continue;
      const record = await conversations.getMessage(request);
      if (
        record.status === ReplyStatus.REPLIED &&
        record.workSessions.every((session) => session.reportStatus === ReplyStatus.REPLIED)
      )
        break;
    }
    const record = await conversations.getMessage(request);
    if (record.status !== ReplyStatus.REPLIED)
      throw new Error(`Turn in ${conversation} did not reply`);
    return record;
  };
  /** The turn's Task, once it settled. */
  const settled = (taskId: string) =>
    poll(async () => {
      const t = JSON.parse(await cli(["get", "task", taskId]));
      if (["failed", "cancelled"].includes(t.status.phase))
        throw new Error(`Task ${t.status.phase}`);
      return t.status.phase === "completed" ? t : undefined;
    });
  const secret = `CLI_${randomUUID()}`;
  await writeFile(join(workspace, "source.txt"), secret, { mode: 0o600 });
  const produced = await message(
    "artifact",
    'Copy ./source.txt byte-for-byte to "$SUPERTAG_OUTPUT_DIR/evidence.txt". Do not append anything or modify its contents. Do not start work Sessions. Final chat prose is unrestricted.',
  );
  const task = await settled(produced.taskId);
  await cli(["describe", "task", produced.taskId]);
  await cli(["events", "task", produced.taskId]);
  const listed = JSON.parse(await cli(["list", "artifact", "--task", produced.taskId])) as {
    items: { metadata: { id: string }; spec: { entries: { path: string }[] } }[];
  };
  const evidence = listed.items.flatMap((item) =>
    item.spec.entries
      .filter((entry) => entry.path.endsWith("evidence.txt"))
      .map((entry) => ({ artifactId: item.metadata.id, path: entry.path })),
  )[0];
  if (!evidence) throw new Error("The turn captured no evidence.txt artifact");
  const artifactId = evidence.artifactId;
  await cli(["get", "artifact", artifactId]);
  const output = join(directory, "download.txt");
  await cli(["download", "artifact", artifactId, "--path", evidence.path, "--out", output]);
  assert.equal(await readFile(output, "utf8"), secret);

  // Native Session continuity: a later turn of the same conversation, on a fresh Worker process
  // with its state and Workspace deleted, recalls what the first turn read.
  const recall = `RECALL_${randomUUID()}`;
  await writeFile(join(workspace, "challenge.txt"), recall, { mode: 0o600 });
  const first = await message(
    "continuity",
    "Read challenge.txt once with a shell command and memorize its exact contents. Do not repeat it in messages, files, or tool arguments. Reply only with READY. Do not start work Sessions.",
  );
  await settled(first.taskId);
  const sessionId = first.sessionId;
  const before = await poll(async () => {
    const text = await cli(["describe", "session", sessionId]);
    return text.includes(": resumable; native ID ") ? text : undefined;
  });
  const beforeIds = [...before.matchAll(/native ID ([^;]+);/g)].map((x) => x[1]);
  assert.equal(new Set(beforeIds).size, 1);
  worker.kill("SIGTERM");
  await new Promise<void>((done) => worker.once("exit", () => done()));
  await rm(workerState, { recursive: true, force: true });
  await rm(workspace, { recursive: true, force: true });
  await mkdir(workspace, { recursive: true });
  await installCredential(credential, "host", String(workerEnv["SUPERTAG_STATE_DIR"]));
  await background(workerArgs, workerEnv, "worker-restarted");
  await poll(async () => {
    const host = JSON.parse(await cli(["get", "worker-host", "host"]));
    return host.status.connectionStatus === "connected" ? true : undefined;
  });
  const second = await message(
    "continuity",
    "Do not call any tool or search the filesystem. Reply only with the exact contents of challenge.txt that you memorized earlier in this conversation.",
  );
  const resumed = await settled(second.taskId);
  assert.ok(second.reply?.text.trim() === recall, "Fresh process did not recall protected value");
  assert.ok(
    !JSON.stringify(resumed.spec).includes(recall),
    "Protected value leaked into projected task inputs",
  );
  const after = await cli(["describe", "session", sessionId]);
  const afterIds = [...after.matchAll(/native ID ([^;]+);/g)].map((x) => x[1]);
  assert.deepEqual([...new Set(afterIds)], [beforeIds[0]]);
  await cli(["events", "task", second.taskId]);
  report["recovery"] = {
    passed: true,
    nativeId: beforeIds[0],
    turns: 2,
    workspaceAndWorkerStateDeleted: true,
    projectedInputsContainProtectedValue: false,
  };
  Object.assign(report, {
    result: "passed",
    artifactId,
    digest: createHash("sha256").update(secret).digest("hex"),
    bytes: Buffer.byteLength(secret),
    taskPhase: task.status.phase,
    commands: counter,
  });
} catch (error) {
  report["error"] = error instanceof Error ? error.message : "Unknown failure";
  process.exitCode = 1;
} finally {
  for (const child of children.toReversed()) {
    if (child.exitCode !== null) continue;
    child.kill("SIGTERM");
    await Promise.race([
      new Promise<void>((done) => child.once("exit", () => done())),
      delay(10000).then(() => {
        child.kill("SIGKILL");
      }),
    ]);
  }
  report["finishedAt"] = new Date().toISOString();
  await writeFile(join(directory, "report.json"), JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(report));
}

/** Installs an enrolled Worker Host credential where connect worklet finds it. */
async function installCredential(file: string, id: string, state: string): Promise<void> {
  const target = join(state, "worker-hosts", `${encodeURIComponent(id)}.credential.json`);
  await mkdir(join(state, "worker-hosts"), { recursive: true, mode: 0o700 });
  await copyFile(file, target);
}
