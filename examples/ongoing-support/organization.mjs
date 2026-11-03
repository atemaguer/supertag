import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { FileArtifactStore } from "supertag-ai/worker";
import { policyRequest } from "./policy-client.mjs";
import { apiClient, createOrganization, objectiveId } from "./resources.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const directory = resolve(
  process.env.SUPPORT_STATE ?? join(homedir(), ".supertag/examples/ongoing-support"),
);
const statePath = join(directory, "state.json");
const command = process.argv[2] ?? "status";
const mode = process.env.SUPPORT_MODE ?? "native";
if (!["native", "reference"].includes(mode))
  throw new Error("SUPPORT_MODE must be native or reference");
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const load = () => readFile(statePath, "utf8").then(JSON.parse);
const save = async (state) => {
  await writeFile(`${statePath}.tmp`, JSON.stringify(state, null, 2), { mode: 0o600 });
  await rename(`${statePath}.tmp`, statePath);
};
const secret = (name) => readFile(join(directory, name), "utf8");
const sdkBin = join(
  dirname(createRequire(import.meta.url).resolve("supertag-ai/package.json")),
  "dist/cli.js",
);
async function waitUntil(check, timeout = 60000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try {
      const result = await check();
      if (result) return result;
    } catch (error) {
      if (error.fatal) throw error;
      last = error;
    }
    await sleep(300);
  }
  throw new Error(
    `Timed out${last ? `: ${last.message}` : ""}; inspect the private logs and status`,
  );
}
async function freePort() {
  const server = createServer();
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const port = server.address().port;
  await new Promise((done) => server.close(done));
  return port;
}
const cleanEnv = () =>
  Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !key.startsWith("SUPERTAG_") && !key.startsWith("SUPPORT_"),
    ),
  );
