# Control Plane API Server

The **API Server** is the part of the **Control Plane**, the service that stores and coordinates a
SuperTag [organization](glossary.md#autonomous-organization), that exposes one versioned management
and resource API for local CLIs, hosted deployments, dashboards, and automation. Most users should
use `supertag` commands rather than call these endpoints themselves.

The API Server handles operator authentication, request validation, accepted work, resource
representation, and status. The CLI never edits Control Plane database rows or external tool
credentials directly. Database migration remains an operator deployment action.

The API Server also owns the **Worklet API**, the authenticated protocol through which a
**Worklet** (supervisor) connects a **Worker Host** (a machine or sandbox that provides execution
capacity). The **Gateway**, which carries traffic to and from external work tools, currently shares
one process, deployment, and HTTP listener with the API Server. It does not define the API behavior
documented here.

Other terms on this page are defined in the glossary: [Tag](glossary.md#tag),
[Role](glossary.md#role), [Objective](glossary.md#objective), [Team](glossary.md#team),
[Workstream](glossary.md#workstream), [Mailbox](glossary.md#mailbox), [Task](glossary.md#task),
[Task Attempt](glossary.md#task-attempt), [Session](glossary.md#session),
[Context Set](glossary.md#context-set), [Permission Set](glossary.md#permission-set),
[Surface Account](glossary.md#surface-account), [host service](glossary.md#host-service),
[Auth Key](glossary.md#auth-key), [admin token](glossary.md#admin-token),
[Operator Token](glossary.md#operator-token), [Worker Profile](glossary.md#worker-profile),
[Worker](glossary.md#worker), [Volume](glossary.md#volume), [Workspace](glossary.md#workspace), and
[Runtime Input](glossary.md#runtime-input).

## Authentication

Every management and resource request requires an operator credential:

```http
Authorization: Bearer <admin-token-or-operator-token>
```

Use HTTPS outside loopback. Set `SUPERTAG_ADMIN_TOKEN` for every non-loopback Control Plane. A
loopback Control Plane generates a local credential under `~/.supertag` when none is configured.

The admin token may call every route. An [Operator Token](resource-model.md#operator-tokens), a
`stop_` secret, may call every route except the `operator-tokens` routes, which return `403`. A
revoked or expired Operator Token returns `401` with a message that says which. Scoped coordination
credentials reach only the coordination routes. The Control Plane records the caller as
`control-plane-break-glass`, `token:NAME`, or the scoped credential's `operatorId` on approvals,
Objective messages, and Objective and Team changes, and in the [audit log](#audit-log) entry for
every management write. See [Manage a remote Control Plane](../operations/control-plane.md#manage-a-remote-control-plane).

Operator credentials are separate from Worker Host credentials. Collaboration surface credentials
accepted during enrollment are write-only and never appear in a response. A Worker Host credential
appears only in the response that issues or rotates it; ordinary Worker Host reads never contain
the token or its server-side logical credential ID.

## Organization spend

`GET /api/v1/spend` returns cost and tokens across Task Attempts. Codex costs use model price estimates; `estimatedCostAttempts` counts those Task Attempts in each group. Each Task Attempt
counts once, using its latest valid usage report. It requires the same operator credential as other
management reads. Query parameters are `by=tag|objective|day` (default `objective`) and
`since=ISO` (Task Attempt start time, inclusive). Invalid grouping or ISO timestamps return
HTTP 400.

For older Codex Task Attempts with tokens but no stored cost, SuperTag estimates cost from the
selected model in the Task Attempt snapshot and marks it estimated. An unknown cost remains when
the Task Attempt has no token report or the model has no known price. Estimates use the current
model price table, so they can differ from the amount billed when prices changed.

The response has `by`, `since`, and `groups`. Each group includes `key`, `attempts`,
`reportedCostByCurrency`, `unknownCostAttempts`, `reportedTokens` (null if none was reported),
and `unknownTokenAttempts`. `unpricedModels`, present only when nonempty, maps each model that
had no price to the number of unknown-cost Task Attempts that reported tokens for it.
`unpricedTokens` counts only tokens from those Task Attempts. Tag groups also have `name`;
Objective groups have `budget` containing
`limitMinor` and `currency`, or null. Currency is null for allocation budgets. Day keys are UTC
dates. `reportedCostByCurrency` is null when no cost was reported; it never implies zero cost.

Each group also includes `postTriggered`: usage from reply activations triggered by Team
questions and blockers, including direct messages. It contains the same cost, token, and
coverage fields as the group. These amounts are already included in the group totals.
`supertag spend` labels this subtotal "Post-triggered activations (included in total)".
The Objective overview exposes `objectiveSpend` and its subset `postTriggeredSpend` for the
entire Objective, independent of Task pagination and Team filters.
`supertag describe objective ID` uses these totals for its budget and reply spend lines.
With a Team filter, it labels spend as covering the entire Objective.

## Organization overview

`GET /api/v1/organization` returns what the organization is doing right now. `supertag status`
reads it. It requires the same operator credential as other management reads.

The response has `asOf`, `workerHosts`, `tags`, and `objectives`:

- Each Worker Host has `id`, `phase`, `running`, `capacity`, `coordinationCapacity`, and
  `harnesses`. Each harness entry has `harness`, `running`, `capacity`, and
  `coordinationCapacity`. `running` counts all running Task Attempts. `capacity` includes
  regular slots and any coordination slots; `coordinationCapacity` counts only
  those coordination slots. For example, four regular slots and one coordination slot show
  `running: 5`, `capacity: 5`, and `coordinationCapacity: 1` when full. Revoked hosts are
  left out.
- Each Tag that is not retired has `id`, `name`, and `runningTaskIds`. An empty list means the
  Tag is idle.
- Each Objective that is not completed or cancelled has `id`, `status`, `ownerTagId`,
  `ownerName`, `deadline`, `spentMinor`, `budgetLimitMinor`, and `currency`, newest first.
  Amounts are in minor units, so `1380` with `USD` means $13.80. `currency` is null for
  allocation budgets. When a model has no published price, `unpricedAttempts` and
  `unpricedTokens` count those Task Attempts and their reported tokens. These fields are absent
  when there are no unpriced Task Attempts. `spentMinor` excludes their unknown cost.

The operator inbox is not part of this response. Read it from `GET /api/v1/coordination/inbox`.

## Worklet API

Remote Worklets connect outbound to `/worklets` on the same Control Plane listener. Each Worklet
presents the credential issued for its declared Worker Host. The API Server binds that identity to a
connection generation—an increasing number identifying its current connection. It carries
assignments and cancellation, and accepts heartbeats,
receipts, and ordered Task Attempt events only from the current generation. The credential grants
only that Worker Host access to the Worklet API; it does not authorize management or
collaboration-surface requests.

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

Redemption calls `POST /api/v1/worker-host-joins` with the key as the bearer token and a
`WorkerHostJoin` body naming the requested host ID. It needs no operator credential. The response
is the one-time `WorkerHostCredential`, plus `status.authKey`, `status.tags`, and
`status.ephemeral`. Failures return `401` for an unknown key, `403` for an expired, revoked, or used
key, and `409` when one of the key's Tags no longer exists.

A host credential also authorizes `DELETE /api/v1/worker-hosts/:id/credential` for that same
host, so a host can remove itself. It authorizes no other management request.

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

Persistent resources use a common envelope:

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
- `status` is observed state maintained by the Control Plane and represented by the API Server.
- `resourceVersion` changes when the represented resource changes and must be treated as opaque.

Resource names make creation idempotent. Repeating Tag creation with the same name returns the
existing Tag. `Tag.spec.roles` lists the reusable responsibilities assigned to that actor;
execution requirements belong to Tasks.

The current `supertag watch` command observes change by polling these resource versions. A native
streaming watch protocol is not part of API v1.

## API v1

### Endpoints

```text
GET  /api/v1/status
GET  /api/v1/metrics
GET  /api/v1/audit
GET  /api/v1/tags
POST /api/v1/tags
GET  /api/v1/tags/:name
DELETE /api/v1/tags/:name
PUT  /api/v1/tags/:name/worker-hosts/:workerHostId
DELETE /api/v1/tags/:name/worker-hosts/:workerHostId
GET  /api/v1/permission-sets
POST /api/v1/permission-sets
GET  /api/v1/permission-sets/:name
DELETE /api/v1/permission-sets/:name
GET  /api/v1/context-sets
POST /api/v1/context-sets
GET  /api/v1/context-sets/:name
DELETE /api/v1/context-sets/:name
GET  /api/v1/roles
POST /api/v1/roles
GET  /api/v1/roles/:name
DELETE /api/v1/roles/:name
GET  /api/v1/workspaces
POST /api/v1/workspaces
GET  /api/v1/workspaces/:name
DELETE /api/v1/workspaces/:name
POST /api/v1/apply-sets/:name/prune
GET  /api/v1/worker-hosts
POST /api/v1/worker-hosts
GET  /api/v1/worker-hosts/:id
POST /api/v1/worker-hosts/:id/credential
DELETE /api/v1/worker-hosts/:id/credential
POST /api/v1/worker-hosts/:id/drain
POST /api/v1/worker-hosts/:id/resume
GET  /api/v1/auth-keys
POST /api/v1/auth-keys
GET  /api/v1/auth-keys/:name
POST /api/v1/auth-keys/:name/revoke
POST /api/v1/worker-host-joins
GET  /api/v1/operator-tokens
POST /api/v1/operator-tokens
GET  /api/v1/operator-tokens/:name
POST /api/v1/operator-tokens/:name/revoke
GET  /api/v1/worker-profiles
GET  /api/v1/tasks
GET  /api/v1/tasks/:id
GET  /api/v1/tasks/:id/events
POST /api/v1/tasks/:id/cancel
POST /api/v1/objectives/:id/cancel
GET  /api/v1/sessions
GET  /api/v1/sessions/:id
GET  /api/v1/sessions/:id/states
GET  /api/v1/sessions/:id/states/:stateId
GET  /api/v1/surface-accounts
POST /api/v1/surface-accounts
GET  /api/v1/surface-accounts/:name
DELETE /api/v1/surface-accounts/:name
POST /api/v1/surface-enrollments
POST /api/v1/tag-operations
```

### Status and declarative resources

`GET /api/v1/status` returns a `ControlPlane` resource. Its status reports the Control Plane phase
and the independently named collaboration surface, Task-dispatch, and reply-delivery controllers.

Tags, Roles, Permission Sets, Context Sets, and Workspaces support declarative creation and
reconciliation with [field managers](resource-model.md#field-managers-and-apply-sets). Each `POST`
merges the request into the stored resource as one manager: it removes fields that manager set and
the request omits, keeps fields other managers own, and answers `409` with reason `Conflict` when
the request changes another manager's value. The failure's `details.conflicts` lists each `path`
and `manager`. These query parameters select the manager:

| Parameter | Effect |
| --- | --- |
| none | Writes as field manager `apply`. |
| `applySet=NAME` | Writes as field manager `NAME` and records the resource as a member of apply set `NAME`. |
| `force=true` | Applies conflicting changes and takes ownership of those fields. |
| `fieldManager=cli` | An imperative write: each listed field replaces the stored one, unlisted fields stay, and changes belong to `cli`. `supertag create tag` uses it. |

Role specs define purpose, instructions, Context Sets, and
Permission Sets; their status reports `assignedTags` as read-only observed state and identifies
built-in Roles without exposing their internal identity. `Tag.status.locations` reports the
collaboration surface locations with account display names and enabled state.

Add `?dryRun=true` to any of these `POST` endpoints to validate and plan a manifest without writing
it. The response holds the complete `spec` the resource would have after the merge, in the form a
stored resource reports, such as a GitHub `repo` resolved to its `repoId`. Its `plan` reports
`action` (`create`, `update`, or `unchanged`), `changes` (each `path`, `action`, and values), and
`conflicts`. A dry run checks structure, Surface Accounts, locations, and Worker Hosts. It does not check that named Roles, sets, or sender Tags
exist; `supertag apply` checks those against the whole input. Worker Host, Worker Profile, Task,
and Session resources expose observed state. Collection responses use a `ResourceList` envelope
and include a collection resource version.

`POST /api/v1/surface-accounts` applies a
[SurfaceAccount manifest](resource-model.md#declared-surface-accounts) under the same field
managers and query parameters. Its secrets are references. Two optional body fields carry
credential material, write-only:

| Field | With | Effect |
| --- | --- | --- |
| `credentials` | `dryRun=true` | The resolved secret values. The plan adds `secrets`: `changed` or `unchanged`, compared with the vault in constant time. Nothing is stored or echoed. |
| `verified` | a write | The account as the CLI verified it with the provider, in the `surface-enrollments` shape, with its secrets. The Control Plane stores it as enrollment does, with the manifest's name and references. |

A write without `verified` only records field ownership and set membership, and fails if anything
would change. A dry run on an existing account also returns `current`, its `provider` and
`externalAccountId`. Changing `provider`, or `verified` for another provider account than the name
holds, is refused with `409`. `GET /api/v1/surface-accounts/:name` reads an account by manifest
name or by `PROVIDER:EXTERNAL_ID`; its `spec.secrets` lists the declared references.

`POST /api/v1/apply-sets/:name/prune` takes `{ "keep": [{ "kind": "Tag", "name": "builder" }] }`,
the resources in the latest input. It deletes the set's other members, Tags first and Surface
Accounts last, with the same protection as `DELETE`, and returns an `ApplySetPrune` whose `items` list each
member's `kind`, `name`, `action` (`delete` or `skip`), and skip `reason`. With `?dryRun=true` it
reports the same decisions without deleting.

### Deleting resources

`DELETE /api/v1/{tags,roles,permission-sets,context-sets,workspaces,surface-accounts}/:name`
deletes one configuration resource under the rules in [Deletion](resource-model.md#deletion). Tags,
Roles, and Surface Accounts retire; sets and Workspaces are deleted. Only the administrative credential reaches these routes.
Coordination credentials and Tags acting through coordination tools cannot delete anything.

A successful request returns `200` with a `ResourceDeletion`:

```json
{
  "apiVersion": "supertag/v1",
  "kind": "ResourceDeletion",
  "metadata": { "kind": "Tag", "name": "release" },
  "dryRun": false,
  "action": "retire",
  "removed": [
    "location slack:C01 with Permission Set deploy",
    "Worker Host build-01 binding",
    "membership in apply set engineering"
  ],
  "notes": []
}
```

`action` is `retire` or `delete`. `removed` describes, for people, the configuration that went with
the resource; `notes` describes effects outside the Control Plane, such as Auth Keys that can no
longer join or Worker Hosts that still declare a deleted Workspace. Add `?dryRun=true` to get the
same response, or the same refusal, without changing anything.

A resource that is still in use returns `409` with reason `Conflict`. The message names every
reference, and `details.references` lists them:

```json
{
  "kind": "Status",
  "status": "Failure",
  "reason": "Conflict",
  "code": 409,
  "message": "permission-set deploy is in use by Role Engineer and Tag release (location slack:C01).",
  "details": { "references": ["Role Engineer", "Tag release (location slack:C01)"] }
}
```

A built-in Role returns `409` with an empty `details.references`. A missing resource, or a Tag or
Role that is already retired, returns `404`. `GET /api/v1/tags/:name` still returns a retired Tag,
with `status.phase: retired` and `status.retiredAt`, while no active Tag holds the name;
`GET /api/v1/tags` lists only active Tags.

### Worker Host enrollment and credentials

`WorkerHost` is a durable identity for an enrolled Worker Host. Its spec contains the desired drain
state. Its status reports its phase, credential revision, connection generation, protocols, last observation,
capacity, active Task Attempts, available slots, and last advertised Workers. Disconnected and revoked
hosts therefore remain visible across Control Plane restart. Neither the token nor its logical
credential ID appears in this resource.

`POST /api/v1/worker-hosts` accepts a virtual `WorkerHostEnrollment` with the host ID in
`metadata.id` and an empty `spec`. It returns a virtual `WorkerHostCredential` whose
`credential.token` is available once with `Cache-Control: no-store`.
`POST /api/v1/worker-hosts/:id/credential` rotates the
credential and returns the same one-time response. `DELETE` revokes the credential and fences its
current connection. The CLI writes issuance responses to a protected file with `--out`; it never
writes their token to a required mode-0600 output file. Use `supertag revoke worker-host-credential ID`, `drain worker-host ID`, and `resume worker-host ID` for the
corresponding lifecycle operations.

A Worker Host may also act on itself with its own credential, without an operator credential:
`DELETE /api/v1/worker-hosts/:id/credential` revokes it, and `POST /api/v1/worker-hosts/:id/drain`
and `/resume` start and end a drain. `supertag up` and `supertag down` drain a host service this
way before restarting or stopping it, and the host resumes itself when it starts again.

`WorkerHost.status.ephemeral` is `true` for a host joined with an ephemeral Auth Key, and
`status.authKey` names the key a host redeemed. `GET /api/v1/worker-hosts` omits removed ephemeral
hosts; `GET /api/v1/worker-hosts/:id` still returns them.

### Auth Keys

`POST /api/v1/auth-keys` accepts an `AuthKey` with `metadata.name` and `spec.tags`, plus optional
boolean `spec.reusable` and `spec.ephemeral`. It returns the `AuthKey` resource and its `secret`
once, with `Cache-Control: no-store`. `GET /api/v1/auth-keys` and `GET /api/v1/auth-keys/:name`
never include the secret. `POST /api/v1/auth-keys/:name/revoke` blocks further joins. The admin
token and Operator Tokens may call these routes. See [Auth Keys](resource-model.md#auth-keys) for the
fields and rules.

### Operator Tokens

`POST /api/v1/operator-tokens` accepts an `OperatorToken` with `metadata.name`. It returns the
`OperatorToken` resource and its `secret` once, with `Cache-Control: no-store`. A name already used,
even by a revoked token, returns `409`. `GET /api/v1/operator-tokens` and
`GET /api/v1/operator-tokens/:name` never include the secret. `POST
/api/v1/operator-tokens/:name/revoke` refuses the token from the next request. Only the admin token
may call these routes. See [Operator Tokens](resource-model.md#operator-tokens) for the fields and
rules.

### Audit log

`GET /api/v1/audit` returns the recorded operator changes, newest first: applies, deletes, Operator
Token and Auth Key changes, approval decisions, Objective messages, approvals, and cancellations,
and every other authenticated management write. Reads are not recorded. The admin token and
Operator Tokens may call it; scoped coordination credentials receive `403`. `supertag audit` reads
this route.

| Query | Meaning |
| --- | --- |
| `since` | Only entries at or after this ISO 8601 time |
| `actor` | Only entries by this exact actor, such as `token:laptop-2` |
| `limit` | 1 through 500; 50 by default |

An unknown, repeated, or invalid query parameter returns `400`.

```json
{
  "apiVersion": "supertag/v1",
  "kind": "AuditEntryList",
  "metadata": { "limit": 50 },
  "items": [
    {
      "id": "5f0c2e1a-…",
      "at": "2026-10-01T09:30:00.120Z",
      "actor": "token:laptop-2",
      "action": "apply",
      "target": "Tag/reviewer",
      "outcome": "succeeded",
      "status": 201,
      "source": "api",
      "method": "POST",
      "path": "/api/v1/tags"
    }
  ]
}
```

| Field | Meaning |
| --- | --- |
| `actor` | `control-plane-break-glass`, `token:NAME`, a scoped credential's `operatorId`, or `slack:USER` or `lark:USER` for a person in an Objective's thread |
| `action` | What was done, such as `apply`, `apply.dry-run`, `delete`, `prune`, `operator-token.create`, `operator-token.revoke`, `auth-key.create`, `auth-key.revoke`, `approval.approve`, `approval.deny`, `objective.message`, `objective.reopen`, `objective.approve`, `objective.cancel`, `task.cancel`, or `coordination.COMMAND` for a command the Control Plane recognizes (`coordination.command` otherwise). A write to a route the Control Plane doesn't recognize is `request` on `UnknownRoute`, and nothing from its path is kept, because a path might hold a credential. |
| `target` | `Kind/NAME` or `Kind/ID`, such as `Tag/reviewer` or `ApprovalRequest/ID`; only the kind when the request named no valid target, failed, or was a dry run |
| `outcome` | `succeeded`, or `failed` for an error response or an interrupted request |
| `status` | The HTTP status. For a change from an Objective's thread, only a refused change has one: the status the API would return. |
| `source` | `api` for a Control Plane API request, `gateway` for an Objective thread in Slack or Lark |
| `method`, `path` | For `api` entries, the request's method and the route it matched as a template, such as `/api/v1/tags/{name}`. The request's own path is never stored, and `path` is left out for an unrecognized route. |

An entry never contains a credential, a secret value, a digest, or a request body. The Control
Plane writes each entry to its database and to one more sink, standard error or the file
`logging.audit` names in `supertag.yaml`; see [Audit log](../operations/control-plane.md#audit-log).

### Metrics

`GET /api/v1/metrics` returns a bounded operational snapshot with resource and Task-state counts.
Its `values.scheduling` section reports the current queue and oldest queued Task, average and
maximum queue and placement duration, admission rejections, reservations consumed, active, and expired, and a
per-Worker-Host capacity and utilization snapshot. A reservation released after a declined claim
leaves no durable record, so the snapshot doesn't count it. Durations are milliseconds and utilization is a
number from zero to one. `scheduling.byPriority` separates queue depth, oldest queued age, placed
Task Attempts, and observed queue duration for `urgent`, `high`, `normal`, and `low` work. This makes
priority starvation visible before changing scheduling policy. These values come from stored assignments, Task Attempts, scheduling audit
events, and the latest durable Worker Host observations; reading metrics does not contact a
Worklet. Task events remain the detailed execution audit trail.

`values.rpc` reports the API Server's process-local gRPC activity. `startedAt` identifies the
counter epoch; `capturedAt` is the observation time. `methods` groups calls by service and method,
with started/completed/active counts, active streams, errors, status-code counts (array indexes
0–16), and cumulative duration buckets in milliseconds. A bucket with `le: null` includes every
duration. Streaming durations measure the lifetime of a stream, not the time for an individual
Task or message. `channels` counts HTTP/2 connections; an increase in opened connections alone
does not distinguish new hosts from reconnects. `queues` reports buffered Worklet frames/bytes,
capacity, peaks and overflow rejections; `closeCodes` groups Worklet closures by code.

RPC observations reset when the API Server process is replaced. Export snapshots to your monitoring
system if you need history, and use successive samples from the same `startedAt` epoch for rates.
They contain no Task identifiers, credentials, request bodies, or error messages. They do not
replace durable Task audit records. `traceErrors` counts failed or dropped lifecycle-log writes.

### Errors

Administrative API errors use a structured `Status` document with a reason, HTTP code, message,
and optional details. A request with a field the Control Plane does not know fails with HTTP 400,
and the message names the field, such as `Unknown field: start`.

### Versions

Every response, including errors and `/healthz`, carries a `SuperTag-Version` header with the
Control Plane's release, such as `0.2.0-alpha.6`. `GET /healthz` needs no credential and returns
`{"ok": true, "version": "0.2.0-alpha.6"}`. The CLI sends its own release in
`SuperTag-Client-Version`. The supported pairs are in
[CLI and Control Plane versions](api-stability.md#cli-and-control-plane-versions).

### Virtual write resources

`SurfaceEnrollment` is a virtual write resource. Its spec contains a locally verified collaboration surface
account and write-only credentials; its response is a secret-free `SurfaceAccount` resource. The
request and response never name the Control Plane's credential backend or its physical storage
location, so moving from the local file vault to an external service does not change this API.

`TagOperation` is a virtual resource for operations that currently span several underlying resources, including surface placement, Context Set activation, and Permission Set activation. The operation receives its own identity and returns output under `status`. Ordinary Tag creation does not use this operation path.

The virtual Tag operation remains for compound placement and binding workflows. It is versioned without pretending to be shell access or arbitrary command execution.

## Deliberate exclusions

The API does not provide arbitrary process execution, filesystem access, database migrations, or
deployment lifecycle control. Worker Host credential operations are limited to enrollment,
rotation, and revocation; tokens do not appear in ordinary reads. The administrative credential has
full control-plane authority. Coordination endpoints can instead use separately configured operator
credentials restricted to exact actions, Objectives, and Teams. Task events, Team change history,
and structured permission decisions provide execution and coordination auditing; a broader
administrative audit log remains planned.

See [Credential storage](credential-storage.md) for the server-side vault and client-side operator credential boundaries.

## CLI conversations (Experimental)

`supertag message tag` uses three routes. Each accepts the admin token or an Operator Token, and
each caller sees only its own conversations; another caller's message returns `404`.

```text
POST /api/v1/tags/:name/messages
GET  /api/v1/tags/:name/messages/:taskId
GET  /api/v1/tags/:name/messages/:taskId/stream
```

`POST` sends `{"text": "...", "session": "NAME"}` and returns a `TagMessage` record. `GET` on the
message returns the record, with `reply` once the Tag has answered. While no bound Worker Host can
run the turn, `waiting` says why in one line, such as
`no bound Worker Host provides MCP server notes`; it is absent once the turn can be placed.

When the message's turn started or continued work Sessions, the record lists them in
`startedSessions`, oldest first. Each entry has the Session `id`, its `title`, the work Session's
latest `taskId` and its `status`, and `reportStatus`: `waiting`, or `replied` with `reportTaskId`
and the report turn's `report` (`presentation` and `text`). `status` is `waiting` when the Task
completed by asking the person a question, and the entry then carries the `question`. While the
work Session's Task has pending approval requests, `approvals` lists each one's `requestId` and the
notice `text` posted to the conversation. `updates` lists the `text` of each reply the Tag posted
from the Task's progress notes, oldest first; an update turn that stayed silent isn't listed.
`GET` and `stream` also accept a work Session's `taskId`,
for the operator whose conversation started it; its stream carries the work Session's activity.

The `stream` route follows the reply as it is written. It answers with Server-Sent Events in the
[AI SDK UI message stream protocol](https://ai-sdk.dev/docs/ai-sdk-ui/stream-protocol) and the
header `x-vercel-ai-ui-message-stream: v1`. Each event is one `data:` line with a JSON part and an
`id:` line numbering it; the last event is `data: [DONE]`.

| Part | Carries |
| --- | --- |
| `start` | The message, with the Task ID as `messageId`. |
| `text-start`, `text-delta`, `text-end` | The Tag's reply text as its harness writes it. |
| `data-activity` | A command or tool call starting and ending, or a retry in a new Task Attempt. |
| `finish` | `messageMetadata.reply`, the final reply with its `presentation` and `text`. |
| `error` | `errorText`, the error that ended the Task. |

- **Resume.** Pass `?resumeAt=N` or a `Last-Event-ID: N` header to receive only the parts after
  part `N` of a running reply.
- **Finished replies.** When the Task has finished, or has no running stream, the route sends the
  stored reply as one complete message.
- **Joined messages.** A message that joined a running Task follows that Task's reply from the
  moment it joined.
- **Waiting.** Until the Task starts, the response stays open and sends a comment line every 15
  seconds.

Streamed reply text reaches readers only through this stream; the message record and the Task
result keep the final reply. The Task's events record its command and tool
activity and its result, not each piece of text.

## Tag messaging administration (Experimental)

`/api/v1/tag-messaging/*` manages directional messaging grants, issues and revokes
Tag-scoped mailbox credentials, and inspects message history. These operation endpoints
use the same administrative authentication; they do not expose a declarative Mailbox
resource. Credential issuance returns the new token once. The separate
`/internal/v1/mailbox/*` endpoints accept only Tag mailbox credentials. See the
[complete HTTP contract](../../spec/tag-messaging.md) and [operator guide](../guides/tag-messaging.md).

Team channel inspection and post history use `/api/v1/tag-messaging/workstreams`. Every Team
gets its channel when it is created, so there is no endpoint to create, update, or close one. See
the [Workstream HTTP contract](../../spec/workstreams.md).

Objectives use the experimental [Objective API](../../spec/objectives.md). Tag credentials
can read owned Objectives and those their active Teams serve; only the owner or an
operator may change Objective status. Team membership does not grant messaging rights.

`POST /api/v1/objectives/:id/cancel` cancels an Objective and its open Tasks. It requires the
admin token or an Operator Token, records the caller in the Objective's change history, and accepts
an optional `{"reason": "..."}` body. It returns an `ObjectiveCancellation` resource whose status reports `changed`, `phase`, `cancelledAt`, `reason`,
and `cancelledTaskIds`. Repeating the request returns 200 with `changed: false`; a completed
Objective returns 409. See [Cancelling an Objective](coordination.md#cancelling-an-objective).

## Coordination operations (Experimental)

`POST /api/v1/coordination/:operation` invokes the same bounded Objective, Team, Task, Mailbox,
Team channel, and Tag primitives available to an authorized manager. Operators may use separate
bearer credentials whose configured action, Objective, and Team scopes are checked before the
operation runs.

Administrative `read_objective` adds a budget projection to the canonical Objective and each visible Task.
It keeps organizational limits, reservations, and charges separate from per-Task Attempt provider
ceilings and observed costs. Provider amounts are grouped by currency without conversion; missing,
running, partial, or mismatched evidence remains explicit. Objective-wide provider coverage is
labeled as applying to visible Tasks, so a Team-scoped caller cannot mistake hidden work for covered
spend. `read_task` exposes the same evidence for one visible Task.

Execution-time `read_objective` instead returns a bounded discovery summary, with `limit` and
`offset`, independent per-collection page metadata, abbreviated instructions, and lossless paginated
Objective definition text. Full results and provider evidence remain in `read_task`. This prevents
large organizational histories from overflowing model tool responses. See
[Discovery view for agents](coordination.md#discovery-view-for-agents).

`GET /api/v1/coordination/inbox` projects pending Task approvals, reviews, and approval requests
without introducing separate workflow resources; `kind=approval` selects approval requests. Each
page includes `tagNames` for its Tag decision makers. The API returns the full view; the CLI
filters `supertag list inbox` to operator decisions unless `--all` is set. See
[Operator inbox](coordination.md#operator-inbox). `GET /api/v1/coordination/teams/:id/history?objectiveId=...` returns
the Team's append-only changed-field deltas and Tag, operator, Task, and Mailbox provenance. The CLI
exposes these reads through `supertag list inbox` and `supertag events team`.

`GET /api/v1/coordination/approvals` lists approval requests, and
`POST /api/v1/coordination/approvals/:id/approve` or `/deny` decides one. The CLI exposes them as
`supertag list approval`, `supertag approve request`, and `supertag deny request`. See
[Approval requests](coordination.md#approval-requests).

`POST /api/v1/coordination/objectives/:id/messages` sends an operator message to the Objective
owner with `{message, reopen?, idempotencyKey?}`. It requires `send_message` and access to that
Objective. `POST /api/v1/coordination/objectives/:id/approve` with `{}` completes a
`ready_for_review` Objective and requires `update_objective`. Team-scoped credentials cannot use
either. The CLI exposes them as `supertag message objective` and `supertag approve objective`. See
[Operator messages and review](coordination.md#operator-messages-and-review).

`GET /api/v1/coordination/objectives/:id/overview` provides an operator view of progress,
recorded blockers, performance summaries, and exact Task/Task Attempt/artifact/review references.
It requires `read_objective` and access to that Objective; Team-scoped credentials are rejected
because ownership and allocation data are Objective-wide. No new MCP tool or write action is added.
Optional query parameters are `teamId`, `limit` (1–100, default 50), and `offset` (default 0).
Unknown or repeated parameters are rejected. A Team filter selects exact Team membership, not its
descendants, and does not grant access to additional records.

The response includes `projectionVersion`, `capturedAt`, `objective`, `conditions`, `attention`,
`approvals`, `performance`, `teams`, `allocation`, `pageUsage`, `tasks`, `total`, `offset`, and
`nextOffset`. `conditions` holds one `Runnable` condition, `{type, status, reasons}`; see
[Runnable](coordination.md#runnable). Without a Team filter, `conversation` lists the latest 50
messages between the operator and the owner, oldest first. Each entry is
`{id, from, tagId, text, createdAt}`; `from` is `owner` or `operator`. An owner message also has
`status`, `pending` until the operator replies, and an operator message has `operatorId`.
`approvals` counts pending requests and those approved or denied in the last 24 hours; pending
requests also add an `approvals_pending` attention item. Counts cover all
filtered assignments; execution detail and provider usage cover only the Task page. Usage coverage
lists missing Task Attempt reports explicitly. These are observations across durable records, not a
transactional snapshot or a dispatch guarantee. Existing write operations still require their own
authority and status/revision fences. See [Overview fields](coordination.md#overview-fields)
for metric definitions and limitations.

### Read a Task's progress

A Task is one assignment for a Tag. An execution Task Attempt records a particular Worker
run of that Task. Use `supertag get task ID` for the JSON resource or `supertag describe task ID`
for a readable summary. `supertag events task ID` shows its stored event history.

Task reads include the existing `apiVersion`, `kind`, `metadata`, `spec`, and `status` envelope.
The status adds these observations when records exist:

- `assignment`: the Team and Objective, assignment phase, approval, priority, dependencies,
  earliest eligible time, execution lease expiry, and registered wait conditions. These conditions
  record what the manager requested; they do not imply a fresh scheduler decision.
- `attempt`: the latest Task Attempt, its Worker Profile, recorded Worker/Host/Worklet identities,
  last event, execution placement, and the recorded failure message when its latest terminal event
  failed. Error stacks and additional error fields are omitted; messages retain the Worker's event
  redaction. A new Task Attempt does not inherit an earlier error. The harness runtime hosts the agent process; the tool
  execution environment receives its workspace operations. They may be on different machines.
- `scheduling`: the last stored scheduling check, its time, and unmet requirements. `status` is
  `compatible`, `incompatible`, or `waiting`. A `waiting` check carries `wait`: `reason` is
  `capacity` with `hosts` (each `workerHostId`, `harnesses`, `capacity`, and `busyTaskIds`), or
  `unavailable` when no eligible host has a matching Worker connected. A later check supersedes an
  earlier one. Describe shows this only for queued work.

These reads use stored evidence and do not contact a Worklet. Unknown host identity is shown as
“not recorded”; it is never inferred from another Worker's current advertisement. Missing terminal
execution evidence does not prove a process stopped. A pending Task without a scheduling diagnosis
is not automatically classified as a capacity or connectivity problem. For a receipt from the
execution owner, use the separate execution inspection below.

The resource version changes when these observations change, even if the Task's phase does not.
`get` and `watch` keep JSON output; `describe task ID` presents the summary in plain text.

### Inspect the latest Task execution

`GET /api/v1/tasks/:id/execution` returns `availability` (`available`, `unavailable`,
`unsupported`, or `not_started`) and the latest `attemptId` when present. An available response
includes the durable Worklet receipt, status, and last event sequence.

Every response also includes a `limits` projection. It reports the Task's requested limits, the
effective controls recorded by the harness in `execution.limits.applied`, the latest cumulative
usage report, peak observed native children, evidence completeness, and an explicit outcome. A
`threshold_reached` outcome is derived only from an applied numeric ceiling and durable numeric
usage or native-agent observations. Missing or incomplete evidence produces `pending` or
`unknown`; terminal error text is never treated as proof that a limit was enforced. The projection
therefore remains available after Control Plane recovery or while its Worklet is disconnected, even
when the optional receipt is unavailable. Applied methods currently distinguish provider-native
agent controls, harness guards, interrupt-on-report token controls, and provider budget controls.

Every response also includes a `placement` projection built from the latest durable Runtime Input
Manifest. It reports whether the harness runtime and workspace execution environment were
`colocated` or `split`, then identifies each access by ID, provider, and placement. Environment
guarantees and credential-free provider provenance are included when available. Shared execution
provenance identifies the environment incarnation, per-Task Attempt access, and expiry without exposing
its bearer token. Missing evidence remains `pending` for a running Task Attempt and `unknown` after a
terminal Task Attempt. This projection also survives Control Plane recovery and does not depend on a
connected Worklet.

The placement projection also reports `cleanup`. A Worker emits its terminal execution event only
after closing the harness execution and both environment accesses. `confirmed` therefore means
that durable terminal event was observed. A running Task Attempt normally remains `pending`; a terminal
Task Attempt without the event remains `unknown`. A recorded cleanup failure also makes cleanup
`unknown`, even while the stored Task Attempt phase is still `running`. The phase alone does not tell
you whether a process is currently executing.

`placement.cleanupFailure` contains the latest Task Attempt's retained cleanup diagnostic, or `null`.
It includes the event sequence and time plus bounded, redacted error messages identifying failed
cleanup stages. When execution failed before cleanup also failed, the diagnostic preserves the
original execution error too. A later terminal execution event clears this diagnostic from the
current projection; the full event history remains available. Prior Task Attempts' errors and ordinary
model progress are not included.

For durable execution, the recorded Worker Host, Worklet, and Worker identities come from
acceptance or recovery receipts. A requested Worker Profile is a capacity requirement, not a
selected host. Before a confirmed receipt identifies the selected host, these fields remain
unrecorded. An unknown receipt cannot establish a new host binding, and an existing binding
cannot silently change during recovery. Older records may contain a placeholder or an
aggregate Worklet descriptor captured before receipt-based recording was available. Those
values are unconfirmed provenance; they are not rewritten into a confirmed binding when a
receipt conflicts with them. The identity mismatch remains an error requiring inspection.

The same projection appears at `status.attempt.placement` in the Task resource.
`supertag describe task ID` distinguishes a waiting assignment from confirmed cleanup and prints retained cleanup
errors. These are stored observations, not a live health check of the Worker Host.

This is an authenticated operator read; it neither retries execution nor changes Task state. The
CLI exposes it through `supertag describe task ID`.

## Artifact inspection

An **artifact** is a captured result with an immutable file manifest. These administrative reads
use the same operator authentication as Task inspection:

| Route | Result |
| --- | --- |
| `GET /api/v1/artifacts?task=ID&limit=20&cursor=CURSOR` | Captured artifacts, with an optional Task filter and a next-page cursor. Limit is 1–100. |
| `GET /api/v1/artifacts/:id` | One artifact manifest, including file paths, digests, sizes, and source Task. |
| `POST /api/v1/artifacts/:id/download` | Where one file can be read, for body `{ "path": PATH }`. Never file content. |

These routes need the admin token or an Operator Token; a coordination-only credential is refused.
Each Artifact's `status.locations` lists where its copies are: `worker-host` entries with
`workerHostId`, `ephemeral`, and `removed`, and `volume` entries with the Volume's name.
`status.ephemeralOnly` is true when some file is held only on ephemeral Worker Hosts and no Volume.

The Control Plane stores no artifact bytes, so no route returns file content. The bytes stay on the
Worker Hosts and Volumes that hold copies. The download route returns the file's digest and size,
the Volume copies with each Volume's source, credential name, and key, and the producing Worker
Host's transfer URL with a signed grant. The grant is bound to that file, that host, and the
requesting operator, and expires after 60 seconds. `holders` lists every Worker Host and Volume
that holds the file. The caller reads a Volume copy with its own mapping for the credential name and
must check the digest. Tasks consume artifacts through exact artifact inputs, preserving the
existing Worker-to-Worker transfer permissions.

See the [CLI walkthrough](../operations/cli.md) for listing results without writing an API client.

## Session persistence

A **Session** groups Tasks from one conversation and owns its stored native conversation state.
For example, a conversation started with Codex on one Worker Host can continue on another host
that can restore its native files and provide compatible tools and workspace access. Claude Code
uses its SDK's Session storage callbacks to preserve main and subagent transcript entries.
Conversation storage does not restore workspace files, running processes, or a sandbox.

Use the administrative API to inspect stored state:

| Request | Response |
| --- | --- |
| `GET /api/v1/sessions/:id/states` | A `states` array, newest first, containing up to 100 metadata records and each record's `nativeId`; transcript payloads are omitted. Add `?nativeId=...` to select a native conversation. |
| `GET /api/v1/sessions/:id/states/:stateId` | The matching record, including its native `data` payload. A state belonging to another Session returns 404. |

Both requests require the administrative bearer credential and return `Cache-Control: no-store`.
Native IDs identify a Codex thread or Claude conversation; the SuperTag Session ID groups the
work across these native conversations. The API retrieves stored state rather than starting an
execution. Continue the conversation through its existing Session; the Control Plane selects a
compatible resume point when admitting the next Task.

A record's `status` is `stored` while its native data is available but has not been approved for
automatic resumption. Successful execution can promote it to `resumable`. A partially synchronized
or failed Task Attempt can therefore remain inspectable without becoming a resume point. Even a
`resumable` record resumes only for the same Tag and Session, the same reply audience, and the
harness that produced it, and that harness must be able to load it where it runs; a newer
execution without eligible state blocks fallback to older native state. Native transcripts are
private Session data and are not discoverable through the artifact catalog or exposed as a new
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

### Continuing Objectives and operator attention

An Objective defines an outcome and its success criteria. Creation accepts `ongoing: true` for a
continuing responsibility that only an operator may mark completed. The default is `false`; its
owner may complete it after assessing the criteria and settling outstanding Tasks. This choice is
independent of `observations`, which select Team channels for new-evidence delivery.

The coordination inbox accepts `kind=task_attention`. These metadata-only entries identify failed
observation assessments or owner Tasks with no scheduled continuation or usable observation
subscription. Their `reason` explains why inspection is needed; `permittedActions` is empty because
recovery depends on the result and possible external effects. Reading an entry does not resolve it.
An entry for an uncertain Task Attempt also carries `uncertainAttempt` (`attemptId`, `workerHostId`,
`workerId`), and its first `commands` entry is the `supertag recover worklet` command for it. A
Task's assignment shows the same record as `uncertainAttempt`, with `attemptNumber`, `detectedAt`,
and `reason`; it is null unless the running Task's current Task Attempt is uncertain. See
[Uncertain Task Attempts](scheduling-and-recovery.md#uncertain-task-attempts).

Observation batches, receipts, and the task-attention inbox are described in
[Observation delivery](coordination.md#observation-delivery).

### Objective allocation recovery and wait explanations

Administrative `update_objective` accepts an optional nonnegative integer `budgetLimitMinor` with
`expectedRevision`. It must increase an active Objective's finite limit and cover charged plus
reserved allocation; it cannot remove a limit or change its currency. Agent callers are rejected.
The existing resource-change history records the operator and old/new values atomically.

Administrative `update_objective` also accepts `deadline`, an ISO timestamp, with
`expectedRevision`. It may replace a deadline that already passed, and the change is audited the
same way. Agent callers that send `deadline` receive 403. The same rules apply to the
administrative `PATCH /api/v1/tag-messaging/objectives/:id` route.

The Objective's read-only `limitState` records the Control Plane's limit observations: the
reported spend of a monetary budget, the 80% warning, exhaustion, deadline warnings, and deadline
passage. Each entry names the limit or deadline it was observed against, so entries for an old
limit stop applying after a change. The rules are in
[Monetary budgets](coordination.md#monetary-budgets) and [Deadlines](coordination.md#deadlines).

The inbox accepts `kind=objective_limit`. Each item carries the event in `reason`, an `objective`
evidence entry, and an `update_objective` action that requires `budgetLimitMinor` or `deadline`.
For an approaching deadline, `reason` calculates the time left when the inbox is read. For
example, a warning created an hour before the deadline says about 27 minutes left when read
27 minutes before it. After the deadline, it says the deadline has passed.
Configured Gateway notices are sent once per item and are revalidated before delivery.

Operator inbox projection version 5 includes `objective_budget` with an `update_objective` action
and `operator_message` with a correlated `send_message` reply. Version 6 adds the `approval` kind
and each item's `commands`. Version 7 adds the `mcp_login` kind. Older cursors must be refreshed.
An `mcp_login` item marks a queued Task held because its Worker Host's login to an MCP server
lapsed. Its key is `mcp_login:TASK_ID:SERVER`. It is an operator decision, so
`supertag list inbox` shows it without `--all`. Its `commands` are `supertag mcp login SERVER`,
then `supertag describe objective ID`. See
[MCP OAuth login](supertag-yaml.md#mcp-oauth-login).
The `objective_budget` item represents blocked observation admission, not a failed execution.
Configured Gateway notices are deduplicated and revalidated before delivery.

For allocation fields and charging, see
[Budgets and allocation](coordination.md#budgets-and-allocation). For who may answer and what a
reply changes, see [Operator decisions](coordination.md#operator-decisions).

`wait_for` accepts optional `reason` (1–2,000 characters). This self-reported explanation persists
in `waitState`, including after resumption. `read_task` returns selected input metadata, an
`inputPage` (default 20, `limit` 1–100, nonnegative `offset`), and authorized requester and Team
channel routes. `sharedWorkstreamsTruncated` marks a bounded discovery list; absence there is not
proof that no other visible channel exists. These views grant no new authority.

`escalate_task` is available only to a running Task Attempt; operator calls receive 403. It takes
`effort`, `model`, or both, and a required `reason` (1–2,000 characters). A value outside the
Tag's range returns 400 with the allowed values; a request that changes nothing, a third
escalation of one Task, or a non-durable Task Attempt returns 409. A successful call stores
`waitState.escalation`, and the next activation's wake reason is `escalated`. The Task's events
gain a `task.self-escalated` entry, and the Objective overview lists `selfEscalations` per Task.
See [Self-escalation](coordination.md#self-escalation).

`list_tags` is available to the Objective owner, Team leads, and operators; other Task Attempts
receive 403. It takes optional `limit` (1–100, default 100) and `offset`, and returns
`{tags, total, nextOffset}` as defined by
[tag-directory.schema.json](../../spec/tag-directory.schema.json). `create_team`, `update_team`,
`assign_task`, and `send_message` accept a Tag name wherever they take a Tag ID. See
[Read tools](coordination.md#read-tools).

### Objective operator messages

`send_message` with `recipientObjectiveId` stores an operator message from the active Objective
owner, using `type: "message"` or `"progress.updated"` and `body.message` (1–8,000 characters).
Set `needsReply: false` to post a report without requesting an operator reply. Reports remain in
the Objective conversation and watch timeline, but stay out of the operator decision inbox.
The message remains durable if external notification delivery is unavailable. Request retries with
the same Objective, sender, key, and content return the original message; different content conflicts.
Each Objective admits at most 100 unanswered questions.

The `operator_message` inbox item carries message identity and source metadata. For an operator
allowed `read_objective` or `read_mailbox` without a Team scope, it also carries `message`:
`{text, createdAt, truncated}`. `text` holds at most 500 characters; `truncated` is true when the
stored message is longer, and `redaction.omitted` then still lists `body`. Other operators receive
metadata only. To read a full message, an Objective-scoped operator (or the current owner) uses
`read_mailbox` with `recipientObjectiveId` and optional `messageId`. Lists accept `limit` (1–100) and `after` (`createdAt`, `id`);
`nextAfter` indicates another page may exist. Ordinary Tag mailbox reads are unchanged.

An operator replies through `send_message` using `recipientTagId` set to the current owner,
`inReplyTo` set to the operator message ID, `type: "message"`, `body.message`, and an idempotency key.
Recording the attributed reply and resolving the operator inbox item is one transaction. Only one
reply wins; identical retries are idempotent. The reply's trusted `operatorId` is preserved over
HTTP and gRPC. An agent cannot set this attribution or resolve its own operator request.

`POST /api/v1/coordination/objectives/:id/messages` is the simpler route. It answers the most
recent unanswered operator message automatically, or sends an unsolicited operator message when
none is pending. The response is `{message, duplicate, repliedToMessageId, objective, statusChange,
guidance}`. The same `idempotencyKey` with the same text returns the original delivery; the CLI
generates a new key for each command.

A reply does not mutate a budget, permissions, or any other resource. Apply an authorized update
first when required. The current owner receives the reply through normal Mailbox scheduling and
can resume an existing Mailbox wait. Pending requests survive restart; delivery retries do not
create another request. Changing the external destination does not change who may answer.
