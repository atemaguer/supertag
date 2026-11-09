# Control Plane API Server

The **API Server** is the part of the **Control Plane**, the service that stores and coordinates a
SuperTag [organization](glossary.md#autonomous-organization), that exposes one versioned management
and resource API for local CLIs, hosted deployments, dashboards, and automation. Most users should
use `supertag` commands rather than call it themselves.

The API Server handles operator authentication, request validation, accepted work, resource
representation, and status. The CLI never edits Control Plane database rows or external tool
credentials directly. Database migration remains an operator deployment action.

The API Server also owns the **Worklet API**, the authenticated protocol through which a
**Worklet** (supervisor) connects a **Worker Host** (a machine or sandbox that provides execution
capacity). The **Gateway**, which carries traffic to and from external work tools, currently shares
one process, deployment, and HTTP listener with the API Server. It does not define the API behavior
documented here.

This page explains how to reach and call the API. The
[operator API reference](operator-api/README.md), generated from the protos, documents every
service, RPC, message, and field.

Other terms on this page are defined in the glossary: [Tag](glossary.md#tag),
[Objective](glossary.md#objective), [Task](glossary.md#task),
[Task Attempt](glossary.md#task-attempt), [Session](glossary.md#session),
[Auth Key](glossary.md#auth-key), [admin token](glossary.md#admin-token),
[Operator Token](glossary.md#operator-token), and [Worker](glossary.md#worker).

## Authentication

Every management and resource request requires an operator credential:

```http
Authorization: Bearer <admin-token-or-operator-token>
```

Use HTTPS outside loopback. Set `SUPERTAG_ADMIN_TOKEN` for every non-loopback Control Plane. A
loopback Control Plane generates a local credential under `~/.supertag` when none is configured.

The admin token may call every RPC. An [Operator Token](resource-model.md#operator-tokens),
a `stop_` secret, may call every one except [`AccessService`](operator-api/access.md), which
refuses it with `permission_denied`. A revoked or expired Operator Token is refused as
unauthenticated, with a message that says which. Scoped coordination credentials reach only the
RPCs that accept them. The Control Plane records the caller as `control-plane-break-glass`,
`token:NAME`, or the scoped credential's `operatorId` on approvals, Objective messages, and
Objective and Team changes, and in the [audit log](#audit-log) entry for every management write.
See [Manage a remote Control Plane](../operations/control-plane.md#manage-a-remote-control-plane).

Operator credentials are separate from Worker Host credentials. Collaboration surface credentials
accepted during enrollment are write-only and never appear in a response. A Worker Host credential
appears only in the response that issues or rotates it; ordinary Worker Host reads never contain
the token or its server-side logical credential ID.

## Operator RPCs (Experimental)

The Control Plane serves its operator API as RPCs defined in protobuf, in the package
`supertag.operator.v1` under
[`spec/proto/supertag/operator/v1/`](../../spec/proto/supertag/operator/v1/). The
[operator API reference](operator-api/README.md) lists every RPC with the action it needs, who may
call it, and what the audit log records, and one page per service:

| Service | Serves |
| --- | --- |
| [`OrganizationService`](operator-api/organization.md) | `supertag status`, `spend`, `audit`, and metrics |
| [`ConversationService`](operator-api/conversation.md) | `supertag message tag` and the terminal UI's conversations |
| [`EventService`](operator-api/event.md) | Change notices for clients that show live state |
| [`InboxService`](operator-api/inbox.md) | The operator inbox and approval requests |
| [`ObjectiveService`](operator-api/objective.md) | Objectives |
| [`WorkService`](operator-api/work.md) | Tasks, Sessions, and artifacts |
| [`TeamService`](operator-api/team.md) | Teams |
| [`MailboxService`](operator-api/mailbox.md) | Messages between Tags, Mailbox grants, and Workstream posts |
| [`HostService`](operator-api/host.md) | Worker Hosts and Auth Keys |
| [`AccessService`](operator-api/access.md) | Operator Tokens |
| [`SurfaceService`](operator-api/surface.md) | Surface Accounts, Tag locations, and set activation |
| [`ResourceService`](operator-api/resource.md) | Configuration resources and server-side apply |

The conventions every RPC follows, such as pagination and the order in which a call is checked, are
in [Shared messages and options](operator-api/shared.md#conventions). The Control Plane serves
no `/api/v1/` routes.

### Calling an RPC

Each RPC is a `POST` to `/PACKAGE.SERVICE/METHOD` on the API port, such as
`/supertag.operator.v1.OrganizationService/GetStatus`. The listener speaks the Connect and
gRPC-Web protocols over HTTP/1.1. gRPC itself needs HTTP/2 and is not served on this port yet.

The Connect protocol accepts JSON, so `curl` can call any RPC:

```sh
curl -s https://control.example.com/supertag.operator.v1.OrganizationService/GetStatus \
  -H "Authorization: Bearer $SUPERTAG_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{}'
```

```json
{
  "metadata": {
    "id": "control-plane",
    "name": "control-plane",
    "resourceVersion": "9f2c…",
    "createdAt": "2026-11-08T09:00:00Z",
    "updatedAt": "2026-11-08T09:41:12.345Z"
  },
  "phase": "CONTROL_PLANE_PHASE_ACCEPTING",
  "controllers": [
    { "name": "task-dispatch", "phase": "CONTROLLER_PHASE_RUNNING" },
    { "name": "reply-delivery", "phase": "CONTROLLER_PHASE_RUNNING" },
    { "name": "surfaces", "phase": "CONTROLLER_PHASE_RUNNING" }
  ]
}
```

Bodies use proto3 JSON. Field names are lowerCamelCase, enums are their value names, times are
RFC 3339 strings, and 64-bit integers are strings. A request field the message does not define is
ignored, not refused. Send `Content-Type: application/proto` for the binary encoding instead. The
generated clients in TypeScript (`@supertag/operator-api`), Go, and Python
([`supertag.operator`](../../sdks/python/README.md#call-the-operator-api)) handle all of this.

Authentication is the same `Authorization: Bearer` header. The Control Plane checks the credential
before it reads the request body. [Method options](operator-api/shared.md#options) in
[`options.proto`](../../spec/proto/supertag/operator/v1/options.proto) declare who may call each
RPC: the operator action the credential must carry, whether only the admin token may call it,
whether a scoped coordination credential or a Worker Host's own credential may, whether it takes an
Auth Key instead, and the action the audit log records. An RPC that
only reads sets `idempotency_level = NO_SIDE_EFFECTS`; every other RPC declares an audit action.

### Examples

Send a message to a Tag. The response returns before the Tag answers:

```sh
curl -s https://control.example.com/supertag.operator.v1.ConversationService/SendMessage \
  -H "Authorization: Bearer $SUPERTAG_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"tag": "planner", "conversation": "billing", "text": "Which step is riskiest?",
       "idempotencyKey": "billing-0007"}'
```

```json
{
  "taskId": "01JC8V3W6Q4Z9T2N5R7K1M0XHB",
  "tag": "planner",
  "conversation": "billing",
  "sessionId": "01JC8T9F2D6S1Q8V4N3B7W5YKE",
  "text": "Which step is riskiest?",
  "createdAt": "2026-11-08T09:41:12.345Z",
  "status": "REPLY_STATUS_WAITING"
}
```

Create an Objective with a budget:

```sh
curl -s https://control.example.com/supertag.operator.v1.ObjectiveService/CreateObjective \
  -H "Authorization: Bearer $SUPERTAG_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"owner": "release-manager", "outcome": "Ship the 0.4 release.",
       "budget": {"limitMinor": "5000", "currency": "USD"}}'
```

List a Tag's running Tasks:

```sh
curl -s https://control.example.com/supertag.operator.v1.WorkService/ListTasks \
  -H "Authorization: Bearer $SUPERTAG_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"tag": "release-manager", "statuses": ["TASK_STATUS_RUNNING"]}'
```

Apply a manifest on the Control Plane:

```sh
curl -s https://control.example.com/supertag.operator.v1.ResourceService/ApplyManifests \
  -H "Authorization: Bearer $SUPERTAG_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"documents": [{"manifest": {"apiVersion": "supertag/v1", "kind": "Tag", "metadata": {"name": "builder"}, "spec": {"roles": ["Builder"]}}}]}'
```

### RPC errors

A refused call returns a Connect error: a JSON body with `code`, `message`, and `details`. The one
detail is a [`supertag.operator.v1.ErrorDetail`](operator-api/shared.md#errordetail) whose `reason`
is stable; branch on it, never on `message`.

| Connect code | HTTP status | `ErrorDetail.reason` |
| --- | --- | --- |
| `unauthenticated` | 401 | `ERROR_REASON_UNAUTHENTICATED`, `ERROR_REASON_CREDENTIAL_REVOKED`, or `ERROR_REASON_CREDENTIAL_EXPIRED` |
| `permission_denied` | 403 | `ERROR_REASON_PERMISSION_DENIED` |
| `invalid_argument` | 400 | `ERROR_REASON_INVALID_ARGUMENT` |
| `not_found` | 404 | `ERROR_REASON_NOT_FOUND` |
| `failed_precondition` | 400 | `ERROR_REASON_CONFLICT` |
| `resource_exhausted` | 429 | `ERROR_REASON_RESOURCE_EXHAUSTED`: a request over a size limit, or a rate or mailbox limit reached |
| `unavailable` | 503 | `ERROR_REASON_DRAINING` while the Control Plane shuts down; `ERROR_REASON_UNAVAILABLE` when this Control Plane lacks what the RPC needs, such as a feature it is configured without |
| `internal` | 500 | `ERROR_REASON_INTERNAL`, with a message that names no internal detail |

`canceled`, `deadline_exceeded`, and `unimplemented` carry `ERROR_REASON_UNSPECIFIED`; the code
says why. A body the Connect protocol itself rejects gets only the code, with no detail: one that
is not valid JSON for the request message (`invalid_argument`) or is over 1 MB, or 16 MB for a
`ResourceService` RPC (`resource_exhausted`). The credential is checked first, so an anonymous
caller still gets `unauthenticated`.

A call without a credential reveals nothing but the error:

```json
{
  "code": "unauthenticated",
  "message": "A valid Control Plane admin token or Operator Token is required",
  "details": [
    {
      "type": "supertag.operator.v1.ErrorDetail",
      "value": "CAE",
      "debug": { "reason": "ERROR_REASON_UNAUTHENTICATED" }
    }
  ]
}
```

`value` is the binary detail in unpadded base64; `debug` repeats it as JSON for people reading the
reply.

### Server streams

[`ConversationService.FollowMessage`](operator-api/conversation.md#followmessage) and
[`EventService.Watch`](operator-api/event.md#watch) are server streams. The client sends one
request and reads events until the stream ends. In the Connect protocol, a stream is a `POST` with
`Content-Type: application/connect+json`. The request body and each event are one frame: a flags
byte, a 4-byte big-endian length, then the JSON message. A last frame with flags `0x02` carries
the end of the stream and any error. The generated clients handle the framing, so call streams
through them rather than `curl`.

Both streams send a `heartbeat` after 15 seconds without another event, so proxies keep an idle
connection open. The server sets no deadline. A stream stays open until it ends on its own, the
client cancels the call, or the Control Plane drains. Draining ends it with `unavailable` and
`ERROR_REASON_DRAINING`; call again to resume. Before an event, an open stream rechecks its
credential once 15 seconds have passed since the last check. When an admin revokes its Operator
Token, or the token expires, the stream ends within 30 seconds, even when idle. It ends with
`unauthenticated` and `ERROR_REASON_CREDENTIAL_REVOKED` or `ERROR_REASON_CREDENTIAL_EXPIRED`.

`@supertag/operator-api` includes `FollowEventAdapter`, which turns `FollowMessage` events into
[AI SDK UI message stream](https://ai-sdk.dev/docs/ai-sdk-ui/stream-protocol) chunks for a chat
UI built on the AI SDK hooks. Text deltas become text parts; activity, `joined`, `waiting`, the
reply, and each work Session become `data-activity`, `data-joined`, `data-waiting`, `data-reply`,
and `data-work-session` parts with stable IDs, so a repeat replaces a part instead of adding one.
`error` becomes an `error` chunk and `end` becomes `finish`, with the message as
`messageMetadata.message`.

### Audit log

Every call to an RPC that declares an audit action is recorded, with `path` set to its procedure,
such as `/supertag.operator.v1.HostService/DrainWorkerHost`, and `status` set to the HTTP status
its Connect code maps to. Reads, plans, and dry runs are not recorded.
[`OrganizationService.ListAuditEntries`](operator-api/organization.md#listauditentries) reads the
log, and `supertag audit` prints it.

An entry never contains a credential, a secret value, a digest, or a request body. The Control
Plane writes each entry to its database and to one more sink, standard error or the file
`logging.audit` names in `supertag.yaml`; see [Audit log](../operations/control-plane.md#audit-log).

## Worklet API

Remote Worklets connect outbound to `/worklets` on the same Control Plane listener. Each Worklet
presents the credential issued for its declared Worker Host. The API Server binds that identity to a
connection generation—an increasing number identifying its current connection. It carries
assignments and cancellation, and accepts heartbeats,
receipts, and ordered Task Attempt events only from the current generation. On the Worklet API the
credential grants access only as that Worker Host. It does not authorize collaboration-surface
requests, and on the operator API it may call only the three RPCs that drain, resume, or revoke its
own host; see below.

Before storing a Worker event, the Worklet validates it against the same event schema used by the
connection. If a Worker emits an unknown event type, an event missing a required field or with a
field of the wrong type, or an event larger than 3 MiB, the Worklet omits that event and records an
`execution.failed` event naming the rejected type and error. The Task Attempt fails, while the
Worker Host connection stays open for other Task Attempts. Fields the schema doesn't name are kept
and delivered unchanged.

The `WorkerHost` status records the last successful credential claim, the cumulative number of
rejected claims against that enrolled host identity, and the most recent rejection time. These
fields survive Control Plane restart without exposing credential material.

Join a host with an [Auth Key](resource-model.md#auth-keys). An operator creates the key, and the
new host redeems it on its first connection:

```bash
supertag create auth-key build --tag builder
# On the new host:
SUPERTAG_AUTH_KEY=stak_... supertag connect worklet --transport websocket \
  --worklet-url https://supertag.example.com --worker-host build-east-1
```

Redemption calls [`HostService.JoinWorkerHost`](operator-api/host.md#joinworkerhost) with the
key as the bearer token in place of an operator credential. The response carries the host's
one-time credential, its Tags, and whether it is ephemeral. An unknown key fails with
`unauthenticated`, an expired, revoked, or used key with `permission_denied`, and a key one of whose
Tags no longer exists with `failed_precondition`. A request that sets `idempotencyKey` is safe to
retry: a repeat with the same key returns the same host with a new credential, which replaces the one
the lost answer carried, until the host first connects. `supertag connect worklet` retries this way
when the answer does not arrive.

A Worker Host may also act on itself with its own credential, without an operator credential. It
sends the credential as the bearer token and its ID in the `x-supertag-worker-host-id` header to
[`RevokeWorkerHostCredential`](operator-api/host.md#revokeworkerhostcredential),
[`DrainWorkerHost`](operator-api/host.md#drainworkerhost), or
[`ResumeWorkerHost`](operator-api/host.md#resumeworkerhost), and may name only itself.
`supertag up` and `supertag down` drain a host service this way before restarting or stopping it,
and the host resumes itself when it starts again. A host credential authorizes no other RPC.

A custom Worker that reads its host credential from its own secret manager gets one from
`supertag enroll worker-host ID --out PATH`, which writes the one-time credential to a mode-`0600`
file. `supertag connect worklet --transport websocket --worklet-url URL --worker-host ID` resolves
the credential stored in `~/.supertag/worker-hosts/<host-id>.credential.json` without accepting an
arbitrary credential path. `supertag connect worklet --transport websocket --worklet-url URL` converts
`http:` to `ws:` and `https:` to `wss:` when `--transport websocket` is explicit, and supplies
`/worklets` when the URL has no explicit path. Without that override, HTTP(S) origins address
the separate gRPC listener. Explicit WS(S) URLs retain WebSocket.
Plain `http:` or `ws:` is accepted only for loopback addresses.
The API Server and Gateway share one process and HTTP listener. Internal gRPC services use
a separately configured listener in that process.

## Resource shape

`supertag get` and `list --output json` print resources in a common envelope:

```json
{
  "apiVersion": "supertag/v1",
  "kind": "Tag",
  "metadata": {
    "id": "01...",
    "name": "engineering",
    "resourceVersion": "2026-08-11T20:00:00.000Z",
    "createdAt": "2026-08-11T19:00:00.000Z",
    "updatedAt": "2026-08-11T20:00:00.000Z"
  },
  "spec": {
    "roles": ["Security Reviewer"]
  },
  "status": {
    "phase": "active",
    "locations": [
      {
        "provider": "slack",
        "account": "Engineering Slack",
        "target": "channel:C0123456789",
        "enabled": true
      }
    ]
  }
}
```

- `metadata` identifies and versions the resource.
- `spec` is user-controlled desired state.
- `status` is observed state maintained by the Control Plane.
- `resourceVersion` changes when the represented resource changes and must be treated as opaque.

Resource names make creation idempotent. Repeating Tag creation with the same name returns the
existing Tag. `Tag.spec.roles` lists the reusable responsibilities assigned to that actor;
execution requirements belong to Tasks.

The JSON Schemas in [`spec/manifests/`](../../spec/manifests/) describe each manifest kind. They are
generated from the protos, as is `manifest.schema.json` for a manifest of any kind.

The current `supertag watch` command observes change by polling these resource versions.
[`EventService.Watch`](operator-api/event.md#watch) streams notices of changes instead.

## Versions

Every response, including errors and `/healthz`, carries a `SuperTag-Version` header with the
Control Plane's release, such as `0.2.0-alpha.6`. `GET /healthz` needs no credential and returns
`{"ok": true, "version": "0.2.0-alpha.6"}`. The CLI sends its own release in
`SuperTag-Client-Version`. The supported pairs are in
[CLI and Control Plane versions](api-stability.md#cli-and-control-plane-versions).

## Deliberate exclusions

The API does not provide arbitrary process execution, filesystem access, database migrations, or
deployment lifecycle control. Worker Host credential operations are limited to enrollment,
rotation, and revocation; tokens do not appear in ordinary reads. The administrative credential has
full control-plane authority. Coordination endpoints can instead use separately configured
operator credentials restricted to exact actions and Objectives. Task events, resource change
history, structured permission decisions, and the [audit log](#audit-log) record what happened.

See [Credential storage](credential-storage.md) for the server-side vault and client-side operator credential boundaries.

## Coordination operations (Experimental)

`POST /internal/v1/coordination/mcp` is the MCP endpoint a running Task Attempt calls with its
execution credential. It offers only the tools that Task's turn may use; see
[Coordination tools](coordination.md#coordination-tools). The Control Plane derives the acting Tag
from the credential and refuses a tool the turn does not get.

Operators coordinate through [`InboxService`](operator-api/inbox.md) and
[`ObjectiveService`](operator-api/objective.md).

## Execution evidence

[`WorkService`](operator-api/work.md) reads of Tasks, Task Attempts, and placement come from
records the Control Plane stores, not from a live health check of the Worker Host. Only
[`InspectTaskExecution`](operator-api/work.md#inspecttaskexecution) asks a Worker Host for its
receipt. It records the Worker events the receipt names and the Control Plane lacks, and neither
retries execution nor changes Task state.

- Missing terminal execution evidence does not prove a process stopped. A pending Task without a
  scheduling diagnosis is not classified as a capacity or connectivity problem.
- The recorded Worker Host, Worklet, and Worker identities come from acceptance or recovery
  receipts. A requested Worker Profile is a capacity requirement, not a selected host, so these
  fields stay unrecorded until a confirmed receipt names the host. Unknown host identity is shown
  as "not recorded"; it is never inferred from another Worker's current advertisement.
- An unknown receipt cannot establish a new host binding, and an existing binding cannot silently
  change during recovery. Older records may hold a placeholder or an aggregate Worklet descriptor;
  those values are unconfirmed and are not rewritten when a receipt conflicts with them. The
  mismatch remains an error that needs inspection.
- A Worker emits its terminal execution event only after closing the harness execution and both
  environment accesses, so cleanup `confirmed` means that durable event was observed. The stored
  Task Attempt phase alone does not tell you whether a process is still executing.
- A limit `threshold_reached` outcome is derived only from an applied numeric ceiling and durable
  usage or native-agent observations. Terminal error text is never treated as proof that a limit
  was enforced.

`supertag describe task ID` shows this stored evidence without asking the Worker Host.

## Session persistence

A **Session** groups Tasks from one conversation and owns its stored native conversation state.
For example, a conversation started with Codex on one Worker Host can continue on another host
that can restore its native files and provide compatible tools and workspace access. Claude Code
uses its SDK's Session storage callbacks to preserve main and subagent transcript entries.
Conversation storage does not restore workspace files, running processes, or a sandbox.

[`WorkService.ListSessionStates`](operator-api/work.md#listsessionstates) and
[`GetSessionState`](operator-api/work.md#getsessionstate) read the stored state. The API retrieves
stored state rather than starting an execution. Continue the conversation through its existing
Session; the Control Plane selects a compatible resume point when admitting the next Task. A
stored archive resumes only for the same Tag and Session, the same reply audience, and the harness
that produced it, and that harness must be able to load it where it runs. Native transcripts are
private Session data and are not discoverable through the artifact catalog or exposed as a
coordination tool.

### Worker storage contract

Built-in connected TypeScript Workers use `HttpSessionStateStore` to call
`POST /internal/v1/sessions/save` and `POST /internal/v1/sessions/load`. These internal endpoints
require an execution credential for the current Task Attempt. The Control Plane can supply a
Session-only credential in `session.persistence: {controlPlaneUrl, token}` without exposing
coordination tools. That credential grants only Session save/load access, not Mailbox or artifact
operations. Existing coordinated execution can use its scoped execution credential. Neither path
uses the administrative token or a native provider credential. Loads are limited to the current Task Attempt's state or the compatible prior
state selected for that Session. Writes belong to the current active Task Attempt.

A save contains `ref`, `harnessId`, `data`, and a positive `writeVersion`. The HTTP adapter assigns
increasing write versions to each state so delayed writes cannot overwrite newer transcript data.
A load contains `ref` and returns the matching native state or null. Custom implementations must
preserve these identity, ordering, and authorization checks. The Python SDK exposes the same
Session storage contract but requires an explicitly supplied durable adapter.
