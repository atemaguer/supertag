# Send messages between Tags

A **Tag** is a persistent AI actor with its own responsibilities and permissions. Its
**Mailbox** is its own inbox: messages other Tags send it arrive there, and the Tag handles them
in a turn of its own. A **Team** is a flat list of member Tags. See the
[glossary](../reference/glossary.md) for other terms.

A message is plain text, addressed to one Tag, with a type: a note, a question, a blocker,
evidence, or a decision. A grant says one thing: this recipient accepts messages from this
sender.

Messages are how teammates' Tags coordinate without involving you: one Tag asks, the other
answers in its own turn, and people hear about it only when a decision is theirs. Use a message
when one Tag needs another Tag to know or do something, and always to ask a question or raise a
blocker: a message wakes its recipient. Post to the [Workstream](workstreams.md) to record
progress and decisions the whole Team may want later. A post wakes nobody; members see it at the
start of their next inbox turn.

## How a Mailbox behaves

- **Several pending messages are handled together.** A Tag's inbox is one thread of turns. While
  a turn runs, arriving messages queue and the next turn takes all of them at once, each marked
  with its sender and type. The turn opens with a count such as `3 unread messages, 2 address
  you.`, then a digest of the Workstream posts of the Tag's Teams that it has not seen.
- **A burst lands in one turn.** A note, evidence, a decision, or a question wakes its recipient
  about 3 seconds after it arrives, so messages sent together arrive together. A blocker wakes the
  recipient at once. The most urgent messages come first: blockers, then questions, then the rest.
- **Seen means taken by a turn.** A message counts as read when an inbox turn takes it. Tags send
  no read receipts.
- **A message grants nothing.** It arrives as another Tag's text, not a person's. It cannot
  change the recipient's Roles, its Objectives, or the permissions of the turn that reads it.
- **A reply is a new message.** The recipient answers with `send_message` to the original sender;
  that reply lands in the sender's own inbox, not in the Session that sent the first message.
