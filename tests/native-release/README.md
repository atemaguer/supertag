# Verify native release platforms

The native archive includes the Rust CLI, the matching Go terminal UI, the shared
execution provider, and all five private Node helpers. These contributor commands build
and execute local archives without publishing them or changing an installed command.
Optional model credentials remain external and are not used by these checks.

The supported archive platforms are `linux-amd64`, `linux-arm64`, and `darwin-arm64`. Intel
Macs have no archive. Each build records its exact source commit and lockfile digests. A separate
build receipt records the Rust, Cargo, Go, Node, pnpm, and Python versions. The CLI, TUI,
provider, and native helper assets must match the selected platform. A cross-compiled
binary alone is not a completed platform verification.

## Linux, including Docker emulation

Use a clean checkout and its full commit SHA. The Docker entry point builds in Debian 12,
matching the base distribution of the native service images. It uses a digest-pinned Rust
image, checksum-pinned Node and Go archives, and the repository's pinned pnpm version.
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

Use native tools on an Apple silicon Mac. Select Node 22.13 or later in the 22.x line, pnpm
11.18.0, Go 1.26.1, Python 3.13, tmux, and the Rust toolchain pinned in
`core/rust-toolchain.toml`.

```sh
uv run scripts/native_release.py package --repo . --commit FULL_COMMIT_SHA \
  --expect-platform darwin-arm64 --output /tmp/supertag-macos-verification --install-smoke
```

The preflight refuses x86_64 Python, Node, or Rust, such as tools running under Rosetta, before a
build; it does not silently relabel their output.

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
idempotent reinstall through the normal managed command symlink. It tests the real Go UI,
a synthetic OpenCode Task, the shared provider's file access and restart receipts, and all
five helpers' bootstrap boundaries. It checks that an old-state sentinel is preserved.
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
three-platform `package` mode, which builds the three platforms at once. Run it manually, or add
the `release-check` label to a pull request to run the full `package` mode on its head commit. Its
explicit host labels follow the
[GitHub runner reference](https://docs.github.com/en/actions/reference/runners/github-hosted-runners).
It uses read-only repository permissions. On its own it uploads, signs, notarizes, and publishes
nothing; `release.yml` calls it to build the signed archives it attaches to a draft release.
