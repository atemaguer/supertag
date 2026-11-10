# ConversationService

<!-- Generated from spec/proto/supertag/operator/v1 by scripts/protoc-gen-operator-docs.mjs. Edit the proto comments, not this file. -->

`supertag.operator.v1.ConversationService` in [`conversation.proto`](../../../spec/proto/supertag/operator/v1/conversation.proto). How to call an RPC, authenticate, and
read its errors is in the [Control Plane API Server](../control-plane-api.md) guide; the conventions every
RPC follows are in [Shared messages and options](shared.md#conventions).

An operator's private conversations with Tags in the terminal UI or
through the operator API.

A conversation is one Session between the caller and a Tag, named by the
caller. The same name continues the same Session, so the Tag sees the
earlier messages and replies. A conversation is private: the admin token is
one operator and each Operator Token is another, and each one reads only its
own conversations. Another operator's message fails with `NotFound`, exactly
as a message that does not exist.

A message is one turn of the conversation, named by the ID of the Task it
started. The Tag answers with its Roles' permissions only; no location's
Permission or Context Sets apply. A turn may hand work to work Sessions.
Each one reports its result back into the conversation as a later turn, and
the message that started it carries that report.

Access. The admin token and Operator Tokens may call every RPC; a scoped
coordination credential is refused with `PermissionDenied`.

Every RPC that names a Tag takes its name, and fails with `NotFound` for an
empty name or a Tag that does not exist or was deleted. A call while
the Control Plane drains fails with `Unavailable` and
`ERROR_REASON_DRAINING`.

## RPCs

### SendMessage

| | |
| --- | --- |
| Procedure | `/supertag.operator.v1.ConversationService/SendMessage` |
| Request | [`SendMessageRequest`](#sendmessagerequest) |
| Response | [`Message`](#message) |
| Action | `message_tag` |
| Callers | The admin token and Operator Tokens |
| Audit log | `tag.message` |

Sends one message to the Tag as the caller and returns it before the Tag
answers, usually with `status` `REPLY_STATUS_WAITING`. Follow the reply
with `FollowMessage`.

A message sent while an earlier turn of the conversation still runs is
delivered into that turn: `joined_task_id` then names it, once the
Control Plane delivered it, and that turn's reply answers this message
too.

It fails with `InvalidArgument` for empty text or a malformed
conversation name, and `FailedPrecondition` with `ERROR_REASON_CONFLICT`
when the Tag does not accept the message, with the message saying why.

### GetMessage

| | |
| --- | --- |
| Procedure | `/supertag.operator.v1.ConversationService/GetMessage` |
| Request | [`GetMessageRequest`](#getmessagerequest) |
| Response | [`Message`](#message) |
| Action | `read_conversation` |
| Callers | The admin token and Operator Tokens |
| Audit log | Nothing; reads only |

Reads one message: its reply once the Tag answered, and each work Session
its turn started with that work Session's report. It fails with `NotFound`
when the Tag does not exist or `task_id` is not a message the caller can
read.

### FollowMessage

| | |
| --- | --- |
| Procedure | `/supertag.operator.v1.ConversationService/FollowMessage` |
| Request | [`FollowMessageRequest`](#followmessagerequest) |
| Response | A server stream of [`FollowEvent`](#followevent) |
| Action | `read_conversation` |
| Callers | The admin token and Operator Tokens |
| Audit log | Nothing; reads only |

Follows one message until there is nothing more to show: the turn's reply
as the Tag writes it, then the work Sessions the turn started until each
one has reported. One call replaces rereading the message. It fails as
`GetMessage` does.

The stream has two phases and ends with `end`:

1. The turn. `joined` first, when the message was delivered into a
   running turn. `waiting` while no bound Worker Host can run the turn.
   `text_delta` and `activity` while it runs. Then exactly one of
   `finish`, with the reply, or `error`, when the turn ended in an error.
2. The work. After `finish`, `activity` events with `work_session_id`
   carry each work Session's commands and tool calls, and a
   `work_session_changed` follows each change to a work Session. Work
   Sessions appear only in this phase: those the turn started are listed
   in `finish.message`.

`end` comes once every work Session is settled: its report arrived, and
it does not wait only on an approval decision. A decision on an approval
request continues the work Session as its next Task, so the stream stays
open through it and shows that Task's work and report. A work Session
that asked the person a question is settled; the answer is the caller's
next message. A message without work Sessions ends right after `finish`.
After `error` the stream sends `end` and follows no work. The server then
closes the stream.

How the stream starts depends on the message:

- A running turn: the text and activity the turn wrote so far, then the
  rest as it is written.
- A turn that has not started: nothing until it starts, apart from
  `waiting` and heartbeats.
- A message that joined a running turn: `joined`, then that turn's text
  and activity from the moment of the call, since its earlier text
  answered earlier messages, then that turn's `finish` or `error`. When
  that turn ends without having read the message, the delivery is
  withdrawn: `joined` with an empty `task_id` follows, then the message's
  own turn from its start.
- A finished turn: `finish` or `error` with the stored reply at once,
  without text or activity, then the work phase.

Every event except `heartbeat` carries a `sequence`. Sequences increase
within the stream, and each is greater than `after_sequence`. To resume a
dropped stream, call again with the last sequence received:

- While the server still holds the events after it, the new stream
  continues exactly, repeating and skipping nothing.
- When it does not, because the Control Plane restarted or forgot a
  finished turn's live text, the new stream starts from the current
  state. It skips text and activity it no longer holds and never repeats
  them. It sends `joined`, `waiting`, `finish` or `error`, and a
  `work_session_changed` for each work Session again where they describe
  the current state.

So a client applies `joined`, `waiting`, `finish`, `error` and
`work_session_changed` as state, not as counts: it shows a reply once per
message and a work Session line when a snapshot differs from the one it
holds. `finish.reply` is the whole reply; it replaces any text deltas.

The stream stays open until `end`, until the client cancels the call, or
until the Control Plane drains, which ends it with `Unavailable`. The
server sets no deadline. Canceling the call stops following while the Tag
keeps working. After `finish`, a client can cancel once every work Session
it tracks has `report_status` `REPLY_STATUS_REPLIED`, including Sessions
that have reported while waiting on approval.

### ListConversations

| | |
| --- | --- |
| Procedure | `/supertag.operator.v1.ConversationService/ListConversations` |
| Request | [`ListConversationsRequest`](#listconversationsrequest) |
| Response | [`ListConversationsResponse`](#listconversationsresponse) |
| Action | `read_conversation` |
| Callers | The admin token and Operator Tokens |
| Audit log | Nothing; reads only |

Lists the caller's conversations, the most recent message first. Empty
`tag` lists every Tag's. It fails with `NotFound` when `tag` names a Tag
that does not exist, and `InvalidArgument` for a malformed `page_token`.

### ListMessages

| | |
| --- | --- |
| Procedure | `/supertag.operator.v1.ConversationService/ListMessages` |
| Request | [`ListMessagesRequest`](#listmessagesrequest) |
| Response | [`ListMessagesResponse`](#listmessagesresponse) |
| Action | `read_conversation` |
| Callers | The admin token and Operator Tokens |
| Audit log | Nothing; reads only |

Lists the messages the caller sent in one conversation, newest first, each
as `GetMessage` returns it. A conversation the caller never wrote in has
no messages. It fails with `InvalidArgument` for a malformed
`page_token`.

## Messages

### SendMessageRequest

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `tag` | `tag` | `string` | The Tag's name. |
| `conversation` | `conversation` | `string` | The conversation's name: 1 to 64 letters, digits, `.`, `_` or `-`, starting with a letter or digit. Empty means `default`. |
| `text` | `text` | `string` | The message. Leading and trailing whitespace is removed, and what remains must not be empty. |
| `idempotency_key` | `idempotencyKey` | `string` | Makes a retry safe. A repeat with the same key from the same caller to the same Tag returns the message the first call created and sends nothing, whatever its text or conversation. A key is 1 to 200 characters without whitespace or control characters. Empty sends every call. |

### GetMessageRequest

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `tag` | `tag` | `string` | The Tag's name. |
| `task_id` | `taskId` | `string` | The message's Task ID, as `Message.task_id`. |

### FollowMessageRequest

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `tag` | `tag` | `string` | The Tag's name. |
| `task_id` | `taskId` | `string` | The message's Task ID, as `Message.task_id`. |
| `after_sequence` | `afterSequence` | `int64` | The last `FollowEvent.sequence` the client received, to resume a dropped stream. 0 starts from the beginning. |

### ListConversationsRequest

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `tag` | `tag` | `string` | Lists only conversations with this Tag, by name. Empty lists every Tag's. |
| `page_size` | `pageSize` | `int32` | At most this many conversations; 0 means 50, and more than 100 means 100. |
| `page_token` | `pageToken` | `string` | The `next_page_token` of the previous page. |

### ListConversationsResponse

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `conversations` | `conversations` | repeated [`Conversation`](#conversation) | The caller's conversations, the one with the most recent message first. |
| `next_page_token` | `nextPageToken` | `string` | Fetches the next page. Empty on the last page. |

### ListMessagesRequest

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `tag` | `tag` | `string` | The Tag's name. |
| `conversation` | `conversation` | `string` | The conversation's name. Empty means `default`. |
| `page_size` | `pageSize` | `int32` | At most this many messages; 0 means 50, and more than 100 means 100. |
| `page_token` | `pageToken` | `string` | The `next_page_token` of the previous page. |

### ListMessagesResponse

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `messages` | `messages` | repeated [`Message`](#message) | The messages, newest first. |
| `next_page_token` | `nextPageToken` | `string` | Fetches the next page. Empty on the last page. |

### Conversation

One of the caller's conversations with a Tag.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `tag` | `tag` | `string` | The Tag's name. |
| `name` | `name` | `string` | The conversation's name, such as `default`. |
| `session_id` | `sessionId` | `string` | The conversation's Session. |
| `last_message_text` | `lastMessageText` | `string` | The start of the conversation's most recent entry, at most 200 characters: the caller's latest message, the Tag's reply to it, or a work Session's report, whichever came last. |
| `last_message_author` | `lastMessageAuthor` | [`ConversationAuthor`](#conversationauthor) | Who wrote `last_message_text`. |
| `last_message_at` | `lastMessageAt` | `google.protobuf.Timestamp` | When the most recent entry was written. |
| `open_work_session_count` | `openWorkSessionCount` | `int32` | How many work Sessions the conversation's turns started are not finished: their status is `WORK_SESSION_STATUS_PENDING`, `WORK_SESSION_STATUS_RUNNING` or `WORK_SESSION_STATUS_WAITING`. |

### Message

One message in a conversation and what answered it.

A message is one the caller sent, or a turn of an Objective whose home
thread is one of the caller's conversations. A turn of an Objective without
a home thread is readable by every operator. A work Session's own Task is not
a message: the message that started it carries it in `work_sessions`.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `task_id` | `taskId` | `string` | The ID of the Task the message started. It names the message. |
| `tag` | `tag` | `string` | The Tag's name. |
| `conversation` | `conversation` | `string` | The conversation's name. For an Objective turn without a home thread, it is `objective:` and the Objective's ID. |
| `session_id` | `sessionId` | `string` | The conversation's Session. |
| `text` | `text` | `string` | What the message said: the caller's text, or the text an Objective turn delivered. |
| `created_at` | `createdAt` | `google.protobuf.Timestamp` | When the message was sent. |
| `status` | `status` | [`ReplyStatus`](#replystatus) | Whether the Tag has replied. |
| `waiting_reason` | `waitingReason` | `string` | Why the turn has not started, in one line, while no bound Worker Host can run it, such as `no bound Worker Host provides MCP server notes`. Empty once the turn can be placed or after the reply. |
| `reply` | `reply` | [`Reply`](#reply) | The Tag's final reply: the turn's result, or the error that ended it. Set when `status` is `REPLY_STATUS_REPLIED`. |
| `joined_task_id` | `joinedTaskId` | `string` | The running turn this message was delivered into, when it joined one instead of starting its own. That turn's reply is `reply`. It goes back to empty when that turn ends without reading the message, which then runs as its own turn. |
| `work_sessions` | `workSessions` | repeated [`WorkSession`](#worksession) | The work Sessions this message's turn started or continued, oldest first. |

### Reply

A reply the Tag wrote: its answer to a message, or a work Session's report.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `presentation` | `presentation` | [`ReplyPresentation`](#replypresentation) | What kind of reply it is. |
| `text` | `text` | `string` | The text, as the Tag wrote it. |

### WorkSession

A work Session a message's turn started: its latest Task and its report.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `id` | `id` | `string` | The work Session's ID. |
| `title` | `title` | `string` | The title the Tag gave the work. |
| `task_id` | `taskId` | `string` | The work Session's latest Task. Empty until it has one. A decision on an approval request continues the work Session as a new Task, which this then names. |
| `status` | `status` | [`WorkSessionStatus`](#worksessionstatus) | How the latest Task is doing. |
| `question` | `question` | `string` | What the Task asked the person, when it completed by asking. The answer is the caller's next message in the conversation. |
| `approvals` | `approvals` | repeated [`ApprovalNotice`](#approvalnotice) | A notice for each of the Task's pending approval requests, as the Tag posted it to the conversation. Decide one with `supertag approve request` or `supertag deny request`; the decision continues the work Session. |
| `not_continued` | `notContinued` | `string` | Why a decision on a request the Task waited on did not continue the work Session, such as the Tag's permissions changing or the turn's limits being spent. `status` is then the Task's own. |
| `report_status` | `reportStatus` | [`ReplyStatus`](#replystatus) | Whether the report on the latest Task has been written. |
| `report_task_id` | `reportTaskId` | `string` | The conversation turn that reports the work Session's result. |
| `report` | `report` | [`Reply`](#reply) | The report. Set when `report_status` is `REPLY_STATUS_REPLIED`. |

### ApprovalNotice

The notice the Tag posted for one pending approval request.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `request_id` | `requestId` | `string` | The approval request's ID. |
| `text` | `text` | `string` | The notice. |

### FollowEvent

One event while following a message. See `FollowMessage` for the order.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `sequence` | `sequence` | `int64` | Orders the stream's events and resumes it as `after_sequence`. 0 only on `heartbeat`, which is never resumed from. |
| `joined` | `joined` | [`JoinedTurn`](#joinedturn) | One of `part`. The message was delivered into a running turn, which answers it, or, with an empty `task_id`, that delivery was withdrawn. |
| `waiting` | `waiting` | [`PlacementWait`](#placementwait) | One of `part`. Why the turn has not started. Sent when the reason changes. |
| `text_delta` | `textDelta` | [`TextDelta`](#textdelta) | One of `part`. Reply text as the Tag writes it. |
| `activity` | `activity` | [`Activity`](#activity) | One of `part`. A command, tool call or retry of the turn or of a work Session. |
| `finish` | `finish` | [`Finish`](#finish) | One of `part`. The turn ended with its reply. |
| `error` | `error` | [`TurnError`](#turnerror) | One of `part`. The turn ended with an error instead of a reply. |
| `work_session_changed` | `workSessionChanged` | [`WorkSessionChanged`](#worksessionchanged) | One of `part`. A work Session the turn started changed. |
| `end` | `end` | [`FollowEnd`](#followend) | One of `part`. Nothing more will follow. The last event of the stream. |
| `heartbeat` | `heartbeat` | [`Heartbeat`](shared.md#heartbeat) | One of `part`. Keeps an idle stream open. |

Oneof `part`: `joined`, `waiting`, `text_delta`, `activity`, `finish`, `error`, `work_session_changed`, `end`, `heartbeat`. What happened. Exactly one is set.

### JoinedTurn

The running turn a message was delivered into.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `task_id` | `taskId` | `string` | That turn's Task, as `Message.joined_task_id`. Empty when the delivery was withdrawn because that turn never read the message, which then runs as its own turn. |

### PlacementWait

Why a turn has not started.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `reason` | `reason` | `string` | One line, as `Message.waiting_reason`. |

### TextDelta

Reply text as the Tag's harness writes it. It includes what the Tag says
between tool calls, and text from a Task Attempt a retry replaced; `finish`
carries the reply itself. An `activity` between two deltas ends a block of
text. The server may skip text of a very long turn.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `text` | `text` | `string` | The text to append. |

### Activity

A command or tool call starting or ending, or a retry of the Task in a new
Task Attempt.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `work_session_id` | `workSessionId` | `string` | The work Session the activity belongs to. Empty for the message's own turn. |
| `text` | `text` | `string` | One line for a start or a retry, such as `running: COMMAND`, `using: TOOL`, or `retrying (Task Attempt N)`. Empty when a command or tool call ends. A client shows it when it does not recognize `detail`. |
| `command` | `command` | [`CommandActivity`](#commandactivity) | One of `detail`. A command starting or ending. |
| `tool` | `tool` | [`ToolActivity`](#toolactivity) | One of `detail`. A tool call starting or ending. |
| `retry` | `retry` | [`RetryActivity`](#retryactivity) | One of `detail`. A new Task Attempt of the Task. |

Oneof `detail`: `command`, `tool`, `retry`. What the activity is. A client that does not recognize the member set
shows `text`.

### CommandActivity

A command the Tag runs.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `id` | `id` | `string` | Pairs the command's start with its end. |
| `command` | `command` | `string` | The command line. The Tag wrote it, so it is untrusted: the Worker removes control characters and cuts it to 200 characters. |
| `status` | `status` | [`ActivityStatus`](#activitystatus) | `ACTIVITY_STATUS_RUNNING` when it starts, then once more when it ends. |

### ToolActivity

A tool the Tag calls.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `id` | `id` | `string` | Pairs the call's start with its end. |
| `tool` | `tool` | `string` | The tool as `PROVIDER.OPERATION`, such as `github.create_pull_request`. |
| `status` | `status` | [`ActivityStatus`](#activitystatus) | `ACTIVITY_STATUS_RUNNING` when it starts, then once more when it ends. |

### RetryActivity

A new Task Attempt continues the Task after the previous one ended without
a result. Text before it is not part of the reply.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `attempt` | `attempt` | `int32` | The new Task Attempt's number, from 1. |

### Finish

The turn's reply.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `reply` | `reply` | [`Reply`](#reply) | The reply. Its presentation is never `REPLY_PRESENTATION_ERROR`; such a reply is a `TurnError` instead. |
| `message` | `message` | [`Message`](#message) | The message as `GetMessage` returns it now, with the work Sessions the turn started. |

### TurnError

The error that ended the turn: its Task failed, or the Control Plane could
not tell whether a delivery into a running turn reached it.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `text` | `text` | `string` | The error, as the message's `reply.text`. |

### WorkSessionChanged

A work Session's current state, after any change to it.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `work_session` | `workSession` | [`WorkSession`](#worksession) | The whole work Session. It replaces the one the client holds with the same `id`. |

### FollowEnd

The end of the stream.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `message` | `message` | [`Message`](#message) | The message as `GetMessage` returns it now. |

## Enums

### ConversationAuthor

Who wrote an entry in a conversation.

| Value | Description |
| --- | --- |
| `CONVERSATION_AUTHOR_UNSPECIFIED` |  |
| `CONVERSATION_AUTHOR_OPERATOR` | The caller. |
| `CONVERSATION_AUTHOR_TAG` | The Tag: a reply or a work Session's report. |

### ReplyStatus

Whether a reply or a report has been written.

| Value | Description |
| --- | --- |
| `REPLY_STATUS_UNSPECIFIED` |  |
| `REPLY_STATUS_WAITING` | Not yet. |
| `REPLY_STATUS_REPLIED` | It has; the reply or report is set. |

### ReplyPresentation

What kind of reply the Tag wrote.

| Value | Description |
| --- | --- |
| `REPLY_PRESENTATION_UNSPECIFIED` |  |
| `REPLY_PRESENTATION_FINAL_RESULT` | The turn's result. |
| `REPLY_PRESENTATION_ERROR` | The error that ended the turn, such as a failed Task. |
| `REPLY_PRESENTATION_STATUS` | A progress update. |
| `REPLY_PRESENTATION_ACKNOWLEDGEMENT` | An acknowledgement that the turn started. |

### WorkSessionStatus

How a work Session's latest Task is doing.

| Value | Description |
| --- | --- |
| `WORK_SESSION_STATUS_UNSPECIFIED` |  |
| `WORK_SESSION_STATUS_PENDING` | It has no Task yet, or its Task waits to run. |
| `WORK_SESSION_STATUS_RUNNING` | Its Task runs. |
| `WORK_SESSION_STATUS_COMPLETED` | Its Task completed. |
| `WORK_SESSION_STATUS_FAILED` | Its Task failed. |
| `WORK_SESSION_STATUS_CANCELLED` | Its Task was cancelled. |
| `WORK_SESSION_STATUS_WAITING` | Its Task completed waiting on the person: on the answer to `question` when set, otherwise on a decision on its `approvals`. |

### ActivityStatus

Whether a command or tool call runs or has ended.

| Value | Description |
| --- | --- |
| `ACTIVITY_STATUS_UNSPECIFIED` |  |
| `ACTIVITY_STATUS_RUNNING` | It started. |
| `ACTIVITY_STATUS_COMPLETED` | It ended successfully. |
| `ACTIVITY_STATUS_FAILED` | It ended with a failure. |
