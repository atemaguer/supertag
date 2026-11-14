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
`darwin-arm64`, attached to its GitHub Release with a `SHA256SUMS` file and an installer script.
The installer script works on macOS and Linux:

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
| `SUPERTAG_VERSION` | The release the script came from. Set a version, such as `0.3.0-alpha.1`, to install that release. Releases before the native CLI have no archive, so the script refuses them |
| `SUPERTAG_INSTALL_ROOT` | `~/.local/share/supertag` |
| `SUPERTAG_BIN_DIR` | `~/.local/bin` |

Installing a newer release keeps the older one beside it and switches the `supertag` link only
after the new release passes its checks. The script replaces a symbolic link at
`~/.local/bin/supertag`, such as the earlier runtime's, and refuses to replace any other file
there.

### Build an archive from a checkout

To install a commit that has no release, build the archive for your machine from a clean
checkout. The build needs the Rust toolchain pinned in `rust/rust-toolchain.toml`, Go, Node.js
with pnpm, Python 3.13, and [uv](https://docs.astral.sh/uv/):

```sh
git clone https://github.com/atemaguer/supertag.git
cd supertag
uv run rust/scripts/native_release.py package --repo . --commit "$(git rev-parse HEAD)" \
  --output "$HOME/supertag-build"
uv run rust/scripts/install_native_release.py "$HOME"/supertag-build/supertag-*-complete.tar.gz
```

`install_native_release.py` checks and installs the archive as the installer script does, and
reads the same `SUPERTAG_INSTALL_ROOT` and `SUPERTAG_BIN_DIR`.

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

Applications call the Control Plane's gRPC API. The TypeScript SDK is `supertag-ai` on npm:

```sh
npm install supertag-ai
```

The Python SDK is `supertag` on PyPI, in Python 3.10 or newer. Install the version that matches
your CLI; the explicit version selects this prerelease, which Python spells `0.3.0a1`:

```sh
python -m pip install 'supertag==0.3.0a1'
```

Each SDK connects to a Control Plane and lets a custom harness adapter talk to its Worker Host;
see [API stability](../reference/api-stability.md#package-entry-points). Generated Go,
TypeScript, and Python bindings live in [`rust/bindings`](../../rust/bindings/README.md). See
[Control Plane API](../reference/control-plane-api.md) for how to connect.

## Upgrade

Run the installer script again, or install a newer archive the same way. Then restart this machine's services with
`supertag up`, which waits for running Task Attempts before replacing a service. For a hosted
deployment, follow [Upgrade a deployment](control-plane.md#upgrade-a-deployment).

## Check the CLI and the local services

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
