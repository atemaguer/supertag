import { createHash } from "node:crypto";
import { TagMessagingError } from "./mailbox.js";

/**
 * Worker Host labels decide placement, never access. A Tag's Worker Host bindings say which
 * hosts may run its Tasks; its `runsOn` labels narrow those to hosts that carry every label.
 * Labels a host advertises are self-reported, so they must never grant authority.
 */

/** Most labels one host, Auth Key, or Tag may carry. */
export const MAX_WORKER_HOST_LABELS = 64;
const LABEL = /^[a-z0-9][a-z0-9._:-]{0,62}$/u;
const LABEL_RULE =
  "1-63 lowercase letters, digits, dots, colons, hyphens, or underscores, starting with a letter or digit";

/** Normalizes one label to lowercase and validates it. Matching is exact after normalization. */
export function parseWorkerHostLabel(value: unknown, field = "Label"): string {
  const label = typeof value === "string" ? value.trim().toLowerCase() : undefined;
  if (label === undefined || !LABEL.test(label))
    throw new TagMessagingError(
      400,
      `${field} ${JSON.stringify(value)} is invalid; a label is ${LABEL_RULE}`,
    );
  return label;
}

/** Normalizes, de-duplicates, and sorts a label list. */
export function parseWorkerHostLabels(values: unknown, field = "labels"): readonly string[] {
  if (!Array.isArray(values)) throw new TagMessagingError(400, `${field} must be an array`);
  const labels = [...new Set(values.map((value) => parseWorkerHostLabel(value, `${field} entry`)))];
  if (field !== "Tag runsOn" && field !== "Tag spec.runsOn")
    for (const label of labels)
      if (label.startsWith("mcp:"))
        throw new TagMessagingError(
          400,
          `${field}: mcp: labels come from host service configuration`,
        );
  for (const label of labels)
    if (label.startsWith("volume-credential:") || label.startsWith(ARTIFACT_VOLUME_LABEL_PREFIX))
      throw new TagMessagingError(
        400,
        `${field}: ${label.startsWith("volume-credential:") ? "volume-credential:" : ARTIFACT_VOLUME_LABEL_PREFIX} labels come from host service configuration`,
      );
  for (const label of labels)
    if (label.startsWith(MCP_LOGIN_LABEL_PREFIX))
      throw new TagMessagingError(400, `${field}: mcp-login: labels come from host MCP logins`);
  if (labels.length > MAX_WORKER_HOST_LABELS)
    throw new TagMessagingError(400, `${field} may list at most ${MAX_WORKER_HOST_LABELS} labels`);
  return labels.sort();
}

/** The automatic label for a declared checkout of a Workspace. */
export function workspaceLabel(workspace: string): string {
  return `workspace:${workspace}`;
}

/** An internal host advertisement for a configured Volume credential name. */
export function volumeCredentialLabel(name: string): string {
  return `volume-credential:${createHash("sha256").update(name).digest("hex").slice(0, 32)}`;
}

/** The prefix of the internal advertisement for a Worker Host's artifact Volume. */
export const ARTIFACT_VOLUME_LABEL_PREFIX = "artifact-volume:";

/**
 * An internal host advertisement for the Volume a Worker Host stores its artifacts on, from a
 * host service's `artifact-volume` or `connect worklet --artifact-volume`. Like
 * {@link volumeCredentialLabel}, it carries a digest of the name, never the name or a location.
 * It is self-reported: the Control Plane uses it to keep Workspaces from mounting the Volume and
 * to accept the host's receipts for copies on it, never to grant access to an artifact.
 */
export function artifactVolumeLabel(name: string): string {
  return `${ARTIFACT_VOLUME_LABEL_PREFIX}${createHash("sha256").update(name).digest("hex").slice(0, 32)}`;
}

/** The automatic label for a harness a Worker Host runs. */
export function harnessLabel(harness: string): string {
  return `harness:${harness.toLowerCase()}`;
}

/** The label prefix for MCP servers a host provides. */
export const MCP_SERVER_LABEL_PREFIX = "mcp:";

/** The automatic label for an MCP server a host service provides. */
export function mcpServerLabel(server: string): string {
  return `${MCP_SERVER_LABEL_PREFIX}${server}`;
}

/** The MCP server a `mcp:NAME` label names, or undefined for other labels. */
export function mcpServerOfLabel(label: string): string | undefined {
  return label.startsWith(MCP_SERVER_LABEL_PREFIX) && label.length > MCP_SERVER_LABEL_PREFIX.length
    ? label.slice(MCP_SERVER_LABEL_PREFIX.length)
    : undefined;
}

