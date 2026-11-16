# supertag-tui

SuperTag's terminal UI, written in Go with Bubble Tea v2, Lip Gloss v2, Bubbles v2
and Glamour.

## Launch and connections

Plain `supertag` in an interactive terminal, or `supertag tui`, launches the binary
`supertag-tui` installed beside the CLI (`--binary` or `SUPERTAG_TUI_BINARY` names another). The
CLI first checks that `supertag-tui --version` matches its own version. It hands over a Control
Plane URL and an operator credential over file descriptor 3 and sets `SUPERTAG_TUI_HANDOVER=3`.
The TUI reads descriptor 3 only when that variable is set, so a plain launch with no handover never touches a descriptor it does not own. The handover
identifies the protocol as `runtime.v2` and can include a trusted server certificate authority and
client certificate and key paths. The TUI uses the generated runtime v2 Go bindings over gRPC and
HTTP/2. A `wss://` Control Plane URL carries the same connection through a WebSocket tunnel, as the
CLI does, with the Control Plane's TLS and any client certificate inside it; the server
certificate authority also checks the tunnel's outer certificate. Cleartext `http://` and `ws://`
connections require a loopback IP address.

The TUI lists Tags and named conversations, loads conversation history, sends messages, and
follows replies. Watch keeps the rail and open conversation current across clients. The TUI
resumes Watch after an interruption and polls while reconnecting. Each reply follows its own
Task event sequence.

Ctrl-P opens **Control Planes**, including when only one connection exists. Press `a` to add a
Control Plane, enter a name, its URL, and an operator token in the masked field, then press Ctrl-S
to verify access and save it. Optional certificate fields support private TLS authorities and
client identities. `s` saves the current launch connection; `e` edits a selected saved
connection's credential without moving it to a different Control Plane URL. Enter switches, and
`d` forgets the selected saved connection. Switching cancels the previous Control Plane's
requests and subscriptions and loads only the selected Control Plane's Tags and conversations.

Saved connections use a private native file, `supertag/tui-control-planes.json` under the operating
system's user configuration directory, with owner-only permissions. It is separate from the
local service credentials and the desktop app's store. A launch handover keeps its selected
Control Plane and credentials; saved connections add to the chooser. Without a launch handover,
`supertag-tui` reopens the last selected saved Control Plane, else the local Control Plane while
it runs, else the first saved one, or shows the empty chooser for adding the first one. The token
never appears in command arguments or the terminal display.

### The local Control Plane

While `supertag up` runs a Control Plane from this user's state directory (`SUPERTAG_STATE_DIR`,
else `~/.supertag`), the Control Planes list shows it first as **Local**, marked
`[this machine]`, and it connects with no token to enter. `supertag-tui` asks the `supertag`
command installed beside it (else the one on `PATH`) with the internal
`supertag __local-control-plane`, so the CLI's own code checks the state directory: it must be
private to this user, the supervisor must hold its lock, and the endpoint must be a loopback
address. The command prints one JSON object to a pipe and refuses a terminal:
`{"protocol": "local-control-plane.v1", "running": true, "state_directory": ..., "url": ...,
"token": ...}`, or `"running": false` with a `message` naming the command that starts it.
`core/crates/cli/tests/local_control_plane.rs` pins that format.

The local operator token is read again each time you choose Local and is never saved, because
`supertag up` may replace it; Local cannot be edited, saved, or forgotten. Choosing Local leaves
no saved Control Plane selected, so the next launch opens Local again. Ctrl-P checks again, so a
Local Control Plane started after launch appears; when none runs, the list says so and how to
start one (`supertag up`), and the saved Control Planes stay available.

Open Objectives show their status, owner, deadline, and available spend information. Send
`/goal <outcome>` in a Tag's conversation to create an Objective or press `m` in an Objective to
message its owner. You can select a Team in the Objective form and read its members, concurrency
limit, and recent Workstream posts from the rail. Work uses the Workspace configured on the owner
Tag. The rail lists questions waiting for an
operator. Select a question to answer the owner in the same Session, its thread of work. The status bar shows whether Worker Hosts, the machines or
sandboxes that run Tasks, are ready, busy, draining, or offline.

## Using the terminal UI

The status bar shows which Control Plane it talks to, its Worker Hosts by phase
(such as `Worker Hosts: 2 ready, 1 unreachable`; revoked hosts are left out), and whether it is
reachable. The conversation opens after the Control Plane returns a Tag. An empty Tag list
shows setup instructions. The rail on the left has four sections:

- **Tags**, each with its state. The main pane holds your conversation with the selected Tag,
  the `default` one at first: its recent history, then the reply streaming in, and work Sessions
  as they run and report.
- **Objectives**, the open ones, each with its spend against a budget in a currency, or why it is
  held (`blocked`, `limited`, `review`, `paused`). Selecting one shows what
  `supertag describe objective` shows, kept current. Press `m` to message its owner. Enter sends
  the follow-up, and Esc closes the composer and keeps the draft. The pane shows the latest
  follow-up and reply from this terminal UI session. Replies on collaboration surfaces post in
  the thread where the Objective started.
- **Waiting on you (N)**, the inbox items an operator decides: `?` marks a question, `!` an
  approval request. Selecting one opens it in place. Type the answer to a question and press
  enter. On an approval request, press `a` then enter to approve it once, or `d` to deny it and
  type the reason. Esc cancels either. Other items show the commands that act on them.
- **Teams**, each with its number of members. Selecting one shows its members, its turn limit and
  the newest posts of its Workstream, kept current.

In a conversation, up on an empty input selects the last work Session line; up and down move
between work Session lines and branch lines. Enter expands a work Session line to show its
Session and latest Task, the commands and tools that Task ran, its report, and what it delivered.
A work Session that delivered a branch gets a branch line after its report. On either line, `d`
shows the branch's diff and `o` opens its pull request with `open` on macOS or `xdg-open` on
Linux. Typing returns to the input, and esc leaves the selection.

