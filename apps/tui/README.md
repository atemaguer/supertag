# SuperTag terminal UI

`supertag-tui` is SuperTag's terminal UI: your conversations with your Tags (SuperTag's AI
actors), in a terminal. It is written in TypeScript with [OpenTUI](https://opentui.com) and React,
runs on Bun, and ships as one Bun-compiled binary beside `supertag`. It shares its Gateway
client, transcript rules and React hooks with the desktop app through `@supertag/client`
(`apps/client`); nothing here is a public package. It is not yet released.

## What it shows

- **The list** on the left, in four sections. **Tags**: the lead Tag first (`★`), the others by
  latest activity, each with a short time (`14:05`, `Yday`, `Mon`), its name in bold while it has
  unread replies, and a preview line: `working…` while it works, `N new · …` for unread replies.
  **Objectives** (outcomes a Tag owns): the open ones, with spend against a budget (`$12.50 of
  $300`) or why one is held (`blocked`, `limited`, `review`, `paused`). **Waiting on you (N)**:
  the inbox items an operator decides, `?` a question, `!` an approval request. **Teams**, with
  their member count. Only what fits is mounted; the list scrolls to keep the selected row in
  view. Ctrl-B folds it to the Tags' initials (`★` lead, `•` unread, `…` working); `[` and `]`
  resize it from the list. Both are remembered. In a narrow terminal it takes at most 40% of the
  width.
- **The conversation**: messages only, never activity. Your messages on the right, the Tag's on
  the left as Markdown with highlighted code; the text a running turn writes streams in place;
  `···` while the Tag works; why a queued turn waits for a Worker Host; time dividers where 15
  minutes passed. Under your last message: `Sending…`, `Sent`, `Seen`, or `! Not delivered`
  (Ctrl-R retries with the same operation, so the Gateway accepts it at most once; Ctrl-X puts it
  back in the composer). The newest 40 messages are mounted; PgUp at the top mounts more, then
  reads earlier ones. Scrolled up, a line counts new messages until End. Under the reply that
  created an Objective (`Created Objective ID: …`), a line says when it is ready for review,
  complete, or cancelled.
- **The composer**: one line; Enter sends, and pasted lines join with spaces. A draft is kept per
  Tag across Tag switches and launches. A
  message sent waits in the outbox, on disk, until the Gateway accepts it, and is sent again at
  the next launch; another can be sent meanwhile, and Ctrl-R sends every one not delivered
  again, oldest first. `/` as a message's first character lists the commands above the composer
  (see [Commands](#commands)). `/goal OUTCOME` goes to the conversation like any message, and
  the Gateway creates an Objective the Tag owns; `/goal` alone opens the new Objective form. ↑ on
  an empty message opens Work Sessions.
- **An Objective** (selected in the list): what `supertag describe objective` shows, kept current.
  `m` sends its owner a follow-up in the Objective's Session and shows the reply (Esc keeps the
  draft); while it is ready for review, `a` approves it and `c` asks for changes.
- **The new Objective form**: the outcome and a budget such as `300 USD` or `$12.50` (empty:
  none). It starts the owner's
  first turn; when that could not start, `r` starts it once the cause is fixed, with the same ID.
- **An inbox item**, opened in place: type the answer to a question and press Enter; on an
  approval request, `a` then Enter approves it once, `d` denies it with a reason. Esc cancels.
- **A Team**: its members, how many of their turns may run at once, and its newest Workstream
  posts, kept current.
- **Work Sessions**: the longer work the conversation's turns started, each with its state.
  Enter expands one (its Session, latest Task, the commands and tools it ran, its report, what it
  delivered). `d` shows its branch's `git diff BASE...BRANCH`, computed in the directory the
  terminal UI started in (the Gateway keeps no repository contents; a missing branch is fetched
  from `origin`, never with a prompt, and the pane says why when it cannot diff). `o` opens its
  pull request with `open` or `xdg-open`.
- **New Tag** (Ctrl-N): a name, from which the ID is derived as `supertag init` names Tags; a
  harness and a Workspace from what the connected Worker Hosts offer; Work Sessions open at once;
  and Web access, on unless the harness's hosts have no network (the desktop app's rules, from
  `@supertag/client`). On Local, "Choose a folder…" adds a folder of this machine with
  `supertag workspace add`. Operators only.
- **The palette** (Ctrl-K): Tags with their Alt-N keys (which open one at once, there too),
  found by name, ID or latest message, then every [command](#commands) with its key and `/`
  name: Create Objective (typing `/goal OUTCOME` there sends it), New Tag, Open inbox, Work
  Sessions, Memory (what the Tag's harness keeps on this machine, with the changes Work Sessions
  proposed to it; `x` deletes one), Schedules (`p` pauses or resumes, `x` deletes), Network
  (operators only), Activity, Gateways, Fold, Keyboard shortcuts, Quit. Esc or Ctrl-K closes it.
- **Gateways** (Ctrl-P): Local, and the Gateways saved with `supertag connect` or in the desktop
  app. The saved ones list at once; Local's row says where it runs, that it is stopped (Enter
  starts it), that SuperTag is not set up here, or why the CLI could not say (it gives up after
  12 seconds). `a` adds one with `supertag connect`: a name, the URL, an Operator Token or a client Auth
  Key (which enrolls this device as `client:HOSTNAME`), and optional TLS files (Ctrl-U clears the
  masked credential). `s` saves the Gateway the launch named (`--gateway URL`) the same way, and
  `e` changes a saved one's credential or TLS files (one saved in the desktop app is changed
  there). `d` forgets a saved one and its cache: with `supertag disconnect`, or from the desktop
  app's store.
