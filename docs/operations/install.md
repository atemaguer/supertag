# Install SuperTag

Install SuperTag's CLI to run Tags, persistent AI actors with their own responsibilities and
permissions, on your repositories. Python applications use the `supertag` SDK from PyPI.

## Before you start

Check the [requirements](requirements.md) for git, supported platforms, disk space, and sign-in
for a **harness**, the connection to an agent system such as Claude Code. Cursor needs an API key
that you generate in Cursor's dashboard; see [Cursor setup](requirements.md#cursor-setup-and-limits).

## 1. Install the CLI with the installer script

The installer script works on macOS and Linux, on arm64 and amd64:

```sh
curl -fsSL https://github.com/atemaguer/supertag/releases/latest/download/install.sh | sh
export PATH="$HOME/.local/bin:$PATH"
supertag --version
```

It downloads your platform's archive from the GitHub Release and checks it against the
release's `SHA256SUMS` before unpacking it. The archive holds the `supertag` command, the
terminal UI, and the bridges that run Claude Code, Cursor, OpenCode, E2B, and Modal. The script
checks that the command and the terminal UI report the release's version, then installs them
under `~/.local/share/supertag`, with the `supertag` command in `~/.local/bin`. It never starts
services or reads your settings. Add the `export` line to your shell startup file to use the
command in new terminals.

Claude Code, Cursor, OpenCode, E2B, and Modal Tasks also need Node.js on `PATH`, in the version
the [requirements](requirements.md) name; the script says so when it doesn't find one. Codex
Tasks don't need Node.js.

To choose the locations or a version, set these before `sh`:

| Variable | Default |
| --- | --- |
| `SUPERTAG_VERSION` | The release the script came from. Set a version, such as `0.3.0`, to install that release. Releases before the native CLI have no archive, so the script refuses them |
| `SUPERTAG_INSTALL_ROOT` | `~/.local/share/supertag` |
| `SUPERTAG_BIN_DIR` | `~/.local/bin` |

The script replaces a symbolic link at `~/.local/bin/supertag`, such as one an earlier install
created. It refuses to replace any other file at that path; remove a `supertag` command installed
another way, for example with `npm uninstall -g supertag-ai`, before you run it.

## Install the Python SDK from PyPI

Python applications need Python 3.10 or newer. Install the matching SDK:

```sh
python -m pip install 'supertag==0.2.0a9'
```

The explicit version selects this prerelease; pip otherwise selects an older stable release.
Python spells `0.2.0-alpha.9` as `0.2.0a9`. The SDK is a library; use the CLI above to
manage the Control Plane and built-in Workers. See [Build a Python Worker](../guides/python-workers.md)
for optional Codex and OpenAI Agents integrations.

## Upgrade

Run the installer script again, and install the matching Python SDK with pip. Earlier versions
stay under `~/.local/share/supertag/versions`. Reinstalling the same release keeps its installed
files in place. For a Compose deployment,
follow the [upgrade procedure](control-plane.md#upgrade-a-compose-deployment) to back up state
and coordinate the connected Worker Hosts. Source contributors can use
[CONTRIBUTING.md](../../CONTRIBUTING.md) to build and link uncommitted changes.

### Upgrade from a release before the native CLI

SuperTag releases before the native CLI ran on Node.js and stored their state in a format the
native release does not read. The native release starts with new state; it does not import the
earlier organization. Keep the earlier state as an archive:

1. Stop the earlier services with the earlier CLI: `supertag down`.
2. Move the state aside, so the native release starts empty and the archive stays intact:
   `mv ~/.supertag ~/.supertag-archive`.
3. Install the native release with the installer script, then run `supertag init` in your
   repository and recreate your Tags.

The archive keeps the earlier database, settings, and credentials. Read your earlier settings
from `~/.supertag-archive/supertag.yaml` when you recreate the configuration.

## Match the CLI and the Control Plane

A **Tag** is a persistent AI actor with its own responsibilities and permissions, and Tags work
in Teams. Together, your Teams of Tags make up an **autonomous organization**: Teams
may pursue different goals but share one set of rules and one record of the work. The **Control
Plane** is the service that stores your organization and accepts work. Your CLI talks to it. A
shared Control Plane can run a different SuperTag version from your CLI, for example after a
teammate upgrades one but not the other. Commands can then fail in confusing ways.

Check the CLI and the local services that `supertag up` runs:

```sh
supertag version
```

```text
supertag 0.3.0
Local services: 0.3.0 (process 41872)
```

When the local services run a different version, it says so; restart them with `supertag down`
and `supertag up`. Add `--output json` for scripts. `supertag --version` prints only the CLI
version.

Every client, Gateway, and Worker Host agrees on a protocol version with the Control Plane when it
connects. When they share none, the Control Plane refuses the connection with an error that names
both SuperTag versions; run the same release on both sides. The supported pairs are listed in
[CLI and Control Plane versions](../reference/api-stability.md#cli-and-control-plane-versions).

## Optional: find the collaboration surface guides

Collaboration surface setup names each surface's guide and app manifest in this repository:

```sh
supertag setup surface slack --help
```

The [collaboration surface guides](../surfaces/README.md) list them all.

## If something goes wrong

- **`supertag` is not found.** Add `~/.local/bin` to your `PATH`.
- **The installer script says the binary reports no version.** The release's Linux builds need
  glibc 2.36 or newer, as in Debian 12 or Ubuntu 24.04. Check yours with `ldd --version`.
- **The installer script refuses to replace `supertag`.** Another installation owns that path;
  remove it, or set `SUPERTAG_BIN_DIR`.
- **`supertag` says the terminal UI and the CLI versions must match.** Run the installer script
  again, so both come from the same release.
- **The version or commands differ from these docs.** Run `supertag --version`, then install
  the version named by these docs with `SUPERTAG_VERSION`.
- **The Control Plane refuses the CLI with an incompatible protocol error.** Install the
  release the Control Plane runs with `SUPERTAG_VERSION`, or upgrade the Control Plane.

## Run it in a repository

Follow [Get started](../../README.md#get-started) to set up a repository and get a reply from your
first Tag. During `supertag init`, enter another number at the `Port` prompt if 3434 is busy. The setup starts a
local Control Plane and a host service; `supertag ps` lists both, `supertag logs -f` follows
their logs, `supertag down` stops them, and `supertag up` starts them again.
[Start in a repository](cli.md#start-in-a-repository) explains what `init` sets up.

## Next

- [CLI operator guide](cli.md)
- [Collaboration surface guides](../surfaces/README.md)
- [Self-host SuperTag](../guides/self-hosting.md)

## Remove the CLI

Stop local services with `supertag down`, then remove the installed files:

```sh
rm -rf ~/.local/share/supertag ~/.local/bin/supertag
```

Your settings and state remain in `~/.supertag/`.
