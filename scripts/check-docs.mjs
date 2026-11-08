// Checks user documentation, agent skills, and SDK READMEs against the CLI and itself:
// every `supertag` command names an ACTION RESOURCE pair listed by `supertag --help` and
// flags listed there or by that command's own --help, relative links and heading anchors resolve, and docs follow
// the repository's documentation rules. Run `pnpm build` first; help comes from
// the built CLI so docs are checked against the command inventory users see.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkDocumentationNodeVersions } from "./check-docs-node.mjs";
import { deprecatedDocProblems } from "./docs-deprecations.mjs";
import { checkLinks, checkOrphans } from "./docs-links.mjs";
import { versionProblems } from "./docs-versions.mjs";
import { checkDocumentationVocabulary } from "./docs-vocabulary.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
execFileSync(
  process.execPath,
  [
    "--test",
    ...["check-install-docs", "docs-versions"].map((n) => join(root, `scripts/${n}.test.mjs`)),
  ],
  { stdio: "inherit" },
);
const release = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
// Keep the Objective-writing entry point available from the documentation index.
const objectiveGuide = "guides/write-an-objective.md";
if (!existsSync(join(root, "docs", objectiveGuide)))
  throw new Error(`docs/${objectiveGuide}: Objective-writing guide is missing`);
if (!readFileSync(join(root, "docs/README.md"), "utf8").includes(`](${objectiveGuide})`))
  throw new Error("docs/README.md: link the Objective-writing guide");

const cli = join(root, "apps/cli/dist/index.js");
if (!existsSync(cli)) throw new Error("Build the CLI first: pnpm build");

// Internal design records are gitignored and must not be linked or checked.
const internal = /(architecture|product-brief)[^/]*\.md$/u;
// Contributors use the checkout shortcut; the operations page compares invocation forms.
const checkoutFormAllowed = new Set(["CONTRIBUTING.md", "docs/operations/control-plane.md"]);

function markdownFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return markdownFiles(path);
    return entry.name.endsWith(".md") && !internal.test(entry.name) ? [path] : [];
  });
}
const files = [
  ...["README.md", "SECURITY.md", "CONTRIBUTING.md"].map((name) => join(root, name)),
  ...markdownFiles(join(root, "docs")),
  ...markdownFiles(join(root, "skills")),
  ...["packages", "sdks"].flatMap((directory) =>
    readdirSync(join(root, directory), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(root, directory, entry.name, "README.md"))
      .filter(existsSync),
  ),
];

// --- Command inventory from help text -------------------------------------------------------
// An empty state directory keeps help invocations from reading or creating local state.
const state = mkdtempSync(join(tmpdir(), "supertag-docs-check-"));
process.on("exit", () => rmSync(state, { recursive: true, force: true }));
const runHelp = (args) =>
  execFileSync(process.execPath, [cli, ...args, "--help"], {
    encoding: "utf8",
    env: { ...process.env, SUPERTAG_STATE_DIR: state },
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 10_000,
  });
const help = runHelp([]);
const alternatives = (token) => token.split("|");
const variable = (token) => /^[A-Z][A-Z0-9_]*$/u.test(token) || token.includes("|");
const inventory = new Map(); // "action resource" -> { flags: Set, openFlags: boolean }
const actionOnly = new Map(); // action -> same shape, for forms such as `supertag team create`
function register(map, key, line) {
  const entry = map.get(key) ?? { flags: new Set(), openFlags: false };
  for (const [flag] of line.matchAll(/--[a-z][a-z0-9-]*/gu)) entry.flags.add(flag);
  // Placeholders such as "[provider scope flags]" or "[arguments]" admit flags help cannot list.
  if (/\[(provider [a-z ]+|flags|arguments)\]/u.test(line)) entry.openFlags = true;
  map.set(key, entry);
}
for (const raw of help.split("\n")) {
  const line = raw.trim();
  if (!line.startsWith("supertag ")) continue;
  // Skip whole bracketed option groups, so `[--by tag|objective|day]` is not read as a resource.
  const tokens = [];
  let depth = 0;
  for (const token of line.split(/\s+/u).slice(1)) {
    if (depth === 0 && !token.startsWith("[")) tokens.push(token);
    depth += (token.match(/\[/gu) ?? []).length - (token.match(/\]/gu) ?? []).length;
  }
  if (!tokens.length) continue;
  const [first, second] = tokens;
  if (first.startsWith("--")) continue;
  if (second && !second.startsWith("--") && !/^[A-Z]/u.test(second)) {
    for (const action of alternatives(first))
      for (const resource of alternatives(second)) {
        if (first === "team" || first === "coordinate") register(actionOnly, action, line);
        else register(inventory, `${action} ${resource}`, line);
      }
  } else for (const action of alternatives(first)) register(actionOnly, action, line);
}
const globalFlags = new Set(["--control-plane", "--help", "--version", "--output"]);
// Top-level help summarizes; a command's own --help lists its complete options. Output that
// repeats the top-level help means the command has no specific help.
const commandHelpFlags = new Map();
function commandFlags(action, resource) {
  const key = `${action} ${resource}`;
  if (!commandHelpFlags.has(key)) {
    let text = "";
    try {
      text = runHelp([action, resource]);
    } catch (error) {
      text = `${error.stdout ?? ""}`;
    }
    commandHelpFlags.set(
      key,
      text.trim() === help.trim()
        ? new Set()
        : new Set([...text.matchAll(/--[a-z][a-z0-9-]*/gu)].map(([flag]) => flag)),
    );
  }
  return commandHelpFlags.get(key);
}

