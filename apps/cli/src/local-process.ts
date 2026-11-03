import { type ChildProcess, spawn } from "node:child_process";
import { open } from "node:fs/promises";
import { stateDirectory } from "@supertag/store";
import {
  isRunning,
  logPath,
  logTail,
  type ProcessStatus,
  type RunMode,
  readStatus,
  rotateLog,
  type ServiceSlot,
} from "./local-state.js";
import { displayPath, type Environment, type ServicesFile, unitSettings } from "./supertag-yaml.js";
import {
  defaultServiceEnvironment,
  type ServiceEnvironment,
  type ServiceManager,
  serviceManager,
  type UnitName,
  unitArguments,
} from "./up-service.js";

/** Shared options for commands that start or stop service processes. */
export interface LocalProcessOptions {
  /** The command that runs this CLI; defaults to the running one. Tests pass a tsx command. */
  readonly cliCommand?: readonly string[];
  /** How long to wait for a background or unit process to become ready. */
  readonly readyTimeoutMs?: number;
  /** Service manager access; tests pass fakes. */
  readonly services?: ServiceEnvironment;
}

export const READY_TIMEOUT_MS = 120_000;
const STOP_TIMEOUT_MS = 20_000;

/** The environment variable that tells a service process how it was started. */
export const MODE_VARIABLE = "SUPERTAG_UP_MODE";

/** What people call a service in messages. */
export function slotLabel(slot: ServiceSlot): string {
  return slot.kind === "control-plane" ? "the local Control Plane" : `host service ${slot.service}`;
}

/** The mode a service process was started in, if a parent started it. */
export function childMode(): RunMode | undefined {
  const value = process.env[MODE_VARIABLE]?.trim();
  return value === "background" || value === "service" || value === "foreground"
    ? value
    : undefined;
}

export function cliCommand(options: LocalProcessOptions): readonly string[] {
  if (options.cliCommand !== undefined) return options.cliCommand;
  const entry = process.argv[1];
  if (entry === undefined) throw new Error("Cannot find the supertag command to run");
  return [process.execPath, ...process.execArgv, entry];
}

export function readyTimeout(options: LocalProcessOptions): number {
  return options.readyTimeoutMs ?? READY_TIMEOUT_MS;
}

export function describeMode(mode: RunMode | undefined): string {
  return mode === "service"
    ? "as a service unit"
    : mode === "foreground"
      ? "in the foreground"
      : "in the background";
}

/** The service manager when this platform has one, else undefined. */
export function optionalServiceManager(options: LocalProcessOptions): ServiceManager | undefined {
  try {
    return serviceManager(options.services ?? defaultServiceEnvironment());
  } catch {
    return undefined;
  }
}

/** The service manager, if a unit that runs `service` is installed under this name. */
export async function installedService(
  unit: UnitName,
  service: string,
  options: LocalProcessOptions,
): Promise<ServiceManager | undefined> {
  const manager = optionalServiceManager(options);
  return manager !== undefined && (await manager.runs(unit, unitArguments(service)))
    ? manager
    : undefined;
}

/** What a unit's environment carries from the shell besides SUPERTAG_* settings. */
const UNIT_BASE_VARIABLES = [
  "PATH",
  "HOME",
  "SUPERTAG_STATE_DIR",
  "CODEX_HOME",
  "CLAUDE_CONFIG_DIR",
  "CLAUDE_SECURESTORAGE_CONFIG_DIR",
  "XDG_CONFIG_HOME",
] as const;

/**
 * The environment a service unit runs with: the mode, what finds harnesses and state, and the
 * shell's non-secret SUPERTAG_* overrides. Never a secret: units read secrets from files and
 * env_file when they start.
 */
export function serviceEnvironment(source: Environment = process.env): Record<string, string> {
  const environment: Record<string, string> = { [MODE_VARIABLE]: "service" };
  for (const key of UNIT_BASE_VARIABLES) {
    const value = source[key]?.trim();
    if (value) environment[key] = value;
  }
  return { ...environment, ...unitSettings(source) };
}

/** Credentials that local harness Workers read from their process environment. */
const HARNESS_CREDENTIAL_VARIABLES = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CODEX_API_KEY",
  "OPENAI_API_KEY",
  "CURSOR_API_KEY",
] as const;

/** The env_file credentials the host imports before starting local Workers. */
export function harnessCredentialsFromEnvFile(
  envFile: ServicesFile["envFile"],
  environment: Environment,
): Record<string, string> {
  const credentials: Record<string, string> = {};
  for (const name of HARNESS_CREDENTIAL_VARIABLES) {
    const value = envFile[name]?.trim();
    if (value && !environment[name]?.trim()) credentials[name] = value;
  }
  return credentials;
}