The diff is `git diff BASE...BRANCH`, computed in the directory you started `supertag` in: the
Control Plane keeps no repository contents. That directory must be a git checkout of the
Workspace. The TUI diffs the head commit the Worker recorded, or the branch itself when the
Worker recorded none. When the checkout lacks it, the TUI fetches the branch from the checkout's
`origin` remote, or its first remote. Git runs
without a terminal, so a fetch that needs credentials fails instead of prompting. When the diff
cannot be computed, the pane says why and shows the pull request's address. The diff scrolls with
up, down, page up and page down; esc goes back.

Ctrl-O lists your conversations with the selected Tag, the most recent first, with their open
work and latest entry. Enter switches to one. `n` starts a new conversation: type its name (1 to
64 letters, digits, `.`, `_` or `-`, starting with a letter or digit) and press enter. The Tag's
rail state counts the open work Sessions of the conversation it shows. Esc goes back.

Ctrl-P lists the Control Planes you can switch to: Local while `supertag up` runs one on this
machine, the one the CLI handed over, and each one saved in the terminal UI or with
`supertag connect`. Enter switches to the one under the cursor, and esc goes back. Adding a Control Plane takes an
operator token, or a client Auth Key (`stak_…`) from an operator. An Auth Key joins this device as
`client:HOSTNAME` once; only the device's own credential is saved. A client device sees its own
conversations and Objectives within the Tags its key allows, and no Worker Host status. Switching ends every stream and call
to the Control Plane you leave and reads everything anew from the next; unsent input stays behind.

Ctrl-K, or `/` on an empty input line or where the pane has none, opens the command palette.
From a Tag's conversation, type `/goal <outcome>` and press enter. It goes to the conversation
like any other message, and the Control Plane creates an Objective that the Tag owns, answers with
its ID, and starts the owner's first turn. Type `/goal` on its own to open the form instead.
The Objective works in the Workspace configured on its owner Tag.

Type to filter the palette commands, move with up and down, and press enter to run one. Esc goes
back.

- **New conversation** names a new conversation with the selected Tag, as `n` in the Ctrl-O list.
- **Switch conversation** opens the Ctrl-O list.
- **`/goal` · Create Objective** opens a form for an Objective owned by the selected Tag: its outcome, the
  Team its owner may hand work to (empty, it works alone), and a budget such as `300 USD` or
  `$12.50` (empty, no budget). Up and down move between the fields; enter moves to the next and,
  on the budget, creates the Objective, which starts at once. The pane then says whether its
  owner took its first turn, with any warnings, and enter shows the Objective. When it could not
  start, such as for an owner without a connected Worker Host, `r` starts it once that is fixed.
- **Control Planes · add or switch** opens the Ctrl-P list.
- **Task files** lists the files a completed Task captured, by Task ID, and saves the chosen one
  to a destination you type.
- **Open inbox** shows the first item waiting on you, with the rail on it.

Tab moves between the rail and the main pane; up and down (or `k` and `j`) move through the rail,
and enter opens the row. Esc quits when there is nothing to go back from, and Ctrl-C quits.
Every text from the server, an agent or a diff is filtered for the terminal, so an escape sequence
shows as text.

It talks to the Control Plane through the generated runtime v2 Go client in
`sdks/go`. `Conversations` sends messages, lists your conversations and their history,
and pages each reply's Task events. `Objectives` lists the open Objectives, describes the selected
one, and creates Objectives. `Inbox` lists the inbox, answers questions and decides approval
requests. `WorkSessions` reads a work Session's delivery and activity. `Teams` lists and reads the
Teams and the shown Team's Workstream. `OperatorEvents.Watch` keeps the rail, the Objective view,
the Team view and expanded work Sessions current. While that stream is down, the TUI rereads what
it shows every five seconds. `Operator.ListHosts` feeds the status bar, reread every 15 seconds;
when the Control Plane refuses it, the status bar leaves the Worker Hosts out. `Operator.ListTags`
lists the Tags. The replies are projected into the TUI's own presentation types in `views/`. See
`contributing/tui-design.md`.

Build with `./build.sh`, which cross-compiles static binaries for macOS arm64 and Linux arm64 and
amd64 into `dist/supertag-tui-GOOS-GOARCH`. It uses the workspace version from `core/Cargo.toml`
by default. Set `SUPERTAG_TUI_VERSION` when building for a launcher with a
different version.
Run the tests with `go test ./...`. The ignored tests in `core/crates/cli/tests/operator_runtime.rs`
drive a built binary end to end under tmux when `SUPERTAG_RUST_TEST_TUI` names it.

The CLI resolves the Control Plane as every other command does (`--control-plane`,
`--state-directory`, `SUPERTAG_CONTROL_PLANE_URL`, or this machine's local services), starts the
binary with a socket as file descriptor 3, sets `SUPERTAG_TUI_HANDOVER=3`, and writes one JSON
object to it:
`{"protocol": "runtime.v2", "current": 0, "contexts": [{"url": ..., "token": ..., "workspace": ...,
"server_ca_file": ..., "client_cert_file": ..., "client_key_file": ...}]}`. The TUI refuses a
handover that names another protocol or none. A handed-over local Control Plane becomes the Local
entry. The CLI also passes the state directory it resolved as `SUPERTAG_STATE_DIR`, so Local is
found in the same place. With nothing selected and no local services running, the CLI starts the
binary without a handover, and it opens on the saved Control Planes.
A saved connection whose credential cannot be read is left out. The binary takes no token from its
arguments or environment; the saved-connection flow is described above.
