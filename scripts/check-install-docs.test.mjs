import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

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
    // The npm package and its installer script install the retired TypeScript CLI.
    assert.doesNotMatch(text, /npm install -g supertag-ai|supertag-ai@latest\/install\.sh/u);
    assert.match(text, /install_native_release\.py|\]\([^)]*operations\/install\.md/iu);
  });
}

test("the install guide builds and installs a native release archive", () => {
  const install = read("docs/operations/install.md");
  assert.match(install, /rust\/scripts\/native_release\.py package/u);
  assert.match(install, /rust\/scripts\/install_native_release\.py/u);
});

test("the user install guide keeps source-development scripts in CONTRIBUTING.md", () => {
  assert.doesNotMatch(read("docs/operations/install.md"), /^\s*pnpm\s/mu);
  assert.match(read("CONTRIBUTING.md"), /pnpm supertag/u);
});
