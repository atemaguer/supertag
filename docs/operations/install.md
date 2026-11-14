# Install SuperTag

SuperTag runs Tags, persistent AI actors with their own responsibilities and permissions, on your
repositories. It has no published release yet, so you build a release archive from this
repository and install it. The archive holds the `supertag` CLI, the terminal UI, and the helpers
that run Claude Code, Cursor, OpenCode, Modal, and E2B work. Python applications use the
`supertag` SDK from PyPI.

## Before you start

Check the [requirements](requirements.md) for the build tools, git, supported platforms, disk
space, and sign-in for a **harness**, the connection to an agent system such as Claude Code.
Cursor needs an API key that you generate in Cursor's dashboard; see
[Cursor setup](requirements.md#cursor-setup-and-limits).

## 1. Build a release archive

Clone the repository and build an archive from its current commit. The build runs in a temporary
directory and leaves your checkout unchanged:

```sh
git clone https://github.com/atemaguer/supertag.git
cd supertag
mkdir -p ~/supertag-releases
uv run rust/scripts/native_release.py package --commit "$(git rev-parse HEAD)" \
  --output ~/supertag-releases | tee ~/supertag-releases/build.log
archive="$(tail -n 1 ~/supertag-releases/build.log)"
```

The build prints its progress; its last line is the archive's path, and the archive's name
includes its version and platform. The commit must be clean. The script checks the versions the
repository pins for Rust, Node.js, and pnpm, and stops with the difference when one does not
match.

## 2. Install the archive

```sh
uv run rust/scripts/install_native_release.py "$archive"
export PATH="$HOME/.local/bin:$PATH"
supertag --version
```

It installs SuperTag under `~/.local/share/supertag`, with the `supertag` command in
`~/.local/bin`. It keeps earlier installs and switches only the command link, and it never
starts services or touches your settings. Add the `export` line to your shell startup file to use
the command in new terminals. To choose the locations, set these first:

| Variable | Default |
| --- | --- |
| `SUPERTAG_INSTALL_ROOT` | `~/.local/share/supertag` |
| `SUPERTAG_BIN_DIR` | `~/.local/bin` |

Plain `supertag` opens the terminal UI, which the archive installs beside the CLI.

## Install the Python SDK from PyPI

Python applications need Python 3.10 or newer. Install the matching SDK:

```sh
python -m pip install 'supertag==0.2.0a9'
```

The explicit version selects this prerelease; pip otherwise selects an older stable release.
Python spells `0.2.0-alpha.9` as `0.2.0a9`. The SDK is a library; use the CLI above to manage the
Control Plane and Worker Hosts. See [Build a Python Worker](../guides/python-workers.md) for
optional Codex and OpenAI Agents integrations.

## Upgrade

Pull the commit you want, then build and install its archive with the same two steps. The
installer keeps the earlier install, so a failed upgrade leaves the previous command working.
Run `supertag down` and `supertag up` afterwards so local services run the new version.

## Check the CLI and the local services

The **Control Plane** is the service that stores your organization and accepts work. Your CLI
talks to it. Check the versions of the CLI and of the local services that `supertag up` runs:

```sh
supertag version
```

Add `--output json` for scripts. `supertag --version` prints only the CLI version.

## If something goes wrong

- **The archive build stops with a version difference.** Install the version it names; see the
  [requirements](requirements.md#system-and-tools).
- **`supertag` is not found.** Add `~/.local/bin`, or your `SUPERTAG_BIN_DIR`, to your `PATH`.
- **The version or commands differ from these docs.** Run `supertag --version`, then build the
  archive from the commit these docs come from.

## Run it in a repository

Follow [Get started](../../README.md#get-started) to set up a repository and get a reply from your
first Tag. `supertag init` starts a local Control Plane and a host service; `supertag ps` lists
both, `supertag logs` prints their logs, `supertag down` stops them, and `supertag up` starts them
again.

## Next

- [CLI operator guide](cli.md)
- [Collaboration surface guides](../surfaces/README.md)
- [Self-host SuperTag](../guides/self-hosting.md)

## Remove SuperTag

Stop local services with `supertag down`, then remove the installed files:

```sh
rm -rf ~/.local/share/supertag ~/.local/bin/supertag
```

Your settings and state remain in `~/.supertag/`.
