import { type ChildProcess, spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { stateDirectory } from "@supertag/store";
import { SUPERTAG_BUILD_IDENTITY } from "./build-identity.js";
import { type Clock, DOWN_WAIT_MS, drainHost } from "./drain.js";
import {
  assertHostServiceEnvironment,
  ensureHostCredential,
  hostHealthLines,
  resolveHostTarget,
  runHostService,
  storedHostCredential,
} from "./host-service.js";
import {
  aborted,
  childMode,
  cliCommand,
  describeMode,
  installedService,
  type LocalProcessOptions,
  MODE_VARIABLE,
  optionalServiceManager,
  readyTimeout,
  serviceEnvironment,
  signalOnInterrupt,
  slotLabel,
  spawnBackground,
  stopProcess,
  waitForReady,
  waitForStop,
} from "./local-process.js";
import {
  clearStatus,
  concurrencyRequestPending,
  controlPlaneSlot,
  finishConcurrencyRequest,
  hostSlot,
  listSlots,
  logPath,
  type ProcessStatus,
  readStatus,
  runningProcess,
  type ServiceSlot,
  writeConcurrencyRequest,
} from "./local-state.js";
import { timestampLines } from "./log-timestamps.js";
import { provisionControlPlane } from "./provision.js";
import { removedHostNote, removedHosts, retireRemovedHost } from "./removed-host.js";
import { hostServiceStorageWarnings } from "./storage-durability.js";
import {
  type ControlPlaneService,
  DEFAULT_INSTANCE_NAME,
  defaultSupertagYamlPath,
  defaultUrl,
  displayPath,
  findService,
  loadServicesFile,
  type ServiceConfig,
  type ServicesFile,
  SUPERTAG_YAML,
  SupertagYamlError,
  serviceFingerprint,
  startOrder,
  unitSettings,
  VAULT_VARIABLES,
} from "./supertag-yaml.js";
import { resolvedSummary, serveControlPlane } from "./up-serve.js";
import {
  defaultServiceEnvironment,
  type ServiceDefinition,
  type ServiceManager,
  serviceManager,
  unitName,
} from "./up-service.js";

export interface UpOptions extends LocalProcessOptions {
  readonly cwd?: string;
  /** `-f PATH`, repeatable: supertag.yaml files merged in order. Defaults to the state directory's. */
  readonly files?: readonly string[];
  /** Services to bring up, with what they depend on; all by default. */
  readonly names?: readonly string[];
  /** Run in this terminal with logs here until Ctrl-C. */
  readonly foreground?: boolean;
  /** Print what `up` would do without doing it. */
  readonly dryRun?: boolean;
  /** Stop waiting for running Task Attempts when a host restarts. */
  readonly force?: boolean;
  /** Time for drain waits; tests pass a fake. */
  readonly clock?: Clock;
  /** Foreground only: stops the services when aborted, instead of SIGINT and SIGTERM. */
  readonly signal?: AbortSignal;
  readonly write?: (text: string) => void;
  /**
   * One line per service instead of the full report: `supertag init` tells one story across its
   * two `up` calls. Services named in `reported` print nothing when they are left alone.
   */
  readonly brief?: { readonly reported?: readonly string[] };
}

/** What `up` did with one service. */
export interface ServiceOutcome {
  readonly service: string;
  readonly kind: ServiceConfig["type"];
  /** `updated`: a host took a new concurrency without a restart. */
  readonly action: "started" | "restarted" | "updated" | "unchanged" | "stopped";
  readonly status?: ProcessStatus;
}

export interface UpResult {
  readonly file: ServicesFile;
  readonly services: readonly ServiceOutcome[];
}

/** A missing identity belongs to an older service and requires one restart. */
export function runningBuildMatches(status: ProcessStatus): boolean {
  return status.buildIdentity === SUPERTAG_BUILD_IDENTITY;
}

export async function runUpCommand(args: readonly string[]): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(upHelp());
    return 0;
  }
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      file: { type: "string", short: "f", multiple: true },
      foreground: { type: "boolean" },
      "dry-run": { type: "boolean" },
      force: { type: "boolean" },
    },
    strict: true,
  });
  if (values.foreground === true && values["dry-run"] === true)
    throw new Error("--foreground and --dry-run cannot be combined");
  await bringUp({
    files: values.file ?? [],
    names: positionals,
    foreground: values.foreground === true,
    dryRun: values["dry-run"] === true,
    force: values.force === true,
  });
  return 0;
}

/** The services file `up` runs. */
export async function loadForUp(options: {
  readonly files?: readonly string[];
  readonly cwd?: string;
}): Promise<ServicesFile> {
  return loadServicesFile({
    files: options.files ?? [],
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
  });
}

export function slotFor(service: ServiceConfig): ServiceSlot {
  return service.type === "control-plane" ? controlPlaneSlot(service.name) : hostSlot(service.name);
}

/** The arguments a background or unit process runs one service with. */
function childArgs(file: ServicesFile, service: ServiceConfig, options: UpOptions): string[] {
  return [
    "up",
    "--foreground",
    service.name,
    ...((options.files ?? []).length > 0 ? file.files.flatMap((path) => ["-f", path]) : []),
  ];
}

function serviceDefinition(
  file: ServicesFile,
  service: ServiceConfig,
  options: UpOptions,
): ServiceDefinition {
  return {
    name: unitName(file.name, service.name),
    description: `SuperTag ${service.type === "control-plane" ? "Control Plane" : "host"} ${service.name}`,
    workingDirectory: stateDirectory(),
    command: [...cliCommand(options), ...childArgs(file, service, options)],
    logFile: logPath(slotFor(service)),
    environment: serviceEnvironment(),
  };
}

/**
 * `supertag up [SERVICE...]`: brings up the services supertag.yaml defines, in depends_on order,
 * waiting for each to be healthy, then returns while they keep running in the background. A
 * service already running with the same settings is left alone; a changed one restarts.
 */
