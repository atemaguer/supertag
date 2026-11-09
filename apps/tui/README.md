# supertag-tui

SuperTag's experimental terminal UI, written in Go with Bubble Tea v2, Lip Gloss v2, Bubbles v2
and Glamour. The status bar shows which Control Plane it talks to. The rail on the left has three
sections:

- **Tags**, each with its state. The main pane holds your default conversation with the selected
  Tag: its recent history first, then the reply streaming in, and work Sessions as they run and
  report.
- **Objectives**, the open ones, each with its spend against a budget in a currency, or why it is
  held (`blocked`, `limited`, `review`, `paused`). Selecting one shows what
  `supertag describe objective` shows, kept current.
- **Waiting on you (N)**, the inbox items an operator decides: `?` marks a question, `!` an
  approval request. Selecting one opens it in place. Type the answer to a question and press
  enter. On an approval request, press `a` then enter to approve it once, or `d` to deny it and
  type the reason. Esc cancels either. Other items show the commands that act on them.

Tab moves between the rail and the main pane; up and down (or `k` and `j`) move through the rail,
and enter opens the row. Esc and Ctrl-C quit. Every text from the server or an agent is filtered
for the terminal, so an escape sequence shows as text.

It talks to the Control Plane through the operator API's generated Go client in
`packages/operator-api/go`, using the Connect protocol over HTTP/1.1. `ConversationService` sends
messages, lists the history and follows each reply, resuming a dropped stream where it left off.
`ObjectiveService` lists the open Objectives and describes the selected one. `InboxService` lists
the inbox, answers questions and decides approval requests. `EventService.Watch` keeps the rail
and the Objective view current, including how many work Sessions of each default conversation are
still open and the Workstream posts of the shown Objective's Team. While that stream is down, the
TUI rereads what it shows every five seconds. The Tags themselves come from `GET /api/v1/tags`. See
`contributing/tui-design.md`.

Build with `./build.sh`, which cross-compiles static binaries for macOS and Linux (arm64 and
amd64) into `dist/supertag-tui-GOOS-GOARCH`, versioned from `packages/supertag-ai/package.json`.
Run the tests with `go test ./...`.

Plain `supertag`, run in an interactive terminal, launches it. The CLI resolves the Control
Plane URL and token as every other command does, starts the binary with an extra pipe as file descriptor 3, and writes one JSON line
`{"url": ..., "token": ..., "name": ...}` to it. The binary never reads `~/.supertag` and takes no
token from its arguments; started any other way, it prints `Run supertag in a terminal to start the
terminal UI.` and exits 2.
