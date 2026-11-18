// User docs must name the current release, not an older or newer one, nor a local package archive.
// These pages show version pairs as illustrative examples, so their versions are not checked: an
// upgrade from the previous release, or a protocol mismatch naming both releases. The install
// guide's PyPI pin is checked separately (check-install-docs.test.mjs).
const illustrativeVersions = new Set([
  "docs/guides/troubleshooting.md",
  "docs/operations/install.md",
  "docs/reference/api-stability.md",
  "docs/reference/control-plane-api.md",
]);
// History names the releases it happened in.
const historical = (name) => name === "CHANGELOG.md" || name.startsWith("docs/development/");
// Contributors pack and install the package to test it.
const archiveAllowed = new Set(["CONTRIBUTING.md"]);

// A version, optionally spelled as a tag (v0.3.0) or in Python form (0.3.0a1), that is not part of
// a longer dotted number such as an IP address. It may end a sentence or a file name (.tgz) or be
// followed by an archive's platform (-aarch64), but never by more of a prerelease.
const versionPattern =
  /(?<![\w.])v?(\d+\.\d+\.\d+(?:-(?:alpha|beta|rc)\.\d+|(?:a|b|rc)\d+)?)(?!\w|\.\d|-(?:\d|alpha|beta|rc))/gu;
const prerelease = /(?:-(?:alpha|beta|rc)\.\d+|(?:a|b|rc)\d+)$/u;
// Text right before a version that makes it a SuperTag version: a package, archive, or image name
// (supertag==, supertag-ai@, supertag-0.3.0-..., supertag-control-plane:), the product name, a
// GitHub release path, or the installer's version variable. Other tools' versions, such as
// Node.js 22.13.0 or PyYAML==6.0.3, have none of these.
const superTagContext =
  /(?:\bsupertag[\w/-]*?(?:\s+(?:version|release))?(?:==|@|:|-|\s+)|releases\/(?:download|tag)\/|SUPERTAG_VERSION[=:]\s*)["'`]?$/iu;
// "Verified in 0.2.0" style history keeps the release it was verified in.
const verifiedHistory = /\bverified\s+(?:in|with|on|against)\b[^.\n]*$/iu;

/** The release version: core/Cargo.toml's workspace.package version. */
export function workspaceVersion(cargoToml) {
  const version = /^\[workspace\.package\]\n(?:[^[\n].*\n)*?version = "([^"]+)"/mu.exec(
    cargoToml,
  )?.[1];
  if (version === undefined) throw new Error("core/Cargo.toml names no workspace version");
  return version;
}

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
  if (!illustrativeVersions.has(name) && !historical(name)) {
    const allowed = new Set([current, pythonVersion(current)]);
    for (const match of text.matchAll(versionPattern)) {
      const version = match[1];
      if (allowed.has(version)) continue;
      const before = text.slice(text.lastIndexOf("\n", match.index) + 1, match.index);
      // A prerelease is always a SuperTag version; a plain one only in a SuperTag context.
      if (!prerelease.test(version) && !superTagContext.test(before)) continue;
      if (verifiedHistory.test(before)) continue;
      problems.push(`${name}:${lineOf(match.index)}: names ${version}; the release is ${current}`);
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
