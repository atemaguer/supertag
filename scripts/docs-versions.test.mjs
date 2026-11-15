import assert from "node:assert/strict";
import { test } from "node:test";
import { pythonVersion, versionProblems, workspaceVersion } from "./docs-versions.mjs";

const current = "0.2.0-alpha.2";

test("accepts the current release and its Python spelling", () => {
  assert.equal(pythonVersion(current), "0.2.0a2");
  assert.deepEqual(
    versionProblems("docs/x.md", "Version `0.2.0-alpha.2`, or `0.2.0a2`.", current),
    [],
  );
});

test("flags another release", () => {
  assert.deepEqual(versionProblems("docs/x.md", "a\nThe version is `0.2.0-alpha.1`.", current), [
    "docs/x.md:2: names 0.2.0-alpha.1; the release is 0.2.0-alpha.2",
  ]);
  assert.equal(versionProblems("docs/x.md", "version `0.2.0a1`", current).length, 1);
});

test("flags any other SuperTag release, not only prereleases", () => {
  const release = "0.3.0";
  const stale = [
    "python -m pip install 'supertag==0.2.9'",
    "npm install --global supertag-ai@0.4.0",
    "curl -LO https://github.com/atemaguer/supertag/releases/download/v0.2.0/install.sh",
    "tar -xzf supertag-0.2.0-aarch64-apple-darwin-complete.tar.gz",
    "image: ghcr.io/atemaguer/supertag-control-plane:0.2.0",
    "SuperTag 0.2.0 adds Teams.",
    "This page describes SuperTag `v0.2.0`.",
    "SUPERTAG_VERSION=0.2.0 sh install.sh",
    "The cutover needs the SuperTag release 0.2.1 or later.",
    "Upgrade from v0.3.0-alpha.1 first.",
  ];
  for (const line of stale)
    assert.equal(versionProblems("docs/x.md", line, release).length, 1, line);
  assert.deepEqual(versionProblems("docs/x.md", "a\npip install 'supertag==0.2.9'", release), [
    "docs/x.md:2: names 0.2.9; the release is 0.3.0",
  ]);
  assert.deepEqual(
    versionProblems(
      "docs/x.md",
      "pip install 'supertag==0.3.0'\nreleases/download/v0.3.0/install.sh\nsupertag-ai@0.3.0",
      release,
    ),
    [],
  );
});

test("ignores other tools' versions and dotted addresses", () => {
  const text = [
    "- **Node.js 22.13.0 or a later 22.x release**",
    "| `codex` | 0.156.0. Install or upgrade |",
    "uv run --with PyYAML==6.0.3 scripts/legacy_archive.py",
    "npm install -g pnpm@11.18.0",
    "export SUPERTAG_CONTROL_PLANE_PUBLISH=0.0.0.0:443",
    "listens on `127.0.0.1:3434` for supertag 127.0.0.1",
  ].join("\n");
  assert.deepEqual(versionProblems("docs/x.md", text, "0.3.0"), []);
});

test("leaves history its releases", () => {
  const text = "SuperTag 0.2.0 shipped the first Rust Control Plane. 0.3.0-alpha.1 followed.";
  assert.deepEqual(versionProblems("CHANGELOG.md", text, "0.3.0"), []);
  assert.deepEqual(versionProblems("docs/development/cutover-runbook.md", text, "0.3.0"), []);
  assert.deepEqual(
    versionProblems("docs/guides/x.md", "Verified in SuperTag 0.2.0 on macOS.", "0.3.0"),
    [],
  );
  assert.equal(
    versionProblems("docs/guides/x.md", "Verified in May. SuperTag 0.2.0 is required.", "0.3.0")
      .length,
    1,
  );
});

test("allows illustrative version pairs", () => {
  assert.deepEqual(
    versionProblems("docs/guides/troubleshooting.md", "CLI is 0.3.0 but 0.2.0-alpha.1", current),
    [],
  );
});

test("flags package-archive installs outside CONTRIBUTING.md", () => {
  const text = "npm install --global /path/to/supertag-ai-0.2.0-alpha.2.tgz\n";
  assert.equal(versionProblems("docs/guides/x.md", text, current).length, 1);
  assert.equal(
    versionProblems("skills/x/SKILL.md", "pip install ./supertag-0.2.0a2.whl", current).length,
    1,
  );
  assert.deepEqual(versionProblems("CONTRIBUTING.md", text, current), []);
});

test("flags an old release and an archive inside a file name", () => {
  const text = "With a wheel, use\n`'/path/to/supertag-0.2.0a1-py3-none-any.whl[codex]'`.";
  assert.deepEqual(versionProblems("docs/guides/x.md", text, current), [
    "docs/guides/x.md:2: names 0.2.0a1; the release is 0.2.0-alpha.2",
    "docs/guides/x.md:2: names a package archive; link docs/operations/install.md",
  ]);
});

test("the release version is core/Cargo.toml's workspace version", () => {
  assert.equal(
    workspaceVersion(
      '[package]\nversion = "9.9.9"\n\n[workspace.package]\nedition = "2024"\nversion = "0.3.0-alpha.1"\n',
    ),
    "0.3.0-alpha.1",
  );
  assert.throws(() => workspaceVersion('[package]\nversion = "9.9.9"\n'), /no workspace version/u);
});
