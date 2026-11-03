import { parseArgs } from "node:util";
import { shellWord, uncertainAttemptRecoverCommand } from "@supertag/core";
import { SUPERTAG_BUILD_IDENTITY } from "./build-identity.js";
import { ControlPlaneClient, ensureLocalAdminToken } from "./control-plane-client.js";
import type { TagResource } from "./control-plane-resources.js";
import { lowDiskWarning, readHostDiskSpace } from "./disk-space.js";
import type { HostEnvironmentProvider } from "./host-environment.js";
import { storedHostCredential } from "./host-service.js";
import { describeMode, type LocalProcessOptions, optionalServiceManager } from "./local-process.js";
import {
  controlPlaneSlot,
  environmentOperatorToken,
  type ProcessStatus,
  readStatus,
  runningProcess,
  type UncertainAttemptStatus,
} from "./local-state.js";
import { takeOutputFlag } from "./output-flag.js";
import { type LaptopPower, laptopPowerWarning, readLaptopPower } from "./power.js";
import { hostStorageLines } from "./storage-durability.js";
import { controlPlaneOf, type ServiceConfig, type ServicesFile } from "./supertag-yaml.js";
import { terminalText } from "./terminal-text.js";
import { fileForState, type KnownService, knownServices } from "./up.js";
import { type UnitName, unitArguments, unitName } from "./up-service.js";
import { compareVersions, SUPERTAG_VERSION } from "./version.js";

/** One row of `supertag ps`. */
export interface ServiceRow {
  readonly service: string;
  readonly type: "control-plane" | "host";
  readonly state: "running" | "starting" | "unhealthy" | "stopped";
  /** Control Plane: where it listens. Host: the Control Plane it uses. */
  readonly address?: string;
  readonly pid?: number;
  readonly mode?: ProcessStatus["mode"];
  readonly version?: string;
  readonly buildIdentity?: string;
  readonly olderVersion?: boolean;
  /** The installed service unit's definition file. */
  readonly unit?: string;
  /** Whether supertag.yaml still names it. */
  readonly configured: boolean;
  readonly controlPlane?: string;
  readonly workerHostId?: string;
  readonly connected?: boolean;
  readonly tags?: readonly string[];
  readonly attempts?: number;
  /** Host: Task Attempts its journal holds as uncertain, each keeping a Worker slot. */
  readonly uncertainAttempts?: readonly UncertainAttemptStatus[];
  /** Host: Task Attempts each harness Worker runs at once, and whether supertag.yaml set it. */
  readonly concurrency?: { readonly value: number; readonly source: "file" | "machine" };
  /** Host: the remote sandbox provider supertag.yaml names in `environment`; absent is local. */
  readonly environment?: HostEnvironmentProvider;
  /** Host: joined with an ephemeral Auth Key, so Task files and artifacts on it are lost if it stops. */
  readonly ephemeral?: boolean;
  /** Host: the Volume supertag.yaml's `artifact-volume` keeps its artifacts on, outliving the host. */
  readonly artifactVolume?: string;
  /** Host: harnesses supertag.yaml lets run commands without an OS sandbox. */
  readonly allowUnsandboxedCommands?: readonly string[];
  /** Host: the OS command keeping the machine awake while Task Attempts run, when held. */
  readonly keepAwake?: { readonly tool: string; readonly since: string };
  /** Host running Task Attempts on a laptop that is on battery or sleeps when its lid closes. */
  readonly powerWarning?: string;
  readonly diskWarning?: string;
  readonly error?: string;
}

export async function runPsCommand(args: readonly string[]): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(psHelp());
    return 0;
  }
  const output = takeOutputFlag(args);
  const { values } = parseArgs({
    args: output.args,
    options: { file: { type: "string", short: "f", multiple: true } },
    strict: true,
  });
  const rows = await listServices({ files: values.file ?? [] });
  process.stdout.write(output.json ? `${JSON.stringify(rows, null, 2)}\n` : formatRows(rows));
  return 0;
}

