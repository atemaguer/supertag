# Install SuperTag

Install SuperTag's CLI from npm to run Tags, persistent AI identities with their own
responsibilities and permissions, on your repositories. The npm package also provides the
TypeScript extension SDK. Python applications use the `supertag` SDK from PyPI.

## Before you start

Check the [requirements](requirements.md) for Node.js, npm, git, supported platforms, disk
space, and sign-in for a **harness**, the connection to an agent system such as Claude Code.
Cursor needs an API key that you generate in Cursor's dashboard; see
[Cursor setup](requirements.md#cursor-setup-and-limits).

## 1. Install the CLI with the installer script

The installer script installs SuperTag's npm package into its own directory, without changing
npm's global prefix. It needs Node.js 22.13.0 or newer and npm, and works on macOS and Linux:

```sh
curl -fsSL https://github.com/atemaguer/supertag/releases/latest/download/install.sh | sh
supertag --version
```

It installs SuperTag under `~/.local/share/supertag`, with the `supertag` command in
`~/.local/bin`, and removes the Claude Code and Codex CLI copies that the vendor SDKs bundle,
since SuperTag runs the CLIs you install. Add `~/.local/bin` to your `PATH` if it isn't already.

The script also installs the experimental terminal UI on macOS and Linux, on arm64 and amd64. It
downloads the release's `supertag-tui` binary with curl or wget and checks it against the
release's `SHA256SUMS`. Run `supertag` with no arguments in a terminal to open it. Its Ctrl-P
switches between this machine's Control Plane and the ones saved with
`supertag connect control-plane`. If the
download or the check fails, the script installs the CLI anyway and prints one line saying why
the terminal UI was not installed. Run the script again to add it.
To choose the locations or a version, set these before `sh`:

| Variable | Default |
| --- | --- |
| `SUPERTAG_VERSION` | The release the script came from; for example, `0.2.0-alpha.6` installs that release |
| `SUPERTAG_INSTALL_ROOT` | `~/.local/share/supertag` |
| `SUPERTAG_BIN_DIR` | `~/.local/bin` |

Applications that embed the SDK still install it from npm or PyPI.

## Or install the CLI from npm

```sh
npm install -g supertag-ai
supertag --version
```

The current release is `0.2.0-alpha.6`. The package includes the CLI, SDK, and bundled
documentation. A SuperTag source checkout is not required. The npm package does not include the
terminal UI, so plain `supertag` prints help; use the installer script to get the terminal UI.

npm also downloads the Claude Code and Codex CLI copies that the vendor SDKs bundle, which
SuperTag doesn't use; the installer script leaves them out. Ensure npm's global prefix's `bin`
directory is on your PATH; `npm prefix --global` prints that prefix. If it is not writable, run `npm config set prefix ~/.local` before installing,
then add `~/.local/bin` to your `PATH` (for example,
`export PATH="$HOME/.local/bin:$PATH"` in your shell startup file).

To install this exact release on another host:

```sh
npm install -g supertag-ai@0.2.0-alpha.6
```

## Install the TypeScript SDK

Add the package to your application:

```sh
npm install supertag-ai
```

For a shared deployment, select the same version as the Control Plane:

```sh
npm install supertag-ai@0.2.0-alpha.6
```

See [Custom Workers](../guides/custom-workers.md) for the public extension interfaces.

## Install the Python SDK from PyPI

Python applications need Python 3.10 or newer. Install the matching SDK:

```sh
python -m pip install 'supertag==0.2.0a6'
```

The explicit version selects this prerelease; pip otherwise selects an older stable release.
Python spells `0.2.0-alpha.6` as `0.2.0a6`. The SDK is a library; use the npm CLI above to
manage the Control Plane and built-in Workers. See [Build a Python Worker](../guides/python-workers.md)
for optional Codex and OpenAI Agents integrations.

## Upgrade

Install the target version with the same npm and pip commands above, or run the installer
script again. For a Compose deployment,
follow the [upgrade procedure](control-plane.md#upgrade-a-compose-deployment) to back up state
and coordinate the connected Worker Hosts. Source contributors can use
[CONTRIBUTING.md](../../CONTRIBUTING.md) to build and link uncommitted changes.

## Match the CLI and the Control Plane

A **Tag** is a persistent AI identity with its own responsibilities and permissions, and Tags work
in Teams. Together, your Teams of Tags make up an **autonomous organization**: Teams
may pursue different goals but share one set of rules and one record of the work. The **Control
Plane** is the service that stores your organization and accepts work. Your CLI talks to it. A
shared Control Plane can run a different SuperTag version from your CLI, for example after a
teammate upgrades one but not the other. Commands can then fail in confusing ways.

Check both versions:

```sh
supertag version
```

```text
CLI version: 0.2.0-alpha.6
Control Plane: https://supertag.example.com
Control Plane version: 0.2.0-alpha.6
Compatibility: supported (same version)
```

It reports the Control Plane other commands would use: the selected one, or the local Control
Plane that `supertag up` runs. Reading the version needs no credential. Add `--output json` for scripts.
If no Control Plane answers, it still prints the CLI version.

Keep both on the same version when you can. Other commands print one warning to stderr when the
versions differ. Upgrade the older side; `supertag --version` prints only the CLI version. The
supported pairs are listed in [CLI and Control Plane versions](../reference/api-stability.md#cli-and-control-plane-versions).

## Optional: find the bundled collaboration surface guides

Collaboration surface setup prints local paths to the package's guides and manifests:

```sh
supertag setup surface slack --help
```

Open those files directly. They ship with the CLI and do not require access to a hosted
documentation site.

## If something goes wrong

- **`supertag` is not found.** Run `npm prefix --global` and add its `bin` directory to your `PATH`.
- **Plain `supertag` prints help instead of the terminal UI.** The terminal UI is not installed.
  Run the installer script again on macOS or Linux; it prints why if it still cannot install it.
- **`supertag` says the terminal UI and the CLI versions must match.** Run the installer script
  again, so both come from the same release.
- **The version or commands differ from these docs.** Run `supertag --version`, then install
  the version named by these docs. The installed package includes its own guides under `dist/docs/`.
- **A command warns that the CLI and Control Plane versions differ.** Run `supertag version`, then
  upgrade the older side. See [Troubleshoot](../guides/troubleshooting.md#the-cli-warns-that-versions-differ).

## Run it in a repository

Follow [Get started](../../README.md#get-started) for setup and the first **Objective**, an outcome
a Tag owns with success criteria. During `supertag init`, enter another number at the `Port` prompt if 3434 is busy. The setup starts a
local Control Plane and a host service; `supertag ps` lists both, `supertag logs -f` follows
their logs, `supertag down` stops them, and `supertag up` starts them again.
[Start in a repository](cli.md#start-in-a-repository) explains what `init` sets up.

## Next

- [CLI operator guide](cli.md)
- [Collaboration surface guides](../surfaces/README.md)
- [Self-host SuperTag](../guides/self-hosting.md)

## Remove the CLI

Stop local services with `supertag down`, then remove the global package:

```sh
npm uninstall -g supertag-ai
```

If you used the installer script, remove its files instead:

```sh
rm -rf ~/.local/share/supertag ~/.local/bin/supertag
```

Either way, your settings and state remain in `~/.supertag/`.
