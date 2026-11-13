import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { create } from "@bufbuild/protobuf";
import { Code, createClient } from "@connectrpc/connect";
import { createGrpcTransport, Http2SessionManager } from "@connectrpc/connect-node";
import {
  HarnessWorkspace,
  RemoteMcpServerInputSchema,
  RemoteWorkspaceProvider,
  RemoteWorkspaceStageChunkSchema,
} from "@supertag/worker-sdk/internal/rust-harness";
import {
  createWorkspaceHandlers,
  startRemoteWorkspaceTransport,
} from "@supertag/worker-sdk/internal/rust-workspace-provider";
import type { SandboxOpts } from "e2b";
import { afterEach, expect, it, vi } from "vitest";
import {
  createE2BWorkspaceSession,
  type E2BWorkspaceSandbox,
  type E2BWorkspaceTemplateBuild,
} from "./src/rust-provider/session.ts";

const owner = {
  hostId: "host",
  hostGeneration: 5n,
  taskId: "task",
  attemptId: "attempt",
  allocationId: "allocation",
};
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function wait(child: ChildProcess) {
  return new Promise<{ exitCode: number; stdout: string; stderr: string }>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8").on("data", (text) => {
      stdout += text;
    });
    child.stderr?.setEncoding("utf8").on("data", (text) => {
      stderr += text;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ exitCode: code ?? -1, stdout, stderr }));
  });
}

async function fixture() {
  const builds: E2BWorkspaceTemplateBuild[] = [];
  const templates = {
    build: vi.fn(async (spec: E2BWorkspaceTemplateBuild) => {
      builds.push(spec);
      return `built-${builds.length}`;
    }),
  };
  const roots = new Set<string>();
  cleanups.push(async () => {
    for (const root of roots) await rm(root, { recursive: true, force: true });
  });
  let alive = false;
  let metadata: Record<string, string> = {};
  let mutationExit: number | undefined;
  const client: E2BWorkspaceSandbox["client"] = {
    sandboxId: "sandbox-one",
    files: {
      async makeDir(path) {
        await mkdir(path, { recursive: true });
        return true;
      },
      async write(path, data) {
        await writeFile(path, typeof data === "string" ? data : new Uint8Array(data));
      },
      async read(path) {
        return readFile(path);
      },
    },
    commands: {
      run: vi.fn(async (command, options) => {
        if (options?.stdin && mutationExit !== undefined) {
          const exitCode = mutationExit;
          mutationExit = undefined;
          return {
            pid: 1,
            async wait() {
              return { exitCode, stdout: "", stderr: "" };
            },
            async kill() {
              return true;
            },
            async sendStdin() {},
            async closeStdin() {},
          };
        }
        const child = spawn("/bin/sh", ["-c", command], {
          cwd: options?.cwd,
          env: { ...process.env, ...options?.envs },
          signal: options?.signal,
          stdio: ["pipe", "pipe", "pipe"],
        });
        if (options?.background) {
          // Like the E2B SDK, deliver a background command's output as it arrives.
          child.stdout?.setEncoding("utf8").on("data", (text) => options.onStdout?.(text));
          child.stderr?.setEncoding("utf8").on("data", (text) => options.onStderr?.(text));
        }
        const finished = wait(child);
        if (!options?.stdin) child.stdin?.end();
        if (options?.background) {
          return {
            pid: child.pid ?? 1,
            wait: () => finished,
            async kill() {
              return child.kill("SIGKILL");
            },
            async sendStdin(data: string | Uint8Array) {
              child.stdin?.write(data);
            },
            async closeStdin() {
              child.stdin?.end();
            },
          };
        }
        return finished;
      }) as E2BWorkspaceSandbox["client"]["commands"]["run"],
    },
    async kill() {
      alive = false;
      return true;
    },
  };
  const writeTransfer = vi.fn(async (path: string, bytes: Uint8Array) => {
    roots.add(dirname(path));
    await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
  });
  const readTransfer = vi.fn(async (path: string) => {
    const bytes = await readFile(path);
    return new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    });
  });
  const factory = {
    create: vi.fn(async (options: SandboxOpts) => {
      alive = true;
      metadata = options.metadata ?? {};
      return { client, writeTransfer, readTransfer };
    }),
  };
  const inventory = {
    find: vi.fn(async () => (alive ? [{ sandboxId: client.sandboxId, metadata }] : [])),
    get: vi.fn(async () => (alive ? { sandboxId: client.sandboxId, metadata } : undefined)),
    kill: vi.fn(async () => {
      alive = false;
    }),
  };
  const session = createE2BWorkspaceSession({
    factory,
    inventory,
    templates,
    template: "test-template",
  });
  return {
    session,
    templates,
    factory,
    inventory,
    client,
    writeTransfer,
    readTransfer,
    failMutation(exitCode: number) {
      mutationExit = exitCode;
    },
  };
}