/** The state of every service supertag.yaml names, and of any other service on this machine. */
export async function listServices(
  options: LocalProcessOptions & {
    readonly files?: readonly string[];
    /** Reads this machine's laptop power facts; tests replace it. */
    readonly power?: () => Promise<LaptopPower | undefined>;
  } = {},
): Promise<readonly ServiceRow[]> {
  const file = await fileForState({ files: options.files ?? [] });
  const known = await knownServices(file);
  const manager = optionalServiceManager(options);
  const tags = await tagsByHost();
  const rows: ServiceRow[] = [];
  for (const entry of known)
    rows.push(await row(entry, file, manager, tags, unitName(entry.instance, entry.slot.service)));
  const diskWarning = lowDiskWarning(await readHostDiskSpace().catch(() => undefined));
  if (diskWarning)
    for (let index = 0; index < rows.length; index++) {
      const item = rows[index];
      if (item?.type === "host" && item.pid !== undefined) rows[index] = { ...item, diskWarning };
    }
  if (!rows.some((item) => item.type === "host" && (item.attempts ?? 0) > 0)) return rows;
  const warning = laptopPowerWarning(await (options.power ?? readLaptopPower)());
  if (warning === undefined) return rows;
  return rows.map((item) =>
    item.type === "host" && (item.attempts ?? 0) > 0 ? { ...item, powerWarning: warning } : item,
  );
}

async function row(
  entry: KnownService,
  file: ServicesFile | undefined,
  manager: ReturnType<typeof optionalServiceManager>,
  tags: ReadonlyMap<string, readonly string[]> | undefined,
  unit: UnitName,
): Promise<ServiceRow> {
  const { slot, service } = entry;
  const running = await runningProcess(slot);
  const status = running.pid === undefined ? undefined : await readStatus(slot);
  const installed =
    manager !== undefined && (await manager.runs(unit, unitArguments(slot.service)));
  const state: ServiceRow["state"] =
    running.pid === undefined
      ? "stopped"
      : status?.state === "failed" ||
          (slot.kind === "host" && status?.state === "ready" && status.connected === false)
        ? "unhealthy"
        : status?.state === "ready"
          ? "running"
          : "starting";
  const base = {
    service: slot.service,
    type: slot.kind,
    state,
    configured: service !== undefined,
    ...(running.pid === undefined ? {} : { pid: running.pid }),
    ...(status?.mode === undefined || running.pid === undefined ? {} : { mode: status.mode }),
    ...(running.pid === undefined || status?.buildIdentity === undefined
      ? {}
      : { buildIdentity: status.buildIdentity }),
    ...(running.pid === undefined
      ? {}
      : status?.version === undefined
        ? { olderVersion: true }
        : {
            version: status.version,
            ...(compareVersions(status.version, SUPERTAG_VERSION) === -1
              ? { olderVersion: true }
              : {}),
          }),
    ...(installed && manager !== undefined ? { unit: manager.path(unit) } : {}),
    ...(status?.error === undefined || running.pid === undefined ? {} : { error: status.error }),
  };
  if (slot.kind === "control-plane") {
    const configured = service?.type === "control-plane" ? service.url : undefined;
    const address = status?.url ?? configured;
    return { ...base, ...(address === undefined ? {} : { address }) };
  }
  const controlPlane =
    status?.url ??
    (service?.type === "host"
      ? "url" in service.controlPlane
        ? service.controlPlane.url
        : (file === undefined ? undefined : controlPlaneOf(file))?.url
      : undefined);
  const stored = await storedHostCredential(slot.service);
  const workerHostId = status?.workerHostId ?? stored?.workerHostId;
  const served =
    workerHostId === undefined || tags === undefined ? undefined : (tags.get(workerHostId) ?? []);
  return {
    ...base,
    ...(controlPlane === undefined ? {} : { address: controlPlane, controlPlane }),
    ...(workerHostId === undefined ? {} : { workerHostId }),
    ...hostConcurrency(running.pid === undefined ? undefined : status, service),
    ...(service?.type === "host" && service.environment !== undefined
      ? { environment: service.environment.provider }
      : {}),
    ...(stored?.ephemeral === true && stored.workerHostId === workerHostId
      ? { ephemeral: true }
      : {}),
    ...(service?.type === "host" && service.artifactVolume !== undefined
      ? { artifactVolume: service.artifactVolume }
      : {}),
    ...(service?.type === "host" && service.allowUnsandboxedCommands.length > 0
      ? { allowUnsandboxedCommands: service.allowUnsandboxedCommands }
      : {}),
    ...(running.pid === undefined || status?.connected === undefined
      ? {}
      : { connected: status.connected }),
    ...(served === undefined ? {} : { tags: served }),
    ...(running.pid === undefined ? {} : { attempts: status?.attempts?.length ?? 0 }),
    ...(running.pid === undefined || !status?.uncertainAttempts?.length
      ? {}
      : { uncertainAttempts: status.uncertainAttempts }),
    ...(running.pid === undefined || status?.keepAwake === undefined
      ? {}
      : { keepAwake: status.keepAwake }),
  };
}