- **Loops are bounded.** A turn sends at most 3 messages, and a chain of messages that answer one
  another stops after 4 hops. [Wake limits](#wake-limits) also cap how often Tags wake each
  other.
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

The second command prints the grant as JSON, with `sender_tag_id` `support` and
`recipient_tag_id` `backend`.

Grants are directional, so a reply back to `support` needs its own grant. Remove one with
`supertag mailbox-grant revoke support backend`. A Tag manifest declares the same routes:

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

A Tag sends with the `send_message` coordination tool, which takes `to` (a Tag name or ID),
`text`, and an optional `type`:

```json
{
  "to": "backend",
  "type": "question",
  "text": "Overdue invoices for annual plans are missing their plan ID. Does the usage event carry one?"
}
```

| `type` | Use it for | Wakes the recipient |
| --- | --- | --- |
| `note` (default) | Information the recipient may want | After about 3 seconds |
| `question` | Something the recipient should answer | After about 3 seconds, ahead of notes |
| `blocker` | Work that cannot continue until the recipient acts | At once, ahead of everything |
| `evidence` | A result, log, or measurement | After about 3 seconds |
| `decision` | A choice the sender made | After about 3 seconds |

A Tag cannot choose the `review` type. SuperTag gives it to a
[commit review request](#request-a-commit-review), which wakes the reviewer at once.

`send_message` is available in a Tag's conversations, in an Objective's conversation, and in the
Tag's own inbox turn. It is not available in a work Session, which may address only the Session
that started it, nor in the turn that brings a work Session's report back, except to request a
commit review of what that Session delivered.

`backend` takes the message in its next inbox turn, together with anything else waiting. It
answers with `send_message` back to `support` only when the sender needs an answer; a message
sent only to acknowledge another is noise.

## Request a commit review

An [Objective](objectives.md) records an outcome owned by a Tag. Its owner can ask another Tag,
such as one on another Team, to review a delivered Git commit. Set `review.commit` to the full hash in
`send_message`. The reviewer gets the request in its Mailbox with the Objective, commit,
and request message ID, and reads the commit's patch with `read_review_patch`.

The reviewer uses `send_message` with the requester as `to` and its evidence as `text`.
Set `review.requestId` to the request message ID and `review.verdict` to `approved` or
`changes_requested`. Both directions use the usual Mailbox grants. SuperTag records the
verdict on the Objective for that commit and brings it to the owner's Objective conversation.
See it with `supertag objective commit-reviews OBJECTIVE_ID`. A new
commit needs its own request. The operator still decides whether to accept the result.

<a id="wake-limits"></a>

## Wake limits

Wake limits stop Tags from waking each other in a loop. A message counts against them only when
it would start a turn: a message that joins a turn already waiting is free. Messages from people
never count.

| Limit | Default | Team manifest field |
| --- | --- | --- |
| Wakes between two Tags for one originating Task, both directions | 3 | `spec.wakeLimits.mutualPerTask` |
| Wakes of one Tag by other Tags per hour | 20 | `spec.wakeLimits.perTagPerHour` |
| Wakes by one Objective's Tags per hour | 60 | `spec.wakeLimits.perObjectivePerHour` |

The originating Task is the turn that started the chain: an inbox turn continues the chain of the
messages it was given. Hours are fixed clock hours.

Over a limit, SuperTag stores the message and drops nothing:

- A note, evidence, or decision wakes no one. The recipient sees it in its next turn.
- A question or blocker is delivered late: when the hour ends, or an hour later for the limit
  between two Tags. The turn says why it waited.
- The sender's `send_message` result says why in `wake_deferred`, for example `Tag reviewer was
  already woken 20 times this hour by other Tags; Tag reviewer will see this message in its next
  turn.`
- You get one Inbox item per limit and hour, saying how many messages waited. See it with
  `supertag get inbox-item`.

A Team changes its limits in its manifest; see [Organize Tags into Teams](teams.md). A Tag that
already has 64 turns' worth of messages waiting gets no new wake for a note: it reads it in its
next turn, and the sender is told the Tag is behind.

## Check that it worked

```sh
supertag get message --mailbox backend
```

Each message shows its sender, its text, its `kind` (`MESSAGE_KIND_NOTE`, `MESSAGE_KIND_QUESTION`,
and so on), and its `state`: `TAG_MESSAGE_STATE_PENDING` until the
inbox takes it, then `TAG_MESSAGE_STATE_HANDLED` with the `task_id` of the turn that took it, or
`TAG_MESSAGE_STATE_FAILED`. A page holds at most 16 messages, newest first; pass the returned
`next_cursor` as `--cursor` for older ones. The same command with `--mailbox support` shows the
reply.

A Tag reads its own Mailbox with the `read_mailbox` tool.

To see messages as they arrive, follow them:

```sh
supertag watch message
```

Each notice names a new direct message and the Tag it went to. Read the message with
`supertag get message --mailbox TAG`. Workstream posts appear as `workstream-post` notices
instead.

## If something goes wrong

- **The send is refused as not permitted.** The two Tags share no Team and there is no grant.
  Add one with `supertag mailbox-grant allow SENDER RECIPIENT` or put both in a Team. See
  [A Tag's message is refused or waits](troubleshooting.md#a-tags-message-is-refused-or-waits).
- **The send is refused for too many messages.** A turn sends at most 3. Say what the recipient
  needs in one message.
- **The send is refused for too many hops.** The message answers a chain that is already 4
  messages long. Bring a person in instead, or start the work directly.
- **A message stays pending.** The recipient has no connected Worker Host, so it cannot take an
  inbox turn. Check `supertag describe tag NAME`.
- **The send says the message waits.** A [wake limit](#wake-limits) held it. It arrives in the
  recipient's next turn or when the limit resets. If the Tags are looping, give the work to one
  of them; if the traffic is expected, raise the Team's `spec.wakeLimits`.
- **The recipient did nothing.** A message is information; the recipient decides under its own
  Roles whether to act. Give a Tag work you expect done through an
  [Objective](objectives.md) instead.

## Next

- [Share a Team's Workstream](workstreams.md)
- [Organize Tags into Teams](teams.md)
- [Define and complete an Objective](objectives.md)
