import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { checkVocabulary } from "./docs-vocabulary.mjs";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("newly freed pages use the public vocabulary", () => {
  for (const path of [
    "docs/concepts/persistence.md",
    "docs/guides/workspaces.md",
    "docs/guides/modal-workers.md",
    "docs/reference/coordination.md",
    "docs/reference/worker.md",
    "docs/operations/install.md",
    "docs/operations/cli.md",
  ])
    assert.deepEqual(checkVocabulary(path, read(path)), []);
});

test("Modal Workers install the published SDK", () => {
  const modal = read("docs/guides/modal-workers.md");
  assert.match(modal, /npm install supertag-ai/u);
  assert.doesNotMatch(modal, /install and build the checkout|npm install \/absolute/u);
});
