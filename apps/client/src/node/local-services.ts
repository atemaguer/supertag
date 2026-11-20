/**
 * The local services, run with the `supertag` CLI, as the desktop app and the terminal UI share
 * them.
 *
 * Later launches: when this user's SuperTag is set up but its services are stopped, a front end
 * starts them with `supertag up`, then connects. When the local Gateway runs an older release, it
 * offers to restart it with its own CLI: `supertag down`, then `supertag up`, which migrates the
 * database. First launch: it checks a project folder and the harnesses with
 * `supertag init --check --json`, then runs `supertag init --yes`, so no front end repeats init's
 * logic.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import type { LocalDiscovery } from "./local";
import { createGatewayClient, ProtocolMismatchError } from "./sdk";

/** What a finished CLI run printed. */
export interface Ran {
  success: boolean;
  stdout: string;
  stderr: string;
}

/** The most of a failed command's output a front end shows. */
export const MAX_REASON_CHARS = 600;

export interface RunOptions {
  /** The PATH the CLI and what it starts run with; the environment's own when absent. */
  path?: string | undefined;
  /** The environment it runs with; this process's when absent. */
  env?: NodeJS.ProcessEnv | undefined;
  /** The directory it runs in. */
  cwd?: string | undefined;
  /** How long it may take before it is killed. */
  timeoutMs: number;
  /** What it says when it outlasts `timeoutMs`. */
  timedOut?: string;
}

/**
 * Runs `cli ARGS` with no input, collecting its output. Rejects with a user-facing string when
 * it can't start or outlasts its limit; a run that exits unsuccessfully resolves with
 * `success: false`.
 */
