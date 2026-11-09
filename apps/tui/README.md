# supertag-tui

A spike of SuperTag's terminal UI, written in Go with Bubble Tea v2, Lip Gloss v2, Bubbles v2 and
Glamour. It lists the organization's Tags on the left and holds your default conversation with
the selected Tag on the right: its recent history first, then the reply streaming in, and work
Sessions as they run and report. The status bar shows which Control Plane it talks to.

It talks to the Control Plane through the operator API's generated Go client in
`packages/operator-api/go`, using the Connect protocol over HTTP/1.1. `ConversationService` sends
messages, lists the history and follows each reply, resuming a dropped stream where it left off.
`EventService.Watch` keeps the Tag rail current, including how many work Sessions of each
default conversation are still open. While that stream is down, the rail rereads the
Tags every five seconds. The Tags themselves come from `GET /api/v1/tags`. See
`contributing/tui-design.md`.

Build with `./build.sh`, which cross-compiles static binaries for macOS and Linux (arm64 and
amd64) into `dist/supertag-tui-GOOS-GOARCH`, versioned from `packages/supertag-ai/package.json`.
Run the tests with `go test ./...`.

Plain `supertag`, run in an interactive terminal, launches it. The CLI resolves the Control
Plane URL and token as every other command does, starts the binary with an extra pipe as file descriptor 3, and writes one JSON line
`{"url": ..., "token": ..., "name": ...}` to it. The binary never reads `~/.supertag` and takes no
token from its arguments; started any other way, it prints `Run supertag in a terminal to start the
terminal UI.` and exits 2.
