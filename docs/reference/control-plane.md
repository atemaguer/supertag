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

The API Server and Gateway are subsystems inside the Control Plane. The API Server is the
authenticated management, resource, and Worklet API boundary. The Gateway connects collaboration
surfaces to the Control Plane. The first deployment remains one process and listener, but these
boundaries keep resource semantics and admission separate from collaboration transport and from
reconciliation.

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
