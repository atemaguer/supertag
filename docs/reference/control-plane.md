# SuperTag Control Plane

The **Control Plane** maintains the durable state of an AI
[organization](glossary.md#autonomous-organization) and decides what work it accepts and where
that work runs. [Worker Hosts](glossary.md#worker-host) form the execution side of the system,
and an optional [Gateway](glossary.md#gateway) connects collaboration surfaces.

This page uses these SuperTag terms, each defined in the glossary: [Tag](glossary.md#tag),
[Role](glossary.md#role), [Objective](glossary.md#objective), [Team](glossary.md#team),
[Workstream](glossary.md#workstream), [Task](glossary.md#task),
[Task Attempt](glossary.md#task-attempt), [Session](glossary.md#session),
[Context Set](glossary.md#context-set), [Permission Set](glossary.md#permission-set), and
[Surface Account](glossary.md#surface-account).

## System boundary

```text
Slack / GitHub / Linear / Lark / Teams     CLI / terminal UI / desktop app / applications
                 |                                         |
              Gateway (client) ─────────┐                  |
                                        v                  v
                        Control Plane: one gRPC API, supertag.runtime.v2
                        - authentication and the role table
                        - admission, policy, and budgets
                        - scheduling, leases, and recovery
                        - durable state and audit (SQLite or PostgreSQL)
                                        ^
                                        | outbound connections
                                  Worker Hosts
                        - harness adapters and Workspace checkouts
```

The Control Plane owns:

- Tags, Roles, Objectives, Teams, Workstreams, Tasks, Sessions, and Mailboxes;
- Context Sets, Permission Sets, admission, identity, policy, and budgets;
- scheduling, leases, recovery decisions, cancellation, and reconciliation; and
- events and audit history.

It keeps transfer files, such as Session checkpoints and workspace bundles, in its transfer
directory, and never stores artifact bytes. Several Control Plane processes can share one
PostgreSQL database and one transfer directory; a SQLite database serves one process.

The Gateway terminates collaboration surface connections, turns their events into Tasks through
the `Connector` service, and delivers replies and operator notifications. It does not decide
policy, create work on its own, or schedule Worker Hosts. Worker Hosts do not become part of the
Control Plane; each claims work and reports its execution. See the
[Worker Host reference](worker.md).

## Connections

Clients reach the Control Plane at one URL: `https://` for native gRPC, `wss://` for the
WebSocket tunnel behind platforms that forward only HTTP, or `http://` on loopback. Every
connection first negotiates a protocol version. See [Control Plane API](control-plane-api.md).

The CLI, the terminal UI, and the desktop app share saved Control Planes: `supertag connect URL
--name NAME` saves one, and `--control-plane NAME` uses it. `--state-directory` reaches the local
services that `supertag up` runs.

## Callers and roles

Every caller of the Control Plane authenticates with its own bearer credential. One
default-deny table maps every RPC to the roles allowed to call it; an RPC
missing from the table is refused.

| Principal | Credential | Obtained with |
| --- | --- | --- |
| `operator:local` (admin), `operator:token:NAME` | The admin operator token, or an Operator Token (`stop_…`) | Deployment configuration; `supertag operator-token create` |
| `host:NAME` | Enrolled credential (`stcr_…`) | `supertag host enroll NAME` with a host Auth Key |
| `gateway:NAME` | Enrolled credential (`stcr_…`) | `supertag gateway enroll NAME` with a gateway Auth Key |
| `client:NAME` | Enrolled credential (`stcr_…`) | `supertag connect URL` with a client Auth Key, or the terminal UI or desktop app |

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
| Worker Host | Execution of the work it claims, for its current generation |
| Gateway | Connector and reply progress calls for the Surface Accounts that name it. With `--all-tags` on its key, also accounts no Surface Account names and the admin operator's notifications |

A client is a device. It sees only the work it started, never work without an owner, and never
Worker Host status. Its Inbox lists the questions and limits of its own Objectives, never
execution recovery or MCP logins, which are Worker Host work. It starts work only through conversations and Objectives. It decides an
approval only when a Permission Set names it as `client:NAME`. The audit log records every
caller by its full principal, and an enrollment by the Auth Key that admitted it,
`auth-key:NAME`. Client certificates are an optional network filter in front of all of this.

## Resources

Control Plane resources use `apiVersion`, `kind`, `metadata`, `spec`, and `status`.

- Persistent resources such as Tags have stable IDs, names, timestamps, and opaque resource versions.
- Desired configuration belongs in `spec`.
- Reconciled or observed state belongs in `status`.
- Cross-resource actions may use explicit virtual resources instead of ad hoc RPC or shell execution.

The resource contract is versioned with the API's protocol, independently of database schemas
and CLI syntax, so the CLI, the terminal UI, the desktop app, and applications share it.

## Controllers

A controller continuously reconciles one named responsibility and exposes status independently:

| Controller | Desired input | Observed responsibility |
| --- | --- | --- |
| `surfaces` | Surface Accounts and locations | Which Gateway serves each account |
| `task-dispatch` | Durable admitted Tasks | Worker Host selection, Task Attempts, retries, and results |
| `reply-delivery` | Durable outbound presentations | Gateway delivery, retry, and completion |

Controllers do not define SuperTag's main building blocks. They are replaceable implementations
behind the resource API. Security admission remains synchronous: a controller cannot later broaden
a Tag's Context Sets or Permission Sets beyond what the Control Plane admitted.

For how `task-dispatch` picks a Worker Host and handles interrupted execution, see
[Scheduling and interrupted execution](scheduling-and-recovery.md).
