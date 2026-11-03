# Tag messaging HTTP protocol v1 (Experimental)

Mailboxes are logical inboxes attached to Tag identities. This protocol is independent of
Worklet transport 18; existing Workers and Task Attempt schemas are unchanged.
Custom implementations of the experimental `Store` interface must implement `TagMailboxStore`.

## Administrative endpoints

These require the API Server administrative bearer token:

| Method and path | Request | Response |
| --- | --- | --- |
| `POST /api/v1/tag-messaging/credentials` | `{ "tagId": "..." }` | 201: `{ id, tagId, createdAt, token }`; token returned once |
| `DELETE /api/v1/tag-messaging/credentials/:id` | None | 200 `{ "revoked": true }`, or 404 |
| `PUT /api/v1/tag-messaging/grants` | `{ senderTagId, recipientTagId, messageTypes }` | 200 `{ "ok": true }`; replaces the directional allowlist, empty list revokes |
| `GET /api/v1/tag-messaging/grants?tagId=...` | None | 200 `{ "items": [...] }`, inbound and outbound grants |
| `GET /api/v1/tag-messaging/messages?tagId=...&limit=100` | None | 200 `{ "items": [...] }`, recent inbound and outbound messages; limit 1–200 |
| `GET /api/v1/tag-messaging/history?tagId=...&limit=50` | Optional paired `beforeCreatedAt` and `beforeId` query parameters | 200 `{ items, nextCursor? }` |
| `POST /api/v1/tag-messaging/retention` | `{ before, limit? }` | 200 `{ pruned }`, terminal message bodies cleared |

These operation responses are not declaratively applied resources. No Mailbox resource is
created. Operator roles are presently Control Plane-wide. Token issuance is an explicit exception
to secret-free responses; all messaging responses use `Cache-Control: no-store`.

## Worker endpoints

All require `Authorization: Bearer <Tag-mailbox-token>`. The token identifies one active Tag;
there is no caller-provided sender or inbox selector. Tokens are opaque and revocable. Use
HTTPS outside loopback. Clients must not forward credentials through redirects.

When a harness executes the Task, the Worker may expose this credential-backed coordination surface
only to the harness's main manager. Native subagents use harness-local coordination and must not
receive the mailbox token or coordination binding and cannot invoke the surface. Harness capability
metadata states whether schema non-observation is hard or provider-guarded.

### Send

`POST /internal/v1/mailbox/send`:

```json
{
  "recipientTagId": "recipient-id",
  "objectiveId": "launch-2026-09",
  "type": "delegation.requested",
  "body": { "outcome": "Prepare launch messaging" },
  "idempotencyKey": "launch-marketing"
}
```

`inReplyTo` is optional. When supplied, it must refer to a message from this recipient to
this sender for the same objective. It never bypasses the directional messaging grant.
Message types are `delegation.requested`, `delegation.accepted`, `delegation.declined`,
`clarification.requested`, `progress.updated`, `result.submitted`, and
`cancellation.requested`, plus `priority.proposed`, `priority.accepted`, and
`priority.declined`. Delegation and priority responses require `inReplyTo` and must answer the
matching proposal type. Only one terminal accept/decline response is admitted per proposal.
Their names describe durable communication, not authority grants or automatic Objective transitions.
Use `result.submitted` or `progress.updated` for a clarification response.

Priority proposals must address a Team and reference a Task owned by that Team in the same
Objective. Their exact body is `{ taskId, priority, rationale }`, where priority is `urgent`,
`high`, `normal`, or `low` and rationale is a nonempty string of at most 2,000 characters.
Priority responses preserve `taskId` and `priority`, may add a bounded rationale, and must reply
to that proposal. An accepted priority is negotiation state only; it does not reorder, reserve,
interrupt, or cancel Task execution. A separate authorized scheduling operation must apply it.

Returns 201 `{ message, duplicate: false }`, or 200 `{ message, duplicate: true }` for an
identical retry. The idempotency key is scoped to the sender across all recipients. A key
cannot be reused for a different body, recipient, objective, type, or reply reference.
Identifiers are nonempty strings of at most 200 characters without whitespace or control
characters. Bodies must be JSON objects, at most 65,536 UTF-8 bytes when serialized. HTTP
requests are limited to 70,000 bytes. Unlike extensible response objects, command requests
reject unknown top-level fields to avoid silently accepting identity or policy overrides.

Admission is bounded to 100 `pending` plus `processing` messages per recipient across all
senders and Objectives. The check and insert are atomic across Control Plane instances. At capacity,
new sends return 429 and persist no message. Identical retries return the existing message even
at capacity; conflicting idempotency payloads still return 409. Moving a message to `processed`
or `failed` frees room; claiming a message does not. Senders should back off after 429. There is
no automatic eviction, and this queue bound does not impose a throughput or spending limit.

### History and body retention

`POST /internal/v1/mailbox/history` accepts `{ before?: {createdAt, id}, limit?: 50 }` and
returns `{ items: TagMessage[], nextCursor?: {createdAt, id} }`. Identity comes from the mailbox
credential. Both cursor fields are required together. `createdAt` must be a valid timestamp
and `id` follows message identifier rules; `limit` is an integer from 1–200. History is ordered
by descending creation time and ID, with the next page strictly before the cursor. Senders and
recipients can inspect their own records. The administrative endpoint selects the Tag explicitly.
The recent-message endpoint remains unchanged.

