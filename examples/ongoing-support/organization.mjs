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
import { apiClient, createOrganization } from "./resources.mjs";

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
  const [overview, provider] = await Promise.all([
    api.overview(),
    policyRequest(state.policyUrl, await secret("read-token"), "/status"),
  ]);
  // The provider's receipts are the durable record of what was applied; one per incident Session.
  const applied = Object.fromEntries(
    Object.entries(provider.operations).map(([operationId, receipt]) => [
      operationId.slice("support:".length),
      receipt,
    ]),
  );
  const proposals = overview.sessions.filter((session) => session.title?.startsWith("support:"));
  const needsApplication = proposals
    .filter(
      (session) =>
        session.status === "OBJECTIVE_SESSION_STATUS_COMPLETED" &&
        !Object.hasOwn(provider.operations, session.title),
    )
    .map((session) => ({
      sessionId: session.id,
      incidentId: session.title.slice("support:".length),
      operationId: session.title,
      next: "Inspect the provider operation receipt before retrying this policy.",
    }));
  return {
    observedAt: new Date().toISOString(),
    mode: state.mode,
    incidents: Object.keys(applied),
    applied,
    needsApplication,
    proposals,
    conversation: overview.conversation,
    provider,
    overview,
  };
}
async function verify(state, report) {
  const api = apiClient(state.url, await secret("admin-token"));
  const overview = report.overview;
  // Every incident an operator reported in this conversation, in order.
  const reported = overview.conversation
    .filter((turn) => turn.author === "OBJECTIVE_CONVERSATION_AUTHOR_OPERATOR")
    .flatMap((turn) => [...turn.text.matchAll(/"incidentId"\s*:\s*"([^"]*)"/gu)].map((m) => m[1]));
  const incidents = [...new Set(reported)];
  assert(
    reported.length > 0 && reported.length < 100,
    "Verifier handles 1–99 observations; extend paging for larger deployments",
  );
  assert.deepEqual(report.needsApplication, [], "Reviewed proposals remain unapplied");
  assert.equal(
    Object.keys(report.provider.operations).length,
    incidents.length,
    "Unexpected or missing provider operations",
  );
  const owner = overview.sessions.find((session) => session.owner);
  assert(owner, "The Objective has no conversation");
  assert.equal(
    owner.status,
    "OBJECTIVE_SESSION_STATUS_COMPLETED",
    "The owner must finish its turn, not wait",
  );
  // The Worker Host's copies; the Control Plane keeps only the catalog.
  const artifacts = new FileArtifactStore(join(directory, "artifacts"));
  for (const incidentId of incidents) {
    const operationId = `support:${incidentId}`;
    const session = overview.sessions.find((item) => item.title === operationId);
    assert.equal(
      session?.status,
      "OBJECTIVE_SESSION_STATUS_COMPLETED",
      `${operationId} did not report`,
    );
    const receipt = report.provider.operations[operationId];
    assert(receipt, `${operationId} has no provider receipt`);
    const { events = [] } = await api.rpc("WorkService", "ListTaskEvents", {
      taskId: session.latestTask.id,
      pageSize: 1000,
    });
    assert(
      events.some(
        (event) =>
          event.type === "artifact.created" &&
          event.payload?.artifact?.artifactId === receipt.sourceArtifactId &&
          event.payload.artifact.digest === receipt.sourceDigest &&
          event.payload.artifact.path === "outputs/policy.json",
      ),
      "Applied digest has no matching captured artifact event from the reviewed work Session",
    );
    const bytes = await artifacts.get({
      uri: `supertag-artifact:${receipt.sourceDigest}`,
      digest: receipt.sourceDigest,
    });
    const proposal = JSON.parse(Buffer.from(bytes).toString());
    assert.equal(proposal.incidentId, incidentId);
    assert.equal(receipt.expectedRevision, proposal.expectedRevision);
    assert.equal(receipt.responseMinutes, proposal.responseMinutes);
    assert.equal(receipt.revision, proposal.expectedRevision + 1);
  }
  assert.equal(
    report.proposals.length,
    incidents.length,
    "Duplicate or unexpected proposal Sessions",
  );
  const evidence = {
    passed: true,
    incidents: incidents.length,
    proposalSessions: report.proposals.length,
    recoveredResponse: report.provider.dropped,
    restartedControlPlane: state.restartedControlPlane ?? false,
    outcomes: incidents.map((incidentId) => {
      const session = overview.sessions.find((item) => item.title === `support:${incidentId}`);
      const receipt = report.provider.operations[`support:${incidentId}`];
      return {
        incidentId,
        sessionId: session.id,
        taskId: session.latestTask.id,
        artifactId: receipt.sourceArtifactId,
        digest: receipt.sourceDigest,
        timeToAppliedMs: Date.parse(receipt.appliedAt) - Date.parse(session.createdAt),
      };
    }),
    usage: report.overview.budget,
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
  // An observation is an operator message in the Objective's conversation; the delivery ID makes
  // a repeated report of the same observation one turn.
  return apiClient(state.url, await secret("admin-token")).message(
    JSON.stringify({ incidentId }),
    deliveryId,
  );
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
    console.log(JSON.stringify({ running: true, mode, stateDirectory: directory }));
    if (command === "demo") {
      // The owner's first turn runs when a Worker is available; it ends with nothing to do.
      await waitUntil(async () => {
        const owner = (await api.overview()).sessions.find((session) => session.owner);
        return owner?.status === "OBJECTIVE_SESSION_STATUS_COMPLETED";
      }, 240000);
      if (process.env.SUPPORT_RESTART !== "0") {
        await stop(plane, "SIGKILL");
        plane = await startPlane();
        state.restartedControlPlane = true;
      }
      await save(state);
      for (const [index, incidentId] of ["one", "one", "two", "three", "one"].entries())
        await observe(state, incidentId, `demo-${index}`);
      await waitUntil(async () => {
        const overview = await api.overview();
        const failed = overview.sessions.find((session) =>
          ["OBJECTIVE_SESSION_STATUS_FAILED", "OBJECTIVE_SESSION_STATUS_CANCELLED"].includes(
            session.status,
          ),
        );
        if (failed)
          throw Object.assign(new Error(`Session ${failed.id} is ${failed.status}`), {
            fatal: true,
          });
        const applied = (
          await policyRequest(state.policyUrl, await secret("read-token"), "/status")
        ).operations;
        const owner = overview.sessions.find((session) => session.owner);
        return (
          ["one", "two", "three"].every((incidentId) =>
            Object.hasOwn(applied, `support:${incidentId}`),
          ) && owner?.status === "OBJECTIVE_SESSION_STATUS_COMPLETED"
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
