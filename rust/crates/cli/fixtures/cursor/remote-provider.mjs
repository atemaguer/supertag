import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  access,
  appendFile,
  cp,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const root = dirname(fileURLToPath(import.meta.url));
const provider = await readFile(join(root, "provider-kind"), "utf8").catch(() => "e2b");
assert.ok(["e2b", "modal"].includes(provider));
const redact = (message) =>
  String(message)
    .replaceAll("synthetic-e2b-provider-key", "[REDACTED]")
    .replaceAll("synthetic-modal-token-id", "[REDACTED]")
    .replaceAll("synthetic-modal-token-secret", "[REDACTED]");
await appendFile(
  join(root, "provider-calls.jsonl"),
  `${JSON.stringify({ type: "boot", pid: process.pid, environment: Object.keys(process.env).sort() })}\n`,
  { mode: 0o600 },
);
process.on("uncaughtException", async (error) => {
  await appendFile(
    join(root, "provider-calls.jsonl"),
    `${JSON.stringify({ type: "startup-error", message: redact(error.message).slice(0, 1200) })}\n`,
    { mode: 0o600 },
  );
  process.exit(1);
});
const { providerTransport } = JSON.parse(await readFile(join(root, "modules.json"), "utf8"));
const { runRemoteWorkspaceTransport } = await import(pathToFileURL(providerTransport).href);
// Copies run the provider SDK's own staging and listing code, with its sandbox
// program executed here as the sandbox would.
const { createWorkspaceCopies } = await import(
  new URL("./copies.js", pathToFileURL(providerTransport)).href
);
const expected =
  provider === "modal"
    ? {
        MODAL_TOKEN_ID: "synthetic-modal-token-id",
        MODAL_TOKEN_SECRET: "synthetic-modal-token-secret",
        MODAL_SERVER_URL: "https://fixture.modal.invalid:443",
        MODAL_CONFIG_PATH: "/dev/null",
        SUPERTAG_MODAL_WORKSPACE_APP: "fixture-modal-app",
        SUPERTAG_MODAL_WORKSPACE_ENVIRONMENT: "fixture-modal-environment",
        SUPERTAG_MODAL_WORKSPACE_IMAGE: "fixture-modal-image",
      }
    : {
        E2B_API_KEY: "synthetic-e2b-provider-key",
        E2B_DOMAIN: "fixture.e2b.invalid",
        SUPERTAG_E2B_TEMPLATE: "fixture-template",
      };
for (const [key, value] of Object.entries(expected))
  assert.equal(process.env[key], value, `provider is missing expected ${key}`);
for (const key of Object.keys(process.env))
  assert.ok(
    ["PATH", "LANG", "TMPDIR", ...Object.keys(expected), "__CF_USER_TEXT_ENCODING"].includes(key),
    `provider inherited ${key}`,
  );

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const trace = (value) =>
  appendFile(
    join(root, "provider-calls.jsonl"),
    `${JSON.stringify({ pid: process.pid, ...value })}\n`,
    { mode: 0o600 },
  );
const serializable = (owner) => ({ ...owner, hostGeneration: String(owner.hostGeneration) });
let allocation;
let directory;
// A preparation sandbox, which Snapshot records; or the prepared artifact a sandbox starts from.
let preparing = false;
let preparedArtifact;
const artifacts = join(root, "remote-artifacts");
let actions = [];
let environment;
let staged = false;
let mcpStaged = false;
const mcpServers = new Set();
const inputPaths = [];
// Each staged Workspace copy by checkout path and its access, for the fixture's file tools.
const copies = new Map();
let workspaceCopies;
const sandbox = {
  async run(argv, timeoutMs, signal) {
    return new Promise((resolve) => {
      execFile(
        argv[0],
        argv.slice(1),
        { timeout: timeoutMs, signal, maxBuffer: 1024 * 1024 },
        (error, stdout) => resolve({ exitCode: error ? (error.code ?? 1) : 0, stdout }),
      );
    });
  },
  writeTransfer: (path, bytes) => writeFile(path, bytes, { flag: "wx", mode: 0o600 }),
  readTransfer: async (path) => Readable.toWeb(createReadStream(path)),
};
let captured = false;
const copyRoot = () => `volumes/${hash(allocation.owner.attemptId)}`;
const enabled = (name) =>
  access(join(root, name)).then(
    () => true,
    () => false,
  );

