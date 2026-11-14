import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { pythonVersion, workspaceVersion } from "./docs-versions.mjs";

const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
const files = [
  "README.md",
  "docs/operations/install.md",
  "skills/SKILLS.md",
  "skills/install-and-first-reply/SKILL.md",
  "skills/deploy-supertag/SKILL.md",
];
for (const file of files) {
  test(`${file} installs the native release`, () => {
    const text = read(file).split("## Contributing")[0];
    // The npm package and its installer script installed the retired TypeScript CLI.
    assert.doesNotMatch(text, /npm install -g supertag-ai|unpkg\.com|supertag-ai@latest/iu);
    assert.match(
      text,
      /releases\/latest\/download\/install\.sh|\]\([^)]*operations\/install\.md/iu,
    );
  });
}

test("the install guide installs a GitHub Release and can build an archive", () => {
  const install = read("docs/operations/install.md");
  assert.match(install, /releases\/latest\/download\/install\.sh \| sh/u);
  assert.match(install, /rust\/scripts\/native_release\.py package/u);
  assert.match(install, /rust\/scripts\/install_native_release\.py/u);
});

test("application guides install the published TypeScript SDK", () => {
  for (const file of ["README.md", "docs/operations/install.md", "packages/supertag-ai/README.md"])
    assert.match(read(file), /npm install supertag-ai\b/u, file);
});

test("Python installation pins the matching PyPI prerelease", () => {
  const version = pythonVersion(workspaceVersion(read("rust/Cargo.toml")));
  for (const file of ["README.md", "docs/operations/install.md", "sdks/python/README.md"]) {
    assert.ok(read(file).includes(`python -m pip install 'supertag==${version}'`), file);
    assert.doesNotMatch(read(file), /pip install .*sdks\/python|preview is unpublished/u);
  }
});

test("the user install guide keeps source-development scripts in CONTRIBUTING.md", () => {
  assert.doesNotMatch(read("docs/operations/install.md"), /^\s*pnpm\s/mu);
  assert.match(read("CONTRIBUTING.md"), /pnpm supertag/u);
});
