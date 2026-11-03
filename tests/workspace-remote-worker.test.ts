import { appendFile, chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type TagMcpGrant, taskWorkspaceBranch } from "../packages/core/src/index.js";
import { E2BWorkspaceEnvironment } from "../packages/runtime/environments/e2b/src/index.ts";
import { CodexHarness } from "../packages/runtime/harnesses/codex/src/index.ts";
import {
  createWorker,
  type EnvironmentPlan,
  type Harness,
  HttpMcpToolProvider,
  networkPolicyWithin,
  type SandboxInstance,
  sandboxExecutionEnvironment,
  startMcpPolicyProxy,
  type TaskAttemptSpec,
  type ToolInput,
  ToolProviderRegistry,
  WorkspaceEnvironmentResolver,
  type WorkspaceInput,
  WorkspaceResolverRegistry,
  workspaceSandboxNetworkNeed,
} from "../packages/runtime/sdk/src/index.ts";
import {
  FAKE_TRANSFER,
  FAKE_WORKSPACE,
  FakeSandboxWorld,
} from "./support/fake-workspace-sandboxes.ts";
import { createRepository, git, isolateGitConfiguration } from "./support/git-repository.js";

const SOURCE = "https://example.com/app.git";
const empty = (): EnvironmentPlan => ({
  files: [],
  mounts: [],
  environmentVariables: {},
  secretBindings: [],
  network: { mode: "none" },
});

/** A stdio MCP server that reports its working directory's marker and any credential it sees. */
const SERVER = `const fs = require("node:fs");
const readline = require("node:readline");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  let result;
  if (message.method === "initialize")
    result = { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "t", version: "1" } };
  else if (message.method === "tools/list")
    result = { tools: ["read_marker", "write_note", "hidden"].map((name) => ({ name, inputSchema: { type: "object" } })) };
  else {
    const leaked = Object.keys(process.env).filter((key) => /TOKEN|SECRET|CANARY|SUPERTAG_MCP/.test(key));
    result = { content: [{ type: "text", text: [fs.readFileSync("marker.txt", "utf8").trim(), process.cwd(), "leaked=" + leaked.join(",")].join("|") }] };
  }
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\\n");
});
`;

/**
 * The harness's MCP client inside the sandbox. It first tries the Worker Host's loopback proxy,
 * then lists and calls tools through the URL the harness received, and tries it without the
 * per-Attempt secret. It prints one JSON report.
 */
const SANDBOX_CLIENT = `const http = require("node:http");
const post = (target, message, auth) => new Promise((resolve, reject) => {
  const url = new URL(target);
  const request = http.request({
    host: url.hostname, port: url.port, path: url.pathname, method: "POST",
    headers: {
      authorization: auth, "content-type": "application/json",
      accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18",
    },
  }, (response) => {
    let text = "";
    response.setEncoding("utf8");
    response.on("data", (chunk) => { text += chunk; });
    response.on("end", () => resolve({ status: response.statusCode, text }));
  });
  request.on("error", reject);
  request.end(JSON.stringify({ jsonrpc: "2.0", ...message }));
});
const result = (text) => {
  const data = text.split("\\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("");
  return JSON.parse(data || text).result;
};
const auth = process.env.MCP_AUTH;
(async () => {
  const report = {};
  report.host = await post(process.env.MCP_HOST_URL, { id: 0, method: "tools/list", params: {} }, auth)
    .then(() => "reached", (error) => error.code || "failed");
  report.unauthorized = (await post(process.env.MCP_URL, { id: 0, method: "tools/list", params: {} }, "Bearer wrong")).status;
  const call = async (name) =>
    result((await post(process.env.MCP_URL, { id: 2, method: "tools/call", params: { name, arguments: {} } }, auth)).text);
  report.tools = result((await post(process.env.MCP_URL, { id: 1, method: "tools/list", params: {} }, auth)).text)
    .tools.map((tool) => tool.name).join(",");
  report.read = (await call("read_marker")).content[0].text;
  report.write = (await call("write_note")).isError === true ? "refused" : "ran";
  report.hidden = (await call("hidden")).isError === true ? "refused" : "ran";
  process.stdout.write(JSON.stringify(report));
})().catch((error) => { process.stdout.write(JSON.stringify({ error: String(error) })); process.exitCode = 1; });
`;

