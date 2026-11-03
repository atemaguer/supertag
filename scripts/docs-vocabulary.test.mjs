import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { checkDocumentationVocabulary, checkVocabulary } from "./docs-vocabulary.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
test("user documentation follows the controlled vocabulary", () => {
  assert.deepEqual(checkDocumentationVocabulary(root), []);
});
test("rejects bare terms in prose, headings, and link labels", () => {
  assert.equal(
    checkVocabulary("example.md", "# Attempts\nA **Surface** and [Attempt](task.md).\n").length,
    3,
  );
});
test("preserves resource names, wrapped terms, and code identifiers", () => {
  assert.deepEqual(
    checkVocabulary(
      "example.md",
      "Task\nAttempt; **Task Attempt**; Surface\nAccounts. `Surface`\n```ts\ntype Attempt = Surface;\n```\n[Task Attempt](#Attempt)",
    ),
    [],
  );
});
