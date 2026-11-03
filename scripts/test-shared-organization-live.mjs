import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    live: { type: "boolean" },
    "skip-build": { type: "boolean" },
    "restart-control-plane": { type: "boolean" },
    provider: { type: "string" },
    "max-attempts": { type: "string" },
    "max-seconds": { type: "string" },
    "attempt-seconds": { type: "string" },
  },
});
if (!values.live)
  throw new Error("Pass --live to use existing local Claude Code and Codex CLI authentication");
const provider = values.provider ?? "docker";
if (!["docker", "modal"].includes(provider)) throw new Error("Choose --provider docker or modal");
const setupSeconds = provider === "modal" ? 420 : 180;
const cleanupSeconds =
  process.env.SUPERTAG_EXAMPLE_WORKER_HOSTS === "docker" ? 180 : provider === "modal" ? 120 : 60;
function bound(value, fallback, maximum, label) {
  const result = Number(value ?? fallback);
  if (!Number.isSafeInteger(result) || result < 1 || result > maximum)
    throw new Error(`${label} must be an integer from 1 through ${maximum}`);
  return String(result);
}
const maxAttempts = bound(values["max-attempts"], 12, 20, "max-attempts");
const maxSeconds = bound(values["max-seconds"], 600, 900, "max-seconds");
const attemptSeconds = bound(values["attempt-seconds"], 300, 600, "attempt-seconds");
const root = resolve(import.meta.dirname, "..");
const temporary = await mkdtemp(join(tmpdir(), "supertag-public-org-live-"));
const stateParent = join(homedir(), ".supertag", "examples");
await mkdir(stateParent, { recursive: true, mode: 0o700 });
const state = await mkdtemp(join(stateParent, "shared-organization-live-"));
const example = join(temporary, "example");
const run = (command, args, options = {}) =>
  execFileSync(command, args, { cwd: root, stdio: "inherit", ...options });
try {
  if (!values["skip-build"]) run("pnpm", ["build"]);
  const source = join(root, "examples/shared-organization");
  await cp(source, example, {
    recursive: true,
    filter: (path) =>
      !relative(source, path)
        .split(sep)
        .some((part) => ["node_modules", ".git", ".supertag", "state", ".state"].includes(part)),
  });
  run("pnpm", ["--filter", "supertag-ai", "pack", "--pack-destination", temporary]);
  const archives = (await readdir(temporary)).filter((name) => name.endsWith(".tgz"));
  if (archives.length !== 1) throw new Error("Expected exactly one public SDK package archive");
  run(
    "npm",
    [
      "install",
      "--omit=dev",
      "--no-audit",
      "--no-fund",
      "--package-lock=false",
      join(temporary, archives[0]),
    ],
    { cwd: example },
  );
  // Reject an incomplete archive before provisioning a paid sandbox or starting native CLIs.
  const imports = [
    "supertag-ai/core",
    "supertag-ai/worker",
    "supertag-ai/transport",
    "supertag-ai/environments/shared-execution",
    "supertag-ai/harnesses/claude-code",
    "supertag-ai/harnesses/codex",
    ...(provider === "modal" ? ["modal"] : []),
  ];
  run(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `await Promise.all(${JSON.stringify(imports)}.map((name) => import(name)));`,
    ],
    { cwd: example },
  );
  process.stdout.write(`Live organization evidence: ${join(state, "live-report.json")}\n`);
  run("pnpm", ["exec", "vitest", "run", "tests/shared-organization-live.test.ts"], {
    timeout: (Number(maxSeconds) + setupSeconds + cleanupSeconds + 60) * 1000,
    env: {
      ...process.env,
      SUPERTAG_SHARED_ORGANIZATION_LIVE: "1",
      SUPERTAG_LIVE_EXAMPLE_DIRECTORY: example,
      SUPERTAG_EXAMPLE_STATE: state,
      SUPERTAG_EXAMPLE_PROVIDER: provider,
      SUPERTAG_EXAMPLE_MCP: "1",
      SUPERTAG_LIVE_MAX_ATTEMPTS: maxAttempts,
      SUPERTAG_LIVE_MAX_SECONDS: maxSeconds,
      SUPERTAG_EXAMPLE_ATTEMPT_MS: String(Number(attemptSeconds) * 1000),
      SUPERTAG_LIVE_RESTART_CONTROL_PLANE: values["restart-control-plane"] ? "1" : "0",
    },
  });
} finally {
  // The test owns cleanup; repeat the example's idempotent cleanup after a failed test process.
  let cleanupConfirmed = false;
  try {
    run(process.execPath, [join(example, "organization.mjs"), "cleanup"], {
      cwd: example,
      timeout: cleanupSeconds * 1000,
      env: { ...process.env, SUPERTAG_EXAMPLE_STATE: state },
    });
    cleanupConfirmed = true;
  } catch {
    process.exitCode = 1;
    process.stderr.write(
      `Cleanup could not be confirmed. The installed example is retained at ${example}.\n` +
        `Inspect the private state at ${state} and retry cleanup from that installation.\n`,
    );
  }
  if (cleanupConfirmed) await rm(temporary, { recursive: true, force: true });
}
