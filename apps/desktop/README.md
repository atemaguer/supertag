# SuperTag desktop app

SuperTag's desktop app, built with Electron: a main process in `electron/` and a React and
TypeScript renderer in `src/`. It shows your conversations with Tags in a window of their own,
on a Mac (Apple silicon or Intel) or on Linux. To install it, see
[Install the desktop app](../../docs/operations/install.md#install-the-desktop-app).

## How it finds SuperTag

The app is a client of a Gateway, as the CLI is. On first launch, with no `supertag.yaml`
in the state directory (`SUPERTAG_STATE_DIR`, else `~/.supertag`), its setup screen runs
`supertag init --check --json` for the folder you choose, then `supertag init --yes`. On later
launches it connects to the local Gateway, and starts the local services with `supertag up` when
they are stopped. It runs only a `supertag` of its own version: the copy bundled in the Mac app,
else the one on your login shell's `PATH` or in `~/.local/bin`. When it finds none, or another
version, it names the install command for its own release. Settings, behind the gear at the foot of
the sidebar, names the app's release, from `package.json` as `app.getVersion()` reads it, and
the Gateway's, with a warning when the Gateway names another while negotiating.

## Develop

From the repository root, after `pnpm install`:

```sh
pnpm --filter @supertag/desktop dev               # Vite server and Electron, in one command
pnpm --filter @supertag/desktop dev --preview     # the same, with the sample Tags
pnpm --filter @supertag/desktop build             # renderer, main process and preload
pnpm --filter @supertag/desktop electron          # the built app
```

`dev` serves the renderer from `http://127.0.0.1:1420` and points Electron at it; closing the
window stops the server. With `--preview`, add `&update=STATE` to the page's URL to see the
update banner and sidebar button in each state: `downloading`, `ready`, `installing`,
`available` (Linux), `error`, `install-error`, or `check-error`. Check a change with `pnpm --filter @supertag/desktop build` and
`pnpm vitest run apps/client apps/desktop`. CI runs them in `.github/workflows/desktop.yml`.

### Look at a change

Tests cannot tell you how the window looks. Before you report a change to the window, take the
screenshots and look at them:

```sh
pnpm --filter @supertag/desktop shots              # every state, into apps/desktop/.shots/
pnpm --filter @supertag/desktop shots narrow rail  # only the named states
```

`scripts/shots.ts` serves the renderer with Vite on a free port, opens the preview in your
installed Chrome, headless, and writes one PNG per state at twice the pixel density. It never
starts Electron, and git ignores `.shots/`. It exits 1 when a state does not render, or when a menu or dialog it opens has no background or is clipped by the window. The states:

| State | Shows |
| --- | --- |
| `default` | the sample Tags and a conversation with a code block and a table, at 1280×820 |
| `inspector` | the Tag details panel |
| `gateway-selector`, `rail-gateway-selector` | the Gateway menu with two saved Gateways (`?preview&gateways`), and the menu opened from the rail |
| `new-tag`, `add-gateway` | the New Tag and Add Gateway dialogs |
| `many-tags` | seventeen Tags with long names and previews, in every row state (`?preview&many`) |
| `no-lead` | a Gateway without a lead Tag (`?preview&nolead`) |
| `runs-elsewhere` | a Tag without a Workspace whose turn runs on another Worker Host |
| `needs-you`, `replying` | a Tag's unanswered question as a card, and the composer replying to it |
| `approval`, `approval-deny`, `approval-decided`, `narrow-approval` | an approval request as a card: pending, asking why it is denied, and decided |
| `narrow`, `narrow-inspector`, `narrow-many-tags` | the same at 900×700 |
| `search` | the command palette |
| `rail` | the sidebar folded into its rail |
| `settings`, `settings-notifications`, `settings-shortcuts`, `settings-updates`, `settings-about`, `settings-gateways`, `settings-tags`, `settings-hosts`, `settings-permissions` | each page of Settings |
| `settings-update`, `settings-search`, `narrow-settings`, `narrow-settings-tags` | Settings with an update ready and a Gateway on another release, which also dot the gear; its search; and its narrow layout |
| `update-banner` | an update ready to install (`?preview&update=ready`) |

[DESIGN.md](DESIGN.md) records what the window should look like: the avatar, the sidebar's rows,
the header band, and the spacing and type tokens. The sample data is in `src/preview.ts`, and
`src/main.tsx` reads the preview's parameters; add a state to `scripts/shots.ts` when you add one.

`electron/main.ts` opens the window, serves the built renderer from `app://supertag/` with its
Content Security Policy, and keeps the window on it; `preload.ts` exposes `window.supertag`, one
method per entry of the channel table in `channels.ts`; `ipc.ts` refuses any call that isn't from
the main window's own page. The main process connects to Gateways with `GatewayState` from
`@supertag/client/node` (`apps/client`), on `supertag-ai`'s Gateway client, so tokens and Auth
Keys stay in it; `electron/gateway/handlers.ts` puts it behind the channel table. It runs the
local services and setup with the app's CLI in `electron/local/`. The renderer takes its view
types, transcript rules and hooks from `@supertag/client/model` and `@supertag/client/react`,
and gives the hooks the window's visibility through `PlatformProvider` (`src/lib/platform.ts`).

The Gateway client's integration tests, in `apps/client/src/node`, and the local services' run
against Control Planes and Gateways started by a built CLI, each with throwaway directories and
ports:

```sh
cargo build --manifest-path core/Cargo.toml --locked -p supertag-cli --bin supertag
SUPERTAG_RUST_TEST_CLI=$PWD/core/target/debug/supertag pnpm vitest run apps/client/src/node apps/desktop/electron
```

Run them under Electron's own Node.js as well, which differs from the repository's:
`ELECTRON_RUN_AS_NODE=1 apps/desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron node_modules/vitest/vitest.mjs run apps/client/src/node apps/desktop/electron`
(on Linux, `apps/desktop/node_modules/electron/dist/electron`).

## Package the app

Releases ship the app (`.github/workflows/release.yml`). electron-builder
(`electron-builder.config.ts`) bundles only `dist/`, `dist-electron/` and `package.json`, and
flips the fuses in `electron/fuses.ts` after packing:

```sh
pnpm --filter @supertag/desktop package:mac        # release/mac-arm64/SuperTag.app, unsigned
pnpm --filter @supertag/desktop package:mac --x64  # release/mac/SuperTag.app, for Intel Macs
pnpm --filter @supertag/desktop package:linux      # release/SuperTag-VERSION-linux-ARCH.deb
```

On macOS, `scripts/package-desktop-macos.sh APP CLI_DIRECTORY IMAGE [ZIP]` puts an extracted
release archive in the app, then builds the disk image, and with ZIP the update zip of the signed
app; without `SIGNED=true` it skips signing and notarization, which is enough for a local check.

## Updates

`electron/updater.ts` checks for a newer published release 15 seconds after launch, then every
hour and when the window comes to the front, and `electron/update-state.ts` turns what it hears into the status the window
shows (`src/components/update.tsx`). On macOS it runs electron-updater against the GitHub
Release that `Resources/app-update.yml` names (written in `afterPack`): it downloads the zip
that `latest-mac.yml` lists for the Mac's architecture and hands it to Squirrel.Mac at once
(`autoInstallOnAppQuit`). Squirrel.Mac unpacks it and verifies its signature, and only then is
the update ready, so "Restart to update" has only to quit, swap the app and open it. A staged
update also installs when the app quits. Squirrel.Mac accepts only an update whose signature satisfies the running
app's, so only a Developer ID build checks; development and ad-hoc signed builds don't. On Linux
it reads the latest release's version and opens its page. A staged update leaves
`update.json` in the app's configuration directory, and the new version's first launch restarts
the local services with `supertag up`. The main process logs to `main.log` in Electron's logs
directory (`~/Library/Logs/SuperTag` on macOS). Each phase of an update writes a line there with
how long it took: found, downloaded, staged, restart requested, quitting, and on the new
version's first launch `Updated from X to Y`, with the time from the restart to the launch and
to the window. Squirrel.Mac's installer logs the part in between to
`~/Library/Caches/ai.supertag.desktop.ShipIt/ShipIt_stderr.log`.

To try the flow before a signed release, serve a `latest-mac.yml` and zip from this machine and
open a packaged, unsigned app with `SUPERTAG_DESKTOP_UPDATE_FEED=http://127.0.0.1:PORT/`. A
signed build ignores the variable. It checks and downloads, then Squirrel.Mac refuses the
unsigned app while it stages the download and the banner shows the install's error. Make the zip with
`ditto -c -k --sequesterRsrc --keepParent SuperTag.app SuperTag-VERSION-darwin-arm64.zip`, its
blockmap with `node build/blockmap.mjs ZIP`, and the feed with
`python3 scripts/desktop_update_feed.py --version VERSION --output latest-mac.yml ZIP`. The Debian package installs the AppArmor profile
in `build/linux/` so Chromium's sandbox can start under Ubuntu's restriction on unprivileged user
namespaces, and keeps `chrome-sandbox` setuid root as its fallback. `scripts/check-desktop-deb.sh
DEB` installs a package, launches it sandboxed, and removes it.

`pnpm --filter @supertag/desktop smoke EXECUTABLE` launches a built app with a throwaway home and
checks that its window renders, has no Node globals, and sees exactly the channel table's
`window.supertag`; on Linux, that its renderers run sandboxed. It drives the app over Chromium's
DevTools protocol, since the packaged app's fuses turn off the Node inspector.
