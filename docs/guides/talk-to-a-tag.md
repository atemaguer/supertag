# Talk to a Tag from your terminal

Send a **Tag** a message from your terminal and get its reply, without Slack or another
collaboration surface. A Tag is a persistent AI actor with its own identity, responsibilities, permissions, and
work history. You have one conversation with each Tag. It continues a **Session**, a thread of
work, and a **Task** is one turn in it, so follow-ups continue where you left off.

Use this for questions and small requests. To give a Tag an outcome to own, create an
[Objective](objectives.md).

## Open a conversation

Follow the [quickstart](../../README.md#get-started) to install SuperTag and run `supertag init`
in a git repository. Setup creates a local [Control Plane](../concepts/how-it-works.md) and
connects your machine as a [Worker Host](../concepts/workers.md) for the Tag.

In the same repository, send `lead` a message:

```sh
supertag message lead "Read this repository and tell me what you would improve first."
```

The command prints the Tag's messages as they arrive and returns with its answer. To check a
delivered branch, ask for a small edit and wait for the Tag's work Session to report.

Before longer work, the Tag first writes one short sentence saying what it is about to do, which
appears as its own message as soon as the Tag writes it. The conversation shows only messages;
`supertag task events TASK_ID` prints the commands the Tag runs. The first message arrives once
the Tag's harness has started and written its first sentence, which takes a few seconds.

If there is no local setup, run `supertag init`. For a shared Control Plane, ask its operator to
set up a Tag. An operator can also create one with **+** in the desktop app's sidebar, or ⌘N:
give it a name, from which its permanent ID is derived, a harness, and optionally a Workspace.
The form offers every harness and Workspace the connected Worker Hosts serve. Connected to the
local services, the desktop app's form can also add a folder of this machine as a new Workspace:
choose **Choose a folder…**, pick a Git repository, and SuperTag adds it, restarts, and starts the
Tag on the branch checked out there. A Claude Code, Cursor, or OpenCode Tag gets
`commands:execute` only when a host lets that harness run commands, as `supertag init` sets up
its lead; the form says when it reads and edits files only.

To give `lead` an **Objective**, an outcome it owns, send `/goal` followed by the outcome and how
to verify it. The message goes to the conversation like any other, and the Control Plane creates
the Objective, answers with its ID, and starts its first turn. `supertag describe objective ID`
shows its progress. To choose a Team or budget before starting, use `supertag objective create`.
`/goal` works the same way in the desktop app, where selecting a Tag opens your conversation with
it. A currency budget stops a Claude Code turn when it is spent; with other
[harnesses](../concepts/workers.md) it stops the next turn.

## Read the conversation and move around

The desktop app reads like a messaging app. The lead Tag sits at the top of
the sidebar with a star, and the other Tags follow by their latest activity. Your messages and the
Tag's are grouped by sender, and a time divider marks a pause of more than fifteen minutes.
Under your last message it shows **Sent** once the Control Plane has it and **Seen** once a
Worker Host's Worklet has taken it up, and the animated `···` stays at the end of the Tag's reply until
its answer arrives. Each of the Tag's messages appears as soon as the Control Plane records it,
and with Codex or Claude Code its text appears as it is written. A message that is not
delivered stays in the conversation with **Retry**, which sends it at most once, and **Edit**. What you have not sent stays with each Tag
until you come back, even after a restart, and a message not yet accepted is sent again the next
time you open the app.

The desktop app's conversation shows only messages, as a messaging app does: yours, each message
the Tag writes, its first sentence included, and its answer. What the Tag does on the way, such as
the commands it runs and the files it reads, stays out of the conversation. While it works, a `···`
bubble sits at the end of its reply; select it to see the Task's activity. Once the answer arrives,
the reply's actions on hover open the activity, and a line under the reply appears only when the
turn failed, was cancelled, or needs attention.

In the desktop app, drag the sidebar's edge to resize it, or past its narrowest to fold it into a
rail of avatars; ⌘B does the same. The Task activity pane resizes from its edge too. ⌘1 to ⌘9 open
the Tags in order, ⌘↑ and ⌘↓ the previous and next, and ⌘N creates a Tag; use Ctrl in place of
⌘ outside macOS. The foot of the sidebar names the app's SuperTag release, and the Gateway's
when it runs another one; hover over it to see both and the protocol version they agreed.

To find a Tag, a message, or a setting, press ⌘K or the search button beside **+** at the top of
the sidebar. The search lists your **Tags**, each with its latest message, and **Actions**: New
Tag, Keyboard shortcuts, and the Gateway settings, such as switching or adding a **Gateway** (the
service the app connects to) and what this device notifies about. Typing filters both lists and also finds Tags by the
text of messages the app keeps on this device. The arrow keys move the selection, Enter opens
it, ⌘1 to ⌘9 open a Tag directly, and Esc closes the search.

## Continue a conversation

You have one conversation with each Tag, and selecting the Tag opens it where you left off. The
desktop app, `supertag message`, and any other client with your credential use the same
conversation. The Tag sees its earlier messages. For an independent topic, send it from a script
in its own Session, or give the Tag an Objective.

## Follow longer work

The Tag answers a quick question directly. For longer work, such as researching a slow export,
it can start a **work Session**, a separate thread that runs the work as its own Task. The Tag
tells you when it starts and reports back when the work finishes or needs a decision.
`supertag get session --parent-tag lead --parent-session SESSION_ID` lists the conversation's
work Sessions, and `supertag task events TASK_ID` shows a Task's commands, tool calls, and result.

You don't need to wait while work runs: `supertag message --no-wait` returns once the message is
accepted. The report appears in the conversation when you return.

## Notifications in the apps

The desktop app tells you when a Tag replies or asks you a question while you are not looking at
that conversation: the window is in the background, or another Tag's conversation is open. Several
replies from one Tag make one notification, such as "lead: 3 new messages", and a question gets
its own. Clicking a notification opens that Tag. The Dock badge shows how many replies you have
not read. Choose **All messages**, **Questions only**, or **Off** under **Notifications** in the
Gateway menu; the choice is kept on this device. Your own messages, the Tag's activity, and
checks that stayed quiet never notify.

## See what a Tag remembers

A Tag keeps a memory between turns, such as your preferences and decisions: what its harness,
such as Claude Code or Codex, keeps itself, or for OpenCode and Cursor, a memory folder the Worker
Host keeps for them, read from the Worker Host on your Mac. In the desktop
app, select the Tag's name above the conversation, or choose **Memory** in the ⌘K search, to open
its details: each memory, its harness, what it is about, and who sees it. One marked **Proposed**
is a change a Work Session suggested, which the Tag's daily review merges or drops. Delete one to
have the Tag forget it. The conversation itself shows only messages. To add or change a memory,
tell the Tag. Memory never passes through the Control Plane, so it shows only on the machine
whose Worker Host keeps it. From a terminal, `supertag get memories --tag TAG` lists it. See
[Reading and deleting memory](../reference/coordination.md#reading-and-deleting-memory).

## See how a Tag's messages land

A Tag's details in the desktop app open with **Activity**: over the last 30 days, how many of the
messages it sent without being asked (Schedule wake-ups and Objective notices) were posted, read,
and answered, and how many checks stayed quiet, and its start rate, if it has one. See
[Quiet results](../reference/coordination.md#quiet-results).

## See a Task's files

While a Task runs on a Worker Host on your own machine, the desktop app shows its checkout under
**Files** in the Task's activity panel: open folders, read text files in a read-only viewer, and
show a file in Finder. Binary files are listed but don't open. The list refreshes while the Task
runs. The app reads the files from your disk; they never pass through the Control Plane. A Task on
another machine says "Files on Worker Host NAME are unreachable from here". For a finished Task,
**Files** names its Session branch, `supertag/session/ID`, with `git diff` and `git checkout`
commands to copy and run in the Workspace's repository. The app and the Worklet know they share a machine from
`~/.supertag/machine-id`, a random identifier created on first use, whichever state directory
each one uses.

## See what a Tag fetched

When a Tag's Permission Sets limit `web:fetch` to named hosts, each Task Attempt's web requests go
through the egress proxy of its **Worker**, the process that runs it, which keeps a log of what it allowed and refused. Operators see it in the
desktop app's Tag details, under **Network**. See [Network log](../reference/iam.md#network-log).

## Ask a Tag to follow up

Ask the Tag to come back to something later, once or on a schedule:

```text
Check PR 412 again in two hours.
Summarize open work every Monday at 9.
```

The Tag sets a **Schedule**, a durable wake-up for itself in this conversation, and tells you
when it will look. When the time comes, its reply appears in the conversation as a normal
message, marked "Scheduled", with no message from you before it. Nothing shows while the Tag
checks unless you write to it meanwhile, and a recurring check that finds nothing new stays quiet: no message, nothing unread,
though `supertag describe task` still shows the turn ran. Unprompted messages arrive at most once
every 30 minutes; later ones wait and arrive together, or as soon as you write. A Schedule takes effect only
when the turn that set it succeeds. Recurring ones run at least an hour apart. A Tag schedules only
when it holds the `schedule:create` runtime action, which `supertag init` and the New Tag forms
grant.

To set one yourself, or to stop one:

```sh
supertag schedule create --tag lead --every "0 9 * * MON" --time-zone Europe/Berlin "Summarize open work"
supertag get schedules --tag lead
supertag schedule pause SCHEDULE_ID
supertag schedule resume SCHEDULE_ID
supertag delete schedule SCHEDULE_ID
```

`--at` takes a duration such as `2h` or a time such as `2026-11-17T09:00`. Without
`--time-zone`, times are read in the Control Plane's time zone. `supertag describe schedule ID`
shows the next time, the missed occurrences, and the latest turn it queued. See
[Schedules](../reference/coordination.md#schedules) for the rules.

The Tag's details in the desktop app, opened from its name above the conversation, list its
Schedules after its notes, with each one's next time, and let you pause, resume, or delete it.

When SuperTag was down through several occurrences of a recurring Schedule, it fires once and
counts the rest as missed. To run the missed ones after all:

```sh
supertag schedule backfill SCHEDULE_ID --from 2d
```

`--from` takes a duration ago, such as `2d`, or an RFC 3339 time. Each missed occurrence since
then queues one turn, at most 24.

## Answer a question or decide an approval

If the Tag asks which region a work Session should use, answer in the same conversation. The
Tag passes your answer to the work Session and reports back after it continues.

To decide a request, use `supertag get approval` to inspect it, then `supertag approval approve ID` or `supertag approval deny ID --reason TEXT` to decide.
A decision lets the work Session continue on its own. If it cannot continue, the conversation
shows the reason.

## Talk to an Objective

To give an Objective a new direction or request a revision, send its owner a turn in the
Objective's Session; see [Send messages from scripts](#send-messages-from-scripts). If the
Objective has a pending question, answer it with `supertag question answer TASK_ID TEXT`. For an
Objective on Slack or another collaboration surface, the owner's reply appears in the home thread.

The Objective keeps working as its Sessions report back. It shares a budget across its own
turns and every Session it starts. When it names a Team, the owner can start a Session of
another member. See [Define and complete an Objective](objectives.md).

## Send messages from scripts

`supertag message` sends to your conversation with a Tag from a terminal or a script. It is the
conversation the desktop app shows, so the message and the reply appear there
too. The command waits for the reply and prints it; without the text, it reads standard input.
When the Tag needs your approval or asks you a question, the command says so on standard error
and names the command that answers:

```sh
supertag message lead "Draft the release notes for 2.4."
cat failing-test.log | supertag message lead
```

Scripts that keep separate threads send a turn with `supertag task submit`. A Session name is the
thread: a new name starts one, and reusing it continues it. These Sessions don't appear in the
desktop app, and `task submit` refuses your conversation's own Session.

```sh
supertag task submit --tag lead --session release-notes "Draft the release notes for 2.4."
supertag task events TASK_ID
```

To give a working Objective a follow-up, submit to its owner in the Objective's Session, the
`session_id` that `supertag get objective ID` prints. `supertag task input TASK_ID TEXT` steers a
Task that is still running. Applications call the same operations through the
[Control Plane API](../reference/control-plane-api.md).

For a coding agent that operates SuperTag from a separate conversation, see
[Run SuperTag from your coding agent](coding-agent-operator.md).

## Check that it worked

Your conversation shows under its Tag with its latest message, and the
desktop app marks replies you have not read. The desktop app's Dock badge counts them; see [Notifications in the apps](#notifications-in-the-apps). What you have read is kept once for each conversation, so reading a reply in one app clears it in the others. An Objective's conversation is titled by the Objective. A work Session the Tag started appears
beneath the conversation that started it; `supertag get session --parent-tag lead --parent-session SESSION_ID`
lists them, and `supertag describe session ID` shows one with its latest Task and report.

## Rules

- **The conversation is private to you.** The admin operator, each Operator Token, and each
  client device have their own conversation with each Tag. Other people's conversations with the
  Tag can't read it.
  See [shared and private Sessions](../concepts/multiplayer.md#shared-and-private-sessions).
- **The Tag answers with its Roles' permissions only.** A terminal conversation has no location,
  so no location's Permission Sets or Context Sets apply.
- **Each conversation stands alone.** The Tag does not read its other conversations, such as
  Slack threads and GitHub issues. Share earlier work through a captured artifact, or tell it what
  it needs.
- **Messages from other Tags arrive elsewhere.** A Tag's inbox is its own thread of turns, so a
  message another Tag sends it never interrupts your conversation. See
  [Send messages between Tags](tag-messaging.md).
- **A work Session has the conversation's permissions, never more.** It runs with the same
  permissions as the message that started it. It can't start more work Sessions or
  create Objectives. A work Session started from your private conversation is private to you too.
- **Your conversation uses only MCP servers its Worker Hosts declare.** Work Sessions also get the
  servers their Workspace provides; see [MCP server placement](../reference/iam.md#placement).
- **A work Session sees only its own work.** It can't read your conversation, the Tag's other
  Sessions, or its Objectives, so the Tag gives it everything it needs when it starts it.
- **A work Session commits its edits to its own branch.** When the Tag is bound to a Workspace,
  the work Session edits that Workspace, the same one as the turn that started it, and the Worklet
  delivers its commits to the Session's own branch under `supertag/session/`, such as
  `supertag/session/0f3c2a9e…`. Your checkout stays on its branch. The report names the branch,
  and a continued work Session commits on top of it, on the same branch. See
  [where a work Session's edits go](../concepts/tasks.md#where-a-work-sessions-edits-go).
- **At most four work Sessions run at once per conversation.** Later ones wait their turn. One
  message starts at most four, and a conversation holds at most eight unfinished. A message whose
  limits allow no parallel agents (`maxNativeAgents: 0`) starts none.
- **A message and its work Sessions share one budget.** When the message has token or cost limits,
  each work Session it starts or continues may spend what the message and its work Sessions
  haven't spent yet. Once less than a twentieth of the message's limits is left, the Tag does the
  work in its own reply. See
  [how work Sessions share a budget](../concepts/tasks.md#how-work-sessions-share-a-budget).
- **A message you send while the Tag reports a work Session gets its own turn.** It isn't added to
  the report.
- **Only your conversation can answer its work Sessions.** The Tag continues a work Session only
  after it stops running and the Tag has reported it, with your current message's permissions. A
  continued work Session counts against your current message's limits, like a new one. If the
  Tag's permissions changed since the work Session last ran, the Tag starts a new work Session
  instead.

## If something goes wrong

- **The conversation shows `· waiting: REASON`.** No Worker Host bound to the Tag can run
  your turn yet. For example, `· waiting: no bound Worker Host provides MCP server notes` names
  a missing MCP server. The turn starts when you fix the reason. See
  [Troubleshoot the first reply](troubleshooting.md#5-check-placement).
- **You send a message while the Tag is still replying.** If the Tag's harness accepts input while
  it works, your message can join the turn in progress. Otherwise it waits, and the next turn
  reads it together with any other messages you sent meanwhile, then answers them once. A joined
  message the Tag has yet to read when the turn ends waits for the next turn the same way. See
  [messages while work is running](../concepts/tasks.md#messages-while-work-is-running).
- **`The requesting Task already finished; request expired`.** The work Session no longer waits
  on that request: it moved on to a later Task, or its Task ended without waiting on it. If the
  work Session still needs the action, its next call creates a new request and notice.
- **`Tag NAME does not exist`.** Check the name with `supertag get tag`.

## Reference

- [Control Plane API](../reference/control-plane-api.md): the `Conversations` service sends, reads, and follows messages

## Next

- [Across Sessions: one Tag, many conversations](../concepts/multiplayer.md#across-sessions-one-tag-many-conversations)
- [Define and complete an Objective](objectives.md)
