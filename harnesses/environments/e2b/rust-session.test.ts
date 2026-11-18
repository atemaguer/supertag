import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  link,
  mkdtemp,
  open,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { create } from "@bufbuild/protobuf";
import { Code, createClient } from "@connectrpc/connect";
import { createGrpcTransport, Http2SessionManager } from "@connectrpc/connect-node";
import {
  HarnessWorkspace,
  RemoteMcpServerInputSchema,
  RemoteWorkspaceCopyUploadSchema,
  RemoteWorkspaceProvider,
  RemoteWorkspaceStageChunkSchema,
} from "@supertag/worker-sdk/internal/rust-harness";
import {
  createWorkspaceHandlers,
  startRemoteWorkspaceTransport,
} from "@supertag/worker-sdk/internal/rust-workspace-provider";
import { afterEach, expect, it, vi } from "vitest";
import { fakePrivileged, relayStarts, fixture as sharedFixture, wait } from "./rust-fixture.ts";
import { createE2BWorkspaceSession } from "./src/rust-provider/session.ts";

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

const fixture = (
  ...args: Parameters<typeof sharedFixture> extends [unknown, ...infer Rest] ? Rest : never
) => sharedFixture(cleanups, ...args);

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

it("admits commands only in a sandbox it can seal", async () => {
  const { session } = await fixture(undefined, false);
  await expect(
    session.allocate({
      owner,
      timeoutMs: 60_000,
      allowedActions: ["files:write", "commands:execute"],
    }),
  ).rejects.toThrow(/allocation/i);
  expect(session.admitsCommands()).toBe(false);
});

it("records the sandbox's processes, seals it before capture, and returns no ignored output or Git metadata", async () => {
  const privileged = fakePrivileged();
  const { session } = await fixture(undefined, privileged);
  const { header, bytes } = await bundle();
  await session.allocate({
    owner,
    timeoutMs: 60_000,
    allowedActions: ["files:read", "files:write", "commands:execute"],
  });
  expect(session.admitsCommands()).toBe(true);
  expect(privileged).toHaveBeenCalledTimes(1);
  expect(privileged.mock.calls[0]?.[0].slice(0, 5)).toEqual([
    "/usr/bin/env",
    "-i",
    "PATH=/usr/local/bin:/usr/bin:/bin",
    "LANG=C.UTF-8",
    "python3",
  ]);
  await session.stage(header, bytes);
  await expect(
    session.execute({
      kind: "command",
      command: [
        "printf 'node_modules/\\nout/\\na.txt\\n' > .gitignore",
        "mkdir -p node_modules/pkg sub/.git out",
        "echo dep > node_modules/pkg/index.js",
        "echo nested > sub/.git/HEAD",
        "echo kept > sub/file",
        "echo report > out/report.txt",
        "echo dropped > out/scratch.txt",
        "echo changed > a.txt",
        "git init -q . 2>/dev/null; echo done",
      ].join(" && "),
    }),
  ).resolves.toEqual({ text: "done\n", isError: false });
  const captured = await session.capture(undefined, ["out/report.txt"]);
  // Sealing ran with the recorded processes and interpreter, and the capture in its process.
  expect(privileged).toHaveBeenCalledTimes(2);
  const sealArgv = privileged.mock.calls[1]?.[0] ?? [];
  expect(sealArgv[4]).toBe("/fixture/python3");
  expect(sealArgv).toContain(
    JSON.stringify([
      [1, "7"],
      [2, "9"],
    ]),
  );
  expect(sealArgv).toContain("capture");
  const paths = unpack(captured.bytes).map((entry) => entry.path);
  // A tracked file stays even when the ignore rules match it; a named path stays too.
  expect(paths).toEqual(
    expect.arrayContaining([".gitignore", "a.txt", "out/report.txt", "sub/file"]),
  );
  expect(paths.some((path) => path.startsWith("node_modules"))).toBe(false);
  expect(paths.some((path) => path.split("/").includes(".git"))).toBe(false);
  expect(paths).not.toContain("out/scratch.txt");
  await session.stop({ owner });
}, 15_000);

