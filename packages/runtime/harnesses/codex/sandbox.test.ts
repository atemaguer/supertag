import { execFile, execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import { type ResolutionContext, WorkspaceEnvironmentResolver } from "../../sdk/src/index.js";
import * as codexAppServer from "./src/app-server.js";
import { installedCodex } from "./src/index.js";
import {
  codexPermissionProfileArguments,
  codexPermissionProfileConfig,
  codexProtectedGitDirectory,
  codexProtectedGitDirectoryArguments,
  codexSandboxAllowance,
  codexSandboxMode,
  codexWritableDirectoryArguments,
} from "./src/sandbox.js";

describe("Codex sandbox allowance", () => {
  it.each([
    { actions: [], expected: { filesystem: "read-only", network: "none" } },
    {
      actions: ["files:write"],
      expected: { filesystem: "workspace-write", network: "none", permissionProfile: "supertag" },
    },
    {
      actions: ["commands:execute"],
      expected: { filesystem: "read-only", network: "loopback", permissionProfile: "supertag" },
    },
    {
      actions: ["commands:execute", "files:write"],
      expected: {
        filesystem: "workspace-write",
        network: "loopback",
        permissionProfile: "supertag",
      },
    },
    {
      actions: ["commands:execute", "files:write", "web:fetch"],
      expected: { filesystem: "workspace-write", network: "enabled" },
    },
    {
      actions: ["commands:execute", "web:fetch"],
      expected: { filesystem: "read-only", network: "loopback", permissionProfile: "supertag" },
    },
    { actions: ["web:fetch"], expected: { filesystem: "read-only", network: "none" } },
  ])("maps $actions to $expected", ({ actions, expected }) => {
    expect(codexSandboxAllowance("native", actions)).toEqual(expected);
    expect(codexSandboxAllowance(undefined, actions)).toEqual(expected);
  });

  it("defers to the execution environment in external sandbox mode", () => {
    const allowance = codexSandboxAllowance("external", ["commands:execute", "files:write"]);
    expect(allowance).toEqual({ filesystem: "external", network: "external" });
    expect(codexSandboxMode(allowance)).toBe("danger-full-access");
    expect(codexPermissionProfileArguments(allowance)).toEqual([]);
  });

  it("replaces the legacy sandbox mode for native writable profiles", () => {
    expect(codexSandboxMode(codexSandboxAllowance("native", ["files:write"]))).toBe(undefined);
    expect(codexSandboxMode(codexSandboxAllowance("native", []))).toBe("read-only");
    expect(codexSandboxMode(codexSandboxAllowance("native", ["commands:execute"]))).toBe(undefined);
  });

  it("builds a loopback-only Codex permission profile", () => {
    expect(
      codexPermissionProfileArguments(
        codexSandboxAllowance("native", ["commands:execute", "files:write"]),
      ),
    ).toEqual([
      "--config",
      'default_permissions="supertag"',
      "--config",
      'permissions.supertag.extends=":workspace"',
      "--config",
      "permissions.supertag.network.enabled=true",
      "--config",
      'permissions.supertag.network.mode="limited"',
      "--config",
      "permissions.supertag.network.allow_local_binding=true",
      "--config",
      "features.network_proxy.enabled=true",
    ]);
    expect(
      codexPermissionProfileArguments(codexSandboxAllowance("native", ["commands:execute"])),
    ).toContain('permissions.supertag.extends=":read-only"');
    expect(codexPermissionProfileArguments(codexSandboxAllowance("native", []))).toEqual([]);
  });

  it("grants the output directory through the profile in app-server threads", () => {
    const loopback = codexSandboxAllowance("native", ["commands:execute", "files:write"]);
    expect(codexAppServer.codexThreadConfig(undefined, "/out", loopback)).toEqual({
      config: { "permissions.supertag.filesystem": { "/out": "write" } },
    });
    expect(
      codexAppServer.codexThreadConfig(undefined, "/out", loopback, undefined, "/scratch"),
    ).toEqual({
      config: { "permissions.supertag.filesystem": { "/out": "write", "/scratch": "write" } },
    });
    const legacy = codexSandboxAllowance("native", ["files:write", "web:fetch"]);
    expect(codexAppServer.codexThreadConfig(undefined, "/out", legacy)).toEqual({
      config: { "sandbox_workspace_write.writable_roots": ["/out"] },
    });
  });

  it("grants an exec-mode writable directory through the profile under loopback", () => {
    expect(
      codexWritableDirectoryArguments(
        codexSandboxAllowance("native", ["commands:execute", "files:write"]),
        "/out",
      ),
    ).toEqual(["--config", 'permissions.supertag.filesystem={ "/out" = "write" }']);
    expect(
      codexWritableDirectoryArguments(codexSandboxAllowance("native", ["files:write"]), "/out"),
    ).toEqual(["--config", 'permissions.supertag.filesystem={ "/out" = "write" }']);
    expect(
      codexPermissionProfileConfig(codexSandboxAllowance("native", ["files:write"]))[
        "permissions.supertag.network.enabled"
      ],
    ).toBeUndefined();
  });
});

const run = promisify(execFile);
const roots: string[] = [];
afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

/**
 * Seatbelt cannot be applied inside an existing sandbox (`sandbox_apply`
 * fails with EPERM), so these probes skip when the suite itself runs in one,
 * such as a Codex Task.
 */
function canApplySandbox(): boolean {
  if (process.platform !== "darwin" || process.env["CODEX_SANDBOX"] !== undefined) return false;
  try {
    execFileSync("/usr/bin/sandbox-exec", ["-p", "(version 1)(allow default)", "/usr/bin/true"], {
      stdio: "ignore",
      timeout: 10_000,
    });
    return true;
  } catch {
    return false;
  }
}

// Runs the bundled Codex CLI's own sandbox (macOS Seatbelt) with the exact
// configuration the Worker passes, then probes loopback and external sockets.
describe.runIf(canApplySandbox())("installed Codex loopback sandbox", () => {
  const probe = `
import net from "node:net";
const result = {};
await new Promise((done) => {
  const server = net.createServer((socket) => socket.end());
  server.on("error", (error) => { result.listen = error.code; done(); });
  server.listen(0, "127.0.0.1", () => {
    result.listen = "ok";
    const client = net.connect(server.address().port, "127.0.0.1", () => { result.connect = "ok"; client.end(); });
    client.on("error", (error) => { result.connect = error.code; });
    client.on("close", () => server.close(done));
  });
});
await new Promise((done) => {
  const client = net.connect({ host: "192.0.2.1", port: 443, timeout: 2000 }, () => { result.external = "ok"; client.destroy(); done(); });
  client.on("error", (error) => { result.external = error.code; done(); });
  client.on("timeout", () => { result.external = "timeout"; client.destroy(); done(); });
});
console.log(JSON.stringify(result));
`;

  async function sandboxed(actions: readonly string[], profile: boolean) {
    const { command } = await installedCodex();
    const root = await mkdtemp(join(tmpdir(), "supertag-codex-sandbox-"));
    roots.push(root);
    await mkdir(join(root, "home"));
    await writeFile(join(root, "probe.mjs"), probe);
    const allowance = codexSandboxAllowance("native", actions);
    const args = profile
      ? ["sandbox", "-P", "supertag", ...codexPermissionProfileArguments(allowance)]
      : ["sandbox", "-P", allowance.filesystem === "workspace-write" ? ":workspace" : ":read-only"];
    const { stdout } = await run(
      command,
      [...args, "-C", root, "--", process.execPath, "probe.mjs"],
      { cwd: root, env: { ...process.env, CODEX_HOME: join(root, "home") }, timeout: 30_000 },
    );
    return JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}") as Record<string, string>;
  }

  it("lets the profile write a granted output directory outside the workspace", async () => {
    const { command } = await installedCodex();
    const root = await mkdtemp(join(tmpdir(), "supertag-codex-sandbox-"));
    // :workspace already allows the temporary directory, so probe outside it.
    const output = await mkdtemp(join(homedir(), ".supertag-codex-output-"));
    const denied = await mkdtemp(join(homedir(), ".supertag-codex-denied-"));
    roots.push(root, output, denied);
    await mkdir(join(root, "home"));
    const allowance = codexSandboxAllowance("native", ["commands:execute", "files:write"]);
    const write = (directory: string) =>
      run(
        command,
        [
          "sandbox",
          "-P",
          "supertag",
          ...codexPermissionProfileArguments(allowance),
          ...codexWritableDirectoryArguments(allowance, output),
          "-C",
          root,
          "--",
          "/usr/bin/touch",
          join(directory, "probe"),
        ],
        { cwd: root, env: { ...process.env, CODEX_HOME: join(root, "home") }, timeout: 30_000 },
      );
    await expect(write(output)).resolves.toBeDefined();
    await expect(write(denied)).rejects.toThrow();
  }, 60_000);

  it("denies loopback without the profile, as before", async () => {
    expect(await sandboxed(["commands:execute", "files:write"], false)).toMatchObject({
      listen: "EPERM",
      external: "EPERM",
    });
  }, 60_000);

  it("allows loopback and still denies external sockets with the profile", async () => {
    expect(await sandboxed(["commands:execute", "files:write"], true)).toEqual({
      listen: "ok",
      connect: "ok",
      external: "EPERM",
    });
  }, 60_000);
});

