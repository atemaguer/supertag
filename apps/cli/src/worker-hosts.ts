import { randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  readdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { stateDirectory as defaultStateDirectory } from "@supertag/store";
import type { ControlPlaneClient } from "./control-plane-client.js";
import { workerHostCredentialView, workerHostView } from "./host-protos.js";
import { hostClient } from "./operator-client.js";
import { takeOutputFlag } from "./output-flag.js";
import { refusedAsError } from "./tag-conversation.js";

export type WorkerHostCommand = "drain" | "enroll" | "resume" | "revoke" | "rotate-credential";
export type WorkerHostControlPlaneCommand = WorkerHostCommand;

export function isWorkerHostCommand(value: string | undefined): value is WorkerHostCommand {
  return (
    value === "drain" ||
    value === "enroll" ||
    value === "resume" ||
    value === "revoke" ||
    value === "rotate-credential"
  );
}

export async function runWorkerHostOperation(
  client: Pick<ControlPlaneClient, "operator">,
  command: WorkerHostControlPlaneCommand,
  args: readonly string[],
): Promise<string> {
  const hosts = hostClient(client.operator);
  if (command === "enroll" || command === "rotate-credential") {
    const { values, positionals } = parseArgs({
      args,
      allowPositionals: true,
      options: { out: { type: "string" } },
      strict: true,
    });
    const id = positionals[0]?.trim();
    if (positionals.length !== 1 || !id || !values.out) {
      throw new Error(
        `Usage: supertag ${command === "enroll" ? "enroll worker-host" : "rotate worker-host-credential"} ID --out PATH`,
      );
    }
    const issuance = workerHostCredentialView(
      await refusedAsError(async () =>
        command === "enroll"
          ? hosts.enrollWorkerHost({ id })
          : hosts.rotateWorkerHostCredential({
              id,
              expectedCredentialRevision: (await hosts.getWorkerHost({ id })).credentialRevision,
            }),
      ),
    );
    if (issuance.metadata.workerHostId !== id || !issuance.credential.token) {
      throw new Error("Control Plane returned an invalid Worker Host credential");
    }
    const path = await writeWorkerHostCredential(values.out, {
      version: 1,
      workerHostId: id,
      token: issuance.credential.token,
    });
    return `${command === "enroll" ? "Enrolled" : "Rotated credential for"} Worker Host ${id}.\nCredential written to ${path} with mode 0600.\nGive its token to the custom Worker on that host through its secret manager.\n`;
  }

  const { json, args: rest } =
    command === "drain" || command === "resume" ? takeOutputFlag(args) : { json: false, args };
  const id = rest[0]?.trim();
  if (rest.length !== 1 || !id) throw new Error(`Usage: supertag ${command} worker-host ID`);
  if (command === "revoke") {
    await refusedAsError(() => hosts.revokeWorkerHostCredential({ id }));
    return `Revoked Worker Host ${id}.\n`;
  }
  const resource = workerHostView(
    await refusedAsError(() =>
      command === "drain" ? hosts.drainWorkerHost({ id }) : hosts.resumeWorkerHost({ id }),
    ),
  );
  if (json) return `${JSON.stringify(resource, null, 2)}\n`;
  return command === "drain"
    ? `worker-host/${id} draining: it finishes accepted work and takes no new Tasks.\n`
    : `worker-host/${id} resumed: it takes new Tasks again.\n`;
}

/**
 * A Worker Host credential this machine stores, and its file: `worker-hosts/ID.credential.json`
 * from `connect worklet`, or a host service's `hosts/SERVICE/credential.json`.
 */
async function findOwnWorkerHostCredential(
  workerHostId: string,
  stateDirectory: string,
): Promise<
  | {
      readonly credential: StoredWorkerHostCredential;
      readonly path: string;
      readonly service?: string;
    }
  | undefined
> {
  const stored = await readStoredWorkerHostCredential(workerHostId, stateDirectory).catch(
    () => undefined,
  );
  if (stored?.controlPlane !== undefined)
    return { credential: stored, path: workerHostCredentialPath(workerHostId, stateDirectory) };
  const hosts = resolve(stateDirectory, "hosts");
  const services = await readdir(hosts, { withFileTypes: true }).catch(() => []);
  for (const entry of services.toSorted((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue;
    const path = resolve(hosts, entry.name, "credential.json");
    const credential = await readWorkerHostCredential(path).catch(() => undefined);
    if (credential?.workerHostId === workerHostId && credential.controlPlane !== undefined)
      return { credential, path, service: entry.name };
  }
  return undefined;
}

/**
 * Revokes this machine's own Worker Host credential with that credential, for hosts without
 * operator access. The credential comes from `worker-hosts/` or a host service's directory under
 * `hosts/`, and its file is removed afterward.
 */
export async function revokeOwnWorkerHostCredential(
  args: readonly string[],
  request: typeof fetch = fetch,
  stateDirectory = defaultStateDirectory(),
): Promise<string> {
  const id = args[0]?.trim();
  if (args.length !== 1 || !id) throw new Error("Usage: supertag revoke worker-host-credential ID");
  const found = await findOwnWorkerHostCredential(id, stateDirectory);
  const stored = found?.credential;
  if (found === undefined || stored?.controlPlane === undefined)
    throw new Error(
      `No operator credentials are available, and no joined credential for Worker Host ${id} is stored on this machine. Run: supertag connect control-plane URL`,
    );
  const response = await request(
    new URL(`/api/v1/worker-hosts/${encodeURIComponent(id)}/credential`, `${stored.controlPlane}/`),
    {
      method: "DELETE",
      headers: { authorization: `Bearer ${stored.token}` },
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    },
  );
  if (!response.ok && response.status !== 401) {
    const body = (await response.json().catch(() => undefined)) as
      | { message?: unknown }
      | undefined;
    throw new Error(
      typeof body?.message === "string"
        ? body.message
        : `Control Plane returned HTTP ${response.status}`,
    );
  }
  if (response.status === 401)
    throw new Error(`The stored credential for Worker Host ${id} is no longer accepted`);
  await unlink(found.path).catch(() => undefined);
  if (found.service !== undefined)
    return `Revoked Worker Host ${id} with its own credential and removed ${found.path}. Host service ${found.service} can no longer connect; stop it with supertag down ${found.service}.\n`;
  return `Revoked Worker Host ${id} with its own credential and removed the stored credential.\n`;
}

/** A Worker Host credential file. `controlPlane` names the Control Plane it joined, if known. */
export interface StoredWorkerHostCredential {
  readonly workerHostId: string;
  readonly token: string;
  readonly controlPlane?: string;
  /** The host joined with an ephemeral Auth Key, so its storage is ephemeral. */
  readonly ephemeral?: boolean;
}

/** Stores a host credential where `connect worklet` finds it for the same Control Plane. */
export async function storeWorkerHostCredential(
  credential: StoredWorkerHostCredential,
  stateDirectory = defaultStateDirectory(),
): Promise<string> {
  const path = workerHostCredentialPath(credential.workerHostId, stateDirectory);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await chmod(dirname(path), 0o700);
  return writeWorkerHostCredential(path, {
    version: 1,
    workerHostId: credential.workerHostId,
    token: credential.token,
    ...(credential.controlPlane === undefined ? {} : { controlPlane: credential.controlPlane }),
    ...(credential.ephemeral === true ? { ephemeral: true as const } : {}),
  });
}

/** Stored credentials recorded for one Control Plane URL. Files without one are skipped. */
export async function findStoredWorkerHostCredentials(
  controlPlane: string,
  stateDirectory = defaultStateDirectory(),
): Promise<readonly StoredWorkerHostCredential[]> {
  return (await listStoredWorkerHostCredentials(stateDirectory)).filter(
    (credential) => credential.controlPlane === controlPlane,
  );
}

/** Every readable stored host credential in a state directory. */
export async function listStoredWorkerHostCredentials(
  stateDirectory = defaultStateDirectory(),
): Promise<readonly StoredWorkerHostCredential[]> {
  const directory = resolve(stateDirectory, "worker-hosts");
  const names = await readdir(directory).catch(() => [] as string[]);
  const found: StoredWorkerHostCredential[] = [];
  for (const name of names.sort()) {
    if (!name.endsWith(".credential.json")) continue;
    const credential = await readWorkerHostCredential(resolve(directory, name)).catch(
      () => undefined,
    );
    if (credential !== undefined) found.push(credential);
  }
  return found;
}

/** Reads the stored credential of one host, or undefined when none is stored. */
export async function readStoredWorkerHostCredential(
  workerHostId: string,
  stateDirectory = defaultStateDirectory(),
): Promise<StoredWorkerHostCredential | undefined> {
  const path = workerHostCredentialPath(workerHostId, stateDirectory);
  if ((await lstat(path).catch(() => undefined)) === undefined) return undefined;
  return readWorkerHostCredential(path);
}

export async function readWorkerHostCredential(
  requestedPath: string,
): Promise<StoredWorkerHostCredential> {
  const path = resolve(requestedPath);
  const metadata = await lstat(path).catch(() => undefined);
  if (
    metadata === undefined ||
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.size > 64 * 1024 ||
    (process.platform !== "win32" && (metadata.mode & 0o077) !== 0)
  ) {
    throw new Error("Worker Host credential must be a private regular file");
  }
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error("Worker Host credential file must contain valid JSON", { cause: error });
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Worker Host credential file has an unsupported format");
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).some(
      (key) => !["version", "workerHostId", "token", "controlPlane", "ephemeral"].includes(key),
    ) ||
    record["version"] !== 1 ||
    typeof record["workerHostId"] !== "string" ||
    !record["workerHostId"].trim() ||
    typeof record["token"] !== "string" ||
    !record["token"].trim() ||
    (record["controlPlane"] !== undefined && typeof record["controlPlane"] !== "string") ||
    (record["ephemeral"] !== undefined && record["ephemeral"] !== true)
  ) {
    throw new Error("Worker Host credential file has an unsupported format");
  }
  return {
    workerHostId: record["workerHostId"].trim(),
    token: record["token"].trim(),
    ...(typeof record["controlPlane"] === "string" ? { controlPlane: record["controlPlane"] } : {}),
    ...(record["ephemeral"] === true ? { ephemeral: true } : {}),
  };
}

export async function writeWorkerHostCredential(
  requestedPath: string,
  credential: {
    readonly version: 1;
    readonly workerHostId: string;
    readonly token: string;
    readonly controlPlane?: string;
    readonly ephemeral?: true;
  },
): Promise<string> {
  const path = resolve(requestedPath);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await chmod(dirname(path), 0o700);
  const temporaryPath = resolve(dirname(path), `.${randomUUID()}.tmp`);
  try {
    await writeFile(temporaryPath, `${JSON.stringify(credential, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, path);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
  return path;
}

export function workerHostCredentialPath(
  workerHostId: string,
  stateDirectory = defaultStateDirectory(),
): string {
  const id = workerHostId.trim();
  if (!id) throw new Error("Worker Host ID must not be empty");
  return resolve(stateDirectory, "worker-hosts", `${encodeURIComponent(id)}.credential.json`);
}

export function workerHostOperationHelp(): string {
  return `Usage:
  supertag list worker-host
  supertag describe worker-host ID
  supertag rotate worker-host-credential ID --out PATH
  supertag revoke worker-host-credential ID
  supertag drain worker-host ID
  supertag resume worker-host ID

  supertag enroll worker-host ID --out PATH

Join a machine that runs built-in Workers with an Auth Key:
  supertag create auth-key NAME --tag TAG
  supertag connect worklet --worklet-url URL --auth-key stak_...

Enrollment and rotation write the bearer credential once to a required mode-0600 output file,
for a custom Worker that reads it from its own secret manager. A Worker Host without operator
credentials may revoke its own credential; the command then uses the stored one.
`;
}
