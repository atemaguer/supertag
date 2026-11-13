# Control Plane operations

A **Tag** is a persistent AI actor with its own responsibilities and permissions, and Tags work
in Teams. Together, your Teams of Tags make up an **autonomous organization**: Teams
may pursue different goals but share one set of rules and one record of the work. The **Control
Plane** is the service that stores and coordinates the organization, applies policy, and schedules
work. If it is unavailable, SuperTag cannot accept new requests, send work to execution systems, or
deliver replies. Use PostgreSQL for production deployments. SQLite is intended for local development
and evaluation with one Control Plane process.

This page uses these terms:

- A **Worker Host** is a machine, container, VM, or sandbox that provides execution capacity. A
  **Worklet** connects it to the Control Plane. A **Worker** on it completes work through a
  **harness**, the connection to an agent system such as Codex or Claude Code.
- An **Auth Key** is a secret that lets a machine join as a Worker Host. A **Volume** is a named
  storage location, such as a bucket prefix or a directory on a Worker Host.
- A **Role** is an
  enduring responsibility assigned to a Tag.
- A **Team** is a flat list of member Tags. A Tag's **Mailbox** is its inbox for messages from
  other Tags.
- An **Objective** is an outcome a Tag owns, with success criteria, a budget, and a deadline.
- A **Session** is one Tag's thread of work. A **Task** is one turn of a Session, and a
  **Task Attempt** is one execution or retry of a Task.

Its **API Server** (management and Worklet requests) and **Gateway** (collaboration-surface
transport) share one process, deployment, and HTTP listener, so there is no separate service to
operate; see [How SuperTag fits together](../concepts/how-it-works.md).

Start with [Self-host SuperTag](../guides/self-hosting.md) if you have not deployed it yet. This page is the operator reference.
For a missing first reply, begin with the shorter [troubleshooting checklist](../guides/troubleshooting.md).

## State and configuration

