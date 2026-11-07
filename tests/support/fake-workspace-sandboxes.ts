/**
 * Fake E2B and Modal clients for Workspace environment tests. Each fake sandbox is a private host
 * directory: every sandbox path under {@link FAKE_SANDBOX_ROOT} in a command, argument, working
 * directory, or environment value is rewritten into that directory, and commands run locally.
 * Templates and images are directory copies, so a sandbox is a copy-on-write view of its artifact.
 * Network is simulated: every process sees SUPERTAG_FAKE_NETWORK=reachable or blocked. With
 * `isolatedLoopback`, each sandbox also has its own loopback, as a remote sandbox does: a Node.js
 * process in it can connect to a loopback port only when a process in the same sandbox listens
 * there, never to one of the Worker Host's.
 * With `image: "python:3.13-slim"`, processes see only that image's commands: `apt-get` but no
 * Node.js. An image gains `node` only from preparation's trusted install layer,
 * {@link WORKSPACE_MCP_NODE_INSTALL}, in a Modal base image or an E2B template, and keeps it in
 * every snapshot built from it.
 * No real provider is ever called.
 */
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  constants,
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import {
  access,
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { PassThrough, Readable } from "node:stream";
import type {
  E2BSandboxClient,
  E2BSandboxFactory,
  E2BTemplateBuildSpec,
  E2BTemplateClient,
} from "../../packages/runtime/environments/e2b/src/index.ts";
import type {
  ModalSandboxClient,
  ModalSandboxFactory,
  ModalSetupSandboxClient,
  ModalWorkspaceClient,
} from "../../packages/runtime/environments/modal/src/index.ts";
import { WORKSPACE_MCP_NODE_INSTALL } from "../../packages/runtime/sdk/src/sandbox-workspace-environment.ts";

export const FAKE_SANDBOX_ROOT = "/workspace";
export const FAKE_WORKSPACE = `${FAKE_SANDBOX_ROOT}/repo`;
export const FAKE_TRANSFER = `${FAKE_SANDBOX_ROOT}/.supertag-transfer`;

// Commands present in python:3.13-slim after Modal's trusted git base layer. The fake runs
// these host executables against its private filesystem, but does not inherit host runtimes.
const PYTHON_SLIM_COMMANDS = [
  "base64",
  "bash",
  "cat",
  "chmod",
  "cp",
  "dirname",
  "env",
  "find",
  "git",
  "head",
  "id",
  "ln",
  "ls",
  "mkdir",
  "mktemp",
  "mv",
  "python3",
  "rm",
  "sed",
  "sh",
  "stat",
  "tail",
  "test",
  "touch",
  "tr",
  "uname",
] as const;

/** The trusted Modal layer that installs Node.js from the image's own package archive. */
const NODE_INSTALL_LAYER = `RUN ${JSON.stringify(["/bin/sh", "-c", WORKSPACE_MCP_NODE_INSTALL])}`;

/** python:3.13-slim ships apt-get; the fake installs nothing at run time. */
const FAKE_APT_GET = `#!/bin/sh
echo "apt-get: the fake image installs packages only in preparation's trusted layers" >&2
exit 100
`;

/** One provider call, recorded with everything the provider received. */
export interface FakeProviderCall {
  readonly kind: string;
  readonly detail: unknown;
}

interface FakeRoot {
  readonly path: string;
  readonly network: boolean;
  /** The modeled image's commands, with `node` once the trusted install layer ran. */
  readonly imagePath?: string;
  /** True once preparation's trusted Node.js install ran for this image. */
  readonly node?: boolean;
  readonly trustedExecutables?: ReadonlyMap<string, string>;
  /** Directory of this sandbox's own loopback ports, with `isolatedLoopback`. */
  readonly loopback?: { readonly ports: string; readonly preload: string };
}

/**
 * Preloaded into every Node.js process of a sandbox with an isolated loopback. Listening records
 * the port as the sandbox's own; connecting to any other loopback port is refused.
 */
const ISOLATED_LOOPBACK_PRELOAD = `const net = require("node:net");
const fs = require("node:fs");
const path = require("node:path");
const ports = process.env.SUPERTAG_FAKE_LOOPBACK;
const loopback = new Set(["127.0.0.1", "localhost", "::1", undefined, ""]);
const listen = net.Server.prototype.listen;
net.Server.prototype.listen = function (...args) {
  this.once("listening", () => {
    const address = this.address();
    if (address && typeof address === "object") fs.writeFileSync(path.join(ports, String(address.port)), "");
  });
  return listen.apply(this, args);
};
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  let options = Array.isArray(args[0]) ? args[0][0] : args[0];
  if (options === null || typeof options !== "object") options = { port: args[0], host: args[1] };
  if (options.path == null && loopback.has(options.host) && !fs.existsSync(path.join(ports, String(options.port)))) {
    const error = Object.assign(new Error("connect ECONNREFUSED: port " + options.port + " is outside this sandbox"), { code: "ECONNREFUSED" });
    process.nextTick(() => this.destroy(error));
    return this;
  }
  return connect.apply(this, args);
};
`;

export class FakeSandboxWorld {
  readonly calls: FakeProviderCall[] = [];
  /** Artifact ID to its root directory. */
  readonly artifacts = new Map<string, string>();
  readonly trustedExecutables = new Map<string, ReadonlyMap<string, string>>();
  /** Artifacts built from a sandbox, by the sandbox they came from. */
  readonly snapshots: { readonly sandbox: string; readonly artifact: string }[] = [];
  /** Sandboxes created for Tasks, by ID. */
  readonly taskSandboxes = new Set<string>();
  /** Artifacts whose image has Node.js from preparation's trusted install layer. */
  readonly nodeArtifacts = new Set<string>();
  /** Bytes the host read from a sandbox, rewritten by `tamper` when set. */
  tamper?: (path: string, bytes: Uint8Array) => Uint8Array;
  #counter = 0;

  private constructor(
    readonly directory: string,
    readonly isolatedLoopback: boolean,
    readonly imagePath?: string,
    readonly nodeImagePath?: string,
  ) {}

  static async create(
    options: { readonly isolatedLoopback?: boolean; readonly image?: "python:3.13-slim" } = {},
  ): Promise<FakeSandboxWorld> {
    const directory = await realpath(await mkdtemp(join(tmpdir(), "supertag-fake-sandboxes-")));
    const imagePath = options.image === undefined ? undefined : join(directory, "image-bin");
    const nodeImagePath =
      options.image === undefined ? undefined : join(directory, "image-bin-node");
    if (imagePath !== undefined && nodeImagePath !== undefined) {
      for (const path of [imagePath, nodeImagePath]) {
        await mkdir(path);
        for (const command of PYTHON_SLIM_COMMANDS) {
          const source = await hostCommand(command);
          if (source === undefined) throw new Error(`Fake image needs host command ${command}`);
          await symlink(source, join(path, command));
        }
        await writeFile(join(path, "apt-get"), FAKE_APT_GET, { mode: 0o755 });
      }
      // What the trusted layer's `apt-get install nodejs` provides.
      await symlink(process.execPath, join(nodeImagePath, "node"));
    }
    return new FakeSandboxWorld(
      directory,
      options.isolatedLoopback === true,
      imagePath,
      nodeImagePath,
    );
  }

  async cleanup(): Promise<void> {
    // Copy mounts are read-only inside a sandbox; restore write permission so they can go.
    await new Promise<void>((resolvePromise) =>
      execFile("chmod", ["-R", "u+w", this.directory], () => resolvePromise()),
    );
    await rm(this.directory, { recursive: true, force: true });
  }

  /** Everything a provider received, as text, for credential scans. */
  async received(): Promise<string> {
    return JSON.stringify(this.calls);
  }

  #id(prefix: string): string {
    this.#counter += 1;
    return `${prefix}-${this.#counter}`;
  }

  async #root(
    from: string | undefined,
    network: boolean,
    prefix: string,
    installNode = false,
  ): Promise<FakeRoot> {
    const path = join(this.directory, this.#id(prefix));
    const source = from === undefined ? undefined : this.artifacts.get(from);
    if (from !== undefined && source === undefined) throw new Error(`Unknown artifact ${from}`);
    if (source === undefined) await mkdir(path, { recursive: true });
    else await cp(source, path, { recursive: true, verbatimSymlinks: true });
    const trustedExecutables = from === undefined ? undefined : this.trustedExecutables.get(from);
    const node = installNode || (from !== undefined && this.nodeArtifacts.has(from));
    const image = {
      ...(this.imagePath && { imagePath: node ? this.nodeImagePath : this.imagePath }),
      ...(node && { node }),
    };
    if (!this.isolatedLoopback) return { path, network, ...image, trustedExecutables };
    // Outside the sandbox root, so snapshots never copy another sandbox's ports.
    const ports = `${path}.loopback`;
    const preload = join(this.directory, "isolated-loopback.cjs");
    await mkdir(ports, { recursive: true });
    await writeFile(preload, ISOLATED_LOOPBACK_PRELOAD);
    return {
      path,
      network,
      ...image,
      trustedExecutables,
      loopback: { ports, preload },
    };
  }

  async #snapshot(root: FakeRoot, sandbox: string, prefix: string): Promise<string> {
    const artifact = this.#id(prefix);
    const path = join(this.directory, `artifact-${artifact}`);
    await cp(root.path, path, { recursive: true, verbatimSymlinks: true });
    this.artifacts.set(artifact, path);
    this.trustedExecutables.set(artifact, await executableDigests(path));
    if (root.node) this.nodeArtifacts.add(artifact);
    this.snapshots.push({ sandbox, artifact });
    return artifact;
  }

  /** E2B clients over this world. */
  e2b(): { templateClient: E2BTemplateClient; sandboxFactory: E2BSandboxFactory } {
    const world = this;
    return {
      templateClient: {
        async build(spec: E2BTemplateBuildSpec) {
          world.calls.push({ kind: "e2b.template.build", detail: spec });
          const bundle = await readFile(join(spec.contextDirectory, spec.contentFile));
          world.calls.push({ kind: "e2b.template.upload", detail: bundle.toString("latin1") });
          const root = await world.#root(
            world.artifacts.has(spec.from) ? spec.from : undefined,
            true,
            "e2b-build",
            spec.mcpRuntimeInstall === WORKSPACE_MCP_NODE_INSTALL,
          );
          const destination = sandboxFilePath(root, spec.contentDestination);
          await mkdir(dirname(destination), { recursive: true });
          await writeFile(destination, bundle, { mode: 0o600 });
          const result = await run(root, "sh", ["-c", spec.script], {});
          if (result.exitCode !== 0) throw new Error(`Fake E2B build failed: ${result.stderr}`);
          return world.#snapshot(root, "e2b-build", "e2b-template");
        },
        async delete(templateId) {
          world.calls.push({ kind: "e2b.template.delete", detail: templateId });
          const path = world.artifacts.get(templateId);
          world.artifacts.delete(templateId);
          world.nodeArtifacts.delete(templateId);
          if (path !== undefined) await rm(path, { recursive: true, force: true });
        },
      },
      sandboxFactory: {
        async create(options) {
          world.calls.push({ kind: "e2b.sandbox.create", detail: options });
          const root = await world.#root(
            options.template,
            options.allowInternetAccess === true,
            "e2b-sandbox",
          );
          const id = root.path.split("/").at(-1) as string;
          world.taskSandboxes.add(id);
          return e2bSandbox(world, root, id);
        },
      },
    };
  }

  /** Modal clients over this world. */
  modal(): { workspaceClient: ModalWorkspaceClient; sandboxFactory: ModalSandboxFactory } {
    const world = this;
    return {
      workspaceClient: {
        async buildImage(input) {
          world.calls.push({ kind: "modal.image.build", detail: input });
          const id = world.#id("modal-base");
          const path = join(world.directory, `artifact-${id}`);
          await mkdir(path, { recursive: true });
          world.artifacts.set(id, path);
          if (input.commands.includes(NODE_INSTALL_LAYER)) world.nodeArtifacts.add(id);
          return id;
        },
        async createSetupSandbox(input) {
          world.calls.push({ kind: "modal.setup.create", detail: input });
          const root = await world.#root(input.imageId, true, "modal-setup");
          const id = root.path.split("/").at(-1) as string;
          const sandbox = modalSandbox(world, root, id);
          return {
            ...sandbox,
            snapshotFilesystem: () => world.#snapshot(root, id, "modal-image"),
          } satisfies ModalSetupSandboxClient;
        },
        async deleteImage(input) {
          world.calls.push({ kind: "modal.image.delete", detail: input });
          const path = world.artifacts.get(input.imageId);
          world.artifacts.delete(input.imageId);
          world.nodeArtifacts.delete(input.imageId);
          if (path !== undefined) await rm(path, { recursive: true, force: true });
        },
      },
      sandboxFactory: {
        async create(input) {
          world.calls.push({ kind: "modal.sandbox.create", detail: input });
          const root = await world.#root(
            input.imageId,
            input.params.blockNetwork !== true,
            "modal-sandbox",
          );
          const id = root.path.split("/").at(-1) as string;
          world.taskSandboxes.add(id);
          return modalSandbox(world, root, id);
        },
      },
    };
  }

  /** True when a process in this sandbox environment sees the network. */
  static async reachable(environment: {
    spawn(spec: { command: string; args: string[] }): Promise<{
      wait(): Promise<{ exitCode: number }>;
    }>;
  }): Promise<boolean> {
    const process = await environment.spawn({
      command: "sh",
      args: ["-c", 'test "$SUPERTAG_FAKE_NETWORK" = reachable'],
    });
    return (await process.wait()).exitCode === 0;
  }

  readTampered(path: string, bytes: Uint8Array): Uint8Array {
    return this.tamper ? this.tamper(path, bytes) : bytes;
  }
}