export async function bringUp(options: UpOptions = {}): Promise<UpResult> {
  const write = options.write ?? ((text: string) => process.stdout.write(text));
  const file = await loadForUp(options);
  const mode = childMode();
  if (mode !== undefined) {
    // A process `up` started runs exactly one service.
    const name = options.names?.[0];
    const service = name === undefined ? undefined : findService(file, name);
    if (service === undefined || (options.names ?? []).length !== 1)
      throw new Error(`${MODE_VARIABLE} is set, so supertag up runs one named service`);
    // Background and service-unit processes write straight to a log file; foreground output
    // reaches a person's terminal, prefixed with its service by the parent.
    if (mode !== "foreground" && options.write === undefined) {
      timestampLines(process.stdout);
      timestampLines(process.stderr);
    }
    return { file, services: [await runInProcess(file, service, mode, options, write)] };
  }
  const order = startOrder(file, options.names);
  if (options.dryRun === true) {
    await dryRun(file, order, options, write);
    return { file, services: [] };
  }
  await explainContext(options, file, write);
  if (options.foreground === true) return foreground(file, order, options, write);

  const outcomes: ServiceOutcome[] = [];
  const unitFile = unitResolver(options);
  for (const service of order)
    outcomes.push(await upService(file, service, unitFile, options, write));
  if (options.brief === undefined) await noteRemovedHosts(file, (line) => write(`${line}\n`));
  return { file, services: outcomes };
}

/** One line per host service with state on this machine that the file no longer names. */
async function noteRemovedHosts(file: ServicesFile, write: (line: string) => void): Promise<void> {
  for (const entry of removedHosts(await knownServices(file)))
    write(await removedHostNote(entry.slot));
}

/**
 * The file as a service unit resolves it. A unit does not inherit this shell's environment, only
 * what serviceEnvironment() writes into its definition: PATH, HOME, the state directory, and the
 * non-secret SUPERTAG_* overrides. `up` resolves the file under that same environment, so what it
 * compares with a unit's status is what the unit itself resolved, whatever this shell holds.
 */
function unitResolver(options: UpOptions): () => Promise<ServicesFile> {
  let loaded: Promise<ServicesFile> | undefined;
  return () => {
    loaded ??= loadServicesFile({
      files: options.files ?? [],
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      environment: serviceEnvironment(),
    }).catch((error: unknown) => {
      if (error instanceof SupertagYamlError)
        throw new Error(
          `${SUPERTAG_YAML} does not resolve for a service unit, which does not inherit this shell's environment:\n  ${error.problems.join("\n  ")}\nPut the variables in ${displayPath(envFilePath())} (env_file), or set restart: no.`,
        );
      throw error;
    });
    return loaded;
  };
}

function envFilePath(): string {
  return join(stateDirectory(), ".env");
}

/** The file and service as the process that runs the service resolves them. */
async function resolvedWhereRun(
  file: ServicesFile,
  service: ServiceConfig,
  unitFile: () => Promise<ServicesFile>,
): Promise<{ readonly file: ServicesFile; readonly service: ServiceConfig }> {
  if (service.restart !== "unless-stopped") return { file, service };
  const resolved = await unitFile();
  const found = findService(resolved, service.name);
  if (found === undefined || found.type !== service.type)
    throw new Error(
      `Service ${service.name} resolves differently for its service unit, which does not inherit this shell's environment. Put the variables it needs in ${displayPath(envFilePath())}.`,
    );
  return { file: resolved, service: found };
}

