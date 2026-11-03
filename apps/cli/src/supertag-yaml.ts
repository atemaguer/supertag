import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { isIP } from "node:net";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { parseNotificationDestination } from "@supertag/control-plane";
import {
  type ModalVolumeCredential,
  parseModalVolumeCredential,
  parseVolumeName,
  parseWorkerHostLabels,
  parseWorkspaceName,
  volumeCredentialLabel,
} from "@supertag/core";
import { stateDirectory } from "@supertag/store";
import {
  Document,
  isMap,
  isScalar,
  isSeq,
  LineCounter,
  type Node,
  parseDocument,
  type Scalar,
  visit,
} from "yaml";
import { HARNESSES, isHarness } from "./harnesses.js";
import {
  type HostEnvironment,
  hostEnvironmentValue,
  parseHostEnvironment,
} from "./host-environment.js";
import { type HostMcpServer, hostMcpValue, mcpServerLabels, parseHostMcp } from "./host-mcp.js";
import type { WorkletHarness } from "./worker.js";
import {
  type ConcurrencySource,
  machineWorkerConcurrency,
  parseWorkerConcurrency,
} from "./worker-concurrency.js";

/**
 * supertag.yaml describes the services that run SuperTag on a machine, like a compose file: one
 * optional `control-plane` service and any number of `host` services. Resources inside a Control
 * Plane stay Kubernetes-style manifests; a control-plane service may only reference or embed them
 * through `provision`.
 */
export const SUPERTAG_YAML = "supertag.yaml";
export const SUPERTAG_YAML_VERSION = 1;
export const DEFAULT_INSTANCE_NAME = "supertag";
export const DEFAULT_CONTROL_PLANE_SERVICE = "control-plane";
export const DEFAULT_CONTROL_PLANE_PORT = 3434;

/** Service, secret, and instance names: lowercase letters, digits, hyphens, and underscores. */
export const SERVICE_NAME = /^[a-z0-9][a-z0-9_-]{0,62}$/u;

const TOP_LEVEL_KEYS = ["version", "name", "services", "secrets", "env_file"] as const;
const CONTROL_PLANE_KEYS = [
  "type",
  "ports",
  "url",
  "database",
  "credentials",
  "notify",
  "logging",
  "tls",
  "hosts",
  "operators",
  "restart",
  "provision",
  "depends_on",
] as const;
const HOST_KEYS = [
  "type",
  "control-plane",
  "auth-key",
  "harnesses",
  "environment",
  "allow-unsandboxed-commands",
  "models",
  "workspaces",
  "volume-credentials",
  "artifact-volume",
  "local-mount-root",
  "labels",
  "mcp",
  "skills",
  "concurrency",
  "depends_on",
  "restart",
] as const;
export const LOG_LEVELS = ["error", "warn", "info", "debug", "trace"] as const;

export type RestartPolicy = "no" | "unless-stopped";
export type LogLevel = (typeof LOG_LEVELS)[number];

/** An address from Compose's short port syntax: `PORT` or `IP:PORT`. */
export interface Endpoint {
  readonly host: string;
  readonly port: number;
}

/** A manifest file, directory, or inline manifest that `up` creates if missing. */
export type ProvisionEntry =
  | { readonly path: string }
  | { readonly manifest: Readonly<Record<string, unknown>>; readonly source: string };

export interface ControlPlaneService {
  readonly type: "control-plane";
  readonly name: string;
  readonly ports: Endpoint;
  /** Public base URL, used for coordination links and by hosts in this file. */
  readonly url: string;
  readonly database: {
    readonly url: string;
    /** A secret name; its value becomes PGPASSWORD for the Control Plane process. */
    readonly password?: string;
  };
  /** `file`, or `vault://mount/prefix` for HashiCorp Vault KV v2. */
  readonly credentials: string;
  /** `slack:CHANNEL_OR_USER` that receives new inbox items. */
  readonly notify?: string | readonly string[];
  readonly logging: {
    readonly level: LogLevel;
    readonly format: "text" | "json";
    /** Where audit entries also go, besides the database: `stderr`, or an absolute JSON-lines file path. */
    readonly audit: string;
  };
  readonly tls: { readonly cert?: string; readonly key?: string; readonly ca?: string };
  /** A Worklet gRPC listener for hosts; without one, hosts connect over WebSocket at `url`. */
  readonly hosts: { readonly grpc?: Endpoint };
  readonly operators: { readonly file?: string };
  readonly restart: RestartPolicy;
  readonly dependsOn: readonly string[];
  readonly provision: readonly ProvisionEntry[];
}

export interface HostService {
  readonly type: "host";
  readonly name: string;
  /** A control-plane service in the same file, or a shared Control Plane's URL. */
  readonly controlPlane: { readonly service: string } | { readonly url: string };
  /** A secret name holding a one-time Auth Key, for a URL Control Plane. */
  readonly authKey?: string;
  readonly harnesses: readonly WorkletHarness[];
  /**
   * The remote sandbox provider this host's Workers run Task Attempts in, with its settings.
   * Absent means the local process environment.
   */
  readonly environment?: HostEnvironment;
  /**
   * Harnesses that may run Tasks granted `commands:execute` without an OS sandbox on this host.
   * Their commands run as the host user. Codex sandboxes its commands and is never listed.
   */
  readonly allowUnsandboxedCommands: readonly WorkletHarness[];
  /** Models each harness serves; the first is its default. */
  readonly models: HostModels;
  /** Workspace name to absolute checkout path. */
  readonly workspaces: Readonly<Record<string, string>>;
  /** Existing host directory that confines local mount destinations. */
  readonly localMountRoot?: string;
  /** Volume credential name to a host-only secret reference; values never enter a Task. */
  readonly volumeCredentials: Readonly<
    Record<string, SecretSource | { readonly path: string } | ModalVolumeCredential>
  >;
  /**
   * The Volume this host stores the artifacts its Tasks capture on, instead of its state
   * directory. Its credential is mapped in `volumeCredentials`; no Workspace may mount it.
   */
  readonly artifactVolume?: string;
  readonly labels: readonly string[];
  /** MCP servers this host provides, by name; each is advertised as the label `mcp:NAME`. */
  readonly mcp: Readonly<Record<string, HostMcpServer>>;
  /** Local directory or JSON catalog whose Skills Context Sets may select. */
  readonly skills?: string;
  /** Task Attempts each harness Worker on this host runs at once. */
  readonly concurrency: number;
  /** Whether `concurrency` came from supertag.yaml or was derived from this machine. */
  readonly concurrencySource: ConcurrencySource;
  readonly restart: RestartPolicy;
  readonly dependsOn: readonly string[];
}

export type ServiceConfig = ControlPlaneService | HostService;

export type SecretSource = { readonly environment: string } | { readonly file: string };

/** The resolved services: merged, interpolated, validated, with defaults and overrides applied. */
export interface ServicesFile {
  /** Absolute paths of the files read, in `-f` order; empty when no file exists. */
  readonly files: readonly string[];
  readonly name: string;
  readonly version: 1;
  /** In file order. */
  readonly services: readonly ServiceConfig[];
  readonly secrets: Readonly<Record<string, SecretSource>>;
  /** Values from env_file, used for interpolation and `environment` secrets. */
  readonly envFile: Readonly<Record<string, string>>;
  /** Absolute paths of the env_file files read, so a `file://` Volume can never copy them. */
  readonly envFilePaths?: readonly string[];
  /** Key path (dot-joined) to where its value came from, such as SUPERTAG_DATABASE_URL. */
  readonly provenance: ReadonlyMap<string, string>;
}

export class SupertagYamlError extends Error {
  constructor(
    readonly problems: readonly string[],
    title = `Invalid ${SUPERTAG_YAML}`,
  ) {
    super(`${title}:\n  ${problems.join("\n  ")}`);
    this.name = "SupertagYamlError";
  }
}

export type Environment = Readonly<Record<string, string | undefined>>;

/** The supertag.yaml `supertag up` reads without -f: the one in the state directory. */
export function defaultSupertagYamlPath(): string {
  return join(stateDirectory(), SUPERTAG_YAML);
}

/** The default SQLite database of the local Control Plane, in the state directory. */
export function defaultDatabaseUrl(): string {
  return `file:${join(stateDirectory(), "supertag.db")}`;
}

/**
 * The files `-f` names, each a file or a directory holding supertag.yaml; without -f, the state
 * directory's file when it exists, else none (the defaults).
 */
