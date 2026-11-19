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

### The Electron shell

The app is moving from Tauri to Electron; until the move completes, both shells build from the
same renderer. The Electron shell is in `electron/`: `main.ts` opens the window, serves the built
renderer from `app://supertag/` with its Content Security Policy, and keeps the window on it;
`preload.ts` exposes `window.supertag`, one method per entry of the channel table in
`channels.ts`; `ipc.ts` refuses any call that isn't from the main window's own page. In a Tauri
window, `src-tauri/bridge.ts` provides the same `window.supertag`. The main process connects to
Gateways in `electron/gateway/` with `supertag-ai`'s Gateway client, so tokens and Auth Keys stay
in it, and runs the local services and setup with the app's CLI in `electron/local/`.

The Gateway backend's integration tests run against Control Planes and Gateways started by a
built CLI, each with throwaway directories and ports:

```sh
cargo build --manifest-path core/Cargo.toml --locked -p supertag-cli --bin supertag
SUPERTAG_RUST_TEST_CLI=$PWD/core/target/debug/supertag pnpm vitest run apps/desktop/electron
```

Run them under Electron's own Node.js as well, which differs from the repository's:
`ELECTRON_RUN_AS_NODE=1 apps/desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron node_modules/vitest/vitest.mjs run apps/desktop/electron`
(on Linux, `apps/desktop/node_modules/electron/dist/electron`).

```sh
pnpm --filter @supertag/desktop build      # renderer, main process and preload
pnpm --filter @supertag/desktop electron   # the built app
pnpm --filter @supertag/desktop dev        # in one terminal: the Vite server
pnpm --filter @supertag/desktop electron:dev   # in another: Electron against it
```

`electron:dev` loads `SUPERTAG_DESKTOP_DEV_URL`, by default `http://127.0.0.1:1420`; set it to
`http://127.0.0.1:1420/?preview` for the sample Tags.

### Package the Electron app

Releases ship the Electron app (`.github/workflows/release.yml`). electron-builder
(`electron-builder.config.ts`) bundles only `dist/`, `dist-electron/` and `package.json`, and
flips the fuses in `electron/fuses.ts` after packing:

```sh
pnpm --filter @supertag/desktop package:mac     # release/mac-arm64/SuperTag.app, unsigned
pnpm --filter @supertag/desktop package:linux   # release/SuperTag-VERSION-linux-ARCH.deb
```

On macOS, `scripts/package-desktop-macos.sh APP CLI_DIRECTORY IMAGE` puts an extracted release
archive in the app, then builds the disk image; without `SIGNED=true` it skips signing and
notarization, which is enough for a local check. The Debian package installs the AppArmor profile
in `build/linux/` so Chromium's sandbox can start under Ubuntu's restriction on unprivileged user
namespaces, and keeps `chrome-sandbox` setuid root as its fallback. `scripts/check-desktop-deb.sh
DEB` installs a package, launches it sandboxed, and removes it.

`pnpm --filter @supertag/desktop smoke EXECUTABLE` launches a built app with a throwaway home and
checks that its window renders, has no Node globals, and sees exactly the channel table's
`window.supertag`; on Linux, that its renderers run sandboxed. It drives the app over Chromium's
DevTools protocol, since the packaged app's fuses turn off the Node inspector.
