import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { E2BWorkspaceEnvironment } from "../packages/runtime/environments/e2b/src/index.ts";
import { ModalWorkspaceEnvironment } from "../packages/runtime/environments/modal/src/index.ts";
import {
  bundleTaskObjects,
  bundleTrustedCommit,
  connectExecutionEnvironmentMcpClient,
  type DevcontainerSubset,
  type EnvironmentPlan,
  HttpMcpToolProvider,
  type ResolutionContext,
  resolveWorkspaceMcpServers,
  type SandboxWorkspaceEnvironment,
  sandboxWorkspaceMcpServers,
  startMcpPolicyProxy,
  type ToolInput,
  ToolProviderRegistry,
  withApprovalRequirements,
  workspaceDefinition,
} from "../packages/runtime/sdk/src/index.ts";
import { prepareScript } from "../packages/runtime/sdk/src/sandbox-workspace-environment.ts";
import {
  FAKE_SANDBOX_ROOT,
  FAKE_TRANSFER,
  FAKE_WORKSPACE,
  FakeSandboxWorld,
} from "./support/fake-workspace-sandboxes.ts";

const exec = promisify(execFile);
const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "SuperTag",
  GIT_AUTHOR_EMAIL: "supertag@localhost",
  GIT_COMMITTER_NAME: "SuperTag",
  GIT_COMMITTER_EMAIL: "supertag@localhost",
};
async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await exec(
    "git",
    ["-C", cwd, "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args],
    { env: GIT_ENV, encoding: "utf8" },
  );
  return stdout.trim();
}

const PLAN: EnvironmentPlan = {
  files: [],
  mounts: [],
  environmentVariables: {},
  secretBindings: [],
  network: { mode: "none" },
};
const SOURCE = "https://example.com/app.git";

/**
 * A dependency-free stdio MCP server. `read_marker` reports `marker.txt` in its working
 * directory, how many times `write_note` ran, and any credential-like variable it can see.
 */
function server(tools: readonly string[]): string {
  return `const fs = require("node:fs");
const readline = require("node:readline");
let writes = 0;
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  let result;
  if (message.method === "initialize")
    result = { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "t", version: "1" } };
  else if (message.method === "tools/list")
    result = { tools: ${JSON.stringify(tools)}.map((name) => ({ name, inputSchema: { type: "object" } })) };
  else {
    if (message.params.name === "write_note") writes += 1;
    const leaked = Object.keys(process.env).filter((key) => /TOKEN|SECRET|CANARY|PASSWORD/.test(key));
    result = { content: [{ type: "text", text: [fs.readFileSync("marker.txt", "utf8").trim(), "writes=" + writes, "leaked=" + leaked.join(",")].join("|") }] };
  }
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\\n");
});
`;
}

const MCP_JSON = {
  mcpServers: {
    tools: { command: "node", args: ["mcp-server.js"] },
    docs: {
      type: "http",
      url: "https://docs.example.test/mcp",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: This is the literal repository reference.
      headers: { Authorization: "Bearer ${SUPERTAG_MCP_DOCS_TOKEN}" },
    },
    // biome-ignore lint/suspicious/noTemplateCurlyInString: This is the literal repository reference.
    db: { command: "node", args: ["db.js"], env: { DB_TOKEN: "${SUPERTAG_MCP_DB_TOKEN}" } },
  },
};

