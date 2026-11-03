/** Run after building: verify the exact production-only layout used by the Docker image. */
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
// pnpm 11 deploy --prod rewrites this checkout-level verification cache with production=true.
// Preserve it so later pnpm exec does not attempt to remove development dependencies.
const statePath = new URL("../node_modules/.pnpm-workspace-state-v1.json", import.meta.url);
const originalState = await readFile(statePath).catch((error: NodeJS.ErrnoException) => {
  if (error.code === "ENOENT") return undefined;
  throw error;
});
const directory = await mkdtemp(join(tmpdir(), "supertag-cli-deployment-"));
try {
  await exec("pnpm", ["--filter", "@supertag/cli", "deploy", "--prod", "--legacy", directory], {
    maxBuffer: 4 * 1024 * 1024,
  });
  // No development condition, repository source tree, or TS loader in the deployed process.
  const environment = { ...process.env };
  delete environment["NODE_OPTIONS"];
  delete environment["NODE_PATH"];
  for (const key of Object.keys(environment))
    if (/^(SUPERTAG_|DATABASE_URL$|VAULT_|AWS_)/u.test(key)) delete environment[key];
  for (const args of [["--help"], ["control-plane", "--help"], ["migrate", "--help"]]) {
    const { stdout } = await exec(process.execPath, ["dist/index.js", ...args], {
      cwd: directory,
      env: environment,
      maxBuffer: 1024 * 1024,
    });
    if (!stdout.trim()) throw new Error(`Deployed CLI produced no help for ${args.join(" ")}`);
  }
  process.stdout.write("Production CLI deployment imports and help commands passed.\n");
} finally {
  try {
    if (originalState) await writeFile(statePath, originalState);
    else await rm(statePath, { force: true });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
