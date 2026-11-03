import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

export const MANAGER_ISOLATION_LIVE_ENV = "SUPERTAG_LIVE_MANAGER_ISOLATION";

export type IsolationHarness = "claude-code" | "opencode";
export type SchemaIsolation = "guarded" | "hard";

export interface BinaryPreflight {
  readonly command: string;
  readonly expectedVersion: string;
  readonly observedVersion?: string;
  readonly compatible: boolean;
  readonly source: "bundled" | "configured";
  readonly error?: string;
}

export interface IsolationObservations {
  readonly listRequests: number;
  readonly rootCallObserved: boolean;
  readonly childCallObserved: boolean;
  readonly childReportedToolVisible?: boolean;
  readonly childReportedCredentialVisible?: boolean;
  readonly outputContainedCredential: boolean;
  readonly nativeChildrenObserved: number;
}

export interface ManagerIsolationManifest {
  readonly version: 1;
  readonly runId: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly harness: IsolationHarness;
  readonly model: string;
  readonly expected: {
    readonly managerOnly: true;
    readonly schemaIsolation: SchemaIsolation;
    readonly credentialIsolation: "hard";
    readonly invocationIsolation: "hard";
  };
  readonly preflight: BinaryPreflight;
  readonly observations?: IsolationObservations;
  readonly coverageLimitations?: readonly string[];
  readonly status: "passed" | "failed" | "unavailable";
  readonly reason?: string;
}

export interface ProbeCliOptions {
  readonly harness: IsolationHarness;
  readonly model: string;
  readonly output: string;
  readonly executable?: string;
  readonly authFile?: string;
}

const PINNED = {
  "claude-code": { packageVersion: "0.3.220", binaryVersion: "2.1.220" },
  opencode: { binaryVersion: "1.1.48" },
} as const;

export function parseProbeCli(
  values: Readonly<Record<string, string | boolean | undefined>>,
  environment: NodeJS.ProcessEnv,
): ProbeCliOptions {
  if (values["live"] !== true || environment[MANAGER_ISOLATION_LIVE_ENV] !== "1") {
    throw new Error(
      `Manager isolation verification requires both --live and ${MANAGER_ISOLATION_LIVE_ENV}=1`,
    );
  }
  const harness = values["harness"];
  if (harness === "codex") {
    throw new Error("Codex native subagents are disabled until child tool inheritance is isolated");
  }
  if (harness !== "claude-code" && harness !== "opencode") {
    throw new Error("Select --harness claude-code or opencode");
  }
  if (typeof values["output"] !== "string" || !values["output"].trim()) {
    throw new Error("Pass --output so the live verification manifest has an explicit destination");
  }
  if (values["executable"] !== undefined && harness !== "opencode") {
    throw new Error("--executable is supported only for the pinned OpenCode preflight");
  }
  if (values["auth-file"] !== undefined && harness === "claude-code") {
    throw new Error("Claude Code uses its configured authentication, not --auth-file");
  }
  const model =
    typeof values["model"] === "string" && values["model"].trim()
      ? values["model"].trim()
      : harness === "claude-code"
        ? "haiku"
        : undefined;
  if (!model) throw new Error("OpenCode requires --model provider/model");
  if (harness === "opencode" && !/^[^\s/]+\/[^\s]+$/u.test(model)) {
    throw new Error("OpenCode requires --model provider/model");
  }
  return {
    harness,
    model,
    output: values["output"],
    ...(typeof values["executable"] === "string" ? { executable: values["executable"] } : {}),
    ...(typeof values["auth-file"] === "string" ? { authFile: values["auth-file"] } : {}),
  };
}

export function isolationExpectation(_harness: IsolationHarness) {
  return {
    managerOnly: true as const,
    schemaIsolation: "hard" as SchemaIsolation,
    credentialIsolation: "hard" as const,
    invocationIsolation: "hard" as const,
  };
}

export function assessIsolation(
  _harness: IsolationHarness,
  preflight: BinaryPreflight,
  observations: IsolationObservations,
): Pick<ManagerIsolationManifest, "status" | "reason"> {
  if (!preflight.compatible) {
    return { status: "failed", reason: "Pinned binary preflight failed closed" };
  }
  const failures = [
    observations.listRequests < 1 ? "manager did not list the fake coordination tool" : undefined,
    !observations.rootCallObserved ? "manager did not call the fake coordination tool" : undefined,
    observations.childReportedToolVisible === undefined ||
    observations.childReportedCredentialVisible === undefined
      ? "native child did not return the required structured isolation report"
      : undefined,
    observations.childCallObserved ? "native child invoked the manager-only tool" : undefined,
    observations.childReportedCredentialVisible
      ? "native child reported access to the credential canary"
      : undefined,
    observations.outputContainedCredential
      ? "provider output contained the credential canary"
      : undefined,
    observations.childReportedToolVisible
      ? "native child reported seeing a hard-isolated tool schema"
      : undefined,
  ].filter((value): value is string => value !== undefined);
  return failures.length ? { status: "failed", reason: failures.join("; ") } : { status: "passed" };
}

