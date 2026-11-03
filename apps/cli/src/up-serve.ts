import { readFile } from "node:fs/promises";
import { parseNotificationDestination } from "@supertag/control-plane";
import {
  inspectDatabaseMigrationReadiness,
  migrateDatabase,
  stateDirectory,
} from "@supertag/store";
import { RpcTelemetry } from "@supertag/worker-transport";
import { fileAuditSink } from "./audit-trail.js";
import { SUPERTAG_BUILD_IDENTITY } from "./build-identity.js";
import { environmentCoordinationOperatorCredentials } from "./control-plane-api.js";
import { ensureLocalAdminToken } from "./control-plane-client.js";
import { startControlPlaneRuntime, writeAuditEvent } from "./control-plane-runtime.js";
import { createCredentialVaultFromEnvironment } from "./credential-vault.js";
import { aborted, signalOnInterrupt } from "./local-process.js";
import {
  acquirePidFile,
  controlPlaneSlot,
  type ProcessStatus,
  type RunMode,
  writeStatus,
} from "./local-state.js";
import {
  CONTROL_PLANE_SETTING_VARIABLES,
  type ControlPlaneService,
  controlPlaneEnvironment,
  defaultUrl,
  readSecret,
  type ServicesFile,
  serviceFingerprint,
  serviceVariable,
  VAULT_VARIABLES,
} from "./supertag-yaml.js";
import { SUPERTAG_VERSION } from "./version.js";

export interface ServeOptions {
  readonly file: ServicesFile;
  readonly service: ControlPlaneService;
  readonly mode: RunMode;
  /** Stops the Control Plane when aborted; defaults to SIGINT and SIGTERM. */
  readonly signal?: AbortSignal;
  readonly write?: (text: string) => void;
  /** Called after the API starts listening, before the service reports ready. */
  readonly onReady?: (status: ProcessStatus) => Promise<void> | void;
}

export type ServeResult =
  | { readonly state: "stopped"; readonly status: ProcessStatus }
  | { readonly state: "already-running"; readonly pid: number };

/** A service's settings for status files, with secret names only. */
export function resolvedSummary(service: object): Record<string, unknown> {
  const summary = JSON.parse(JSON.stringify(service)) as Record<string, unknown>;
  const notify = summary["notify"];
  if (typeof notify === "string") summary["notify"] = parseNotificationDestination(notify).key;
  else if (Array.isArray(notify))
    summary["notify"] = notify.map((entry: unknown) =>
      typeof entry === "string" ? parseNotificationDestination(entry).key : entry,
    );
  return summary;
}

/** Text lines, or JSON lines with `logging.format: json`. */
export function logWriter(
  write: (text: string) => void,
  format: "text" | "json",
  service: string,
): (text: string) => void {
  if (format === "text") return write;
  return (text) => {
    for (const line of text.split("\n"))
      if (line)
        write(
          `${JSON.stringify({ time: new Date().toISOString(), level: "info", service, message: line })}\n`,
        );
  };
}

/**
 * Runs the local Control Plane of a control-plane service in this process until stopped, with
 * its state in `~/.supertag/control-plane/`. Background and unit modes run this same function with
 * output going to the log. Secret values are read here, when the service starts.
 */
