/** Real Control Plane + Docker Worker Hosts; models own all delegation and completion. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { request } from "node:https";
import { join, resolve } from "node:path";
import { getgid, getuid } from "node:process";
import { parseArgs, promisify } from "node:util";
import { stageWorkerAuth } from "../examples/shared-organization/worker-auth.mjs";
import { verifyArtifactOrganizationEvidence } from "./artifact-organization-evidence.js";

const { values } = parseArgs({
  options: {
    live: { type: "boolean" },
    output: { type: "string" },
    "skip-build": { type: "boolean" },
    "allow-unconfined-seccomp": { type: "boolean" },
    "max-seconds": { type: "string" },
    "max-attempts": { type: "string" },
  },
});
if (!values.live) throw new Error("Pass --live to run subscription-backed agents in Docker");
function bound(value: string | undefined, fallback: number, max: number) {
  const number = Number(value ?? fallback);
  assert(Number.isSafeInteger(number) && number > 0 && number <= max, `Expected integer 1..${max}`);
  return number;
}
const maxSeconds = bound(values["max-seconds"], 600, 1200);
const maxAttempts = bound(values["max-attempts"], 10, 20);
const execute = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
const directory = resolve(values.output ?? `/tmp/supertag-artifact-organization-${Date.now()}`);
await mkdir(directory, { mode: 0o700 });
const network = `supertag-art-org-${randomUUID().slice(0, 8)}`;
const image = `${network}:live`;
const containers: string[] = [];
const secrets: string[] = [randomUUID()];
const adminToken = secrets[0] as string;
const objectiveId = `artifact-org-${randomUUID().slice(0, 8)}`;
let apiUrl = "",
  tlsCa = "",
  passed = false;
type Row = Record<string, unknown>;
const record = (value: unknown): Row =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Row) : {};
const rows = (value: unknown): Row[] => (Array.isArray(value) ? value.map(record) : []);
const json = (value: unknown): Row =>
  typeof value === "string" ? record(JSON.parse(value)) : record(value);
const name = (service: string) => `${network}-${service}`;
const run = (command: string, args: string[], options: Parameters<typeof execute>[2] = {}) =>
  execute(command, args, {
    cwd: root,
    timeout: 300_000,
    maxBuffer: 32 * 1024 * 1024,
    ...options,
    encoding: "utf8",
  });
function redact(text: string) {
  for (const secret of secrets) text = text.replaceAll(secret, "[REDACTED]");
  return text;
}
async function save(filename: string, value: unknown) {
  await writeFile(join(directory, filename), redact(JSON.stringify(value, null, 2)), {
    mode: 0o600,
  });
}
async function eventually(probe: () => Promise<boolean>, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await probe()) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("Timed out waiting for Docker organization");
}
async function api(method: string, path: string, body?: object): Promise<Row> {
  return new Promise((resolve, reject) => {
    const req = request(
      `${apiUrl}${path}`,
      {
        method,
        ca: tlsCa,
        headers: { authorization: `Bearer ${adminToken}`, "content-type": "application/json" },
        timeout: 15_000,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          try {
            const parsed = JSON.parse(Buffer.concat(chunks).toString());
            if ((response.statusCode ?? 500) >= 400)
              reject(new Error(`${method} ${path}: ${JSON.stringify(parsed)}`));
            else resolve(parsed);
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("API request timeout")));
    req.on("error", reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}
async function snapshot(): Promise<Record<string, Row[]>> {
  const script =
    "const db=require('better-sqlite3')('/state/control-plane.db',{readonly:true});const tables={sessions:'SELECT id,tagId,sessionKey,parentSessionId,objectiveId FROM Session',inbound:'SELECT id,tagId,sessionKey,status FROM DurableInboundEvent',attempts:'SELECT * FROM TaskAttempt',tasks:'SELECT * FROM Task',teams:'SELECT * FROM Team',objectives:'SELECT * FROM Objective',messages:'SELECT * FROM TagMessage',hosts:'SELECT * FROM WorkerHost',events:'SELECT * FROM TaskEvent',artifacts:'SELECT * FROM CapturedArtifact',acquisitions:'SELECT * FROM ArtifactAcquisition',sessionStates:'SELECT id,nativeId FROM SessionState'};console.log(JSON.stringify(Object.fromEntries(Object.entries(tables).map(([k,q])=>[k,db.prepare(q).all()]))));";
  return JSON.parse(
    (await run("docker", ["exec", name("control-plane"), "node", "-e", script])).stdout,
  );
}
async function launch(
  service: string,
  script: string,
  marker: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
) {
  const container = name(service);
  containers.push(container);
  await run(
    "docker",
    [
      "run",
      "-d",
      "--name",
      container,
      "--hostname",
      service,
      "--network",
      network,
      "--network-alias",
      service,
      "--init",
      ...args,
      image,
      "node",
      `/app/${script}.js`,
    ],
    { env },
  );
  await eventually(async () => {
    const logs = await run("docker", ["logs", container]);
    const running = (
      await run("docker", ["inspect", "-f", "{{.State.Running}}", container])
    ).stdout.trim();
    assert.equal(running, "true", `${service} stopped: ${redact(logs.stderr)}`);
    return logs.stdout.includes(marker);
  });
}
await save("run.json", {
  objectiveId,
  model: "gpt-5.6-luna",
  seccomp: values["allow-unconfined-seccomp"] ? "unconfined" : "default",
  maxSeconds,
  maxAttempts,
});
try {
  await run("docker", ["info", "--format", "{{.ServerVersion}}"]);
  if (!values["skip-build"]) await run("pnpm", ["build"]);
  const build = join(directory, "build");
  await mkdir(build);
  await mkdir(join(directory, "certificates"));
  await mkdir(join(directory, "control-plane"), { mode: 0o700 });
  await run("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-days",
    "1",
    "-keyout",
    join(directory, "certificates/server.key"),
    "-out",
    join(directory, "certificates/server.crt"),
    "-subj",
    "/CN=control-plane",
    "-addext",
    "subjectAltName=DNS:control-plane,IP:127.0.0.1",
  ]);
  tlsCa = await readFile(join(directory, "certificates/server.crt"), "utf8");
  await run("pnpm", ["--filter", "supertag-ai", "pack", "--pack-destination", build]);
  const archive = (await readdir(build)).find((file) => file.endsWith(".tgz"));
  assert(archive, "Public package archive missing");
  await cp(join(build, archive), join(build, "supertag-ai.tgz"));
  if (archive !== "supertag-ai.tgz") await rm(join(build, archive));
  await run("pnpm", [
    "exec",
    "esbuild",
    "tests/fixtures/organization-docker-control-plane.ts",
    "scripts/fixtures/artifact-organization-docker-worker.ts",
    "--bundle",
    "--platform=node",
    "--format=esm",
    "--conditions=development",
    "--outbase=.",
    `--outdir=${join(build, "compiled")}`,
    "--external:better-sqlite3",
    "--external:ws",
    "--external:supertag-ai/*",
    '--banner:js=import { createRequire } from "node:module"; const require = createRequire(import.meta.url); const __dirname = import.meta.dirname; const __filename = import.meta.filename;',
  ]);
  await mkdir(join(build, "app"));
  await cp(
    join(build, "compiled/tests/fixtures/organization-docker-control-plane.js"),
    join(build, "app/organization-docker-control-plane.js"),
  );
  await cp(
    join(build, "compiled/scripts/fixtures/artifact-organization-docker-worker.js"),
    join(build, "app/artifact-organization-docker-worker.js"),
  );
  await cp(join(root, "packages/store/drizzle"), join(build, "drizzle"), { recursive: true });
  await writeFile(
    join(build, "Dockerfile"),
    [
      "FROM node:24-bookworm-slim",
      "RUN apt-get update && apt-get install --no-install-recommends --yes ca-certificates git && rm -rf /var/lib/apt/lists/*",
      "WORKDIR /app",
      "COPY supertag-ai.tgz /app/supertag-ai.tgz",
      "RUN npm install --omit=dev --no-audit --no-fund /app/supertag-ai.tgz better-sqlite3@12.11.1 ws@8.19.0 && rm /app/supertag-ai.tgz",
      'RUN echo \'{"type":"module"}\' > package.json',
      "COPY app/ /app/",
      "COPY drizzle/ /drizzle/",
    ].join("\n"),
  );
  process.stdout.write(`Building native Docker organization; evidence: ${directory}\n`);
  await run("docker", ["build", "-t", image, build]);
  await run("docker", ["network", "create", network]);
  await launch(
    "control-plane",
    "organization-docker-control-plane",
    "Organization API ready",
    [
      "-p",
      "127.0.0.1::8790",
      "-v",
      `${join(directory, "certificates")}:/certificates:ro`,
      "-v",
      `${join(directory, "control-plane")}:/state`,
      "-e",
      "SUPERTAG_TEST_ADMIN_TOKEN",
    ],
    { ...process.env, SUPERTAG_TEST_ADMIN_TOKEN: adminToken },
  );
  const port = (await run("docker", ["port", name("control-plane"), "8790/tcp"])).stdout.match(
    /:(\d+)\s*$/,
  )?.[1];
  assert(port);
  apiUrl = `https://127.0.0.1:${port}`;
  for (const workerId of ["worker-a", "worker-b"]) {
    const home = join(directory, workerId, "home"),
      state = join(directory, workerId, "state");
    await mkdir(state, { recursive: true, mode: 0o700 });
    await stageWorkerAuth({ name: "codex", homeDirectory: home });
    const issuance = await api("POST", "/supertag.operator.v1.HostService/EnrollWorkerHost", {
      id: workerId,
    });
    const token = issuance["token"];
    assert.equal(typeof token, "string");
    secrets.push(token as string);
    await launch(
      workerId,
      "artifact-organization-docker-worker",
      "Artifact organization Worker ready",
      [
        "--read-only",
        "--cap-drop",
        "ALL",
        "--user",
        `${getuid?.() ?? 1000}:${getgid?.() ?? 1000}`,
        ...(values["allow-unconfined-seccomp"] ? ["--security-opt", "seccomp=unconfined"] : []),
        "--tmpfs",
        "/tmp:rw,nosuid,nodev",
        "-v",
        `${home}:/worker-home`,
        "-v",
        `${state}:/state`,
        "-v",
        `${join(directory, "certificates/server.crt")}:/certificates/server.crt:ro`,
        "-e",
        "HOME=/worker-home",
        "-e",
        "CODEX_HOME=/worker-home/.codex",
        "-e",
        `WORKER_ID=${workerId}`,
        "-e",
        "SUPERTAG_WORKLET_CREDENTIAL",
        "-e",
        "NODE_EXTRA_CA_CERTS=/certificates/server.crt",
        "-e",
        "SUPERTAG_LIVE_CODEX_MODEL=gpt-5.6-luna",
        "-e",
        "SUPERTAG_LIVE_ATTEMPT_MS=180000",
      ],
      { ...process.env, SUPERTAG_WORKLET_CREDENTIAL: token as string },
    );
  }
  await eventually(
    async () =>
      rows((await api("GET", "/api/v1/worker-profiles"))["items"]).filter(
        (item) => record(item["status"])["phase"] === "available",
      ).length === 2,
  );
  const resource = (kind: string, name: string, spec: object) => ({
    apiVersion: "supertag/v1",
    kind,
    metadata: { name },
    spec,
  });
  await api(
    "POST",
    "/api/v1/permission-sets",
    resource("PermissionSet", "artifact-work", {
      permissions: ["files:write", "commands:execute", "web:fetch"].map((action) => ({
        target: "runtime",
        action,
      })),
    }),
  );
  const context =
    "This Objective runs on isolated Docker Worker Hosts. Files are private to each Attempt and disappear after it finishes; all inter-agent work must be read through artifact tools. Write reports to your own SUPERTAG_OUTPUT_DIR so the Worker preserves them as artifacts. Use find_artifacts, inspect_artifact, and read_artifact to retrieve previous work, and record the producer's native harnessSession in reviews. Do not read another host's filesystem. The Objective's conversation starts work Sessions with start_session, naming a Team member Tag with tag to delegate; each work Session's report arrives as the conversation's next turn. Complete the Objective with update_objective. Do not start more than six work Sessions. Native subagents are disabled. Never poll or sleep while waiting; end the turn. Use read_objective to obtain IDs and current state.";
  for (const [role, instructions] of [
    [
      "Delivery owner",
      "Own the outcome: prepare evidence, obtain independent review, check the review's report, and complete the Objective only when its success criteria are met.",
    ],
    [
      "Independent reviewer",
      "Independently verify the source artifact, its calculations and recommendation, and submit a review artifact that quotes the exact producer native session reference and SOURCE_NONCE from its source report. Do not claim Objective owner authority.",
    ],
  ] as const)
    await api(
      "POST",
      "/api/v1/roles",
      resource("Role", role, {
        purpose: role,
        instructions: `${context} ${instructions}`,
        permissionSets: ["artifact-work"],
        contextSets: [],
      }),
    );
  const owner = record(
    (
      await api(
        "POST",
        "/api/v1/tags",
        resource("Tag", "Delivery owner", {
          roles: ["Delivery owner"],
          workerHosts: ["worker-a"],
        }),
      )
    )["metadata"],
  )["id"] as string;
  const reviewer = record(
    (
      await api(
        "POST",
        "/api/v1/tags",
        resource("Tag", "Independent reviewer", {
          roles: ["Independent reviewer"],
          workerHosts: ["worker-b"],
        }),
      )
    )["metadata"],
  )["id"] as string;

  const practices = 17,
    weeklyMinutes = 43,
    weeks = 8,
    expectedMinutes = practices * weeklyMinutes * weeks;
  // The only work request issued by the runner: applying the Objective starts its conversation.
  // Every work Session after that is a model decision.
  await api(
    "POST",
    "/api/v1/objectives",
    resource("Objective", objectiveId, {
      owner: "Delivery owner",
      outcome: [
        `Prepare an independently reviewed pilot recommendation for a scheduling product. Source facts: ${practices} practices, ${weeklyMinutes} minutes saved per practice per week, ${weeks} pilot weeks. Determine total minutes saved. Generate a fresh random UUID in your runtime and include it in the source report as SOURCE_NONCE: <uuid>. Produce a source report, have the Independent reviewer Tag independently review the actual artifact and calculations in a work Session of its own, and deliver the final recommendation. Keep report contents in artifacts, not duplicated into work Session instructions or messages. The reviewer must discover and read the source artifact through artifact tools. Start the review only after the source report's work Session reported. Your role supplies runtime details; organize the work yourself.`,
        "Done when:",
        "A source report records the evidence and correct total minutes",
        "A different Tag reads that artifact in a separate Docker Worker Host and publishes an independent review with the producer native session ID",
        "The owner reads the review, preserves a final recommendation artifact, and completes the Objective",
      ].join("\n"),
      team: { members: ["Delivery owner", "Independent reviewer"] },
      runtimeActions: ["files:write", "commands:execute", "web:fetch"],
      budget: { minor: 100 },
    }),
  );
  let state = await snapshot();
  const deadline = Date.now() + maxSeconds * 1000;
  let lastCount = -1;
  let stalledSince: number | undefined;
  while (Date.now() < deadline) {
    state = await snapshot();
    const starts = (state["events"] ?? []).filter(
      (event) => event["type"] === "execution.started",
    ).length;
    if (starts !== lastCount) {
      process.stdout.write(
        `Objective ${objectiveId}: ${starts} model Attempts; status ${state["objectives"]?.[0]?.["status"]}\n`,
      );
      lastCount = starts;
    }
    assert(starts <= maxAttempts, "Live model Attempt budget exceeded");
    const status = state["objectives"]?.[0]?.["status"];
    assert(status !== "blocked", "The Objective's conversation blocked the Objective");
    const active =
      (state["tasks"] ?? []).some((task) =>
        ["pending", "running"].includes(String(task["status"])),
      ) ||
      (state["inbound"] ?? []).some((event) =>
        ["pending", "processing"].includes(String(event["status"])),
      );
    if ((state["tasks"] ?? []).length && !active && status !== "completed") {
      stalledSince ??= Date.now();
      assert(
        Date.now() - stalledSince < 15_000,
        "Organization stalled with no pending or running turns",
      );
    } else stalledSince = undefined;
    const attempts = state["attempts"] ?? [];
    if (
      state["objectives"]?.[0]?.["status"] === "completed" &&
      attempts.every((attempt) =>
        ["completed", "failed", "cancelled"].includes(String(attempt["status"])),
      )
    )
      break;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  const artifacts = state["artifacts"] ?? [],
    acquisitions = state["acquisitions"] ?? [],
    tasks = state["tasks"] ?? [],
    attempts = state["attempts"] ?? [];
  const evidence = {
    objectiveId,
    objectives: state["objectives"],
    sessions: state["sessions"],
    attempts: attempts.map(({ workerSnapshot, ...rest }) => ({
      ...rest,
      workerHostId: json(workerSnapshot)["workerHostId"],
    })),
    tasks: tasks.map(({ id, tagId, sessionId, status }) => ({ id, tagId, sessionId, status })),
    artifacts,
    acquisitions,
    teams: state["teams"],
    hosts: (state["hosts"] ?? []).map(({ credentialHash: _credential, ...rest }) => rest),
    events: (state["events"] ?? []).filter((event) => event["type"] !== "runtime-inputs.resolved"),
    expectedMinutes,
  };
  await save("evidence.json", evidence);
  const nativeSessions: Row[] = [];
  for (const workerId of ["worker-a", "worker-b"]) {
    const log = (await run("docker", ["logs", name(workerId)])).stdout;
    for (const line of log.split("\n")) {
      try {
        const event = record(JSON.parse(line));
        if (event["type"] === "native-session") nativeSessions.push(event);
      } catch {
        /* Worker readiness and transport diagnostics are not JSON events. */
      }
    }
    const attemptRoot = join(directory, workerId, "state/attempts");
    for (const entry of await readdir(attemptRoot)) {
      assert(
        entry.startsWith(".supertag-attempt-owners-"),
        `Attempt directory remains after completion: ${workerId}/${entry}`,
      );
      assert.deepEqual(
        await readdir(join(attemptRoot, entry)),
        [],
        "Attempt ownership remains after completion",
      );
    }
  }
  await save("native-sessions.json", nativeSessions);
  const contents: Array<{ artifactId: unknown; tagId: unknown; path: unknown; text: string }> = [];
  for (const artifact of artifacts) {
    const entries =
      typeof artifact["entries"] === "string"
        ? rows(JSON.parse(artifact["entries"]))
        : rows(artifact["entries"]);
    for (const entry of entries) {
      const digest = String(entry["digest"]).replace(/^sha256:/, "");
      assert(/^[a-f0-9]{64}$/.test(digest));
      const bytes = await hostCopy(directory, digest);
      assert.equal(createHash("sha256").update(bytes).digest("hex"), digest);
      if (bytes.length <= 64_000 && /\.(md|txt|json)$/.test(String(entry["path"])))
        contents.push({
          artifactId: artifact["id"],
          tagId: artifact["tagId"],
          path: entry["path"],
          text: bytes.toString("utf8"),
        });
    }
  }
  await save("artifact-text.json", contents);
  const verification = verifyArtifactOrganizationEvidence({
    state,
    contents,
    nativeSessions,
    owner,
    reviewer,
    expectedMinutes,
  });
  passed = true;
  await save("report.json", {
    passed,
    objectiveId,
    model: "gpt-5.6-luna",
    workerHosts: ["worker-a", "worker-b"],
    attempts: attempts.length,
    artifacts: artifacts.length,
    verification,
    expectedMinutes,
    sourceNonce: verification.sourceNonce,
    seccomp: values["allow-unconfined-seccomp"] ? "unconfined" : "default",
  });
} catch (error) {
  if (apiUrl) {
    try {
      const failed = await snapshot();
      await save("failure-state.json", {
        objectives: failed["objectives"],
        sessions: failed["sessions"],
        artifacts: failed["artifacts"],
        acquisitions: failed["acquisitions"],
        attempts: failed["attempts"],
        events: (failed["events"] ?? []).filter(
          (event) => event["type"] !== "runtime-inputs.resolved",
        ),
      });
    } catch {
      /* Preserve the original error when state is unavailable. */
    }
  }
  await save("failure.json", {
    passed: false,
    error: error instanceof Error ? error.message : String(error),
  });
  throw error;
} finally {
  for (const container of containers) {
    const logs = await run("docker", ["logs", container]).catch(() => ({
      stdout: "",
      stderr: "Logs unavailable",
    }));
    await writeFile(join(directory, `${container}.log`), redact(`${logs.stdout}${logs.stderr}`), {
      mode: 0o600,
    });
  }
  const cleanup = await Promise.allSettled(
    containers.map((container) => run("docker", ["rm", "-f", container])),
  );
  const infrastructure = await Promise.allSettled([
    run("docker", ["network", "rm", network]),
    run("docker", ["image", "rm", image]),
  ]);
  for (const workerId of ["worker-a", "worker-b"]) {
    await rm(join(directory, workerId, "home"), { recursive: true, force: true });
    // Interrupted Attempts can retain native auth copies and runtime bearer bindings.
    // Keep the exported evidence, not private execution directories or journals.
    await rm(join(directory, workerId, "state"), { recursive: true, force: true });
  }
  await rm(join(directory, "certificates/server.key"), { force: true });
  await save("cleanup.json", {
    containers: cleanup.map((result) => result.status),
    infrastructure: infrastructure.map((result) => result.status),
    stagedCredentialsRemoved: true,
  });
  if ([...cleanup, ...infrastructure].some((result) => result.status === "rejected"))
    process.exitCode = 1;
  process.stdout.write(
    `Artifact organization ${passed ? "passed" : "failed"}; evidence ${directory}\n`,
  );
}

/** An artifact's bytes from the Worker Host that holds them; the Control Plane keeps none. */
async function hostCopy(directory: string, digest: string): Promise<Buffer> {
  for (const host of await readdir(directory, { withFileTypes: true })) {
    if (!host.isDirectory()) continue;
    const bytes = await readFile(
      join(directory, host.name, "state/artifacts/sha256", digest),
    ).catch(() => undefined);
    if (bytes) return bytes;
  }
  throw new Error(`No Worker Host in ${directory} holds sha256:${digest}`);
}
