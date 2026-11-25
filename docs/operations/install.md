# Install SuperTag

Install the `supertag` command to run Tags, persistent, proactive, multiplayer AI actors with their own identities, responsibilities,
permissions, and work histories, on your repositories. One installation holds everything a machine needs:

| Part | What it is |
| --- | --- |
| `supertag` | The CLI. It also runs the **Control Plane** (the service that stores your organization and schedules work), the **Gateway** (the service clients connect to, which also connects collaboration surfaces such as Slack), and the **Worklet** (`supertag worklet`, the program that connects a machine to the Control Plane as a **Worker Host** and runs its work) |
| `supertag-shared-execution` | An optional shared execution provider for Cursor Tasks |
| Node bridges | The harness adapters for Claude Code, Cursor, and OpenCode, run with your Node.js |

Codex runs through an adapter built into `supertag` and needs no Node.js. The installer prints a
notice when the Node.js on `PATH` can't run them: Claude Code needs Node.js 22.13.0 or later, and
Cursor, OpenCode, E2B, and Modal a 22.x release from 22.13.0.

## Before you start

Check the [requirements](requirements.md) for git, Node.js, supported platforms, and sign-in for
a **harness**, the connection to an agent system such as Claude Code or Codex.

## Install a release archive

A SuperTag release is one archive per platform, attached to its GitHub Release with a
`SHA256SUMS` file and an installer script:

| Platform | Archive |
| --- | --- |
| macOS on Apple silicon | `darwin-arm64` |
| macOS on Intel | `darwin-amd64` |
| Linux on arm64 | `linux-arm64` |
| Linux on amd64 | `linux-amd64` |

The installer script picks your platform's archive. In a terminal running under Rosetta on an
Apple silicon Mac, it still installs the Apple silicon build:

```sh
curl -fsSL https://supertag.sh/install | sh
export PATH="$HOME/.local/bin:$PATH"
supertag --version
```

`supertag.sh/install` redirects to the latest release's `install.sh` on GitHub. The script
downloads your platform's archive from that release and checks it against the release's
`SHA256SUMS` before unpacking it. It checks that `supertag` and `supertag-tui` report the release's version, then
installs the release under `~/.local/share/supertag` and links `supertag` into `~/.local/bin`.
It never starts services or reads existing SuperTag state. Add the `export` line to your shell
startup file to use the command in new terminals.

To choose the locations or a version, set these before `sh`:

| Variable | Default |
| --- | --- |
| `SUPERTAG_VERSION` | The release the script came from. Set a version, such as `0.3.14`, to install that release |
| `SUPERTAG_INSTALL_ROOT` | `$XDG_DATA_HOME/supertag` when `XDG_DATA_HOME` is set, otherwise `~/.local/share/supertag` |
| `SUPERTAG_BIN_DIR` | `$XDG_BIN_HOME` when it is set, otherwise `~/.local/bin` |

Installing a newer release keeps the older one beside it and switches the `supertag` link only
after the new release passes its checks. The script replaces a symbolic link at
`~/.local/bin/supertag` and refuses to replace any other file there.

### What the archive holds

