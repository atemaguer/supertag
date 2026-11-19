/**
 * The local Gateway `supertag up` runs from this user's state directory, as the CLI's own
 * `supertag __local-gateway` reports it (the terminal UI's contract, `local-gateway.v2`), so the
 * app never repeats the CLI's private-file and lock checks. Its token is read at each use and
 * never saved, because `supertag up` may replace it.
 *
 * Same signature and shape as the Gateway backend's reader (`gateway/local.ts`); one of the two
 * goes when both are on main.
 */
import { run } from "./run";

export interface LocalDiscovery {
  running: boolean;
  url?: string;
  token?: string;
  stateDirectory: string;
  /** SuperTag was set up in the state directory (its `supertag.yaml` exists). */
  setUp: boolean;
  machineId: string | null;
  /** Why it isn't running, when it isn't. */
  message?: string;
}

export const LOCAL_PROTOCOL = "local-gateway.v2";

/** Reads what `cli __local-gateway` prints. Rejects with a user-facing string. */
export async function readLocalGateway(
  cli: string,
  env?: NodeJS.ProcessEnv,
): Promise<LocalDiscovery> {
  const ran = await run(cli, ["__local-gateway"], {
    path: env?.["PATH"],
    timeoutMs: 10_000,
    timedOut: "The supertag CLI did not say where the local Gateway runs in time.",
  });
  return parseLocalGateway(ran.success ? ran.stdout : "");
}

/** What `__local-gateway` printed, checked. */
export function parseLocalGateway(printed: string): LocalDiscovery {
  let value: Record<string, unknown>;
  try {
    value = JSON.parse(printed) as Record<string, unknown>;
  } catch {
    throw "Could not read the local Gateway from the supertag CLI.";
  }
  if (value === null || typeof value !== "object" || value["protocol"] !== LOCAL_PROTOCOL) {
    throw "This version of the supertag CLI can't report the local Gateway to the app. Update it, then try again.";
  }
  const text = (key: string) =>
    typeof value[key] === "string" ? (value[key] as string) : undefined;
  const stateDirectory = text("state_directory");
  if (stateDirectory === undefined || typeof value["running"] !== "boolean") {
    throw "Could not read the local Gateway from the supertag CLI.";
  }
  const discovery: LocalDiscovery = {
    running: value["running"],
    stateDirectory,
    setUp: value["set_up"] === true,
    machineId: text("machine_id") ?? null,
  };
  const url = text("url");
  const token = text("token");
  const message = text("message");
  if (url !== undefined) discovery.url = url;
  if (token !== undefined) discovery.token = token;
  if (message !== undefined) discovery.message = message;
  if (discovery.running && (url === undefined || token === undefined)) {
    throw "Could not read the local Gateway from the supertag CLI.";
  }
  return discovery;
}
