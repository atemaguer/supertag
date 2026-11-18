import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { chmod, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceConfigurationError } from "@supertag/worker-sdk/internal/rust-workspace-provider";
import { NotFoundError } from "modal";
import { afterEach, expect, it, vi } from "vitest";
import {
  collected,
  fakePrivileged,
  relayInputs,
  relayOutput,
  sandboxId,
  fixture as sharedFixture,
} from "./rust-fixture.ts";
import { sandboxOwnershipMetadata, sandboxOwnershipName } from "./src/rust-provider/ownership.ts";
import { missingApp } from "./src/rust-provider/session.ts";

const owner = {
  hostId: "host-modal",
  hostGeneration: 9_007_199_254_740_993n,
  taskId: "task-modal",
  attemptId: "attempt-modal",
  allocationId: "allocation-modal",
};
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  try {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  } finally {
    vi.unstubAllEnvs();
  }
});

const fixture = (
  ...args: Parameters<typeof sharedFixture> extends [unknown, ...infer Rest] ? Rest : never
) => sharedFixture(cleanups, ...args);

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
  return { start: { name: "tools", command: "sh", args: ["-c", script] }, childPid };
}

/**
 * Milliseconds from `since` until `pid` is gone, or undefined after 15 seconds. Poll it alongside
 * the call that stops the process, so the time covers the stop alone.
 */
