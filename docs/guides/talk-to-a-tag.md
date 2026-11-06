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

## Check that it worked

```sh
supertag list session
```

Your conversation appears as a Session with the key `cli:<you>:<conversation>`.
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
- `--output json` waits for the reply and prints the message record, with the Session, the Task,
  and the reply.
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
