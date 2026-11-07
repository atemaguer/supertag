# Talk to a Tag from the CLI

Send a **Tag** a message from your terminal and get its reply, without Slack or another
collaboration surface. A Tag is a persistent AI identity with its own responsibilities and
permissions. Each named conversation is its own **Session**, a group of Tasks from one
conversation, so follow-ups continue where you left off.

Use this for questions and small requests. To give a Tag an outcome to own, create an
[Objective](objectives.md).

## Before you start

- A running Control Plane with a Tag, and a Worker Host bound to it. `supertag init` sets these
  up; see [install SuperTag](../operations/install.md).
- The `supertag` CLI connected to that Control Plane as an operator.

## 1. Send a message

```sh
supertag message tag planner 'What are you working on?'
```

While the Tag works, the command shows the commands it runs, then prints its reply. In a
terminal, a dim line such as `· running: ls src` marks each command the Tag starts. The command
exits when the reply is complete. To send a longer message, pass `-` and write it to standard input:

```sh
supertag message tag planner - < question.md
```

## 2. Continue a conversation

Without `--session`, messages go to your `default` conversation. Name a conversation to keep a
topic separate:

```sh
supertag message tag planner 'Plan the billing migration.' --session billing
supertag message tag planner 'Which step is riskiest?' --session billing
```

The second message sees the first, and the Tag's reply to it.

## 3. Follow longer work

The Tag answers a quick question directly. For work that takes longer, such as research, several
tool calls, or edits, it starts a **work Session**: a new Session of the same Tag that runs the
work as its own Task. The Tag replies briefly that it started, and the command stays to follow
the work:

```text
$ supertag message tag planner 'Find out why the billing export is slow.' --session billing
I'm looking into the billing export now and will report back here.
· working: Investigate slow billing export
· done: Investigate slow billing export
The export is slow because it loads every invoice before filtering. Filtering in the query
cuts it from 40 s to 2 s. Want me to make that change?
```

In a terminal, dim lines such as `· running: rg invoice` show what each work Session does. They
are how you follow its progress; the Tag doesn't post progress of its own. The Tag speaks again
when a work Session finishes or waits: it gets a turn in your conversation to report the result,
or what the work Session waits for, in its own words. The command exits when every work Session it started
has reported.

Ctrl-C stops following, not the work. The report still arrives in the conversation, and your next
message there sees it.

## 4. Answer a work Session's question or approval

A work Session that needs a decision from you stops and asks. The command shows it waiting on you,
then the Tag's question:

```text
$ supertag message tag planner 'Move the billing export to the new cluster.' --session billing
I'm starting the move and will report back here.
· working: Move billing export
· waiting on you: Move billing export
Which region should the new cluster use: eu-west or us-east?
```

Answer with your next message in the same conversation. The Tag passes your answer to the work
Session, which picks up where it stopped, and the command follows it again:

```text
$ supertag message tag planner 'eu-west' --session billing
I've passed that on.
· working: Move billing export
· done: Move billing export
The billing export now runs on the eu-west cluster.
```

If a work Session needs approval for an action, it stops and waits for your decision, the way it
waits for an answer. `supertag message tag` prints the notice under `· approval needed: TITLE`,
and on Slack and other surfaces it posts to your conversation. The notice names the permission
that requires approval, in SuperTag's words. The Tag then tells you briefly what the work Session
waits for:

```text
$ supertag message tag planner 'Resolve the Sentry issue for the export timeout.' --session billing
I'm resolving the issue and will report back here.
· working: Resolve export timeout issue
· approval needed: Resolve export timeout issue
Work Session "Resolve export timeout issue" is waiting for approval:
- 6f0d2c1e-8a4b-4f7e-9c3d-2b5a1e7f9d40: MCP sentry/update_issue (required by sentry-triage)
Review with supertag list approval, then supertag approve request ID or supertag deny request ID --reason TEXT.
The work Session continues on its own once you decide.
· waiting for approval: Resolve export timeout issue
It's waiting for your approval to update the Sentry issue.
```

`supertag list approval` shows the request in full. Decide it with
`supertag approve request ID` or `supertag deny request ID --reason TEXT`; a message to the Tag
doesn't approve anything, and you don't need to message the Tag after deciding. Either decision
continues the work Session as its next Task. An approval lets it retry the same action once; a
denial gives it your reason, so it can try another way or report back. Its report then reaches
your conversation like any other. `supertag message tag` keeps following a work Session that
waits for approval, so decide from another terminal; the command then prints `· working:` again,
then `· done:` or the next wait. If the Tag's permissions changed while the work Session waited,
or the turn's limits are spent, the decision doesn't continue it: the command prints
`· not continued: TITLE` and why. Start a new work Session after a permission change, or send a
message to continue it after the limits ran out.

