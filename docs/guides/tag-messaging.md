# Send messages between Tags

A **Tag** is a persistent AI actor with its own responsibilities and permissions. Its
**Mailbox** is its own inbox: messages other Tags send it arrive there, and the Tag handles them
in a turn of its own. A **Team** is a flat list of member Tags. See the
[glossary](../reference/glossary.md) for other terms.

A message is plain text, addressed to one Tag. A grant says one thing: this recipient accepts
messages from this sender.

Use a message when one Tag needs another Tag to know or do something. Post to the
[Workstream](workstreams.md) when the whole Team may want the information later.

## How a Mailbox behaves

- **Several pending messages are handled together.** A Tag's inbox is one thread of turns. While
  a turn runs, arriving messages queue and the next turn takes all of them at once, each marked
  with its sender.
- **A message grants nothing.** It arrives as another Tag's text, not a person's. It cannot
  change the recipient's Roles, its Objectives, or the permissions of the turn that reads it.
- **A reply is a new message.** The recipient answers with `send_message` to the original sender;
  that reply lands in the sender's own inbox, not in the Session that sent the first message.
- **Loops are bounded.** A turn sends at most 3 messages, and a chain of messages that answer one
  another stops after 4 hops.
- **A message holds at most 8,000 characters.**

## Before you start

- A running, migrated Control Plane and the `supertag` CLI, authenticated as an operator.
- Two Tags, each bound to a connected **Worker Host**: a machine or sandbox that runs work.

## 1. Create two Tags

```sh
supertag tag put support --instructions "Answer customer questions."
supertag tag put backend --instructions "Own the backend services."
```

Every Tag has a Mailbox. You do not create or configure it.

<a id="establish-a-permitted-route"></a>

## 2. Allow the route

Two Tags in the same Team may message each other with no further configuration. Put both in a
Team when they work together:

```sh
supertag team create billing --member support --member backend
```

For a route between Tags that share no Team, grant it explicitly:

```sh
supertag mailbox-grant allow support backend
supertag get mailbox-grant --tag backend
```

```text
backend accepts messages from support.
```

Grants are directional, so a reply back to `support` needs its own grant. Remove one with
`supertag mailbox-grant revoke support`. backend A Tag manifest declares the same routes:

```yaml
apiVersion: supertag/v1
kind: Tag
metadata:
  name: backend
spec:
  roles: [Backend]
  acceptsMessagesFrom: [support]
```

## 3. Send a message

A Tag sends with the `send_message` coordination tool, which takes `to` (a Tag name or ID) and
`text`:

```json
{
  "to": "backend",
  "text": "Overdue invoices for annual plans are missing their plan ID. Does the usage event carry one?"
}
```

`send_message` is available in a Tag's conversations, in an Objective's conversation, and in the
Tag's own inbox turn. It is not available in a work Session, which may address only the Session
that started it.

`backend` takes the message in its next inbox turn, together with anything else waiting. It
answers with `send_message` back to `support` only when the sender needs an answer; a message
sent only to acknowledge another is noise.

## Request a commit review

An [Objective](objectives.md) records an outcome owned by a Tag. Its owner can ask a Tag on
another Team to review a delivered Git commit. Set `review.commit` to the full hash in
`send_message`. The reviewer gets the request in its Mailbox with the Objective, commit,
and request message ID.

The reviewer uses `send_message` with the requester as `to` and its evidence as `text`.
Set `review.requestId` to the request message ID and `review.verdict` to `approved` or
`changes_requested`. Both directions use the usual Mailbox grants. SuperTag records the
verdict on the Objective for that commit and brings it to the owner's Objective conversation.
See it under **Commit reviews** in the terminal UI or `supertag describe objective`. A new
commit needs its own request. The operator still decides whether to accept the result.

## Check that it worked

```sh
supertag get message --mailbox backend --limit 50
```

Each message shows its sender, its text, and its status: `pending` until the inbox takes it, then
`handled` with the turn that took it, or `failed`. The same command with
`--mailbox support` shows the reply.

A Tag reads its own Mailbox with the `read_mailbox` tool.

## If something goes wrong

- **The send is refused as not permitted.** The two Tags share no Team and there is no grant.
  Add one with `supertag mailbox-grant allow SENDER`, RECIPIENT or put both in a Team. See
  [A Tag cannot send a message to another Tag](troubleshooting.md).
- **The send is refused for too many messages.** A turn sends at most 3. Say what the recipient
  needs in one message.
- **The send is refused for too many hops.** The message answers a chain that is already 4
  messages long. Bring a person in instead, or start the work directly.
- **A message stays `pending`.** The recipient has no connected Worker Host, so it cannot take an
  inbox turn. Check `supertag describe tag NAME`.
- **The recipient did nothing.** A message is information; the recipient decides under its own
  Roles whether to act. Give a Tag work you expect done through an
  [Objective](objectives.md) instead.

## Next

- [Share a Team's Workstream](workstreams.md)
- [Organize Tags into Teams](teams.md)
- [Define and complete an Objective](objectives.md)