async function upService(
  shellFile: ServicesFile,
  shellService: ServiceConfig,
  unitFile: () => Promise<ServicesFile>,
  options: UpOptions,
  write: (text: string) => void,
): Promise<ServiceOutcome> {
  const slot = slotFor(shellService);
  const label = slotLabel(slot);
  const unit = unitName(shellFile.name, shellService.name);
  const wantsUnit = shellService.restart === "unless-stopped";
  const { file, service } = await resolvedWhereRun(shellFile, shellService, unitFile);
  if (service.type === "host") assertHostServiceEnvironment(service);
  if (wantsUnit)
    for (const warning of unitWarnings(shellFile, shellService, file, service))
      write(`${warning}\n`);
  const manager = wantsUnit
    ? serviceManager(options.services ?? defaultServiceEnvironment())
    : optionalServiceManager(options);
  const installed = manager === undefined ? false : await manager.installed(unit);
  const definition = wantsUnit ? serviceDefinition(file, service, options) : undefined;
  const unitCurrent =
    definition !== undefined && manager !== undefined
      ? installed && (await manager.current(definition))
      : !installed;
  const fingerprint = serviceFingerprint(file, service);
  const running = await runningProcess(slot);
  if (running.staleRemoved !== undefined)
    write(`Removed a stale pid file of ${label}: process ${running.staleRemoved} is gone.\n`);
  let action: ServiceOutcome["action"] = "started";
  if (running.pid !== undefined) {
    const status = await waitForReady(slot, { timeoutMs: readyTimeout(options) });
    if (status.configuration === fingerprint && runningBuildMatches(status) && unitCurrent) {
      if (options.brief?.reported?.includes(service.name) !== true) {
        if (options.brief === undefined)
          write(`${capitalize(label)} already runs with these settings, so it was left alone.\n`);
        await report(file, service, status, write, options.brief && "unchanged");
      }
      await provision(file, service, status, write);
      if (options.brief === undefined) notificationNote(service, write);
      return { service: service.name, kind: service.type, action: "unchanged", status };
    }
    const change =
      runningBuildMatches(status) && unitCurrent
        ? concurrencyChange(file, service, status)
        : undefined;
    if (change !== undefined) {
      write(
        `${capitalize(label)}: concurrency changed from ${change.from} to ${change.to}, so SuperTag applies it without a restart.\n`,
      );
      const updated = await applyConcurrency(slot, file, service, options);
      const attempts = updated.attempts?.length ?? 0;
      if (change.to < change.from && attempts > 0)
        write(`${capitalize(waitsToFit(change.to, attempts))}.\n`);
      await report(file, service, updated, write, options.brief && "updated");
      await provision(file, service, updated, write);
      if (options.brief === undefined) notificationNote(service, write);
      return { service: service.name, kind: service.type, action: "updated", status: updated };
    }
    const reason =
      status.configuration !== fingerprint
        ? `${changedFields(status.resolved, resolvedSummary(service))} changed`
        : !runningBuildMatches(status)
          ? "SuperTag build changed"
          : "its service unit changed";
    write(`${capitalize(label)}: ${reason}, so SuperTag restarts it.\n`);
    if (service.type === "control-plane")
      write("Running Task Attempts may see a brief disconnect; hosts reconnect on their own.\n");
    else await drainHost(slot, drainOptions(options, write));
    await stopService(slot, unit, options, write, { quiet: true });
    action = "restarted";
  }
  if (service.type === "control-plane") await assertPortFree(service);
  else {
    // Join here, so a missing or rejected Auth Key fails on this terminal.
    const target = await resolveHostTarget(file, service, 0);
    const credential = await ensureHostCredential(file, service, target);
    if (credential.notice) write(`${credential.notice}\n`);
    for (const warning of hostServiceStorageWarnings(service, credential.ephemeral === true))
      write(`${warning}\n`);
  }
  let status: ProcessStatus;
  await clearStatus(slot);
  if (definition !== undefined && manager !== undefined) {
    const carried = Object.keys(unitSettings(process.env));
    if (carried.length > 0)
      write(
        `The service unit for ${service.name} keeps ${carried.join(", ")} from this shell; run supertag up without ${carried.length === 1 ? "it" : "them"} to drop ${carried.length === 1 ? "it" : "them"}.\n`,
      );
    for (const line of await manager.install(definition)) write(`${line}\n`);
    status = await waitForReady(slot, {
      timeoutMs: readyTimeout(options),
      ...(running.pid === undefined ? {} : { replacing: running.pid }),
      onTimeout: () => manager.stop(unit),
    });
  } else {
    if (installed && manager !== undefined) {
      await manager.uninstall(unit);
      write(`Removed the service unit for ${label} (${manager.path(unit)}): restart is no.\n`);
    }
    const child = await spawnBackground(slot, childArgs(file, service, options), options);
    if (options.brief === undefined)
      write(`Starting ${label} in the background (logs in ${displayPath(logPath(slot))})...\n`);
    status = await waitForReady(slot, {
      timeoutMs: readyTimeout(options),
      pid: child.pid,
      exited: child.exited,
      onTimeout: async () => {
        if (!child.exited()) await stopProcess(child.pid).catch(() => undefined);
      },
    });
  }
  if (status.configuration !== fingerprint)
    write(`${SUPERTAG_YAML} changed while ${label} started; run supertag up again.\n`);
  await report(file, service, status, write, options.brief && action);
  await provision(file, service, status, write);
  if (options.brief === undefined) notificationNote(service, write);
  return { service: service.name, kind: service.type, action, status };
}

/** A host's concurrency before and after, when nothing else about it changed. */
interface ConcurrencyChange {
  readonly from: number;
  readonly to: number;
}

/**
 * The change when concurrency is the only setting that differs from what the running host
 * reports. `up` then applies it without a restart or a drain.
 */
export function concurrencyChange(
  file: ServicesFile,
  service: ServiceConfig,
  status: ProcessStatus,
): ConcurrencyChange | undefined {
  if (service.type !== "host" || status.state !== "ready") return undefined;
  // The host reports the concurrency it applies with its source; only the value is a change.
  const from = status.concurrency?.value;
  if (from === undefined || from === service.concurrency) return undefined;
  return serviceFingerprint(file, { ...service, concurrency: from }) === status.configuration
    ? { from, to: service.concurrency }
    : undefined;
}

/** Hands the running host its new concurrency and waits until it reports the new settings. */
async function applyConcurrency(
  slot: ServiceSlot,
  file: ServicesFile,
  service: ServiceConfig,
  options: UpOptions,
): Promise<ProcessStatus> {
  if (service.type !== "host") throw new Error("Only a host has a concurrency");
  const id = await writeConcurrencyRequest(slot, {
    concurrency: service.concurrency,
    source: service.concurrencySource,
    configuration: serviceFingerprint(file, service),
    resolved: resolvedSummary(service),
  });
  // The host removes the request once its status shows it. A later `up` may already have
  // replaced that status, so waiting for the request, not for a status, never misses it.
  const deadline = Date.now() + readyTimeout(options);
  for (;;) {
    if (!(await concurrencyRequestPending(slot, id))) {
      const status = await readStatus(slot);
      if (status !== undefined) return status;
    }
    if ((await runningProcess(slot)).pid === undefined)
      throw new Error(`${capitalize(slotLabel(slot))} stopped before it took the new concurrency`);
    if (Date.now() > deadline) {
      await finishConcurrencyRequest(slot, id);
      throw new Error(
        `${capitalize(slotLabel(slot))} did not take the new concurrency within ${Math.round(readyTimeout(options) / 1000)} seconds; see supertag logs ${service.name}`,
      );
    }
    await new Promise((settle) => setTimeout(settle, 100));
  }
}

/** What a lower concurrency means for running work, in `up` and `up --dry-run`. */
function waitsToFit(limit: number, attempts: number): string {
  return `running Task Attempts finish, and a harness starts new ones only once fewer than ${limit} run on it (${attempts} running now)`;
}