export function sanitizeProbeText(value: string, credential: string): string {
  return value.split(credential).join("[REDACTED]").slice(0, 4096);
}

export function parseChildReport(output: string): {
  childReportedToolVisible?: boolean;
  childReportedCredentialVisible?: boolean;
} {
  const matches = [...output.matchAll(/CHILD_ISOLATION_REPORT\s+(\{[^\n]+\})/gu)];
  const encoded = matches.at(-1)?.[1];
  if (!encoded) return {};
  try {
    const parsed: unknown = JSON.parse(encoded);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const record = parsed as Record<string, unknown>;
    return {
      ...(typeof record["toolVisible"] === "boolean"
        ? { childReportedToolVisible: record["toolVisible"] }
        : {}),
      ...(typeof record["credentialVisible"] === "boolean"
        ? { childReportedCredentialVisible: record["credentialVisible"] }
        : {}),
    };
  } catch {
    return {};
  }
}

export function isProviderUnavailable(message: string): boolean {
  return /auth|credential|login|api key|oauth|rate limit|quota|session failed|model.*(?:unavailable|not found)|provider/iu.test(
    message,
  );
}

export async function preflightPinnedBinary(
  harness: IsolationHarness,
  configuredExecutable?: string,
): Promise<BinaryPreflight> {
  let command = configuredExecutable ?? harness;
  let source: BinaryPreflight["source"] = "configured";
  const expectedVersion = PINNED[harness].binaryVersion;
  try {
    if (harness === "claude-code") {
      const resolved = resolveBundledClaude();
      command = resolved.command;
      source = "bundled";
      if (resolved.packageVersion !== PINNED["claude-code"].packageVersion) {
        return {
          command,
          source,
          expectedVersion,
          observedVersion: resolved.packageVersion,
          compatible: false,
          error: "Installed Claude Agent SDK package does not match the probe pin",
        };
      }
    } else {
      command = configuredExecutable ?? "opencode";
    }
    const result = await promisify(execFile)(command, ["--version"], { timeout: 10_000 });
    const observedVersion = versionFromOutput(`${result.stdout}\n${result.stderr}`);
    return {
      command,
      source,
      expectedVersion,
      ...(observedVersion ? { observedVersion } : {}),
      compatible: observedVersion === expectedVersion,
      ...(observedVersion === expectedVersion
        ? {}
        : { error: `Expected ${expectedVersion}, observed ${observedVersion ?? "no version"}` }),
    };
  } catch (error) {
    return {
      command,
      source,
      expectedVersion,
      compatible: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function versionFromOutput(output: string): string | undefined {
  return output.match(/\b(\d+\.\d+\.\d+)\b/u)?.[1];
}

function resolveBundledClaude(): { command: string; packageVersion: string } {
  const requireFromHarness = createRequire(
    new URL("../packages/runtime/harnesses/claude-code/package.json", import.meta.url),
  );
  const sdkEntry = requireFromHarness.resolve("@anthropic-ai/claude-agent-sdk");
  const sdkManifest = join(dirname(sdkEntry), "package.json");
  const sdkPackage = createRequire(sdkManifest)(sdkManifest) as { version?: string };
  if (!sdkPackage.version) throw new Error("Claude Agent SDK version is unavailable");
  const report = process.platform === "linux" ? process.report.getReport() : undefined;
  const musl =
    report !== undefined &&
    !(report as { header?: { glibcVersionRuntime?: string } }).header?.glibcVersionRuntime;
  const suffix = `${process.platform}-${process.arch}${musl ? "-musl" : ""}`;
  const command = createRequire(sdkEntry).resolve(
    `@anthropic-ai/claude-agent-sdk-${suffix}/${process.platform === "win32" ? "claude.exe" : "claude"}`,
  );
  return { command, packageVersion: sdkPackage.version };
}

export function newProbeIdentity() {
  const runId = randomUUID();
  return {
    runId,
    nonce: randomUUID(),
    credential: `supertag-isolation-canary-${randomUUID()}`,
  };
}
