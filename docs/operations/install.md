# Install SuperTag

Install the `supertag` command to run Tags, persistent AI actors with their own responsibilities
and permissions, on your repositories. One installation holds everything a machine needs:

| Part | What it is |
| --- | --- |
| `supertag` | The CLI. It also runs the **Control Plane** (the service that stores your organization and schedules work), the **Gateway** (the service clients connect to, which also connects collaboration surfaces such as Slack), and the **Worklet** (`supertag worker-host`, the program that connects a machine to the Control Plane as a **Worker Host** and runs its work) |
| `supertag-tui` | The terminal UI that plain `supertag` opens |
| `supertag-shared-execution` | An optional shared execution provider for Cursor Tasks |
| Node bridges | The harness adapters for Claude Code, Cursor, and OpenCode, run with your Node.js |

Codex runs through an adapter built into `supertag` and needs no Node.js. The installer prints a
notice when the Node.js on `PATH` can't run them: Claude Code needs Node.js 22.13.0 or later, and
Cursor, OpenCode, E2B, and Modal a 22.x release from 22.13.0.

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
| `SUPERTAG_VERSION` | The release the script came from. Set a version, such as `0.3.1`, to install that release |
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

## Install the desktop app

The desktop app gives your conversations with Tags a window of their own, on an Apple silicon Mac
or on Linux (amd64 or arm64). Intel Macs have no desktop app; use the terminal UI there. Get the
files from the [latest release](https://github.com/atemaguer/supertag/releases/latest).

On a Mac:

1. Download `SuperTag-VERSION-darwin-arm64.dmg`, open it, and drag **SuperTag** to
   **Applications**.
2. Open SuperTag from Applications.

The Mac app carries its own `supertag` CLI, terminal UI, and Node.js bridges, so it needs no
separate SuperTag install. It doesn't carry Claude Code or Codex: install the ones you want to use
yourself, as in [Requirements](requirements.md). The setup screen checks that each is installed and
signed in, and says how when it isn't. Claude Code also needs [Node.js](requirements.md). To use
`supertag` in a terminal too, install it with the install script above.

On Linux:

1. Install the `supertag` command with the install script above. The Linux app uses it.
2. Install `SuperTag-VERSION-linux-ARCH.deb` with `sudo apt install ./SuperTag-VERSION-linux-ARCH.deb`,
   or make `SuperTag-VERSION-linux-ARCH.AppImage` executable (`chmod +x`) and run it.
3. Open SuperTag from your applications menu, or run the AppImage.

The Debian package needs WebKitGTK 4.1 and GTK 3, which `apt` installs with it; the AppImage
carries them.

On first launch the app's setup screen asks for your project folder and coding agent, then sets
SuperTag up and opens your conversation with `lead`. On later launches it connects to your local
SuperTag, and when its services are stopped it shows "Starting SuperTag…" and starts them with
`supertag up`. If they can't start, it shows what `supertag up` printed and where the logs are.

After you upgrade the app, your local services may still run the release an older `supertag`
started. The app then can't connect, and offers **Restart SuperTag with VERSION**, its own
version. It asks first, because Tasks running now are interrupted. Then it runs its bundled
`supertag down` and `supertag up` against the same state directory (`~/.supertag`, or
`SUPERTAG_STATE_DIR`), shows each step, and connects. `up` migrates the database, as in
[Upgrade](#upgrade). If either command fails, the app shows what it printed and where the logs
are. The app offers this only for the local services, and only when they run an older release. A
remote Gateway from another release gets the error alone: upgrade it where it runs.

## Build only the CLI

For a server or container that runs only the Control Plane or a Gateway, or on an Intel Mac,
which has no release archive, build the CLI alone. It also runs Codex Tasks:

```sh
cargo build --release --locked --manifest-path core/Cargo.toml -p supertag-cli --bin supertag
```

Put `core/target/release/supertag` on your `PATH`. Without the release archive's Node bridges, a
Worklet runs Claude Code, Cursor, or OpenCode only when you name a built adapter entrypoint
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
python -m pip install 'supertag==0.3.1'
```

Each SDK connects to SuperTag and lets a custom harness adapter talk to the Worklet that started it;
see [API stability](../reference/api-stability.md#package-entry-points). Generated Go,
TypeScript, and Python bindings live beside the SDKs in [`sdks/`](../../sdks/README.md). See
[Control Plane API](../reference/control-plane-api.md) for how to connect.

## Upgrade

Run the installer script again, or install a newer archive the same way. Then run `supertag up`.
It sees that the services on this machine run another build and restarts them with the new one:

```text
SuperTag 0.3.0 runs in /Users/you/.supertag, a different build than this CLI, so it restarts with this one.
Stopped SuperTag 0.3.0 services (protocol 2) without draining through the Control Plane, because this CLI speaks protocol 5. Their Worker Hosts stopped gracefully; Task Attempts they were running follow the recovery rules.
Restarted SuperTag: 0.3.0 (protocol 2) → 0.3.1 (protocol 5).
Started SuperTag in the background (process 4242).
Migrated the database schema from version 82 to 83.
```

When the old services speak the same protocol, `up` first drains their Worker Hosts and waits
for running Task Attempts, as `supertag down` does. When they speak another protocol, the new CLI
cannot drain through their Control Plane. It stops them with a signal instead, and each Worklet
still stops gracefully. A per-user service unit is restarted with the new executable.

The new Control Plane migrates the database when it starts, and `up` prints each migration. A
migrated database belongs to the new release: an older release refuses to start against it,
naming the schema version it found. To go back, restore the backup you took before the upgrade.
See [Back up](control-plane.md#back-up) for the local database.

Upgrading from a release that kept Session checkpoints on the Control Plane drops them: those
Sessions continue from their recap, and you can delete `~/.supertag/checkpoints`, which nothing
reads any more.

`supertag down` also stops services from another release, without draining when it must. For a
hosted deployment, follow [Upgrade a deployment](control-plane.md#upgrade-a-deployment).

## Check the CLI and the local services

Your CLI, the terminal UI, the desktop app, and Worklets negotiate a protocol version with
the Control Plane on every connection, and refuse a Control Plane that speaks none of theirs. The
error names both releases and which to upgrade, such as `This CLI speaks SuperTag protocol 5, but
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