/** A running host's applied concurrency from its status; otherwise the file's proposed value. */
export function hostConcurrency(
  status: Pick<ProcessStatus, "concurrency"> | undefined,
  service: ServiceConfig | undefined,
): Pick<ServiceRow, "concurrency"> {
  if (status?.concurrency !== undefined) return { concurrency: status.concurrency };
  return service?.type === "host"
    ? { concurrency: { value: service.concurrency, source: service.concurrencySource } }
    : {};
}

/** Tags by Worker Host on the local Control Plane, when it runs; undefined otherwise. */
async function tagsByHost(): Promise<ReadonlyMap<string, readonly string[]> | undefined> {
  const slot = controlPlaneSlot();
  if ((await runningProcess(slot)).pid === undefined) return undefined;
  const url = (await readStatus(slot))?.url;
  if (url === undefined) return undefined;
  try {
    const token = environmentOperatorToken() || (await ensureLocalAdminToken());
    const list = await new ControlPlaneClient({ url, token }).request<{
      readonly items: readonly TagResource[];
    }>("/api/v1/tags");
    const byHost = new Map<string, string[]>();
    for (const tag of list.items)
      for (const host of tag.spec.workerHosts ?? []) {
        const names = byHost.get(host) ?? [];
        names.push(tag.metadata.name ?? tag.metadata.id ?? "");
        byHost.set(host, names);
      }
    return byHost;
  } catch {
    return undefined;
  }
}

export function formatRows(rows: readonly ServiceRow[]): string {
  if (rows.length === 0) return "No services.\n";
  const table = rows.map((item) =>
    [
      item.service,
      item.environment === undefined ? item.type : `${item.type} (${item.environment})`,
      item.state,
      item.address ?? "-",
      item.pid === undefined
        ? item.unit === undefined
          ? "-"
          : `unit ${item.unit}`
        : `${item.pid} ${describeMode(item.mode)}`,
    ].map(terminalText),
  );
  const header = ["SERVICE", "TYPE", "STATE", "ADDRESS", "PROCESS"];
  const widths = header.map((title, index) =>
    Math.max(title.length, ...table.map((cells) => (cells[index] ?? "").length)),
  );
  const line = (cells: readonly string[]) =>
    `${cells.map((cell, index) => (index === cells.length - 1 ? cell : cell.padEnd(widths[index] ?? 0))).join("  ")}\n`;
  let text = line(header);
  rows.forEach((item, index) => {
    text += line(table[index] ?? []);
    const details: string[] = [];
    if (item.type === "host" && item.workerHostId !== undefined) {
      details.push(`Worker Host ${item.workerHostId}`);
      if (item.connected !== undefined) details.push(item.connected ? "connected" : "disconnected");
      if (item.tags !== undefined)
        details.push(item.tags.length > 0 ? `Tags ${item.tags.join(", ")}` : "no Tags");
      if (item.attempts !== undefined) details.push(`Task Attempts running: ${item.attempts}`);
      if (item.uncertainAttempts?.length)
        details.push(`Task Attempts uncertain: ${item.uncertainAttempts.length}`);
    }
    if (item.type === "host" && item.concurrency !== undefined)
      details.push(
        `concurrency ${item.concurrency.value} per harness (${item.concurrency.source === "file" ? "from supertag.yaml" : "from this machine"})`,
      );
    if (item.type === "host" && item.allowUnsandboxedCommands !== undefined)
      details.push(`runs commands unsandboxed: ${item.allowUnsandboxedCommands.join(", ")}`);
    if (item.type === "host" && item.workerHostId !== undefined) {
      if (item.keepAwake !== undefined)
        details.push(
          `keeping the machine awake (${item.keepAwake.tool}) since ${item.keepAwake.since}`,
        );
    }
    if (item.pid !== undefined && item.unit !== undefined) details.push(`unit ${item.unit}`);
    if (item.pid !== undefined)
      details.push(
        `build ${item.buildIdentity ?? "unknown"}${item.buildIdentity !== undefined && item.buildIdentity !== SUPERTAG_BUILD_IDENTITY ? " (differs from CLI)" : ""}`,
      );
    if (item.olderVersion)
      details.push(
        `SuperTag ${item.version ?? "version unknown"} (older than CLI ${SUPERTAG_VERSION})`,
      );
    if (!item.configured)
      details.push(
        item.type === "host"
          ? `not in supertag.yaml; remove it with supertag down ${item.service}`
          : "not in supertag.yaml",
      );
    if (item.error !== undefined) details.push(`error: ${item.error}`);
    if (details.length > 0) text += `  ${details.map(terminalText).join("; ")}\n`;
    if (item.type === "host")
      for (const line of hostStorageLines({
        ephemeral: item.ephemeral === true,
        sandbox: item.environment,
        artifactVolume: item.artifactVolume,
      }))
        text += `  ${line}\n`;
    if (item.powerWarning !== undefined) text += `  ${terminalText(item.powerWarning)}\n`;
    if (item.diskWarning !== undefined) text += `  ${terminalText(item.diskWarning)}\n`;
    text += uncertainAttemptLines(item);
  });
  return text;
}

