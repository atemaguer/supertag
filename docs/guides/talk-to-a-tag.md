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

The command shows the reply as the Tag writes it. In a terminal, a dim line such as
`· running: ls src` marks each command the Tag starts. The command exits when the reply is
complete. To send a longer message, pass `-` and write it to standard input:

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

In a terminal, dim lines such as `· running: rg invoice` show what each work Session does. When
a work Session finishes, the Tag gets a turn in your conversation to report the result in its
own words. The command exits when every work Session it started has reported.

Ctrl-C stops following, not the work. The report still arrives in the conversation, and your next
message there sees it.

## Check that it worked

```sh
supertag list session
```

Your conversation appears as a Session with the key `cli:<you>:<conversation>`. A work Session
it started shows the conversation's Session ID under `PARENT`, and `STATUS` shows its Task's
status: `pending`, `running`, `completed`, `failed`, or `cancelled`.
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
  permissions and workspace as the message that started it. It can't start more work Sessions or
  create Objectives. A work Session started from your private conversation is private to you too.
- **At most four work Sessions run at once per conversation.** Later ones wait their turn. One
  message starts at most four, and a conversation holds at most eight unfinished. Together, the work
  Sessions of one message share its token and cost limits. A message whose limits allow no parallel
  agents (`maxNativeAgents: 0`) starts none.
- **A message you send while the Tag reports a work Session gets its own turn.** It isn't added to
  the report.
- `--output json` waits for the reply and every report, and prints one message record with the
  Session, the Task, the reply, and `startedSessions`: each work Session with its status and
  report.
- **Ctrl-C stops showing the reply, not the work.** The Tag keeps working. The command prints the
  `supertag describe task` command that follows the Task.

## If something goes wrong

- **The command stops waiting after 10 minutes without progress.** The Tag is still working. Follow
  the Task with the `supertag describe task` command the message prints. Its reply stays in the
  conversation, so your next message there sees it.
- **A message sent while the Tag is still replying.** If the Tag's harness accepts input while it
  works, your message joins the running reply, and the command prints that reply. Otherwise the
  message waits its turn.
- **`Tag NAME does not exist`.** Check the name with `supertag list tag`.

## Reference

- [CLI conversation routes and the reply stream](../reference/control-plane-api.md#cli-conversations-experimental)

## Next

- [Across Sessions: one Tag, one memory](../concepts/multiplayer.md#across-sessions-one-tag-one-memory)
- [Define and complete an Objective](objectives.md)
