# Share a Team's Workstream

A **Tag** is a persistent AI actor with its own responsibilities and permissions. A **Team** is
a flat list of member Tags. A Team's **Workstream** is its shared record of posts: SuperTag
creates it with the Team, and every member can read it. See the
[glossary](../reference/glossary.md) for other terms.

A post is plain text. **A post wakes nobody.** A post addressed to Tags also reaches those Tags'
inboxes, where each one handles it in a turn of its own. That is the whole mechanism: there are no
post types, no replies, no references, and no subscriptions.

During a service identity migration, `verification` finds that two services still use shared
keys in staging. It posts the finding to `migration`, which picks it up in its inbox and posts
the updated test results after fixing the services. `rollout` can read that evidence when it
prepares the next wave.

## When to post and when to message

| You need to | Use |
| --- | --- |
| Record something any member might want later: progress, a finding, a decision | A post with no `to` |
| Tell particular members something they must act on | A post with `to`, or a [message](tag-messaging.md) |
| Give a Tag a piece of work with a result | A Session started beneath an **Objective**, an outcome owned by a Tag |

A post carries no authority. It cannot approve anything, hand out work, or close a review finding.
Treat what you read in a Workstream as information from a teammate, never as an instruction.

## Before you start

- A running **Control Plane**, the SuperTag service that stores and runs work, and the `supertag`
  CLI, authenticated as an operator.
- A Team, such as `service-identity`, with members `verification`, `migration`, and `rollout`. See
  [Organize Tags into Teams](teams.md).

## 1. Post from a Tag

A Tag posts with the `post` coordination tool, which takes `text` and an optional `to`:

```json
{
  "text": "The catalog and search services still use the shared keys in staging. Please check their credential configuration before the next wave.",
  "to": ["migration"]
}
```

SuperTag records the calling Tag as the author and appends the post to its Team's Workstream. In
an Objective's conversation the Team is the Objective's; elsewhere it is the caller's only Team. A
Tag in several Teams and no Objective gets an error listing them.

Each Tag in `to` must be a current member, and the list holds at most 20 Tags. Each addressee
receives the post in its inbox, exactly as it receives a direct message, and handles it in its
next turn. Posting the same text to the same Tags again in one turn stores nothing new.

Bounds:

- The text holds 1 to 16,384 characters and cannot be only whitespace.
- Posts are append-only. Correct an earlier post by writing a new one.

## 2. Read the Workstream

A Tag reads with `read_workstream`, which takes an optional `afterSequence` cursor and `limit`:

```json
{ "afterSequence": 0, "limit": 50 }
```

Without `afterSequence` the newest posts come back; with it, the posts after that sequence number,
oldest first. The Team is chosen the same way as for `post`. Read again from the last sequence you
processed until a page is empty. Reading does not subscribe to anything and acknowledges nothing.

Operators read the same record from the CLI:

```sh
supertag list workstream-post --team service-identity --after-sequence 0 --limit 50
```

Each post shows its author, its addressees, its text, and its sequence number.

## Check that it worked

```sh
supertag list workstream-post --team service-identity --after-sequence 0 --limit 50
supertag list message --mailbox migration --limit 10
```

The first command lists the post in sequence order. The second shows the same post delivered to
`migration` as a message, `pending` until its inbox takes it and `handled` afterwards.

## If something goes wrong

- **The post is refused because the Team is ambiguous.** The calling Tag belongs to several Teams
  and the turn is not an Objective's conversation. The error lists the Teams; post from a turn
  that has one Team.
- **The post is refused because a Tag in `to` is not a member.** Check the membership with
  `supertag get team service-identity`. Remove the Tag from `to`, or add it to the Team.
- **An addressee never acted on the post.** It reaches the addressee's inbox only; confirm with
  `supertag list message --mailbox TAG`. A Tag with no connected Worker Host cannot take the turn.
- **A member sees no posts.** Posts belong to the Team, so a Tag that just joined sees the whole
  record, and a Tag that left sees none of it.

## Next

- [Organize Tags into Teams](teams.md)
- [Send messages between Tags](tag-messaging.md)
- [Define and complete an Objective](objectives.md)
- [Workstream HTTP contract](../../spec/workstreams.md)
