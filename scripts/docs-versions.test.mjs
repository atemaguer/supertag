import assert from "node:assert/strict";
import { test } from "node:test";
import { pythonVersion, versionProblems } from "./docs-versions.mjs";

const current = "0.2.0-alpha.2";

test("accepts the current release and its Python spelling", () => {
  assert.equal(pythonVersion(current), "0.2.0a2");
  assert.deepEqual(
    versionProblems("docs/x.md", "Version `0.2.0-alpha.2`, or `0.2.0a2`.", current),
    [],
  );
});

test("flags another release", () => {
  assert.deepEqual(versionProblems("docs/x.md", "a\nThe version is `0.2.0-alpha.1`.", current), [
    "docs/x.md:2: names 0.2.0-alpha.1; the release is 0.2.0-alpha.2",
  ]);
  assert.equal(versionProblems("docs/x.md", "version `0.2.0a1`", current).length, 1);
});

test("allows illustrative version pairs", () => {
  assert.deepEqual(
    versionProblems("docs/guides/troubleshooting.md", "CLI is 0.3.0 but 0.2.0-alpha.1", current),
    [],
  );
});

test("flags package-archive installs outside CONTRIBUTING.md", () => {
  const text = "npm install --global /path/to/supertag-ai-0.2.0-alpha.2.tgz\n";
  assert.equal(versionProblems("docs/guides/x.md", text, current).length, 1);
  assert.equal(
    versionProblems("skills/x/SKILL.md", "pip install ./supertag-0.2.0a2.whl", current).length,
    1,
  );
  assert.deepEqual(versionProblems("CONTRIBUTING.md", text, current), []);
});

test("flags an old release and an archive inside a file name", () => {
  const text = "With a wheel, use\n`'/path/to/supertag-0.2.0a1-py3-none-any.whl[codex]'`.";
  assert.deepEqual(versionProblems("docs/guides/x.md", text, current), [
    "docs/guides/x.md:2: names 0.2.0a1; the release is 0.2.0-alpha.2",
    "docs/guides/x.md:2: names a package archive; link docs/operations/install.md",
  ]);
});
