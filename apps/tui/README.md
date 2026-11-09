# supertag-tui

SuperTag's experimental terminal UI, written in Go with Bubble Tea v2, Lip Gloss v2, Bubbles v2
and Glamour. The status bar shows which Control Plane it talks to. The rail on the left has four
sections:

- **Tags**, each with its state. The main pane holds your conversation with the selected Tag,
  the `default` one at first: its recent history, then the reply streaming in, and work Sessions
  as they run and report.
- **Objectives**, the open ones, each with its spend against a budget in a currency, or why it is
  held (`blocked`, `limited`, `review`, `paused`). Selecting one shows what
  `supertag describe objective` shows, kept current.
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

Tab moves between the rail and the main pane; up and down (or `k` and `j`) move through the rail,
and enter opens the row. Esc quits when there is nothing to go back from, and Ctrl-C quits.
Every text from the server, an agent or a diff is filtered for the terminal, so an escape sequence
shows as text.

It talks to the Control Plane through the operator API's generated Go client in
`packages/operator-api/go`, using the Connect protocol over HTTP/1.1. `ConversationService` sends
messages, lists your conversations and their history, and follows each reply, resuming a dropped
stream where it left off. `ObjectiveService` lists the open Objectives and describes the selected
one. `InboxService` lists the inbox, answers questions and decides approval requests.
`WorkService.GetSession` reads a work Session's delivery, and `ListTaskEvents` its latest Task's
commands and tool calls. `TeamService` lists and reads the Teams, and
`MailboxService.ListWorkstreamPosts` reads the shown Team's Workstream. `EventService.Watch` keeps
the rail, the Objective view, the Team view and expanded work Sessions current, including how many
work Sessions of each shown conversation are still open. While that stream is down, the TUI
rereads what it shows every five seconds. The Tags themselves come from `GET /api/v1/tags`. See
`contributing/tui-design.md`.

Build with `./build.sh`, which cross-compiles static binaries for macOS and Linux (arm64 and
amd64) into `dist/supertag-tui-GOOS-GOARCH`, versioned from `packages/supertag-ai/package.json`.
Run the tests with `go test ./...`. The end-to-end test runs the built binary through
`supertag` under tmux, in a throwaway git checkout: `SUPERTAG_TUI_E2E=1 go test -run TestEndToEnd -v .`

Plain `supertag`, run in an interactive terminal, launches it. The CLI resolves the Control
Plane URL and token as every other command does, starts the binary with an extra pipe as file descriptor 3, and writes one JSON line
`{"url": ..., "token": ..., "name": ...}` to it. The binary never reads `~/.supertag` and takes no
token from its arguments; started any other way, it prints `Run supertag in a terminal to start the
terminal UI.` and exits 2.
