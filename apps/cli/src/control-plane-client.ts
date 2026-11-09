import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { ConnectError } from "@connectrpc/connect";
import { confirm, password } from "@inquirer/prompts";
import type { CredentialValue } from "@supertag/core";
import { ControlPlanePhase, type GetStatusResponse } from "@supertag/operator-api";
import { FileCredentialStore, stateDirectory } from "@supertag/store";
import type { VerifiedSurfaceAccount } from "@supertag/surface-sdk";
import { stringify as stringifyYaml } from "yaml";
import {
  CONTROL_PLANE_API_VERSION,
  type ControlPlaneResourceList,
  type SurfaceAccountResource,
  type TagOperationResource,
  type TagResource,
} from "./control-plane-resources.js";
import {
  environmentOperatorToken,
  localControlPlaneUrl as localUpControlPlaneUrl,
} from "./local-state.js";
import {
  OPERATOR_API_VERSION,
  operatorErrorMessage,
  organizationClient,
} from "./operator-client.js";
import type { TagCommand } from "./tags.js";
import {
  CLIENT_VERSION_HEADER,
  SUPERTAG_VERSION,
  VERSION_HEADER,
  versionMismatchHint,
  warnOnVersionSkew,
} from "./version.js";

const DEFAULT_CONTROL_PLANE_NAME = "default";
const CONFIG_VERSION = 1;
const LOCAL_ADMIN_CREDENTIAL = "control-plane/local-admin";
const FILE_OPERATOR_CREDENTIAL_PROVIDER = "file";

interface StoredControlPlane {
  readonly url: string;
}

interface StoredCredential {
  readonly provider: string;
  readonly credentialId: string;
}

interface StoredConnection {
  readonly controlPlane: string;
  readonly credential: string;
}

interface ControlPlaneConfiguration {
  readonly version: 1;
  readonly activeConnection: string | null;
  readonly controlPlanes: Readonly<Record<string, StoredControlPlane>>;
  readonly credentials: Readonly<Record<string, StoredCredential>>;
  readonly connections: Readonly<Record<string, StoredConnection>>;
}

/** Client-side credentials are separate from the Gateway's surface credential vault. */
export interface OperatorCredentialProvider {
  readonly id: string;
  store(credentialId: string, value: CredentialValue): Promise<void>;
  resolve(credentialId: string): Promise<CredentialValue | undefined>;
  delete(credentialId: string): Promise<void>;
}

export type OperatorCredentialProviderFactory = () => OperatorCredentialProvider;

const operatorCredentialProviderFactories = new Map<string, OperatorCredentialProviderFactory>();

/** Allows an embedding CLI distribution to install keychain, OIDC, or hosted providers. */
export function registerOperatorCredentialProvider(
  providerId: string,
  factory: OperatorCredentialProviderFactory,
): void {
  const normalized = providerId.trim();
  if (!/^[a-z][a-z0-9-]{1,62}$/u.test(normalized)) {
    throw new Error("Operator credential provider ID contains unsupported characters");
  }
  if (operatorCredentialProviderFactories.has(normalized)) {
    throw new Error(
      `Operator credential provider ${JSON.stringify(normalized)} is already installed`,
    );
  }
  operatorCredentialProviderFactories.set(normalized, factory);
}

export class FileOperatorCredentialProvider implements OperatorCredentialProvider {
  readonly id = FILE_OPERATOR_CREDENTIAL_PROVIDER;
  readonly #store: FileCredentialStore;

  constructor(path = resolve(stateDirectory(), "credentials.json")) {
    this.#store = new FileCredentialStore("operator", path);
  }

  store(credentialId: string, value: CredentialValue): Promise<void> {
    return this.#store.store(credentialId, value);
  }

  resolve(credentialId: string): Promise<CredentialValue | undefined> {
    return this.#store.resolve(credentialId);
  }

  delete(credentialId: string): Promise<void> {
    return this.#store.delete(credentialId);
  }
}

registerOperatorCredentialProvider(
  FILE_OPERATOR_CREDENTIAL_PROVIDER,
  () => new FileOperatorCredentialProvider(),
);

export interface ControlPlaneTarget {
  readonly name?: string;
  readonly url: string;
  readonly token: string;
}