it("allocates a file-only Task even where the process record cannot run, but never commands", async () => {
  const broken = vi.fn(async () => ({ exitCode: 127, stdout: "python3: not found\n" }));
  const files = await fixture(undefined, broken);
  const { header, bytes } = await bundle();
  await files.session.allocate({ owner, timeoutMs: 60_000, allowedActions: ["files:write"] });
  await files.session.stage(header, bytes);
  await files.session.capture();
  await files.session.stop({ owner });
  const commands = await fixture(undefined, broken);
  await expect(
    commands.session.allocate({
      owner,
      timeoutMs: 60_000,
      allowedActions: ["files:write", "commands:execute"],
    }),
  ).rejects.toThrow(/allocation/u);
});

it("refuses to capture a sandbox it cannot seal", async () => {
  const { session } = await fixture(undefined, fakePrivileged(4));
  const { header, bytes } = await bundle();
  await session.allocate({
    owner,
    timeoutMs: 60_000,
    allowedActions: ["files:read", "files:write", "commands:execute"],
  });
  await session.stage(header, bytes);
  await expect(session.capture()).rejects.toThrow(/captured/i);
  await expect(session.capture()).rejects.toThrow();
  await session.stop({ owner });
});

it("records every sandbox, but seals only one that ran a Task-driven process", async () => {
  const privileged = fakePrivileged();
  const { session } = await fixture(undefined, privileged);
  const { header, bytes } = await bundle();
  await session.allocate({ owner, timeoutMs: 60_000, allowedActions: ["files:write"] });
  expect(privileged).toHaveBeenCalledTimes(1);
  expect(session.admitsCommands()).toBe(false);
  await session.stage(header, bytes);
  await session.capture();
  // File tools start no process that outlives its call, so nothing needs sealing.
  expect(privileged).toHaveBeenCalledTimes(1);
  await session.stop({ owner });
});

