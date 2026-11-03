#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const launcher = `#!/bin/sh
set -eu

SOURCE=$0
while [ -L "$SOURCE" ]; do
  SOURCE_DIRECTORY=$(CDPATH= cd -P -- "$(dirname -- "$SOURCE")" >/dev/null 2>&1 && pwd)
  SOURCE=$(readlink "$SOURCE")
  case "$SOURCE" in
    /*) ;;
    *) SOURCE="$SOURCE_DIRECTORY/$SOURCE" ;;
  esac
done

SCRIPT_DIRECTORY=$(CDPATH= cd -P -- "$(dirname -- "$SOURCE")" >/dev/null 2>&1 && pwd)
ROOT=$(CDPATH= cd -- "$SCRIPT_DIRECTORY/.." >/dev/null 2>&1 && pwd)
PATH="$ROOT/app/node_modules/.bin:$PATH"
export PATH
exec "$ROOT/runtime/node" "$ROOT/app/node_modules/supertag-ai/dist/cli.js" "$@"
`;

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const packageDirectory = join(repositoryRoot, "packages/supertag-ai");
const target = targetName(process.platform, process.arch);
const expectedTarget = readOption(process.argv.slice(2), "--target");
if (expectedTarget !== undefined && expectedTarget !== target) {
  throw new Error(`Runner is ${target}, not requested target ${expectedTarget}`);
}
const output = resolve(
  repositoryRoot,
  readOption(process.argv.slice(2), "--output") ?? `dist/supertag-${target}.tar.gz`,
);
const temporaryDirectory = await mkdtemp(join(tmpdir(), "supertag-distribution-"));

try {
  const nodeRuntime = await prepareNodeRuntime(temporaryDirectory, target);
  const nodeExecutable = join(nodeRuntime, "bin/node");
  const npmCli = join(nodeRuntime, "lib/node_modules/npm/bin/npm-cli.js");
  const runtimeEnvironment = {
    PATH: `${join(nodeRuntime, "bin")}:${process.env.PATH ?? ""}`,
  };
  const packageManifest = JSON.parse(
    await readFile(join(packageDirectory, "package.json"), "utf8"),
  );
  const version = requiredString(packageManifest.version, "supertag-ai package version");
  await execute("pnpm", ["--filter", "supertag-ai", "build"], repositoryRoot);
  const packOutput = await execute(
    nodeExecutable,
    [
      npmCli,
      "pack",
      packageDirectory,
      "--pack-destination",
      temporaryDirectory,
      "--ignore-scripts",
      "--json",
    ],
    repositoryRoot,
    true,
    runtimeEnvironment,
  );
  const packResult = JSON.parse(packOutput);
  const tarballName = requiredString(packResult?.[0]?.filename, "npm pack filename");
  const tarball = join(temporaryDirectory, basename(tarballName));

  const distribution = join(temporaryDirectory, "archive/supertag");
  const application = join(distribution, "app");
  const runtime = join(distribution, "runtime");
  const state = join(temporaryDirectory, "state");
  await mkdir(application, { recursive: true });
  await mkdir(runtime, { recursive: true });
  await mkdir(state, { recursive: true });
  await writeFile(join(application, "package.json"), '{"private":true}\n', "utf8");

  await execute(
    nodeExecutable,
    [
      npmCli,
      "install",
      "--omit=dev",
      "--no-audit",
      "--no-fund",
      "--no-package-lock",
      "--no-save",
      tarball,
    ],
    application,
    false,
    runtimeEnvironment,
  );

  await copyFile(nodeExecutable, join(runtime, "node"));
  await chmod(join(runtime, "node"), 0o755);
  await mkdir(join(distribution, "bin"), { recursive: true });
  await writeFile(join(distribution, "VERSION"), `${version}\n`, "utf8");
  await writeFile(join(distribution, "bin/supertag"), launcher, { mode: 0o755 });

  const command = join(distribution, "bin/supertag");
  const actualVersion = (
    await execute(command, ["--version"], distribution, true, {
      SUPERTAG_STATE_DIR: state,
    })
  ).trim();
  if (actualVersion !== version) {
    throw new Error(`Packaged CLI reported ${actualVersion || "no version"}; expected ${version}`);
  }
  await execute(command, ["migrate"], distribution, false, { SUPERTAG_STATE_DIR: state });

  await mkdir(dirname(output), { recursive: true });
  await execute(
    "tar",
    ["-czf", output, "-C", join(temporaryDirectory, "archive"), "supertag"],
    repositoryRoot,
  );
  process.stdout.write(`${output}\n`);
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}

function readOption(args, name) {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const value = args[index + 1]?.trim();
  if (!value) throw new Error(`${name} requires a value`);
  return value;
}

function targetName(platform, architecture) {
  if (platform !== "darwin" && platform !== "linux") {
    throw new Error(`Unsupported CLI distribution platform: ${platform}`);
  }
  if (architecture !== "arm64" && architecture !== "x64") {
    throw new Error(`Unsupported CLI distribution architecture: ${architecture}`);
  }
  return `${platform}-${architecture}`;
}

function requiredString(value, label) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Missing ${label}`);
  }
  return value.trim();
}

async function prepareNodeRuntime(temporaryDirectory, target) {
  const version = requiredString(
    await readFile(join(repositoryRoot, ".node-version"), "utf8"),
    ".node-version",
  );
  const archiveName = `node-v${version}-${target}.tar.gz`;
  const baseUrl = (
    process.env.SUPERTAG_NODE_DIST_URL ?? `https://nodejs.org/dist/v${version}`
  ).replace(/\/$/u, "");
  const [archiveResponse, checksumsResponse] = await Promise.all([
    fetch(`${baseUrl}/${archiveName}`),
    fetch(`${baseUrl}/SHASUMS256.txt`),
  ]);
  if (!archiveResponse.ok) {
    throw new Error(`Unable to download ${archiveName}: HTTP ${archiveResponse.status}`);
  }
  if (!checksumsResponse.ok) {
    throw new Error(`Unable to download Node checksums: HTTP ${checksumsResponse.status}`);
  }
  const archive = Buffer.from(await archiveResponse.arrayBuffer());
  const checksums = await checksumsResponse.text();
  const expected = checksums
    .split("\n")
    .find((line) => line.trim().endsWith(`  ${archiveName}`))
    ?.trim()
    .split(/\s+/u)[0];
  if (!expected) throw new Error(`Node checksums do not contain ${archiveName}`);
  const actual = createHash("sha256").update(archive).digest("hex");
  if (actual !== expected) throw new Error(`Checksum verification failed for ${archiveName}`);

  const archivePath = join(temporaryDirectory, archiveName);
  const extractionDirectory = join(temporaryDirectory, "node-runtime");
  await writeFile(archivePath, archive);
  await mkdir(extractionDirectory, { recursive: true });
  await execute("tar", ["-xzf", archivePath, "-C", extractionDirectory], repositoryRoot);
  return join(extractionDirectory, `node-v${version}-${target}`);
}

function execute(command, args, cwd, capture = false, environment = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...environment },
      stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
    });
    let stdout = "";
    if (capture) child.stdout?.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) resolvePromise(stdout);
      else reject(new Error(`${command} failed with ${signal ?? `exit code ${code}`}`));
    });
  });
}
