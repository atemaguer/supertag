import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, vi } from "vitest";
import { resolveControlPlaneTarget } from "../../apps/cli/src/control-plane-client.ts";
import { startControlPlaneRuntime } from "../../apps/cli/src/control-plane-runtime.ts";
import { listSlots, runningProcess } from "../../apps/cli/src/local-state.ts";
import { hostClient } from "../../apps/cli/src/operator-client.ts";
import {
  getAuthKeyResource,
  getWorkerHostResource,
  listWorkerHostResources,
} from "../../apps/cli/src/operator-resources.ts";
import type { ServiceEnvironment } from "../../apps/cli/src/up-service.ts";
import { migrateSqlite } from "./database.ts";

export const TIMEOUT = 180_000;

/** Runs the CLI from source, as background and unit processes do. */
export const CLI = [
  process.execPath,
  "--import",
  pathToFileURL(resolve("node_modules/tsx/dist/loader.mjs")).href,
  "--conditions=development",
  resolve("apps/cli/src/index.ts"),
];

export interface ServicesContext {
  readonly directory: string;
  readonly bin: string;
  readonly state: string;
  readonly output: string[];
  readonly cleanups: Array<() => Promise<void>>;
  printed(): string;
}

/**
 * A private state directory, HOME, and PATH per test, with stdout captured. Every service process
 * a test leaves behind is stopped afterwards.
 */
export function useServicesContext(): ServicesContext {
  const context = {
    directory: "",
    bin: "",
    state: "",
    output: [] as string[],
    cleanups: [] as Array<() => Promise<void>>,
    printed: () => context.output.join(""),
  };
  beforeEach(async () => {
    context.directory = await mkdtemp(join(tmpdir(), "supertag-services-"));
    context.bin = join(context.directory, "bin");
    context.state = join(context.directory, "state");
    await mkdir(context.bin);
    vi.stubEnv("SUPERTAG_STATE_DIR", context.state);
    vi.stubEnv("HOME", join(context.directory, "home"));
    vi.stubEnv("PATH", `${context.bin}:/usr/bin:/bin`);
    for (const name of [
      "SUPERTAG_CONTROL_PLANE",
      "SUPERTAG_GATEWAY_HOST",
      "SUPERTAG_DEPLOYMENT_PLATFORM",
      "PORT",
      "SUPERTAG_ADMIN_TOKEN",
      "SUPERTAG_OPERATOR_TOKEN",
      "SUPERTAG_AUTH_KEY",
      "SUPERTAG_DATABASE_URL",
      "SUPERTAG_COORDINATION_URL",
      "SUPERTAG_WORKLET_TRANSPORT",
      "SUPERTAG_WORKLET_GRPC_PORT",
      "SUPERTAG_WORKER_WORKSPACE",
      "SUPERTAG_UP_MODE",
      "SUPERTAG_OPERATOR_CHANNEL",
      "SUPERTAG_RPC_TRACE",
      "SUPERTAG_CREDENTIAL_VAULT",
      "PGPASSWORD",
      "INIT_CWD",
      "OPENAI_API_KEY",
      "ANTHROPIC_API_KEY",
      "CODEX_HOME",
      "XDG_DATA_HOME",
      "XDG_CONFIG_HOME",
    ])
      vi.stubEnv(name, undefined);
    // Port 0 lets the OS choose; a pre-picked ephemeral port can be taken by parallel suites.
    vi.stubEnv("SUPERTAG_GATEWAY_PORT", "0");
    context.output.length = 0;
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      context.output.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });
  afterEach(async () => {
    for (const cleanup of context.cleanups.splice(0).reverse())
      await cleanup().catch(() => undefined);
    for (const slot of await listSlots().catch(() => [])) {
      const { pid } = await runningProcess(slot).catch(() => ({}) as { pid?: number });
      if (pid !== undefined && pid !== process.pid) process.kill(pid, "SIGKILL");
    }
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await rm(context.directory, { recursive: true, force: true });
  });
  return context;
}

export async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  await new Promise<void>((done) => server.close(() => done()));
  if (address === null || typeof address === "string") throw new Error("no port");
  return address.port;
}

