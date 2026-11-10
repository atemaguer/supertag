# ObjectiveService

<!-- Generated from spec/proto/supertag/operator/v1 by scripts/protoc-gen-operator-docs.mjs. Edit the proto comments, not this file. -->

`supertag.operator.v1.ObjectiveService` in [`objective.proto`](../../../spec/proto/supertag/operator/v1/objective.proto). How to call an RPC, authenticate, and
read its errors is in the [Control Plane API Server](../control-plane-api.md) guide; the conventions every
RPC follows are in [Shared messages and options](shared.md#conventions).

An operator's Objectives: `supertag create objective`, `list objective`,
`get objective`, `describe objective`, `watch objective`, `approve objective`,
`update objective`, `complete objective`,
`cancel objective`, `pause objective` and `resume objective`.

An Objective is an outcome its owner Tag works toward in a conversation of
its own, with a budget, a deadline, and a status. The owner may hand work to
work Sessions of its Team's members. The terminal UI and automation send
follow-ups through `MessageObjective`. Applying an `Objective` manifest is
`ResourceService`'s.

Access. The admin token and Operator Tokens may call every RPC. An RPC that
sets `(supertag.operator.v1.allow_scoped_credential)` also accepts a scoped
coordination credential that carries the RPC's action, for the Objectives
its scope names only: any other Objective fails with `PermissionDenied`.

Every RPC that names an Objective fails with `InvalidArgument` for an empty
`id` and `NotFound` for an Objective that does not exist. A call while the
Control Plane drains fails with `Unavailable` and `ERROR_REASON_DRAINING`.
A refusal because of the Objective's state,
such as a stale revision or a cancelled Objective, is `FailedPrecondition`
with `ERROR_REASON_CONFLICT`, and the message says why.

## RPCs

### CreateObjective

| | |
| --- | --- |
| Procedure | `/supertag.operator.v1.ObjectiveService/CreateObjective` |
| Request | [`CreateObjectiveRequest`](#createobjectiverequest) |
| Response | [`CreateObjectiveResponse`](#createobjectiveresponse) |
| Action | `create_objective` |
| Callers | The admin token and Operator Tokens |
| Audit log | `objective.create` |

Creates an Objective and starts it: the owner takes its first turn.

Repeating the call with the same `id` and definition returns the same
Objective and starts nothing new, so a create that could not start the
Objective, such as for an owner without a connected Worker Host, starts it
when repeated once that is fixed. The same `id` with a different
definition fails with `FailedPrecondition`.

`warnings` names each condition that would hold the Objective's turns or
limit what they may do; creation still succeeds. With `dry_run` the call
checks and warns exactly as a create does, returns the Objective it would
create, and stores and starts nothing.

It fails with `InvalidArgument` for an empty outcome, a malformed `id`,
deadline, budget, runtime action or Workspace name, and `NotFound` for an
owner Tag, Team or Workspace that does not exist.

### ListObjectives

| | |
| --- | --- |
| Procedure | `/supertag.operator.v1.ObjectiveService/ListObjectives` |
| Request | [`ListObjectivesRequest`](#listobjectivesrequest) |
| Response | [`ListObjectivesResponse`](#listobjectivesresponse) |
| Action | `list_objectives` |
| Callers | The admin token and Operator Tokens |
| Audit log | Nothing; reads only |

Lists Objectives, the most recently created first. It fails with
`NotFound` when `owner` names a Tag that does not exist.

### GetObjective

| | |
| --- | --- |
| Procedure | `/supertag.operator.v1.ObjectiveService/GetObjective` |
| Request | [`GetObjectiveRequest`](#getobjectiverequest) |
| Response | [`Objective`](#objective) |
| Action | `read_objective` |
| Callers | The admin token, Operator Tokens, and scoped coordination credentials |
| Audit log | Nothing; reads only |

Reads one Objective.

### DescribeObjective

| | |
| --- | --- |
| Procedure | `/supertag.operator.v1.ObjectiveService/DescribeObjective` |
| Request | [`DescribeObjectiveRequest`](#describeobjectiverequest) |
| Response | [`ObjectiveOverview`](#objectiveoverview) |
| Action | `read_objective` |
| Callers | The admin token, Operator Tokens, and scoped coordination credentials |
| Audit log | Nothing; reads only |

Reads the operator's view of an Objective, as `supertag describe
objective` shows it: whether it can run, what needs the operator, spend
against its budget, its conversation, each of its Sessions with the Tag
running it and its latest Task's delivery and report, and one page of its
Tasks. The view is observed records, not a transactional snapshot: reread
the Objective before changing it and pass its `revision`.

`page_size` and `page_token` page through `tasks` only; every other field
is whole on every page.

### MessageObjective

| | |
| --- | --- |
| Procedure | `/supertag.operator.v1.ObjectiveService/MessageObjective` |
| Request | [`MessageObjectiveRequest`](#messageobjectiverequest) |
| Response | [`MessageObjectiveResponse`](#messageobjectiveresponse) |
| Action | `message_objective` |
| Callers | The admin token, Operator Tokens, and scoped coordination credentials |
| Audit log | `objective.message` |

Sends a message to the Objective's conversation as its owner's next turn.
A message answers a question the owner asked, and moves a `blocked`,
`limited` or `ready_for_review` Objective back to `working`.

The owner's reply goes to the Objective's home thread. When that is one
of the caller's conversations, as for an Objective created from the CLI,
follow it with `ConversationService.FollowMessage` with `tag` and
`task_id` from the response.

It fails with `InvalidArgument` for empty text, and `FailedPrecondition`
for a completed or cancelled Objective.

### UpdateObjective

| | |
| --- | --- |
| Procedure | `/supertag.operator.v1.ObjectiveService/UpdateObjective` |
| Request | [`UpdateObjectiveRequest`](#updateobjectiverequest) |
| Response | [`UpdateObjectiveResponse`](#updateobjectiveresponse) |
| Action | `update_objective` |
| Callers | The admin token and Operator Tokens |
| Audit log | `objective.update` |

Changes an Objective's status, deadline, budget or runtime actions. Set at
least one of them, and `expected_revision` to the revision read last.

- `status` sets `working`, `blocked`, `ready_for_review` or `completed`.
  `OBJECTIVE_STATUS_COMPLETED` needs `completion_summary`, as `supertag
  complete objective` sends it. `OBJECTIVE_STATUS_CANCELLED` fails with
  `InvalidArgument`: only `CancelObjective` cancels. Only the owner sets
  `OBJECTIVE_STATUS_LIMITED`, so it fails with `PermissionDenied`.
- `deadline` moves the deadline, including after it passed, but not on a
  completed Objective.
- `budget_limit_minor` raises the budget above its current limit, on an
  Objective that has a budget and is not completed.
- `runtime_actions` replaces the runtime actions for turns that start
  afterwards. Actions the owner Tag's Permission Sets do not allow are
  dropped, each with a warning.

It fails with `InvalidArgument` for a request that sets nothing or sets a
malformed value, and `FailedPrecondition` when `expected_revision` is not
the Objective's revision, when the Objective is cancelled, and when it
refuses the deadline or budget change.

### ApproveObjective

| | |
| --- | --- |
| Procedure | `/supertag.operator.v1.ObjectiveService/ApproveObjective` |
| Request | [`ApproveObjectiveRequest`](#approveobjectiverequest) |
| Response | [`Objective`](#objective) |
| Action | `update_objective` |
| Callers | The admin token, Operator Tokens, and scoped coordination credentials |
| Audit log | `objective.approve` |

Completes an Objective its owner submitted for review: its status
becomes `completed`, and the owner's assessment becomes the completion
summary. It fails with `FailedPrecondition` unless the Objective is
`ready_for_review`.

### CancelObjective

| | |
| --- | --- |
| Procedure | `/supertag.operator.v1.ObjectiveService/CancelObjective` |
| Request | [`CancelObjectiveRequest`](#cancelobjectiverequest) |
| Response | [`CancelObjectiveResponse`](#cancelobjectiveresponse) |
| Action | `cancel_objective` |
| Callers | The admin token and Operator Tokens |
| Audit log | `objective.cancel` |

Cancels an Objective for good: its open Tasks are cancelled and nothing
new starts. Cancelling a cancelled Objective changes nothing, except that
it cancels any Task an earlier call left open, and succeeds with
`changed` false. It fails with `FailedPrecondition` for a completed
Objective.

### PauseObjective

| | |
| --- | --- |
| Procedure | `/supertag.operator.v1.ObjectiveService/PauseObjective` |
| Request | [`PauseObjectiveRequest`](#pauseobjectiverequest) |
| Response | [`PauseObjectiveResponse`](#pauseobjectiveresponse) |
| Action | `update_objective` |
| Callers | The admin token and Operator Tokens |
| Audit log | `objective.pause` |

Pauses an Objective: no new turn of its Sessions starts, running Task
Attempts finish, and messages and reports wait. Pausing a paused
Objective succeeds with `changed` false. It fails with
`FailedPrecondition` for a completed or cancelled Objective.

### ResumeObjective

| | |
| --- | --- |
| Procedure | `/supertag.operator.v1.ObjectiveService/ResumeObjective` |
| Request | [`ResumeObjectiveRequest`](#resumeobjectiverequest) |
| Response | [`ResumeObjectiveResponse`](#resumeobjectiveresponse) |
| Action | `update_objective` |
| Callers | The admin token and Operator Tokens |
| Audit log | `objective.resume` |

Resumes a paused Objective: work starts again, and the owner receives a
summary of what changed while it was paused as its next turn. Resuming an
Objective that is not paused succeeds with `changed` false.

## Messages

### CreateObjectiveRequest

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `id` | `id` | `string` | The Objective's ID: 1 to 200 characters without whitespace or control characters, other than `.` and `..`. Empty generates one from the outcome's first words, such as `ship-sso-7f3k`. |
| `outcome` | `outcome` | `string` | The outcome, as one statement: the result, how success is verified, what must not change, and when to ask a person. Must not be empty. |
| `owner` | `owner` | `string` | The owner Tag's name. |
| `team` | `team` | `string` | The name or ID of the Team whose members the owner may hand work to. Empty: the owner works alone. |
| `deadline` | `deadline` | `google.protobuf.Timestamp` | When the Objective is due. Unset: no deadline. |
| `budget` | `budget` | [`Budget`](#budget) | The budget for the owner and all the work it starts. Unset: no budget. |
| `runtime_actions` | `runtimeActions` | repeated `string` | Runtime actions, such as `files:write`, that the Objective's Tasks may receive. Empty: those the owner Tag's Permission Sets allow, recorded at creation. A list narrows them; actions the owner lacks are dropped, each with a warning. |
| `workspaces` | `workspaces` | repeated `string` | Names of Workspaces the Objective's work may use. Each must exist. |
| `ongoing` | `ongoing` | `bool` | A responsibility that only an operator ends: the owner never completes it on its own. |
| `dry_run` | `dryRun` | `bool` | Check and warn without creating or starting anything. |

### CreateObjectiveResponse

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `objective` | `objective` | [`Objective`](#objective) | The Objective, or with `dry_run` the Objective the call would create. |
| `warnings` | `warnings` | repeated `string` | Each condition that would hold the Objective's turns or limit what they may do, in one sentence, such as an owner Tag with no connected Worker Host or a runtime action the owner lacks. |
| `started_task_id` | `startedTaskId` | `string` | The Task of the owner's first turn, when this call or an earlier one started the Objective. Empty with `dry_run`, for a completed or cancelled Objective, and when the Objective could not be started. |
| `not_started` | `notStarted` | `string` | Why the Objective could not be started, in one sentence, when it could not. Repeat the call with the Objective's `id` once that is fixed. |

### ListObjectivesRequest

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `owner` | `owner` | `string` | Lists only Objectives this Tag owns, by name. Empty lists every Tag's. |
| `page_size` | `pageSize` | `int32` | At most this many Objectives; 0 means 100, and more than 200 means 200. |
| `page_token` | `pageToken` | `string` | The `next_page_token` of the previous page. |

### ListObjectivesResponse

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `objectives` | `objectives` | repeated [`Objective`](#objective) | The Objectives, the most recently created first. |
| `next_page_token` | `nextPageToken` | `string` | Fetches the next page. Empty on the last page. |

### GetObjectiveRequest

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `id` | `id` | `string` | The Objective's ID. |

### DescribeObjectiveRequest

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `id` | `id` | `string` | The Objective's ID. |
| `page_size` | `pageSize` | `int32` | At most this many `tasks`; 0 means 50, and more than 100 means 100. |
| `page_token` | `pageToken` | `string` | The `next_page_token` of the previous page. |

### MessageObjectiveRequest

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `id` | `id` | `string` | The Objective's ID. |
| `text` | `text` | `string` | The message. Leading and trailing whitespace is removed, and what remains must not be empty. |
| `idempotency_key` | `idempotencyKey` | `string` | Makes a retry safe. A repeat with the same key to the same Objective returns the turn the first call started, with `duplicate` true, and sends nothing. A key is 1 to 200 characters without whitespace or control characters. Empty sends every call. |

### MessageObjectiveResponse

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `task_id` | `taskId` | `string` | The Task of the turn the message started, or of the turn an earlier call with the same `idempotency_key` started. |
| `tag` | `tag` | `string` | The owner Tag's name, for `ConversationService.FollowMessage`. |
| `duplicate` | `duplicate` | `bool` | The message repeated an earlier one with the same `idempotency_key`, and nothing was sent. |
| `status_change` | `statusChange` | [`ObjectiveStatus`](#objectivestatus) | The status the message moved the Objective out of, back to `working`. `OBJECTIVE_STATUS_UNSPECIFIED` when the status did not change. |

### UpdateObjectiveRequest

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `id` | `id` | `string` | The Objective's ID. |
| `expected_revision` | `expectedRevision` | `int64` | The Objective's `revision` as the caller read it, from 1. The update applies only while it is still the Objective's revision. |
| `status` | `status` | optional [`ObjectiveStatus`](#objectivestatus) | The new status. Unset leaves the status. |
| `completion_summary` | `completionSummary` | optional `string` | The assessment of the outcome and its supporting results. Required with `OBJECTIVE_STATUS_COMPLETED`, and optional with `OBJECTIVE_STATUS_READY_FOR_REVIEW`. Leading and trailing whitespace is removed. |
| `deadline` | `deadline` | `google.protobuf.Timestamp` | The new deadline. Unset leaves the deadline. |
| `budget_limit_minor` | `budgetLimitMinor` | optional `int64` | The new budget limit in the budget's unit: minor units of its currency, or allocation units for a budget without one. It must be above the current limit. Unset leaves the budget. |
| `runtime_actions` | `runtimeActions` | [`RuntimeActions`](#runtimeactions) | The runtime actions that replace the current ones. Unset leaves them. |

### RuntimeActions

A list of runtime actions, such as `files:write`.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `actions` | `actions` | repeated `string` | The actions, at most 50. |

### UpdateObjectiveResponse

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `objective` | `objective` | [`Objective`](#objective) | The Objective after the change, with its new `revision`. |
| `warnings` | `warnings` | repeated `string` | Each runtime action dropped because the owner Tag's Permission Sets do not allow it, in one sentence. |

### ApproveObjectiveRequest

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `id` | `id` | `string` | The Objective's ID. |

### CancelObjectiveRequest

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `id` | `id` | `string` | The Objective's ID. |
| `reason` | `reason` | `string` | Why the operator cancels it, recorded on the Objective and sent to its owner. Empty gives no reason. |

### CancelObjectiveResponse

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `objective` | `objective` | [`Objective`](#objective) | The Objective, now `cancelled`. |
| `changed` | `changed` | `bool` | False when the Objective was already cancelled. |
| `cancelled_task_ids` | `cancelledTaskIds` | repeated `string` | The open Tasks this call cancelled. |

### PauseObjectiveRequest

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `id` | `id` | `string` | The Objective's ID. |

### PauseObjectiveResponse

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `objective` | `objective` | [`Objective`](#objective) | The Objective, with `paused_at` set. |
| `changed` | `changed` | `bool` | False when the Objective was already paused. |

### ResumeObjectiveRequest

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `id` | `id` | `string` | The Objective's ID. |

### ResumeObjectiveResponse

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `objective` | `objective` | [`Objective`](#objective) | The Objective, with `paused_at` unset. |
| `changed` | `changed` | `bool` | False when the Objective was not paused. |
| `summary` | `summary` | `string` | What the owner was told changed while the Objective was paused. Empty when `changed` is false or the Objective is completed or cancelled. |

### Budget

A budget: provider-reported cost in a currency, or allocation units.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `limit_minor` | `limitMinor` | `int64` | The limit, in minor units of `currency`, or in allocation units when `currency` is empty. |
| `currency` | `currency` | `string` | The ISO 4217 code, such as `USD`. Empty keeps the budget in allocation units, which provider-reported cost does not count against. |

### Objective

One Objective.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `id` | `id` | `string` | The Objective's ID. |
| `outcome` | `outcome` | `string` | The outcome statement. |
| `owner_tag_id` | `ownerTagId` | `string` | The owner Tag's ID. |
| `owner_tag` | `ownerTag` | `string` | The owner Tag's name. Empty when the Tag no longer exists. |
| `status` | `status` | [`ObjectiveStatus`](#objectivestatus) | Where the Objective stands. |
| `revision` | `revision` | `int64` | Increases with every change. Pass it as `expected_revision`. |
| `ongoing` | `ongoing` | `bool` | A responsibility that only an operator ends. |
| `deadline` | `deadline` | `google.protobuf.Timestamp` | When it is due. Unset without a deadline. |
| `budget` | `budget` | [`Budget`](#budget) | Its budget. Unset without one. |
| `spend` | `spend` | [`ObjectiveSpend`](#objectivespend) | Provider-reported spend against a budget in a currency, as last observed. Unset without such a budget. |
| `runtime_actions` | `runtimeActions` | repeated `string` | The runtime actions its Tasks may receive. |
| `workspaces` | `workspaces` | repeated `string` | The Workspaces its work may use. |
| `team_id` | `teamId` | `string` | The ID of the Team whose members the owner may hand work to. Empty when the owner works alone. |
| `completion_summary` | `completionSummary` | `string` | The owner's assessment of the outcome: the result once completed, or what the owner submitted for review. |
| `limit_summary` | `limitSummary` | [`LimitSummary`](#limitsummary) | The owner's account of progress, open work, blockers and the next step, written when the Objective reached a limit. Unset until then. |
| `execution_started_at` | `executionStartedAt` | `google.protobuf.Timestamp` | When it started: its first turn was admitted. Unset until then. |
| `paused_at` | `pausedAt` | `google.protobuf.Timestamp` | When an operator paused it. Unset while it runs. |
| `cancelled_at` | `cancelledAt` | `google.protobuf.Timestamp` | When an operator cancelled it. Unset otherwise. |
| `cancellation_reason` | `cancellationReason` | `string` | The operator's reason for cancelling it, when one was given. |
| `surface_task_id` | `surfaceTaskId` | `string` | The collaboration surface Task it was created from, such as a Slack message. Empty for an Objective created through this API or a manifest. |
| `notification_task_id` | `notificationTaskId` | `string` | The surface Task an operator chose as its home thread, where the owner's replies post, in place of the thread it was created in. Empty otherwise. |
| `created_at` | `createdAt` | `google.protobuf.Timestamp` | When it was created. |
| `updated_at` | `updatedAt` | `google.protobuf.Timestamp` | When it last changed. |

### ObjectiveSpend

Provider-reported spend against an Objective's budget.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `amount_minor` | `amountMinor` | `int64` | The provider-reported cost of every Task of the Objective's Sessions, in minor units of the budget's currency. |
| `currency` | `currency` | `string` | The budget's ISO 4217 code. |
| `unknown_cost_attempts` | `unknownCostAttempts` | `int32` | Executed Task Attempts that reported no cost. They are not counted as zero, so actual spend may be higher. |
| `estimated_cost_attempts` | `estimatedCostAttempts` | `int32` | Task Attempts whose cost comes from a model price estimate. |
| `observed_at` | `observedAt` | `google.protobuf.Timestamp` | When the spend was last observed. |

### LimitSummary

The owner's summary at a limit.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `text` | `text` | `string` | The summary. The Tag wrote it, so it is untrusted text. |
| `written_at` | `writtenAt` | `google.protobuf.Timestamp` | When it was written. |

### ObjectiveOverview

The operator's view of one Objective. See `DescribeObjective`.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `captured_at` | `capturedAt` | `google.protobuf.Timestamp` | When the Control Plane read the records. |
| `objective` | `objective` | [`Objective`](#objective) | The Objective. |
| `execution_readiness` | `executionReadiness` | `string` | Whether the Control Plane can execute Objectives now: `ready`, `awaiting-coordination` until it knows the address Tasks coordinate through, or `awaiting-worklet` until its Worklet service is attached. |
| `conditions` | `conditions` | repeated [`ObjectiveCondition`](#objectivecondition) | Whether the Objective's turns can run now. A completed or cancelled Objective runs nothing more, whatever they say. |
| `attention` | `attention` | repeated [`ObjectiveAttention`](#objectiveattention) | What the operator should look at, each with the next step. |
| `approvals` | `approvals` | [`ApprovalCounts`](#approvalcounts) | The Objective's approval requests: pending, and decided in the last day. |
| `tag_names` | `tagNames` | map of `string` to `string` | Display names of the Tags this view names by ID, keyed by Tag ID. A Tag that no longer exists has no entry. |
| `team` | `team` | [`ObjectiveTeam`](#objectiveteam) | The Team whose members the owner may hand work to. Unset when the owner works alone. |
| `limits` | `limits` | [`ObjectiveLimits`](#objectivelimits) | The deadline and the budget, with the notices each raised. |
| `budget` | `budget` | [`ObjectiveBudgetUse`](#objectivebudgetuse) | Spend against the budget and the usage behind it. |
| `conversation` | `conversation` | repeated [`ObjectiveConversationEntry`](#objectiveconversationentry) | The newest turns of the Objective's own conversation, at most 25 Tasks' worth, oldest first. |
| `sessions` | `sessions` | repeated [`ObjectiveSession`](#objectivesession) | Every Session of the Objective: its own conversation first, then work Sessions, oldest first. |
| `high_findings` | `highFindings` | repeated [`HighFinding`](#highfinding) | High-severity findings in the latest result of each Session. |
| `posts` | `posts` | repeated [`WorkstreamPost`](team.md#workstreampost) | The Team's newest Workstream posts, at most 50, oldest first. Empty without a Team. |
| `writes` | `writes` | repeated [`VolumeWrites`](#volumewrites) | What the Objective's Task Attempts wrote to each Volume, by Volume name. |
| `tasks` | `tasks` | repeated [`ObjectiveTask`](#objectivetask) | One page of the Tasks of every Session, oldest first within each Session, the Objective's own Session first. |
| `total_tasks` | `totalTasks` | `int32` | How many Tasks all pages hold. |
| `next_page_token` | `nextPageToken` | `string` | Fetches the next page of `tasks`. Empty on the last page. |
| `commit_reviews` | `commitReviews` | repeated [`ObjectiveCommitReview`](#objectivecommitreview) | The 50 newest commit review requests and their recorded verdicts, newest first. |

### ObjectiveCommitReview

A review request tied to one delivered Git commit of the Objective.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `request_id` | `requestId` | `string` | The request's Mailbox message ID. |
| `commit` | `commit` | `string` | Full Git commit hash. |
| `reviewer_tag_id` | `reviewerTagId` | `string` | The Tag asked to review the commit. |
| `verdict` | `verdict` | `string` | Empty while pending, otherwise approved or changes_requested. |
| `summary` | `summary` | `string` | The reviewer's evidence. Treat it as untrusted text. |
| `recorded_at` | `recordedAt` | `google.protobuf.Timestamp` | When the reviewer recorded the verdict. |

### ObjectiveCondition

A condition on an Objective, such as whether its turns can run.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `type` | `type` | `string` | The condition: `Runnable`. |
| `status` | `status` | `bool` | Whether it holds. |
| `reasons` | `reasons` | repeated `string` | Why it does not, each in one sentence with the step that clears it. Empty when it holds. |

### ObjectiveAttention

One thing about an Objective that needs a look, with the next step.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `kind` | `kind` | [`ObjectiveAttentionKind`](#objectiveattentionkind) | What it is. |
| `message` | `message` | `string` | What is the matter, in one or two sentences. |
| `next_action` | `nextAction` | `string` | What to do about it, usually naming a `supertag` command. |
| `observed_at` | `observedAt` | `google.protobuf.Timestamp` | When it was observed. Unset when the Control Plane recorded no time. |

### ApprovalCounts

How many approval requests an Objective has, by state.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `pending` | `pending` | `int32` | Waiting for a decision. |
| `approved_last_day` | `approvedLastDay` | `int32` | Approved in the last 24 hours. |
| `denied_last_day` | `deniedLastDay` | `int32` | Denied in the last 24 hours. |

### ObjectiveTeam

The Team an Objective's owner may hand work to.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `id` | `id` | `string` | The Team's ID. |
| `name` | `name` | `string` | The Team's name. |
| `member_tag_ids` | `memberTagIds` | repeated `string` | The IDs of its member Tags. |
| `max_concurrency` | `maxConcurrency` | optional `int32` | At most this many turns run at once across the Team's Objectives. Unset: only Worker Host capacity limits them. |

### ObjectiveLimits

An Objective's deadline and budget.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `deadline` | `deadline` | [`DeadlineLimit`](#deadlinelimit) | The deadline. Unset without one. |
| `budget` | `budget` | [`BudgetLimit`](#budgetlimit) | The budget. Unset without one. |

### DeadlineLimit

Where an Objective stands against its deadline.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `at` | `at` | `google.protobuf.Timestamp` | The deadline. |
| `minutes_remaining` | `minutesRemaining` | `int32` | Whole minutes until it; 0 once it passed. |
| `remaining` | `remaining` | `string` | The time left in words, such as `about 3 hours left`, or `passed`. |
| `passed` | `passed` | `bool` | Whether it passed. |
| `grace_minutes` | `graceMinutes` | `int32` | How long running Task Attempts keep their authority after it, in minutes. |
| `notices` | `notices` | repeated [`LimitNotice`](#limitnotice) | The notices already raised for this deadline, newest last. |
| `guidance` | `guidance` | `string` | What happens at the deadline, in a few sentences. |

### LimitNotice

A notice the Control Plane raised about a limit.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `kind` | `kind` | `string` | What it is about, such as `objective_deadline_approaching` or `deadline_passed`. Clients show `message` and do not parse it. |
| `at` | `at` | `google.protobuf.Timestamp` | When it was raised. |
| `message` | `message` | `string` | The notice, as the owner received it. |

### BudgetLimit

Where an Objective stands against its budget.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `measure` | `measure` | [`BudgetMeasure`](#budgetmeasure) | How the budget is measured. |
| `limit` | `limit` | [`Budget`](#budget) | The limit and its currency. `currency` is empty when `measure` is `BUDGET_MEASURE_UNMEASURED`. |
| `reported_spent_minor` | `reportedSpentMinor` | optional `int64` | Provider-reported spend, in minor units of the currency. Unset when nothing was observed yet or the budget is unmeasured. |
| `overrun_minor` | `overrunMinor` | `int64` | How far reported spend is over the limit; 0 when it is not. |
| `reported_spend_observed_at` | `reportedSpendObservedAt` | `google.protobuf.Timestamp` | When spend was last observed. Unset when it never was. |
| `unknown_cost_attempts` | `unknownCostAttempts` | `int32` | Executed Task Attempts that reported no cost. |
| `exhausted` | `exhausted` | `bool` | Whether the budget is used up, so new turns are refused. |
| `guidance` | `guidance` | `string` | How the budget is enforced, in a few sentences. |

### ObjectiveBudgetUse

Spend against an Objective's budget, and the usage behind it.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `currency` | `currency` | `string` | The budget's ISO 4217 code. Empty for a budget in allocation units and for an Objective without a budget. |
| `limit_minor` | `limitMinor` | optional `int64` | The budget limit. Unset without a budget. |
| `spent_minor` | `spentMinor` | optional `int64` | Provider-reported spend counted against the budget, in minor units of `currency`. Unset when `currency` is empty: spend is not counted in allocation units. |
| `available_minor` | `availableMinor` | optional `int64` | What is left: `limit_minor` minus `spent_minor`, negative once over. Unset when either is unset. |
| `attempts` | `attempts` | `int32` | Executed Task Attempts of every Task of the Objective's Sessions. |
| `reported_cost_by_currency` | `reportedCostByCurrency` | map of `string` to `int64` | Their provider-reported cost by ISO 4217 code, in minor units. Separate currencies are never combined. Empty when no Task Attempt reported cost. |
| `unknown_cost_attempts` | `unknownCostAttempts` | `int32` | Task Attempts that reported no cost. |
| `estimated_cost_attempts` | `estimatedCostAttempts` | `int32` | Task Attempts whose cost comes from a model price estimate. |
| `unpriced_models` | `unpricedModels` | map of `string` to `int32` | Task Attempts that reported tokens for a model the Harness has no price for, by model. The budget cannot count them. |
| `unpriced_tokens` | `unpricedTokens` | `int64` | Tokens those Task Attempts reported. |
| `reported_tokens` | `reportedTokens` | optional `int64` | Tokens every Task Attempt reported. Unset when none reported tokens. |
| `unknown_token_attempts` | `unknownTokenAttempts` | `int32` | Task Attempts that reported no tokens. |

### ObjectiveConversationEntry

One entry of an Objective's own conversation.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `task_id` | `taskId` | `string` | The Task of the turn. |
| `author` | `author` | [`ObjectiveConversationAuthor`](#objectiveconversationauthor) | Who wrote it. |
| `operator_id` | `operatorId` | `string` | The operator who wrote it, when `author` is `OBJECTIVE_CONVERSATION_AUTHOR_OPERATOR`. |
| `text` | `text` | `string` | The text. An owner's reply is untrusted text. |
| `created_at` | `createdAt` | `google.protobuf.Timestamp` | When it was written. |

### ObjectiveSession

One Session of an Objective: its own conversation, where the owner works,
or a work Session started under it.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `id` | `id` | `string` | The Session's ID. |
| `tag_id` | `tagId` | `string` | The ID of the Tag running it. |
| `tag` | `tag` | `string` | The name of the Tag running it. Empty when the Tag no longer exists. |
| `owner` | `owner` | `bool` | Whether it is the Objective's own conversation. |
| `title` | `title` | `string` | The title the Tag gave the work. Empty for the Objective's own conversation. |
| `parent_session_id` | `parentSessionId` | `string` | The Session that started this work Session. Empty for the Objective's own conversation. |
| `status` | `status` | [`ObjectiveSessionStatus`](#objectivesessionstatus) | How it is doing. |
| `question` | `question` | `string` | What its latest Task asked, while it waits on the answer. |
| `approval_request_ids` | `approvalRequestIds` | repeated `string` | The approval requests its latest Task waits on. |
| `task_count` | `taskCount` | `int32` | How many Tasks it has. |
| `created_at` | `createdAt` | `google.protobuf.Timestamp` | When it was created. |
| `latest_task` | `latestTask` | [`ObjectiveSessionTask`](#objectivesessiontask) | Its latest Task. Unset while it has none. |

### ObjectiveSessionTask

A Session's latest Task, with what it delivered and reported.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `id` | `id` | `string` | The Task's ID. |
| `status` | `status` | [`ObjectiveSessionStatus`](#objectivesessionstatus) | How it is doing. `OBJECTIVE_SESSION_STATUS_WAITING` when it completed asking a question or waiting on approval requests; never `OBJECTIVE_SESSION_STATUS_QUEUED`. |
| `created_at` | `createdAt` | `google.protobuf.Timestamp` | When it was created. |
| `updated_at` | `updatedAt` | `google.protobuf.Timestamp` | When it last changed. |
| `question` | `question` | `string` | What it asked, while it waits on the answer. |
| `workspace` | `workspace` | `string` | The Workspace it works in. Empty without one. |
| `delivery` | `delivery` | [`TaskDelivery`](shared.md#taskdelivery) | What it delivered. Unset until the Worker recorded a delivery, and for a Task without one. |
| `attempt_status` | `attemptStatus` | [`TaskAttemptStatus`](shared.md#taskattemptstatus) | The status of its latest Task Attempt. Unspecified before one started. |
| `report` | `report` | `string` | Its report: the result text it ended with, cut to 400 characters. The Tag wrote it, so it is untrusted text. Empty until it ended with one. |
| `explanations` | `explanations` | repeated [`TaskExplanation`](#taskexplanation) | Why it is held while open, or how it failed. |

### TaskExplanation

Why a Task is held, or how it failed, from its stored records.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `kind` | `kind` | [`TaskExplanationKind`](#taskexplanationkind) | What it is about. |
| `message` | `message` | `string` | The explanation, in one or two sentences. |
| `next_action` | `nextAction` | `string` | What to do about it, usually naming a `supertag` command. |
| `observed_at` | `observedAt` | `google.protobuf.Timestamp` | When the record behind it was written. Unset when none was. |
| `harness` | `harness` | `string` | The Harness that ran the failed Task Attempt, with `TASK_EXPLANATION_KIND_EXECUTION_FAILED`. |
| `failure_kind` | `failureKind` | `string` | How the Task failed, such as `harness_sign_in`, with `TASK_EXPLANATION_KIND_EXECUTION_FAILED`, when the Worker classified it. |

### HighFinding

A high-severity finding in a Session's latest result.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `task_id` | `taskId` | `string` | The Task whose result carries it. |
| `id` | `id` | `string` | The finding's ID within that result. |
| `summary` | `summary` | `string` | What was found. The Tag wrote it, so it is untrusted text. |
| `location` | `location` | `string` | Where, such as a file and line, when the Tag said. |

### VolumeWrites

What an Objective's Task Attempts wrote to one Volume.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `volume` | `volume` | `string` | The Volume's name. |
| `files` | `files` | `int64` | Files written. |
| `bytes` | `bytes` | `int64` | Bytes written. |
| `partial` | `partial` | `int32` | Task Attempts whose writes were cut short. |
| `refused` | `refused` | `int32` | Task Attempts whose writes the Worker Host refused. |

### ObjectiveTask

One Task of an Objective's Sessions.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `id` | `id` | `string` | The Task's ID. |
| `session_id` | `sessionId` | `string` | Its Session's ID. |
| `tag_id` | `tagId` | `string` | The ID of the Tag that ran it. |
| `status` | `status` | [`TaskStatus`](shared.md#taskstatus) | How it is doing. |
| `request` | `request` | `string` | The turn's input, cut to 400 characters. |
| `response` | `response` | `string` | The turn's result text, cut to 400 characters. Untrusted text. |
| `created_at` | `createdAt` | `google.protobuf.Timestamp` | When it was created. |
| `started_at` | `startedAt` | `google.protobuf.Timestamp` | When it started running. Unset until it did. |
| `ended_at` | `endedAt` | `google.protobuf.Timestamp` | When it ended. Unset while it is open. |
| `attempts` | `attempts` | repeated [`ObjectiveTaskAttempt`](#objectivetaskattempt) | Its Task Attempts, oldest first. |

### ObjectiveTaskAttempt

One Task Attempt of an Objective's Task.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `id` | `id` | `string` | The Task Attempt's ID. |
| `number` | `number` | `int32` | Its number within the Task, from 1. |
| `status` | `status` | [`TaskAttemptStatus`](shared.md#taskattemptstatus) | How it is doing. |
| `started_at` | `startedAt` | `google.protobuf.Timestamp` | When it started. |
| `ended_at` | `endedAt` | `google.protobuf.Timestamp` | When it ended. Unset while it runs. |
| `worker_profile` | `workerProfile` | `string` | The Worker Profile it ran with. |

## Enums

### ObjectiveStatus

Where an Objective stands.

| Value | Description |
| --- | --- |
| `OBJECTIVE_STATUS_UNSPECIFIED` |  |
| `OBJECTIVE_STATUS_WORKING` | The owner works on it. |
| `OBJECTIVE_STATUS_BLOCKED` | The owner cannot continue without a person: it ended twice with nothing running and nothing asked, or marked the Objective blocked. |
| `OBJECTIVE_STATUS_LIMITED` | It reached its budget or deadline limit. An operator raises the budget or moves the deadline to resume it. |
| `OBJECTIVE_STATUS_READY_FOR_REVIEW` | The owner submitted its result for an operator's review. |
| `OBJECTIVE_STATUS_COMPLETED` | It is done. Nothing new starts. |
| `OBJECTIVE_STATUS_CANCELLED` | An operator cancelled it. Nothing new starts. |

### ObjectiveAttentionKind

What about an Objective needs a look.

| Value | Description |
| --- | --- |
| `OBJECTIVE_ATTENTION_KIND_UNSPECIFIED` |  |
| `OBJECTIVE_ATTENTION_KIND_NOT_STARTED` | Its conversation has not started. |
| `OBJECTIVE_ATTENTION_KIND_PAUSED` | An operator paused it. |
| `OBJECTIVE_ATTENTION_KIND_CANCELLED` | An operator cancelled it. |
| `OBJECTIVE_ATTENTION_KIND_BLOCKED` | It is blocked. |
| `OBJECTIVE_ATTENTION_KIND_REVIEW` | The owner submitted it for review. |
| `OBJECTIVE_ATTENTION_KIND_OWNER_QUESTION` | The owner asked a question and waits on the answer. |
| `OBJECTIVE_ATTENTION_KIND_BUDGET_THRESHOLD` | Spend crossed a budget warning threshold. |
| `OBJECTIVE_ATTENTION_KIND_BUDGET_EXHAUSTED` | The budget is used up. |
| `OBJECTIVE_ATTENTION_KIND_BUDGET_COVERAGE_INCOMPLETE` | Some executed Task Attempts reported no cost, so reported spend may be low. |
| `OBJECTIVE_ATTENTION_KIND_DEADLINE_APPROACHING` | The deadline is near. |
| `OBJECTIVE_ATTENTION_KIND_DEADLINE_PASSED` | The deadline passed. |
| `OBJECTIVE_ATTENTION_KIND_APPROVALS_PENDING` | Approval requests wait for a decision. |

### BudgetMeasure

How an Objective's budget is measured.

| Value | Description |
| --- | --- |
| `BUDGET_MEASURE_UNSPECIFIED` |  |
| `BUDGET_MEASURE_PROVIDER_REPORTED_COST` | Provider-reported cost in the budget's currency counts against it. |
| `BUDGET_MEASURE_UNMEASURED` | The budget names no currency, so provider-reported cost cannot be counted against it. |

### ObjectiveConversationAuthor

Who wrote an entry in an Objective's conversation.

| Value | Description |
| --- | --- |
| `OBJECTIVE_CONVERSATION_AUTHOR_UNSPECIFIED` |  |
| `OBJECTIVE_CONVERSATION_AUTHOR_OPERATOR` | An operator's message. |
| `OBJECTIVE_CONVERSATION_AUTHOR_SUPERTAG` | A turn SuperTag delivered: the Objective's start, a limit notice, an approval decision, a work Session's report, or a resume summary. |
| `OBJECTIVE_CONVERSATION_AUTHOR_OWNER` | The owner Tag's reply. |

### ObjectiveSessionStatus

How one of an Objective's Sessions is doing, by its latest Task.

| Value | Description |
| --- | --- |
| `OBJECTIVE_SESSION_STATUS_UNSPECIFIED` |  |
| `OBJECTIVE_SESSION_STATUS_QUEUED` | It has no Task yet. |
| `OBJECTIVE_SESSION_STATUS_PENDING` | Its latest Task waits to run. |
| `OBJECTIVE_SESSION_STATUS_RUNNING` | Its latest Task runs. |
| `OBJECTIVE_SESSION_STATUS_WAITING` | Its latest Task completed waiting on a person: on the answer to `question` when set, otherwise on a decision on its approval requests. |
| `OBJECTIVE_SESSION_STATUS_COMPLETED` | Its latest Task completed. |
| `OBJECTIVE_SESSION_STATUS_FAILED` | Its latest Task failed. |
| `OBJECTIVE_SESSION_STATUS_CANCELLED` | Its latest Task was cancelled. |

### TaskExplanationKind

What a Task explanation is about.

| Value | Description |
| --- | --- |
| `TASK_EXPLANATION_KIND_UNSPECIFIED` |  |
| `TASK_EXPLANATION_KIND_OBJECTIVE_PAUSED` | The Objective is paused; the Task starts once it resumes. |
| `TASK_EXPLANATION_KIND_CONTROLLER` | The Control Plane does not execute Objectives now. |
| `TASK_EXPLANATION_KIND_WORKER_REQUIREMENTS` | No connected Worker can meet the Task's requirements. |
| `TASK_EXPLANATION_KIND_ATTEMPT_UNCERTAIN` | The Task's Task Attempt may have executed and will not be replayed. |
| `TASK_EXPLANATION_KIND_EXECUTION_FAILED` | The Task failed. |
