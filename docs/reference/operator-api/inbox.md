# InboxService

<!-- Generated from spec/proto/supertag/operator/v1 by scripts/protoc-gen-operator-docs.mjs. Edit the proto comments, not this file. -->

`supertag.operator.v1.InboxService` in [`inbox.proto`](../../../spec/proto/supertag/operator/v1/inbox.proto). How to call an RPC, authenticate, and
read its errors is in the [Control Plane API Server](../control-plane-api.md) guide; the conventions every
RPC follows are in [Shared messages and options](shared.md#conventions).

What waits on a person, across Tags and Objectives: `supertag list inbox`,
`watch inbox`, `list approval`, `approve request` and `deny request`.

The inbox is a read model over existing records: approval requests,
questions an Objective's owner asked, budget and deadline limits, Tasks
that need an operator, and MCP servers to log in to. An item leaves the
inbox once what it stands for is settled. Each item names the `supertag`
commands that act on it.

Approval requests come from permissions marked `approval: required`. The
Task that asked ends waiting on the decision; a decision continues its
Session as the Session's next Task.

Access. The admin token and Operator Tokens may call every RPC. Every RPC
also accepts a scoped coordination credential that carries the RPC's
action. Such a credential reaches only the Objectives its scope names:

- A list without `objective_id` covers its one Objective, and fails with
  `PermissionDenied` when its scope names several.
- `objective_id` outside its scope fails with `PermissionDenied`.
- An approval request outside any Objective, which a Tag's inbox turn
  asked for, reaches only a credential without an Objective scope.

A call while the Control Plane drains fails with `Unavailable` and
`ERROR_REASON_DRAINING`.

## RPCs

### ListInboxItems

| | |
| --- | --- |
| Procedure | `/supertag.operator.v1.InboxService/ListInboxItems` |
| Request | [`ListInboxItemsRequest`](#listinboxitemsrequest) |
| Response | [`ListInboxItemsResponse`](#listinboxitemsresponse) |
| Action | `read_coordination_inbox` |
| Callers | The admin token, Operator Tokens, and scoped coordination credentials |
| Audit log | Nothing; reads only |

Lists the items waiting on a person, the longest waiting first. Every
item is pending.

Approval items are listed only for a credential that also carries the
`list_approvals` action; `kind` `INBOX_ITEM_KIND_APPROVAL` without it
fails with `PermissionDenied`. Items the operator does not decide, such
as a question another Tag must answer, are listed too, with
`operator_eligible` false.

Each kind is scanned up to a bound. When a kind had more candidates than
the bound, the response names it in `truncated_kinds` and some of its
items are missing. It fails with `InvalidArgument` for a malformed
`page_token`.

### ListApprovals

| | |
| --- | --- |
| Procedure | `/supertag.operator.v1.InboxService/ListApprovals` |
| Request | [`ListApprovalsRequest`](#listapprovalsrequest) |
| Response | [`ListApprovalsResponse`](#listapprovalsresponse) |
| Action | `list_approvals` |
| Callers | The admin token, Operator Tokens, and scoped coordination credentials |
| Audit log | Nothing; reads only |

Lists approval requests, the most recently created first. A pending
request whose Task already finished lists as `APPROVAL_STATUS_EXPIRED`;
the Control Plane records the expiry itself, not this call.

### Approve

| | |
| --- | --- |
| Procedure | `/supertag.operator.v1.InboxService/Approve` |
| Request | [`ApproveRequest`](#approverequest) |
| Response | [`Approval`](#approval) |
| Action | `decide_approval` |
| Callers | The admin token, Operator Tokens, and scoped coordination credentials |
| Audit log | `approval.approve` |

Approves a pending approval request, as `supertag approve request` does.
The decision continues the waiting Session.

It fails with `NotFound` for a request that does not exist,
`PermissionDenied` when `approvers` names operators but not the caller,
`InvalidArgument` for a `valid_until` that is not in the future or
`APPROVAL_SCOPE_OBJECTIVE` on a request outside any Objective, and
`FailedPrecondition` for a request that is no longer pending, including
one whose Task already finished, which this call expires. Repeating the
caller's own decision, with the same scope, returns the decided request.

### Deny

| | |
| --- | --- |
| Procedure | `/supertag.operator.v1.InboxService/Deny` |
| Request | [`DenyRequest`](#denyrequest) |
| Response | [`Approval`](#approval) |
| Action | `decide_approval` |
| Callers | The admin token, Operator Tokens, and scoped coordination credentials |
| Audit log | `approval.deny` |

Denies a pending approval request with a reason, as `supertag deny
request` does. The decision continues the waiting Session, which reads
the reason. It fails as `Approve` does, and with `InvalidArgument` for an
empty reason.

### AnswerQuestion

| | |
| --- | --- |
| Procedure | `/supertag.operator.v1.InboxService/AnswerQuestion` |
| Request | [`AnswerQuestionRequest`](#answerquestionrequest) |
| Response | [`MessageObjectiveResponse`](objective.md#messageobjectiveresponse) |
| Action | `message_objective` |
| Callers | The admin token, Operator Tokens, and scoped coordination credentials |
| Audit log | `objective.message` |

Answers the question an inbox item of kind `INBOX_ITEM_KIND_QUESTION`
stands for: the text goes to the Objective's conversation as its owner's
next turn, exactly as `ObjectiveService.MessageObjective` sends it, and
the item leaves the inbox.

It fails with `InvalidArgument` for empty text or a `key` that names no
question item, `NotFound` when the Objective does not exist, and
`FailedPrecondition` when the question no longer waits on an answer,
because the owner took another turn or the Objective closed. A repeat
with the same `idempotency_key` returns the first call's turn even after
the question was answered.

## Messages

### ListInboxItemsRequest

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `objective_id` | `objectiveId` | `string` | Lists only this Objective's items. Empty lists every Objective's and the items outside any Objective. |
| `kind` | `kind` | [`InboxItemKind`](#inboxitemkind) | Lists only items of this kind. Unspecified lists every kind. |
| `next_actor_tag_id` | `nextActorTagId` | `string` | Lists only items this Tag may act on, by ID, as `next_actor_tag_ids` names it. Empty lists items whoever acts. |
| `page_size` | `pageSize` | `int32` | At most this many items; 0 means 50, and more than 100 means 100. |
| `page_token` | `pageToken` | `string` | The `next_page_token` of the previous page. |

### ListInboxItemsResponse

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `as_of` | `asOf` | `google.protobuf.Timestamp` | When the Control Plane read the records. |
| `items` | `items` | repeated [`InboxItem`](#inboxitem) | The items, the longest waiting first. |
| `tag_names` | `tagNames` | map of `string` to `string` | Display names of the Tags the items name in `next_actor_tag_ids` and `excluded_actor_tag_ids`, keyed by Tag ID. A Tag that no longer exists has no entry. |
| `truncated_kinds` | `truncatedKinds` | repeated [`InboxItemKind`](#inboxitemkind) | Kinds whose scan reached its bound, so some of their items are missing. |
| `next_page_token` | `nextPageToken` | `string` | Fetches the next page. Empty on the last page. |

### InboxItem

One thing waiting on a person. It carries metadata only: no approval
action arguments, Task text or Tag output beyond what the fields name.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `key` | `key` | `string` | Identifies what the item stands for, such as `approval:ID` or `question:TASK_ID`. It is opaque except to `AnswerQuestion`, and it is the `id` of `WATCH_KIND_INBOX_ITEM` changes. |
| `occurrence` | `occurrence` | `string` | Identifies one occurrence of the item. A Task that needs the same decision again after another Task Attempt is a new occurrence with the same `key`. A client that shows each item once keys on this. |
| `kind` | `kind` | [`InboxItemKind`](#inboxitemkind) | What it waits on. |
| `reason` | `reason` | `string` | Why it needs a look, in one sentence. Worker Hosts and Tags can shape it, so it is untrusted text. |
| `objective_id` | `objectiveId` | `string` | The Objective it belongs to. Empty only for an approval requested by a Tag's inbox turn, which belongs to no Objective. |
| `next_actor_tag_ids` | `nextActorTagIds` | repeated `string` | The IDs of the Tags that may act on it next. |
| `excluded_actor_tag_ids` | `excludedActorTagIds` | repeated `string` | The IDs of Tags that may not act on it, such as the Tag that asked. |
| `operator_eligible` | `operatorEligible` | `bool` | Whether an operator decides it. `supertag list inbox` without `--all` shows only these. |
| `actionable_since` | `actionableSince` | `google.protobuf.Timestamp` | Since when it waits. |
| `deadline` | `deadline` | `google.protobuf.Timestamp` | The deadline of its Objective. Unset without one. |
| `evidence` | `evidence` | repeated [`InboxEvidence`](#inboxevidence) | The records it was derived from. |
| `approval` | `approval` | [`InboxApproval`](#inboxapproval) | The approval request, for `INBOX_ITEM_KIND_APPROVAL`. |
| `question` | `question` | [`InboxQuestion`](#inboxquestion) | The question, for `INBOX_ITEM_KIND_QUESTION`, when the caller may read the whole Objective. |
| `uncertain_attempt` | `uncertainAttempt` | [`UncertainAttempt`](#uncertainattempt) | The uncertain Task Attempt, for an `INBOX_ITEM_KIND_TASK_ATTENTION` item about one. |
| `commands` | `commands` | repeated `string` | The `supertag` commands that act on it, the most direct first, such as `supertag approve request ID`. A command for a Worker Host, such as `supertag recover worklet`, runs there. |
| `notification` | `notification` | [`InboxNotification`](#inboxnotification) | How the operator notification about it was delivered. Unset for kinds that send none. |

### InboxEvidence

A record an inbox item was derived from.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `task` | `task` | [`TaskEvidence`](#taskevidence) | One of `record`. A Task. |
| `objective` | `objective` | [`ObjectiveEvidence`](#objectiveevidence) | One of `record`. An Objective. |
| `approval_request_id` | `approvalRequestId` | `string` | One of `record`. An approval request, by ID. |

Oneof `record`: `task`, `objective`, `approval_request_id`. The record. Exactly one is set.

### TaskEvidence

A Task as an inbox item saw it.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `id` | `id` | `string` | The Task's ID. |
| `status` | `status` | [`TaskStatus`](shared.md#taskstatus) | How it was doing. |
| `attempt_count` | `attemptCount` | `int32` | How many Task Attempts it had. |
| `updated_at` | `updatedAt` | `google.protobuf.Timestamp` | When it last changed. |

### ObjectiveEvidence

An Objective as an inbox item saw it.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `id` | `id` | `string` | The Objective's ID. |
| `revision` | `revision` | `int64` | Its revision. |

### InboxApproval

The approval request an `INBOX_ITEM_KIND_APPROVAL` item stands for.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `request_id` | `requestId` | `string` | The approval request's ID. |
| `kind` | `kind` | [`ApprovalKind`](#approvalkind) | What kind of request it is. |
| `summary` | `summary` | `string` | What would happen, in a short sanitized sentence. |
| `requesting_tag_id` | `requestingTagId` | `string` | The ID of the Tag that asked. |
| `requesting_tag` | `requestingTag` | `string` | The name of the Tag that asked. Empty when the Tag no longer exists. |
| `task_id` | `taskId` | `string` | The Task that asked. |
| `blocking` | `blocking` | `bool` | Whether a running Task Attempt waits on the decision. |

### InboxQuestion

The question an `INBOX_ITEM_KIND_QUESTION` item stands for.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `text` | `text` | `string` | The question, cut to 500 characters. The Tag wrote it, so it is untrusted text. |
| `asked_at` | `askedAt` | `google.protobuf.Timestamp` | When the owner asked it. |
| `truncated` | `truncated` | `bool` | Whether the question is longer than `text`. `DescribeObjective` shows it whole. |

### UncertainAttempt

A Task Attempt that may have executed, which only an operator on its
Worker Host can recover.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `attempt_id` | `attemptId` | `string` | The Task Attempt's ID. |
| `worker_host_id` | `workerHostId` | `string` | The Worker Host it ran on, when known. |
| `worker_id` | `workerId` | `string` | The Worker it ran on, when known. |

### InboxNotification

How the operator notification about an inbox item was delivered.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `status` | `status` | [`InboxNotificationStatus`](#inboxnotificationstatus) | Whether it was delivered. |
| `reason` | `reason` | `string` | More about the status, such as where it was delivered or why it failed. |

### ListApprovalsRequest

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `objective_id` | `objectiveId` | `string` | Lists only this Objective's requests. Empty lists every Objective's and the requests outside any Objective. |
| `status` | `status` | [`ApprovalStatus`](#approvalstatus) | Lists only requests with this status. Unspecified lists every status. |
| `page_size` | `pageSize` | `int32` | At most this many requests; 0 means 100, and more than 500 means 500. |
| `page_token` | `pageToken` | `string` | The `next_page_token` of the previous page. |

### ListApprovalsResponse

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `approvals` | `approvals` | repeated [`Approval`](#approval) | The requests, the most recently created first. |
| `next_page_token` | `nextPageToken` | `string` | Fetches the next page. Empty on the last page. |

### ApproveRequest

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `id` | `id` | `string` | The approval request's ID. |
| `scope` | `scope` | [`ApprovalScope`](#approvalscope) | What the approval covers. Unspecified means `APPROVAL_SCOPE_ONCE`. |
| `valid_until` | `validUntil` | `google.protobuf.Timestamp` | When the approval ends. It must be in the future. Unset: it does not end, apart from a once-scope approval being used up. |

### DenyRequest

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `id` | `id` | `string` | The approval request's ID. |
| `reason` | `reason` | `string` | Why, at most 2,000 characters. The Session that asked reads it. Control characters are removed, and what remains must not be empty. |

### AnswerQuestionRequest

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `key` | `key` | `string` | The question item's `key`. |
| `text` | `text` | `string` | The answer. Leading and trailing whitespace is removed, and what remains must not be empty. |
| `idempotency_key` | `idempotencyKey` | `string` | Makes a retry safe, as `MessageObjectiveRequest.idempotency_key` does. |

### ApprovalAction

One action an approval request covers.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `target` | `target` | [`ApprovalTarget`](#approvaltarget) | What it acts on. |
| `action` | `action` | `string` | The action. For `APPROVAL_TARGET_MCP`, the concrete `server/tool` called. |
| `surface_account_id` | `surfaceAccountId` | `string` | The Surface Account, for `APPROVAL_TARGET_SURFACE`. |
| `scope` | `scope` | `string` | The Surface Account scope, for `APPROVAL_TARGET_SURFACE`. |
| `resource` | `resource` | `string` | The resource the call's arguments name, for `APPROVAL_TARGET_MCP` when the server maps one. |
| `provider` | `provider` | `string` | The surface provider, such as `github`, for display. |
| `tool_name` | `toolName` | `string` | The tool the Tag called, for display only. |

### Approval

One approval request.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `id` | `id` | `string` | The approval request's ID. |
| `objective_id` | `objectiveId` | `string` | The Objective it belongs to. Empty for a request a Tag's inbox turn made. |
| `task_id` | `taskId` | `string` | The Task that asked. |
| `attempt_id` | `attemptId` | `string` | The Task Attempt that asked, when known. |
| `requesting_tag_id` | `requestingTagId` | `string` | The ID of the Tag that asked. |
| `kind` | `kind` | [`ApprovalKind`](#approvalkind) | What kind of request it is. |
| `actions` | `actions` | repeated [`ApprovalAction`](#approvalaction) | The actions it covers. |
| `arguments_digest` | `argumentsDigest` | `string` | The `sha256:` digest of the call's canonical JSON arguments, for a surface action. The arguments themselves are never returned. |
| `summary` | `summary` | `string` | What would happen, in a short sanitized sentence. |
| `rule_sources` | `ruleSources` | repeated `string` | The Permission Sets whose `approval: required` produced it. |
| `approvers` | `approvers` | repeated `string` | Who may decide it, as the requiring Permission Sets name them, such as `operator:ID`. Without an `operator:` entry, any operator may decide it. |
| `status` | `status` | [`ApprovalStatus`](#approvalstatus) | Where it stands. |
| `scope` | `scope` | [`ApprovalScope`](#approvalscope) | What the approval covers, once approved. |
| `valid_until` | `validUntil` | `google.protobuf.Timestamp` | When an `APPROVAL_SCOPE_OBJECTIVE` approval ends. Unset when it does not. |
| `decided_by` | `decidedBy` | `string` | Who decided it: the operator's or Tag's ID. Empty while pending. |
| `decided_by_kind` | `decidedByKind` | [`ApprovalDecider`](#approvaldecider) | Whether an operator or a Tag decided it. |
| `decided_at` | `decidedAt` | `google.protobuf.Timestamp` | When it was decided. Unset while pending. |
| `reason` | `reason` | `string` | The decider's reason, when one was given. A denial always has one. |
| `consumed_at` | `consumedAt` | `google.protobuf.Timestamp` | When a once-scope approval was used up. Unset until then. |
| `created_at` | `createdAt` | `google.protobuf.Timestamp` | When it was created. |
| `updated_at` | `updatedAt` | `google.protobuf.Timestamp` | When it last changed. |

## Enums

### InboxItemKind

What an inbox item waits on.

| Value | Description |
| --- | --- |
| `INBOX_ITEM_KIND_UNSPECIFIED` |  |
| `INBOX_ITEM_KIND_APPROVAL` | A pending approval request. `approval` describes it. |
| `INBOX_ITEM_KIND_QUESTION` | An Objective's owner asked a question and waits on the answer. `question` carries it. Answer it with `AnswerQuestion`. |
| `INBOX_ITEM_KIND_OBJECTIVE_BUDGET` | An Objective's budget is used up. |
| `INBOX_ITEM_KIND_OBJECTIVE_LIMIT` | An Objective reached a budget or deadline limit. `reason` says which. |
| `INBOX_ITEM_KIND_TASK_ATTENTION` | A Task needs an operator, such as a running Task whose Task Attempt is uncertain. `uncertain_attempt` names that Task Attempt. |
| `INBOX_ITEM_KIND_MCP_LOGIN` | A Task is held until an MCP server is logged in to. |

### InboxNotificationStatus

Whether an operator notification was delivered.

| Value | Description |
| --- | --- |
| `INBOX_NOTIFICATION_STATUS_UNSPECIFIED` |  |
| `INBOX_NOTIFICATION_STATUS_NOT_CONFIGURED` | No operator notification channel is configured. |
| `INBOX_NOTIFICATION_STATUS_PENDING` | It waits to be sent. |
| `INBOX_NOTIFICATION_STATUS_DELIVERING` | It is being sent. |
| `INBOX_NOTIFICATION_STATUS_DELIVERED` | It was delivered. |
| `INBOX_NOTIFICATION_STATUS_FAILED` | Sending it failed. |
| `INBOX_NOTIFICATION_STATUS_UNAVAILABLE` | The channel cannot deliver it now. |

### ApprovalKind

What kind of approval request it is.

| Value | Description |
| --- | --- |
| `APPROVAL_KIND_UNSPECIFIED` |  |
| `APPROVAL_KIND_SURFACE_ACTION` | A Tag's use of a surface, runtime or MCP action. |

### ApprovalStatus

Where an approval request stands.

| Value | Description |
| --- | --- |
| `APPROVAL_STATUS_UNSPECIFIED` |  |
| `APPROVAL_STATUS_PENDING` | It waits for a decision. |
| `APPROVAL_STATUS_APPROVED` | It was approved. |
| `APPROVAL_STATUS_DENIED` | It was denied. |
| `APPROVAL_STATUS_EXPIRED` | It can no longer be used, because its Task finished or its approval ended. |

### ApprovalScope

What an approval covers.

| Value | Description |
| --- | --- |
| `APPROVAL_SCOPE_UNSPECIFIED` |  |
| `APPROVAL_SCOPE_ONCE` | This one request. |
| `APPROVAL_SCOPE_OBJECTIVE` | Every matching action in the request's Objective, until `valid_until` when set. |

### ApprovalDecider

Who decided an approval request.

| Value | Description |
| --- | --- |
| `APPROVAL_DECIDER_UNSPECIFIED` |  |
| `APPROVAL_DECIDER_OPERATOR` | An operator. |
| `APPROVAL_DECIDER_TAG` | A Tag named as an approver. |

### ApprovalTarget

What an approval action acts on.

| Value | Description |
| --- | --- |
| `APPROVAL_TARGET_UNSPECIFIED` |  |
| `APPROVAL_TARGET_SURFACE` | A collaboration surface, through a Surface Account. |
| `APPROVAL_TARGET_RUNTIME` | A runtime action in the Task's sandbox, such as `files:write`. |
| `APPROVAL_TARGET_MCP` | An MCP server's tool. |
