# supertag-tui

A spike of SuperTag's terminal UI, written in Go with Bubble Tea v2, Lip Gloss v2, Bubbles v2 and
Glamour. It lists the organization's Tags on the left and holds your default conversation with
the selected Tag on the right: the reply streams in, work Sessions show as they run and report,
and the status bar shows which Control Plane it talks to. It is a client of the Control Plane HTTP
API only; see `contributing/tui-design.md`.

Build with `./build.sh`, which cross-compiles static binaries for macOS and Linux (arm64 and
amd64) into `dist/supertag-tui-GOOS-GOARCH`, versioned from `packages/supertag-ai/package.json`.
Run the tests with `go test ./...`.

Plain `supertag`, run in an interactive terminal, launches it. The CLI resolves the Control
Plane URL and token as every other command does, starts the binary with an extra pipe as file descriptor 3, and writes one JSON line
`{"url": ..., "token": ..., "name": ...}` to it. The binary never reads `~/.supertag` and takes no
token from its arguments; started any other way, it prints `Run supertag in a terminal to start the
terminal UI.` and exits 2.