export async function supertagYamlPaths(
  options: { readonly files?: readonly string[]; readonly cwd?: string } = {},
): Promise<readonly string[]> {
  const given = options.files ?? [];
  if (given.length === 0) {
    const fallback = defaultSupertagYamlPath();
    return (await stat(fallback).catch(() => undefined))?.isFile() ? [fallback] : [];
  }
  const paths: string[] = [];
  for (const file of given) {
    const path = resolve(options.cwd ?? process.cwd(), expandHome(file));
    const stats = await stat(path).catch(() => undefined);
    if (stats === undefined) throw new Error(`${file} does not exist`);
    const chosen = stats.isDirectory() ? join(path, SUPERTAG_YAML) : path;
    if (!(await stat(chosen).catch(() => undefined))?.isFile())
      throw new Error(`${file} does not contain ${SUPERTAG_YAML}`);
    paths.push(chosen);
  }
  return paths;
}

export interface LoadOptions {
  readonly files?: readonly string[];
  readonly cwd?: string;
  /** Defaults to process.env. */
  readonly environment?: Environment;
}

/** Reads, merges, interpolates, and validates supertag.yaml, reporting every problem at once. */
export async function loadServicesFile(options: LoadOptions = {}): Promise<ServicesFile> {
  const paths = await supertagYamlPaths(options);
  const environment = options.environment ?? process.env;
  const sources: FileSource[] = [];
  for (const path of paths) {
    const text = await readFile(path, "utf8").catch((error: unknown) => {
      throw new Error(`Cannot read ${path}: ${errorMessage(error)}`);
    });
    sources.push({ path, text });
  }
  return resolveServices(sources, environment, readEnvFile);
}

interface FileSource {
  readonly path: string;
  readonly text: string;
}

interface ParsedFile {
  readonly path: string;
  readonly value: Record<string, unknown>;
  readonly positions: Map<string, string>;
}

/** Resolves already-read files. Exported for tests. */
export async function resolveServices(
  sources: readonly FileSource[],
  environment: Environment,
  envFileReader: (path: string) => Promise<Record<string, string>> = readEnvFile,
): Promise<ServicesFile> {
  const problems: string[] = [];
  const parsed: ParsedFile[] = [];
  for (const source of sources) {
    const result = parseYaml(source.text, source.path);
    if ("problems" in result) {
      problems.push(...result.problems);
      continue;
    }
    parsed.push(result);
  }
  if (problems.length > 0) throw new SupertagYamlError(problems);

  // env_file: each file's own, else the .env beside it when present.
  const envFile: Record<string, string> = {};
  const envFilePaths: string[] = [];
  for (const file of parsed) {
    const declared = file.value["env_file"];
    const directory = dirname(file.path);
    const lists =
      declared === undefined || declared === null
        ? []
        : Array.isArray(declared)
          ? declared
          : [declared];
    if (lists.some((item) => typeof item !== "string")) {
      problems.push(
        `${at(file.positions, ["env_file"], file.path)}: env_file: must be a path or a list of paths`,
      );
      continue;
    }
    const names =
      lists.length > 0
        ? (lists as string[]).map((item) => resolve(directory, expandHome(item)))
        : (await stat(join(directory, ".env")).catch(() => undefined))?.isFile()
          ? [join(directory, ".env")]
          : [];
    for (const name of names) {
      envFilePaths.push(name);
      try {
        Object.assign(envFile, await envFileReader(name));
      } catch (error) {
        problems.push(
          `${at(file.positions, ["env_file"], file.path)}: env_file: cannot read ${displayPath(name)}: ${errorMessage(error)}`,
        );
      }
    }
  }
  if (problems.length > 0) throw new SupertagYamlError(problems);

  // Interpolate each file, then merge in -f order.
  const provenance = new Map<string, string>();
  let merged: Record<string, unknown> = {};
  const positions = new Map<string, string>();
  const owners = new Map<string, string>();
  for (const file of parsed) {
    const value = interpolate(file.value, [], {
      lookup: (name) => {
        const fromProcess = environment[name];
        if (fromProcess !== undefined)
          return { value: fromProcess, source: `environment: ${name}` };
        const fromFile = envFile[name];
        if (fromFile !== undefined) return { value: fromFile, source: `env_file: ${name}` };
        return undefined;
      },
      problem: (path, message) =>
        problems.push(`${at(file.positions, path, file.path)}: ${message}`),
      provenance,
    }) as Record<string, unknown>;
    merged = mergeValues(merged, value) as Record<string, unknown>;
    for (const [key, position] of file.positions) {
      positions.set(key, position);
      owners.set(key, file.path);
    }
  }
  if (problems.length > 0) throw new SupertagYamlError(problems);
  const firstFile = parsed[0]?.path;
  const located = (path: readonly string[]) => at(positions, path, firstFile ?? SUPERTAG_YAML);
  // Relative paths resolve against the file that set the value.
  const directoryOf = (path: readonly string[]) =>
    dirname(nearest(owners, path) ?? firstFile ?? defaultSupertagYamlPath());
  // Setting variables come from the process environment, then env_file, like interpolation.
  const settings: Record<string, string | undefined> = {};
  const fromEnvFile = new Set<string>();
  for (const name of [...SETTING_VARIABLES, ...PLATFORM_VARIABLES]) {
    settings[name] = environment[name] ?? envFile[name];
    if (environment[name] === undefined && envFile[name] !== undefined) fromEnvFile.add(name);
  }
  const result = validate(merged, {
    problem: (path, message) =>
      problems.push(`${located(path)}: ${[...path].join(".")}: ${message}`),
    directoryOf,
    environment: settings,
    provenance,
  });
  if (problems.length > 0) throw new SupertagYamlError(problems);
  for (const [path, source] of provenance)
    provenance.set(
      path,
      source
        .split(", ")
        .map((part) => (fromEnvFile.has(part) ? `env_file: ${part}` : part))
        .join(", "),
    );
  return {
    ...result,
    files: parsed.map((file) => file.path),
    envFile,
    envFilePaths,
    provenance,
  };
}

/** Parses one file and records the position of every key and list item. */
function parseYaml(
  text: string,
  file: string,
): ParsedFile | { readonly problems: readonly string[] } {
  const lineCounter = new LineCounter();
  const document = parseDocument(text, { lineCounter, prettyErrors: false, merge: true });
  const shown = displayPath(file);
  const position = (offset: number | undefined) => {
    if (offset === undefined) return shown;
    const { line, col } = lineCounter.linePos(offset);
    return `${shown}:${line}:${col}`;
  };
  if (document.errors.length > 0)
    return {
      problems: document.errors.map(
        (error) => `${position(error.pos[0])}: ${error.message.split("\n")[0]}`,
      ),
    };
  const positions = new Map<string, string>();
  const visit = (node: unknown, path: readonly string[]) => {
    if (isMap(node))
      for (const pair of node.items) {
        const key = isScalar(pair.key) ? String((pair.key as Scalar).value) : String(pair.key);
        const next = [...path, key];
        const range = (pair.key as { range?: [number, number, number] } | null)?.range;
        positions.set(pathKey(next), position(range?.[0]));
        visit(pair.value, next);
      }
    else if (isSeq(node))
      node.items.forEach((item, index) => {
        const next = [...path, String(index)];
        positions.set(pathKey(next), position((item as Node | null)?.range?.[0]));
        visit(item, next);
      });
  };
  visit(document.contents, []);
  positions.set(pathKey([]), `${shown}:1:1`);
  const value: unknown = document.toJS({ maxAliasCount: 1000 }) ?? {};
  if (!isRecord(value))
    return {
      problems: [
        `${shown}: ${SUPERTAG_YAML} is a map with services, such as services: { control-plane: { type: control-plane } }`,
      ],
    };
  return { path: file, value, positions };
}

interface InterpolationContext {
  readonly lookup: (
    name: string,
  ) => { readonly value: string; readonly source: string } | undefined;
  readonly problem: (path: readonly string[], message: string) => void;
  readonly provenance: Map<string, string>;
}

/** `${VAR}`, `${VAR:-default}`, `${VAR:?message}`, and `$$`, in every string value. */
function interpolate(
  value: unknown,
  path: readonly string[],
  context: InterpolationContext,
): unknown {
  if (typeof value === "string") {
    const sources: string[] = [];
    const result = interpolateString(
      value,
      (name, operator, argument) => {
        const found = context.lookup(name);
        const present = found !== undefined && found.value !== "";
        if (operator === ":-") {
          if (present) sources.push(found.source);
          return present ? found.value : argument;
        }
        if (operator === ":?") {
          if (!present) {
            context.problem(path, `\${${name}} is required: ${argument || `set ${name}`}`);
            return "";
          }
          sources.push(found.source);
          return found.value;
        }
        if (found === undefined) {
          context.problem(
            path,
            `\${${name}} is not set. Set it in the environment or an env_file, or give a default with \${${name}:-VALUE}`,
          );
          return "";
        }
        sources.push(found.source);
        return found.value;
      },
      (message) => context.problem(path, message),
    );
    if (sources.length > 0) context.provenance.set(path.join("."), sources.join(", "));
    else if (path.includes("mcp") && value.includes("${"))
      context.provenance.set(path.join("."), "interpolated value");
    return result;
  }
  if (Array.isArray(value))
    return value.map((item, index) => interpolate(item, [...path, String(index)], context));
  if (isRecord(value))
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        key.startsWith("x-") ? entry : interpolate(entry, [...path, key], context),
      ]),
    );
  return value;
}

