import { randomUUID } from "node:crypto";
import { mkdir, open, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { stateDirectory } from "@supertag/store";
import {
  controlPlaneOf,
  DEFAULT_CONTROL_PLANE_PORT,
  DEFAULT_CONTROL_PLANE_SERVICE,
  defaultUrl,
  loadServicesFile,
} from "./supertag-yaml.js";

/** The two kinds of service supertag.yaml defines. */
export type ServiceKind = "control-plane" | "host";

/**
 * Where one service keeps its pid file, status, and log: `~/.supertag/control-plane/` for the
 * local Control Plane (one per machine), and `~/.supertag/hosts/SERVICE/` for each host service.
 */
export interface ServiceSlot {
  readonly kind: ServiceKind;
  readonly service: string;
}

/** How a service process runs. */
export type RunMode = "background" | "foreground" | "service";

/** One running Task Attempt on a host, as the host process reports it. */
export interface RunningAttempt {
  readonly attemptId: string;
  readonly taskId: string;
  readonly startedAt: string;
}

/**
 * One uncertain Task Attempt in a host's journal: it may have executed and keeps a Worker slot
 * until an operator stops the host and runs `supertag recover worklet`.
 */
export interface UncertainAttemptStatus {
  readonly attemptId: string;
  readonly taskId: string;
  readonly workerId?: string;
  /** Why its receipt became `unknown`. */
  readonly reason?: string;
  readonly since?: string;
}

/** What a running service process reports in its `status.json`. */
export interface ProcessStatus {
  readonly pid: number;
  readonly mode: RunMode;
  readonly state: "starting" | "ready" | "failed";
  readonly startedAt: string;
  /** Fingerprint of the settings only a restart changes. */
  readonly configuration: string;
  /** The SuperTag release running this process; absent in older status files. */
  readonly version?: string;
  /** Digest of the code loaded when the service started. */
  readonly buildIdentity?: string;
  readonly kind?: ServiceKind;
  readonly service?: string;
  /** The supertag.yaml `name` that labels the service unit. */
  readonly instance?: string;
  /** The service's resolved settings, without secret values, for `up --dry-run` reasons. */
  readonly resolved?: Readonly<Record<string, unknown>>;
  /** Control Plane: its API URL. Host: the management URL of the Control Plane it joined. */
  readonly url?: string;
  /** Control Plane: its Worklet gRPC listener, when it has one. */
  readonly workletUrl?: string;
  /** Host only. */
  readonly workerHostId?: string;
  readonly workers?: readonly string[];
  /** Host only: whether the Worklet is connected now. */
  readonly connected?: boolean;
  /** Host only: Task Attempts running now. */
  readonly attempts?: readonly RunningAttempt[];
  /** Host only: uncertain Task Attempts in its journal. */
  readonly uncertainAttempts?: readonly UncertainAttemptStatus[];
  /** Host only: the OS command keeping the machine awake while Task Attempts run, if any. */
  readonly keepAwake?: { readonly tool: string; readonly since: string };
  /** Host only: the per-harness concurrency it applies and where that value came from. */
  readonly concurrency?: { readonly value: number; readonly source: "machine" | "file" };
  /** Host only: the time limit of each Task Attempt it runs. */
  readonly attemptTimeLimitMs?: number;
  /** The line naming what this host serves. */
  readonly serving?: string;
  /** Lines worth showing whoever started the process, such as skipped harnesses. */
  readonly notices?: readonly string[];
  readonly error?: string;
}

/** A log larger than this is moved to NAME.log.1 when its process starts. */
export const LOG_ROTATE_BYTES = 10 * 1024 * 1024;
export { DEFAULT_CONTROL_PLANE_PORT };

export function controlPlaneSlot(service = DEFAULT_CONTROL_PLANE_SERVICE): ServiceSlot {
  return { kind: "control-plane", service };
}

export function hostSlot(service: string): ServiceSlot {
  return { kind: "host", service };
}

export function slotDirectory(slot: ServiceSlot): string {
  return slot.kind === "control-plane"
    ? join(stateDirectory(), "control-plane")
    : hostServiceDirectory(slot.service);
}

/** A host service's directory: its credential, Worker Host ID, pid, status, logs, and journal. */
export function hostServiceDirectory(service: string): string {
  return join(stateDirectory(), "hosts", service);
}

/** Where a host service keeps its Worker Host credential, which records its Worker Host ID. */
export function hostCredentialPath(service: string): string {
  return join(hostServiceDirectory(service), "credential.json");
}

export function pidPath(slot: ServiceSlot): string {
  return join(slotDirectory(slot), "pid");
}

export function statusPath(slot: ServiceSlot): string {
  return join(slotDirectory(slot), "status.json");
}

export function logDirectory(slot: ServiceSlot): string {
  return join(slotDirectory(slot), "logs");
}

export function logPath(slot: ServiceSlot): string {
  return join(logDirectory(slot), `${slot.kind}.log`);
}

/** Every service slot with state on this machine: the Control Plane's and each host's. */
export async function listSlots(): Promise<readonly ServiceSlot[]> {
  const slots: ServiceSlot[] = [];
  if ((await stat(join(stateDirectory(), "control-plane")).catch(() => undefined))?.isDirectory()) {
    const status = await readStatus(controlPlaneSlot());
    slots.push(controlPlaneSlot(status?.service ?? DEFAULT_CONTROL_PLANE_SERVICE));
  }
  const hosts = await readdir(join(stateDirectory(), "hosts"), { withFileTypes: true }).catch(
    () => [],
  );
  for (const entry of hosts.toSorted((a, b) => a.name.localeCompare(b.name)))
    if (entry.isDirectory()) slots.push(hostSlot(entry.name));
  return slots;
}

/** Pid files this process took and has not released. */
const heldPidFiles = new Set<string>();

/**
 * The live process holding a pid file, cleaning up a stale one. A file that names this process
 * without this process having taken it is stale too: a container restarted on the same volume
 * often gets the pid its earlier run had.
 */
export async function runningProcess(
  slot: ServiceSlot,
): Promise<{ readonly pid?: number; readonly staleRemoved?: number }> {
  const path = pidPath(slot);
  const text = await readFile(path, "utf8").catch(() => undefined);
  if (text === undefined) return {};
  const pid = Number(text.trim());
  const own = pid === process.pid && !heldPidFiles.has(path);
  if (Number.isInteger(pid) && pid > 0 && !own && isRunning(pid)) return { pid };
  await removeState(slot);
  return Number.isInteger(pid) && pid > 0 ? { staleRemoved: pid } : {};
}

/**
 * Takes the pid file for this service: the lock that keeps one process per service, and one local
 * Control Plane per machine. Returns the live holder instead when another process has it.
 */
export async function acquirePidFile(slot: ServiceSlot): Promise<{
  readonly held?: number;
  /** Removes the pid file and status; a failed process keeps its status for `up` to report. */
  readonly release: (options?: { readonly keepStatus?: boolean }) => Promise<void>;
}> {
  await mkdir(slotDirectory(slot), { recursive: true, mode: 0o700 });
  const path = pidPath(slot);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(path, "wx", 0o600);
      await handle.writeFile(`${process.pid}\n`);
      await handle.close();
      heldPidFiles.add(path);
      let released = false;
      return {
        release: async (options = {}) => {
          if (released) return;
          released = true;
          heldPidFiles.delete(path);
          const owner = Number((await readFile(path, "utf8").catch(() => "")).trim());
          if (owner !== process.pid) return;
          if (options.keepStatus === true) await unlink(path).catch(() => undefined);
          else await removeState(slot);
        },
      };
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
      const running = await runningProcess(slot);
      if (running.pid !== undefined) return { held: running.pid, release: async () => {} };
    }
  }
  throw new Error(`Could not take the pid file ${path}`);
}

