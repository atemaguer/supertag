# Verify native release platforms

The native archive includes the Rust CLI, the matching Go terminal UI, the shared
execution provider, and all five private Node helpers. These contributor commands build
and execute local archives without publishing them or changing an installed command.
Optional model credentials remain external and are not used by these checks.

The supported archive platforms are `linux-amd64`, `linux-arm64`, `darwin-amd64`, and
`darwin-arm64`. Each build records its exact source commit and lockfile digests. A separate
build receipt records the Rust, Cargo, Go, Node, pnpm, and Python versions. The CLI, TUI,
provider, and native helper assets must match the selected platform. A cross-compiled
binary alone is not a completed platform verification.

## Linux, including Docker emulation

Use a clean checkout and its full commit SHA. The Docker entry point builds in Debian 12,
matching the base distribution of the native service images. It uses a digest-pinned Rust
image, checksum-pinned Node and Go archives, and the repository's pinned pnpm version.
Docker must support the requested architecture, natively or through emulation.

```sh
uv run rust/scripts/native_release_docker.py --repo . --commit FULL_COMMIT_SHA \
  --platform linux-amd64 --output /tmp/supertag-linux-amd64-verification
```

Choose `linux-arm64` for ARM64. Add `--profile dev` for a faster development verification.
The source bundle is read-only, the container uses your UID, execution is limited to two
CPUs and 6 GiB, and only the output directory persists. No host credential directory or
Docker socket is mounted. The owned build container is removed; the local builder image
remains as a reusable cache. Its identity is recorded in the builder receipt.

## macOS, including Intel execution through Rosetta

Use native tools on an Intel Mac for `darwin-amd64` and an Apple Silicon Mac for
`darwin-arm64`. Select Node 22.13 or later in the 22.x line, pnpm 11.18.0, Go 1.26.1,
Python 3.13, tmux, and the Rust toolchain pinned in `rust/rust-toolchain.toml`.

```sh
uv run rust/scripts/native_release.py package --repo . --commit FULL_COMMIT_SHA \
  --expect-platform darwin-arm64 --output /tmp/supertag-macos-verification --install-smoke
```

For a repeatable Intel verification on Apple Silicon, Rosetta must already be available.
The following command downloads checksum-pinned Node/Go, Python 3.13.9, and the pinned
Intel Rust toolchain into a disposable directory. It does not change your system tools.

```sh
uv run rust/scripts/native_release_macos_x64.py --repo . --commit FULL_COMMIT_SHA \
  --output /tmp/supertag-macos-amd64-verification
```

Use `--tools-directory /path/to/new-private-directory` to retain downloaded tools for
inspection. Without it, they are removed after the run. For manual tool provisioning, run the
packaging Python interpreter and Node as x86_64 binaries, and put the pinned x86_64 Rust
toolchain's actual `bin` directory first in `PATH`. Keep downloaded tools and Rustup/Cargo
homes in a disposable directory. Use `--expect-platform darwin-amd64`. The preflight refuses
mixed Python/Node/Rust architectures before a build; it does not silently relabel ARM64
output. Go can cross-compile the TUI, whose architecture and actual execution are then
checked. Do not install or change system Rosetta as part of a release verification.

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

The `native-release-check.yml` workflow has a fast `contracts` mode and a full
four-platform `package` mode. Run it manually, or add the `release-check` label to a pull request
to run the full `package` mode on its head commit. Its explicit host labels follow the
[GitHub runner reference](https://docs.github.com/en/actions/reference/runners/github-hosted-runners). It uses read-only repository permissions and has no upload,
registry, release, signing, or notarization step. The existing TypeScript release, npm,
and installer-channel workflows remain separate until an explicit cutover.