async function persist(value) {
  const target = join(directory, "allocation.json");
  await writeFile(`${target}.tmp`, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  await rename(`${target}.tmp`, target);
}

async function stopMcpServers() {
  const running = [...mcpServers];
  mcpServers.clear();
  await Promise.all(
    running.map(async (child) => {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = new Promise((resolve) => child.once("exit", resolve));
        child.kill("SIGKILL");
        await exited;
      }
    }),
  );
}

async function git(cwd, ...args) {
  const { stdout } = await promisify(execFile)("/usr/bin/git", ["-C", cwd, ...args], {
    env: { PATH: "/usr/bin:/bin", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
    timeout: 10_000,
    maxBuffer: 1024 * 1024,
  });
  return stdout.trim();
}

const implementation = {
  provider: {
    async allocate({
      owner,
      allowedActions,
      timeoutMs,
      environment: requested,
      preparedArtifact: artifact,
      prepare,
    }) {
      assert.equal(allocation, undefined);
      assert.ok(owner && owner.hostGeneration > 0n && timeoutMs > 0);
      assert.match(owner.allocationId, /^[\w-]+$/u);
      assert.ok(allowedActions.every((action) => ["files:read", "files:write"].includes(action)));
      directory = join(root, "remote-allocations", owner.allocationId);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      allocation = {
        owner: serializable(owner),
        sandboxId: `fixture-${owner.allocationId}`,
        stopped: false,
      };
      actions = allowedActions;
      // The Worker Host's devcontainer translation: the fixture records it and runs its setup.
      environment = requested && {
        image: requested.image,
        dockerfileCommands: [...requested.dockerfileCommands],
        user: requested.user,
        setupCommands: [...requested.setupCommands],
      };
      if (environment) await trace({ type: "environment", provider, environment, prepare });
      preparing = prepare;
      preparedArtifact = artifact;
      if (artifact !== undefined) {
        // The prepared checkout, with its untracked setup output, is the sandbox's filesystem.
        assert.match(artifact, /^fixture-artifact-[0-9a-f]{8}$/u);
        await cp(join(artifacts, artifact, "checkout"), join(directory, "checkout"), {
          recursive: true,
        });
      }
      await persist(allocation);
      await trace({
        type: "allocate",
        provider,
        ...allocation,
        prepare,
        preparedArtifact: artifact,
        environment: Object.keys(process.env).sort(),
      });
      if (await enabled("lose-allocate-ack")) process.exit(7);
      return { sandboxId: allocation.sandboxId };
    },
    async stage(stream, context) {
      assert.ok(allocation && !staged);
      const chunks = [];
      let header;
      for await (const { part } of stream) {
        if (!header) {
          assert.equal(part.case, "header");
          header = part.value;
        } else {
          assert.equal(part.case, "payload");
          chunks.push(part.value);
        }
      }
      const body = Buffer.concat(chunks);
      const bundle = body.subarray(0, Number(header.bundle.byteLength));
      assert.equal(hash(bundle), header.bundle.sha256);
      const bundlePath = join(directory, "prepared.bundle");
      await writeFile(bundlePath, bundle, { mode: 0o600 });
      const checkout = join(directory, "checkout");
      if (preparedArtifact === undefined) {
        await mkdir(checkout, { mode: 0o700 });
        await git(checkout, "init", "--quiet");
      }
      await git(
        checkout,
        "-c",
        "protocol.file.allow=always",
        "fetch",
        "--quiet",
        bundlePath,
        header.startCommit,
      );
      // Over a prepared checkout this is a forced checkout: untracked setup output stays.
      await git(checkout, "checkout", "--quiet", "--force", "--detach", header.startCommit);
      assert.equal(await git(checkout, "rev-parse", "HEAD"), header.startCommit);
      let offset = bundle.length;
      for (const { path, blob } of header.inputFiles) {
        const attempt = hash(allocation.owner.attemptId);
        assert.match(
          path,
          new RegExp(`^inputs/${attempt}/artifact-[0-9a-f]{64}/(?:[^/]+/)*evidence\\.txt$`, "u"),
        );
        const bytes = body.subarray(offset, offset + Number(blob.byteLength));
        assert.equal(hash(bytes), blob.sha256);
        offset += bytes.length;
        const destination = join(checkout, path);
        await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
        await writeFile(destination, bytes, { mode: 0o400, flag: "wx" });
        inputPaths.push(path);
      }
      assert.equal(offset, body.length);
      if (header.mcpCommit !== undefined) {
        // The trusted copy is the base commit, beside the checkout the Harness can change.
        assert.match(header.mcpCommit, /^[0-9a-f]{40}$/u);
        await git(checkout, "merge-base", "--is-ancestor", header.mcpCommit, header.startCommit);
        const archive = join(directory, "mcp.tar");
        await git(checkout, "archive", "--format=tar", "-o", archive, header.mcpCommit);
        await mkdir(join(directory, "mcp"), { mode: 0o700 });
        await promisify(execFile)("/usr/bin/tar", ["-xf", archive, "-C", join(directory, "mcp")]);
        await rm(archive);
        mcpStaged = true;
      }
      if (preparing) assert.ok(header.inputFiles.length === 0 && header.mcpCommit === undefined);
      if (environment?.setupCommands.length && (preparing || preparedArtifact === undefined)) {
        const { stdout } = await promisify(execFile)(
          "/bin/sh",
          [
            "-c",
            ["set -e", 'cd -- "$1"', ...environment.setupCommands].join("\n"),
            "devcontainer-setup",
            checkout,
          ],
          { env: { PATH: "/usr/bin:/bin", HOME: directory }, timeout: 10_000 },
        );
        await trace({
          type: "setup",
          checkout,
          stdout,
          prepare: preparing,
          setupCommands: environment.setupCommands,
        });
      }
      staged = true;
      await trace({
        type: "stage",
        allocationId: allocation.owner.allocationId,
        startCommit: header.startCommit,
        before: await readFile(join(checkout, "workspace.txt"), "utf8"),
        inputPaths,
        mcpCommit: header.mcpCommit,
      });
      if (inputPaths.length && (await enabled("hold-input-stage"))) {
        await trace({ type: "input-stage-wait", owner: allocation.owner, inputPaths });
        while (await enabled("hold-input-stage")) {
          context.signal.throwIfAborted();
          await delay(20);
        }
      }
      return { inputFiles: header.inputFiles };
    },
    async snapshot() {
      assert.ok(preparing && staged && !allocation.stopped);
      const artifact = `fixture-artifact-${createHash("sha256")
        .update(allocation.owner.allocationId)
        .digest("hex")
        .slice(0, 8)}`;
      await cp(join(directory, "checkout"), join(artifacts, artifact, "checkout"), {
        recursive: true,
      });
      await trace({ type: "snapshot", artifact, preparedArtifact });
      return { artifact };
    },
    async removeArtifact({ artifact }) {
      assert.match(artifact, /^fixture-artifact-[0-9a-f]{8}$/u);
      await rm(join(artifacts, artifact), { recursive: true, force: true });
      await trace({ type: "remove-artifact", artifact });
      return {};
    },
    async *capture() {
      assert.ok(staged && !allocation.stopped);
      await stopMcpServers();
      const checkout = join(directory, "checkout");
      if (
        await access(join(root, "omit-tracked-output")).then(
          () => true,
          () => false,
        )
      ) {
        await rm(join(checkout, "gone.txt"));
      }
      const content = await readFile(join(checkout, "workspace.txt"));
      const entries = [];
      async function files(folder, prefix = "") {
        for (const entry of await readdir(folder, { withFileTypes: true })) {
          if (entry.name === ".git") continue;
          const path = prefix + entry.name;
          if (inputPaths.includes(path) && !(await enabled("return-private-input"))) continue;
          // Workspace copies never return in the tree, unless a fault returns them.
          if (copies.size && path === copyRoot() && !(await enabled("return-copy"))) continue;
          const physical = join(folder, entry.name);
          if (entry.isDirectory()) await files(physical, `${path}/`);
          else {
            assert.ok(entry.isFile(), "unsupported fixture capture entry");
            entries.push({ path, data: await readFile(physical) });
          }
        }
      }
      await files(checkout);
      entries.sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
      const manifest = Buffer.from(
        JSON.stringify({
          entries: entries.map(({ path, data }) => ({ path, mode: "100644", size: data.length })),
        }),
      );
      const length = Buffer.alloc(4);
      length.writeUInt32BE(manifest.length);
      const tree = Buffer.concat([
        Buffer.from("STWTREE1\n"),
        length,
        manifest,
        ...entries.map(({ data }) => data),
      ]);
      await trace({
        type: "capture",
        allocationId: allocation.owner.allocationId,
        content: content.toString(),
        paths: entries.map(({ path }) => path),
        sha256: hash(tree),
      });
      captured = true;
      yield {
        part: { case: "tree", value: { sha256: hash(tree), byteLength: BigInt(tree.length) } },
      };
      yield { part: { case: "payload", value: tree } };
    },
    async stageCopy(stream, context) {
      assert.ok(staged && !allocation.stopped && !captured);
      const inputs = stream[Symbol.asyncIterator]();
      const first = await inputs.next();
      assert.equal(first.value?.part.case, "header");
      const header = first.value.part.value;
      const keys = [];
      const directories = [];
      async function* parts() {
        for (;;) {
          const next = await inputs.next();
          if (next.done) return;
          const { part } = next.value;
          assert.ok(["file", "payload", "directory"].includes(part.case));
          if (part.case === "file") keys.push(part.value.key);
          if (part.case === "directory") directories.push(part.value);
          yield part;
        }
      }
      workspaceCopies ??= createWorkspaceCopies({
        sandbox,
        root: directory,
        attemptId: allocation.owner.attemptId,
        label: "Fixture",
        lifetime: new AbortController().signal,
      });
      const result = await workspaceCopies.stage(header, parts(), context.signal);
      copies.set(header.path, { readWrite: header.readWrite });
      await trace({
        type: "stage-copy",
        path: header.path,
        readWrite: header.readWrite,
        keys: keys.sort(),
        directories: directories.sort(),
      });
      return result;
    },
    async *captureCopy(request, context) {
      assert.ok(captured && !allocation.stopped);
      const keys = [];
      try {
        for await (const part of workspaceCopies.capture(request, context.signal)) {
          if (part.case === "file") keys.push(part.value.key);
          if (part.case === "listed")
            await trace({
              type: "capture-copy",
              path: request.path,
              maxBytes: String(request.maxBytes),
              keys,
              skipped: String(part.value.skipped),
              refusal: part.value.errorReason,
            });
          yield { part };
        }
      } catch (error) {
        await trace({ type: "fixture-error", operation: "captureCopy", message: error.message });
        throw error;
      }
    },
    async *runMcpServer(stream, context) {
      assert.ok(staged && mcpStaged && !allocation.stopped);
      const inputs = stream[Symbol.asyncIterator]();
      const first = await inputs.next();
      assert.equal(first.value?.part.case, "start");
      const { name, command, args } = first.value.part.value;
      const cwd = join(directory, "mcp");
      // The fixture sandbox image has Node.js on PATH, and nothing of the Worker Host.
      const child = spawn(
        "/usr/bin/env",
        ["-i", `PATH=${dirname(process.execPath)}:/usr/bin:/bin`, "LANG=C.UTF-8", command, ...args],
        {
          cwd,
          stdio: ["pipe", "pipe", "ignore"],
          signal: context.signal,
        },
      );
      child.on("error", () => undefined);
      mcpServers.add(child);
      await trace({ type: "mcp-start", name, command, args, cwd, pid: child.pid });
      const forwarded = (async () => {
        for (;;) {
          const next = await inputs.next();
          if (next.done) break;
          assert.equal(next.value.part.case, "stdin");
          child.stdin.write(next.value.part.value);
        }
        child.stdin.end();
        await trace({ type: "mcp-input-ended", name });
      })();
      forwarded.catch(() => child.kill("SIGKILL"));
      try {
        for await (const chunk of child.stdout) yield { stdout: new Uint8Array(chunk) };
      } finally {
        child.kill("SIGKILL");
        mcpServers.delete(child);
        await forwarded.catch(() => undefined);
        await trace({ type: "mcp-stop", name });
      }
    },
    async stop({ owner, sandboxId }, context) {
      assert.ok(owner);
      await stopMcpServers();
      directory ??= join(root, "remote-allocations", owner.allocationId);
      allocation ??= JSON.parse(await readFile(join(directory, "allocation.json"), "utf8"));
      assert.deepEqual(serializable(owner), allocation.owner);
      if (sandboxId !== undefined) assert.equal(sandboxId, allocation.sandboxId);
      if (await enabled("fail-stop-revealing-credentials")) {
        // A provider error that quotes the Worker Host's provider credential and a URL password.
        await trace({ type: "stop-failed", ...allocation });
        throw new Error(
          `Stop refused for ${process.env.E2B_API_KEY} at https://fixture:url-password-4242@sandbox.invalid/v1`,
        );
      }
      if (await enabled("refuse-stop")) {
        await trace({ type: "stop-uncertain", ...allocation });
        return {};
      }
      if (await enabled("hold-stop")) {
        await trace({ type: "stop-wait", ...allocation });
        while (await enabled("hold-stop")) {
          context.signal.throwIfAborted();
          await delay(20);
        }
      }
      allocation.stopped = true;
      await persist(allocation);
      await trace({ type: "stop", ...allocation });
      return { stoppedSandboxId: allocation.sandboxId };
    },
  },
  workspace: {
    async execute({ operation }) {
      assert.ok(staged && !allocation.stopped);
      const requested = operation.value?.path ?? "";
      // Like the provider's file tools, a read-only copy may only be read.
      const copy = [...copies].find(([path]) => requested.startsWith(`${path}/`));
      if (
        !["workspace.txt", "marker.txt", "mcp-server.js", ".mcp.json"].includes(requested) &&
        !inputPaths.includes(requested) &&
        !copy &&
        !/^(?:outputs\/[0-9a-f]{64}|deliverables|reports)\/(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+$/u.test(
          requested,
        )
      )
        return { text: "Fixture path denied", isError: true };
      assert.ok(requested.split("/").every((component) => component !== "." && component !== ".."));
      const path = join(directory, "checkout", requested);
      if (operation.case === "read" && actions.includes("files:read")) {
        await trace({ type: "read", allocationId: allocation.owner.allocationId });
        return { text: await readFile(path, "utf8") };
      }
      if (
        operation.case === "write" &&
        actions.includes("files:write") &&
        !inputPaths.includes(requested) &&
        (!copy || copy[1].readWrite)
      ) {
        await mkdir(dirname(path), { recursive: true, mode: 0o700 });
        await writeFile(path, operation.value.content);
        await trace({ type: "write", allocationId: allocation.owner.allocationId });
        return { text: "written" };
      }
      return { text: "Fixture operation denied", isError: true };
    },
  },
};
for (const [service, names] of [
  [implementation.provider, ["allocate", "stage", "stageCopy", "stop", "snapshot", "removeArtifact"]],
  [implementation.workspace, ["execute"]],
]) {
  for (const name of names) {
    const original = service[name];
    service[name] = async (...args) => {
      try {
        return await original(...args);
      } catch (error) {
        await trace({
          type: "fixture-error",
          operation: name,
          message: redact(error.message).slice(0, 1200),
        });
        throw error;
      }
    };
  }
}
await runRemoteWorkspaceTransport(implementation);
