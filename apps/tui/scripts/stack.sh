#!/bin/sh
# A throwaway local SuperTag for trying the terminal UI against real services: state and HOME
# under $TUI_ROOT (default /tmp/supertag-tui, mode 700), the Control Plane on 127.0.0.1:$TUI_PORT
# (default 47451), and four Worker Hosts running the fixture adapter, which answers every
# message. Each carries a label a Tag's runsOn picks: `plain` only answers; `coord` also starts a
# Work Session from each conversation turn, keeps a note and schedules a wake-up; `ask` asks the
# operator when an Objective's turn says "Ask which branch to release"; `approve` posts to its
# Team's Workstream, which waits for an operator's approval. Never touches ~/.supertag or :3434. Build the
# binaries first, in core/:
#   cargo build -p supertag-cli --features test-fixtures --bin supertag --bin supertag-fixture-adapter
#   stack.sh up | tag [ID [LABEL [TAG PUT ARGS...]]] | down | cli ARGS... | tui [ARGS...]
set -eu
here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../../.." && pwd)
root=${TUI_ROOT:-/tmp/supertag-tui}
cli=${SUPERTAG_CLI:-$repo/core/target/debug/supertag}
adapter=${SUPERTAG_ADAPTER:-$repo/core/target/debug/supertag-fixture-adapter}
bun=${BUN:-bun}
state=$root/state
home=$root/home
port=${TUI_PORT:-47451}

run() {
  env -i PATH=/usr/bin:/bin HOME="$home" SUPERTAG_STATE_DIR="$state" TERM="${TERM:-xterm-256color}" "$cli" "$@"
}

case ${1:-} in
  up)
    mkdir -p "$state" "$home"
    chmod 700 "$root" "$state" "$home"
    cat >"$state/supertag.yaml" <<EOF
version: 1
name: tui-try
services:
  control-plane:
    type: control-plane
    ports: ["127.0.0.1:$port"]
  fixture-host:
    type: host
    adapter: $adapter
    labels: [plain]
  coord-host:
    type: host
    adapter: $adapter
    labels: [coord]
    adapter-args:
      - --work-session-flow
      - --remember=The release branch is main.
      - --schedule=2h
  approve-host:
    type: host
    adapter: $adapter
    labels: [approve]
    adapter-args: [--workstream-approval]
  ask-host:
    type: host
    adapter: $adapter
    labels: [ask]
    adapter-args: [--objective-question]
EOF
    run up --state-directory "$state"
    ;;
  tag)
    id=${2:-engineer}
    label=${3:-plain}
    [ $# -ge 3 ] && shift 3 || shift $#
    run tag put "$id" --instructions "Process requests" --state-directory "$state" "$@"
    run placement runs-on "$id" "$label" --state-directory "$state" >/dev/null
    ;;
  down)
    run down --state-directory "$state"
    ;;
  cli)
    shift
    run "$@"
    ;;
  tui)
    shift
    exec env -i PATH=/usr/bin:/bin:/opt/homebrew/bin HOME="$home" SUPERTAG_STATE_DIR="$state" \
      SUPERTAG_CLI="$cli" TERM="${TERM:-xterm-256color}" ${COLORTERM:+COLORTERM=$COLORTERM} \
      ${TERM_PROGRAM:+TERM_PROGRAM=$TERM_PROGRAM} ${TMUX:+TMUX=$TMUX} TMPDIR=/tmp \
      ${SUPERTAG_TUI_TIMING:+SUPERTAG_TUI_TIMING=$SUPERTAG_TUI_TIMING} \
      ${SUPERTAG_TUI_BINARY:-$bun run "$here/../src/main.tsx"} "$@"
    ;;
  *)
    echo "usage: stack.sh up | tag [ID [LABEL [TAG PUT ARGS...]]] | down | cli ARGS... | tui [ARGS...]" >&2
    exit 2
    ;;
esac
