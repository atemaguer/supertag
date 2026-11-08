# Objectives (experimental)

An Objective is an outcome a Tag owns, with a budget, a deadline and a status. Its response is
described by [`objective.schema.json`](objective.schema.json). The behavior behind these routes is
in [Objective coordination](../docs/reference/coordination.md#objectives).

## Administrative HTTP API

All routes require API Server administrative authentication.

| Method | Path | Body or query | Response |
| --- | --- | --- | --- |
| POST | `/api/v1/tag-messaging/objectives` | `{id?, outcome, ownerTagId, teamId?, deadline?, budgetLimitMinor?, budgetCurrency?, runtimeActions?, workspaces?, ongoing?}`, optional `dryRun=true` query | Objective with `warnings`, and `started` or `notStarted` |
| GET | `/api/v1/tag-messaging/objectives` | `tagId?`, `limit?`, `offset?` | `{items: Objective[]}` |
| GET | `/api/v1/tag-messaging/objectives/:id` | none | Objective |
| PATCH | `/api/v1/tag-messaging/objectives/:id` | `{expectedRevision, status?, completionSummary?, budgetLimitMinor?, deadline?, runtimeActions?}` | Objective; with `warnings` when `runtimeActions` is sent |

Creating an Objective starts it: the Control Plane admits the first turn of its conversation and
returns that Task's ID in `started`. Starting is idempotent, so a retried creation returns the
same Task. A condition that prevents starting leaves the Objective created and explains itself in
`notStarted`. A dry run starts nothing.

`id` may be omitted. The Control Plane then generates one from the first three words of the
outcome and four random lowercase letters or digits, such as `ship-sso-for-7f3k`. IDs cannot be
`.` or `..`.

`teamId` names an existing Team, by ID. The Objective's owner may start work Sessions of that
Team's members, and the Team's Workstream is the one its turns post to.

Omitted on creation, `runtimeActions` defaults to the actions the owner Tag's Permission Sets
allow through its active Roles, resolved once and stored. A creation or update list is
intersected with those actions; each dropped action, and an owner with none, produces a
`warnings` entry. A creation retry that omits `runtimeActions` returns the stored Objective.

`warnings` also names conditions that would hold the Objective's turns, such as an owner Tag with
no connected Worker Host. Creation still succeeds. With `?dryRun=true` the request is validated
exactly as creation is, nothing is stored, and the response is the would-be Objective with its
`warnings` and `dryRun: true`.

## Collaboration-surface creation

A Tag serving a verified human `@SuperTag objective <outcome>` command creates the Objective with
the coordination tool `create_objective`. Its input is
`{outcome, deadline?, budgetLimitMinor?, budgetCurrency?, workspaces?}`. The Objective's
`runtimeActions` are the invoking Task's, composed from the Tag's Roles and the location's
Permission Set activations, and its turns keep that Task's runtime approval requirements. Its
home thread is the thread the command arrived in. Its `workspaces` come from the Tag location the
command arrived at:

1. the location's `workspaces`, when it lists any;
2. otherwise, for a GitHub location, every Workspace whose `source` names the event's repository.
   https, ssh, and scp-style sources match with or without `.git`; owner and name compare
   case-insensitively;
3. otherwise none.

An input `workspaces` must be a subset of that list and replaces it; any other name returns 400.
The response adds `warnings`, as administrative creation does.

## Definition and limits

Creation returns 200, including on identical retries. Reusing an ID with a different outcome
statement or owner returns 409. The outcome, owner, Workspaces and Team are fixed in this
version. The owner must be active. The outcome is one natural-language statement of 1 to 8,000
trimmed characters.

`budgetLimitMinor` is a nonnegative allocation. `budgetCurrency` is optional, valid only with a
limit, and must be an uppercase three-letter code. With a currency, the limit is the Objective's
budget pool: every turn of every Session beneath the Objective draws on it, and no new turn is
admitted once what remains falls below 5% of the limit.

Only administrative requests may change `budgetLimitMinor`, which can only increase, or
`deadline`, which may replace one that already passed. A Tag's status update that includes either
field returns 403. The read-only `limitState` field records the Control Plane's budget and
deadline observations; see
[the budget pool](../docs/reference/coordination.md#the-budget-pool).

## Visibility and status

A Tag sees the Objectives it owns and those whose Team it belongs to. Only the owner or an
administrator changes the status.

Statuses are `working`, `blocked`, `limited`, `ready_for_review` and `completed`; all explicit
transitions are permitted, except that a `limited` Objective leaves that status only when the
same request raises the budget or moves the deadline. Updates use a positive integer
`expectedRevision` and atomically increment it. Stale revisions return 409. Completing requires a
nonempty `completionSummary` of up to 16,000 characters. It is optional with `ready_for_review`,
where it records the owner's assessment for an operator to approve, and invalid on other
statuses. Reopening clears the current summary. This is a current-state record; evidence
verification and human approval workflows are application concerns.

`cancelled` is a sixth, terminal status that status updates cannot set; a status update that
names it returns 400. Only an administrative `POST /api/v1/objectives/{id}/cancel`, with an
optional `{"reason": "..."}` of up to 2,000 characters, cancels an Objective. It records
`cancelledAt` and `cancellationReason` and cancels every open Task in the Objective's Sessions.
Cancelling a cancelled Objective succeeds without changes; cancelling a completed one returns
409. A cancelled Objective refuses every later status, deadline or budget update with 409.

`POST /api/v1/objectives/{id}/pause` and `/resume` record and clear `pausedAt`. While it is set,
no turn of the Objective's Sessions starts. Both are idempotent and report `changed`.

Errors: 400 invalid payload, 401 invalid credential, 403 a status change by a Tag that is not the
owner, 404 a missing or invisible Objective, 409 a conflicting definition or revision. Lists
default to 100 records, newest creation time then ID first.
