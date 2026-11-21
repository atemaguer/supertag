# Control Plane API

The Control Plane, the service that stores a SuperTag organization and schedules its work,
serves one gRPC API. Clients, such as the CLI, the desktop app, and your own
applications, call it through a **Gateway**, the service that forwards their calls and connects
collaboration surfaces. The **Worklets** of **Worker Hosts**, the machines that run work, call it
directly. A running **Task Attempt**'s Worker sends its data calls to the data endpoint the Control
Plane names, usually a Gateway. This page is the contract for calling it. See the
[glossary](glossary.md) for terms.

The API is the protobuf package `supertag.runtime.v2`, defined in
[`proto/supertag/runtime/v2/`](../../proto/supertag/runtime/v2/runtime.proto). Its
comments are the field-level reference.

## Connect

| URL | Transport |
| --- | --- |
| `https://HOST[:PORT]` | gRPC over HTTP/2 with TLS |
| `wss://HOST[:PORT][/PATH]` | gRPC carried in a WebSocket. The Control Plane's TLS runs end to end inside it, so a platform edge that terminates its own TLS sees only ciphertext |
| `http://127.0.0.1:PORT` | Cleartext gRPC, loopback only |

Trust a private certificate authority as the CLI does with `SUPERTAG_SERVER_CA_FILE`. A Control
Plane may also require a TLS client certificate; that is a network filter, and every call still
authenticates with its own credential.

### Negotiate a protocol version

Every connection starts with `ProtocolNegotiation.Negotiate`, which carries no credential. Send
your role, `SERVICE_ROLE_CLIENT` for an application, and the protocol versions you speak. Then
send the selected version in the `x-supertag-protocol` metadata header on every other call. A
call without it, or with a version the Control Plane does not speak, fails with
`FAILED_PRECONDITION`. Only negotiation and the standard gRPC health service are exempt.

SuperTag 0.3.0 speaks protocol 2, 0.3.1 speaks protocol 5, 0.3.2 speaks protocol 6, and 0.3.3
through 0.3.7 speak protocol 7.
Before 1.0, each release speaks only its own protocol version, so a client and a Control Plane from
releases with different versions cannot connect. When you offer no version the Control Plane speaks, `Negotiate` fails
with `FAILED_PRECONDITION` and a message of this form:

```text
incompatible SuperTag protocol: this Control Plane (SuperTag 0.3.0) speaks protocol versions [2],
but the connecting operator client (SuperTag BUILD) offered [5]; run the same SuperTag release on
both services
```

The part `(SuperTag BUILD) speaks protocol versions [V, ...]` names the Control Plane's release and
versions, and every release keeps that form. The CLI, desktop app, and Worklets
read it to show which release to upgrade, for example: `This app speaks SuperTag protocol 5, but
the Control Plane at http://127.0.0.1:3434 runs SuperTag 0.3.0 (protocol 2). Upgrade the Control
Plane.`

### Authenticate

Send `authorization: Bearer SECRET` on every call. The Control Plane checks each call against one
table of roles:

| Caller | Secret | May call |
| --- | --- | --- |
| The admin operator | The admin Operator Token | Every operator service, including `OperatorAccess` |
| A named operator, `token:NAME` | An Operator Token | Every operator service except Operator Token management in `OperatorAccess` |
| A client device, `client:NAME` | The credential `supertag connect` saved from a client Auth Key | Operator services, limited to the Tags its key named |
| A Worker Host's Worklet, `host:NAME` | Its host credential | `WorkerHost` registration, claims, leases, finishing, and checkpoints, and `HostLandings`, `VolumeObjects`, `Transfers`, `WorkspaceGitAccess`, and `ArtifactSources` |
| A running Task Attempt's Worker | The Task Attempt credential `WorkerHost.StartTask` returned (`stat_…`) | That Task Attempt's data calls on `WorkerHost`, such as its events, text, questions, usage, network log, history, and Context Item pins, and the `Attempt…` services |
| A Gateway, `gateway:NAME` | Its Gateway credential | `Connector`, `ReplyProgress`, and `OperatorNotifications` |

A Task Attempt credential names its Task Attempt, so data requests carry no Task Attempt or lease
fields. It works only while the Worklet holds the Task Attempt's lease, and it never claims,
starts, renews, or finishes a Task Attempt. After a cancellation, `ReportAttemptUsage`,
`ReportAttemptMilestone`, and `ReportNetworkLog` still accept it until the Worklet's
`FinishTask` confirms execution stopped.

A Gateway forwards these calls to the Control Plane as their caller:

| Forwarded | Not forwarded |
| --- | --- |
| Negotiation, health, and every method an operator, a client device, or an Auth Key may call | `WorkerHost` registration, claims, leases, finishing, and checkpoints |
| A Task Attempt's data calls on `WorkerHost` and the `Attempt…` services, under its Task Attempt credential | `HostLandings`, `VolumeObjects`, `Transfers`, `WorkspaceGitAccess`, and `ArtifactSources` |
| | `Connector`, `ReplyProgress`, `OperatorNotifications`, and other Gateway methods |