export async function serveControlPlane(options: ServeOptions): Promise<ServeResult> {
  const { file, service } = options;
  const write = logWriter(
    options.write ?? ((text: string) => process.stdout.write(text)),
    service.logging.format,
    service.name,
  );
  const slot = controlPlaneSlot(service.name);
  const lock = await acquirePidFile(slot);
  if (lock.held !== undefined) {
    write(
      `The local Control Plane is already running (process ${lock.held}). Stop it with supertag down first.\n`,
    );
    return { state: "already-running", pid: lock.held };
  }
  const { signal: stop, dispose } =
    options.signal === undefined
      ? signalOnInterrupt()
      : { signal: options.signal, dispose: () => undefined };
  let failed = false;
  const cleanups: Array<() => Promise<void>> = [
    () => lock.release({ keepStatus: failed }),
    async () => dispose(),
  ];
  const cleanup = async () => {
    for (const task of cleanups.splice(0).reverse()) await task().catch(() => undefined);
  };
  let status: ProcessStatus = {
    pid: process.pid,
    mode: options.mode,
    state: "starting",
    startedAt: new Date().toISOString(),
    configuration: serviceFingerprint(file, service),
    version: SUPERTAG_VERSION,
    buildIdentity: SUPERTAG_BUILD_IDENTITY,
    kind: "control-plane",
    service: service.name,
    instance: file.name,
    resolved: resolvedSummary(service),
  };
  const update = async (next: Partial<ProcessStatus>) => {
    status = { ...status, ...next };
    await writeStatus(slot, status);
  };
  try {
    await update({});
    // A database password secret becomes PGPASSWORD unless the environment already sets it.
    if (service.database.password !== undefined && !process.env["PGPASSWORD"])
      process.env["PGPASSWORD"] = await readSecret(file, service.database.password);
    const databaseUrl = service.database.url;
    // A hosting platform migrates in its release step, and the Control Plane there refuses a
    // schema that is not current rather than migrating it at startup.
    if (!process.env["SUPERTAG_DEPLOYMENT_PLATFORM"]?.trim()) {
      const readiness = await inspectDatabaseMigrationReadiness({ url: databaseUrl });
      if (readiness.state !== "current") {
        await migrateDatabase({ url: databaseUrl });
        write("SuperTag database schema updated.\n");
      }
    }
    // Like settings, these come from the process environment, then env_file, so a service unit,
    // which does not inherit the shell's environment, can read them from ~/.supertag/.env.
    const variable = (name: string) => serviceVariable(file, name);
    const adminToken = variable("SUPERTAG_ADMIN_TOKEN") ?? (await ensureLocalAdminToken());
    // Settings the runtime reads from its environment come from the resolved service, which
    // already applied environment overrides.
    const environment: Record<string, string | undefined> = { ...process.env };
    for (const key of CONTROL_PLANE_SETTING_VARIABLES) delete environment[key];
    Object.assign(environment, controlPlaneEnvironment(service), {
      SUPERTAG_STATE_DIR: stateDirectory(),
    });
    for (const key of VAULT_VARIABLES) {
      const value = variable(key);
      if (value !== undefined) environment[key] = value;
    }
    const embedded = variable("SUPERTAG_WORKLET_TRANSPORT") === "embedded";
    const grpc = service.hosts.grpc;
    const tls =
      service.tls.cert !== undefined && service.tls.key !== undefined
        ? { cert: await readFile(service.tls.cert), key: await readFile(service.tls.key) }
        : undefined;
    // The database always records audit entries; logging.audit names one more sink.
    const audit =
      service.logging.audit === "stderr" ? writeAuditEvent : fileAuditSink(service.logging.audit);
    // A port chosen by the operating system has no URL to advertise until it listens.
    const coordinationUrl =
      service.ports.port === 0 && service.url === defaultUrl(service.ports)
        ? undefined
        : service.url;
    const runtime = await startControlPlaneRuntime({
      host: service.ports.host,
      port: service.ports.port,
      enableLocalAdmin: true,
      adminToken,
      databaseUrl,
      stateDirectory: stateDirectory(),
      credentialVault: createCredentialVaultFromEnvironment(environment),
      workletTransport: embedded ? "embedded" : "remote",
      ...(embedded || grpc === undefined
        ? {}
        : {
            workletGrpc: {
              host: grpc.host,
              port: grpc.port,
              ...(tls === undefined ? {} : { tls }),
            },
          }),
      ...(coordinationUrl === undefined ? {} : { coordinationUrl }),
      ...(service.notify !== undefined
        ? { operatorChannel: service.notify }
        : process.env["SUPERTAG_DEPLOYMENT_PLATFORM"] === undefined
          ? { operatorChannel: "desktop" }
          : {}),
      operatorNotificationSecrets: Object.fromEntries(
        await Promise.all(
          (typeof service.notify === "string" ? [service.notify] : (service.notify ?? []))
            .filter((entry) => entry.startsWith("webhook:"))
            .map((entry) => entry.slice(entry.lastIndexOf("#") + 1))
            .filter((name) => name !== "" && file.secrets[name] !== undefined)
            .map(async (name) => [name, await readSecret(file, name)] as const),
        ),
      ),
      coordinationOperatorCredentials: await environmentCoordinationOperatorCredentials(
        service.operators.file,
      ),
      audit,
      ...(service.logging.level === "trace"
        ? {
            rpcTelemetry: new RpcTelemetry({
              onEvent: (event) => {
                if (process.stderr.writableNeedDrain) throw new Error("RPC trace sink busy");
                process.stderr.write(`${JSON.stringify({ type: "supertag.rpc", ...event })}\n`);
              },
            }),
          }
        : {}),
    });
    cleanups.push(() => runtime.close());
    write(`SuperTag Control Plane listening at ${runtime.url}\n`);
    if (runtime.workletGrpcUrl !== undefined)
      write(`Worklet gRPC listening at ${runtime.workletGrpcUrl}\n`);
    await update({
      url: runtime.url,
      ...(runtime.workletGrpcUrl === undefined ? {} : { workletUrl: runtime.workletGrpcUrl }),
    });
    if (!stop.aborted) {
      await options.onReady?.(status);
      await update({ state: "ready" });
      if (options.mode === "foreground") write("Press Ctrl-C to stop.\n");
      await aborted(stop);
    }
    write("Stopping...\n");
    await cleanup();
    write("Stopped.\n");
    return { state: "stopped", status };
  } catch (error) {
    failed = true;
    await update({
      state: "failed",
      error: error instanceof Error ? error.message : String(error),
    }).catch(() => undefined);
    throw error;
  } finally {
    await cleanup();
  }
}