Messages carry a nullable `bodyPrunedAt`, and history and retention reads are indexed. The
administrator-only retention operation requires a timestamp `before`, compared
strictly against message `updatedAt`. Its `limit` defaults to 100 and accepts 1–1,000.
Only `processed` or `failed` messages without an outstanding lease and without a linked queued,
running, waiting, or submitted delegated Task are eligible. Pruning coordinates with Objective
state mutations and rechecks eligibility before updating. No automatic cleanup is scheduled.

Pruning sets `body` to `{}` and records `bodyPrunedAt`, retaining all identity, delivery, reply,
and idempotency metadata. Same-payload retries return the marked original message; the body is
not restored and no delivery is created. Fingerprints remain stored to reject conflicting retries.
This does not erase other copies or guarantee physical database-file reclamation.

### Receive

`POST /internal/v1/mailbox/receive` accepts `{ "waitMs": 20000, "leaseMs": 60000 }`.
Both fields are optional. `waitMs` defaults to 0 and ranges from 0–20,000 milliseconds;
`leaseMs` defaults to 60,000 and ranges from 5,000–300,000 milliseconds.

Returns 200 `{ "delivery": null }` when no message arrives, otherwise:

```json
{
  "delivery": {
    "message": { "id": "...", "senderTagId": "...", "recipientTagId": "...", "objectiveId": "...", "type": "delegation.requested", "body": {}, "idempotencyKey": "...", "status": "processing", "attemptCount": 1, "createdAt": "...", "updatedAt": "..." },
    "leaseToken": "opaque-claim-token",
    "leaseExpiresAt": "2026-09-05T00:01:00.000Z"
  }
}
```

Claims are exclusive per message, with up to five attempts. Expired claims are redeliverable.
The API Server rechecks credentials during long polling and polls shared storage, so messages
sent through another Control Plane instance are visible. The token that claims a delivery owns
its lease; another credential for the same Tag cannot settle that claim.

### Settle or renew

| Path (POST) | Body | Behavior |
| --- | --- | --- |
| `/internal/v1/mailbox/messages/:id/ack` | `{ leaseToken }` | Mark processed; repeat acknowledgement is idempotent |
| `/internal/v1/mailbox/messages/:id/release` | `{ leaseToken, retry?: false }` | Mark failed by default; `retry: true` makes it pending |
| `/internal/v1/mailbox/messages/:id/renew` | `{ leaseToken, leaseMs?: 60000 }` | Extend a live owned lease using Control Plane time |

Success returns 200 `{ "ok": true }`. These endpoints require the original claiming
credential. A stale, expired, wrong-recipient, or wrong-credential lease returns 409.
A revoked credential returns 401. Processing receipts do not confer execution authority.

Other errors: 400 invalid input or reply correlation, 401 invalid authentication, 403 no
messaging grant, 404 unknown active Tag or endpoint, 409 conflicting idempotency key,
413 oversized request, and 503 Control Plane draining. Messaging errors return an `error` code
and a bounded `message`; unexpected internal errors do not expose database details.

Message response fields are defined in [tag-message.schema.json](tag-message.schema.json).
Readers should preserve or ignore unknown response fields. A changed command discriminator
or required behavior needs a protocol revision. Timestamps are UTC ISO 8601 strings.

## Objective delivery ownership

An explicitly started Objective may consume eligible messages through the Objective runtime.
Admission atomically binds `TaskAssignment.sourceMessageId` to one message and marks delivery
processing. The executable Task has a `tag_message` trigger referencing that source message.
Custom receive/renew/settle calls cannot take over a Task-owned delivery, including after execution
lease expiry. Existing live custom delivery leases remain valid until settled or expired.

The message becomes processed when its coordination Task submits successfully, or failed after
terminal failure/cancellation. Execution recovery retains the original binding. Delivery receipts
are not assignment acceptance. Message bodies cannot provide sender identity, authorization,
human approval, or authoritative Task linkage. Runtime authority comes from the recipient's existing
assignment bounded by the current Objective, not the sender's body.

## Team-addressed coordination messages

The coordination tool `send_team_message` accepts `recipientTeamId`, `type`, `body`,
`idempotencyKey`, and optional `inReplyTo`. Its Objective comes from the active Attempt (or the
administrative request). The target Team must be active and linked to that Objective. The existing
directional sender-to-lead grant authorizes each new send. The stored message additionally exposes
`recipientTeamId`; `recipientTagId` records the lead resolved for delivery. Idempotency fingerprints
the Team address rather than its current lead.

Pending unadmitted messages follow leadership changes transactionally. An admitted message remains
owned by its delivery Task; Team updates reject leadership changes while message assignments remain
unfinished. Additional Objective links and dissolution cannot strand pending Team messages.
Generic mailbox claims exclude these messages. Started Objectives admit them through the same
bounded, durable coordination path as Tag messages, selecting the addressed Team explicitly.
Retrying an existing identical Team send does not require a new grant to a replacement lead; it
returns the existing message and creates no work. A new idempotency key requires a current grant.

When a Team-addressed `delegation.requested` message is admitted, its mailbox-delivery Task remains
an assessment responsibility rather than the requested business work. The handling Attempt must
send a correlated `delegation.accepted` reply before it can assign a child Task in the addressed
Team. A decline prevents that Attempt from creating the requested work. Administrative assignment
remains independent, and the normal Team, Objective, membership, budget, approval, and Attempt
authority checks still apply; a message response supplies none of them.

The durable request-to-commitment chain uses existing records: the delivery Task references the
request through `sourceMessageId`, its business Task references the delivery through `parentTaskId`,
and the response references the request through `inReplyTo`. `read_commitments` projects requested,
accepted, declined, or committed state from that chain without exposing the request body. Pending
Team requests follow leadership rerouting before admission; admitted deliveries retain their
existing execution owner.
