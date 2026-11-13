import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
const temporaryDirectory = await mkdtemp(join(tmpdir(), "supertag-external-worker-"));
const exampleDirectory = new URL("../../../examples/custom-worker/", import.meta.url);

try {
  const { stdout } = await execute("pnpm", ["pack", "--pack-destination", temporaryDirectory], {
    cwd: new URL("..", import.meta.url),
  });
  const tarballName = stdout.trim().split("\n").at(-1);
  if (!tarballName) throw new Error("pnpm pack did not return a tarball path");
  const tarballPath = tarballName.startsWith("/")
    ? tarballName
    : join(temporaryDirectory, tarballName);

  const packageJson = JSON.parse(await readFile(new URL("package.json", exampleDirectory), "utf8"));
  packageJson.dependencies["supertag-ai"] = `file:${tarballPath}`;
  await writeFile(
    join(temporaryDirectory, "package.json"),
    `${JSON.stringify(packageJson, null, 2)}\n`,
  );
  for (const file of ["worker.mjs", "harness.mjs", "environment.mjs", "verify.mjs"]) {
    await copyFile(new URL(file, exampleDirectory), join(temporaryDirectory, file));
  }

  await execute("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund"], {
    cwd: temporaryDirectory,
  });
  // The durable journal uses the packaged SQLite dependency. Build only that native
  // addon, rather than enabling lifecycle scripts for every installed dependency.
  await execute("npm", ["rebuild", "better-sqlite3", "--no-audit", "--no-fund"], {
    cwd: temporaryDirectory,
  });
  const workerVerification = await execute(process.execPath, ["worker.mjs"], {
    cwd: temporaryDirectory,
  });
  const verification = await execute(process.execPath, ["verify.mjs"], {
    cwd: temporaryDirectory,
  });
  process.stdout.write(workerVerification.stdout);
  process.stdout.write(verification.stdout);
  await copyFile(
    new URL("./verify-control-plane-client.mjs", import.meta.url),
    join(temporaryDirectory, "verify-control-plane-client.mjs"),
  );
  const controlPlaneVerification = await execute(
    process.execPath,
    ["verify-control-plane-client.mjs"],
    {
      cwd: temporaryDirectory,
    },
  );
  process.stdout.write(controlPlaneVerification.stdout);
  // Reuse the isolated installation to check the organization example's public
  // imports. Help must not create state, launch services, or call native models.
  const organizationDirectory = join(temporaryDirectory, "shared-organization");
  await mkdir(organizationDirectory);
  const organizationSource = new URL("../../../examples/shared-organization/", import.meta.url);
  for (const file of await readdir(organizationSource))
    if (/\.(?:mjs|cjs)$/.test(file))
      await copyFile(new URL(file, organizationSource), join(organizationDirectory, file));
  for (const file of ["organization.mjs", "worker.mjs"]) {
    const help = await execute(process.execPath, [file, "--help"], {
      cwd: organizationDirectory,
      timeout: 30000,
    });
    if (!help.stdout.includes(`node ${file}`))
      throw new Error(`Shared organization ${file} did not display help`);
  }
  process.stdout.write("Shared organization public package imports passed.\n");
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}