it("refuses to capture a sandbox that ran a Workspace MCP server and cannot be sealed", async () => {
  const { session } = await fixture(undefined, fakePrivileged(4));
  const { header, bytes } = await bundle();
  await session.allocate({ owner, timeoutMs: 60_000, allowedActions: ["files:read"] });
  await session.stage({ ...header, mcpCommit: header.startCommit }, bytes);
  const server = await session.startMcpServer({
    name: "probe",
    command: "sh",
    args: ["-c", "cat"],
  });
  await session.stopMcpServer(server);
  await expect(session.capture()).rejects.toThrow(/captured/u);
  await session.stop({ owner });
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

it("stops a Workspace MCP server's process group before capture, even children ignoring SIGTERM", async () => {
  const { session } = await fixture();
  const { header, bytes } = await bundle();
  await session.allocate({ owner, timeoutMs: 60_000, allowedActions: ["files:read"] });
  await session.stage({ ...header, mcpCommit: header.startCommit }, bytes);
  const server = forkingMcpServer();
  const { start, childPid } = await server;
  const process_ = await session.startMcpServer(start);
  const pid = await childPid();
  const started = Date.now();
  const gone = goneAfter(pid, started);
  const captured = await session.capture();
  expect(captured.tree.byteLength).toBeGreaterThan(0n);
  // The child ignored SIGTERM, so only the group's SIGKILL ends it.
  const stoppedAfter = await gone;
  expect(stoppedAfter).toBeDefined();
  expect(stoppedAfter).toBeLessThan(MCP_STOP_BOUND_MS);
  await expect(process_.wait()).resolves.toBeDefined();
}, 20_000);

it("stops a Workspace MCP server that is not reading its input before capture", async () => {
  const { session } = await fixture();
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
  const stopped = server.wait().then(() => Date.now() - started);
  const captured = await session.capture();
  expect(captured.tree.byteLength).toBeGreaterThan(0n);
  expect(await stopped).toBeLessThan(MCP_STOP_BOUND_MS);
  await expect(server.wait()).resolves.toBeDefined();
}, 20_000);

it("refuses capture rather than wait for an MCP server descendant that left its group", async () => {
  const { session } = await fixture();
  const { header, bytes } = await bundle();
  await session.allocate({ owner, timeoutMs: 60_000, allowedActions: ["files:read"] });
  await session.stage({ ...header, mcpCommit: header.startCommit }, bytes);
  const directory = await mkdtemp(join(tmpdir(), "supertag-mcp-escape-"));
  const pidFile = join(directory, "escaped.pid");
  cleanups.push(async () => {
    const pid = Number((await readFile(pidFile, "utf8").catch(() => "")).trim());
    if (pid > 0) process.kill(pid, "SIGKILL");
    await rm(directory, { recursive: true, force: true });
  });
  // The descendant starts its own session, so no process group signal reaches it, and it
  // holds the server's output open.
  const escaping = `import os, sys; os.setsid(); open(sys.argv[1], "w").write(str(os.getpid())); os.execvp("sleep", ["sleep", "60"])`;
  await session.startMcpServer({
    name: "tools",
    command: "sh",
    args: ["-c", `python3 -c '${escaping}' "${pidFile}" & exec sleep 60`],
  });
  for (
    let attempt = 0;
    attempt < 200 && !(await readFile(pidFile, "utf8").catch(() => ""));
    attempt++
  )
    await new Promise((resolve) => setTimeout(resolve, 25));
  const started = Date.now();
  await expect(session.capture()).rejects.toThrow(/could not be captured/u);
  expect(Date.now() - started).toBeLessThan(7_000);
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

type CopyPart =
  | { case: "file"; value: { key: string; size: bigint; sha256: string } }
  | { case: "payload"; value: Uint8Array }
  | { case: "directory"; value: string };

const GiB = 1024n ** 3n;

function copyParts(
  files: Record<string, Buffer>,
  corrupt?: string,
  directories: string[] = [],
): AsyncIterable<CopyPart> {
  return (async function* () {
    for (const directory of directories) yield { case: "directory", value: directory };
    for (const [key, body] of Object.entries(files)) {
      const sha256 = createHash("sha256")
        .update(key === corrupt ? "other" : body)
        .digest("hex");
      yield { case: "file", value: { key, size: BigInt(body.length), sha256 } };
      for (let offset = 0; offset < body.length; offset += 256 * 1024)
        yield { case: "payload", value: body.subarray(offset, offset + 256 * 1024) };
    }
  })();
}

it("stages Workspace copies beside the checkout, seals read-only ones, and returns only changed files", async () => {
  const { session, writeTransfer, client } = await fixture();
  const { header, bytes } = await bundle();
  await session.allocate({
    owner,
    timeoutMs: 60_000,
    allowedActions: ["files:read", "files:write"],
  });
  await session.stage(header, bytes);
  const root = `volumes/${createHash("sha256").update(owner.attemptId).digest("hex")}`;
  // A file larger than one transfer part spans several parts.
  const large = Buffer.alloc(9 * 1024 * 1024 + 3, 7);
  await expect(
    session.stageCopy(
      { path: `${root}/ro`, readWrite: false },
      copyParts({ "rows.csv": Buffer.from("a,b\n1,2\n") }, "rows.csv"),
    ),
  ).rejects.toThrow(/copy transfer failed/i);
  await expect(
    session.stageCopy({ path: "volumes/other/ro", readWrite: false }, copyParts({})),
  ).rejects.toThrow(/copy path is invalid/i);
  await expect(
    session.stageCopy(
      { path: `${root}/ro`, readWrite: false },
      copyParts({
        "rows.csv": Buffer.from("a,b\n1,2\n"),
        "nested/notes.txt": Buffer.from("notes\n"),
      }),
    ),
  ).resolves.toEqual({ files: 2n });
  await expect(
    session.stageCopy(
      { path: `${root}/rw`, readWrite: true },
      copyParts({
        "rows.csv": Buffer.from("x\n"),
        "empty.txt": Buffer.alloc(0),
        "large.bin": large,
      }),
    ),
  ).resolves.toEqual({ files: 3n });
  await expect(
    session.execute({ kind: "read", path: `${root}/ro/nested/notes.txt` }),
  ).resolves.toMatchObject({ text: expect.stringContaining("notes") });
  await expect(
    session.execute({ kind: "write", path: `${root}/ro/denied.txt`, content: "no" }),
  ).rejects.toThrow(/read-only/i);
  await session.execute({ kind: "write", path: `${root}/rw/rows.csv`, content: "x\ny\n" });
  await session.execute({ kind: "write", path: `${root}/rw/new/created.txt`, content: "new\n" });
  const sandboxRoot = dirname(writeTransfer.mock.calls[0]?.[0] as string);
  await symlink("/etc/hosts", join(sandboxRoot, "checkout", root, "rw", "link"));
  // Copies are never part of the returned tree.
  expect(
    unpack((await session.capture()).bytes).some(({ path }) => path.startsWith("volumes/")),
  ).toBe(false);
  await expect(async () => {
    for await (const _ of session.captureCopy({ path: `${root}/ro`, maxBytes: GiB })) break;
  }).rejects.toThrow(/not a staged read-write copy/i);
  const parts = [];
  for await (const part of session.captureCopy({ path: `${root}/rw`, maxBytes: 20n * GiB }))
    parts.push(part);
  // The listing may hash the staged bytes and the copy's limit: one second per MiB of both.
  const scan = vi.mocked(client.commands.run).mock.calls.find(([command]) =>
    // The program text names every mode; the mode argument follows it.
    command.slice(command.lastIndexOf("sys.exit(1)")).includes("copy-scan"),
  );
  expect(scan?.[1]?.timeoutMs).toBe(120_000 + 2 * 20 * 1024 * 1000);
  expect(parts.filter((part) => part.case !== "payload")).toEqual([
    {
      case: "file",
      value: {
        key: "new/created.txt",
        size: 4n,
        sha256: createHash("sha256").update("new\n").digest("hex"),
      },
    },
    {
      case: "file",
      value: {
        key: "rows.csv",
        size: 4n,
        sha256: createHash("sha256").update("x\ny\n").digest("hex"),
      },
    },
    // Two unchanged files and the link.
    { case: "listed", value: { skipped: 3n, errorKey: "", errorReason: "" } },
  ]);
  expect(
    Buffer.concat(
      parts.flatMap((part) => (part.case === "payload" ? [Buffer.from(part.value)] : [])),
    ).toString(),
  ).toBe("new\nx\ny\n");
  await session.stop({ owner });
  // A sealed read-only copy keeps its owner from removing entries; reopen it for cleanup.
  for (const directory of ["ro", "ro/nested"])
    await chmod(join(sandboxRoot, "checkout", root, directory), 0o700);
}, 30_000);

it("refuses a read-write copy holding a hard link or an unwritable name without sending bytes", async () => {
  const { session, writeTransfer } = await fixture();
  const { header, bytes } = await bundle();
  await session.allocate({
    owner,
    timeoutMs: 60_000,
    allowedActions: ["files:read", "files:write"],
  });
  await session.stage(header, bytes);
  const root = `volumes/${createHash("sha256").update(owner.attemptId).digest("hex")}`;
  await session.stageCopy(
    { path: `${root}/rw`, readWrite: true },
    copyParts({ "a.txt": Buffer.from("a\n") }),
  );
  const copy = join(dirname(writeTransfer.mock.calls[0]?.[0] as string), "checkout", root, "rw");
  await writeFile(join(copy, "b.txt"), "b\n");
  await link(join(copy, "b.txt"), join(copy, "c.txt"));
  await session.capture();
  const parts = [];
  for await (const part of session.captureCopy({ path: `${root}/rw`, maxBytes: GiB }))
    parts.push(part);
  expect(parts.at(-1)).toEqual({
    case: "listed",
    value: { skipped: 1n, errorKey: "b.txt", errorReason: "a file has another link or changed" },
  });
  expect(parts.some((part) => part.case === "payload")).toBe(false);
  await session.stop({ owner });
}, 30_000);

it("stages any name and empty directory a local read-only copy holds", async () => {
  const { session, writeTransfer } = await fixture();
  const { header, bytes } = await bundle();
  await session.allocate({ owner, timeoutMs: 60_000, allowedActions: ["files:read"] });
  await session.stage(header, bytes);
  const root = `volumes/${createHash("sha256").update(owner.attemptId).digest("hex")}`;
  // Names a Volume key refuses are still files a `file://` Volume can hold.
  const odd = "back\\slash\tand tab.txt";
  await expect(
    session.stageCopy(
      { path: `${root}/ro`, readWrite: false },
      copyParts({ [odd]: Buffer.from("odd\n") }, undefined, ["empty", "nested/hollow"]),
    ),
  ).resolves.toEqual({ files: 1n });
  const copy = join(dirname(writeTransfer.mock.calls[0]?.[0] as string), "checkout", root, "ro");
  expect(await readFile(join(copy, odd), "utf8")).toBe("odd\n");
  for (const directory of ["empty", "nested/hollow"])
    expect((await stat(join(copy, directory))).isDirectory()).toBe(true);
  // A read-write copy's names must be Volume keys, so they can be written back.
  await expect(
    session.stageCopy(
      { path: `${root}/rw`, readWrite: true },
      copyParts({ [odd]: Buffer.from("odd\n") }),
    ),
  ).rejects.toThrow(/copy file record is invalid/u);
  await session.stop({ owner });
  for (const directory of ["ro", "ro/nested", "ro/nested/hollow", "ro/empty"])
    await chmod(join(copy, "..", directory), 0o700);
}, 30_000);

it("refuses a change over the copy's limits without reading it", async () => {
  const { session, writeTransfer, readTransfer } = await fixture();
  const { header, bytes } = await bundle();
  await session.allocate({
    owner,
    timeoutMs: 60_000,
    allowedActions: ["files:read", "files:write"],
  });
  await session.stage(header, bytes);
  const root = `volumes/${createHash("sha256").update(owner.attemptId).digest("hex")}`;
  await session.stageCopy(
    { path: `${root}/rw`, readWrite: true },
    copyParts({ "kept.bin": Buffer.alloc(600, 1) }),
  );
  const copy = join(dirname(writeTransfer.mock.calls[0]?.[0] as string), "checkout", root, "rw");
  await session.capture();
  const listed = async (maxBytes: bigint) => {
    const parts = [];
    for await (const part of session.captureCopy({ path: `${root}/rw`, maxBytes }))
      parts.push(part);
    const summary = parts.find((part) => part.case === "listed");
    if (summary?.value.errorReason)
      expect(parts.some((part) => part.case === "payload")).toBe(false);
    return summary;
  };
  // A sparse file far over the limit is refused by its size alone.
  const sparse = await open(join(copy, "huge.bin"), "w");
  await sparse.truncate(64 * 1024 ** 3);
  await sparse.close();
  const reads = readTransfer.mock.calls.length;
  expect(await listed(1000n)).toEqual({
    case: "listed",
    value: {
      skipped: 0n,
      errorKey: "huge.bin",
      errorReason: "a file exceeds the copy byte limit or 5 GiB",
    },
  });
  // Only the listing itself came back.
  expect(readTransfer.mock.calls.length).toBe(reads + 1);
  await rm(join(copy, "huge.bin"));
  // A staged file counts only once it changes; new files may not exceed the limit together.
  await writeFile(join(copy, "a.bin"), Buffer.alloc(300, 2));
  await writeFile(join(copy, "b.bin"), Buffer.alloc(300, 3));
  expect(await listed(1000n)).toEqual({
    case: "listed",
    value: { skipped: 1n, errorKey: "", errorReason: "" },
  });
  await writeFile(join(copy, "kept.bin"), Buffer.alloc(600, 4));
  expect(await listed(1000n)).toEqual({
    case: "listed",
    value: {
      skipped: 0n,
      errorKey: "kept.bin",
      errorReason: "change set exceeds the copy byte limit",
    },
  });
  await session.stop({ owner });
}, 30_000);

it("wires Workspace copy staging and capture through generated gRPC and production handlers", async () => {
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
  const root = `volumes/${createHash("sha256").update(owner.attemptId).digest("hex")}`;
  try {
    await provider.allocate(
      { owner, timeoutMs: 60_000, allowedActions: ["files:read", "files:write"] },
      auth,
    );
    await provider.stage(
      (async function* () {
        yield create(RemoteWorkspaceStageChunkSchema, { part: { case: "header", value: header } });
        yield create(RemoteWorkspaceStageChunkSchema, { part: { case: "payload", value: bytes } });
      })(),
      auth,
    );
    const upload = (path: string, files: Record<string, Buffer>) =>
      (async function* () {
        yield create(RemoteWorkspaceCopyUploadSchema, {
          part: { case: "header", value: { path, readWrite: true } },
        });
        for await (const part of copyParts(files))
          yield create(RemoteWorkspaceCopyUploadSchema, { part });
      })();
    // A stream must open with its header.
    await expect(
      provider.stageCopy(
        (async function* () {
          yield create(RemoteWorkspaceCopyUploadSchema, {
            part: { case: "payload", value: Buffer.from("x") },
          });
        })(),
        auth,
      ),
    ).rejects.toMatchObject({ code: Code.InvalidArgument });
    await expect(
      provider.stageCopy(upload(`${root}/rw`, { "rows.csv": Buffer.from("x\n") }), auth),
    ).resolves.toMatchObject({ files: 1n });
    await session.execute({ kind: "write", path: `${root}/rw/rows.csv`, content: "x\ny\n" });
    for await (const _ of provider.capture({}, auth));
    const parts = [];
    for await (const { part } of provider.captureCopy({ path: `${root}/rw`, maxBytes: GiB }, auth))
      parts.push(part);
    expect(parts.map((part) => part.case)).toEqual(["file", "listed", "payload"]);
    expect(Buffer.from(parts[2]?.value as Uint8Array).toString()).toBe("x\ny\n");
    await provider.stop({ owner, sandboxId: "sandbox-one" }, auth);
  } finally {
    sessionManager.abort();
    await server.close();
  }
}, 15_000);
/** Two commits of one repository, each bundled with its full history. */
async function history() {
  const root = await mkdtemp(join(tmpdir(), "supertag-e2b-history-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const git = async (...args: string[]) => {
    const result = await wait(spawn("git", args, { cwd: root }));
    if (result.exitCode !== 0) throw new Error(result.stderr);
    return result.stdout.trim();
  };
  const commit = async (name: string) => {
    await git("add", "-A", ".");
    await git(
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "-c",
      "commit.gpgSign=false",
      "commit",
      "-qm",
      name,
    );
    const head = await git("rev-parse", "HEAD");
    const ref = `refs/heads/supertag-deliveries/${name}`;
    await git("update-ref", ref, head);
    const path = join(root, `${name}.bundle`);
    await git("bundle", "create", path, ref);
    const bytes = await readFile(path);
    await rm(path);
    return {
      bytes,
      header: {
        startCommit: head,
        bundle: {
          sha256: createHash("sha256").update(bytes).digest("hex"),
          byteLength: BigInt(bytes.length),
        },
      },
    };
  };
  await git("init", "-q", "--template=");
  await writeFile(join(root, ".gitignore"), ".setup-*\n");
  await writeFile(join(root, "a.txt"), "one\n");
  await writeFile(join(root, "gone.txt"), "removed later\n");
  const trusted = await commit("trusted");
  await writeFile(join(root, "a.txt"), "two\n");
  await rm(join(root, "gone.txt"));
  const next = await commit("next");
  return { trusted, next };
}

it("prepares the trusted commit once, snapshots it, and starts Task sandboxes from the artifact", async () => {
  const directory = await mkdtemp(join(tmpdir(), "supertag-e2b-prepared-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const preparedRoot = join(directory, "prepared");
  const { trusted, next } = await history();
  const setup = ["sh -c 'echo built >> .setup-log'", "sh -c 'echo tracked-edit > a.txt'"];

  // A preparation sandbox takes the trusted commit alone, runs setup, and is snapshotted.
  const build = await fixture(preparedRoot);
  await expect(
    build.session.allocate({
      owner,
      timeoutMs: 60_000,
      allowedActions: ["files:read"],
      prepare: true,
      environment: { dockerfileCommands: [], setupCommands: setup },
    }),
  ).rejects.toThrow(/no file actions/u);
  const preparation = await fixture(preparedRoot);
  await preparation.session.allocate({
    owner,
    timeoutMs: 60_000,
    allowedActions: [],
    prepare: true,
    environment: { dockerfileCommands: [], setupCommands: setup },
  });
  await expect(
    preparation.session.stage(
      { ...trusted.header, mcpCommit: trusted.header.startCommit },
      trusted.bytes,
    ),
  ).rejects.toThrow(/trusted commit alone/u);
  await preparation.session.stage(trusted.header, trusted.bytes);
  await expect(preparation.session.execute({ kind: "read", path: "a.txt" })).rejects.toThrow(
    /not staged/u,
  );
  await expect(preparation.session.snapshot()).resolves.toBe("snapshot-prepared");
  await preparation.session.stop({ owner });

  // A Task sandbox from the artifact builds nothing, runs no setup, and checks out its start
  // commit over the prepared one: tracked files follow the commit, setup output stays.
  const task = await fixture(preparedRoot);
  await task.session.allocate({
    owner,
    timeoutMs: 60_000,
    allowedActions: ["files:read", "files:write"],
    preparedArtifact: "snapshot-prepared",
    environment: { dockerfileCommands: ["USER node"], user: "node", setupCommands: setup },
  });
  expect(task.templates.build).not.toHaveBeenCalled();
  expect(task.factory.create).toHaveBeenCalledWith(
    expect.objectContaining({ template: "snapshot-prepared" }),
  );
  await task.session.stage(next.header, next.bytes);
  expect(
    vi
      .mocked(task.client.commands.run)
      .mock.calls.some(([command]) => command.includes("devcontainer-setup")),
  ).toBe(false);
  await expect(task.session.snapshot()).rejects.toThrow(/preparation sandbox/u);
  const captured = await task.session.capture();
  expect(unpack(captured.bytes)).toEqual([
    // Setup output the checkout ignores stays in the sandbox.
    { path: ".gitignore", mode: "100644", body: ".setup-*\n" },
    { path: "a.txt", mode: "100644", body: "two\n" },
  ]);
  await task.session.stop({ owner });

  // A warm preparation starts from the artifact and runs its own setup lines on the new commit.
  const warm = await fixture(preparedRoot);
  await warm.session.allocate({
    owner,
    timeoutMs: 60_000,
    allowedActions: [],
    prepare: true,
    preparedArtifact: "snapshot-prepared",
    environment: { dockerfileCommands: [], setupCommands: ["sh -c 'echo warm >> .setup-log'"] },
  });
  await warm.session.stage(next.header, next.bytes);
  expect(await readFile(join(preparedRoot, "checkout", ".setup-log"), "utf8")).toBe(
    "built\nwarm\n",
  );
  await warm.session.snapshot();
  await warm.session.stop({ owner });

  // Eviction deletes the provider's snapshot; an invalid ID never reaches it.
  await warm.session.removeArtifact("snapshot-prepared");
  expect(warm.factory.deleteSnapshot).toHaveBeenCalledWith("snapshot-prepared");
  await expect(warm.session.removeArtifact("bad artifact")).rejects.toThrow(/invalid/u);
  const other = await fixture(preparedRoot);
  await expect(
    other.session.allocate({
      owner,
      timeoutMs: 60_000,
      allowedActions: [],
      preparedArtifact: "bad artifact",
    }),
  ).rejects.toThrow(/prepared artifact is invalid/u);
  expect(other.factory.create).not.toHaveBeenCalled();
}, 30_000);

it("reports its sandbox lost only once E2B says that sandbox no longer exists", async () => {
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
  // The sandbox stops answering, but E2B does not answer either: a timeout proves nothing.
  vi.mocked(f.client.commands.run).mockRejectedValue(new Error("socket hang up"));
  f.inventory.get.mockRejectedValueOnce(new Error("request timed out"));
  expect(await outcome("a.txt")).not.toHaveProperty("sandboxLost");
  // E2B still lists the sandbox: not gone.
  expect(await outcome("a.txt")).not.toHaveProperty("sandboxLost");
  // E2B reports the exact ID not found: the sandbox is gone, and later calls say so at once.
  f.inventory.get.mockResolvedValueOnce(undefined);
  expect(await outcome("a.txt")).toEqual({
    text: "The E2B sandbox no longer exists.",
    isError: true,
    sandboxLost: true,
  });
  const asked = f.inventory.get.mock.calls.length;
  expect(await outcome("a.txt")).toMatchObject({ sandboxLost: true });
  expect(f.inventory.get.mock.calls.length).toBe(asked);
});

it("starts the egress relay as root over a long-lived command, and keeps the sandbox offline", async () => {
  relayStarts.mockClear();
  const { session, factory } = await fixture();
  await session.allocate({
    owner,
    timeoutMs: 60_000,
    allowedActions: ["files:read", "files:write", "commands:execute"],
    egress: {
      proxy: "127.0.0.1:4000",
      variables: { HTTPS_PROXY: "http://attempt:secret@127.0.0.1:3128" },
      caPem: "-----BEGIN CERTIFICATE-----\nfixture\n-----END CERTIFICATE-----\n",
    },
  });
  expect(relayStarts).toHaveBeenCalledTimes(1);
  expect(relayStarts.mock.calls[0]?.[0].slice(0, 4)).toEqual([
    "/usr/bin/env",
    "-i",
    "PATH=/usr/local/bin:/usr/bin:/bin",
    "python3",
  ]);
  expect(factory.create.mock.calls[0]?.[0].allowInternetAccess).toBe(false);
  await session.stop({ owner });
});