/** Removes what a stopped service left behind, before a new process starts. */
export async function clearStatus(slot: ServiceSlot): Promise<void> {
  if ((await runningProcess(slot)).pid === undefined) await removeState(slot);
}

async function removeState(slot: ServiceSlot): Promise<void> {
  await unlink(pidPath(slot)).catch(() => undefined);
  await unlink(statusPath(slot)).catch(() => undefined);
}

export async function readStatus(slot: ServiceSlot): Promise<ProcessStatus | undefined> {
  const text = await readFile(statusPath(slot), "utf8").catch(() => undefined);
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text) as ProcessStatus;
  } catch {
    return undefined;
  }
}

export async function writeStatus(slot: ServiceSlot, status: ProcessStatus): Promise<void> {
  const path = statusPath(slot);
  await mkdir(slotDirectory(slot), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(status, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

/**
 * A new concurrency that `supertag up` asks a running host to apply without a restart, with the
 * settings fingerprint and resolved settings the host reports once it has.
 */
export interface ConcurrencyRequest {
  readonly concurrency: number;
  /** Whether the new value came from the machine or the file, for `supertag ps`. */
  readonly source: "machine" | "file";
  readonly configuration: string;
  readonly resolved: Readonly<Record<string, unknown>>;
}

/** One request waiting in a host's slot; `request` is undefined for a malformed file. */
export interface PendingConcurrencyRequest {
  readonly id: string;
  readonly request: ConcurrencyRequest | undefined;
}

/**
 * Each request is its own file, named so that names sort in the order `up` wrote them. Two `up`
 * commands at once therefore never replace or remove each other's request.
 */
function concurrencyRequestDirectory(slot: ServiceSlot): string {
  return join(slotDirectory(slot), "concurrency");
}

function concurrencyRequestPath(slot: ServiceSlot, id: string): string {
  return join(concurrencyRequestDirectory(slot), `${id}.json`);
}

/**
 * Leaves a concurrency request for the running host, which picks it up within a second, and
 * returns its ID. The host removes the request once it has applied it and updated its status.
 */
export async function writeConcurrencyRequest(
  slot: ServiceSlot,
  request: ConcurrencyRequest,
): Promise<string> {
  const directory = concurrencyRequestDirectory(slot);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const id = `${Date.now().toString().padStart(15, "0")}-${randomUUID()}`;
  // A dot-prefixed temporary name is not a request, so the host never reads a partial file.
  const temporary = join(directory, `.${id}.tmp`);
  await writeFile(temporary, `${JSON.stringify(request, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, concurrencyRequestPath(slot, id));
  return id;
}

/** Whether the host has yet to apply a request. */
export async function concurrencyRequestPending(slot: ServiceSlot, id: string): Promise<boolean> {
  return stat(concurrencyRequestPath(slot, id)).then(
    () => true,
    () => false,
  );
}

/** Requests waiting for the host, oldest first. */
export async function pendingConcurrencyRequests(
  slot: ServiceSlot,
): Promise<PendingConcurrencyRequest[]> {
  const names = await readdir(concurrencyRequestDirectory(slot)).catch(() => [] as string[]);
  const pending: PendingConcurrencyRequest[] = [];
  for (const name of names.filter((entry) => entry.endsWith(".json")).toSorted()) {
    const id = name.slice(0, -".json".length);
    const text = await readFile(concurrencyRequestPath(slot, id), "utf8").catch(() => undefined);
    if (text === undefined) continue;
    pending.push({ id, request: parseConcurrencyRequest(text) });
  }
  return pending;
}

/** Removes a request the host applied or rejected; `up` waits for exactly this. */
export async function finishConcurrencyRequest(slot: ServiceSlot, id: string): Promise<void> {
  await unlink(concurrencyRequestPath(slot, id)).catch(() => undefined);
}

/** Removes every waiting request. */
export async function clearConcurrencyRequests(slot: ServiceSlot): Promise<void> {
  for (const { id } of await pendingConcurrencyRequests(slot))
    await finishConcurrencyRequest(slot, id);
}

function parseConcurrencyRequest(text: string): ConcurrencyRequest | undefined {
  try {
    const value = JSON.parse(text) as Partial<ConcurrencyRequest>;
    if (
      typeof value.concurrency === "number" &&
      (value.source === "machine" || value.source === "file") &&
      typeof value.configuration === "string" &&
      typeof value.resolved === "object" &&
      value.resolved !== null
    )
      return {
        concurrency: value.concurrency,
        source: value.source,
        configuration: value.configuration,
        resolved: value.resolved,
      };
  } catch {
    // A torn or foreign file is not a request.
  }
  return undefined;
}

/** Moves a large log aside before a new process starts writing. */
export async function rotateLog(slot: ServiceSlot): Promise<void> {
  await mkdir(logDirectory(slot), { recursive: true, mode: 0o700 });
  const path = logPath(slot);
  const size = (await stat(path).catch(() => undefined))?.size ?? 0;
  if (size > LOG_ROTATE_BYTES) await rename(path, `${path}.1`);
}

/** The last lines of a service's log, for failure messages. */
export async function logTail(slot: ServiceSlot, lines = 40): Promise<string> {
  const text = await readFile(logPath(slot), "utf8").catch(() => "");
  return text
    .split("\n")
    .slice(-lines - 1)
    .join("\n")
    .trimEnd();
}

/**
 * The local Control Plane's URL, which commands use when no Control Plane is selected: the one it
 * reported while it runs, else where supertag.yaml in the state directory says it listens.
 */
export async function localControlPlaneUrl(): Promise<string> {
  const slot = controlPlaneSlot();
  const running = await runningProcess(slot).catch(() => ({}) as { pid?: number });
  if (running.pid !== undefined) {
    const status = await readStatus(slot);
    if (status?.url !== undefined) return status.url;
  }
  const file = await loadServicesFile().catch(() => undefined);
  const service = file === undefined ? undefined : controlPlaneOf(file);
  if (service !== undefined && service.ports.port !== 0) return defaultUrl(service.ports);
  return `http://127.0.0.1:${DEFAULT_CONTROL_PLANE_PORT}`;
}

/**
 * The operator credential named in the environment: SUPERTAG_OPERATOR_TOKEN, which holds an
 * Operator Token or the admin token, else SUPERTAG_ADMIN_TOKEN.
 */
export function environmentOperatorToken(): string | undefined {
  return (
    process.env["SUPERTAG_OPERATOR_TOKEN"]?.trim() ||
    process.env["SUPERTAG_ADMIN_TOKEN"]?.trim() ||
    undefined
  );
}

export function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
}