export type ControlPlaneManagementCommand =
  | "connect"
  | "current"
  | "list"
  | "remove"
  | "status"
  | "use";

export function isControlPlaneManagementCommand(
  value: string | undefined,
): value is ControlPlaneManagementCommand {
  return (
    value === "connect" ||
    value === "current" ||
    value === "list" ||
    value === "remove" ||
    value === "status" ||
    value === "use"
  );
}

/** A Control Plane API refusal; `status` is the HTTP status, such as 409 for a stale revision. */
export class ControlPlaneRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** The SuperTag-Version the Control Plane reported, if any. */
    readonly controlPlaneVersion?: string,
  ) {
    super(message);
    this.name = "ControlPlaneRequestError";
  }
}

export class ControlPlaneClient {
  readonly #target: ControlPlaneTarget;

  constructor(target: ControlPlaneTarget) {
    this.#target = target;
  }

  /** The Control Plane URL this client talks to. */
  get url(): string {
    return this.#target.url;
  }

  async status(): Promise<GetStatusResponse> {
    try {
      return await organizationClient({
        url: this.#target.url,
        token: this.#target.token,
        warnOnSkew: true,
      }).getStatus({});
    } catch (error) {
      if (error instanceof ConnectError) throw new Error(operatorErrorMessage(error));
      throw error;
    }
  }

  async setupSurface(verified: VerifiedSurfaceAccount): Promise<SurfaceAccountResource> {
    return this.#request<SurfaceAccountResource>("/api/v1/surface-enrollments", {
      method: "POST",
      body: JSON.stringify({
        apiVersion: CONTROL_PLANE_API_VERSION,
        kind: "SurfaceEnrollment",
        metadata: { id: randomUUID() },
        spec: verified,
      }),
    });
  }

  async listTags(): Promise<ControlPlaneResourceList<TagResource>> {
    return this.#request<ControlPlaneResourceList<TagResource>>("/api/v1/tags", {
      method: "GET",
    });
  }

  async getTag(name: string): Promise<TagResource> {
    return this.#request<TagResource>(`/api/v1/tags/${encodeURIComponent(name)}`, {
      method: "GET",
    });
  }

  async runTagCommand(command: TagCommand, args: readonly string[]): Promise<string> {
    if (command === "create") {
      const resource = await this.createTag(parseCreateTagArgs(args));
      const bindingGuidance = resource.spec.workerHosts.length
        ? ""
        : ` Bind a Worker Host before it can run Tasks: supertag update tag ${resource.metadata.name} --add-worker-host HOST.`;
      return `Created Tag ${resource.metadata.name} (${resource.metadata.id}).${bindingGuidance}\n`;
    }
    if (command === "bind-worker-host" || command === "unbind-worker-host") {
      const { name, workerHostId } = parseTagWorkerHostArgs(command, args);
      const resource = await this.#request<TagResource>(
        `/api/v1/tags/${encodeURIComponent(name)}/worker-hosts/${encodeURIComponent(workerHostId)}`,
        { method: command === "bind-worker-host" ? "PUT" : "DELETE" },
      );
      return `${command === "bind-worker-host" ? "Bound" : "Unbound"} Worker Host ${workerHostId} ${command === "bind-worker-host" ? "to" : "from"} Tag ${resource.metadata.name}.\n`;
    }
    const result = await this.#request<TagOperationResource>("/api/v1/tag-operations", {
      method: "POST",
      body: JSON.stringify({
        apiVersion: CONTROL_PLANE_API_VERSION,
        kind: "TagOperation",
        metadata: { id: randomUUID() },
        spec: { command, args },
      }),
    });
    return result.status.output;
  }

  async createTag(input: {
    readonly name: string;
    readonly workerHosts?: readonly string[];
  }): Promise<TagResource> {
    // An imperative write: listed fields replace, the rest stay, and changes belong to `cli`.
    return this.#request<TagResource>("/api/v1/tags?fieldManager=cli", {
      method: "POST",
      body: JSON.stringify({
        apiVersion: CONTROL_PLANE_API_VERSION,
        kind: "Tag",
        metadata: { name: input.name },
        spec: { workerHosts: input.workerHosts },
      }),
    });
  }

  request<T>(pathname: string, init: RequestInit = { method: "GET" }): Promise<T> {
    return this.#request<T>(pathname, init);
  }

  async #response(pathname: string, init: RequestInit): Promise<Response> {
    const url = new URL(pathname, `${this.#target.url}/`);
    if (url.origin !== new URL(this.#target.url).origin || url.username || url.password)
      throw new Error("Control Plane requests must stay on the configured origin");
    const response = await fetch(url, {
      ...init,
      signal: init.signal ?? AbortSignal.timeout(30_000),
      redirect: "error",
      headers: {
        authorization: `Bearer ${this.#target.token}`,
        "content-type": "application/json",
        [CLIENT_VERSION_HEADER]: SUPERTAG_VERSION,
        ...init.headers,
      },
    });
    const controlPlaneVersion = response.headers.get(VERSION_HEADER)?.trim() || undefined;
    warnOnVersionSkew(controlPlaneVersion);
    if (!response.ok) {
      const body = await response.json().catch(() => undefined);
      const message =
        isRecord(body) && typeof body["message"] === "string"
          ? body["message"]
          : // Coordination routes report a sentence in `error`; others use a short code there.
            isRecord(body) && typeof body["error"] === "string" && /\s/u.test(body["error"])
            ? body["error"]
            : `Control Plane returned HTTP ${response.status}`;
      // An older Control Plane rejects fields and routes it does not know with a bare 400 or 404.
      const hint = mayBeUnsupportedRequest(response.status, body)
        ? versionMismatchHint(SUPERTAG_VERSION, controlPlaneVersion)
        : undefined;
      throw new ControlPlaneRequestError(
        hint === undefined ? message : `${message}\n${hint}`,
        response.status,
        controlPlaneVersion,
      );
    }
    return response;
  }

  async #request<T>(pathname: string, init: RequestInit): Promise<T> {
    return (await this.#response(pathname, init)).json().catch(() => undefined) as Promise<T>;
  }
}

