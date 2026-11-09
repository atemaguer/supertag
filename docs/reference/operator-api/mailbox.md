# MailboxService

<!-- Generated from spec/proto/supertag/operator/v1 by scripts/protoc-gen-operator-docs.mjs. Edit the proto comments, not this file. -->

`supertag.operator.v1.MailboxService` in [`mailbox.proto`](../../../spec/proto/supertag/operator/v1/mailbox.proto). How to call an RPC, authenticate, and
read its errors is in the [Control Plane API Server](../control-plane-api.md) guide; the conventions every
RPC follows are in [Shared messages and options](shared.md#conventions).

What Tags say to one another, as an operator sees it: `supertag list
message`, `grant mailbox`, `revoke mailbox`, `list mailbox-grant` and
`list workstream-post`.

A Tag's Mailbox holds plain text messages from other Tags. Each message is
delivered as a turn of the recipient's inbox Session; messages that arrive
while a turn runs are handled together in the next one. Tags in the same
Team may message one another; a grant lets a recipient accept messages
from a sender outside its Teams too. A grant is directional and gives no
execution authority. A Tag manifest's `acceptsMessagesFrom` lists the same
grants. Every Team also has a Workstream: the shared record of its
members' posts, which every member reads.

Operators read Mailboxes and Workstreams; only Tags write to them.

Access. The admin token and Operator Tokens may call every RPC; a scoped
coordination credential is refused with `PermissionDenied`.

Every RPC that names a Tag takes its name, and fails with `InvalidArgument`
for an empty one and `NotFound` for a Tag that does not exist or was
deleted. A call while the Control Plane drains fails with `Unavailable` and
`ERROR_REASON_DRAINING`.

## RPCs

### ListTagMessages

| | |
| --- | --- |
| Procedure | `/supertag.operator.v1.MailboxService/ListTagMessages` |
| Request | [`ListTagMessagesRequest`](#listtagmessagesrequest) |
| Response | [`ListTagMessagesResponse`](#listtagmessagesresponse) |
| Action | `read_mailbox` |
| Callers | The admin token and Operator Tokens |
| Audit log | Nothing; reads only |

Lists the messages a Tag sent or received, newest first, each with its
status, as `supertag list message` shows them. It fails with
`InvalidArgument` for a malformed `page_token`.

### GrantMailbox

| | |
| --- | --- |
| Procedure | `/supertag.operator.v1.MailboxService/GrantMailbox` |
| Request | [`GrantMailboxRequest`](#grantmailboxrequest) |
| Response | [`MailboxGrantChange`](#mailboxgrantchange) |
| Action | `manage_mailbox` |
| Callers | The admin token and Operator Tokens |
| Audit log | `mailbox-grant.add` |

Lets `recipient` accept messages from `sender`, as `supertag grant
mailbox` does. Granting an existing grant changes nothing and succeeds
with `changed` false.

### RevokeMailbox

| | |
| --- | --- |
| Procedure | `/supertag.operator.v1.MailboxService/RevokeMailbox` |
| Request | [`RevokeMailboxRequest`](#revokemailboxrequest) |
| Response | [`MailboxGrantChange`](#mailboxgrantchange) |
| Action | `manage_mailbox` |
| Callers | The admin token and Operator Tokens |
| Audit log | `mailbox-grant.revoke` |

Removes the grant that lets `recipient` accept messages from `sender`, as
`supertag revoke mailbox` does. The two Tags may still message each other
while they share a Team. Revoking a grant that does not exist changes
nothing and succeeds with `changed` false.

### ListMailboxGrants

| | |
| --- | --- |
| Procedure | `/supertag.operator.v1.MailboxService/ListMailboxGrants` |
| Request | [`ListMailboxGrantsRequest`](#listmailboxgrantsrequest) |
| Response | [`ListMailboxGrantsResponse`](#listmailboxgrantsresponse) |
| Action | `read_mailbox` |
| Callers | The admin token and Operator Tokens |
| Audit log | Nothing; reads only |

Lists the grants in which a Tag is the sender or the recipient, by sender
Tag ID and then recipient Tag ID, as `supertag list mailbox-grant` shows
them. Team membership is not listed. It fails with `InvalidArgument` for
a malformed `page_token`.

### ListWorkstreamPosts

| | |
| --- | --- |
| Procedure | `/supertag.operator.v1.MailboxService/ListWorkstreamPosts` |
| Request | [`ListWorkstreamPostsRequest`](#listworkstreampostsrequest) |
| Response | [`ListWorkstreamPostsResponse`](#listworkstreampostsresponse) |
| Action | `read_mailbox` |
| Callers | The admin token and Operator Tokens |
| Audit log | Nothing; reads only |

Lists a Team's Workstream posts, as `supertag list workstream-post` shows
them. Without `after_sequence` and `page_token` it lists the newest
posts, oldest first, and `next_page_token` is empty. With
`after_sequence` it lists the posts after that sequence, oldest first,
and `next_page_token` continues after the page while more follow. To
follow new posts, a client calls again with the last `sequence` it
received, when `EventService.Watch` sends a `WATCH_KIND_WORKSTREAM_POST`
change for the Team.

It fails with `InvalidArgument` for an empty `team` or a malformed
`page_token`, and `NotFound` for a Team that does not exist.

## Messages

### ListTagMessagesRequest

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `tag` | `tag` | `string` | The Tag's name. |
| `page_size` | `pageSize` | `int32` | At most this many messages; 0 means 50, and more than 200 means 200. |
| `page_token` | `pageToken` | `string` | The `next_page_token` of the previous page, which continues toward older messages. |

### ListTagMessagesResponse

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `messages` | `messages` | repeated [`TagMessage`](#tagmessage) | The messages, newest first. |
| `tag_names` | `tagNames` | map of `string` to `string` | Names of the Tags the messages name, keyed by Tag ID. A deleted Tag has no entry. |
| `next_page_token` | `nextPageToken` | `string` | Fetches the next, older page. Empty on the last page. |

### TagMessage

One message from one Tag to another.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `id` | `id` | `string` | The message's ID. |
| `sender_tag_id` | `senderTagId` | `string` | The ID of the Tag that sent it. |
| `recipient_tag_id` | `recipientTagId` | `string` | The ID of the Tag it was sent to. |
| `objective_id` | `objectiveId` | `string` | The Objective the sending turn worked under. Empty outside one. |
| `source_task_id` | `sourceTaskId` | `string` | The Task that sent it. Empty when no Task did. |
| `workstream_post_id` | `workstreamPostId` | `string` | The Workstream post whose addressees it delivered, when a post sent it. |
| `text` | `text` | `string` | The message, at most 8,000 characters. A Tag wrote it, so it is untrusted text. |
| `hops` | `hops` | `int32` | How many inbox turns the chain of messages that produced it passed through, at most 4. 0 outside such a chain. |
| `task_id` | `taskId` | `string` | The inbox turn that took it. Empty while it waits. |
| `status` | `status` | [`TagMessageStatus`](#tagmessagestatus) | Where it stands. |
| `created_at` | `createdAt` | `google.protobuf.Timestamp` | When it was sent. |

### GrantMailboxRequest

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `sender` | `sender` | `string` | The Tag that may send, by name. |
| `recipient` | `recipient` | `string` | The Tag that accepts its messages, by name. |

### RevokeMailboxRequest

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `sender` | `sender` | `string` | The Tag that may no longer send, by name. |
| `recipient` | `recipient` | `string` | The Tag that no longer accepts its messages, by name. |

### MailboxGrantChange

A Mailbox grant after `GrantMailbox` or `RevokeMailbox`.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `grant` | `grant` | [`MailboxGrant`](#mailboxgrant) | The grant. |
| `changed` | `changed` | `bool` | False when the call found the grant already as asked. |

### MailboxGrant

A recipient Tag accepts messages from a sender Tag, in addition to its Team
members.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `sender_tag_id` | `senderTagId` | `string` | The sender's Tag ID. |
| `recipient_tag_id` | `recipientTagId` | `string` | The recipient's Tag ID. |

### ListMailboxGrantsRequest

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `tag` | `tag` | `string` | The Tag's name. |
| `page_size` | `pageSize` | `int32` | At most this many grants; 0 means 100, and more than 500 means 500. |
| `page_token` | `pageToken` | `string` | The `next_page_token` of the previous page. |

### ListMailboxGrantsResponse

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `grants` | `grants` | repeated [`MailboxGrant`](#mailboxgrant) | The grants, by sender Tag ID and then recipient Tag ID. |
| `tag_names` | `tagNames` | map of `string` to `string` | Names of the Tags the grants name, keyed by Tag ID. A deleted Tag has no entry. |
| `next_page_token` | `nextPageToken` | `string` | Fetches the next page. Empty on the last page. |

### ListWorkstreamPostsRequest

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `team` | `team` | `string` | The Team's name or ID. |
| `after_sequence` | `afterSequence` | optional `int64` | Lists the posts after this `WorkstreamPost.sequence`, oldest first. Unset lists the newest posts. |
| `page_size` | `pageSize` | `int32` | At most this many posts; 0 means 50, and more than 200 means 200. |
| `page_token` | `pageToken` | `string` | The `next_page_token` of the previous page. It continues the same listing, so a request with it ignores `after_sequence`. |

### ListWorkstreamPostsResponse

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `posts` | `posts` | repeated [`WorkstreamPost`](team.md#workstreampost) | The posts, oldest first. |
| `tag_names` | `tagNames` | map of `string` to `string` | Names of the Tags the posts name, keyed by Tag ID. A deleted Tag has no entry. |
| `next_page_token` | `nextPageToken` | `string` | Fetches the posts after this page. Empty on the last page, and without `after_sequence`. |

## Enums

### TagMessageStatus

Where a Tag message stands.

| Value | Description |
| --- | --- |
| `TAG_MESSAGE_STATUS_UNSPECIFIED` |  |
| `TAG_MESSAGE_STATUS_PENDING` | It waits for the recipient's inbox to take it. |
| `TAG_MESSAGE_STATUS_HANDLED` | The inbox turn that took it completed. |
| `TAG_MESSAGE_STATUS_FAILED` | The inbox turn that took it failed or was cancelled. |
