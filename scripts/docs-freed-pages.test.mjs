import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { checkVocabulary } from "./docs-vocabulary.mjs";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("init sign-in guidance follows the per-harness check", () => {
  const init = read("apps/cli/src/init.ts");
  assert.match(init, /not signed in \(the credential check did not succeed\)/u);
  for (const path of ["README.md", "docs/guides/troubleshooting.md"])
    assert.match(read(path), /not signed in \(the credential check did not succeed\)/u);
});

test("newly freed pages use the public vocabulary", () => {
  for (const path of [
    "docs/concepts/persistence.md",
    "docs/guides/workspaces.md",
    "docs/guides/modal-workers.md",
    "docs/reference/mailbox.md",
    "docs/reference/coordination.md",
    "docs/reference/worker.md",
    "docs/operations/install.md",
    "docs/operations/cli.md",
  ])
    assert.deepEqual(checkVocabulary(path, read(path)), []);
});

test("checkout installation builds the SDK before local application installation", () => {
  for (const path of [
    "README.md",
    "docs/operations/install.md",
    "skills/install-and-first-reply/SKILL.md",
  ])
    assert.doesNotMatch(read(path), /^pnpm install\npnpm install:cli$/mu);
  const modal = read("docs/guides/modal-workers.md");
  assert.match(
    modal,
    /install and build the checkout[\s\S]*\.\.\/operations\/install\.md[\s\S]*npm install \/absolute\/path\/to\/supertag\/packages\/supertag-ai/u,
  );
});
