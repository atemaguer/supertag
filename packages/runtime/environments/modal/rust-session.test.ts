import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import type { ModalSandboxClient } from "./src/index.ts";
import { sandboxOwnershipMetadata, sandboxOwnershipName } from "./src/rust-provider/ownership.ts";
import {
  createModalWorkspaceSession,
  type ModalWorkspaceScope,
} from "./src/rust-provider/session.ts";

const owner = {
  hostId: "host-modal",
  hostGeneration: 9_007_199_254_740_993n,
  taskId: "task-modal",
  attemptId: "attempt-modal",
  allocationId: "allocation-modal",
};
const sandboxId = "sb-0000000000000000000000";
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  try {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  } finally {
    vi.unstubAllEnvs();
  }
});

function collected(child: ChildProcess) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8").on("data", (text) => {
      stdout += text;
    });
    child.stderr?.setEncoding("utf8").on("data", (text) => {
      stderr += text;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 137, stdout, stderr }));
    child.stdin?.end();
  });
}

async function fixture() {
  const roots = new Set<string>();
  const children: { child: ChildProcess; done: Promise<number>; running: boolean }[] = [];
  let allocated = false;
  let finished = false;
  let tags: Record<string, string> = {};
  let nextExit: number | undefined;
  const reap = async () => {
    for (const record of children) {
      if (record.running && record.child.pid) {
        try {
          process.kill(
            process.platform === "win32" ? record.child.pid : -record.child.pid,
            "SIGKILL",
          );
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        }
      }
    }
    await Promise.all(children.map((record) => record.done));
  };
  cleanups.push(async () => {
    await reap();
    for (const root of roots) await rm(root, { recursive: true, force: true });
  });
  const exec = vi.fn<ModalSandboxClient["exec"]>(async (command, options) => {
    for (const value of command) {
      if (/^\/tmp\/supertag-workspace-[a-f0-9-]{36}$/u.test(value)) roots.add(value);
    }
    if (nextExit !== undefined && command.includes("split-write")) {
      const code = nextExit;
      nextExit = undefined;
      return {
        stdin: { async writeBytes() {}, async close() {} },
        stdout: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.close();
          },
        }),
        stderr: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.close();
          },
        }),
        async wait() {
          return code;
        },
      };
    }
    const [program, ...args] = command;
    if (!program) throw new Error("Missing fixture program");
    const child = spawn(program, args, {
      cwd: options.workdir,
      env: { PATH: process.env["PATH"], ...options.env },
      detached: process.platform !== "win32",
      stdio: "pipe",
    });
    child.stdin.on("error", () => {});
    const done = new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => resolve(code ?? 137));
    });
    const record = { child, done, running: true };
    void done
      .finally(() => {
        record.running = false;
      })
      .catch(() => undefined);
    children.push(record);
    return {
      stdin: {
        writeBytes: (bytes) =>
          new Promise<void>((resolve, reject) => {
            child.stdin.write(bytes, (error) => (error ? reject(error) : resolve()));
          }),
        close: () =>
          new Promise<void>((resolve, reject) => {
            child.stdin.once("error", reject);
            child.stdin.end(resolve);
          }),
      },
      stdout: Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
      stderr: Readable.toWeb(child.stderr) as ReadableStream<Uint8Array>,
      wait: () => done,
    };
  });
  const terminate = vi.fn<ModalSandboxClient["terminate"]>(async () => {
    await reap();
    finished = true;
    return 137;
  });
  const sandbox: ModalSandboxClient = { sandboxId, exec, terminate };
  const create = vi.fn<ModalWorkspaceScope["create"]>(async (params) => {
    allocated = true;
    tags = { ...params.tags };
    return sandbox;
  });
  const inventory = {
    find: vi.fn<ModalWorkspaceScope["inventory"]["find"]>(async () =>
      allocated && !finished ? [{ sandboxId, metadata: tags }] : [],
    ),
    get: vi.fn<ModalWorkspaceScope["inventory"]["get"]>(async (id) => {
      if (!allocated || id !== sandboxId) throw new Error("No matching sandbox");
      return { sandboxId, metadata: tags };
    }),
    poll: vi.fn<ModalWorkspaceScope["inventory"]["poll"]>(async () => (finished ? 137 : null)),
    terminate: vi.fn<ModalWorkspaceScope["inventory"]["terminate"]>(() =>
      terminate({ wait: true }),
    ),
  };
  const close = vi.fn();
  const open = vi.fn(async (): Promise<ModalWorkspaceScope> => ({ create, inventory, close }));
  const session = createModalWorkspaceSession({ open });
  cleanups.push(() => session.close());
  return {
    session,
    open,
    create,
    close,
    inventory,
    exec,
    terminate,
    recovery() {
      const value = createModalWorkspaceSession({ open });
      cleanups.push(() => value.close());
      return value;
    },
    failNextProcess(code: number) {
      nextExit = code;
    },
    runningChildren() {
      return children.filter((record) => record.running).length;
    },
  };
}