/** The `up --dry-run` line for a concurrency change. */
function concurrencyLine(name: string, change: ConcurrencyChange, attempts: number): string {
  const lead = `${change.to > change.from ? "raise" : "lower"} concurrency of ${name} from ${change.from} to ${change.to} without a restart`;
  if (change.to > change.from) return `${lead}; new Task Attempts can start at once`;
  return `${lead}; ${attempts === 0 ? "no Task Attempts running, so nothing waits" : waitsToFit(change.to, attempts)}`;
}

function drainOptions(
  options: {
    readonly force?: boolean;
    readonly clock?: Clock;
    readonly signal?: AbortSignal;
    readonly maxWaitMs?: number;
  },
  write: (text: string) => void,
) {
  return {
    write,
    ...(options.force === undefined ? {} : { force: options.force }),
    ...(options.clock === undefined ? {} : { clock: options.clock }),
    ...(options.maxWaitMs === undefined ? {} : { maxWaitMs: options.maxWaitMs }),
  };
}

/**
 * Variables from this shell that a service unit cannot see, because it does not inherit this
 * shell's environment: ones that change the service's settings as this shell resolves them
 * (`shell`) from what the unit resolves (`unit`), secrets read from the environment, and what the
 * Control Plane reads itself (the admin token, Vault). Settings that differ only because of them
 * never restart the unit's service, because `up` compares what the unit resolves.
 */
function unitWarnings(
  shell: ServicesFile,
  shellService: ServiceConfig,
  unit: ServicesFile,
  unitService: ServiceConfig,
): string[] {
  const unitEnvironment = serviceEnvironment();
  // The unit sees what its definition carries, and env_file.
  const visible = (name: string) =>
    unitEnvironment[name] !== undefined ||
    (shell.envFile[name] !== undefined &&
      shell.envFile[name]?.trim() === process.env[name]?.trim());
  const variables = new Set<string>();
  if (serviceFingerprint(shell, shellService) !== serviceFingerprint(unit, unitService)) {
    // A host's settings include where its Control Plane in the same file listens.
    const prefixes = [
      `services.${shellService.name}.`,
      ...(shellService.type === "host" && "service" in shellService.controlPlane
        ? [`services.${shellService.controlPlane.service}.`]
        : []),
    ];
    for (const [path, source] of shell.provenance)
      if (prefixes.some((prefix) => path.startsWith(prefix)))
        for (const part of source.split(", ")) {
          if (part.startsWith("env_file: ")) continue;
          const name = part.replace(/^environment: /u, "");
          if (!visible(name)) variables.add(name);
        }
  }
  const secrets = [
    ...(shellService.type === "control-plane" && shellService.database.password !== undefined
      ? [shellService.database.password]
      : []),
    ...(shellService.type === "host" && shellService.authKey !== undefined
      ? [shellService.authKey]
      : []),
  ];
  for (const name of secrets) {
    const source = shell.secrets[name];
    if (
      source !== undefined &&
      "environment" in source &&
      shell.envFile[source.environment] === undefined &&
      !visible(source.environment)
    )
      variables.add(source.environment);
  }
  // What the Control Plane reads itself: the admin token, and Vault's address and token.
  if (shellService.type === "control-plane")
    for (const name of [
      "SUPERTAG_ADMIN_TOKEN",
      ...(unitService.type === "control-plane" && unitService.credentials.startsWith("vault:")
        ? VAULT_VARIABLES
        : []),
    ])
      if (process.env[name]?.trim() && shell.envFile[name] === undefined) variables.add(name);
  if (variables.size === 0) return [];
  return [
    `Warning: the service unit for ${shellService.name} does not inherit this shell's environment, so it cannot see ${[...variables].toSorted().join(", ")}. Put them in ${displayPath(envFilePath())} (env_file) or a secret file, or unset them in this shell. supertag up does not restart the service for them.`,
  ];
}

/** Top-level settings that differ between two resolved services. */
export function changedFields(
  before: Readonly<Record<string, unknown>> | undefined,
  after: Readonly<Record<string, unknown>>,
): string {
  if (before === undefined) return "its settings";
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(
    (key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]),
  );
  return keys.length === 0 ? "where its Control Plane listens" : keys.join(", ");
}

async function runInProcess(
  file: ServicesFile,
  service: ServiceConfig,
  mode: "foreground" | "background" | "service",
  options: UpOptions,
  write: (text: string) => void,
): Promise<ServiceOutcome> {
  const signal = options.signal === undefined ? {} : { signal: options.signal };
  if (service.type === "control-plane") {
    const result = await serveControlPlane({
      file,
      service,
      mode,
      write,
      ...signal,
      ...(mode === "foreground"
        ? { onReady: (status: ProcessStatus) => provision(file, service, status, write) }
        : {}),
    });
    if (result.state === "already-running")
      throw new Error(
        `The local Control Plane is already running (process ${result.pid}). Stop it with supertag down first.`,
      );
    return { service: service.name, kind: service.type, action: "stopped", status: result.status };
  }
  await runHostService({ file, service, mode, write, ...signal });
  return { service: service.name, kind: service.type, action: "stopped" };
}

/**
 * `up --foreground`: one service runs in this process; several run as child processes whose logs
 * are shown here, each line prefixed with its service. Ctrl-C stops them all.
 */
