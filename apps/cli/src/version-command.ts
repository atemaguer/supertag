import { parseArgs } from "node:util";
import { SUPERTAG_BUILD_IDENTITY } from "./build-identity.js";
import { resolveControlPlaneUrl } from "./control-plane-client.js";
import {
  assessVersionSkew,
  CLIENT_VERSION_HEADER,
  SUPERTAG_VERSION,
  VERSION_HEADER,
  type VersionSkew,
  type VersionSupport,
} from "./version.js";

export interface ControlPlaneVersionReport {
  readonly url?: string;
  readonly reachable: boolean;
  /** Absent when the Control Plane is unreachable or predates version reporting. */
  readonly version?: string;
  readonly buildIdentity?: string;
  readonly skew?: VersionSkew;
  readonly support?: VersionSupport;
  readonly error?: string;
}

export interface VersionReport {
  readonly cli: { readonly version: string; readonly buildIdentity: string };
  readonly controlPlane: ControlPlaneVersionReport;
}

/** `supertag version`: this CLI's version, and the selected Control Plane's when it answers. */
export async function runVersionCommand(
  args: readonly string[],
  controlPlaneOverride?: string,
): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...args],
    allowPositionals: true,
    options: {
      output: { type: "string", short: "o", default: "text" },
      help: { type: "boolean", short: "h" },
    },
    strict: true,
  });
  if (values.help) {
    process.stdout.write(versionHelp());
    return 0;
  }
  if (positionals.length > 0) throw new Error(`Usage: supertag version [--output text|json]`);
  if (values.output !== "text" && values.output !== "json")
    throw new Error("--output must be text or json");
  const report = await versionReport(controlPlaneOverride);
  process.stdout.write(
    values.output === "json" ? `${JSON.stringify(report, null, 2)}\n` : formatVersionReport(report),
  );
  return 0;
}

export async function versionReport(controlPlaneOverride?: string): Promise<VersionReport> {
  const cli = { version: SUPERTAG_VERSION, buildIdentity: SUPERTAG_BUILD_IDENTITY };
  let url: string | undefined;
  try {
    url = await versionTargetUrl(controlPlaneOverride);
  } catch (error) {
    return { cli, controlPlane: { reachable: false, error: errorMessage(error) } };
  }
  if (url === undefined) return { cli, controlPlane: { reachable: false } };
  const probe = await probeControlPlaneVersion(url);
  if (!probe.reachable) return { cli, controlPlane: { url, reachable: false, error: probe.error } };
  const { skew, support } = assessVersionSkew(SUPERTAG_VERSION, probe.version);
  return {
    cli,
    controlPlane: {
      url,
      reachable: true,
      ...(probe.version === undefined ? {} : { version: probe.version }),
      ...(probe.buildIdentity === undefined ? {} : { buildIdentity: probe.buildIdentity }),
      skew,
      support,
    },
  };
}

/** The Control Plane other commands use. */
async function versionTargetUrl(override?: string): Promise<string | undefined> {
  return resolveControlPlaneUrl(override);
}

/**
 * Reads the version from the unauthenticated health endpoint, so it needs no credential. A
 * reachable Control Plane without the header predates version reporting.
 */
export async function probeControlPlaneVersion(
  url: string,
  timeoutMs = 5_000,
): Promise<
  | { readonly reachable: true; readonly version?: string; readonly buildIdentity?: string }
  | { readonly reachable: false; readonly error: string }
> {
  try {
    const response = await fetch(new URL("/healthz", `${url}/`), {
      headers: { [CLIENT_VERSION_HEADER]: SUPERTAG_VERSION },
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
    const header = response.headers.get(VERSION_HEADER)?.trim();
    const body: unknown = await response.json().catch(() => undefined);
    const reported =
      header ||
      (typeof body === "object" &&
      body !== null &&
      "version" in body &&
      typeof body.version === "string"
        ? body.version
        : undefined);
    const buildIdentity =
      typeof body === "object" &&
      body !== null &&
      "buildIdentity" in body &&
      typeof body.buildIdentity === "string"
        ? body.buildIdentity
        : undefined;
    return {
      reachable: true,
      ...(reported ? { version: reported } : {}),
      ...(buildIdentity ? { buildIdentity } : {}),
    };
  } catch (error) {
    return { reachable: false, error: errorMessage(error) };
  }
}

export function formatVersionReport(report: VersionReport): string {
  const lines = [`CLI version: ${report.cli.version}`, `CLI build: ${report.cli.buildIdentity}`];
  const controlPlane = report.controlPlane;
  if (controlPlane.url === undefined) {
    lines.push(`Control Plane: none found${controlPlane.error ? ` (${controlPlane.error})` : ""}`);
  } else if (!controlPlane.reachable) {
    lines.push(
      `Control Plane: ${controlPlane.url} (not reachable${controlPlane.error ? `: ${controlPlane.error}` : ""})`,
    );
  } else {
    lines.push(`Control Plane: ${controlPlane.url}`);
    lines.push(
      `Control Plane version: ${controlPlane.version ?? "unknown (it predates version reporting)"}`,
    );
    lines.push(`Control Plane build: ${controlPlane.buildIdentity ?? "unknown"}`);
    lines.push(`Compatibility: ${describeCompatibility(controlPlane, report.cli.version)}`);
  }
  return `${lines.join("\n")}\n`;
}

function describeCompatibility(controlPlane: ControlPlaneVersionReport, cli: string): string {
  const major = cli.split(".")[0];
  switch (controlPlane.skew) {
    case "none":
      return "supported (same version)";
    case "patch":
      return "supported (patch releases differ)";
    case "prerelease":
      return "supported with a warning (prereleases differ)";
    case "minor":
      return controlPlane.support === "supported-with-warning"
        ? "supported with a warning (one minor release apart)"
        : major === "0"
          ? "not supported (before 1.0, each minor release may break compatibility)"
          : "not supported (more than one minor release apart)";
    case "major":
      return "not supported (major releases differ)";
    default:
      return controlPlane.version === undefined
        ? "unknown (upgrade the Control Plane to compare versions)"
        : "unknown (a version is not a release number)";
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    const cause = error.cause;
    if (cause instanceof Error && cause.message) return cause.message;
    return error.message;
  }
  return String(error);
}

export function versionHelp(): string {
  return `Usage: supertag version [--output text|json]

Prints this CLI's version and build identity. When a Control Plane is selected or found, also
prints its URL, version, build identity, and whether SuperTag supports the pair. The Control Plane is the one other commands use:
--control-plane, SUPERTAG_CONTROL_PLANE, the project's supertag.yaml, or the saved connection.
Reading its version needs no credential.

supertag --version prints only the CLI version.
Set SUPERTAG_NO_VERSION_WARNING=1 to silence version skew warnings from other commands.
`;
}
