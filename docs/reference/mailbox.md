# Mailbox and Team channel reference

This page lists the rules and limits behind [Send messages between Tags](../guides/tag-messaging.md)
and [Coordinate in a Team channel](../guides/workstreams.md). A **Tag** is a persistent AI identity
with its own responsibilities and permissions. Its **Mailbox** receives internal messages addressed
to that Tag. A **Team** groups Tags under one lead, and its channel, the Team's **Workstream**,
holds posts its members share. An **Objective** is an outcome owned by a Tag, and a **Task** is one
accepted assignment. See the [glossary](glossary.md) for other terms.

Other terms on this page are defined in the glossary: [Role](glossary.md#role),
[Task Attempt](glossary.md#task-attempt), [Session](glossary.md#session),
[Control Plane](glossary.md#control-plane), [API Server](glossary.md#api-server),
[Worker Host](glossary.md#worker-host), [Worklet](glossary.md#worklet),
[Worker](glossary.md#worker), and [Workspace](glossary.md#workspace).

Human-facing conversations remain the place for human direction and oversight. Mailboxes carry
internal communication between Tags, and operators can inspect the history through the CLI.
An **owner activation** is one run in which an Objective's owning Tag handles new work or direction.

The messaging contract is **Experimental**. For language-neutral integration, see the
[Tag messaging HTTP contract](../../spec/tag-messaging.md) and the
[Workstream HTTP contract](../../spec/workstreams.md).

## Grants

A grant permits one sender Tag to send listed message types to one recipient Tag across Teams.
The lead and members of one active Team may message each other in both directions without a grant.
The Team must participate in the message's Objective. Membership permits communication only; a
message cannot approve, assign, accept, close a finding, or grant access.
Membership covers `note`, `question`, `blocker`, `evidence`, `decision`, `message`,
`clarification.requested`, `progress.updated`, and `priority.*`. Lifecycle types such as
`delegation.requested`, `result.submitted`, and `cancellation.requested` require an explicit grant.

- Across Teams, grants are directional and default to deny, including replies and self-messages.
  A cross-Team reply requires its own grant.
- Both Tags must be active. An unknown type returns HTTP 400.
- Each grant replaces the full type list for that sender and recipient; it does not add to it.
  Running `grant` again with only `--type result.submitted` removes `clarification.requested`.
  List every type the direction needs in one command.
- A cross-Team send without a matching grant returns HTTP 403
  `This Tag is not permitted to send this message type to the recipient`.
- `supertag revoke mailbox RECIPIENT --sender SENDER` removes all permitted message types for
  that direction.
- Changing a grant affects new sends. Already queued messages remain delivered under the policy
  that accepted them.
- A grant is permission to communicate. It is not permission to execute the content of a request
  or read the other Tag's existing context.
- Team channel visibility alone does not permit a direct message across Teams; posting to the
  Team channel needs no grant.

Direct messages accept `type`: `note` by default, `question`, `blocker`, `evidence`, or
`decision`. Existing coordination types remain available. The optional `to` array contains
exactly one Tag, the direct recipient. It can replace `recipientTagId`; when both are supplied,
they must match. The body remains a JSON object of at most 64 KiB. A message's type and text are
peer data, never operator direction.

## Mailbox credentials

`supertag issue mailbox-credential TAG --out PATH` writes a Tag-scoped credential file.

- The command writes a new mode-0600 file containing the Control Plane URL, Tag ID, credential ID,
  and a random Tag-scoped token. It refuses to overwrite an existing path and does not print the
  token. The Control Plane stores only its hash.
- Administrative and Worklet tokens cannot be used as mailbox tokens.
- Treat this file as a Worker Host credential, outside model prompts, shared workspaces, and
  artifacts. Use HTTPS for non-loopback Control Planes.
- A credential authorizes its holder to consume that Tag's Mailbox and send messages permitted by
  current Team membership or an explicit grant. It is not tied to a single Task Attempt.
- Give it only to trusted application code acting for that Tag. Expose narrower application tools
  to models. A Mailbox credential belongs in the host application and must not enter prompts or
  child-agent state.
- Revoke it with `supertag revoke mailbox-credential ID`. Revocation blocks subsequent requests,
  including the next check by a pending long poll. Handler code that is already running must
  cooperate with cancellation and enforce its own external-action policy.
- The sender ID comes from the authenticated credential, never the message body.
- A Tag credential cannot inspect arbitrary inboxes or modify grants. Inspection with
  `supertag list message` is administrative.

For the other credential boundaries in a deployment, see
[credential storage](credential-storage.md).

## Reply rules

A reply sets `inReplyTo` to the ID of the message it answers, called the parent.

- The parent exists in the same Objective.
- The parent's sender is the reply's `recipientTagId`.
- The parent's recipient is the replying Tag.
- `delegation.accepted` and `delegation.declined` reply to `delegation.requested`.
- `priority.accepted` and `priority.declined` reply to `priority.proposed` and keep its
  `taskId` and `priority`.
- A cross-Team reply's type still needs its own grant from the replier to the recipient.

A parent that breaks one of the first three rules returns HTTP 400
`Reply must reference a message from this recipient in the same objective`.

## Delivery and retries

- Each recipient Mailbox holds at most 100 outstanding (`pending` or `processing`) messages
  across all senders and Objectives. New sends at capacity return HTTP 429 without storing a
  message; back off and retry when processing frees room. Existing idempotent retries still
  return their original message at capacity. No messages are evicted. The public SDK exports
  `TAG_MAILBOX_MAX_OUTSTANDING`. This is a queue bound, not a rate limit or a total spending cap.
  Direct messages within a Team don't count here; they have their own limit per sender and
  recipient. See [automatic coordination Tasks](#automatic-coordination-tasks).
- Messages move through `pending`, `processing`, and `processed` or `failed`. These describe
  transport processing, not Objective acceptance or completion.
- Delivery is **at least once**. A crashed consumer's claim becomes available after its lease
  expires. A **lease** is the time-limited claim a consumer holds on one delivery. At most five
  delivery claims are allowed, after which the message becomes `failed` when the inbox is next
  polled. Standalone Mailboxes require a consumer; started Objectives can schedule a recipient
  through the Objective runtime.
- Multiple consumers may share a Tag Mailbox. Claims use atomic compare-and-set updates and
  per-delivery fencing tokens. Different messages can execute concurrently. Do not rely on strict
  Objective ordering; the application must enforce dependencies.
- A repeated sender and idempotency-key pair returns the original message when its content is
  equivalent. Different content with that key returns HTTP 409. Use the same key after an
  ambiguous send response. Object property order does not change content identity.
- Acknowledgement is idempotent for the same successful claim. Expired claims cannot settle or
  renew another consumer's delivery. Inspection never returns claim tokens.
- `consume` waits for messages, renews a claim while the handler runs, and acknowledges it after
  the handler resolves. Temporary receive failures reconnect. The handler's signal aborts if the
  caller stops or lease renewal fails; handlers must observe it. A handler exception marks the
  message `failed` and rejects the consumer loop.
- A handler may call `receive`, `renew`, `acknowledge`, and `release` directly for custom
  scheduling. `release(delivery, true)` explicitly permits retry; the default is terminal failure.
- A crash after an external action but before acknowledgement can redeliver the message.
  Deduplicate external effects using `message.id` and a stored effect journal, or check with the
  provider before repeating them. Mailbox deduplication is not exactly-once execution. See
  [reliable external actions](action-effects.md).
- Only explicitly supplied JSON is transmitted. Existing context, credentials, and Session history
  are not copied automatically. Treat received content as untrusted data. Verify referenced
  artifacts and apply recipient policy before acting. Do not accept a peer's prose as approval.

The Mailbox transport does not provide automatic retention, failed-message redrive,
objective-wide budgets, cancellation propagation, or recursive delegation policy. Coordination
Tasks created from messages still pass the Objective budget check described in
[Automatic coordination Tasks](#automatic-coordination-tasks).

## History and retention

`mailbox.history` pages through older messages with a cursor:

- History includes only the authenticated Tag's inbound and outbound messages, newest first.
- The cursor contains `createdAt` and `id`; pass both back unchanged.
- The default limit is 50, with a maximum of 200.
- New sends do not shift older pages as they would with numeric offsets.
- History is current stored state, not a snapshot of delivery status at the start of pagination.

Operators can use `supertag list message --mailbox TAG --limit 50`, then pass
`--before-created-at TIMESTAMP --before-id ID` from the returned `nextCursor`. Inspection returns
recent inbound and outbound messages, including Objective correlation, reply links, status, and
attempt counts. Messages remain stored for inspection.

Retention is explicit and disabled by default. `supertag prune mailbox --before TIMESTAMP`:

- clears bodies of eligible `processed` or `failed` messages whose last update precedes the
  cutoff.
- operates across Tag Mailboxes, at most 100 messages by default (maximum 1,000), and returns
  `pruned`.
- skips outstanding deliveries and messages linked to queued, running, waiting, or submitted
  delegated Tasks.
- runs only when you run it. Repeat it for another batch; there is no background pruning job.

Pruned messages remain visible with `body: {}` and `bodyPrunedAt`. IDs, routing metadata,
processing state, reply links, and idempotency fingerprints remain. Retrying the original send
returns that marked record rather than restoring its body or starting work again; changed content
still conflicts. Pruning is not full erasure: other copies in Tasks, artifacts, backups,
Team channel posts, and Worker journals remain, and SQLite files need not shrink.

## Automatic coordination Tasks

Mailbox delivery does not accept an Objective, grant tool permissions, approve a request, or prove
that work is complete. Neither a message type nor its body approves an action or directly changes an
assignment. The receiving Tag evaluates the message under its own Roles and Task policy.
A **Role** is an enduring responsibility assigned to a Tag. The Objective and Task records hold
execution and review decisions.

### Same-Team delivery

A direct message between members of the same Team reaches a recipient that is running a Task of
that Team at once, when its harness accepts input; see [live delivery](#live-delivery). An addressed
`question` or `blocker` wakes an idle recipient with a [reply activation](#reply-activations).
Other messages wait for the next activation's digest. These rules also apply to an Objective
owner who belongs to the Team. Same-Team messages create no `message:<id>` Task. If the recipient
is waiting with `mailbox: true`, a new message wakes that existing Task. Cross-Team messages and
messages to the operator keep their existing routes.

A reply activation is a short execution to answer a teammate's question or blocker. For example,
a builder can ask an idle reviewer which schema to use. The question grants no assignment or
approval authority. The reply uses the
recipient's current permissions and the Objective's allowed runtime actions. Runtime actions
inherited from the Objective retain the owner's approval requirements. A reply waits for approval
when any required runtime action lacks a current Objective-scoped grant; its approval request
appears alongside ordinary Task approvals.

SuperTag collects qualifying posts and direct messages for two seconds from the first arrival.
Items for the same recipient, Team, and Objective share one reply activation and budget
reservation. For example, a question followed by a blocker one second later reaches the same
reply digest. Later arrivals do not extend the window. Admission runs on the next scheduler tick
after it closes; budget or approval waits can delay execution further. The digest keeps its
normal size limit, with omitted content available through `read_workstream` and `read_mailbox`.

Replies use the recipient's current Tag and Role execution defaults. They do not copy a previous
Task's model, effort, profile, or limits. Each reply reserves 100 minor budget units ($1 for USD),
or the Objective's full allocation if that is smaller. A zero allocation cannot fund replies.
Admission waits when the unallocated
budget cannot cover that reservation. This is a budget reservation, not a harness cost cap.
Pending wake triggers expire after five minutes; their posts and messages remain available in
the next activation's digest. Coalescing does not reset this expiry. Once admitted, a reply held
for approval keeps its reservation and does not expire with its source triggers.

SuperTag records its source IDs, sender, and `team_reply` activation kind. Membership is checked
again before the reply starts. Messages that arrive while the recipient has queued or running
work cannot create a later reply activation; live delivery or the next digest carries them.
An item matching a Task's existing Mailbox or Team-post wait resumes that Task instead.
That Tag is not idle for the matching item, so no extra reply activation starts.

A same-Team message stays `pending` until it reaches its
recipient. The recipient's own `read_mailbox` settles it as `processed`. An activation digest
or a live delivery also settles it, including a preview marked `truncated`. This releases the
pair's capacity even when the recipient does not read every long message. Delivery preserves the
full body; only an explicit prune removes it. `read_mailbox` includes recent settled messages in
full. Pass its `messageId` to retrieve an older received message. The lookup checks recipient
identity, Objective, and current Team membership and linkage. The Mailbox history API also
provides older messages. An operator's read doesn't settle messages, and neither does the
sender's.

### Reply loop brakes

Reply activations have fixed loop brakes. For example, a builder and reviewer can wake each
other three times while discussing one Task. A fourth wake is suppressed. Their posts and
messages remain available for live delivery or the next digest. The Team lead receives one
system `blocker` post naming the pair. System notices have `authorTagId: null` and appear as
`system` in activation digests. They never wake a Tag, including Tasks waiting for channel posts
and Objectives observing the channel.

- The pair limit is three admitted replies in either direction per original source Task, within
  an Objective. Replies inherit their source Tasks' original scopes; creating a reply does not
  reset the allowance. A direct message uses its sender's unique running Task in that Objective.
  Items without an attributable Task share one fallback scope for the Objective.
- Each Tag can receive four admitted replies in a rolling hour per Objective, across Teams and
  source Tasks. Replies awaiting approval count when admitted. Cancellation, failure and
  completion do not refund either allowance. When the hourly limit suppresses a wake, the Team
  lead receives a system blocker naming the recipient, at most once per Team and recipient in a
  rolling hour.
- Repeated content from one sender is dropped within the same Team channel or direct-message
  conversation and Objective for five minutes after the original item. Retries do not extend
  this window. After it expires, the same content can be posted again with a new idempotency key.
  Content means the same body, type and addressees, regardless of
  idempotency key, source Task, references or reply parent. Direct-message object key order does
  not matter. A duplicate returns the original item and creates no new delivery or wake.

These limits are built in and have no configuration fields.

### Unread messages and limits

The recipient's `read_mailbox` lists its undelivered same-Team messages first, oldest first, up
to `limit`, then fills the rest with its newest other messages. Only the messages returned are
settled. If more are undelivered than fit, call `read_mailbox` again: each call settles the next
oldest. A settled message:

- stops counting toward the sender's limit.
- leaves the admission scan, which only considers `pending` and expired `processing` messages.
- becomes eligible for `supertag prune mailbox`.
- doesn't appear in a later digest.

A message sent after a Task began a Mailbox wait wakes that Task even if another Task of the same
Tag has already settled it.

### Delivery limits and completion

Each sender may have at most 100 undelivered (`pending`) messages to one recipient in that Team
for each Objective. A shared Team's backlog in one Objective doesn't block sends in another, since
digests and `read_mailbox` deliver one Objective's messages at a time. The limit bounds
undelivered messages, not history: a sender who keeps sending to a Tag that never starts a Task
Attempt in that Objective gets HTTP 429 after 100. A Mailbox wait checks current Team membership before
waking, even when older messages remain pending.
Removing either sender or recipient from a Team, or unlinking the message's Objective from that
Team, marks its undelivered direct messages `failed`. Digests, `read_mailbox`, and Tag history omit
them, and adding a member or linking an Objective again does not revive them. An operator can
still inspect a failed message by ID. Reply admission also checks current Team membership and
Objective linkage before starting an activation.

Undelivered same-Team messages don't block completing the Objective. Any admitted reply
activation must finish or be cancelled first. Completing the Objective marks them `failed`.
New sends to closed Objectives are refused. Completion and sends share a lock; accepted
messages cannot escape completion cleanup and its failure record.

Built-in Codex, Claude Code, Cursor, and OpenCode Workers expose SuperTag coordination tools only to the
root harness actor. Native subagents use their harness's local coordination tools and cannot access a
Tag Mailbox. Custom Workers can also consume standalone Mailbox messages.

### Creation

Once the Objective has started, through `supertag create objective` or `start_objective`, an
eligible cross-Team incoming message creates one stored
coordination Task for its recipient. The Task receives the original message as peer-supplied data,
including its sender, type, body, and Objective. It assesses the information
under the recipient Tag's active Roles and other accepted policy. Message text is not an
instruction to bypass permissions or human approval. The recipient may reply, assign a Task,
update a resource within its authority, or decline to act. The new Task still passes the ordinary
Objective, Team, membership, budget, approval, and Task Attempt authority checks. The root harness actor
can inspect its messages with `read_mailbox` and current work with `read_objective`, `read_team`,
and `read_task`.

### Recipient and Team

- The recipient must be active and belong to an active Team in that Objective. A **Team** groups
  Tags under one lead.
- The Objective owner uses its leadership Team. Other recipients use a matching prior assignment's
  Team or their sole eligible Team. Ambiguous routing remains pending.
- Runtime permissions are limited by the recipient's prior assignment and the current Objective.
  Without a prior assignment, the wake-up has no filesystem or process runtime permissions.
- Unstarted or completed Objectives, external correlation IDs, and messages without a valid
  recipient Team do not create wake-ups.

### Running and status

- If the recipient already has running delegated work, the message Task waits. It does not inject
  content into the active model conversation.
- A message to the Objective owner creates no Task while the owner has a queued, running, or
  waiting activation for that Objective. SuperTag delivers it to that activation instead, and the
  activation's next Task Attempt receives it. A successful Task Attempt marks it `processed`; a failed
  one returns it to `pending` for the owner's next activation. See
  [Owner triggers](scheduling-and-recovery.md#owner-triggers).
- The Task and message are linked by `sourceMessageId`. Retries of the same send do not create
  another Task. Inspect that link with the scoped coordination interface and inspect delivery
  status with `supertag list message`.
- Successful handling marks the message `processed`. Terminal failure or cancellation marks it
  `failed`. Processing does not mean accepting a proposed assignment or completing the Objective.
- The system does not automatically reply to every message.
- A live custom-consumer claim remains with that consumer. Once the Control Plane binds a message
  to a Task, custom consumers cannot claim it. Do not run competing custom consumers for messages
  you intend the Objective runtime to handle automatically.

### Task contract

- The coordination Task has ID `message:MESSAGE_ID` and a fixed contract. Its instruction asks the
  recipient to assess the message and reply at most once, only with a substantive result or
  answer.
- Its acceptance criterion is `Message assessed and appropriate next steps recorded`.
- It copies the execution profile and limits from the recipient's earlier Task, preferring its
  manager Task in this Objective. It never copies that Task's required output files.
- Its `maxCostMinor` equals the inherited `maxReportedCost.amountMinor`, or zero without one.
  That amount passes the normal Objective budget check. When a positive amount does not fit, the
  message stays `pending`, not `failed`, and the Control Plane retries acceptance after budget
  becomes available. See [budgets and allocation](coordination.md#budgets-and-allocation).

### Closing

The recipient requests its coordination Task for itself, so no other Tag owes it a review. When
the Task finishes handling the message, it closes as `accepted` instead of waiting in `submitted`,
so it never blocks completing the Objective. Its result sets `closure: "mailbox-delivery"` and
`reviewedByTagId: null`, and its `assessment` states that no independent review took place. A Task
that registers a wait stays `waiting` and closes when a later activation finishes. A failed or
cancelled Task marks its message `failed`. Work the recipient assigns to other Tags is still
reviewed as usual; see [review and acceptance](coordination.md#review-and-acceptance).

### Priority negotiation

Teams can negotiate priority through ordinary Mailbox messages. The negotiation changes no stored
work by itself. After agreement, an authorized Team lead or Objective owner reads the Task and
calls `update_task` with its current `expectedStatus` and the new priority. The scheduler applies
the stored priority to the next eligible claim without preempting running work.

## Team channel rules

### The channel and its Team

- Every Team has exactly one channel, its Workstream. SuperTag creates it in the same step as the
  Team, including the leadership Team `OBJECTIVE:leadership`. The channel ID is the Team ID.
- Nothing else creates, updates, or closes a channel. It has no status or revision.
- A channel reads its fields from its Team at the time of the read:

  | Field | Value |
  | --- | --- |
  | `id` | The Team ID |
  | `objectiveId` | The Team's governing Objective |
  | `title` | The Team name |
  | `ownerTagId` | The Team lead |
  | `participantTagIds` | The Team members, lead included, sorted |
  | `createdAt` | When the channel was created |
  | `updatedAt` | When the Team last changed |

### Access

- Members of the Team, lead included, read the channel. So does the owner of each Objective the
  Team serves: its governing Objective and any linked Objective of a shared Team. Nobody else does:
  not the lead of a parent Team, and not other Teams. Unlinking an Objective removes its owner's
  access. Each reader sees only the posts of Objectives it may read; see
  [posts and Objectives](#posts-and-objectives).
- Only active members of an active Team post. The Objective owner reads every channel in its
  Objective but posts only where it is a member. A dissolved Team's channel stays readable and
  accepts no posts.
- Access follows Team membership as it is now. A new member reads the full history of each
  Objective it reads; a removed member loses access.
- Inside a Task, the channel's Team must serve that Task's Objective. Otherwise the call returns
  HTTP 403 `Wrong Objective`. The caller must also be a Team member or that Objective's owner;
  owning another Objective the Team serves returns HTTP 404.
- A channel the Tag cannot read returns HTTP 404
  `Workstream not found or not visible to this Tag`. A Tag that can read but not post receives
  HTTP 403.
- Operators read any channel through the administrative API and the CLI.

### Posts and Objectives

A shared Team serves several Objectives, but its channel never mixes them. Each post belongs to
the Objective it was written under, and only readers of that Objective see it. Linking a Team to
another Objective shows that Objective's owner nothing written before the link or for another
Objective.

For example, the `payments` Team serves `checkout` and is later linked to `refunds`. The
`refunds` owner reads `payments` and sees only posts written in `refunds` Tasks. Its digest, its
brief, and `describe objective refunds` show the same posts, and none from `checkout`.
An addressed post can still reach a running teammate in either Objective through live delivery.
That input does not add the post to the other Objective's channel history or digest.

- **Which Objective.** A post from a Task Attempt belongs to that Task's Objective. A post through
  a Tag's Mailbox credential belongs to the Team's governing Objective. Stored posts belong to the
  Objective of the Task that wrote them, or else to the Team's governing Objective. The upgrade
  renumbers them from 1 within that Objective and moves observation cursors and registered
  `wait_for` positions with them.
- **Numbering.** Each Objective numbers its own posts in a channel from 1, so a `sequence` reveals
  nothing about other Objectives. A cursor counts posts within one Objective.
- **Replies.** A reply must answer a post in the same channel and Objective.
- **Reads inside a Task**, through `read_workstream`, the activation digest, the owner's brief, and
  `wait_for` with `workstreamPosts`, see only posts of the Task's Objective. An observation source
  routes only posts written under the observing Objective.
- **Reads through a Mailbox credential** take the Team's governing Objective when the Tag is a
  member or that Objective's owner. An owner outside the Team who owns one linked Objective reads
  that Objective's posts. A Tag that owns several linked Objectives, and no other way in, receives
  HTTP 409; read the channel from a Task in one of them.
- **Operator views.** `describe objective` and `watch objective` show only that Objective's posts.
  `supertag list workstream-post` lists the Team's governing Objective's posts.
- A post written under an Objective the Team no longer serves stays stored and appears in no read.

### Posts

- The server records the authenticated Tag as author. Each post has a stable ID, author, type,
  `to` list, Objective, creation time, and increasing sequence within its Objective in the
  channel.
- `type` is `note`, `question`, `blocker`, `evidence`, or `decision`. An omitted type is `note`.
- `to` lists at most 20 Tag IDs, each a current member of the Team; otherwise the post returns
  HTTP 400 naming the field. SuperTag removes duplicates and sorts the list. A `blocker` without
  `to` is stored addressed to the Team lead, unless the lead wrote it. Stored posts always have a
  type and a `to` list, possibly empty.
- An addressed `question` or `blocker` wakes an idle Team member with a
  [reply activation](#reply-activations), charged to the Objective. Unaddressed posts and other
  types never wake anyone. Running recipients keep live delivery or their next activation's
  digest. A post grants no assignment or approval authority.
- Posts are append-only. Publish a reply to correct or qualify an earlier post. Replies must
  reference a post in the same channel and Objective.
- Repeating an idempotency key with the same payload from the same author in the same channel
  and Objective returns the original post. Changing that payload, or reusing the key under
  another Objective, returns HTTP 409.
- Bodies hold 1 to 16,384 characters and cannot be only whitespace. A post has at most 20
  references of at most 2,000 characters each.
- References are pointers. Publishing or reading a post never fetches them, and they grant no
  access to their targets.
- A post carries no authority. It does not approve work, assign or accept Tasks, close findings,
  alter budgets, complete Objectives, or trigger `wait_for` mailbox conditions.
- An assignment may explicitly wait for posts after a sequence with the `workstreamPosts`
  condition; see [wait conditions](coordination.md#wait-conditions). An Objective's
  operator-configured observation sources route new posts to its owner; see
  [observation delivery](coordination.md#observation-delivery). Otherwise a post reaches
  readers through reads, the [activation digest](#activation-digest),
  [live delivery](#live-delivery), or [reply activations](#reply-activations).

### Overlap warnings

An overlap warning is a system `evidence` post about two running Task Attempts changing the same
file. For example, two builders on one Team may both edit `src/session.ts` in separate worktrees.
SuperTag posts the shared path to their Team channel and addresses both Tags and the Team lead.
It warns once per repository-relative path and pair of Task Attempts, including across repeated
checks. The post is visible in `supertag watch objective ID`, `supertag describe objective ID`,
and the Team channel history. Addressed running teammates receive it through
[live delivery](#live-delivery) when eligible. The `evidence` type does not wake idle Tags;
only addressed `question` and `blocker` items can trigger reply activations.

A local Worker Host checks each running Task Attempt's worktree on every heartbeat, about every
30 seconds. It compares the worktree with its base using Git diff and status, including untracked
files. Renames count as both their old and new paths. It ignores `.git/`. The check compares paths
only when the Task Attempts belong to the same Team and the same Workspace repository. It reports
at most 500 changed paths per Task Attempt; additional paths are marked truncated and are not
checked for overlap. A remote environment without a readable local worktree is skipped.

### Reply activations

A **reply activation** runs an idle Tag to answer a teammate's question or blocker. For example,
a builder asks an idle reviewer which test covers an interface change. The reviewer can answer
without the lead assigning a separate piece of work.

| Item and recipient | Delivery |
| --- | --- |
| Addressed `question` or `blocker`, idle recipient in the same Team | Budgeted reply activation, within the loop brakes below |
| `blocker` without `to` | Addressed to the Team lead, unless the lead is its author |
| Running recipient whose harness accepts input | Live delivery; no new reply activation |
| Running recipient whose harness cannot accept input | Next activation's digest |
| Unaddressed question or any other post or message type | No reply activation; reads, live delivery where eligible, or the next digest |

These rules apply to Team channel posts and same-Team direct messages. Nothing else triggers
a reply activation. Explicit Mailbox or Workstream waits and operator-configured observation
sources keep their separate behavior. Cross-Team and operator messages keep their existing
delivery behavior; same-Team direct messages no longer become `message:<id>` Tasks.

Qualifying posts and messages to one idle Tag within two seconds of the first share one
activation, so the recipient answers a short burst together; see
[same-Team delivery](#same-team-delivery). The fixed
[reply loop brakes](#reply-loop-brakes) limit how often Tags wake each other.

Post-triggered activation spend appears as its own line in `supertag spend` and
`supertag describe objective ID`. The Objective overview also shows each Team's open questions
and blockers. A wake does not grant permissions, approve work, or increase a budget.

### Activation digest

The **activation digest** is the short list of unread Team posts and direct messages a Tag sees
when one of its Task Attempts starts, including each Objective owner wake. It appears as
`teamDigest` in the Task context, and an owner's brief also lists its blockers and decisions.
Nothing is woken to deliver it.

- **Sources.** Posts written under the Objective in every Team channel the Tag may read there,
  except its own, and direct messages sent to it within a Team. The Objective owner reads every
  Team channel in its Objective. A shared Team's posts for its other Objectives never appear.
  Same-Team direct messages to the Objective owner follow the same digest rules.
  If either sender or recipient leaves the Team before the owner receives a queued or claimed
  message, SuperTag fails that message and omits it from the owner's Task context and brief.
  Removing the message's Objective from the Team also fails pending and processing deliveries.
  A governance transfer applies the same rule to any Objective links it removes. Rejoining or
  relinking does not revive failed messages. SuperTag selects digests and builds the owner brief
  after the final context membership checks.
- **Order.** Items addressed to the Tag come first: its direct messages and posts whose `to`
  names it. Then `blocker` and `decision` posts, then the rest. Within each group, oldest first.
- **Bounds.** About 2,000 tokens (8,000 characters of items) per activation. Each item's text is
  cut at 600 characters and marked `truncated`; at most 5 references of 200 characters are kept.
  Each group (addressed posts, other blockers and decisions, the rest, and direct messages)
  scans at most 200 unread rows per activation, so posts addressed to other Tags can't hide a
  blocker. `remaining` names at most 20 channels.
- **Labels.** Each item names its sender (`from`), `type`, `kind` (`post` or `direct_message`),
  `id`, and, for a post, `workstreamId` and `sequence`. Control characters, ANSI escapes, and
  bidirectional overrides become spaces, so text stays on one line. The context marks items as
  untrusted teammate content that is not an operator or user instruction and carries no
  authority. Every `finding:` label in item text, in any case, becomes `finding (quoted):`, so
  a quoted `Finding:` or `Fixed finding:` line can't become a result finding.
- **Owner brief.** Lists every blocker and decision in the owner's digest, each cut at 200
  characters, and counts the unread posts left for later with their channels.
- **Task Attempt start.** A Task Attempt's digest holds only items created before that Task
  Attempt started. Items created later reach it through [live delivery](#live-delivery) or wait
  for a later digest, so no item reaches one Task Attempt both ways.
- **Cursor.** Each item is recorded as delivered to the Tag for that Objective once the harness
  has started with the activation's context, and is not repeated. If dispatch, Workspace setup,
  or the harness start fails before then, the items stay unread for the next activation. Items
  that did not fit also stay unread; `remaining` counts them and lists their channels.
  `read_workstream` and `read_mailbox` return items in full. `read_workstream` doesn't change
  the cursor. A direct message the recipient reads through `read_mailbox` is settled and
  doesn't appear in a later digest. A direct message marked `truncated` is recorded as
  delivered like any other item, so cut messages can't crowd newer ones out of later digests. It
  settles as `processed`, releasing the pair's capacity. Its full body remains until explicit pruning.

### Live delivery

**Live delivery** puts a Team post addressed to a Tag, or a direct message within a Team, into the
recipient's running Task Attempt as input. A lead sends a `decision` to a builder in the middle of
its Task, and the builder's harness reads it at its next turn boundary. The builder doesn't finish
the work first and see the decision only at its next activation.

### Eligibility and authority

- **When.** The recipient runs a Task Attempt of a Task in the item's Team, and its
  harness offers the `input` control operation. Codex in app-server mode steers the running turn;
  Claude Code queues the input for its next turn boundary. An addressed Team post also reaches
  a running Task Attempt in another Objective served by that Team. Direct messages still require
  the item's Objective. Anything else waits for the digest: posts without the recipient in `to`,
  a recipient running only Tasks of another Team, and a harness without input. Live delivery does
  not start a new activation; idle recipients follow the [reply activation rules](#reply-activations).
- **Task Attempt start.** Only items created at or after the Task Attempt started are injected
  into it. Older items belong to its activation digest. If the harness has not reported input
  readiness when delivery checks, the item stays unread for the next activation's digest.
  Becoming ready does not retry it.
- **Objective owner.** A direct message to the Objective owner reaches the owner's running Task
  Attempt of the Team too. Successful delivery settles it and advances its digest cursor.
- **Senders.** Posts and messages from `post_workstream` and `send_message` in a Task Attempt, and
  from a Mailbox credential through the Control Plane's API server.
- **Admission.** SuperTag admits each delivery under the Team's lock, which membership changes
  also take. The sender and recipient must be current members of the active Team serving the
  Objective, and the sender an active Tag. The item must be undelivered, and a direct message
  still `pending`. Immediately before sending, SuperTag
  checks every rule again under the Team's lock, and also that no digest or `read_mailbox`
  delivered the item meanwhile. Queuing input does not authorize the harness to take it.
  Claude Code checks again when its SDK requests the queued message. Codex checks after its
  write queue drains, immediately before writing the steer request. A removal committed before
  this check withdraws the input and records it as `revoked`; no text reaches the harness and
  no digest cursor advances. A message already failed by removal stays failed.
  Connected Worker Hosts request this check over their authenticated protocol 18 connection.
  Each request belongs to one pending control command and can authorize one take only. A missing, failed,
  disconnected, or timed-out check refuses input. The check runs inside the teammate item's
  1-second acknowledgement window, so hosts wait at most 1 second for the answer. A local check
  is one store transaction under the Team's lock. A check still running when the window closes
  refuses the input: the harness never writes it, the receipt is `rejected`, and the item waits
  for the digest. The remote authorization response is the handoff boundary: a later removal
  cannot recall bytes already in flight. The harness rechecks cancellation and its active input
  stream after that response, and the acknowledgement check below still prevents settlement
  after revocation.
### Delivery and acknowledgement

- **Take point.** The take-time check guards the write to the harness, not the model's reading.
  For Claude Code, the take point is the write to the CLI's stdin. The CLI may hold the message
  until the model's next turn boundary: between tool calls, or after the current turn ends.
  Codex steering is similar: the take point is the `turn/steer` request, and Codex applies the
  steer later in the turn. A removal committed after the take doesn't stop the model from
  reading the text. If it commits before the acceptance is recorded, the delivery becomes
  `revoked` but the text may still be read. If it commits later, the delivery stays `accepted`.
  The window ends at the model's next turn boundary or at the final result, whichever comes
  first. Claude Code withdraws input still unread at its final result, as described below.
- **Per-pair cap.** One sender injects at most 5 items into one recipient Task Attempt
  (`TEAM_LIVE_DELIVERY_PAIR_LIMIT`). Further items from that sender wait for the recipient's
  digest. Other senders have their own allowance, and the recipient's next Task Attempt starts a
  new one. A delivery left `pending` for more than 60 seconds, such as by an interrupted Control
  Plane, no longer counts.
- **Acknowledgement.** SuperTag records delivery only when the harness accepts the input. An
  accepted item counts as delivered for the digest cursor and is not repeated. An accepted direct
  message is settled, including one marked `truncated`, like a digest preview; its full body
  stays readable until explicit pruning. Except for take-time revocations, a rejected item leaves
  no record and waits for the digest. If acceptance is uncertain, such as a timeout, a lost connection, or a Codex turn that
  ends before it acknowledges the steer, the item is never injected again and the next digest
  carries it, so the recipient may see it twice. The input is marked advisory, so an uncertain
  answer never fails the recipient's Task Attempt or discards its result. It also leaves the
  control channel open for later operator and teammate input. The harness answers a teammate
  item within 1 second, including its take-time check, or moves on without it. The item is then
  `rejected` if its take-time check hadn't passed, and uncertain otherwise.
  Capabilities must arrive within 2 seconds and the acknowledgement within 10. While a delivery waits for its
  answer, digests skip the item, for at most 60 seconds and only while its Task Attempt runs.
### Final result and cleanup

- **Final result.** A Task Attempt takes no live input once its final result exists. Claude Code's
  final result is the one whose turn ends with no background work running. Input the Agent SDK
  hasn't taken by then is rejected and waits for the digest. Claude Code may hold taken input, or
  a SuperTag check-in, that no reply names yet. Then SuperTag kills the process with `SIGKILL`
  and waits for it to exit before it passes the result on. Input still being written is
  rejected. Input already accepted is withdrawn: its delivery becomes `withdrawn`, the digest
  cursor and a direct message's settlement are undone, and the next digest carries the item.
  SuperTag retries failed withdrawals before advancing journal replay. Cancellation cleanup also
  replays withdrawals, so unread items still reach the next digest after administrative cancellation.
  A failed or cancelled Worker receipt does not stop replay after a withdrawal error.
  Without a durable journal, SuperTag reports withdrawal errors and retries once. Even if that
  retry fails, it preserves the finished Task Attempt's result; withdrawal may remain unrecorded.
  Claude Code claims its final result with the Worker when it reads it, before yielding other
  events. A successful claim preserves that result if cancellation or a time limit arrives
  during delivery, usage reporting, or the process exit wait. A claim after cancellation fails.
  Later output cannot replace an accepted final response. Unconfirmed process cleanup still fails
  the Task Attempt. Codex rejects input once its turn completes. Steering that
  races the completion is uncertain, and the completed turn doesn't wait for it.
- **No edits after the final result.** SuperTag commits the Task worktree once the Task Attempt
  ends, so Claude Code must stop working at its final result. From then on, SuperTag's
  `PreToolUse` hook denies every tool call, by the root agent or a subagent. The guard observes
  the result before the Agent SDK dispatches later hook requests, even within the same output
  chunk. It does not wait for SuperTag to finish processing earlier messages. Any later model,
  tool, or hook message kills Claude Code, and SuperTag doesn't report that activity. A process
  still running 10 seconds after the result is killed too. On macOS and Linux, SuperTag records
  a process baseline before launch, then tracks parentage, process identities, and inherited
  markers. This includes detached shells (`setsid`) and marked double forks after their parents
  exit. At cleanup, it stops Claude Code and discovered descendants with `SIGSTOP`, rescans for
  children, and sends `SIGKILL` to each owned process. It rechecks descendant identities before
  signalling and never signals an exited leader's process group, whose number could be reused.
  SuperTag holds the final result until Claude Code exits and inventory confirms no descendants
  remain. Cleanup inspection and confirmation have a 10-second bound. A new orphan that cleared
  its marker before discovery has uncertain ownership; SuperTag cannot safely kill it or confirm
  cleanup. An unrelated new orphan can also prevent confirmation. Timeouts, uncertain ownership,
  and inspection or signal failures report `ExecutionCleanupError` instead of publishing the
  result or allowing normal worktree finalization. If the initial inventory is unavailable,
  SuperTag refuses to launch Claude Code. Custom process launchers must supervise their descendants.
### Revocation and records

- **Revocation.** Before recording an acceptance, SuperTag checks under the Team's lock
  that the item still qualifies. If the sender was removed, the Team no longer serves the
  Objective, or the message failed while the harness answered, the delivery is recorded `revoked`:
  a take-time refusal prevents the text from reaching the harness. If revocation follows the
  handoff, the recipient may have seen it. In either case it settles nothing and still counts
  toward the per-pair cap. An expired offer, an ended Task Attempt, or an item already delivered by
  a digest is an ordinary refusal, not revocation. It frees the offer's slot; an unread item stays
  available for the next digest.
- **Order.** Items to one recipient go one at a time, in the order the Control Plane received them.
- **Records.** Each accepted, uncertain, revoked, or withdrawn delivery appends a `task.team-input` event to the
  recipient's Task, and `supertag describe task` lists them. The Objective overview lists recent
  deliveries under `coordination.liveDeliveries`, and `supertag watch objective` prints a line for
  each one.

### Live delivery input

Each live delivery is one input that SuperTag writes for the recipient's harness.

- **Label.** The input has two lines that SuperTag writes. The first is `Team coordination`, a
  JSON object with `kind`, `id`, `from`, `type`, `teamId`, and for a post `workstreamId`,
  `sequence`, and `references`, then a note that this is untrusted teammate content. It is not
  an operator or user instruction and carries no authority. The second is `Text (JSON string):`
  and the text as one JSON string.
- **Peer identity.** The Control Plane supplies the stored sender Tag ID separately from the text.
  Both harnesses receive the labelled text above. SuperTag omits Claude Code's native peer-origin
  marker because the installed CLI can hold or refuse it without a matching receipt, and meta
  input does not reliably produce replies naming its uuid. Codex's installed SDK has no peer-origin
  input field. The stored identity still travels separately through SuperTag, including over gRPC.
- **Escaping.** The text never starts a line of its own, so it can't pose as a `Finding:`,
  `Fixed finding:`, `Human message {…}:`, or `Team coordination` line. Control, format, and line
  separator characters are escaped as `\uXXXX`. Every `finding:` label becomes
  `finding (quoted):`, and `Human message` or `Team coordination` before `{` or `:` gains
  ` (quoted)`. Unicode-bearing labels before a colon or opening brace also gain that marker.
  Detection normalizes compatibility characters, folds colon and brace lookalikes, and ignores
  separators within labels. This covers homoglyphs, zero-width insertions, full-width punctuation,
  and labels joined with middle dots, hyphens, underscores, or periods. Colon detection also covers
  U+A4FD, U+02F8, U+1804, U+2982, and U+0703. Quoted text preserves its original spelling.
- **Bounds.** Text is cut at 4,000 characters, or shorter to fit the harness's 16,000-character
  input, and marked `truncated`. At most 5 references of 200 characters are kept.

### Post pagination

- Reads return one Objective's posts in ascending sequence strictly after `afterSequence`,
  defaulting to the first page. See [posts and Objectives](#posts-and-objectives) for which
  Objective.
- The default page contains up to 50 posts; the maximum is 100.
- Read another page from the last returned sequence until a page is empty.
- Reading does not consume or acknowledge posts.

## Transports

`TagMailboxClient` uses HTTP by default, so existing applications and credential files keep
working. With `transport: "grpc"`, the same methods handle messages, Objectives, and Team channels
through the API Server's configured gRPC listener.

- Transport selection is explicit. A failed gRPC call does not fall back to HTTP.
- Credentials, message IDs, delivery leases, and permissions have the same meaning on both
  transports.
- Cancellation stops a pending receive. It does not acknowledge a message or undo handler effects.
- In a credential file, an optional `tlsCa` field contains the CA's PEM text, not its filename.
  Omit `tlsCa` when the host already trusts the certificate.
- Keep the credential file private with mode `0600`. Non-loopback connections require HTTPS.

### Open questions and blockers in the Objective overview

`supertag describe objective ID` groups unanswered `question` and `blocker` posts and
visible direct messages by Team. A post is open until any stored post in the same channel
and Objective names it with `replyTo`. A direct message is open until a stored message in
that Objective names it with `inReplyTo`. Processing or delivering an item does not answer it;
the reply's type and text do not affect this rule.

The view includes only the selected Objective. Direct messages must have both sender and
recipient among the Team's current members or lead, and satisfy Mailbox visibility rules.
Operator-authored messages are excluded. A message between members of multiple Teams can
appear under each Team. Unaddressed posts display `Team (unaddressed)`.

Each Team shows the newest 20 open posts and newest 20 open direct messages, with a notice
when more exist. Each entry includes sender, addressee, its post or message ID, and a
single-line body preview of at most 100 characters. Terminal controls are replaced before
truncation. Direct-message previews use `body.message` when it is text, otherwise the JSON
body. Use the Team channel and Mailbox history for full records. The JSON overview includes
these bounded records in each Team's `openCoordination` field.