/**
 * Whether a refusal looks like one an older Control Plane gives for a field or route it does not
 * know: any 400, a 405, or a 404 that names no missing resource.
 */
function mayBeUnsupportedRequest(status: number, body: unknown): boolean {
  if (status === 400 || status === 405) return true;
  if (status !== 404) return false;
  const message = isRecord(body) && typeof body["message"] === "string" ? body["message"] : "";
  return message === "" || /route not found|unknown .*command/iu.test(message);
}

function parseCreateTagArgs(args: readonly string[]): {
  readonly name: string;
  readonly workerHosts: readonly string[];
} {
  const { positionals, values } = parseArgs({
    args,
    allowPositionals: true,
    options: { "worker-host": { type: "string", multiple: true } },
    strict: true,
  });
  if (positionals.length !== 1)
    throw new Error("Usage: supertag create tag NAME [--worker-host HOST ...]");
  return {
    name: required(positionals[0], "Tag name"),
    workerHosts: (values["worker-host"] ?? []).map((value) => required(value, "Worker Host ID")),
  };
}

function parseTagWorkerHostArgs(
  command: "bind-worker-host" | "unbind-worker-host",
  args: readonly string[],
): { readonly name: string; readonly workerHostId: string } {
  const { positionals } = parseArgs({ args, allowPositionals: true, options: {}, strict: true });
  if (positionals.length !== 2) {
    throw new Error(
      `Usage: supertag update tag NAME --${command === "bind-worker-host" ? "add" : "remove"}-worker-host HOST`,
    );
  }
  return {
    name: required(positionals[0], "Tag name"),
    workerHostId: required(positionals[1], "Worker Host ID"),
  };
}

export async function runControlPlaneManagementCommand(
  command: ControlPlaneManagementCommand,
  args: readonly string[],
): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(controlPlaneManagementHelp(command));
    return;
  }
  if (command === "connect") {
    await connectControlPlane(args);
    return;
  }
  if (command === "list") {
    await listControlPlanes(args);
    return;
  }
  if (command === "current") {
    await currentControlPlane(args);
    return;
  }
  if (command === "use") {
    await useControlPlane(args);
    return;
  }
  if (command === "remove") {
    await removeControlPlane(args);
    return;
  }
  await statusControlPlane(args);
}