async function foreground(
  file: ServicesFile,
  order: readonly ServiceConfig[],
  options: UpOptions,
  write: (text: string) => void,
): Promise<UpResult> {
  const toRun: ServiceConfig[] = [];
  const named =
    (options.names ?? []).length > 0 ? (options.names ?? []) : order.map((service) => service.name);
  const unitFile = unitResolver(options);
  for (const service of order) {
    const slot = slotFor(service);
    const running = await runningProcess(slot);
    if (running.pid === undefined) {
      toRun.push(service);
      continue;
    }
    const status = await readStatus(slot);
    // A dependency already running with the same settings is left alone; a unit's settings are
    // what it resolved without this shell's environment.
    const resolved =
      status?.mode === "service" ? await resolvedWhereRun(file, service, unitFile) : undefined;
    if (
      status?.configuration ===
        serviceFingerprint(resolved?.file ?? file, resolved?.service ?? service) &&
      !named.includes(service.name)
    ) {
      write(
        `${capitalize(slotLabel(slot))} already runs ${describeMode(status.mode)}; leaving it.\n`,
      );
      if (service.type === "control-plane")
        await provision(
          resolved?.file ?? file,
          resolved?.service ?? service,
          await waitForReady(slot, { timeoutMs: readyTimeout(options) }),
          write,
        );
      continue;
    }
    throw new Error(
      `${capitalize(slotLabel(slot))} is already running ${describeMode(status?.mode)} (process ${running.pid}). Stop it with supertag down ${service.name}, then run supertag up --foreground.`,
    );
  }
  if (toRun.length === 1 && toRun[0] !== undefined)
    return { file, services: [await runInProcess(file, toRun[0], "foreground", options, write)] };
  if (toRun.length === 0) return { file, services: [] };

  const { signal, dispose } =
    options.signal === undefined
      ? signalOnInterrupt()
      : { signal: options.signal, dispose: () => {} };
  const children: { service: ServiceConfig; child: ChildProcess }[] = [];
  const exited = new AbortController();
  try {
    for (const service of toRun) {
      const [command, ...prefix] = cliCommand(options);
      if (command === undefined) throw new Error("Cannot find the supertag command to run");
      const child = spawn(command, [...prefix, ...childArgs(file, service, options)], {
        cwd: stateDirectory(),
        env: { ...process.env, [MODE_VARIABLE]: "foreground" },
        stdio: ["ignore", "pipe", "pipe"],
      });
      for (const stream of [child.stdout, child.stderr])
        if (stream !== null)
          createInterface({ input: stream }).on("line", (line) =>
            write(`${service.name} | ${line}\n`),
          );
      let gone = false;
      child.on("exit", () => {
        gone = true;
        exited.abort();
      });
      children.push({ service, child });
      const pid = child.pid;
      if (pid === undefined) throw new Error(`Could not start ${service.name}`);
      await waitForReady(slotFor(service), {
        timeoutMs: readyTimeout(options),
        pid,
        exited: () => gone,
      });
    }
    write("Press Ctrl-C to stop.\n");
    await Promise.race([aborted(signal), aborted(exited.signal)]);
  } finally {
    for (const { child } of children.toReversed()) {
      if (child.exitCode !== null || child.pid === undefined) continue;
      const done = new Promise((settle) => child.once("exit", settle));
      child.kill("SIGTERM");
      await done;
    }
    dispose();
  }
  return {
    file,
    services: toRun.map((service) => ({
      service: service.name,
      kind: service.type,
      action: "stopped",
    })),
  };
}

/** `up --dry-run`: what `up` would start, restart, drain, or leave, with reasons. */
async function dryRun(
  file: ServicesFile,
  order: readonly ServiceConfig[],
  options: UpOptions,
  write: (text: string) => void,
): Promise<void> {
  write(
    `supertag up would, for ${file.files.length > 0 ? file.files.map((path) => displayPath(path)).join(" + ") : "the defaults"}:\n`,
  );
  const unitFile = unitResolver(options);
  for (const shellService of order) {
    const { file: resolved, service } = await resolvedWhereRun(file, shellService, unitFile);
    if (service.type === "host") assertHostServiceEnvironment(service);
    const slot = slotFor(service);
    const unit = unitName(file.name, service.name);
    const manager = optionalServiceManager(options);
    const installed = manager === undefined ? false : await manager.installed(unit);
    const wantsUnit = service.restart === "unless-stopped";
    const unitCurrent =
      wantsUnit && manager !== undefined
        ? installed && (await manager.current(serviceDefinition(resolved, service, options)))
        : !installed;
    const running = await runningProcess(slot);
    const status = running.pid === undefined ? undefined : await readStatus(slot);
    const fingerprint = serviceFingerprint(resolved, service);
    const change =
      status !== undefined && runningBuildMatches(status) && unitCurrent
        ? concurrencyChange(resolved, service, status)
        : undefined;
    const lines: string[] = [];
    if (status === undefined) lines.push(`start ${service.name}: not running`);
    else if (status.configuration === fingerprint && runningBuildMatches(status) && unitCurrent)
      lines.push(`leave ${service.name}: running with the same settings`);
    else if (change !== undefined)
      lines.push(concurrencyLine(service.name, change, status.attempts?.length ?? 0));
    else {
      const reason =
        status.configuration !== fingerprint
          ? `${changedFields(status.resolved, resolvedSummary(service))} changed`
          : !runningBuildMatches(status)
            ? "SuperTag build changed"
            : "its service unit changed";
      if (service.type === "host") {
        const attempts = status.attempts?.length ?? 0;
        lines.push(
          `drain and restart ${service.name}: ${reason}; ${attempts === 0 ? "no Task Attempts running, so no wait" : `waits for ${attempts} running Task Attempt${attempts === 1 ? "" : "s"}`}`,
        );
      } else lines.push(`restart ${service.name}: ${reason}; hosts reconnect on their own`);
    }
    if (wantsUnit && !unitCurrent)
      lines.push(
        `  ${installed ? "update" : "install"} service unit ${manager?.path(unit) ?? unit.label}`,
      );
    if (!wantsUnit && installed)
      lines.push(`  remove service unit ${manager?.path(unit) ?? unit.label}: restart is no`);
    if (service.type === "control-plane" && service.provision.length > 0)
      lines.push(
        `  provision ${service.provision.length} manifest ${service.provision.length === 1 ? "entry" : "entries"}: create what is missing, change nothing that exists`,
      );
    if (wantsUnit)
      for (const warning of unitWarnings(file, shellService, resolved, service))
        lines.push(`  ${warning}`);
    if (service.type === "host")
      for (const warning of hostServiceStorageWarnings(
        service,
        (await storedHostCredential(service.name))?.ephemeral === true,
      ))
        lines.push(`  ${warning}`);
    for (const line of lines) write(`  ${line}\n`);
  }
  await noteRemovedHosts(file, (line) => write(`  ${line}\n`));
}