/**
 * A Worker runs a Workspace Task on a remote provider: the resolver starts the sandbox before tool
 * resolution, the Workspace's stdio server is listed and called inside it, and the Task's commits
 * come back to the host-managed clone. The provider's own `provision` is never used.
 */
describe("a Worker running a remote Workspace Task", () => {
  const cleanups: (() => Promise<unknown> | unknown)[] = [];
  let origin: string;
  let root: string;
  let world: FakeSandboxWorld;

  beforeEach(async () => {
    cleanups.push(await isolateGitConfiguration());
    const upstream = await createRepository();
    await writeFile(
      join(upstream, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          tools: { command: "node", args: ["mcp-server.js"] },
          db: {
            command: "node",
            args: ["mcp-server.js"],
            // biome-ignore lint/suspicious/noTemplateCurlyInString: This is the literal repository reference.
            env: { DB_TOKEN: "${SUPERTAG_MCP_DB_TOKEN}" },
          },
        },
      }),
    );
    await writeFile(join(upstream, "mcp-server.js"), SERVER);
    await writeFile(join(upstream, "marker.txt"), "trusted\n");
    git(upstream, "add", "-A");
    git(upstream, "commit", "--quiet", "-m", "Add a repository MCP server");
    origin = join(await mkdtemp(join(tmpdir(), "supertag-remote-origin-")), "app.git");
    git(upstream, "clone", "--quiet", "--bare", upstream, origin);
    await appendFile(
      process.env["GIT_CONFIG_GLOBAL"] as string,
      `[url "${pathToFileURL(origin).href}"]\n\tinsteadOf = ${SOURCE}\n`,
    );
    root = await mkdtemp(join(tmpdir(), "supertag-remote-root-"));
    world = await FakeSandboxWorld.create({ isolatedLoopback: true });
    const saved = { ...process.env };
    process.env["SUPERTAG_MCP_CANARY"] = "host-canary";
    process.env["GITHUB_TOKEN"] = "host-canary";
    for (const path of [upstream, join(origin, ".."), root])
      cleanups.push(() => rm(path, { recursive: true, force: true }));
    cleanups.push(
      () => world.cleanup(),
      () => {
        process.env = saved;
      },
    );
  });
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });

  const worker = (calls: string[], harness: (calls: string[]) => Harness) => {
    const fake = harness(calls);
    const environment = new E2BWorkspaceEnvironment({
      stagingDirectory: join(root, "returned"),
      workspaceDirectory: FAKE_WORKSPACE,
      transferDirectory: FAKE_TRANSFER,
      ...world.e2b(),
    });
    const workspaces = new WorkspaceResolverRegistry([
      new WorkspaceEnvironmentResolver({
        checkouts: [],
        cloneSources: true,
        worktreeRoot: join(root, "workspaces"),
        environments: { e2b: environment },
        mcpVariables: { SUPERTAG_MCP_DB_TOKEN: "db-canary-token" },
      }),
    ]);
    return createWorker({
      id: "remote-test",
      profiles: [
        {
          ref: { id: "remote", revision: "1" },
          workerType: "test",
          harness: { provider: fake.id },
          execution: { provider: "e2b", lifetime: { scope: "attempt" } },
        },
      ],
      harnesses: [fake],
      environments: [
        {
          id: "e2b",
          capabilities: [],
          workspaceEnvironment: environment,
          async provision() {
            calls.push("provision");
            throw new Error("The Worker must use the Workspace sandbox");
          },
        },
      ],
      workspaceResolvers: workspaces,
      toolProviders: new ToolProviderRegistry([
        new HttpMcpToolProvider({
          servers: {},
          workspaceServers: (id) => workspaces.mcpServersForAttempt(id),
        }),
      ]),
    });
  };

  /**
   * A harness whose MCP client runs on the sandbox side, as Claude's and Codex's do on a remote
   * runtime: its plan allows each MCP server's host, like theirs, plus `extraHost` once tools are
   * resolved; its client is a process in the sandbox that can reach only the sandbox's loopback.
   * The prepared image must provide the harness's command, so it is named after one.
   */
  const sandboxHarness =
    (extraHost?: string) =>
    (calls: string[]): Harness => ({
      id: "sh",
      async describe() {
        return {
          sessions: { resume: false, export: false, scope: "none" as const },
          id: "sh",
          version: "1",
          inputKinds: ["instruction", "tool", "workspace"],
          streaming: true,
          cancellation: true,
          sessionPersistence: "none",
          toolIsolation: { managerOnly: true, schemaIsolation: "hard" },
          mcpClients: [{ client: "harness-runtime", transports: ["mcp-http"] }],
        };
      },
      async plan(context) {
        const workspace: WorkspaceInput | undefined = context.workspace;
        calls.push(`plan:${workspace?.placement}`);
        const mcpHosts = context.tools.flatMap((tool) =>
          tool.binding.kind === "mcp-http" ? [new URL(tool.binding.url).hostname] : [],
        );
        return {
          runtime: {
            ...empty(),
            network: {
              mode: "allowlist",
              allowedHosts: [
                "api.example.test",
                ...mcpHosts,
                ...(extraHost !== undefined && mcpHosts.length ? [extraHost] : []),
              ],
            },
          },
          execution: empty(),
        };
      },
      async start(_plan, environments, context) {
        const input = context.tools.find((tool) => tool.binding.kind === "mcp-http") as
          | ToolInput
          | undefined;
        if (input === undefined) throw new Error("Missing Workspace tool");
        calls.push(`runtime:${environments.runtime === environments.execution}`);
        const proxy = await startMcpPolicyProxy(input, { harnessRuntime: environments.runtime });
        // The Worker Host's own loopback proxy, which a sandbox-side client cannot reach.
        const hostProxy = await startMcpPolicyProxy(input);
        return {
          async *run() {
            calls.push(`root:${environments.execution.rootDirectory}`);
            calls.push(`url:${new URL(proxy.url).hostname}`);
            const client = await environments.runtime.spawn({
              command: "node",
              args: ["-e", SANDBOX_CLIENT],
              environment: {
                MCP_URL: proxy.url,
                MCP_HOST_URL: hostProxy.url,
                MCP_AUTH: proxy.headers["Authorization"] ?? "",
              },
            });
            const result = await client.wait();
            const report = JSON.parse(result.stdout) as Record<string, string>;
            for (const [key, value] of Object.entries(report)) calls.push(`${key}:${value}`);
            // The checkout sits at the Workspace input's mountPath, beside what the Harness stages.
            calls.push(`mount:${context.workspace?.mountPath}`);
            const process = await environments.execution.spawn({
              command: "sh",
              args: ["-c", "echo remote > work.txt"],
              cwd: context.workspace?.mountPath ?? ".",
            });
            await process.wait();
            yield { type: "output.message", text: "Done." };
          },
          async close() {
            await hostProxy.close();
            await proxy.close().then(
              () => {
                calls.push("closed");
                world.calls.push({ kind: "harness.closed", detail: null });
              },
              (error: unknown) => calls.push(`close-failed:${String(error)}`),
            );
          },
        };
      },
    });

  it("starts the sandbox before tool resolution, enforces grants and approvals, and delivers", async () => {
    const calls: string[] = [];
    const events: string[] = [];
    for await (const event of worker(calls, sandboxHarness()).execute(
      attemptSpec(
        ["tools"],
        [{ action: "tools/read_marker" }, { action: "tools/write_note" }],
        [{ target: "mcp", action: "tools/write_note", permissionSets: ["ops"], approvers: [] }],
      ),
    )) {
      events.push(event.type);
      if (event.type === "execution.failed") throw new Error(event.error.message);
    }
    expect(events).toContain("execution.completed");
    expect(calls).not.toContain("provision");
    // Preliminary and final plans both see a Workspace with nothing to stage.
    expect(calls.filter((call) => call.startsWith("plan:"))).toEqual([
      "plan:execution-root",
      "plan:execution-root",
    ]);
    // The Harness's root is the checkout's parent; the checkout is its Workspace mountPath.
    expect(calls).toContain(`root:${posix.dirname(FAKE_WORKSPACE)}`);
    expect(calls).toContain(`mount:${posix.basename(FAKE_WORKSPACE)}`);
    // The harness runs in the sandbox and passed the network check although its final plan
    // allows the policy proxy's loopback host, which its preliminary plan could not know.
    expect(calls).toContain("runtime:true");
    expect(calls).toContain("url:127.0.0.1");
    // The Worker Host's loopback proxy is out of the sandbox's reach; the relay is not.
    expect(calls).toContain("host:ECONNREFUSED");
    expect(calls).toContain("unauthorized:401");
    expect(calls).toContain("tools:read_marker,write_note");
    // The relay ran inside the sandbox, never on a Worker Host interface.
    expect(
      world.calls.some(
        (call) =>
          call.kind === "e2b.sandbox.run" &&
          JSON.stringify(call.detail).includes("listening: server.address().port"),
      ),
    ).toBe(true);
    // The server ran inside the sandbox, from the trusted copy beside the checkout, with no host
    // variable or host working directory.
    const read = calls.find((call) => call.startsWith("read:")) ?? "";
    // The fake sandbox maps its root to a host directory; the server ran beneath it, in the
    // trusted copy, never in a Worker Host checkout.
    expect(read).toMatch(/^read:trusted\|[^|]*\/workspace\/\.repo-supertag-mcp\|leaked=$/u);
    expect(read).not.toContain(root);
    expect(calls).toContain("write:refused");
    expect(calls).toContain("hidden:refused");
    expect(await world.received()).not.toContain("host-canary");
    expect(await world.received()).not.toContain("db-canary-token");
    // The sandbox's commit came back to the host-managed clone.
    const clone = join(root, "workspaces", "app", "clone");
    const branch = taskWorkspaceBranch("objective-1", "task-1");
    expect(git(clone, "show", `refs/heads/${branch}:work.txt`)).toBe("remote");
    // Every sandbox MCP bridge confirmed its process terminated, and closing never stopped the
    // sandbox: it ran the commit and transfer after the close and stopped once, afterward.
    expect(calls.filter((call) => call.startsWith("close"))).toEqual(["closed"]);
    const timeline = world.calls.map((call) => call.kind);
    const closed = timeline.indexOf("harness.closed");
    const killed = timeline.indexOf("e2b.sandbox.kill");
    expect(closed).toBeGreaterThan(-1);
    expect(timeline.filter((kind) => kind === "e2b.sandbox.kill")).toHaveLength(1);
    expect(killed).toBeGreaterThan(closed);
    expect(timeline.slice(closed, killed)).toContain("e2b.sandbox.run");
    expect(timeline.slice(killed + 1)).not.toContain("e2b.sandbox.run");
  }, 120_000);

  // Codex's harness-owned route allows the policy proxy's host. Claude Code never runs inside a
  // remote runtime: it uses split execution, and its Worker refuses this route.
  it.each([
    [
      "codex",
      (calls: string[]) =>
        new CodexHarness({
          workspace: root,
          runner: async function* (request) {
            calls.push(`servers:${request.mcpServers.map((server) => server.name).join(",")}`);
            yield { type: "output.message", text: "Done." };
          },
        }),
    ],
  ] as const)(
    "passes the network check for %s's MCP route",
    async (_name, harness) => {
      // The prepared image must provide the harness's command.
      const bin = join(root, "bin");
      await mkdir(bin, { recursive: true });
      await writeFile(join(bin, "codex"), "#!/bin/sh\n");
      await chmod(join(bin, "codex"), 0o755);
      process.env["PATH"] = `${bin}:${process.env["PATH"]}`;
      const calls: string[] = [];
      let failure: string | undefined;
      for await (const event of worker(calls, harness).execute(
        attemptSpec(["tools"], [{ action: "tools/read_marker" }], []),
      ))
        if (event.type === "execution.failed") failure = event.error.message;
      expect(failure).toBeUndefined();
      expect(calls).toContain("servers:tools");
    },
    120_000,
  );

  it("stages Codex's auth.json and session files beside the checkout, never committing or delivering them", async () => {
    const bin = join(root, "bin");
    await mkdir(bin, { recursive: true });
    await writeFile(join(bin, "codex"), "#!/bin/sh\n");
    await chmod(join(bin, "codex"), 0o755);
    process.env["PATH"] = `${bin}:${process.env["PATH"]}`;
    const authFile = join(root, "auth.json");
    await writeFile(authFile, JSON.stringify({ tokens: { access_token: "CODEX-CANARY" } }));
    const calls: string[] = [];
    let failure: string | undefined;
    const codex = (log: string[]) =>
      new CodexHarness({
        workspace: root,
        authFile,
        runner: async function* (request, runtime) {
          log.push(`workspace:${request.workspace}`);
          log.push(`staged:${(await runtime.read(".codex/auth.json")).includes("CODEX-CANARY")}`);
          // What Codex itself writes: session state under CODEX_HOME, an output at its root, and
          // the Task's change in its working directory.
          const work = await runtime.spawn({
            command: "sh",
            args: [
              "-c",
              'mkdir -p "$1/sessions" && echo transcript > "$1/sessions/rollout.jsonl" && mkdir -p outputs && echo report > outputs/report.txt && echo codex > "$2/codex.txt"',
              "sh",
              runtime.resolvePath(".codex"),
              request.workspace,
            ],
          });
          log.push(`exit:${(await work.wait()).exitCode}`);
          yield { type: "output.message", text: "Done." };
        },
      });
    for await (const event of worker(calls, codex).execute(
      attemptSpec(["tools"], [{ action: "tools/read_marker" }], []),
    ))
      if (event.type === "execution.failed") failure = event.error.message;
    expect(failure).toBeUndefined();
    expect(calls).toContain(`workspace:${FAKE_WORKSPACE}`);
    expect(calls).toContain("staged:true");
    expect(calls).toContain("exit:0");
    const clone = join(root, "workspaces", "app", "clone");
    const branch = taskWorkspaceBranch("objective-1", "task-1");
    expect(git(clone, "show", `refs/heads/${branch}:codex.txt`)).toBe("codex");
    const delivered = git(clone, "ls-tree", "-r", "--name-only", `refs/heads/${branch}`);
    expect(delivered).not.toContain(".codex");
    expect(delivered).not.toContain("auth.json");
    expect(delivered).not.toContain("outputs");
    expect(git(clone, "log", "-p", `refs/heads/${branch}`)).not.toContain("CODEX-CANARY");
  }, 120_000);

  it("refuses a final plan that adds any other host to the sandbox's network", async () => {
    const calls: string[] = [];
    let failure: string | undefined;
    for await (const event of worker(calls, sandboxHarness("extra.example.test")).execute(
      attemptSpec(["tools"], [{ action: "tools/read_marker" }], []),
    ))
      if (event.type === "execution.failed") failure = event.error.message;
    expect(failure).toMatch(/network access beyond the policy its Workspace sandbox started with/u);
    expect(calls.some((call) => call.startsWith("runtime:"))).toBe(false);
  }, 120_000);

  it("refuses a stdio server whose env references a host credential, naming it", async () => {
    const calls: string[] = [];
    let failure: string | undefined;
    for await (const event of worker(calls, sandboxHarness()).execute(
      attemptSpec(["db"], [{ action: "db/read_marker" }], []),
    ))
      if (event.type === "execution.failed") failure = event.error.message;
    expect(failure).toMatch(/Workspace MCP server db references host credential/u);
    expect(calls).not.toContain("provision");
    expect(calls.some((call) => call.startsWith("plan:"))).toBe(false);
  }, 60_000);
});

