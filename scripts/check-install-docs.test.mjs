import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const files = [
  "README.md",
  "docs/operations/install.md",
  "skills/SKILLS.md",
  "skills/install-and-first-reply/SKILL.md",
  "skills/deploy-supertag/SKILL.md",
  "packages/supertag-ai/README.md",
];
for (const file of files) {
  test(`${file} uses repository installation`, () => {
    const text = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
    assert.doesNotMatch(
      text,
      /npm\s+(?:install|i)\s+(?:-g|--global)\s+supertag-ai\b|\.tgz\b|\barchive\b|\btarball\b|ask a maintainer|npm\s+`?latest`?/iu,
    );
    assert.match(text, /install:cli|\]\([^)]*operations\/install\.md/iu);
  });
}
test("only the install guide announces future packages", () => {
  const matches = files.filter((file) =>
    /npm and PyPI packages come later/u.test(
      readFileSync(new URL(`../${file}`, import.meta.url), "utf8"),
    ),
  );
  assert.deepEqual(matches, ["docs/operations/install.md"]);
});

test("docs check allows only the install guide's exact installer commands", async () => {
  const { isInstallCommand } = await import("./docs-install-commands.mjs");
  for (const command of ["pnpm install", "pnpm install:cli", "pnpm uninstall:cli"])
    assert.equal(isInstallCommand("docs/operations/install.md", command), true);
  for (const command of ["pnpm test", "pnpm install:cli-extra", "pnpm install && pnpm test"])
    assert.equal(isInstallCommand("docs/operations/install.md", command), false);
  assert.equal(isInstallCommand("docs/guides/workers.md", "pnpm install:cli"), false);
  const checker = readFileSync(new URL("./check-docs.mjs", import.meta.url), "utf8");
  assert.match(checker, /!isInstallCommand\(name, line\)/u);
});