/** `main` holds the trusted server; `task` rewrites it, its marker, and `.mcp.json`. */
async function repository(path: string) {
  await mkdir(path, { recursive: true });
  await git(path, "init", "-q", "-b", "main");
  await writeFile(join(path, ".mcp.json"), JSON.stringify(MCP_JSON));
  await writeFile(join(path, "mcp-server.js"), server(["read_marker", "write_note", "hidden"]));
  await writeFile(join(path, "marker.txt"), "trusted\n");
  await git(path, "add", "-A");
  await git(path, "commit", "-qm", "Trusted");
  const trusted = await git(path, "rev-parse", "HEAD");
  await git(path, "checkout", "-q", "-b", "task");
  await writeFile(join(path, "mcp-server.js"), server(["read_marker", "write_note", "exfiltrate"]));
  await writeFile(join(path, "marker.txt"), "task\n");
  await writeFile(
    join(path, ".mcp.json"),
    JSON.stringify({ mcpServers: { tools: { command: "sh", args: ["-c", "exit 7"] } } }),
  );
  await git(path, "add", "-A");
  await git(path, "commit", "-qm", "Task");
  const task = await git(path, "rev-parse", "HEAD");
  await git(path, "checkout", "-q", "main");
  return { path, trusted, task };
}

type Provider = "e2b" | "modal";

