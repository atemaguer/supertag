#!/usr/bin/env node
// Runs one shard of the Core workspace's test binaries.
//
//   node scripts/core-test-shard.mjs SHARD TOTAL [-- TEST-ARGS...]
//
// Builds every test binary once (`cargo test --workspace --all-features --no-run`), assigns the
// binaries to TOTAL shards by their recorded run time, and runs this shard's binaries one after
// another, as `cargo test` would: from the package directory, with TEST-ARGS passed to each.
// Shard 1 also runs the doc tests. Run from the repository root or core/.
//
// SUPERTAG_CORE_SHARD_HEAD_START gives shard 1 a head start in seconds, for work the job runs
// besides tests (lint, package checks), so the assignment leaves it fewer tests.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Seconds per test binary in the unsharded runtime job (Core run 43848147359, SQLite and
// PostgreSQL cases together). Binaries not listed count as DEFAULT_SECONDS. Refresh when a
// shard runs much longer than the others.
const RECORDED_SECONDS = {
  transport_runtime: 246,
  cursor_runtime: 144,
  crash_durability: 87,
  placement_runtime: 74,
  memory_eval_runtime: 70,
  tunnel_runtime: 67,
  split_runtime: 50,
  replicas_runtime: 46,
  language_runtime: 45,
  approvals_contract: 42,
  github_workspace_runtime: 42,
  tag_sessions_contract: 40,
  native_codex: 39,
  workspace_mount_runtime: 37,
  host_readiness_runtime: 32,
  supertag_worker_host: 25,
  operator_runtime: 24,
  local_services: 21,
  supertag_control_plane: 21,
  opencode_runtime: 20,
  workspace_runtime: 11,
  slack_threads: 11,
  slack_socket_runtime: 11,
  supertag_gateway: 10,
  work_sessions_runtime: 8,
  host_workspaces_runtime: 8,
  linear_runtime: 8,
  placement_contract: 7,
  objective_overview_contract: 7,
  session_branch_runtime: 6,
  teams_runtime: 6,
  coordination_runtime: 6,
  supertag_api: 6,
};
const DEFAULT_SECONDS = 2;

const separator = process.argv.indexOf("--");
const positional = process.argv.slice(2, separator === -1 ? undefined : separator);
const testArgs = separator === -1 ? [] : process.argv.slice(separator + 1);
const shard = Number(positional[0]);
const total = Number(positional[1]);
if (
  positional.length !== 2 ||
  !Number.isInteger(shard) ||
  !Number.isInteger(total) ||
  shard < 1 ||
  shard > total
) {
  console.error("usage: node scripts/core-test-shard.mjs SHARD TOTAL [-- TEST-ARGS...]");
  process.exit(2);
}
const headStart = Number(process.env.SUPERTAG_CORE_SHARD_HEAD_START ?? 0);

const core = resolve(dirname(fileURLToPath(import.meta.url)), "..", "core");
const cargo = process.env.CARGO ?? "cargo";

// Cargo gives the processes it runs the `[env]` table of each .cargo/config.toml from core/ up
// (the nearer file wins; the environment wins over both). Only plain `KEY = "value"` entries are
// supported; anything else stops the run rather than silently dropping a setting.
const cargoEnv = {};
for (let directory = core; ; directory = dirname(directory)) {
  const file = join(directory, ".cargo", "config.toml");
  if (existsSync(file)) {
    let inEnv = false;
    for (const raw of readFileSync(file, "utf8").split("\n")) {
      const line = raw.trim();
      if (line === "" || line.startsWith("#")) continue;
      if (line.startsWith("[")) {
        inEnv = line === "[env]";
        continue;
      }
      if (!inEnv) continue;
      const entry = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*"([^"\\]*)"$/.exec(line);
      if (!entry) {
        console.error(`unsupported [env] entry in ${file}: ${line}`);
        process.exit(2);
      }
      if (!(entry[1] in cargoEnv)) cargoEnv[entry[1]] = entry[2];
    }
  }
  if (dirname(directory) === directory) break;
}
const workspace = ["--locked", "--workspace", "--all-features"];

const build = spawnSync(
  cargo,
  ["test", ...workspace, "--no-run", "--message-format=json-render-diagnostics"],
  {
    cwd: core,
    stdio: ["ignore", "pipe", "inherit"],
    maxBuffer: 256 * 1024 * 1024,
    encoding: "utf8",
  },
);
if (build.status !== 0) process.exit(build.status ?? 1);

const binaries = [];
for (const line of build.stdout.split("\n")) {
  if (!line.startsWith("{")) continue;
  const message = JSON.parse(line);
  if (message.reason !== "compiler-artifact" || !message.profile?.test || !message.executable)
    continue;
  const name = message.target.name.replaceAll("-", "_");
  binaries.push({
    label: `${message.target.kind.join(",")} ${message.target.name} (${message.manifest_path})`,
    executable: message.executable,
    directory: dirname(message.manifest_path),
    seconds: RECORDED_SECONDS[name] ?? DEFAULT_SECONDS,
  });
}
if (binaries.length === 0) {
  console.error("cargo built no test binaries");
  process.exit(1);
}

// Longest first onto the least-loaded shard; ties keep a stable order so every shard computes
// the same assignment.
binaries.sort((a, b) => b.seconds - a.seconds || a.label.localeCompare(b.label));
const loads = Array.from({ length: total }, (_, index) => (index === 0 ? headStart : 0));
const mine = [];
for (const binary of binaries) {
  const target = loads.indexOf(Math.min(...loads));
  loads[target] += binary.seconds;
  if (target === shard - 1) mine.push(binary);
}
console.log(
  `shard ${shard}/${total}: ${mine.length} of ${binaries.length} test binaries, ` +
    `about ${loads[shard - 1] - (shard === 1 ? headStart : 0)}s (shards: ${loads.join("s, ")}s)`,
);

const failures = [];
for (const binary of mine) {
  if (!existsSync(binary.executable)) {
    failures.push(`${binary.label}: missing ${binary.executable}`);
    continue;
  }
  console.log(`\n     Running ${binary.label}`);
  const run = spawnSync(binary.executable, testArgs, {
    cwd: binary.directory,
    stdio: "inherit",
    env: { ...cargoEnv, ...process.env, CARGO_MANIFEST_DIR: binary.directory },
  });
  if (run.status !== 0) failures.push(`${binary.label}: exit ${run.status ?? run.signal}`);
}

if (shard === 1) {
  console.log("\n     Running doc tests");
  const docs = spawnSync(cargo, ["test", ...workspace, "--doc"], { cwd: core, stdio: "inherit" });
  if (docs.status !== 0) failures.push(`doc tests: exit ${docs.status ?? docs.signal}`);
}

if (failures.length > 0) {
  console.error(`\nshard ${shard}/${total} failed:\n  ${failures.join("\n  ")}`);
  process.exit(1);
}
console.log(`\nshard ${shard}/${total} passed`);