/** Mirror the host process environment that init will start. */
export function probeWorkerEnvironment(
  file: Pick<ServicesFile, "envFile">,
  serviceInstalled: boolean,
  shell: Environment = process.env,
): Record<string, string | undefined> {
  const base = serviceInstalled ? serviceEnvironment(shell) : { ...shell };
  return { ...base, ...harnessCredentialsFromEnvFile(file.envFile, base) };
}

/** Starts this CLI detached with `args`, logging to the service's log file. */
export async function spawnBackground(
  slot: ServiceSlot,
  args: readonly string[],
  options: LocalProcessOptions,
): Promise<{ readonly pid: number; readonly exited: () => boolean }> {
  await rotateLog(slot);
  const log = await open(logPath(slot), "a", 0o600);
  let child: ChildProcess;
  try {
    const [command, ...prefix] = cliCommand(options);
    if (command === undefined) throw new Error("Cannot find the supertag command to run");
    child = spawn(command, [...prefix, ...args], {
      cwd: stateDirectory(),
      detached: true,
      stdio: ["ignore", log.fd, log.fd],
      env: { ...process.env, [MODE_VARIABLE]: "background" },
      windowsHide: true,
    });
  } finally {
    await log.close();
  }
  let exited = false;
  child.on("exit", () => {
    exited = true;
  });
  child.on("error", () => {
    exited = true;
  });
  child.unref();
  const pid = child.pid;
  if (pid === undefined) throw new Error(`Could not start ${slotLabel(slot)} in the background`);
  return { pid, exited: () => exited };
}

/**
 * Waits until a service reports ready. Fails with the end of its log when the process exits,
 * reports failure, or takes longer than the timeout.
 */
export async function waitForReady(
  slot: ServiceSlot,
  input: {
    readonly timeoutMs: number;
    /** The process expected to report, when known. */
    readonly pid?: number;
    /** A process being replaced; its status does not count. */
    readonly replacing?: number;
    readonly exited?: () => boolean;
    readonly onTimeout?: () => Promise<void>;
  },
): Promise<ProcessStatus> {
  const deadline = Date.now() + input.timeoutMs;
  for (;;) {
    const status = await readStatus(slot);
    const current =
      status !== undefined &&
      status.pid !== input.replacing &&
      (input.pid === undefined || status.pid === input.pid);
    if (current && status.state === "ready") return status;
    const failed = current && status.state === "failed";
    const gone = input.exited?.() === true || (input.pid !== undefined && !isRunning(input.pid));
    if (failed || gone || Date.now() > deadline) {
      if (!failed && !gone) await input.onTimeout?.();
      else if (failed && input.pid !== undefined)
        await stopProcess(input.pid).catch(() => undefined);
      const reason = failed
        ? `failed to start: ${status?.error ?? "see the log"}`
        : gone
          ? "stopped before it was ready"
          : `was not ready within ${Math.round(input.timeoutMs / 1000)} seconds and was stopped`;
      const tail = await logTail(slot);
      const label = slotLabel(slot);
      throw new Error(
        `${label.charAt(0).toUpperCase()}${label.slice(1)} ${reason}.${
          tail ? `\nLast lines of ${displayPath(logPath(slot))}:\n${tail}` : ""
        }`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

/** Asks a process to stop, then kills it if it has not exited in time. */
export async function stopProcess(pid: number): Promise<void> {
  if (pid === process.pid) throw new Error("SuperTag runs in this process; stop it with Ctrl-C");
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return;
  }
  const deadline = Date.now() + STOP_TIMEOUT_MS;
  while (isRunning(pid)) {
    if (Date.now() > deadline) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        return;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** Waits for a service manager to stop a process, then stops it directly if it is still there. */
export async function waitForStop(
  pid: number,
  stillRunning: () => Promise<number | undefined>,
): Promise<void> {
  const deadline = Date.now() + STOP_TIMEOUT_MS;
  while ((await stillRunning()) === pid && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 100));
  if ((await stillRunning()) === pid) await stopProcess(pid);
}

export function signalOnInterrupt(): { readonly signal: AbortSignal; dispose(): void } {
  const controller = new AbortController();
  const dispose = () => {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  };
  const stop = () => {
    dispose();
    controller.abort();
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  return { signal: controller.signal, dispose };
}

export function aborted(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) =>
    signal.addEventListener("abort", () => resolve(), { once: true }),
  );
}
