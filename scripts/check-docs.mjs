// Checks user documentation, agent skills, and SDK READMEs against the CLI and itself: every
// `supertag` command names a command and flags listed in rust/docs/cli-reference.md, the
// reference generated from the Rust CLI's help; relative links and heading anchors resolve; and
// docs follow the repository's documentation rules. Pages listed in docs-pending-cli.txt still
// describe the removed TypeScript CLI: their commands are not checked until they are rewritten.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
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

// --- CLI reference ----------------------------------------------------------------------------
const nativeCommands = new Map(); // "host enroll" -> Set of flags its help lists
for (const section of readFileSync(join(root, "rust/docs/cli-reference.md"), "utf8")
  .split(/^## /mu)
  .slice(1)) {
  // The top-level `supertag` section is the command with no subcommand: the terminal UI.
  const heading = section.match(/^`supertag(?: ([^`]+))?`/u);
  if (heading)
    nativeCommands.set(
      heading[1] ?? "",
      new Set([...section.matchAll(/--[a-z][a-z0-9-]*/gu)].map(([flag]) => flag)),
    );
}
function checkCommand({ command }) {
  const words = command
    .replace(/\s+#.*$/u, "")
    .replace(/["'][^"']*["']/gu, "VALUE")
    .split(/\s+/u)
    .slice(1);
  const path = [];
  for (const word of words) {
    if (word.startsWith("-")) break;
    path.push(word);
  }
  let key;
  for (let length = path.length; length >= 0 && key === undefined; length--) {
    const candidate = path.slice(0, length).join(" ");
    if (nativeCommands.has(candidate) && (length > 0 || path.length === 0)) key = candidate;
  }
  if (key === undefined)
    return `\`supertag ${path.slice(0, 2).join(" ")}\` is not in rust/docs/cli-reference.md`;
  const unknown = words
    .filter((word) => /^--[a-z]/u.test(word))
    .map((word) => word.split("=")[0])
    .filter((flag) => flag !== "--help" && !nativeCommands.get(key).has(flag));
  return unknown.length
    ? `flag ${[...new Set(unknown)].join(", ")} not listed for \`supertag ${key}\` in rust/docs/cli-reference.md`
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
// Explain the Objective-driven way of working before the quickstart.
const readme = readFileSync(join(root, "README.md"), "utf8");
const positioningHeading = "## How Tags work together";
const quickstartHeading = "## Run your first Tag";
const positioningStart = readme.indexOf(positioningHeading);
const quickstartStart = readme.indexOf(quickstartHeading);
const positioning =
  positioningStart < 0
    ? ""
    : readme.slice(positioningStart + positioningHeading.length).split(/^## /mu)[0];
if (positioningStart < 0 || quickstartStart < 0 || positioningStart > quickstartStart)
  problems.push("README.md: explain how SuperTag is meant to be used before the quickstart");
for (const required of [
  /Objective/u,
  /outcome/iu,
  /evidence.*when it.s done/isu,
  /constraints/iu,
  /budget/iu,
  /deadline/iu,
  /steer/iu,
  /decisions/iu,
  /findings/iu,
  /approvals?/iu,
  /\]\(docs\/guides\/write-an-objective\.md\)/u,
  /\]\(docs\/concepts\/interaction-model\.md\)/u,
])
  if (!required.test(positioning))
    problems.push(`README.md: usage section must include ${required}`);
const warnings = [];
// The quickstart should help readers continue after their first reply.
const quickstart =
  quickstartStart < 0
    ? ""
    : readme.slice(quickstartStart + quickstartHeading.length).split(/^## /mu)[0];
for (const guide of ["talk-to-a-tag", "first-team"])
  if (!quickstart.includes(`](docs/guides/${guide}.md)`))
    problems.push(`README.md: link docs/guides/${guide}.md from the quickstart`);
const teamGuide = join(root, "docs/guides/first-team.md");
if (!existsSync(teamGuide)) problems.push("docs/guides/first-team.md: missing Team walkthrough");
if (!/\]\(guides\/first-team\.md\)/u.test(readFileSync(join(root, "docs/README.md"), "utf8")))
  problems.push("docs/README.md: link the first Team walkthrough");
// Pages that still describe the TypeScript CLI. Remove a page once its commands are rewritten.
const pending = new Set(
  readFileSync(join(root, "scripts/docs-pending-cli.txt"), "utf8")
    .split("\n")
    .filter((line) => line && !line.startsWith("#")),
);
for (const name of pending)
  if (!existsSync(join(root, name)))
    problems.push(`scripts/docs-pending-cli.txt: ${name} does not exist`);
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
  if (pending.has(name)) continue;
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
console.log(
  `Documentation check passed: ${files.length} files, ${commandCount} commands checked, ${pending.size} pages pending the Rust CLI.`,
);
