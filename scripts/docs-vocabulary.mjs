import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Parallel Objectives own these pages. Remove exclusions when their vocabulary fixes land.
export const deferredVocabularyPages = new Set([
  "docs/guides/workers.md",
  "docs/guides/deploy-modal.md",
  "docs/guides/objective-overview.md",
  "docs/reference/artifacts.md",
  "docs/reference/supertag-yaml.md",
]);

export function vocabularyFiles(root) {
  return execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" })
    .split("\0")
    .filter(
      (name) =>
        (name === "README.md" ||
          name === "SECURITY.md" ||
          /^(docs|skills)\/.*\.md$/u.test(name) ||
          /^(packages|sdks)\/.*\/README\.md$/u.test(name)) &&
        !/(architecture|product-brief)[^/]*\.md$/u.test(name) &&
        !deferredVocabularyPages.has(name),
    );
}

// Preserve newlines for diagnostics. Code identifiers, examples, and link destinations
// keep their exact spelling; link labels and emphasized prose remain checked.
export function vocabularyProse(text) {
  const blank = (value) => value.replace(/[^\n]/gu, " ");
  return text
    .replace(/^\s*(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\s*\1\s*$/gmu, blank)
    .replace(/(`+)[^`]*?\1/gu, blank)
    .replace(/\]\([^)]*\)/gu, blank)
    .replace(/<[^>]*>/gu, blank)
    .replace(/[*_]/gu, "");
}

export function checkVocabulary(name, text) {
  const prose = vocabularyProse(text);
  const problems = [];
  for (const match of prose.matchAll(/\bAttempts?\b|\bSurfaces?\b/gu)) {
    const before = prose.slice(0, match.index);
    const after = prose.slice(match.index + match[0].length);
    if (match[0].startsWith("Attempt") && /\bTask\s+$/u.test(before)) continue;
    if (match[0] === "Surface" && /^\s+Accounts?\b/u.test(after)) continue;
    const replacement = match[0].startsWith("Attempt") ? "Task Attempt" : "collaboration surface";
    problems.push(`${name}:${before.split("\n").length}: use ${replacement}, not ${match[0]}`);
  }
  return problems;
}

export function checkDocumentationVocabulary(root) {
  return vocabularyFiles(root).flatMap((name) =>
    checkVocabulary(name, readFileSync(join(root, name), "utf8")),
  );
}
