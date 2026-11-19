/**
 * The local Gateway `supertag up` runs from this user's state directory (`SUPERTAG_STATE_DIR`,
 * else `~/.supertag`). The app asks its own CLI, `supertag __local-gateway`, which checks the
 * state directory's private files and the supervisor's lock the way every command does, so none
 * of that is ported here. The operator token it prints is read at each connect and never saved,
 * because `supertag up` may replace it.
 */
import { execFile } from "node:child_process";
import type { LocalGateway } from "../model/gateway";

/** The identity the app gives the local Gateway in place of a saved origin. */
export const LOCAL = "local";
const PROTOCOL = "local-gateway.v2";
const TIMEOUT_MS = 10_000;
const MAX_OUTPUT = 64 * 1024;

/** What `supertag __local-gateway` reports. */
export interface LocalDiscovery {
  running: boolean;
  /** The local Gateway's URL, while it runs. */
  url?: string;
  /** Its current operator token, while it runs. Never saved or sent to the window. */
  token?: string;
  stateDirectory: string;
  /** SuperTag is set up in the state directory, so stopped services can be started. */
  setUp: boolean;
  /** This machine's identifier, which tells a Control Plane a Task's files are on its disk. */
  machineId: string | null;
  /** Why no local Gateway runs, when none does. */
  message?: string;
}

const UNREADABLE = "Could not read the local Gateway from the SuperTag CLI.";

function field(value: Record<string, unknown>, key: string): string | undefined {
  const found = value[key];
  return typeof found === "string" ? found : undefined;
}

/** Parses the CLI's report, or throws the window's message. */
export function parseLocalGateway(output: string): LocalDiscovery {
  let value: unknown;
  try {
    value = JSON.parse(output);
  } catch {
    throw UNREADABLE;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw UNREADABLE;
  const report = value as Record<string, unknown>;
  if (report["protocol"] !== PROTOCOL) {
    throw "The SuperTag CLI does not match this app. Install the same release as the app.";
  }
  const stateDirectory = field(report, "state_directory");
  if (typeof report["running"] !== "boolean" || stateDirectory === undefined) throw UNREADABLE;
  const machineId = field(report, "machine_id");
  const discovery: LocalDiscovery = {
    running: report["running"],
    stateDirectory,
    setUp: report["set_up"] === true,
    machineId: machineId ?? null,
  };
  if (discovery.running) {
    const url = field(report, "url");
    const token = field(report, "token");
    if (url === undefined || token === undefined) throw UNREADABLE;
    discovery.url = url;
    discovery.token = token;
  } else {
    discovery.message = field(report, "message") ?? "No local Gateway is running.";
  }
  return discovery;
}

/**
 * Asks `cli` for the local Gateway. Its output is a pipe, never a terminal, so it may print the
 * token; `env` reaches it as is (`SUPERTAG_STATE_DIR` selects another state directory).
 */
export function readLocalGateway(
  cli: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<LocalDiscovery> {
  return new Promise((resolve, reject) => {
    execFile(
      cli,
      ["__local-gateway"],
      { env, timeout: TIMEOUT_MS, maxBuffer: MAX_OUTPUT, encoding: "utf8" },
      (error, stdout, stderr) => {
        if (error) {
          // The CLI's errors name files and permissions, never the credential.
          const reason = stderr
            .replace(/^Error:\s*/u, "")
            .replace(/\p{Cc}+/gu, " ")
            .trim()
            .slice(0, 300);
          reject(reason === "" ? UNREADABLE : `Could not read the local Gateway: ${reason}`);
          return;
        }
        try {
          resolve(parseLocalGateway(stdout));
        } catch (problem) {
          reject(problem);
        }
      },
    );
  });
}

/** Finds the local Gateway: the CLI's report, or why none can be found. */
export type DiscoverLocal = () => Promise<LocalDiscovery>;

/** The local Gateway, connectable: its URL and current token, or the window's message. */
export async function discover(
  find: DiscoverLocal,
): Promise<{ url: string; token: string; stateDirectory: string }> {
  const local = await find();
  if (!local.running || local.url === undefined || local.token === undefined) {
    throw local.message ?? "No local Gateway is running.";
  }
  return { url: local.url, token: local.token, stateDirectory: local.stateDirectory };
}

/** Whether the local Gateway is running: its origin when it is, else why not. */
export async function status(find: DiscoverLocal): Promise<LocalGateway> {
  try {
    const local = await discover(find);
    return { origin: local.url };
  } catch (problem) {
    return { problem: typeof problem === "string" ? problem : UNREADABLE };
  }
}
