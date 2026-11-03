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
async function cli(args: string[], override: NodeJS.ProcessEnv = env) {
  return new Promise<string>((done, reject) => {
    const child = spawn(process.execPath, [...prefix, ...args], {
      cwd: root,
      env: override,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "",
      err = "";
    child.stdout.on("data", (x) => (out += x));
    child.stderr.on("data", (x) => (err += x));
    const timer = setTimeout(
      () => child.kill("SIGKILL"),
      Math.max(1, Math.min(30000, deadline - Date.now())),
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
        instructions: "Complete only the assigned Task. Do not delegate.",
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
  const tag = JSON.parse(await cli(["get", "tag", "operator-worker"]));
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
  await cli([
    "create",
    "objective",
    "objective",
    "--outcome",
    "Verify operator artifact workflow",
    "--owner",
    "operator-worker",
    "--criterion",
    "Exact artifact bytes",
    "--budget-minor",
    "100",
    ...["files:read", "files:write", "commands:execute"].flatMap((a) => ["--runtime-action", a]),
  ]);
  await cli([
    "create",
    "team",
    "team",
    "--objective",
    "objective",
    "--name",
    "Validation",
    "--lead",
    "operator-worker",
    "--max-concurrency",
    "1",
  ]);
  const secret = `CLI_${randomUUID()}`;
  await writeFile(join(workspace, "source.txt"), secret, { mode: 0o600 });
  const instruction = join(directory, "instruction.txt");
  await writeFile(
    instruction,
    "Copy ./source.txt byte-for-byte to outputs/evidence.txt. Do not append anything or modify its contents. Do not delegate. Final chat prose is unrestricted.",
  );
  await cli([
    "assign",
    "task",
    "producer",
    "--objective",
    "objective",
    "--team",
    "team",
    "--tag",
    tag.metadata.id,
    "--instruction-file",
    instruction,
    "--criterion",
    "Exact source bytes",
    "--output-file",
    "outputs/evidence.txt",
    "--max-cost-minor",
    "20",
  ]);
  const task = await poll(async () => {
    const t = JSON.parse(await cli(["get", "task", "producer"]));
    const p = t.status.assignment.phase;
    if (["failed", "cancelled"].includes(p)) throw new Error(`Task ${p}`);
    return p === "submitted" ? t : undefined;
  });
  await cli(["describe", "task", "producer"]);
  await cli(["events", "task", "producer"]);
  await cli(["list", "artifact", "--task", "producer"]);
  const artifactId = task.status.outcome.taskResult.artifacts[0].artifactId;
  await cli(["get", "artifact", artifactId]);
  const output = join(directory, "download.txt");
  await cli([
    "download",
    "artifact",
    artifactId,
    "--path",
    "outputs/evidence.txt",
    "--out",
    output,
  ]);
  assert.equal(await readFile(output, "utf8"), secret);
  const recall = `RECALL_${randomUUID()}`;
  await writeFile(join(workspace, "challenge.txt"), recall, { mode: 0o600 });
  const wakeAt = new Date(Date.now() + 120000).toISOString();
  await writeFile(
    instruction,
    `If you already memorized the protected value in this native conversation, do not call tools; reply only with that exact remembered value. Otherwise read challenge.txt once, memorize its exact contents, then call wait_for exactly once with only notBefore set to ${wakeAt} and immediately end your turn with READY. Do not repeat the protected value in messages or files. Do not delegate.`,
  );
  await cli([
    "assign",
    "task",
    "continuity",
    "--objective",
    "objective",
    "--team",
    "team",
    "--tag",
    tag.metadata.id,
    "--instruction-file",
    instruction,
    "--criterion",
    "Fresh process retains native Session",
    "--max-cost-minor",
    "20",
  ]);
  const waiting = await poll(async () => {
    const t = JSON.parse(await cli(["get", "task", "continuity"]));
    if (["failed", "cancelled", "submitted"].includes(t.status.assignment.phase))
      throw new Error("Continuity did not enter waiting");
    return t.status.assignment.phase === "waiting" && t.status.attempt.phase === "cancelled"
      ? t
      : undefined;
  });
  const sessionId = waiting.spec.sessionId;
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
  const resumed = await poll(async () => {
    const t = JSON.parse(await cli(["get", "task", "continuity"]));
    if (["failed", "cancelled"].includes(t.status.assignment.phase))
      throw new Error("Continuity failed after restart");
    return t.status.assignment.phase === "submitted" ? t : undefined;
  });
  assert.ok(
    resumed.status.outcome.text?.trim() === recall,
    "Fresh process did not recall protected value",
  );
  assert.ok(
    !JSON.stringify(resumed.spec).includes(recall),
    "Protected value leaked into projected task inputs",
  );
  assert.equal(resumed.status.attempt.number, 2);
  const after = await cli(["describe", "session", sessionId]);
  const afterIds = [...after.matchAll(/native ID ([^;]+);/g)].map((x) => x[1]);
  assert.deepEqual([...new Set(afterIds)], [beforeIds[0]]);
  await cli(["events", "task", "continuity"]);
  report["recovery"] = {
    passed: true,
    nativeId: beforeIds[0],
    attempts: 2,
    workspaceAndWorkerStateDeleted: true,
    projectedInputsContainProtectedValue: false,
  };
  Object.assign(report, {
    result: "passed",
    artifactId,
    digest: createHash("sha256").update(secret).digest("hex"),
    bytes: Buffer.byteLength(secret),
    taskPhase: task.status.assignment.phase,
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
