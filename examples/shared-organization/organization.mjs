import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { copyFile, cp, mkdir, open, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { checkCoordinationTls, generateCoordinationTls } from "./coordination-tls.mjs";
import {
  buildDockerWorkerImage,
  cleanupDockerWorkerHosts,
  removeDockerWorkerImage,
  startDockerWorker,
  stopDockerWorker,
} from "./docker-workers.mjs";
import { installedCodexVersion, startModal, stopModal } from "./execution.mjs";

const run = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const stateDirectory = resolve(
  process.env.SUPERTAG_EXAMPLE_STATE ?? join(homedir(), ".supertag/examples/shared-organization"),
);
const statePath = join(stateDirectory, "state.json");
const command = process.argv[2];
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const print = (value) => console.log(JSON.stringify(value));
const load = () => readFile(statePath, "utf8").then(JSON.parse);
const save = (value) =>
  writeFile(statePath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
const secret = (name) => readFile(join(stateDirectory, name), "utf8");
const sdkBin = () =>
  join(dirname(createRequire(import.meta.url).resolve("supertag-ai/package.json")), "dist/cli.js");
async function request(state, method, path, body) {
  const response = await fetch(`${state.managementUrl}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${await secret("admin-token")}`,
      "content-type": "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(15000),
  });
  const value = await response.json();
  if (!response.ok)
    throw new Error(`${method} ${path}: ${response.status} ${JSON.stringify(value)}`);
  return value;
}
const rpc = (state, service, method, body = {}) =>
  request(state, "POST", `/supertag.operator.v1.${service}/${method}`, body);
async function waitUntil(check, timeout = 60000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try {
      const result = await check();
      if (result) return result;
    } catch (error) {
      last = error;
    }
    await sleep(500);
  }
  throw new Error(`Service did not become ready${last ? `: ${last.message}` : ""}`);
}
async function launch(name, args, env) {
  const log = await open(join(stateDirectory, `${name}.log`), "a", 0o600);
  try {
    const child = spawn(process.execPath, args, {
      cwd: here,
      env,
      detached: true,
      stdio: ["ignore", log.fd, log.fd],
    });
    await new Promise((done, fail) => {
      child.once("spawn", done);
      child.once("error", fail);
    });
    child.unref();
    const identity = (await run("ps", ["-p", String(child.pid), "-o", "lstart="])).stdout.trim();
    return { pid: child.pid, identity };
  } finally {
    await log.close();
  }
}
async function stop(record, signal = "SIGTERM") {
  if (!record?.pid) return { stopped: true };
  const owned = async () =>
    (await run("ps", ["-p", String(record.pid), "-o", "lstart="])
      .then((result) => result.stdout.trim())
      .catch(() => "")) === record.identity;
  if (!(await owned())) return { stopped: true };
  const send = (value) => {
    try {
      process.kill(-record.pid, value);
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  };
  send(signal);
  const deadline = Date.now() + (signal === "SIGKILL" ? 5000 : 15000);
  while (Date.now() < deadline) {
    if (!(await owned())) return { stopped: true };
    await sleep(200);
  }
  if (await owned()) send("SIGKILL");
  await waitUntil(async () => !(await owned()), 5000);
  return {
    stopped: true,
    forced: true,
    outcome: "Execution may remain uncertain; inspect retained journals and Task state",
  };
}
async function cpEnvironment(state) {
  const environment = { ...process.env };
  for (const key of Object.keys(environment))
    if (key.startsWith("SUPERTAG_")) delete environment[key];
  return {
    ...environment,
    SUPERTAG_STATE_DIR: join(stateDirectory, "control-plane"),
    SUPERTAG_DATABASE_URL: `file:${join(stateDirectory, "control-plane", "supertag.db")}`,
    SUPERTAG_ADMIN_TOKEN: await secret("admin-token"),
    SUPERTAG_WORKLET_TRANSPORT: "remote",
    SUPERTAG_COORDINATION_URL: state.coordinationUrl ?? state.workerApiUrl ?? state.managementUrl,
  };
}
async function startControlPlane(state) {
  state.controlPlane = await launch(
    "control-plane",
    [
      sdkBin(),
      "control-plane",
      "--host",
      "127.0.0.1",
      "--port",
      String(new URL(state.managementUrl).port),
    ],
    await cpEnvironment(state),
  );
  await save(state);
  await waitUntil(() => request(state, "GET", "/api/v1/worker-hosts"));
}
async function freePort() {
  const server = createServer();
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const port = server.address().port;
  await new Promise((done) => server.close(done));
  return port;
}
const resource = (kind, name, spec) => ({
  apiVersion: "supertag/v1",
  kind,
  metadata: { name },
  spec,
});
async function bootstrap() {
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  if (await load().catch(() => undefined))
    throw new Error(
      "This state directory already has an example. Inspect status or choose a fresh SUPERTAG_EXAMPLE_STATE.",
    );
  const provider = process.env.SUPERTAG_EXAMPLE_PROVIDER ?? "docker";
  if (!["docker", "modal"].includes(provider)) throw new Error("Choose docker or modal execution");
  const workerHostsMode = process.env.SUPERTAG_EXAMPLE_WORKER_HOSTS ?? "process";
  if (!["process", "docker"].includes(workerHostsMode))
    throw new Error("Choose process or docker Worker Hosts");
  const suffix = randomBytes(5).toString("hex");
  const state = {
    stateDirectory,
    objectiveId: "shared-csv",
    provider,
    workerHosts: workerHostsMode,
    ...(workerHostsMode === "docker"
      ? {
          workerOwner: randomBytes(16).toString("hex"),
          workerImageName: `supertag-org-workers:${suffix}`,
          workerNetwork: process.platform === "linux" ? "host" : "bridge",
        }
      : {}),
    mcp: provider === "modal" || process.env.SUPERTAG_EXAMPLE_MCP === "1",
    containerName: `supertag-shared-org-${suffix}`,
    imageName: `supertag-shared-org:${suffix}`,
    managementUrl: `http://127.0.0.1:${await freePort()}`,
    workers: {},
  };
  state.workerApiUrl = state.managementUrl;
  if (workerHostsMode === "docker" && state.workerNetwork !== "host")
    state.workerApiUrl = state.managementUrl.replace("127.0.0.1", "host.docker.internal");
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  for (const filename of ["admin-token", "execution-token", "mcp-token"])
    await writeFile(join(stateDirectory, filename), randomBytes(32).toString("hex"), {
      mode: 0o600,
      flag: "wx",
    });
  if (workerHostsMode === "docker") {
    state.coordinationTls = await generateCoordinationTls(join(stateDirectory, "coordination-tls"));
    const port = await freePort();
    state.coordinationUrl = `https://${new URL(state.workerApiUrl).hostname}:${port}`;
    const configPath = join(stateDirectory, "coordination-tls.json");
    await writeFile(
      configPath,
      JSON.stringify({
        targetUrl: state.managementUrl,
        certFile: state.coordinationTls.certFile,
        keyFile: state.coordinationTls.keyFile,
        port,
      }),
      { mode: 0o600, flag: "wx" },
    );
    state.coordinationProxy = await launch(
      "coordination-tls",
      [join(here, "coordination-tls.mjs"), configPath],
      process.env,
    );
    await save(state);
    await waitUntil(
      () => checkCoordinationTls(`https://127.0.0.1:${port}`, state.coordinationTls.caFile),
      10000,
    );
  }
  const build = join(stateDirectory, "build");
  for (const dir of [
    build,
    join(stateDirectory, "workspace"),
    join(stateDirectory, "execution-state"),
  ])
    await mkdir(dir, { recursive: true, mode: 0o700 });
  const sdkDirectory = dirname(createRequire(import.meta.url).resolve("supertag-ai/package.json"));
  await readFile(join(sdkDirectory, "dist/environments/shared-execution.js"));
  const packed = JSON.parse(
    (
      await run(
        "npm",
        ["pack", sdkDirectory, "--ignore-scripts", "--pack-destination", build, "--json"],
        {
          maxBuffer: 10 * 1024 * 1024,
        },
      )
    ).stdout,
  )[0];
  await copyFile(join(build, packed.filename), join(build, "supertag-ai.tgz"));
  for (const filename of ["Dockerfile", "execution-service.mjs", "mcp-fixture.cjs"])
    await copyFile(join(here, filename), join(build, filename));
  if (workerHostsMode === "docker") {
    for (const filename of ["Worker.Dockerfile", "worker.mjs", "mcp-tools.mjs"])
      await copyFile(join(here, filename), join(build, filename));
    await cp(join(here, "seed"), join(build, "seed"), { recursive: true });
    await buildDockerWorkerImage(state, build, save);
  }
  const codexVersion = await installedCodexVersion();
  if (provider === "modal") {
    await startModal(state, {
      build,
      codexVersion,
      token: await secret("execution-token"),
      mcpToken: state.mcp ? await secret("mcp-token") : undefined,
      save,
    });
  } else {
    await run(
      "docker",
      ["build", "--build-arg", `CODEX_VERSION=${codexVersion}`, "-t", state.imageName, build],
      { maxBuffer: 30 * 1024 * 1024 },
    );
    await run(
      "docker",
      [
        "run",
        "-d",
        "--name",
        state.containerName,
        "-p",
        "127.0.0.1::8787",
        "-e",
        "SUPERTAG_SHARED_EXECUTION_ADMIN_TOKEN",
        "-e",
        "SUPERTAG_EXAMPLE_MCP_TOKEN",
        "-v",
        `${join(stateDirectory, "workspace")}:/data`,
        "-v",
        `${join(stateDirectory, "execution-state")}:/state`,
        state.imageName,
      ],
      {
        env: {
          ...process.env,
          SUPERTAG_SHARED_EXECUTION_ADMIN_TOKEN: await secret("execution-token"),
          SUPERTAG_EXAMPLE_MCP_TOKEN: state.mcp ? await secret("mcp-token") : "",
        },
      },
    );
    const port = /:(\d+)\s*$/.exec(
      (await run("docker", ["port", state.containerName, "8787/tcp"])).stdout,
    )?.[1];
    if (!port) throw new Error("Could not resolve execution service port");
    state.executionUrl = `http://127.0.0.1:${port}`;
  }
  await save(state);
  await waitUntil(
    async () =>
      (await fetch(`${state.executionUrl}/healthz`, { signal: AbortSignal.timeout(3000) })).ok,
  );
  if (state.mcp) {
    const { runMcpPreflight } = await import("./mcp-preflight.mjs");
    state.mcpProbe = await runMcpPreflight({
      state,
      token: await secret("mcp-token"),
      executionToken: await secret("execution-token"),
    });
    await save(state);
    if (!state.mcpProbe.passed)
      throw new Error("MCP preflight failed; inspect private state and clean up before retrying");
  }
  await run(process.execPath, [sdkBin(), "migrate"], { env: await cpEnvironment(state) });
  await startControlPlane(state);
  await request(
    state,
    "POST",
    "/api/v1/permission-sets",
    resource("PermissionSet", "shared-workspace", {
      permissions: ["files:write", "commands:execute", "web:fetch"].map((action) => ({
        target: "runtime",
        action,
      })),
    }),
  );
  state.tagIds = {};
  for (const name of ["claude", "codex"]) {
    const role = name === "claude" ? "Delivery manager" : "Review manager";
    await request(
      state,
      "POST",
      "/api/v1/roles",
      resource("Role", role, {
        purpose:
          name === "claude"
            ? "Deliver a working, independently reviewed CSV utility"
            : "Independently examine work and report reproducible evidence",
        instructions: `${state.mcp ? "At the beginning of every Task, call both example_stdio and example_http exchange MCP tools with collection docs, action read. Read and report the already committed INTERRUPTED_HANDOFF note; do not publish it again. These are actual MCP calls, not shell/file substitutes. Then proceed with your work. " : ""}Read BRIEF.md. You are the ${role.toLowerCase()}. The shared execution workspace is the place for source code and tests. The two existing execution profiles are shared-claude and shared-codex, revision 1. Do not create new Tags. Keep total work Sessions at most eight. Always include the reviewed SHA-256 in review evidence. ${name === "claude" ? "You own the Objective. Do the work in work Sessions: start_session {title, instruction} runs one as your own Tag, and start_session {title, instruction, tag} gives one to the review manager in your Team, who runs it under their own Roles. Each work Session reports back as a turn of this conversation; review that report, then accept it or send fixes with continue_session. Reach the other manager directly with send_message {to, text} and record shared progress with post {text, to?}. End each turn with work running or a question asked; complete the Objective only after independent review succeeds." : "You review work the delivery manager gives you. Report your findings in your final reply, which returns to the Objective that started your Session, and reach the delivery manager directly with send_message {to, text}; do not claim owner authority."}`,
        contextSets: [],
        permissionSets: ["shared-workspace"],
      }),
    );
    const tag = await request(
      state,
      "POST",
      "/api/v1/tags",
      resource("Tag", `Shared ${name} manager`, { roles: [role] }),
    );
    state.tagIds[name] = tag.metadata.id;
    const hostId = `shared-${name}-host`;
    const enrollment = await request(state, "POST", "/api/v1/worker-hosts", {
      apiVersion: "supertag/v1",
      kind: "WorkerHostEnrollment",
      metadata: { id: hostId },
      spec: {},
    });
    await writeFile(
      join(stateDirectory, `${name}.json`),
      JSON.stringify(
        {
          hostId,
          workletUrl: `${state.workerApiUrl.replace("http:", "ws:")}/worklets`,
          executionUrl:
            workerHostsMode === "docker" && state.workerNetwork !== "host"
              ? state.executionUrl.replace("127.0.0.1", "host.docker.internal")
              : state.executionUrl,
          executionToken: await secret("execution-token"),
          ...(state.mcp ? { mcpToken: await secret("mcp-token") } : {}),
          credential: enrollment.credential.token,
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
    await save(state);
  }
  const managers = ["Shared claude manager", "Shared codex manager"];
  const team = await rpc(state, "TeamService", "CreateTeam", {
    id: "shared-review",
    name: "Independent review",
    members: managers,
    maxConcurrency: 2,
  });
  state.teamId = team.id;
  for (const [sender, recipient] of [managers, managers.toReversed()])
    await rpc(state, "MailboxService", "GrantMailbox", { sender, recipient });
  state.ready = true;
  await save(state);
  print({
    ready: true,
    stateDirectory,
    statePath,
    managementUrl: state.managementUrl,
    objectiveId: state.objectiveId,
  });
}
async function start() {
  const state = await load();
  if (!state.ready)
    throw new Error(
      "Bootstrap did not complete; inspect private logs and cleanup before retrying with fresh state.",
    );
  if (state.started)
    throw new Error("This Objective was already started. Use status; do not replay it.");
  for (const name of ["claude", "codex"]) {
    if (state.workerHosts === "docker") {
      await startDockerWorker(state, name, save);
      continue;
    }
    const previous = state.workers[name];
    const identity = previous
      ? await run("ps", ["-p", String(previous.pid), "-o", "lstart="])
          .then((result) => result.stdout.trim())
          .catch(() => "")
      : "";
    if (identity && identity === previous.identity) continue;
    const environment = { ...process.env };
    for (const key of Object.keys(environment))
      if (key.startsWith("SUPERTAG_") && !key.startsWith("SUPERTAG_EXAMPLE_"))
        delete environment[key];
    delete environment.SUPERTAG_EXAMPLE_WORKER_CONFIG;
    delete environment.SUPERTAG_EXAMPLE_WORKER_STATE;
    state.workers[name] = await launch(name, [join(here, "worker.mjs"), name], {
      ...environment,
      SUPERTAG_EXAMPLE_STATE: stateDirectory,
    });
    await save(state);
  }
  await waitUntil(async () => {
    const profiles = await request(state, "GET", "/api/v1/worker-profiles");
    return ["shared-claude", "shared-codex"].every((id) =>
      profiles.items.some(
        (profile) => profile.spec.ref.id === id && profile.status.phase === "available",
      ),
    );
  });
  // Persist intent before the non-idempotent request. Recovery inspects the existing Objective.
  state.started = new Date().toISOString();
  await save(state);
  // Creating the Objective starts its conversation: the owner Tag takes its first turn at once.
  const result = await request(
    state,
    "POST",
    "/supertag.operator.v1.ObjectiveService/CreateObjective",
    {
      id: state.objectiveId,
      owner: "Shared claude manager",
      team: state.teamId,
      outcome: [
        "Build csv-summary.mjs to the specification in BRIEF.md, obtain independent review from the review manager in review.md, and complete the Objective with that evidence.",
        "Done when:",
        ...[
          "The dependency-free CSV summary module passes reproducible tests",
          "The independent review manager reviews the actual source and records its SHA-256",
          "The managers exchange work and review evidence through their Sessions, Mailboxes, and the Team's Workstream",
        ].map((criterion) => `- ${criterion}`),
      ].join("\n"),
      runtimeActions: ["files:write", "commands:execute", "web:fetch"],
      budget: { limitMinor: 1000 },
    },
  );
  print({ started: true, stateDirectory, objectiveId: state.objectiveId, result });
}
async function status() {
  const state = await load();
  const objective = await request(
    state,
    "POST",
    "/supertag.operator.v1.ObjectiveService/GetObjective",
    {
      id: state.objectiveId,
    },
  ).catch(() => undefined);
  const { tasks = [] } = await rpc(state, "WorkService", "ListTasks", { pageSize: 500 });
  const attempts = await Promise.all(
    tasks.map(async (task) => ({
      taskId: task.id,
      events: (
        await rpc(state, "WorkService", "ListTaskEvents", { taskId: task.id, pageSize: 1000 })
      ).events,
    })),
  );
  const messages = [
    ...new Map(
      (
        await Promise.all(
          Object.keys(state.tagIds).map(
            async (name) =>
              (
                await rpc(state, "MailboxService", "ListTagMessages", {
                  tag: `Shared ${name} manager`,
                  pageSize: 200,
                })
              ).messages ?? [],
          ),
        )
      )
        .flat()
        .map((message) => [message.id, message]),
    ).values(),
  ];
  print({
    stateDirectory,
    managementUrl: state.managementUrl,
    objective,
    posts:
      (
        await rpc(state, "MailboxService", "ListWorkstreamPosts", {
          team: state.teamId ?? "",
        }).catch(() => ({}))
      ).posts ?? [],
    tasks,
    attempts,
    messages,
    workerHosts: (await request(state, "GET", "/api/v1/worker-hosts")).items,
  });
}
async function cleanupExecution(state) {
  if (state.provider === "modal") await stopModal(state);
  else
    for (const [kind, name] of [
      ["container", state.containerName],
      ["image", state.imageName],
    ]) {
      const present = await run("docker", [kind, "inspect", name])
        .then(() => true)
        .catch((error) => {
          if (/No such (?:object|container|image)/i.test(error.stderr ?? "")) return false;
          throw error;
        });
      if (present)
        await run("docker", kind === "container" ? ["rm", "-f", name] : ["image", "rm", name]);
    }
}
async function cleanup() {
  const state = await load().catch((error) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (state === undefined) return print({ stopped: true, stateDirectory });
  if (state === null || typeof state !== "object" || Array.isArray(state))
    throw new Error("Invalid example state; cleanup cannot verify owned resources");
  // Request cancellation before stopping execution; retained journals describe any uncertainty.
  if (state.started) {
    const { tasks: active = [] } = await rpc(state, "WorkService", "ListTasks", {
      statuses: ["TASK_STATUS_PENDING", "TASK_STATUS_RUNNING"],
      pageSize: 500,
    }).catch(() => ({}));
    const cancel = (task) =>
      rpc(state, "WorkService", "CancelTask", { id: task.id }).catch(() => undefined);
    if (state.workerHosts === "docker") await Promise.all(active.map(cancel));
    else for (const task of active) await cancel(task);
  }
  if (state.workerHosts === "docker") {
    await cleanupDockerWorkerHosts(state, {
      stopControlPlane: async () => {
        const results = await Promise.allSettled([
          stop(state.coordinationProxy),
          stop(state.controlPlane),
        ]);
        const failures = results.filter((result) => result.status === "rejected");
        if (failures.length)
          throw new AggregateError(
            failures.map((result) => result.reason),
            "Local Control Plane endpoint cleanup could not be confirmed",
          );
        return {
          stopped: true,
          ...(results.some((result) => result.value.forced) ? { forced: true } : {}),
        };
      },
      stopExecution: () => cleanupExecution(state),
      save,
    });
    print({ stopped: true, stateDirectory, evidencePreserved: true, shutdown: state.shutdown });
    return;
  }
  state.shutdown = await Promise.all(
    Object.values(state.workers ?? {}).map((record) =>
      record.kind === "docker" ? stopDockerWorker(state, record) : stop(record),
    ),
  );
  state.shutdown.push(await stop(state.controlPlane));
  await removeDockerWorkerImage(state);
  await cleanupExecution(state);
  state.stopped = new Date().toISOString();
  await save(state);
  print({ stopped: true, stateDirectory, evidencePreserved: true, shutdown: state.shutdown });
}
if (!command || ["--help", "help"].includes(command)) {
  console.log(
    "node organization.mjs bootstrap|start|status|cleanup|restart-control-plane\nConfigure SUPERTAG_EXAMPLE_STATE to select private persistent state. SUPERTAG_EXAMPLE_PROVIDER=docker|modal selects execution; SUPERTAG_EXAMPLE_WORKER_HOSTS=process|docker selects Worker Hosts. Bootstrap starts execution and Control Plane; start runs native Claude Code and Codex using their local logins.",
  );
} else {
  try {
    if (command === "bootstrap") await bootstrap();
    else if (command === "start") await start();
    else if (command === "status") await status();
    else if (command === "cleanup") await cleanup();
    else if (command === "restart-control-plane") {
      const state = await load();
      await stop(state.controlPlane, "SIGKILL");
      await startControlPlane(state);
      print({ restarted: true, stateDirectory });
    } else throw new Error("Unknown command; use --help");
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
