import assert from "node:assert/strict";
import { test } from "node:test";
import { checkCommand, checkProseFlag, commandsIn, parseReference } from "./docs-commands.mjs";

const reference = parseReference(`# CLI

## \`supertag\`

\`\`\`text
Commands:
  tag    Manage Tags
  get    Read resources
  watch  Stream change notices
\`\`\`

## \`supertag tag\`

\`\`\`text
Commands:
  put  Create or replace a Tag
\`\`\`

## \`supertag tag put\`

\`\`\`text
Usage: supertag tag put [OPTIONS] <TAG_ID>

Options:
      --workspace-id <WORKSPACE_ID>
      --expected-revision <EXPECTED_REVISION>
\`\`\`

## \`supertag connect\`

\`\`\`text
Usage: supertag connect [OPTIONS] --name <NAME> <URL>

Arguments:
  <URL>  The Control Plane origin
\`\`\`

## \`supertag get\`

\`\`\`text
Commands:
  tag  Read one Tag [alias: tags]
\`\`\`

## \`supertag get tag\`

\`\`\`text
Usage: supertag get tag [ID]
\`\`\`

## \`supertag watch\`

\`\`\`text
Usage: supertag watch [OPTIONS] [KIND]...

Arguments:
  [KIND]...  Only these kinds [possible values: tag, objective]

Options:
      --limit <LIMIT>
\`\`\`
`);
const check = (command) => checkCommand(reference, command);

test("accepts documented commands, aliases, and placeholders", () => {
  for (const command of [
    "supertag",
    "supertag tag put lead --workspace-id app",
    "supertag get tags",
    "supertag get KIND",
    "supertag watch objective ID --limit 3",
    "supertag tag put lead [--expected-revision N]",
    "supertag --control-plane https://cp.example get tag lead",
  ])
    assert.equal(check(command), null, command);
});

test("rejects unknown subcommands under a known parent", () => {
  assert.match(check("supertag tag frobnicate"), /tag frobnicate/u);
  assert.match(check("supertag frobnicate"), /frobnicate/u);
  assert.match(check("supertag connect worklet"), /URL/u);
  assert.equal(check("supertag connect https://cp.example --name work"), null);
});

test("rejects values a command's first argument does not accept", () => {
  assert.match(check("supertag watch inbox"), /inbox/u);
});

test("rejects unknown flags, including bracketed ones", () => {
  assert.match(check("supertag tag put lead --revision 2"), /--revision/u);
  assert.match(check("supertag tag put lead [--revision N]"), /--revision/u);
});

test("finds inline commands that wrap across lines, and flags in prose", () => {
  const { commands, flags } = commandsIn(
    "Run `supertag get\ntag lead` first.\n\nThen pass `[--revision N]`.\n",
  );
  assert.deepEqual(commands, [{ line: 1, command: "supertag get tag lead" }]);
  assert.deepEqual(flags, [{ line: 4, flag: "[--revision N]" }]);
  assert.match(checkProseFlag(reference, flags[0].flag), /--revision/u);
  assert.equal(checkProseFlag(reference, "--workspace-id"), null);
});

test("joins continued shell lines in fenced blocks", () => {
  const { commands } = commandsIn("```sh\nsupertag tag put lead \\\n  --revision 2\n```\n");
  assert.match(check(commands[0].command), /--revision/u);
});