The Gateway passes the caller's own credential through unchanged and adds no authority. A host
credential therefore reaches no method through a Gateway, and the Gateway drops the host
generation header. A caller that sends Task Attempt data calls through a Gateway negotiates as
`SERVICE_ROLE_WORKER_HOST`.

When the Control Plane sets `SUPERTAG_DATA_ENDPOINT` to a Gateway URL, `RegisterHost` returns it
in `HostRecord.data_endpoint`. Empty means the Control Plane itself, at the URL the Worklet
dials. The field grants nothing. The Worklet passes it to each Worker it starts, and the Worker
sends all of its Task Attempt's data calls there, with no fallback to the Control Plane. A host
that registers again applies the new value to the Workers it starts afterwards.

An application usually runs with an Operator Token of its own, so its changes appear under its
name in `supertag audit`.

## Operator services

| Service | For |
| --- | --- |
| `Operator` | Tags, Tasks, Worker Hosts, Auth Keys, Task events and usage, reply deliveries, and recovery decisions |
| `Conversations` | Your conversation with each Tag: its messages, sending one, following it as it changes, and how far you have read |
| `OperatorEvents` | `Watch`: change notices with a resume token |
| `Objectives` | Create an Objective, read and list them, change limits, pause, resume, cancel, review, and complete |
| `ObjectiveOverviews` | The readable progress overview that `describe objective` prints |
| `Inbox` | Inbox items, questions and their answers, and approval decisions |
| `WorkSessions` | Work Sessions started from a parent Session, how many their Tag has open, and closing one |
| `Schedules` | [Schedules](coordination.md#schedules) that wake a Tag in your conversation: create, read, list, pause, resume, and delete |
| `Memories` | Operators only: drop all of a Tag's [memory](coordination.md#memory) on every Worker Host |
| `Teams` | Teams and their Workstream posts |
| `Mailbox` | Messages between Tags and Mailbox grants |
| `LiveInputs` | Messages to a running Task, and resolving an uncertain delivery |
| `PolicyCatalog`, `SurfacePolicyCatalog` | Roles, Permission Sets, Context Sets, Role assignments, Surface Accounts, and surface locations |
| `ManifestRelationships` | Server-side apply of manifests and apply sets |
| `Placement` | A Tag's required labels, and why a Task waits |
| `AuthKeys`, `Enrollments` | Auth Keys, enrollment, and credential rotation |
| `OperatorAccess` | Operator Tokens (admin only) and the audit log |
| `ArtifactCatalog`, `ArtifactPublications`, `ArtifactVolumes` | Artifacts, publications to other Objectives, and Volumes |
| `HostLandings` | Worklets claim and record the landings of the Workspace deliveries they hold |
| `Workspaces`, `WorkspaceCredentials`, `WorkspaceLandings` | Remote Workspaces, their Workspace Credentials and checks, and where Session changes landed |
| `WorkspaceVolumes` | Workspace data Volumes |
| `TaskFiles` | `Locate`: where a Task's files can be read, as locations only, never file content. A running Task's local checkout is returned only to a caller whose `machine_id` matches its Worker Host's (both read `supertag/machine-id` in the per-user configuration directory); others get "Files on Worker Host NAME are unreachable from here" |
| `Spend`, `Metrics` | Spend reports and an operational snapshot |

The other services in the package serve Worklets, Gateways, and harness adapters.

## Call it from your application

Generated bindings for Go, TypeScript, and Python live in
[`sdks/`](../../sdks/README.md). The Go module exposes Connect clients; pass
`connect.WithGRPC()`. TypeScript exports protobuf-es messages and service descriptors, and Python
exposes messages and gRPC stubs.

```text
1. Negotiate(role: SERVICE_ROLE_CLIENT, protocol_versions: [...])  → protocol_version
2. Operator.SubmitTask(tag_id: "lead", session_id: "triage", operation_id: "...", prompt: "...")
     metadata: authorization: Bearer stop_..., x-supertag-protocol: <version>
3. OperatorEvents.Watch(...)  → change notices until the Task finishes
```

## Writes, retries, and conflicts

- Many writes take an `operation_id`. A retry with the same ID returns the first result instead
  of acting twice. Generate a new one per intended change.
- Many updates take an `expected_revision`. The Control Plane refuses the change when the
  resource changed since you read that revision.
- A refused call returns a gRPC status with a plain message. Messages never echo secrets.

## Read a conversation

An operator or client has one conversation with each Tag. `Conversations.ListMessages` returns a
page of it, newest first. Each message carries its Task, its `order` in the conversation, when it
was sent and finished, and the events its turn shows: every message the Tag wrote while it
worked, and its latest activity or plan. One call renders a page; a client needs no read per
message. When a turn's messages exceed the page's share, the oldest are left out and
`events_truncated` is set.

Each conversation numbers its own messages: the first is `order` 1, and each later message,
whether yours, a Schedule's turn, or a Work Session's report, takes the next number. A Schedule's
post held for pacing takes its number when it reaches the conversation, after the messages you
already saw. The `conversation_id` is the conversation's own and does not name a Session.

A client that keeps a copy reads only what changed: it passes the `conversation_id` the copy came
from, the latest `order` it holds as `after`, and its unfinished turns as `refresh_task_ids`. The
response then sets `incremental` and holds the newer messages and those turns. When the
conversation was replaced, or more than a page arrived since, the response is the newest page
instead, which replaces the copy. Upgrading the Control Plane to this numbering gave every
conversation a new `conversation_id`, so each client reads its conversations again once.

A conversation leaves out turns that finished quietly ([quiet results](coordination.md#quiet-results)).
A refreshed turn that ended that way comes back with `Task.quiet` set, so a client that held it
running drops it.

`Conversations.ListConversations` lists your conversations, one per Tag, the most recently active
first.
Each has a preview of its latest message, when it was active, how many finished replies you have
not read, whether one of its Tasks is queued or running, and `asking` when its latest message is
the Tag's question still waiting for an answer. Quiet turns count in none of these, and a
Schedule's turn counts only once it finishes or a person's message joins it. While it runs,
`ListMessages` returns it with its `schedule_id`, so a client can refresh it; the apps show it
once it finishes, or at once when a message's `live_input` names it as the turn the message
joins. Clients use
the list for notifications and badges. `MarkConversationRead` records the
latest finished turn you have read. You have one read mark per conversation, shared by all of your
clients: reading on one device clears the badge on the others, and the mark never moves back.
Unread counts only the turns after your mark, so the list costs the same however long the
conversation is.

## Follow a conversation

`Conversations.FollowConversation` streams a conversation as it changes, so a client shows each
message the Tag writes, each change of state, and the result as soon as the Control Plane records
them, without polling. Send it what `ListMessages` takes to read changes: the `conversation_id`
and latest `order` of the copy you keep, and its unfinished turns. The first response holds what
changed since that copy, exactly as `ListMessages` would return it; a client without a copy sends
none and gets the newest page. Each later response holds only the messages that changed since the
one before. A response with nothing set is a heartbeat, sent at least every 15 seconds.

While a turn runs, a response can also carry `texts`: the text of the message its Tag is writing
now, all of it so far, as the harness streams it. The Worklet redacts it before it leaves, and
the Control Plane keeps it in memory only. Show it in the message's place; once the message is
recorded as one of the turn's events, the same response clears the text, and the turn's result
replaces it too. Harnesses that do not stream send no text.

For an operator, a response also says why a queued turn still waits for a Worker Host, such as an
uncertain Task Attempt that holds a host's only slot, once the turn has waited about two seconds.
An empty reason says the earlier one no longer holds.

After a dropped stream, follow again from the copy you kept (see
[How streams deliver](#how-streams-deliver)). A copy cannot be replayed when the conversation was
replaced or more than a page of messages arrived since. `ListMessages` with `after` reads the same
changes in one call.

A message carries its turn's messages and only its latest activity or plan. `Operator.ListEvents`
returns every event of a turn, including the activity a conversation page leaves out.

## Watch for changes

`OperatorEvents.Watch` streams change notices for Tags, Tasks, conversation messages and read
marks, Objectives, Teams, Workstream posts, Schedules, and Mailbox messages. Each notice carries a resume token; reconnect with the last one to
continue without a gap. A notice says what changed, not its new contents: read the resource.
A Watch request may name the kinds it follows. A kind the Control Plane does not know, such as one a
newer client asks for, is ignored rather than refused.

## How streams deliver

`FollowConversation` and `Watch` share these rules:

- **Pushed after commit.** A stream sends a change only once the write that made it has
  committed, so it never shows what the database could still lose. It sends nothing it has not
  read back from the database.
- **Any replica.** A stream may run on any Control Plane replica sharing the database. A change
  made through another replica reaches it at once on PostgreSQL, by a notification without
  content, and at the latest about a second later when a notification is lost. See
  [Replicas](../operations/control-plane.md#replicas).
- **Resume, don't restart.** Reconnect with what you hold: a conversation's `conversation_id`,
  latest `order`, and unfinished turns, or a Watch's last resume token. The stream replays what
  changed after it, then pushes. When it cannot, the first response says so: a
  `FollowConversation` page with `incremental` unset, or a `WatchResync`. Read again what you
  show and carry on from there. A Watch that falls behind the notices the Control Plane keeps
  while it is open also gets `WatchResync`.
- **Subscribe, then read.** A stream registers for changes before it reads what you missed, so
  a change that commits in between is neither lost nor sent twice.
- **Heartbeats.** An idle stream sends a heartbeat at least every 15 seconds.
- **Streamed text is ephemeral.** A follow's `texts` are best-effort. They come only from the
  replica that received them, are never stored, and are never replayed on resume. The recorded
  message replaces them.

## Stability

The API is versioned by protocol negotiation and the package name. See
[API stability](api-stability.md).
