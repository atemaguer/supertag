// Prints what one translated README, or all of them, must fix: node scripts/check-readme-translation.mjs [code]
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { translationPath, translationProblems } from "./readme-translations.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const only = process.argv[2];
const problems = translationProblems(root).filter(
  (problem) => !only || problem.startsWith(`${translationPath(only)}:`),
);
console.log(problems.length ? problems.join("\n") : "ok");
process.exit(problems.length ? 1 : 0);