/**
 * Each uncertain Task Attempt of a host, with how to recover it: the Attempt may have executed,
 * so it is never replayed, and it keeps a Worker slot until an operator confirms it stopped.
 */
function uncertainAttemptLines(item: ServiceRow): string {
  const safe = (text: string) => terminalText(text).trim();
  let text = "";
  for (const attempt of item.uncertainAttempts ?? []) {
    text += `  Uncertain: Task ${safe(attempt.taskId)} Attempt ${safe(attempt.attemptId)} may have executed and keeps a Worker slot${attempt.reason ? ` (${safe(attempt.reason)})` : ""}.\n`;
    text += `    Stop the host service first: supertag down ${terminalText(shellWord(item.service))}\n`;
    text += `    After confirming its execution stopped: ${terminalText(uncertainAttemptRecoverCommand(attempt.taskId, attempt))}\n`;
    text += `    Then start it again: supertag up ${terminalText(shellWord(item.service))}\n`;
  }
  return text;
}

export function psHelp(): string {
  return `Usage: supertag ps [-f PATH...] [--output text|json]

Lists this machine's services: each service supertag.yaml names, and any other service with
state in ~/.supertag/. For each: its name, type (a host with an environment shows its provider,
such as host (e2b)), state (running, starting, unhealthy, or stopped), address, and process or
service unit. Host services also show their Control Plane, Worker Host
ID, whether they are connected, the Tags they serve (from the local Control Plane), how many
Task Attempts they are running, how many each harness may run at once and whether that came from
supertag.yaml or this machine, which harnesses run commands without a sandbox
(allow-unsandboxed-commands), and whether they are keeping the machine awake for them. A host
whose storage is ephemeral says so: one that joined with an ephemeral Auth Key loses its Task
files and artifacts if it stops, and a remote sandbox loses its Task files when it stops. While
Task Attempts run on a laptop, a warning says when it is on battery or sleeps when its lid closes.
A running host warns when its temporary filesystem has less free space than the smaller of
10 GiB and 5% of its volume.
A host also lists each uncertain Task Attempt: one that may have executed, so it is never replayed,
and that keeps a Worker slot until you stop the host service, confirm its execution stopped, and
run the supertag recover worklet command shown.
Each running service's build identity appears below its row and in JSON output. An older running
SuperTag version also appears below its row and in JSON output.

  -f, --file PATH        supertag.yaml, or a directory that holds one; repeat to merge files
  --output text|json     Output format (default: text)
`;
}
