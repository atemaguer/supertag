/**
 * The Gateways saved with `supertag connect`, `<config>/supertag/gateways.json`, which a
 * front end without its own store (the terminal UI) reads beside the desktop app's. Its shape,
 * as `core/crates/cli/src/profiles.rs` reads and writes it:
 * `{ version: 1, gateways: [{ name, url, token, server_ca_file, client_cert_file, client_key_file }] }`,
 * an owner-only file in a private directory. Only the CLI writes it, under its lock, so saving
 * runs `supertag connect`; the credential reaches it in its environment, never as a flag.
 */
import { execFile } from "node:child_process";
import { constants, promises as fs } from "node:fs";
import path from "node:path";
import type { AddedWorkspace } from "../model/tag-admin";
import type { Tls } from "./session";

const MAX_STORE_BYTES = 16 * 1024 * 1024;
const SAVE_TIMEOUT_MS = 60_000;
export const CLI_STORE_ERROR = "Could not read the Gateways saved with supertag connect.";

/**
 * The per-user configuration directory the CLI and the desktop app use, computed as the CLI
 * does (`profiles.rs`, `config_directory`): macOS `~/Library/Application Support`; elsewhere an
 * absolute `$XDG_CONFIG_HOME`, else `~/.config`.
 */
export function configRoot(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  const home = env["HOME"] || undefined;
  if (platform === "darwin") {
    if (!home) throw "HOME is required to find saved Gateways.";
    return path.join(home, "Library/Application Support");
  }
  const xdg = env["XDG_CONFIG_HOME"];
  if (xdg && path.isAbsolute(xdg)) return xdg;
  if (!home) throw "HOME or XDG_CONFIG_HOME is required to find saved Gateways.";
  return path.join(home, ".config");
}

/** `<config>/supertag/gateways.json`, which `supertag connect` writes. */
export function cliStore(env?: NodeJS.ProcessEnv, platform?: NodeJS.Platform): string {
  return path.join(configRoot(env, platform), "supertag", "gateways.json");
}

/** `<config>/ai.supertag.desktop/gateways.json`, which the desktop app writes. */
export function desktopStore(env?: NodeJS.ProcessEnv, platform?: NodeJS.Platform): string {
  return path.join(configRoot(env, platform), "ai.supertag.desktop", "gateways.json");
}

/** One Gateway saved with `supertag connect`. TLS files are paths, read at connect. */
export interface CliGateway {
  name: string;
  url: string;
  token: string;
  serverCaFile?: string;
  clientCertFile?: string;
  clientKeyFile?: string;
}

const uid = () => process.getuid?.();

/** Parses the CLI's store, refusing what the CLI refuses. */
export function parseCliStore(text: string): CliGateway[] {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw CLI_STORE_ERROR;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw CLI_STORE_ERROR;
  const record = value as Record<string, unknown>;
  if (record["version"] !== 1)
    throw "The Gateways saved with supertag connect have a newer format.";
  const gateways = record["gateways"] ?? [];
  if (!Array.isArray(gateways)) throw CLI_STORE_ERROR;
  return gateways.map((entry: unknown) => {
    const saved = (entry ?? {}) as Record<string, unknown>;
    const text = (key: string) => {
      const found = saved[key] ?? "";
      if (typeof found !== "string") throw CLI_STORE_ERROR;
      return found;
    };
    const url = text("url");
    const token = text("token");
    if (url === "" || token === "") throw CLI_STORE_ERROR;
    const gateway: CliGateway = { name: text("name"), url, token };
    const ca = text("server_ca_file");
    const cert = text("client_cert_file");
    const key = text("client_key_file");
    if (ca) gateway.serverCaFile = ca;
    if (cert) gateway.clientCertFile = cert;
    if (key) gateway.clientKeyFile = key;
    return gateway;
  });
}

/**
 * The Gateways saved with `supertag connect`; none when the store does not exist. The file
 * must be private and its directory too, as the CLI requires.
 */
