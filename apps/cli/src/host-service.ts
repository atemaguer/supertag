import { mkdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { workerHostNameCandidate, workerHostNameFromHostname } from "@supertag/core";
import { stateDirectory } from "@supertag/store";
import { checkClaudeCodeModels } from "@supertag/worker-claude-code";
import { checkCodexModels } from "@supertag/worker-codex";
import { checkCursorModels } from "@supertag/worker-cursor";
import { FileSkillResolver, type UncertainAttempt } from "@supertag/worker-sdk";
import { SUPERTAG_BUILD_IDENTITY } from "./build-identity.js";
import {
  ControlPlaneClient,
  ControlPlaneRequestError,
  type ControlPlaneTarget,
  ensureLocalAdminToken,
  normalizeControlPlaneUrl,
} from "./control-plane-client.js";
import {
  CONTROL_PLANE_API_VERSION,
  type TagResource,
  type WorkerHostCredentialIssuance,
  type WorkerHostResource,
} from "./control-plane-resources.js";
import { resumeIfDrained } from "./drain.js";
import { providerCredentialsFromEnvFile } from "./host-environment.js";
import { hostMcpToolServers } from "./host-mcp.js";
import {
  checkHostMcpCredentials,
  createHostMcpEnvironment,
  createHostMcpHeaders,
  workspaceMcpVariables,
} from "./host-mcp-auth.js";
import { KeepAwake } from "./keep-awake.js";
import { aborted, harnessCredentialsFromEnvFile, signalOnInterrupt } from "./local-process.js";
import {
  acquirePidFile,
  clearConcurrencyRequests,
  controlPlaneSlot,
  environmentOperatorToken,
  finishConcurrencyRequest,
  hostCredentialPath,
  hostServiceDirectory,
  hostSlot,
  type ProcessStatus,
  pendingConcurrencyRequests,
  type RunMode,
  readStatus,
  runningProcess,
  type UncertainAttemptStatus,
  writeStatus,
} from "./local-state.js";
import { FileMcpLoginStore, lapsedMcpLogins } from "./mcp-oauth.js";
import { hostServiceStorageWarnings } from "./storage-durability.js";
import {
  availableHostVolumeCredentials,
  controlPlaneOf,
  type HostService,
  readSecret,
  readVolumeCredential,
  readVolumeMountCredential,
  type ServicesFile,
  serviceFingerprint,
  UNSANDBOXED_HARNESSES,
} from "./supertag-yaml.js";
import { resolvedSummary } from "./up-serve.js";
import { SUPERTAG_VERSION } from "./version.js";
import {
  assertHostEnvironmentWorkers,
  DEFAULT_ATTEMPT_TIMEOUT_MS,
  startWorkletRuntime,
  type WorkletHarness,
  type WorkletHarnessWorker,
  type WorkletRuntimeHandle,
} from "./worker.js";
import { parseWorkerConcurrency } from "./worker-concurrency.js";
import { redeemAuthKey, sameControlPlane } from "./worker-host-join.js";
import { readWorkerHostCredential, writeWorkerHostCredential } from "./worker-hosts.js";
import { assertGitCheckouts, parseWorkletWorkspaces } from "./worklet-workspaces.js";

/** How often a running host looks for a concurrency change from `supertag up`. */
const CONCURRENCY_POLL_MS = 250;

/** The time limit of each Task Attempt a host service runs: the Worklet default, 60 minutes. */
export const ATTEMPT_TIME_LIMIT_MS = DEFAULT_ATTEMPT_TIMEOUT_MS;

/** The journal's uncertain Task Attempts as a host service's status records them. */
export function uncertainAttemptStatuses(
  attempts: readonly UncertainAttempt[],
): UncertainAttemptStatus[] {
  return attempts.map((attempt) => ({
    attemptId: attempt.attemptId,
    taskId: attempt.taskId,
    ...(attempt.workerId === undefined ? {} : { workerId: attempt.workerId }),
    ...(attempt.uncertainty === undefined
      ? {}
      : {
          reason: `${attempt.uncertainty.name}: ${attempt.uncertainty.message}`.slice(0, 500),
          since: attempt.uncertainty.at,
        }),
  }));
}

/** Where a host service connects, and how it reaches the management API. */
export interface HostTarget {
  readonly workletUrl: string;
  readonly transport: "websocket" | "grpc";
  /** HTTP URL of the management API; the stored credential records it. */
  readonly managementUrl: string;
  /** The local Control Plane in the same file, managed with this machine's operator credential. */
  readonly local?: ControlPlaneTarget;
  /** CA file the host trusts for a gRPC listener. */
  readonly tlsCa?: string;
}

/**
 * The Control Plane a host service connects to: a shared one by URL over WebSocket, or the local
 * control-plane service in the same file, waiting up to `waitMs` for it to become ready.
 */
export async function resolveHostTarget(
  file: ServicesFile,
  service: HostService,
  waitMs = 0,
): Promise<HostTarget> {
  if ("url" in service.controlPlane) {
    const url = normalizeControlPlaneUrl(service.controlPlane.url);
    return { workletUrl: url, transport: "websocket", managementUrl: url };
  }
  const controlPlane = controlPlaneOf(file);
  const slot = controlPlaneSlot(service.controlPlane.service);
  const deadline = Date.now() + waitMs;
  for (;;) {
    const running = await runningProcess(slot);
    const status = running.pid === undefined ? undefined : await readStatus(slot);
    if (status?.state === "ready" && status.url !== undefined) {
      const token = environmentOperatorToken() || (await ensureLocalAdminToken());
      const tlsCa = controlPlane?.tls.ca;
      return {
        workletUrl: status.workletUrl ?? status.url,
        transport: status.workletUrl === undefined ? "websocket" : "grpc",
        managementUrl: normalizeControlPlaneUrl(status.url),
        local: { url: status.url, token },
        ...(tlsCa === undefined ? {} : { tlsCa }),
      };
    }
    if (Date.now() >= deadline)
      throw new Error(
        `The local Control Plane (${service.controlPlane.service}) is not running. Start it with supertag up ${service.controlPlane.service}.`,
      );
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

export interface HostCredential {
  readonly workerHostId: string;
  readonly token: string;
  readonly source: "stored" | "auth-key";
  readonly notice?: string;
  /** Joined with an ephemeral Auth Key: Task files and artifacts on it are lost if it stops. */
  readonly ephemeral?: boolean;
}

/**
 * The host service's Worker Host credential, kept with its Worker Host ID in
 * `~/.supertag/hosts/SERVICE/credential.json`. Without one, a host in the same file as its Control
 * Plane is enrolled with this machine's operator credential; a host of a URL Control Plane joins
 * with its auth-key secret, or SUPERTAG_AUTH_KEY. Once stored, the credential is used and any Auth
 * Key is ignored.
 */
export async function ensureHostCredential(
  file: ServicesFile,
  service: HostService,
  target: HostTarget,
): Promise<HostCredential> {
  const path = hostCredentialPath(service.name);
  const stored = (await stat(path).catch(() => undefined))
    ? await readWorkerHostCredential(path)
    : undefined;
  if (
    stored !== undefined &&
    (stored.controlPlane === undefined ||
      sameControlPlane(stored.controlPlane, target.managementUrl))
  ) {
    // The local Control Plane may move to another port; the credential follows it.
    if (stored.controlPlane !== target.managementUrl)
      await writeWorkerHostCredential(path, {
        version: 1,
        workerHostId: stored.workerHostId,
        token: stored.token,
        controlPlane: target.managementUrl,
        ...(stored.ephemeral === true ? { ephemeral: true as const } : {}),
      });
    return {
      workerHostId: stored.workerHostId,
      token: stored.token,
      source: "stored",
      ...(stored.ephemeral === true ? { ephemeral: true } : {}),
    };
  }
  const name = workerHostNameFromHostname(service.name);
  let joined: {
    readonly workerHostId: string;
    readonly token: string;
    readonly notice: string;
    readonly ephemeral?: boolean;
  };
  if (target.local !== undefined) joined = await enrollLocal(target.local, name);
  else {
    const authKey =
      service.authKey !== undefined
        ? await readSecret(file, service.authKey)
        : process.env["SUPERTAG_AUTH_KEY"]?.trim() || undefined;
    if (authKey === undefined)
      throw new Error(
        `Host service ${service.name} has no Worker Host credential for ${target.managementUrl}. Ask an operator for an Auth Key (supertag create auth-key NAME --tag TAG), save it in a file, and add it to supertag.yaml: auth-key: KEY under the service, with secrets: { KEY: { file: PATH } }. SUPERTAG_AUTH_KEY also works for one run.`,
      );
    joined = await redeemAuthKey({
      controlPlane: target.managementUrl,
      authKey: authKey.trim(),
      name,
    });
  }
  await mkdir(hostServiceDirectory(service.name), { recursive: true, mode: 0o700 });
  await writeWorkerHostCredential(path, {
    version: 1,
    workerHostId: joined.workerHostId,
    token: joined.token,
    controlPlane: target.managementUrl,
    ...(joined.ephemeral === true ? { ephemeral: true as const } : {}),
  });
  return {
    workerHostId: joined.workerHostId,
    token: joined.token,
    source: "auth-key",
    ...(joined.ephemeral === true ? { ephemeral: true } : {}),
    notice: `Host service ${service.name}: ${joined.notice}${
      stored?.controlPlane === undefined
        ? ""
        : ` It replaces the credential for ${stored.controlPlane} (Worker Host ${stored.workerHostId}).`
    }`,
  };
}

/**
 * Enrolls a host on the local Control Plane with this machine's operator credential, under the
 * first free name of NAME, NAME-2, NAME-3, ... An Auth Key would need a Tag, and the file names
 * none: Tag manifests decide which Tags a host serves.
 */
async function enrollLocal(
  target: ControlPlaneTarget,
  name: string,
): Promise<{ readonly workerHostId: string; readonly token: string; readonly notice: string }> {
  const client = new ControlPlaneClient(target);
  for (let attempt = 1; attempt <= 20; attempt += 1) {
    const workerHostId = workerHostNameCandidate(name, attempt);
    try {
      const issuance = await client.request<WorkerHostCredentialIssuance>("/api/v1/worker-hosts", {
        method: "POST",
        body: JSON.stringify({
          apiVersion: CONTROL_PLANE_API_VERSION,
          kind: "WorkerHostEnrollment",
          metadata: { id: workerHostId },
          spec: {},
        }),
      });
      if (
        issuance?.kind !== "WorkerHostCredential" ||
        issuance.metadata.workerHostId !== workerHostId ||
        !issuance.credential.token
      )
        throw new Error("Control Plane returned an invalid Worker Host credential");
      return {
        workerHostId,
        token: issuance.credential.token,
        notice: `Enrolled as Worker Host ${workerHostId} on the local Control Plane.`,
      };
    } catch (error) {
      if (error instanceof Error && /already enrolled/u.test(error.message)) continue;
      throw error;
    }
  }
  throw new Error(`No free Worker Host ID near ${name}`);
}

export interface RunHostOptions {
  readonly file: ServicesFile;
  readonly service: HostService;
  readonly mode: RunMode;
  /** Stops the host when aborted; defaults to SIGINT and SIGTERM. */
  readonly signal?: AbortSignal;
  readonly write?: (text: string) => void;
  /** Checks each harness's configured models once at startup; replaceable for tests. */
  readonly checkModels?: HostModelCheck;
  /** Checks the installed Claude Code and Codex CLIs; defaults to finding them on PATH. */
  readonly checkCli?: HostCliCheck;
}

export type HostModelCheckResult =
  | { readonly status: "ok" }
  | { readonly status: "failed"; readonly message: string }
  | { readonly status: "skipped"; readonly note: string };

/** Checks one harness's configured models without running a Task. */
export type HostModelCheck = (
  harness: WorkletHarness,
  models: readonly string[],
) => Promise<HostModelCheckResult>;

/**
 * The built-in checks: Codex, Claude Code, and Cursor list the models available to this machine's
 * account, which costs no prompt. OpenCode has no listing this cheap, so it is skipped.
 */
export const defaultHostModelCheck: HostModelCheck = (harness, models) =>
  harness === "codex"
    ? checkCodexModels(models)
    : harness === "claude-code"
      ? checkClaudeCodeModels(models)
      : harness === "cursor"
        ? checkCursorModels(models)
        : Promise.resolve({
            status: "skipped",
            note: "OpenCode offers no cheap model check; its models are not checked at startup.",
          });

/** The service's harnesses that run commands unsandboxed and were not allowed to. */
export function unsandboxedWithoutOptIn(
  service: Pick<HostService, "environment" | "harnesses" | "allowUnsandboxedCommands">,
): readonly WorkletHarness[] {
  if (service.environment) return [];
  const unsandboxed: readonly WorkletHarness[] = UNSANDBOXED_HARNESSES;
  return service.harnesses.filter(
    (harness) =>
      unsandboxed.includes(harness) && !service.allowUnsandboxedCommands.includes(harness),
  );
}

/**
 * Checks each configured harness model once, before the host takes work. A model the provider
 * does not offer fails startup with the provider's answer; a check that cannot run is noted.
 */
export async function checkHostModels(
  service: Pick<HostService, "harnesses" | "models">,
  check: HostModelCheck,
  notice: (line: string) => void,
): Promise<void> {
  const failures: string[] = [];
  for (const harness of service.harnesses) {
    const models = service.models[harness] ?? [];
    if (models.length === 0) continue;
    const result = await check(harness, models);
    if (result.status === "failed") failures.push(result.message);
    else if (result.status === "skipped") notice(result.note);
  }
  if (failures.length > 0)
    throw new Error(
      `Host service models are not available: ${failures.join(" ")} Change models in supertag.yaml and run supertag up again.`,
    );
}

/** Checks one harness's installed CLI; resolves to a message when the host can't use it. */
export type HostCliCheck = (harness: "claude-code" | "codex") => Promise<string | undefined>;

export const defaultHostCliCheck: HostCliCheck = async (harness) => {
  const { checkHarnessCli } = await import("./harnesses.js");
  const check = await checkHarnessCli(harness);
  return check.status === "ok" ? undefined : check.message;
};

/**
 * Claude Code and Codex Tasks run the CLI installed on this machine, so a host service that serves
 * either fails to start when its CLI is missing or older than SuperTag supports.
 */
export async function checkHostCliTools(
  service: Pick<HostService, "name" | "harnesses">,
  check: HostCliCheck,
): Promise<void> {
  const failures: string[] = [];
  for (const harness of service.harnesses)
    if (harness === "claude-code" || harness === "codex") {
      const failure = await check(harness);
      if (failure !== undefined) failures.push(failure);
    }
  if (failures.length > 0)
    throw new Error(
      `Host service ${service.name} can't run its harnesses:\n  ${failures.join("\n  ")}\nInstall or upgrade them, or remove them from harnesses in supertag.yaml, then run supertag up again.`,
    );
}

/**
 * Runs a host service in this process until stopped: one Worklet that serves every configured
 * harness, tracked in `~/.supertag/hosts/SERVICE/` so `supertag down` stops it. Background and unit
 * modes run this same function with output going to the log.
 */
export function assertHostServiceEnvironment(
  service: Pick<HostService, "environment" | "harnesses" | "allowUnsandboxedCommands">,
): void {
  assertHostEnvironmentWorkers(
    service.environment,
    service.harnesses.map((harness) => ({
      harness,
      workerId: `local-${harness}`,
      profileId: `local-${harness}`,
      profileRevision: "1",
      allowUnsandboxedCommands: service.allowUnsandboxedCommands.includes(harness),
    })),
  );
}

export async function runHostService(options: RunHostOptions): Promise<void> {
  const { file, service } = options;
  assertHostServiceEnvironment(service);
  const write = options.write ?? ((text: string) => process.stdout.write(text));
  // A host with a missing MCP credential never takes Tasks that would need it.
  await checkHostMcpCredentials(service.mcp, { file });
  const slot = hostSlot(service.name);
  const lock = await acquirePidFile(slot);
  if (lock.held !== undefined)
    throw new Error(
      `Host service ${service.name} is already running (process ${lock.held}). Stop it with supertag down ${service.name} first.`,
    );
  const notices: string[] = [];
  const notice = (line: string) => {
    notices.push(line);
    write(`${line}\n`);
  };
  let status: ProcessStatus = {
    pid: process.pid,
    mode: options.mode,
    state: "starting",
    startedAt: new Date().toISOString(),
    configuration: serviceFingerprint(file, service),
    version: SUPERTAG_VERSION,
    buildIdentity: SUPERTAG_BUILD_IDENTITY,
    kind: "host",
    service: service.name,
    instance: file.name,
    resolved: resolvedSummary(service),
    connected: false,
    attempts: [],
    concurrency: { value: service.concurrency, source: service.concurrencySource },
    attemptTimeLimitMs: ATTEMPT_TIME_LIMIT_MS,
  };
  // Status writes are serialized so a later one never lands before an earlier one.
  let writes = Promise.resolve();
  const update = (next: Partial<ProcessStatus>) => {
    status = { ...status, ...next };
    const snapshot = status;
    writes = writes.then(() => writeStatus(slot, snapshot)).catch(() => undefined);
    return writes;
  };
  const awake = new KeepAwake({
    onChange: (hold) => {
      const { keepAwake: _previous, ...rest } = status;
      status = hold === undefined ? rest : { ...rest, keepAwake: hold };
      void update({});
    },
    onUnavailable: notice,
  });
  const { signal: stop, dispose } =
    options.signal === undefined
      ? signalOnInterrupt()
      : { signal: options.signal, dispose: () => undefined };
  /**
   * Applies each concurrency `supertag up` asked for, without a restart: a higher limit starts
   * waiting work at once, and a lower one starts nothing new until running work fits under it.
   */
  const applyConcurrencyRequests = async (running: WorkletRuntimeHandle) => {
    // Oldest first, so the last `up` wins; each request is removed only after the status shows it.
    for (const { id, request } of await pendingConcurrencyRequests(slot)) {
      try {
        if (request === undefined) continue;
        const concurrency = parseWorkerConcurrency(request.concurrency);
        running.setConcurrency(concurrency);
        write(`Concurrency changed to ${concurrency} per harness without a restart.\n`);
        await update({
          configuration: request.configuration,
          resolved: request.resolved,
          concurrency: { value: concurrency, source: request.source },
        });
      } finally {
        await finishConcurrencyRequest(slot, id);
      }
    }
  };
  let worklet: WorkletRuntimeHandle | undefined;
  let failed = false;
  let watchConcurrency: NodeJS.Timeout | undefined;
  const injectedCredentials = harnessCredentialsFromEnvFile(file.envFile, process.env);
  try {
    // Workers inherit these allowlisted credentials from the host process, including when a
    // service unit starts without the invoking shell's environment.
    Object.assign(process.env, injectedCredentials);
    // A request left by an earlier process is already in the settings this one started with.
    await clearConcurrencyRequests(slot);
    await update({});
    const target = await resolveHostTarget(
      file,
      service,
      options.mode === "foreground" ? 0 : 60_000,
    );
    const credential = await ensureHostCredential(file, service, target);
    // Background and unit processes log this; `up` already warned on the terminal.
    if (options.mode === "foreground")
      for (const warning of hostServiceStorageWarnings(service, credential.ephemeral === true))
        write(`${warning}\n`);
    if (credential.notice) notice(credential.notice);
    if (await resumeIfDrained(service.name, target.managementUrl, credential))
      notice(`Resumed Worker Host ${credential.workerHostId}: it takes new Task Attempts again.`);
    await checkHostCliTools(service, options.checkCli ?? defaultHostCliCheck);
    await checkHostModels(service, options.checkModels ?? defaultHostModelCheck, notice);
    for (const harness of unsandboxedWithoutOptIn(service))
      notice(
        `${harness} runs commands without a sandbox, so Tasks that may run commands will not run on it here. To let it, add ${harness} to allow-unsandboxed-commands in host service ${service.name}.`,
      );
    const workers = service.harnesses.map(
      (harness): WorkletHarnessWorker => ({
        harness,
        workerId: `local-${harness}`,
        profileId: `local-${harness}`,
        profileRevision: "1",
        concurrency: service.concurrency,
        ...(service.models[harness] === undefined ? {} : { models: service.models[harness] }),
        ...(service.allowUnsandboxedCommands.includes(harness)
          ? { allowUnsandboxedCommands: true }
          : {}),
      }),
    );
    const valid: string[] = [];
    for (const [name, path] of Object.entries(service.workspaces).toSorted(([a], [b]) =>
      a.localeCompare(b),
    )) {
      const entry = `${name}=${path}`;
      try {
        await assertGitCheckouts(parseWorkletWorkspaces([entry]).checkouts);
        valid.push(entry);
      } catch (error) {
        notice(
          `Skipping Workspace ${name}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    const workspaces = parseWorkletWorkspaces(valid);
    const caPath = target.tlsCa ?? process.env["SUPERTAG_WORKLET_TLS_CA_FILE"]?.trim();
    const tlsCa = caPath ? await readFile(caPath, "utf8") : undefined;
    let markConnected: () => void = () => undefined;
    const connected = new Promise<void>((resolve) => {
      markConnected = resolve;
    });
    const names = workspaces.checkouts.map((checkout) => checkout.name);
    const serving = `Serving ${workers.map((worker) => worker.harness).join(", ")}${
      service.environment === undefined ? "" : ` in ${service.environment.provider} sandboxes`
    }${
      names.length ? ` with Workspace${names.length > 1 ? "s" : ""} ${names.join(", ")}` : ""
    } as Worker Host ${credential.workerHostId}.`;
    // The provider SDK reads its credentials from this process. Child processes get allowlisted
    // variables only.
    if (service.environment !== undefined)
      Object.assign(
        process.env,
        providerCredentialsFromEnvFile(service.environment, file.envFile, process.env),
      );
    const availableVolumeCredentialNames = await availableHostVolumeCredentials(file, service);
    for (const name of Object.keys(service.volumeCredentials))
      if (!availableVolumeCredentialNames.includes(name))
        notice(`Skipping Volume credential ${name}: its secret cannot be read on this host.`);
    worklet = await startWorkletRuntime({
      url: target.workletUrl,
      transport: target.transport,
      onConnected: () => {
        markConnected();
        if (status.state === "ready") void update({ connected: true });
      },
      onDisconnected: () => void update({ connected: false }),
      onAttempt: {
        started: (spec) => {
          void update({
            attempts: [
              ...(status.attempts ?? []).filter((attempt) => attempt.attemptId !== spec.attemptId),
              {
                attemptId: spec.attemptId,
                taskId: spec.taskId,
                startedAt: new Date().toISOString(),
              },
            ],
          });
          awake.update(status.attempts?.length ?? 0);
        },
        finished: (spec) => {
          void update({
            attempts: (status.attempts ?? []).filter(
              (attempt) => attempt.attemptId !== spec.attemptId,
            ),
          });
          awake.update(status.attempts?.length ?? 0);
        },
      },
      // `supertag ps` shows these with the commands that recover them.
      onUncertainAttempts: (attempts) =>
        void update({ uncertainAttempts: uncertainAttemptStatuses(attempts) }),
      onCleanupFailure: ({ attemptId, diagnostics }) =>
        notice(`Task Attempt ${attemptId} cleanup confirmation failed: ${diagnostics.join("; ")}`),
      ...(tlsCa === undefined ? {} : { tlsCa }),
      credential: { token: credential.token, workerHostId: credential.workerHostId },
      workletId: `${credential.workerHostId}-worklet`,
      journalId: `host-${service.name}`,
      journalDirectory: join(hostServiceDirectory(service.name), "attempt-journal"),
      workers,
      ...(service.environment === undefined ? {} : { environment: service.environment }),
      workspace:
        workspaces.defaultPath ??
        (process.env["SUPERTAG_WORKER_WORKSPACE"]?.trim() ||
          workspaces.checkouts[0]?.path ||
          (await emptyWorkspace(service.name))),
      workspaces,
      labels: service.labels,
      hostVolumeCredentialNames: () => availableHostVolumeCredentials(file, service),
      // Volume credential values are read here, on the Worker Host, only when a copy needs one.
      readVolumeCredential: (name) => readVolumeCredential(file, service, name),
      readVolumeMountCredential: async (name) => readVolumeMountCredential(service, name),
      volumeProtectedPaths: hostSecretPaths(file),
      ...(service.localMountRoot === undefined ? {} : { localMountRoot: service.localMountRoot }),
      hostMcpServerNames: Object.keys(service.mcp),
      hostMcpLoginsNeeded: () => lapsedMcpLogins(service.mcp, new FileMcpLoginStore()),
      mcpServers: hostMcpToolServers(service.mcp),
      mcpHeaders: createHostMcpHeaders(service.mcp, { file }),
      mcpEnvironment: createHostMcpEnvironment(service.mcp, { file }),
      workspaceMcpVariables: workspaceMcpVariables({ file }),
      ...(service.skills === undefined
        ? {}
        : { skills: await FileSkillResolver.load({ catalogPath: service.skills }) }),
      timeoutMs: ATTEMPT_TIME_LIMIT_MS,
      // Artifacts stay on this host or its artifact Volume, served to other Worklets on this
      // machine over loopback.
      artifacts: {
        controlPlane: target.managementUrl,
        transferHost: "127.0.0.1",
        transferPort: 0,
        allowInsecureHttp: false,
        consumersOnThisMachine: true,
        // With `artifact-volume`, copies go to that Volume, reached through volume-credentials.
        ...(service.artifactVolume === undefined
          ? {}
          : {
              volume: {
                name: service.artifactVolume,
                readCredential: (name: string) => readVolumeCredential(file, service, name),
              },
            }),
      },
    });
    await Promise.race([worklet.started, aborted(stop)]);
    await Promise.race([connected, aborted(stop)]);
    if (!stop.aborted) {
      write(`${serving}\n`);
      await update({
        state: "ready",
        connected: true,
        url: target.managementUrl,
        workerHostId: credential.workerHostId,
        workers: workers.map((worker) => worker.workerId),
        serving,
        notices,
      });
      if (options.mode === "foreground") write("Press Ctrl-C to stop.\n");
      const running = worklet;
      let applying = false;
      watchConcurrency = setInterval(() => {
        if (applying) return;
        applying = true;
        void applyConcurrencyRequests(running)
          .catch((error) =>
            notice(
              `Could not change concurrency: ${error instanceof Error ? error.message : String(error)}`,
            ),
          )
          .finally(() => {
            applying = false;
          });
      }, CONCURRENCY_POLL_MS);
      watchConcurrency.unref();
      await aborted(stop);
    }
    write("Stopping...\n");
  } catch (error) {
    failed = true;
    await update({
      state: "failed",
      notices,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  } finally {
    clearInterval(watchConcurrency);
    await worklet?.stop().catch(() => undefined);
    for (const name of Object.keys(injectedCredentials)) delete process.env[name];
    awake.release();
    dispose();
    await writes;
    await lock.release({ keepStatus: failed });
  }
  write("Stopped.\n");
}

/** The folder Tasks without a Workspace see when the host has no checkout: an empty one. */
async function emptyWorkspace(service: string): Promise<string> {
  const directory = join(hostServiceDirectory(service), "workspace");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  return directory;
}

/**
 * The host health check. On the local Control Plane it reads the host's record with the operator
 * credential; a shared Control Plane accepted the connection that registers every Worker, which is
 * the signal there.
 */
export async function hostHealthLines(
  status: ProcessStatus,
  target: Pick<HostTarget, "local" | "managementUrl">,
  timeoutMs = 30_000,
): Promise<readonly string[]> {
  const workers = status.workers ?? [];
  if (status.workerHostId === undefined) return [];
  if (target.local === undefined)
    return [
      `Worker Host ${status.workerHostId} connected to ${target.managementUrl}; Workers registered: ${workers.toSorted().join(", ")}.`,
    ];
  const client = new ControlPlaneClient(target.local);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const host = await client
      .request<WorkerHostResource>(
        `/api/v1/worker-hosts/${encodeURIComponent(status.workerHostId)}`,
      )
      .catch(() => undefined);
    const registered = host?.status.workers.map((worker) => worker.id) ?? [];
    const missing = workers.filter((worker) => !registered.includes(worker));
    if (host?.status.connectionStatus === "connected" && missing.length === 0)
      return [
        `Worker Host ${status.workerHostId} connected; Workers registered: ${registered.toSorted().join(", ")}.`,
      ];
    if (Date.now() > deadline)
      throw new Error(
        `Worker Host ${status.workerHostId} is ${host?.status.connectionStatus ?? "not visible"}${missing.length ? `; ${missing.join(", ")} not registered` : ""}`,
      );
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

/** Binds a host to Tags on the local Control Plane; Tags that are missing are reported. */
export async function bindLocalTags(
  target: ControlPlaneTarget,
  workerHostId: string,
  tags: readonly string[],
  notice: (line: string) => void,
): Promise<void> {
  const client = new ControlPlaneClient(target);
  for (const tag of tags) {
    try {
      const resource = await client.request<TagResource>(`/api/v1/tags/${encodeURIComponent(tag)}`);
      if (resource.status?.phase === "retired") {
        notice(`Tag ${tag} was deleted, so Worker Host ${workerHostId} was not bound to it.`);
        continue;
      }
      if (resource.spec.workerHosts.includes(workerHostId)) continue;
      await client.request(
        `/api/v1/tags/${encodeURIComponent(tag)}/worker-hosts/${encodeURIComponent(workerHostId)}`,
        { method: "PUT" },
      );
      notice(`Bound Worker Host ${workerHostId} to Tag ${tag}.`);
    } catch (error) {
      if (error instanceof ControlPlaneRequestError && error.status === 404) {
        notice(`Tag ${tag} does not exist, so Worker Host ${workerHostId} was not bound to it.`);
        continue;
      }
      throw error;
    }
  }
}

/** The Worker Host ID a host service's stored credential records, if it has one. */
export async function storedWorkerHostId(service: string): Promise<string | undefined> {
  return (await storedHostCredential(service))?.workerHostId;
}

/** The host service's stored Worker Host ID and whether it joined as an ephemeral host. */
export async function storedHostCredential(
  service: string,
): Promise<{ readonly workerHostId: string; readonly ephemeral: boolean } | undefined> {
  const path = hostCredentialPath(service);
  if (!(await stat(path).catch(() => undefined))) return undefined;
  const credential = await readWorkerHostCredential(path).catch(() => undefined);
  return credential === undefined
    ? undefined
    : { workerHostId: credential.workerHostId, ephemeral: credential.ephemeral === true };
}

/**
 * Settings, secrets from every service, Control Plane storage, and this machine's Worker Host
 * artifact copies. A host's `file://` Volume may never be in or contain these paths, even when its
 * own mapping consents to the source: mounting the artifact copies would bypass artifact grants.
 */
export function hostSecretPaths(
  file: Pick<ServicesFile, "files" | "envFilePaths" | "secrets" | "services">,
): readonly string[] {
  const references = [
    ...Object.values(file.secrets),
    ...file.services.flatMap((service) =>
      service.type === "host" ? Object.values(service.volumeCredentials) : [],
    ),
  ];
  return [
    ...file.files,
    ...(file.envFilePaths ?? []),
    ...references.flatMap((reference) => ("file" in reference ? [reference.file] : [])),
    join(stateDirectory(), "artifacts"),
    ...file.services.flatMap((service) => {
      if (service.type !== "control-plane") return [];
      // ServicesFile resolves SQLite paths relative to the declaring settings file.
      const database = service.database.url.startsWith("file:")
        ? service.database.url.slice("file:".length)
        : undefined;
      return [
        ...(database === undefined ? [] : [database, `${database}-wal`, `${database}-shm`]),
        ...(service.tls.key === undefined ? [] : [service.tls.key]),
        ...(service.operators.file === undefined ? [] : [service.operators.file]),
      ];
    }),
  ];
}
