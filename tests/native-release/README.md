# Verify native release platforms

The native archive includes the Rust CLI, the terminal UI (`supertag-tui`, compiled by the Bun
version in `.bun-version`) with the licenses of the native library it embeds in
`licenses/opentui/`, the shared execution provider, and all five private Node helpers.
`SHIP_TUI` in `scripts/native_archive.py` is the terminal UI's release switch, on: set to `False`,
the archive, the installer checks, the smoke, and the desktop app carry no `supertag-tui` and no
`licenses/opentui/`, and the smoke checks that plain `supertag` says the terminal UI isn't
installed. Set `SUPERTAG_RELEASE_TUI=0` (or `1`) to override it for one local build; CI builds and
tests the terminal UI either way. These contributor commands build and execute local archives without publishing them or changing an installed command.
Optional model credentials remain external and are not used by these checks.

The supported archive platforms are `linux-amd64`, `linux-arm64`, `darwin-arm64`, and
`darwin-amd64`. Each build records its exact source commit and lockfile digests. A separate
build receipt records the Rust, Cargo, Node, pnpm, Bun, and Python versions. The CLI, terminal UI,
provider, and native helper assets must match the selected platform. A cross-compiled
binary alone is not a completed platform verification.

## Linux, including Docker emulation

Use a clean checkout and its full commit SHA. The Docker entry point builds in Debian 12,
matching the base distribution of the native service images. It uses a digest-pinned Rust
image, checksum-pinned Node and Bun archives (Bun's baseline build on amd64, which needs no
AVX2), and the repository's pinned pnpm version.
Docker must support the requested architecture, natively or through emulation.

```sh
uv run scripts/native_release_docker.py --repo . --commit FULL_COMMIT_SHA \
  --platform linux-amd64 --output /tmp/supertag-linux-amd64-verification
```

Choose `linux-arm64` for ARM64. Add `--profile dev` for a faster development verification.
The source bundle is read-only, the container uses your UID, execution is limited to two
CPUs and 6 GiB, and only the output directory persists. No host credential directory or
Docker socket is mounted. `--cargo-cache DIR` also mounts `DIR` writable as the build's Cargo
registry and target directory; see [Reuse dependency builds](#reuse-dependency-builds). The owned build container is removed; the local builder image
remains as a reusable cache. Its identity is recorded in the builder receipt.

## macOS

Use native tools on a Mac of the archive's architecture: an Apple silicon Mac for `darwin-arm64`,
an Intel Mac for `darwin-amd64`. Select Node 22.13 or later in the 22.x line, pnpm 11.18.0, Bun at
the version in `.bun-version` (on Intel, Bun's `darwin-x64-baseline` build, which needs no AVX2,
as the release uses), Python 3.13, and the Rust toolchain pinned in `core/rust-toolchain.toml`.

```sh
uv run scripts/native_release.py package --repo . --commit FULL_COMMIT_SHA \
  --expect-platform darwin-arm64 --output /tmp/supertag-macos-verification --install-smoke
```

The preflight refuses Python, Node, Bun, or Rust of another architecture before a build, such as
x86_64 tools running under Rosetta for `--expect-platform darwin-arm64`; it does not silently
relabel their output. The release builds `darwin-amd64` on an Intel runner, never under Rosetta.

## Reuse dependency builds

`native_release.py package` and `native_release_docker.py` take `--cargo-cache DIR`, which keeps
Cargo's registry in `DIR/home` and its target directory in `DIR/target` instead of disposable
scratch, so a later build reuses compiled third-party crates. The build still starts from the
exact commit: every snapshot file is stamped newer than any cached output, so Cargo rebuilds all
of SuperTag's own crates, and a cache holding Cargo configuration or credentials is refused. The
build receipt records `cargo_cache`. The release workflow restores and saves `DIR` with
`Swatinem/rust-cache`, which saves only dependency builds.

## What a successful run proves

`--install-smoke` includes the extracted smoke and verifies a fresh installation and an
idempotent reinstall through the normal managed command symlink. It tests a
packaged `supertag message` round trip; the terminal UI's version, its embedded OpenTUI library
loading without a terminal, and, on Linux, that it needs no glibc newer than 2.17; plain
`supertag` starting the terminal UI beside it in a pseudo-terminal, which must draw and quit on
Ctrl-C; a synthetic OpenCode Task, the shared provider's file
access and restart receipts, and all five helpers' bootstrap boundaries. It checks that an old-state sentinel is preserved.
It does not use model services, test shared-provider command containment, import legacy
state, sign binaries, notarize applications, or publish a release.

Archive, checksum, build receipt, extracted receipt, and installed receipt are published
into the local output directory together only after the requested checks pass. A failing
installed smoke leaves no final archive. After assembly, disposable compiler caches,
source dependencies, and unpacked staging are removed before the smoke tests extract the
archive; only the exact fixture equipment is retained. Keep temporary paths below a private or sticky
parent; the installer intentionally refuses shared writable non-sticky ancestors.

The smoke tests' fixture adapter is built after the archive with the `supertag-cli` feature
`fixture-adapter`, which turns on no feature of any other crate, so Cargo reuses the release
build's crates and compiles only the adapter. `test-fixtures` includes it and adds the crash points
and test-only behavior of the other crates, which would rebuild all of them.

The `native-release-check.yml` workflow has a fast `contracts` mode and a full
four-platform `package` mode, which builds the four platforms at once. Run it manually, or add
the `release-check` label to a pull request to run the full `package` mode on its head commit. Its
explicit host labels follow the
[GitHub runner reference](https://docs.github.com/en/actions/reference/runners/github-hosted-runners).
It uses read-only repository permissions. On its own it uploads, signs, notarizes, and publishes
nothing; `release.yml` calls it to build the signed archives it attaches to a draft release.