function mapPath(root: FakeRoot, path: string): string {
  // The sandbox root may end a quoted shell argument, as in `'/workspace'`.
  return path.replace(/\/workspace(?![\w.~-])/gu, `${root.path}${FAKE_SANDBOX_ROOT}`);
}

function sandboxFilePath(root: FakeRoot, path: string): string {
  if (root.imagePath !== undefined) {
    if (!isAbsolute(path)) throw new Error(`Path ${path} is outside the fake image`);
    validateSandboxPath(root, path);
  }
  return mapPath(root, path);
}

async function executableDigests(directory: string): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  async function visit(path: string): Promise<void> {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const file = join(path, entry.name);
      if (entry.isDirectory()) await visit(file);
      else if (entry.isFile()) {
        const mode = statSync(file).mode;
        if ((mode & 0o111) !== 0)
          result.set(
            file.slice(directory.length),
            createHash("sha256")
              .update(await readFile(file))
              .digest("hex"),
          );
      }
    }
  }
  await visit(directory);
  return result;
}

function inRoot(root: FakeRoot, path: string): boolean {
  // Check the nearest existing ancestor as well: a missing leaf under a symlink can escape.
  let ancestor = resolve(path);
  const suffix: string[] = [];
  while (true) {
    try {
      const resolved = resolve(realpathSync(ancestor), ...suffix);
      return resolved === root.path || resolved.startsWith(`${root.path}${sep}`);
    } catch {
      const parent = dirname(ancestor);
      if (parent === ancestor) return false;
      suffix.unshift(ancestor.slice(parent.length + 1));
      ancestor = parent;
    }
  }
}