- **The status line**: the Gateway, its connection (`not answering, reconnecting…` while its
  Watch is down; the follow and the Watch reopen on their own), its Worker Hosts by phase
  (operators only), and unread replies outside the conversation in front. When connecting fails
  while the cache shows, why (such as a Gateway on another SuperTag protocol, naming both
  releases and which to upgrade) shows in full above the list, and it keeps trying.
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
4. Nothing (or only `--state-directory`): the Gateway used last, else Local when it runs or was
   set up, else the first saved Gateway, else Local when SuperTag is not set up here, else the
   Gateway chooser.

Without `--gateway`, Local follows the desktop app's startup (`apps/desktop/src/startup.ts`,
sharing `@supertag/client/node`'s `local-services.ts`): services that were set up but are
stopped start with `supertag up --state-directory DIR` under "Starting SuperTag…", and a failed
start shows what `up` printed (`r` tries again); a local Gateway of an older release is offered
"Restart SuperTag with VERSION" (`supertag down`, then `supertag up`), confirmed first because
its running Tasks are interrupted; when SuperTag is not set up, it says to run `supertag init` in
a repository, and connects once Local runs. The chooser opens a stopped Local by starting it.
`--gateway local` never starts the services.

The CLI it runs (for `__local-gateway`, `up`, `down` and `connect`) is `SUPERTAG_CLI`, else `supertag` beside
the binary, else `supertag` on `PATH`. It reads `SUPERTAG_STATE_DIR`, `HOME`, `XDG_CONFIG_HOME`,
`XDG_CACHE_HOME`, `TERM`, `COLORTERM`, `TERM_PROGRAM`, `TMUX` and `SUPERTAG_TUI_NOTIFY`; a
launcher passes the environment through.

## Files

| File | What |
| --- | --- |
| `<config>/supertag/tui.json` | The Gateway used last, whom each Gateway's credential acted as (so a launch paints that Gateway's cache before connecting), the Tag list's width and fold. Never a credential |
| `<user cache>/supertag/tui/` | Per Gateway and principal, owner-only: the Tags and conversation list, each conversation's latest 50 messages, the outbox, drafts. Never a credential. `<user cache>` is `~/Library/Caches` on macOS, else `$XDG_CACHE_HOME` or `~/.cache` |

## Commands

One registry, `src/commands.ts`, holds every command: its ID, title, one-line description,
`/` name and aliases, argument hint, key, when it is available, and what it does. The slash
popup, the palette, the keys outside a panel, and the Keyboard shortcuts screen all read it.

| Command | Key | Does |
| --- | --- | --- |
| `/goal <outcome>` | | With an outcome, sends `/goal OUTCOME` to the conversation; alone, opens the new Objective form |
| `/new` | Ctrl-N | New Tag |
| `/inbox` | | Opens the first inbox item |
| `/work` | ↑ on an empty message | Work Sessions |
| `/memory`, `/schedules`, `/network`, `/activity` | | The Tag's panels |
| `/gateways` (`/gateway`) | Ctrl-P | Gateways |
| `/fold` | Ctrl-B | Folds the Tag list to initials, or expands it |
| `/help` | | Keyboard shortcuts |
| `/quit` (`/exit`, `/q`) | Ctrl-C | Quit |
| | Ctrl-K | The palette |