export function runSupertag(
  cli: string,
  args: readonly string[],
  options: RunOptions,
): Promise<Ran> {
  return new Promise((resolve, reject) => {
    const env = { ...(options.env ?? process.env) };
    if (options.path !== undefined) env["PATH"] = options.path;
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(cli, args, { cwd: options.cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      reject(`Could not run ${cli}: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(options.timedOut ?? `supertag ${args[0] ?? ""} did not finish in time.`);
    }, options.timeoutMs);
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(`Could not run ${cli}: ${error.message}`);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        success: code === 0,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
  });
}

const CONTROL = /\p{Cc}/gu;

/** The last lines of a failed command's output, as one bounded reason. */
export function failureReason(ran: Ran): string {
  const text = ran.stderr.trim() === "" ? ran.stdout : ran.stderr;
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  const tail = [...lines.slice(-4).join(" ").replace(CONTROL, "")];
  if (tail.length > MAX_REASON_CHARS) return `…${tail.slice(-MAX_REASON_CHARS).join("")}`;
  if (tail.length === 0) return "The command failed without saying why.";
  return tail.join("");
}

function parse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** The one JSON object a `--json` run prints on its last line that starts one. */
export function jsonOf(stdout: string): Record<string, unknown> | undefined {
  const line = stdout
    .split("\n")
    .reverse()
    .map((each) => each.trim())
    .find((each) => each.startsWith("{"));
  const value = (line === undefined ? undefined : parse(line)) ?? parse(stdout.trim());
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** What a `--json` run printed: its object, or its error and fix in one line. */
export function jsonResult(ran: Ran): Record<string, unknown> | null {
  const value = jsonOf(ran.stdout);
  if (ran.success) return value ?? null;
  const error = value?.["error"];
  if (typeof error === "string") {
    const fix = value?.["fix"];
    throw typeof fix === "string" && fix !== "" ? `${error} ${fix}` : error;
  }
  throw failureReason(ran);
}

// Starting, stopping and restarting the local services

/** How long `supertag up` may take to report its services ready. */
const UP_LIMIT_MS = 180_000;
/** How long `supertag down` may take: it waits up to five minutes for running Task Attempts. */
const DOWN_LIMIT_MS = 360_000;

/** Whether to start the local services: SuperTag is set up in the state directory, but stopped. */
export function shouldStart(local: Pick<LocalDiscovery, "running" | "setUp"> | undefined): boolean {
  return local !== undefined && !local.running && local.setUp;
}

type Verb = "up" | "down";

const VERBS = {
  up: {
    failure: "Could not start SuperTag",
    timedOut: "supertag up did not report its services ready in 3 minutes.",
    limit: UP_LIMIT_MS,
  },
  down: {
    failure: "Could not stop SuperTag",
    timedOut: "supertag down did not stop the services in 6 minutes.",
    limit: DOWN_LIMIT_MS,
  },
} as const;

/** How a front end runs the CLI: the PATH, and the environment (this process's when absent). */
export interface CliEnvironment {
  path?: string | undefined;
  env?: NodeJS.ProcessEnv | undefined;
}

/**
 * Runs `supertag VERB --state-directory STATE`. On failure, says the last lines it printed, which
 * say why (earlier ones are progress), and where the logs are.
 */
export async function runVerb(
  cli: string,
  verb: Verb,
  state: string,
  environment: CliEnvironment = {},
): Promise<void> {
  const { failure, timedOut, limit } = VERBS[verb];
  const failed = (detail: string) => {
    const trimmed = detail.trim();
    const shown =
      trimmed === ""
        ? `supertag ${verb} stopped without saying why.`
        : trimmed.split("\n").slice(-12).join("\n");
    return `${failure}:\n${shown}\nLogs: ${path.join(state, "logs")}`;
  };
  let ran: Ran;
  try {
    ran = await runSupertag(cli, [verb, "--state-directory", state], {
      ...environment,
      timeoutMs: limit,
      timedOut,
    });
  } catch (error) {
    throw failed(typeof error === "string" ? error : `could not run ${cli}`);
  }
  if (!ran.success) throw failed(`${ran.stdout}\n${ran.stderr}`);
}

/** `supertag up` for the local services in `state`. */
export const startLocal = (cli: string, state: string, environment: CliEnvironment = {}) =>
  runVerb(cli, "up", state, environment);

/** What a front end reports while it restarts the local services. */
export type RestartStep = "stopping" | "starting";

/** `supertag down`, then `supertag up` against the same state directory; a failed down stops. */
export async function restartLocal(
  cli: string,
  state: string,
  environment: CliEnvironment,
  step: (step: RestartStep) => void,
): Promise<void> {
  step("stopping");
  await runVerb(cli, "down", state, environment);
  step("starting");
  await startLocal(cli, state, environment);
}

// An older local Gateway

/** The local Gateway runs an older release than this front end: `running` is it, `version` ours. */
export interface LocalUpgrade {
  running: string;
  version: string;
}

/** What a Gateway of another release said while negotiating, when it named itself. */
export interface Peer {
  build: string | undefined;
  versions: readonly number[] | undefined;
}

/** Whether every protocol version `peer` speaks is older than all of `ours`. */
export function older(peer: readonly number[], ours: readonly number[]): boolean {
  if (peer.length === 0 || ours.length === 0) return false;
  return Math.max(...peer) < Math.min(...ours);
}

/**
 * Whether the local Gateway runs an older release than this front end, which speaks only older
 * protocol versions. A Gateway newer than it, or one whose release can't be told, is never
 * offered a restart: this CLI would run it backwards. `probe` negotiates and returns the peer of
 * a protocol mismatch, or nothing when it agreed or could not be reached.
 */
export async function localUpgrade(
  local: LocalDiscovery | undefined,
  probe: (url: string, token: string) => Promise<Peer | undefined>,
  ours: readonly number[],
  version: string,
): Promise<LocalUpgrade | null> {
  if (!local?.running || local.url === undefined || local.token === undefined) return null;
  const peer = await probe(local.url, local.token).catch(() => undefined);
  if (peer?.build === undefined || peer.versions === undefined) return null;
  return older(peer.versions, ours) ? { running: peer.build, version } : null;
}

/**
 * Negotiates with the Gateway at `url`, with `supertag-ai`'s own negotiation, so the protocol
 * versions stay single-sourced in the SDK: the peer of a protocol mismatch when it named itself,
 * or nothing when it agreed, could not be reached, or refused for another reason.
 */
export async function probeGateway(
  url: string,
  token: string,
  buildVersion: string,
): Promise<Peer | undefined> {
  const client = createGatewayClient({ url, token, buildVersion });
  try {
    await client.negotiate();
    return undefined;
  } catch (error) {
    if (!(error instanceof ProtocolMismatchError)) return undefined;
    return { build: error.peerBuild, versions: error.peerVersions };
  } finally {
    client.close();
  }
}

// First launch: setting SuperTag up

/** How long the checks may take: a harness sign-in check runs one short turn. */
const CHECK_TIMEOUT_MS = 120_000;
/** How long init may take: it writes the configuration and starts the services. */
const SETUP_TIMEOUT_MS = 600_000;

/** `supertag init --check --json` for `directory` and, when given, only `harness`. */
export async function checkSetup(
  cli: string,
  environment: CliEnvironment,
  install: string,
  directory: string | undefined,
  harness: string | undefined,
): Promise<Record<string, unknown>> {
  const args = ["init", "--check", "--json"];
  if (directory !== undefined) args.push("--directory", directory);
  if (harness !== undefined) args.push("--harness", harness);
  const ran = await runSupertag(cli, args, { ...environment, timeoutMs: CHECK_TIMEOUT_MS });
  // A CLI older than the front end has no check: say to update it, as for one that is missing.
  if (!ran.success && ran.stderr.includes("unexpected argument")) {
    return { cli: null, outdated: cli, install };
  }
  const value = jsonOf(ran.stdout);
  if (value === undefined) {
    throw ran.success
      ? "This version of the supertag CLI can't check a setup for the app. Update it, then try again."
      : failureReason(ran);
  }
  return { ...value, cli };
}

/** Sets SuperTag up for the project in `directory` with `harness`, and starts it. */
export async function setUpLocal(
  cli: string,
  environment: CliEnvironment,
  directory: string,
  harness: string,
): Promise<Record<string, unknown> | null> {
  const ran = await runSupertag(
    cli,
    ["init", "--yes", "--json", "--harness", harness, "--directory", directory],
    { ...environment, cwd: directory, timeoutMs: SETUP_TIMEOUT_MS },
  );
  return jsonResult(ran);
}