it("stops only the killed process in a caller-owned sandbox, never the sandbox", async () => {
  const world = await FakeSandboxWorld.create();
  try {
    const client = await world.e2b().sandboxFactory.create({ template: undefined } as never);
    let terminated = 0;
    const sandbox: SandboxInstance = {
      id: client.sandboxId,
      async mkdir(path) {
        await client.files.makeDir(path);
      },
      write: async () => {},
      read: async () => new Uint8Array(),
      makeReadOnly: async () => {},
      async start(spec) {
        const handle = await client.commands.run([spec.command, ...(spec.args ?? [])].join(" "), {
          background: true,
          ...(spec.cwd ? { cwd: spec.cwd } : {}),
        } as never);
        return {
          terminate: () => handle.kill(),
          wait: async () => handle.wait(),
        };
      },
      async terminate() {
        terminated += 1;
        return client.kill();
      },
    };
    const environment = sandboxExecutionEnvironment(sandbox, FAKE_WORKSPACE, {
      id: "e2b",
      backend: {
        capabilities: {
          networkModes: ["none"],
          readOnlyMounts: false,
          boundedSymlinkSafeReads: true,
          streamOutput: false,
        },
        create: async () => sandbox,
      },
    });
    await sandbox.mkdir(FAKE_WORKSPACE);
    // A backend that cannot create directories offers no preparation, so Attempts run without scratch.
    expect(environment.prepareOutputDirectory).toBeUndefined();
    const sleeping = await environment.spawn({ command: "sleep", args: ["30"] });
    sleeping.kill();
    // Termination is confirmed by the process's own exit, not reported as a cleanup failure.
    expect((await sleeping.wait()).exitCode).toBe(137);
    const kinds = world.calls.map((call) => call.kind);
    expect(kinds).toContain("e2b.process.kill");
    expect(kinds).not.toContain("e2b.sandbox.kill");
    expect(terminated).toBe(0);
    // The sandbox still runs work after the kill, then stops only when disposed.
    expect((await (await environment.spawn({ command: "true" })).wait()).exitCode).toBe(0);
    await environment.dispose();
    expect(terminated).toBe(1);
  } finally {
    await world.cleanup();
  }
}, 30_000);

