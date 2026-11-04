import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("first-run README explains sign-in and port choice before init", () => {
  const setup = read("README.md").split("### 2. Set up your repository")[1];
  const beforeInit = setup.split("\nsupertag init\n")[0];
  assert.match(beforeInit, /codex[^`\n]* login/u);
  assert.match(beforeInit, /claude/u);
  assert.match(beforeInit, /3434/u);
  assert.match(
    read("README.md"),
    /Codex file-backed sign-in, `signed in` only means a credential is present and\nreadable/u,
  );
});

test("first-run docs explain auth recovery and npm prerequisites", () => {
  assert.match(
    read("docs/guides/troubleshooting.md"),
    /not signed in \(the credential check did not succeed\)[\s\S]*Change the setup/u,
  );
  assert.match(read("docs/operations/requirements.md"), /\*\*npm\*\*, included with Node\.js/u);
  assert.match(read("skills/install-and-first-reply/SKILL.md"), /select only signed-in harnesses/u);
});
