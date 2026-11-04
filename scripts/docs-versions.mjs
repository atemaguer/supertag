// User docs must name the current registry release, not a local package archive.
// These pages show version pairs as illustrative examples, so their versions are not checked.
const illustrativeVersions = new Set([
  "docs/guides/troubleshooting.md",
  "docs/reference/api-stability.md",
]);
// Contributors pack and install the package to test it.
const archiveAllowed = new Set(["CONTRIBUTING.md"]);

/** Python spells a prerelease such as 0.2.0-alpha.2 as 0.2.0a2. */
export function pythonVersion(version) {
  return version.replace(
    /-(alpha|beta|rc)\.(\d+)$/u,
    (_, kind, number) => `${{ alpha: "a", beta: "b", rc: "rc" }[kind]}${number}`,
  );
}

export function versionProblems(name, text, current) {
  const problems = [];
  const lineOf = (index) => text.slice(0, index).split("\n").length;
  if (!illustrativeVersions.has(name)) {
    const allowed = new Set([current, pythonVersion(current)]);
    const pattern = /\b\d+\.\d+\.\d+(?:-(?:alpha|beta|rc)\.\d+|(?:a|b|rc)\d+)(?![\w.]|-\d)/gu;
    for (const match of text.matchAll(pattern)) {
      if (!allowed.has(match[0]))
        problems.push(
          `${name}:${lineOf(match.index)}: names ${match[0]}; the release is ${current}`,
        );
    }
  }
  if (!archiveAllowed.has(name)) {
    for (const match of text.matchAll(/\.(?:tgz|whl)\b/gu))
      problems.push(
        `${name}:${lineOf(match.index)}: names a package archive; link docs/operations/install.md`,
      );
  }
  return problems;
}
