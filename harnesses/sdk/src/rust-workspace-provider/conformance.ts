/**
 * The sandbox provider conformance suite (docs/reference/sandbox-providers.md). It drives a
 * provider's session through the production handlers and the real gRPC transport, as the Worker
 * Host does, and checks what the contract requires and an outside caller can observe.
 *
 * It depends on no test framework: `sandboxProviderConformance` returns named cases whose `run`
 * throws on a failure. Register them with any runner:
 *
 *   for (const check of sandboxProviderConformance(factory, { commands: true }))
 *     it(check.name, check.run, check.timeoutMs);
 *
 * The cases need `git` on the machine running them, to build the pinned bundle.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { create, type MessageInitShape } from "@bufbuild/protobuf";
import { type Client, createClient } from "@connectrpc/connect";
import { createGrpcTransport, Http2SessionManager } from "@connectrpc/connect-node";
import {
  HarnessWorkspace,
  HarnessWorkspaceRequestSchema,
  RemoteWorkspaceProvider,
  RemoteWorkspaceStageChunkSchema,
} from "../rust-harness/index.js";
import { createWorkspaceHandlers } from "./handlers.js";
import type { SandboxWorkspaceSession } from "./session.js";
import { startRemoteWorkspaceTransport } from "./transport.js";

/**
 * Makes a fresh provider session for one case. `directory` is the case's private scratch
 * directory, removed afterwards, for a test double's own state such as a prepared root.
 * `hostId` is the owner's host ID, new for every case, so `lose` can find exactly the case's
 * sandboxes even while another run uses the same provider.
 */
export type ConformanceFactory = (context: {
  readonly directory: string;
  readonly hostId: string;
}) => Promise<ConformanceProvider>;

/** One provider session under test, made fresh for every case. */
export interface ConformanceProvider {
  readonly session: SandboxWorkspaceSession;
  /**
   * Ends the sandbox out of band, as a crashed or expired sandbox would end. Without it, the
   * lost-sandbox case is skipped.
   */
  lose?(): Promise<void>;
  /** Releases what the provider's test double holds, after the case. */
  close?(): Promise<void>;
  /**
   * For a test double whose egress relay runs on this machine: the port its relay listens on,
   * which the egress case connects to directly. An isolated provider leaves it out, and the
   * case connects from a command in the sandbox to the relay's fixed port instead.
   */
  relayPort?(): number | undefined;
}

export interface ConformanceOptions {
  /** The provider can seal its sandboxes, so it admits `commands:execute`. */
  readonly commands: boolean;
  /** The provider keeps prepared artifacts: Snapshot and RemoveArtifact. */
  readonly snapshots?: boolean;
  /**
   * The sandbox is a separate machine or container: a command cannot reach the machine running
   * the suite, and the seal really stops processes. A test double that runs files and processes
   * on this machine sets false, and its command and seal cases then check the protocol only.
   */
  readonly isolated?: boolean;
  /** Each case's time limit; 60 seconds by default. */
  readonly timeoutMs?: number;
  /**
   * The provider carries a network-scoped Task's connections over its egress relay
   * (`RemoteWorkspaceAllocateRequest.egress`). Needs `commands`.
   */
  readonly egress?: boolean;
}

export interface ConformanceCase {
  readonly name: string;
  readonly run: () => Promise<void>;
  readonly timeoutMs: number;
}

const TOKEN = "sandbox-provider-conformance-token";
const AUTH = { headers: { authorization: `Bearer ${TOKEN}` } };