| Variable | Purpose | Default |
| --- | --- | --- |
| `SUPERTAG_STATE_DIR` | Local credentials and default SQLite location | `~/.supertag` |
| `SUPERTAG_DATABASE_URL` | `file:`, `postgresql:`, or `postgres:` database URL | `file:$SUPERTAG_STATE_DIR/supertag.db` |
| `SUPERTAG_ADMIN_TOKEN` | Enables authenticated CLI management over HTTPS; its holder issues [Operator Tokens](#give-teammates-operator-tokens) | remote management disabled |
| `SUPERTAG_OPERATOR_NOTIFICATION_TASK_ID` | Existing verified surface Task used as the default operator notification destination | unset |
| `SUPERTAG_OPERATOR_CHANNEL` | Slack channel or user that receives new inbox items: `slack:ID` or `slack:WORKSPACE_ID/ID`; see [Operator channel](#operator-channel) | off |
| `SUPERTAG_COORDINATION_OPERATORS_FILE` | JSON file of attributable, scoped coordination credentials | no scoped operators |
| `SUPERTAG_WORKLET_TRANSPORT` | `embedded` smoke-test responder or `remote` Worklet connection | `embedded` |
| `SUPERTAG_WORKLET_GRPC_PORT` | Additional API Server gRPC listener when remote Worklets are enabled | disabled |
| `SUPERTAG_WORKLET_GRPC_TLS_CERT_FILE` / `SUPERTAG_WORKLET_GRPC_TLS_KEY_FILE` | TLS files for the gRPC listener; required outside loopback | unset |

`supertag start control-plane` reads only these environment variables. `supertag up` also reads
`supertag.yaml`, and environment variables override it; see
[Environment and supertag.yaml](#environment-and-supertagyaml).

Keep `SUPERTAG_STATE_DIR` on persistent storage with mode `0700`. The default local providers share a lock-protected `credentials.json`, written atomically with mode `0600`; Control Plane collaboration surface credentials and CLI operator credentials occupy separate namespaces. Database records contain provider-neutral logical credential IDs, not collaboration surface values or physical vault locations. An external vault implementation may keep no collaboration surface credential material in this directory.

### Environment and supertag.yaml

There are two ways to run a Control Plane, and they read settings differently:

| Command | Reads | Use for |
| --- | --- | --- |
| `supertag up` | A `control-plane` service in [`supertag.yaml`](../reference/supertag-yaml.md), then the environment | A computer or server you manage by hand, containers, and platform deployments |
| `supertag start control-plane` | The environment only, never `supertag.yaml` | Scripts that start a bare Control Plane |

The container image runs `supertag up --foreground control-plane`. Without a `supertag.yaml`, it
reads the environment just as `supertag start control-plane` does; see
[In containers and hosting platforms](../reference/supertag-yaml.md#in-containers-and-hosting-platforms).
With a file, its `provision` list creates missing resources after the Control Plane becomes healthy.
A provisioning error stops the container command so the platform can report the failed startup.

For `supertag up`, values come from flags first, then environment variables, then the files in
`-f` order, then defaults. An environment variable comes from the process environment, or else
from `env_file`. It overrides the matching key, and `supertag config` marks each such value with a
`# from VAR` comment:

| Environment variable | `control-plane` key |
| --- | --- |
| `SUPERTAG_GATEWAY_HOST` | The address in `ports`; the container image sets `0.0.0.0` |
| `SUPERTAG_GATEWAY_PORT` | The port in `ports` |
| `PORT`, only with `SUPERTAG_DEPLOYMENT_PLATFORM` set | The port in `ports`, unless `SUPERTAG_GATEWAY_PORT` is set |
| `SUPERTAG_COORDINATION_URL` | `url` |
| `SUPERTAG_DATABASE_URL` | `database.url` |
| `PGPASSWORD`, when already set | `database.password` |
| `SUPERTAG_CREDENTIAL_VAULT`, `SUPERTAG_VAULT_MOUNT`, `SUPERTAG_VAULT_PATH_PREFIX` | `credentials` |
| `SUPERTAG_OPERATOR_CHANNEL` | `notify` |
| `SUPERTAG_RPC_TRACE=1` | `logging.level: trace` |
| `SUPERTAG_WORKLET_GRPC_PORT` | `hosts.grpc` |
| `SUPERTAG_WORKLET_GRPC_TLS_CERT_FILE`, `SUPERTAG_WORKLET_GRPC_TLS_KEY_FILE` | `tls.cert`, `tls.key` |
| `SUPERTAG_WORKLET_TLS_CA_FILE` | `tls.ca` |
| `SUPERTAG_COORDINATION_OPERATORS_FILE` | `operators.file` |

Some settings have no key and stay in the environment: `SUPERTAG_ADMIN_TOKEN`,
`SUPERTAG_STATE_DIR`, `VAULT_ADDR`, `VAULT_TOKEN`, `VAULT_NAMESPACE`,
and `SUPERTAG_DEPLOYMENT_PLATFORM`. Under `supertag up`, a control-plane service also reads
`SUPERTAG_ADMIN_TOKEN` and the `VAULT_*` variables from `env_file`, which is where a service unit
finds them. When `supertag up` provisions that Control Plane, it uses the same admin token unless
`SUPERTAG_OPERATOR_TOKEN` is set. `SUPERTAG_WORKLET_TRANSPORT=embedded` runs the smoke-test responder under
`supertag up`, and then no host can connect. A host service of a shared Control Plane that
has no `auth-key` and no stored credential joins with `SUPERTAG_AUTH_KEY`.

### Apply migrations

Apply migrations before starting a new release:

```sh
supertag migrate database --check
supertag migrate database
# Container:        docker compose --env-file .env -f deploy/compose.yaml run --rm migrate
```

`supertag migrate database --check` is read-only and reports the current migration, the release target,
and every pending migration. It exits successfully only when the schema is current, so deployment
automation can use it as a readiness gate. The Control Plane also performs this schema check before it
opens its listener and refuses to start against an uninitialized, stale, newer, or untracked
schema.

The PostgreSQL runner serializes migration processes and bounds both schema-lock acquisition and
statement execution. A timeout leaves the migration transaction unapplied and reports how to
inspect blocking sessions before retrying.

Migrations use `SUPERTAG_DATABASE_URL` and are safe to run again when already current.

## Operator notifications

This section covers where operator alerts go and which inbox kinds exist. To act on a decision,
follow [Respond to budget and operator requests](../guides/objective-decisions.md); the decision
rules are in the [coordination reference](../reference/coordination.md#approval-requests).

### Operator inbox

The operator inbox lists everything that needs a person: pending decisions from stored Tasks and
Objectives, and pending approval requests. Inspect it with
`supertag list inbox --output text`; JSON remains the default output. Each item names the
`supertag` command that acts on it, and shows notification status separately from the decision
itself. `supertag watch inbox` prints each new item on one line as it appears, until you press
Ctrl-C.

Filter with `--kind`:

| Kind | Pending decision |
| --- | --- |
| `approval` | An action marked `approval: required` awaits a decision |
| `question` | An Objective asked you a question with `ask` and waits on the answer |
| `objective-budget` | The Objective's budget pool is used up and admits no further turn |
| `objective-limit` | A monetary budget reached 80% or its limit, or a deadline is 24 hours away, 1 hour away, or passed |
| `task-attention` | A Task failed because its repository's git config changed during the Task Attempt, or a Task Attempt is uncertain and needs `supertag recover worklet` on its Worker Host |
| `mcp-login` | A Task is held until an MCP server is logged in |

An alert requests a decision; it does not approve more spending. Accepted results remain recorded
even when execution runs out of budget.

Approval requests appear only to operators who may list them: the admin token, an Operator Token, or scoped
credentials with the `list_approvals` action. `supertag list approval` keeps the full
request listing for scripts.

### Operator channel

An operator notification alerts you when the inbox gains a decision or urgent item. The local
`supertag up` service uses desktop notifications by default on macOS and Linux. Set `notify` in
`supertag.yaml` to choose desktop, webhook, or Slack destinations. The
[notification setup guide](../guides/notifications.md) shows the configuration and the inbox
delivery status. A headless Control Plane can set one destination through
`SUPERTAG_OPERATOR_CHANNEL`, such as `slack:U0123456789`.

Messages are stored before sending, then retried from the outbox outside request handling. New
items within 60 seconds are summarized; a blocking approval sends immediately. An Objective's
own verified collaboration thread may also carry the item.

### Notification destinations

A notification destination is an existing conversation where a person can receive an alert. SuperTag
addresses that conversation through a Task: the stored record of a request received from a verified
collaboration surface, such as a Slack conversation. Use that Task's ID as the destination; do not
supply a channel name, webhook URL, or credentials.

When work exhausts its execution budget, the Control Plane notifies this destination without
running another agent turn, and the pending decision stays in the operator inbox. It chooses the
surface Task an operator set as the Objective's notification Task first, then the verified surface
Task that originated the Objective, then the deployment default
`SUPERTAG_OPERATOR_NOTIFICATION_TASK_ID`. A notice still waiting for delivery is withdrawn when its
limit changes, the Objective closes, or its destination changes or stops verifying; the operator's
Slack notification destination then reports it instead. In an Objective's notification thread,
`@SuperTag approve`, `@SuperTag pause`, and `@SuperTag resume` act on that Objective.

### Set the deployment default

Add `SUPERTAG_OPERATOR_NOTIFICATION_TASK_ID` to the Control Plane's environment and restart it.
Start every Control Plane replica with the same value. The shared deployment configuration accepts
this optional variable on all supported platforms. The
referenced Task must be one a person's message started in a verified surface conversation; arbitrary Task IDs do not grant
permission to send to a destination. A headless deployment gets such a Task the same way as any
other: a person mentions the Tag once in the operator conversation through a connected
**Surface Account**, an enrolled external workspace or account. Copy that Task's ID from
`supertag list task`.

### Questions from an Objective

An Objective asks a person a question with `ask`. The question posts to the Objective's thread and
appears in **Waiting on you** in the terminal UI. Select the question, type your answer, and
press Enter. You can also reply in the home thread. The answer starts the Objective's next turn
and clears the inbox item.

### Delivery status

If no destination is configured, the inbox explicitly shows `unconfigured`; no external alert was
delivered. Invalid or revoked destinations show a failure instead of silently falling back to a
different conversation. Gateway retries use its durable outbox. Transport delivery is not a human
acknowledgement: the inbox item remains until renewal, cancellation, or the Objective no longer
requires an allocation decision. A confirmed completed Objective does not request additional funds.

## Run it as a service

Installed CLI:

```sh
supertag start control-plane
```

On a machine you manage by hand, `restart: unless-stopped` on the `control-plane` service in
`supertag.yaml` makes `supertag up` install a launchd or systemd unit instead; see
[Service units](../reference/supertag-yaml.md#service-units).

After upgrading or rebuilding the installed CLI, run `supertag up` again. A build identity is a
short digest of the installed code. `up` compares it with the identity each local service recorded
when it started and restarts services whose code changed, even if the release version stayed the
same. A host first stops taking new Task Attempts and waits for running ones to finish.
`supertag up --dry-run` shows the decision without restarting anything. `supertag version` shows
the CLI and reachable Control Plane builds; `supertag ps` shows each running local service's build.

Container: `docker compose --env-file .env -f deploy/compose.yaml up -d control-plane`, as in
[Self-host SuperTag](../guides/self-hosting.md). The container runs
`supertag up --foreground control-plane`, which installs no unit; Compose restarts it.

The Control Plane also persists its coordination signing key in the configured credential vault under
`control-plane/coordination-signing-key`. Preserve that value across restarts so running Task Attempts can
continue using their credentials after lease recovery. Every request still checks the persisted
Task Attempt, lease, deadline, and membership. File and Vault providers create the key atomically;
custom vaults must implement `storeIfAbsent` or preprovision this entry with a `key` value containing
32 random bytes encoded as base64url. Replacing or deleting the key invalidates existing
credentials.

The CLI defaults to a local file credential vault. Set `SUPERTAG_CREDENTIAL_VAULT=vault` to use
HashiCorp Vault KV v2 with `VAULT_ADDR` and `VAULT_TOKEN` supplied through the environment.
`SUPERTAG_VAULT_MOUNT` defaults to `secret`; `SUPERTAG_VAULT_PATH_PREFIX` defaults to `supertag`.
`VAULT_NAMESPACE` selects an optional Enterprise namespace. Unknown providers and missing required
Vault settings fail startup. Selecting Vault does not copy existing file credentials: migrate those
entries, including the coordination signing key, before switching an existing organization.

The Control Plane stores no artifact bytes; Worker Hosts keep them. See
[Artifact storage](#artifact-storage).

Use Docker Compose, systemd, launchd, or another supervisor in an always-on deployment. Configure restart-on-failure and send `SIGTERM` for graceful shutdown. Collaboration surface setup and credential rotation are reconciled while the Control Plane runs; do not restart it for each Task.

## Manage a remote Control Plane

A remote Control Plane accepts three kinds of operator credential:

| Credential | Who holds it | Can |
| --- | --- | --- |
| Admin token, `SUPERTAG_ADMIN_TOKEN` | The deployment's owner, for setup and break-glass work | Everything, including Operator Token management |
| [Operator Token](../reference/resource-model.md#operator-tokens) | One teammate or machine each | Everything except creating, listing, and revoking Operator Tokens |
| Scoped coordination credential | A person or tool limited to some Objectives | Only the named coordination commands |

Each credential records who acted. The admin token acts as `control-plane-break-glass`, an
Operator Token as `token:NAME`, and a scoped credential as its configured `operatorId`.

### Connect the CLI

Set `SUPERTAG_ADMIN_TOKEN` on the Control Plane, then connect the CLI once from the owner's machine:

```sh
export SUPERTAG_OPERATOR_TOKEN="the-admin-token-configured-on-the-control-plane"
supertag connect control-plane https://supertag.example.com
unset SUPERTAG_OPERATOR_TOKEN
```

`connect control-plane` accepts the admin token or an Operator Token. It reads the token from
`SUPERTAG_OPERATOR_TOKEN`, from `SUPERTAG_ADMIN_TOKEN` as before, or from a masked prompt; never
from a flag. It checks the token against the Control Plane before saving it.

The CLI stores a versioned connection document in `~/.supertag/control-planes.json` and the token through its configured operator credential provider. The default file provider uses the `operator` section of mode-`0600` `credentials.json`. Control Planes, operator credentials, and named connections are separate logical entries, allowing a later keychain, OIDC, or hosted provider without changing Control Plane resource APIs. Ordinary `setup` and `tag` commands target the active connection automatically.

A loopback Control Plane generates a local administrative credential when none is configured. The CLI discovers it through the shared `~/.supertag` state directory, so local commands use the same API path without requiring `control-plane connect`. Non-loopback listeners never generate an implicit administrative credential.

Names are optional and useful only when one operator machine controls multiple deployments:

```sh
supertag connect control-plane https://staging.example.com --name staging
supertag list control-plane
supertag use control-plane staging
supertag get control-plane --current
supertag status control-plane

# One command against another configured Control Plane
supertag --control-plane staging list tag
```

For management commands, an arbitrary URL supplied through `--control-plane` or `SUPERTAG_CONTROL_PLANE` never borrows a stored credential; provide `SUPERTAG_OPERATOR_TOKEN` explicitly. This prevents credentials for one deployment from being sent to another host. A Worklet does not use an operator credential. Point it at a separate execution listener with `supertag connect worklet --worklet-url URL`; it authenticates with its Worker Host credential.

Operator credentials authenticate management requests to the API Server. Each remote Worker
Host has a separate enrollment credential that authorizes only that host identity on the Worklet API.
SSH remains an emergency diagnostic path rather than the normal configuration interface. See the
[control-plane model](../reference/control-plane.md) and [Control Plane API](../reference/control-plane-api.md)
for the contracts.

### Give teammates Operator Tokens

Do not share the admin token with teammates. A shared token makes every change look like the same
person, and removing one person means rotating it for everyone. Give each teammate, or each machine,
its own Operator Token instead. The owner creates it with the admin token:

```sh
supertag create operator-token laptop-2
```

The command prints a `stop_` secret once. Send it to the teammate over a private channel. On their
machine, the teammate connects and pastes the secret at the masked prompt:

```sh
supertag connect control-plane https://supertag.example.com
```

From then on, the teammate's commands act as `token:laptop-2`. Approvals, Objective messages, and
Objective reopen, approve, and cancel decisions record that operator ID. To review or end access:

```sh
supertag list operator-token          # name, phase, expiry, last use; never the secret
supertag revoke operator-token laptop-2
```

A token expires 90 days after creation; create a new one under a new name before then. Revoking
refuses the token on its next request, without a restart. A conversation it is following or a
watch it holds ends within 30 seconds.

### Audit log

The audit log answers "who changed what, and did it work?" The Control Plane keeps it in its
database, so it survives restarts and needs no log store. It records one entry for each change an
operator makes:

- applies and deletes: an apply records each resource it applied or failed to apply as
  `resource.apply`, and each apply-set member it pruned as `resource.prune`
- Operator Token and Auth Key creation and revocation
- approval decisions, from `supertag approve request` and `supertag deny request`
- Objective messages, approvals, reopens, pauses, resumes, and cancellation, including `@SuperTag approve` and
  replies in an Objective's Slack or Lark thread
- other management writes, such as Task cancellation and Worker Host credential changes

Each entry names the actor, the action, the target, the time, and the outcome:

```sh
supertag audit --since 2026-10-01T00:00:00Z
```

```text
TIME                      ACTOR           ACTION             TARGET                   OUTCOME
2026-10-01T09:31:12.408Z  token:laptop-2  objective.message  Objective/release-notes  succeeded (200)
2026-10-01T09:30:00.120Z  token:laptop-2  resource.apply     Tag/reviewer             succeeded (200)
```

The actor is `control-plane-break-glass` for the admin token, `token:NAME` for an Operator Token, a
scoped credential's `operatorId`, or `slack:USER` and `lark:USER` for a person in an Objective's
thread. The target is `Kind/NAME` or `Kind/ID`; a failed request records only
the kind, because a name it did not resolve could hold a credential. The outcome is `succeeded` or
`failed`, with the HTTP status when there is one. Entries come newest first. `--actor NAME` keeps one operator's
entries, `--limit N` returns up to 500 (50 by default), and `--output json` prints the entries as
JSON.

Reads, plans such as `supertag diff`, and dry runs are not recorded. An entry never contains a credential, a secret value, a digest, or a
request body, so message text and denial reasons stay out too. Any operator credential except a
scoped coordination credential may read the log.

The Control Plane also writes each entry as one JSON line to one more place. `supertag start
control-plane` writes it to standard error. Under `supertag up`, it goes to the service log, or to
the file `logging.audit` names in `supertag.yaml`:

```json
{"type":"supertag.audit","at":"2026-10-01T09:30:00.120Z","actor":"token:laptop-2","action":"resource.apply","target":"Tag/reviewer","outcome":"succeeded","status":200,"source":"api","method":"POST","path":"/supertag.operator.v1.ResourceService/ApplyManifests","id":"5f0c…"}
```

`path` is the RPC's procedure, such as `/supertag.operator.v1.HostService/DrainWorkerHost`. A
request the Control Plane doesn't recognize is refused and not recorded, so a credential pasted
into a URL never reaches the log. A failure to write the line or the
entry is reported on standard error and never fails the change itself, even when the report fails
too.

### Scoped coordination credentials

For tools or people who should reach only some Objectives, configure scoped coordination
credentials. Unlike Operator Tokens, they are static: the Control Plane reads the JSON array named by
`SUPERTAG_COORDINATION_OPERATORS_FILE` at startup, so changes need a restart. Keep that file in the
deployment's secret store. Identity and scope come only from this server-side mapping. Request
headers and command bodies cannot choose an operator ID or expand its access.

```json
[
  {
    "token": "secret-issued-to-release-coordinator",
    "operatorId": "release-coordinator",
    "actions": ["read_coordination_inbox", "read_objective", "update_objective", "watch_events"],
    "objectiveIds": ["objective-release"],
    "revoked": false
  }
]
```

`actions` contains exact operator action names; `read_coordination_inbox` grants the inbox.
`list_approvals` and `decide_approval` let an operator list and decide approval requests, and
`watch_events` lets it follow changes with `supertag watch inbox` and `supertag watch objective`.
For a scoped credential, `update_objective` grants only `ApproveObjective`: `supertag approve
objective` for an Objective submitted for review. A credential takes `token`,
`operatorId`, `actions`, `objectiveIds` and `revoked`; any other field makes the Control Plane
refuse to start. Omit `objectiveIds` only when the operator should reach every Objective. Set
`revoked` to `true` and restart the
Control Plane to refuse an issued token while retaining its configuration record. A scoped token
can call only the operator RPCs that accept scoped credentials: every `InboxService` RPC,
`ObjectiveService.GetObjective`, `DescribeObjective`, `MessageObjective` and `ApproveObjective`, and
`EventService.Watch`. Each also needs the RPC's action, and reaches only the Objectives the scope
names. The Control Plane refuses scoped tokens on every other RPC. The CLI
uses the credential saved by `supertag connect control-plane`, so `supertag list inbox`,
`supertag approve request`, `supertag describe objective` and the other commands those RPCs serve
work with a scoped token. See [Operator RPCs](../reference/control-plane-api.md#operator-rpcs-experimental).

## Health and readiness

```text
GET /healthz   process liveness
GET /readyz    admission, surface, and Worklet readiness
GET /health    compatibility alias for liveness
```

- `/healthz` returns success once the HTTP process is alive.
- `supertag up` checks `/healthz` up to three times with short backoff. A busy Control Plane can
  miss one check without making `up` report a healthy service as unavailable.
- `/readyz` returns success only while the Control Plane accepts admissions, Objective coordination is activated, collaboration surface supervision has no errors, and a remote Worklet is connected when required. Its `objectives` field distinguishes `ready`, `awaiting-coordination`, `awaiting-worklet`, and `stopped`. Readiness does not guarantee an available Worker slot.
- A live but unready Control Plane should remain running while the operator restores its collaboration surface or Worklet dependency.

Compose example:

```sh
curl --fail http://127.0.0.1:3434/healthz
curl --fail http://127.0.0.1:3434/readyz
docker compose --env-file .env -f deploy/compose.yaml ps
docker compose --env-file .env -f deploy/compose.yaml logs --tail=200 control-plane
```

Authenticated HTTP collaboration ingress uses:

```text
POST /webhooks/slack/:externalAccountId
POST /webhooks/github/:externalAccountId
POST /webhooks/linear
POST /webhooks/teams/:externalAccountId
```

Expose only the paths required by configured HTTP collaboration surfaces. Socket Mode Slack and Lark/Feishu long connections need no public webhook path.

## Observe and verify internal RPC traffic

An **RPC** is a request between SuperTag processes. The API Server's gRPC listener carries
Worker Host control traffic and internal resource operations. It has its own TLS/HTTP2 route;
a successful management health check does not prove that this route works.

Verify both routes after configuring the listener and its certificate:

```sh
supertag verify deployment https://control.example.com \
  --grpc-url https://control.example.com:8443 \
  --env-file .env.deployment
```

For a private certificate authority, set `SUPERTAG_WORKLET_TLS_CA_FILE` on the machine running
verification. The probe uses a deliberately invalid execution credential and requires a gRPC
authentication rejection. It never sends the administrative token to the RPC listener. It checks
routing and TLS, not authenticated host registration or long-lived stream stability.

`OrganizationService.GetMetrics` reports `rpc`: call counts, duration buckets, active streams,
connection counts, Worklet queue pressure and closure codes for the API Server process that answered.
See [Metrics](../reference/operator-api/organization.md#getmetrics) for reset and duration semantics. Watch changes
over time: increasing queue rejection counts, persistent errors or repeated connection closures
are reasons to inspect capacity, networking and credentials. Choose alert thresholds from your
workload's measured baseline.

Set `SUPERTAG_RPC_TRACE=1` on the Control Plane to emit structured `supertag.rpc` lifecycle events
to stderr. Events contain the service, method, start/finish time, gRPC status and duration. They
omit payloads, credentials and resource identifiers. Slow or failing sinks can drop events;
`traceErrors` exposes those drops. These are process-local lifecycle logs, not correlated distributed
traces. Leave them disabled when counters are sufficient.

For a custom gRPC server, pass `new RpcTelemetry({ onEvent })` as its `telemetry` option and read
`snapshot()` for your exporter. Import it from `supertag-ai/transport`. A standalone shared execution
service accepts the same option; its observations belong to that service and are not automatically
aggregated by the Control Plane.

## Durability and recovery

The Control Plane commits an inbound event before acknowledging the provider. Dispatch uses leases; results and outbound replies use durable records. Worker failures and provider-delivery failures retry independently. Expired claims recover after a process or Worklet failure.

Delivery is at least once. A crash after a provider accepts a reply but before SuperTag records delivery can produce a duplicate.

Shutdown first fences new Control Plane management requests and new Gateway collaboration surface ingress. The
Gateway keeps its shared HTTP listener attached so health checks remain responsive and rejected
requests receive an explicit `503` instead of hanging. Active Gateway requests drain while
persistence remains connected.

The Worklet transport and authenticated internal APIs remain available while accepted surface Tasks
finish. Active Objective executions are interrupted after their durable state is preserved; their
leases and unclaimed work are recovered when the supervisor restarts the Control Plane. After the
surface-Task drain completes, shutdown fences internal APIs, closes Worklet connections, disconnects
persistence, and closes the shared listener.

For how the Control Plane picks a Worker Host and recovers interrupted Task Attempts, see
[Scheduling and interrupted execution](../reference/scheduling-and-recovery.md).

## Artifact storage

An artifact is saved output from a Task, such as a report or a binary file. The Control Plane
keeps only its catalog: identity, provenance, access rules, and which Worker Hosts or Volumes hold
each copy.
It never receives, relays, or stores artifact bytes, so it needs no artifact directory or bucket.
How transfers, verification, limits, and durability work is described in
[Artifacts: storage and limits](../reference/artifacts.md#storage-and-limits); this section covers
operator concerns.

Every Worklet, including the host services that `supertag up` starts, stores the artifacts its
Tasks capture under its Worker Host's `SUPERTAG_STATE_DIR/artifacts` (by default
`~/.supertag/artifacts` on that Worker Host), outside harness and execution workspaces. It serves
them to other Worklets only when a reachable transfer endpoint is configured. A default loopback
Worklet advertises no endpoint to other machines; the
[Worker guide](../guides/workers.md#keep-artifacts-on-worker-hosts) lists the listener and
advertised URL options. Persist and protect this directory when the Worklet runs in a container.
A Worker Host with an [artifact Volume](../guides/workers.md#3-store-artifacts-on-a-volume) stores
its copies there instead. Each producing Task Attempt has a separate namespace on that Volume.
The catalog checks that Task Attempt's host before recording the copy. That Volume's credential
stays on the host; the Control Plane has none.

An ephemeral Worker Host has no persistent state: `connect worklet` warns when one would hold the
only copy of artifacts. See [storage durability](../reference/resource-model.md#storage-durability).
`supertag describe task` and `supertag list artifact` show which Worker Hosts or Volumes hold each
copy. `supertag download artifact` reads from a Volume or serving host this machine can reach. SuperTag does not replicate
copies between hosts automatically, so back up the state directory of each Worker Host whose copies
you need, along with the catalog database.

Each serving Worklet needs a transfer URL reachable by the consuming Worklets. Put that endpoint on
a private network or authenticated tunnel and use TLS outside a trusted local network. The catalog
location is an availability hint, not permission; a stale location falls back to another permitted
copy or an explicit unavailable result, and never widens access.

## Back up PostgreSQL deployments

Back up both the relational database and the configured Control Plane credential vault. With the default local vault, store the two artifacts together in encrypted storage.

```sh
mkdir -p backups
chmod 700 backups

docker compose --env-file .env -f deploy/compose.yaml exec -T postgres \
  pg_dump -U supertag -d supertag -Fc > backups/supertag.dump

docker compose --env-file .env -f deploy/compose.yaml cp \
  control-plane:/var/lib/supertag/credentials.json \
  backups/credentials.json
chmod 600 backups/supertag.dump backups/credentials.json
```

Test restores on a separate deployment. To restore an existing local-vault deployment, stop the Control Plane first, restore PostgreSQL with `pg_restore`, restore `credentials.json` with mode `0600`, run migrations, and only then start the Control Plane and Worker. For an external vault, follow that provider's backup and recovery procedure and preserve the logical credential IDs. A database without its matching vault values retains configuration but cannot authenticate collaboration surfaces.

## Back up local SQLite environments

SQLite is not the recommended production store. If a local SQLite environment contains state worth preserving, use SQLite's online backup command instead of copying a live database file:

```sh
mkdir -p /secure/backups
chmod 700 /secure/backups
sqlite3 /var/lib/supertag/supertag.db \
  ".backup '/secure/backups/supertag.db'"
cp /var/lib/supertag/credentials.json /secure/backups/credentials.json
chmod 600 /secure/backups/supertag.db /secure/backups/credentials.json
```

Restore both files while the Control Plane is stopped, then run `supertag migrate database` before restarting it. External-vault deployments restore the vault through their provider instead.

## Upgrade a Compose deployment

Create a backup first, then build the release:

```sh
git pull --ff-only
docker compose --env-file .env -f deploy/compose.yaml build --pull
```

Run the migration, then verify the schema before starting the new Control Plane:

```sh
docker compose --env-file .env -f deploy/compose.yaml run --rm migrate
docker compose --env-file .env -f deploy/compose.yaml run --rm migrate node dist/index.js migrate --check
docker compose --env-file .env -f deploy/compose.yaml up -d --remove-orphans control-plane
curl --fail http://127.0.0.1:3434/healthz
curl --fail http://127.0.0.1:3434/readyz
```

The Control Plane and Worklet transport must be protocol-compatible. The optional gRPC listener
requires a durable Worklet using protocol 18 and wire version 1. Other versions are rejected before
a Task is sent. Protocol 18 checks live-input authority at take time and supports selecting and
reserving the exact Worker/profile on the chosen host. Upgrade Worklets with the same release before
treating the deployment as ready. See
[gRPC Worklet setup](../guides/workers.md#connect-securely-through-grpc).
Worklet heartbeats continue while host labels and Worker concurrency are checked, so a slow
credential or host probe does not disconnect an otherwise healthy Worker Host.
Host label observations expire after five seconds. Only one check may remain in flight, including
across reconnections. A timed-out check must settle before the next heartbeat can retry it;
SuperTag cannot cancel an extension's promise. The Control Plane keeps the last reported labels
until a check succeeds. Late results from timed-out checks are ignored.

## Network and secret boundaries

- Bind to loopback by default.
- Put TLS and an allowlisted reverse proxy in front of any remote Control Plane listener. An
  `https://` Worklet URL selects gRPC over TLS; with `--transport websocket`, Worklets use `wss://`.
- Never place collaboration surface credentials or Worker Host credentials in command-line flags, images, logs, prompts, or database rows.
- Keep the admin token with the deployment's owner. Give each teammate an Operator Token, and keep operator credentials separate from per-host credentials. Rotate or revoke a host with `supertag rotate worker-host-credential` or `supertag revoke worker-host-credential`.
- Gateway collaboration surface credentials receive collaboration events and deliver replies; their storage and use remain under Control Plane policy.
- Harness and hosted MCP credentials remain on the Worker Host.
- Rotate a collaboration surface by running its `supertag setup surface PROVIDER` command again against the same state and database. The running Control Plane reconciles the update.

For credential-provider contracts, continue to [Credential storage](../reference/credential-storage.md).
