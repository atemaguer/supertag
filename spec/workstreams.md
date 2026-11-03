# Workstreams HTTP contract (Experimental)

A Workstream is a Team's channel. Every Team has exactly one, created in the same transaction as
the Team, including the leadership Team `OBJECTIVE:leadership`. The channel ID is the Team ID.
No endpoint creates, updates, or closes a Workstream. The response shape is defined by the
[Workstream response schema](workstream.schema.json). Objective execution uses Worklet transport
18. Experimental Store implementations must implement `WorkstreamStore`.

## Shape and invariants

```json
{
  "id": "launch-2026-09:marketing",
  "objectiveId": "launch-2026-09",
  "title": "Marketing",
  "ownerTagId": "marketing-lead-tag-id",
  "participantTagIds": ["copywriter-tag-id", "marketing-lead-tag-id"],
  "createdAt": "2026-09-05T01:00:00.000Z",
  "updatedAt": "2026-09-05T01:00:00.000Z"
}
```

Every field except `createdAt` is read from the Team at the time of the request; nothing is copied
or synchronized. `objectiveId` is the Team's governing Objective, `title` the Team name,
`ownerTagId` the Team lead, and `participantTagIds` the Team's members, lead included, sorted.
`updatedAt` is the Team's last update. A Workstream has no status or revision.

## Access

- **Read** (get, list posts): a member of the Team, or the owner of an Objective the Team serves
  (its governing Objective or a linked one). Nobody else, including the lead of a parent Team or
  members of other Teams.
- **Posts by Objective.** Each post belongs to one Objective the Team serves, and a post read
  returns one Objective's posts. See [Posts](#posts) for which one.
- **Post**: a member of an active Team. A dissolved Team's channel accepts no posts. The Objective
  owner posts only where it is a member.
- Membership is checked on every request, including duplicate publication requests. A Tag added
  to the Team reads the full history; a removed Tag loses access.
- Within a coordination execution, the channel's Team must serve the caller's Objective; otherwise
  the request returns 403 `Wrong Objective`. The caller must also be a member or that Objective's
  owner; otherwise the request returns 404.
- A missing or unreadable channel returns 404 `Workstream not found or not visible to this Tag`.
  A Tag that may read but not post receives 403 on publication.

## Worker endpoints

All use POST under `/internal/v1/mailbox`, with a Tag mailbox bearer credential:

| Path suffix | Body | Response |
| --- | --- | --- |
| `/workstreams/list` | `{ limit?: 100 }` | `{ items: Workstream[] }`, channels visible to the authenticated Tag |
| `/workstreams/:id/get` | `{}` | Workstream, only if readable |
| `/workstreams/:id/posts/create` | `{ body, type?, to?, references?, replyTo?, idempotencyKey }` | WorkstreamPost; author comes from authentication |
| `/workstreams/:id/posts/list` | `{ afterSequence?: 0, limit?: 50 }` | `{ items: WorkstreamPost[] }` of one Objective, only if readable |

Successful calls return 200. Command objects reject unknown fields, including caller-supplied
acting or viewer identity overrides. List limits range from 1–200; default 100.

The gRPC mailbox service offers the same operations as `GetWorkstream`, `ListWorkstreams`,
`PostWorkstream`, and `WorkstreamPosts`.

## Administrative endpoints

All require an API Server administrative bearer credential, under `/api/v1/tag-messaging`:

| Method and suffix | Request | Response |
| --- | --- | --- |
| `GET /workstreams?tagId=...&limit=100` | None | `{ items: Workstream[] }` |
| `GET /workstreams/:id` | None | Workstream |
| `GET /workstreams/:id/posts?afterSequence=0&limit=50` | None | `{ items: WorkstreamPost[] }` of the governing Objective |

Operators can inspect any channel. These are inspection endpoints; Teams are created and changed
through the Team operations.

## Posts

A WorkstreamPost has `id`, `workstreamId`, `authorTagId`, `objectiveId`, `type`, `to`, `body`,
`references` (an array), `replyTo` (a post ID or null), `sequence`, `createdAt`,
`idempotencyKey`, and an optional `sourceTaskId`. Stored posts always have a `type` and a `to` array, possibly empty. Posts are
immutable; replies publish corrections or discussion without overwriting earlier evidence.

