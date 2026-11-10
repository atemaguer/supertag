# Talk to a Tag from your terminal

Send a **Tag** a message from your terminal and get its reply, without Slack or another
collaboration surface. A Tag is a persistent AI actor with its own responsibilities and
permissions. Each named conversation is its own **Session**, a thread of work. A **Task** is one
turn in that thread, so follow-ups continue where you left off.

Use this for questions and small requests. To give a Tag an outcome to own, create an
[Objective](objectives.md).

## Open a conversation

Follow the [quickstart](../../README.md#get-started) to install SuperTag and run `supertag init`
in a git repository. Setup creates a local [Control Plane](../concepts/how-it-works.md) and
connects your machine as a [Worker Host](../concepts/workers.md) for the Tag.

In the same repository, run `supertag`. Select `lead`, type “Read this repository and tell me what
you would improve first,” and press Enter. The reply appears in the conversation. To check a
delivered branch, ask for a small edit and wait for the Tag's work Session to report.

If there is no local setup or the Control Plane has no Tags, SuperTag shows how to get started
with `supertag init`. For a shared Control Plane, ask its operator to set up a Tag.

| Key | Action |
| --- | --- |
| Ctrl-K | Open the command palette. |
| Ctrl-O | Open the selected Tag's conversations. |
| Ctrl-P | Switch Control Planes when more than one is available. |
| ↑ on empty input | Select a work Session. Enter expands it. |
| `d` on a work Session or branch | Show the diff from this checkout. |
| `o` on a work Session or branch | Open its pull request when one exists. |

To give `lead` an **Objective**, an outcome it owns, type `/goal` followed by the outcome and how
to verify it. Press Enter to create it, then Enter again to open its progress view. Enter `/goal`
on its own to choose a Team or budget before starting. A currency budget requires a
[Worker](../concepts/workers.md) that can enforce a reported cost limit.

## Continue a conversation

Each Tag opens in your `default` conversation. To keep a topic separate, press Ctrl-O, then
`n`, type a name such as `billing`, and press Enter. Use Ctrl-O and Enter to reopen an
existing conversation. The Tag sees the earlier messages in that conversation.

## Follow longer work

The Tag answers a quick question directly. For longer work, such as researching a slow export,
it can start a **work Session**, a separate thread that runs the work as its own Task. The Tag
tells you when it starts and reports back when the work finishes or needs a decision. Select
a work Session and press Enter to see its commands, tool calls, and result.

You can leave the terminal UI while work runs. The report appears in the conversation when you
return.

## Answer a question or decide an approval

If the Tag asks which region a work Session should use, answer in the same conversation. The
Tag passes your answer to the work Session and reports back after it continues.

If a request appears under **Waiting on you**, select it and review the requested action.
Press `a` and Enter to approve it once, or press `d`, enter a reason, and press Enter to deny it.
For requests shown only in the conversation, use `supertag list approval` to inspect the
request, then `supertag approve request ID` or `supertag deny request ID --reason TEXT` to decide.
A decision lets the work Session continue on its own. If it cannot continue, the conversation
shows the reason.

## Talk to an Objective

To give an Objective a new direction or request a revision, select it under **Objectives**.
Press `m`, type your follow-up, and press Enter to send it as the owner's next turn. Press Esc
to close the composer and keep the draft. If the Objective has a pending question, answer it
under **Waiting on you**. The owner's reply appears below the follow-up for a local Objective,
or in the home thread for an Objective on Slack or another collaboration surface.

The Objective keeps working as its Sessions report back. It shares a budget across its own
turns and every Session it starts. When it names a Team, the owner can start a Session of
another member. See [Define and complete an Objective](objectives.md).

## Send messages from scripts

Use [`supertag message tag` or `supertag message objective`](../operations/cli.md#send-messages-from-the-cli)
for scripts that run the CLI. Both accept standard input and JSON output.

For direct integrations, use the [operator API](../reference/control-plane-api.md#send-messages-and-answer-questions). Call
[`ConversationService.SendMessage`](../reference/operator-api/conversation.md#sendmessage)
to send to a Tag, or
[`ObjectiveService.MessageObjective`](../reference/operator-api/objective.md#messageobjective)
to send to an Objective. After sending to a Tag, pass its name and the returned Task ID to
[`ConversationService.FollowMessage`](../reference/operator-api/conversation.md#followmessage)
to follow its reply and work Session reports.

For a coding agent that operates SuperTag from a separate conversation, see
[Run SuperTag from your coding agent](coding-agent-operator.md).

## Check that it worked

```sh
supertag list session
```

Your conversation appears as a Session with the key `cli:<you>:<conversation>`, titled by your
first message. A work Session it started shows its own title, and the conversation's Session ID
under `PARENT`. An Objective's conversation is titled `Objective ID`, and the Session that handles
the Tag's Mailbox messages is titled `Inbox`. `STATUS` shows the latest Task's status: `pending`, `running`, `completed`,
`failed`, or `cancelled`.
`supertag get session ID` reports `"audience": "SESSION_AUDIENCE_PRIVATE"`, and
`supertag describe session ID` shows its Tasks.

## Rules

- **The conversation is private to you.** The admin token and each Operator Token have their own
  conversations, even with the same name. Other people's conversations with the Tag can't read it.
  See [shared and private Sessions](../concepts/multiplayer.md#shared-and-private-sessions).
- **The Tag answers with its Roles' permissions only.** A terminal conversation has no location,
  so no location's Permission Sets or Context Sets apply.
- **The Tag remembers its other conversations.** It sees its open Objectives and can search its
  shared Sessions, such as Slack threads and GitHub issues, when a question needs them.
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
- **A work Session commits its edits to its own branch.** When the Tag's Worker Hosts declare a
  Workspace, the work Session edits it and the Worker commits to a branch such as
  `supertag/session/0f3c2a9e`. Your checkout stays on its branch. The report names the branch, and
  a continued work Session commits on top of it, on the same branch. With
  several Workspaces, the Tag picks one when it starts the work Session. See
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
- **Ctrl-C closes the terminal UI.** The Tag keeps working. Open `supertag` again and select the
  same conversation to see the reply and work Session reports.

## If something goes wrong

- **The conversation shows `· waiting: REASON`.** No Worker Host bound to the Tag can run
  your turn yet. For example, `· waiting: no bound Worker Host provides MCP server notes` names
  a missing MCP server. The turn starts when you fix the reason. See
  [A Tag stops answering](troubleshooting.md#a-tag-stops-answering).
- **The terminal UI stops following a reply after losing its connection.** Open `supertag` again
  and select the same conversation. The reply and work Session reports appear there as they arrive.
- **You send a message while the Tag is still replying.** If the Tag's harness accepts input while
  it works, your message can join the turn in progress. Otherwise it waits for its own turn.
  A joined message the Tag has yet to read when the turn ends gets a turn of its own.
- **`The requesting Task already finished; request expired`.** The work Session no longer waits
  on that request: it moved on to a later Task, or its Task ended without waiting on it. If the
  work Session still needs the action, its next call creates a new request and notice.
- **`Tag NAME does not exist`.** Check the name with `supertag list tag`.

## Reference

- [`ConversationService`: sending, reading, and following messages](../reference/operator-api/conversation.md)

## Next

- [Across Sessions: one Tag, one memory](../concepts/multiplayer.md#across-sessions-one-tag-one-memory)
- [Define and complete an Objective](objectives.md)
