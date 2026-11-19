#!/bin/sh
# The terminal UI end to end against the stack from stack.sh, in a private tmux server: it opens
# Local, sends a message to a fixture-adapter Tag and waits for the reply, pastes, switches Tags
# with Alt-2, sees a message sent from the CLI arrive, checks a notification was written
# (OSC 9 through tmux passthrough), then quits with Ctrl-C and checks the terminal was restored.
#   tmux-e2e.sh [TAG]
set -eu
here=$(cd "$(dirname "$0")" && pwd)
root=${TUI_ROOT:-/tmp/supertag-tui}
tag=${1:-lead}
socket=$root/tmux.sock
log=$root/pane.log
t() { tmux -S "$socket" "$@"; }
wait_for() {
  i=0
  while ! t capture-pane -p -t e2e | grep -qF -- "$1"; do
    i=$((i + 1))
    if [ $i -gt 600 ]; then
      echo "timed out waiting for: $1" >&2
      t capture-pane -p -t e2e >&2
      return 1
    fi
    sleep 0.05
  done
}
t kill-server 2>/dev/null || true
rm -f "$log"
t -f /dev/null new-session -d -s e2e -x 160 -y 45 "sh $here/stack.sh tui --gateway local; echo exited \$?; sleep 30"
t set-option -t e2e allow-passthrough on
t pipe-pane -t e2e -o "cat >> $log"
wait_for "Local · connected"
# The palette opens the Tag, whichever the last launch left open.
t send-keys -t e2e C-k
wait_for "Search Tags"
t send-keys -t e2e -l "$tag"
t send-keys -t e2e Enter
wait_for "Message $tag"
text="tmux round trip $$"
t send-keys -t e2e -l "$text"
t send-keys -t e2e Enter
wait_for "Process requests: $text"
echo "round trip ok"
t set-buffer "pasted words"
t paste-buffer -p -t e2e
wait_for "pasted words"
t send-keys -t e2e Enter
wait_for "Process requests: pasted words"
echo "paste ok"
# A reply that lands after switching to another Tag notifies.
t send-keys -t e2e -l "notify me $$"
t send-keys -t e2e Enter M-2
sleep 0.3
echo "after Alt-2: $(t capture-pane -p -t e2e | grep -o "Message [a-z]*" | head -1)"
i=0
while ! grep -aq "]9;" "$log" 2>/dev/null; do
  i=$((i + 1))
  if [ $i -gt 400 ]; then echo "no OSC 9 notification written" >&2; exit 1; fi
  sleep 0.05
done
echo "notification ok: $(grep -ao ']9;[^[:cntrl:]]*' "$log" | head -1)"
grep -aq "$(printf '\033Ptmux;')" "$log" && echo "notification wrapped for tmux passthrough"
# A message from another client (the CLI) shows in the open conversation.
sh "$here/stack.sh" cli message "$tag" "from the CLI $$" >/dev/null 2>&1 || true
t send-keys -t e2e C-k
wait_for "Search Tags"
t send-keys -t e2e -l "$tag"
t send-keys -t e2e Enter
wait_for "from the CLI $$"
echo "from another client ok"
# Save the same local Gateway as a named one with `supertag connect`, through the chooser, and
# switch to it; then back to Local.
local=$(sh "$here/stack.sh" cli __local-gateway)
url=$(printf '%s' "$local" | sed 's/.*"url":"\([^"]*\)".*/\1/')
token=$(printf '%s' "$local" | sed 's/.*"token":"\([^"]*\)".*/\1/')
t send-keys -t e2e C-p
wait_for "Enter connect"
t send-keys -t e2e a
wait_for "Tab next field"
t send-keys -t e2e -l "second"
t send-keys -t e2e Tab
t send-keys -t e2e -l "$url"
t send-keys -t e2e Tab
t send-keys -t e2e -l "$token"
t send-keys -t e2e C-s
wait_for "second · connected"
echo "saved Gateway ok"
t send-keys -t e2e C-p
wait_for "second"
t send-keys -t e2e C-p
t send-keys -t e2e Escape
echo "--- frame"
t capture-pane -p -t e2e | head -24
t send-keys -t e2e C-c
wait_for "exited 0"
grep -q "$(printf '\033\\[?1049l')" "$log" && echo "alternate screen restored"
t kill-server 2>/dev/null || true
echo "e2e ok"