/**
 * The label prefix a host advertises, instead of `mcp:NAME`, for an `auth: { oauth: true }`
 * server whose login lapsed. Tasks that need the server are held with its login command.
 */
export const MCP_LOGIN_LABEL_PREFIX = "mcp-login:";

/** The label for a host MCP server that needs `supertag mcp login NAME`. */
export function mcpLoginLabel(server: string): string {
  return `${MCP_LOGIN_LABEL_PREFIX}${server}`;
}

/** The MCP server a `mcp-login:NAME` label names, or undefined for other labels. */
export function mcpServerOfLoginLabel(label: string): string | undefined {
  const server = label.startsWith(MCP_LOGIN_LABEL_PREFIX)
    ? label.slice(MCP_LOGIN_LABEL_PREFIX.length)
    : "";
  return /^[a-z0-9][a-z0-9_-]{0,58}$/u.test(server) ? server : undefined;
}

/** `linux`, `macos`, or `windows` for a Node.js platform name; other valid names pass through. */
export function operatingSystemLabel(platform: string): string | undefined {
  const known: Readonly<Record<string, string>> = {
    darwin: "macos",
    linux: "linux",
    win32: "windows",
  };
  return known[platform] ?? validLabel(platform);
}

/** `x64` or `arm64` for a Node.js architecture name; other valid names pass through. */
export function architectureLabel(arch: string): string | undefined {
  return validLabel(arch);
}

/** Labels a Worklet advertises without configuration. */
export function automaticWorkerHostLabels(input: {
  readonly platform?: string;
  readonly arch?: string;
  readonly harnesses?: readonly string[];
  readonly workspaces?: readonly string[];
}): readonly string[] {
  const labels = [
    input.platform === undefined ? undefined : operatingSystemLabel(input.platform),
    input.arch === undefined ? undefined : architectureLabel(input.arch),
    ...(input.harnesses ?? []).map((harness) => validLabel(harnessLabel(harness))),
    ...(input.workspaces ?? []).map(workspaceLabel),
  ];
  return [...new Set(labels.filter((label): label is string => label !== undefined))].sort();
}

/**
 * Labels a host advertised in its descriptor: its explicit `labels`, plus `workspace:NAME` for
 * each declared checkout and `harness:NAME` for each harness its profiles report.
 */
export function advertisedWorkerHostLabels(
  descriptor: Readonly<Record<string, unknown>>,
): readonly string[] {
  const labels = new Set<string>();
  const explicit = descriptor["labels"];
  if (Array.isArray(explicit))
    for (const value of explicit) {
      const label =
        typeof value !== "string"
          ? undefined
          : (validLabel(value) ?? (mcpServerOfLoginLabel(value) === undefined ? undefined : value));
      if (label !== undefined) labels.add(label);
    }
  const workspaces = descriptor["workspaces"];
  if (Array.isArray(workspaces))
    for (const name of workspaces)
      if (typeof name === "string" && WORKSPACE_NAME.test(name)) labels.add(workspaceLabel(name));
  const workers = descriptor["workers"];
  if (Array.isArray(workers))
    for (const worker of workers) {
      const supports = isRecord(worker) ? worker["profileCapabilities"] : undefined;
      if (!Array.isArray(supports)) continue;
      for (const support of supports) {
        const harness = isRecord(support) ? support["harness"] : undefined;
        const label = typeof harness === "string" ? validLabel(harnessLabel(harness)) : undefined;
        if (label !== undefined) labels.add(label);
      }
    }
  return [...labels].sort();
}

/** Every label a host carries: advertised labels plus labels granted by its Auth Key. */
export function effectiveWorkerHostLabels(
  descriptor: Readonly<Record<string, unknown>>,
  grantedLabels: readonly string[] = [],
): readonly string[] {
  return [...new Set([...advertisedWorkerHostLabels(descriptor), ...grantedLabels])].sort();
}

/** Required labels a host does not carry, in the order they were required. */
export function missingWorkerHostLabels(
  required: readonly string[],
  carried: readonly string[],
): readonly string[] {
  const have = new Set(carried);
  return required.filter((label) => !have.has(label));
}

/** Scheduling requirement recorded when no bound host carries the listed labels. */
export function workerHostLabelRequirement(missing: readonly string[]): string {
  return `labels:${missing.join(",")}`;
}

const WORKSPACE_NAME = /^[a-z0-9][a-z0-9_-]{0,62}$/u;

function validLabel(value: string): string | undefined {
  const label = value.trim().toLowerCase();
  return LABEL.test(label) ? label : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