export async function fakeHarness(context: ServicesContext, ...commands: string[]) {
  for (const command of commands) {
    const path = join(context.bin, command);
    // Report a version above any minimum, like a current install.
    await writeFile(path, '#!/bin/sh\n[ "$1" = "--version" ] && echo "99.0.0"\nexit 0\n');
    await chmod(path, 0o755);
  }
}

export function git(cwd: string, ...args: string[]) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

/** A git repository with one commit, and its real top-level path. */
export async function repository(
  context: ServicesContext,
  name: string,
  origin?: string,
): Promise<string> {
  const root = join(context.directory, name);
  await mkdir(root, { recursive: true });
  git(root, "init", "-q", "-b", "main");
  git(
    root,
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@example.com",
    "commit",
    "-q",
    "--allow-empty",
    "-m",
    "init",
  );
  if (origin) git(root, "remote", "add", "origin", origin);
  return git(root, "rev-parse", "--show-toplevel");
}

/** Writes ~/.supertag/supertag.yaml in the test's state directory. */
export async function writeServices(context: ServicesContext, text: string): Promise<string> {
  await mkdir(context.state, { recursive: true });
  const path = join(context.state, "supertag.yaml");
  await writeFile(path, text);
  return path;
}

/** Calls the local Control Plane the way any supertag command finds it. */
export async function api(path: string, init: RequestInit = {}) {
  const target = await resolveControlPlaneTarget();
  if (target === undefined) throw new Error("no local operator credential");
  const response = await fetch(`${target.url}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${target.token}`, "content-type": "application/json" },
  });
  return response.json() as Promise<
    Record<string, unknown> & {
      spec: Record<string, unknown>;
      status: Record<string, unknown>;
      items: { metadata: { name: string }; spec: Record<string, unknown> }[];
    }
  >;
}

async function localTarget() {
  const target = await resolveControlPlaneTarget();
  if (target === undefined) throw new Error("no local operator credential");
  return target;
}

/** Reads a Worker Host of the local Control Plane, as `supertag get worker-host` prints it. */
export async function localWorkerHost(id: string) {
  return getWorkerHostResource(await localTarget(), id);
}

/** Lists the Worker Hosts of the local Control Plane, as `supertag get worker-host` prints them. */
export async function localWorkerHosts() {
  return listWorkerHostResources(await localTarget());
}

/** Binds a Worker Host to a Tag on the local Control Plane. */
export async function bindLocalWorkerHost(tag: string, workerHostId: string) {
  return hostClient(await localTarget()).bindWorkerHost({ tag, workerHostId });
}

const SHARED_ADMIN = "shared-control-plane-admin";

/** A teammate's view: a shared Control Plane with Tag lead and Auth Keys for it. */
export async function sharedControlPlane(context: ServicesContext) {
  const databasePath = join(context.directory, "shared.db");
  await migrateSqlite(databasePath);
  const runtime = await startControlPlaneRuntime({
    host: "127.0.0.1",
    port: 0,
    databaseUrl: `file:${databasePath}`,
    adminToken: SHARED_ADMIN,
    coordinationOperatorCredentials: [],
    workletTransport: "remote",
    stateDirectory: join(context.directory, "shared"),
    reply: async () => {},
  });
  context.cleanups.push(() => runtime.close());
  const shared = async (path: string, init: RequestInit = {}) =>
    (await (
      await fetch(`${runtime.url}${path}`, {
        ...init,
        headers: { authorization: `Bearer ${SHARED_ADMIN}`, "content-type": "application/json" },
      })
    ).json()) as Record<string, unknown> & {
      spec: Record<string, unknown>;
      status: Record<string, unknown>;
      secret: string;
    };
  await shared("/api/v1/tags", {
    method: "POST",
    body: JSON.stringify({
      apiVersion: "supertag/v1",
      kind: "Tag",
      metadata: { name: "lead" },
      spec: {},
    }),
  });
  const authKey = async (name: string) =>
    (
      await hostClient({ url: runtime.url, token: SHARED_ADMIN }).createAuthKey({
        name,
        tags: ["lead"],
      })
    ).secret;
  const admin = { url: runtime.url, token: SHARED_ADMIN };
  return {
    url: runtime.url,
    shared,
    authKey,
    workerHost: (id: string) => getWorkerHostResource(admin, id),
    authKeyResource: (name: string) => getAuthKeyResource(admin, name),
  };
}