async function explainContext(
  options: UpOptions,
  file: ServicesFile,
  write: (text: string) => void,
): Promise<void> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const local = join(cwd, SUPERTAG_YAML);
  if (
    (options.files ?? []).length === 0 &&
    !file.files.includes(local) &&
    resolve(cwd) !== resolve(stateDirectory()) &&
    (await stat(local).catch(() => undefined))?.isFile()
  )
    write(
      `${displayPath(local)} is not read: supertag up reads ${defaultSupertagYamlPath()}, or the files -f names.\n`,
    );
}

/** On every up, a healthy Control Plane gets what its file declares and is missing. */
async function provision(
  file: ServicesFile,
  service: ServiceConfig,
  status: ProcessStatus,
  write: (text: string) => void,
): Promise<void> {
  if (service.type !== "control-plane" || status.url === undefined) return;
  for (const line of await provisionControlPlane(file, service, status.url)) write(`${line}\n`);
}

/**
 * Prints where a service runs, after its health check. `brief` prints one line for what `up` did
 * instead, with the host's health lines after it.
 */
/** After the existing up lines (init prints it last for brief runs), note the default desktop channel for a local Control Plane. */
export function notificationNote(service: ServiceConfig, write: (text: string) => void): void {
  if (
    service.type === "control-plane" &&
    service.notify === undefined &&
    process.env["SUPERTAG_DEPLOYMENT_PLATFORM"] === undefined
  )
    write("Operator notifications: desktop (default on this local host).\n");
}

async function report(
  file: ServicesFile,
  service: ServiceConfig,
  status: ProcessStatus,
  write: (text: string) => void,
  brief?: ServiceOutcome["action"],
): Promise<void> {
  const label = slotLabel(slotFor(service));
  const at = service.type === "control-plane" ? ` at ${status.url}` : "";
  const where = `${describeMode(status.mode)}${at} (process ${status.pid})`;
  const summary =
    brief === "unchanged"
      ? `${capitalize(label)} already runs ${where}.`
      : `${brief === "restarted" ? "Restarted" : brief === "updated" ? "Updated" : "Started"} ${label} ${where}.`;
  if (service.type === "control-plane") {
    if (status.url === undefined) throw new Error("The Control Plane did not report its URL");
    await waitForControlPlaneHealth(status.url);
    write(brief === undefined ? `Control Plane ready at ${status.url}.\n` : `${summary}\n`);
    if (brief !== undefined) return;
  } else {
    if (brief !== undefined) write(`${summary}\n`);
    for (const line of status.notices ?? []) write(`${line}\n`);
    const target = await resolveHostTarget(file, service, 0).catch(() => undefined);
    if (target !== undefined)
      for (const line of await hostHealthLines(status, target)) write(`${line}\n`);
    if (brief !== undefined) return;
  }
  write(
    `${capitalize(label)} is running ${describeMode(status.mode)} (process ${status.pid}). Follow its logs with supertag logs -f ${service.name}; stop it with supertag down ${service.name}.\n`,
  );
}

/** Retry brief load spikes before reporting a running Control Plane as unavailable. */
export async function waitForControlPlaneHealth(url: string): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const ready = await fetch(new URL("/healthz", `${url}/`), {
      signal: AbortSignal.timeout(5_000),
    }).catch(() => undefined);
    if (ready?.ok) return;
    if (attempt < 2) await delay(250 * 2 ** attempt);
  }
  throw new Error(`The Control Plane at ${url} is not ready`);
}

async function assertPortFree(service: ControlPlaneService): Promise<void> {
  if (service.ports.port === 0) return;
  const url = defaultUrl(service.ports);
  const answer = await fetch(new URL("/healthz", `${url}/`), {
    redirect: "error",
    signal: AbortSignal.timeout(2_000),
  }).catch(() => undefined);
  if (answer !== undefined)
    throw new Error(
      `Another Control Plane already listens at ${url}, so SuperTag cannot start the local one there. Stop it, or change ports in ${SUPERTAG_YAML}.`,
    );
}

/** Stops one service, through its unit when one is installed; optionally removes the unit. */
export async function stopService(
  slot: ServiceSlot,
  unit: ReturnType<typeof unitName>,
  options: LocalProcessOptions & { readonly removeServices?: boolean },
  write: (text: string) => void,
  flags: { readonly quiet?: boolean } = {},
): Promise<boolean> {
  const label = slotLabel(slot);
  const manager: ServiceManager | undefined = await installedService(unit, slot.service, options);
  const running = await runningProcess(slot);
  if (running.staleRemoved !== undefined)
    write(`Removed a stale pid file of ${label}: process ${running.staleRemoved} is gone.\n`);
  if (manager !== undefined) {
    if (options.removeServices === true) {
      await manager.uninstall(unit);
      write(`Removed the service unit for ${label} (${manager.path(unit)}).\n`);
    } else await manager.stop(unit);
  }
  if (running.pid === undefined) return false;
  if (manager === undefined) await stopProcess(running.pid);
  else await waitForStop(running.pid, async () => (await runningProcess(slot)).pid);
  await runningProcess(slot);
  if (flags.quiet !== true) {
    write(`Stopped ${label} (process ${running.pid}).\n`);
    if (manager !== undefined && options.removeServices !== true)
      write(
        "Its service unit starts it again when you log in; supertag down --remove-services removes it.\n",
      );
  }
  return true;
}

