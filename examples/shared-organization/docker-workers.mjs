import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getgid, getuid } from "node:process";
import { promisify } from "node:util";
import { stageWorkerAuth } from "./worker-auth.mjs";

const execute = promisify(execFile);
const ownerLabel = "supertag.example.owner";
const workerNames = ["claude", "codex"];

async function inspect(name, run) {
  try {
    return JSON.parse((await run("docker", ["inspect", name], { timeout: 5000 })).stdout)[0];
  } catch (error) {
    if (/No such (?:object|container|image)/i.test(error.stderr ?? "")) return undefined;
    throw error;
  }
}
function assertOwned(info, state, record) {
  if (
    info.Config?.Labels?.[ownerLabel] !== state.workerOwner ||
    (record.containerId && info.Id !== record.containerId)
  )
    throw new Error(
      "Docker Worker ownership differs from the private example state; refusing to alter it",
    );
}

export async function buildDockerWorkerImage(state, buildDirectory, save, { run = execute } = {}) {
  await run(
    "docker",
    [
      "build",
      "--label",
      `${ownerLabel}=${state.workerOwner}`,
      "-f",
      join(buildDirectory, "Worker.Dockerfile"),
      "-t",
      state.workerImageName,
      buildDirectory,
    ],
    { timeout: 300000, maxBuffer: 30 * 1024 * 1024 },
  );
  const info = await inspect(state.workerImageName, run);
  if (!info || info.Config?.Labels?.[ownerLabel] !== state.workerOwner)
    throw new Error("Could not confirm the built Worker image");
  state.workerImageId = info.Id;
  await save(state);
}

export async function startDockerWorker(
  state,
  name,
  save,
  { run = execute, stageAuth = stageWorkerAuth, environment = process.env } = {},
) {
  if (!workerNames.includes(name)) throw new Error("Choose claude or codex Worker");
  if (!state.workerImageId || !state.workerOwner)
    throw new Error("Docker Worker image was not prepared");
  let record = state.workers[name];
  if (!record) {
    record = { kind: "docker", containerName: `${state.containerName}-${name}-worker` };
    state.workers[name] = record;
    // Store the exact ownership/name before a create request can have an ambiguous outcome.
    await save(state);
  }
  const configPath = join(state.stateDirectory, `${name}.json`);
  const config = JSON.parse(await readFile(configPath, "utf8"));
  record.workerHostId = config.hostId;
  const existing = await inspect(record.containerId ?? record.containerName, run);
  if (existing) {
    assertOwned(existing, state, record);
    record.containerId = existing.Id;
    record.ownerLabel = existing.Config.Labels[ownerLabel];
    if (existing.State.Running) record.runningObserved = true;
    await save(state);
    if (existing.State.Running) return record;
    if (existing.State.Status !== "created")
      throw new Error(
        `The ${name} Worker container exited; inspect its logs and clean up before retrying`,
      );
  } else {
    const directory = join(state.stateDirectory, "worker-hosts", name);
    const homeDirectory = join(directory, "home");
    const runtimeDirectory = join(directory, "state");
    await mkdir(runtimeDirectory, { recursive: true, mode: 0o700 });
    const auth = await stageAuth({
      name,
      homeDirectory,
      sourceFile: environment[`SUPERTAG_EXAMPLE_${name.toUpperCase()}_AUTH_FILE`],
    });
    record.auth = auth;

    // Do not give either container the other manager's config or native sign-in.
    const childEnvironment = {
      HOME: "/worker-home",
      ...(state.coordinationTls
        ? { NODE_EXTRA_CA_CERTS: "/run/supertag/coordination-ca.pem" }
        : {}),
      SUPERTAG_EXAMPLE_WORKER_CONFIG: "/run/supertag/worker.json",
      SUPERTAG_EXAMPLE_WORKER_STATE: "/worker-state",
      SUPERTAG_EXAMPLE_ATTEMPT_MS: environment.SUPERTAG_EXAMPLE_ATTEMPT_MS ?? "300000",
      ...(name === "codex"
        ? {
            CODEX_HOME: "/worker-home/.codex",
            SUPERTAG_EXAMPLE_CODEX_MODEL:
              environment.SUPERTAG_EXAMPLE_CODEX_MODEL ?? "gpt-5.6-luna",
          }
        : {
            CLAUDE_CONFIG_DIR: "/worker-home/.claude",
            CLAUDE_SECURESTORAGE_CONFIG_DIR: "/worker-home/.claude",
            SUPERTAG_EXAMPLE_CLAUDE_MODEL: environment.SUPERTAG_EXAMPLE_CLAUDE_MODEL ?? "sonnet",
          }),
    };
    const args = [
      "create",
      "--name",
      record.containerName,
      "--label",
      `${ownerLabel}=${state.workerOwner}`,
      "--network",
      state.workerNetwork,
      "--init",
      "--read-only",
      "--tmpfs",
      "/tmp:rw,nosuid,nodev",
      "--user",
      `${getuid()}:${getgid()}`,
      "--mount",
      `type=bind,src=${configPath},dst=/run/supertag/worker.json,readonly`,
      "--mount",
      `type=bind,src=${runtimeDirectory},dst=/worker-state`,
      "--mount",
      `type=bind,src=${homeDirectory},dst=/worker-home`,
      ...(state.coordinationTls
        ? [
            "--mount",
            `type=bind,src=${state.coordinationTls.caFile},dst=/run/supertag/coordination-ca.pem,readonly`,
          ]
        : []),
      ...Object.entries(childEnvironment).flatMap(([key, value]) => ["--env", `${key}=${value}`]),
      state.workerImageId,
      name,
    ];
    await run("docker", args, { timeout: 30000, env: environment });
    const created = await inspect(record.containerName, run);
    if (!created) throw new Error("Docker did not report the created Worker container");
    assertOwned(created, state, record);
    record.containerId = created.Id;
    record.ownerLabel = created.Config.Labels[ownerLabel];
    await save(state);
  }
  await run("docker", ["start", record.containerId], { timeout: 30000 });
  const started = await inspect(record.containerId, run);
  if (!started?.State.Running)
    throw new Error(`The ${name} Worker container did not remain running`);
  assertOwned(started, state, record);
  record.runningObserved = true;
  await save(state);
  return record;
}