/**
 * The Control Plane commands use: the one `--control-plane`, SUPERTAG_CONTROL_PLANE, or the saved
 * active connection names, else this machine's local Control Plane with the machine-wide local
 * operator credential. SUPERTAG_OPERATOR_TOKEN or SUPERTAG_ADMIN_TOKEN replaces the token.
 */
export async function resolveControlPlaneTarget(
  override?: string,
): Promise<ControlPlaneTarget | undefined> {
  return resolveSavedControlPlaneTarget(override);
}

/** The Control Plane a selection or the saved active connection names. */
export async function resolveSavedControlPlaneTarget(
  override?: string,
): Promise<ControlPlaneTarget | undefined> {
  const configured = await readControlPlaneConfiguration();
  const selection =
    override ?? process.env["SUPERTAG_CONTROL_PLANE"]?.trim() ?? configured.activeConnection;
  if (!selection) {
    const token = environmentOperatorToken() || (await readLocalAdminToken());
    return token === undefined ? undefined : { url: await localControlPlaneUrl(), token };
  }

  if (isControlPlaneUrl(selection)) {
    const token = environmentOperatorToken();
    if (!token) {
      throw new Error(
        "SUPERTAG_OPERATOR_TOKEN (or SUPERTAG_ADMIN_TOKEN) is required when SUPERTAG_CONTROL_PLANE or --control-plane is a URL",
      );
    }
    return { url: normalizeControlPlaneUrl(selection), token };
  }

  const connection = configured.connections[selection];
  if (connection === undefined) {
    throw new Error(
      `Control Plane connection ${JSON.stringify(selection)} is not configured. Run: supertag list control-plane`,
    );
  }
  const controlPlane = configured.controlPlanes[connection.controlPlane];
  const credential = configured.credentials[connection.credential];
  if (controlPlane === undefined || credential === undefined) {
    throw new Error(`Control Plane connection ${JSON.stringify(selection)} is incomplete`);
  }
  const environmentToken = environmentOperatorToken();
  const storedToken = await operatorCredentialProvider(credential.provider).resolve(
    credential.credentialId,
  );
  const token = environmentToken ?? storedToken?.["token"]?.trim();
  if (!token) {
    throw new Error(
      `Administrative credential for Control Plane ${JSON.stringify(selection)} is missing`,
    );
  }
  return { name: selection, url: normalizeControlPlaneUrl(controlPlane.url), token };
}

export async function resolveControlPlaneUrl(override?: string): Promise<string | undefined> {
  return resolveSavedControlPlaneUrl(override);
}

/** The URL a selection or the saved active connection names, else the local Control Plane's. */
export async function resolveSavedControlPlaneUrl(override?: string): Promise<string | undefined> {
  const configured = await readControlPlaneConfiguration();
  const selection =
    override ?? process.env["SUPERTAG_CONTROL_PLANE"]?.trim() ?? configured.activeConnection;
  if (!selection) return localControlPlaneUrl();
  if (isControlPlaneUrl(selection)) return normalizeControlPlaneUrl(selection);
  const connection = configured.connections[selection];
  if (connection === undefined) {
    throw new Error(`Control Plane connection ${JSON.stringify(selection)} is not configured`);
  }
  const controlPlane = configured.controlPlanes[connection.controlPlane];
  if (controlPlane === undefined)
    throw new Error(`Control Plane connection ${JSON.stringify(selection)} is incomplete`);
  return normalizeControlPlaneUrl(controlPlane.url);
}

export async function ensureLocalAdminToken(): Promise<string> {
  const provider = operatorCredentialProvider(FILE_OPERATOR_CREDENTIAL_PROVIDER);
  const existing = await provider.resolve(LOCAL_ADMIN_CREDENTIAL);
  const token = existing?.["token"]?.trim();
  if (token) return token;
  const generated = randomBytes(32).toString("hex");
  await provider.store(LOCAL_ADMIN_CREDENTIAL, { token: generated });
  return generated;
}