interface Bundle {
  readonly header: {
    readonly startCommit: string;
    readonly bundle: { readonly sha256: string; readonly byteLength: bigint };
  };
  readonly bytes: Uint8Array;
}

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      PATH: process.env["PATH"] ?? "/usr/bin:/bin",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
    },
  });
  if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr}`);
  return result.stdout.trim();
}

/**
 * A start commit with a tracked file, an executable, a link inside the checkout, and a
 * `.gitignore`; with `escaping`, also a link that leaves the checkout.
 */
async function bundle(directory: string, escaping = false): Promise<Bundle> {
  const root = join(directory, escaping ? "escaping" : "repository");
  await mkdir(root);
  git(root, "init", "-q", "--template=");
  await writeFile(join(root, "a.txt"), "original\n");
  await writeFile(join(root, "run.sh"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  await writeFile(join(root, ".gitignore"), "ignored/\n");
  await symlink("a.txt", join(root, "inside"));
  if (escaping) await symlink("../../../../../../../etc/hostname", join(root, "escape"));
  git(root, "add", ".");
  git(
    root,
    "-c",
    "user.name=Conformance",
    "-c",
    "user.email=conformance@example.invalid",
    "-c",
    "commit.gpgSign=false",
    "commit",
    "-qm",
    "conformance",
  );
  const startCommit = git(root, "rev-parse", "HEAD");
  const ref = "refs/heads/supertag-deliveries/conformance";
  git(root, "update-ref", ref, startCommit);
  const path = join(directory, escaping ? "escaping.bundle" : "source.bundle");
  git(root, "bundle", "create", path, ref);
  const bytes = await readFile(path);
  return {
    bytes,
    header: {
      startCommit,
      bundle: {
        sha256: createHash("sha256").update(bytes).digest("hex"),
        byteLength: BigInt(bytes.byteLength),
      },
    },
  };
}

interface TreeEntry {
  readonly path: string;
  readonly mode: string;
  readonly body: string;
}

/** Reads the `STWTREE1` tree Capture returns. */
function unpack(bytes: Uint8Array): TreeEntry[] {
  const input = Buffer.from(bytes);
  assert.equal(input.subarray(0, 9).toString(), "STWTREE1\n", "tree header");
  let offset = 13 + input.readUInt32BE(9);
  const manifest = JSON.parse(input.subarray(13, offset).toString()) as {
    entries: { path: string; mode: string; size: number }[];
  };
  const entries = manifest.entries.map(({ path, mode, size }) => {
    const body = input.subarray(offset, offset + size).toString();
    offset += size;
    return { path, mode, body };
  });
  assert.equal(offset, input.length, "tree length");
  return entries;
}

/** One case's provider, served over the real transport, with a host directory it must not touch. */
interface Harness {
  readonly provider: Client<typeof RemoteWorkspaceProvider>;
  readonly workspace: Client<typeof HarnessWorkspace>;
  readonly under: ConformanceProvider;
  readonly owner: {
    hostId: string;
    hostGeneration: bigint;
    taskId: string;
    attemptId: string;
    allocationId: string;
  };
  readonly bundle: Bundle;
  /** The same commit with a link that leaves the checkout. */
  readonly escaping: Bundle;
  /** A host directory with one file; nothing a sandbox does may change it. */
  readonly host: string;
}

async function withHarness(
  factory: ConformanceFactory,
  body: (harness: Harness) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "supertag-provider-conformance-"));
  const host = join(directory, "host");
  await mkdir(host);
  await writeFile(join(host, "sentinel"), "host\n");
  const provider = join(directory, "provider");
  await mkdir(provider);
  const id = randomUUID();
  const hostId = `conformance-host-${id.slice(0, 8)}`;
  const under = await factory({ directory: provider, hostId });
  const server = await startRemoteWorkspaceTransport({
    ...createWorkspaceHandlers(under.session),
    token: TOKEN,
    // The client sees only "internal"; the cause belongs in the test's log.
    onError: (error) => console.error("Provider operation failed:", error),
  });
  const sessions = new Http2SessionManager(server.endpoint);
  const transport = createGrpcTransport({ baseUrl: server.endpoint, sessionManager: sessions });
  try {
    await body({
      provider: createClient(RemoteWorkspaceProvider, transport),
      workspace: createClient(HarnessWorkspace, transport),
      under,
      owner: {
        hostId,
        hostGeneration: 1n,
        taskId: `task-${id}`,
        attemptId: `attempt-${id}`,
        allocationId: `allocation-${id}`,
      },
      bundle: await bundle(directory),
      escaping: await bundle(directory, true),
      host,
    });
    // Rule 1 and 2: the host directory is exactly as it was.
    assert.deepEqual(await readdir(host), ["sentinel"], "the host directory gained an entry");
    assert.equal(await readFile(join(host, "sentinel"), "utf8"), "host\n", "the host file changed");
  } finally {
    sessions.abort();
    await server.close();
    await under.session.close().catch(() => undefined);
    await under.close?.();
    await rm(directory, { recursive: true, force: true });
  }
}

const READ_WRITE = ["files:read", "files:write"];

async function allocate(harness: Harness, allowedActions: readonly string[]): Promise<string> {
  const allocation = await harness.provider.allocate(
    { owner: harness.owner, timeoutMs: 600_000, allowedActions: [...allowedActions] },
    AUTH,
  );
  assert.ok(allocation.sandboxId, "Allocate returns a sandbox ID");
  return allocation.sandboxId;
}

function stageParts(bundle: Bundle, sha256 = bundle.header.bundle.sha256) {
  const header = create(RemoteWorkspaceStageChunkSchema, {
    part: {
      case: "header",
      value: { ...bundle.header, bundle: { ...bundle.header.bundle, sha256 } },
    },
  });
  const chunk = 64 * 1024;
  return (async function* () {
    yield header;
    for (let offset = 0; offset < bundle.bytes.byteLength; offset += chunk)
      yield create(RemoteWorkspaceStageChunkSchema, {
        part: { case: "payload", value: bundle.bytes.subarray(offset, offset + chunk) },
      });
  })();
}

async function staged(harness: Harness, allowedActions: readonly string[]): Promise<string> {
  const sandboxId = await allocate(harness, allowedActions);
  await harness.provider.stage(stageParts(harness.bundle), AUTH);
  return sandboxId;
}

type Operation = NonNullable<MessageInitShape<typeof HarnessWorkspaceRequestSchema>["operation"]>;

/** A tool call's text, or `undefined` when the call was refused or failed. */
async function tool(harness: Harness, operation: Operation): Promise<string | undefined> {
  try {
    const result = await harness.workspace.execute(
      create(HarnessWorkspaceRequestSchema, { operation }),
      AUTH,
    );
    return result.isError ? undefined : result.text;
  } catch {
    return undefined;
  }
}

async function capture(harness: Harness, keep: string[] = []): Promise<TreeEntry[]> {
  const chunks: Uint8Array[] = [];
  let receipt: { sha256: string; byteLength: bigint } | undefined;
  for await (const chunk of harness.provider.capture({ keep }, AUTH)) {
    if (chunk.part.case === "tree") receipt = chunk.part.value;
    else if (chunk.part.case === "payload") chunks.push(chunk.part.value);
  }
  const bytes = Buffer.concat(chunks);
  assert.ok(receipt, "Capture sends its receipt first");
  assert.equal(BigInt(bytes.byteLength), receipt.byteLength, "tree length matches the receipt");
  assert.equal(
    createHash("sha256").update(bytes).digest("hex"),
    receipt.sha256,
    "tree digest matches the receipt",
  );
  return unpack(bytes);
}

async function refused(call: Promise<unknown>, what: string): Promise<void> {
  await assert.rejects(call, Error, `${what} must be refused`);
}

/**
 * The conformance cases for one provider. `factory` makes a fresh provider session for each
 * case; `options` says which optional contracts it implements.
 */
export function sandboxProviderConformance(
  factory: ConformanceFactory,
  options: ConformanceOptions,
): ConformanceCase[] {
  const timeoutMs = options.timeoutMs ?? 60_000;
  const cases: ConformanceCase[] = [];
  const add = (name: string, body: (harness: Harness) => Promise<void>) =>
    cases.push({ name, timeoutMs, run: () => withHarness(factory, body) });

  add("allocates one sandbox per helper and stops it exactly once", async (harness) => {
    const sandboxId = await allocate(harness, ["files:read"]);
    await refused(allocate(harness, ["files:read"]), "a second Allocate on one helper");
    await refused(
      harness.provider.stop(
        { owner: { ...harness.owner, allocationId: "another-allocation" }, sandboxId },
        AUTH,
      ),
      "Stop for another owner",
    );
    const stopped = await harness.provider.stop({ owner: harness.owner, sandboxId }, AUTH);
    assert.equal(stopped.stoppedSandboxId, sandboxId, "Stop confirms the sandbox");
    const again = await harness.provider.stop({ owner: harness.owner, sandboxId }, AUTH);
    assert.equal(again.stoppedSandboxId, sandboxId, "Stop on a stopped sandbox succeeds");
  });

  add(
    "refuses a bundle whose digest differs from its receipt, then stages the right one",
    async (harness) => {
      await allocate(harness, READ_WRITE);
      await refused(
        harness.provider.stage(stageParts(harness.bundle, "0".repeat(64)), AUTH),
        "a bundle with the wrong digest",
      );
      await harness.provider.stage(stageParts(harness.bundle), AUTH);
      const text = await tool(harness, { case: "read", value: { path: "a.txt" } });
      assert.ok(text?.includes("original"), "the staged checkout holds the start commit");
    },
  );

  add("refuses to stage a commit holding a link that leaves the checkout", async (harness) => {
    await allocate(harness, READ_WRITE);
    await refused(
      harness.provider.stage(stageParts(harness.escaping), AUTH),
      "a commit with an escaping link",
    );
    assert.equal(
      await tool(harness, { case: "read", value: { path: "a.txt" } }),
      undefined,
      "file tools after a refused Stage",
    );
  });

  add("keeps file tools inside the checkout and away from Git metadata", async (harness) => {
    await staged(harness, READ_WRITE);
    assert.ok(
      await tool(harness, { case: "write", value: { path: "new.txt", content: "created\n" } }),
      "a write inside the checkout",
    );
    assert.ok(
      await tool(harness, {
        case: "edit",
        value: { path: "a.txt", oldText: "original", newText: "edited" },
      }),
      "an edit inside the checkout",
    );
    assert.ok(
      (await tool(harness, { case: "glob", value: { pattern: "*.txt" } }))?.includes("new.txt"),
      "glob finds the new file",
    );
    assert.ok(
      (await tool(harness, { case: "read", value: { path: "inside" } }))?.includes("edited"),
      "a link inside the checkout reads its target",
    );
    for (const path of [
      ".git/config",
      "../outside.txt",
      join(harness.host, "sentinel"),
      join(harness.host, "planted"),
    ]) {
      assert.equal(
        await tool(harness, { case: "write", value: { path, content: "planted\n" } }),
        undefined,
        `a write to ${path}`,
      );
    }
    for (const path of [".git/HEAD", "../outside.txt", join(harness.host, "sentinel")])
      assert.equal(
        await tool(harness, { case: "read", value: { path } }),
        undefined,
        `a read of ${path}`,
      );
  });

  add("captures the exact sorted tree, without Git metadata or ignored files", async (harness) => {
    await staged(harness, READ_WRITE);
    await tool(harness, {
      case: "edit",
      value: { path: "a.txt", oldText: "original", newText: "changed" },
    });
    await tool(harness, { case: "write", value: { path: "b/new.txt", content: "new\n" } });
    await tool(harness, {
      case: "write",
      value: { path: "ignored/cache.txt", content: "cache\n" },
    });
    await tool(harness, { case: "write", value: { path: "kept/out.txt", content: "kept\n" } });
    const tree = await capture(harness, ["kept"]);
    const paths = tree.map((entry) => entry.path);
    assert.deepEqual(paths, [...paths].sort(), "entries are sorted");
    assert.ok(
      tree.some((entry) => entry.path === "a.txt" && entry.body === "changed\n"),
      "the edited file returns with its new bytes",
    );
    assert.ok(
      tree.some((entry) => entry.path === "b/new.txt" && entry.body === "new\n"),
      "a created file returns",
    );
    assert.ok(
      tree.some((entry) => entry.path === "run.sh" && entry.mode === "100755"),
      "file modes return exactly",
    );
    assert.ok(
      tree.some((entry) => entry.path === "inside" && entry.mode === "120000"),
      "links return as links",
    );
    assert.ok(
      tree.some((entry) => entry.path === "kept/out.txt"),
      "a kept path returns even when untracked",
    );
    assert.ok(!paths.some((path) => path.split("/").includes(".git")), "no Git metadata");
    assert.ok(!paths.some((path) => path.startsWith("ignored/")), "no ignored output");
    // After Capture, tools are sealed.
    assert.equal(
      await tool(harness, { case: "write", value: { path: "late.txt", content: "late\n" } }),
      undefined,
      "a write after Capture",
    );
  });

  add("fails every tool call after Stop and runs nothing on the host", async (harness) => {
    const sandboxId = await staged(harness, READ_WRITE);
    await harness.provider.stop({ owner: harness.owner, sandboxId }, AUTH);
    for (const operation of [
      { case: "read", value: { path: "a.txt" } },
      { case: "write", value: { path: "after-stop.txt", content: "x\n" } },
      { case: "list", value: {} },
    ] as Operation[])
      assert.equal(await tool(harness, operation), undefined, `${operation.case} after Stop`);
    await refused(capture(harness), "Capture after Stop");
  });

  cases.push({
    name: "fails every tool call when the sandbox is lost, and runs nothing on the host",
    timeoutMs,
    run: () =>
      withHarness(factory, async (harness) => {
        if (!harness.under.lose) return;
        await staged(harness, options.commands ? [...READ_WRITE, "commands:execute"] : READ_WRITE);
        await harness.under.lose();
        assert.equal(
          await tool(harness, { case: "read", value: { path: "a.txt" } }),
          undefined,
          "a read in a lost sandbox",
        );
        assert.equal(
          await tool(harness, { case: "write", value: { path: "lost.txt", content: "x\n" } }),
          undefined,
          "a write in a lost sandbox",
        );
        if (options.commands)
          assert.equal(
            await tool(harness, {
              case: "command",
              value: { command: `touch ${join(harness.host, "planted")}` },
            }),
            undefined,
            "a command in a lost sandbox",
          );
        await refused(capture(harness), "Capture of a lost sandbox");
      }),
  });

  add("refuses commands to a Task without commands:execute", async (harness) => {
    await staged(harness, READ_WRITE);
    assert.equal(
      await tool(harness, { case: "command", value: { command: "true" } }),
      undefined,
      "a command without commands:execute",
    );
  });

  if (options.commands) {
    const COMMANDS = [...READ_WRITE, "commands:execute"];

    if (options.egress)
      add(
        "carries a command's connection over the egress relay to the Worker Host's proxy",
        async (harness) => {
          // The Attempt's egress proxy, on this machine's loopback: it answers CONNECT, then
          // echoes, so a connection's bytes cross the relay both ways.
          const requests: string[] = [];
          const proxy = createServer((socket) => {
            socket.on("error", () => {});
            socket.once("data", (data: Buffer) => {
              // What follows the request in the same read is the tunnel's first bytes.
              const end = data.indexOf("\r\n\r\n") + 4;
              requests.push(data.subarray(0, end).toString("latin1"));
              socket.write("HTTP/1.1 200 Connection established\r\n\r\n");
              if (end < data.length) socket.write(data.subarray(end));
              socket.pipe(socket);
            });
          }).listen(0, "127.0.0.1");
          await once(proxy, "listening");
          try {
            const port = (proxy.address() as { port: number }).port;
            const variables = { HTTPS_PROXY: "http://attempt:placeholder@127.0.0.1:3128" };
            const allocation = await harness.provider.allocate(
              {
                owner: harness.owner,
                timeoutMs: 600_000,
                allowedActions: COMMANDS,
                egress: {
                  proxy: `127.0.0.1:${port}`,
                  variables,
                  caPem: "-----BEGIN CERTIFICATE-----\nconformance\n-----END CERTIFICATE-----\n",
                },
              },
              AUTH,
            );
            assert.ok(allocation.sandboxId, "Allocate returns a sandbox ID");
            await harness.provider.stage(stageParts(harness.bundle), AUTH);
            const proxied = await tool(harness, {
              case: "command",
              value: { command: 'printf "%s" "$HTTPS_PROXY"' },
            });
            assert.ok(
              proxied?.includes(variables.HTTPS_PROXY),
              "commands get the proxy through the relay",
            );
            // More than one credit window each way.
            const size = 512 * 1024;
            const relayPort = harness.under.relayPort?.();
            if (relayPort !== undefined) {
              const payload = Buffer.alloc(size, 7);
              const socket = connect(relayPort, "127.0.0.1");
              socket.on("error", () => {});
              const received: Buffer[] = [];
              socket.on("data", (data: Buffer) => received.push(data));
              await once(socket, "connect");
              socket.write("CONNECT conformance.example:443 HTTP/1.1\r\n\r\n");
              socket.write(payload);
              const reply = "HTTP/1.1 200 Connection established\r\n\r\n";
              const deadline = Date.now() + 30_000;
              while (Buffer.concat(received).length < reply.length + size) {
                assert.ok(Date.now() < deadline, "the relayed bytes arrive");
                await new Promise((resolve) => setTimeout(resolve, 20));
              }
              socket.destroy();
              const all = Buffer.concat(received);
              assert.equal(all.subarray(0, reply.length).toString(), reply);
              assert.ok(all.subarray(reply.length).equals(payload), "the bytes return intact");
            } else {
              assert.ok(options.isolated, "a provider whose relay runs elsewhere is isolated");
              const program = [
                "import socket",
                "s = socket.create_connection(('127.0.0.1', 3128), timeout=30)",
                "s.sendall(b'CONNECT conformance.example:443 HTTP/1.1\\r\\n\\r\\n')",
                "head = b''",
                "while not head.endswith(b'\\r\\n\\r\\n'): head += s.recv(1)",
                `payload = bytes(range(256)) * ${size / 256}`,
                "s.sendall(payload)",
                "back = b''",
                "while len(back) < len(payload): back += s.recv(65536)",
                "print(head.split(b'\\r\\n')[0].decode(), back == payload)",
              ].join("\n");
              const relayed = await tool(harness, {
                case: "command",
                value: { command: `python3 -c "${program}"`, timeoutMs: 60_000 },
              });
              assert.match(
                relayed ?? "",
                /HTTP\/1\.1 200 Connection established True/u,
                "a command reaches the proxy through the relay",
              );
            }
            assert.match(requests[0] ?? "", /^CONNECT conformance\.example:443 HTTP\/1\.1\r\n/u);
            await capture(harness);
          } finally {
            proxy.close();
          }
        },
      );

    add(
      "runs commands in the checkout, bounded in time and output, never on the host",
      async (harness) => {
        await staged(harness, COMMANDS);
        const echoed = await tool(harness, {
          case: "command",
          value: { command: "cat a.txt && echo conformance-ok" },
        });
        assert.ok(echoed?.includes("conformance-ok"), "a command runs");
        assert.ok(echoed?.includes("original"), "a command runs in the checkout");
        // In a separate sandbox, a write to the host's path lands only in the sandbox.
        if (options.isolated)
          await tool(harness, {
            case: "command",
            value: {
              command: `mkdir -p ${harness.host} && echo planted > ${join(harness.host, "planted")}`,
            },
          });
        const started = Date.now();
        await tool(harness, { case: "command", value: { command: "sleep 30", timeoutMs: 1_000 } });
        assert.ok(Date.now() - started < 20_000, "a command stops at its own time limit");
        const flood = await harness.workspace.execute(
          {
            operation: {
              case: "command",
              value: { command: "head -c 4000000 /dev/zero | tr '\\0' a" },
            },
          },
          AUTH,
        );
        assert.ok(flood.text.length < 256 * 1024, "command output is bounded");
      },
    );

    add(
      "seals the sandbox before Capture, after a command left a process running",
      async (harness) => {
        await staged(harness, COMMANDS);
        await tool(harness, {
          case: "command",
          value: {
            // A test double would leave the process running on this machine.
            command: options.isolated
              ? "(while :; do date >> leftover.log; sleep 0.05; done) > /dev/null 2>&1 & echo started"
              : "date > leftover.log",
          },
        });
        const first = await capture(harness);
        const second = await capture(harness);
        assert.deepEqual(first, second, "the captured tree is fixed once sealed");
      },
    );
  } else {
    add("refuses Allocate for commands when the provider cannot seal", async (harness) => {
      await refused(
        allocate(harness, [...READ_WRITE, "commands:execute"]),
        "commands in a sandbox that cannot be sealed",
      );
    });
  }

  if (options.snapshots) {
    add(
      "snapshots a preparation sandbox and deletes the artifact idempotently",
      async (harness) => {
        await harness.provider.allocate(
          { owner: harness.owner, timeoutMs: 600_000, allowedActions: [], prepare: true },
          AUTH,
        );
        await harness.provider.stage(stageParts(harness.bundle), AUTH);
        const { artifact } = await harness.provider.snapshot({}, AUTH);
        assert.ok(artifact, "Snapshot returns an artifact");
        await harness.provider.removeArtifact({ artifact }, AUTH);
        await harness.provider.removeArtifact({ artifact }, AUTH);
      },
    );
  }

  return cases;
}