/**
 * A fake launchd or systemd. Starting a unit runs the command its definition names, as the real
 * manager would, so the service writes its own pid file and status.
 */
export function fakeServices(context: ServicesContext, platform: NodeJS.Platform) {
  const calls: string[] = [];
  const running = new Map<string, ChildProcess>();
  const home = join(context.directory, "home");
  const definition = async (name: string) => {
    if (platform === "darwin") {
      const text = await readFile(
        join(home, "Library", "LaunchAgents", `ai.supertag.${name}.plist`),
        "utf8",
      );
      const strings = (block: string) =>
        [...block.matchAll(/<string>([^<]*)<\/string>/gu)].map((match) =>
          (match[1] ?? "").replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&"),
        );
      const command = strings(
        /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/u.exec(text)?.[1] ?? "",
      );
      const pairs = [
        ...(
          /<key>EnvironmentVariables<\/key>\s*<dict>([\s\S]*?)<\/dict>/u.exec(text)?.[1] ?? ""
        ).matchAll(/<key>([^<]*)<\/key>\s*<string>([^<]*)<\/string>/gu),
      ].map((match) => [match[1] ?? "", match[2] ?? ""]);
      const log = /<key>StandardOutPath<\/key>\s*<string>([^<]*)<\/string>/u.exec(text)?.[1] ?? "";
      return { command, environment: Object.fromEntries(pairs), log };
    }
    const text = await readFile(
      join(home, ".config", "systemd", "user", `supertag-${name}.service`),
      "utf8",
    );
    const command = (/^ExecStart=(.*)$/mu.exec(text)?.[1] ?? "").split(" ");
    const environment = Object.fromEntries(
      [...text.matchAll(/^Environment=(\S+?)=(.*)$/gmu)].map((match) => [
        match[1] ?? "",
        match[2] ?? "",
      ]),
    );
    const log = /^StandardOutput=append:(.*)$/mu.exec(text)?.[1] ?? "";
    return { command, environment, log };
  };
  const start = async (name: string) => {
    if (running.has(name)) return;
    const { command, environment, log } = await definition(name);
    const [program, ...args] = command;
    if (program === undefined) throw new Error(`no command for ${name}`);
    await mkdir(join(log, ".."), { recursive: true });
    const handle = await open(log, "a");
    // A unit sees only its definition's environment, not the test's.
    const child = spawn(program, args, {
      cwd: context.state,
      env: { ...environment },
      stdio: ["ignore", handle.fd, handle.fd],
    });
    // Track the child before awaiting anything: a command that exits at once must not emit
    // "exit" before its listener exists, or stop() would wait for an exit that already happened.
    running.set(name, child);
    child.once("exit", () => {
      if (running.get(name) === child) running.delete(name);
    });
    await handle.close();
  };
  const stop = async (name: string) => {
    const child = running.get(name);
    if (child === undefined) return;
    if (child.exitCode !== null || child.signalCode !== null) {
      running.delete(name);
      return;
    }
    const exited = new Promise((done) => child.once("exit", done));
    child.kill("SIGTERM");
    await exited;
  };
  const nameOf = (value: string | undefined) =>
    (value ?? "")
      .replace(/^.*ai\.supertag\./u, "")
      .replace(/\.plist$/u, "")
      .replace(/^supertag-/u, "")
      .replace(/\.service$/u, "");
  const environment: ServiceEnvironment = {
    platform,
    home,
    uid: 501,
    run: async (command, args) => {
      calls.push(`${command} ${args.join(" ")}`);
      const verb = command === "launchctl" ? args[0] : args[1];
      const name = nameOf(args.at(-1));
      if (verb === "print") return { code: running.has(name) ? 0 : 113, output: "" };
      if (verb === "bootstrap" || verb === "start" || verb === "kickstart") await start(name);
      if (verb === "restart") {
        await stop(name);
        await start(name);
      }
      if (verb === "bootout" || verb === "stop") await stop(name);
      if (verb === "disable") await stop(nameOf(args.at(-1)));
      return { code: 0, output: "" };
    },
  };
  context.cleanups.push(async () => {
    for (const name of [...running.keys()]) await stop(name);
  });
  return { environment, calls };
}
