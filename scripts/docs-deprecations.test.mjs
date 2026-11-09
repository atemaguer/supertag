import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { deprecatedDocProblems, documentedApiEndpoints } from "./docs-deprecations.mjs";

test("extracts API routes even when HTTP verbs are padded", () => {
  const routes = documentedApiEndpoints(
    "```text\nGET  /api/v1/auth-keys/:name\nPUT  /api/v1/tags/:name/worker-hosts/:workerHostId\nPOST /api/v1/auth-keys/:name/revoke\n```",
  );
  assert.deepEqual(routes, [
    { line: 2, method: "GET", path: "/api/v1/auth-keys/:name" },
    { line: 3, method: "PUT", path: "/api/v1/tags/:name/worker-hosts/:workerHostId" },
    { line: 4, method: "POST", path: "/api/v1/auth-keys/:name/revoke" },
  ]);
});

test("rejects removed commands, Tag profile flags, and pairing instructions", () => {
  for (const text of [
    "supertag tag permission allow builder runtime",
    "supertag tag context COMMAND",
    "supertag tag add builder slack",
    "supertag get presences",
    "supertag create tag builder --worker-profile local-codex",
    "supertag tag create builder --worker-profile-revision 1",
    "**Pairing token matches** on both sides",
    "Only the harness's main manager receives coordination tools.",
    "supertag get tags",
    "supertag describe permissionset engineering",
    "supertag get worker-hosts",
    "supertag list tags",
  ])
    assert.equal(deprecatedDocProblems("example.md", text).length, 1, text);
});

test("preserves current storage and harness isolation contracts", () => {
  assert.deepEqual(
    deprecatedDocProblems(
      "example.md",
      "S3ArtifactStore stores Worker Host copies. Manager-only tools isolate native subagents. Worker Host credentials authenticate Worklets. supertag create tag builder --worker-host laptop",
    ),
    [],
  );
});

test("reports the source line", () => {
  assert.match(
    deprecatedDocProblems("example.md", "Title\n\nsupertag get presences")[0],
    /^example\.md:3:/u,
  );
});

test("agent skills contain no removed setup instructions", () => {
  for (const skill of ["configure-tags", "connect-a-surface", "run-a-worker", "troubleshoot"]) {
    const name = `skills/${skill}/SKILL.md`;
    const text = readFileSync(new URL(`../${name}`, import.meta.url), "utf8");
    assert.deepEqual(deprecatedDocProblems(name, text), []);
  }
});
