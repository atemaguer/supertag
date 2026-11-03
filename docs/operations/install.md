# Install SuperTag from the repository

Install SuperTag's CLI from a clone to run Tags, persistent AI identities with their own
responsibilities and permissions, on your repositories. The same build provides the extension SDK
for applications. npm and PyPI packages come later.

## Before you start

- Check the [requirements](requirements.md) for Node.js, pnpm, git, supported platforms, disk
  space, and sign-in for a **harness**, the connection to an agent system such as Claude Code.
  Cursor needs an API key that you generate in Cursor's dashboard; see [Cursor setup](requirements.md#cursor-setup-and-limits).

## 1. Clone and install

```sh
git clone https://github.com/atemaguer/supertag.git
cd supertag
pnpm install:cli
supertag --version
```

The installer installs dependencies, builds SuperTag, and links the CLI into npm's global
prefix. Keep the checkout in place: the command uses its build. Ensure that prefix's `bin`
directory is on your PATH; `npm prefix --global` prints the prefix.
The link needs write access to that prefix. To use a directory you own, run
`npm config set prefix ~/.local` before running the installer, then add `~/.local/bin` to your
`PATH` (for example, `export PATH="$HOME/.local/bin:$PATH"` in your shell startup file).

For SDK use, run `npm install /absolute/path/to/supertag/packages/supertag-ai` in your
application after building, replacing the path with your checkout.

## Check that it worked

```sh
supertag --version
```

The version is `0.2.0-alpha.3`.

## Match the CLI and the Control Plane

A **Tag** is a persistent AI identity with its own responsibilities and permissions, and Tags work
in Teams under a lead. Together, your Teams of Tags make up an **autonomous organization**: Teams
may pursue different goals but share one set of rules and one record of the work. The **Control
Plane** is the service that stores your organization and accepts work. Your CLI talks to it. A
shared Control Plane can run a different SuperTag version from your CLI, for example after a
teammate upgrades one but not the other. Commands can then fail in confusing ways.

Check both versions:

```sh
supertag version
```

```text
CLI version: 0.2.0-alpha.3
Control Plane: https://supertag.example.com
Control Plane version: 0.2.0-alpha.3
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
- **The version or commands differ from these docs.** Use the documentation in your checkout and rerun
  the installer there after updating it.
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

Stop local services with `supertag down`, then run this from the SuperTag checkout:

```sh
pnpm uninstall:cli
```

This removes the global command link. Your settings and state remain in `~/.supertag/`.