export async function runDownCommand(
  args: readonly string[],
  testOptions: Pick<DownOptions, "clock" | "write"> = {},
): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(downHelp());
    return 0;
  }
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      file: { type: "string", short: "f", multiple: true },
      "remove-services": { type: "boolean" },
      force: { type: "boolean" },
    },
    strict: true,
  });
  const result = await bringDown({
    ...testOptions,
    files: values.file ?? [],
    names: positionals,
    removeServices: values["remove-services"] === true,
    force: values.force === true,
  });
  return result === "timed-out" ? 1 : 0;
}

export interface DownOptions extends LocalProcessOptions {
  readonly cwd?: string;
  readonly files?: readonly string[];
  /** Services to stop; all by default. */
  readonly names?: readonly string[];
  /** Also uninstall the service units. */
  readonly removeServices?: boolean;
  /** Stop hosts without waiting for running Task Attempts. */
  readonly force?: boolean;
  /** Time for drain waits; tests pass a fake. */
  readonly clock?: Clock;
  readonly write?: (text: string) => void;
}

/** The file for commands that stop or inspect services. */
export async function fileForState(options: {
  readonly files?: readonly string[];
  readonly cwd?: string;
}): Promise<ServicesFile | undefined> {
  return loadServicesFile({
    files: options.files ?? [],
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
  });
}

/** A service `down`, `logs`, or `ps` knows of: from the file, or from state on this machine. */
export interface KnownService {
  readonly slot: ServiceSlot;
  /** The supertag.yaml `name` its unit is labeled with. */
  readonly instance: string;
  /** Undefined for a service the file no longer names. */
  readonly service?: ServiceConfig;
}

/** Services named in the file, then services with state on this machine that it no longer names. */
export async function knownServices(
  file: ServicesFile | undefined,
): Promise<readonly KnownService[]> {
  const instance = file?.name ?? DEFAULT_INSTANCE_NAME;
  const known: KnownService[] = (file?.services ?? []).map((service) => ({
    slot: slotFor(service),
    instance,
    service,
  }));
  for (const slot of await listSlots()) {
    const named = known.some(
      (entry) =>
        entry.slot.kind === slot.kind &&
        (slot.kind === "control-plane" || entry.slot.service === slot.service),
    );
    if (named) continue;
    const status = await readStatus(slot);
    known.push({ slot, instance: status?.instance ?? instance });
  }
  return known;
}

/**
 * `supertag down [SERVICE...]`: stops services in reverse depends_on order, hosts first. With
 * service units installed, it stops them until the next login; `removeServices` uninstalls them.
 */
export async function bringDown(
  options: DownOptions = {},
): Promise<"stopped" | "not-running" | "timed-out"> {
  const write = options.write ?? ((text: string) => process.stdout.write(text));
  const file = await fileForState(options);
  const known = await knownServices(file);
  const names = options.names ?? [];
  for (const name of names)
    if (!known.some((entry) => entry.slot.service === name))
      throw new Error(`${name} is not a service in ${SUPERTAG_YAML} or on this machine`);
  const order = file === undefined ? [] : startOrder(file).map((service) => service.name);
  const targets = known
    .filter((entry) => names.length === 0 || names.includes(entry.slot.service))
    .toSorted((a, b) => {
      // Hosts before the Control Plane; dependents before what they depend on.
      if (a.slot.kind !== b.slot.kind) return a.slot.kind === "host" ? -1 : 1;
      return order.indexOf(b.slot.service) - order.indexOf(a.slot.service);
    });
  let stopped = false;
  let retired = false;
  for (const target of targets) {
    if (target.slot.kind === "host") {
      const outcome = await drainHost(
        target.slot,
        drainOptions({ ...options, maxWaitMs: DOWN_WAIT_MS }, write),
      );
      if (outcome === "timeout") {
        write(
          `Host service ${target.slot.service} remains running; no services were stopped after it.\n`,
        );
        return "timed-out";
      }
    }
    const unit = unitName(target.instance, target.slot.service);
    // A host the file no longer names, stopped by name, is removed: its unit, Worker Host, state.
    const removed =
      target.service === undefined &&
      target.slot.kind === "host" &&
      names.includes(target.slot.service);
    stopped =
      (await stopService(
        target.slot,
        unit,
        removed ? { ...options, removeServices: true } : options,
        write,
      )) || stopped;
    if (removed && (await retireRemovedHost(target.slot, write)) === "removed") retired = true;
  }
  if (!stopped && !retired && options.removeServices !== true)
    write(
      names.length === 0
        ? "SuperTag is not running on this machine.\n"
        : `${names.join(", ")} ${names.length === 1 ? "is" : "are"} not running.\n`,
    );
  return stopped ? "stopped" : "not-running";
}

export async function runLogsCommand(args: readonly string[]): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(logsHelp());
    return 0;
  }
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      follow: { type: "boolean", short: "f" },
      file: { type: "string", multiple: true },
    },
    strict: true,
  });
  await showLogs({ follow: values.follow === true, names: positionals, files: values.file ?? [] });
  return 0;
}

/**
 * `supertag logs [-f] [SERVICE...]`: prints services' logs, each line prefixed with its service
 * when several are shown, and with `follow` keeps printing.
 */