- `supertag`, the CLI, which also runs the Control Plane, the Gateway, and the Worklet.
- `supertag-tui`, the terminal UI. Plain `supertag` in a terminal opens it; see
  [Open the terminal UI](cli.md#open-the-terminal-ui).
- `supertag-shared-execution` and `node-bridges/`, which Worker Hosts use to run harnesses.
  Each directory in `node-bridges/` has a `THIRD-PARTY-NOTICES.txt` with the licenses of the
  open-source packages in its files; packages in a `node_modules/` there carry their own.
- `LICENSE`, `NOTICE`, and `licenses/opentui/`, the licenses of the OpenTUI library the terminal
  UI embeds. That library links FFmpeg under the GNU LGPL 2.1, and each release attaches the exact
  FFmpeg source it was built from, such as `ffmpeg-9.0.2.tar.xz`, listed in the same
  `SHA256SUMS`. `NOTICE` says where OpenTUI's source and build scripts are.

### Build an archive from a checkout

To install a commit that has no release, build the archive for your machine from a clean
checkout. The build needs the Rust toolchain pinned in `core/rust-toolchain.toml`, Go, Node.js
with pnpm, [Bun](https://bun.sh) at the version in `.bun-version`, Python 3.13, and
[uv](https://docs.astral.sh/uv/):

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

The desktop app gives your conversations with Tags a window of their own, on a Mac with macOS 13
or later, or on Linux (amd64 or arm64) with `apt`, such as Ubuntu or Debian. Get the files from the
[latest release](https://github.com/atemaguer/supertag/releases/latest).

On a Mac:

1. Download `SuperTag-VERSION-darwin-arm64.dmg` for Apple silicon, or
   `SuperTag-VERSION-darwin-amd64.dmg` for an Intel Mac. **About This Mac** in the Apple menu
   shows which you have: an Apple chip, such as M1, or an Intel processor.
2. Open the image. Its window shows **SuperTag** beside a shortcut to your **Applications** folder.
   Drag **SuperTag** onto **Applications**.
3. Eject the image, then open SuperTag from Applications.

The Mac app carries its own `supertag` CLI and Node.js bridges, so it needs no
separate SuperTag install. It doesn't carry Claude Code or Codex: install the ones you want to use
yourself, as in [Requirements](requirements.md). The setup screen checks that each is installed and
signed in, and says how when it isn't. Claude Code also needs [Node.js](requirements.md). To use
`supertag` in a terminal too, install it with the install script above.

On Linux:

1. Install the `supertag` command with the install script above. The Linux app uses it, and only
   a `supertag` of its own version: when it finds none or another version, its setup screen
   shows the install command for its release.
2. Install `SuperTag-VERSION-linux-ARCH.deb` with `sudo apt install ./SuperTag-VERSION-linux-ARCH.deb`.
3. Open SuperTag from your applications menu, or run `supertag-desktop`.

The app runs its pages in Chromium's sandbox. Ubuntu 23.10 and later allow that sandbox only to
programs with an AppArmor profile, so the package installs one for the app,
`/etc/apparmor.d/supertag-desktop`, and removes it when you uninstall. There is no AppImage: its
sandbox can't start under that restriction. Without `apt`, use the CLI.

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

### Updating

The app checks for a newer published release shortly after it opens, then every hour while it
stays open and when you come back to its window. It never offers drafts. It offers pre-releases only when it is a pre-release
itself. **Check for Updates…** in the app menu (the **File** menu on Linux) checks now, as does **Check
for updates** on the **Updates** page of **Settings**, behind the gear at the foot of the sidebar.
Its **About** page names the app's release.

On a Mac, the app downloads the new release in the background without asking. The sidebar shows
the download's progress at its foot, then **Preparing VERSION…** while the app unpacks the
release and checks its signature. After that, a banner in the window's bottom right corner says
**SuperTag VERSION is ready**:

- **Restart to update** closes the app, installs the release, and opens the new version. The
  window is gone for some seconds meanwhile.
- **Later** hides the banner until the app opens again or a newer release arrives. **Update to
  VERSION** stays at the sidebar's foot until you install the update.

A ready update also installs when you quit the app, so the next time it opens it is the new
version. Either way, the new version first runs `supertag up` with its own CLI, which restarts
your local services with the new build, as in [Upgrade](#upgrade). Tasks running then are
interrupted and follow the recovery rules.

If a download or an install fails, the banner says so and offers **Download from GitHub**, which
opens the release's page. Download the disk image there and install it as above. The app also
tries again at its next check.

A Debian package can't update itself. On Linux the banner and the sidebar offer **Download
VERSION** instead, which opens the release's page. Install the new `.deb` there with `apt`, and
update the `supertag` command with `supertag update`, since the app runs only a `supertag` of
its own version.

## Build only the CLI

For a server or container that runs only the Control Plane or a Gateway, build the CLI alone.
It also runs Codex Tasks:

```sh
cargo build --release --locked --manifest-path core/Cargo.toml -p supertag-cli --bin supertag
```

Put `core/target/release/supertag` on your `PATH`. Without the release archive's Node bridges, a
Worklet runs Claude Code, Cursor, or OpenCode only when you name a built adapter entrypoint
with `--harness-entrypoint`, and `supertag init` doesn't offer Claude Code; it names the
directory the bridges belong in. Container images for hosted platforms are described in
[Self-host SuperTag](../guides/self-hosting.md).

## Client libraries

Applications call the Control Plane's gRPC API. The TypeScript SDK is `supertag-ai` on npm:

```sh
npm install supertag-ai
```

The Python SDK is `supertag` on PyPI, in Python 3.10 or newer. Install the version that matches
your CLI:

```sh
python -m pip install 'supertag==0.3.14'
```

Each SDK connects to SuperTag and lets a custom harness adapter talk to the [Worker](../reference/glossary.md#worker) that started it;
see [API stability](../reference/api-stability.md#package-entry-points). Generated Go,
TypeScript, and Python bindings live beside the SDKs in [`sdks/`](../../sdks/README.md). See
[Control Plane API](../reference/control-plane-api.md) for how to connect.

## Upgrade

Update the CLI with `supertag update`. It installs the latest published release the way the
installer script does, from the same `SHA256SUMS`, archive, and layout:

```text
Downloading SuperTag 0.3.14 for darwin-arm64 from https://github.com/atemaguer/supertag/releases/latest/download...
Updated SuperTag: 0.3.7 → 0.3.14 at /Users/you/.local/bin/supertag.
Restarting the local services on SuperTag 0.3.14.
```

It checks the archive against `SHA256SUMS` and checks that the release's `supertag` and
`supertag-tui` report its version. Then it installs the release beside the running one and
switches the `supertag` link with one rename. A failed download or check leaves the running
release in place. Older releases stay under `~/.local/share/supertag/versions`.

| Command | What it does |
| --- | --- |
| `supertag update` | Installs the latest release, or says this CLI is already on it |
| `supertag update --check` | Prints this CLI's version and the latest release's, and installs nothing |
| `supertag update --version 0.3.5` | Installs that release, including an older one |

When the local services run an older release, `update` restarts them on the new one with
`supertag up`, but only when no Task Attempt is running. Otherwise it leaves them running and
prints the command to run later, such as `supertag up`. It also leaves them alone when they don't
run the current `~/.supertag/supertag.yaml`: you edited it since they started, or started them
with options instead. Run `supertag up` yourself then, with any options you started them with. After going back to an older release, `update` never restarts them, because
an older Control Plane refuses a database a newer one migrated.

`update` replaces only a `supertag` the installer script installed. It refuses the copy inside
the desktop app, which updates itself (see [Updating](#updating)), and a `supertag` built from
source. It also refuses when the install directories aren't writable. Each refusal names what to
do instead. `update` honors the installer's `SUPERTAG_BIN_DIR` and `XDG_BIN_HOME`.

You can also run the installer script again, or install a newer archive the same way. Then run
`supertag up`. It sees that the services on this machine run another build and restarts them
with the new one:

```text
SuperTag 0.3.0 runs in /Users/you/.supertag, a different build than this CLI, so it restarts with this one.
Stopped SuperTag 0.3.0 services (protocol 2) without draining through the Control Plane, because this CLI speaks protocol 5. Their Worker Hosts stopped gracefully; Task Attempts they were running follow the recovery rules.
Restarted SuperTag: 0.3.2 (protocol 6) → 0.3.14 (protocol 7).
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

Your CLI, the desktop app, and Worklets negotiate a protocol version with
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
