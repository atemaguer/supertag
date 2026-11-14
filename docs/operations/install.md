# Install SuperTag

Install the `supertag` command to run Tags, persistent AI actors with their own responsibilities
and permissions, on your repositories. One installation holds everything a machine needs:

| Part | What it is |
| --- | --- |
| `supertag` | The CLI. It also runs the **Control Plane** (the service that stores your organization and schedules work), the **Gateway** (the service that connects collaboration surfaces such as Slack), and the **Worker Host** (the process that runs work on a machine) |
| `supertag-tui` | The terminal UI that plain `supertag` opens |
| `supertag-shared-execution` | An optional shared execution provider for Cursor Tasks |
| Node bridges | The harness adapters for Claude Code, Cursor, and OpenCode, run with your Node.js |

Codex runs through an adapter built into `supertag` and needs no Node.js.

## Before you start

Check the [requirements](requirements.md) for git, Node.js, supported platforms, and sign-in for
a **harness**, the connection to an agent system such as Claude Code or Codex.

## Install a release archive

A SuperTag release is one archive per platform: `linux-amd64`, `linux-arm64`, `darwin-amd64`, or
`darwin-arm64`. The installer verifies the archive and its checksum, checks the Node.js it will
use, installs the release under `~/.local/share/supertag`, and links `supertag` into
`~/.local/bin`. It never starts services or reads existing SuperTag state.

Release archives are not published yet. Until they are, build the archive for your machine from
a clean checkout. The build needs the Rust toolchain pinned in `rust/rust-toolchain.toml`, Go,
Node.js with pnpm, Python 3.13, and [uv](https://docs.astral.sh/uv/):

```sh
git clone https://github.com/atemaguer/supertag.git
cd supertag
uv run rust/scripts/native_release.py package --repo . --commit "$(git rev-parse HEAD)" \
  --output "$HOME/supertag-build"
uv run rust/scripts/install_native_release.py "$HOME"/supertag-build/supertag-*-complete.tar.gz
export PATH="$HOME/.local/bin:$PATH"
supertag --version
```

Add the `export` line to your shell startup file to use the command in new terminals. To choose
other locations, set these before running the installer:

| Variable | Default |
| --- | --- |
| `SUPERTAG_INSTALL_ROOT` | `~/.local/share/supertag` |
| `SUPERTAG_BIN_DIR` | `~/.local/bin` |

Installing a newer archive keeps the older release beside it and switches the `supertag` link
only after the new release passes its checks.

## Build only the CLI

For a server or container that runs only the Control Plane or a Gateway, the CLI alone is
enough. It also runs Codex Tasks:

```sh
cargo build --release --locked --manifest-path rust/Cargo.toml -p supertag-cli --bin supertag
```

Put `rust/target/release/supertag` on your `PATH`. Without the release archive's Node bridges, a
Worker Host runs Claude Code, Cursor, or OpenCode only when you name a built adapter entrypoint
with `--harness-entrypoint`. Container images for hosted platforms are described in
[Self-host SuperTag](../guides/self-hosting.md).

## Client libraries

Applications call the Control Plane's gRPC API. Generated Go, TypeScript, and Python bindings
live in [`rust/bindings`](../../rust/bindings/README.md). See
[Control Plane API](../reference/control-plane-api.md) for how to connect.

## Upgrade

Install the newer archive the same way. Then restart this machine's services with
`supertag up`, which waits for running Task Attempts before replacing a service. For a hosted
deployment, follow [Upgrade a deployment](control-plane.md#upgrade-a-deployment).

## Match the CLI and the Control Plane

Your CLI, the terminal UI, the desktop app, and Worker Hosts negotiate a protocol version with
the Control Plane on every connection, and refuse a Control Plane that speaks none of theirs.
Check what is running:

```sh
supertag version
```

It prints this CLI's version and the versions of the services `supertag up` runs on this machine.
Upgrade the CLI and the Control Plane together.

## Coming from the TypeScript runtime

This SuperTag replaces the earlier TypeScript runtime and starts from fresh state. It does not
read, change, or import the earlier runtime's `~/.supertag` contents or database. Before you run
`supertag init` on a machine that used the earlier runtime:

1. Stop the earlier services with the earlier CLI.
2. Move the earlier state aside, for example `mv ~/.supertag ~/.supertag-typescript`. Keep it
   if you may need its history.
3. Run `supertag init` to create new state.

A shared deployment needs a new, empty database. Keep the earlier database as an archive; there
is no importer.

## Next

- [Run your first Tag](../../README.md#run-your-first-tag)
- [Use the CLI](cli.md)