const children = new Set();
async function launch(name, args, env) {
  const log = await open(join(directory, `${name}.log`), "a", 0o600);
  const child = spawn(process.execPath, args, {
    cwd: here,
    env: { ...cleanEnv(), ...env },
    stdio: ["ignore", log.fd, log.fd],
    detached: process.platform !== "win32",
  });
  children.add(child);
  try {
    await once(child, "spawn");
  } finally {
    await log.close();
  }
  return child;
}
async function stop(child, signal = "SIGTERM") {
  if (child.exitCode !== null || child.signalCode !== null) {
    children.delete(child);
    return;
  }
  const exited = once(child, "exit");
  const send = (value) => {
    try {
      if (process.platform === "win32") child.kill(value);
      else process.kill(-child.pid, value);
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  };
  send(signal);
  const timer = setTimeout(() => send("SIGKILL"), 15000);
  try {
    await exited;
  } finally {
    clearTimeout(timer);
    children.delete(child);
  }
}
async function snapshot(state) {
  const api = apiClient(state.url, await secret("admin-token"));
  const [overview, team, provider] = await Promise.all([
    api.request("GET", `/api/v1/coordination/objectives/${objectiveId}/overview?limit=100`),
    api.coordinate("read_team", { teamId: "support-team" }),
    policyRequest(state.policyUrl, await secret("read-token"), "/status"),
  ]);
  const applied = team.context?.applied ?? {};
  const needsApplication = overview.tasks
    .filter(
      (task) =>
        task.status === "accepted" &&
        !Object.values(applied).some((entry) => entry.taskId === task.taskId),
    )
    .map((task) => ({
      taskId: task.taskId,
      operationId: task.taskId,
      next: "Inspect the provider operation receipt before retrying this policy.",
    }));
  return {
    observedAt: new Date().toISOString(),
    mode: state.mode,
    cursor: team.context?.cursor ?? 0,
    applied,
    needsApplication,
    provider,
    overview,
  };
}
async function verify(state, report) {
  const api = apiClient(state.url, await secret("admin-token"));
  const objective = await api.coordinate("read_objective");
  const stream = await api.coordinate("read_workstream", {
    workstreamId: "support-observations",
    afterSequence: 0,
    limit: 100,
  });
  assert(
    stream.posts.length > 0 && stream.posts.length < 100,
    "Verifier handles 1–99 observations; extend paging for larger deployments",
  );
  const incidents = [...new Set(stream.posts.map((post) => JSON.parse(post.body).incidentId))];
  assert.equal(report.cursor, stream.posts.at(-1).sequence, "Unprocessed observations remain");
  assert.equal(
    Object.keys(report.provider.operations).length,
    incidents.length,
    "Unexpected or missing provider operations",
  );
  // The Worker Host's copies; the Control Plane keeps only the catalog.
  const artifacts = new FileArtifactStore(join(directory, "artifacts"));
  for (const incidentId of incidents) {
    const taskId = `support:${incidentId}`;
    const task = objective.tasks.find((item) => item.taskId === taskId);
    assert.equal(task?.status, "accepted", `${taskId} is not accepted`);
    const receipt = report.provider.operations[taskId];
    assert(receipt, `${taskId} has no provider receipt`);
    assert(
      task.result.taskResult.artifacts.some(
        (item) =>
          item.artifactId === receipt.sourceArtifactId &&
          item.paths.includes("outputs/policy.json"),
      ),
      "Applied artifact was not selected by the reviewed Task",
    );
    const events = (await api.request("GET", `/api/v1/tasks/${encodeURIComponent(taskId)}/events`))
      .items;
    assert(
      events.some(
        (event) =>
          event.type === "artifact.created" &&
          event.attemptId === task.result.reviewedAttemptId &&
          event.payload?.artifact?.artifactId === receipt.sourceArtifactId &&
          event.payload.artifact.digest === receipt.sourceDigest &&
          event.payload.artifact.path === "outputs/policy.json",
      ),
      "Applied digest has no matching captured artifact event from the reviewed Attempt",
    );
    const bytes = await artifacts.get({
      uri: `supertag-artifact:${receipt.sourceDigest}`,
      digest: receipt.sourceDigest,
    });
    const proposal = JSON.parse(Buffer.from(bytes).toString());
    assert.deepEqual(proposal, JSON.parse(task.instruction));
    assert.equal(proposal.incidentId, incidentId);
    assert.equal(receipt.expectedRevision, proposal.expectedRevision);
    assert.equal(receipt.responseMinutes, proposal.responseMinutes);
    assert.equal(receipt.revision, proposal.expectedRevision + 1);
    assert.equal(report.applied[incidentId].sourceDigest, receipt.sourceDigest);
    assert.equal(report.applied[incidentId].reviewedAttemptId, task.result.reviewedAttemptId);
  }
  assert.equal(objective.tasks.length, incidents.length + 1, "Duplicate/unexpected assignments");
  assert.equal(
    objective.tasks.find((task) => task.taskId === `${objectiveId}:start`)?.status,
    "waiting",
    "Manager must return to a durable wait before completion",
  );
  const evidence = {
    passed: true,
    incidents: incidents.length,
    assignments: objective.tasks.length,
    recoveredResponse: report.provider.dropped,
    restartedControlPlane: state.restartedControlPlane ?? false,
    outcomes: incidents.map((incidentId) => {
      const task = objective.tasks.find((item) => item.taskId === `support:${incidentId}`);
      const receipt = report.provider.operations[task.taskId];
      return {
        incidentId,
        taskId: task.taskId,
        producingAttemptId: task.result.reviewedAttemptId,
        artifactId: receipt.sourceArtifactId,
        digest: receipt.sourceDigest,
        timeToAppliedMs: Date.parse(receipt.appliedAt) - Date.parse(task.createdAt),
      };
    }),
    performance: report.overview.performance,
    usage: report.overview.pageUsage,
    limits:
      "Two local Worker processes, local SQLite and policy service; not independent machines or arbitrary-provider exactly-once.",
  };
  await writeFile(join(directory, "verification.json"), JSON.stringify(evidence, null, 2), {
    mode: 0o600,
  });
  return evidence;
}
async function observe(state, incidentId, deliveryId) {
  if (!/^[a-zA-Z0-9_-]{1,80}$/u.test(incidentId ?? "") || !deliveryId)
    throw new Error("Usage: npm run observe -- INCIDENT_ID DELIVERY_ID");
  return apiClient(state.url, await secret("admin-token")).coordinate("post_workstream", {
    workstreamId: "support-observations",
    body: JSON.stringify({ incidentId }),
    idempotencyKey: deliveryId,
  });
}
async function run() {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const lock = await open(join(directory, "run.lock"), "wx", 0o600);
  await lock.writeFile(String(process.pid));
  let closing = false;
  const cleanup = async () => {
    if (closing) return;
    closing = true;
    for (const child of [...children].reverse()) await stop(child);
    await lock.close();
    await rm(join(directory, "run.lock"), { force: true });
  };
  for (const signal of ["SIGINT", "SIGTERM"])
    process.once(signal, () => {
      void cleanup().then(() => process.exit(0));
    });
  try {
    let state;
    try {
      state = await load();
      if (!state.ready)
        throw new Error("Setup was interrupted; inspect and use a fresh SUPPORT_STATE directory");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      state = {
        mode,
        url: `http://127.0.0.1:${await freePort()}`,
        policyUrl: `http://127.0.0.1:${await freePort()}`,
        ready: false,
      };
      for (const name of ["admin-token", "read-token", "write-token"])
        await writeFile(join(directory, name), randomBytes(32).toString("hex"), {
          mode: 0o600,
          flag: "wx",
        });
      await save(state);
    }
    if (state.mode !== mode)
      throw new Error("Use a fresh SUPPORT_STATE when switching native/reference mode");
    const adminToken = await secret("admin-token");
    const cpEnv = {
      SUPERTAG_STATE_DIR: join(directory, "control-plane"),
      SUPERTAG_DATABASE_URL: `file:${join(directory, "control-plane", "state.db")}`,
      SUPERTAG_ADMIN_TOKEN: adminToken,
      SUPERTAG_WORKLET_TRANSPORT: "remote",
      SUPERTAG_COORDINATION_URL: state.url,
    };
    await mkdir(join(directory, "control-plane"), { recursive: true, mode: 0o700 });
    const migration = await launch("migrate", [sdkBin, "migrate", "database"], cpEnv);
    assert.equal((await once(migration, "exit"))[0], 0, "Migration failed");
    children.delete(migration);
    const api = apiClient(state.url, adminToken);
    const startPlane = async () => {
      const child = await launch(
        "control-plane",
        [
          sdkBin,
          "start",
          "control-plane",
          "--host",
          "127.0.0.1",
          "--port",
          new URL(state.url).port,
        ],
        cpEnv,
      );
      await waitUntil(() => api.request("GET", "/api/v1/worker-hosts"));
      return child;
    };
    let plane = await startPlane();
    await launch("policy", [join(here, "policy-service.mjs")], {
      SUPPORT_POLICY_STATE: join(directory, "policy.json"),
      SUPPORT_POLICY_PORT: new URL(state.policyUrl).port,
      SUPPORT_READ_TOKEN: await secret("read-token"),
      SUPPORT_WRITE_TOKEN: await secret("write-token"),
      SUPPORT_DROP_RESPONSE: command === "demo" ? "1" : "0",
    });
    const readToken = await secret("read-token");
    await waitUntil(() => policyRequest(state.policyUrl, readToken, "/status"));
    if (!state.ready) {
      state.actors = await createOrganization(api);
      state.ready = true;
      await save(state);
    }
    for (const name of ["manager", "analyst"]) {
      const path = join(directory, `${name}.json`);
      await writeFile(
        path,
        JSON.stringify({
          ...state.actors[name],
          workletUrl: `${state.url.replace(/^http/u, "ws")}/worklets`,
          policyUrl: state.policyUrl,
          policyToken: await secret(name === "manager" ? "write-token" : "read-token"),
          analystTagId: state.actors.analyst.tagId,
        }),
        { mode: 0o600 },
      );
      await launch(name, [join(here, "worker.mjs"), name], {
        SUPPORT_MODE: mode,
        SUPPORT_WORKER_CONFIG: path,
        SUPPORT_WORKER_STATE: join(directory, name),
        ...(process.env.SUPPORT_CLAUDE_MODEL
          ? { SUPPORT_CLAUDE_MODEL: process.env.SUPPORT_CLAUDE_MODEL }
          : {}),
        ...(process.env.SUPPORT_CODEX_MODEL
          ? { SUPPORT_CODEX_MODEL: process.env.SUPPORT_CODEX_MODEL }
          : {}),
      });
    }
    await waitUntil(async () => {
      const profiles = await api.request("GET", "/api/v1/worker-profiles");
      return ["support-manager", "support-analyst"].every((id) =>
        profiles.items.some(
          (profile) => profile.spec.ref.id === id && profile.status.phase === "available",
        ),
      );
    });
    const objective = await api.coordinate("read_objective");
    if (!objective.tasks.some((task) => task.taskId === `${objectiveId}:start`))
      await api.coordinate("start_objective", { maxCostMinor: 0 });
    console.log(JSON.stringify({ running: true, mode, stateDirectory: directory }));
    if (command === "demo") {
      await waitUntil(
        async () =>
          (await api.coordinate("read_objective")).tasks.find(
            (task) => task.taskId === `${objectiveId}:start`,
          )?.status === "waiting",
        240000,
      );
      if (process.env.SUPPORT_RESTART !== "0") {
        await stop(plane, "SIGKILL");
        plane = await startPlane();
        state.restartedControlPlane = true;
      }
      await save(state);
      for (const [index, incidentId] of ["one", "one", "two", "three", "one"].entries())
        await observe(state, incidentId, `demo-${index}`);
      await waitUntil(async () => {
        const objective = await api.coordinate("read_objective");
        const failed = objective.tasks.find((task) =>
          ["failed", "cancelled", "rejected"].includes(task.status),
        );
        if (failed)
          throw Object.assign(
            new Error(
              `Task ${failed.taskId} is ${failed.status}: ${JSON.stringify(failed.result)}`,
            ),
            { fatal: true },
          );
        const team = await api.coordinate("read_team", { teamId: "support-team" });
        return (
          team.context?.cursor === 5 &&
          objective.tasks.find((task) => task.taskId === `${objectiveId}:start`)?.status ===
            "waiting"
        );
      }, 600000);
      const report = await snapshot(state);
      console.log(JSON.stringify(await verify(state, report), null, 2));
    } else {
      while (!closing) {
        await sleep(1000);
        const failed = [...children].find(
          (child) => child.exitCode !== null || child.signalCode !== null,
        );
        if (failed) throw new Error("An example process stopped; inspect its private log");
      }
    }
  } finally {
    await cleanup();
  }
}
if (command === "start" || command === "demo") await run();
else if (command === "observe")
  console.log(JSON.stringify(await observe(await load(), process.argv[3], process.argv[4])));
else if (command === "status" || command === "verify") {
  const state = await load();
  const report = await snapshot(state);
  console.log(JSON.stringify(command === "verify" ? await verify(state, report) : report, null, 2));
} else throw new Error("Choose start, demo, observe, status, or verify");
