import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { checkDocumentationNodeVersions, checkNodeVersions } from "./check-docs-node.mjs";

test("rejects old, shortened, and future Node requirements", () => {
  for (const text of [
    "Node.js 20.18.1 or newer",
    "Node 22.13",
    "Node.js `24.0.0`",
    "Node.js >=20.18.1",
  ])
    assert.equal(checkNodeVersions("README.md", text, "22.13.0").length, 1);
  assert.deepEqual(checkNodeVersions("README.md", "Node.js 22.13.0 or newer", "22.13.0"), []);
});

test("all user documentation agrees with package engines", () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  assert.deepEqual(checkDocumentationNodeVersions(root), []);
});

test("requirements describe managed harness telemetry and credential limits", () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const requirements = readFileSync(
    resolve(root, "docs/operations/requirements.md"),
    "utf8",
  ).replace(/\s+/gu, " ");
  assert.match(requirements, /Codex adapter runs `codex app-server`/u);
  assert.match(requirements, /analytics\.enabled=false/u);
  assert.match(requirements, /no supported telemetry opt-out for Claude Code Tasks/u);
  assert.match(requirements, /does not forward `DISABLE_TELEMETRY` or `DISABLE_ERROR_REPORTING`/u);
  assert.match(requirements, /OpenCode receives only provider environment credentials/u);
  assert.match(requirements, /copies `~\/\.codex\/auth\.json`/u);
  assert.match(requirements, /long-lived ChatGPT refresh token/u);
  assert.match(requirements, /leaves `experimental\.openTelemetry` unset/u);
  assert.doesNotMatch(requirements, /opencode\.ai\/docs\/enterprise\//u);
  assert.doesNotMatch(requirements, /Verify the effective harness configuration/u);
});