async function bundle(linkTarget = "a.txt", inputParentLink = false, unrelated = false) {
  const root = await mkdtemp(join(tmpdir(), "supertag-e2b-bundle-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const git = async (...args: string[]) => {
    const result = await wait(spawn("git", args, { cwd: root }));
    if (result.exitCode !== 0) throw new Error(result.stderr);
    return result.stdout.trim();
  };
  await git("init", "-q", "--template=");
  await writeFile(join(root, "a.txt"), "original\n");
  await writeFile(join(root, ".gitattributes"), "a.txt text eol=crlf\n");
  await writeFile(join(root, "runner"), "#!/bin/sh\nexit 0\n");
  await chmod(join(root, "runner"), 0o755);
  await symlink(linkTarget, join(root, "link"));
  if (inputParentLink) await symlink("a.txt", join(root, "inputs"));
  await git("add", ".");
  await git(
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
  const startCommit = await git("rev-parse", "HEAD");
  const ref = "refs/heads/supertag-deliveries/fixture";
  await git("update-ref", ref, startCommit);
  const tree = await git("rev-parse", "HEAD^{tree}");
  // A commit outside the start commit's history, carried in the bundle without a head.
  let other: string | undefined;
  if (unrelated) {
    await git("checkout", "-q", "--orphan", "unrelated");
    await git(
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "-c",
      "commit.gpgSign=false",
      "commit",
      "-qm",
      "unrelated",
    );
    other = await git("rev-parse", "HEAD");
  }
  const path = join(root, "source.bundle");
  await git("bundle", "create", path, ref, ...(other ? [other] : []));
  const bytes = await readFile(path);
  return {
    tree,
    other,
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

it("stages verified private inputs and excludes them from the return tree", async () => {
  const input = Buffer.from("exact remote evidence\n");
  const attempt = createHash("sha256").update(owner.attemptId).digest("hex");
  const operation = "a".repeat(64);
  const path = `inputs/${attempt}/artifact-${operation}/evidence.txt`;
  const { session } = await fixture();
  const { header, bytes } = await bundle(path);
  await session.allocate({
    owner,
    timeoutMs: 60_000,
    allowedActions: ["files:read", "files:write"],
  });
  const inputFiles = [
    {
      path,
      blob: {
        sha256: createHash("sha256").update(input).digest("hex"),
        byteLength: BigInt(input.length),
      },
    },
  ];
  const corrupt = Buffer.from(input);
  corrupt[0] = 0;
  await expect(session.stage({ ...header, inputFiles }, bytes, undefined, corrupt)).rejects.toThrow(
    /differ from the receipt/i,
  );
  await session.stage({ ...header, inputFiles }, bytes, undefined, input);
  const read = await session.execute({ kind: "read", path });
  expect(read.isError).toBe(false);
  expect(read.text).toContain("exact remote evidence");
  await expect(session.execute({ kind: "write", path, content: "mutated" })).rejects.toThrow(
    /read-only/i,
  );
  await expect(
    session.execute({ kind: "edit", path: "link", oldText: "exact", newText: "mutated" }),
  ).rejects.toThrow(/read-only/i);
  expect(unpack((await session.capture()).bytes).map((entry) => entry.path)).not.toContain(path);
  await session.stop({ owner });
}, 15_000);

it("rejects an input root redirected by the repository", async () => {
  const { session } = await fixture();
  const { header, bytes } = await bundle("a.txt", true);
  await session.allocate({ owner, timeoutMs: 60_000, allowedActions: ["files:read"] });
  const attempt = createHash("sha256").update(owner.attemptId).digest("hex");
  await expect(
    session.stage(
      {
        ...header,
        inputFiles: [
          {
            path: `inputs/${attempt}/artifact-${"a".repeat(64)}/empty.txt`,
            blob: { sha256: createHash("sha256").update("").digest("hex"), byteLength: 0n },
          },
        ],
      },
      bytes,
    ),
  ).rejects.toThrow(/could not be staged/i);
  await expect(session.execute({ kind: "read", path: "a.txt" })).rejects.toThrow(/not staged/i);
  await session.stop({ owner });
}, 15_000);

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

it("allocates once with exact ownership, bounded lifetime, and no network or environment", async () => {
  const { session, factory, inventory } = await fixture();
  await expect(
    session.allocate({ owner, timeoutMs: 99_999_999, allowedActions: ["files:read"] }),
  ).resolves.toEqual({ sandboxId: "sandbox-one" });
  expect(factory.create).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      template: "test-template",
      timeoutMs: 3_600_000,
      allowInternetAccess: false,
      metadata: {
        "supertag.hostId": "host",
        "supertag.hostGeneration": "5",
        "supertag.taskId": "task",
        "supertag.attemptId": "attempt",
        "supertag.allocationId": "allocation",
      },
    }),
  );
  expect(factory.create.mock.calls[0]?.[0]).not.toHaveProperty("envs");
  await expect(session.allocate({ owner, timeoutMs: 60_000, allowedActions: [] })).rejects.toThrow(
    /allocat/i,
  );
  await expect(session.stop({ owner: { ...owner, hostGeneration: 6n } })).rejects.toThrow(/owner/i);
  expect(inventory.kill).not.toHaveBeenCalled();
  await expect(session.stop({ owner, sandboxId: "sandbox-one" })).resolves.toEqual({
    state: "stopped",
    sandboxId: "sandbox-one",
  });
});

it("rejects command authority before a sandbox is allocated", async () => {
  const { session, factory } = await fixture();
  await expect(
    session.allocate({
      owner,
      timeoutMs: 60_000,
      allowedActions: ["files:write", "commands:execute"],
    }),
  ).rejects.toThrow(/commands/i);
  expect(factory.create).not.toHaveBeenCalled();
});

it("stages a pinned bundle, accepts file tools, seals them, and returns exact sorted bytes and modes", async () => {
  const { session } = await fixture();
  const { header, bytes } = await bundle();
  await session.allocate({
    owner,
    timeoutMs: 60_000,
    allowedActions: ["files:read", "files:write"],
  });
  await session.stage(header, bytes);
  await expect(session.execute({ kind: "read", path: "a.txt" })).resolves.toMatchObject({
    text: expect.stringContaining("original"),
  });
  await session.execute({ kind: "write", path: "z-last", content: "new content" });
  await session.execute({ kind: "write", path: ".git ", content: "plain file with a space" });
  const result = await session.capture();
  expect(result.tree).toEqual({
    sha256: createHash("sha256").update(result.bytes).digest("hex"),
    byteLength: BigInt(result.bytes.byteLength),
  });
  expect(unpack(result.bytes)).toEqual([
    { path: ".git ", mode: "100644", body: "plain file with a space" },
    { path: ".gitattributes", mode: "100644", body: "a.txt text eol=crlf\n" },
    { path: "a.txt", mode: "100644", body: "original\n" },
    { path: "link", mode: "120000", body: "a.txt" },
    { path: "runner", mode: "100755", body: "#!/bin/sh\nexit 0\n" },
    { path: "z-last", mode: "100644", body: "new content" },
  ]);
  await expect(session.execute({ kind: "write", path: "after", content: "later" })).rejects.toThrow(
    /staged|sealed/i,
  );
  await expect(session.capture()).resolves.toEqual(result);
  await expect(session.stop({ owner })).resolves.toEqual({
    state: "stopped",
    sandboxId: "sandbox-one",
  });
}, 15_000);

it("rejects wrong digest before transfer and rejects an unadvertised pin", async () => {
  const { session, writeTransfer } = await fixture();
  const { header, bytes } = await bundle();
  await session.allocate({ owner, timeoutMs: 60_000, allowedActions: ["files:read"] });
  await expect(
    session.stage({ ...header, bundle: { ...header.bundle, sha256: "0".repeat(64) } }, bytes),
  ).rejects.toThrow(/digest/i);
  expect(writeTransfer).not.toHaveBeenCalled();
  await expect(session.stage({ ...header, startCommit: "0".repeat(40) }, bytes)).rejects.toThrow(
    /stage/i,
  );
  await expect(session.capture()).rejects.toThrow(/staged/i);
}, 15_000);

it("a lost allocation response is redacted and recovered through exact provider ownership", async () => {
  const { session, factory, inventory } = await fixture();
  const createSandbox = factory.create.getMockImplementation();
  if (!createSandbox) throw new Error("missing fixture factory");
  factory.create.mockImplementationOnce(async (options) => {
    await createSandbox(options);
    throw new Error("provider detail: secret key");
  });
  await expect(session.allocate({ owner, timeoutMs: 60_000, allowedActions: [] })).rejects.toThrow(
    /^E2B Workspace allocation could not be verified$/,
  );
  await session.close();
  expect(inventory.find).not.toHaveBeenCalled();
  expect(inventory.kill).not.toHaveBeenCalled();
  const recovery = createE2BWorkspaceSession({ inventory, factory });
  await expect(recovery.stop({ owner })).resolves.toEqual({
    state: "stopped",
    sandboxId: "sandbox-one",
  });
  expect(inventory.find).toHaveBeenCalledOnce();
  expect(inventory.kill).toHaveBeenCalledExactlyOnceWith("sandbox-one");
});

it("never accepts an unverified sandbox ID as proof while Allocate is in flight", async () => {
  const { session, factory, inventory } = await fixture();
  const createSandbox = factory.create.getMockImplementation();
  if (!createSandbox) throw new Error("missing fixture factory");
  const started = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  factory.create.mockImplementationOnce(async (options) => {
    started.resolve();
    await released.promise;
    return createSandbox(options);
  });
  const allocating = session.allocate({ owner, timeoutMs: 60_000, allowedActions: [] });
  const cancelled = expect(allocating).rejects.toThrow(/could not be verified/);
  await started.promise;
  try {
    await expect(session.stop({ owner, sandboxId: "unrelated-absent-id" })).rejects.toThrow(
      /unverified/,
    );
    expect(inventory.get).not.toHaveBeenCalled();
    await expect(session.stop({ owner })).resolves.toEqual({ state: "uncertain" });
  } finally {
    released.resolve();
    await cancelled;
  }
  const recovery = createE2BWorkspaceSession({ inventory, factory });
  await expect(recovery.stop({ owner })).resolves.toEqual({
    state: "stopped",
    sandboxId: "sandbox-one",
  });
});

it("withholds capture after a failed mutation wrapper and stops an acknowledged sandbox on close", async () => {
  const { session, inventory, failMutation } = await fixture();
  const { header, bytes } = await bundle();
  await session.allocate({
    owner,
    timeoutMs: 60_000,
    allowedActions: ["files:read", "files:write"],
  });
  await session.stage(header, bytes);
  await expect(session.execute({ kind: "read", path: "missing-file" })).resolves.toMatchObject({
    isError: true,
  });
  failMutation(137);
  await expect(
    session.execute({ kind: "write", path: "a.txt", content: "in flight" }),
  ).resolves.toMatchObject({
    isError: true,
  });
  await expect(session.capture()).rejects.toThrow(/could not be captured/);
  await session.close();
  expect(inventory.kill).toHaveBeenCalledExactlyOnceWith("sandbox-one");
}, 15_000);

it("fails staging a pinned bundle with an escaping symlink", async () => {
  const { session } = await fixture();
  const { header, bytes } = await bundle("../outside");
  await session.allocate({ owner, timeoutMs: 60_000, allowedActions: ["files:read"] });
  await expect(session.stage(header, bytes)).rejects.toThrow(/could not be staged/);
  await expect(session.capture()).rejects.toThrow(/staged/i);
  await session.close();
}, 15_000);

it("wires generated gRPC through production handlers, seals queued edits and proves absence", async () => {
  const { session, inventory, writeTransfer } = await fixture();
  const { header, bytes } = await bundle();
  const token = "workspace-provider-fixture-token";
  const auth = { headers: { authorization: `Bearer ${token}` } };
  const server = await startRemoteWorkspaceTransport({
    ...createWorkspaceHandlers(session),
    token,
  });
  const sessionManager = new Http2SessionManager(server.endpoint);
  const transport = createGrpcTransport({ baseUrl: server.endpoint, sessionManager });
  const provider = createClient(RemoteWorkspaceProvider, transport);
  const workspace = createClient(HarnessWorkspace, transport);
  try {
    await expect(
      provider.allocate(
        {
          owner,
          timeoutMs: 60_000,
          allowedActions: ["files:read", "files:write"],
        },
        auth,
      ),
    ).resolves.toMatchObject({ sandboxId: "sandbox-one" });
    const stageHeader = create(RemoteWorkspaceStageChunkSchema, {
      part: { case: "header", value: header },
    });
    const payload = (value: Uint8Array) =>
      create(RemoteWorkspaceStageChunkSchema, {
        part: { case: "payload", value },
      });
    const parts = async function* (...messages: (typeof stageHeader)[]) {
      yield* messages;
    };
    await expect(provider.stage(parts(payload(bytes), stageHeader), auth)).rejects.toMatchObject({
      code: Code.InvalidArgument,
    });
    expect(writeTransfer).not.toHaveBeenCalled();
    await provider.stage(
      parts(stageHeader, payload(bytes.subarray(0, 10)), payload(bytes.subarray(10))),
      auth,
    );
    await expect(
      workspace.execute({ operation: { case: "command", value: { command: "true" } } }, auth),
    ).rejects.toMatchObject({ code: Code.PermissionDenied });
    await expect(
      workspace.execute(
        { operation: { case: "write", value: { path: ".git/config", content: "untrusted" } } },
        auth,
      ),
    ).rejects.toMatchObject({ code: Code.Internal });
    const edit = (oldText: string, newText: string) =>
      session.execute({ kind: "edit", path: "a.txt", oldText, newText });
    const edits = Promise.all([edit("original", "first"), edit("first", "second")]);
    void edits.catch(() => undefined);
    const output = [];
    for await (const part of provider.capture({}, auth)) output.push(part);
    await edits;
    expect(output[0]?.part.case).toBe("tree");
    const collected = Buffer.concat(
      output.flatMap((part) => (part.part.case === "payload" ? [part.part.value] : [])),
    );
    expect(unpack(collected)).toContainEqual({ path: "a.txt", mode: "100644", body: "second\n" });
    await expect(provider.stop({ owner, sandboxId: "sandbox-one" }, auth)).resolves.toMatchObject({
      stoppedSandboxId: "sandbox-one",
    });
    await session.close();
    expect(inventory.kill).toHaveBeenCalledExactlyOnceWith("sandbox-one");
  } finally {
    sessionManager.abort();
    await server.close();
  }
}, 15_000);

it("runs a Workspace stdio MCP server in the trusted copy beside the checkout, with no host variable", async () => {
  const { session } = await fixture();
  const { header, bytes } = await bundle();
  const token = "workspace-provider-fixture-token";
  const auth = { headers: { authorization: `Bearer ${token}` } };
  const server = await startRemoteWorkspaceTransport({
    ...createWorkspaceHandlers(session),
    token,
  });
  const sessionManager = new Http2SessionManager(server.endpoint);
  const transport = createGrpcTransport({ baseUrl: server.endpoint, sessionManager });
  const provider = createClient(RemoteWorkspaceProvider, transport);
  const canary = "host-canary-value";
  vi.stubEnv("SUPERTAG_MCP_CANARY", canary);
  const start = (args: string[]) =>
    create(RemoteMcpServerInputSchema, {
      part: { case: "start", value: { name: "tools", command: "sh", args } },
    });
  const stdin = (text: string) =>
    create(RemoteMcpServerInputSchema, {
      part: { case: "stdin", value: new TextEncoder().encode(text) },
    });
  try {
    await provider.allocate(
      { owner, timeoutMs: 60_000, allowedActions: ["files:read", "files:write"] },
      auth,
    );
    await provider.stage(
      (async function* () {
        yield create(RemoteWorkspaceStageChunkSchema, {
          part: { case: "header", value: { ...header, mcpCommit: header.startCommit } },
        });
        yield create(RemoteWorkspaceStageChunkSchema, { part: { case: "payload", value: bytes } });
      })(),
      auth,
    );
    // The server sees its trusted copy, a fixed PATH and LANG, and its own input lines.
    const inputs = (async function* () {
      yield start(["-c", 'pwd; env | sort; while read line; do echo "got:$line"; done']);
      yield stdin("hello\n");
    })();
    let output = "";
    for await (const part of provider.runMcpServer(inputs, auth)) {
      output += new TextDecoder().decode(part.stdout);
    }
    const [directory, ...lines] = output.trim().split("\n");
    expect(directory).toMatch(/^\/.*\/supertag-workspace-[^/]+\/mcp$/u);
    expect(lines).toContain("got:hello");
    expect(lines).toContain("PATH=/usr/local/bin:/usr/bin:/bin");
    expect(lines).toContain("LANG=C.UTF-8");
    expect(output).not.toContain(canary);
    expect(
      lines
        .filter((line) => !line.startsWith("got:"))
        .map((line) => line.split("=")[0])
        .filter((name) => !["PATH", "LANG", "PWD", "SHLVL", "_"].includes(name ?? "")),
    ).toEqual([]);
    // The trusted copy holds the commit's files, outside the checkout the file tools reach.
    expect(await readFile(join(directory ?? "", "a.txt"), "utf8")).toBe("original\n");
    await expect(session.execute({ kind: "read", path: "../mcp/a.txt" })).rejects.toThrow();
    // A running server is stopped before capture, so it cannot change the returned tree.
    const held = provider.runMcpServer(
      (async function* () {
        yield start(["-c", "echo ready; exec sleep 30"]);
        await new Promise(() => undefined);
      })(),
      auth,
    );
    const iterator = held[Symbol.asyncIterator]();
    expect(new TextDecoder().decode((await iterator.next()).value?.stdout)).toBe("ready\n");
    const captured = [];
    for await (const part of provider.capture({}, auth)) captured.push(part);
    expect(captured[0]?.part.case).toBe("tree");
    await expect(iterator.next()).resolves.toMatchObject({ done: true });
    // No server starts once capture sealed the sandbox.
    await expect(
      (async () => {
        for await (const _ of provider.runMcpServer(
          (async function* () {
            yield start(["-c", "echo late"]);
          })(),
          auth,
        ));
      })(),
    ).rejects.toMatchObject({ code: Code.Internal });
  } finally {
    vi.unstubAllEnvs();
    sessionManager.abort();
    await server.close();
  }
}, 20_000);

it("refuses a Workspace MCP server without a trusted copy", async () => {
  const { session } = await fixture();
  const { header, bytes } = await bundle();
  await session.allocate({ owner, timeoutMs: 60_000, allowedActions: ["files:read"] });
  await expect(session.stage({ ...header, mcpCommit: "0".repeat(64) }, bytes)).rejects.toThrow(
    /trusted MCP commit/u,
  );
  await session.stage(header, bytes);
  await expect(session.startMcpServer({ name: "tools", command: "sh", args: [] })).rejects.toThrow(
    /no trusted MCP copy/u,
  );
}, 15_000);

it("refuses a trusted MCP commit the bundle lacks, that is no commit, or that is no ancestor", async () => {
  const { header, bytes, tree, other } = await bundle("a.txt", false, true);
  if (!other) throw new Error("the fixture bundle has no unrelated commit");
  // Each has the start commit's length, so only the in-sandbox stage script can refuse it.
  for (const mcpCommit of ["f".repeat(header.startCommit.length), tree, other]) {
    const { session } = await fixture();
    await session.allocate({ owner, timeoutMs: 60_000, allowedActions: ["files:read"] });
    await expect(session.stage({ ...header, mcpCommit }, bytes)).rejects.toThrow(
      /bundle could not be staged/u,
    );
    await session.stop({ owner });
  }
  // The same bundle stages with the start commit as its trusted copy.
  const { session } = await fixture();
  await session.allocate({ owner, timeoutMs: 60_000, allowedActions: ["files:read"] });
  await session.stage({ ...header, mcpCommit: header.startCommit }, bytes);
  await session.stop({ owner });
}, 30_000);

const DEVCONTAINER = {
  image: "python:3.13-slim",
  dockerfileCommands: ["RUN true", "USER root", "RUN install-tools", "USER nobody"],
  user: "nobody",
  setupCommands: [
    `export TOOL_HOME="$1"'/.tool'`,
    "sh -c 'echo \"$TOOL_HOME\" > .setup-out; pwd -P >> .setup-out'",
  ],
};

it("builds the devcontainer image before the sandbox and runs its setup in the checkout after staging", async () => {
  const { session, templates, factory, client } = await fixture();
  const { header, bytes } = await bundle();
  await session.allocate({
    owner,
    timeoutMs: 60_000,
    allowedActions: ["files:read"],
    environment: DEVCONTAINER,
  });
  // One build from the registry image, ending as the devcontainer's user; the sandbox starts
  // from it, so every process the session starts runs as that user and it owns the checkout.
  expect(templates.build).toHaveBeenCalledTimes(1);
  const [build] = templates.build.mock.calls[0] ?? [];
  expect(build?.dockerfile).toBe(
    "FROM python:3.13-slim\nRUN true\nUSER root\nRUN install-tools\nUSER nobody\n",
  );
  expect(build?.name).toMatch(/^supertag-workspace-[0-9a-f]{32}$/u);
  expect(factory.create).toHaveBeenCalledWith(expect.objectContaining({ template: "built-1" }));
  await session.stage(header, bytes);
  const setup = vi
    .mocked(client.commands.run)
    .mock.calls.find(([command]) => command.includes("devcontainer-setup"));
  expect(setup?.[0]).toContain("set -e");
  const read = await session.execute({ kind: "read", path: ".setup-out" });
  const [toolHome, directory] = read.text
    .split("\n")
    .map((line) => line.replace(/^\s*\d+\s*[\t|→]?/u, "").trim())
    .filter(Boolean);
  expect(toolHome).toMatch(/\/supertag-workspace-[^/]+\/checkout\/\.tool$/u);
  expect(directory).toMatch(/\/supertag-workspace-[^/]+\/checkout$/u);
  await session.stop({ owner });

  // The same translation names the same template, so E2B can reuse its layers.
  const again = await fixture();
  await again.session.allocate({
    owner,
    timeoutMs: 60_000,
    allowedActions: ["files:read"],
    environment: DEVCONTAINER,
  });
  expect(again.templates.build.mock.calls[0]?.[0].name).toBe(build?.name);
  await again.session.stop({ owner });
}, 20_000);

it("sets a declared user on the operator template and builds nothing for setup alone", async () => {
  const user = await fixture();
  await user.session.allocate({
    owner,
    timeoutMs: 60_000,
    allowedActions: [],
    environment: { dockerfileCommands: ["USER node"], user: "node", setupCommands: [] },
  });
  expect(user.templates.build).toHaveBeenCalledWith({
    name: expect.stringMatching(/^supertag-workspace-/u),
    fromTemplate: "test-template",
    user: "node",
  });
  await user.session.stop({ owner });
  const setup = await fixture();
  await setup.session.allocate({
    owner,
    timeoutMs: 60_000,
    allowedActions: [],
    environment: { dockerfileCommands: [], setupCommands: ["true"] },
  });
  expect(setup.templates.build).not.toHaveBeenCalled();
  expect(setup.factory.create).toHaveBeenCalledWith(
    expect.objectContaining({ template: "test-template" }),
  );
  await setup.session.stop({ owner });
});

it("fails staging when devcontainer setup fails, exposing no file tools", async () => {
  const { session } = await fixture();
  const { header, bytes } = await bundle();
  await session.allocate({
    owner,
    timeoutMs: 60_000,
    allowedActions: ["files:read"],
    environment: { dockerfileCommands: [], setupCommands: ["sh -c 'exit 3'"] },
  });
  await expect(session.stage(header, bytes)).rejects.toThrow(/bundle could not be staged/u);
  await expect(session.execute({ kind: "read", path: "a.txt" })).rejects.toThrow(/not staged/u);
  await session.stop({ owner });
}, 15_000);

it("refuses an inconsistent devcontainer environment before any provider call", async () => {
  for (const environment of [
    // The image must end as the user it names.
    { ...DEVCONTAINER, dockerfileCommands: ["USER root"] },
    { ...DEVCONTAINER, image: "python 3" },
    { ...DEVCONTAINER, user: "$NAME", dockerfileCommands: ["USER $NAME"] },
    // Without a devcontainer image, only the user can change.
    { dockerfileCommands: ["RUN true", "USER node"], user: "node", setupCommands: [] },
    { dockerfileCommands: ["RUN a\nRUN b"], setupCommands: [] },
    { dockerfileCommands: [], setupCommands: ["a\0b"] },
  ]) {
    const { session, templates, factory } = await fixture();
    await expect(
      session.allocate({ owner, timeoutMs: 60_000, allowedActions: [], environment }),
    ).rejects.toThrow(/devcontainer environment is invalid/u);
    expect(templates.build).not.toHaveBeenCalled();
    expect(factory.create).not.toHaveBeenCalled();
  }
});
