# Resource model

For a plain-language introduction, start with [core concepts](../concepts/README.md). Then
read [Tags](../concepts/tags.md), [Tasks and Sessions](../concepts/tasks.md), or
[Worker Hosts, Worklets, Workers, and harnesses](../concepts/workers.md) when you need more detail.

SuperTag capitalizes the names of resources and contracts users create, configure, inspect, or
implement. General terms such as **collaboration surface** and **harness** stay lowercase.
Write **Task Attempt** for one execution or retry of a [Task](#operational-resources). Code identifiers keep their spelling.

SuperTag exposes a deliberately small resource model. It gives operators stable objects to
configure without turning every database row into a public abstraction. These resources describe
the [organization](glossary.md#autonomous-organization) and its work; the
[Control Plane and Worker Hosts](#runtime-components) are the top-level runtime components that
manage and execute them.

CLI resource commands use exact lowercase singular names: `tag`, `permission-set`,
`context-set`, `role`, `surface-account`, `worker-host`, `worker-profile`, `task`,
`session`, `volume`, `workspace`, `auth-key`, `operator-token`, and `objective`.
For example, `supertag get permission-set` lists [Permission Sets](#configuration-resources). Plural and
unhyphenated spellings are rejected with the supported names. Manifest kinds retain
PascalCase names such as `PermissionSet`.

## Runtime components

The **Control Plane** and **Worker Hosts** are SuperTag's two top-level runtime components. The
Control Plane stores the organization and schedules its work, and a Worker Host is a machine,
container, VM, or sandbox that runs it. The Control Plane contains an **API Server** for management and resource requests and a **Gateway** for
**collaboration surface** transport. A collaboration surface is how SuperTag meets people in an external work tool, such as
Slack, GitHub, Lark/Feishu, Linear, or Microsoft Teams: it receives events at a [Tag](#configuration-resources)'s locations and
replies there. A location is a place on a collaboration surface, such as a channel or repository. The API
Server also exposes the **Worklet API** used by Worker Hosts. The API Server and Gateway are internal subsystems, not additional
resources or separately deployed services. Worker Hosts supply execution capacity through [Worklets](glossary.md#worklet),
[Workers](glossary.md#worker), [harnesses](glossary.md#harness), and
[execution environments](glossary.md#execution-environment).

## Configuration resources

- **Tag** — a persistent AI actor with a stable identity, responsibilities, permissions, and
  work history. It holds [Roles](glossary.md#role), a [Mailbox](glossary.md#mailbox), and bindings
  to eligible Worker Hosts. You assign work to a Tag by name. Its configuration, open
  assignments, and results persist across model and harness sessions.
- **Permission Set** — reusable authority to perform surface-backed actions, use harness/runtime tools, or call tools of MCP servers.
  A permission can carry `approval: required`, and `spec.approvers` lists the operators
  (`operator:<id>`) and Tags (`tag:<name or id>`) that may decide. See [IAM approval](iam.md#approval).
- **Context Set** — reusable knowledge and [Skills](glossary.md#skill) that may enter a Task.
- **Role** — passive reusable policy for a responsibility, combining instructions, Context Sets, and Permission Sets.
- **Volume** — a named storage location, such as a bucket prefix or a directory on the Worker
  Host, and the name of the credential that reaches it; see [Volumes](#volumes).
- **Workspace** — a named repository that [Objectives](#operational-resources) may work in, with an optional git `source`,
  a base `ref`, one `setup` command, and a `delivery` mode. Worker Hosts declare local checkouts
  of it or clone its source; see [Workspaces](#workspaces).
- **Worker Profile** — a versioned execution configuration implemented by a
  [Worker](glossary.md#worker).
- **Surface Account** — an enrolled external workspace or account; credentials remain in the
  credential vault. `supertag setup surface` enrolls one interactively, and a SurfaceAccount
  manifest declares one; see [Declared Surface Accounts](#declared-surface-accounts).

Roles, Permission Sets, and Context Sets are shared resources. A Tag lists the Roles it holds. A set
can be activated directly at one of a Tag's locations when it is situational, or referenced by a Role when it
follows an enduring responsibility. Team membership places the Tag in the organization; the Task
gives it current direction. A Tag's Worker Host bindings define where its Tasks may run; the
scheduler then chooses a compatible Worker, harness, and execution environment on one of those
hosts. None of these resources becomes a separate actor.

## Operational resources

- **Objective** — an outcome a Tag owns, with a budget, a deadline, a status and an explicit
  completion assessment. It is a conversation with a goal: it talks in the thread it was created
  in, and the work happens in Sessions started beneath it. Set `ongoing: true` for a continuing
  responsibility that only an operator can end. An Objective may name one Team, whose members its
  owner may start work Sessions of. See [Objective coordination](coordination.md#objectives).
- **Team** is a flat list of member Tags with an optional concurrency limit. Members may message
  one another and share the Team's Workstream. A Team stands alone: any number of Objectives may
  name one Team. See [Teams](coordination.md#teams).
- **Workstream** is a Team's shared record of posts. Every member reads it, and a post wakes
  nobody; each Tag a post addresses receives it in its Mailbox. See
  [Workstream](coordination.md#workstream).
- **Mailbox** is a Tag's inbox for plain-text messages from other Tags. Every message waiting
  when a turn starts is handled together in that turn. See [Mailbox](coordination.md#mailbox).
- **Session** preserves automatic continuity for one Tag conversation. The `audience` field is
  `shared` or `private`. A direct chat or a conversation in the terminal UI is private to one
  person. A Tag's conversation Tasks can list, search, and read its shared Sessions and
  their own person's private ones. See
  [across Sessions](../concepts/multiplayer.md#across-sessions-one-tag-one-memory). A [work Session](../concepts/tasks.md#session)
  reports its conversation as `parentSessionId`. In `supertag get session`, `latestTaskStatus` is
  the status of a Session's latest Task, `tag` the Tag's name, and `title` a work Session's title
  or a conversation's first request.
- **Task** records one turn of a Session. Its result can carry
  [findings](coordination.md#review-findings): problems the Task reports about its own work, each
  with a severity, a summary and an optional location. A finding is part of the result, not a
  separate resource.
- **Task Attempt** records one Worker execution or retry.
- An **approval request** records one ask for a decision on a gated action, with its scope and
  decider. It is operational state listed with `supertag list approval`, not an applied resource.
  See [Approval requests](coordination.md#approval-requests).
- **Worker Host** is the durable enrolled identity and latest observed capacity, capability,
  health, and scheduling state of one execution location.
- **Auth Key** is an operator-issued join secret. A machine that redeems it joins as a new Worker
  Host bound to the key's Tags. See [Auth Keys](#auth-keys).
- **Operator Token** is a named management credential that the [admin token](glossary.md#admin-token)'s holder issues to one
  teammate or machine. SuperTag records the changes it makes under its name. See
  [Operator Tokens](#operator-tokens).

A **Worklet** runs on each Worker Host and reports that state to the Control Plane through the
API Server's Worklet API. It is a supervisor and transport participant, not a separate operational
resource. A per-host credential binds its Worklet connection to that Worker Host. Rotation and
revocation block older connections without exposing credentials through ordinary resource reads.
A **connection generation** is the increasing number that identifies the current connection.

Most of these records are inspectable but not declaratively applied. An Objective, with the Team
it names, may also be declared in a manifest; see [Declared Objectives](#declared-objectives).
Otherwise an Objective comes from `supertag create objective` or an `@SuperTag objective` command,
and a Team from `supertag create team`. A Team's Workstream exists with the Team. Status is never
declared: owners and operators record it explicitly. The execution records report what the service
did.

## Resource envelope

Control Plane resources use a common envelope:

```yaml
apiVersion: supertag/v1
kind: PermissionSet
metadata:
  name: engineering-read
spec:
  permissions:
    - target: runtime
      action: commands:execute
status:
  phase: active
```

Clients declare `spec`; the Control Plane owns generated metadata and `status`. The
language-neutral envelope is defined in
[`spec/resource-envelope.schema.json`](../../spec/resource-envelope.schema.json).

The relationship between Tags and Roles follows that same boundary: `Tag.spec.roles` is desired
configuration, while `Role.status.assignedTags` is a read-only projection. `Tag.spec.workerHosts`
is the desired pool of enrolled Worker Host IDs. An empty pool is valid configuration, but the
Control Plane rejects new Tasks for that Tag until an operator binds at least one host. A host that
joins with an Auth Key is added to the pool of each of the key's Tags. Storage records used to
preserve policy across admission and recovery are internal implementation details rather than
additional resources.

More Tag fields declare where its Tasks run, where the Tag works, and who may message it:

| Field | Entry | Meaning |
| --- | --- | --- |
| `spec.runsOn` | label | Labels a bound Worker Host must carry to run the Tag's Tasks. See [Worker Host labels](#worker-host-labels). |
| `spec.locations` | `provider`, provider scope fields, optional `account`, `permissionSets`, `contextSets`, `workspaces` | Where the Tag answers, with the sets activated at each location and the Workspaces its Objectives get |
| `spec.acceptsMessagesFrom` | Tag name | Mailbox grants where this Tag is the recipient |

Location scope fields match the `--add-location` flags in camelCase: `channelId` for Slack,
`repo` or `repoId` for GitHub, `chatId` for Lark, `team` or `teamId` for Linear, and `teamId`
with `channelId` for Microsoft Teams. `account` selects a Surface Account by external ID when a
provider has several. A stored Tag reports each location with its resolved `account` and stable
IDs; `status.locations` still reports the account display name and whether the route is enabled.

A location's `workspaces` lists Workspace names, at most 16, in order. An Objective created from
that location, such as with `@SuperTag objective` in its Slack channel, names those Workspaces.
Apply rejects a name that no Workspace defines. A GitHub location without `workspaces` gives its
Objectives every Workspace whose `source` is that repository instead. `update tag --add-location`
does not set `workspaces`; declare them in a manifest. See
[Objectives from a location](#objectives-from-a-location).

Each `acceptsMessagesFrom` entry names one sender Tag this Tag accepts messages from. Tags that
share a Team need no entry. See [Mailbox](coordination.md#mailbox).

Apply merges each of these lists entry by entry, and records who set each entry. See
[Field managers and apply sets](#field-managers-and-apply-sets).

## Auth Keys

An Auth Key lets a machine join as a Worker Host without copying a credential file. An operator
creates it for one or more existing Tags. The machine redeems it once with `supertag connect
worklet`, becomes a new Worker Host, and is bound to those Tags. Tags have no user accounts behind
them, so these bindings are what give a Tag its hosts.

```yaml
apiVersion: supertag/v1
kind: AuthKey
metadata:
  name: ci
spec:
  tags: [builder]
  labels: [linux-ci]
  reusable: true
  ephemeral: true
status:
  phase: active
  expiresAt: "2026-12-29T00:00:00.000Z"
  redemptionCount: 3
  usedAt: "2026-09-30T12:00:00.000Z"
```

| Field | Meaning |
| --- | --- |
| `spec.tags` | Tags bound to every host that joins with the key. They must exist when the key is created. |
| `spec.labels` | Labels granted to every host that joins with the key. See [Worker Host labels](#worker-host-labels). |
| `spec.reusable` | `false` (default): the key joins one host. `true`: it joins any number. |
| `spec.ephemeral` | Hosts that join are removed after they disconnect. See [Ephemeral Worker Hosts](#ephemeral-worker-hosts). |
| `status.phase` | `active`, `used` (a one-off key after its first join), `expired`, or `revoked`. |
| `status.expiresAt` | Fixed at creation: one hour for a one-off key, 90 days for a reusable key. |
| `status.usedAt`, `status.redemptionCount` | The last successful join and the number of joins. |

The rules:

- The secret starts with `stak_`. It is shown once, when the key is created. The Control Plane
  stores only its SHA-256 digest, and `list` and `get` never show it.
- Only operators create, read, and revoke Auth Keys. Tags cannot.
- Keys have no update. To change Tags, revoke the key and create one under a new name. Names are
  never reused.
- Revoking a key blocks new joins. Hosts that already joined keep their enrollment and Tags.
- A joining machine asks for a Worker Host ID, which defaults to its hostname. When that ID is
  taken, the Control Plane picks `NAME-2`, `NAME-3`, and so on.
- Joining is atomic. Under concurrent use, a one-off key still joins exactly one host.
- Auth Keys are imperative only. They do not appear in manifests, and `supertag apply` rejects
  them. A Tag manifest that lists `spec.workerHosts` is authoritative and unbinds hosts that joined
  with a key but are missing from the list.

### Ephemeral Worker Hosts

An ephemeral Worker Host suits a CI job or a short-lived container. Its `status.ephemeral` is
`true`. After it stays disconnected for 30 seconds, the Control Plane removes it: the host is
revoked, unbound from its Tags, and hidden from `supertag list worker-host`. `supertag get
worker-host ID` still shows it. A host that joined but never connected is removed after ten
minutes.

Persistent hosts keep the stricter recovery rule: a Task Attempt whose outcome is unknown keeps its
capacity until the host reports evidence. An ephemeral host cannot come back after removal, so its
interrupted Task Attempts count as stopped, and their Tasks run again on another host. The usual
retry limits apply. See [Leases and unknown outcomes](scheduling-and-recovery.md#leases-and-unknown-outcomes).

#### Storage durability

A Worker Host's storage is ephemeral or persistent, and `status.ephemeral` decides it. An ephemeral
host's Task files and artifact copies go with it when it is removed. Every other host is
persistent: [host services](glossary.md#host-service) that `supertag up` starts on your machine, and Worklets that joined
without an ephemeral key. A remote sandbox, such as on Modal or e2b, is always ephemeral: its
Task files are lost when the sandbox stops, whatever host started it.

`describe worker-host` reads execution placement from recorded Task Attempts, so omitting a
sandbox capability from a later host advertisement does not remove its warning. It inspects the
200 most recent Tasks and all running Task Attempts. Missing placement is reported as unknown;
a host with no inspected execution history is not evidence of persistent Task storage.
`describe task` uses its own Task Attempt's recorded placement. These records describe reported
execution, not an independent inspection of the host. `ps` and `up` use the local service settings.

The Control Plane stores no artifact bytes. Each Worker Host keeps the artifacts its Tasks capture
in its own state directory, so an artifact is only as durable as the hosts that hold it.

SuperTag shows this rather than refusing it:

| Command | What it says |
| --- | --- |
| `supertag ps`, `supertag describe worker-host` | "Ephemeral storage: Task files and artifacts on this host are lost if it stops." A host whose Tasks run in remote sandboxes says its Task files there are lost when each sandbox stops. `describe worker-host` says `Storage: persistent` only when its inspected execution records show local storage. |
| `supertag describe task` | Under `Storage:`, where the Task files, delivered branch, and each output and artifact live, flagging an artifact held only on ephemeral storage. See [artifacts](artifacts.md#where-describe-task-places-a-file) for how it decides. |
| `supertag up`, `supertag up --dry-run` | A warning for each host service that joined as an ephemeral host or runs Tasks in remote sandboxes. A host service keeps the artifacts its Tasks capture on its own host, and the Control Plane keeps no copy. A sandbox loses only its Task files. |
| `supertag connect worklet` | The ephemeral storage line on an ephemeral host, and a warning that it would hold the only copy of the artifacts its Tasks capture. |

## Operator Tokens

An Operator Token lets one teammate or machine manage a shared Control Plane without the admin
token. Each token has a name, and SuperTag records what it does as `token:NAME`. When a teammate
leaves or a laptop is lost, revoking that one token is enough; nobody else's access changes.

```yaml
apiVersion: supertag/v1
kind: OperatorToken
metadata:
  name: laptop-2
spec: {}
status:
  phase: active
  operatorId: token:laptop-2
  expiresAt: "2026-12-30T00:00:00.000Z"
  lastUsedAt: "2026-10-01T09:30:00.000Z"
```

| Field | Meaning |
| --- | --- |
| `status.phase` | `active`, `expired`, or `revoked`. |
| `status.operatorId` | The operator ID recorded for the token's changes, such as `token:laptop-2`. |
| `status.expiresAt` | Fixed at creation: 90 days later. |
| `status.lastUsedAt` | The last request the token authenticated, updated at most once a minute. |
| `status.revokedAt` | When the token was revoked. |

The admin token and Operator Tokens differ in one way:

| Credential | Can |
| --- | --- |
| Admin token (`SUPERTAG_ADMIN_TOKEN`) | Everything, including creating, listing, and revoking Operator Tokens. Changes are recorded as `control-plane-break-glass`. |
| Operator Token | Everything else the admin token can: apply and delete resources, create Auth Keys, create and direct Objectives, decide approvals, message, cancel, and read. Changes are recorded as `token:NAME`. |
| Scoped coordination credential | Only the named coordination commands, Objectives, and Teams. See [scoped operator credentials](../operations/control-plane.md#scoped-coordination-credentials). |

The rules:

- The secret starts with `stop_`. It is shown once, when the token is created. The Control Plane
  stores only its SHA-256 digest and compares digests in constant time. `list` and `get` never show
  the secret.
- Tokens have no update. Names are never reused, so `token:NAME` always means one token.
- Revoking a token refuses it on the next request. An expired token is refused the same way.
- Approval policies can name a token as an approver: `operator:token:laptop-2`.
- Operator Tokens are imperative only. They do not appear in manifests.

## Worker Host labels

A label is a short placement hint on a Worker Host, such as `macos`, `gpu`, or `workspace:app`.
Bindings and labels answer different questions:

- A Tag's bound Worker Hosts (`spec.workerHosts`) are the hosts that may run its Tasks.
- A Tag's `spec.runsOn` labels choose among those hosts. A host is eligible only when it is bound
  to the Tag and carries every label in `runsOn`. An empty list means any bound host.

For example, a Tag with `runsOn: [macos, gpu]` and three bound hosts runs only on a bound host
labeled both `macos` and `gpu`. An unbound host never runs its Tasks, whatever its labels.

```yaml
apiVersion: supertag/v1
kind: Tag
metadata:
  name: ios-builder
spec:
  workerHosts: [mac-mini-1, mac-mini-2]
  runsOn: [macos, arm64]
```

A label is 1-63 lowercase letters, digits, dots, colons, hyphens, or underscores, starting with a
letter or digit. SuperTag lowercases labels and matches them exactly. There is no selector
language. A host carries three kinds of label:

| Kind | Labels | Set by |
| --- | --- | --- |
| Automatic | `linux`, `macos`, or `windows`; `x64` or `arm64`; `harness:NAME` for each harness; `workspace:NAME` for each declared checkout; `mcp:NAME` for each [MCP server a host service provides](supertag-yaml.md#host-mcp-servers) | The Worklet |
| Declared | Any label, such as `gpu` | `supertag connect worklet --label LABEL` |
| Granted | The Auth Key's `spec.labels` | The Auth Key the host joined with |

`status.labels` on a Worker Host lists all of its labels. `status.grantedLabels` lists those its
Auth Key granted. Automatic and declared labels come from the host's latest connection and are
self-reported: a host can claim any label. Labels therefore decide placement only. They never grant
access, and a Tag's bindings stay the only way to let a host run its Tasks.

A Task in a named Workspace prefers bound hosts labeled `workspace:NAME`, on a profile that can
use the checkout in place. When the Workspace records a `source`, hosts that can clone it come
next; without a `source`, `workspace:NAME` is required. Either way the host must carry the Tag's
`runsOn` labels. When no bound host carries the required labels, the Task waits. Its
scheduling record names the requirement, such as `labels:macos,gpu`, and `supertag describe task`
prints `No bound Worker Host has labels: macos, gpu`. The list names the labels no bound host
carries; when each label exists on some host but none carries them all, it names every required
label. For an `mcp:NAME` label, it also names the missing MCP server, such as `No bound Worker Host
provides MCP server sentry`.

A Task granted `commands:execute` also skips an **unsandboxed harness**: one that runs commands
as the host's user, without an operating-system sandbox, such as Claude Code or OpenCode on a host
service. It runs on one only when the host service lists it in `allow-unsandboxed-commands`.
Otherwise it runs on another Worker, such as Codex, or waits; its scheduling record names the
requirement `allow-unsandboxed-commands:HOST`, and `supertag describe task` explains it. See
[Unsandboxed harnesses](supertag-yaml.md#unsandboxed-harnesses).

`runsOn` is set in a Tag manifest; `supertag update tag` has no flag for it. Each label is its own
entry under the [field manager rules](#field-managers-and-apply-sets), so a label that one apply
set adds survives another set's apply. Per-Objective and per-Task labels are not supported yet.

## Execution settings

Execution settings choose the harness, model, and reasoning effort a Tag's Tasks run with. For
example, a Reviewer Role can run on Codex with one model at medium or high effort:

```yaml
apiVersion: supertag/v1
kind: Role
metadata:
  name: Reviewer
spec:
  purpose: Review changes before they merge.
  execution:
    harness: codex
    model: [gpt-6-sol]        # allowed models; the first is the default
    effort: [medium, high]    # allowed efforts; the first is the default
```

`spec.execution` takes the same three fields on a Role and on a Tag:

| Field | Value | Meaning |
| --- | --- | --- |
| `harness` | One harness name, such as `codex` or `claude-code` | Tasks run only on that harness. |
| `model` | One model, or a list | One value means only this model. A list allows each, and the first is the default. |
| `effort` | `low`, `medium`, or `high`, or a list of them | Same rule as `model`. |

A `harness` or `model` left out allows anything the Worker Host offers and uses the host's
default. Effort is different: when neither the Tag nor its Roles set `effort`, Tasks start at
`low`, and `medium` and `high` stay allowed. An `effort` list keeps its own first value as the
default. Starting low keeps routine work cheap; the actors raise effort when work needs it. A Role sets
the default and allowed range for its Tags. A Tag's own `spec.execution` overrides its Roles' field
by field, so the Tag wins. When several Roles set a field, the first Role by name wins. A Role's
models apply only to its own harness: a Tag that switches to another harness does not inherit them.
`status.execution` on a Tag shows the resulting range, and `supertag describe tag` prints it.

Each harness maps effort to its own option. Codex receives it as `model_reasoning_effort`, and
Claude Code receives it as its effort option. OpenCode has no effort option, so it ignores effort
and the Task Attempt records that it did.

When SuperTag accepts a Task, it records one harness, model, and effort for it, from the acting
Tag's own range. See
[Scheduling and recovery](scheduling-and-recovery.md#placement-by-harness-and-model).

`execution` is one field under the [field manager rules](#field-managers-and-apply-sets): one
manager owns all three settings together. `supertag get role NAME --output yaml` and
`supertag get tag NAME --output yaml` export it. Tags and Roles without `execution` run on
whatever harness and model their Worker Hosts offer, starting at low effort.

## Workspaces

A Workspace names a git repository. Its Tasks can also receive copies of Volume data; see
[Workspace Volume copies](#workspace-volume-copies). Workspace fields are optional:

```yaml
apiVersion: supertag/v1
kind: Workspace
metadata:
  name: app          # 1-63 lowercase letters, digits, hyphens, or underscores
spec:
  source: https://github.com/acme/app.git   # cloned by hosts without a checkout
  ref: main                                 # base for Session branches
  setup: npm ci                             # one shell command
  delivery: branch                          # branch (default), patch, or pull-request
```

| Field | Default | Meaning |
| --- | --- | --- |
| `spec.source` | none | Git remote; embedded credentials are rejected. Worker Hosts without a checkout clone it, and `pull-request` delivery pushes to it. |
| `spec.ref` | The checkout's current branch, or the source's default branch in a clone, else `main` | Base for each new Session branch, and the base of pull requests |
| `spec.setup` | none | One shell command run once in each new Task worktree |
| `spec.mcp` | none | Selected server names from the trusted checkout's `.mcp.json` |
| `spec.skills` | none | Selected Skill names from the host checkout |
| `spec.delivery` | `branch` | `branch` keeps the Session's branch; `patch` also attaches a patch artifact; `pull-request` pushes the branch and opens one GitHub pull request per Session. `pull-request` requires a github.com `source`. |

A field set by an earlier apply that a later manifest omits returns to its default, as the
[field manager rules](#field-managers-and-apply-sets) describe. `status.workerHosts` lists the
enrolled Worker Hosts whose latest descriptor declares a checkout, with their connection status.
Checkout paths stay on each host. Hosts whose Worker Profiles all report `supertag.workspace.clone`
can also serve a Workspace with a `source`; SuperTag prefers hosts that declare a checkout.

An Objective lists its Workspaces in `workspaces`, an array of names. A Task records its
Workspace, `source`, base `ref`, its Session's branch `supertag/session/<short session id>`,
`delivery`, and `setup`
when SuperTag accepts it; `Task.spec.workspace` reports the name, branch, ref, and delivery. For
`pull-request` delivery, `Task.status.pullRequest` reports the pull request's `repository`,
`number`, `url`, and `state`: `draft`, `ready`, or `closed`. `lastError` appears when the Control
Plane could not mark it ready or close it. See
[Work in a repository with Workspaces](../guides/workspaces.md) and
[Workspace staging](worker.md#workspace-staging).

<!-- supertag-cli: native start -->

### Workspace Volume copies

A Tag declares the Volume copies its Tasks receive with `supertag tag put TAG --workspace-mounts
FILE`. The file is a JSON array; each entry places one Workspace Volume at an absolute path
outside the checkout:

```json
[{ "volumeId": "datasets", "destination": "/srv/supertag-mounts/datasets",
   "maxBytes": 1073741824, "access": "read-only" }]
```

| Field | Default | Meaning |
| --- | --- | --- |
| `volumeId` | required | A Workspace Volume registered with `supertag workspace-volume put` |
| `destination` | required | Normalized absolute path directly inside a `destinationRoot` that serving Worker Hosts map. Not a dot name, not overlapping another copy or a protected system path. |
| `maxBytes` | 1 GiB | The most bytes the copy holds and its write-back may change: 1 to 20 GiB |
| `access` | `read-only` | `read-write` writes changed and created files back after a successful Task Attempt, and requires `files:write` |

A Tag has at most eight copies. Its Tasks must allow `files:read`, may not allow
`commands:execute` or `web:fetch`, and run on Codex, Claude Code, Cursor, or OpenCode. The Control
Plane freezes each Volume's source, credential name, and revision when it accepts a Task. Only a
Worker Host whose `--workspace-mount-mappings` maps that exact Volume, credential name, and
destination root claims the Task; a retargeted Volume leaves queued Tasks unplaceable.

The Worker Host stages each copy for one Task Attempt and removes it when the Task Attempt ends.
A copy holds at most 10,000 files and visits at most 40,000 entries, and one Task Attempt copies
at most 20 GiB across its copies. Links, hard-linked files, files on another filesystem, and the
names `.git` and `.supertag-*` are refused. A remote E2B or Modal Workspace receives the staged
files at `volumes/<digest>/<name>` inside its checkout; the returned tree never includes them.
Read-only provider-native Modal Volume mounts are on the backlog.

### Read-write copy contract

After a successful Task Attempt, the Worker Host writes each changed and created regular file of a
read-write copy directly to its Volume: to a `file://` directory without following links, or to
`s3://` with a streamed, signed `PUT`. It never writes deletions or links, and a failed or
cancelled Task Attempt writes nothing. Before the first write it refuses more than 1,000 changed
files, any file over 5 GiB or the copy's `maxBytes`, a changed total above `maxBytes`, and names
the Volume cannot hold. A refusal writes nothing. Writing in key order stops at the first failure.

Each copy's summary records `volume_id`, `destination`, `status` (`complete`, `partial`, or
`refused`), written `files` with `key`, `size`, and `sha256`, `skipped`, an `error` with `key` and
`reason` when present, and `not_attempted`. `supertag describe task ID` shows it as the Task's
mount writes. A `partial` or `refused` write-back fails the Task.

<!-- supertag-cli: native end -->

### Objectives from a location

An Objective created from a collaboration surface gets its Workspaces from the Tag location the
request arrived at:

| Location | Workspaces the Objective gets |
| --- | --- |
| Any location with `workspaces` | Those Workspaces, in order |
| A GitHub location without `workspaces` | Every Workspace whose `source` is the repository. `https://github.com/acme/app`, `https://github.com/acme/app.git`, `git@github.com:acme/app.git`, and `ssh://git@github.com/acme/app` all match `acme/app`; owner and name ignore case. |
| Any other location | None |

The Tag that creates the Objective, through the `create_objective` tool, may pass `workspaces` to
name a subset. A name outside that set returns 400. Creation `warnings` then cover those
Workspaces like any other. Mentions carry no Workspace syntax; the location decides.

<!-- supertag-cli: native start -->

## Volumes

A Volume names a place where data lives outside git, such as a dataset in a bucket or a directory
on the Worker Host. Volumes are Experimental. A Workspace Volume holds data Tasks receive as
copies; an artifact Volume holds captured Task files (see
[Artifacts](artifacts.md)).

```sh
supertag workspace-volume put datasets --source s3://acme-data/datasets/v3 --credential acme-data
supertag workspace-volume put notes --source file:///srv/data/notes
```

| Setting | Meaning |
| --- | --- |
| `--source` | A canonical `file:///ABSOLUTE/PATH` on the Worker Host, or `s3://BUCKET/PREFIX` with a non-empty prefix and no trailing slash. Query settings, `r2://`, `gs://`, and `modal-volume://` are refused. |
| `--credential` | Required for `s3://` and refused for `file://`: a label of 1-63 lowercase letters, digits, hyphens, or underscores that each serving Worker Host maps to its own keys. The Control Plane stores only the label. |
| `--expected-revision` | The revision you last read, or 0 to create. A stale revision is refused. |

A source carries no connection settings. Each Worker Host owner pins them in the host's
`--workspace-mount-mappings` file: `endpoint` (an HTTPS origin), `region`, and
`credentialEnvPrefix`, the prefix of the environment variables holding the keys
(`PREFIX_ACCESS_KEY_ID`, `PREFIX_SECRET_ACCESS_KEY`, optional `PREFIX_SESSION_TOKEN`). Requests are
path-style. So whoever registers a Volume cannot send a host's signed requests, or a read-write
copy's Task output, to an endpoint the host did not choose. A `file://` mapping takes none of
these; the mapping itself is the host owner's consent.

`supertag get workspace-volume NAME` shows a Workspace Volume's source, credential label, and
revision. Changing a source is a new revision. For what a Volume keeps when a sandbox or host dies,
see [Persistence](../concepts/persistence.md).

<!-- supertag-cli: native end -->

### Volume security

A host's artifact Volume stores captured Task files governed by artifact grants. Workspace Volume
copies cannot expose that Volume, a parent location, or any location beneath it. Placement checks advertised artifact Volumes and Volumes with recorded copies;
dispatch checks them again. The Worker Host also checks its own current artifact Volume.

SuperTag compares locations, not source URL strings. File paths compare by component, and on
macOS also case- and Unicode-insensitively, so `/srv/Data` and `/srv/data` are one location.
Because no source carries an endpoint, an `s3://` Workspace Volume compares with an S3 artifact
Volume by bucket name and nested prefix on any endpoint, and SuperTag refuses an overlap in either
direction. So an endpoint alias, such as a virtual-hosted or path-style spelling of the same store,
cannot expose artifact storage to a Task. Distinct prefixes such as `artifacts` and
`artifacts-other` remain separate.

The Worker Host checks its mappings again against its own state, its Workspaces, home
configuration, and the artifact paths the Control Plane discloses for each Task Attempt. It
compares real paths and directory identities, so a bind mount or link that reaches protected
storage under another spelling is refused.

## Field managers and apply sets

A manifest from version control, an operator running `supertag update tag`, and a second team's
manifest may all change one Tag. SuperTag records which writer last set each field, so one writer
does not silently undo another.

A **field manager** is the name recorded for that writer:

| Field manager | Writes |
| --- | --- |
| `apply` | `apply -f` without `--set` |
| `init` | Starter resources created by `supertag init` |
| The set name | `apply -f` with `--set NAME` |
| `cli` | Imperative commands such as `update tag` and `grant mailbox`, Worker Hosts joining with an Auth Key, and any other change made outside apply |
| `tag:<name>` | Reserved for changes Tags make through tools. No current tool changes a managed field. |

A field is either one value or one entry of a list. Each list entry has its own manager:

| Resource | Field | One entry per |
| --- | --- | --- |
| Tag | `spec.roles`, `spec.workerHosts`, `spec.runsOn` | Role name, Worker Host ID, label |
| Tag | `spec.locations` | Provider and scope ID, such as `slack:C0123` or `teams:TEAM/CHANNEL` |
| Tag | `spec.acceptsMessagesFrom` | Sender Tag |
| Role | `spec.contextSets`, `spec.permissionSets` | Set name |
| Permission Set | `spec.approvers`, `spec.permissions` | Approver; permission target, scope or resource, and action |
| Context Set | `spec.items` | `itemKey` |
| Objective | `spec.teams` | Team name |
| Surface Account | `spec.configuration`, `spec.secrets` | Option name, secret name |

Other fields, such as a Role's `purpose`, are single values. An Objective's lists, such as
`spec.runtimeActions` and `spec.workspaces`, are single values too. A location's sets and
`workspaces` belong to its entry, so activating a set there changes that entry. Messages name
fields by path, such as `spec.purpose` or `spec.locations[slack:C0123]`.

Apply follows four rules for each field:

1. **Omitted and yours: removed.** A field this manager set that the manifest now omits is removed.
   A single value returns to its default.
2. **Omitted and someone else's: kept.** A location added with `supertag update tag` survives.
3. **Changed and someone else's: conflict.** Apply refuses and names the field and its manager.
   `--force-conflicts` applies the change and moves the field to the applying manager.
4. **Same value: no conflict.** Setting the value another manager already set moves the field to
   the applying manager. Each field has one manager.

Imperative commands keep their own rule: they change only what they name. SuperTag stores each
field's value when apply writes it. A field whose value later differs changed outside apply, so it
belongs to `cli`. A resource with no record, such as one created before field managers existed,
belongs entirely to `cli`, so its first apply conflicts rather than deletes.

An **apply set** is a named group of resources that one input declares. `--set NAME` records every
resource in the input as a member of that set, and writes as field manager `NAME`.
A resource belongs to at most one apply set; applying it under another set moves it. `--prune`
removes the set's members that the input no longer lists: it cancels Objectives first, then deletes
Tags, sets, Workspaces, and Volumes, and retires Surface Accounts last. It
deletes each one as [Deletion](#deletion) describes and keeps, and reports, a member that is still
in use. A kept member stays in the set for the next prune. See
[Manage an organization as a set](../operations/resources.md#manage-an-organization-as-a-set).

`supertag.yaml` is not a source of resources. It lists the services `supertag up` runs, and
`apply` refuses it. See
[supertag.yaml and local state](supertag-yaml.md).

## Declared Objectives

An Objective manifest declares standing work, such as an ongoing responsibility, beside the Tags
that do it.

```yaml
apiVersion: supertag/v1
kind: Objective
metadata:
  name: dependency-upkeep
spec:
  owner: maintainer
  outcome: Keep dependencies current and the build green. Open a pull request for each upgrade.
  ongoing: true
  workspaces: [app]
  budget: { minor: 50000, currency: USD }
  deadline: "2027-01-01T00:00:00Z"
  runtimeActions: [files:write]
  team: { members: [maintainer, builder], maxConcurrency: 2 }
```

| Field | Meaning | After creation |
| --- | --- | --- |
| `metadata.name` | The Objective ID. | Fixed |
| `spec.owner` | Required. The owner Tag's name. | Fixed |
| `spec.outcome` | Required. One natural-language statement of the outcome. | Fixed |
| `spec.ongoing` | `true` for a responsibility that only an operator ends. Default `false`. | Fixed |
| `spec.workspaces` | Workspace names. | Fixed |
| `spec.budget` | `minor`, a nonnegative integer, and an optional uppercase `currency`. | Only increases |
| `spec.deadline` | An ISO timestamp. | Changes |
| `spec.runtimeActions` | Runtime actions for turns admitted afterwards. Omitted: what the owner's Permission Sets allow when it is created. | Changes |
| `spec.team` | An existing Team's name, or the Objective's own Team as `members` (Tag names), an optional `name`, and an optional `maxConcurrency` (1 to 1000). | Which Team is fixed; its own Team's fields change |

The rules:

- Applying a new Objective creates it and starts its conversation. An Objective that could not
  start, such as one whose owner Tag had no Worker Host, starts on a later apply.
- A change to a fixed field is refused before anything is applied. A new name creates a new
  Objective. A field another manager owns is reported as a conflict, as for other kinds.
- A manifest that stops setting `budget`, `deadline`, or `runtimeActions` leaves the stored value.
- A declared Team's ID is the Objective's ID. Apply creates and updates only the Teams it owns,
  and leaves a Team the Objective names by name alone.
- `--prune` cancels a set member the input no longer declares; it is never deleted. A completed
  member leaves the set unchanged. A cancelled Objective cannot run again, so apply leaves a
  cancelled declaration as it is and says so.
- A manifest has no `status`. `supertag get objective ID --output yaml` exports the declarable
  fields; JSON reads return the full Objective record.

## Declared Surface Accounts

A SurfaceAccount manifest declares one Surface Account. Its secrets are references, never
values:

```yaml
apiVersion: supertag/v1
kind: SurfaceAccount
metadata:
  name: acme-slack
spec:
  provider: slack
  displayName: Acme Slack
  configuration: { transport: socket }
  secrets:
    botToken: { secretRef: slack-bot-token }
    appToken: { env: SLACK_APP_TOKEN }
```

| Field | Meaning | After creation |
| --- | --- | --- |
| `metadata.name` | 1 to 63 letters, digits, dots, hyphens, or underscores. Tag locations may name the account by it in `account`. | Fixed to one provider account |
| `spec.provider` | `slack`, `github`, `lark`, `linear`, or `teams`. | Fixed |
| `spec.displayName` | Optional. Replaces the name the provider reports. | Changes |
| `spec.configuration` | The provider's non-secret options, with defaults filled in. | Changes; identity options, such as a Teams `tenantId`, may not name another account |
| `spec.secrets` | Secret name to exactly one of `{ secretRef: NAME }`, `{ env: VARIABLE }`, or `{ file: PATH }`. | Changes |

The [collaboration surface guides](../surfaces/README.md#declare-a-surface-account-in-a-manifest) list each
provider's options and secrets, and the
[SurfaceAccount schema](../../spec/manifests/surface-account.schema.json) gives the exact shape.

The rules:

- A literal secret value is invalid anywhere in the manifest.
- `env` and `file` are read by the applying CLI; a relative `file` path starts from the manifest's
  directory. `secretRef` is resolved by the caller that applies the manifest; `supertag apply -f`
  supplies no resolver and refuses it.
- Apply compares the resolved values with the credential vault. When the account is new or
  anything changed, the CLI verifies the values with the provider, as `supertag setup surface`
  does, before any manifest in the input is applied. An unchanged account is neither re-verified
  nor rewritten.
- `diff` never reads secrets. It plans the declared fields and references only.
- The stored resource lists the references in `spec.secrets` beside the fields verification
  records, such as `externalAccountId`. No value or derivative of a value is stored outside the
  vault.
- A name stays bound to the provider account it first named. Credentials for another account, or a
  second manifest for the same one, are refused. Applying a manifest for an account that setup
  created names that account and keeps its ID.
- `supertag get surface NAME --output yaml` exports the declarable fields and references. An
  account setup created has no references to export.

## Deletion

`supertag delete` removes a Tag, Role, Permission Set, Context Set, Workspace, or Surface
Account. Objectives are cancelled instead, never deleted. Deletion never erases history, and it refuses a resource that is
still in use:

| Resource | Deleting it | Refused while |
| --- | --- | --- |
| Tag | Retires the Tag and removes its locations with their set activations, Worker Host bindings, Mailbox grants in both directions, and Role assignments | It owns an open Objective, belongs to any Team, has a pending or running Task, or a Permission Set names it in `spec.approvers` |
| Role | Retires the Role and clears its sets | A Tag holds it, or it is built in |
| Permission Set, Context Set | Deletes the set and its entries | An active Role lists it, or a Tag location activates it |
| Workspace | Deletes the Workspace | An open Objective names it, or a Tag location lists it |
| Surface Account | Retires the account and deletes its vault credential | A Tag location uses it, or a Permission Set grants an action through it |

A Volume has no `supertag delete` form; `apply --set NAME --prune` deletes a Volume that its apply
set no longer declares.

A Surface Account is named by its manifest name, or, when setup created it, by
`PROVIDER:EXTERNAL_ID` as `supertag list surface` shows. A **retired** account keeps its row for
delivery history, frees its name, matches no inbound event, and is omitted from `list` and `get`.
Setting up or applying the same provider account again reconnects it.

An open Objective is one that is not `completed` or `cancelled`. A refusal names every reference.
There is no force option: remove the references, then delete again. Deletion also removes the
resource's field-manager record and apply-set membership. A dry run reports the same decision and
what would go with the resource, without changing anything.

A **retired** Tag has `status.phase: retired` and `status.retiredAt`. Its row stays, so Tasks,
Sessions, approval requests, Objectives, and artifacts keep pointing at it. It receives no work,
cannot be messaged or bound to a Worker Host, and Auth Keys that name it can no longer join. `list`
omits retired Tags; `get` still returns one by name. Only active Tags hold a name, so a new Tag can
reuse a retired Tag's name. It gets a new ID, and history still names the retired Tag by ID. When
several retired Tags share a name and no active Tag holds it, `get` returns the latest one retired.

Deleting a set or Workspace does not change history, because each Task keeps the policy and
workspace recorded when SuperTag accepted it. A Worker Host that declares a deleted Workspace keeps
its checkout; SuperTag stops offering the Workspace until one with that name exists again.

## Internal coordination

Each Tag has one Mailbox: plain-text messages from other Tags, handled together in one turn of
the Tag's inbox. Mailboxes are not separately configured. Tags in one Team message each other
without a grant; across Teams, a grant records that a recipient accepts messages from a sender.
Delivery grants no execution authority. See [Mailbox](coordination.md#mailbox) and
[Send messages between Tags](../guides/tag-messaging.md).

A message from the terminal UI or a reply in the Objective's home thread delivers its next
turn. The owner uses `ask` to put a question to a person. A message grants no authority and
changes no budget. See
[Operator messages](coordination.md#operator-messages).

A harness exposes these tools only to its root harness actor. Native subagents acquire no Tag
identity and no Mailbox; they coordinate through the harness's local primitives. See
[Coordination tools](coordination.md#coordination-tools).

Each Team has one [Workstream](../guides/workstreams.md), its shared record of posts. Every
member reads it, a post wakes nobody, and each Tag a post addresses receives it in its Mailbox.
Posts carry information only. See [Workstream](coordination.md#workstream).

For saved Task output, producer provenance, and artifact acquisition, see [artifacts](artifacts.md).
