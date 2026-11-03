import { readFileSync } from "node:fs";

/** Response header naming the Control Plane's SuperTag version. */
export const VERSION_HEADER = "SuperTag-Version";
/** Request header naming the CLI's SuperTag version. */
export const CLIENT_VERSION_HEADER = "SuperTag-Client-Version";
/** Set to 1 to silence version skew warnings, for example in CI. */
export const NO_VERSION_WARNING_ENV = "SUPERTAG_NO_VERSION_WARNING";

function checkoutVersion(): string {
  try {
    const metadata: unknown = JSON.parse(
      readFileSync(new URL("../../../packages/supertag-ai/package.json", import.meta.url), "utf8"),
    );
    if (
      metadata &&
      typeof metadata === "object" &&
      "name" in metadata &&
      metadata.name === "supertag-ai" &&
      "version" in metadata &&
      typeof metadata.version === "string"
    )
      return metadata.version;
  } catch {
    /* Published bundles provide SUPERTAG_CLI_VERSION. */
  }
  return "unknown";
}

/** The SuperTag release this process runs, as the CLI or as the Control Plane. */
export const SUPERTAG_VERSION = process.env["SUPERTAG_CLI_VERSION"]?.trim() || checkoutVersion();

interface ParsedVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly prerelease: readonly string[];
}

export function parseVersion(value: string): ParsedVersion | undefined {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/u.exec(
    value.trim(),
  );
  if (match === null) return undefined;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] === undefined ? [] : match[4].split("."),
  };
}

/**
 * How far apart two releases are. `none` and `patch` need no warning; `prerelease` and a
 * one-minor difference after 1.0 are supported with a warning; anything wider is unsupported.
 */
export type VersionSkew = "none" | "patch" | "prerelease" | "minor" | "major" | "unknown";
export type VersionSupport = "supported" | "supported-with-warning" | "unsupported" | "unknown";

export interface VersionSkewAssessment {
  readonly skew: VersionSkew;
  readonly support: VersionSupport;
}

/** Applies the skew policy in docs/reference/api-stability.md. */
export function assessVersionSkew(
  cliVersion: string,
  controlPlaneVersion: string | undefined,
): VersionSkewAssessment {
  if (controlPlaneVersion === undefined) return { skew: "unknown", support: "unknown" };
  if (cliVersion === controlPlaneVersion) return { skew: "none", support: "supported" };
  const cli = parseVersion(cliVersion);
  const controlPlane = parseVersion(controlPlaneVersion);
  if (cli === undefined || controlPlane === undefined)
    return { skew: "unknown", support: "unknown" };
  if (cli.major !== controlPlane.major) return { skew: "major", support: "unsupported" };
  if (cli.minor !== controlPlane.minor) {
    // Before 1.0, a minor release may break compatibility the way a major release does later.
    const adjacent = cli.major > 0 && Math.abs(cli.minor - controlPlane.minor) === 1;
    return { skew: "minor", support: adjacent ? "supported-with-warning" : "unsupported" };
  }
  const prerelease =
    cli.prerelease.join(".") !== controlPlane.prerelease.join(".") ||
    (cli.patch !== controlPlane.patch &&
      (cli.prerelease.length > 0 || controlPlane.prerelease.length > 0));
  if (prerelease) return { skew: "prerelease", support: "supported-with-warning" };
  if (cli.patch !== controlPlane.patch) return { skew: "patch", support: "supported" };
  return { skew: "none", support: "supported" };
}

/** Semantic version precedence; undefined when either version is unparseable. */
export function compareVersions(left: string, right: string): number | undefined {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (a === undefined || b === undefined) return undefined;
  for (const key of ["major", "minor", "patch"] as const)
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
  // A release sorts after its own prereleases.
  if (a.prerelease.length === 0 && b.prerelease.length === 0) return 0;
  if (a.prerelease.length === 0) return 1;
  if (b.prerelease.length === 0) return -1;
  for (let index = 0; index < Math.max(a.prerelease.length, b.prerelease.length); index += 1) {
    const x = a.prerelease[index];
    const y = b.prerelease[index];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    const xNumeric = /^\d+$/u.test(x);
    const yNumeric = /^\d+$/u.test(y);
    if (xNumeric && yNumeric) return Number(x) < Number(y) ? -1 : 1;
    if (xNumeric !== yNumeric) return xNumeric ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

function upgradeAdvice(cliVersion: string, controlPlaneVersion: string): string {
  return compareVersions(cliVersion, controlPlaneVersion) === -1
    ? "upgrade the CLI or use one that matches the Control Plane"
    : "upgrade the Control Plane or use a matching CLI";
}

/** The warning for a skewed pair, or undefined when the pair needs none. */
export function versionSkewWarning(
  cliVersion: string,
  controlPlaneVersion: string | undefined,
): string | undefined {
  if (controlPlaneVersion === undefined) return undefined;
  const { support } = assessVersionSkew(cliVersion, controlPlaneVersion);
  if (support !== "supported-with-warning" && support !== "unsupported") return undefined;
  const pair = `this CLI is ${cliVersion} but the Control Plane is ${controlPlaneVersion}`;
  const advice = upgradeAdvice(cliVersion, controlPlaneVersion);
  return support === "unsupported"
    ? `Warning: ${pair}, and SuperTag does not support this pair. Commands may fail; ${advice}.\n`
    : `Warning: ${pair}. Some commands may fail; ${advice}.\n`;
}

/**
 * A hint for a Control Plane that rejected a request it may not understand. Undefined when both
 * sides run the same version, since the rejection then has another cause.
 */
export function versionMismatchHint(
  cliVersion: string,
  controlPlaneVersion: string | undefined,
): string | undefined {
  if (controlPlaneVersion === cliVersion) return undefined;
  if (controlPlaneVersion === undefined)
    return `Hint: this CLI is ${cliVersion} and the Control Plane does not report its version, so it is probably older and may not support this request. Upgrade the Control Plane or use a matching CLI.`;
  const advice = upgradeAdvice(cliVersion, controlPlaneVersion);
  return `Hint: this CLI is ${cliVersion} but the Control Plane is ${controlPlaneVersion}, which may not support this request. ${advice.charAt(0).toUpperCase()}${advice.slice(1)}.`;
}

export function versionWarningSuppressed(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  const value = environment[NO_VERSION_WARNING_ENV]?.trim().toLowerCase();
  return value !== undefined && value !== "" && value !== "0" && value !== "false";
}

let warnedThisCommand = false;

/** Starts a new command, which may print its own skew warning. */
export function resetVersionSkewWarning(): void {
  warnedThisCommand = false;
}

/** Prints the skew warning to stderr at most once per command. */
export function warnOnVersionSkew(
  controlPlaneVersion: string | undefined,
  cliVersion: string = SUPERTAG_VERSION,
): void {
  if (warnedThisCommand || versionWarningSuppressed()) return;
  const warning = versionSkewWarning(cliVersion, controlPlaneVersion);
  if (warning === undefined) return;
  warnedThisCommand = true;
  process.stderr.write(warning);
}
