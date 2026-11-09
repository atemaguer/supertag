# Control Plane API Server

The **API Server** is the part of the **Control Plane**, the service that stores and coordinates a
SuperTag [organization](glossary.md#autonomous-organization), that exposes one versioned management
and resource API for local CLIs, hosted deployments, dashboards, and automation. Most users should
use `supertag` commands rather than call these endpoints themselves.

The API Server handles operator authentication, request validation, accepted work, resource
representation, and status. The CLI never edits Control Plane database rows or external tool
credentials directly. Database migration remains an operator deployment action.

The API Server also owns the **Worklet API**, the authenticated protocol through which a
**Worklet** (supervisor) connects a **Worker Host** (a machine or sandbox that provides execution
capacity). The **Gateway**, which carries traffic to and from external work tools, currently shares
one process, deployment, and HTTP listener with the API Server. It does not define the API behavior
documented here.

Other terms on this page are defined in the glossary: [Tag](glossary.md#tag),
[Role](glossary.md#role), [Objective](glossary.md#objective), [Team](glossary.md#team),
[Workstream](glossary.md#workstream), [Mailbox](glossary.md#mailbox), [Task](glossary.md#task),
[Task Attempt](glossary.md#task-attempt), [Session](glossary.md#session),
[Context Set](glossary.md#context-set), [Permission Set](glossary.md#permission-set),
[Surface Account](glossary.md#surface-account), [host service](glossary.md#host-service),
[Auth Key](glossary.md#auth-key), [admin token](glossary.md#admin-token),
[Operator Token](glossary.md#operator-token), [Worker Profile](glossary.md#worker-profile),
[Worker](glossary.md#worker), [Volume](glossary.md#volume), [Workspace](glossary.md#workspace), and
[Runtime Input](glossary.md#runtime-input).

## Authentication

Every management and resource request requires an operator credential:

```http
Authorization: Bearer <admin-token-or-operator-token>
```

Use HTTPS outside loopback. Set `SUPERTAG_ADMIN_TOKEN` for every non-loopback Control Plane. A
loopback Control Plane generates a local credential under `~/.supertag` when none is configured.

The admin token may call every RPC. An [Operator Token](resource-model.md#operator-tokens),
a `stop_` secret, may call every one except [`AccessService`](#operator-tokens), which refuses it
with `permission_denied`. A revoked or expired Operator Token is refused as unauthenticated, with a
message that says which. Scoped coordination
credentials reach only the RPCs that accept them. The Control Plane records the caller as
`control-plane-break-glass`, `token:NAME`, or the scoped credential's `operatorId` on approvals,
Objective messages, and Objective and Team changes, and in the [audit log](#audit-log) entry for
every management write. See [Manage a remote Control Plane](../operations/control-plane.md#manage-a-remote-control-plane).

Operator credentials are separate from Worker Host credentials. Collaboration surface credentials
accepted during enrollment are write-only and never appear in a response. A Worker Host credential
appears only in the response that issues or rotates it; ordinary Worker Host reads never contain
the token or its server-side logical credential ID.

## Operator RPCs (Experimental)

The Control Plane serves its operator API as RPCs defined in protobuf, in the package
`supertag.operator.v1` under
[`spec/proto/supertag/operator/v1/`](../../spec/proto/supertag/operator/v1/). The proto comments
are the reference for each message and field. Only the [Worker HTTP routes](#worker-http-routes)
remain under `/api/v1/`.

### RPC list

| RPC | Operator action | Returns |
| --- | --- | --- |
| `OrganizationService.GetStatus` | `status` | The Control Plane phase and the phase of each controller: Task dispatch, reply delivery, and collaboration surfaces |
| `OrganizationService.GetOrganization` | `read_organization` | What the organization is doing right now |
| `OrganizationService.GetSpend` | `read_spend` | Cost and tokens of Task Attempts, grouped |
| `OrganizationService.ListAuditEntries` | `read_audit` | Recorded operator changes, newest first |
| `OrganizationService.GetMetrics` | `read_metrics` | An operational snapshot for monitoring |
| `ConversationService.SendMessage` | `message_tag` | Sends a message to a Tag |
| `ConversationService.GetMessage` | `read_conversation` | One message and its reply |
| `ConversationService.FollowMessage` | `read_conversation` | Streams one message's reply and work |
| `ConversationService.ListConversations` | `read_conversation` | The caller's conversations |
| `ConversationService.ListMessages` | `read_conversation` | One conversation's messages |
| `EventService.Watch` | `watch_events` | Streams change notices |
| `InboxService.ListInboxItems` | `read_coordination_inbox` | The items waiting on a person |
| `InboxService.ListApprovals` | `list_approvals` | Approval requests |
| `InboxService.Approve` | `decide_approval` | Approves a pending approval request |
| `InboxService.Deny` | `decide_approval` | Denies a pending approval request with a reason |
| `InboxService.AnswerQuestion` | `message_objective` | Answers a question item as the Objective's next turn |
| `ObjectiveService.CreateObjective` | `create_objective` | Creates an Objective and starts it |
| `ObjectiveService.ListObjectives` | `list_objectives` | Objectives, newest first |
| `ObjectiveService.GetObjective` | `read_objective` | One Objective |
| `ObjectiveService.DescribeObjective` | `read_objective` | The operator's view of an Objective |
| `ObjectiveService.MessageObjective` | `message_objective` | Sends the owner's next turn |
| `ObjectiveService.UpdateObjective` | `update_objective` | Changes status, deadline, budget, or runtime actions |
| `ObjectiveService.ApproveObjective` | `update_objective` | Completes an Objective submitted for review |
| `ObjectiveService.CancelObjective` | `cancel_objective` | Cancels an Objective and its open Tasks |
| `ObjectiveService.PauseObjective` | `update_objective` | Holds new turns |
| `ObjectiveService.ResumeObjective` | `update_objective` | Lets work start again |
| `WorkService.ListTasks` | `read_task` | Tasks, the most recently created first |
| `WorkService.GetTask` | `read_task` | One Task with its Task Attempts, placement, delivery, and storage |
| `WorkService.ListTaskEvents` | `read_task` | A Task's recorded events, in sequence order |
| `WorkService.InspectTaskExecution` | `read_task` | How the latest Task Attempt ran, with the Worker Host's receipt |
| `WorkService.CancelTask` | `cancel_task` | Cancels a pending or running Task |
| `WorkService.ListSessions` | `read_session` | Sessions, the most recent interaction first |
| `WorkService.GetSession` | `read_session` | One Session and what its latest delivering Task delivered |
| `WorkService.ListSessionStates` | `read_session` | A Session's native archives, without their contents |
| `WorkService.GetSessionState` | `read_session_state` | One native archive with its contents |
| `WorkService.ListArtifacts` | `read_artifact` | Captured artifacts and where their copies are |
| `WorkService.GetArtifact` | `read_artifact` | One artifact's files and copies |
| `WorkService.ResolveArtifactDownload` | `download_artifact` | Where the caller can read one artifact file |
| `TeamService.CreateTeam` | `manage_team` | Creates a Team |
| `TeamService.ListTeams` | `read_team` | Teams, by name |
| `TeamService.GetTeam` | `read_team` | One Team |
| `TeamService.UpdateTeam` | `manage_team` | Changes a Team's name, members, or turn limit |
| `TeamService.DeleteTeam` | `manage_team` | Deletes a Team and its Workstream posts |
| `MailboxService.ListTagMessages` | `read_mailbox` | Messages a Tag sent or received, newest first |
| `MailboxService.GrantMailbox` | `manage_mailbox` | Lets one Tag accept messages from another |
| `MailboxService.RevokeMailbox` | `manage_mailbox` | Removes that grant |
| `MailboxService.ListMailboxGrants` | `read_mailbox` | The grants in which a Tag is the sender or the recipient |
| `MailboxService.ListWorkstreamPosts` | `read_mailbox` | A Team's Workstream posts |
| `HostService.ListWorkerHosts` | `read_worker_host` | Worker Hosts, the earliest enrolled first |
| `HostService.GetWorkerHost` | `read_worker_host` | One Worker Host |
| `HostService.EnrollWorkerHost` | `manage_worker_host` | Enrolls a Worker Host and returns its first credential |
| `HostService.RotateWorkerHostCredential` | `manage_worker_host_credential` | Replaces a Worker Host's credential |
| `HostService.RevokeWorkerHostCredential` | `manage_worker_host_credential` | Revokes a Worker Host |
| `HostService.DrainWorkerHost` | `manage_worker_host` | Stops a Worker Host taking new Tasks |
| `HostService.ResumeWorkerHost` | `manage_worker_host` | Ends a drain |
| `HostService.BindWorkerHost` | `bind_worker_host` | Lets a Worker Host run a Tag's Tasks |
| `HostService.UnbindWorkerHost` | `bind_worker_host` | Removes that binding |
| `HostService.CreateAuthKey` | `manage_auth_key` | Creates an Auth Key and returns its secret once |
| `HostService.ListAuthKeys` | `read_auth_key` | Auth Keys, without their secrets |
| `HostService.GetAuthKey` | `read_auth_key` | One Auth Key |
| `HostService.RevokeAuthKey` | `manage_auth_key` | Stops new joins with an Auth Key |
| `AccessService.CreateOperatorToken` | `manage_operator_token` | Creates an Operator Token and returns its secret once |
| `AccessService.ListOperatorTokens` | `read_operator_token` | Operator Tokens, without their secrets |
| `AccessService.GetOperatorToken` | `read_operator_token` | One Operator Token |
| `AccessService.RevokeOperatorToken` | `manage_operator_token` | Refuses an Operator Token from the next call |
| `SurfaceService.SetUpSurface` | `set_up_surface` | Saves a verified Surface Account and its credentials |
| `SurfaceService.ListSurfaceAccounts` | `read_surface_account` | Connected Surface Accounts |
| `SurfaceService.GetSurfaceAccount` | `read_surface_account` | One Surface Account |
| `SurfaceService.AddTagLocation` | `manage_tag_location` | Makes a Tag answer in a location |
| `SurfaceService.RemoveTagLocation` | `manage_tag_location` | Stops a Tag answering in a location |
| `SurfaceService.ActivateSet` | `manage_set_activation` | Activates a Context Set or Permission Set in a location |
| `SurfaceService.DeactivateSet` | `manage_set_activation` | Deactivates it |
| `ResourceService.GetResource` | `read_resource` | One configuration resource, optionally with its manifest |
| `ResourceService.ListResources` | `read_resource` | The resources of one kind, by name |
| `ResourceService.DiffManifests` | `read_resource` | Plans an apply without changing anything |
| `ResourceService.ApplyManifests` | `apply_resource` | Applies manifests on the Control Plane |
| `ResourceService.DeleteResource` | `delete_resource` | Deletes or retires one resource |

### Calling an RPC

Each RPC is a `POST` to `/PACKAGE.SERVICE/METHOD` on the API port, such as
`/supertag.operator.v1.OrganizationService/GetStatus`. The listener speaks the Connect and
gRPC-Web protocols over HTTP/1.1. gRPC itself needs HTTP/2 and is not served on this port yet.

The Connect protocol accepts JSON, so `curl` can call any RPC:

```sh
curl -s https://control.example.com/supertag.operator.v1.OrganizationService/GetStatus \
  -H "Authorization: Bearer $SUPERTAG_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{}'
```

```json
{
  "metadata": {
    "id": "control-plane",
    "name": "control-plane",
    "resourceVersion": "9f2c…",
    "createdAt": "2026-11-08T09:00:00Z",
    "updatedAt": "2026-11-08T09:41:12.345Z"
  },
  "phase": "CONTROL_PLANE_PHASE_ACCEPTING",
  "controllers": [
    { "name": "task-dispatch", "phase": "CONTROLLER_PHASE_RUNNING" },
    { "name": "reply-delivery", "phase": "CONTROLLER_PHASE_RUNNING" },
    { "name": "surfaces", "phase": "CONTROLLER_PHASE_RUNNING" }
  ]
}
```

Bodies use proto3 JSON. Field names are lowerCamelCase, enums are their value names, times are
RFC 3339 strings, and 64-bit integers are strings. A request field the message does not define is
ignored, not refused. Send `Content-Type: application/proto` for the binary encoding instead. The
generated clients in TypeScript and Go handle all of this.

Authentication is the same `Authorization: Bearer` header as the routes above. The Control Plane
checks the credential before it reads the request body. Method options in
[`options.proto`](../../spec/proto/supertag/operator/v1/options.proto) declare who may call each
RPC:

| Option | Meaning |
| --- | --- |
| `(supertag.operator.v1.action)` | The operator action the credential must carry. The admin token and Operator Tokens carry every action |
| `(supertag.operator.v1.requires_admin_token)` | Only the admin token may call the RPC; an Operator Token gets `permission_denied` |
| `(supertag.operator.v1.allow_anonymous)` | A call without a credential is accepted |
| `(supertag.operator.v1.audit_action)` | The `action` the [audit log](#audit-log) records for each authenticated call |
| `(supertag.operator.v1.allow_scoped_credential)` | A [scoped coordination credential](../operations/control-plane.md#scoped-coordination-credentials) may call the RPC when it carries the action, for the Objectives its scope names only |

Every RPC declares an action. An RPC that only reads sets `idempotency_level = NO_SIDE_EFFECTS`;
every other RPC declares an audit action. A scoped coordination credential gets
`permission_denied` from an RPC without `allow_scoped_credential`, and from one that names an
Objective outside its scope. Every `InboxService` RPC, `EventService.Watch`, and
`ObjectiveService.GetObjective`, `DescribeObjective`, `MessageObjective`, and `ApproveObjective`
accept one.

### RPC errors

A refused call returns a Connect error: a JSON body with `code`, `message`, and `details`. The one
detail is a `supertag.operator.v1.ErrorDetail` whose `reason` is stable; branch on it, never on
`message`.

| Connect code | HTTP status | `ErrorDetail.reason` |
| --- | --- | --- |
| `unauthenticated` | 401 | `ERROR_REASON_UNAUTHENTICATED`, `ERROR_REASON_CREDENTIAL_REVOKED`, or `ERROR_REASON_CREDENTIAL_EXPIRED` |
| `permission_denied` | 403 | `ERROR_REASON_PERMISSION_DENIED` |
| `invalid_argument` | 400 | `ERROR_REASON_INVALID_ARGUMENT` |
| `not_found` | 404 | `ERROR_REASON_NOT_FOUND` |
| `failed_precondition` | 400 | `ERROR_REASON_CONFLICT` |
| `resource_exhausted` | 429 | `ERROR_REASON_RESOURCE_EXHAUSTED`: a request over a size limit, or a rate or mailbox limit reached |
| `unavailable` | 503 | `ERROR_REASON_DRAINING` while the Control Plane shuts down; `ERROR_REASON_UNAVAILABLE` when this Control Plane lacks what the RPC needs, such as a feature it is configured without |
| `internal` | 500 | `ERROR_REASON_INTERNAL`, with a message that names no internal detail |

`canceled`, `deadline_exceeded`, and `unimplemented` carry `ERROR_REASON_UNSPECIFIED`; the code
says why. A body the Connect protocol itself rejects gets only the code, with no detail: one that
is not valid JSON for the request message (`invalid_argument`) or is over 1 MB, or 16 MB for a
`ResourceService` RPC (`resource_exhausted`). The credential is checked first, so an anonymous caller still gets
`unauthenticated`.

A call without a credential reveals nothing but the error:

```json
{
  "code": "unauthenticated",
  "message": "A valid Control Plane admin token or Operator Token is required",
  "details": [
    {
      "type": "supertag.operator.v1.ErrorDetail",
      "value": "CAE",
      "debug": { "reason": "ERROR_REASON_UNAUTHENTICATED" }
    }
  ]
}
```

`value` is the binary detail in unpadded base64; `debug` repeats it as JSON for people reading the
reply.

### Server streams

`FollowMessage` and `Watch` are server streams. The client sends one request and reads events
until the stream ends. In the Connect protocol, a stream is a `POST` with
`Content-Type: application/connect+json`. The request body and each event are one frame: a flags
byte, a 4-byte big-endian length, then the JSON message. A last frame with flags `0x02` carries
the end of the stream and any error. The generated clients handle the framing, so call streams
through them rather than `curl`.

Both streams send a `heartbeat` after 15 seconds without another event, so proxies keep an idle
connection open. The server sets no deadline. A stream stays open until it ends on its own, the
client cancels the call, or the Control Plane drains. Draining ends it with `unavailable` and
`ERROR_REASON_DRAINING`; call again to resume. Before an event, an open stream rechecks its
credential once 15 seconds have passed since the last check. When an admin revokes its Operator
Token, or the token expires, the stream ends within 30 seconds, even when idle. It ends with
`unauthenticated` and `ERROR_REASON_CREDENTIAL_REVOKED` or `ERROR_REASON_CREDENTIAL_EXPIRED`.

### Conversations

`ConversationService` serves `supertag message tag`, `supertag message objective`, and the
terminal UI. A conversation is one Session between the caller and a Tag, named by the caller,
such as `default` or `billing`. The same name continues the same Session.

A conversation is private. The admin token is one operator, and each Operator Token is another.
Each reads only its own conversations, even with the same name. Another operator's message fails
with `not_found`, exactly as a message that does not exist. The Tag answers with its Roles'
permissions only; no location's Permission or Context Sets apply.

A message is one turn of the conversation, named by the ID of the Task it started. A turn may
start **work Sessions**: Sessions of the same Tag that run longer work as their own Tasks and
report back into the conversation. The message lists them in `workSessions`, each with its latest
Task, its status, its question or approval notices, and its report.

`SendMessage` returns the message before the Tag answers:

```sh
curl -s https://control.example.com/supertag.operator.v1.ConversationService/SendMessage \
  -H "Authorization: Bearer $SUPERTAG_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"tag": "planner", "conversation": "billing", "text": "Which step is riskiest?",
       "idempotencyKey": "billing-0007"}'
```

```json
{
  "taskId": "01JC8V3W6Q4Z9T2N5R7K1M0XHB",
  "tag": "planner",
  "conversation": "billing",
  "sessionId": "01JC8T9F2D6S1Q8V4N3B7W5YKE",
  "text": "Which step is riskiest?",
  "createdAt": "2026-11-08T09:41:12.345Z",
  "status": "REPLY_STATUS_WAITING"
}
```

- An empty `conversation` means `default`. A name has 1 to 64 letters, digits, `.`, `_`, or `-`,
  and starts with a letter or digit.
- A repeat with the same `idempotencyKey` from the same caller to the same Tag returns the first
  message and sends nothing.
- A message sent while an earlier turn still runs may join that turn. `joinedTaskId` then names
  it, and that turn's reply answers both. If that turn ends without reading the message,
  `joinedTaskId` goes back to empty and the message runs as its own turn.
- `waitingReason` says in one line why the turn has not started, while no bound Worker Host can
  run it.
- `SendMessage` fails with `not_found` for a Tag that does not exist, and with
  `failed_precondition` and `ERROR_REASON_CONFLICT` when the Tag does not accept the message.

`GetMessage` reads a message the caller sent, or a turn of an Objective that talks in one of the
caller's conversations. Every operator may read the turns of an Objective that talks in no thread.
A work Session's own Task is not a message: read it through the message that started it. `ListConversations` and `ListMessages` page with `pageSize` (0 means 50, at most 100),
`pageToken`, and `nextPageToken`.

### Following a reply

`FollowMessage` streams one message until there is nothing more to show. Each event carries one
part:

| Part | Carries |
| --- | --- |
| `joined` | The running turn the message joined, or an empty `taskId` once that delivery is withdrawn |
| `waiting` | Why the turn has not started; sent when the reason changes |
| `textDelta` | Reply text as the Tag's harness writes it |
| `activity` | A command or tool call starting or ending, or a retry in a new Task Attempt |
| `finish` | The turn's reply, and the message with the work Sessions the turn started |
| `error` | The error that ended the turn instead of a reply |
| `workSessionChanged` | The whole of one work Session, after any change to it |
| `end` | The message as `GetMessage` returns it; always the last event |
| `heartbeat` | Nothing; keeps an idle stream open |

The stream has two phases:

```text
turn:  [joined] [waiting…] (textDelta | activity)…  finish | error
work:  (activity with workSessionId | workSessionChanged)…
       end
```

- **The turn.** `joined` comes first when the message joined a running turn. Then come `waiting`
  while no Worker Host can run it, text and activity while it runs, and one `finish` or `error`.
- **The work.** After `finish`, the stream follows the work Sessions the turn started.
  `finish.message` lists them. Their activity carries `workSessionId`; their text is never
  streamed.
- **The end.** `end` comes once every work Session has reported and none waits only on an
  approval decision. A decision continues the work Session as a new Task, so the stream stays
  open through it. A question counts as settled: the answer is the caller's next message. After
  `error`, `end` follows at once.

How a stream starts depends on the turn. A running turn sends its text and activity so far, then
the rest live. A joined message sends `joined`, then the joined turn from the moment of the call.
When the joined turn ends without reading the message, the Control Plane withdraws the delivery.
The stream then sends `joined` with an empty `taskId` and follows the message's own turn.
A finished turn sends its stored `finish` or `error` at once, without text, then the work phase.

**Resume.** Every event except `heartbeat` has a `sequence`, increasing and greater than the
request's `afterSequence`. To resume a dropped stream, call again with the last sequence received.
While the server still holds the events after it, the new stream continues exactly. When it does
not, for example after a Control Plane restart, the new stream skips the text and activity it
lost and never repeats them. It sends `joined`, `waiting`, `finish` or `error`, and a
`workSessionChanged` for each work Session again, for the current state. So a client applies those
parts as state, not as counts, and `finish.reply` replaces any text it streamed.

`supertag message tag --output json` stops following once every work Session's `reportStatus` is
`REPLY_STATUS_REPLIED`, including one that waits on approval.

Streamed reply text reaches readers only through `FollowMessage`. The message and the Task's
result keep the final reply; the Task's events record its commands, tool calls, and result, not
each piece of text.

`@supertag/operator-api` includes `FollowEventAdapter`, which turns these events into
[AI SDK UI message stream](https://ai-sdk.dev/docs/ai-sdk-ui/stream-protocol) chunks for a chat
UI built on the AI SDK hooks. Text deltas become text parts; activity, `joined`, `waiting`, the
reply, and each work Session become `data-activity`, `data-joined`, `data-waiting`, `data-reply`,
and `data-work-session` parts with stable IDs, so a repeat replaces a part instead of adding one.
`error` becomes an `error` chunk and `end` becomes `finish`, with the message as
`messageMetadata.message`.

### Event stream

`EventService.Watch` tells a client what changed, so it rereads only that. Each `change` names one
thing by `kind` and ID and carries none of its state; the client rereads it through the RPC that
reads that kind. `reason` is a few words for logs and people, such as `status completed`; clients
do not parse it. `kinds` limits the stream to some kinds; empty sends every kind the caller may
see.

Every event carries an opaque `resumeToken`. To show current state without missing a change:

1. Call `Watch` without a token. The first event is a `heartbeat` whose token marks the start.
2. Read the state.
3. Apply each change that follows.

To resume a dropped stream, call again with the last token received. The server replays the
changes after it, in order. When it can't, because the token is too old or from before the
Control Plane restarted, the first event is a `resync`: the client rereads everything it shows. A
token the server did not issue fails with `invalid_argument`. A notice may stand for several
changes, and the same change may arrive twice, so treat each one as a reason to reread.

The caller sees only what it could read through the other RPCs. The admin token and Operator
Tokens carry every action and have no Objective scope. A scoped coordination credential needs
`watch_events` to call `Watch` at all, and sees no conversations, Sessions, or Tags:

| Kind | Who sees it |
| --- | --- |
| `WATCH_KIND_CONVERSATION_MESSAGE` | Messages in the caller's own conversations, with `read_conversation` |
| `WATCH_KIND_SESSION` | Every Session, for the admin token and Operator Tokens, except that a conversation's Session and its work Sessions reach only the operator whose conversation it is |
| `WATCH_KIND_TASK` | The same, for Tasks; a scoped credential with `read_objective` sees the Tasks of Objectives in its scope |
| `WATCH_KIND_TAG` | Every Tag, for the admin token and Operator Tokens |
| `WATCH_KIND_OBJECTIVE` | Objectives in the credential's Objective scope, with `read_objective` |
| `WATCH_KIND_INBOX_ITEM` | Inbox items of those Objectives, with `read_coordination_inbox` |
| `WATCH_KIND_APPROVAL` | Approval requests of those Objectives, with `list_approvals`; a request outside any Objective reaches only a credential without an Objective scope |
| `WATCH_KIND_WORKSTREAM_POST` | Posts to every Team's Workstream, for the admin token and Operator Tokens; a scoped credential with `read_objective` sees posts to the Teams of Objectives in its scope. `teamId` names the Team |

`supertag watch inbox` and `supertag watch objective` follow this stream and reread on each notice.

A kind the caller may not see is left out silently, even when `kinds` names it. The comment on
each `WatchKind` value in [`event.proto`](../../spec/proto/supertag/operator/v1/event.proto) says
which ID fields its changes set.

### Inbox

`InboxService` serves `supertag list inbox`, `supertag list approval`, `supertag approve request`,
`supertag deny request`, and the terminal UI's **Waiting on you** list.

`ListInboxItems` lists what waits on a person, the longest waiting first. Items are derived from
existing records: approval requests, questions an Objective's owner asked, budget and deadline
limits, Tasks that need an operator, and Tasks held for an MCP login. Reading an item does not
resolve it. Each item has a `key`, such as `approval:ID` or `question:TASK_ID`, and an
`occurrence`. A Task that needs the same decision again after another Task Attempt is a new
occurrence with the same `key`, so a client that shows each item once keys on `occurrence`.

- `operatorEligible` is true for items an operator decides. `supertag list inbox` shows only those
  unless `--all` is set.
- `tagNames` names the Tags in `nextActorTagIds` and `excludedActorTagIds`.
- Approval items are listed only for a credential that also carries `list_approvals`.
- Each kind is scanned up to a bound. A kind with more candidates is named in `truncatedKinds`.
- Pages use `pageSize` (0 means 50, at most 100), `pageToken`, and `nextPageToken`.

```sh
curl -s https://control.example.com/supertag.operator.v1.InboxService/ListInboxItems \
  -H "Authorization: Bearer $SUPERTAG_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"objectiveId": "objective-release", "kind": "INBOX_ITEM_KIND_QUESTION"}'
```

`ListApprovals` lists approval requests, the most recently created first, filtered by
`objectiveId` and `status`. Pages use `pageSize` (0 means 100, at most 500) and `pageToken`.

`Approve` takes an optional `scope` (`APPROVAL_SCOPE_ONCE` or `APPROVAL_SCOPE_OBJECTIVE`) and
`validUntil`. `Deny` requires a `reason`, which the Session that asked reads. Both continue the
waiting Session, and both fail with `failed_precondition` for a request that is no longer pending.
Repeating your own decision with the same scope returns the decided request instead, so a retry is
safe. The audit log records them as `approval.approve` and `approval.deny`. See
[Approval requests](coordination.md#approval-requests).

`AnswerQuestion` takes a question item's `key` and the answer `text`, and sends it as the owner's
next turn, exactly as `MessageObjective` does. Once the owner took another turn or the Objective
closed, it fails with `failed_precondition`. A repeat with the same `idempotencyKey` returns the
first call's turn.

### Objectives

`ObjectiveService` serves `supertag create objective`, `list objective`, `get objective`,
`describe objective`, `message objective`, `approve objective`, `complete objective`,
`cancel objective`, `pause objective`, `resume objective`, and the terminal UI's Objective view.
Applying an Objective manifest with `supertag apply` goes through
[`ResourceService.ApplyManifests`](#resources). The complete Objective contract is in [Objectives](../../spec/objectives.md).

`CreateObjective` takes the `outcome`, the `owner` Tag's name, and optionally an `id`, a `team` by
name or ID, a `deadline`, a `budget`, `runtimeActions`, `workspaces`, and `ongoing`. It starts the
owner's first turn and returns `startedTaskId`, or `notStarted` with the reason it could not.
`warnings` names each condition that would hold the Objective's turns. With `dryRun` it checks and
warns, and stores nothing. Repeating it with the same `id` and definition returns the same
Objective and starts nothing new.

```sh
curl -s https://control.example.com/supertag.operator.v1.ObjectiveService/CreateObjective \
  -H "Authorization: Bearer $SUPERTAG_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"owner": "release-manager", "outcome": "Ship the 0.4 release.",
       "budget": {"limitMinor": "5000", "currency": "USD"}}'
```

`DescribeObjective` returns the operator's view, as `supertag describe objective` shows it:
conditions, what needs the operator, approval counts, the Team, deadline and budget limits, spend
against the budget, the conversation, each Session with its latest Task's delivery and report,
high findings, the newest Workstream posts, Volume writes, and one page of Tasks with their Task
Attempts. `pageSize` (0 means 50, at most 100) and `pageToken` page through the Tasks only. The view
is observed records, not a transactional snapshot. See
[Overview fields](coordination.md#overview-fields).

`MessageObjective` sends `text` as the owner's next turn, with an optional `idempotencyKey`. It
moves a `blocked`, `limited`, or `ready_for_review` Objective back to `working`, and fails with
`failed_precondition` for a completed or cancelled Objective. See
[Operator messages](coordination.md#operator-messages).

`UpdateObjective` takes `expectedRevision` and at least one of `status`, `completionSummary`,
`deadline`, `budgetLimitMinor`, and `runtimeActions`. `OBJECTIVE_STATUS_COMPLETED` needs a
`completionSummary`. Only `CancelObjective` cancels, and only the owner sets
`OBJECTIVE_STATUS_LIMITED`. A stale `expectedRevision` fails with `failed_precondition`.
`ApproveObjective` completes an Objective that is `ready_for_review`.

`CancelObjective` cancels an Objective and its open Tasks, with an optional `reason`, and records
the caller in the Objective's change history. It returns the Objective, `changed`, and
`cancelledTaskIds`. Repeating it succeeds with `changed` false; a completed Objective fails with
`failed_precondition`. `PauseObjective` and `ResumeObjective` return `changed` the same way. See
[Cancelling an Objective](coordination.md#cancelling-an-objective).

### Work

`WorkService` serves `supertag list task`, `get task`, `describe task`, `events task`,
`cancel task`, `watch task`, `list session`, `get session`, `describe session`, `watch session`,
`list artifact`, `get artifact`, and `download artifact`. The busy-Task column of
`supertag list tag` and `list worker-host` reads `ListTasks` too. The terminal UI expands a work
Session line with `GetSession` and `ListTaskEvents`, and reads the branch it shows from
`GetSession`.

A Session is one conversation of a Tag. Each turn of it is a Task, and each try at running a Task
is a Task Attempt. Every view comes from records the Control Plane stores. Only
`InspectTaskExecution` asks a Worker Host.

A CLI conversation is private to the operator who holds it. Its Session, the work Sessions its
turns started, and their Tasks, events, native archives, and artifacts reach that operator only.
Other callers' lists leave them out, and naming one fails with `not_found`. The admin token is
the operator `admin`, so it does not see an Operator Token holder's conversations either.

| RPC | Order | `pageSize` |
| --- | --- | --- |
| `ListTasks` | Most recently created first | 0 means 100, at most 500 |
| `ListTaskEvents` | Sequence order, after `afterSequence` | 0 means 500, at most 1,000 |
| `ListSessions` | Most recent interaction first | 0 means 100, at most 500 |
| `ListSessionStates` | Most recently created first | 0 means 100, at most 100 |
| `ListArtifacts` | Oldest first | 0 means 20, at most 100 |

`ListTasks` filters by `tag` name, `sessionId`, `objectiveId`, and `statuses`. `ListSessions`
filters by `tag`, `parentSessionId`, and `objectiveId`. A page token names a position in the list,
so any Control Plane can continue it. An empty `nextPageToken` marks the last page. A `ListTasks`
page before the last can hold fewer Tasks than `pageSize`, or none, when most of the Tasks it
passed are hidden from you or do not match.

```sh
curl -s https://control.example.com/supertag.operator.v1.WorkService/ListTasks \
  -H "Authorization: Bearer $SUPERTAG_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"tag": "release-manager", "statuses": ["TASK_STATUS_RUNNING"]}'
```

`GetTask` returns what `get task` and `describe task` show; see
[Read a Task's progress](#read-a-tasks-progress). `CancelTask` cancels a pending Task at once. For a
running Task it tells the Worker to stop, and the status stays `TASK_STATUS_RUNNING` until the
Worker reports it stopped. Repeating the call asks the Worker again. For a Task that already
finished it changes nothing and returns `accepted` false. The audit log records `task.cancel`.

`GetSession` adds `delivery`: what the Session's latest delivering Task delivered. For a work
Session that is the branch with its base and head commits, any pull request, and `checkout`, the
Worker Host whose checkout holds the branch. The Control Plane keeps no repository contents, so a
client that shows a diff computes it from its own checkout. A conversation's `WorkSession.id` in
[`ConversationService`](#conversations) is the Session ID to pass.

Artifacts and native archives are described in [Artifact inspection](#artifact-inspection) and
[Session persistence](#session-persistence).

### Teams

`TeamService` serves `supertag create team`, `list team`, `get team`, `update team`, and
`delete team`, and the terminal UI's Teams list and Team view. A Team is a flat list of member
Tags with an optional turn limit; see [Teams](coordination.md#teams). Requests name a Team by
name or ID, and members by Tag name. Each `Team.members` entry carries the Tag's ID and name; a
deleted Tag's name is empty.

`CreateTeam` takes `name`, `members`, and an optional `id` and `maxConcurrency`. Repeating it with
the same ID and definition returns the existing Team. Another Team with the ID or name fails with
`already_exists` and `ERROR_REASON_CONFLICT`.

`UpdateTeam` takes `expectedRevision` and at least one of `name`, `members.tags`, and
`concurrency`. A `concurrency.maxConcurrency` of 0 removes the limit. A stale revision fails with
`failed_precondition`, unless the Team already has every value the request sets: then nothing
changes and the Team is returned, so retrying an applied change succeeds. New members take part
from their next turn.

`DeleteTeam` also deletes the Team's Workstream posts. It fails with `failed_precondition` while
an Objective that is not completed or cancelled names the Team.

`ListTeams` lists Teams by name, optionally only those a `member` Tag belongs to. Pages use
`pageSize` (0 means 100, at most 500) and `pageToken`.

```sh
curl -s https://control.example.com/supertag.operator.v1.TeamService/CreateTeam \
  -H "Authorization: Bearer $SUPERTAG_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name": "launch", "members": ["release-manager", "builder"], "maxConcurrency": 2}'
```

### Mailbox

`MailboxService` serves `supertag list message`, `grant mailbox`, `revoke mailbox`,
`list mailbox-grant`, and `list workstream-post`, and the Workstream posts in the terminal UI's
Team view. Requests name Tags by name, and responses carry `tagNames` for the Tag IDs they
contain. There is no declarative Mailbox resource.

A grant lets the `recipient` accept messages from the `sender`. Tags that share a Team need none.
`GrantMailbox` and `RevokeMailbox` return `changed` false when there was nothing to change, so a
retry is safe. `ListMailboxGrants` lists the grants in which a Tag is the sender or the recipient;
Team membership is not listed.

`ListTagMessages` lists the messages a Tag sent or received, newest first, each with its status.
`ListWorkstreamPosts` lists a Team's posts, oldest first. Without `afterSequence` it returns the
newest page. With `afterSequence` it continues from that sequence, and `nextPageToken` pages on
while more follow. To follow new posts, call again with the last `sequence` when
[`EventService.Watch`](#event-stream) sends a `WATCH_KIND_WORKSTREAM_POST` change. Both take
`pageSize` (0 means 50, at most 200).

The Workstream contract is in [Workstreams](../../spec/workstreams.md). See
[Send messages between Tags](../guides/tag-messaging.md).

### Organization

`OrganizationService` serves `supertag status`, `spend`, and `audit`, and the snapshot a monitoring
system reads. The admin token and Operator Tokens may call every RPC; a scoped coordination
credential gets `permission_denied`.

`GetOrganization` returns what the organization is doing right now:

- `workerHosts`: each Worker Host that is not revoked, with its `phase`, `running` Task Attempts,
  `capacity`, and `coordinationCapacity`, and the same counts per harness in `harnesses`.
  `capacity` includes coordination slots, which only an Objective's owner uses;
  `coordinationCapacity` counts only those. For example, four regular slots and one coordination
  slot show `running: 5`, `capacity: 5`, and `coordinationCapacity: 1` when full. `diskSpace` and
  `diskWarning` report scratch space as the host last reported it.
- `tags`: each Tag that is not retired, with `runningTaskIds`, empty when the Tag is idle, and the
  commands their harnesses report as running.
- `objectives`: each Objective that is not completed or cancelled, newest first, with `status`,
  `owner`, `deadline`, `spentMinor`, `budgetLimitMinor`, `currency`, and its high-severity
  findings. Amounts are in minor units, so `1380` with `USD` means $13.80. `currency` is empty for
  allocation budgets. `unpricedAttempts` and `unpricedTokens` count Task Attempts whose model has no
  published price; `spentMinor` excludes their unknown cost.

The operator inbox is not part of it: `supertag status` counts it with
`InboxService.ListInboxItems`.

`GetSpend` sums cost and tokens across Task Attempts. Each Task Attempt counts once, with its latest
valid usage report. `by` groups by `SPEND_GROUPING_OBJECTIVE`, the default, `SPEND_GROUPING_TAG`,
or `SPEND_GROUPING_DAY`, in UTC dates. `since` counts only Task Attempts that started at or after
that time. Each group has `key`, `attempts`, `reportedCostByCurrency`, `unknownCostAttempts`,
`estimatedCostAttempts`, `reportedTokens`, and `unknownTokenAttempts`. Objective groups carry
`budget`, and Task Attempts outside any Objective form the group `unassigned`. Tag groups carry
`name`. Currencies are never combined, and an empty `reportedCostByCurrency` never means zero cost.

For Codex Task Attempts with tokens but no stored cost, SuperTag estimates the cost from the model
in the Task Attempt snapshot and counts the Task Attempt in `estimatedCostAttempts`. Estimates use
the current price table, so they can differ from what was billed. A model with no price leaves the
cost unknown: `unpricedModels` counts those Task Attempts per model, and `unpricedTokens` sums their
tokens.

```sh
curl -s https://control.example.com/supertag.operator.v1.OrganizationService/GetSpend \
  -H "Authorization: Bearer $SUPERTAG_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"by": "SPEND_GROUPING_TAG", "since": "2026-11-01T00:00:00Z"}'
```

### Audit log

`ListAuditEntries` returns the recorded operator changes, newest first: applies, deletes, Worker
Host, Auth Key, Operator Token, and surface changes, approval decisions, Objective messages, and
every other call that can change state. A call to an RPC that declares an audit action is recorded
with `path` set to its procedure, such as `/supertag.operator.v1.HostService/DrainWorkerHost`.
Reads, plans, and dry runs are not recorded. A change whose call returned before `ListAuditEntries` began is listed.
`supertag audit` reads this RPC.

| Field | Meaning |
| --- | --- |
| `since` | Only entries at or after this time |
| `actor` | Only entries by this exact actor, such as `token:laptop-2`; at most 200 characters |
| `pageSize` | 0 means 50, at most 500 |
| `pageToken` | The `nextPageToken` of the previous page. The next page continues after the last entry returned, so entries recorded in between are neither repeated nor skipped. |

```json
{
  "entries": [
    {
      "id": "5f0c2e1a-…",
      "at": "2026-10-01T09:30:00.120Z",
      "actor": "token:laptop-2",
      "action": "worker-host.drain",
      "target": "WorkerHost/build-east-1",
      "outcome": "AUDIT_OUTCOME_SUCCEEDED",
      "status": 200,
      "source": "AUDIT_SOURCE_API",
      "method": "POST",
      "path": "/supertag.operator.v1.HostService/DrainWorkerHost"
    }
  ]
}
```

| Field | Meaning |
| --- | --- |
| `actor` | `control-plane-break-glass`, `token:NAME`, a scoped credential's `operatorId`, or `slack:USER` or `lark:USER` for a person in an Objective's thread |
| `action` | What was done, such as `resource.apply`, `resource.prune`, `resource.delete`, `worker-host.enroll`, `worker-host.credential.rotate`, `worker-host.credential.revoke`, `worker-host.drain`, `worker-host.resume`, `tag.worker-host.add`, `tag.worker-host.remove`, `auth-key.create`, `auth-key.revoke`, `operator-token.create`, `operator-token.revoke`, `surface.enroll`, `tag.location.add`, `tag.location.remove`, `tag.set.activate`, `tag.set.deactivate`, `approval.approve`, `approval.deny`, `objective.message`, `objective.reopen`, `objective.approve`, `objective.cancel`, `task.cancel`, `task.inspect`, `artifact.download`, `team.create`, `team.update`, `team.delete`, `mailbox-grant.add`, `mailbox-grant.revoke`, or `coordination.COMMAND` for a command the Control Plane recognizes (`coordination.command` otherwise). A request the Control Plane doesn't recognize is refused and not recorded, because its path might hold a credential. An `ApplyManifests` call records one `resource.apply` entry for each document it applied or failed to apply, and one `resource.prune` entry for each apply-set member pruning deleted or cancelled. |
| `target` | `Kind/NAME` or `Kind/ID`, such as `Tag/reviewer` or `ApprovalRequest/ID`; only the kind when the request named no valid target or failed |
| `outcome` | `AUDIT_OUTCOME_SUCCEEDED`, or `AUDIT_OUTCOME_FAILED` for an error response or an interrupted request |
| `status` | The HTTP status. For an RPC it is the status its Connect code maps to, such as `200`, `404` for `not_found`, or `409` for `already_exists`. For a change from an Objective's thread, only a refused change has one: the status the API would return. |
| `source` | `AUDIT_SOURCE_API` for a Control Plane API call, `AUDIT_SOURCE_GATEWAY` for an Objective thread in Slack or Lark |
| `method`, `path` | For API entries, the call's method and the RPC's procedure, such as `/supertag.operator.v1.ResourceService/ApplyManifests`. |

An entry never contains a credential, a secret value, a digest, or a request body. The Control
Plane writes each entry to its database and to one more sink, standard error or the file
`logging.audit` names in `supertag.yaml`; see [Audit log](../operations/control-plane.md#audit-log).

### Metrics

`GetMetrics` returns a bounded operational snapshot: resource counts, Tasks by status, the recovery
backlog, the operator inbox, usage, harness subagents, scheduling, the Mailbox backlog, and reply
delivery. `scheduling` reports the current queue and oldest queued Task, average and maximum queue
and placement duration, admission rejections, reservations consumed, active, and expired, and each
Worker Host's capacity and utilization. A reservation released after a declined claim leaves no
durable record, so the snapshot doesn't count it. Durations are milliseconds and utilization is a
number from zero to one. Everything except `rpc` comes from stored records, so reading metrics does
not contact a Worklet. Task events remain the detailed execution audit trail.

`rpc` reports the gRPC activity of the API Server process that answered the call, not of the whole
deployment. `startedAt` identifies the counter epoch; `capturedAt` is the observation time.
`methods` counts calls by service and method: started, completed, and active calls, active streams,
errors, status codes (entry N counts code N, for codes 0–16), and cumulative duration buckets in
milliseconds. The last bucket has no `le` and counts every duration. A stream's duration is its
lifetime, not the time for an individual Task or message. `channels` counts HTTP/2 connections; an
increase in opened connections alone does not distinguish new hosts from reconnects. `queues`
reports buffered Worklet frames and bytes, capacity, peaks, and overflow rejections; `closeCodes`
groups Worklet closures by code. `traceErrors` counts failed or dropped lifecycle-log writes.

RPC observations reset when the API Server process is replaced. Export snapshots to your monitoring
system if you need history, and use successive samples from the same `startedAt` epoch for rates.
They contain no Task identifiers, credentials, request bodies, or error messages.

### Worker Hosts and Auth Keys

`HostService` serves `supertag list worker-host`, `get worker-host`, `describe worker-host`,
`enroll worker-host`, `drain worker-host`, `resume worker-host`, `rotate worker-host-credential`,
`revoke worker-host-credential`, `update tag --add-worker-host` and `--remove-worker-host`, and
`create auth-key`, `list auth-key`, `get auth-key`, and `revoke auth-key`. The terminal UI's status
bar counts Worker Hosts by phase with `ListWorkerHosts`. The admin token and Operator Tokens may call
every RPC; a scoped coordination credential gets `permission_denied`.

A `WorkerHost` is the durable identity of an enrolled Worker Host, built from what the host last
reported. It carries its phase, drain state, credential revision, connection generation, protocols,
last observation, capacity, active Task Attempts, available slots, and last advertised Workers, so
disconnected and revoked hosts stay visible across Control Plane restarts. Neither its token nor its
logical credential ID appears. `ephemeral` is true for a host joined with an ephemeral Auth Key, and
`authKey` names the key a host redeemed. `ListWorkerHosts` leaves out ephemeral hosts revoked after
they disconnected; `GetWorkerHost` still reads them.

`EnrollWorkerHost` returns a `WorkerHostCredential` whose `token` appears only in that response. An
ID enrolls once: a repeat, or an ID a revoked host had, fails with `already_exists`.
`RotateWorkerHostCredential` takes `expectedCredentialRevision`, the host's current
`credentialRevision`, and returns a new credential. The old token stops working, and the host's
connection ends. A retry of a rotation that applied changes nothing and fails with
`failed_precondition`, as does rotating a revoked host. `RevokeWorkerHostCredential` revokes the host
and ends its connection; revoking it again returns it unchanged. `DrainWorkerHost` and
`ResumeWorkerHost` start and end a drain, and return the host without `storage`. The CLI writes each
issued credential to the mode-0600 file `--out` names and never prints its token.

`BindWorkerHost` and `UnbindWorkerHost` take a Tag name and a Worker Host ID. They return the Tag's
bound hosts and `changed`, which is false when nothing changed, so a retry is safe.

`CreateAuthKey` takes `name`, `tags`, and optional `labels`, `reusable`, and `ephemeral`. It returns
the `AuthKey` and its `secret`, once. Names are never reused: a repeat, or the name of a revoked or
expired key, fails with `already_exists`. `ListAuthKeys` and `GetAuthKey` never return the secret.
`RevokeAuthKey` blocks further joins; hosts that already joined keep their enrollment. See
[Auth Keys](resource-model.md#auth-keys) for the fields and rules.

Lists take `pageSize` (0 means 100, at most 500) and `pageToken`. Redeeming an Auth Key, and a host
acting on itself with its own credential, stay plain HTTP; see [Worklet API](#worklet-api).

```sh
curl -s https://control.example.com/supertag.operator.v1.HostService/DrainWorkerHost \
  -H "Authorization: Bearer $SUPERTAG_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"id": "build-east-1"}'
```

### Operator Tokens

`AccessService` serves `supertag create operator-token`, `list operator-token`,
`get operator-token`, and `revoke operator-token`. Only the admin token may call it; an Operator
Token or a scoped credential gets `permission_denied`.

`CreateOperatorToken` takes a `name` and returns the `OperatorToken` and its `secret`, once. A name
already used, even by a revoked token, fails with `already_exists`. `ListOperatorTokens` and
`GetOperatorToken` never return the secret, and lists page as `HostService` lists do.
`RevokeOperatorToken` refuses the token from the next call; revoking it again returns it. See
[Operator Tokens](resource-model.md#operator-tokens) for the fields and rules.

### Collaboration surfaces

`SurfaceService` serves `supertag setup surface`, `list surface`, `get surface`,
`update tag --add-location` and `--remove-location`, and `activate` and `deactivate` of a Context
Set or Permission Set. The admin token and Operator Tokens may call every RPC; a scoped coordination
credential gets `permission_denied`.

`SetUpSurface` saves a Surface Account whose credentials the CLI already verified with the
provider: `provider`, `externalAccountId`, `displayName`, `authMethod`, `configuration`, and
`secrets`. The secrets go to the Control Plane's credential vault and never appear in a response or
the audit log. An account with the same provider and external account ID is updated in place, so a
retry changes nothing more.

`ListSurfaceAccounts` lists connected accounts, the earliest created first, and pages as
`HostService` lists do. `GetSurfaceAccount` reads one by manifest name or by
`PROVIDER:EXTERNAL_ID`. Its `secrets` lists the references a SurfaceAccount manifest declared, and is
unset for an account that only `supertag setup surface` set up.

A `SurfaceLocation` names one place: `channelId` for Slack, `chatId` for Lark, `teamId` and
`channelId` for Microsoft Teams, `repo` or `repoId` for GitHub, and `team` or `teamId` for Linear.
`account` selects the Surface Account when the provider has several. The Control Plane resolves a
GitHub repository or Linear team name with the account's credentials.

`AddTagLocation` and `RemoveTagLocation` return `changed` false when the Tag already had the
location, or did not, so both are safe to retry. A location has at most one Tag: adding one that
another Tag has fails with `failed_precondition`. Removing a location also deactivates every set
activated there. `ActivateSet` and `DeactivateSet` take `kind` (`SET_KIND_CONTEXT_SET` or
`SET_KIND_PERMISSION_SET`), the set's name, the Tag, and one of the Tag's locations.

```sh
curl -s https://control.example.com/supertag.operator.v1.SurfaceService/AddTagLocation \
  -H "Authorization: Bearer $SUPERTAG_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"tag": "builder", "location": {"provider": "SURFACE_PROVIDER_SLACK", "channelId": "C0123456789"}}'
```

Applying and deleting SurfaceAccount manifests is described under [Resources](#resources).

### Resources

`ResourceService` serves `supertag apply -f`, `diff -f`, `get`, `list`, `describe`, `watch`, and
`delete` for configuration resources: Tags, Roles, Permission Sets, Context Sets, Volumes,
Workspaces, Surface Accounts, and Worker Profiles, which are observed and never applied. It also
serves `create tag`, the starter resources `supertag init` writes, the Workspaces `supertag up`
provisions, and the terminal UI's Tag rail. The admin token and Operator Tokens may call every RPC;
a scoped coordination credential gets `permission_denied`. Every RPC that names a resource takes
its `kind`, such as `RESOURCE_KIND_TAG`, and its `name`.

`GetResource` reads one resource, and `ListResources` lists one kind by name, 100 to a page by
default and at most 500. Each `Resource` holds one kind's message with `metadata`, `spec`, and
`status`. With `manifest`, it also holds the resource's manifest, which
`supertag get tag NAME --output yaml` prints for a Tag. A retired Tag is still read by name while no active Tag holds it, with
`status.phase` `TAG_PHASE_RETIRED`; listings leave retired Tags and Surface Accounts out.

`ApplyManifests` takes manifest `documents` as the client parsed them, each with a `source` that
names it in messages, such as `tags.yaml document 2`. The Control Plane checks the whole input
before it writes anything, then merges each field under its
[field manager](resource-model.md#field-managers-and-apply-sets) and applies the documents in
dependency order. These request fields select the manager:

| Field | Effect |
| --- | --- |
| none | Writes as field manager `apply`. |
| `applySet` | Writes as field manager `applySet` and records each resource as a member of that apply set. |
| `prune` | With `applySet`, then deletes the set's members the input no longer declares, as `DeleteResource` does, and reports each in `pruned`. A member still in use is kept. |
| `forceConflicts` | Applies changes to fields another manager owns and takes ownership of them. |
| `imperative` | Writes as field manager `cli`: each listed field replaces the stored one, and unlisted fields stay. `supertag create tag` uses it. |
| `createOnly` | Applies only documents whose resource doesn't exist yet. `supertag up` uses it. |

The whole input goes in one call, of at most 16 MB. The response has one result per document,
with its `outcome`, `warnings`, and, for an Objective, `startedTaskId` or `notStarted`. Applying is
not one transaction. When a document fails, those before it stay applied, the rest are not
applied, and the call succeeds with `complete` false. A failed document's `failure` has the
reason, and `failureMessage` says why; a failure of the Control Plane itself, such as a lost
database connection, has `ERROR_REASON_INTERNAL` and names no internal detail. Applying the same
input again changes nothing more, so a retry is safe.

An invalid input fails with `invalid_argument` and the message `supertag apply` prints, such as
`Nothing was applied. Invalid manifests:` and one line per problem. A change to another manager's
field fails with `failed_precondition`, reason `ERROR_REASON_CONFLICT`. Its `fields` name each
field's path and its `manager`. A change to a field that cannot change, such as an Objective's
outcome, fails the same way.

A SurfaceAccount document's `secrets` hold the values the client resolved from the manifest's
references. The Control Plane verifies new or changed credentials with the provider, as
`supertag setup surface` does, and stores them in its credential vault. They never appear in a
response, a log, or the audit log.

`DiffManifests` takes the same documents and flags, and changes nothing. Each plan has an
`action` (`PLAN_ACTION_CREATE`, `PLAN_ACTION_UPDATE`, or `PLAN_ACTION_UNCHANGED`), the field
`changes`, and the `conflicts` and `refusals` an apply would hit. It never reads secrets, and
refuses a document that carries them.

```sh
curl -s https://control.example.com/supertag.operator.v1.ResourceService/ApplyManifests \
  -H "Authorization: Bearer $SUPERTAG_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"documents": [{"manifest": {"apiVersion": "supertag/v1", "kind": "Tag", "metadata": {"name": "builder"}, "spec": {"roles": ["Builder"]}}}]}'
```

`DeleteResource` deletes one resource under the rules in [Deletion](resource-model.md#deletion).
Tags, Roles, and Surface Accounts retire; sets, Volumes, and Workspaces are deleted. Its response
has the `action` (`DELETION_ACTION_RETIRE` or `DELETION_ACTION_DELETE`), `removed`, and `notes`.
`removed` describes, for people, the configuration that went with the resource, such as
`Worker Host build-01 binding`. `notes` describes effects outside the Control Plane, such as Auth
Keys that can no longer join. With `dryRun` it gives the same answer, or the same refusal, and
changes nothing. A resource still in use fails with `failed_precondition`, and the message names
every reference, such as
`permission-set deploy is in use by Role Engineer and Tag release (location slack:C01).` A missing
resource, or a repeat after it is gone, fails with `not_found`. Objectives are cancelled with
`ObjectiveService.CancelObjective`, never deleted.

The JSON Schemas in [`spec/manifests/`](../../spec/manifests/) describe each manifest kind. They are
generated from the protos, as is `manifest.schema.json` for a manifest of any kind.

## Worklet API

Remote Worklets connect outbound to `/worklets` on the same Control Plane listener. Each Worklet
presents the credential issued for its declared Worker Host. The API Server binds that identity to a
connection generation—an increasing number identifying its current connection. It carries
assignments and cancellation, and accepts heartbeats,
receipts, and ordered Task Attempt events only from the current generation. The credential grants
only that Worker Host access to the Worklet API; it does not authorize management or
collaboration-surface requests.

Before storing a Worker event, the Worklet validates it against the same event schema used by the
connection. If a Worker emits an unknown event type, an event missing a required field or with a
field of the wrong type, or an event larger than 3 MiB, the Worklet omits that event and records an
`execution.failed` event naming the rejected type and error. The Task Attempt fails, while the
Worker Host connection stays open for other Task Attempts. Fields the schema doesn't name are kept
and delivered unchanged.

The `WorkerHost` status records the last successful credential claim, the cumulative number of
rejected claims against that enrolled host identity, and the most recent rejection time. These
fields survive Control Plane restart without exposing credential material.

Join a host with an [Auth Key](resource-model.md#auth-keys). An operator creates the key, and the
new host redeems it on its first connection:

```bash
supertag create auth-key build --tag builder
# On the new host:
SUPERTAG_AUTH_KEY=stak_... supertag connect worklet --transport websocket \
  --worklet-url https://supertag.example.com --worker-host build-east-1
```

Redemption calls `POST /api/v1/worker-host-joins` with the key as the bearer token and a
`WorkerHostJoin` body naming the requested host ID. It needs no operator credential. The response
is the one-time `WorkerHostCredential`, plus `status.authKey`, `status.tags`, and
`status.ephemeral`. Failures return `401` for an unknown key, `403` for an expired, revoked, or used
key, and `409` when one of the key's Tags no longer exists.

A Worker Host may also act on itself with its own credential, without an operator credential:
`DELETE /api/v1/worker-hosts/:id/credential` revokes it, and `POST /api/v1/worker-hosts/:id/drain`
and `/resume` start and end a drain. `supertag up` and `supertag down` drain a host service this
way before restarting or stopping it, and the host resumes itself when it starts again. A host
credential authorizes no other management request.

A custom Worker that reads its host credential from its own secret manager gets one from
`supertag enroll worker-host ID --out PATH`, which writes the one-time credential to a mode-`0600`
file. `supertag connect worklet --transport websocket --worklet-url URL --worker-host ID` resolves
the credential stored in `~/.supertag/worker-hosts/<host-id>.credential.json` without accepting an
arbitrary credential path. `supertag connect worklet --transport websocket --worklet-url URL` converts
`http:` to `ws:` and `https:` to `wss:` when `--transport websocket` is explicit, and supplies
`/worklets` when the URL has no explicit path. Without that override, HTTP(S) origins address
the separate gRPC listener. Explicit WS(S) URLs retain WebSocket.
Plain `http:` or `ws:` is accepted only for loopback addresses.
The API Server and Gateway share one process and HTTP listener. Internal gRPC services use
a separately configured listener in that process.

## Resource shape

`supertag get` and `list --output json` print resources in a common envelope:

```json
{
  "apiVersion": "supertag/v1",
  "kind": "Tag",
  "metadata": {
    "id": "01...",
    "name": "engineering",
    "resourceVersion": "2026-08-11T20:00:00.000Z",
    "createdAt": "2026-08-11T19:00:00.000Z",
    "updatedAt": "2026-08-11T20:00:00.000Z"
  },
  "spec": {
    "roles": ["Security Reviewer"]
  },
  "status": {
    "phase": "active",
    "locations": [
      {
        "provider": "slack",
        "account": "Engineering Slack",
        "target": "channel:C0123456789",
        "enabled": true
      }
    ]
  }
}
```

- `metadata` identifies and versions the resource.
- `spec` is user-controlled desired state.
- `status` is observed state maintained by the Control Plane.
- `resourceVersion` changes when the represented resource changes and must be treated as opaque.

Resource names make creation idempotent. Repeating Tag creation with the same name returns the
existing Tag. `Tag.spec.roles` lists the reusable responsibilities assigned to that actor;
execution requirements belong to Tasks.

The current `supertag watch` command observes change by polling these resource versions.
[`EventService.Watch`](#event-stream) streams notices of changes instead.

## Worker HTTP routes

Besides the operator RPCs, the Worklet API, health checks, and collaboration surface webhooks,
the Control Plane serves four plain HTTP routes for Worker Hosts:

```text
POST   /api/v1/worker-host-joins
DELETE /api/v1/worker-hosts/:id/credential
POST   /api/v1/worker-hosts/:id/drain
POST   /api/v1/worker-hosts/:id/resume
```

Joining is authorized by an Auth Key, and the others by the Worker Host's own credential; see
[Worklet API](#worklet-api).

### Errors

Errors from these routes use a structured `Status` document with a reason, HTTP code, message,
and optional details. A request with a field the Control Plane does not know fails with HTTP 400,
and the message names the field, such as `Unknown field: start`.

### Versions

Every response, including errors and `/healthz`, carries a `SuperTag-Version` header with the
Control Plane's release, such as `0.2.0-alpha.6`. `GET /healthz` needs no credential and returns
`{"ok": true, "version": "0.2.0-alpha.6"}`. The CLI sends its own release in
`SuperTag-Client-Version`. The supported pairs are in
[CLI and Control Plane versions](api-stability.md#cli-and-control-plane-versions).

## Deliberate exclusions

The API does not provide arbitrary process execution, filesystem access, database migrations, or
deployment lifecycle control. Worker Host credential operations are limited to enrollment,
rotation, and revocation; tokens do not appear in ordinary reads. The administrative credential has
full control-plane authority. Coordination endpoints can instead use separately configured
operator credentials restricted to exact actions and Objectives. Task events, resource change
history, structured permission decisions, and the [audit log](#audit-log) record what happened.

See [Credential storage](credential-storage.md) for the server-side vault and client-side operator credential boundaries.

## Coordination operations (Experimental)

`POST /internal/v1/coordination/mcp` is the MCP endpoint a running Task Attempt calls with its
execution credential. It offers only the tools that Task's turn may use; see
[Coordination tools](coordination.md#coordination-tools). The Control Plane derives the acting Tag
from the credential and refuses a tool the turn does not get.

Operators coordinate through [`InboxService`](#inbox) and [`ObjectiveService`](#objectives).

### Read a Task's progress

A Task is one turn of a Tag's Session. An execution Task Attempt records a particular Worker
run of that Task. Use `supertag get task ID` for the JSON `Task` or `supertag describe task ID`
for a readable summary. `supertag events task ID` shows its stored event history. All three call
[`WorkService`](#work).

`WorkService.GetTask` returns the Task's request, status, and times, and these observations when
records exist:

- `tag`: the Tag's name, beside `tagId`.
- `objectiveId`: the Objective whose Session the Task belongs to, when it has one.
- `findings`: the [findings](coordination.md#review-findings) its result carried, by severity, or
  why the stored findings are unreadable.
- `attempts`: every Task Attempt, oldest first, with its status, times, provider-reported cost
  when known, and mounts.
- `latestAttempt`: the latest Task Attempt, its Worker Profile, recorded Worker, Worker Host, and
  Worklet identities, last event, execution placement, warnings, and the recorded failure message
  when its latest terminal event failed. Error stacks and additional error fields are omitted;
  messages keep the Worker's event redaction. A new Task Attempt does not inherit an earlier
  error. The harness runtime hosts the agent process; the tool execution environment receives its
  workspace operations. They may be on different machines.
- `scheduling`: the last stored scheduling check, its time, and unmet requirements. `status` is
  `SCHEDULING_STATUS_COMPATIBLE` or `SCHEDULING_STATUS_INCOMPATIBLE`. A later check supersedes an
  earlier one. Describe shows this only for queued work.
- `delivery`: what the Task delivered: a Workspace branch with its base and head commits,
  patches, a pull request, or outputs.
- `storage`: where the Task's files and artifact copies are kept. `ListTasks` leaves it out.

Free-form records stay JSON objects: `trigger`, `outcome`, and each event's `payload`.

These reads use stored evidence and do not contact a Worklet. Unknown host identity is shown as
“not recorded”; it is never inferred from another Worker's current advertisement. Missing terminal
execution evidence does not prove a process stopped. A pending Task without a scheduling diagnosis
is not automatically classified as a capacity or connectivity problem. For a receipt from the
execution owner, use the separate execution inspection below.

`resourceVersion` changes when these observations change, even if the Task's status does not.
`get` and `watch` print JSON; `describe task ID` presents the summary in plain text.

### Inspect the latest Task execution

`WorkService.InspectTaskExecution` returns `availability` (`TASK_EXECUTION_AVAILABILITY_AVAILABLE`,
`UNAVAILABLE`, `UNSUPPORTED`, or `NOT_STARTED`) and the latest `attemptId` when present. An
available response includes the durable Worklet `receipt`, with its status and last event
sequence. When the Control Plane reaches the Worker Host, it first records the Worker events the
receipt names and it lacks, so the response and `ListTaskEvents` include them. A Worker Host it
cannot reach makes `availability` `TASK_EXECUTION_AVAILABILITY_UNAVAILABLE`, not an error. The
audit log records `task.inspect`.

Every response also includes a `limits` projection. It reports the Task's requested limits, the
effective controls recorded by the harness in `execution.limits.applied`, the latest cumulative
usage report, peak observed native children, evidence completeness, and an explicit outcome. A
`threshold_reached` outcome is derived only from an applied numeric ceiling and durable numeric
usage or native-agent observations. Missing or incomplete evidence produces `pending` or
`unknown`; terminal error text is never treated as proof that a limit was enforced. The projection
therefore remains available after Control Plane recovery or while its Worklet is disconnected, even
when the optional receipt is unavailable. Applied methods currently distinguish provider-native
agent controls, harness guards, interrupt-on-report token controls, and provider budget controls.

Every response also includes a `placement` projection built from the latest durable Runtime Input
Manifest. It reports whether the harness runtime and workspace execution environment were
`colocated` or `split`, then identifies each access by ID, provider, and placement. Environment
guarantees and credential-free provider provenance are included when available. Shared execution
provenance identifies the environment incarnation, per-Task Attempt access, and expiry without exposing
its bearer token. Missing evidence remains `pending` for a running Task Attempt and `unknown` after a
terminal Task Attempt. This projection also survives Control Plane recovery and does not depend on a
connected Worklet.

The placement projection also reports `cleanup`. A Worker emits its terminal execution event only
after closing the harness execution and both environment accesses. `confirmed` therefore means
that durable terminal event was observed. A running Task Attempt normally remains `pending`; a terminal
Task Attempt without the event remains `unknown`. A recorded cleanup failure also makes cleanup
`unknown`, even while the stored Task Attempt phase is still `running`. The phase alone does not tell
you whether a process is currently executing.

`placement.cleanupFailure` contains the latest Task Attempt's retained cleanup diagnostic, or is unset.
It includes the event sequence and time plus bounded, redacted error messages identifying failed
cleanup stages. When execution failed before cleanup also failed, the diagnostic preserves the
original execution error too. A later terminal execution event clears this diagnostic from the
current projection; the full event history remains available. Prior Task Attempts' errors and ordinary
model progress are not included.

For durable execution, the recorded Worker Host, Worklet, and Worker identities come from
acceptance or recovery receipts. A requested Worker Profile is a capacity requirement, not a
selected host. Before a confirmed receipt identifies the selected host, these fields remain
unrecorded. An unknown receipt cannot establish a new host binding, and an existing binding
cannot silently change during recovery. Older records may contain a placeholder or an
aggregate Worklet descriptor captured before receipt-based recording was available. Those
values are unconfirmed provenance; they are not rewritten into a confirmed binding when a
receipt conflicts with them. The identity mismatch remains an error requiring inspection.

The same projection appears at `latestAttempt.placement` in `GetTask`.
`supertag describe task ID` distinguishes a waiting assignment from confirmed cleanup and prints retained cleanup
errors. These are stored observations, not a live health check of the Worker Host.

It neither retries execution nor changes Task state; it only records Worker events the Control
Plane missed. `supertag describe task ID` shows the stored placement from `GetTask` without asking
the Worker Host.

## Artifact inspection

An **artifact** is a captured result with an immutable file manifest. Three
[`WorkService`](#work) RPCs read artifacts:

| RPC | Result |
| --- | --- |
| `ListArtifacts` | Captured artifacts, oldest first, with an optional `taskId` filter. `pageSize` 0 means 20, at most 100. |
| `GetArtifact` | One artifact's files with their paths, digests, and sizes, and its source Task. |
| `ResolveArtifactDownload` | Where one file at `path` can be read. Never file content. |

Each artifact's `copies` lists where its copies are: `workerHost` entries with `workerHostId`,
`ephemeral`, and `removed`, and `volume` entries with the Volume's name. `ephemeralOnly` is true
when some file is held only on ephemeral Worker Hosts and no Volume.

The Control Plane stores no artifact bytes, so no RPC returns file content. The bytes stay on the
Worker Hosts and Volumes that hold copies, and move over plain HTTP from them to the caller.
`ResolveArtifactDownload` returns the file's `digest` and `sizeBytes`, `volumes` with each
Volume's source, credential name, and key, and `transfers` with the producing Worker Host's
`transferUrl` and a signed `grant`. The grant is bound to that file, that host, and the requesting
operator, and expires at `expiresAt`, 60 seconds later. Each call issues new grants. `holders`
lists every Worker Host and Volume that holds the file. The caller reads a Volume copy with its own
mapping for the credential name and must check the digest. The audit log records
`artifact.download`. Tasks consume artifacts through exact artifact inputs, preserving the existing
Worker-to-Worker transfer permissions.

See the [CLI walkthrough](../operations/cli.md) for listing results without writing an API client.

## Session persistence

A **Session** groups Tasks from one conversation and owns its stored native conversation state.
For example, a conversation started with Codex on one Worker Host can continue on another host
that can restore its native files and provide compatible tools and workspace access. Claude Code
uses its SDK's Session storage callbacks to preserve main and subagent transcript entries.
Conversation storage does not restore workspace files, running processes, or a sandbox.

Two [`WorkService`](#work) RPCs read the stored state:

| RPC | Response |
| --- | --- |
| `ListSessionStates` | A Session's native archives, newest first, each with its `nativeId`; the `data` payloads are left out. Set `nativeId` to select one native conversation. |
| `GetSessionState` | One archive, including its native `data`. An archive of another Session fails with `not_found`. It needs the `read_session_state` action. |

Native IDs identify a Codex thread or Claude conversation; the SuperTag Session ID groups the
work across these native conversations. The API retrieves stored state rather than starting an
execution. Continue the conversation through its existing Session; the Control Plane selects a
compatible resume point when admitting the next Task.

An archive's `status` is `SESSION_STATE_STATUS_STORED` while its native data is available but has
not been approved for automatic resumption. Successful execution can promote it to
`SESSION_STATE_STATUS_RESUMABLE`. A partially synchronized
or failed Task Attempt can therefore remain inspectable without becoming a resume point. Even a
`resumable` record resumes only for the same Tag and Session, the same reply audience, and the
harness that produced it, and that harness must be able to load it where it runs; a newer
execution without eligible state blocks fallback to older native state. Native transcripts are
private Session data and are not discoverable through the artifact catalog or exposed as a new
coordination tool.

### Worker storage contract

Built-in connected TypeScript Workers use `HttpSessionStateStore` to call
`POST /internal/v1/sessions/save` and `POST /internal/v1/sessions/load`. These internal endpoints
require an execution credential for the current Task Attempt. The Control Plane can supply a
Session-only credential in `session.persistence: {controlPlaneUrl, token}` without exposing
coordination tools. That credential grants only Session save/load access, not Mailbox or artifact
operations. Existing coordinated execution can use its scoped execution credential. Neither path
uses the administrative token or a native provider credential. Loads are limited to the current Task Attempt's state or the compatible prior
state selected for that Session. Writes belong to the current active Task Attempt.

A save contains `ref`, `harnessId`, `data`, and a positive `writeVersion`. The HTTP adapter assigns
increasing write versions to each state so delayed writes cannot overwrite newer transcript data.
A load contains `ref` and returns the matching native state or null. Custom implementations must
preserve these identity, ordering, and authorization checks. The Python SDK exposes the same
Session storage contract but requires an explicitly supplied durable adapter.

### Continuing Objectives and operator attention

`CreateObjective` accepts `ongoing: true` for a continuing responsibility that only an operator may mark
completed. The default is `false`: the owner completes it after assessing the outcome and
settling outstanding work.

Inbox items of kind `INBOX_ITEM_KIND_TASK_ATTENTION` identify a Task that needs an operator.
Their `reason` explains why inspection is needed. Reading an item does not resolve it. An item for an uncertain Task Attempt carries `uncertainAttempt`
(`attemptId`, `workerHostId`, `workerId`), and its first `commands` entry is the
`supertag recover worklet` command for it. See
[Uncertain Task Attempts](scheduling-and-recovery.md#uncertain-task-attempts).

### Objective allocation recovery

`ObjectiveService.UpdateObjective` accepts an optional nonnegative `budgetLimitMinor` with
`expectedRevision`. It must increase an active Objective's finite limit; it cannot remove a limit
or change its currency. Agent callers are rejected. The resource-change history records the
operator and the old and new values atomically.

`UpdateObjective` also accepts `deadline` with `expectedRevision`. It may replace a deadline that
already passed, and the change is audited the same way. A Tag's `update_objective` tool call that
sends `deadline` is refused.

The Objective's read-only `limitState` records the Control Plane's limit observations: the
reported spend of a monetary budget, the 80% warning, exhaustion, deadline warnings, and deadline
passage. Each entry names the limit or deadline it was observed against, so entries for an old
limit stop applying after a change. The rules are in
[The budget pool](coordination.md#the-budget-pool) and [Deadlines](coordination.md#deadlines).

An `INBOX_ITEM_KIND_OBJECTIVE_LIMIT` item carries the event in `reason`, an `objective` evidence
entry, and commands that raise the budget or move the deadline.
For an approaching deadline, `reason` calculates the time left when the inbox is read: a warning
created an hour before the deadline says about 27 minutes left when it is read 27 minutes before
it, and says the deadline has passed afterwards. Configured Gateway notices are sent once per item
and revalidated before delivery.

The inbox kinds are `INBOX_ITEM_KIND_APPROVAL`, `QUESTION`, `OBJECTIVE_BUDGET`, `OBJECTIVE_LIMIT`,
`TASK_ATTENTION`, and `MCP_LOGIN`. A question item stands for an Objective whose latest turn called `ask`. An
MCP login item marks a queued Task held because its Worker Host's login to an MCP server
lapsed; its key is `mcp_login:TASK_ID:SERVER`, and its commands are `supertag mcp login SERVER`,
then `supertag describe objective ID`. See [MCP OAuth login](supertag-yaml.md#mcp-oauth-login)
and [Operator inbox](coordination.md#operator-inbox).

For the pool and its ceilings, see [The budget pool](coordination.md#the-budget-pool). For what an
operator's message changes, see [Operator messages](coordination.md#operator-messages).
