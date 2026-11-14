# Control Plane API

The Control Plane, the service that stores a SuperTag organization and schedules its work,
serves one gRPC API to every client: the CLI, the terminal UI, the desktop app, your own
applications, **Worker Hosts** (the machines that run work), and **Gateways** (the services that
connect collaboration surfaces). This page is the contract for calling it. See the
[glossary](glossary.md) for terms.

The API is the protobuf package `supertag.runtime.v2`, defined in
[`rust/proto/supertag/runtime/v2/`](../../rust/proto/supertag/runtime/v2/runtime.proto). Its
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

### Authenticate

Send `authorization: Bearer SECRET` on every call. The Control Plane checks each call against one
table of roles:

| Caller | Secret | May call |
| --- | --- | --- |
| The admin operator | The admin Operator Token | Every operator service, including `OperatorAccess` |
| A named operator, `token:NAME` | An Operator Token | Every operator service except `OperatorAccess` |
| A client device, `client:NAME` | The credential `supertag connect` saved from a client Auth Key | Operator services, limited to the Tags its key named |
| A Worker Host, `host:NAME` | Its host credential | `WorkerHost` and the services a running Task Attempt uses |
| A Gateway, `gateway:NAME` | Its Gateway credential | `Connector` and the operator notification services |

An application usually runs with an Operator Token of its own, so its changes appear under its
name in `supertag audit`.

## Operator services

| Service | For |
| --- | --- |
| `Operator` | Tags, Tasks, Worker Hosts, Auth Keys, Task events and usage, reply deliveries, and recovery decisions |
| `Conversations` | A Tag's conversations and their messages, and sending a message |
| `OperatorEvents` | `Watch`: change notices with a resume token |
| `Objectives` | Create an Objective, read and list them, change limits, pause, resume, cancel, review, and complete |
| `ObjectiveOverviews` | The readable progress overview that `describe objective` prints |
| `Inbox` | Inbox items, questions and their answers, and approval decisions |
| `WorkSessions` | Work Sessions started from a parent Session |
| `Teams` | Teams and their Workstream posts |
| `Mailbox` | Messages between Tags and Mailbox grants |
| `LiveInputs` | Messages to a running Task, and resolving an uncertain delivery |
| `PolicyCatalog`, `SurfacePolicyCatalog` | Roles, Permission Sets, Context Sets, Role assignments, Surface Accounts, and surface locations |
| `ManifestRelationships` | Server-side apply of manifests and apply sets |
| `Placement` | A Tag's required labels, and why a Task waits |
| `AuthKeys`, `Enrollments` | Auth Keys, enrollment, and credential rotation |
| `OperatorAccess` | Operator Tokens (admin only) |
| `ArtifactCatalog`, `ArtifactPublications`, `ArtifactVolumes` | Artifacts, publications to other Objectives, and Volumes |
| `GithubWorkspaces`, `GithubPublications` | GitHub Workspace sources and publications |
| `WorkspaceVolumes` | Workspace data Volumes |
| `Spend`, `Metrics` | Spend reports and an operational snapshot |

The other services in the package serve Worker Hosts, Gateways, and harness adapters.

## Call it from your application

Generated bindings for Go, TypeScript, and Python live in
[`rust/bindings`](../../rust/bindings/README.md). The Go module exposes Connect clients; pass
`connect.WithGRPC()`. TypeScript exports protobuf-es messages and service descriptors, and Python
exposes messages and gRPC stubs.

```text
1. Negotiate(role: SERVICE_ROLE_CLIENT, protocol_versions: [...])  → protocol_version
2. Operator.SubmitTask(tag_id: "lead", session_id: "triage", prompt: "...")
     metadata: authorization: Bearer stop_..., x-supertag-protocol: <version>
3. OperatorEvents.Watch(...)  → change notices until the Task finishes
```

## Writes, retries, and conflicts

- Many writes take an `operation_id`. A retry with the same ID returns the first result instead
  of acting twice. Generate a new one per intended change.
- Many updates take an `expected_revision`. The Control Plane refuses the change when the
  resource changed since you read that revision.
- A refused call returns a gRPC status with a plain message. Messages never echo secrets.

## Watch for changes

`OperatorEvents.Watch` streams change notices for Tags, Tasks, conversation messages, Objectives,
Teams, and Workstream posts. Each notice carries a resume token; reconnect with the last one to
continue without a gap. A notice says what changed, not its new contents: read the resource.

## Stability

The API is versioned by protocol negotiation and the package name. See
[API stability](api-stability.md).