export function interpolateString(
  text: string,
  resolveVariable: (name: string, operator: "" | ":-" | ":?", argument: string) => string,
  problem: (message: string) => void = () => {},
): string {
  let output = "";
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character !== "$") {
      output += character;
      continue;
    }
    const next = text[index + 1];
    if (next === "$") {
      output += "$";
      index += 1;
      continue;
    }
    if (next !== "{") {
      const match = /^[A-Za-z_][A-Za-z0-9_]*/u.exec(text.slice(index + 1));
      if (match === null) {
        output += "$";
        continue;
      }
      output += resolveVariable(match[0], "", "");
      index += match[0].length;
      continue;
    }
    const close = text.indexOf("}", index + 2);
    if (close < 0) {
      problem(`unterminated \${ in "${text}"; write $$ for a literal $`);
      return output;
    }
    const body = text.slice(index + 2, close);
    const match = /^([A-Za-z_][A-Za-z0-9_]*)(?:(:-|:\?)(.*))?$/su.exec(body);
    if (match === null) {
      problem(
        `\${${body}} is not a valid variable; use \${NAME}, \${NAME:-default}, or \${NAME:?message}`,
      );
      index = close;
      continue;
    }
    output += resolveVariable(match[1] ?? "", (match[2] ?? "") as "" | ":-" | ":?", match[3] ?? "");
    index = close;
  }
  return output;
}

/** Maps merge by key, lists and scalars replace, and `null` removes a key. */
export function mergeValues(base: unknown, over: unknown): unknown {
  if (!isRecord(base) || !isRecord(over)) return over;
  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(over)) {
    if (value === null && key in base) delete result[key];
    else
      result[key] =
        isRecord(result[key]) && isRecord(value) ? mergeValues(result[key], value) : value;
  }
  return result;
}

interface ValidationContext {
  readonly problem: (path: readonly string[], message: string) => void;
  readonly directoryOf: (path: readonly string[]) => string;
  readonly environment: Environment;
  readonly provenance: Map<string, string>;
}

function parseSecretSource(
  source: unknown,
  path: readonly string[],
  context: ValidationContext,
): SecretSource | undefined {
  if (isRecord(source) && Object.keys(source).length === 1) {
    if (
      typeof source["environment"] === "string" &&
      /^[A-Za-z_][A-Za-z0-9_]*$/u.test(source["environment"])
    )
      return { environment: source["environment"] };
    if (typeof source["file"] === "string" && source["file"].trim())
      return {
        file: resolve(context.directoryOf([...path, "file"]), expandHome(source["file"].trim())),
      };
  }
  context.problem(path, "must be { environment: VAR } or { file: PATH }");
  return undefined;
}

/**
 * A service's `volume-credentials`: credential names to secret references, or `{ path: DIR }`
 * consent for `file://` Volumes. Only references are kept; values are read when used.
 */
function parseVolumeCredentials(
  raw: unknown,
  path: readonly string[],
  context: ValidationContext,
): Record<string, SecretSource | { readonly path: string } | ModalVolumeCredential> {
  const volumeCredentials: Record<
    string,
    SecretSource | { readonly path: string } | ModalVolumeCredential
  > = {};
  if (raw === undefined || raw === null) return volumeCredentials;
  if (!isRecord(raw)) {
    context.problem(
      [...path, "volume-credentials"],
      "must map credential names to secret references",
    );
    return volumeCredentials;
  }
  for (const [name, source] of Object.entries(raw)) {
    const key = [...path, "volume-credentials", name];
    if (!SERVICE_NAME.test(name)) {
      context.problem(
        key,
        "credential names are lowercase letters, digits, hyphens, or underscores",
      );
      continue;
    }
    if (
      isRecord(source) &&
      ("modal-secret" in source || "modal-oidc-role" in source || "modal-volume" in source)
    ) {
      try {
        volumeCredentials[name] = parseModalVolumeCredential(source);
      } catch {
        context.problem(
          key,
          "must name one provider-held modal-secret, modal-oidc-role ARN, or modal-volume consent",
        );
      }
      continue;
    }
    const reference =
      isRecord(source) &&
      Object.keys(source).length === 1 &&
      typeof source["path"] === "string" &&
      source["path"].trim()
        ? {
            path: resolve(context.directoryOf([...key, "path"]), expandHome(source["path"].trim())),
          }
        : parseSecretSource(source, key, context);
    if (reference !== undefined) {
      if ("environment" in reference && reference.environment.startsWith("SUPERTAG_MCP_"))
        context.problem(key, "must not use SUPERTAG_MCP_* environment variables");
      else volumeCredentials[name] = reference;
    }
  }
  return volumeCredentials;
}