it("allows a final plan no more network than the sandbox started with", () => {
  const none = { mode: "none" } as const;
  const open = { mode: "unrestricted" } as const;
  const api = { mode: "allowlist", allowedHosts: ["api.example.test"] } as const;
  const both = { mode: "allowlist", allowedHosts: ["api.example.test", "x.test"] } as const;
  expect(networkPolicyWithin(none, none)).toBe(true);
  expect(networkPolicyWithin(api, both)).toBe(true);
  expect(networkPolicyWithin(both, api)).toBe(false);
  expect(networkPolicyWithin(api, none)).toBe(false);
  expect(networkPolicyWithin(open, both)).toBe(false);
  expect(networkPolicyWithin(both, open)).toBe(true);
});

it("keeps the policy proxy host in the network need without a Workspace sandbox server", () => {
  const loopback = { mode: "allowlist", allowedHosts: ["api.example.test", "127.0.0.1"] } as const;
  // Only a Workspace stdio server's route exempts the proxy's loopback host; the integration
  // test above covers that case through the Worker.
  expect(workspaceSandboxNetworkNeed(loopback, [])).toEqual(loopback);
  expect(workspaceSandboxNetworkNeed({ mode: "none" }, [])).toEqual({ mode: "none" });
});

function attemptSpec(
  mcp: readonly string[],
  grants: readonly TagMcpGrant[],
  approvals: readonly unknown[],
): TaskAttemptSpec {
  const capturedAt = "2026-10-03T00:00:00.000Z";
  return {
    version: 2,
    taskId: "task-1",
    attemptId: "attempt-1",
    tag: { id: "tag-1", name: "Engineering" },
    input: {
      origin: {
        surface: "cli",
        accountId: "account-1",
        scope: "objective:objective-1",
        sessionKey: "objective-1",
        occurredAt: capturedAt,
      },
      messages: [{ id: "message-1", role: "requester", text: "Use the repository tool" }],
    },
    execution: {},
    workerProfile: { id: "remote", revision: "1" },
    contextPlan: { version: 7, capturedAt, sets: [] },
    workspacePlan: {
      version: 1,
      status: "workspace",
      workspace: "app",
      source: SOURCE,
      branch: taskWorkspaceBranch("objective-1", "task-1"),
      delivery: "branch",
      mcp,
    },
    authorization: {
      version: 5,
      capturedAt,
      tag: { id: "tag-1", name: "Engineering" },
      origin: {
        tagRouteId: "surface-1",
        surfaceAccountId: "account-1",
        provider: "slack",
        scope: "channel:C1",
      },
      requester: { id: "U1", kind: "user" },
      permissionSets: [],
      resources: [],
      runtimeActions: ["files:write"],
      mcp: grants,
      approvals,
    },
  } as unknown as TaskAttemptSpec;
}
