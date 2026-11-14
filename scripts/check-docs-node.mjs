// Keep the user-facing Node requirement tied to the package contract.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

export function checkNodeVersions(name, text, minimum) {
  const problems = [];
  text.split("\n").forEach((line, index) => {
    for (const match of line.matchAll(/\bNode(?:\.js)?\s+`?(?:v|>=?\s*)?(\d+(?:\.\d+){0,2})/giu)) {
      if (match[1] !== minimum)
        problems.push(
          `${name}:${index + 1}: Node.js ${match[1]} differs from engines.node (>=${minimum}); link to docs/operations/requirements.md`,
        );
    }
  });
  return problems;
}

export function checkDocumentationNodeVersions(root) {
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const minimum = manifest.engines.node.match(/^>=(\d+\.\d+\.\d+)$/u)?.[1];
  if (!minimum) throw new Error("Update the docs Node checker for the new engines.node range");
  const problems = [];
  const walk = (path) =>
    readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
      if (entry.name === "node_modules" || entry.name === "dist" || entry.name.startsWith("."))
        return [];
      const child = join(path, entry.name);
      return entry.isDirectory() ? walk(child) : entry.name.endsWith(".md") ? [child] : [];
    });
  const files = [
    ...["README.md", "CONTRIBUTING.md", "SECURITY.md"].map((name) => join(root, name)),
    ...walk(join(root, "docs")).filter(
      (path) => !/(architecture|product-brief)[^/]*\.md$/u.test(path),
    ),
    ...walk(join(root, "skills")),
    ...walk(join(root, "packages")).filter((path) => path.endsWith("/README.md")),
    ...walk(join(root, "sdks")).filter((path) => path.endsWith("/README.md")),
  ];
  for (const file of files)
    problems.push(...checkNodeVersions(relative(root, file), readFileSync(file, "utf8"), minimum));
  return problems;
}
