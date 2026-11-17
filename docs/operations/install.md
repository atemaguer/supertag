# Install SuperTag

Install the `supertag` command to run Tags, persistent AI actors with their own responsibilities
and permissions, on your repositories. One installation holds everything a machine needs:

| Part | What it is |
| --- | --- |
| `supertag` | The CLI. It also runs the **Control Plane** (the service that stores your organization and schedules work), the **Gateway** (the service that connects collaboration surfaces such as Slack), and the **Worker Host** (the process that runs work on a machine) |
| `supertag-tui` | The terminal UI that plain `supertag` opens |
| `supertag-shared-execution` | An optional shared execution provider for Cursor Tasks |
| Node bridges | The harness adapters for Claude Code, Cursor, and OpenCode, run with your Node.js |

Codex runs through an adapter built into `supertag` and needs no Node.js. The installer prints a
notice when Node.js 22.13.0 or a later 22.x release is not on `PATH`.

## Before you start

Check the [requirements](requirements.md) for git, Node.js, supported platforms, and sign-in for
a **harness**, the connection to an agent system such as Claude Code or Codex.

## Install a release archive

A SuperTag release is one archive per platform: `linux-amd64`, `linux-arm64`, or `darwin-arm64`,
attached to its GitHub Release with a `SHA256SUMS` file and an installer script. The installer
script works on Linux and on Apple silicon Macs; Intel Macs have no release, so
[build the CLI](#build-only-the-cli) there instead:

```sh
curl -fsSL https://github.com/atemaguer/supertag/releases/latest/download/install.sh | sh
export PATH="$HOME/.local/bin:$PATH"
supertag --version
```

It downloads your platform's archive and checks it against the release's `SHA256SUMS` before
unpacking it. It checks that `supertag` and the terminal UI report the release's version, then
installs the release under `~/.local/share/supertag` and links `supertag` into `~/.local/bin`.
It never starts services or reads existing SuperTag state. Add the `export` line to your shell
startup file to use the command in new terminals.

To choose the locations or a version, set these before `sh`:

| Variable | Default |
| --- | --- |
| `SUPERTAG_VERSION` | The release the script came from. Set a version, such as `0.3.0`, to install that release |
| `SUPERTAG_INSTALL_ROOT` | `$XDG_DATA_HOME/supertag` when `XDG_DATA_HOME` is set, otherwise `~/.local/share/supertag` |
| `SUPERTAG_BIN_DIR` | `$XDG_BIN_HOME` when it is set, otherwise `~/.local/bin` |

Installing a newer release keeps the older one beside it and switches the `supertag` link only
after the new release passes its checks. The script replaces a symbolic link at
`~/.local/bin/supertag` and refuses to replace any other file there.

### Build an archive from a checkout

To install a commit that has no release, build the archive for your machine from a clean
checkout. The build needs the Rust toolchain pinned in `core/rust-toolchain.toml`, Go, Node.js
with pnpm, Python 3.13, and [uv](https://docs.astral.sh/uv/):

```sh
git clone https://github.com/atemaguer/supertag.git
cd supertag
uv run scripts/native_release.py package --repo . --commit "$(git rev-parse HEAD)" \
  --output "$HOME/supertag-build"
uv run scripts/install_native_release.py "$HOME"/supertag-build/supertag-*-complete.tar.gz
```

`install_native_release.py` checks and installs the archive as the installer script does, and
reads the same `SUPERTAG_INSTALL_ROOT` and `SUPERTAG_BIN_DIR`.

## Build only the CLI

For a server or container that runs only the Control Plane or a Gateway, or on an Intel Mac,
which has no release archive, build the CLI alone. It also runs Codex Tasks:

```sh
cargo build --release --locked --manifest-path core/Cargo.toml -p supertag-cli --bin supertag
```

Put `core/target/release/supertag` on your `PATH`. Without the release archive's Node bridges, a
Worker Host runs Claude Code, Cursor, or OpenCode only when you name a built adapter entrypoint
with `--harness-entrypoint`. Container images for hosted platforms are described in
[Self-host SuperTag](../guides/self-hosting.md).

## Client libraries

Applications call the Control Plane's gRPC API. The TypeScript SDK is `supertag-ai` on npm:

```sh
npm install supertag-ai
```

The Python SDK is `supertag` on PyPI, in Python 3.10 or newer. Install the version that matches
your CLI:

```sh
python -m pip install 'supertag==0.3.0'
```

Each SDK connects to a Control Plane and lets a custom harness adapter talk to its Worker Host;
see [API stability](../reference/api-stability.md#package-entry-points). Generated Go,
TypeScript, and Python bindings live beside the SDKs in [`sdks/`](../../sdks/README.md). See
[Control Plane API](../reference/control-plane-api.md) for how to connect.

## Upgrade

Run the installer script again, or install a newer archive the same way. Then restart this
machine's services with `supertag up`, which waits for running Task Attempts before replacing a
service. For a hosted deployment, follow [Upgrade a deployment](control-plane.md#upgrade-a-deployment).

## Check the CLI and the local services

Your CLI, the terminal UI, the desktop app, and Worker Hosts negotiate a protocol version with
the Control Plane on every connection, and refuse a Control Plane that speaks none of theirs. The
error names both releases and which to upgrade, such as `This CLI speaks SuperTag protocol 3, but
the Control Plane at http://127.0.0.1:3434 runs SuperTag 0.3.0 (protocol 2). Upgrade the Control
Plane.`
Check what is running:

```sh
supertag version
```

It prints this CLI's version and the versions of the services `supertag up` runs on this machine.
Upgrade the CLI and the Control Plane together.

## Next

- [Run your first Tag](../../README.md#run-your-first-tag)
- [Use the CLI](cli.md)