async function readLocalAdminToken(): Promise<string | undefined> {
  return (
    await operatorCredentialProvider(FILE_OPERATOR_CREDENTIAL_PROVIDER).resolve(
      LOCAL_ADMIN_CREDENTIAL,
    )
  )?.["token"]?.trim();
}

async function connectControlPlane(args: readonly string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      name: { type: "string" },
      replace: { type: "boolean", default: false },
    },
    strict: true,
  });
  if (positionals.length !== 1) {
    throw new Error("Usage: supertag connect control-plane URL [--name NAME] [--replace]");
  }
  const url = normalizeControlPlaneUrl(required(positionals[0], "Control Plane URL"));
  const name = normalizeControlPlaneName(values.name ?? DEFAULT_CONTROL_PLANE_NAME);
  const configured = await readControlPlaneConfiguration();
  const existing = configured.connections[name];
  if (existing !== undefined && !values.replace) {
    if (!process.stdin.isTTY) {
      throw new Error(
        `Control Plane ${displayControlPlaneName(name)} already exists; pass --replace to replace it`,
      );
    }
    const accepted = await confirm({
      message: `Replace ${displayControlPlaneName(name)}?`,
      default: false,
    });
    if (!accepted) {
      process.stdout.write("Control Plane connection unchanged.\n");
      return;
    }
  }

  const token =
    environmentOperatorToken() ||
    (await password({ message: "Operator Token or admin token", mask: "*" })).trim();
  if (!token) throw new Error("The Operator Token or admin token must not be empty");
  const target: ControlPlaneTarget = { name, url, token };
  await new ControlPlaneClient(target).status();

  const credentialRef = `control-plane/${createHash("sha256").update(name).digest("hex")}`;
  const credentialProvider = operatorCredentialProvider(FILE_OPERATOR_CREDENTIAL_PROVIDER);
  const priorCredential = await credentialProvider.resolve(credentialRef);
  await credentialProvider.store(credentialRef, { token });
  try {
    await writeControlPlaneConfiguration({
      version: CONFIG_VERSION,
      activeConnection: name,
      controlPlanes: { ...configured.controlPlanes, [name]: { url } },
      credentials: {
        ...configured.credentials,
        [name]: { provider: credentialProvider.id, credentialId: credentialRef },
      },
      connections: {
        ...configured.connections,
        [name]: { controlPlane: name, credential: name },
      },
    });
  } catch (error) {
    if (priorCredential === undefined) await credentialProvider.delete(credentialRef);
    else await credentialProvider.store(credentialRef, priorCredential);
    throw error;
  }
  process.stdout.write(
    `Connected to SuperTag at ${new URL(url).host}.\nThis is now your active Control Plane${name === DEFAULT_CONTROL_PLANE_NAME ? "." : ` (${name}).`}\n`,
  );
}

async function listControlPlanes(args: readonly string[]): Promise<void> {
  const { values } = parseArgs({ args, options: { output: { type: "string" } }, strict: true });
  const output = values.output ?? "text";
  if (output !== "text" && output !== "json" && output !== "yaml")
    throw new Error("--output must be text, json, or yaml");
  const configured = await readControlPlaneConfiguration();
  const entries = Object.entries(configured.connections).sort(([left], [right]) =>
    left.localeCompare(right),
  );
  const rows = entries.map(([name, connection]) => {
    const controlPlane = configured.controlPlanes[connection.controlPlane];
    if (controlPlane === undefined)
      throw new Error(`Control Plane connection ${JSON.stringify(name)} is incomplete`);
    return {
      active: configured.activeConnection === name,
      name: displayControlPlaneName(name),
      url: controlPlane.url,
    };
  });
  if (output === "json") {
    process.stdout.write(`${JSON.stringify({ items: rows }, null, 2)}\n`);
    return;
  }
  if (output === "yaml") {
    process.stdout.write(stringifyYaml({ items: rows }));
    return;
  }
  if (entries.length === 0) {
    process.stdout.write("No remote Control Planes configured.\n");
    return;
  }
  process.stdout.write("ACTIVE\tNAME\tURL\n");
  for (const row of rows) {
    process.stdout.write(`${row.active ? "*" : ""}\t${row.name}\t${row.url}\n`);
  }
}

