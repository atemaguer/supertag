import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { checkLinks, checkOrphans } from "./docs-links.mjs";

const root = resolve(import.meta.dirname, "..");
function pages(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory()
      ? pages(path)
      : entry.name.endsWith(".md") && !/(architecture|product-brief)[^/]*\.md$/u.test(entry.name)
        ? [path]
        : [];
  });
}
test("every public docs page is linked directly from the index", () => {
  assert.deepEqual(checkOrphans(root, pages(resolve(root, "docs"))), []);
});
test("relative links in README, docs, and skills resolve", () => {
  const files = [
    resolve(root, "README.md"),
    ...pages(resolve(root, "docs")),
    ...pages(resolve(root, "skills")),
  ];
  assert.deepEqual(
    files.flatMap((file) => checkLinks(root, file, readFileSync(file, "utf8"))),
    [],
  );
});

test("broken skill links and heading anchors are reported", () => {
  const file = resolve(root, "skills/run-a-worker/SKILL.md");
  assert.deepEqual(checkLinks(root, file, "[missing](missing.md)"), [
    "skills/run-a-worker/SKILL.md:1: broken link missing.md",
  ]);
  assert.deepEqual(
    checkLinks(root, file, "[missing](../../README.md#nonexistent-heading-for-test)"),
    ["skills/run-a-worker/SKILL.md:1: missing anchor #nonexistent-heading-for-test in README.md"],
  );
  assert.deepEqual(checkLinks(root, file, "```md\n[example](missing.md)\n```"), []);
});

test("SDK README skips absent generated docs but checks source docs", () => {
  const file = resolve(root, "packages/supertag-ai/README.md");
  assert.deepEqual(
    checkLinks(
      root,
      file,
      "[generated](dist/docs/missing-guide.md)\n[source](../../docs/missing-guide.md)",
    ),
    ["packages/supertag-ai/README.md:2: broken link ../../docs/missing-guide.md"],
  );
});

test("reference definitions and angle-bracket destinations are checked", () => {
  const file = resolve(root, "README.md");
  assert.deepEqual(checkLinks(root, file, "[guide]: missing.md\n[guide](<missing file.md>)"), [
    "README.md:1: broken link missing.md",
    "README.md:2: broken link missing file.md",
  ]);
});

test("first-reply diagnostic keeps init services and the bound host running", () => {
  const skill = readFileSync(resolve(root, "skills/install-and-first-reply/SKILL.md"), "utf8");
  const diagnostic = skill.split("## Connectivity check")[1]?.split("## Verify the setup")[0];
  assert.ok(diagnostic, "the skill includes a connectivity diagnostic");
  assert.doesNotMatch(
    diagnostic,
    /supertag down|supertag start control-plane|SUPERTAG_WORKLET_TRANSPORT/u,
  );
  for (const command of [
    "supertag status",
    "supertag get host",
    "supertag describe tag lead",
    "supertag get surface-location",
    "supertag watch task",
    "supertag describe task TASK_ID",
    "supertag logs",
  ]) {
    assert.ok(diagnostic.includes(command), `diagnostic includes ${command}`);
  }
});
test("links to this repository's files by GitHub URL resolve", () => {
  const file = resolve(root, "packages/supertag-ai/README.md");
  const base = "https://github.com/atemaguer/supertag/blob/main";
  assert.deepEqual(checkLinks(root, file, `[ok](${base}/docs/README.md)`), []);
  assert.equal(checkLinks(root, file, `[gone](${base}/docs/guides/removed.md)`).length, 1);
  assert.equal(
    checkLinks(root, file, `[anchor](${base}/docs/README.md#no-such-heading)`).length,
    1,
  );
  assert.deepEqual(
    checkLinks(root, file, "[other](https://github.com/other/repo/blob/main/x.md)"),
    [],
  );
});