function validate(
  value: Record<string, unknown>,
  context: ValidationContext,
): Pick<ServicesFile, "name" | "version" | "services" | "secrets"> {
  const { problem } = context;
  unknownKeys(value, [], TOP_LEVEL_KEYS, problem);
  const version = value["version"];
  if (version !== undefined && version !== null && version !== 1 && version !== "1")
    problem(["version"], "must be 1");
  let name = DEFAULT_INSTANCE_NAME;
  if (value["name"] !== undefined && value["name"] !== null) {
    if (typeof value["name"] !== "string" || !SERVICE_NAME.test(value["name"]))
      problem(
        ["name"],
        "must be 1-63 lowercase letters, digits, hyphens, or underscores, starting with a letter or digit",
      );
    else name = value["name"];
  }

  const secrets: Record<string, SecretSource> = {};
  const rawSecrets = value["secrets"];
  if (rawSecrets !== undefined && rawSecrets !== null) {
    if (!isRecord(rawSecrets))
      problem(["secrets"], "must map secret names to { environment: VAR } or { file: PATH }");
    else
      for (const [secret, source] of Object.entries(rawSecrets)) {
        const path = ["secrets", secret];
        if (!SERVICE_NAME.test(secret)) {
          problem(path, "secret names are lowercase letters, digits, hyphens, or underscores");
          continue;
        }
        const reference = parseSecretSource(source, path, context);
        if (reference !== undefined) secrets[secret] = reference;
      }
  }

  const rawServices = value["services"];
  const entries: [string, unknown][] =
    rawServices === undefined || rawServices === null
      ? [[DEFAULT_CONTROL_PLANE_SERVICE, { type: "control-plane" }]]
      : isRecord(rawServices)
        ? Object.entries(rawServices).filter(([key]) => !key.startsWith("x-"))
        : [];
  if (rawServices !== undefined && rawServices !== null && !isRecord(rawServices))
    problem(["services"], "must map service names to services, each with a type");
  const controlPlanes = entries.filter(
    ([, service]) => isRecord(service) && service["type"] === "control-plane",
  );
  if (controlPlanes.length > 1)
    problem(
      ["services", controlPlanes[1]?.[0] ?? ""],
      `only one control-plane service is allowed; ${controlPlanes[0]?.[0]} is already one`,
    );
  const controlPlaneName = controlPlanes[0]?.[0];
  const names = new Set(entries.map(([key]) => key));
  const services: ServiceConfig[] = [];
  for (const [service, raw] of entries) {
    const path = ["services", service];
    if (!SERVICE_NAME.test(service)) {
      problem(
        path,
        "service names are 1-63 lowercase letters, digits, hyphens, or underscores, starting with a letter or digit",
      );
      continue;
    }
    if (!isRecord(raw)) {
      problem(path, "must be a map with a type: control-plane or host");
      continue;
    }
    const secretName = (key: readonly string[], value: unknown): string | undefined => {
      if (value === undefined || value === null) return undefined;
      if (typeof value !== "string" || !(value in secrets)) {
        problem(key, "must name an entry in secrets");
        return undefined;
      }
      return value;
    };
    const dependsOn = (fallback: readonly string[]): readonly string[] => {
      const declared = raw["depends_on"];
      if (declared === undefined || declared === null) return fallback;
      if (!Array.isArray(declared) || declared.some((item) => typeof item !== "string")) {
        problem([...path, "depends_on"], "must list service names");
        return [];
      }
      for (const [index, item] of (declared as string[]).entries())
        if (!names.has(item) || item === service)
          problem(
            [...path, "depends_on", String(index)],
            `${item} is not another service in this file`,
          );
      return [...new Set(declared as string[])];
    };
    const restart = restartPolicy(raw["restart"], [...path, "restart"], problem);
    if (raw["type"] === "control-plane") {
      services.push(
        controlPlaneService(service, raw, path, context, secretName, dependsOn([]), restart),
      );
    } else if (raw["type"] === "host") {
      unknownKeys(raw, path, HOST_KEYS, problem);
      const target = raw["control-plane"];
      let controlPlane: HostService["controlPlane"] | undefined;
      if (target === undefined || target === null) {
        if (controlPlaneName === undefined)
          problem(
            [...path, "control-plane"],
            "is required: this file has no control-plane service, so name a shared Control Plane's URL, such as https://supertag.example.com",
          );
        else controlPlane = { service: controlPlaneName };
      } else if (typeof target === "string" && names.has(target)) {
        if (target !== controlPlaneName)
          problem([...path, "control-plane"], `${target} is not a control-plane service`);
        else controlPlane = { service: target };
      } else if (typeof target === "string" && isHttpUrl(target)) {
        controlPlane = { url: target.trim().replace(/\/+$/u, "") };
      } else
        problem(
          [...path, "control-plane"],
          "must be the control-plane service's name or an http(s) URL",
        );
      const authKey = secretName([...path, "auth-key"], raw["auth-key"]);
      if (authKey !== undefined && controlPlane !== undefined && "service" in controlPlane)
        problem(
          [...path, "auth-key"],
          "is only for a URL control-plane; a host in the same file as its Control Plane joins with an Auth Key SuperTag creates",
        );
      const harnesses = raw["harnesses"];
      let chosen: WorkletHarness[] = [];
      if (!Array.isArray(harnesses) || harnesses.length === 0 || !harnesses.every(isHarness))
        problem([...path, "harnesses"], `must list one or more of ${HARNESSES.join(", ")}`);
      else chosen = [...new Set(harnesses as WorkletHarness[])];
      const hostEnvironment = parseHostEnvironment(raw["environment"], (key, message) =>
        problem([...path, "environment", ...key], message),
      );
      const allowUnsandboxedCommands = parseAllowUnsandboxedCommands(
        raw["allow-unsandboxed-commands"],
        chosen,
        (message) => problem([...path, "allow-unsandboxed-commands"], message),
      );
      if (hostEnvironment)
        for (const harness of allowUnsandboxedCommands)
          problem(
            [...path, "allow-unsandboxed-commands"],
            `${harness} cannot use allow-unsandboxed-commands with ${hostEnvironment.provider} environment; remove allow-unsandboxed-commands because commands run in the sandbox`,
          );
      const models: Partial<Record<WorkletHarness, readonly string[]>> = {};
      const rawModels = raw["models"];
      if (rawModels !== undefined && rawModels !== null) {
        if (!isRecord(rawModels))
          problem(
            [...path, "models"],
            "must map a harness to its model or a list of models, such as codex: [gpt-6-sol]",
          );
        else
          for (const [harness, model] of Object.entries(rawModels)) {
            const names = (Array.isArray(model) ? model : [model]).map((name) =>
              typeof name === "string" ? name.trim() : "",
            );
            if (
              !isHarness(harness) ||
              names.length === 0 ||
              names.some((name) => !name) ||
              new Set(names).size !== names.length
            )
              problem(
                [...path, "models", harness],
                `must map one of ${HARNESSES.join(", ")} to a model name or a list of distinct model names`,
              );
            else models[harness] = names;
          }
      }
      if (chosen.includes("opencode") && models.opencode === undefined)
        problem(
          [...path, "models"],
          "needs opencode: PROVIDER/MODEL, because OpenCode runs only with a model",
        );
      const workspaces: Record<string, string> = {};
      const volumeCredentials = parseVolumeCredentials(raw["volume-credentials"], path, context);
      let artifactVolume: string | undefined;
      if (raw["artifact-volume"] !== undefined && raw["artifact-volume"] !== null)
        try {
          artifactVolume = parseVolumeName(raw["artifact-volume"], "artifact-volume");
        } catch (error) {
          problem(
            [...path, "artifact-volume"],
            errorMessage(error).replace(/^artifact-volume /u, ""),
          );
        }
      let localMountRoot: string | undefined;
      const rawLocalMountRoot = raw["local-mount-root"];
      if (rawLocalMountRoot !== undefined) {
        if (typeof rawLocalMountRoot !== "string" || !rawLocalMountRoot.trim())
          problem([...path, "local-mount-root"], "must name an existing directory");
        else
          localMountRoot = resolve(
            context.directoryOf([...path, "local-mount-root"]),
            expandHome(rawLocalMountRoot.trim()),
          );
      }
      const rawWorkspaces = raw["workspaces"];
      if (rawWorkspaces !== undefined && rawWorkspaces !== null) {
        if (!isRecord(rawWorkspaces))
          problem([...path, "workspaces"], "must map Workspace names to checkout paths");
        else
          for (const [workspace, checkout] of Object.entries(rawWorkspaces)) {
            const key = [...path, "workspaces", workspace];
            try {
              parseWorkspaceName(workspace);
            } catch (error) {
              problem(key, errorMessage(error));
              continue;
            }
            if (
              typeof checkout !== "string" ||
              !(checkout.startsWith("/") || checkout === "~" || checkout.startsWith("~/"))
            )
              problem(key, "must be an absolute or ~ path to a git checkout");
            else workspaces[workspace] = resolve(expandHome(checkout));
          }
      }
      if (hostEnvironment !== undefined && Object.keys(workspaces).length > 0)
        problem(
          [...path, "workspaces"],
          `cannot name checkout paths on a host with environment ${hostEnvironment.provider}: its sandboxes serve Workspaces by source only`,
        );
      let labels: readonly string[] = [];
      const rawLabels = raw["labels"];
      if (rawLabels !== undefined && rawLabels !== null) {
        try {
          if (!Array.isArray(rawLabels)) throw new Error("must list labels");
          labels = parseWorkerHostLabels(rawLabels.map(String), "labels");
        } catch (error) {
          problem([...path, "labels"], errorMessage(error));
        }
      }
      const mcp = parseHostMcp(raw["mcp"], [...path, "mcp"], {
        problem,
        directoryOf: context.directoryOf,
        secrets: new Set(Object.keys(secrets)),
        expandHome,
      });
      let skills: string | undefined;
      if (raw["skills"] !== undefined && raw["skills"] !== null) {
        if (typeof raw["skills"] !== "string" || !raw["skills"].trim())
          problem([...path, "skills"], "must be a catalog directory or JSON file path");
        else
          skills = resolve(
            context.directoryOf([...path, "skills"]),
            expandHome(raw["skills"].trim()),
          );
      }
      let concurrency = machineWorkerConcurrency();
      let concurrencySource: ConcurrencySource = "machine";
      const rawConcurrency = raw["concurrency"];
      if (rawConcurrency !== undefined && rawConcurrency !== null) {
        concurrencySource = "file";
        try {
          concurrency = parseWorkerConcurrency(rawConcurrency);
        } catch (error) {
          problem([...path, "concurrency"], errorMessage(error));
        }
      }
      if (controlPlane === undefined) continue;
      services.push({
        type: "host",
        name: service,
        controlPlane,
        ...(authKey === undefined ? {} : { authKey }),
        harnesses: chosen,
        ...(hostEnvironment === undefined ? {} : { environment: hostEnvironment }),
        allowUnsandboxedCommands,
        models,
        workspaces,
        volumeCredentials,
        ...(artifactVolume === undefined ? {} : { artifactVolume }),
        ...(localMountRoot === undefined ? {} : { localMountRoot }),
        labels,
        mcp,
        ...(skills === undefined ? {} : { skills }),
        concurrency,
        concurrencySource,
        restart,
        dependsOn: dependsOn("service" in controlPlane ? [controlPlane.service] : []),
      });
    } else
      problem(
        [...path, "type"],
        raw["type"] === undefined
          ? "is required: control-plane or host"
          : "must be control-plane or host",
      );
  }
  // depends_on must not form a cycle.
  const byName = new Map(services.map((service) => [service.name, service]));
  const visiting = new Set<string>();
  const done = new Set<string>();
  const visit = (service: string, trail: readonly string[]) => {
    if (done.has(service)) return;
    if (visiting.has(service)) {
      problem(
        ["services", service, "depends_on"],
        `forms a cycle: ${[...trail, service].join(" -> ")}`,
      );
      return;
    }
    visiting.add(service);
    for (const dependency of byName.get(service)?.dependsOn ?? [])
      visit(dependency, [...trail, service]);
    visiting.delete(service);
    done.add(service);
  };
  for (const service of services) visit(service.name, []);
  return { name, version: 1, services, secrets };
}

