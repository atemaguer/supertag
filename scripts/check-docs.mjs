// Checks user documentation, agent skills, and SDK READMEs against the CLI and itself: every
// `supertag` command and flag appears in the generated CLI reference (docs/reference/cli.md),
// relative links and heading anchors resolve, and docs follow the repository's documentation rules.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkDocumentationNodeVersions } from "./check-docs-node.mjs";
import { checkCommand, checkProseFlag, commandsIn, parseReference } from "./docs-commands.mjs";
import { deprecatedDocProblems } from "./docs-deprecations.mjs";
import { checkLinks, checkOrphans } from "./docs-links.mjs";
import { versionProblems, workspaceVersion } from "./docs-versions.mjs";
import { checkDocumentationVocabulary } from "./docs-vocabulary.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
execFileSync(
  process.execPath,
  [
    "--test",
    ...[
      "check-install-docs",
      "check-docs-node",
      "docs-commands",
      "docs-deprecations",
      "docs-links",
      "docs-versions",
      "docs-vocabulary",
    ].map((n) => join(root, `scripts/${n}.test.mjs`)),
  ],
  { stdio: "inherit" },
);
const release = workspaceVersion(readFileSync(join(root, "rust/Cargo.toml"), "utf8"));
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

// --- Command inventory from the CLI reference ----------------------------------------------
// docs/reference/cli.md is generated from the help of every visible command, and
// rust/crates/cli/tests/cli_help.rs fails when the CLI's help no longer matches it.
const reference = "docs/reference/cli.md";
const cli = parseReference(readFileSync(join(root, reference), "utf8"));

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
  const { commands, flags } = commandsIn(text);
  for (const found of commands) {
    commandCount++;
    const problem = checkCommand(cli, found.command);
    if (problem) problems.push(`${name}:${found.line}: ${problem} in ${reference}`);
  }
  // CONTRIBUTING.md describes flags of repository scripts, not of the CLI.
  for (const found of name === "CONTRIBUTING.md" ? [] : flags) {
    const problem = checkProseFlag(cli, found.flag);
    if (problem) problems.push(`${name}:${found.line}: ${problem} in ${reference}`);
  }
}
if (warnings.length) console.warn(`${warnings.join("\n")}\n`);
if (problems.length) {
  console.error(problems.join("\n"));
  console.error(`\n${problems.length} documentation problem(s) in ${files.length} files.`);
  process.exit(1);
}
console.log(`Documentation check passed: ${files.length} files, ${commandCount} commands.`);