`/` as the first character of a message opens the popup above the composer, and the `/` stays in
the composer. It lists every command by name with its description; typing narrows them (the start
of a name first, then within it, then a word of the description; at most 10). ↑ ↓ (Ctrl-P
Ctrl-N) choose, wrapping around; Tab completes the name; Enter runs a command that takes no
argument and empties the composer, and writes one that takes an argument as `/goal ` to type it
after (a line over the composer shows its hint). Esc closes the popup and keeps the text (typing
opens it again); Ctrl-C closes it and drops the text. A space after the name closes it. Enter never
sends while it is open. A `/` later in a message, a path such as `/usr/bin` (a second `/`), and a
name no command has are sent as text. Sent in full, `/name` runs the command, and `/goal OUTCOME`
goes to the conversation; a command that takes no argument, given one (`/help me with this`), is a
message.

## Keys

Enter send · `/` commands · Ctrl-K palette · Ctrl-N New Tag · Ctrl-P Gateways · Alt-1…9 (or Ctrl-1…9
where the terminal reports it) the nth Tag ·
Alt-↑/↓ (Alt-k/j) previous or next Tag · → from the list to the pane · ← from the pane to the
list · Tab between the list and the pane · ↑/↓ (k/j) in the list · ↑ on an empty message Work
Sessions · `m` message an Objective's owner · `a`/`d` approve or
deny · Ctrl-B fold · `[` `]` resize · PgUp/PgDn scroll · End or Ctrl-End latest · Ctrl-R retry ·
Ctrl-X edit · Esc close · Ctrl-C quit. The Keyboard shortcuts screen (`/help`, or in the palette)
lists the commands from `src/commands.ts`, then the keys no command runs from `src/keys.ts`.

← and → never take a key a field needs. → in the list moves the keys to the pane in front: the
composer, or the Objective, inbox item, or Team the list selected. ← in the pane moves them back
to the list, whose selection stays on the row in front, only when the field that has the keys is
empty or its cursor is at the start (or the pane has no field); otherwise ← moves the cursor, and
→ at the end of the text does nothing. With Ctrl, Alt, or Shift they move and select in the text
as before. ← also closes Work Sessions and the Tag panels (Memory, Schedules, Network, Activity),
back to the list; the palette, Gateways, New Tag, and the new Objective form keep ← for their
fields. The list's border and selected row are brighter while it has the keys; the composer's
border while the conversation does.

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

`scripts/stack.sh` runs a throwaway SuperTag with state under `/tmp/supertag-tui` (mode 700,
`TUI_ROOT`), the Control Plane on `127.0.0.1:47451` (`TUI_PORT`), and four Worker Hosts on the
fixture adapter, which answers every message. `stack.sh tag ID LABEL` picks one by its label:
`plain` (the default) only answers; `coord` also starts a Work Session from each conversation
turn and schedules a wake-up; `ask` asks the operator when an Objective's turn says
"Ask which branch to release"; `approve` posts to its Team's Workstream and waits for an
approval. It never touches `~/.supertag`. `stack.sh tui` runs Bun with a short `PATH`; set
`BUN=/tmp/bun/bin/bun` when Bun is elsewhere. With `SUPERTAG_TUI_BINARY` set, `stack.sh tui` and
`tmux-e2e.sh` run that compiled binary through the CLI's launcher (`supertag tui`) instead, as the
`tui-e2e` CI job does on Linux.

```sh
(cd ../../core && cargo build -p supertag-cli --features test-fixtures \
  --bin supertag --bin supertag-fixture-adapter)
sh scripts/stack.sh up && sh scripts/stack.sh tag engineer && sh scripts/stack.sh tag lead
sh scripts/stack.sh tui --gateway local   # try it
sh scripts/tmux-e2e.sh engineer           # send, paste, Alt-2, notify, the Gateway restarting, inbox,
                                          # /goal, Work Sessions, Schedules, a Team, New Tag,
                                          # save and forget a Gateway
TUI_BINARY=/tmp/supertag-tui/dist/supertag-tui-darwin-arm64 SUPERTAG_CLI=../../core/target/debug/supertag \
  bun bench/first-paint.ts 10             # first paint in a PTY, 30 ms round trip
sh scripts/stack.sh down
```

## Performance budgets

`bench/perf.tsx` (test renderer, 30 Tags, 20 Objectives, 15 inbox items, a 300-turn Markdown
conversation): keystroke to frame
p95 ≤ 8 ms at 250×70; a page of 32 streamed updates blocks the event loop ≤ 16 ms; keys typed
during a stream arrive in order; memory held after the 300-turn conversation streamed ≤ 250 MB,
measured in a process of its own after a full collection, as anonymous memory (Linux's RSS also
counts the 40–50 MB of the executable and OpenTUI's library mapped from disk, which macOS's leaves
out). `bench/first-paint.ts` (compiled binary in a PTY,
30 ms round trip, 50 Markdown turns): median first launch ≤ 352 ms and next launch (from the
cache) ≤ 163 ms, the Go TUI's medians plus 50 ms.
