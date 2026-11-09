# TeamService

<!-- Generated from spec/proto/supertag/operator/v1 by scripts/protoc-gen-operator-docs.mjs. Edit the proto comments, not this file. -->

`supertag.operator.v1.TeamService` in [`team.proto`](../../../spec/proto/supertag/operator/v1/team.proto). How to call an RPC, authenticate, and
read its errors is in the [Control Plane API Server](../control-plane-api.md) guide; the conventions every
RPC follows are in [Shared messages and options](shared.md#conventions).

Teams: `supertag create team`, `list team`, `get team`, `update team` and
`delete team`.

A Team is a set of Tags. Its members may message one another and share the
Team's Workstream, and an Objective that names the Team may hand work to
its members. A Team stands alone: any number of Objectives may name it.
`MailboxService.ListWorkstreamPosts` reads its Workstream.

Access. The admin token and Operator Tokens may call every RPC; a scoped
coordination credential is refused with `PermissionDenied`.

Every RPC that names a Team takes its name or ID, and fails with
`InvalidArgument` for an empty one and `NotFound` for a Team that does not
exist. Every RPC that names Tags takes their names, and fails with
`NotFound` for a Tag that does not exist or was deleted. A call while the
Control Plane drains fails with `Unavailable` and `ERROR_REASON_DRAINING`.

## RPCs

### CreateTeam

| | |
| --- | --- |
| Procedure | `/supertag.operator.v1.TeamService/CreateTeam` |
| Request | [`CreateTeamRequest`](#createteamrequest) |
| Response | [`Team`](#team) |
| Action | `manage_team` |
| Callers | The admin token and Operator Tokens |
| Audit log | `team.create` |

Creates a Team.

Repeating the call with the same `id`, name, members and limit returns
the existing Team and changes nothing. It fails with `AlreadyExists` and
`ERROR_REASON_CONFLICT` when another Team has the ID or the name, or the
Team with the ID differs, and with `InvalidArgument` for a malformed ID
or name, no members, more than 100 members, or a `max_concurrency` out
of range.

### ListTeams

| | |
| --- | --- |
| Procedure | `/supertag.operator.v1.TeamService/ListTeams` |
| Request | [`ListTeamsRequest`](#listteamsrequest) |
| Response | [`ListTeamsResponse`](#listteamsresponse) |
| Action | `read_team` |
| Callers | The admin token and Operator Tokens |
| Audit log | Nothing; reads only |

Lists Teams by name, as `supertag list team` shows them. It fails with
`NotFound` when `member` names a Tag that does not exist, and
`InvalidArgument` for a malformed `page_token`.

### GetTeam

| | |
| --- | --- |
| Procedure | `/supertag.operator.v1.TeamService/GetTeam` |
| Request | [`GetTeamRequest`](#getteamrequest) |
| Response | [`Team`](#team) |
| Action | `read_team` |
| Callers | The admin token and Operator Tokens |
| Audit log | Nothing; reads only |

Reads one Team.

### UpdateTeam

| | |
| --- | --- |
| Procedure | `/supertag.operator.v1.TeamService/UpdateTeam` |
| Request | [`UpdateTeamRequest`](#updateteamrequest) |
| Response | [`Team`](#team) |
| Action | `manage_team` |
| Callers | The admin token and Operator Tokens |
| Audit log | `team.update` |

Changes a Team's name, members or turn limit. Set at least one of them,
and `expected_revision` to the revision read last. New members take part
from their next turn; turns already running are not stopped.

When `expected_revision` is older but the Team already has every value
the request sets, it changes nothing and returns the Team, so a retry of
an applied change succeeds.

It fails with `InvalidArgument` for a request that sets nothing or sets
a malformed value, `FailedPrecondition` and `ERROR_REASON_CONFLICT` when
`expected_revision` is not the Team's revision and the Team differs from
the request, and `AlreadyExists` and `ERROR_REASON_CONFLICT` when another
Team has the new name.

### DeleteTeam

| | |
| --- | --- |
| Procedure | `/supertag.operator.v1.TeamService/DeleteTeam` |
| Request | [`DeleteTeamRequest`](#deleteteamrequest) |
| Response | [`DeleteTeamResponse`](#deleteteamresponse) |
| Action | `manage_team` |
| Callers | The admin token and Operator Tokens |
| Audit log | `team.delete` |

Deletes a Team and its Workstream posts. It fails with
`FailedPrecondition` and `ERROR_REASON_CONFLICT` while an Objective that
is not completed or cancelled names the Team, and the message names it.

## Messages

### CreateTeamRequest

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `id` | `id` | `string` | The Team's ID: 1 to 200 characters without whitespace or control characters, other than `.` and `..`. Empty uses `name`, which must then be a valid ID. |
| `name` | `name` | `string` | The Team's name: 1 to 200 characters without control characters, unique among Teams. Leading and trailing whitespace is removed. |
| `members` | `members` | repeated `string` | The member Tags, by name: 1 to 100 of them. Repeated names count once. |
| `max_concurrency` | `maxConcurrency` | optional `int32` | At most this many turns run at once across the Sessions of every open Objective that names the Team; later turns wait. From 1 to 1,000. Unset: only Worker Host capacity limits them. |

### ListTeamsRequest

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `member` | `member` | `string` | Lists only Teams this Tag is a member of, by name. Empty lists every Team. |
| `page_size` | `pageSize` | `int32` | At most this many Teams; 0 means 100, and more than 500 means 500. |
| `page_token` | `pageToken` | `string` | The `next_page_token` of the previous page. |

### ListTeamsResponse

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `teams` | `teams` | repeated [`Team`](#team) | The Teams, by name. |
| `next_page_token` | `nextPageToken` | `string` | Fetches the next page. Empty on the last page. |

### GetTeamRequest

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `team` | `team` | `string` | The Team's name or ID. A name that is also another Team's ID names that Team. |

### UpdateTeamRequest

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `team` | `team` | `string` | The Team's name or ID. |
| `expected_revision` | `expectedRevision` | `int64` | The Team's `revision` as the caller read it, from 1. The update applies only while it is still the Team's revision. |
| `name` | `name` | optional `string` | The new name. Unset leaves the name. |
| `members` | `members` | [`TeamMembers`](#teammembers) | The members that replace the current ones. Unset leaves them. |
| `concurrency` | `concurrency` | [`TeamConcurrency`](#teamconcurrency) | The new turn limit. Unset leaves the limit. |

### TeamMembers

A Team's member Tags.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `tags` | `tags` | repeated `string` | The Tags, by name: 1 to 100 of them. Repeated names count once. |

### TeamConcurrency

A Team's turn limit.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `max_concurrency` | `maxConcurrency` | `int32` | At most this many turns run at once, from 1 to 1,000. 0 removes the limit, so only Worker Host capacity limits them. |

### DeleteTeamRequest

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `team` | `team` | `string` | The Team's name or ID. |

### DeleteTeamResponse

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `id` | `id` | `string` | The deleted Team's ID. |
| `name` | `name` | `string` | The deleted Team's name. |

### Team

One Team.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `id` | `id` | `string` | The Team's ID. |
| `name` | `name` | `string` | Its name. |
| `members` | `members` | repeated [`TeamMember`](#teammember) | Its member Tags, by Tag ID. |
| `max_concurrency` | `maxConcurrency` | optional `int32` | At most this many turns run at once across the Sessions of every open Objective that names it. Unset: only Worker Host capacity limits them. |
| `revision` | `revision` | `int64` | Increases with every change, from 1. Pass it as `expected_revision`. |
| `created_at` | `createdAt` | `google.protobuf.Timestamp` | When it was created. |
| `updated_at` | `updatedAt` | `google.protobuf.Timestamp` | When it last changed. |

### TeamMember

One member Tag of a Team.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `tag_id` | `tagId` | `string` | The Tag's ID. |
| `tag` | `tag` | `string` | The Tag's name. Empty when the Tag was deleted. |

### WorkstreamPost

One post to a Team's Workstream, which the Team's members read.

| Field | JSON | Type | Description |
| --- | --- | --- | --- |
| `id` | `id` | `string` | The post's ID. |
| `team_id` | `teamId` | `string` | The Team's ID. |
| `author_tag_id` | `authorTagId` | `string` | The ID of the member Tag that wrote it. |
| `to_tag_ids` | `toTagIds` | repeated `string` | The IDs of the member Tags it is addressed to. Each one also receives it as a Mailbox message. Every member reads the post either way. |
| `body` | `body` | `string` | The post. The Tag wrote it, so it is untrusted text. |
| `source_task_id` | `sourceTaskId` | `string` | The Task that posted it, when a Task did. |
| `sequence` | `sequence` | `int64` | The post's place in the Team's Workstream, from 1. |
| `created_at` | `createdAt` | `google.protobuf.Timestamp` | When it was posted. |
