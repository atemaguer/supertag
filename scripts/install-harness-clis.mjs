#!/usr/bin/env node
// Installs the Claude Code and Codex CLIs at the versions the pinned SDKs target, for CI. SuperTag
// runs the user's installed CLIs, so tests that start a real harness need them on PATH.
import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

// Each harness package links its SDK under its own node_modules; read the SDKs' manifests there.
const harness = (name, path) =>
  fileURLToPath(
    new URL(`../packages/runtime/harnesses/${name}/node_modules/${path}`, import.meta.url),
  );
const read = (path) => JSON.parse(readFileSync(path, "utf8"));
const claudeVersion = read(
  harness("claude-code", "@anthropic-ai/claude-agent-sdk/package.json"),
).claudeCodeVersion;
// pnpm links packages; resolve the SDK's own dependencies from its real location.
const codexSdk = createRequire(realpathSync(harness("codex", "@openai/codex-sdk/package.json")));
const codexVersion = read(codexSdk.resolve("@openai/codex/package.json")).version;
const packages = [`@anthropic-ai/claude-code@${claudeVersion}`, `@openai/codex@${codexVersion}`];
process.stdout.write(`Installing ${packages.join(" ")}\n`);
if (process.argv.includes("--print")) process.exit(0);
execFileSync("npm", ["install", "--global", "--no-audit", "--no-fund", ...packages], {
  stdio: "inherit",
});