describe.each<Provider>(["e2b", "modal"])("Workspace stdio MCP servers on %s", (provider) => {
  const cleanups: (() => Promise<unknown>)[] = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup().catch(() => undefined);
  });

  async function setup() {
    const world = await FakeSandboxWorld.create();
    const scratch = await mkdtemp(join(tmpdir(), "supertag-sandbox-mcp-"));
    cleanups.push(
      () => world.cleanup(),
      () => rm(scratch, { recursive: true, force: true }),
    );
    const paths = { workspaceDirectory: FAKE_WORKSPACE, transferDirectory: FAKE_TRANSFER };
    const stagingDirectory = join(scratch, "returned");
    const environment: SandboxWorkspaceEnvironment =
      provider === "e2b"
        ? new E2BWorkspaceEnvironment({ stagingDirectory, ...paths, ...world.e2b() })
        : new ModalWorkspaceEnvironment({
            appName: "supertag-test",
            stagingDirectory,
            ...paths,
            ...world.modal(),
          });
    const repo = await repository(join(scratch, "source"));
    const content = await bundleTrustedCommit({
      repository: repo.path,
      trustedCommit: repo.trusted,
      directory: join(scratch, "bundles"),
    });
    const define = async (names: readonly string[], devcontainer?: DevcontainerSubset) => {
      // The Worker reads `.mcp.json` from the trusted commit, here the host checkout at main.
      const mcp = await resolveWorkspaceMcpServers(repo.path, names, {
        SUPERTAG_MCP_DOCS_TOKEN: "docs-canary-token",
        SUPERTAG_MCP_DB_TOKEN: "db-canary-token",
      });
      const definition = workspaceDefinition({
        workspace: "app",
        source: SOURCE,
        trustedCommit: repo.trusted,
        content,
        mcp,
        harness: { commands: ["sh"], install: "true harness-install" },
        ...(devcontainer === undefined ? {} : { devcontainer }),
      });
      // E2B reads a devcontainer build context from the trusted repository.
      return {
        mcp,
        definition: devcontainer?.build
          ? { ...definition, trustedRepository: repo.path }
          : definition,
      };
    };
    return { world, scratch, environment, repo, define };
  }

  it("runs a stdio server inside the sandbox from the trusted copy, behind the Worker's grants and approvals", async () => {
    const { world, scratch, environment, repo, define } = await setup();
    const saved = { ...process.env };
    process.env["SUPERTAG_MCP_CANARY"] = "host-canary";
    process.env["GITHUB_TOKEN"] = "host-canary";
    cleanups.push(async () => {
      process.env = saved;
    });
    const { mcp, definition } = await define(["tools", "docs"]);
    expect(environment.refuse(definition)).toBeUndefined();
    expect(definition.mcp?.servers).toEqual([
      { name: "docs", transport: "http" },
      { name: "tools", transport: "stdio", command: "node", args: ["mcp-server.js"], env: {} },
    ]);
    const prepared = await environment.prepare(definition);
    // The provider received the declared definitions, never a resolved credential.
    expect(await world.received()).not.toContain("docs-canary-token");
    const task = await environment.start(prepared, {
      taskId: "t1",
      attemptId: "a1",
      branch: "supertag/test/t1",
      base: repo.trusted,
      head: repo.task,
      objects: await bundleTaskObjects({
        repository: repo.path,
        trustedCommit: repo.trusted,
        head: repo.task,
        directory: join(scratch, "bundles"),
      }),
      plan: PLAN,
    });
    cleanups.push(() => task.dispose("completed"));
    // The Task's checkout holds its own edits; the server copy beside it does not.
    expect(await task.read("marker.txt")).toBe("task\n");
    // The Harness's view, as the Worker gives it, with variables its plan set: a stdio server
    // starts with none of them.
    const harness = environment.harnessEnvironment(task);
    await harness.prepare({
      ...PLAN,
      environmentVariables: { SUPERTAG_OUTPUT_DIR: "outputs/a1", PLAN_CANARY: "plan-canary" },
    });
    const planned = await harness.spawn({ command: "sh", args: ["-c", 'echo "$PLAN_CANARY"'] });
    expect((await planned.wait()).stdout.trim()).toBe("plan-canary");

    const servers = sandboxWorkspaceMcpServers(mcp.servers, {
      provider: environment.provider,
      sandbox: harness,
      directory: environment.mcpDirectory,
    });
    // HTTP servers keep the Worker-side policy proxy and its host-held headers.
    expect(servers.find((item) => item.name === "docs")).toEqual({
      name: "docs",
      url: "https://docs.example.test/mcp",
      headers: { Authorization: "Bearer docs-canary-token" },
    });
    const [input] = (await new ToolProviderRegistry([
      new HttpMcpToolProvider({ servers: {}, workspaceServers: () => servers }),
    ]).resolve({
      task: {
        attemptId: "a1",
        authorization: {
          mcp: [{ action: "tools/read_marker" }, { action: "tools/write_note" }],
        },
      },
    } as unknown as ResolutionContext)) as ToolInput[];
    if (input === undefined) throw new Error("Missing tool input");
    // The harness sees neither the command nor where it runs.
    expect(input.binding).toEqual({
      kind: "mcp-http",
      name: "tools",
      url: "http://127.0.0.1:9/supertag-stdio/tools",
    });
    expect(JSON.stringify(input)).not.toContain("mcp-server.js");
    expect(input.capability.operations.map((operation) => operation.name)).toEqual([
      "read_marker",
      "write_note",
    ]);
    const [guarded] = withApprovalRequirements(
      [input],
      [{ target: "mcp", action: "tools/write_note", permissionSets: ["ops"], approvers: [] }],
      () => undefined,
    ) as ToolInput[];
    if (guarded === undefined) throw new Error("Missing guarded input");

    const proxy = await startMcpPolicyProxy(guarded);
    cleanups.push(() => proxy.close());
    const client = new Client({ name: "harness", version: "1" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(proxy.url), {
        requestInit: { headers: proxy.headers },
      }),
    );
    cleanups.push(() => client.close());
    const listed = await client.listTools();
    expect(listed.tools.map((tool) => tool.name)).toEqual(["read_marker", "write_note"]);
    const text = async (name: string) =>
      (
        (await client.callTool({ name, arguments: {} })) as {
          isError?: boolean;
          content: { text: string }[];
        }
      ).content[0]?.text;
    expect(await text("read_marker")).toBe("trusted|writes=0|leaked=");
    const approval = (await client.callTool({ name: "write_note", arguments: {} })) as {
      isError?: boolean;
    };
    expect(approval.isError).toBe(true);
    const hidden = (await client.callTool({ name: "hidden", arguments: {} })) as {
      isError?: boolean;
    };
    expect(hidden.isError).toBe(true);
    // Neither refused call reached the server.
    expect(await text("read_marker")).toBe("trusted|writes=0|leaked=");

    // The execution-environment client reaches the same server, with the same checks.
    const direct = await connectExecutionEnvironmentMcpClient(harness, guarded, {
      timeoutMs: 30_000,
    });
    cleanups.push(() => direct.close());
    expect(direct.tools.map((tool) => tool.name)).toEqual(["read_marker", "write_note"]);
    expect(((await direct.callTool("write_note", {})) as { isError?: boolean }).isError).toBe(true);
    await expect(direct.callTool("hidden", {})).rejects.toThrow(/not admitted/u);
    const other = await environment.start(prepared, {
      taskId: "t2",
      attemptId: "a2",
      branch: "supertag/test/t2",
      base: repo.trusted,
      head: repo.trusted,
      plan: PLAN,
    });
    cleanups.push(() => other.dispose("completed"));
    await expect(
      connectExecutionEnvironmentMcpClient(environment.harnessEnvironment(other), guarded),
    ).rejects.toThrow(/Workspace sandbox/u);
  }, 120_000);

  it("refuses a stdio server whose env references a host credential, naming it, before any provider call", async () => {
    const { world, environment, define } = await setup();
    const { mcp, definition } = await define(["tools", "db"]);
    const reason = environment.refuse(definition);
    expect(reason).toContain("Workspace MCP server db");
    expect(reason).toContain("SUPERTAG_MCP_DB_TOKEN");
    expect(reason).not.toContain("db-canary-token");
    await expect(environment.prepare(definition)).rejects.toThrow(/Workspace MCP server db/u);
    expect(world.calls).toEqual([]);
    // The same rule holds where the Worker builds the Task's servers.
    expect(() =>
      sandboxWorkspaceMcpServers(mcp.servers, {
        provider: environment.provider,
        sandbox: {} as never,
        directory: environment.mcpDirectory,
      }),
    ).toThrow(/Workspace MCP server db/u);
  });

  it("places the trusted copy only when a stdio server is selected, outside the checkout", async () => {
    const { world, environment, define } = await setup();
    expect(environment.mcpDirectory).toBe(`${FAKE_SANDBOX_ROOT}/.repo-supertag-mcp`);
    await environment.prepare((await define(["docs"])).definition);
    expect(JSON.stringify(world.calls)).not.toContain("worktree add");
    await environment.prepare((await define(["tools"])).definition);
    expect(JSON.stringify(world.calls)).toContain("worktree add");
  }, 60_000);

  it("installs Node.js for the bridge before the content only when a stdio server is selected", async () => {
    const { world, environment, define } = await setup();
    const builds = () =>
      world.calls
        .filter((call) => call.kind === "modal.image.build" || call.kind === "e2b.template.build")
        .map((call) => JSON.stringify(call.detail));
    await environment.prepare((await define(["docs"])).definition);
    expect(builds()).toHaveLength(1);
    expect(builds()[0]).not.toContain("nodejs");
    await environment.prepare((await define(["tools"])).definition);
    expect(builds()).toHaveLength(2);
    const build = builds()[1] as string;
    expect(build).toContain("apt-get install -y --no-install-recommends nodejs");
    if (provider === "modal") {
      const { commands } = JSON.parse(build) as { commands: string[] };
      expect(commands.findIndex((command) => command.includes("nodejs"))).toBeGreaterThan(
        commands.findIndex((command) => command.includes(" git ")),
      );
    } else
      expect(JSON.parse(build)).toMatchObject({
        mcpRuntimeInstall: expect.any(String),
        mcpDirectory: environment.mcpDirectory,
      });
  }, 60_000);

  it.runIf(provider === "modal")(
    "installs git and Node.js as root after a devcontainer USER, then restores that user and gives it the MCP copy",
    async () => {
      const { world, environment, define } = await setup();
      const dockerfile = "FROM python:3.13-slim\nUSER nobody\n";
      const { definition } = await define(["tools"], {
        build: {
          dockerfile: "Dockerfile",
          dockerfileContent: dockerfile,
          dockerfileDigest: "0".repeat(64),
        },
        remoteUser: "nobody",
      });
      expect(environment.refuse(definition)).toBeUndefined();
      await environment.prepare(definition);
      const build = world.calls.find((call) => call.kind === "modal.image.build");
      const { commands } = (build as { detail: { commands: string[] } }).detail;
      const at = (fragment: string) => commands.findIndex((command) => command.includes(fragment));
      expect(commands.slice(0, 2)).toEqual(["USER nobody", "USER root"]);
      expect(at(" git ")).toBe(2);
      expect(at("nodejs")).toBe(3);
      expect(commands[4]).toBe("USER nobody");
      expect(at("harness-install")).toBe(5);
      // The user owns the trusted MCP copy's directory, which prepare empties and refills.
      expect(commands.slice(6, 7)).toEqual(["USER root"]);
      expect(commands[7]).toContain(`chown -R 'nobody'`);
      expect(commands[7]).toContain(`'${environment.mcpDirectory}'`);
      expect(commands.slice(8)).toEqual(["USER nobody"]);
    },
    60_000,
  );

  it("gives the Dockerfile's USER the checkout and MCP directories when the devcontainer names no user", async () => {
    const { world, environment, define } = await setup();
    const { definition } = await define(["tools"], {
      build: {
        dockerfile: "Dockerfile",
        dockerfileContent: "FROM python:3.13-slim\nUSER root\nUSER nobody\n",
        dockerfileDigest: "0".repeat(64),
      },
    });
    expect(environment.refuse(definition)).toBeUndefined();
    await environment.prepare(definition);
    const build = world.calls.find(
      (call) => call.kind === "modal.image.build" || call.kind === "e2b.template.build",
    ) as { detail: { commands?: string[]; user?: string; mcpDirectory?: string } };
    if (provider === "modal") {
      const commands = build.detail.commands as string[];
      const chown = commands.findIndex((command) => command.includes("chown -R 'nobody'"));
      expect(chown).toBeGreaterThan(0);
      expect(commands[chown - 1]).toBe("USER root");
      expect(commands[chown]).toContain(`'${environment.mcpDirectory}'`);
      expect(commands.slice(chown + 1)).toEqual(["USER nobody"]);
    }
    // The native template client chowns the checkout and MCP directories for `user` as root.
    else
      expect(build.detail).toMatchObject({
        user: "nobody",
        mcpDirectory: environment.mcpDirectory,
      });
  }, 60_000);

  it("refuses a Dockerfile USER that is not a literal name before any provider call", async () => {
    const { world, environment, define } = await setup();
    const { definition } = await define(["tools"], {
      build: {
        dockerfile: "Dockerfile",
        dockerfileContent: "FROM python:3.13-slim\nARG NAME=nobody\nUSER $NAME\n",
        dockerfileDigest: "0".repeat(64),
      },
    });
    expect(environment.refuse(definition)).toMatch(/USER must name a literal user/u);
    expect(world.calls).toEqual([]);
  });

  it("refuses a nonliteral Dockerfile USER even when remoteUser overrides it", async () => {
    const { world, environment, define } = await setup();
    const { definition } = await define(["tools"], {
      remoteUser: "nobody",
      build: {
        dockerfile: "Dockerfile",
        dockerfileContent: "FROM python:3.13-slim\nARG NAME=nobody\nUSER $NAME\n",
        dockerfileDigest: "0".repeat(64),
      },
    });
    expect(environment.refuse(definition)).toMatch(/USER must name a literal user/u);
    expect(world.calls).toEqual([]);
  });

  it("refuses to prepare a stdio server when the sandbox cannot run Node.js, naming why", async () => {
    const { scratch, environment, define } = await setup();
    // The image's `node` is missing or too old: a stand-in that cannot run the bridge's check.
    const bin = join(scratch, "no-node");
    await mkdir(bin, { recursive: true });
    await writeFile(join(bin, "node"), "#!/bin/sh\nexit 127\n", { mode: 0o755 });
    // The fake sandbox reads PATH when it starts each process; the stub is removed afterward.
    vi.stubEnv("PATH", `${bin}:${process.env["PATH"] ?? ""}`);
    try {
      const { definition } = await define(["tools"]);
      await expect(environment.prepare(definition)).rejects.toThrow(
        /Workspace stdio MCP servers need Node\.js 18 or later in the sandbox/u,
      );
      await expect(environment.prepare((await define(["docs"])).definition)).resolves.toMatchObject(
        { provider },
      );
    } finally {
      vi.unstubAllEnvs();
    }
  }, 60_000);

  it("gives the Harness a view beside the checkout and refuses staging into it", async () => {
    const { environment, repo, define } = await setup();
    const prepared = await environment.prepare((await define(["docs"])).definition);
    const task = await environment.start(prepared, {
      taskId: "t1",
      attemptId: "a1",
      branch: "supertag/test/t1",
      base: repo.trusted,
      head: repo.trusted,
      plan: PLAN,
    });
    cleanups.push(() => task.dispose("completed"));
    const harness = environment.harnessEnvironment(task);
    expect(environment.harnessEnvironment(task)).toBe(harness);
    expect(harness.rootDirectory).toBe(FAKE_SANDBOX_ROOT);
    expect(environment.checkoutPath).toBe("repo");
    expect(harness.resolvePath(environment.checkoutPath)).toBe(task.rootDirectory);
    const auth = { path: ".codex/auth.json", content: "{}", mode: 0o600 };
    await harness.prepare({ ...PLAN, files: [auth] });
    // Restaging replaces the file, as a retried start does.
    await harness.prepare({ ...PLAN, files: [auth] });
    expect(await harness.read(".codex/auth.json")).toBe("{}");
    await expect(task.read(".codex/auth.json")).rejects.toThrow();
    for (const path of ["repo", "repo/.codex/auth.json", "./repo/x"])
      await expect(harness.prepare({ ...PLAN, files: [{ path, content: "x" }] })).rejects.toThrow(
        /outside the Workspace checkout/u,
      );
    await expect(
      harness.prepare({
        ...PLAN,
        mounts: [{ source: { uri: "file:///nonexistent" }, destination: "repo/.agents/skills/x" }],
      }),
    ).rejects.toThrow(/outside the Workspace checkout/u);
    await expect(harness.prepareOutputDirectory?.("repo/outputs")).rejects.toThrow(
      /outside the Workspace checkout/u,
    );
    // Finalize sees nothing the Harness staged.
    const finalized = await environment.finalize(task, {
      message: "Work",
      author: { name: "SuperTag", email: "supertag@localhost" },
    });
    expect(finalized).toEqual({ head: repo.trusted, committed: false, mountOutputManifests: [] });
  }, 60_000);
});

it("adds the trusted copy to the prepare script only when asked", () => {
  const base = {
    workspaceDirectory: "/w/repo",
    contentPath: "/w/t/content.bundle",
    trustedCommit: "a".repeat(40),
    harnessCommands: ["sh"],
  };
  expect(prepareScript(base)).not.toContain("worktree");
  expect(prepareScript(base)).not.toContain("node -e");
  const script = prepareScript({ ...base, mcpDirectory: "/w/.repo-supertag-mcp" });
  // Node.js is checked after setup, which may install it.
  expect(script.indexOf("node -e")).toBeGreaterThan(script.indexOf("harness command sh"));
  expect(script).toContain(`mcp='/w/.repo-supertag-mcp'`);
  expect(script).toContain('g worktree add -q --detach "$mcp" "$trusted"');
  expect(script.indexOf("worktree add")).toBeLessThan(script.indexOf('rm -f "$bundle"'));
});