// --- Extraction -----------------------------------------------------------------------------
function commandsIn(text) {
  const found = [];
  let fence = null;
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const marker = line.match(/^\s*(```+|~~~+)\s*([\w-]*)/u);
    if (marker) {
      fence = fence ? null : marker[2] || "text";
      continue;
    }
    if (fence && /^(sh|bash|shell|zsh|console|text)$/u.test(fence)) {
      let command = line.replace(/^\s*\$\s+/u, "");
      let end = index;
      while (command.trimEnd().endsWith("\\") && end + 1 < lines.length)
        command = `${command.trimEnd().slice(0, -1)} ${lines[++end].trim()}`;
      // Allow leading environment assignments: FOO=bar supertag ...
      const match = command.match(/^\s*(?:[A-Z_][A-Z0-9_]*=\S*\s+)*supertag(\s.*)?$/u);
      if (match) found.push({ line: index + 1, command: `supertag${match[1] ?? ""}` });
      index = end;
    } else if (!fence) {
      for (const span of line.matchAll(/`(supertag\s[^`]+)`/gu))
        found.push({ line: index + 1, command: span[1] });
    }
  }
  return found;
}

function checkCommand({ command }) {
  const words = command
    .replace(/\s+#.*$/u, "")
    .replace(/["'][^"']*["']/gu, "VALUE")
    .split(/\s+/u)
    .slice(1);
  // Strip the global Control Plane selector wherever it appears before the action.
  while (words[0]?.startsWith("--")) {
    if (words[0] === "--control-plane") words.splice(0, 2);
    else if (words[0] === "--help" || words[0] === "--version") return null;
    else return `unknown global flag ${words[0]}`;
  }
  const [action, resource] = words;
  if (!action || action === "..." || variable(action)) return null;
  const knownAction =
    actionOnly.has(action) || [...inventory.keys()].some((key) => key.startsWith(`${action} `));
  // Prose may name an action alone ("the `supertag watch` command"). A placeholder resource is
  // valid only where help uses one itself, such as `supertag coordinate COMMAND`.
  if (knownAction && !resource) return null;
  if (resource && variable(resource) && !resource.includes("|")) {
    if (actionOnly.has(action)) return null;
    return `\`supertag ${action} ${resource}\` needs a resource listed by supertag --help`;
  }
  const pair = resource && inventory.get(`${action} ${resource}`);
  const entry = pair || actionOnly.get(action);
  if (!entry)
    return resource
      ? `\`supertag ${action} ${resource}\` is not in supertag --help`
      : `\`supertag ${action}\` is not in supertag --help`;
  if (entry.openFlags) return null;
  let unknown = words
    .filter((word) => /^--[a-z]/u.test(word))
    .map((word) => word.split("=")[0])
    .filter((flag) => !entry.flags.has(flag) && !globalFlags.has(flag));
  if (unknown.length && pair) {
    const documented = commandFlags(action, resource);
    unknown = unknown.filter((flag) => !documented.has(flag));
  }
  return unknown.length
    ? `flag ${[...new Set(unknown)].join(", ")} not listed for \`supertag ${action}${pair ? ` ${resource}` : ""}\` in supertag --help`
    : null;
}

// --- Links and anchors ------------------------------------------------------------------------
// Long sections are hard to scan. They are reported but do not fail the check.
const sectionWordLimit = 600;
function longSections(name, text) {
  const found = [];
  let heading = "(top)";
  let line = 1;
  let words = 0;
  let fenced = false;
  const flush = () => {
    if (words > sectionWordLimit)
      found.push(
        `${name}:${line}: section "${heading}" has ${words} words (over ${sectionWordLimit})`,
      );
  };
  text.split("\n").forEach((content, index) => {
    if (/^\s*(```|~~~)/u.test(content)) fenced = !fenced;
    const match = !fenced && content.match(/^#{1,3}\s+(.+)$/u);
    if (match) {
      flush();
      heading = match[1];
      line = index + 1;
      words = 0;
    } else if (!fenced) words += content.split(/\s+/u).filter(Boolean).length;
  });
  flush();
  return found;
}

// --- Run --------------------------------------------------------------------------------------
const problems = [
  ...checkDocumentationNodeVersions(root),
  ...checkDocumentationVocabulary(root),
  ...checkOrphans(root, markdownFiles(join(root, "docs"))),
];
// README explains the Objective-driven way of working before Get started.
const readme = readFileSync(join(root, "README.md"), "utf8");
const positioningHeading = "## How you use SuperTag";
const positioningStart = readme.indexOf(positioningHeading);
const positioning =
  positioningStart < 0
    ? ""
    : readme.slice(positioningStart + positioningHeading.length).split(/^## /mu)[0];
if (positioningStart < 0 || positioningStart > readme.indexOf("## Get started"))
  problems.push("README.md: explain how SuperTag is meant to be used before Get started");
for (const required of [
  /Objective/u,
  /outcome/iu,
  /done.when evidence/iu,
  /constraints/iu,
  /budget/iu,
  /deadline/iu,
  /steer/iu,
  /decisions/iu,
  /findings/iu,
  /approvals/iu,
  /\]\(docs\/guides\/write-an-objective\.md\)/u,
  /\]\(docs\/guides\/talk-to-a-tag\.md\)/u,
  /\]\(docs\/concepts\/interaction-model\.md\)/u,
])
  if (!required.test(positioning))
    problems.push(`README.md: usage section must include ${required}`);
const warnings = [];
// The first reply must lead to a runnable example of the Team promised on the first screen.
if (!/\]\(docs\/guides\/first-team\.md\)/u.test(readme.split(/^## /mu)[0]))
  problems.push("README.md: link the first Team walkthrough before the first section");
const teamGuide = join(root, "docs/guides/first-team.md");
if (!existsSync(teamGuide)) problems.push("docs/guides/first-team.md: missing Team walkthrough");
if (!/\]\(guides\/first-team\.md\)/u.test(readFileSync(join(root, "docs/README.md"), "utf8")))
  problems.push("docs/README.md: link the first Team walkthrough");
let commandCount = 0;
for (const file of files) {
  const name = relative(root, file);
  const text = readFileSync(file, "utf8");
  problems.push(...deprecatedDocProblems(name, text));
  problems.push(...versionProblems(name, text, release));
  problems.push(...checkLinks(root, file, text));
  if (!checkoutFormAllowed.has(name))
    text.split("\n").forEach((line, index) => {
      if (/\bpnpm supertag\b/u.test(line))
        problems.push(`${name}:${index + 1}: use \`supertag\`, not \`pnpm supertag\`, in docs`);
      // Workspace scripts belong in CONTRIBUTING.md, not user documentation.
      // The root README keeps a Contributing section, so only docs/ is checked.
      else if (
        name.startsWith("docs/") &&
        /(^|[\s`])(pnpm (?!add\b|dlx\b)\S+|tsx scripts\/|node scripts\/|vitest\b)/u.test(line)
      )
        problems.push(
          `${name}:${index + 1}: contributor command in user docs; move it to CONTRIBUTING.md`,
        );
    });
  warnings.push(...longSections(name, text));
  for (const found of commandsIn(text)) {
    commandCount++;
    const problem = checkCommand(found);
    if (problem) problems.push(`${name}:${found.line}: ${problem}`);
  }
}
if (warnings.length) console.warn(`${warnings.join("\n")}\n`);
if (problems.length) {
  console.error(problems.join("\n"));
  console.error(`\n${problems.length} documentation problem(s) in ${files.length} files.`);
  process.exit(1);
}
console.log(`Documentation check passed: ${files.length} files, ${commandCount} commands.`);