function controlPlaneService(
  name: string,
  raw: Record<string, unknown>,
  path: readonly string[],
  context: ValidationContext,
  secretName: (key: readonly string[], value: unknown) => string | undefined,
  dependsOn: readonly string[],
  restart: RestartPolicy,
): ControlPlaneService {
  const { problem, environment, provenance } = context;
  unknownKeys(raw, path, CONTROL_PLANE_KEYS, problem);
  const key = (...rest: string[]) => [...path, ...rest];
  const fromEnvironment = (field: string, variable: string) =>
    provenance.set([...path, field].join("."), variable);
  const section = (field: string, allowed: readonly string[]): Record<string, unknown> => {
    const value = raw[field];
    if (value === undefined || value === null) return {};
    if (!isRecord(value)) {
      problem(key(field), `must be a map with ${allowed.join(", ")}`);
      return {};
    }
    unknownKeys(value, key(field), allowed, problem);
    return value;
  };
  const filePath = (field: readonly string[], value: unknown): string | undefined => {
    if (value === undefined || value === null) return undefined;
    if (typeof value !== "string" || !value.trim()) {
      problem(field, "must be a file path");
      return undefined;
    }
    return resolve(context.directoryOf(field), expandHome(value.trim()));
  };

  // ports
  let ports: Endpoint = { host: "127.0.0.1", port: DEFAULT_CONTROL_PLANE_PORT };
  const rawPorts = raw["ports"];
  if (rawPorts !== undefined && rawPorts !== null) {
    if (!Array.isArray(rawPorts) || rawPorts.length !== 1)
      problem(key("ports"), 'must list one port, such as ["3434"] or ["0.0.0.0:3434"]');
    else {
      const parsed = parseEndpoint(rawPorts[0], "127.0.0.1");
      if (parsed === undefined)
        problem(key("ports", "0"), 'must be "PORT" or "IP:PORT" with a port from 0 through 65535');
      else ports = parsed;
    }
  }
  const environmentHost = environment["SUPERTAG_GATEWAY_HOST"]?.trim();
  let hostVariable: string | undefined;
  if (environmentHost) {
    const host = environmentHost.replace(/^\[|\]$/gu, "");
    if (isIP(host) === 0 && !/^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/u.test(host))
      problem(key("ports"), "SUPERTAG_GATEWAY_HOST must be an IP address or host name");
    else {
      ports = { ...ports, host };
      hostVariable = "SUPERTAG_GATEWAY_HOST";
      fromEnvironment("ports", hostVariable);
    }
  }
  // A hosting platform names the port in PORT; SUPERTAG_GATEWAY_PORT still wins over it.
  const portVariable = environment["SUPERTAG_GATEWAY_PORT"]?.trim()
    ? "SUPERTAG_GATEWAY_PORT"
    : environment["SUPERTAG_DEPLOYMENT_PLATFORM"]?.trim() && environment["PORT"]?.trim()
      ? "PORT"
      : undefined;
  const environmentPort =
    portVariable === undefined ? undefined : environment[portVariable]?.trim();
  if (portVariable !== undefined && environmentPort) {
    const port = Number(environmentPort);
    if (!Number.isInteger(port) || port < 0 || port > 65_535)
      problem(key("ports"), `${portVariable} must be an integer from 0 through 65535`);
    else {
      ports = { ...ports, port };
      fromEnvironment(
        "ports",
        hostVariable === undefined ? portVariable : `${hostVariable}, ${portVariable}`,
      );
    }
  }

  // url
  let url = defaultUrl(ports);
  if (raw["url"] !== undefined && raw["url"] !== null) {
    if (typeof raw["url"] !== "string" || !isHttpUrl(raw["url"]))
      problem(key("url"), "must be an http(s) URL");
    else url = raw["url"].trim().replace(/\/+$/u, "");
  }
  const environmentUrl = environment["SUPERTAG_COORDINATION_URL"]?.trim();
  if (environmentUrl) {
    url = environmentUrl.replace(/\/+$/u, "");
    fromEnvironment("url", "SUPERTAG_COORDINATION_URL");
  }

  // database
  const database = section("database", ["url", "password"]);
  let databaseUrl = defaultDatabaseUrl();
  if (database["url"] !== undefined && database["url"] !== null) {
    const message =
      typeof database["url"] === "string"
        ? databaseProblem(database["url"])
        : "must be a database URL";
    if (message !== undefined) problem(key("database", "url"), message);
    else
      databaseUrl = resolveDatabase(
        String(database["url"]).trim(),
        context.directoryOf(key("database", "url")),
      );
  }
  const environmentDatabase = environment["SUPERTAG_DATABASE_URL"]?.trim();
  if (environmentDatabase) {
    databaseUrl = environmentDatabase;
    provenance.set(key("database", "url").join("."), "SUPERTAG_DATABASE_URL");
  }
  const password = secretName(key("database", "password"), database["password"]);

  // credentials
  let credentials = "file";
  if (raw["credentials"] !== undefined && raw["credentials"] !== null) {
    if (
      typeof raw["credentials"] !== "string" ||
      parseCredentials(raw["credentials"]) === undefined
    )
      problem(key("credentials"), "must be file or vault://MOUNT/PREFIX");
    else credentials = raw["credentials"].trim();
  }
  const vault = environment["SUPERTAG_CREDENTIAL_VAULT"]?.trim();
  if (vault === "file" || vault === "vault") {
    credentials =
      vault === "file"
        ? "file"
        : `vault://${environment["SUPERTAG_VAULT_MOUNT"]?.trim() || "secret"}${
            environment["SUPERTAG_VAULT_PATH_PREFIX"]?.trim()
              ? `/${environment["SUPERTAG_VAULT_PATH_PREFIX"]?.trim()}`
              : ""
          }`;
    fromEnvironment("credentials", "SUPERTAG_CREDENTIAL_VAULT");
  } else if (vault) problem(key("credentials"), "SUPERTAG_CREDENTIAL_VAULT must be file or vault");

  // notify
  let notify: string | readonly string[] | undefined;
  const channel = environment["SUPERTAG_OPERATOR_CHANNEL"]?.trim();
  const rawNotify = channel || raw["notify"];
  if (rawNotify !== undefined && rawNotify !== null) {
    try {
      if (
        typeof rawNotify !== "string" &&
        !(
          Array.isArray(rawNotify) &&
          rawNotify.length > 0 &&
          rawNotify.every((entry) => typeof entry === "string")
        )
      )
        throw new Error("must be a destination or a list of destinations");
      const entries = typeof rawNotify === "string" ? [rawNotify] : (rawNotify as string[]);
      for (const entry of entries) {
        const destination = parseNotificationDestination(entry);
        if (destination.secretName) secretName(key("notify"), destination.secretName);
      }
      notify =
        typeof rawNotify === "string" ? rawNotify.trim() : entries.map((entry) => entry.trim());
      if (channel) fromEnvironment("notify", "SUPERTAG_OPERATOR_CHANNEL");
    } catch {
      problem(
        key("notify"),
        `${channel ? "SUPERTAG_OPERATOR_CHANNEL " : ""}must be desktop, webhook:HTTPS_URL[#secret-name], or slack:ID (a string or list)`,
      );
    }
  }

  // logging
  const logging = section("logging", ["level", "format", "audit"]);
  let level: LogLevel = "info";
  if (logging["level"] !== undefined && logging["level"] !== null) {
    if (!(LOG_LEVELS as readonly unknown[]).includes(logging["level"]))
      problem(key("logging", "level"), `must be one of ${LOG_LEVELS.join(", ")}`);
    else level = logging["level"] as LogLevel;
  }
  if (environment["SUPERTAG_RPC_TRACE"]?.trim() === "1") {
    level = "trace";
    provenance.set(key("logging", "level").join("."), "SUPERTAG_RPC_TRACE");
  }
  let format: "text" | "json" = "text";
  if (logging["format"] !== undefined && logging["format"] !== null) {
    if (logging["format"] !== "text" && logging["format"] !== "json")
      problem(key("logging", "format"), "must be text or json");
    else format = logging["format"];
  }
  let audit = "stderr";
  if (logging["audit"] !== undefined && logging["audit"] !== null)
    audit =
      logging["audit"] === "stderr"
        ? "stderr"
        : (filePath(key("logging", "audit"), logging["audit"]) ?? "stderr");

  // tls
  const tls = section("tls", ["cert", "key", "ca"]);
  const environmentFile = (variable: string, field: string, fallback: string | undefined) => {
    const value = environment[variable]?.trim();
    if (!value) return fallback;
    provenance.set(key("tls", field).join("."), variable);
    return resolve(value);
  };
  const cert = environmentFile(
    "SUPERTAG_WORKLET_GRPC_TLS_CERT_FILE",
    "cert",
    filePath(key("tls", "cert"), tls["cert"]),
  );
  const tlsKey = environmentFile(
    "SUPERTAG_WORKLET_GRPC_TLS_KEY_FILE",
    "key",
    filePath(key("tls", "key"), tls["key"]),
  );
  const ca = environmentFile(
    "SUPERTAG_WORKLET_TLS_CA_FILE",
    "ca",
    filePath(key("tls", "ca"), tls["ca"]),
  );
  if ((cert === undefined) !== (tlsKey === undefined))
    problem(key("tls"), "needs both cert and key");

  // hosts.grpc
  const hosts = section("hosts", ["grpc"]);
  let grpc: Endpoint | undefined;
  if (hosts["grpc"] !== undefined && hosts["grpc"] !== null) {
    grpc = parseEndpoint(hosts["grpc"], ports.host);
    if (grpc === undefined)
      problem(key("hosts", "grpc"), 'must be "PORT" or "IP:PORT" with a port from 0 through 65535');
  }
  const environmentGrpc = environment["SUPERTAG_WORKLET_GRPC_PORT"]?.trim();
  if (environmentGrpc) {
    const port = Number(environmentGrpc);
    if (!Number.isInteger(port) || port < 0 || port > 65_535)
      problem(
        key("hosts", "grpc"),
        "SUPERTAG_WORKLET_GRPC_PORT must be an integer from 0 through 65535",
      );
    else {
      grpc = { host: grpc?.host ?? ports.host, port };
      provenance.set(key("hosts", "grpc").join("."), "SUPERTAG_WORKLET_GRPC_PORT");
    }
  }
  if (cert !== undefined && grpc === undefined)
    problem(key("tls"), "cert and key secure the hosts.grpc listener; set hosts.grpc too");

  // operators.file
  const operators = section("operators", ["file"]);
  let operatorsFile = filePath(key("operators", "file"), operators["file"]);
  const environmentOperators = environment["SUPERTAG_COORDINATION_OPERATORS_FILE"]?.trim();
  if (environmentOperators) {
    operatorsFile = resolve(environmentOperators);
    provenance.set(key("operators", "file").join("."), "SUPERTAG_COORDINATION_OPERATORS_FILE");
  }

  // provision
  const provision: ProvisionEntry[] = [];
  const rawProvision = raw["provision"];
  if (rawProvision !== undefined && rawProvision !== null) {
    if (!Array.isArray(rawProvision))
      problem(key("provision"), "must list manifest files, directories, or inline manifests");
    else
      rawProvision.forEach((entry, index) => {
        const field = key("provision", String(index));
        if (typeof entry === "string" && entry.trim())
          provision.push({ path: resolve(context.directoryOf(field), expandHome(entry.trim())) });
        else if (
          isRecord(entry) &&
          typeof entry["apiVersion"] === "string" &&
          typeof entry["kind"] === "string" &&
          isRecord(entry["metadata"])
        )
          provision.push({ manifest: entry, source: `${SUPERTAG_YAML} ${field.join(".")}` });
        else
          problem(
            field,
            "must be a manifest path, or an inline manifest with apiVersion, kind, metadata, and spec",
          );
      });
  }

  return {
    type: "control-plane",
    name,
    ports,
    url,
    database: { url: databaseUrl, ...(password === undefined ? {} : { password }) },
    credentials,
    ...(notify === undefined ? {} : { notify }),
    logging: { level, format, audit },
    tls: {
      ...(cert === undefined ? {} : { cert }),
      ...(tlsKey === undefined ? {} : { key: tlsKey }),
      ...(ca === undefined ? {} : { ca }),
    },
    hosts: grpc === undefined ? {} : { grpc },
    operators: operatorsFile === undefined ? {} : { file: operatorsFile },
    restart,
    dependsOn,
    provision,
  };
}

