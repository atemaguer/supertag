#!/usr/bin/env node
// Installs the Claude Code CLI at the version the pinned Claude Agent SDK targets, for CI.
// SuperTag runs the user's installed CLI, so tests that start a real harness need it on PATH.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// The harness package links its SDK under its own node_modules; read the SDK's manifest there.
const manifest = fileURLToPath(
  new URL(
    "../packages/runtime/harnesses/claude-code/node_modules/@anthropic-ai/claude-agent-sdk/package.json",
    import.meta.url,
  ),
);
const claudeVersion = JSON.parse(readFileSync(manifest, "utf8")).claudeCodeVersion;
const packages = [`@anthropic-ai/claude-code@${claudeVersion}`];
process.stdout.write(`Installing ${packages.join(" ")}\n`);
if (process.argv.includes("--print")) process.exit(0);
execFileSync("npm", ["install", "--global", "--no-audit", "--no-fund", ...packages], {
  stdio: "inherit",
});
