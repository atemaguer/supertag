import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("first-run README sends readers to sign-in and install before init", () => {
  const beforeInit = read("README.md")
    .split("## Run your first Tag")[1]
    ?.split("\nsupertag init\n")[0];
  assert.ok(beforeInit, "README.md: the first-run section runs supertag init");
  assert.match(beforeInit, /\]\(docs\/operations\/requirements\.md\)/u);
  assert.match(beforeInit, /\]\(docs\/operations\/install\.md\)/u);
});

test("first-run docs explain auth recovery and the build tools", () => {
  assert.match(
    read("docs/guides/troubleshooting.md"),
    /not signed in \(the credential check did not succeed\)[\s\S]*Change the setup/u,
  );
  assert.match(read("docs/operations/requirements.md"), /\*\*Build tools\*\* for \[installing/u);
});
