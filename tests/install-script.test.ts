import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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
  it("verifies and installs the matching release archive", async () => {
    const fixture = await releaseFixture("1.2.3");
    const result = await runInstaller(fixture);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Installed SuperTag 1.2.3");
    expect(await readlink(join(fixture.bin, "supertag"))).toBe(
      join(await realpath(fixture.installRoot), "versions/1.2.3/bin/supertag"),
    );
    expect(await readFile(join(fixture.installRoot, "versions/1.2.3/VERSION"), "utf8")).toBe(
      "1.2.3\n",
    );
  });

  it("refuses an archive whose checksum does not match", async () => {
    const fixture = await releaseFixture("1.2.3");
    await writeFile(
      join(fixture.downloadRoot, "checksums.txt"),
      `${"0".repeat(64)}  ${fixture.asset}\n`,
    );

    const result = await runInstaller(fixture);

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("checksum verification failed");
  });
});

async function releaseFixture(version: string) {
  const root = await mkdtemp(join(tmpdir(), "supertag-installer-test-"));
  temporaryDirectories.push(root);
  const downloadRoot = join(root, "release");
  const archiveRoot = join(root, "archive/supertag");
  const installRoot = join(root, "install");
  const bin = join(root, "bin");
  const asset = "supertag-darwin-arm64.tar.gz";
  await mkdir(join(archiveRoot, "bin"), { recursive: true });
  await mkdir(downloadRoot, { recursive: true });
  await writeFile(join(archiveRoot, "VERSION"), `${version}\n`);
  await writeFile(
    join(archiveRoot, "bin/supertag"),
    `#!/bin/sh\nif [ "\${1:-}" = "--version" ]; then printf '${version}\\n'; exit 0; fi\nexit 0\n`,
  );
  await chmod(join(archiveRoot, "bin/supertag"), 0o755);
  await run("tar", ["-czf", join(downloadRoot, asset), "-C", join(root, "archive"), "supertag"]);
  const archive = await readFile(join(downloadRoot, asset));
  const checksum = createHash("sha256").update(archive).digest("hex");
  await writeFile(join(downloadRoot, "checksums.txt"), `${checksum}  ${asset}\n`);
  return { asset, bin, downloadRoot, installRoot };
}

async function runInstaller(fixture: Awaited<ReturnType<typeof releaseFixture>>) {
  return run("sh", [installer], {
    SUPERTAG_ARCH: "arm64",
    SUPERTAG_BIN_DIR: fixture.bin,
    SUPERTAG_DOWNLOAD_ROOT: `file://${fixture.downloadRoot}`,
    SUPERTAG_INSTALL_ROOT: fixture.installRoot,
    SUPERTAG_OS: "darwin",
    SUPERTAG_VERSION: "1.2.3",
  });
}

function run(
  command: string,
  args: readonly string[],
  environment: Readonly<Record<string, string>> = {},
): Promise<{ readonly code: number | null; readonly stderr: string; readonly stdout: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
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