async function bundle(linkTarget = "a.txt") {
  const root = await mkdtemp(join(tmpdir(), "supertag-modal-bundle-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const git = async (...args: string[]) => {
    const result = await collected(
      spawn("git", args, {
        cwd: root,
        env: {
          PATH: process.env["PATH"],
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
        },
        stdio: "pipe",
      }),
    );
    if (result.code !== 0) throw new Error(result.stderr);
    return result.stdout.trim();
  };
  const commit = () =>
    git(
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "-c",
      "commit.gpgSign=false",
      "commit",
      "-qm",
      "fixture",
    );
  await git("init", "-q", "--template=");
  await writeFile(join(root, "a.txt"), "base\n");
  await git("add", ".");
  await commit();
  await writeFile(join(root, "a.txt"), "runtime start\n");
  await writeFile(join(root, ".gitattributes"), "a.txt text eol=crlf\n");
  await writeFile(join(root, "runner"), "#!/bin/sh\nexit 0\n");
  await chmod(join(root, "runner"), 0o755);
  await symlink(linkTarget, join(root, "link"));
  await git("add", ".");
  await commit();
  const startCommit = await git("rev-parse", "HEAD");
  const ref = "refs/heads/supertag-deliveries/modal-fixture";
  await git("update-ref", ref, startCommit);
  await writeFile(join(root, "a.txt"), "newer source HEAD must not leak\n");
  await git("add", ".");
  await commit();
  expect(await git("rev-parse", "HEAD")).not.toBe(startCommit);
  const path = join(root, "source.bundle");
  await git("bundle", "create", path, ref);
  const bytes = await readFile(path);
  return {
    bytes,
    header: {
      startCommit,
      bundle: {
        sha256: createHash("sha256").update(bytes).digest("hex"),
        byteLength: BigInt(bytes.length),
      },
    },
  };
}

function unpack(bytes: Uint8Array) {
  const input = Buffer.from(bytes);
  expect(input.subarray(0, 9).toString()).toBe("STWTREE1\n");
  let offset = 13 + input.readUInt32BE(9);
  const manifest = JSON.parse(input.subarray(13, offset).toString()) as {
    entries: { path: string; mode: string; size: number }[];
  };
  const entries = manifest.entries.map(({ path, mode, size }) => {
    const body = input.subarray(offset, offset + size);
    offset += size;
    return { path, mode, body: body.toString() };
  });
  expect(offset).toBe(input.length);
  return entries;
}

/**
 * A Workspace MCP server that ignores SIGTERM and forks a child that ignores it too and holds
 * the server's output open. Returns the server's start and the child's pid, once written.
 */
async function forkingMcpServer() {
  const directory = await mkdtemp(join(tmpdir(), "supertag-mcp-fork-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const pidFile = join(directory, "child.pid");
  const script = `trap '' TERM; sh -c 'trap "" TERM; echo $$ > "$0.tmp"; mv "$0.tmp" "$0"; exec sleep 60' "${pidFile}" & echo ready; while :; do sleep 1; done`;
  const childPid = async () => {
    for (let attempt = 0; attempt < 200; attempt++) {
      const text = await readFile(pidFile, "utf8").catch(() => "");
      if (text.trim()) return Number(text.trim());
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error("the forked child never started");
  };
  const exited = async (pid: number) => {
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        process.kill(pid, 0);
      } catch {
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return false;
  };
  return { start: { name: "tools", command: "sh", args: ["-c", script] }, childPid, exited };
}

it("stops a Workspace MCP server's process group before capture without ending the sandbox", async () => {
  const f = await fixture();
  const { header, bytes } = await bundle();
  await f.session.allocate({ owner, timeoutMs: 60_000, allowedActions: ["files:read"] });
  await f.session.stage({ ...header, mcpCommit: header.startCommit }, bytes);
  const { start, childPid, exited } = await forkingMcpServer();
  const server = await f.session.startMcpServer(start);
  const pid = await childPid();
  const started = Date.now();
  // On Modal a process's terminate is the sandbox's, so the stop goes through the input.
  const captured = await f.session.capture();
  expect(Date.now() - started).toBeLessThan(4_500);
  expect(captured.tree.byteLength).toBeGreaterThan(0n);
  expect(await exited(pid)).toBe(true);
  await expect(server.wait()).resolves.toBeDefined();
  expect(f.terminate).not.toHaveBeenCalled();
  expect(f.inventory.terminate).not.toHaveBeenCalled();
}, 20_000);

it("stops a Workspace MCP server that is not reading its input before capture", async () => {
  const f = await fixture();
  const session = f.session;
  const { header, bytes } = await bundle();
  await session.allocate({ owner, timeoutMs: 60_000, allowedActions: ["files:read"] });
  await session.stage({ ...header, mcpCommit: header.startCommit }, bytes);
  const server = await session.startMcpServer({
    name: "tools",
    command: "sh",
    args: ["-c", "exec sleep 60"],
  });
  // More input than a pipe holds, which a server busy elsewhere never takes.
  await server.write?.(new Uint8Array(256 * 1024));
  const started = Date.now();
  const captured = await session.capture();
  expect(Date.now() - started).toBeLessThan(4_500);
  expect(captured.tree.byteLength).toBeGreaterThan(0n);
  await expect(server.wait()).resolves.toBeDefined();
  expect(f.terminate).not.toHaveBeenCalled();
}, 20_000);

it("allocates once with create-time ownership and a bounded whole-second lifetime, without sandbox credentials", async () => {
  vi.stubEnv("MODAL_TOKEN_ID", "synthetic-modal-id");
  vi.stubEnv("MODAL_TOKEN_SECRET", "synthetic-modal-secret");
  vi.stubEnv("CURSOR_API_KEY", "synthetic-cursor-secret");
  const f = await fixture();
  await expect(
    f.session.allocate({ owner, timeoutMs: 99_999_999, allowedActions: ["files:read"] }),
  ).resolves.toEqual({ sandboxId });
  expect(f.create).toHaveBeenCalledExactlyOnceWith({
    name: sandboxOwnershipName(owner),
    tags: sandboxOwnershipMetadata(owner),
    timeoutMs: 3_600_000,
    blockNetwork: true,
  });
  expect(f.inventory.get).toHaveBeenCalledExactlyOnceWith(sandboxId);
  expect(JSON.stringify(f.create.mock.calls)).not.toContain("synthetic-");
  await expect(f.session.allocate({ owner, timeoutMs: 1_001, allowedActions: [] })).rejects.toThrow(
    /allocat/i,
  );
  await expect(f.session.stop({ owner: { ...owner, hostGeneration: 1n } })).rejects.toThrow(
    /owner/i,
  );
  expect(f.inventory.terminate).not.toHaveBeenCalled();
  await expect(f.session.stop({ owner, sandboxId })).resolves.toEqual({
    state: "stopped",
    sandboxId,
  });
  expect(f.terminate).toHaveBeenCalledExactlyOnceWith({ wait: true });
});

it("refuses command authority before opening a provider client", async () => {
  const f = await fixture();
  await expect(
    f.session.allocate({ owner, timeoutMs: 60_000, allowedActions: ["commands:execute"] }),
  ).rejects.toThrow(/commands/i);
  expect(f.open).not.toHaveBeenCalled();
  expect(f.create).not.toHaveBeenCalled();
});

it("rounds a fractional-second lifetime for the pinned Modal create contract", async () => {
  const f = await fixture();
  await f.session.allocate({ owner, timeoutMs: 60_001, allowedActions: [] });
  expect(f.create.mock.calls[0]?.[0].timeoutMs).toBe(61_000);
});

it("stages the exact runtime commit through binary exec and captures edits with modes and safe symlinks", async () => {
  vi.stubEnv("MODAL_TOKEN_SECRET", "synthetic-provider-secret");
  vi.stubEnv("CURSOR_API_KEY", "synthetic-harness-secret");
  const f = await fixture();
  const { header, bytes } = await bundle();
  await f.session.allocate({
    owner,
    timeoutMs: 60_000,
    allowedActions: ["files:read", "files:write"],
  });
  await f.session.stage(header, bytes);
  await expect(f.session.execute({ kind: "read", path: "a.txt" })).resolves.toMatchObject({
    text: expect.stringContaining("runtime start"),
  });
  await f.session.execute({
    kind: "edit",
    path: "a.txt",
    oldText: "runtime start",
    newText: "changed in Modal",
  });
  await f.session.execute({ kind: "write", path: "z-last", content: "new content" });
  await expect(f.session.execute({ kind: "read", path: ".git/config" })).rejects.toThrow(
    /Git metadata/,
  );
  const result = await f.session.capture();
  expect(result.tree).toEqual({
    sha256: createHash("sha256").update(result.bytes).digest("hex"),
    byteLength: BigInt(result.bytes.byteLength),
  });
  expect(unpack(result.bytes)).toEqual([
    { path: ".gitattributes", mode: "100644", body: "a.txt text eol=crlf\n" },
    { path: "a.txt", mode: "100644", body: "changed in Modal\n" },
    { path: "link", mode: "120000", body: "a.txt" },
    { path: "runner", mode: "100755", body: "#!/bin/sh\nexit 0\n" },
    { path: "z-last", mode: "100644", body: "new content" },
  ]);
  await expect(f.session.capture()).resolves.toEqual(result);
  await expect(
    f.session.execute({ kind: "write", path: "after", content: "sealed" }),
  ).rejects.toThrow(/sealed/);
  expect(f.exec.mock.calls.every(([, options]) => options.mode === "binary")).toBe(true);
  expect(JSON.stringify(f.exec.mock.calls)).not.toContain("synthetic-");
  await expect(f.session.stop({ owner })).resolves.toEqual({ state: "stopped", sandboxId });
  expect(f.runningChildren()).toBe(0);
}, 15_000);

it("rejects a corrupt bundle before remote exec and refuses an unadvertised start commit", async () => {
  const f = await fixture();
  const { header, bytes } = await bundle();
  await f.session.allocate({ owner, timeoutMs: 60_000, allowedActions: ["files:read"] });
  await expect(
    f.session.stage({ ...header, bundle: { ...header.bundle, sha256: "0".repeat(64) } }, bytes),
  ).rejects.toThrow(/digest/);
  expect(f.exec).not.toHaveBeenCalled();
  await expect(f.session.stage({ ...header, startCommit: "0".repeat(40) }, bytes)).rejects.toThrow(
    /could not be staged/,
  );
  await expect(f.session.capture()).rejects.toThrow(/staged/);
}, 15_000);

it("redacts a lost Create response and recovers it only through exact Modal ownership and terminal status", async () => {
  const f = await fixture();
  const create = f.create.getMockImplementation();
  if (!create) throw new Error("Missing fixture create");
  f.create.mockImplementationOnce(async (params) => {
    await create(params);
    throw new Error("private provider credential");
  });
  await expect(
    f.session.allocate({ owner, timeoutMs: 60_000, allowedActions: [] }),
  ).rejects.toThrow(/^Modal Workspace allocation could not be verified$/);
  await f.session.close();
  expect(f.inventory.find).not.toHaveBeenCalled();
  expect(f.inventory.terminate).not.toHaveBeenCalled();
  expect(f.close).toHaveBeenCalledOnce();
  await expect(f.recovery().stop({ owner })).resolves.toEqual({ state: "stopped", sandboxId });
  expect(f.inventory.find).toHaveBeenCalledExactlyOnceWith(sandboxOwnershipMetadata(owner));
  expect(f.inventory.poll).toHaveBeenCalledExactlyOnceWith(sandboxId);
  expect(f.inventory.terminate).toHaveBeenCalledExactlyOnceWith(sandboxId);
});

it("never accepts a caller's unrelated sandbox ID while allocation is unresolved", async () => {
  const f = await fixture();
  const create = f.create.getMockImplementation();
  if (!create) throw new Error("Missing fixture create");
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  f.create.mockImplementationOnce(async (params) => {
    started.resolve();
    await release.promise;
    return create(params);
  });
  const allocating = f.session.allocate({ owner, timeoutMs: 60_000, allowedActions: [] });
  const failed = expect(allocating).rejects.toThrow(/could not be verified/);
  await started.promise;
  try {
    await expect(f.session.stop({ owner, sandboxId: "sb-unrelated" })).rejects.toThrow(
      /unverified/,
    );
    expect(f.inventory.get).not.toHaveBeenCalled();
    await expect(f.session.stop({ owner })).resolves.toEqual({ state: "uncertain" });
  } finally {
    release.resolve();
    await failed;
  }
  await expect(f.recovery().stop({ owner })).resolves.toEqual({ state: "stopped", sandboxId });
});

it("withholds a tree after an unsettled write wrapper and closes the acknowledged allocation", async () => {
  const f = await fixture();
  const { header, bytes } = await bundle();
  await f.session.allocate({
    owner,
    timeoutMs: 60_000,
    allowedActions: ["files:read", "files:write"],
  });
  await f.session.stage(header, bytes);
  f.failNextProcess(137);
  await expect(
    f.session.execute({ kind: "write", path: "a.txt", content: "in flight" }),
  ).resolves.toMatchObject({ isError: true });
  await expect(f.session.capture()).rejects.toThrow(/could not be captured/);
  await f.session.close();
  expect(f.inventory.terminate).toHaveBeenCalledExactlyOnceWith(sandboxId);
  expect(f.close).toHaveBeenCalledOnce();
  expect(f.runningChildren()).toBe(0);
}, 15_000);

it("refuses escaping symlinks in the pinned source before exposing file tools", async () => {
  const f = await fixture();
  const { header, bytes } = await bundle("../outside");
  await f.session.allocate({ owner, timeoutMs: 60_000, allowedActions: ["files:read"] });
  await expect(f.session.stage(header, bytes)).rejects.toThrow(/could not be staged/);
  await expect(f.session.execute({ kind: "read", path: "a.txt" })).rejects.toThrow(/staged/);
  await expect(f.session.capture()).rejects.toThrow(/staged/);
}, 15_000);

it("builds the devcontainer's layers into the sandbox image and runs its setup in the checkout", async () => {
  const f = await fixture();
  const { header, bytes } = await bundle();
  const environment = {
    image: "python:3.13-slim",
    dockerfileCommands: ["USER root", "RUN install-tools", "USER nobody"],
    user: "nobody",
    setupCommands: [`export TOOL_HOME="$1"'/.tool'`, `sh -c 'echo "$TOOL_HOME" > .setup-out'`],
  };
  await f.session.allocate({
    owner,
    timeoutMs: 60_000,
    allowedActions: ["files:read"],
    environment,
  });
  // The image ends as the devcontainer's user, so staging, setup, and MCP servers run as it.
  expect(f.create).toHaveBeenCalledExactlyOnceWith({
    name: sandboxOwnershipName(owner),
    tags: sandboxOwnershipMetadata(owner),
    timeoutMs: 60_000,
    blockNetwork: true,
    image: { image: "python:3.13-slim", dockerfileCommands: environment.dockerfileCommands },
  });
  await f.session.stage(header, bytes);
  const out = unpack((await f.session.capture()).bytes).find(
    (entry) => entry.path === ".setup-out",
  );
  expect(out?.body).toMatch(/\/supertag-workspace-[^/]+\/checkout\/\.tool\n$/u);
  await f.session.stop({ owner });

  // Setup alone needs no image build.
  const plain = await fixture();
  await plain.session.allocate({
    owner,
    timeoutMs: 60_000,
    allowedActions: [],
    environment: { dockerfileCommands: [], setupCommands: ["true"] },
  });
  expect(plain.create.mock.calls[0]?.[0]).not.toHaveProperty("image");
  await plain.session.stop({ owner });
}, 15_000);
