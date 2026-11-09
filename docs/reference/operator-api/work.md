# WorkService

<!-- Generated from spec/proto/supertag/operator/v1 by scripts/protoc-gen-operator-docs.mjs. Edit the proto comments, not this file. -->

`supertag.operator.v1.WorkService` in [`work.proto`](../../../spec/proto/supertag/operator/v1/work.proto). How to call an RPC, authenticate, and
read its errors is in the [Control Plane API Server](../control-plane-api.md) guide; the conventions every
RPC follows are in [Shared messages and options](shared.md#conventions).

Sessions, Tasks and artifacts as an operator inspects them: `supertag list
task`, `get task`, `describe task`, `events task`, `cancel task`, `list
session`, `get session`, `describe session`, `list artifact`, `get
artifact` and `download artifact`, and the terminal UI's review of a work
Session's delivered branch.

A Session is one conversation of a Tag. Each turn of it is a Task, and each
try at running a Task is a Task Attempt. A work Session is a Session that a
turn started for one piece of work; its `parent_session_id` names the
Session that started it.

Every view is built from the records the Control Plane stores; only
`InspectTaskExecution` asks a Worker Host. The Control Plane keeps no
artifact bytes and no repository contents: a Task's files, its branch and
its artifacts stay on the Worker Host or Volume that holds them, and the
views say where. A client that shows a diff computes it from its own
checkout.

Access. The admin token and Operator Tokens may call every RPC. A scoped
coordination credential is refused with `PermissionDenied`. A CLI
conversation's Session, the work Sessions its turns started, and their
Tasks, events, native archives and artifacts reach only the operator whose
conversation it is, as in `ConversationService`: another caller's lists
leave them out, and naming one fails with `NotFound`, exactly as for one
that does not exist.

Every RPC that names a Task, Session, native archive or artifact fails with
`InvalidArgument` for an empty ID and `NotFound` for one that does not
exist. A call while the Control Plane drains fails with `Unavailable` and
`ERROR_REASON_DRAINING`.

## RPCs

### ListTasks

| | |
| --- | --- |
| Procedure | `/supertag.operator.v1.WorkService/ListTasks` |
| Request | [`ListTasksRequest`](#listtasksrequest) |
| Response | [`ListTasksResponse`](#listtasksresponse) |
| Action | `read_task` |
| Callers | The admin token and Operator Tokens |
| Audit log | Nothing; reads only |

Lists Tasks, the most recently created first, as `supertag list task`
shows them. Each Task is the view `GetTask` returns without `storage`.

It fails with `NotFound` when `tag` names a Tag that does not exist, and
`InvalidArgument` for a malformed `page_token`.

### GetTask

| | |
| --- | --- |
| Procedure | `/supertag.operator.v1.WorkService/GetTask` |
| Request | [`GetTaskRequest`](#gettaskrequest) |
| Response | [`Task`](#task) |
| Action | `read_task` |
| Callers | The admin token and Operator Tokens |
| Audit log | Nothing; reads only |

Reads one Task as `supertag get task` and `describe task` show it: its
request, how it runs, each Task Attempt, the latest Task Attempt's
placement and failure, what it delivered, and where its files and
artifacts are kept.

### ListTaskEvents

| | |
| --- | --- |
| Procedure | `/supertag.operator.v1.WorkService/ListTaskEvents` |
| Request | [`ListTaskEventsRequest`](#listtaskeventsrequest) |
| Response | [`ListTaskEventsResponse`](#listtaskeventsresponse) |
| Action | `read_task` |
| Callers | The admin token and Operator Tokens |
| Audit log | Nothing; reads only |

Lists a Task's recorded events in sequence order, as `supertag events
task` shows them: what the Control Plane and the Worker recorded about
the Task and each of its Task Attempts, commands and tool calls
included. It fails with `InvalidArgument` for a malformed `page_token`.

### InspectTaskExecution

| | |
| --- | --- |
| Procedure | `/supertag.operator.v1.WorkService/InspectTaskExecution` |
| Request | [`InspectTaskExecutionRequest`](#inspecttaskexecutionrequest) |
| Response | [`InspectTaskExecutionResponse`](#inspecttaskexecutionresponse) |
| Action | `read_task` |
| Callers | The admin token and Operator Tokens |
| Audit log | `task.inspect` |

Reports how the Task's latest Task Attempt ran against its execution
limits and where it ran, and, for a durable Task Attempt, asks the
Worker Host that ran it for its execution receipt. When the Control Plane
reaches that Worker Host, the Worker events the receipt names and the
Control Plane has not recorded are recorded first, so the report and
`ListTaskEvents` include them. A Worker Host the Control Plane cannot
reach makes `availability` `TASK_EXECUTION_AVAILABILITY_UNAVAILABLE`,
not an error.

### CancelTask

| | |
| --- | --- |
| Procedure | `/supertag.operator.v1.WorkService/CancelTask` |
| Request | [`CancelTaskRequest`](#canceltaskrequest) |
| Response | [`CancelTaskResponse`](#canceltaskresponse) |
| Action | `cancel_task` |
| Callers | The admin token and Operator Tokens |
| Audit log | `task.cancel` |

Cancels a pending or running Task, as `supertag cancel task` does. A
pending Task is cancelled at once. A running Task's Worker is told to
stop, and the Task stays `TASK_STATUS_RUNNING` until the Worker reports
it stopped; repeating the call meanwhile asks the Worker again, which is
harmless. Cancelling a Task that already finished changes nothing and
succeeds with `accepted` false.

### ListSessions

| | |
| --- | --- |
| Procedure | `/supertag.operator.v1.WorkService/ListSessions` |
| Request | [`ListSessionsRequest`](#listsessionsrequest) |
| Response | [`ListSessionsResponse`](#listsessionsresponse) |
| Action | `read_session` |
| Callers | The admin token and Operator Tokens |
| Audit log | Nothing; reads only |

Lists Sessions, the most recent interaction first, as `supertag list
session` shows them. Each Session is the view `GetSession` returns
without `delivery`.

It fails with `NotFound` when `tag` names a Tag that does not exist, and
`InvalidArgument` for a malformed `page_token`.

### GetSession

| | |
| --- | --- |
| Procedure | `/supertag.operator.v1.WorkService/GetSession` |
| Request | [`GetSessionRequest`](#getsessionrequest) |
| Response | [`Session`](#session) |
| Action | `read_session` |
| Callers | The admin token and Operator Tokens |
| Audit log | Nothing; reads only |

Reads one Session as `supertag get session` and `describe session` show
it, with `delivery`: what its latest delivering Task delivered, such as a
work Session's branch, base and head commits and pull request, and the
Worker Host whose checkout holds the branch.

### ListSessionStates

| | |
| --- | --- |
| Procedure | `/supertag.operator.v1.WorkService/ListSessionStates` |
| Request | [`ListSessionStatesRequest`](#listsessionstatesrequest) |
| Response | [`ListSessionStatesResponse`](#listsessionstatesresponse) |
| Action | `read_session` |
| Callers | The admin token and Operator Tokens |
| Audit log | Nothing; reads only |

Lists a Session's native archives, the most recently created first, as
`supertag describe session` counts them: what each harness saved of its
own conversation so a later Task can resume it. The archives' contents
are left out; `GetSessionState` reads one whole.

### GetSessionState

| | |
| --- | --- |
| Procedure | `/supertag.operator.v1.WorkService/GetSessionState` |
| Request | [`GetSessionStateRequest`](#getsessionstaterequest) |
| Response | [`SessionState`](#sessionstate) |
| Action | `read_session_state` |
| Callers | The admin token and Operator Tokens |
| Audit log | Nothing; reads only |

Reads one native archive with its contents. It fails with `NotFound`
when the archive belongs to another Session.

### ListArtifacts

| | |
| --- | --- |
| Procedure | `/supertag.operator.v1.WorkService/ListArtifacts` |
| Request | [`ListArtifactsRequest`](#listartifactsrequest) |
| Response | [`ListArtifactsResponse`](#listartifactsresponse) |
| Action | `read_artifact` |
| Callers | The admin token and Operator Tokens |
| Audit log | Nothing; reads only |

Lists captured artifacts, the oldest first, as `supertag list artifact`
shows them, each with where its copies are. It fails with
`InvalidArgument` for a malformed `page_token`.

### GetArtifact

| | |
| --- | --- |
| Procedure | `/supertag.operator.v1.WorkService/GetArtifact` |
| Request | [`GetArtifactRequest`](#getartifactrequest) |
| Response | [`Artifact`](#artifact) |
| Action | `read_artifact` |
| Callers | The admin token and Operator Tokens |
| Audit log | Nothing; reads only |

Reads one artifact's catalog record, as `supertag get artifact` shows
it: its files with their digests and sizes, and where its copies are.

### ResolveArtifactDownload

| | |
| --- | --- |
| Procedure | `/supertag.operator.v1.WorkService/ResolveArtifactDownload` |
| Request | [`ResolveArtifactDownloadRequest`](#resolveartifactdownloadrequest) |
| Response | [`ArtifactDownload`](#artifactdownload) |
| Action | `download_artifact` |
| Callers | The admin token and Operator Tokens |
| Audit log | `artifact.download` |

Says where the caller can read one artifact file, for `supertag download
artifact`: the serving Worker Host's transfer endpoint with a short-lived
grant for this file and caller, and the Volume copies the caller may read
with its own Volume credentials. The bytes never pass through the Control
Plane. The client fetches them from a location and checks them against
`digest` and `size_bytes` before keeping them.

Only copies of the Worker Host whose Task Attempt captured the artifact
are offered. When there is none, `transfers` and `volumes` are empty and
`holders` names where the file is. Each call issues new grants. It fails
with `InvalidArgument` for an empty `path`, and `NotFound` when the
artifact has no file at `path`.

## Messages

### ListTasksRequest

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `tag` | `tag` | `string` | Lists only this Tag's Tasks, by name. Empty lists every Tag's. |
| `session_id` | `sessionId` | `string` | Lists only this Session's Tasks. Empty lists every Session's. |
| `objective_id` | `objectiveId` | `string` | Lists only this Objective's Tasks. Empty lists Tasks in and outside Objectives. |
| `statuses` | `statuses` | repeated [`TaskStatus`](shared.md#taskstatus) | Lists only Tasks with one of these statuses. Empty lists every status. |
| `page_size` | `pageSize` | `int32` | At most this many Tasks; 0 means 100, and more than 500 means 500. |
| `page_token` | `pageToken` | `string` | The `next_page_token` of the previous page. |

### ListTasksResponse

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `tasks` | `tasks` | repeated [`Task`](#task) | The Tasks, the most recently created first. |
| `next_page_token` | `nextPageToken` | `string` | Fetches the next page. Empty on the last page. A page before the last can hold fewer Tasks than `page_size`, or none, when most Tasks it passed are ones the caller cannot see or that do not match. |

### GetTaskRequest

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `id` | `id` | `string` | The Task's ID. |

### ListTaskEventsRequest

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `task_id` | `taskId` | `string` | The Task's ID. |
| `after_sequence` | `afterSequence` | `int64` | Lists only events after this `TaskEvent.sequence`. 0 lists from the first. A client that follows a running Task passes the last sequence it received. |
| `page_size` | `pageSize` | `int32` | At most this many events; 0 means 500, and more than 1,000 means 1,000. |
| `page_token` | `pageToken` | `string` | The `next_page_token` of the previous page. |

### ListTaskEventsResponse

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `events` | `events` | repeated [`TaskEvent`](#taskevent) | The events, in sequence order. |
| `next_page_token` | `nextPageToken` | `string` | Fetches the next page. Empty on the last page. |

### InspectTaskExecutionRequest

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `task_id` | `taskId` | `string` | The Task's ID. |

### CancelTaskRequest

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `id` | `id` | `string` | The Task's ID. |

### CancelTaskResponse

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `task_id` | `taskId` | `string` | The Task's ID. |
| `accepted` | `accepted` | `bool` | Whether this call cancelled the Task or asked its Worker to stop. False when the Task had already finished, or its result was being recorded. |
| `status` | `status` | [`TaskStatus`](shared.md#taskstatus) | The Task's status after the call: `TASK_STATUS_CANCELLED` once cancelled, `TASK_STATUS_RUNNING` until a running Task's Worker stops, or the status a finished Task ended with. |

### ListSessionsRequest

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `tag` | `tag` | `string` | Lists only this Tag's Sessions, by name. Empty lists every Tag's. |
| `parent_session_id` | `parentSessionId` | `string` | Lists only the work Sessions this Session started. Empty lists Sessions whatever started them. |
| `objective_id` | `objectiveId` | `string` | Lists only this Objective's Sessions: its own conversation and the work Sessions started under it. Empty lists Sessions in and outside Objectives. |
| `page_size` | `pageSize` | `int32` | At most this many Sessions; 0 means 100, and more than 500 means 500. |
| `page_token` | `pageToken` | `string` | The `next_page_token` of the previous page. |

### ListSessionsResponse

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `sessions` | `sessions` | repeated [`Session`](#session) | The Sessions, the most recent interaction first. |
| `next_page_token` | `nextPageToken` | `string` | Fetches the next page. Empty on the last page. |

### GetSessionRequest

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `id` | `id` | `string` | The Session's ID. A work Session's ID is `WorkSession.id` in `ConversationService`. |

### ListSessionStatesRequest

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `session_id` | `sessionId` | `string` | The Session's ID. |
| `native_id` | `nativeId` | `string` | Lists only archives of this harness-native conversation ID. Empty lists every archive. |
| `page_size` | `pageSize` | `int32` | At most this many archives; 0 means 100, and more than 100 means 100. |
| `page_token` | `pageToken` | `string` | The `next_page_token` of the previous page. |

### ListSessionStatesResponse

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `states` | `states` | repeated [`SessionState`](#sessionstate) | The archives, the most recently created first, without `data`. |
| `next_page_token` | `nextPageToken` | `string` | Fetches the next page. Empty on the last page. |

### GetSessionStateRequest

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `session_id` | `sessionId` | `string` | The Session's ID. |
| `id` | `id` | `string` | The archive's ID, as `SessionState.id`. |

### ListArtifactsRequest

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `task_id` | `taskId` | `string` | Lists only this Task's artifacts. Empty lists every Task's. |
| `page_size` | `pageSize` | `int32` | At most this many artifacts; 0 means 20, and more than 100 means 100. |
| `page_token` | `pageToken` | `string` | The `next_page_token` of the previous page. |

### ListArtifactsResponse

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `artifacts` | `artifacts` | repeated [`Artifact`](#artifact) | The artifacts, the oldest first. |
| `next_page_token` | `nextPageToken` | `string` | Fetches the next page. Empty on the last page. |

### GetArtifactRequest

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `id` | `id` | `string` | The artifact's ID. |

### ResolveArtifactDownloadRequest

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `artifact_id` | `artifactId` | `string` | The artifact's ID. |
| `path` | `path` | `string` | The file's exact path within the artifact, as `ArtifactEntry.path`, at most 1,024 characters. |

### Task

One Task: a turn of a Session, and how it ran.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `id` | `id` | `string` | The Task's ID. |
| `resource_version` | `resourceVersion` | `string` | Changes whenever the view changes, apart from `storage`. Compare it for equality only. |
| `tag_id` | `tagId` | `string` | The ID of the Tag that runs it. |
| `tag` | `tag` | `string` | That Tag's name. Empty when the Tag no longer exists. |
| `session_id` | `sessionId` | `string` | Its Session's ID. |
| `objective_id` | `objectiveId` | `string` | The Objective its Session belongs to. Empty outside an Objective. |
| `status` | `status` | [`TaskStatus`](shared.md#taskstatus) | How it is doing. |
| `created_at` | `createdAt` | `google.protobuf.Timestamp` | When it was created. |
| `updated_at` | `updatedAt` | `google.protobuf.Timestamp` | When it last changed. |
| `started_at` | `startedAt` | `google.protobuf.Timestamp` | When it started running. Unset until it did. |
| `ended_at` | `endedAt` | `google.protobuf.Timestamp` | When it ended. Unset while it is open. |
| `execution` | `execution` | [`TaskExecution`](#taskexecution) | What the Task requires of the Worker that runs it, as recorded when it was accepted. |
| `trigger` | `trigger` | `google.protobuf.Struct` | What started the Task, as recorded when it was accepted: the inbound event, delegation or schedule, with its references. The record's fields depend on what started it, so it is a JSON object. Collaboration surfaces shape parts of it, so it is untrusted text. |
| `workspace` | `workspace` | [`TaskWorkspace`](#taskworkspace) | The named Workspace and the Task's branch, recorded when it was accepted. Unset for a Task without a named Workspace. |
| `outcome` | `outcome` | `google.protobuf.Struct` | How the Task ended, as the Control Plane recorded it: a JSON object such as `{"status": "completed"}` with the reason for a failure or cancellation. Unset while it is open. |
| `findings` | `findings` | [`TaskFindings`](#taskfindings) | The findings its result carries, or why they are unreadable. Unset when it has none. |
| `resolution` | `resolution` | [`ExecutionResolution`](#executionresolution) | How the harness, model and effort were chosen, and what the latest Task Attempt ran with. Unset when nothing was recorded. |
| `skills` | `skills` | repeated [`DeliveredSkill`](#deliveredskill) | Skills delivered to the latest Task Attempt. |
| `prepared_workspace` | `preparedWorkspace` | [`PreparedWorkspace`](#preparedworkspace) | The prepared Workspace environment the latest Task Attempt used, when its Worker reported one. |
| `attempts` | `attempts` | repeated [`TaskAttempt`](#taskattempt) | Every Task Attempt, oldest first. |
| `latest_attempt` | `latestAttempt` | [`LatestTaskAttempt`](#latesttaskattempt) | The latest Task Attempt in detail. Unset before one started. |
| `scheduling` | `scheduling` | [`SchedulingCheck`](#schedulingcheck) | The last placement check of the Task's requirements against the bound Worker Hosts. Unset before one was recorded. Clients show it while the Task is `TASK_STATUS_PENDING`. |
| `pull_request` | `pullRequest` | [`PullRequestDelivery`](shared.md#pullrequestdelivery) | The pull request a Worker opened for `WORKSPACE_DELIVERY_MODE_PULL_REQUEST` delivery, from the moment it was recorded, before `delivery` carries it. |
| `delivery` | `delivery` | [`TaskDelivery`](shared.md#taskdelivery) | What the Task delivered. Unset until the Worker recorded a delivery. |
| `storage` | `storage` | [`TaskStorage`](#taskstorage) | Where the latest Task Attempt's files and the Task's artifacts are kept. Set by `GetTask` only. |

### TaskExecution

What a Task requires of the Worker that runs it.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `harness` | `harness` | `string` | The harness, such as `codex`. Empty: any harness the profile offers. |
| `model` | `model` | `string` | The model the Worker passes to its harness. Empty: the host's default. |
| `effort` | `effort` | `string` | The reasoning effort, such as `low`. Empty: the harness's default. |
| `profile` | `profile` | [`WorkerProfileRef`](#workerprofileref) | The Worker Profile the Task must run with. Unset: any matching profile. |
| `requires` | `requires` | repeated [`CapabilityRequirement`](#capabilityrequirement) | Capabilities a Worker must have. |
| `prefers` | `prefers` | repeated [`CapabilityRequirement`](#capabilityrequirement) | Capabilities a Worker should have, used to choose between Workers. |
| `outputs` | `outputs` | [`OutputPolicy`](#outputpolicy) | Which files the Worker collects as outputs. Unset: none beyond the Workspace delivery. |
| `limits` | `limits` | [`ExecutionLimits`](#executionlimits) | Limits the harness must enforce. Unset: none. |

### WorkerProfileRef

A Worker Profile at one revision.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `id` | `id` | `string` | The profile's ID. |
| `revision` | `revision` | `string` | Its revision. |

### CapabilityRequirement

A Worker capability at a version.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `id` | `id` | `string` | The capability's ID, such as `supertag.execution.local-process`. |
| `version` | `version` | `int32` | Its version. |

### OutputPolicy

Which files a Worker collects as a Task's outputs. Paths and patterns are
relative to the Workspace.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `directory` | `directory` | `string` | The directory outputs are collected from. |
| `required` | `required` | repeated `string` | Patterns each of which must match at least one collected file. |
| `include` | `include` | repeated `string` | Further patterns to keep. |
| `exclude` | `exclude` | repeated `string` | Patterns to leave out. |
| `git` | `git` | [`OutputGitMode`](#outputgitmode) | What happens to the git state. |
| `max_files` | `maxFiles` | optional `int32` | At most this many files. Unset: the Worker's default. |
| `max_bytes` | `maxBytes` | optional `int64` | At most this many bytes. Unset: the Worker's default. |

### ExecutionLimits

Limits a harness enforces on one Task Attempt.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `max_native_agents` | `maxNativeAgents` | optional `int32` | At most this many native child agents. Unset: no limit. |
| `max_reported_tokens` | `maxReportedTokens` | optional `int64` | Interrupt once reported tokens reach this. A report may overshoot it. Unset: no limit. |
| `max_reported_cost` | `maxReportedCost` | [`Money`](shared.md#money) | The provider's budget over reported cost. Enforcement may stop after the budget is crossed. Unset: no limit. |

### TaskWorkspace

The named Workspace a Task works in.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `name` | `name` | `string` | The Workspace's name. |
| `branch` | `branch` | `string` | The Task's branch. |
| `ref` | `ref` | `string` | The ref the branch starts from, when the Workspace names one. |
| `delivery` | `delivery` | [`WorkspaceDeliveryMode`](shared.md#workspacedeliverymode) | How the Workspace delivers. |

### TaskFinding

One review finding a Task's result carries.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `id` | `id` | `string` | The finding's ID within the result, such as `F1`. |
| `severity` | `severity` | [`TaskFindingSeverity`](#taskfindingseverity) | How severe it is. |
| `summary` | `summary` | `string` | What was found, in one sentence. The Tag wrote it, so it is untrusted text. |
| `location` | `location` | `string` | Where, such as `file:line`, when the Tag said. |

### TaskFindings

The findings of a Task's result.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `findings` | `findings` | repeated [`TaskFinding`](#taskfinding) | The findings, high first, then medium, then low, each severity in the result's order. Empty when `unreadable` is set. |
| `unreadable` | `unreadable` | `string` | Why the stored findings do not validate. Empty when they do. |

### ExecutionResolution

How a Task's harness, model and effort were resolved when it was accepted,
and what its latest Task Attempt ran with.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `source` | `source` | [`ExecutionSource`](#executionsource) | Who chose them. Unspecified when nothing was recorded. |
| `chosen_by_tag_id` | `chosenByTagId` | `string` | The Tag that chose them, with `EXECUTION_SOURCE_CHOSEN`. Empty when the delegating actor was not a Tag. |
| `chosen_by_tag` | `chosenByTag` | `string` | That Tag's name. Empty when it no longer exists or `chosen_by_tag_id` is empty. |
| `harness` | `harness` | `string` | The harness. Empty: any. |
| `model` | `model` | `string` | The model. Empty: the host's default. |
| `effort` | `effort` | `string` | The effort. Empty: the harness's default. |
| `latest_attempt` | `latestAttempt` | [`AttemptExecution`](#attemptexecution) | What the latest Task Attempt ran with. Unset before one started. |

### AttemptExecution

What one Task Attempt ran with.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `harness` | `harness` | `string` | The harness. Empty when it was not recorded. |
| `model` | `model` | `string` | The model. Empty: the harness's default. |
| `model_source` | `modelSource` | [`ModelSource`](#modelsource) | Where the model came from. |
| `effort` | `effort` | `string` | The effort. Empty when none was asked for. |
| `effort_ignored` | `effortIgnored` | `string` | Why the effort was ignored, in one sentence, when the harness has no effort option. Empty otherwise. |

### DeliveredSkill

A Skill delivered to a Task Attempt.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `name` | `name` | `string` | The Skill's name. |
| `source` | `source` | `string` | Where it came from, such as `host service`. |
| `digest` | `digest` | `string` | Its `sha256:` digest. |

### PreparedWorkspace

A prepared Workspace environment as a Task Attempt's Worker reported it.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `digest` | `digest` | `string` | The environment's `sha256:` digest. |
| `provider` | `provider` | `string` | The environment provider, such as `local` or `e2b`. |
| `trusted_commit` | `trustedCommit` | `string` | The commit the environment was prepared from. |

### ReportedCost

Provider-reported cost of one Task Attempt.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `cost` | `cost` | [`Money`](shared.md#money) | The amount. |
| `estimated` | `estimated` | `bool` | Whether it comes from a model price estimate. |

### TaskAttempt

One Task Attempt.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `id` | `id` | `string` | The Task Attempt's ID. |
| `number` | `number` | `int32` | Its number within the Task, from 1. |
| `status` | `status` | [`TaskAttemptStatus`](shared.md#taskattemptstatus) | How it is doing. |
| `started_at` | `startedAt` | `google.protobuf.Timestamp` | When it started. |
| `ended_at` | `endedAt` | `google.protobuf.Timestamp` | When it ended. Unset while it runs. |
| `reported_cost` | `reportedCost` | [`ReportedCost`](#reportedcost) | Its provider-reported cost. Unset when none was reported. |
| `live_mounts` | `liveMounts` | repeated [`LiveMount`](#livemount) | Live sources attached at its start. |
| `mount_manifests` | `mountManifests` | repeated [`MountManifest`](#mountmanifest) | What the Workspace's `copy` mounts placed in its environment. Each lists at most its first 20 objects; `object_count` and `total_bytes` cover all of them. |
| `mount_output_manifests` | `mountOutputManifests` | repeated [`MountOutputManifest`](#mountoutputmanifest) | What it wrote back to the sources of `copy` mounts. |

### LiveMount

A live source attached to a Task Attempt: not a snapshot, so its content
is not pinned.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `volume` | `volume` | `string` | The Volume's name. |
| `source` | `source` | `string` | The Volume's source, without credentials. |
| `prefix` | `prefix` | `string` | The key prefix within the source. Empty: the entire source. |
| `path` | `path` | `string` | Where it is mounted in the environment. |
| `access` | `access` | [`MountAccess`](#mountaccess) | How it may be used. |
| `attached_at` | `attachedAt` | `google.protobuf.Timestamp` | When the provider attached it. |

### MountManifest

What one `copy` mount placed in a Task Attempt's environment.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `volume` | `volume` | `string` | The Volume's name. |
| `source` | `source` | `string` | The Volume's source when it was copied, never a credential. |
| `path` | `path` | `string` | Where the copy is in the environment. |
| `access` | `access` | [`MountAccess`](#mountaccess) | How it may be used. |
| `object_count` | `objectCount` | `int32` | How many objects were copied. |
| `total_bytes` | `totalBytes` | `int64` | How many bytes were copied. |
| `digest` | `digest` | `string` | The `sha256:` digest over the source and every object. Two Task Attempts that copied the same content have the same digest. |
| `copied_at` | `copiedAt` | `google.protobuf.Timestamp` | When it was copied. |
| `objects` | `objects` | repeated [`MountObject`](#mountobject) | The copied objects, in key order. |

### MountObject

One object a `copy` mount placed. The Worker reported it, so its text is
untrusted.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `key` | `key` | `string` | The key relative to the Volume's source. |
| `size` | `size` | `int64` | Its size in bytes. |
| `etag` | `etag` | `string` | The object store's ETag, when it reports one. |
| `version_id` | `versionId` | `string` | The object store's version ID, when versioning is on. |
| `sha256` | `sha256` | `string` | The `sha256:` digest of the copied bytes, for a source without ETags. |

### MountOutputManifest

What a Task Attempt wrote back to one `copy` mount's source.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `volume` | `volume` | `string` | The Volume's name. |
| `source` | `source` | `string` | The Volume's source, never a credential. |
| `path` | `path` | `string` | Where the copy was in the environment. |
| `status` | `status` | [`MountOutputStatus`](#mountoutputstatus) | How the write-back ended. |
| `uploaded_at` | `uploadedAt` | `google.protobuf.Timestamp` | When it ended. |
| `objects` | `objects` | repeated [`MountUpload`](#mountupload) | The objects uploaded. |
| `skipped` | `skipped` | `int32` | Unchanged objects not uploaded. |
| `error` | `error` | [`MountUploadError`](#mountuploaderror) | The object that failed and why, including a refused bound. Unset when none failed. |
| `not_attempted` | `notAttempted` | repeated `string` | Changed keys not uploaded, the failed key included. |

### MountUpload

One object a Task Attempt uploaded to a mount's source.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `key` | `key` | `string` | The key relative to the Volume's source. |
| `size` | `size` | `int64` | Its size in bytes. |
| `sha256` | `sha256` | `string` | The `sha256:` digest of its bytes. |

### MountUploadError

Why a write-back to a mount's source failed.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `key` | `key` | `string` | The key that failed. |
| `reason` | `reason` | `string` | Why, as the Worker Host reported it. |

### LatestTaskAttempt

The latest Task Attempt of a Task, in detail.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `id` | `id` | `string` | The Task Attempt's ID. |
| `number` | `number` | `int32` | Its number within the Task, from 1. |
| `status` | `status` | [`TaskAttemptStatus`](shared.md#taskattemptstatus) | How it is doing. |
| `worker_profile` | `workerProfile` | [`WorkerProfileRef`](#workerprofileref) | The Worker Profile it runs with. |
| `durable_execution` | `durableExecution` | `bool` | Whether its Worker journals execution, so the Control Plane can recover its events and `InspectTaskExecution` can read its receipt. |
| `failure` | `failure` | [`RecordedEvent`](#recordedevent) | The failure its Worker recorded. Unset when none was. |
| `warnings` | `warnings` | repeated [`RecordedEvent`](#recordedevent) | Problems its Worker recorded that did not change the outcome, such as an incomplete native archive, at most 8, oldest first. |
| `running_command` | `runningCommand` | [`RunningCommand`](#runningcommand) | The command it reports running now. Unset unless it runs one. |
| `worker_id` | `workerId` | `string` | The Worker that runs it. Empty when not recorded. |
| `worker_host_id` | `workerHostId` | `string` | The Worker Host that runs it. Empty when not recorded. |
| `worklet_id` | `workletId` | `string` | The Worklet that runs it. Empty when not recorded. |
| `selection` | `selection` | [`PlacementSelection`](#placementselection) | How the Worker Host was selected. Unset when not recorded. |
| `last_event` | `lastEvent` | [`TaskEventRef`](#taskeventref) | Its most recent event. Unset when it has none. |
| `placement` | `placement` | [`ExecutionPlacement`](#executionplacement) | Where its harness and tools ran, and whether cleanup is confirmed. |

### RecordedEvent

A message a Worker recorded on a Task Attempt.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `message` | `message` | `string` | The message. The Worker applied its redaction policy; it is untrusted text. |
| `at` | `at` | `google.protobuf.Timestamp` | When it was recorded. |
| `sequence` | `sequence` | `int64` | The `TaskEvent.sequence` it was recorded in. |

### RunningCommand

A command a running Task Attempt reports running.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `command` | `command` | `string` | The command, on one line. The Tag wrote it, so it is untrusted text. |
| `started_at` | `startedAt` | `google.protobuf.Timestamp` | When the Control Plane recorded its start. |

### PlacementSelection

How a Task Attempt's Worker Host was selected.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `allowed_worker_host_ids` | `allowedWorkerHostIds` | repeated `string` | The Worker Hosts that could have run it. |
| `reservation` | `reservation` | [`PlacementReservation`](#placementreservation) | The capacity reservation it was placed with. Unset when none was recorded. |

### PlacementReservation

A reservation of Worker Host capacity for a Task Attempt.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `id` | `id` | `string` | The reservation's ID. |
| `expires_at` | `expiresAt` | `google.protobuf.Timestamp` | When it expires unless used. |
| `phase` | `phase` | [`PlacementReservationPhase`](#placementreservationphase) | Where it stands. |

### TaskEventRef

Names one recorded Task event.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `type` | `type` | `string` | The event's type, such as `execution.completed`. |
| `sequence` | `sequence` | `int64` | Its `TaskEvent.sequence`. |
| `at` | `at` | `google.protobuf.Timestamp` | When it was recorded. |

### ExecutionPlacement

Where a Task Attempt's harness and tools ran.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `status` | `status` | [`PlacementStatus`](#placementstatus) | Whether the placement is known. |
| `mode` | `mode` | [`PlacementMode`](#placementmode) | Whether harness and tools ran in one environment. Unspecified until known. |
| `cleanup` | `cleanup` | [`CleanupStatus`](#cleanupstatus) | Whether execution is confirmed stopped. |
| `cleanup_failure` | `cleanupFailure` | [`CleanupFailure`](#cleanupfailure) | The cleanup failure its Worker recorded. Unset when none was. |
| `harness` | `harness` | [`HarnessIdentity`](#harnessidentity) | The harness that ran. Unset until known. |
| `harness_runtime` | `harnessRuntime` | [`ExecutionEnvironment`](#executionenvironment) | The environment the harness ran in. With `PLACEMENT_MODE_COLOCATED` it is `execution_environment`. Unset until known. |
| `execution_environment` | `executionEnvironment` | [`ExecutionEnvironment`](#executionenvironment) | The environment the tools and Workspace ran in. Unset until known. |

### CleanupFailure

A cleanup failure a Worker recorded.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `sequence` | `sequence` | `int64` | The `TaskEvent.sequence` it was recorded in. |
| `at` | `at` | `google.protobuf.Timestamp` | When it was recorded. |
| `summary` | `summary` | `string` | What failed, in one sentence. |
| `items` | `items` | repeated [`CleanupItem`](#cleanupitem) | What could not be cleaned up, at most 8. |

### CleanupItem

One thing a Worker could not clean up.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `id` | `id` | `string` | Its ID within the failure, such as `cleanup-1`. |
| `text` | `text` | `string` | What it is, at most 160 characters. Untrusted text. |

### HarnessIdentity

A harness that ran a Task Attempt.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `id` | `id` | `string` | The harness's ID, such as `codex`. |
| `version` | `version` | `string` | Its version. |
| `provenance` | `provenance` | `google.protobuf.Struct` | What the Worker reported about how it was resolved, such as the MCP clients it configured, as a JSON object. Set by `InspectTaskExecution` only. |

### ExecutionEnvironment

An environment a Task Attempt ran in.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `id` | `id` | `string` | The environment's ID, as its provider names it. |
| `provider` | `provider` | `string` | The provider, such as `local-harness-runtime` or `e2b`. |
| `placement` | `placement` | [`EnvironmentPlacement`](#environmentplacement) | Where it runs. |
| `provenance` | `provenance` | `google.protobuf.Struct` | Credential-free identity and lifetime evidence from the provider, as a JSON object. Set by `InspectTaskExecution` only. |

### SchedulingCheck

The last check of a Task's requirements against its Tag's bound Worker
Hosts.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `status` | `status` | [`SchedulingStatus`](#schedulingstatus) | Whether a bound Worker Host can place it. |
| `unmet_requirements` | `unmetRequirements` | repeated `string` | The requirements no bound Worker Host meets, such as `labels:gpu` or `workspace.checkout-or-clone:NAME`. |
| `reason` | `reason` | `string` | Why the Task waits, in one sentence, with `SCHEDULING_STATUS_INCOMPATIBLE`. Empty otherwise. |
| `unsandboxed_commands` | `unsandboxedCommands` | repeated [`UnsandboxedCommandHold`](#unsandboxedcommandhold) | Worker Hosts whose matching harnesses would run commands unsandboxed without the host's opt-in, with `SCHEDULING_STATUS_INCOMPATIBLE`. |
| `workspace_refusals` | `workspaceRefusals` | repeated `string` | Why Workspace environment providers refuse the Task, each in one sentence, with `SCHEDULING_STATUS_INCOMPATIBLE`. |
| `observed_at` | `observedAt` | `google.protobuf.Timestamp` | When the check ran. |
| `sequence` | `sequence` | `int64` | The `TaskEvent.sequence` it was recorded in. |

### UnsandboxedCommandHold

A Worker Host whose matching harnesses run commands unsandboxed, which
its host service has not allowed.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `worker_host_id` | `workerHostId` | `string` | The Worker Host's ID. |
| `harnesses` | `harnesses` | repeated `string` | The harnesses. |

### TaskStorage

Where a Task's files and artifacts are kept. The Control Plane is never
one of the places.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `task_files` | `taskFiles` | [`TaskFiles`](#taskfiles) | Where the latest Task Attempt's files are. Unset before a Task Attempt recorded its Worker Host. |
| `artifacts` | `artifacts` | repeated [`TaskArtifactStorage`](#taskartifactstorage) | The Task's artifacts, at most 20, oldest first. |
| `more_artifacts` | `moreArtifacts` | `bool` | The Task captured more artifacts than `artifacts` shows. List them with `ListArtifacts` and `task_id`. |

### TaskFiles

Where a Task Attempt's files are: a Workspace checkout on its Worker Host,
or a remote sandbox.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `worker_host_id` | `workerHostId` | `string` | The Worker Host that ran the Task Attempt. |
| `ephemeral` | `ephemeral` | `bool` | Whether that Worker Host joined with an ephemeral Auth Key, so its files are lost when it stops. |
| `sandbox` | `sandbox` | `string` | The remote sandbox provider the Task Attempt ran in, whose files are lost when the sandbox stops. Empty for files on the Worker Host. |
| `placement_unknown` | `placementUnknown` | `bool` | The Control Plane has no placement record for the Task Attempt, so where its files are is unknown. |

### TaskArtifactStorage

Where one of a Task's artifacts is kept.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `artifact_id` | `artifactId` | `string` | The artifact's ID. |
| `title` | `title` | `string` | Its title. The Tag wrote it, so it is untrusted text. |
| `files` | `files` | `int32` | How many files it has. |
| `copies` | `copies` | repeated [`ArtifactCopy`](#artifactcopy) | Where its copies are. |
| `ephemeral_only` | `ephemeralOnly` | `bool` | Some file is held only on an ephemeral Worker Host, with no Volume copy, so it may be lost or already gone. |

### ArtifactCopy

One place an artifact's files are kept.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `worker_host` | `workerHost` | [`WorkerHostCopy`](#workerhostcopy) | One of `place`. On a Worker Host. |
| `volume` | `volume` | [`VolumeCopy`](#volumecopy) | One of `place`. On a Volume. |

Oneof `place`: `worker_host`, `volume`. Where the copy is. Exactly one is set.

### WorkerHostCopy

An artifact copy on a Worker Host.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `worker_host_id` | `workerHostId` | `string` | The Worker Host's ID. |
| `ephemeral` | `ephemeral` | `bool` | Whether the Worker Host joined with an ephemeral Auth Key, so the copy is lost when it stops. |
| `removed` | `removed` | `bool` | Whether the Worker Host was removed, so the copy is gone. |

### VolumeCopy

An artifact copy on a Volume.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `volume` | `volume` | `string` | The Volume's name, or its ID when the name is not known. |

### TaskEvent

One event recorded about a Task or one of its Task Attempts.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `id` | `id` | `string` | The event's ID. |
| `task_id` | `taskId` | `string` | The Task's ID. |
| `attempt_id` | `attemptId` | `string` | The Task Attempt it is about. Empty for an event about the Task. |
| `sequence` | `sequence` | `int64` | Its place in the Task's events, from 1. |
| `type` | `type` | `string` | What happened, such as `task.created`, `execution.started` or `command.updated`. |
| `payload` | `payload` | `google.protobuf.Struct` | The event's record, a JSON object whose fields depend on `type`. Worker events carry what the Worker reported after its redaction policy, so they are untrusted text. Unset for an event without one. |
| `created_at` | `createdAt` | `google.protobuf.Timestamp` | When it was recorded. |

### InspectTaskExecutionResponse

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `availability` | `availability` | [`TaskExecutionAvailability`](#taskexecutionavailability) | Whether the receipt could be read. |
| `attempt_id` | `attemptId` | `string` | The latest Task Attempt's ID. Empty before one started. |
| `receipt` | `receipt` | `google.protobuf.Struct` | The Worker's durable execution receipt, as a JSON object with its status and the last journal sequence, with `TASK_EXECUTION_AVAILABILITY_AVAILABLE`. |
| `limits` | `limits` | [`ExecutionLimitReport`](#executionlimitreport) | How the latest Task Attempt ran against its execution limits, from recorded events only. |
| `placement` | `placement` | [`ExecutionPlacement`](#executionplacement) | Where it ran, with the harness's and environments' provenance. |

### ExecutionLimitReport

How a Task Attempt ran against its execution limits.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `requested` | `requested` | [`ExecutionLimits`](#executionlimits) | The limits the Task asked for. |
| `applied` | `applied` | [`AppliedExecutionLimits`](#appliedexecutionlimits) | The limits the harness reported it installed. Unset when it reported none. |
| `observed` | `observed` | [`ExecutionObservation`](#executionobservation) | What was observed. |
| `completeness` | `completeness` | [`LimitCompleteness`](#limitcompleteness) | How complete the evidence is. |
| `outcome` | `outcome` | [`LimitOutcome`](#limitoutcome) | What the evidence shows. |

### AppliedExecutionLimits

The limits a harness installed for a Task Attempt.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `max_native_agents` | `maxNativeAgents` | [`AppliedLimit`](#appliedlimit) | The native child agent limit. Unset when none was installed. |
| `max_reported_tokens` | `maxReportedTokens` | [`AppliedLimit`](#appliedlimit) | The reported token limit. Unset when none was installed. |
| `max_reported_cost` | `maxReportedCost` | [`AppliedCostLimit`](#appliedcostlimit) | The reported cost limit. Unset when none was installed. |

### AppliedLimit

A count limit a harness installed.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `limit` | `limit` | `int64` | The limit. |
| `method` | `method` | `string` | How it is enforced: `provider-native`, `harness-guard` or `interrupt-on-report`. |

### AppliedCostLimit

A cost limit a harness installed.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `limit` | `limit` | [`Money`](shared.md#money) | The limit. |
| `method` | `method` | `string` | How it is enforced: `provider-budget`. |

### ExecutionObservation

What a Task Attempt was observed to use.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `usage` | `usage` | [`ExecutionUsage`](#executionusage) | The usage its harness last reported. Unset when it reported none. |
| `peak_native_agents` | `peakNativeAgents` | `int32` | The most native child agents active at once. |

### ExecutionUsage

Cumulative usage a harness reported for one Task Attempt, excluding
earlier history. Not a billing record.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `input_tokens` | `inputTokens` | `int64` | Input tokens. |
| `output_tokens` | `outputTokens` | `int64` | Output tokens, reasoning tokens included. |
| `cached_input_tokens` | `cachedInputTokens` | `int64` | Input tokens served from the provider's cache. |
| `cache_write_tokens` | `cacheWriteTokens` | optional `int64` | Tokens written to the provider's prompt cache. Unset when not reported. |
| `reasoning_tokens` | `reasoningTokens` | optional `int64` | Reasoning tokens, part of `output_tokens`. Unset when not reported. |
| `total_tokens` | `totalTokens` | `int64` | All tokens. |
| `complete` | `complete` | `bool` | False when the reports do not cover the whole Task Attempt and every child agent. |
| `reported_cost` | `reportedCost` | [`ReportedCost`](#reportedcost) | The provider-reported cost. Unset when none was reported. |
| `unpriced_model` | `unpricedModel` | `string` | A model the harness has no price for, so cost is unknown. Empty otherwise. |

### LimitCompleteness

How complete the evidence about a Task Attempt's limits is.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `applied` | `applied` | `bool` | Every requested limit has evidence of the harness control that enforced it. |
| `usage` | `usage` | optional `bool` | Whether usage reports are complete. Unset when no token or cost limit was requested or installed. |
| `terminal` | `terminal` | `bool` | Whether the Task Attempt ended. |
| `complete` | `complete` | `bool` | Whether every requested or installed limit can be classified. |

### LimitOutcome

The outcome of a Task Attempt's limits.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `status` | `status` | [`LimitOutcomeStatus`](#limitoutcomestatus) | What the evidence shows. |
| `threshold_reached` | `thresholdReached` | [`LimitThresholds`](#limitthresholds) | Which limits were reached. Each is unset when the evidence cannot yet tell, or no such limit applies. |

### LimitThresholds

Which limits a Task Attempt reached.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `max_native_agents` | `maxNativeAgents` | optional `bool` | The native child agent limit. |
| `max_reported_tokens` | `maxReportedTokens` | optional `bool` | The reported token limit. |
| `max_reported_cost` | `maxReportedCost` | optional `bool` | The reported cost limit. |

### Session

One Session.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `id` | `id` | `string` | The Session's ID. |
| `resource_version` | `resourceVersion` | `string` | Changes whenever the Session changes. Compare it for equality only. |
| `tag_id` | `tagId` | `string` | The ID of its Tag. |
| `tag` | `tag` | `string` | That Tag's name. Empty when the Tag no longer exists. |
| `session_key` | `sessionKey` | `string` | The key its turns are routed by, such as a thread or a CLI conversation. |
| `origin` | `origin` | `google.protobuf.Struct` | Where it started, as recorded when it opened: a JSON object whose fields depend on what started it, such as a work Session's `title`. Collaboration surfaces shape parts of it, so it is untrusted text. |
| `phase` | `phase` | [`SessionPhase`](#sessionphase) | Where it stands. |
| `audience` | `audience` | [`SessionAudience`](#sessionaudience) | Who its replies are for. |
| `parent_session_id` | `parentSessionId` | `string` | The Session that started this work Session. Empty for a Session no turn started. |
| `objective_id` | `objectiveId` | `string` | The Objective it belongs to: the Objective's own conversation, or a work Session started under it. Empty otherwise. |
| `title` | `title` | `string` | A work Session's title, or how the Session began, such as its first request shortened to 60 characters, `Objective ID` or `Inbox`. Empty when there is nothing to name it by. Untrusted text. |
| `latest_task_id` | `latestTaskId` | `string` | Its latest Task's ID. Empty before it has one. |
| `latest_task_status` | `latestTaskStatus` | [`TaskStatus`](shared.md#taskstatus) | Its latest Task's status. Unspecified before it has one. |
| `last_interaction_at` | `lastInteractionAt` | `google.protobuf.Timestamp` | When it last had a turn. |
| `created_at` | `createdAt` | `google.protobuf.Timestamp` | When it was created. |
| `updated_at` | `updatedAt` | `google.protobuf.Timestamp` | When it last changed. |
| `delivery` | `delivery` | [`SessionDelivery`](#sessiondelivery) | What its latest delivering Task delivered. Set by `GetSession` only, and unset when no Task of it delivered anything. |

### SessionDelivery

What a Session's latest delivering Task delivered, for review. A client
shows the branch's changes by diffing `base` and `head` of
`delivery.workspace` in its own checkout of the Workspace; the Control
Plane keeps no repository contents.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `task_id` | `taskId` | `string` | The Task that delivered it: the latest Task of the Session whose delivery the Worker recorded. |
| `delivery` | `delivery` | [`TaskDelivery`](shared.md#taskdelivery) | What it delivered: the Workspace branch with its base and head commits, patches, the pull request with its web address, and outputs. |
| `checkout` | `checkout` | [`TaskFiles`](#taskfiles) | Where the branch's checkout is. Unset when the Task Attempt recorded no Worker Host. |

### SessionState

What a harness saved of its own conversation after one Task Attempt. It
keeps conversation state, not Workspace files.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `id` | `id` | `string` | The archive's ID. |
| `session_id` | `sessionId` | `string` | Its Session's ID. |
| `task_id` | `taskId` | `string` | The Task that produced it. |
| `attempt_id` | `attemptId` | `string` | The Task Attempt that produced it. |
| `harness_id` | `harnessId` | `string` | The harness that saved it, such as `codex`. |
| `native_id` | `nativeId` | `string` | The harness's own ID for the conversation. Empty when the harness has none. |
| `ref` | `ref` | `google.protobuf.Struct` | How the harness refers to the archive, as a JSON object with its `id`, `format` and `uri`. |
| `status` | `status` | [`SessionStateStatus`](#sessionstatestatus) | Whether it can resume. |
| `write_version` | `writeVersion` | `int64` | Orders the archive's writes; a later write has a higher version. |
| `compatibility` | `compatibility` | `string` | What a resuming harness must be compatible with. Empty until it is resumable. |
| `worker_profile` | `workerProfile` | [`WorkerProfileRef`](#workerprofileref) | The Worker Profile that produced it. Unset until it is resumable. |
| `created_at` | `createdAt` | `google.protobuf.Timestamp` | When it was created. |
| `updated_at` | `updatedAt` | `google.protobuf.Timestamp` | When it last changed. |
| `data` | `data` | `google.protobuf.Struct` | The archive itself, a JSON object in the harness's own format. It holds the native conversation, tool results included, so it is sensitive and untrusted. Set by `GetSessionState` only. |

### Artifact

One captured artifact: immutable files a Task Attempt produced. The
catalog records what the files are; Worker Hosts and Volumes keep the
bytes.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `id` | `id` | `string` | The artifact's ID. |
| `task_id` | `taskId` | `string` | The Task that captured it. |
| `attempt_id` | `attemptId` | `string` | The Task Attempt that captured it. |
| `tag_id` | `tagId` | `string` | The ID of the Tag that ran it. |
| `objective_id` | `objectiveId` | `string` | The Objective it belongs to. Empty outside an Objective. |
| `session_id` | `sessionId` | `string` | Its Session's ID. |
| `operation_id` | `operationId` | `string` | The Worker's ID for the capture, which makes a repeated capture idempotent. |
| `harness_session` | `harnessSession` | [`HarnessSession`](#harnesssession) | The harness conversation that produced it. Unset when not reported. |
| `title` | `title` | `string` | Its title. The Tag wrote it, so it is untrusted text. |
| `summary` | `summary` | `string` | Its summary. Untrusted text. Empty without one. |
| `kind` | `kind` | `string` | What kind of artifact it is, such as `patch` or `output`. |
| `entries` | `entries` | repeated [`ArtifactEntry`](#artifactentry) | Its files, by path. |
| `inputs` | `inputs` | repeated [`ArtifactSelection`](#artifactselection) | Files of other artifacts that were supplied to the Task Attempt, which does not mean each was used. |
| `created_at` | `createdAt` | `google.protobuf.Timestamp` | When it was captured. |
| `copies` | `copies` | repeated [`ArtifactCopy`](#artifactcopy) | Where its copies are. |
| `ephemeral_only` | `ephemeralOnly` | `bool` | Some file is held only on an ephemeral Worker Host, with no Volume copy, so it may be lost or already gone. |

### HarnessSession

A harness conversation, by its native ID.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `harness_id` | `harnessId` | `string` | The harness, such as `codex`. |
| `id` | `id` | `string` | The harness's ID for the conversation. |

### ArtifactEntry

One file of an artifact.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `path` | `path` | `string` | Its path within the artifact. |
| `uri` | `uri` | `string` | Its content address, `supertag-artifact:` and its digest. |
| `digest` | `digest` | `string` | Its `sha256:` digest. |
| `size_bytes` | `sizeBytes` | `int64` | Its size in bytes. |
| `media_type` | `mediaType` | `string` | Its media type, when the Worker recorded one. |

### ArtifactSelection

Files selected from one artifact.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `artifact_id` | `artifactId` | `string` | The artifact's ID. |
| `paths` | `paths` | repeated `string` | The files' paths. |

### ArtifactDownload

Where the caller can read one artifact file. See `ResolveArtifactDownload`.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `artifact_id` | `artifactId` | `string` | The artifact's ID. |
| `path` | `path` | `string` | The file's path within the artifact. |
| `digest` | `digest` | `string` | The file's `sha256:` digest. A client keeps only bytes that match it. |
| `size_bytes` | `sizeBytes` | `int64` | The file's size in bytes. |
| `transfers` | `transfers` | repeated [`ArtifactTransfer`](#artifacttransfer) | The serving Worker Hosts' transfer endpoints, each with a grant. |
| `volumes` | `volumes` | repeated [`ArtifactVolumeLocation`](#artifactvolumelocation) | Copies on Volumes, which the client reads with its own credentials. |
| `holders` | `holders` | [`ArtifactHolders`](#artifactholders) | Where the file is held, for a client that can reach none of the copies. |
| `expires_at` | `expiresAt` | `google.protobuf.Timestamp` | When the grants expire. |

### ArtifactTransfer

A Worker Host transfer endpoint that serves one artifact file.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `worker_host_id` | `workerHostId` | `string` | The Worker Host's ID. |
| `transfer_url` | `transferUrl` | `string` | The endpoint's address. |
| `grant` | `grant` | `string` | The grant to present to the endpoint, for this file and caller only, until `ArtifactDownload.expires_at`. It is a credential: clients never log or store it. |

### ArtifactVolumeLocation

An artifact file's copy on a Volume.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `volume` | `volume` | `string` | The Volume's name. |
| `source` | `source` | `string` | The Volume's source, such as `s3://bucket/prefix/`. |
| `credential` | `credential` | `string` | The name of the Volume's credential, which the reading machine maps to its own secret. Never a value. Empty when the Volume names none. |
| `key` | `key` | `string` | The copy's key beneath `source`. |

### ArtifactHolders

Where an artifact file is held.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `worker_host_ids` | `workerHostIds` | repeated `string` | Worker Hosts holding a copy, the one whose Task Attempt captured it first. |
| `volumes` | `volumes` | repeated `string` | Volumes holding a copy, by name. |

## Enums

### OutputGitMode

What the Worker does with the Workspace's git state when it collects
outputs.

| Value | Description |
| --- | --- |
| `OUTPUT_GIT_MODE_UNSPECIFIED` |  |
| `OUTPUT_GIT_MODE_REFERENCE` | Records the commit, without its files. |
| `OUTPUT_GIT_MODE_CAPTURE` | Captures the git state as an artifact. |
| `OUTPUT_GIT_MODE_IGNORE` | Leaves git state out. |

### TaskFindingSeverity

How severe a Task finding is.

| Value | Description |
| --- | --- |
| `TASK_FINDING_SEVERITY_UNSPECIFIED` |  |
| `TASK_FINDING_SEVERITY_HIGH` | High. `supertag describe objective` and `OrganizationService.GetOrganization` list the high findings of each Session's latest result. |
| `TASK_FINDING_SEVERITY_MEDIUM` | Medium. |
| `TASK_FINDING_SEVERITY_LOW` | Low. |

### ExecutionSource

Who chose a Task's harness, model and effort.

| Value | Description |
| --- | --- |
| `EXECUTION_SOURCE_UNSPECIFIED` |  |
| `EXECUTION_SOURCE_DEFAULT` | The Tag's or Role's defaults. |
| `EXECUTION_SOURCE_CHOSEN` | The delegating actor chose them. |

### ModelSource

Where a Task Attempt's model came from.

| Value | Description |
| --- | --- |
| `MODEL_SOURCE_UNSPECIFIED` |  |
| `MODEL_SOURCE_TASK` | The Task named it. |
| `MODEL_SOURCE_HOST_DEFAULT` | The Worker Host's default for the profile. |

### MountAccess

How a mount may be used.

| Value | Description |
| --- | --- |
| `MOUNT_ACCESS_UNSPECIFIED` |  |
| `MOUNT_ACCESS_READ_ONLY` | Nothing the Task changes is saved to the Volume's source. |
| `MOUNT_ACCESS_READ_WRITE` | Changes are saved to the Volume's source. |

### MountOutputStatus

How a write-back to a `copy` mount's source ended.

| Value | Description |
| --- | --- |
| `MOUNT_OUTPUT_STATUS_UNSPECIFIED` |  |
| `MOUNT_OUTPUT_STATUS_COMPLETE` | Every changed object was uploaded. |
| `MOUNT_OUTPUT_STATUS_PARTIAL` | Some changed objects were uploaded. |
| `MOUNT_OUTPUT_STATUS_REFUSED` | The Worker Host refused the upload, such as for a bound it exceeded. |

### PlacementReservationPhase

Where a placement reservation stands.

| Value | Description |
| --- | --- |
| `PLACEMENT_RESERVATION_PHASE_UNSPECIFIED` |  |
| `PLACEMENT_RESERVATION_PHASE_RESERVED` | Held for the Task Attempt. |
| `PLACEMENT_RESERVATION_PHASE_CONSUMED` | Used: the Task Attempt started on the reserved Worker Host. |
| `PLACEMENT_RESERVATION_PHASE_EXPIRED` | It expired before it was used. |

### PlacementStatus

Whether a Task Attempt's placement is known.

| Value | Description |
| --- | --- |
| `PLACEMENT_STATUS_UNSPECIFIED` |  |
| `PLACEMENT_STATUS_NOT_STARTED` | No Task Attempt started. |
| `PLACEMENT_STATUS_PENDING` | It runs, and its Worker has not reported where yet. |
| `PLACEMENT_STATUS_AVAILABLE` | Its Worker reported where it runs. |
| `PLACEMENT_STATUS_UNKNOWN` | It ended without reporting where it ran. |

### PlacementMode

Whether a Task Attempt's harness and tools ran in one environment.

| Value | Description |
| --- | --- |
| `PLACEMENT_MODE_UNSPECIFIED` |  |
| `PLACEMENT_MODE_COLOCATED` | In one environment. |
| `PLACEMENT_MODE_SPLIT` | The harness in one, its tools and Workspace in another. |

### CleanupStatus

Whether a Task Attempt's execution is confirmed stopped and cleaned up.

| Value | Description |
| --- | --- |
| `CLEANUP_STATUS_UNSPECIFIED` |  |
| `CLEANUP_STATUS_NOT_STARTED` | No Task Attempt started. |
| `CLEANUP_STATUS_PENDING` | It runs. |
| `CLEANUP_STATUS_CONFIRMED` | A terminal execution event is recorded, which the Worker sends only after closing both environments. |
| `CLEANUP_STATUS_UNKNOWN` | Neither is recorded, or cleanup failed. Missing evidence does not prove execution stopped. |

### EnvironmentPlacement

Where an execution environment runs.

| Value | Description |
| --- | --- |
| `ENVIRONMENT_PLACEMENT_UNSPECIFIED` |  |
| `ENVIRONMENT_PLACEMENT_LOCAL` | On the Worker Host. |
| `ENVIRONMENT_PLACEMENT_REMOTE` | In a remote sandbox, such as E2B or Modal. |
| `ENVIRONMENT_PLACEMENT_MANAGED` | In an environment the provider manages, whose location is not reported. |

### SchedulingStatus

Whether the bound Worker Hosts can place a Task.

| Value | Description |
| --- | --- |
| `SCHEDULING_STATUS_UNSPECIFIED` |  |
| `SCHEDULING_STATUS_COMPATIBLE` | A bound Worker Host meets every requirement. |
| `SCHEDULING_STATUS_INCOMPATIBLE` | None does. The Task waits. |

### TaskExecutionAvailability

Whether a Task Attempt's execution receipt could be read.

| Value | Description |
| --- | --- |
| `TASK_EXECUTION_AVAILABILITY_UNSPECIFIED` |  |
| `TASK_EXECUTION_AVAILABILITY_NOT_STARTED` | No Task Attempt started. |
| `TASK_EXECUTION_AVAILABILITY_UNSUPPORTED` | The latest Task Attempt does not journal execution, so it has no receipt. |
| `TASK_EXECUTION_AVAILABILITY_UNAVAILABLE` | The Worker Host that ran it could not be reached, or has no receipt. |
| `TASK_EXECUTION_AVAILABILITY_AVAILABLE` | `receipt` carries the receipt. |

### LimitOutcomeStatus

What the evidence shows about a Task Attempt's limits.

| Value | Description |
| --- | --- |
| `LIMIT_OUTCOME_STATUS_UNSPECIFIED` |  |
| `LIMIT_OUTCOME_STATUS_NOT_REQUESTED` | No limit was requested or installed. |
| `LIMIT_OUTCOME_STATUS_PENDING` | The Task Attempt runs; the outcome is not known yet. |
| `LIMIT_OUTCOME_STATUS_WITHIN_LIMITS` | It stayed within every limit. |
| `LIMIT_OUTCOME_STATUS_THRESHOLD_REACHED` | It reached at least one limit. |
| `LIMIT_OUTCOME_STATUS_UNKNOWN` | The evidence cannot tell. |

### SessionPhase

Where a Session stands.

| Value | Description |
| --- | --- |
| `SESSION_PHASE_UNSPECIFIED` |  |
| `SESSION_PHASE_OPEN` | It takes new turns. |

### SessionAudience

Who a Session's replies are for.

| Value | Description |
| --- | --- |
| `SESSION_AUDIENCE_UNSPECIFIED` |  |
| `SESSION_AUDIENCE_SHARED` | Everyone in its location. |
| `SESSION_AUDIENCE_PRIVATE` | The one requester who started it. |

### SessionStateStatus

Whether a native archive can resume.

| Value | Description |
| --- | --- |
| `SESSION_STATE_STATUS_UNSPECIFIED` |  |
| `SESSION_STATE_STATUS_STORED` | Stored, and not verified for resumption. |
| `SESSION_STATE_STATUS_RESUMABLE` | A later Task of the Session resumes it with the same harness, reply audience and Workspace. |