export async function loadCliGateways(file: string): Promise<CliGateway[]> {
  try {
    const directory = await fs.lstat(path.dirname(file));
    if (
      !directory.isDirectory() ||
      (directory.mode & 0o077) !== 0 ||
      (uid() !== undefined && directory.uid !== uid())
    ) {
      throw CLI_STORE_ERROR;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw CLI_STORE_ERROR;
  }
  let handle: fs.FileHandle;
  try {
    handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw CLI_STORE_ERROR;
  }
  try {
    const metadata = await handle.stat();
    if (
      !metadata.isFile() ||
      metadata.nlink !== 1 ||
      (metadata.mode & 0o077) !== 0 ||
      (uid() !== undefined && metadata.uid !== uid()) ||
      metadata.size > MAX_STORE_BYTES
    ) {
      throw CLI_STORE_ERROR;
    }
    return parseCliStore(await handle.readFile("utf8"));
  } catch (error) {
    throw typeof error === "string" ? error : CLI_STORE_ERROR;
  } finally {
    await handle.close();
  }
}

/** Reads a saved Gateway's TLS files, or says which one could not be read. */
export async function tlsOf(saved: {
  serverCaFile?: string | undefined;
  clientCertFile?: string | undefined;
  clientKeyFile?: string | undefined;
}): Promise<Tls> {
  const read = async (file: string, what: string) => {
    try {
      return await fs.readFile(file);
    } catch {
      throw `Could not read the ${what} ${file}.`;
    }
  };
  if ((saved.clientCertFile === undefined) !== (saved.clientKeyFile === undefined)) {
    throw "Name both the client certificate and its key.";
  }
  const tls: { ca?: Buffer; identity?: { cert: Buffer; key: Buffer } } = {};
  if (saved.serverCaFile) tls.ca = await read(saved.serverCaFile, "certificate authority file");
  if (saved.clientCertFile && saved.clientKeyFile) {
    tls.identity = {
      cert: await read(saved.clientCertFile, "client certificate"),
      key: await read(saved.clientKeyFile, "client key"),
    };
  }
  return tls;
}

/** What to save with `supertag connect`. */
export interface NewCliGateway {
  name: string;
  url: string;
  /** An Operator Token, enrolled credential, or a client Auth Key the CLI enrolls with. */
  token: string;
  replace?: boolean;
  serverCaFile?: string;
  clientCertFile?: string;
  clientKeyFile?: string;
}

/**
 * Saves a Gateway with `cli connect`, which checks it, enrolls an Auth Key as this device, and
 * writes the store under its lock. The credential goes in `SUPERTAG_OPERATOR_TOKEN`.
 */
export function saveWithCli(
  cli: string,
  gateway: NewCliGateway,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const args = ["connect", gateway.url, "--name", gateway.name];
  if (gateway.replace) args.push("--replace");
  if (gateway.serverCaFile) args.push("--server-ca-file", gateway.serverCaFile);
  if (gateway.clientCertFile) args.push("--client-cert-file", gateway.clientCertFile);
  if (gateway.clientKeyFile) args.push("--client-key-file", gateway.clientKeyFile);
  return new Promise((resolve, reject) => {
    const child = execFile(
      cli,
      args,
      {
        env: { ...env, SUPERTAG_OPERATOR_TOKEN: gateway.token },
        timeout: SAVE_TIMEOUT_MS,
        encoding: "utf8",
      },
      (error, _stdout, stderr) => {
        if (!error) {
          resolve();
          return;
        }
        // The CLI's errors name the Gateway and files, never the credential.
        const reason = stderr
          .replace(/^Error:\s*/u, "")
          .replace(/\p{Cc}+/gu, " ")
          .trim()
          .slice(0, 400);
        reject(reason === "" ? "supertag connect failed." : reason);
      },
    );
    child.stdin?.end();
  });
}

/** Runs the CLI and settles with its stdout, or rejects with its error line (never a credential). */
function runCli(
  cli: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  failed: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      cli,
      args,
      { env, timeout: timeoutMs, encoding: "utf8" },
      (error, stdout, stderr) => {
        if (!error) {
          resolve(stdout);
          return;
        }
        const reason = stderr
          .replace(/^Error:\s*/u, "")
          .replace(/\p{Cc}+/gu, " ")
          .trim()
          .slice(0, 400);
        reject(reason === "" ? failed : reason);
      },
    );
    child.stdin?.end();
  });
}

/** Forgets the Gateway saved under `name` with `supertag disconnect`, the CLI's own store. */
export async function forgetWithCli(
  cli: string,
  name: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  await runCli(cli, ["disconnect", name], env, SAVE_TIMEOUT_MS, "supertag disconnect failed.");
}

/** How long `supertag workspace add` may take: it restarts the changed services, as `up` does. */
const ADD_WORKSPACE_TIMEOUT_MS = 180_000;

/** Adds the repository at `folder` as a Workspace of the local services in `state`. */
export async function addWorkspaceWithCli(
  cli: string,
  state: string,
  folder: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<AddedWorkspace> {
  const out = await runCli(
    cli,
    ["workspace", "add", "--json", "--state-directory", state, folder],
    env,
    ADD_WORKSPACE_TIMEOUT_MS,
    "supertag workspace add failed.",
  );
  let value: Record<string, unknown> | undefined;
  try {
    value = JSON.parse(out.trim().split("\n").at(-1) ?? "") as Record<string, unknown>;
  } catch {
    value = undefined;
  }
  const workspace = value?.["workspace"];
  if (typeof workspace !== "string") {
    throw "This version of the supertag CLI can't add a folder here. Update it, then try again.";
  }
  const added: AddedWorkspace = { workspace };
  if (typeof value?.["ref"] === "string") added.workspaceRef = value["ref"];
  if (typeof value?.["baseCommit"] === "string") added.workspaceCommit = value["baseCommit"];
  return added;
}
