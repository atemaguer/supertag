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

The TUI lists Tags with your one conversation with each, loads conversation history, sends
messages, and follows replies. Watch keeps the rail and open conversation current across clients.
The TUI resumes Watch after an interruption and polls while reconnecting. Each message of a
history page carries what its turn showed, every message the Tag wrote and its latest activity,
so a finished turn reads nothing more. Rereading a conversation asks only for what changed since
the copy on screen: the messages after its latest and the turns it holds unfinished. A running
turn reads its new events through `Operator.ListEvents` each second, and reads the turn itself
once its events go quiet; a queued turn reads only the turn. A history page reads its messages'
work Sessions concurrently, and each conversation stays in memory, so returning to it shows it at
once.

The TUI also keeps a cache on disk, so `supertag` shows the last Tag's conversation before any
call to the Control Plane: the Tag list with each conversation's row, the selected Tag, the latest
50 messages of each conversation shown, with their rendering at the terminal's width, messages not
yet sent, and unsent drafts. It lives in `supertag/tui/` in the user cache directory, with an
owner-only directory per Control Plane and principal and an owner-only file per entry, each
written in one step as `{"schemaVersion": 1, "value": ...}`; an entry in another schema is
discarded. The principal is the one `Enrollments.WhoAmI` named the last time this credential
connected, found by a one-way digest of the credential, so a message sent while the Control Plane
is unreachable is still kept. Each launch asks again: nothing is written before a principal is
known, and when the Control Plane names another one, what the cache showed is dropped. The cache never holds a credential. Forgetting a saved Control Plane deletes its cache.
`docs/reference/credential-storage.md` describes it beside the desktop app's.

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

- **Tags**, the lead Tag first with a star, then the others by their conversation's latest
  activity. Each shows its state and, under it, the latest message of your conversation with it.
  The state says `working` while a Task of that conversation is queued or running, `N new` for
  replies you have not read, whose preview is bold, and otherwise when the conversation was last
  active (`14:05`, `Yday`, `Mon`). The main pane holds your one conversation with the selected
  Tag: its history across every Session, then the reply streaming in, and work Sessions as they
  run and report. Showing a finished reply marks the conversation read.
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

The conversation reads like a messaging app. Consecutive messages from you or the Tag form one
group under one name, and a time divider (`Today 10:16 PM`, `Yesterday 9:02 AM`) starts the
history and marks each pause of more than fifteen minutes. Each message the Tag writes while it
works, starting with its sentence of intent, is its own message, and its result follows, rendered
as markdown. Under your last message the TUI shows `Sending…` until the Control Plane accepts it,
then `Sent`, and `Seen` once a Worker Host took its turn up. While its turn runs, an animated
`···` stays as the turn's last line, after its intent and any messages it writes, with what it
is doing now as a dim caption beside it, until the result arrives. A sent message
shows at once and waits in an outbox, kept on disk, until the Control Plane accepts it; the next
launch sends what is left again with the same operation ID, so the Tag gets it at most once. One
that was not delivered says `! Not delivered`: Ctrl-R sends it again, and Ctrl-X takes it back
into the input to edit. Scrolled up, the title counts the Tag's messages that arrived since, and
End on an empty input (or Ctrl-End) jumps to the latest. What you type stays with each Tag
when you switch Tags and when you quit.

Alt-1 to Alt-9 (or Ctrl-1 to Ctrl-9 where the terminal reports them) open the Tags in rail
order, and Alt-↑ and Alt-↓ (or Alt-k and Alt-j) the previous and next Tag. On macOS, Alt keys
need the terminal to send Option as Meta. Ctrl-B folds the rail into a narrow column of Tag
initials, starred for the lead, with `•` for unread replies and `…` while a Tag works, or expands
it again. While the rail has the focus, `[` and `]` make the expanded rail narrower or wider. The
TUI keeps both choices in `preferences.json` beside its cache.

Ctrl-N, or **New Tag** in the command palette, opens a short form to create a Tag: its name, from
which the permanent ID is derived as `supertag init` names Tags, a harness, and optionally a
Workspace. Up and down move between the fields, left and right choose the harness and Workspace,
and enter on the Workspace creates the Tag. The harnesses and Workspaces come from the connected
Worker Hosts (`Operator.ListHosts`), and every harness is offered when none is connected. Like the
lead Tag `supertag init` creates, the new Tag may edit files and run commands. It is created with
`Operator.PutTag` fenced at revision zero, so it never replaces another Tag, and is selected once
created. Only operators may create Tags: a client device is told so instead.

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
- **New Tag** opens the form to create a Tag, as Ctrl-N does.

Tab moves between the rail and the main pane; up and down (or `k` and `j`) move through the rail,
and enter opens the row. Esc quits when there is nothing to go back from, and Ctrl-C quits.
Every text from the server, an agent or a diff is filtered for the terminal, so an escape sequence
shows as text.

It talks to the Control Plane through the generated runtime v2 Go client in
`sdks/go`. `Conversations` sends messages, lists your conversations with their previews and
unread replies, reads their history and what changed in it, and marks them read.
`Operator.ListEvents` reads a running turn's new events. `Operator.PutTag` creates Tags.
`Enrollments.WhoAmI` names the principal the cache is kept for. `Objectives` lists the open Objectives, describes the selected
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
Run the tests with `go test ./...`. `typing_bench_test.go` guards typing latency, and
`BenchmarkFirstConversation` in `firstpaint_bench_test.go` measures how long a launch takes to show
the last Tag's conversation, without a cache and with one. The ignored tests in `core/crates/cli/tests/operator_runtime.rs`
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