export async function stopDockerWorker(state, record, { run = execute } = {}) {
  const info = await inspect(record.containerId ?? record.containerName, run);
  if (!info) {
    record.removed = true;
    return { stopped: true };
  }
  assertOwned(info, state, record);
  if (info.State.Running)
    await run("docker", ["stop", "--time", "20", info.Id], { timeout: 25000 });
  const stopped = await inspect(info.Id, run);
  if (stopped?.State.Running) throw new Error("Docker Worker is still running after stop");
  const name = workerNames.find((name) => state.workers[name] === record);
  if (name) {
    try {
      const result = await run("docker", ["logs", info.Id], {
        timeout: 3000,
        maxBuffer: 2 * 1024 * 1024,
      });
      const config = JSON.parse(await readFile(join(state.stateDirectory, `${name}.json`), "utf8"));
      let log = `${result.stdout}${result.stderr}`;
      for (const value of [config.credential, config.executionToken, config.mcpToken].filter(
        Boolean,
      ))
        log = log.replaceAll(value, "[REDACTED]");
      await writeFile(join(state.stateDirectory, `${name}.log`), log, { mode: 0o600 });
    } catch {
      record.logsUnavailable = true;
    }
  }
  await run("docker", ["rm", info.Id], { timeout: 5000 });
  record.removed = true;
  return {
    stopped: true,
    ...(stopped?.State.ExitCode === 137
      ? {
          forced: true,
          outcome:
            "Container required forced termination; inspect retained journals for uncertainty",
        }
      : {}),
  };
}

export async function removeDockerWorkerImage(state, { run = execute } = {}) {
  if (!state.workerImageName) return;
  const info = await inspect(state.workerImageName, run);
  if (!info) return;
  if (
    info.Config?.Labels?.[ownerLabel] !== state.workerOwner ||
    (state.workerImageId && info.Id !== state.workerImageId)
  )
    throw new Error("Docker Worker image ownership differs; refusing to remove it");
  await run("docker", ["image", "rm", state.workerImageName], { timeout: 30000 });
}

// An unavailable Docker daemon must not prevent independent hosted execution cleanup.
export async function cleanupDockerWorkerHosts(
  state,
  { stopControlPlane, stopExecution, save, run = execute },
) {
  const failures = [];
  state.shutdown = await Promise.all(
    Object.values(state.workers ?? {}).map(async (record) => {
      try {
        return await stopDockerWorker(state, record, { run });
      } catch (error) {
        failures.push(error);
        return {
          stopped: false,
          containerName: record.containerName,
          outcome: "Docker Worker cleanup could not be confirmed",
        };
      }
    }),
  );
  try {
    state.shutdown.push(await stopControlPlane());
  } catch (error) {
    failures.push(error);
    state.shutdown.push({
      stopped: false,
      outcome: "Control Plane cleanup could not be confirmed",
    });
  }
  const results = await Promise.allSettled([
    stopExecution(),
    removeDockerWorkerImage(state, { run }),
  ]);
  for (const result of results) if (result.status === "rejected") failures.push(result.reason);
  if (!failures.length) state.stopped = new Date().toISOString();
  await save(state);
  if (failures.length)
    throw new AggregateError(
      failures,
      "Docker Worker Host cleanup could not be fully confirmed; inspect retained state and retry cleanup",
    );
}