async function goneAfter(pid: number, since: number): Promise<number | undefined> {
  while (Date.now() - since < 15_000) {
    try {
      process.kill(pid, 0);
    } catch {
      return Date.now() - since;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return undefined;
}

/**
 * The supervisor's stop schedule: half a second after a server's input ends, SIGTERM; two seconds
 * later, SIGKILL to its group; plus margin. Only that stop is timed. The Git work capture does
 * afterwards takes as long as the machine makes it, so it is not timed.
 */
const MCP_STOP_BOUND_MS = 4_500;

it("stops a Workspace MCP server's process group before capture without ending the sandbox", async () => {
  const f = await fixture();
  const { header, bytes } = await bundle();
  await f.session.allocate({ owner, timeoutMs: 60_000, allowedActions: ["files:read"] });
  await f.session.stage({ ...header, mcpCommit: header.startCommit }, bytes);
  const { start, childPid } = await forkingMcpServer();
  const server = await f.session.startStdioServer({ kind: "mcp", ...start });
  const pid = await childPid();
  const started = Date.now();
  const gone = goneAfter(pid, started);
  // On Modal a process's terminate is the sandbox's, so the stop goes through the input.
  const captured = await f.session.capture();
  expect(captured.tree.byteLength).toBeGreaterThan(0n);
  // The child ignored SIGTERM, so only the group's SIGKILL ends it.
  const stoppedAfter = await gone;
  expect(stoppedAfter).toBeDefined();
  expect(stoppedAfter).toBeLessThan(MCP_STOP_BOUND_MS);
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
  const server = await session.startStdioServer({
    kind: "mcp",
    name: "tools",
    command: "sh",
    args: ["-c", "exec sleep 60"],
  });
  // More input than a pipe holds, which a server busy elsewhere never takes.
  await server.write?.(new Uint8Array(256 * 1024));
  const started = Date.now();
  const stopped = server.wait().then(() => Date.now() - started);
  const captured = await session.capture();
  expect(captured.tree.byteLength).toBeGreaterThan(0n);
  expect(await stopped).toBeLessThan(MCP_STOP_BOUND_MS);
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

it("admits commands only in a sandbox it can seal", async () => {
  const f = await fixture(false);
  await expect(
    f.session.allocate({
      owner,
      timeoutMs: 60_000,
      allowedActions: ["files:write", "commands:execute"],
    }),
  ).rejects.toThrow(/allocation/i);
  expect(f.session.admitsCommands()).toBe(false);
});

it("stops a timed-out command inside the sandbox without ending it, then seals before capture", async () => {
  const privileged = fakePrivileged();
  const f = await fixture(privileged);
  const { header, bytes } = await bundle();
  await f.session.allocate({
    owner,
    timeoutMs: 60_000,
    allowedActions: ["files:read", "files:write", "commands:execute"],
  });
  await f.session.stage(header, bytes);
  const started = Date.now();
  const late = await f.session.execute({
    kind: "command",
    command: "echo started; sleep 30; echo late > late.txt",
    timeoutMs: 1_000,
  });
  expect(late).toMatchObject({ isError: true, text: expect.stringContaining("deadline") });
  expect(Date.now() - started).toBeLessThan(10_000);
  // On Modal a process's terminate is the sandbox's: the deadline must never reach it.
  expect(f.terminate).not.toHaveBeenCalled();
  await expect(
    f.session.execute({ kind: "command", command: "echo next > next.txt; echo ok" }),
  ).resolves.toEqual({ text: "ok\n", isError: false });
  const captured = await f.session.capture();
  expect(privileged).toHaveBeenCalledTimes(2);
  const paths = unpack(captured.bytes).map((entry) => entry.path);
  expect(paths).toContain("next.txt");
  expect(paths).not.toContain("late.txt");
  expect(f.terminate).not.toHaveBeenCalled();
}, 30_000);

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

it("snapshots a preparation sandbox into an image, starts from it, and deletes it on eviction", async () => {
  const preparation = await fixture();
  await preparation.session.allocate({
    owner,
    timeoutMs: 60_000,
    allowedActions: [],
    prepare: true,
    environment: {
      image: "python:3.13-slim",
      dockerfileCommands: ["RUN install-tools"],
      setupCommands: [],
    },
  });
  // The preparation builds the devcontainer's layers; the snapshot needs a staged sandbox.
  expect(preparation.create.mock.calls[0]?.[0]).toHaveProperty("image");
  await expect(preparation.session.snapshot()).rejects.toThrow(/staged preparation/u);
  await preparation.session.stop({ owner });

  const task = await fixture();
  await task.session.allocate({
    owner,
    timeoutMs: 60_000,
    allowedActions: ["files:read"],
    preparedArtifact: "im-prepared0000000000000000",
    environment: {
      image: "python:3.13-slim",
      dockerfileCommands: ["RUN install-tools"],
      setupCommands: [],
    },
  });
  // A prepared image already holds the layers: none is built again.
  expect(task.create).toHaveBeenCalledExactlyOnceWith({
    name: sandboxOwnershipName(owner),
    tags: sandboxOwnershipMetadata(owner),
    timeoutMs: 60_000,
    blockNetwork: true,
    artifact: "im-prepared0000000000000000",
  });
  await task.session.stop({ owner });
  await task.session.removeArtifact("im-prepared0000000000000000");
  expect(task.deleteImage).toHaveBeenCalledWith("im-prepared0000000000000000");
});

it("reports its sandbox lost only once Modal reports that sandbox finished", async () => {
  const f = await fixture();
  const { header, bytes } = await bundle();
  await f.session.allocate({
    owner,
    timeoutMs: 60_000,
    allowedActions: ["files:read", "files:write"],
  });
  await f.session.stage(header, bytes);
  const outcome = (path: string) =>
    f.session.execute({ kind: "read", path }).then(
      (result) => result,
      (error: unknown) => ({ thrown: String(error) }),
    );
  // A tool error in a live sandbox is not a loss.
  const missing = await outcome("missing.txt");
  expect(missing).toMatchObject({ isError: true });
  expect(missing).not.toHaveProperty("sandboxLost");
  f.exec.mockRejectedValue(new Error("stream reset"));
  // Modal's NotFound, or a timeout, does not prove the sandbox stopped.
  f.inventory.get.mockRejectedValueOnce(new Error("NotFound"));
  expect(await outcome("a.txt")).not.toHaveProperty("sandboxLost");
  f.inventory.poll.mockRejectedValueOnce(new Error("deadline exceeded"));
  expect(await outcome("a.txt")).not.toHaveProperty("sandboxLost");
  // Still running: not gone.
  f.inventory.poll.mockResolvedValueOnce(null);
  expect(await outcome("a.txt")).not.toHaveProperty("sandboxLost");
  // Another owner's tags on that ID prove nothing about this sandbox.
  f.inventory.get.mockResolvedValueOnce({ sandboxId, metadata: {} });
  f.inventory.poll.mockResolvedValueOnce(137);
  expect(await outcome("a.txt")).not.toHaveProperty("sandboxLost");
  // The exact owned sandbox reports a terminal exit code: it is gone.
  f.inventory.poll.mockResolvedValueOnce(137);
  expect(await outcome("a.txt")).toEqual({
    text: "The Modal sandbox no longer exists.",
    isError: true,
    sandboxLost: true,
  });
  const polled = f.inventory.poll.mock.calls.length;
  expect(await outcome("a.txt")).toMatchObject({ sandboxLost: true });
  expect(f.inventory.poll.mock.calls.length).toBe(polled);
});

it("names a missing Modal app instead of an unverified allocation", async () => {
  const missing = missingApp(new NotFoundError("App 'live' not found"), "live", "main");
  expect(missing).toBeInstanceOf(WorkspaceConfigurationError);
  expect((missing as Error).message).toBe(
    "Modal app live was not found in environment main: deploy or create it, or set SUPERTAG_MODAL_WORKSPACE_APP to an existing app",
  );
  const other = new Error("private provider detail");
  expect(missingApp(other, "live", "main")).toBe(other);
  // The session passes the configuration error through; any other failure stays opaque.
  const f = await fixture();
  f.create.mockImplementationOnce(async () => {
    throw missing;
  });
  await expect(
    f.session.allocate({ owner, timeoutMs: 60_000, allowedActions: [] }),
  ).rejects.toThrow(/^Modal app live was not found in environment main/);
  await f.session.close();
}, 15_000);
it("keeps blockNetwork and carries a network-scoped Task's connections over the relay's exec", async () => {
  // The Attempt's egress proxy, on this host's loopback.
  const seen: string[] = [];
  const proxy = createServer((socket) => {
    socket.once("data", (data) => {
      seen.push(data.toString());
      socket.write("HTTP/1.1 200 Connection established\r\n\r\n");
    });
  }).listen(0, "127.0.0.1");
  await once(proxy, "listening");
  cleanups.push(async () => {
    proxy.close();
  });
  const privileged = fakePrivileged();
  const f = await fixture(privileged);
  const { header, bytes } = await bundle();
  const egress = {
    proxy: `127.0.0.1:${(proxy.address() as { port: number }).port}`,
    variables: { HTTPS_PROXY: "http://attempt:secret@127.0.0.1:3128" },
    caPem: "-----BEGIN CERTIFICATE-----\nfixture\n-----END CERTIFICATE-----\n",
  };
  // The relay serves commands only, and the proxy is only ever this host's loopback.
  for (const [actions, value] of [
    [["files:read"], egress],
    [["files:write", "commands:execute"], { ...egress, proxy: "10.0.0.1:3128" }],
  ] as const)
    await expect(
      fixture(fakePrivileged()).then(({ session }) =>
        session.allocate({ owner, timeoutMs: 60_000, allowedActions: [...actions], egress: value }),
      ),
    ).rejects.toThrow(/egress/u);
  await f.session.allocate({
    owner,
    timeoutMs: 60_000,
    allowedActions: ["files:read", "files:write", "commands:execute"],
    egress,
  });
  // No tunnel and no allow-list: the sandbox has no network at all, DNS included.
  expect(f.create.mock.calls[0]?.[0].blockNetwork).toBe(true);
  // The relay started first, before the process record, so sealing spares it.
  expect(privileged.mock.calls[0]?.[0].join(" ")).toContain("3128");
  // A Task client connects to the relay, which sends its bytes as lines.
  relayOutput.send?.("O 1");
  relayOutput.send?.(
    `D 1 ${Buffer.from("CONNECT pypi.org:443 HTTP/1.1\r\n\r\n").toString("base64")}`,
  );
  await vi.waitFor(() => expect(seen).toEqual(["CONNECT pypi.org:443 HTTP/1.1\r\n\r\n"]));
  await vi.waitFor(() =>
    expect(relayInputs.join("")).toContain(
      `D 1 ${Buffer.from("HTTP/1.1 200 Connection established\r\n\r\n").toString("base64")}`,
    ),
  );
  await f.session.stage(header, bytes);
  const variables = await f.session.execute({
    kind: "command",
    command: 'printf "%s|" "$HTTPS_PROXY"; cat "$SSL_CERT_FILE"',
  });
  expect(variables.text).toContain("http://attempt:secret@127.0.0.1:3128|");
  expect(variables.text).toContain("-----BEGIN CERTIFICATE-----");
  await f.session.capture();
  await f.session.stop({ owner });
}, 30_000);
