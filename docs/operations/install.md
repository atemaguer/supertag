# Install SuperTag

Install the `supertag` command to run Tags, persistent AI actors with their own responsibilities
and permissions, on your repositories. One installation holds everything a machine needs:

| Part | What it is |
| --- | --- |
| `supertag` | The CLI. It also runs the **Control Plane** (the service that stores your organization and schedules work), the **Gateway** (the service that connects collaboration surfaces such as Slack), and the **Worker Host** (the process that runs work on a machine) |
| `supertag-tui` | The terminal UI that plain `supertag` opens |
| `supertag-shared-execution` | An optional shared execution provider for Cursor Tasks |
| Node bridges | The harness adapters for Claude Code, Cursor, and OpenCode, run with your Node.js |

Codex runs through an adapter built into `supertag`. The installer still checks Node.js and
tests the Node bridges with it, so every installation needs Node.js.

## Before you start

Check the [requirements](requirements.md) for git, Node.js, supported platforms, and sign-in for
a **harness**, the connection to an agent system such as Claude Code or Codex. If this machine
ran the earlier TypeScript runtime, [retire it first](#retire-the-earlier-typescript-runtime).

## Retire the earlier TypeScript runtime

This SuperTag replaces the earlier TypeScript runtime and starts from fresh state; there is no
importer. Its installer replaces the earlier `supertag` link in `~/.local/bin`, and its
`supertag down` does not stop the earlier runtime's services. Do these steps before you install,
while `supertag` is still the earlier CLI. The earlier CLI stays installed afterwards, at
`~/.local/share/supertag/versions/VERSION/node_modules/.bin/supertag`.

1. Stop the earlier services and remove their service units:

   ```sh
   supertag down --remove-services
   ```

   Check that none remains: `launchctl list | grep ai.supertag` on macOS, or
   `systemctl --user list-units 'supertag-*'` on Linux, prints nothing.
2. Archive the earlier state, check the archive, then move the state aside so the new runtime
   starts empty:

   ```sh
   tar -czf ~/supertag-typescript-state.tar.gz -C ~ .supertag
   tar -tzf ~/supertag-typescript-state.tar.gz .supertag/supertag.db
   mv ~/.supertag ~/.supertag-typescript
   ```

   The archive holds `supertag.db`, the local database, with the credentials and history. Keep
   it private.
3. For a shared deployment on PostgreSQL, stop every earlier service, then dump the earlier
   database and check that the dump reads back before you point the new Control Plane at a new,
   empty database:

   ```sh
   pg_dump --format=custom --file supertag-typescript.dump "$EARLIER_DATABASE_URL"
   pg_restore --list supertag-typescript.dump > /dev/null
   ```

Then [install a release archive](#install-a-release-archive) and run `supertag init`.

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

## Next

- [Run your first Tag](../../README.md#run-your-first-tag)
- [Use the CLI](cli.md)