async function currentControlPlane(args: readonly string[]): Promise<void> {
  parseArgs({ args, options: {}, strict: true });
  const configured = await readControlPlaneConfiguration();
  if (configured.activeConnection === null) {
    process.stdout.write(`${await localControlPlaneUrl()}\n`);
    return;
  }
  const connection = configured.connections[configured.activeConnection];
  const controlPlane =
    connection === undefined ? undefined : configured.controlPlanes[connection.controlPlane];
  if (controlPlane === undefined) throw new Error("The active Control Plane connection is invalid");
  process.stdout.write(
    `${configured.activeConnection === DEFAULT_CONTROL_PLANE_NAME ? controlPlane.url : `${configured.activeConnection}\t${controlPlane.url}`}\n`,
  );
}

async function useControlPlane(args: readonly string[]): Promise<void> {
  const { positionals } = parseArgs({ args, allowPositionals: true, options: {}, strict: true });
  if (positionals.length !== 1) throw new Error("Usage: supertag use control-plane NAME");
  const name = normalizeControlPlaneName(required(positionals[0], "Control Plane name"));
  const configured = await readControlPlaneConfiguration();
  if (configured.connections[name] === undefined) {
    throw new Error(`Control Plane connection ${JSON.stringify(name)} is not configured`);
  }
  await writeControlPlaneConfiguration({ ...configured, activeConnection: name });
  process.stdout.write(`Using ${displayControlPlaneName(name)} as the active Control Plane.\n`);
}

async function removeControlPlane(args: readonly string[]): Promise<void> {
  const { positionals } = parseArgs({ args, allowPositionals: true, options: {}, strict: true });
  if (positionals.length !== 1) throw new Error("Usage: supertag remove control-plane NAME");
  const name = normalizeControlPlaneName(required(positionals[0], "Control Plane name"));
  const configured = await readControlPlaneConfiguration();
  const connection = configured.connections[name];
  if (connection === undefined)
    throw new Error(`Control Plane connection ${JSON.stringify(name)} is not configured`);
  const credential = configured.credentials[connection.credential];
  if (credential === undefined)
    throw new Error(`Control Plane connection ${JSON.stringify(name)} is incomplete`);
  const { [name]: _removedConnection, ...connections } = configured.connections;
  const { [connection.controlPlane]: _removedControlPlane, ...controlPlanes } =
    configured.controlPlanes;
  const { [connection.credential]: _removedCredential, ...credentials } = configured.credentials;
  const nextActive =
    configured.activeConnection === name
      ? (Object.keys(connections).sort()[0] ?? null)
      : configured.activeConnection;
  await writeControlPlaneConfiguration({
    ...configured,
    activeConnection: nextActive,
    controlPlanes,
    credentials,
    connections,
  });
  await operatorCredentialProvider(credential.provider).delete(credential.credentialId);
  process.stdout.write(`Removed ${displayControlPlaneName(name)}.\n`);
}

async function statusControlPlane(args: readonly string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: { "control-plane": { type: "string" } },
    strict: true,
  });
  const target = await resolveControlPlaneTarget(values["control-plane"]);
  if (target === undefined) {
    throw new Error("No active remote Control Plane. Run: supertag connect control-plane URL");
  }
  const status = await new ControlPlaneClient(target).status();
  const phase = ControlPlanePhase[status.phase]?.toLowerCase() ?? "unknown";
  process.stdout.write(
    `${target.name === undefined || target.name === DEFAULT_CONTROL_PLANE_NAME ? target.url : target.name}\t${phase}\tAPI ${OPERATOR_API_VERSION}\n`,
  );
}

async function readControlPlaneConfiguration(): Promise<ControlPlaneConfiguration> {
  const path = controlPlaneConfigurationPath();
  const stats = await lstat(path).catch(() => undefined);
  if (stats === undefined) return emptyControlPlaneConfiguration();
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new Error(`Control Plane configuration is not a regular file: ${path}`);
  }
  const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
  if (!isControlPlaneConfiguration(parsed)) {
    throw new Error(`Control Plane configuration has an unsupported format: ${path}`);
  }
  return parsed;
}

