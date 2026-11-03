import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { minimalProcessEnvironment } from "@supertag/worker-sdk";

export type CursorSignInStatus =
  | "signed-in"
  | "invalid-key"
  | "no-models"
  | "verification-failed"
  | "cli-login-only"
  | "logged-out"
  | "missing-cli"
  | "probe-failed";

export interface CursorSignInResult {
  readonly signedIn: boolean;
  readonly status: CursorSignInStatus;
  readonly message: string;
}

export type CursorModelVerifier = (
  apiKey?: string,
) => Promise<
  | { readonly status: "ok"; readonly models: readonly string[] }
  | { readonly status: "invalid-key" }
  | { readonly status: "error" }
>;

export type CursorProbeExec = (
  command: string,
  args: readonly string[],
  options: {
    readonly timeout: number;
    readonly killSignal: "SIGKILL";
    readonly maxBuffer: number;
    readonly env: NodeJS.ProcessEnv;
  },
) => Promise<{ readonly stdout: string }>;

const execFileAsync = promisify(execFile);
const defaultExec: CursorProbeExec = (command, args, options) =>
  execFileAsync(command, [...args], options);

const sdkAdvice = "Set CURSOR_API_KEY for the Worker Host.";

/**
 * The bundled runner requires CURSOR_API_KEY; a Cursor CLI login does not supply it.
 * See https://cursor.com/docs/sdk/typescript.md and
 * https://cursor.com/docs/cli/reference/authentication.md.
 */
export async function checkCursorSignIn(options: {
  readonly verifyModels: CursorModelVerifier;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly exec?: CursorProbeExec;
  readonly timeoutMs?: number;
}): Promise<CursorSignInResult> {
  const environment = options.environment ?? process.env;
  const apiKey = environment["CURSOR_API_KEY"]?.trim();
  if (apiKey) {
    try {
      const verification = await options.verifyModels(apiKey);
      if (verification.status === "invalid-key")
        return result("invalid-key", "Cursor API key is invalid. Replace CURSOR_API_KEY.");
      if (verification.status === "error")
        return result(
          "verification-failed",
          "Could not verify Cursor SDK sign-in or model access.",
        );
      if (verification.models.length === 0)
        return result("no-models", "Cursor SDK sign-in works, but no models are available.");
      return result("signed-in", "Cursor SDK sign-in and model access verified.", true);
    } catch {
      // SDK exceptions may contain credentials. Return only a fixed message.
      return result("verification-failed", "Could not verify Cursor SDK sign-in or model access.");
    }
  }

  const probe = options.exec ?? defaultExec;
  const requestedTimeout = options.timeoutMs;
  const probeOptions = {
    timeout:
      requestedTimeout !== undefined && Number.isFinite(requestedTimeout) && requestedTimeout > 0
        ? requestedTimeout
        : 5_000,
    killSignal: "SIGKILL" as const,
    maxBuffer: 64 * 1024,
    env: minimalProcessEnvironment(environment),
  };
  let command = "cursor-agent";
  try {
    await probe(command, ["--version"], probeOptions);
  } catch (error) {
    if (!isMissingBinary(error))
      return result("probe-failed", `Cursor CLI probe failed. ${sdkAdvice}`);
    command = "agent";
    try {
      const about = await probe(command, ["about", "--format", "json"], probeOptions).catch(
        () => undefined,
      );
      const identified = about !== undefined && identifiesCursor(about.stdout);
      const version = identified
        ? undefined
        : await probe(command, ["--version"], probeOptions).catch(() => undefined);
      if (!identified && (version === undefined || !identifiesCursor(version.stdout)))
        return result("missing-cli", `Cursor CLI was not found. ${sdkAdvice}`);
    } catch {
      return result("missing-cli", `Cursor CLI was not found. ${sdkAdvice}`);
    }
  }
  try {
    const { stdout } = await probe(command, ["status", "--format", "json"], probeOptions);
    const parsed: unknown = JSON.parse(stdout);
    if (!isRecord(parsed) || typeof parsed["isAuthenticated"] !== "boolean")
      return result("probe-failed", `Cursor CLI returned an invalid status. ${sdkAdvice}`);
    if (parsed["isAuthenticated"])
      return result(
        "cli-login-only",
        `Cursor CLI is signed in, but the Cursor SDK runner needs CURSOR_API_KEY.`,
      );
    return result("logged-out", `Cursor CLI is signed out. ${sdkAdvice}`);
  } catch {
    // CLI stdout/stderr may contain account or credential data.
    return result("probe-failed", `Could not check Cursor CLI sign-in. ${sdkAdvice}`);
  }
}

function result(status: CursorSignInStatus, message: string, signedIn = false): CursorSignInResult {
  return { status, message, signedIn };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isMissingBinary(value: unknown): boolean {
  return isRecord(value) && value["code"] === "ENOENT";
}

function identifiesCursor(output: string): boolean {
  try {
    const about: unknown = JSON.parse(output);
    return (
      isRecord(about) &&
      ["name", "product", "application", "cli"].some((field) => isCursorName(about[field]))
    );
  } catch {
    return isCursorName(output.trim());
  }
}

function isCursorName(value: unknown): boolean {
  return typeof value === "string" && /^cursor(?:[- ]agent)?\b/i.test(value.trim());
}
