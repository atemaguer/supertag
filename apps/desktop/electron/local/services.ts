/**
 * The local services, run with the app's own CLI. A port of the Tauri app's `local_start.rs` and
 * `gateway/local.rs:local_upgrade`.
 *
 * Later launches: when this user's SuperTag is set up but its services are stopped, the app starts
 * them with `supertag up`, then connects. First-launch setup stays with onboarding. When the local
 * Gateway runs an older release, the app offers to restart it with its own CLI: `supertag down`,
 * then `supertag up`, which migrates the database.
 */
import path from "node:path";
import type { LocalDiscovery } from "../gateway/local";
import { result, run } from "./run";

/** How long `supertag up` may take to report its services ready. */
const UP_LIMIT_MS = 180_000;
/** How long `supertag down` may take: it waits up to five minutes for running Task Attempts. */
const DOWN_LIMIT_MS = 360_000;
/** How long `supertag workspace add` may take: it restarts the changed services, as `up` does. */
const ADD_WORKSPACE_LIMIT_MS = 420_000;

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

/**
 * Runs `supertag VERB --state-directory STATE`. On failure, says the last lines it printed, which
 * say why (earlier ones are progress), and where the logs are.
 */
export async function runVerb(
  cli: string,
  verb: Verb,
  state: string,
  searchPath: string | undefined,
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
  let ran: Awaited<ReturnType<typeof run>>;
  try {
    ran = await run(cli, [verb, "--state-directory", state], {
      path: searchPath,
      timeoutMs: limit,
      timedOut,
    });
  } catch (error) {
    throw failed(typeof error === "string" ? error : `could not run ${cli}`);
  }
  if (!ran.success) throw failed(`${ran.stdout}\n${ran.stderr}`);
}

export const up = (cli: string, state: string, searchPath: string | undefined) =>
  runVerb(cli, "up", state, searchPath);

/** What the app reports while it restarts the local services. */
export type RestartStep = "stopping" | "starting";

/** `supertag down`, then `supertag up` against the same state directory; a failed down stops. */
export async function restart(
  cli: string,
  state: string,
  searchPath: string | undefined,
  step: (step: RestartStep) => void,
): Promise<void> {
  step("stopping");
  await runVerb(cli, "down", state, searchPath);
  step("starting");
  await up(cli, state, searchPath);
}

/** A folder `supertag workspace add` made a Workspace of the local host, as its `--json` says. */
export interface AddedWorkspace {
  workspace: string;
  workspaceRef?: string;
  workspaceCommit?: string;
}

/** Adds the git repository at `folder` as a Workspace of the local services in `state`. */
export async function addWorkspace(
  cli: string,
  searchPath: string | undefined,
  state: string,
  folder: string,
): Promise<AddedWorkspace> {
  const ran = await run(cli, ["workspace", "add", "--json", "--state-directory", state, folder], {
    path: searchPath,
    timeoutMs: ADD_WORKSPACE_LIMIT_MS,
  });
  const value = result(ran);
  const workspace = value?.["workspace"];
  if (typeof workspace !== "string") {
    throw "This version of the supertag CLI can't add a folder for the app. Update it, then try again.";
  }
  const added: AddedWorkspace = { workspace };
  if (typeof value?.["ref"] === "string") added.workspaceRef = value["ref"];
  if (typeof value?.["baseCommit"] === "string") added.workspaceCommit = value["baseCommit"];
  return added;
}

/** The local Gateway runs an older release than this app: `running` is it, `version` the app's. */
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
 * Whether the local Gateway runs an older release than this app, which speaks only older
 * protocol versions. A Gateway newer than the app, or one whose release can't be told, is never
 * offered a restart: the app's CLI would run it backwards. `probe` negotiates and returns the
 * peer of a protocol mismatch, or nothing when it agreed or could not be reached.
 */
export async function localUpgrade(
  local: LocalDiscovery | undefined,
  probe: (url: string, token: string) => Promise<Peer | undefined>,
  ours: readonly number[],
  appVersion: string,
): Promise<LocalUpgrade | null> {
  if (!local?.running || local.url === undefined || local.token === undefined) return null;
  const peer = await probe(local.url, local.token).catch(() => undefined);
  if (peer?.build === undefined || peer.versions === undefined) return null;
  return older(peer.versions, ours) ? { running: peer.build, version: appVersion } : null;
}