function restartPolicy(
  value: unknown,
  path: readonly string[],
  problem: (path: readonly string[], message: string) => void,
): RestartPolicy {
  if (value === undefined || value === null || value === "no" || value === false) return "no";
  if (value === "unless-stopped") return "unless-stopped";
  problem(path, "must be no or unless-stopped");
  return "no";
}

function unknownKeys(
  value: Record<string, unknown>,
  path: readonly string[],
  allowed: readonly string[],
  problem: (path: readonly string[], message: string) => void,
): void {
  for (const key of Object.keys(value))
    if (!allowed.includes(key) && !key.startsWith("x-"))
      problem([...path, key], `unknown field; expected one of ${allowed.join(", ")}`);
}

/** Compose short syntax: `PORT`, `IP:PORT`, or `[IPV6]:PORT`. */
export function parseEndpoint(value: unknown, defaultHost: string): Endpoint | undefined {
  const text =
    typeof value === "number"
      ? String(value)
      : typeof value === "string"
        ? value.trim()
        : undefined;
  if (text === undefined) return undefined;
  const match = /^(?:(\[[^\]]+\]|[^:]+):)?(\d{1,5})$/u.exec(text);
  if (match === null) return undefined;
  const port = Number(match[2]);
  if (!Number.isInteger(port) || port > 65_535) return undefined;
  const host = match[1]?.replace(/^\[|\]$/gu, "") ?? defaultHost;
  return { host, port };
}

export function formatEndpoint(endpoint: Endpoint): string {
  return `${endpoint.host.includes(":") ? `[${endpoint.host}]` : endpoint.host}:${endpoint.port}`;
}

/** The URL a Control Plane bound to `ports` is reached at from this machine. */
export function defaultUrl(ports: Endpoint): string {
  const shown = ports.host === "0.0.0.0" || ports.host === "::" ? "127.0.0.1" : ports.host;
  return `http://${shown.includes(":") ? `[${shown}]` : shown}:${ports.port}`;
}

/** Why a database URL is unusable here, or undefined. Passwords stay out of the file. */
export function databaseProblem(value: string): string | undefined {
  const trimmed = value.trim();
  if (trimmed.startsWith("file:"))
    return trimmed.length > "file:".length ? undefined : "needs a path after file:";
  if (!/^postgres(ql)?:\/\//u.test(trimmed))
    return "must be a file: SQLite path or a postgresql:// URL";
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return "must be a valid postgresql:// URL";
  }
  if (url.password)
    return "must not contain a password; name a secret in database.password instead";
  return undefined;
}

/** A relative file: path is relative to the supertag.yaml that names it. */
function resolveDatabase(database: string, directory: string): string {
  if (!database.startsWith("file:")) return database;
  const path = database.slice("file:".length);
  return `file:${resolve(directory, expandHome(path))}`;
}

export function parseCredentials(
  value: string,
):
  | { readonly provider: "file" }
  | { readonly provider: "vault"; readonly mount: string; readonly prefix?: string }
  | undefined {
  const trimmed = value.trim();
  if (trimmed === "file") return { provider: "file" };
  const match = /^vault:\/\/([^/\s]+)(?:\/(\S+?))?\/?$/u.exec(trimmed);
  if (match === null) return undefined;
  return {
    provider: "vault",
    mount: match[1] ?? "secret",
    ...(match[2] ? { prefix: match[2] } : {}),
  };
}

/**
 * The SUPERTAG_* variables that carry a control-plane service's file settings to the runtime,
 * for the settings the runtime reads only from its environment.
 */
export function controlPlaneEnvironment(service: ControlPlaneService): Record<string, string> {
  const environment: Record<string, string> = {};
  const credentials = parseCredentials(service.credentials);
  if (credentials?.provider === "vault") {
    environment["SUPERTAG_CREDENTIAL_VAULT"] = "vault";
    environment["SUPERTAG_VAULT_MOUNT"] = credentials.mount;
    if (credentials.prefix) environment["SUPERTAG_VAULT_PATH_PREFIX"] = credentials.prefix;
  } else environment["SUPERTAG_CREDENTIAL_VAULT"] = "file";
  return environment;
}

/** Environment variables the file settings replace for a Control Plane process. */
export const CONTROL_PLANE_SETTING_VARIABLES = [
  "SUPERTAG_CREDENTIAL_VAULT",
  "SUPERTAG_VAULT_MOUNT",
  "SUPERTAG_VAULT_PATH_PREFIX",
] as const;

/** Every SUPERTAG_* variable that overrides a file setting or that a service unit carries. */
export const SETTING_VARIABLES = [
  "SUPERTAG_GATEWAY_HOST",
  "SUPERTAG_GATEWAY_PORT",
  "SUPERTAG_COORDINATION_URL",
  "SUPERTAG_DATABASE_URL",
  "SUPERTAG_CREDENTIAL_VAULT",
  "SUPERTAG_VAULT_MOUNT",
  "SUPERTAG_VAULT_PATH_PREFIX",
  "SUPERTAG_OPERATOR_CHANNEL",
  "SUPERTAG_RPC_TRACE",
  "SUPERTAG_WORKLET_GRPC_TLS_CERT_FILE",
  "SUPERTAG_WORKLET_GRPC_TLS_KEY_FILE",
  "SUPERTAG_WORKLET_TLS_CA_FILE",
  "SUPERTAG_WORKLET_GRPC_PORT",
  "SUPERTAG_COORDINATION_OPERATORS_FILE",
] as const;

/**
 * What a hosting platform sets: with SUPERTAG_DEPLOYMENT_PLATFORM, the platform's PORT sets the
 * Control Plane's port. Never carried into a unit.
 */
