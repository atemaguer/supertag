# SuperTag Control Plane

The Control Plane is one of SuperTag's two top-level runtime components. It maintains the durable
state of an AI [organization](glossary.md#autonomous-organization) and decides what work the
organization accepts and where that work runs. [Worker Hosts](glossary.md#worker-host) form the
execution side of the system.

This page uses these SuperTag terms, each defined in the glossary: [Tag](glossary.md#tag),
[Role](glossary.md#role), [Objective](glossary.md#objective), [Team](glossary.md#team),
[Workstream](glossary.md#workstream), [Task](glossary.md#task),
[Task Attempt](glossary.md#task-attempt), [Session](glossary.md#session),
[Context Set](glossary.md#context-set), [Permission Set](glossary.md#permission-set),
[Control Plane](glossary.md#control-plane), [API Server](glossary.md#api-server),
[Gateway](glossary.md#gateway), [Surface Account](glossary.md#surface-account),
[Worklet API](glossary.md#worklet-api), [Worklet](glossary.md#worklet), and
[Worker](glossary.md#worker).

The API Server is the Control Plane's public endpoint: the authenticated management, resource, and
Worklet API boundary that operators, Worker Hosts, and Gateways call. It keeps no durable state
apart from transfer files, and the API Server and the controllers run as one process. Running API
Server replicas apart from the controllers is not supported yet: every Control Plane process also
runs its own controllers, so run exactly one per database. The Gateway connects collaboration
surfaces to the Control Plane. It runs as a separate, optional process and is an ordinary client
of the API Server. These boundaries keep resource semantics and admission separate from
collaboration transport and from reconciliation.

## System boundary

```text
Slack / GitHub / Linear / Lark / Teams       CLI / API
                    |                            |
                 Gateway                    API Server
                    \____________________________/
                                  |
                            Control Plane
                    - controllers and scheduling
                    - durable state and audit
                                  |
                         API Server / Worklet API
                                  |
                           Worker Hosts
                        - one Worklet per host
                        - Workers and Worker Profiles
                        - harnesses and environments
```

The Control Plane owns:

- Tags, Roles, Objectives, Teams, Workstreams, Tasks, Sessions, and Mailboxes;
- Context Sets, Permission Sets, admission, identity, policy, and budgets;
- scheduling, leases, retries, recovery, cancellation, and reconciliation; and
- desired state, observed state, events, and audit history.

The API Server authenticates operator and Worklet requests, validates resource representations,
applies admission rules, and exposes desired and observed state through versioned resources. Its
Worklet API registers Worker Hosts, carries assignments and cancellation, accepts heartbeats and
execution observations, and reports backpressure. Resource watch clients compare the resource
versions represented by the API Server. It does not run controllers or execute Tasks.

The Gateway terminates and authenticates collaboration-surface connections, normalizes incoming
messages, forwards them to the appropriate Control Plane service, and delivers outbound
presentations. It reports collaboration surface transport success, failure, and health. It does not own the
management or Worklet APIs, decide organizational policy, create work, or schedule Worker Hosts.

Worker Hosts do not become part of the Control Plane. Each provides execution capacity through a
Worklet and one or more Workers. See [Worker Hosts, Worklets, Workers, and harnesses](worker.md).

## Stable API boundary

```text
CLI / dashboard / automation
            |
      API Server
  authentication, validation,
  admission and resources
            |
 PostgreSQL + credential vault
            |
       controllers
       /         \
 Worklet API    Gateway connections to surfaces
```

All management clients use the Control Plane API Server. PostgreSQL tables, logical credential IDs,
and vault implementations are private implementation details. Local and hosted deployments differ
only in how the CLI locates and authenticates to the Control Plane.

## Connections

The local CLI configuration separates three concerns:

- **Control Plane** — the deployment whose API Server the CLI and Worklets use.
- **Operator credential** — how this CLI authenticates, resolved through a client-side provider.
- **Connection** — a named pairing of one Control Plane and one operator credential.

The active connection is used automatically. Names remain optional for the first Control Plane and
become useful when an operator manages several deployments. This concept is intentionally called a
connection rather than a context; Context Sets already describe knowledge admitted to Tag work.

## Callers and roles

Every caller of the Control Plane authenticates with its own bearer credential. One
default-deny table at the API Server maps every RPC to the roles allowed to call it; an RPC
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
| Client | Tags and Teams its Auth Key allows, its own conversations and Objectives, its Inbox items |
| Worker Host | Execution of the work it claims, for its current generation |
| Gateway | Connector, reply progress, and operator notification calls, for the Surface Accounts that name it |

A client is a device. It sees only the work it started, never work without an owner, and never
Worker Host status. It starts work only through conversations and Objectives. It decides an
approval only when a Permission Set names it as `client:NAME`. The audit log records every
caller by its full principal, and an enrollment by the Auth Key that admitted it,
`auth-key:NAME`. Client certificates are an optional network filter in front of all of this.

## Resources

Control Plane resources use `apiVersion`, `kind`, `metadata`, `spec`, and `status`.

- Persistent resources such as Tags have stable IDs, names, timestamps, and opaque resource versions.
- Desired configuration belongs in `spec`.
- Reconciled or observed state belongs in `status`.
- Cross-resource actions may use explicit virtual resources instead of ad hoc RPC or shell execution.

The API Server's resource contract is versioned independently from database schemas, CLI syntax,
and Gateway protocols. This allows a dashboard, SDK, or newer CLI to share the same resource
contract.

## Controllers

A controller continuously reconciles one named responsibility and exposes status independently:

| Controller | Desired input | Observed responsibility |
| --- | --- | --- |
| `surfaces` | Enrolled Surface Accounts | Gateway connections and HTTP collaboration surface readiness |
| `task-dispatch` | Durable admitted Tasks | Worker selection, Task Attempts, retries, and results |
| `reply-delivery` | Durable outbound presentations | Gateway delivery, retry, and completion |

Controllers do not define SuperTag's main building blocks. They are replaceable implementations
behind the resource API. Security admission remains synchronous: a controller cannot later broaden
a Tag's Context Sets or Permission Sets beyond what the Control Plane admitted.

The Control Plane writes a warning to its process log when one event-loop turn runs for more than
one second. The warning includes `lagMs` and the HTTP route or background job active during the
stall. For example, a long dispatch pass reports `job: task dispatch`.

For how `task-dispatch` picks a Worker Host and handles interrupted execution, see
[Scheduling and interrupted execution](scheduling-and-recovery.md).

## Current scope

The first API version establishes resource envelopes, idempotent Tag creation, observable
controller status, collaboration surface enrollment, and versioned virtual operations for compound Tag changes.
Tag location state remains part of the Tag; other resources gain collection APIs as their mutation
contracts stabilize.
