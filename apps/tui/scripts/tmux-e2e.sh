#!/bin/sh
# The terminal UI end to end against the stack from stack.sh, in a private tmux server: it opens
# Local, sends a message to a fixture-adapter Tag and waits for the reply, pastes, switches Tags
# with Alt-2, sees a message sent from the CLI arrive, checks a notification was written
# (OSC 9 through tmux passthrough). Then the screens around conversations, on Tags it creates
# on the stack's labeled hosts: answers an Objective's question and approves a Workstream post
# from the inbox, creates an Objective with /goal and messages its owner, expands a Work Session,
# deletes a note, pauses a Schedule, reads Activity and a Team, and creates a Tag with Ctrl-N.
# Last it saves a Gateway with `supertag connect`, switches to it, forgets it with
# `supertag disconnect`, quits with Ctrl-C and checks the terminal was restored.
#   tmux-e2e.sh [TAG]
set -eu
here=$(cd "$(dirname "$0")" && pwd)
root=${TUI_ROOT:-/tmp/supertag-tui}
tag=${1:-lead}
socket=$root/tmux.sock
log=$root/pane.log
t() { tmux -S "$socket" "$@"; }
esc() { t send-keys -t e2e Escape; sleep 0.3; }
shows() { t capture-pane -p -t e2e | grep -qF -- "$1"; }
cli() { sh "$here/stack.sh" cli "$@" --state-directory "$root/state" >/dev/null; }
palette() {
  t send-keys -t e2e C-k
  wait_for "Search Tags"
  t send-keys -t e2e -l "$1"
  t send-keys -t e2e Enter
}
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

# The screens around conversations. Each Tag runs on the stack's host with its label.
sh "$here/stack.sh" tag asker ask >/dev/null
sh "$here/stack.sh" tag releaser approve --require-workstream-approval --workstream-approver local >/dev/null
sh "$here/stack.sh" tag planner coord --allow files:read --allow schedule:create >/dev/null
cli team create release --name Release --member releaser --member planner || true
cli objective create "release-q-$$" --owner asker "Ask which branch to release"
cli objective create "rollout-$$" --owner releaser --team release "Verify the rollout"
wait_for "Waiting on you ("
echo "inbox listed ok"
# Open inbox shows the first item; answer the question and approve the post, in either order.
for _ in 1 2; do
  palette "open inbox"
  i=0
  while ! shows "A question" && ! shows "An approval request"; do
    i=$((i + 1)); [ $i -gt 200 ] && { t capture-pane -p -t e2e >&2; exit 1; }; sleep 0.05
  done
  if shows "A question"; then
    wait_for "Which branch should I release?"
    t send-keys -t e2e -l "Release from main"
    t send-keys -t e2e Enter
    wait_for "Answered."
    echo "question answered ok"
  else
    wait_for "a approve once"
    t send-keys -t e2e a
    wait_for "Enter approves it once"
    t send-keys -t e2e Enter
    wait_for "Approved once."
    echo "approval approved ok"
  fi
  sleep 0.5
done
# /goal from the palette opens the form; the Objective starts and m messages its owner.
palette planner
wait_for "Message planner"
t send-keys -t e2e -l "/"
wait_for "Search Tags"
t send-keys -t e2e -l "goal"
wait_for "/goal · Create Objective"
t send-keys -t e2e Enter
wait_for "New Objective for planner"
t send-keys -t e2e -l "Check the e2e $$"
t send-keys -t e2e Enter Enter
t send-keys -t e2e -l '$12.50'
t send-keys -t e2e Enter
wait_for "took its first turn"
t send-keys -t e2e Enter
wait_for "· working"
t send-keys -t e2e m
wait_for "A follow-up for the owner"
t send-keys -t e2e -l "follow up $$"
t send-keys -t e2e Enter
wait_for "planner: "
echo "Objective created and messaged ok"
# A conversation turn on the coord host starts a Work Session; ↑ on an empty message lists it.
palette planner
wait_for "Message planner"
t send-keys -t e2e -l "investigate $$"
t send-keys -t e2e Enter
wait_for "Started the investigation."
sleep 1
t send-keys -t e2e Up
wait_for "Bounded investigation"
t send-keys -t e2e Enter
wait_for "Latest Task"
esc
echo "Work Sessions ok"
# The same turn kept a note and scheduled a wake-up.
palette notes
wait_for "The release branch is main."
t send-keys -t e2e x
sleep 0.5
esc
palette schedules
wait_for "Check PR 412"
t send-keys -t e2e p
wait_for "paused ·"
esc
echo "Notes and Schedules ok"
palette activity
wait_for "Over the last"
esc
echo "Activity ok"
# The Team is the rail's last row.
t send-keys -t e2e Tab
for _ in $(seq 1 30); do t send-keys -t e2e j; done
wait_for "Members: "
wait_for "Workstream"
t send-keys -t e2e Tab
echo "Team ok"
# Ctrl-N creates a Tag from the hosts' harnesses.
t send-keys -t e2e C-n
wait_for "New Tag"
wait_for "Web access  [x] on"
t send-keys -t e2e -l "e2e helper $$"
t send-keys -t e2e C-s
wait_for "Message e2e helper $$"
echo "New Tag ok"
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
# Forget it: `supertag disconnect` removes it, and the chooser opens for another.
t send-keys -t e2e C-p
wait_for "d forget"
t send-keys -t e2e j d
wait_for "Forget second and its cache on this device?"
t send-keys -t e2e Enter
sleep 1
if sh "$here/stack.sh" cli get tags --gateway second >/dev/null 2>&1; then
  echo "second is still saved" >&2
  exit 1
fi
echo "forgot the saved Gateway ok"
wait_for "Local"
t send-keys -t e2e Enter
wait_for "Local · connected"
echo "--- frame"
t capture-pane -p -t e2e | head -24
t send-keys -t e2e C-c
wait_for "exited 0"
grep -q "$(printf '\033\\[?1049l')" "$log" && echo "alternate screen restored"
t kill-server 2>/dev/null || true
echo "e2e ok"