function validateSandboxPath(root: FakeRoot, path: string): void {
  if (!isAbsolute(path)) return;
  if (path === "/dev/null") return;
  if (!path.startsWith(`${FAKE_SANDBOX_ROOT}/`) && path !== FAKE_SANDBOX_ROOT)
    throw new Error(`Path ${path} is outside the fake image`);
  if (!inRoot(root, mapPath(root, path))) throw new Error(`Path ${path} escapes the fake sandbox`);
}

function trustedExecutable(root: FakeRoot, path: string): boolean {
  if (!inRoot(root, path)) return false;
  const digest = root.trustedExecutables?.get(path.slice(root.path.length));
  if (digest === undefined) return false;
  try {
    return createHash("sha256").update(readFileSync(path)).digest("hex") === digest;
  } catch {
    return false;
  }
}

/** Task writes are data in the fake image, even when copied from an executable host file. */
function confineTaskExecutables(root: FakeRoot): void {
  if (root.imagePath === undefined) return;
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      // Never follow a Task-created symlink out of this sandbox.
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) {
        const mode = lstatSync(path).mode;
        if ((mode & 0o111) !== 0 && !trustedExecutable(root, path)) chmodSync(path, mode & ~0o111);
      }
    }
  };
  visit(root.path);
}

function validateImageCommand(
  root: FakeRoot,
  command: string,
  args: readonly string[],
  cwd: string,
): void {
  if (root.imagePath === undefined) return;
  if (command.includes("/")) {
    if (isAbsolute(command)) validateSandboxPath(root, command);
    const executable = isAbsolute(command) ? mapPath(root, command) : resolve(cwd, command);
    if (!trustedExecutable(root, executable))
      throw new Error(`Executable ${command} is outside the fake image or trusted snapshot`);
  }
  // The host shell has no chroot. Refuse path operands that could reach its filesystem, including
  // paths embedded in a shell script, before handing the command to it.
  for (const arg of args) {
    // Track simple shell directory changes so a Task-copied executable cannot hide behind
    // `cd /workspace; ./program`. This is an image model, not a shell security parser.
    if (command === "sh" && args.includes("-c") && arg === args[args.indexOf("-c") + 1]) {
      let shellCwd = cwd;
      for (const part of arg.split(/(?:;|&&|\|\||\n)/u)) {
        const cd = part.trim().match(/^cd\s+(['"]?)([^\s'";]+)\1(?:\s|$)/u);
        if (cd) {
          const target = cd[2] as string;
          shellCwd = isAbsolute(target) ? mapPath(root, target) : resolve(shellCwd, target);
          if (!inRoot(root, shellCwd)) throw new Error(`Path ${target} escapes the fake sandbox`);
          continue;
        }
        for (const token of part.matchAll(/(?:^|\s)(\.\.?\/[^\s'";|&]+)/gu)) {
          const path = resolve(shellCwd, token[1] as string);
          if (!trustedExecutable(root, path))
            throw new Error(`Executable ${token[1]} is outside the fake image or trusted snapshot`);
        }
      }
    }
    // A `*` before the slash marks a glob such as a git pathspec, not a path.
    for (const match of arg.matchAll(/(?<![\w.~*-])\/(?:[\w.~-]+(?:\/[\w.~-]+)*)/gu)) {
      const path = match[0];
      if (path === "/dev/null") continue;
      validateSandboxPath(root, path);
      const mapped = mapPath(root, path);
      try {
        const stat = statSync(mapped);
        if (stat.isFile() && (stat.mode & 0o111) !== 0 && !trustedExecutable(root, mapped))
          throw new Error(`Executable ${path} is outside the fake image or trusted snapshot`);
      } catch (error) {
        if (error instanceof Error && error.message.includes("trusted snapshot")) throw error;
      }
    }
    if (/(?:^|[\s'";|&(])\.\.\//u.test(arg))
      throw new Error("Relative parent path escapes the fake sandbox");
  }
}

function mapEnvironment(
  root: FakeRoot,
  environment: Readonly<Record<string, string>> | undefined,
): Record<string, string> {
  const mapped = Object.fromEntries(
    Object.entries(environment ?? {})
      .filter(([key]) => !/^(?:DYLD_.*|LD_PRELOAD|BASH_ENV)$/u.test(key))
      .map(([key, value]) => [key, mapPath(root, value)]),
  );
  // Shell subprocesses see only modeled image commands. A Task cannot put a copied host binary
  // on PATH, even when the directory itself is inside its private sandbox.
  const path =
    root.imagePath === undefined
      ? (mapped["PATH"] ?? process.env["PATH"] ?? "/usr/bin:/bin")
      : [
          root.imagePath,
          ...new Set(
            [...(root.trustedExecutables?.keys() ?? [])]
              .filter(
                (file) => file.endsWith("/node") && trustedExecutable(root, join(root.path, file)),
              )
              .map((file) => dirname(join(root.path, file))),
          ),
        ].join(":");
  return {
    ...mapped,
    PATH: path,
    HOME: `${root.path}${FAKE_SANDBOX_ROOT}/home`,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    SUPERTAG_FAKE_NETWORK: root.network ? "reachable" : "blocked",
    ...(root.loopback === undefined
      ? {}
      : {
          NODE_OPTIONS: `--require ${root.loopback.preload}`,
          SUPERTAG_FAKE_LOOPBACK: root.loopback.ports,
        }),
  };
}

/** True when the root's modeled image provides `command`. */
function imageCommand(root: FakeRoot, command: string): boolean {
  return (
    root.imagePath !== undefined &&
    ((PYTHON_SLIM_COMMANDS as readonly string[]).includes(command) ||
      command === "apt-get" ||
      (command === "node" && root.node === true))
  );
}

async function hostCommand(command: string): Promise<string | undefined> {
  for (const directory of (process.env["PATH"] ?? "/usr/bin:/bin").split(":")) {
    const path = join(directory, command);
    try {
      await access(path, constants.X_OK);
      return path;
    } catch {}
  }
  return undefined;
}

interface Running {
  readonly pid: number | undefined;
  readonly stdin: NodeJS.WritableStream;
  readonly stdout: Readable;
  readonly stderr: Readable;
  readonly done: Promise<number>;
  kill(): void;
}

function launch(
  root: FakeRoot,
  command: string,
  args: readonly string[],
  options: { readonly cwd?: string; readonly env?: Readonly<Record<string, string>> },
): Running {
  const cwd = options.cwd === undefined ? root.path : mapPath(root, options.cwd);
  if (options.cwd !== undefined) validateSandboxPath(root, options.cwd);
  validateImageCommand(root, command, args, cwd);
  confineTaskExecutables(root);
  if (
    root.imagePath !== undefined &&
    !command.includes("/") &&
    !imageCommand(root, command) &&
    ![...(root.trustedExecutables?.keys() ?? [])].some(
      (file) => file.endsWith(`/${command}`) && trustedExecutable(root, join(root.path, file)),
    )
  ) {
    const stdin = new PassThrough();
    stdin.resume();
    return {
      pid: undefined,
      stdin,
      stdout: Readable.from([]),
      stderr: Readable.from([Buffer.from(`sh: ${command}: not found\n`)]),
      done: Promise.resolve(127),
      kill: () => stdin.destroy(),
    };
  }
  const executable =
    root.imagePath !== undefined && !command.includes("/")
      ? imageCommand(root, command)
        ? join(root.imagePath, command)
        : ([...(root.trustedExecutables?.keys() ?? [])]
            .filter((file) => file.endsWith(`/${command}`))
            .map((file) => join(root.path, file))
            .find((file) => trustedExecutable(root, file)) ?? join(root.imagePath, command))
      : command.includes("/") && !isAbsolute(command)
        ? resolve(cwd, command)
        : mapPath(root, command);
  // An absolute host executable must not silently bypass the image's PATH. Staged executables
  // are allowed when they live in this sandbox's private filesystem.
  const child = spawn(
    executable,
    args.map((arg) => mapPath(root, arg)),
    {
      cwd,
      env: mapEnvironment(root, options.env),
      stdio: "pipe",
      // Its own process group, so a kill also stops a shell's children: Linux's dash forks the
      // command where macOS's sh execs it, and an orphan would hold the pipes open.
      detached: true,
    },
  );
  child.stdin.on("error", () => {});
  const done = new Promise<number>((resolvePromise) => {
    child.on("error", () => resolvePromise(127));
    child.on("close", (code) => resolvePromise(code ?? 137));
  });
  return {
    pid: child.pid,
    stdin: child.stdin,
    stdout: child.stdout,
    stderr: child.stderr,
    done,
    kill: () => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    },
  };
}

async function collect(stream: Readable): Promise<string> {
  let text = "";
  for await (const chunk of stream) text += String(chunk);
  return text;
}

async function run(
  root: FakeRoot,
  command: string,
  args: readonly string[],
  options: { readonly cwd?: string; readonly env?: Readonly<Record<string, string>> },
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  await mkdir(join(root.path, FAKE_SANDBOX_ROOT, "home"), { recursive: true });
  if (options.cwd !== undefined)
    await mkdir(sandboxFilePath(root, options.cwd), { recursive: true });
  const running = launch(root, command, args, options);
  running.stdin.end();
  const [stdout, stderr, exitCode] = await Promise.all([
    collect(running.stdout),
    collect(running.stderr),
    running.done,
  ]);
  return { exitCode, stdout, stderr };
}

/**
 * A fake E2B sandbox. Killing it records `e2b.sandbox.kill`, stops its background processes, and
 * makes every later command or file operation fail, so work after disposal cannot pass unnoticed.
 */
function e2bSandbox(world: FakeSandboxWorld, root: FakeRoot, id: string): E2BSandboxClient {
  let killed = false;
  const background = new Set<Running>();
  const alive = () => {
    if (killed) throw new Error(`Fake E2B sandbox ${id} was terminated`);
  };
  const runCommand = async (
    command: string,
    options: {
      background?: boolean;
      cwd?: string;
      envs?: Record<string, string>;
      onStdout?: (data: string) => void | Promise<void>;
      onStderr?: (data: string) => void | Promise<void>;
    } = {},
  ) => {
    alive();
    world.calls.push({ kind: "e2b.sandbox.run", detail: { id, command, options } });
    await mkdir(join(root.path, FAKE_SANDBOX_ROOT, "home"), { recursive: true });
    const running = launch(root, "sh", ["-c", command], {
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options.envs === undefined ? {} : { env: options.envs }),
    });
    let stdout = "";
    let stderr = "";
    running.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      stdout += text;
      void options.onStdout?.(text);
    });
    running.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
      void options.onStderr?.(chunk.toString("utf8"));
    });
    const wait = async () => {
      const exitCode = await running.done;
      const path =
        options.envs?.["SUPERTAG_FILE_LIMIT"] === undefined
          ? undefined
          : options.envs["SUPERTAG_FILE_PATH"];
      if (path !== undefined && exitCode === 0)
        stdout = Buffer.from(
          world.readTampered(path, new Uint8Array(Buffer.from(stdout, "base64"))),
        ).toString("base64");
      return { exitCode, stdout, stderr };
    };
    if (options.background) {
      background.add(running);
      void running.done.then(() => background.delete(running));
      return {
        pid: running.pid ?? 0,
        wait,
        kill: async () => {
          world.calls.push({ kind: "e2b.process.kill", detail: { id, pid: running.pid } });
          running.kill();
          return true;
        },
        sendStdin: async (data: string | Uint8Array) => {
          running.stdin.write(data);
        },
        closeStdin: async () => {
          running.stdin.end();
        },
      };
    }
    running.stdin.end();
    return wait();
  };
  return {
    sandboxId: id,
    files: {
      async makeDir(path) {
        alive();
        await mkdir(sandboxFilePath(root, path), { recursive: true });
        return true;
      },
      async write(path, data) {
        alive();
        await writeFile(
          sandboxFilePath(root, path),
          typeof data === "string" ? data : Buffer.from(data),
        );
      },
      async read(path) {
        alive();
        return new Uint8Array(await readFile(sandboxFilePath(root, path)));
      },
    },
    commands: { run: runCommand } as unknown as E2BSandboxClient["commands"],
    kill: async () => {
      world.calls.push({ kind: "e2b.sandbox.kill", detail: { id } });
      killed = true;
      for (const running of background) running.kill();
      return true;
    },
  };
}

function modalSandbox(world: FakeSandboxWorld, root: FakeRoot, id: string): ModalSandboxClient {
  return {
    sandboxId: id,
    async exec(command, options) {
      world.calls.push({ kind: "modal.sandbox.exec", detail: { id, command, options } });
      await mkdir(join(root.path, FAKE_SANDBOX_ROOT, "home"), { recursive: true });
      const [program, ...args] = command;
      const running = launch(root, program as string, args, {
        ...(options.workdir === undefined ? {} : { cwd: options.workdir }),
        ...(options.env === undefined ? {} : { env: options.env }),
      });
      const isRead = args[2] === "read";
      const readPath = args[3] ?? "";
      let stdout = Readable.toWeb(running.stdout) as ReadableStream<Uint8Array>;
      if (isRead) {
        const bytes = new Uint8Array(Buffer.from(await collectBytes(running.stdout)));
        const tampered = world.readTampered(readPath, bytes);
        stdout = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(tampered);
            controller.close();
          },
        });
      }
      return {
        stdin: {
          writeBytes: (bytes) =>
            new Promise<void>((resolvePromise, reject) =>
              running.stdin.write(bytes, (error) => (error ? reject(error) : resolvePromise())),
            ),
          close: () =>
            new Promise<void>((resolvePromise) => {
              running.stdin.end(() => resolvePromise());
            }),
        },
        stdout,
        stderr: Readable.toWeb(running.stderr) as ReadableStream<Uint8Array>,
        wait: () => running.done,
      };
    },
    terminate: async () => 0,
  };
}

async function collectBytes(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks);
}
