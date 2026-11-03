# Objectives (experimental)

An Objective is a durable outcome definition. Its response is described by
[`objective.schema.json`](objective.schema.json).

## Administrative HTTP API

All routes require API Server administrative authentication.

| Method | Path | Body or query | Response |
| --- | --- | --- | --- |
| POST | `/api/v1/tag-messaging/objectives` | `{id?, outcome, ownerTagId, deadline?, budgetLimitMinor?, budgetCurrency?, runtimeActions?, workspaces?}`, optional `dryRun=true` query | Objective with `warnings` |
| GET | `/api/v1/tag-messaging/objectives` | `tagId`, optional `limit` | `{items: Objective[]}` visible to that Tag |
| GET | `/api/v1/tag-messaging/objectives/:id` | none | Objective |
| PATCH | `/api/v1/tag-messaging/objectives/:id` | `{expectedRevision, status?, completionSummary?, budgetLimitMinor?, deadline?, notificationTaskId?, runtimeActions?}` | Objective; with `warnings` when `runtimeActions` is sent |

Omitted on creation, `runtimeActions` defaults to the actions the owner Tag's Permission Sets allow
through its active Roles, resolved once and stored. A creation or update list is intersected with
those actions; each dropped action, and an owner with none, produces a `warnings` entry. A creation
retry that omits `runtimeActions` returns the stored Objective.

## Tag-authenticated HTTP API

All routes use POST and a Tag mailbox bearer credential. Owner and viewer identities come
from that credential. Bodies reject unknown properties.

| Path | Body | Response |
| --- | --- | --- |
| `/internal/v1/mailbox/objectives/create` | `{id, outcome, deadline?, budgetLimitMinor?, budgetCurrency?}` | Objective owned by the caller |
| `/internal/v1/mailbox/objectives/list` | `{limit?}` | `{items: Objective[]}` |
| `/internal/v1/mailbox/objectives/:id/get` | `{}` | Objective |
| `/internal/v1/mailbox/objectives/:id/status` | `{status, expectedRevision, completionSummary?}` | Objective |

Tag-authenticated creation that names `workspaces` or `runtimeActions` returns 403. The Objective
gets the caller's own runtime actions from its active Roles. A status update that sends
`runtimeActions` returns 403.

## Collaboration-surface creation

A Tag serving a verified human `@SuperTag objective <outcome>` command creates the Objective with
the surface coordination tool `create_objective`. Its input is
`{outcome, deadline?, budgetLimitMinor?, budgetCurrency?, workspaces?}`. The Objective's
`runtimeActions` are the invoking Task's, composed from the Tag's Roles and the location's
Permission Set activations, and its Tasks keep that Task's runtime approval requirements. The Objective's
`workspaces` come from the Tag location, the route, the command arrived at:

1. The location's `workspaces`, when it lists any.
2. Otherwise, for a GitHub location, every Workspace whose `source` names the event's repository.
   https, ssh, and scp-style sources match with or without `.git`; owner and name compare
   case-insensitively.
3. Otherwise none.

An input `workspaces` must be a subset of that list and replaces it; any other name returns 400.
The response adds `warnings`, as administrative creation does.

Administrative creation may omit `id`; the Control Plane then generates one from the first three
words of the outcome and four random lowercase letters or digits, such as `ship-sso-for-7f3k`.
Administrative creation also returns `warnings`: sentences naming conditions that would hold the
Objective's Tasks, such as an owner Tag with no connected Worker Host. Creation still succeeds. With
`?dryRun=true` the request is validated exactly as creation, nothing is stored, and the response is
the would-be Objective with its `warnings` and `dryRun: true`.

Creation returns 200, including identical retries. Reusing an ID with a different outcome
statement or owner returns 409. The definition and owner are immutable in this version.
Owner must be active. IDs follow the mailbox ID validation rules and cannot be `.` or `..`. The
outcome is one natural-language statement of 1–8,000 trimmed characters.
`budgetLimitMinor` is a nonnegative organizational allocation. `budgetCurrency` is optional, valid
only with a limit, and must be an uppercase three-letter code. Currencyless allocations cannot be
combined with provider monetary ceilings. With a currency, the limit also caps provider-reported
cost across every Task Attempt in the Objective.

Only administrative requests may change `budgetLimitMinor` (increase only) or `deadline`. A new
`deadline` may replace one that already passed. Tag-authenticated status updates that include
either field return 403. The read-only `limitState` field records the Control Plane's budget and
deadline observations; see [coordination limits](../docs/reference/coordination.md#budgets-and-allocation).

Visibility is the Objective owner or a member of an active Team that serves the Objective.
Only the owner or administrator can update status. Each Team's channel, its
[Workstream](workstreams.md), is readable by the Team's members and the owner of the Team's
governing Objective.

Statuses are `working`, `blocked`, `ready_for_review`, and `completed`; all explicit transitions
are permitted. Updates use a positive integer `expectedRevision` and atomically increment it.
Stale revisions return 409. Completing requires a nonempty `completionSummary` (up to 16,000
characters). It is optional with `ready_for_review`, where it records the owner's assessment for an
operator to approve, and invalid on other statuses. Reopening clears the current summary. This is a
current-state record; status history, automatic evidence verification, scheduling, cascading
completion, and human approval workflows are application concerns.

`cancelled` is a fifth, terminal status that status updates cannot set; a status update that
names it returns 400. Only an administrative `POST /api/v1/objectives/{id}/cancel` with an
optional `{"reason": "..."}` (up to 2,000 characters) cancels an Objective. It records
`cancelledAt` and `cancellationReason`, cancels the Objective's open Tasks, fails its unclaimed
Mailbox messages, and records a processed notice in the owner's Mailbox. Cancelling a cancelled
Objective succeeds without changes; cancelling a completed one returns 409. A cancelled Objective
refuses every later status, deadline, budget, or notification update with 409.

Errors: 400 invalid payload, 401 invalid Tag credential, 403 non-owner status change,
404 missing/invisible Objective, 409 conflicting definition or revision. Lists default to
100 and allow 1–200, newest creation time then ID first. No pagination cursor yet.

Mailbox messages accept Objective references that name no stored Objective; operators can
explicitly create a matching Objective later.