## Check that it worked

```sh
supertag list session
```

Your conversation appears as a Session with the key `cli:<you>:<conversation>`, titled by your
first message. A work Session it started shows its own title, and the conversation's Session ID
under `PARENT`. `STATUS` shows the latest Task's status: `pending`, `running`, `completed`,
`failed`, or `cancelled`.
`supertag get session ID` reports `status.audience: private`, and
`supertag describe session ID` shows its Tasks.

## Rules

- **The conversation is private to you.** The admin token and each Operator Token have their own
  conversations, even with the same name. Other people's conversations with the Tag can't read it.
  See [shared and private Sessions](../concepts/multiplayer.md#shared-and-private-sessions).
- **The Tag answers with its Roles' permissions only.** A CLI conversation has no location, so no
  location's Permission Sets or Context Sets apply.
- **The Tag remembers its other conversations.** It sees its open Objectives and can search its
  shared Sessions, such as Slack threads and GitHub issues, when a question needs them.
- **A work Session has the conversation's permissions, never more.** It runs with the same
  permissions as the message that started it. It can't start more work Sessions or
  create Objectives. A work Session started from your private conversation is private to you too.
- **Your conversation uses only MCP servers its Worker Hosts declare.** Work Sessions also get the
  servers their Workspace provides; see [MCP server placement](../reference/iam.md#placement).
- **A work Session sees only its own work.** It can't read your conversation, the Tag's other
  Sessions, or its Objectives, so the Tag gives it everything it needs when it starts it.
- **A work Session commits its edits to its own branch.** When the Tag's Worker Hosts declare a
  Workspace, the work Session edits it and the Worker commits to a branch such as
  `supertag/session/0f3c2a9e`. Your checkout stays on its branch. The report names the branch, and
  a continued work Session builds on it in the next branch, `supertag/session/0f3c2a9e-2`. With
  several Workspaces, the Tag picks one when it starts the work Session. See
  [where a work Session's edits go](../concepts/tasks.md#where-a-work-sessions-edits-go).
- **At most four work Sessions run at once per conversation.** Later ones wait their turn. One
  message starts at most four, and a conversation holds at most eight unfinished. A message whose
  limits allow no parallel agents (`maxNativeAgents: 0`) starts none.
- **A message and its work Sessions share one budget.** When the message has token or cost limits,
  each work Session it starts or continues gets an equal share of what the message hasn't spent or
  given out yet. Once a share would be under a tenth of the message's limits, the Tag does the work
  in its own reply. See
  [how work Sessions share a budget](../concepts/tasks.md#how-work-sessions-share-a-budget).
- **A message you send while the Tag reports a work Session gets its own turn.** It isn't added to
  the report.
- **Only your conversation can answer its work Sessions.** The Tag continues a work Session only
  after it stops running and the Tag has reported it, with your current message's permissions. A
  continued work Session counts against your current message's limits, like a new one. If the
  Tag's permissions changed since the work Session last ran, the Tag starts a new work Session
  instead.
- `--output json` waits for the reply and every report, and prints one message record with the
  Session, the Task, the reply, and `startedSessions`: each work Session the message started or
  continued, with its status and report. A work Session waiting on you has status `waiting` and
  its `question`; one waiting for approval lists `approvals`, and the command returns there.
  While no bound Worker Host can run the turn, `waiting` says why.
- **Ctrl-C stops showing the reply, not the work.** The Tag keeps working. The command prints the
  `supertag describe task` command that follows the Task.

## If something goes wrong

- **The command prints `· waiting: REASON` and no reply.** No Worker Host bound to the Tag can run
  your turn yet, for example `· waiting: no bound Worker Host provides MCP server notes`. The
  command prints the reason once and keeps waiting; the turn starts when the reason is fixed. See
  [A Tag stops answering](troubleshooting.md#a-tag-stops-answering).
- **The command stops waiting after 10 minutes without progress.** The Tag is still working. Follow
  the Task with the `supertag describe task` command the message prints. Its reply stays in the
  conversation, so your next message there sees it.
- **A message sent while the Tag is still replying.** If the Tag's harness accepts input while it
  works, your message joins the running reply, and the command prints that reply. Otherwise the
  message waits its turn.
- **`The requesting Task already finished; request expired`.** The work Session no longer waits
  on that request: it moved on to a later Task, or its Task ended without waiting on it. If the
  work Session still needs the action, its next call creates a new request and notice.
- **`Tag NAME does not exist`.** Check the name with `supertag list tag`.

## Reference

- [CLI conversation routes and the reply stream](../reference/control-plane-api.md#cli-conversations-experimental)

## Next

- [Across Sessions: one Tag, one memory](../concepts/multiplayer.md#across-sessions-one-tag-one-memory)
- [Define and complete an Objective](objectives.md)
