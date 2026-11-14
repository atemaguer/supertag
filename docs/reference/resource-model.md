# Resource model

For a plain-language introduction, start with [core concepts](../concepts/README.md). Then
read [Tags](../concepts/tags.md), [Tasks and Sessions](../concepts/tasks.md), or
[Worker Hosts and harnesses](../concepts/workers.md) when you need more detail.

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
container, VM, or sandbox that runs it. A separate, optional **Gateway** carries
**collaboration surface** traffic as a client of the Control Plane. A collaboration surface is how SuperTag meets people in an external work tool, such as
Slack, GitHub, Lark/Feishu, Linear, or Microsoft Teams: it receives events at a [Tag](#configuration-resources)'s locations and
replies there. A location is a place on a collaboration surface, such as a channel or repository. The Control
Plane serves one API to operator clients, Worker Hosts, and Gateways. Worker Hosts supply execution
capacity through [harness adapters](glossary.md#harness-adapter), [harnesses](glossary.md#harness),
and [execution environments](glossary.md#execution-environment).

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
  decider. It is operational state listed with `supertag get approval`, not an applied resource.
  See [Approval requests](coordination.md#approval-requests).
- **Worker Host** is the durable enrolled identity and latest observed capacity, capability,
  health, and scheduling state of one execution location.
- **Auth Key** is an operator-issued join secret. A machine that redeems it joins as a new Worker
  Host bound to the key's Tags. See [Auth Keys](#auth-keys).
- **Operator Token** is a named management credential that the [admin token](glossary.md#admin-token)'s holder issues to one
  teammate or machine. SuperTag records the changes it makes under its name. See
  [Operator Tokens](#operator-tokens).

Each Worker Host reports that state to the Control Plane over its own connection. A per-host
credential binds the connection to that Worker Host. Rotation and
revocation block older connections without exposing credentials through ordinary resource reads.
A **connection generation** is the increasing number that identifies the current connection.

Most of these records are inspectable but not declaratively applied. An Objective, with the Team
it names, may also be declared in a manifest; see [Declared Objectives](#declared-objectives).
Otherwise an Objective comes from `supertag objective create` or an `@SuperTag objective` command,
and a Team from `supertag team create`. A Team's Workstream exists with the Team. Status is never
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
revoked, unbound from its Tags, and hidden from `supertag get host`. `supertag get
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
| `supertag ps`, `supertag describe host` | "Ephemeral storage: Task files and artifacts on this host are lost if it stops." A host whose Tasks run in remote sandboxes says its Task files there are lost when each sandbox stops. `describe worker-host` says `Storage: persistent` only when its inspected execution records show local storage. |
| `supertag describe task` | Under `Storage:`, where the Task files, delivered branch, and each output and artifact live, flagging an artifact held only on ephemeral storage. See [artifacts](artifacts.md#where-describe-task-places-a-file) for how it decides. |
| `supertag up` | A warning for each host service that joined as an ephemeral host or runs Tasks in remote sandboxes. A host service keeps the artifacts its Tasks capture on its own host, and the Control Plane keeps no copy. A sandbox loses only its Task files. |

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
| Scoped coordination credential | Only the named coordination commands, Objectives, and Teams. See [scoped operator credentials](../operations/control-plane.md#identities-and-access). |

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
| Automatic | `linux`, `macos`, or `windows`; `x64` or `arm64`; `harness:NAME` for each harness; `workspace:NAME` for each declared checkout; `mcp:NAME` for each [MCP server a host service provides](../surfaces/worker-tools.md) | The Worker Host |
| Declared | Any label, such as `gpu` | `supertag worker-host --label LABEL` |
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

`runsOn` is set in a Tag manifest or with `supertag placement runs-on TAG LABEL...`. Each label is its own
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
manager owns all three settings together. `supertag get role NAME` and `supertag get tag NAME`
print it as JSON. Tags and Roles without `execution` run on
whatever harness and model their Worker Hosts offer, starting at low effort.

## Workspaces

A Workspace names a git repository and can attach data from a Volume. A Volume is a named
storage source configured separately by an operator. Workspace fields are optional, except that
`source` is required when `mounts` is present:

```yaml
apiVersion: supertag/v1
kind: Workspace
metadata:
  name: app          # 1-63 lowercase letters, digits, hyphens, or underscores
spec:
  source: https://github.com/acme/app.git   # cloned by hosts without a checkout
  ref: main                                 # base for Session branches
  setup: npm ci                             # one shell command
  mounts:
    - volume: datasets                     # a separately configured Volume
      path: /mnt/datasets                  # outside the Task checkout
      access: read-only                    # default; read-write saves changes to the source
      strategy: copy                       # copy (default) or mount
      maxBytes: 1048576                    # optional copy limit in bytes
  delivery: branch                          # branch (default), patch, or pull-request
```

| Field | Default | Meaning |
| --- | --- | --- |
| `spec.source` | none | Git remote; embedded credentials are rejected. Worker Hosts without a checkout clone it, and `pull-request` delivery pushes to it. |
| `spec.ref` | The checkout's current branch, or the source's default branch in a clone, else `main` | Base for each new Session branch, and the base of pull requests |
| `spec.setup` | none | One shell command run once in each new Task worktree |
| `spec.mcp` | none | Selected server names from the trusted checkout's `.mcp.json` |
| `spec.skills` | none | Selected Skill names from the host checkout |
| `spec.mounts` | none | Volumes attached at absolute paths outside the checkout. Paths cannot overlap each other, staged files, or protected system locations. Each entry needs `volume` and `path`; `access` defaults to `read-only`, `strategy` to `copy`, and `maxBytes` is an optional positive byte limit. `mount` requests a native mount; `read-write` saves changes to the Volume source. |
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
[Workspace staging](worker.md#workspaces).

`strategy: mount` requests live data, such as a dataset too large to copy. Placement requires a
provider that advertises native mounts and never substitutes `copy`. Local and e2b
support only `copy`; e2b native mounts would require keys inside the sandbox. Modal supports
S3, R2, GCS, and Modal Volume mounts with the declared access. Unsupported sources and connection options are
refused before preparation or any provider call; see [Native source settings](#native-source-settings).
`maxBytes` bounds copies only. Native mounts attach at Task start, after setup.

`supertag describe task ID` labels each native mount **live**. For each Task Attempt, it shows
its Volume, source, prefix, destination path, access, and attachment time. An empty prefix means
the entire source. These records describe what the provider attached; they do not pin the files
or prove the source is still attached after the Task Attempt ends. Native mounts have no object
manifest or content digest. Copy mounts retain their manifests and changed-content indicators.

### Read-write output contract

A read-write Workspace mount lets a Task save files to its Volume's source. With `strategy: copy`, the Worker compares files with the input manifest and uploads created or changed files at finalize to S3, R2, or `file://`. It never propagates deletions or follows symbolic links. Uploads run sequentially without retries. Before the first upload, SuperTag refuses more than 1,000 changed files per mount per Task Attempt, any file over 5 GiB, or a changed total above that mount's `maxBytes`. A refusal uploads nothing.

Each mount's Task Attempt output manifest records `volume`, `source`, `path`, `status` (`complete`, `partial`, or `refused`), `uploadedAt`, uploaded `objects` with `key`, `size`, and `sha256`, `skipped`, an `error` with `key` and `reason` when present, and `notAttempted`. `supertag describe task ID` displays it under **Writes**; the Objective overview summarizes it. An upload failure fails the Task Attempt with a reason naming the mount and key. Earlier uploads remain in the source and appear in the partial manifest. Git delivery still completes; the owner decides whether to rerun, which uploads again.

With `strategy: mount`, Modal CloudBucketMount and Modal Volumes attach writable when access is `read-write`. e2b refuses native mounts that require keys inside the sandbox. Parallel Tasks writing the same key use last-write-wins. An interrupted Task Attempt can leave partial writes, and writes land before review. Object stores are not POSIX: rename, append, and locks are unavailable on native mount paths.

### Workspace mount security

Every mount path must stay outside the checkout, staged files, and other mounts. This applies to
both `copy` and `mount`, including mixtures of the two. For example, `/mnt/data` conflicts with
`/mnt/data/token`, but not `/mnt/database`. Refusals name both conflicting paths.
Staged paths include input mounts and credential targets, as well as files such as `.mcp.json`.
Sandbox start checks declared paths before resolving mount sources. SuperTag checks paths again
inside the started sandbox before staging the harness plan.

A Workspace cannot attach a Volume that holds artifacts, even through another Volume name.
The [Volume security rules](#volume-security) describe how SuperTag compares source locations.
Native mounts resolve through a host source guard before checkout or preparation. This guard reads
catalog metadata without opening host copy credentials. A host without that guard refuses native mounts.

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

## Volumes

A Volume names a place where data lives outside git, such as a dataset in a bucket or a share
the operator mounted on the Worker Host. For example, a `datasets` Volume can point at
`s3://acme-data/datasets/v3/`. Volumes are Experimental.

```yaml
apiVersion: supertag/v1
kind: Volume
metadata:
  name: datasets     # 1-63 lowercase letters, digits, hyphens, or underscores
spec:
  source: s3://acme-data/datasets/v3/   # s3://, r2://, or file:// on the Worker Host
  credential: acme-data                 # a name; each Worker Host maps it to a secret
```

| Field | Default | Meaning |
| --- | --- | --- |
| `spec.source` | required | `s3://BUCKET/PREFIX` for Amazon S3 or another S3-compatible store, `r2://BUCKET/PREFIX` for Cloudflare R2, or `file:///ABSOLUTE/PATH` for a directory on the Worker Host. Native mounts also accept `gs://BUCKET/PREFIX/` and `modal-volume://NAME/PREFIX/`. S3/R2 URLs accept the connection parameters below. Apply rejects fragments, embedded credentials, unknown parameters, and `.` or `..` segments. `file://`, `gs://`, and `modal-volume://` sources reject all query strings. |
| `spec.credential` | required | The name each Worker Host maps to a secret, provider-held reference, or explicit consent. For `modal-volume://`, the mapping must be `{ modal-volume: NAME }`, matching the source name exactly. For `file://`, the host never reads with the secret; its mapping is the host's consent to expose that directory. |

### Volume connection settings

S3-compatible connection settings belong in the source URL, for example:

```yaml
source: s3://acme-data/datasets/v3/?region=eu-west-2&endpoint=https%3A%2F%2Fstore.example&forcePathStyle=true
```

| Query parameter | Default | Meaning |
| --- | --- | --- |
| `region` | `us-east-1` for S3; `auto` for R2 | Signing region. Lowercase letters and digits, with single hyphens between groups. |
| `endpoint` | AWS S3 regional endpoint for S3; required for R2 | `https://` URL, optionally with a port and path. HTTPS is required even on loopback. Link-local and metadata IP addresses are refused, including IPv4 embedded in mapped, translated, compatible, and well-known NAT64 addresses. Local-use NAT64 addresses (`64:ff9b:1::/48`) are refused because their IPv4 layout depends on the network. No embedded credentials, query, fragment, whitespace, control characters, or Unicode format characters. Percent-encode it as a query value. |
| `forcePathStyle` | `false` | Literal `true` or `false`. Use `true` for stores that require bucket names in request paths. |

Each parameter may occur only once. Unknown parameters are refused. For R2, use a source such as
`r2://acme-data/datasets/?endpoint=https%3A%2F%2FACCOUNT.r2.cloudflarestorage.com`.
`describe volume` shows the region, endpoint, and path style, including their defaults.
Whoever can apply Volumes decides where a mapped credential is sent. Only grant that ability to
people trusted to choose credential destinations. For example, changing `endpoint` sends signed
requests to the new store. Address checks inspect the URL's literal host; they do not resolve DNS
or prevent a hostname from resolving to a private address. Use trusted endpoints, DNS, and host
network rules that block metadata services. Local development stores also need a certificate
trusted by the Worker Host.
Source URLs reject secret look-alikes, including percent-encoded keys and adjacent random-key
fragments. Separators such as `/`, `.`, `~`, `+`, and `,` do not hide these keys.
Recognized prefixes include `sk-proj`, `sk-ant-api03-`, `sk_live_`, `sk_test_`, `sk-svcacct-`,
and `sk-or-v1-`. Their payloads can contain lowercase letters or one- and two-letter fragments.
Ordinary word paths such as `sk-learn/models/training/`, `sk-proj/models/checkpoints/`, and
`asia/training/checkpoints/` remain valid, including trailing dates and versions such as
`sk-proj/models/checkpoints/2024` and `asia/training/checkpoints/v1`. Numeric date paths such as
`sk-proj/2024/10/06/12/` and `asia/2024/10/06/12/30/` also remain valid. This heuristic catches common mistakes; it cannot identify
every secret. Keep secret values out of source URLs.
Endpoint checks also refuse the metadata addresses `fd20:ce::254`, `fd00:ec2::23`,
`192.0.0.192`, and `168.63.129.16`, including the supported embedded IPv4 forms above.

These settings are public catalog data; keep credentials in the host's
[Volume credential secret](../guides/workspaces.md#attach-data-outside-the-repository).

`spec.credential` is a name, never a secret value. The Control Plane stores only the name. Each
Worker Host that serves the Volume keeps the secret itself. Apply rejects a value that looks like a
key or token, such as an access key ID, so a secret pasted by mistake is not stored.

`supertag get volume NAME`, `supertag get volume`, and `supertag describe volume NAME` show a
Volume. `apply` creates or replaces one; a credential a later manifest omits is cleared.

For what a Volume keeps when a sandbox or host dies, see
[Persistence](../concepts/persistence.md).

Copy mounts have a fixed combined limit of 20 GiB per Task Attempt, in addition to each mount's
`maxBytes`. SuperTag checks all listings before copying any files. A `file://` source refuses files
with more than one hard link and rechecks home-directory consent during copying. See
[copy mount behavior](../guides/workspaces.md#attach-data-outside-the-repository) for the source and destination
restrictions.

### Native source settings

Native mounts expose live data through Modal. For example, a Volume with
`source: gs://training-data/models/` and `credential: training` can use the host mapping
`training: { modal-secret: gcs-reader }`. The Workspace selects `strategy: mount`.

| Source | Authentication | Prefix and settings |
| --- | --- | --- |
| `s3://BUCKET/PREFIX/` | Host mapping to `modal-secret` or `modal-oidc-role` | Empty prefix or one ending in `/`. A region selects its regional AWS endpoint. |
| `r2://BUCKET/PREFIX/?endpoint=URL` | Host mapping to `modal-secret` | Requires an HTTPS endpoint. Empty prefix or one ending in `/`. |
| `gs://BUCKET/PREFIX/` | Host mapping to `modal-secret` | Uses GCS's endpoint. Empty prefix or one ending in `/`; no query parameters. |
| `modal-volume://NAME/PREFIX/` | Required `credential` maps to `{ modal-volume: NAME }` on the host | Mounts the existing Volume's subdirectory, or the entire Volume for an empty prefix. The mapped name must match exactly, including case. Uses the host's configured Modal environment; no query parameters. |

Modal configures CloudBucketMount and Modal Volumes with the declared `read-only` or `read-write` access.
Placement excludes hosts without the named credential mapping. The host checks Modal Volume name
consent before any provider call; missing or mismatched consent refuses the mount with a named reason.
`gs://` and `modal-volume://` are mount-only: copying and artifact storage refuse them.
Native prefixes use literal characters, without percent encoding. Modal bucket mounts refuse
`forcePathStyle=true`, endpoint paths, and an explicit region together with an explicit endpoint;
Modal cannot represent those settings without changing their meaning. No fallback to copying occurs.
Modal Volume names contain 1–64 letters, digits, underscores, dots, or hyphens,
starting with a letter or digit. Volume names cannot contain `..`.

A native source attaches only when the Task sandbox starts. Setup and prepared snapshots cannot
read it. The source stays live and can change during a Task Attempt; no object manifest pins its
contents. The provider-held reference is used only for attachment, never as a sandbox secret or
an environment variable. The catalog records the source and credential name, not the host mapping
or its secret values.

### Volume security

A host's artifact Volume stores captured Task files governed by artifact grants. Workspace mounts
cannot expose that Volume, a parent location, or any location beneath it. These restrictions apply
to `copy` and `mount`. Placement checks advertised artifact Volumes and Volumes with recorded copies;
dispatch checks them again. The Worker Host also checks its own current artifact Volume.

SuperTag compares normalized locations, not source URL strings. For S3-compatible stores, it compares
request hosts and paths, including endpoint paths and bucket subdomains. It checks both path-style
and virtual-hosted addressing, regardless of `forcePathStyle`. For example, an endpoint ending in
`/artifacts` can reach the same bucket as `s3://artifacts` through the server's root endpoint.
`s3://` and `r2://` can identify the same store. The comparison decodes percent encoding and ignores
repeated or trailing slashes. AWS comparisons also ignore signing region and endpoint region.
Distinct prefixes such as `artifacts` and `artifacts-other` remain separate. AWS endpoint forms whose
bucket cannot be identified, such as access points, cannot establish separation from AWS artifact
Volumes and cause refusal.

Google Cloud Storage comparisons fold `storage.googleapis.com`, `commondatastorage.googleapis.com`,
regional `storage.REGION.rep.googleapis.com` endpoints, and their bucket subdomains into one origin.
The `storage.cloud.google.com` browser endpoint shares that origin too.
Unrecognized `googleapis.com` endpoint forms cannot establish separation from GCS artifact Volumes
and cause refusal. Loopback comparisons also fold `0.0.0.0`, `[::]`, and `*.localhost`.
For other stores, origins are compared by host spelling and port. DNS aliases, IP-versus-name
aliases, and alternate ports reaching the same store are not detected. Use the same endpoint
spelling and port for every Volume that reaches that store.

An artifact source that cannot be parsed or read causes refusal instead of an assumption that the
data is elsewhere. Placement can still compare a stored HTTP artifact endpoint to protect its
location without blocking unrelated mounts. This exception only creates a deny rule; mounting an
HTTP source remains forbidden. A refusal names the invalid mount or the artifact Volume that
prevents the comparison.

Dispatched file artifact locations carry no copy credential and grant no mount consent. The host
checks real paths against these protected locations, including aliases. Native mounts refuse
`file://` sources; those sources require the host's explicit consent for copying.
GCS comparisons use bucket and prefix. Modal Volume comparisons use the Volume name and prefix;
the environment comes only from host configuration.

## Field managers and apply sets

A manifest from version control, an operator running `supertag tag put`, and a second team's
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
2. **Omitted and someone else's: kept.** A field set with `supertag tag put` survives.
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
- A manifest has no `status`. `supertag get objective ID` returns the full Objective record as
  JSON.

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

The [collaboration surface guides](../surfaces/README.md#declare-accounts-and-locations-in-manifests) list each
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
- `supertag get surface-account NAME` returns the account as JSON.

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
`PROVIDER:EXTERNAL_ID` as `supertag get surface-account` shows. A **retired** account keeps its row for
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
