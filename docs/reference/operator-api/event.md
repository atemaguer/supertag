# EventService

<!-- Generated from spec/proto/supertag/operator/v1 by scripts/protoc-gen-operator-docs.mjs. Edit the proto comments, not this file. -->

`supertag.operator.v1.EventService` in [`event.proto`](../../../spec/proto/supertag/operator/v1/event.proto). How to call an RPC, authenticate, and
read its errors is in the [Control Plane API Server](../control-plane-api.md) guide; the conventions every
RPC follows are in [Shared messages and options](shared.md#conventions).

Tells an operator's client what changed, so it rereads only that.

## RPCs

### Watch

| | |
| --- | --- |
| Procedure | `/supertag.operator.v1.EventService/Watch` |
| Request | [`WatchRequest`](#watchrequest) |
| Response | A server stream of [`WatchEvent`](#watchevent) |
| Action | `watch_events` |
| Callers | The admin token, Operator Tokens, and scoped coordination credentials |
| Audit log | Nothing; reads only |

Streams a notice for each change the caller may see. A notice names what
changed and carries none of its state: the client rereads it through the
RPC that reads that kind of thing.

Without `resume_token`, the first event is a `heartbeat` whose
`resume_token` marks where the stream starts. To show current state
without missing a change, call `Watch`, wait for that first event, read
the state, then apply the changes that follow.

Every event carries a `resume_token`. To resume a dropped stream, call
again with the last one received. The server then sends the changes after
it, in the order it recorded them. When it cannot, because the token is
too old or from before the Control Plane restarted, the first event is a
`resync`: the client rereads everything it shows. A token the server did
not issue fails with `InvalidArgument`.

A notice may stand for several changes to the same thing, and the same
change may arrive twice, so a client treats each notice as a reason to
reread. A `heartbeat` follows 15 seconds without another event. The stream
stays open until the client cancels the call or the Control Plane drains,
which ends it with `Unavailable`.

The caller sees only changes to what it could read through the other
RPCs, with the same actions and scope:

- `WATCH_KIND_CONVERSATION_MESSAGE`: messages in the caller's own
  conversations, as `ConversationService.GetMessage` reads them. The
  credential needs the `read_conversation` action. A scoped coordination
  credential has no conversations and sees none.
- `WATCH_KIND_SESSION` and `WATCH_KIND_TASK`: every Session and Task for
  the admin token and Operator Tokens, except that a conversation's
  Session and its Tasks, work Sessions included, reach only the operator
  whose conversation it is. A scoped coordination credential with the
  `read_objective` action sees only the Tasks of Objectives its scope
  allows, by `objective_id`, and no Sessions.
- `WATCH_KIND_TAG`: every Tag, for the admin token and Operator Tokens. A
  scoped coordination credential sees none.
- `WATCH_KIND_OBJECTIVE`: Objectives the credential's Objective scope
  allows, with the `read_objective` action.
- `WATCH_KIND_INBOX_ITEM`: inbox items of Objectives the credential's
  Objective scope allows, with the `read_coordination_inbox` action.
- `WATCH_KIND_APPROVAL`: approval requests of Objectives the credential's
  Objective scope allows, with the `list_approvals` action. A request
  outside any Objective reaches only a credential without an Objective
  scope.
- `WATCH_KIND_WORKSTREAM_POST`: posts to every Team's Workstream for the
  admin token and Operator Tokens. A scoped coordination credential with
  the `read_objective` action sees posts to the Teams of Objectives its
  scope allows, as `ObjectiveService.DescribeObjective` shows them.

The admin token and Operator Tokens carry every action and have no
Objective scope. A scoped coordination credential needs the
`watch_events` action to call `Watch` at all. A call while the Control
Plane drains fails with `Unavailable` and `ERROR_REASON_DRAINING`.

A kind the caller may not see is left out silently, even when `kinds`
names it.

## Messages

### WatchRequest

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `resume_token` | `resumeToken` | `string` | The last `WatchEvent.resume_token` the client received. Empty starts with the changes from now on. |
| `kinds` | `kinds` | repeated [`WatchKind`](#watchkind) | Sends only changes of these kinds. Empty sends every kind the caller may see. |

### WatchEvent

One event on the watch stream.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `resume_token` | `resumeToken` | `string` | Resumes the stream after this event. It is opaque. |
| `change` | `change` | [`WatchChange`](#watchchange) | One of `event`. Something changed. |
| `resync` | `resync` | [`WatchResync`](#watchresync) | One of `event`. The server could not replay from the request's `resume_token`. |
| `heartbeat` | `heartbeat` | [`Heartbeat`](shared.md#heartbeat) | One of `event`. Nothing changed for 15 seconds. |

Oneof `event`: `change`, `resync`, `heartbeat`. What the event is. Exactly one is set.

### WatchChange

A notice that one thing changed. Only the fields its kind names are set.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `kind` | `kind` | [`WatchKind`](#watchkind) | What kind of thing changed. |
| `id` | `id` | `string` | The ID of what changed. |
| `tag` | `tag` | `string` | The name of the Tag it belongs to. |
| `session_id` | `sessionId` | `string` | The Session it belongs to. |
| `task_id` | `taskId` | `string` | The Task it belongs to. |
| `objective_id` | `objectiveId` | `string` | The Objective it belongs to. |
| `conversation` | `conversation` | `string` | The caller's conversation it belongs to, by name. |
| `reason` | `reason` | `string` | What happened, in a few words for logs and people, such as `created` or `status completed`. Clients do not parse it. |
| `changed_at` | `changedAt` | `google.protobuf.Timestamp` | When the change happened. |
| `team_id` | `teamId` | `string` | The ID of the Team it belongs to. |

### WatchResync

The stream continues from now, but the changes since the requested resume
token are lost. The client rereads everything it shows.

No fields.

## Enums

### WatchKind

What kind of thing changed.

| Value | Description |
| --- | --- |
| `WATCH_KIND_UNSPECIFIED` |  |
| `WATCH_KIND_TAG` | A Tag was created, changed, or deleted, or its status changed. `id` is the Tag's ID and `tag` its name. |
| `WATCH_KIND_SESSION` | A Session was created or changed. `id` is the Session's ID; `tag` names its Tag, and `conversation` the caller's conversation when the Session is one. |
| `WATCH_KIND_TASK` | A Task was created or its status changed. `id` is the Task's ID; `session_id`, `tag`, and `objective_id` for an Objective's Task, name what it belongs to. |
| `WATCH_KIND_OBJECTIVE` | An Objective was created or changed, including its status. `id` is the Objective's ID and `tag` its owner Tag. |
| `WATCH_KIND_INBOX_ITEM` | An inbox item appeared, changed, or was resolved. `id` is the item's ID and `objective_id` its Objective's. |
| `WATCH_KIND_APPROVAL` | An approval request was created, decided, or expired. `id` is the request's ID; `task_id` names the Task that asked, and `objective_id` its Objective when it has one. |
| `WATCH_KIND_CONVERSATION_MESSAGE` | A message in one of the caller's conversations was sent, got its reply, or one of its work Sessions changed. `id` is the message's Task ID, as `Message.task_id`; `tag`, `conversation`, and `session_id` name its conversation. Reread it with `ConversationService.GetMessage`. |
| `WATCH_KIND_WORKSTREAM_POST` | A Team's Workstream got a post. `id` is the post's ID and `team_id` its Team's. Reread the Objectives the Team serves with `ObjectiveService.DescribeObjective`, which carries the newest posts. |