export async function showLogs(
  options: {
    readonly follow?: boolean;
    readonly names?: readonly string[];
    readonly files?: readonly string[];
    readonly signal?: AbortSignal;
    readonly write?: (text: string) => void;
  } = {},
): Promise<void> {
  const write = options.write ?? ((text: string) => process.stdout.write(text));
  const file = await fileForState({ files: options.files ?? [] });
  const known = await knownServices(file);
  const names = options.names ?? [];
  for (const name of names)
    if (!known.some((entry) => entry.slot.service === name))
      throw new Error(`${name} is not a service in ${SUPERTAG_YAML} or on this machine`);
  const chosen = known.filter((entry) => names.length === 0 || names.includes(entry.slot.service));
  const prefixed = chosen.length > 1;
  const sources = chosen.map((entry) => ({
    name: entry.slot.service,
    path: logPath(entry.slot),
    offset: 0,
    partial: "",
  }));
  const drain = async (source: (typeof sources)[number]) => {
    const size = (await stat(source.path).catch(() => undefined))?.size;
    if (size === undefined) return;
    if (size < source.offset) source.offset = 0;
    if (size === source.offset) return;
    const end = size;
    const text = await new Promise<string>((done, reject) => {
      const chunks: string[] = [];
      const stream = createReadStream(source.path, {
        start: source.offset,
        end: end - 1,
        encoding: "utf8",
      });
      stream.on("data", (chunk) => chunks.push(String(chunk)));
      stream.on("end", () => done(chunks.join("")));
      stream.on("error", reject);
    });
    source.offset = end;
    if (!prefixed) {
      write(text);
      return;
    }
    const lines = `${source.partial}${text}`.split("\n");
    source.partial = lines.pop() ?? "";
    for (const line of lines) write(`${source.name} | ${line}\n`);
  };
  const present = await Promise.all(
    sources.map(async (source) => (await stat(source.path).catch(() => undefined)) !== undefined),
  );
  if (!present.some(Boolean) && options.follow !== true) {
    write(`No logs yet in ${displayPath(stateDirectory())}.\n`);
    return;
  }
  for (const source of sources) await drain(source);
  if (options.follow !== true) {
    for (const source of sources) if (source.partial) write(`${source.name} | ${source.partial}\n`);
    return;
  }
  const { signal, dispose } =
    options.signal === undefined
      ? signalOnInterrupt()
      : { signal: options.signal, dispose: () => {} };
  try {
    while (!signal.aborted) {
      await Promise.race([new Promise((done) => setTimeout(done, 250)), aborted(signal)]);
      for (const source of sources) await drain(source);
    }
  } finally {
    dispose();
  }
}

function capitalize(text: string): string {
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}

export function upHelp(): string {
  return `Usage:
  supertag up [SERVICE...] [-f PATH...] [--force]
  supertag up --foreground [SERVICE...] [-f PATH...]
  supertag up --dry-run [SERVICE...] [-f PATH...]

Brings up the services ${SUPERTAG_YAML} defines, like docker compose up: a control-plane service runs
the local Control Plane, and each host service connects this machine as a Worker Host. Services
start in depends_on order (hosts after the Control Plane they use), each waits for its health
check, and up returns while they keep running in the background. Naming services brings up only
those and what they depend on.

up reads ~/.supertag/${SUPERTAG_YAML} (or $SUPERTAG_STATE_DIR/${SUPERTAG_YAML}), or the files -f names,
merged in order. Without a file it runs one control-plane service with the defaults: port 3434
on 127.0.0.1 and a SQLite database in ~/.supertag/. Environment variables such as
SUPERTAG_DATABASE_URL override the file; supertag config shows the result.

Running up again leaves a service that runs with the same settings alone and restarts one whose
settings changed. A changed host drains first: it takes no new Task Attempts and waits for running
ones to finish, at most the longest remaining Task Attempt time limit plus 30 seconds (30 minutes
at most), printing progress every 10 seconds. --force or Ctrl-C stops waiting. A service with
restart: unless-stopped gets a per-user service unit (launchd on macOS, systemd on Linux) that
keeps it running after restarts.

A control-plane service's provision list is applied after it becomes healthy, including with
--foreground: missing resources are created, and existing ones are never changed or deleted. A
host in the same file as its Control Plane creates missing Workspaces with defaults. If provisioning
fails, up reports the error and stops a foreground Control Plane.

  SERVICE...        Services to bring up (default: all)
  -f, --file PATH   ${SUPERTAG_YAML}, or a directory that holds one; repeat to merge files
  --foreground      Run in this terminal with logs here, each line prefixed by its service; Ctrl-C
                    stops them
  --dry-run         Print what up would start, restart, drain, or leave, and why
  --force           Do not wait for running Task Attempts when a host restarts

Follow the logs with supertag logs -f, list services with supertag ps, and stop with supertag
down.
`;
}

export function downHelp(): string {
  return `Usage: supertag down [SERVICE...] [-f PATH...] [--remove-services] [--force]

Stops services in reverse depends_on order: hosts first, then the Control Plane. A host drains
first, taking no new Task Attempts and waiting up to five minutes for running ones. It prints
their Task and Attempt IDs and how to stop now with supertag down SERVICE --force. If work remains,
down exits non-zero and leaves that host and subsequent services running. Without SERVICE, down stops every
service on this machine, including ones ${SUPERTAG_YAML} no longer names. With service units installed, down stops them until the
next login; --remove-services also uninstalls them.

Naming a host service ${SUPERTAG_YAML} no longer names removes it: down stops it, removes its
service unit, unbinds its Worker Host from Tags (with operator access to its Control Plane),
revokes the Worker Host, and removes its state from this machine. supertag up and supertag ps
list such services.

  SERVICE             Services to stop (default: all)
  -f, --file PATH     ${SUPERTAG_YAML}, or a directory that holds one; repeat to merge files
  --remove-services   Uninstall the service units as well
  --force             Do not wait for running Task Attempts
`;
}

export function logsHelp(): string {
  return `Usage: supertag logs [-f] [SERVICE...]

Prints the logs of this machine's services from ~/.supertag/control-plane/logs/ and
~/.supertag/hosts/SERVICE/logs/. Plain lines start with an ISO 8601 time; JSON audit lines carry
their own. Each line starts with SERVICE | when several services are shown.

  SERVICE...        Services to show (default: all)
  -f, --follow      Keep printing new lines until Ctrl-C
`;
}