const PLATFORM_VARIABLES = ["SUPERTAG_DEPLOYMENT_PLATFORM", "PORT"] as const;

/** Variables a service reads itself, not through the file: a unit needs them carried too. */
const RUNTIME_VARIABLES = ["SUPERTAG_WORKLET_TRANSPORT"] as const;

/** What a Vault credential store reads from the environment, or else env_file; never carried. */
export const VAULT_VARIABLES = ["VAULT_ADDR", "VAULT_TOKEN", "VAULT_NAMESPACE"] as const;

/**
 * Whether a setting variable's value is a secret. A database URL is one when it carries a
 * password; every other setting variable holds a port, URL, name, or path.
 */
export function isSecretSetting(name: string, value: string): boolean {
  if (name !== "SUPERTAG_DATABASE_URL") return false;
  const trimmed = value.trim();
  if (trimmed.startsWith("file:")) return false;
  try {
    const url = new URL(trimmed);
    return url.password !== "" || url.searchParams.has("password");
  } catch {
    // Unparseable: it could hide a password, so it never goes into a unit file.
    return true;
  }
}

/**
 * The non-secret SUPERTAG_* overrides in an environment, which a service unit's definition
 * carries, so a service under a unit resolves the same settings as `supertag up` did.
 */
export function unitSettings(environment: Environment): Record<string, string> {
  const carried: Record<string, string> = {};
  for (const name of [...SETTING_VARIABLES, ...RUNTIME_VARIABLES]) {
    const value = environment[name]?.trim();
    if (value && !isSecretSetting(name, value)) carried[name] = value;
  }
  return carried;
}

/**
 * A variable a service started by `supertag up` reads: from the process environment, else
 * env_file, so a service unit, which does not inherit the shell's environment, can read it from
 * ~/.supertag/.env. Values never leave memory.
 */
export function serviceVariable(
  file: Pick<ServicesFile, "envFile">,
  name: string,
  environment: Environment = process.env,
): string | undefined {
  return environment[name]?.trim() || file.envFile[name]?.trim() || undefined;
}

/** Reads a secret's value when a service starts. Values never leave memory. */
export async function readSecret(
  file: Pick<ServicesFile, "secrets" | "envFile">,
  name: string,
  environment: Environment = process.env,
): Promise<string> {
  const source = file.secrets[name];
  if (source === undefined) throw new Error(`Secret ${name} is not defined in ${SUPERTAG_YAML}`);
  if ("environment" in source) {
    const value = environment[source.environment] ?? file.envFile[source.environment];
    if (value === undefined || value === "")
      throw new Error(
        `Secret ${name} reads ${source.environment}, which is not set in the environment or an env_file`,
      );
    return value;
  }
  const value = await readFile(source.file, "utf8").catch((error: unknown) => {
    throw new Error(
      `Secret ${name} reads ${displayPath(source.file)}, which cannot be read: ${errorMessage(error)}`,
    );
  });
  if (!value.trim())
    throw new Error(`Secret ${name} reads ${displayPath(source.file)}, which is empty`);
  return value.trim();
}

/**
 * Resolves one Volume credential where it is used: on the Worker Host whose service maps it.
 * The Control Plane maps none.
 */
export async function readVolumeCredential(
  file: Pick<ServicesFile, "envFile">,
  service: Pick<HostService, "volumeCredentials">,
  name: string,
  environment: Environment = process.env,
): Promise<string | { readonly path: string }> {
  const source = service.volumeCredentials[name];
  if (source === undefined)
    throw new Error(`Volume credential ${name} is not mapped in this service's volume-credentials`);
  if ("modal-secret" in source || "modal-oidc-role" in source || "modal-volume" in source)
    throw new Error(`Volume credential ${name} is provider-held and cannot authorize copy`);
  if ("path" in source) {
    const entry = await stat(source.path);
    if (!entry.isDirectory()) throw new Error(`Volume credential ${name} path is not a directory`);
    return source;
  }
  return readSecret(
    {
      secrets: { [name]: source },
      envFile: file.envFile,
    },
    name,
    environment,
  );
}

/** Native mounts read only provider-held references, never environment or file secrets. */
export function readVolumeMountCredential(
  service: Pick<HostService, "volumeCredentials">,
  name: string,
): ModalVolumeCredential {
  return parseModalVolumeCredential(service.volumeCredentials[name]);
}

/** Advertises readable copy credentials and valid host consent for native mounts; never values. */
export async function availableHostVolumeCredentials(
  file: Pick<ServicesFile, "envFile">,
  service: Pick<HostService, "volumeCredentials">,
  environment: Environment = process.env,
): Promise<readonly string[]> {
  const names: string[] = [];
  for (const name of Object.keys(service.volumeCredentials)) {
    try {
      const source = service.volumeCredentials[name];
      if (
        source &&
        ("modal-secret" in source || "modal-oidc-role" in source || "modal-volume" in source)
      )
        readVolumeMountCredential(service, name);
      else await readVolumeCredential(file, service, name, environment);
      names.push(name);
    } catch {
      // A missing or unreadable secret must not make this host eligible for the Volume.
    }
  }
  return names;
}

/** Credential availability advertised to placement; only names are hashed, never references. */
export function hostVolumeCredentialLabels(
  service: Pick<HostService, "volumeCredentials">,
): readonly string[] {
  return Object.keys(service.volumeCredentials).map(volumeCredentialLabel);
}

