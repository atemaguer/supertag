# SuperTag desktop app

SuperTag's desktop app, built with Tauri 2: a Rust backend in `src-tauri/` and a React and
TypeScript frontend in `src/`. It shows your conversations with Tags in a window of their own,
on an Apple silicon Mac or on Linux. To install it, see
[Install the desktop app](../../docs/operations/install.md#install-the-desktop-app).

## How it finds SuperTag

The app is a client of a Gateway, as the terminal UI is. On first launch, with no `supertag.yaml`
in the state directory (`SUPERTAG_STATE_DIR`, else `~/.supertag`), its setup screen runs
`supertag init --check --json` for the folder you choose, then `supertag init --yes`. On later
launches it connects to the local Gateway, and starts the local services with `supertag up` when
they are stopped. It runs only a `supertag` of its own version: the copy bundled in the Mac app,
else the one on your login shell's `PATH` or in `~/.local/bin`. When it finds none, or another
version, it names the install command for its own release.

## Develop

From the repository root, after `pnpm install`:

```sh
pnpm --filter @supertag/desktop tauri dev
```

Check a change with `pnpm --filter @supertag/desktop build`, then run `cargo clippy` and the whole
`cargo test` with `--manifest-path apps/desktop/src-tauri/Cargo.toml`. The unfiltered test run
checks that every Tauri command is allowed. CI runs them in `.github/workflows/desktop.yml`.
