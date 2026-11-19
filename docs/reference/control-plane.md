# SuperTag Control Plane

The **Control Plane** maintains the durable state of an AI
[organization](glossary.md#autonomous-organization) and decides what work it accepts and where
that work runs. [Worker Hosts](glossary.md#worker-host) form the execution side of the system,
each connected by its [Worklet](glossary.md#worklet). A [Gateway](glossary.md#gateway) is the
endpoint clients connect to, and it connects collaboration surfaces.

This page uses these SuperTag terms, each defined in the glossary: [Tag](glossary.md#tag),
[Role](glossary.md#role), [Objective](glossary.md#objective), [Team](glossary.md#team),
[Workstream](glossary.md#workstream), [Task](glossary.md#task),
[Task Attempt](glossary.md#task-attempt), [Session](glossary.md#session),
[Context Set](glossary.md#context-set), [Permission Set](glossary.md#permission-set), and
[Surface Account](glossary.md#surface-account).

## System boundary

```text
Slack / GitHub / Linear / Lark / Teams     CLI / desktop app / applications
                 |                                         |
                 └───────────────> Gateway <───────────────┘
                                        |  forwards calls as a client
                                        v
                        Control Plane: one gRPC API, supertag.runtime.v2
                        - authentication and the role table
                        - admission, policy, and budgets
                        - scheduling, leases, and recovery
                        - durable state and audit (SQLite or PostgreSQL)
                                        ^
                                        | outbound connections
                         Worker Hosts, each running a Worklet
                        - a Worker per Task Attempt: harness adapter and harness
                        - Workspace checkouts
```

The Control Plane owns:

- Tags, Roles, Objectives, Teams, Workstreams, Tasks, Sessions, and Mailboxes;
- Context Sets, Permission Sets, admission, identity, policy, and budgets;
- scheduling, leases, recovery decisions, cancellation, and reconciliation; and
- events and audit history.

It stores no files. Session checkpoints stay on the Worker Host whose Worklet wrote them, and the Control
Plane records only which host holds each one. Artifact and Workspace delivery bytes stay on the
Worker Host that produced them, and no file passes through the Control Plane. Other Worklets
read artifacts from that host directly or from a Volume, and read deliveries from their Session
branches in the Workspace's git remote. Several Control Plane processes can share one PostgreSQL database; a SQLite
database serves one process.

### Session checkpoints

A checkpoint is a harness's native session, saved after a successful turn so the next turn of the
Session can resume it. It is a cache: the Session's Tasks and their events are the record, and a
turn without a checkpoint starts from a recap of them (see
[Continuity and recaps](../concepts/tasks.md#continuity-and-recaps)).

The Worklet that ran the turn keeps the checkpoint in its host's artifact storage, which every
Worker of the host shares. The Control Plane records only its holder, size, and digest. Only the holder
resumes it:

- The Session's next Task waits up to 10 minutes for the holder while the holder is ready, bound
  to the Tag, and runs the Task's harness. `supertag placement explain` reports the requirement
  `checkpoint-holder`, and the conversation shows the same reason.
- When the holder is offline, draining, or no longer eligible, or the 10 minutes pass, another
  Worker Host takes the Task and starts it from the recap.
- A holder whose file is missing or whose bytes no longer match its digest also starts fresh.

A Tag that names a [Volume](resource-model.md#volumes) (`supertag tag put TAG --volume NAME`) keeps its
checkpoints on that Volume instead, at `tags/<SHA-256 of TAG>/sessions/<SHA-256 of SESSION>/checkpoint/`.
The turn's Worklet writes it there, through its own `--volume` mapping for a file Volume or a
presigned request for an S3 one, and keeps no copy. Any host that reaches the Volume resumes it,
so the next Task waits for no particular host. The reader checks the checkpoint's size and SHA-256,
and a missing or changed checkpoint starts the turn fresh. A dropped checkpoint's object is
deleted from the Volume: by the Control Plane within seconds for an S3 Volume, and within 10
minutes by the Worklet of a Worker Host that maps a file Volume.

| Rule | When |
| --- | --- |
| A Session keeps only its newest checkpoint | A successful turn's checkpoint replaces the Session's earlier ones |
| A checkpoint over 8 MiB is never kept or resumed | Half the 16 MiB limit, leaving room for one more long turn |
| An idle Session's checkpoint is dropped | 14 days after the Session's last finished turn |
| An ended Objective's checkpoints are dropped | 3 days after the Objective completes or is cancelled, before its Sessions would go idle |
| A failed or cancelled Task Attempt's checkpoint is dropped | At the next maintenance pass |

A Worklet deletes a checkpoint file when a newer one replaces it, when the Control Plane no
longer names it (checked at start and every hour), and when it has not been written for 14 days.
These periods are fixed; there is no setting.

The Gateway forwards client calls to the Control Plane, and a running Task Attempt's data calls
under its Task Attempt credential when the Control Plane names it as the data endpoint
(`SUPERTAG_DATA_ENDPOINT`; the local Gateway under `supertag up`). It never forwards a Worker
Host's registration, claim, or lease calls. It terminates collaboration surface
connections, turns their events into Tasks through the `Connector` service, and delivers replies
and operator notifications. It does not decide policy, create work on its own, or schedule Worker
Hosts. Worker Hosts do not become part of the Control Plane; each host's Worklet claims work and
reports its execution. See the
[Worker Host reference](worker.md).

## Connections

Worklets and Gateways reach the Control Plane at one URL: `https://` for native gRPC, `wss://` for
the WebSocket tunnel behind platforms that forward only HTTP, or `http://` on loopback. Clients
reach it through a Gateway, which takes the same kinds of URL. Every
connection first negotiates a protocol version. See [Control Plane API](control-plane-api.md).

`supertag connect URL --name NAME` saves a Gateway, and `--gateway NAME` uses it or one the
desktop app saved. `--state-directory` reaches the local
services that `supertag up` runs.

Every client finds the local Gateway the same way. The state directory
(`SUPERTAG_STATE_DIR`, else `~/.supertag`) must be private to the user, the `supertag up`
supervisor must hold its lock, and the endpoint must be a loopback address. The client then reads
the admin operator token from `credentials.json`. The desktop app shows this
Gateway as **Local**, read its token at each connect, and never save it.

## Callers and roles

Every caller of the Control Plane authenticates with its own bearer credential. One
default-deny table maps every RPC to the roles allowed to call it; an RPC
missing from the table is refused.

| Principal | Credential | Obtained with |
| --- | --- | --- |
| `operator:local` (admin), `operator:token:NAME` | The admin operator token, or an Operator Token (`stop_…`) | Deployment configuration; `supertag operator-token create` |
| `host:NAME` | Enrolled credential (`stcr_…`) | `supertag host enroll NAME` with a host Auth Key |
| `gateway:NAME` | Enrolled credential (`stcr_…`) | `supertag gateway enroll NAME` with a gateway Auth Key |
| `client:NAME` | Enrolled credential (`stcr_…`) | `supertag connect URL` with a client Auth Key, or the desktop app |
| One running Task Attempt | Task Attempt credential (`stat_…`) | Returned by `StartTask` to the Worklet that holds the Task Attempt's lease |

An Auth Key (`stak_…`) admits one role, chosen when an operator creates it with
`supertag auth-key create NAME --role host|gateway|client`. It is accepted only to enroll. The
enrollee generates its credential, and the Control Plane stores only its digest. An enrollee
rotates its own credential, an operator rotates or revokes anyone's, and a revoked or replaced
credential is refused on the next call and ends open streams within about a second.

| Role | May call |
| --- | --- |
| Admin operator | Everything an operator may, plus Operator Tokens |
| Operator | Configuration, fleet, recovery, audit, Auth Keys and enrollments, and all work |
| Client | Tags its Auth Key allows, Teams made only of those Tags, its own conversations and Objectives, and their Inbox items |
| Worker Host | Registration, claims, leases, finishing, checkpoints, and transfers of the work its Worklet claims, for its current generation |
| Task Attempt | The data calls of the one Task Attempt its credential names, while its lease lives: events, text, questions, usage, milestones, its network log, history and Context Item pins, and the `Attempt…` services. Never a lease operation |
| Gateway | Connector and reply progress calls for the Surface Accounts that name it. With `--all-tags` on its key, also accounts no Surface Account names and the admin operator's notifications |

A client is a device. It sees only the work it started, never work without an owner, and never
Worker Host status. Its Inbox lists the questions and limits of its own Objectives, never
execution recovery or MCP logins, which are Worker Host work. It starts work only through conversations and Objectives. It decides an
approval only when a Permission Set names it as `client:NAME`. The audit log records every
caller by its full principal, and an enrollment by the Auth Key that admitted it,
`auth-key:NAME`. Client certificates are an optional network filter in front of all of this.

## Resources

Manifests describe Control Plane resources with `apiVersion`, `kind`, `metadata.name`, and
`spec`; see [Resource envelope](resource-model.md#resource-envelope).

- Persistent resources such as Tags have stable IDs, names, timestamps, and revisions.
- Desired configuration belongs in `spec`, which `supertag apply` writes.
- The Control Plane owns observed state, such as phases and revisions, and `supertag get`
  reports it.

The resource contract is versioned with the API's protocol, independently of database schemas
and CLI syntax, so the CLI, the desktop app, and applications share it.

## Background work

Besides answering calls, the Control Plane keeps three kinds of work moving:

| Work | Desired input | Responsibility |
| --- | --- | --- |
| Connector leases | Surface Accounts and locations | Which Gateway delivers each account's replies, one at a time |
| Task dispatch | Durable admitted Tasks | Offering Tasks to eligible Worker Hosts, Task Attempts, retries, and results |
| Reply delivery | Durable outbound presentations | Gateway delivery, retry, and completion |

Security admission stays synchronous: none of this work can later broaden a Tag's Context Sets or
Permission Sets beyond what the Control Plane admitted.

For how dispatch picks a Worker Host and handles interrupted execution, see
[Scheduling and interrupted execution](scheduling-and-recovery.md).
