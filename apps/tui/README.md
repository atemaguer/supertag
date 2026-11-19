# SuperTag terminal UI

`supertag-tui` is SuperTag's terminal UI: your conversations with your Tags (SuperTag's AI
actors), in a terminal. It is written in TypeScript with [OpenTUI](https://opentui.com) and React,
runs on Bun, and ships as one Bun-compiled binary beside `supertag`. It shares its Gateway
client, transcript rules and React hooks with the desktop app through `@supertag/client`
(`apps/client`); nothing here is a public package. It is not yet released.

## What it shows

- **The Tag list**: the lead Tag first (`★`), the others by latest activity, each with a short
  time (`14:05`, `Yday`, `Mon`), its name in bold while it has unread replies, and a preview line:
  `working…` while it works, `N new · …` for unread replies. Ctrl-B folds it to initials (`★` lead,
  `•` unread, `…` working); `[` and `]` resize it from the list. Both are remembered.
- **The conversation**: messages only, never activity. Your messages on the right, the Tag's on
  the left as Markdown with highlighted code; the text a running turn writes streams in place;
  `···` while the Tag works; why a queued turn waits for a Worker Host; time dividers where 15
  minutes passed. Under your last message: `Sending…`, `Sent`, `Seen`, or `! Not delivered`
  (Ctrl-R retries with the same operation, so the Gateway accepts it at most once; Ctrl-X puts it
  back in the composer). The newest 40 messages are mounted; PgUp at the top mounts more, then
  reads earlier ones. Scrolled up, a line counts new messages until End.
- **The composer**: Enter sends. A draft is kept per Tag across Tag switches and launches. A
  message sent waits in the outbox, on disk, until the Gateway accepts it, and is sent again at
  the next launch.
- **The palette** (Ctrl-K, or `/` on an empty message): Tags with their Alt-N keys, and commands.
- **Gateways** (Ctrl-P): Local, and the Gateways saved with `supertag connect` or in the desktop
  app. `a` adds one with `supertag connect`: a name, the URL, an Operator Token or a client Auth
  Key (which enrolls this device as `client:HOSTNAME`), and optional TLS files.
- **The status line**: the Gateway, its connection, its Worker Hosts by phase (operators only),
  and unread replies outside the conversation in front.
- **Notifications**: a reply or question in a conversation that is not in front, or while the
  terminal is unfocused, writes OSC 9 (through tmux passthrough inside tmux; tmux needs
  `allow-passthrough on`). `SUPERTAG_TUI_NOTIFY=all|questions|bell|off`.

Every string from a Gateway shows escape sequences as text (`^[`).

## Entry contract

This is what the `supertag` CLI's launcher and the release build rely on. Change it only with
them.

| | |
| --- | --- |
| Entry | `apps/tui/src/main.tsx`, package `@supertag/tui` in the pnpm workspace (`@opentui/core` is a direct dependency) |
| Build | `bun build --compile --minify --bytecode --format=esm --target=bun-TARGET`, `--external @opentui/core-PLATFORM` for every other platform, `--define process.env.SUPERTAG_TUI_VERSION="VERSION"`; `scripts/build.sh` does this for local use |
| Bun | 1.4.5 (OpenTUI needs at least 1.3.14) |
| `supertag-tui --version` | Prints the bare version (`0.3.2`; `dev` unbuilt) and exits 0, before OpenTUI or React load |
| `supertag-tui --headless-check` | Loads OpenTUI's native library, prints `ok`, exits 0; needs no terminal |
| `supertag-tui [--gateway URL\|NAME\|local] [--state-directory DIR]` | The UI. Without a terminal on stdin and stdout it exits 2 with a message on stderr. A bad argument exits 2 with the usage |
| Ctrl-C | Restores the terminal (leaves the alternate screen) and exits 0 |

There is no handover from the CLI: the terminal UI finds its own connection. In order:

1. `--gateway local` (or `--state-directory DIR`): the local Gateway `supertag up` runs, as
   `supertag __local-gateway` (`local-gateway.v2`) reports it. The token it prints is read at
   every connect and never saved.
2. `--gateway URL`, else `SUPERTAG_GATEWAY_URL`: that Gateway, with the token in
   `SUPERTAG_OPERATOR_TOKEN` and the TLS files in `SUPERTAG_SERVER_CA_FILE`,
   `SUPERTAG_CLIENT_CERT_FILE` and `SUPERTAG_CLIENT_KEY_FILE`, as the CLI reads them. The token
   is removed from the process environment once read.
3. `--gateway NAME`: the Gateway saved under that name in `<config>/supertag/gateways.json`
   (written by `supertag connect`, with its TLS files) or `<config>/ai.supertag.desktop/gateways.json`
   (the desktop app's). `<config>` is `~/Library/Application Support` on macOS, else an absolute
   `$XDG_CONFIG_HOME`, else `~/.config`, as the CLI computes it.
4. Nothing: the Gateway used last, else Local when it runs, else the first saved Gateway, else
   the Gateway chooser.

The CLI it runs (for `__local-gateway` and `connect`) is `SUPERTAG_CLI`, else `supertag` beside
the binary, else `supertag` on `PATH`. It reads `SUPERTAG_STATE_DIR`, `HOME`, `XDG_CONFIG_HOME`,
`XDG_CACHE_HOME`, `TERM`, `COLORTERM`, `TERM_PROGRAM`, `TMUX` and `SUPERTAG_TUI_NOTIFY`; a
launcher passes the environment through.

## Files

| File | What |
| --- | --- |
| `<config>/supertag/tui.json` | The Gateway used last, whom each Gateway's credential acted as (so a launch paints that Gateway's cache before connecting), the Tag list's width and fold. Never a credential |
| `<user cache>/supertag/tui/` | Per Gateway and principal, owner-only: the Tags and conversation list, each conversation's latest 50 messages, the outbox, drafts. Never a credential. `<user cache>` is `~/Library/Caches` on macOS, else `$XDG_CACHE_HOME` or `~/.cache` |

## Keys

Enter send · Ctrl-K or `/` palette · Ctrl-P Gateways · Alt-1…9 the nth Tag · Alt-↑/↓ (Alt-k/j)
previous or next Tag · Tab between the list and the message · ↑/↓ (k/j) in the list · Ctrl-B fold
· `[` `]` resize · PgUp/PgDn scroll · End or Ctrl-End latest · Ctrl-R retry · Ctrl-X edit · Esc
close · Ctrl-C quit. The Keyboard shortcuts screen (in the palette) lists them from `src/keys.ts`.

## Developing

Install the workspace with `pnpm install`, and Bun 1.4.5 (for example into a temporary prefix:
`BUN_INSTALL=/tmp/bun curl -fsSL https://bun.sh/install | bash -s bun-v1.4.5`).

```sh
bun run src/main.tsx --gateway local      # run it from the checkout
bun test .test.tsx                        # screens, in OpenTUI's test renderer
pnpm vitest run apps/tui                  # logic that needs no renderer (from the repository root)
bun bench/perf.tsx                        # budgets; exits 1 when one is missed
sh scripts/build.sh                       # compile for this machine into /tmp/supertag-tui/dist
```

`src/ui/` holds the OpenTUI imports (Markdown, the syntax style, fields, hooks), so an OpenTUI
upgrade touches one place. Screen tests drive the real screen tree against `test/fake-gateway.ts`,
an in-memory Gateway served through `createRouterTransport`, so `GatewayState`, follows and the
Watch run their real code.

### Against real services

`scripts/stack.sh` runs a throwaway SuperTag with state under `/tmp/supertag-tui` (mode 700), the
Control Plane on `127.0.0.1:47451`, and a Worker Host on the fixture adapter, which answers every
message. It never touches `~/.supertag`.

```sh
(cd ../../core && cargo build -p supertag-cli --features test-fixtures \
  --bin supertag --bin supertag-fixture-adapter)
sh scripts/stack.sh up && sh scripts/stack.sh tag engineer && sh scripts/stack.sh tag lead
sh scripts/stack.sh tui --gateway local   # try it
sh scripts/tmux-e2e.sh engineer           # send, stream, paste, Alt-2, notify, save a Gateway, quit
TUI_BINARY=/tmp/supertag-tui/dist/supertag-tui-darwin-arm64 SUPERTAG_CLI=../../core/target/debug/supertag \
  bun bench/first-paint.ts 10             # first paint in a PTY, 30 ms round trip
sh scripts/stack.sh down
```

## Performance budgets

`bench/perf.tsx` (test renderer, 30 Tags, a 300-turn Markdown conversation): keystroke to frame
p95 ≤ 8 ms at 250×70; a page of 32 streamed updates blocks the event loop ≤ 16 ms; keys typed
during a stream arrive in order; RSS ≤ 250 MB. `bench/first-paint.ts` (compiled binary in a PTY,
30 ms round trip, 50 Markdown turns): median first launch ≤ 352 ms and next launch (from the
cache) ≤ 163 ms, the Go TUI's medians plus 50 ms.