async function writeControlPlaneConfiguration(
  configuration: ControlPlaneConfiguration,
): Promise<void> {
  const path = controlPlaneConfigurationPath();
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(configuration, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await rename(temporaryPath, path);
    await chmod(path, 0o600);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

function controlPlaneConfigurationPath(): string {
  return resolve(stateDirectory(), "control-planes.json");
}

function emptyControlPlaneConfiguration(): ControlPlaneConfiguration {
  return {
    version: CONFIG_VERSION,
    activeConnection: null,
    controlPlanes: {},
    credentials: {},
    connections: {},
  };
}

function isControlPlaneConfiguration(value: unknown): value is ControlPlaneConfiguration {
  if (
    !isRecord(value) ||
    value["version"] !== CONFIG_VERSION ||
    !(value["activeConnection"] === null || typeof value["activeConnection"] === "string") ||
    !isRecord(value["controlPlanes"]) ||
    !isRecord(value["credentials"]) ||
    !isRecord(value["connections"])
  ) {
    return false;
  }
  const controlPlanesValid = Object.values(value["controlPlanes"]).every(
    (controlPlane) => isRecord(controlPlane) && typeof controlPlane["url"] === "string",
  );
  const credentialsValid = Object.values(value["credentials"]).every(
    (credential) =>
      isRecord(credential) &&
      typeof credential["provider"] === "string" &&
      typeof credential["credentialId"] === "string",
  );
  const connectionsValid = Object.values(value["connections"]).every(
    (connection) =>
      isRecord(connection) &&
      typeof connection["controlPlane"] === "string" &&
      typeof connection["credential"] === "string",
  );
  return controlPlanesValid && credentialsValid && connectionsValid;
}

function operatorCredentialProvider(providerId: string): OperatorCredentialProvider {
  const factory = operatorCredentialProviderFactories.get(providerId);
  if (factory === undefined)
    throw new Error(
      `Operator credential provider ${JSON.stringify(providerId)} is not installed in this CLI`,
    );
  const provider = factory();
  if (provider.id !== providerId) {
    throw new Error(
      `Operator credential provider factory ${JSON.stringify(providerId)} is invalid`,
    );
  }
  return provider;
}

/** This machine's local Control Plane: where `supertag up` runs it, else the default port. */
async function localControlPlaneUrl(): Promise<string> {
  return normalizeControlPlaneUrl(await localUpControlPlaneUrl());
}

export function normalizeControlPlaneUrl(input: string): string {
  const url = new URL(input);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Control Plane URL must use http: or https:");
  }
  if (
    url.protocol === "http:" &&
    url.hostname !== "127.0.0.1" &&
    url.hostname !== "localhost" &&
    url.hostname !== "::1"
  ) {
    throw new Error("Remote Control Plane URLs must use HTTPS");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(
      "Control Plane URL must not contain credentials, query parameters, or a fragment",
    );
  }
  url.pathname = url.pathname.replace(/\/+$/u, "") || "/";
  return url.toString().replace(/\/$/u, "");
}

function normalizeControlPlaneName(input: string): string {
  const name = input.trim();
  if (!/^[a-z0-9](?:[a-z0-9._-]{0,62})$/u.test(name)) {
    throw new Error(
      "Control Plane name must use 1-63 lowercase letters, numbers, dots, dashes, or underscores",
    );
  }
  return name;
}

function isControlPlaneUrl(value: string): boolean {
  return value.startsWith("http://") || value.startsWith("https://");
}

function displayControlPlaneName(name: string): string {
  return name === DEFAULT_CONTROL_PLANE_NAME ? "default Control Plane" : name;
}

function required(value: string | undefined, label: string): string {
  const normalized = value?.trim();
  if (!normalized) throw new Error(`${label} is required`);
  return normalized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function _isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && "code" in value;
}

function controlPlaneManagementHelp(command: ControlPlaneManagementCommand): string {
  if (command === "connect")
    return "Usage: supertag connect control-plane URL [--name NAME] [--replace]\n";
  if (command === "use") return "Usage: supertag use control-plane NAME\n";
  if (command === "remove") return "Usage: supertag remove control-plane NAME\n";
  if (command === "status") return "Usage: supertag status control-plane [--control-plane NAME]\n";
  return `Usage: supertag ${command} control-plane\n`;
}