/** `KEY=value` lines; `#` comments, `export `, and surrounding quotes are allowed. */
export async function readEnvFile(path: string): Promise<Record<string, string>> {
  const text = await readFile(path, "utf8");
  const values: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/u)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/u.exec(line);
    if (match === null) continue;
    let value = match[2] ?? "";
    if (/^(["']).*\1$/u.test(value)) value = value.slice(1, -1);
    else value = value.replace(/\s+#.*$/u, "");
    values[match[1] ?? ""] = value;
  }
  return values;
}

export function findService(file: ServicesFile, name: string): ServiceConfig | undefined {
  return file.services.find((service) => service.name === name);
}

export function controlPlaneOf(file: ServicesFile): ControlPlaneService | undefined {
  return file.services.find(
    (service): service is ControlPlaneService => service.type === "control-plane",
  );
}

/** Services and every service they depend on, in an order where dependencies come first. */
export function startOrder(
  file: ServicesFile,
  names?: readonly string[],
): readonly ServiceConfig[] {
  const byName = new Map(file.services.map((service) => [service.name, service]));
  for (const name of names ?? [])
    if (!byName.has(name))
      throw new Error(
        `${name} is not a service in ${file.files.length > 0 ? file.files.map((path) => displayPath(path)).join(", ") : "the defaults"}. Services: ${file.services.map((service) => service.name).join(", ")}`,
      );
  const order: ServiceConfig[] = [];
  const seen = new Set<string>();
  const visit = (name: string) => {
    if (seen.has(name)) return;
    seen.add(name);
    const service = byName.get(name);
    if (service === undefined) return;
    for (const dependency of service.dependsOn) visit(dependency);
    order.push(service);
  };
  for (const service of names === undefined || names.length === 0
    ? file.services
    : names.map((name) => byName.get(name) as ServiceConfig))
    visit(service.name);
  return order;
}

/**
 * A fingerprint of what only a restart changes: the service's resolved settings, and for a host,
 * where its Control Plane in the same file listens. Secret values are not part of it.
 */
export function serviceFingerprint(file: ServicesFile, service: ServiceConfig): string {
  const controlPlane =
    service.type === "host" && "service" in service.controlPlane ? controlPlaneOf(file) : undefined;
  const value = {
    // The source of a value never changes what runs, so an equal effective value keeps the host.
    service: {
      ...service,
      provision: undefined,
      ...(service.type === "host" ? { concurrencySource: undefined } : {}),
    },
    ...(controlPlane === undefined
      ? {}
      : {
          controlPlane: {
            ports: controlPlane.ports,
            url: controlPlane.url,
            hosts: controlPlane.hosts,
            tls: controlPlane.tls,
          },
        }),
  };
  return createHash("sha256")
    .update(JSON.stringify(sortKeys(value)))
    .digest("hex")
    .slice(0, 16);
}

/** The resolved file as `supertag config` prints it; secrets appear as `<secret: NAME>`. */
export function renderServicesFile(file: ServicesFile): string {
  const services: Record<string, unknown> = {};
  for (const service of file.services) services[service.name] = serviceValue(service);
  const value: Record<string, unknown> = { name: file.name, version: file.version, services };
  if (Object.keys(file.secrets).length > 0)
    value["secrets"] = Object.fromEntries(
      Object.entries(file.secrets).map(([name, source]) => [
        name,
        "environment" in source ? { environment: source.environment } : { file: source.file },
      ]),
    );
  const document = new Document(value);
  document.commentBefore =
    file.files.length > 0
      ? ` Resolved from ${file.files.map((path) => displayPath(path)).join(", ")}`
      : ` No ${SUPERTAG_YAML} found; these are the defaults`;
  for (const service of file.services)
    if (service.type === "host" && service.concurrencySource === "machine") {
      const node = document.getIn(["services", service.name, "concurrency"], true) as
        | { comment?: string | null }
        | undefined;
      if (node !== undefined && node !== null && typeof node === "object")
        node.comment = " from this machine's CPU cores and memory";
    }
  for (const [path, source] of file.provenance) {
    if (path.split(".").includes("mcp") && !path.split(".").includes("helper"))
      document.setIn(path.split("."), "<redacted>");
    const node = document.getIn(path.split("."), true) as { comment?: string | null } | undefined;
    if (node !== undefined && node !== null && typeof node === "object")
      node.comment = ` from ${source}`;
  }
  return formatDocument(document);
}

/** Masks a password in a database URL's user info or `password` query parameter. */
export function redactDatabaseUrl(url: string | undefined): string | undefined {
  if (url === undefined || url.startsWith("file:")) return url;
  try {
    const parsed = new URL(url);
    let changed = false;
    if (parsed.password) {
      parsed.password = "****";
      changed = true;
    }
    if (parsed.searchParams.has("password")) {
      parsed.searchParams.set("password", "****");
      changed = true;
    }
    return changed ? parsed.toString() : url;
  } catch {
    // An unparseable URL may still hold a secret; show only its scheme.
    const scheme = /^[a-z][a-z0-9+.-]*:/iu.exec(url)?.[0] ?? "";
    return `${scheme}<unreadable URL hidden>`;
  }
}

/** YAML with short lists of scalars on one line, as people write supertag.yaml. */
export function formatDocument(document: Document): string {
  visit(document, {
    Seq(_, node) {
      if (node.items.every((item) => isScalar(item))) node.flow = true;
    },
  });
  return document.toString({ lineWidth: 0, flowCollectionPadding: false });
}

/** Harnesses whose local command boundary is not enforceable; Cursor policy is workspace-writable. */
export const UNSANDBOXED_HARNESSES = [
  "claude-code",
  "cursor",
  "opencode",
] as const satisfies readonly WorkletHarness[];

/**
 * Reads `allow-unsandboxed-commands`: a list of the service's own harnesses that may run
 * commands without an enforceable sandbox boundary. Codex sandboxes its commands,
 * so listing it is an error.
 */
function parseAllowUnsandboxedCommands(
  value: unknown,
  harnesses: readonly WorkletHarness[],
  problem: (message: string) => void,
): readonly WorkletHarness[] {
  if (value === undefined || value === null) return [];
  const unsandboxed: readonly string[] = UNSANDBOXED_HARNESSES;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    problem(`must list harnesses, such as [${UNSANDBOXED_HARNESSES.join(", ")}]`);
    return [];
  }
  const allowed: WorkletHarness[] = [];
  for (const entry of new Set(value as string[])) {
    if (entry === "codex")
      problem("lists codex, which runs commands in its own OS sandbox and needs no opt-in");
    else if (!unsandboxed.includes(entry))
      problem(`lists ${entry}; list only ${UNSANDBOXED_HARNESSES.join(" or ")}`);
    else if (!harnesses.includes(entry as WorkletHarness))
      problem(`lists ${entry}, which is not in this service's harnesses`);
    else allowed.push(entry as WorkletHarness);
  }
  return allowed.sort();
}

/** The labels a host service advertises: its `labels`, plus `mcp:NAME` for each MCP server. */
export function hostServiceLabels(service: HostService): readonly string[] {
  return [...new Set([...service.labels, ...mcpServerLabels(service.mcp)])].sort();
}

/** Models each harness serves; the first is its default. */
export type HostModels = Readonly<Partial<Record<WorkletHarness, readonly string[]>>>;

/** The file form of host models: one model as a string, several as a list. */
export function modelsValue(models: HostModels): Record<string, string | string[]> {
  return Object.fromEntries(
    Object.entries(models).map(([harness, names]) => [
      harness,
      names.length === 1 ? (names[0] as string) : [...names],
    ]),
  );
}

function serviceValue(service: ServiceConfig): Record<string, unknown> {
  const secret = (name: string | undefined) =>
    name === undefined ? undefined : `<secret: ${name}>`;
  if (service.type === "host")
    return compact({
      type: "host",
      "control-plane":
        "service" in service.controlPlane ? service.controlPlane.service : service.controlPlane.url,
      "auth-key": secret(service.authKey),
      harnesses: [...service.harnesses],
      environment:
        service.environment === undefined ? undefined : hostEnvironmentValue(service.environment),
      "allow-unsandboxed-commands":
        service.allowUnsandboxedCommands.length > 0
          ? [...service.allowUnsandboxedCommands]
          : undefined,
      models: Object.keys(service.models).length > 0 ? modelsValue(service.models) : undefined,
      workspaces:
        Object.keys(service.workspaces).length > 0 ? { ...service.workspaces } : undefined,
      "local-mount-root": service.localMountRoot,
      "volume-credentials":
        Object.keys(service.volumeCredentials).length > 0
          ? { ...service.volumeCredentials }
          : undefined,
      "artifact-volume": service.artifactVolume,
      labels: service.labels.length > 0 ? [...service.labels] : undefined,
      mcp: Object.keys(service.mcp).length > 0 ? hostMcpValue(service.mcp) : undefined,
      skills: service.skills,
      concurrency: service.concurrency,
      depends_on: service.dependsOn.length > 0 ? [...service.dependsOn] : undefined,
      restart: service.restart,
    });
  return compact({
    type: "control-plane",
    ports: [formatEndpoint(service.ports)],
    url: service.url,
    database: compact({
      url: redactDatabaseUrl(service.database.url),
      password: secret(service.database.password),
    }),
    credentials: service.credentials,
    notify: service.notify,
    logging: { ...service.logging },
    tls: Object.keys(service.tls).length > 0 ? { ...service.tls } : undefined,
    hosts:
      service.hosts.grpc === undefined ? undefined : { grpc: formatEndpoint(service.hosts.grpc) },
    operators: service.operators.file === undefined ? undefined : { ...service.operators },
    restart: service.restart,
    depends_on: service.dependsOn.length > 0 ? [...service.dependsOn] : undefined,
    provision:
      service.provision.length > 0
        ? service.provision.map((entry) => ("path" in entry ? entry.path : entry.manifest))
        : undefined,
  });
}

function compact(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}

/**
 * Whether `apply -f` was given a supertag.yaml rather than resource manifests: by its name, or a
 * map without apiVersion and kind whose keys are supertag.yaml keys.
 */
export function isSupertagYamlInput(value: unknown, file?: string): boolean {
  if (file !== undefined && basename(file) === SUPERTAG_YAML) return true;
  if (!isRecord(value) || "apiVersion" in value || "kind" in value) return false;
  const known = TOP_LEVEL_KEYS as readonly string[];
  const keys = Object.keys(value);
  return keys.length > 0 && keys.every((key) => known.includes(key) || key.startsWith("x-"));
}

/** A path relative to the current directory when that is shorter, for messages. */
export function displayPath(path: string, from = process.cwd()): string {
  const shown = relative(from, path);
  return shown && !shown.startsWith("..") && !isAbsolute(shown) ? shown : path;
}

export function expandHome(path: string): string {
  const home = process.env["HOME"]?.trim() || homedir();
  return path === "~" ? home : path.startsWith("~/") ? join(home, path.slice(2)) : path;
}

function pathKey(path: readonly string[]): string {
  return JSON.stringify(path);
}

function nearest(
  positions: ReadonlyMap<string, string>,
  path: readonly string[],
): string | undefined {
  for (let length = path.length; length >= 0; length -= 1) {
    const position = positions.get(pathKey(path.slice(0, length)));
    if (position !== undefined) return position;
  }
  return undefined;
}

function at(positions: ReadonlyMap<string, string>, path: readonly string[], file: string): string {
  return nearest(positions, path) ?? displayPath(file);
}

function isHttpUrl(value: string): boolean {
  if (!/^https?:\/\/\S+$/u.test(value.trim())) return false;
  try {
    new URL(value.trim());
    return true;
  } catch {
    return false;
  }
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .toSorted(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => [key, sortKeys(entry)]),
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A service name for this machine: its hostname, sanitized to service-name rules. */
export function serviceNameFromHostname(hostname: string): string {
  const name = hostname
    .trim()
    .toLowerCase()
    .replace(/\.local$/u, "")
    .replace(/[^a-z0-9_-]+/gu, "-")
    .replace(/^[^a-z0-9]+/u, "")
    .slice(0, 63)
    .replace(/[_-]+$/u, "");
  if (!name) return "host";
  return name === DEFAULT_CONTROL_PLANE_SERVICE ? `${name}-host` : name;
}
