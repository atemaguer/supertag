/**
 * Running the `supertag` CLI as a child process and reading what it printed.
 */
import { spawn } from "node:child_process";

/** What a finished CLI run printed. */
export interface Ran {
  success: boolean;
  stdout: string;
  stderr: string;
}

/** The most of a failed command's output the app shows. */
export const MAX_REASON_CHARS = 600;

export interface RunOptions {
  /** The PATH the CLI and what it starts run with; the app's own when absent. */
  path?: string | undefined;
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
export function run(cli: string, args: readonly string[], options: RunOptions): Promise<Ran> {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    if (options.path !== undefined) env["PATH"] = options.path;
    const child = spawn(cli, args, {
      cwd: options.cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
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
export function reason(ran: Ran): string {
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
export function result(ran: Ran): Record<string, unknown> | null {
  const value = jsonOf(ran.stdout);
  if (ran.success) return value ?? null;
  const error = value?.["error"];
  if (typeof error === "string") {
    const fix = value?.["fix"];
    throw typeof fix === "string" && fix !== "" ? `${error} ${fix}` : error;
  }
  throw reason(ran);
}
