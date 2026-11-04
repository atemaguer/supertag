import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readlink, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const installer = resolve("install.sh");
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("install.sh", () => {
  it("installs the npm package with the system's Node.js and links the command", async () => {
    const fixture = await packageFixture("1.2.3");
    const result = await runInstaller(fixture);

    expect(result.stderr).not.toContain("SuperTag installer:");
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Installed SuperTag 1.2.3");
    expect(result.stdout).toContain("then run supertag init");
    expect(await readlink(join(fixture.bin, "supertag"))).toBe(
      join(await realpath(fixture.installRoot), "versions/1.2.3/node_modules/.bin/supertag"),
    );
  });

  it("removes the Claude Code and Codex CLIs the vendor SDKs bundle", async () => {
    const fixture = await packageFixture("1.2.3");
    expect((await runInstaller(fixture)).code).toBe(0);
    const modules = join(
      fixture.installRoot,
      "versions/1.2.3/node_modules/supertag-ai/node_modules",
    );
    for (const bundled of [
      "@openai/codex-darwin-arm64",
      "@anthropic-ai/claude-agent-sdk-linux-x64",
    ])
      await expect(stat(join(modules, bundled))).rejects.toMatchObject({ code: "ENOENT" });
    // Packages that only share a prefix stay.
    expect((await stat(join(modules, "@openai/codex-sdk"))).isDirectory()).toBe(true);
  });

  it("refuses to install without a new enough Node.js", async () => {
    const fixture = await packageFixture("1.2.3");
    const old = join(fixture.root, "old-node");
    await mkdir(old);
    await writeFile(join(old, "node"), "#!/bin/sh\necho v20.11.0\n");
    await chmod(join(old, "node"), 0o755);
    const result = await runInstaller(fixture, `${old}:${process.env["PATH"] ?? ""}`);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("Node.js 20.11.0 is older than 22.13.0");
  });
});

/** A packed package named supertag-ai whose bin prints its version, bundling fake vendor CLIs. */
async function packageFixture(version: string) {
  const root = await mkdtemp(join(tmpdir(), "supertag-installer-test-"));
  temporaryDirectories.push(root);
  const source = join(root, "package");
  const bundled = [
    "@openai/codex-darwin-arm64",
    "@anthropic-ai/claude-agent-sdk-linux-x64",
    "@openai/codex-sdk",
  ];
  await mkdir(join(source, "bin"), { recursive: true });
  for (const name of bundled) {
    const directory = join(source, "node_modules", name);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "package.json"), JSON.stringify({ name, version: "1.0.0" }));
  }
  await writeFile(
    join(source, "package.json"),
    JSON.stringify({
      name: "supertag-ai",
      version,
      bin: { supertag: "bin/supertag.js" },
      dependencies: Object.fromEntries(bundled.map((name) => [name, "1.0.0"])),
      bundleDependencies: bundled,
    }),
  );
  await writeFile(
    join(source, "bin/supertag.js"),
    `#!/usr/bin/env node\nconsole.log(${JSON.stringify(version)});\n`,
  );
  await chmod(join(source, "bin/supertag.js"), 0o755);
  const packed = await run("npm", ["pack", "--silent", "--pack-destination", root], {}, source);
  const tarball = join(root, packed.stdout.trim().split("\n").at(-1) ?? "");
  return {
    root,
    tarball,
    bin: join(root, "bin"),
    installRoot: join(root, "install"),
  };
}

async function runInstaller(fixture: Awaited<ReturnType<typeof packageFixture>>, path?: string) {
  return run("sh", [installer], {
    SUPERTAG_BIN_DIR: fixture.bin,
    SUPERTAG_INSTALL_ROOT: fixture.installRoot,
    SUPERTAG_PACKAGE_SOURCE: fixture.tarball,
    npm_config_cache: join(fixture.root, "npm-cache"),
    ...(path === undefined ? {} : { PATH: path }),
  });
}

function run(
  command: string,
  args: readonly string[],
  environment: Readonly<Record<string, string>> = {},
  cwd: string = dirname(installer),
): Promise<{ readonly code: number | null; readonly stderr: string; readonly stdout: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...environment },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("exit", (code) => resolvePromise({ code, stderr, stdout }));
  });
}
