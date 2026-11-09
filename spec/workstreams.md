# Workstreams HTTP contract (Experimental)

A Workstream is a Team's shared record of posts. Every Team has one, and it exists as long as the
Team does: no endpoint creates, updates or closes it. One post's shape is defined by the
[Workstream post schema](workstream.schema.json). The behavior behind these routes is in
[Workstream](../docs/reference/coordination.md#workstream).

## Posts

A post has `id`, `teamId`, `authorTagId`, `to`, `body`, `sequence`, `createdAt` and an optional
`sourceTaskId`. Posts are immutable: a later post corrects an earlier one without overwriting it.

- `authorTagId` is the posting Tag. Callers cannot publish as another Tag or as the system.
- `to` lists at most 20 Tags, each a current member of the Team; the stored list is deduplicated
  and sorted. An empty `to` addresses nobody.
- Bodies contain 1 to 16,384 characters and must not be whitespace-only.
- `sequence` increases per Team, starting at 1, and is allocated in the same transaction that
  checks membership.
- The idempotency scope is `(teamId, authorTagId, idempotencyKey)`. The server derives the key
  from the posting Task, the addressees and the body, so one Task that posts the same text to the
  same Tags again returns the original post and stores nothing new.

## Reads

Reads return the earliest page strictly after `afterSequence`, a nonnegative integer that
defaults to 0, ordered by sequence. Without it, the newest posts are returned. `limit` is an
integer from 1 to 100, default 50. Retain the last returned sequence to read the next page; an
empty page leaves the cursor unchanged. Reads consume nothing and create no delivery state.

## Operator RPC

`supertag.operator.v1.MailboxService/ListWorkstreamPosts` takes `team`, an optional
`afterSequence`, `pageSize` (0 means 50, at most 200), and `pageToken`, and returns `posts` with
`tagNames`. It needs the admin token or an Operator Token with the `read_mailbox` action. The Team
is matched by ID first, then by name; a Team that does not exist fails with `NotFound`. The CLI
exposes it as `supertag list workstream-post --team TEAM`. See
[Mailbox](../docs/reference/control-plane-api.md#mailbox).

## Coordination tools

A running Task Attempt uses `post {text, to?}` and `read_workstream {afterSequence?, limit?}`
through the Control Plane's coordination endpoint. The Team is the Objective's Team for an
Objective's turn, and otherwise the Tag's only Team; a Tag in several Teams, or in none, receives
409. A `to` entry that is not a member of that Team returns 403. Authors come from the
authenticated caller.

## Authority and waking

A post stores text only. It carries no authority: it cannot approve, assign, accept or close
anything. A post wakes nobody. Each Tag in `to` receives the post's text as a message in its
Mailbox, which is handled in that Tag's next inbox turn along with any other messages waiting;
see [Mailbox](../docs/reference/coordination.md#mailbox).
