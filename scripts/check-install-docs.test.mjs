import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { pythonVersion } from "./docs-versions.mjs";

const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
const entryPoints = [
  "README.md",
  "docs/operations/install.md",
  "skills/SKILLS.md",
  "skills/install-and-first-reply/SKILL.md",
  "skills/deploy-supertag/SKILL.md",
];
for (const file of entryPoints) {
  test(`${file} sends readers to the native install`, () => {
    const text = read(file).split("## Contributing")[0];
    assert.match(text, /\]\([^)]*operations\/install\.md|native_release\.py package/u);
  });
}

// The npm package and its installer were removed with the TypeScript runtime.
for (const file of ["README.md", "docs/operations/install.md", "docs/operations/requirements.md"]) {
  test(`${file} does not install the removed npm package`, () => {
    assert.doesNotMatch(
      read(file),
      /supertag-ai|unpkg\.com|npm (?:install|uninstall) -g supertag/u,
    );
  });
}

test("the install guide builds and installs a native archive from a clean commit", () => {
  const install = read("docs/operations/install.md");
  assert.match(
    install,
    /uv run rust\/scripts\/native_release\.py package --commit "\$\(git rev-parse HEAD\)"/u,
  );
  assert.match(install, /uv run rust\/scripts\/install_native_release\.py "\$archive"/u);
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
  assert.doesNotMatch(read("docs/operations/install.md"), /^\s*pnpm\s/mu);
  assert.match(read("CONTRIBUTING.md"), /pnpm supertag/u);
});
