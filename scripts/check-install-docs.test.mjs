import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { pythonVersion } from "./docs-versions.mjs";

const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
const files = [
  "README.md",
  "docs/operations/install.md",
  "skills/SKILLS.md",
  "skills/install-and-first-reply/SKILL.md",
  "skills/deploy-supertag/SKILL.md",
];
for (const file of files) {
  test(`${file} uses published CLI installation`, () => {
    const text = read(file).split("## Contributing")[0];
    assert.doesNotMatch(text, /pnpm install:cli|git clone|npm and PyPI packages come later/u);
    assert.match(text, /npm install -g supertag-ai|\]\([^)]*operations\/install\.md/iu);
  });
}

test("application guides install the published TypeScript SDK", () => {
  for (const file of [
    "README.md",
    "docs/guides/custom-workers.md",
    "docs/guides/modal-workers.md",
  ]) {
    assert.match(read(file), /npm install supertag-ai\b/u);
    assert.doesNotMatch(read(file), /npm install \/absolute\/path\/to\/supertag/u);
  }
});

test("Python installation pins the matching PyPI prerelease", () => {
  const version = pythonVersion(JSON.parse(read("package.json")).version);
  for (const file of [
    "README.md",
    "docs/operations/install.md",
    "docs/guides/python-workers.md",
    "sdks/python/README.md",
  ]) {
    assert.ok(read(file).includes(`python -m pip install 'supertag==${version}'`), file);
    assert.doesNotMatch(read(file), /pip install .*sdks\/python|preview is unpublished/u);
  }
  for (const file of ["docs/guides/python-workers.md", "sdks/python/README.md"])
    for (const extra of ["codex", "agents", "codex,agents"])
      assert.ok(
        read(file).includes(`python -m pip install 'supertag[${extra}]==${version}'`),
        file,
      );
});

test("the user install guide keeps source-development scripts in CONTRIBUTING.md", () => {
  assert.doesNotMatch(read("docs/operations/install.md"), /\bpnpm\s/u);
  assert.match(read("CONTRIBUTING.md"), /pnpm supertag/u);
});