/**
 * The Worker runs git in a Workspace's repository after the harness finishes. A harness that
 * could write the repository's shared git directory could make those commands run its code on
 * the Worker Host, so the Codex sandbox must never grant it.
 */
describe("Codex sandbox and the shared git directory", () => {
  const actions = ["commands:execute", "files:write"];
  const gitIn = (cwd: string, ...args: string[]) =>
    execFileSync(
      "git",
      ["-C", cwd, "-c", "user.name=Test", "-c", "user.email=test@example.com", ...args],
      {
        encoding: "utf8",
        env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
      },
    ).trim();
  const inside = (path: string, root: string) => {
    const offset = relative(root, path);
    return offset === "" || (!offset.startsWith("..") && !isAbsolute(offset));
  };

  /** A Task worktree in a temporary repository, like a local Worker checkout. */
  async function taskWorktree() {
    const base = await mkdtemp(join(tmpdir(), "supertag-codex-git-"));
    const output = await mkdtemp(join(tmpdir(), "supertag-codex-git-output-"));
    roots.push(base, output);
    const checkout = join(base, "checkout");
    await mkdir(checkout);
    gitIn(checkout, "init", "--quiet", "--initial-branch=main");
    await writeFile(join(checkout, "README.md"), "# App\n");
    gitIn(checkout, "add", "-A");
    gitIn(checkout, "commit", "--quiet", "-m", "Initial commit");
    const input = await new WorkspaceEnvironmentResolver({
      checkouts: [{ name: "app", path: checkout }],
      worktreeRoot: join(base, "workspaces"),
    }).resolve({
      task: {
        taskId: "task-1",
        attemptId: "attempt-1",
        workspacePlan: {
          version: 1,
          status: "workspace",
          workspace: "app",
          branch: "supertag/objective-1/task-1",
          delivery: "branch",
        },
        authorization: { runtimeActions: actions },
      },
      profile: { harness: { provider: "codex" } },
    } as unknown as ResolutionContext);
    const worktree = fileURLToPath(input?.source.uri ?? "");
    return {
      base,
      worktree,
      output,
      common: gitIn(worktree, "rev-parse", "--path-format=absolute", "--git-common-dir"),
      gitDir: gitIn(worktree, "rev-parse", "--path-format=absolute", "--git-dir"),
    };
  }

  it("grants writes only to the Task worktree and the output directory, never the git directory", async () => {
    const attempt = await taskWorktree();
    const allowance = codexSandboxAllowance("native", actions);
    expect(await codexProtectedGitDirectory(attempt.worktree)).toBe(attempt.common);
    expect(codexProtectedGitDirectoryArguments(allowance, attempt.common)).toEqual([
      "--config",
      `permissions.supertag.filesystem={ ${JSON.stringify(attempt.common)} = "read" }`,
    ]);
    expect(
      codexAppServer.codexThreadConfig(undefined, attempt.output, allowance, attempt.common),
    ).toEqual({
      config: {
        "permissions.supertag.filesystem": {
          [attempt.output]: "write",
          [attempt.common]: "read",
        },
      },
    });
    // The profile extends Codex's :workspace: the working directory plus temporary directories.
    expect(codexPermissionProfileConfig(allowance)["permissions.supertag.extends"]).toBe(
      ":workspace",
    );
    const granted = codexWritableDirectoryArguments(allowance, attempt.output)
      .filter((argument) => argument.startsWith("permissions.supertag.filesystem="))
      .flatMap((argument) =>
        [...argument.matchAll(/"([^"]+)" = "write"/gu)].map((match) => match[1] as string),
      );
    expect(granted).toEqual([attempt.output]);
    for (const root of [attempt.worktree, ...granted]) {
      expect(inside(attempt.common, root)).toBe(false);
      expect(inside(attempt.gitDir, root)).toBe(false);
    }
    // Managed clones live under the Worker's state directory, outside every writable root too.
    const clone = new WorkspaceEnvironmentResolver({ checkouts: [] }).clonePath("app");
    for (const root of [tmpdir(), "/tmp"]) expect(inside(clone, root)).toBe(false);
  });

  it.runIf(canApplySandbox())(
    "denies the Codex sandbox writes to the repository config, worktree config, and info/attributes",
    async () => {
      const { command } = await installedCodex();
      const attempt = await taskWorktree();
      const home = join(attempt.base, "codex-home");
      await mkdir(home);
      const allowance = codexSandboxAllowance("native", actions);
      const append = (path: string) =>
        run(
          command,
          [
            "sandbox",
            "-P",
            "supertag",
            ...codexPermissionProfileArguments(allowance),
            ...codexWritableDirectoryArguments(allowance, attempt.output),
            ...codexProtectedGitDirectoryArguments(allowance, attempt.common),
            "-C",
            attempt.worktree,
            "--",
            "/bin/sh",
            "-c",
            `mkdir -p "$(dirname "$1")" && printf '[filter "evil"]\\n' >> "$1"`,
            "sh",
            path,
          ],
          { cwd: attempt.worktree, env: { ...process.env, CODEX_HOME: home }, timeout: 30_000 },
        );
      // The sandbox applies, and the Task worktree itself stays writable.
      await expect(append(join(attempt.worktree, "probe.txt"))).resolves.toBeDefined();
      for (const target of [
        join(attempt.common, "config"),
        join(attempt.gitDir, "config.worktree"),
        join(attempt.common, "info", "attributes"),
      ])
        await expect(append(target)).rejects.toThrow();
      expect(await readFile(join(attempt.common, "config"), "utf8")).not.toContain("evil");
    },
    60_000,
  );
});