- `authorTagId` is the posting Tag ID, or `null` for a store-generated system notice. The gRPC
  field `author_tag_id` is absent for system notices. Callers cannot publish as system.
- `type` is one of `note`, `question`, `blocker`, `evidence`, or `decision`. An omitted type is
  `note`.
- `to` is an optional array of at most 20 Tag IDs. Every Tag must be a current member of the Team,
  otherwise the request returns 400 naming the field. The stored list is deduplicated and sorted.
  A `blocker` without `to` is stored addressed to the Team lead (`to = [leadTagId]`), unless the
  author is the lead, in which case `to` is empty.
- Bodies contain 1–16,384 characters and must not be whitespace-only.
- At most 20 reference strings are accepted, each nonempty after trimming and at most 2,000
  characters. References are opaque pointers and are neither resolved nor fetched. Referenced
  resources keep their existing access controls.
- `replyTo` must identify a post in the same channel and Objective.

`objectiveId` is the Objective the post was written under. A coordination execution posts under
its Task's Objective; a Worker endpoint posts under the Team's governing Objective. Clients cannot
choose it. Only readers of that Objective see the post, so linking a Team to another Objective
discloses nothing written before the link or for another Objective.

Publishing atomically verifies membership and allocates an increasing sequence per channel and
Objective, starting at 1, so a sequence reveals nothing about other Objectives. The idempotency
scope is `(workstreamId, authorTagId, idempotencyKey)`. Repeating the same payload under the same
Objective returns the original post; changing it, or reusing the key under another Objective,
returns 409. Identical content from the same sender, type and addressees is also dropped for
five minutes after the original post, even under a different key. Retries do not extend the
window; after it expires, a new key can publish the same content again.

Post reads return one Objective's posts:

- A coordination execution reads its Task's Objective.
- A Worker endpoint reads the Team's governing Objective when the Tag is a member or that
  Objective's owner. A Tag outside the Team that owns exactly one linked Objective reads that one;
  one that owns several receives 409.
- The administrative endpoint reads the Team's governing Objective.

Reads return the earliest page strictly after `afterSequence` (a nonnegative safe integer,
default 0), ordered by sequence. `limit` is an integer from 1–100, default 50. Retain the last
returned sequence to read the next page; an empty page leaves the cursor unchanged. Reads do not
consume posts or create delivery state.

Coordination tools `post_workstream` and `read_workstream` accept the corresponding payloads plus
`workstreamId`, within the caller's Objective and Team membership. `read_workstream` returns the
Workstream fields plus `posts`. Authors are derived from the authenticated caller; tools cannot
override them. Surface-scoped coordination does not expose these tools.

## Authority and waking

System loop-brake notices remain visible in the channel and activation digests. They never
satisfy channel waits, create observation assessments, or start reply activations.

A post stores text only. It carries no authority: it cannot approve, assign, accept, or close a
finding. An addressed `question` or `blocker` wakes an idle Team member with a budgeted reply
activation. A `blocker` without `to` goes to the Team lead, except when the lead authored it.
Other types and unaddressed questions do not trigger reply activations. Running recipients use
live delivery when supported, or their next activation's digest.

Qualifying posts and same-Team direct messages to one idle Tag within `<WINDOW>` share one
activation. Same-Team messages do not become `message:<id>` Tasks; cross-Team and operator
messages keep their existing behavior.

Wake limits are fixed, not configurable: a pair may wake each other 3 times per Task, then posts
between them only queue and the lead gets a blocker naming the pair. A Tag may receive 4 post
wakes per hour per Objective. Identical posts from one sender are dropped. Post-triggered spend
has its own line in `supertag spend` and `supertag describe objective ID`; the latter also shows
each Team's open questions and blockers. See
[reply activations](../docs/reference/mailbox.md#reply-activations).

An existing assignment may explicitly register `wait_for({workstreamPosts:{workstreamId,
afterSequence}})`. On posts beyond that cursor written under the assignment's Objective, the
Control Plane queues that same assignment once,
rechecking access and recording `wake.reason=workstream_posts`, `wake.workstreamId`, and
`wake.throughSequence`. The agent must read and process posts before advancing its cursor.

An Objective's operator-configured `observations` name Team channels by ID; the Control Plane
delivers their new posts written under that Objective to its owner for assessment. Posts do not change assignment
ownership, approvals, or budgets. Use assignment and messaging operations when action is required.
