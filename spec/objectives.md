# Objectives (experimental)

An Objective is an outcome a Tag owns, with a budget, a deadline and a status. Its stored record is
described by [`objective.schema.json`](objective.schema.json). The behavior behind it is
in [Objective coordination](../docs/reference/coordination.md#objectives).

## Operator API

Operators create and manage Objectives with the `supertag.runtime.v2.Objectives` RPCs defined in
[`runtime.proto`](../rust/proto/supertag/runtime/v2/runtime.proto): `CreateObjective`,
`GetObjective`, `ListObjectives`, `ListCommitReviews`, `SetLimits`, `SetRuntimeActions`,
`PauseObjective`, `ResumeObjective`, `CancelObjective`, `ReviewObjective`, and
`CompleteObjective`. The proto comments are the reference for each request and response.

Creating an Objective starts it: the Control Plane admits the first turn of its conversation and
returns that Task's ID in `startedTaskId`. Starting is idempotent, so a retried creation returns
the same Task. A condition that prevents starting leaves the Objective created and explains itself
in `notStarted`. A dry run starts nothing.

`id` may be omitted. The Control Plane then generates one from the first three words of the
outcome and four random lowercase letters or digits, such as `ship-sso-for-7f3k`. IDs cannot be
`.` or `..`.

`owner` names the owner Tag. `team` names an existing Team, by name or ID. The Objective's owner
may start work Sessions of that Team's members, and the Team's Workstream is the one its turns post
to.

Omitted on creation, `runtimeActions` defaults to the actions the owner Tag's Permission Sets
allow through its active Roles, resolved once and stored. A creation or update list is
intersected with those actions; each dropped action, and an owner with none, produces a
`warnings` entry. A creation retry that omits `runtimeActions` returns the stored Objective.

`files:delegate-write` is a delegation grant. When the Objective and the delegating turn
both carry it, a different Team member with its own `files:write` permission can write in
the delegated Session. The grant does not give the owner `files:write`. Approval rules on
the grant and on the delegate's write action apply to the delegated write.

`warnings` also names conditions that would hold the Objective's turns, such as an owner Tag with
no connected Worker Host. Creation still succeeds. With `dryRun` the request is validated exactly
as creation is, nothing is stored, and the response is the would-be Objective with its
`warnings`.

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
The response adds `warnings`, as `CreateObjective` does.

## Definition and limits

Creation succeeds on identical retries too. Reusing an ID with a different outcome statement or
owner fails with `failed_precondition`. The outcome, owner, Workspaces and Team are fixed in this
version. The owner must be active. The outcome is one natural-language statement of 1 to 8,000
trimmed characters.

The budget's `limitMinor` is a nonnegative allocation. Its `currency` is optional and must be an
uppercase three-letter code. With a currency, the limit is the Objective's
budget pool: every turn of every Session beneath the Objective draws on it, and no new turn is
admitted once what remains falls below 5% of the limit.

Only administrative requests may change `budgetLimitMinor`, which can only increase, or
`deadline`, which may replace one that already passed. A Tag's status update that includes either
field is refused. The read-only `limitState` field records the Control Plane's budget and
deadline observations; see
[the budget pool](../docs/reference/coordination.md#the-budget-pool).

## Visibility and status

A Tag sees the Objectives it owns and those whose Team it belongs to. Only the owner or an
administrator changes the status.

Statuses are `working`, `blocked`, `limited`, `ready_for_review` and `completed`; all explicit
transitions are permitted, except that a `limited` Objective leaves that status only when the
same request raises the budget or moves the deadline. Updates use a positive integer
`expectedRevision` and atomically increment it. Stale revisions are refused. Completing requires a
nonempty `completionSummary` of up to 16,000 characters. It is optional with `ready_for_review`,
where it records the owner's assessment for an operator to approve, and invalid on other
statuses. Reopening clears the current summary. This is a current-state record; evidence
verification and human approval workflows are application concerns.

`cancelled` is a sixth, terminal status that status updates cannot set; a status update that
names it fails with `invalid_argument`. Only an operator's `CancelObjective`, with an optional
`reason` of up to 2,000 characters, cancels an Objective. It records `cancelledAt` and
`cancellationReason` and cancels every open Task in the Objective's Sessions. Cancelling a
cancelled Objective succeeds without changes; cancelling a completed one fails with
`failed_precondition`. A cancelled Objective refuses every later status, deadline or budget
update.

`PauseObjective` and `ResumeObjective` record and clear `pausedAt`. While it is set, no turn of
the Objective's Sessions starts. Both are idempotent and report `changed`.

Errors: `invalid_argument` for an invalid request, `unauthenticated` for an invalid credential,
`permission_denied` for a status the caller may not set, `not_found` for a missing or invisible
Objective, and `failed_precondition` for a conflicting definition or revision. Lists default to
100 records, newest creation time then ID first.
