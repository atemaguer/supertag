# OrganizationService

<!-- Generated from spec/proto/supertag/operator/v1 by scripts/protoc-gen-operator-docs.mjs. Edit the proto comments, not this file. -->

`supertag.operator.v1.OrganizationService` in [`organization.proto`](../../../spec/proto/supertag/operator/v1/organization.proto). How to call an RPC, authenticate, and
read its errors is in the [Control Plane API Server](../control-plane-api.md) guide; the conventions every
RPC follows are in [Shared messages and options](shared.md#conventions).

Reads the state of the Control Plane and the organization it runs as a
whole: `supertag status`, `spend` and `audit`, and the operational metrics
a monitoring system scrapes.

Access. The admin token and Operator Tokens may call every RPC; a scoped
coordination credential is refused with `PermissionDenied`. Every caller
sees the whole organization.

A call while the Control Plane drains fails with `Unavailable` and
`ERROR_REASON_DRAINING`.

## RPCs

### GetStatus

| | |
| --- | --- |
| Procedure | `/supertag.operator.v1.OrganizationService/GetStatus` |
| Request | [`GetStatusRequest`](#getstatusrequest) |
| Response | [`GetStatusResponse`](#getstatusresponse) |
| Action | `status` |
| Callers | The admin token and Operator Tokens |
| Audit log | Nothing; reads only |

Reports whether the Control Plane accepts new work and how each of its
controllers is running. It needs a credential: a call without one fails
with `Unauthenticated` and reveals nothing else, which is how
`supertag verify deployment` checks that the API refuses anonymous
callers.

### GetOrganization

| | |
| --- | --- |
| Procedure | `/supertag.operator.v1.OrganizationService/GetOrganization` |
| Request | [`GetOrganizationRequest`](#getorganizationrequest) |
| Response | [`OrganizationOverview`](#organizationoverview) |
| Action | `read_organization` |
| Callers | The admin token and Operator Tokens |
| Audit log | Nothing; reads only |

Reports what the organization is doing right now, as `supertag status`
shows it: each Worker Host with its running Task Attempts against
capacity per harness, each Tag as idle or busy, and each Objective that
is not completed or cancelled with its spend, budget, deadline and high
findings. The operator inbox count comes from `InboxService`.

### GetSpend

| | |
| --- | --- |
| Procedure | `/supertag.operator.v1.OrganizationService/GetSpend` |
| Request | [`GetSpendRequest`](#getspendrequest) |
| Response | [`SpendReport`](#spendreport) |
| Action | `read_spend` |
| Callers | The admin token and Operator Tokens |
| Audit log | Nothing; reads only |

Sums the provider-reported cost and tokens of Task Attempts, as
`supertag spend` shows them, grouped by Objective, Tag or day. Separate
currencies are never combined.

### ListAuditEntries

| | |
| --- | --- |
| Procedure | `/supertag.operator.v1.OrganizationService/ListAuditEntries` |
| Request | [`ListAuditEntriesRequest`](#listauditentriesrequest) |
| Response | [`ListAuditEntriesResponse`](#listauditentriesresponse) |
| Action | `read_audit` |
| Callers | The admin token and Operator Tokens |
| Audit log | Nothing; reads only |

Lists recorded operator changes, the newest first, as `supertag audit`
shows them: applies, deletes, Operator Token, Auth Key and Worker Host
changes, approval decisions, Objective messages and every other call that
can change state. An entry never holds a credential, a secret, a digest
or a request body. A change whose call returned before this call began
is listed.

It fails with `InvalidArgument` for an `actor` over 200 characters or a
malformed `page_token`.

### GetMetrics

| | |
| --- | --- |
| Procedure | `/supertag.operator.v1.OrganizationService/GetMetrics` |
| Request | [`GetMetricsRequest`](#getmetricsrequest) |
| Response | [`MetricSnapshot`](#metricsnapshot) |
| Action | `read_metrics` |
| Callers | The admin token and Operator Tokens |
| Audit log | Nothing; reads only |

Reads a bounded operational snapshot for monitoring: resource and Task
counts, recovery and scheduling state, inbox, Mailbox and reply delivery
backlogs, usage, and the answering API Server process's RPC counters.
Everything but `rpc` comes from stored records; reading it contacts no
Worklet.

## Messages

### GetStatusRequest

No fields.

### GetStatusResponse

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `metadata` | `metadata` | [`Metadata`](shared.md#metadata) | Names the Control Plane. `created_at` is when this process started, and `resource_version` changes when the phase or any controller changes. |
| `phase` | `phase` | [`ControlPlanePhase`](#controlplanephase) | Whether the Control Plane accepts new work. |
| `controllers` | `controllers` | repeated [`Controller`](#controller) | Each controller the Control Plane runs, in a stable order. |

### Controller

One independently running part of the Control Plane.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `name` | `name` | `string` | The controller's name: `task-dispatch`, `reply-delivery`, or the collaboration surface controller's name. |
| `phase` | `phase` | [`ControllerPhase`](#controllerphase) | How it is running. |

### GetOrganizationRequest

No fields.

### OrganizationOverview

What the organization is doing right now. See `GetOrganization`.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `captured_at` | `capturedAt` | `google.protobuf.Timestamp` | When the Control Plane read the records. |
| `worker_hosts` | `workerHosts` | repeated [`OrganizationWorkerHost`](#organizationworkerhost) | Each Worker Host that is not revoked, by ID. |
| `tags` | `tags` | repeated [`OrganizationTag`](#organizationtag) | Each Tag that is not deleted, by name. |
| `objectives` | `objectives` | repeated [`OrganizationObjective`](#organizationobjective) | Each Objective that is not completed or cancelled, the newest first. |

### OrganizationWorkerHost

A Worker Host's load. Capacity counts regular slots plus the owner-only
slots Workers with the coordination capability add, one per such Worker.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `id` | `id` | `string` | The host's ID. |
| `phase` | `phase` | [`WorkerHostPhase`](host.md#workerhostphase) | Its phase. |
| `running` | `running` | `int32` | Task Attempts running on it. |
| `capacity` | `capacity` | `int32` | How many Task Attempts it runs at once, owner-only slots included. |
| `coordination_capacity` | `coordinationCapacity` | `int32` | Its owner-only coordination slots. |
| `harnesses` | `harnesses` | repeated [`HarnessLoad`](#harnessload) | Its load per harness, by harness name. A Worker that serves several harnesses counts its capacity under each of them. |
| `disk_space` | `diskSpace` | [`DiskSpace`](host.md#diskspace) | Its free and total scratch space, as it last reported. Unset when it never reported. |
| `disk_warning` | `diskWarning` | `string` | A warning when free scratch space is below the smaller of 10 GiB and 5% of the volume. Empty otherwise. |

### HarnessLoad

Running Task Attempts against capacity for one harness on one Worker Host.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `harness` | `harness` | `string` | The harness, such as `codex`, or the Worker type when its Workers name none. |
| `running` | `running` | `int32` | Task Attempts of this harness running on the host. |
| `capacity` | `capacity` | `int32` | Its capacity, owner-only slots included. |
| `coordination_capacity` | `coordinationCapacity` | `int32` | Its owner-only coordination slots. |

### OrganizationTag

Whether a Tag is busy.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `id` | `id` | `string` | The Tag's ID. |
| `name` | `name` | `string` | The Tag's name. |
| `running_task_ids` | `runningTaskIds` | repeated `string` | The Tasks whose Task Attempts run now, sorted. Empty when the Tag is idle. |
| `running_commands` | `runningCommands` | repeated [`TagRunningCommand`](#tagrunningcommand) | The command each running Task's harness reports as running, for harnesses that report commands. |

### TagRunningCommand

The command a running Task's harness reports.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `task_id` | `taskId` | `string` | The Task's ID. |
| `command` | `command` | `string` | The command, as plain single-line text. The harness wrote it, so it is untrusted text. |
| `started_at` | `startedAt` | `google.protobuf.Timestamp` | When it started. |

### OrganizationObjective

An Objective that is not finished, with its spend.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `id` | `id` | `string` | The Objective's ID. |
| `status` | `status` | [`ObjectiveStatus`](objective.md#objectivestatus) | Where it stands. |
| `owner_tag_id` | `ownerTagId` | `string` | The owner Tag's ID. |
| `owner` | `owner` | `string` | The owner Tag's name, or its ID when the Tag no longer exists. |
| `deadline` | `deadline` | `google.protobuf.Timestamp` | When it is due. Unset without a deadline. |
| `spent_minor` | `spentMinor` | `int64` | Provider-reported spend in minor units of `spend_currency`, as last observed; 0 when none is known. |
| `budget_limit_minor` | `budgetLimitMinor` | optional `int64` | The budget limit, in minor units of `currency` or in allocation units. Unset without a budget. |
| `currency` | `currency` | `string` | The budget's ISO 4217 code. Empty when the budget counts allocation units or there is none. |
| `spend_currency` | `spendCurrency` | `string` | The currency of `spent_minor`. Empty when spend counts allocation units. |
| `unpriced_attempts` | `unpricedAttempts` | `int32` | Task Attempts whose model has no published price, so their cost is unknown and a budget in a currency cannot be enforced on them. |
| `unpriced_tokens` | `unpricedTokens` | `int64` | The tokens those Task Attempts used. 0 when `unpriced_attempts` is 0. |
| `high_findings` | `highFindings` | repeated [`HighFinding`](objective.md#highfinding) | The high-severity findings of the latest Task of each of its Sessions, in Session order. |

### GetSpendRequest

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `by` | `by` | [`SpendGrouping`](#spendgrouping) | How to group Task Attempts. Unspecified groups by Objective. |
| `since` | `since` | `google.protobuf.Timestamp` | Counts only Task Attempts that started at or after this time. Unset counts all of them. |

### SpendReport

Spend grouped as asked. See `GetSpend`.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `by` | `by` | [`SpendGrouping`](#spendgrouping) | How the groups are formed. Never unspecified. |
| `since` | `since` | `google.protobuf.Timestamp` | The `since` of the request. Unset when it had none. |
| `groups` | `groups` | repeated [`SpendGroup`](#spendgroup) | The groups, by `key`. Empty when no Task Attempt counts. |

### SpendGroup

The usage of one group of Task Attempts.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `key` | `key` | `string` | The Objective ID or `unassigned`, the Tag ID, or the day as `YYYY-MM-DD`. |
| `name` | `name` | `string` | The Tag's name when grouped by Tag. Empty otherwise. |
| `budget` | `budget` | [`Budget`](objective.md#budget) | The Objective's budget when grouped by Objective and it has one. Unset otherwise. |
| `attempts` | `attempts` | `int32` | Task Attempts in the group. |
| `reported_cost_by_currency` | `reportedCostByCurrency` | map of `string` to `int64` | Their provider-reported cost by ISO 4217 code, in minor units, estimated costs included. Empty when none reported a cost. |
| `unknown_cost_attempts` | `unknownCostAttempts` | `int32` | Task Attempts that reported no cost. They are not counted as zero. |
| `estimated_cost_attempts` | `estimatedCostAttempts` | `int32` | Task Attempts whose cost is an estimate from a model price table. |
| `unpriced_models` | `unpricedModels` | map of `string` to `int32` | Unknown-cost Task Attempts that reported tokens for a model the harness has no price for, counted by model. |
| `unpriced_tokens` | `unpricedTokens` | `int64` | The tokens of those Task Attempts. |
| `reported_tokens` | `reportedTokens` | optional `int64` | The tokens reported by every Task Attempt that reported usage. Unset when none did. |
| `unknown_token_attempts` | `unknownTokenAttempts` | `int32` | Task Attempts that reported no usage. |

### ListAuditEntriesRequest

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `since` | `since` | `google.protobuf.Timestamp` | Lists only entries at or after this time. Unset lists from the oldest. |
| `actor` | `actor` | `string` | Lists only entries by this exact operator, such as `token:laptop-2`. Empty lists every operator's. |
| `page_size` | `pageSize` | `int32` | At most this many entries; 0 means 50, and more than 500 means 500. |
| `page_token` | `pageToken` | `string` | The `next_page_token` of the previous page. |

### ListAuditEntriesResponse

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `entries` | `entries` | repeated [`AuditEntry`](#auditentry) | The entries, the newest first. |
| `next_page_token` | `nextPageToken` | `string` | Fetches the next page, which continues after this page's last entry, so entries recorded in between are neither repeated nor skipped. Empty on the last page. |

### AuditEntry

One recorded operator change.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `id` | `id` | `string` | The entry's ID. |
| `at` | `at` | `google.protobuf.Timestamp` | When the Control Plane finished handling the change. |
| `actor` | `actor` | `string` | Who acted: `control-plane-break-glass` for the admin token, `token:NAME` for an Operator Token, a scoped credential's operator ID, `worker-host:ID` for a Worker Host's own credential, `auth-key:NAME` for a host that joined with an Auth Key (`auth-key` when the join failed), or `PROVIDER:USER` for a person in an Objective thread. |
| `action` | `action` | `string` | What was done, such as `apply`, `auth-key.create` or `approval.approve`: an RPC's `audit_action`, or what the call it arrived as did. |
| `target` | `target` | `string` | What it was done to, as `Kind/NAME` or `Kind/ID`, such as `Tag/builder`. Only the kind, such as `Tag`, when the change failed or its name could hold a secret. |
| `outcome` | `outcome` | [`AuditOutcome`](#auditoutcome) | Whether the change took effect. |
| `status` | `status` | optional `int32` | The HTTP status of the response, for a change that arrived as a call. An RPC's status is the HTTP status its Connect code maps to. Unset otherwise. |
| `source` | `source` | [`AuditSource`](#auditsource) | Where the Control Plane received the change. |
| `method` | `method` | `string` | The call's HTTP method, for a change that arrived as a call. Empty otherwise. |
| `path` | `path` | `string` | The route the call matched, as a template such as `/supertag.operator.v1.HostService/DrainWorkerHost`. It is never the call's own path. Empty when the call matched no route or the change did not arrive as a call. |

### GetMetricsRequest

No fields.

### MetricSnapshot

An operational snapshot. See `GetMetrics`. Durations are milliseconds.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `captured_at` | `capturedAt` | `google.protobuf.Timestamp` | When the Control Plane read the records. |
| `tags` | `tags` | `int64` | Tags. |
| `roles` | `roles` | `int64` | Roles. |
| `role_assignments` | `roleAssignments` | `int64` | Role assignments to Tags. |
| `surface_accounts` | `surfaceAccounts` | `int64` | Surface Accounts. |
| `permission_sets` | `permissionSets` | `int64` | Permission Sets. |
| `context_sets` | `contextSets` | `int64` | Context Sets. |
| `sessions` | `sessions` | `int64` | Sessions. |
| `tasks` | `tasks` | [`TaskCounts`](#taskcounts) | Tasks by status. |
| `recovery` | `recovery` | [`RecoveryMetrics`](#recoverymetrics) | Work recovery still has to settle. |
| `coordination_inbox` | `coordinationInbox` | [`InboxMetrics`](#inboxmetrics) | The operator inbox. |
| `usage` | `usage` | [`UsageMetrics`](#usagemetrics) | Provider-reported usage. |
| `native_agents` | `nativeAgents` | [`NativeAgentMetrics`](#nativeagentmetrics) | Native subagents of harnesses. |
| `scheduling` | `scheduling` | [`SchedulingMetrics`](#schedulingmetrics) | The Task queue and placement. |
| `mailbox` | `mailbox` | [`BacklogMetrics`](#backlogmetrics) | Mailbox messages no inbox turn has taken yet. |
| `reply_delivery` | `replyDelivery` | [`ReplyDeliveryMetrics`](#replydeliverymetrics) | Replies waiting to reach collaboration surfaces. |
| `rpc` | `rpc` | [`RpcMetrics`](#rpcmetrics) | The answering API Server process's RPC counters. Each process counts its own, from `rpc.started_at`, and they reset when it is replaced. |

### TaskCounts

Tasks by status.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `total` | `total` | `int64` | Every Task. |
| `pending` | `pending` | `int64` | Pending Tasks. |
| `running` | `running` | `int64` | Running Tasks. |
| `completed` | `completed` | `int64` | Completed Tasks. |
| `failed` | `failed` | `int64` | Failed Tasks. |
| `cancelled` | `cancelled` | `int64` | Cancelled Tasks. |

### RecoveryMetrics

Work recovery still has to settle.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `unknown_control_deliveries` | `unknownControlDeliveries` | `int64` | Control messages to Worker Hosts whose delivery is not known. |
| `blocked_sessions` | `blockedSessions` | `int64` | Sessions blocked until recovery settles them. |
| `durable_executions_awaiting_reconciliation` | `durableExecutionsAwaitingReconciliation` | `int64` | Durable executions waiting for their Worker Host to reconcile them. |

### InboxMetrics

The operator inbox.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `pending` | `pending` | `int64` | Pending items. |
| `by_kind` | `byKind` | map of `string` to `int64` | Pending items by kind, such as `approval_request`. |
| `oldest_actionable_at` | `oldestActionableAt` | `google.protobuf.Timestamp` | When the oldest actionable item arrived. Unset when there is none. |
| `oldest_actionable_age_seconds` | `oldestActionableAgeSeconds` | optional `int64` | Its age in seconds. Unset when there is none. |

### UsageMetrics

Provider-reported usage.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `reporting_attempts` | `reportingAttempts` | `int64` | Task Attempts with at least one usage report. |
| `total_tokens` | `totalTokens` | `int64` | Their tokens. |
| `incomplete_attempts` | `incompleteAttempts` | `int64` | Task Attempts whose reports do not cover the whole Task Attempt. |
| `reported_cost_by_currency` | `reportedCostByCurrency` | map of `string` to `int64` | Their cost by ISO 4217 code, in minor units. |

### NativeAgentMetrics

Native subagents of harnesses.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `peak_concurrent` | `peakConcurrent` | `int64` | The most subagents one Task Attempt ran at once. |
| `token_limit_interruptions` | `tokenLimitInterruptions` | `int64` | Task Attempts stopped at their token limit. |
| `agent_limit_interruptions` | `agentLimitInterruptions` | `int64` | Task Attempts stopped at their subagent limit. |

### SchedulingMetrics

The Task queue and placement.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `queued` | `queued` | `int64` | Pending Tasks. |
| `oldest_queued_at` | `oldestQueuedAt` | `google.protobuf.Timestamp` | When the oldest pending Task was queued. Unset when none is. |
| `oldest_queued_age_seconds` | `oldestQueuedAgeSeconds` | optional `int64` | Its age in seconds. Unset when none is queued. |
| `placed_attempts` | `placedAttempts` | `int64` | Task Attempts placed on a Worker Host. |
| `average_queue_duration_ms` | `averageQueueDurationMs` | `double` | Average time from queueing to placement. |
| `maximum_queue_duration_ms` | `maximumQueueDurationMs` | `double` | Longest time from queueing to placement. |
| `average_placement_duration_ms` | `averagePlacementDurationMs` | `double` | Average time to place a Task Attempt. |
| `maximum_placement_duration_ms` | `maximumPlacementDurationMs` | `double` | Longest time to place a Task Attempt. |
| `admission_rejections` | `admissionRejections` | `int64` | Task Attempts a Worker Host refused to admit. |
| `reservations` | `reservations` | [`ReservationMetrics`](#reservationmetrics) | Capacity reservations. A reservation released after a declined claim leaves no record, so none of these counts it. |
| `worker_hosts` | `workerHosts` | repeated [`WorkerHostUtilization`](#workerhostutilization) | Each Worker Host's capacity, from its latest stored observation. |

### ReservationMetrics

Capacity reservations.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `consumed` | `consumed` | `int64` | Reservations a Task Attempt used. |
| `active` | `active` | `int64` | Reservations held now. |
| `expired` | `expired` | `int64` | Reservations that expired unused. |

### WorkerHostUtilization

One Worker Host's capacity.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `id` | `id` | `string` | The host's ID. |
| `phase` | `phase` | [`WorkerHostPhase`](host.md#workerhostphase) | Its phase: connected, draining or unreachable. |
| `active_attempts` | `activeAttempts` | `int32` | Task Attempts running on it. |
| `capacity` | `capacity` | `int32` | How many it runs at once. |
| `available_slots` | `availableSlots` | `int32` | How many more it can take now. |
| `utilization` | `utilization` | `double` | `active_attempts` over `capacity`, from 0 to 1. |

### BacklogMetrics

A backlog.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `pending` | `pending` | `int64` | Items waiting. |
| `oldest_pending_at` | `oldestPendingAt` | `google.protobuf.Timestamp` | When the oldest arrived. Unset when none waits. |

### ReplyDeliveryMetrics

Replies waiting to reach collaboration surfaces.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `backlog` | `backlog` | `int64` | Replies not yet delivered. |
| `retrying` | `retrying` | `int64` | Replies waiting to retry. |
| `retry_attempts` | `retryAttempts` | `int64` | Retries made. |
| `failed` | `failed` | `int64` | Replies that will not be retried. |
| `oldest_pending_at` | `oldestPendingAt` | `google.protobuf.Timestamp` | When the oldest undelivered reply was created. Unset when none waits. |

### RpcMetrics

One API Server process's RPC counters, Worklet transports included. They
hold no request headers, bodies, IDs or error messages.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `started_at` | `startedAt` | `google.protobuf.Timestamp` | When the process began counting. Compare samples only within one `started_at`. |
| `captured_at` | `capturedAt` | `google.protobuf.Timestamp` | When it was read. |
| `methods` | `methods` | repeated [`RpcMethodMetrics`](#rpcmethodmetrics) | Counters per service and method. |
| `channels` | `channels` | [`RpcChannelMetrics`](#rpcchannelmetrics) | HTTP/2 connections. |
| `queues` | `queues` | [`RpcQueueMetrics`](#rpcqueuemetrics) | Buffered Worklet frames. |
| `close_codes` | `closeCodes` | map of `string` to `int64` | Worklet closures by close code. |
| `trace_errors` | `traceErrors` | `int64` | Lifecycle events a slow or failing trace sink dropped. |

### RpcMethodMetrics

Counters for one RPC method.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `service` | `service` | `string` | The service. |
| `method` | `method` | `string` | The method. |
| `started` | `started` | `int64` | Calls started. |
| `completed` | `completed` | `int64` | Calls completed. |
| `active` | `active` | `int64` | Calls running. |
| `active_streams` | `activeStreams` | `int64` | Streams open. |
| `errors` | `errors` | `int64` | Calls that failed. |
| `status_codes` | `statusCodes` | repeated `int64` | Completed calls by gRPC status code: entry N counts code N, for codes 0 to 16. |
| `duration` | `duration` | [`RpcDurationMetrics`](#rpcdurationmetrics) | Call durations. A stream's duration is its lifetime. |

### RpcDurationMetrics

A duration histogram, in milliseconds.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `count` | `count` | `int64` | Durations observed. |
| `total` | `total` | `double` | Their sum. |
| `max` | `max` | `double` | The longest. |
| `buckets` | `buckets` | repeated [`RpcDurationBucket`](#rpcdurationbucket) | Cumulative buckets, the smallest bound first. |

### RpcDurationBucket

One cumulative histogram bucket.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `le` | `le` | optional `double` | Its upper bound. Unset for the last bucket, which counts every duration. |
| `count` | `count` | `int64` | Durations at or below the bound. |

### RpcChannelMetrics

HTTP/2 connections. More opened connections alone do not tell new hosts
from reconnects.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `active` | `active` | `int64` | Connections open. |
| `opened` | `opened` | `int64` | Connections opened. |
| `closed` | `closed` | `int64` | Connections closed. |

### RpcQueueMetrics

Buffered Worklet frames.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `active` | `active` | `int64` | Queues open. |
| `frames` | `frames` | `int64` | Frames buffered. |
| `bytes` | `bytes` | `int64` | Bytes buffered. |
| `capacity_frames` | `capacityFrames` | `int64` | The frame capacity. |
| `capacity_bytes` | `capacityBytes` | `int64` | The byte capacity. |
| `peak_frames` | `peakFrames` | `int64` | The most frames buffered at once. |
| `peak_bytes` | `peakBytes` | `int64` | The most bytes buffered at once. |
| `rejections` | `rejections` | `int64` | Frames refused because a queue was full. |

## Enums

### ControlPlanePhase

Whether the Control Plane accepts new work.

| Value | Description |
| --- | --- |
| `CONTROL_PLANE_PHASE_UNSPECIFIED` |  |
| `CONTROL_PLANE_PHASE_ACCEPTING` | It admits events and dispatches Tasks. |
| `CONTROL_PLANE_PHASE_DRAINING` | It is shutting down. Accepted Tasks finish; nothing new starts. |

### ControllerPhase

How a controller is running.

| Value | Description |
| --- | --- |
| `CONTROLLER_PHASE_UNSPECIFIED` |  |
| `CONTROLLER_PHASE_RUNNING` | It is doing its work. |
| `CONTROLLER_PHASE_DEGRADED` | It runs, but at least one of its connections reports an error. |
| `CONTROLLER_PHASE_DRAINING` | It is finishing accepted work before it stops. |
| `CONTROLLER_PHASE_STOPPED` | It is not running. |
| `CONTROLLER_PHASE_DISABLED` | This Control Plane is configured without it. |

### SpendGrouping

How `GetSpend` groups Task Attempts.

| Value | Description |
| --- | --- |
| `SPEND_GROUPING_UNSPECIFIED` |  |
| `SPEND_GROUPING_OBJECTIVE` | By the Objective of each Task Attempt's Task. Task Attempts outside any Objective form the group `unassigned`. |
| `SPEND_GROUPING_TAG` | By Tag. |
| `SPEND_GROUPING_DAY` | By the UTC day each Task Attempt started. |

### AuditOutcome

Whether a recorded change took effect.

| Value | Description |
| --- | --- |
| `AUDIT_OUTCOME_UNSPECIFIED` |  |
| `AUDIT_OUTCOME_SUCCEEDED` | It took effect. |
| `AUDIT_OUTCOME_FAILED` | It was refused or failed. |

### AuditSource

Where the Control Plane received a change.

| Value | Description |
| --- | --- |
| `AUDIT_SOURCE_UNSPECIFIED` |  |
| `AUDIT_SOURCE_API` | A call to the API Server. |
| `AUDIT_SOURCE_GATEWAY` | A person's action in an Objective thread on a collaboration surface, through the Gateway. |
