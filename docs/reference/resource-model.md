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

CLI resource commands name a kind in lowercase and singular, such as `tag`, `permission-set`,
`context-set`, `role`, `surface-account`, `host`, `task`, `session`, `volume`, `workspace`,
`auth-key`, `operator-token`, and `objective`; `supertag get` also accepts the plural. For
example, `supertag get permission-set` lists [Permission Sets](#configuration-resources). The
[CLI reference](cli.md#supertag-get) lists every kind. Manifest kinds retain
PascalCase names such as `PermissionSet`.

## Runtime components

The **Control Plane** and **Worker Hosts** are SuperTag's two top-level runtime components. The
Control Plane stores the organization and schedules its work, and a Worker Host is a machine,
container, VM, or sandbox that provides the capacity to run it. On each Worker Host a **Worklet**,
the `supertag worklet` program, connects the host to the Control Plane, claims Tasks, and
starts a **Worker** for each Task Attempt: a process of its own that runs a harness adapter and
the harness it drives. The Worklet and the Worker are roles of running programs, not resources
you create or apply. The Worklet holds the host's credential and every lease; a Worker never
receives that credential, and its calls carry a Task Attempt credential that names its one Task
Attempt and ends with its lease. A separate **Gateway** is the service clients connect to: it forwards their calls to the Control
Plane, carries running Task Attempts' data calls under their Task Attempt credentials when the Control Plane names it as the data endpoint, and carries **collaboration surface** traffic as a client of the Control Plane. A collaboration surface is how SuperTag meets people in an external work tool, such as
Slack, GitHub, Lark/Feishu, Linear, or Microsoft Teams: it receives events at a [Tag](#configuration-resources)'s locations and
replies there. A location is a place on a collaboration surface, such as a channel or repository. The Control
Plane serves one API to Worklets and Gateways, and through Gateways to clients. Worker Hosts
supply execution capacity through [harness adapters](glossary.md#harness-adapter), [harnesses](glossary.md#harness),
and [execution environments](glossary.md#execution-environment).

## Configuration resources

- **Tag** — a persistent AI actor with a stable identity, responsibilities, permissions, and
  work history. It holds [Roles](glossary.md#role), a [Mailbox](glossary.md#mailbox), and bindings
  to eligible Worker Hosts. You assign work to a Tag by name. Its configuration, open
  assignments, and results persist across model and harness sessions.
- **Permission Set** — reusable authority to perform surface-backed actions, use harness/runtime tools, or call tools of MCP servers.
  A permission can carry `approvalRequired: true`, and `spec.approvers` lists the operators
  (`operator:<id>`) and clients (`client:<name>`) that may decide. See [IAM approval](iam.md#approval).
- **Context Set** — reusable knowledge and [Skills](glossary.md#skill) that may enter a Task.
- **Role** — passive reusable policy for a responsibility, combining instructions, Context Sets, and Permission Sets.
- **Volume** — a named storage location, a directory or an S3 bucket prefix: a Workspace Volume
  whose data Tasks receive as copies, or an artifact Volume that holds artifact copies; see
  [Volumes](#volumes).
- **Workspace** — a named repository that a Tag's Tasks work in. A Worker Host maps a local
  repository to it by name, or a remote Workspace names a repository on any git server; see
  [Workspaces](#workspaces).
- **Workspace Credential** — what git delivery presents to a remote Workspace's git server: an
  SSH key, an HTTPS token, a git credential helper, or a GitHub App. The Control Plane stores its
  name, kind, and a non-secret identifier; the secret stays in the credential vault of the
  machine that runs the Control Plane. See [Workspace Credentials](#workspace-credentials).
- **Surface Account** — an enrolled external workspace or account; credentials remain in the
  credential vault. `supertag setup surface` enrolls one interactively, and a SurfaceAccount
  manifest declares one; see [Declared Surface Accounts](#declared-surface-accounts).

Roles, Permission Sets, and Context Sets are shared resources. A Tag lists the Roles it holds. A set
can be activated directly at one of a Tag's locations when it is situational, or referenced by a Role when it
follows an enduring responsibility. Team membership places the Tag in the organization; the Task
gives it current direction. A Tag's Worker Host bindings define where its Tasks may run; the
scheduler then chooses a compatible harness and model on one of those hosts. None of these resources becomes a separate actor.

## Operational resources

- **Objective** — an outcome a Tag owns, with a budget, a deadline, a status and an explicit
  completion assessment. It is a conversation with a goal: it talks in the thread it was created
  in, and the work happens in Sessions started beneath it. Set `ongoing: true` for a continuing
  responsibility that only an operator can end. An Objective may name one Team, whose members its
  owner may start work Sessions of. See [Objective coordination](coordination.md#objectives).
- **Team** is a flat list of member Tags with an optional concurrency limit. Members may message
  one another and share the Team's Workstream. A Team stands alone: any number of Objectives may
  name one Team. See [Teams](coordination.md#teams).
- **Workstream** is a Team's shared record of posts. Every member reads it. Each Tag a post
  addresses receives it in its Mailbox, and an unaddressed question or blocker goes to the
  Objective's owner Tag; other posts wake nobody. See
  [Workstream](coordination.md#workstream).
- **Mailbox** is a Tag's inbox for plain-text messages from other Tags. Each message has a type:
  note, question, blocker, evidence, or decision. Every message waiting when a turn starts is
  handled together in that turn, and a message counts as seen once a turn takes it. A Team's
  `spec.wakeLimits` overrides the [wake limits](coordination.md#wake-limits). See
  [Mailbox](coordination.md#mailbox).
- **Session** preserves automatic continuity for one Tag conversation. The `audience` field is
  `shared` or `private`. A direct chat or a conversation in the desktop app is private to one
  person. One Session does not read another's transcript. See
  [across Sessions](../concepts/multiplayer.md#across-sessions-one-tag-many-conversations). A [work Session](../concepts/tasks.md#session)
  reports its conversation as `parent_session_id`. In `supertag get session`, `latest_task_state`
  is the state of a work Session's latest Task, `tag_id` its Tag, and `title` its title.
- **Task** records one turn of a Session.
- **Schedule** wakes one Tag later in one Session, once (`at`) or on a recurrence (`every`, a cron
  expression in a time zone). When it is due, the Control Plane queues an ordinary Task; it never
  starts a run. A Tag creates one with its `schedule` tool; an operator or client creates one in
  its own conversation with `supertag schedule create`. See [Schedules](coordination.md#schedules).
- **Memory** is a Tag's notebook: short notes it keeps with its `remember` and `forget` tools,
  each shared or private to one person's conversation. People list and delete notes; they never
  write them. See [Memory](coordination.md#memory).
- **Task Attempt** records one execution or retry of a Task on a Worker Host.
- **Landing** records where git delivery put one Session's changes; see [Landing](#landing).
- An **approval request** records one ask for a decision on a gated action, with its scope and
  decider. It is operational state listed with `supertag get approval`, not an applied resource.
  See [Approval requests](coordination.md#approval-requests).
- **Worker Host** is the durable enrolled identity and latest observed capacity, capability,
  health, and scheduling state of one execution location.
- **Auth Key** is an operator-issued join secret. Redeeming it enrolls a new Worker Host bound to
  the key's Tags, a Gateway, or a client device, by the key's role. See [Auth Keys](#auth-keys).
- **Operator Token** is a named management credential that the [admin token](glossary.md#admin-token)'s holder issues to one
  teammate or machine. SuperTag records the changes it makes under its name. See
  [Operator Tokens](#operator-tokens).

Each Worker Host's Worklet reports that state to the Control Plane over its own connection. A per-host
credential binds the connection to that Worker Host. Rotation and
revocation block older connections without exposing credentials through ordinary resource reads.
A **connection generation** is the increasing number that identifies the current connection.

Most of these records are inspectable but not declaratively applied. An Objective, with the Team
it names, may also be declared in a manifest; see [Declared Objectives](#declared-objectives). So
may a recurring Schedule; see [Declared Schedules](#declared-schedules).
Otherwise an Objective comes from `supertag objective create` or a person's `/goal` message,
a Team from `supertag team create`, a Schedule from a Tag's `schedule` tool or
`supertag schedule create`, and a note of a Tag's Memory from its `remember` tool. A Team's Workstream exists with the Team. Status is never
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
```

A manifest has exactly `apiVersion`, `kind`, `metadata.name`, and `spec`; any other field, such
as `status`, is refused. The Control Plane owns everything else it reports, such as revisions and
phases, and `supertag get KIND NAME` prints it as JSON.

The relationship between Tags and Roles follows that same boundary: `Tag.spec.roles` is desired
configuration; `supertag get role-assignment` lists the resulting assignments. A Tag's Worker Host
bindings are not a manifest field: a host that joins with an Auth Key is bound to each of the key's
Tags, and a host in the same `supertag.yaml` as its Control Plane may run every Tag. A Tag with no
bound host waits for one. Storage records used to
preserve policy across admission and recovery are internal implementation details rather than
additional resources.

More Tag fields declare where its Tasks run, where the Tag works, and who may message it:

| Field | Entry | Meaning |
| --- | --- | --- |
| `spec.runsOn` | label | Labels a bound Worker Host must carry to run the Tag's Tasks. See [Worker Host labels](#worker-host-labels). |
| `spec.workspace` | `id`, `baseCommit` or `ref`, `mcp` | The Workspace the Tag's Tasks work in, the commit new Sessions start from or the local branch whose current commit they start from, and the `.mcp.json` servers they may use. See [Workspaces](#workspaces). |
| `spec.acceptsMessagesFrom` | Tag name | Mailbox grants where this Tag is the recipient |
| `spec.lead` | `true` or `false` | Whether this is the Control Plane's **lead Tag**. Omitted keeps the current value. |
| `spec.maxWorkSessions` | 1 to 64 | How many work Sessions the Tag may have open at once, 8 by default. Omitted keeps the current value. See [Open work Sessions](coordination.md#open-work-sessions). |
| `spec.memory` | `true` or `false` | Whether the Tag keeps [Memory](coordination.md#memory): notes it writes and a daily review. Omitted keeps the current value; a new Tag keeps memory. |
| `spec.volume` | A Volume ID, or `""` | Keeps the Tag's work beyond any one Worker Host: the capturing host's Worklet writes a copy of every capture there, and a capture fails when its copy cannot be written. Its Sessions' checkpoints live there too, so any host that reaches the Volume resumes them; see [Session checkpoints](control-plane.md#session-checkpoints). A file Volume places the Tag only on hosts that map it. Omitted keeps the current value. See [Keep every capture on a Volume](artifacts.md#keep-every-capture-on-a-volume). |
| `spec.startRate` | `starts` (1 to 10,000) and `per` (`1m` to `7d`) | At most how many of the Tag's Task Attempts start per period; `starts: 0` removes it. Omitted keeps the current value; a new Tag has none. See [Start rates](scheduling-and-recovery.md#start-rates). |

Where a Tag answers is a separate `SurfaceLocation` resource, a Tag **location**. It names the
Tag, a channel, repository, chat, or team of a Surface Account, and the Permission Sets and Context Sets
it activates there. `supertag tag update TAG --add-location PROVIDER` creates one for a local
Gateway. See [Manage resources](../operations/resources.md).

The lead Tag is the Control Plane's default Tag: `supertag init` makes the Tag it creates the lead,
and the desktop app shows it first. At most one active Tag is the lead; making
a second one the lead is refused with the name of the current one, so clear that one first with
`lead: false` or `supertag tag put TAG --lead false`. Retiring the lead Tag leaves no lead.

Each `acceptsMessagesFrom` entry names one sender Tag this Tag accepts messages from. Tags that
share a Team need no entry. See [Mailbox](coordination.md#mailbox).

Apply merges each of these lists entry by entry, and records who set each entry. See
[Field managers and apply sets](#field-managers-and-apply-sets).

## Auth Keys

An Auth Key lets a principal join a Control Plane without copying a credential file. An operator
creates it for one role, and the enrollee redeems it from its own side, choosing its own name:

| Role | Enrolls | Redeemed with |
| --- | --- | --- |
| `host` | A Worker Host | `supertag host enroll HOST_ID`, or a host service's `auth-key` in `supertag.yaml` |
| `gateway` | A Gateway | `supertag gateway enroll` |
| `client` | A device running the CLI or desktop app | `supertag connect URL --name NAME` |

```sh
supertag auth-key create ci --role host --tag builder --label linux-ci --reusable --ephemeral
```

The secret starts with `stak_` and is printed once. `supertag get auth-key ci` then shows the key
without it:

| Field | Meaning |
| --- | --- |
| `role` | `host`, `gateway`, or `client`. It never changes. |
| `allowed_tag_ids`, `all_tags` | Host keys: the Tags every joining host may run. Client keys: the Tags the device may talk to. `--all-tags` names every Tag. |
| `labels` | Host keys: labels granted to every host that joins. See [Worker Host labels](#worker-host-labels). |
| `reusable` | `false` (default): the key enrolls one principal. `true`: it enrolls any number. |
| `ephemeral` | Host keys: hosts that join are removed after they disconnect. See [Ephemeral Worker Hosts](#ephemeral-worker-hosts). |
| `phase` | `active`, `used` (a one-time key after its first enrollment), `expired`, or `revoked`. |
| `expires_at_ms` | At most one hour for a one-time key and 90 days for a reusable key; `--expires-in-seconds` shortens it. |

The rules:

- The Control Plane stores only a digest of the secret, and `get` never shows it.
- Only operators create, read, and revoke Auth Keys. Tags cannot.
- Keys have no update. To change one, revoke it with `supertag auth-key revoke NAME` and create
  one under a new name. Names are never reused.
- Revoking a key blocks new enrollments. Principals that already joined stay enrolled.
- An enrolling host chooses its Worker Host ID. With a reusable key, an ID already taken enrolls
  as `ID-2`, `ID-3`, and so on. IDs are never reused.
- Enrollment is atomic. Under concurrent use, a one-time key still enrolls exactly one principal.
- Auth Keys are imperative only. They do not appear in manifests, and `supertag apply` rejects
  them.

### Ephemeral Worker Hosts

An ephemeral Worker Host suits a CI job or a short-lived container. Its `ephemeral` field is
`true`. After it stays disconnected for 30 seconds, the Control Plane removes it: the host is
revoked and unbound from its Tags, and `supertag get host ID` shows when it was removed in
`removed_at_ms`. A host that joined but never connected is removed after ten minutes.

Persistent hosts keep the stricter recovery rule: a Task Attempt whose outcome is unknown keeps its
capacity until the host's Worklet reports evidence. An ephemeral host cannot come back after removal, so its
interrupted Task Attempts count as stopped, and their Tasks run again on another host. The usual
retry limits apply. See [Leases and unknown outcomes](scheduling-and-recovery.md#leases-and-unknown-outcomes).

#### Storage durability

A Worker Host's storage is ephemeral or persistent, and its `ephemeral` field decides it. An
ephemeral host's Task files and artifact copies go with it when it is removed. Every other host
is persistent: [host services](glossary.md#host-service) that `supertag up` starts on your
machine, and hosts that enrolled without an ephemeral key. A remote sandbox, such as on Modal or
E2B, is always ephemeral: its Task files are lost when the sandbox stops, whatever host started
it.

The Control Plane stores no artifact bytes, so an ephemeral host's artifacts are lost with it
unless they were copied to a Volume. See [Artifacts](artifacts.md#where-artifact-bytes-live).

## Operator Tokens

An Operator Token lets one teammate or machine manage a shared Control Plane without the admin
token. Each token has a name, and SuperTag records what it does as `token:NAME`. When a teammate
leaves or a laptop is lost, revoking that one token is enough; nobody else's access changes.

```sh
supertag operator-token create laptop-2
supertag get operator-token laptop-2
```

`get operator-token` shows a token without its secret:

| Field | Meaning |
| --- | --- |
| `phase` | `active`, `expired`, or `revoked`. |
| `operator_id` | The operator ID recorded for the token's changes, such as `operator:token:laptop-2`. |
| `expires_at_ms` | 90 days after the token was created or last rotated. |
| `last_used_at_ms` | The last request the token authenticated, updated at most once a minute. |
| `rotated_at_ms`, `secret_revision` | The last `supertag operator-token rotate` and how many secrets the token has had. |
| `revoked_at_ms` | When the token was revoked. |

The admin token and Operator Tokens differ in one way:

| Credential | Can |
| --- | --- |
| Admin token | Everything, including creating, listing, rotating, and revoking Operator Tokens. Changes are recorded under the Control Plane's configured operator ID, such as `local`. |
| Operator Token | Everything else the admin token can: apply and delete resources, create Auth Keys, create and direct Objectives, decide approvals, message, cancel, and read. Changes are recorded as `token:NAME`. |

The rules:

- The secret starts with `stop_`. It is shown once, when the token is created. The Control Plane
  stores only its SHA-256 digest and compares digests in constant time. `list` and `get` never show
  the secret.
- Tokens have no update; `rotate` replaces the secret and keeps the name. Names are never reused, so `token:NAME` always means one token.
- Revoking a token refuses it on the next request. An expired token is refused the same way.
- Approval policies can name a token as an approver: `operator:token:laptop-2`.
- Operator Tokens are imperative only. They do not appear in manifests.

## Worker Host labels

A label is a short placement hint on a Worker Host, such as `macos`, `gpu`, or `workspace:app`.
Bindings and labels answer different questions:

- A Tag's bound Worker Hosts are the hosts that may run its Tasks: those whose Auth Key named the
  Tag, and a local host service, which may run every Tag.
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
  runsOn: [macos, arm64]
```

A label is 1-63 lowercase letters, digits, dots, colons, hyphens, or underscores, starting with a
letter or digit. SuperTag lowercases labels and matches them exactly. There is no selector
language. A host carries three kinds of label:

| Kind | Labels | Set by |
| --- | --- | --- |
| Automatic | `linux`, `macos`, or `windows`; `x64` or `arm64`; `harness:NAME` for each harness; `workspace:NAME` for each declared checkout; `mcp:NAME` for each [MCP server in the host's catalog](../surfaces/worker-tools.md) | The Worker Host |
| Declared | Any label, such as `gpu` | A [host service's `labels`](supertag-yaml.md#host-labels) in supertag.yaml, or `supertag worklet --label LABEL` |
| Granted | The Auth Key's `spec.labels` | The Auth Key the host joined with |

`labels` in `supertag get host ID` lists all of a Worker Host's labels. `granted_labels` lists those its
Auth Key granted. Automatic and declared labels come from the host's latest connection and are
self-reported: a host can claim any label. Labels therefore decide placement only. They never grant
access, and a Tag's bindings stay the only way to let a host run its Tasks.

A Task in a named Workspace runs only on a bound host that serves it and so carries
`workspace:NAME`: a host that maps the local Workspace, or, for a remote Workspace, a host that serves it
(`--remote-workspace NAME`, or `remote: true` in `supertag.yaml`). The host must also carry the Tag's `runsOn` labels. When no
bound host carries the required labels, the Task waits. Its
scheduling record names the requirement, such as `labels:macos,gpu`, and `supertag describe task`
prints `No bound Worker Host has labels: macos, gpu`. The list names the labels no bound host
carries; when each label exists on some host but none carries them all, it names every required
label. For an `mcp:NAME` label, it also names the missing MCP server, such as `No bound Worker Host
provides MCP server sentry`.

A Task granted `commands:execute` also skips an **unsandboxed harness**: one that runs commands
as the host's user, without an operating-system sandbox: Claude Code, Cursor, or OpenCode on a
local host (any of them on a local-vm host, or with an E2B or Modal Workspace, runs
commands in its container or sandbox instead, and so does Claude Code on a host with
`sandbox-commands`). It
runs on one only when the host service lists it in `allow-unsandboxed-commands`. Otherwise it runs
on another Worker Host, such as one serving Codex, or waits. See
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
    models: [gpt-6-sol]        # allowed models; the first is the default
    efforts: [medium, high]    # allowed efforts; the first is the default
```

`spec.execution` takes the same fields on a Role and on a Tag:

| Field | Value | Meaning |
| --- | --- | --- |
| `harness` | One harness name, such as `codex` or `claude-code` | Tasks run only on that harness. |
| `models` | A list of model IDs | Each is allowed, and the first is the default. |
| `efforts` | A list of `low`, `medium`, and `high` | Same rule as `models`. |
| `sharedExecutionEnvironmentId` | One shared execution environment ID | New Cursor Sessions run in that environment. Requires `harness: cursor` or no harness. |

A `harness` or `models` left out allows anything the Worker Host offers and uses the host's
default. Effort is different: when neither the Tag nor its Roles set `efforts`, Tasks start at
`low`, and `medium` and `high` stay allowed. An `efforts` list keeps its own first value as the
default. Starting low keeps routine work cheap; the actors raise effort when work needs it. A Role sets
the default and allowed range for its Tags. A Tag's own `spec.execution` overrides its Roles' field
by field, so the Tag wins. When several Roles set a field, the first Role by name wins. A Role's
models apply only to its own harness: a Tag on another harness does not inherit them.
A Tag keeps the harness it was created with; changing `harness` on an existing Tag is refused, so
create a new Tag for another harness. A work Session may name another harness with
`start_session`; see [work Sessions](../concepts/tasks.md#other-sessions).
`supertag describe tag` prints the resulting range.

Each harness maps effort to its own option. Codex receives it as `model_reasoning_effort`, and
Claude Code receives it as its effort option. OpenCode has no effort option, so it ignores effort
and the Task Attempt records that it did.

When SuperTag accepts a Task, it records one harness, model, and effort for it, from the acting
Tag's own range. See
[Scheduling and recovery](scheduling-and-recovery.md#placement-by-harness-and-model).

`execution` is one field under the [field manager rules](#field-managers-and-apply-sets): one
manager owns all its settings together. `supertag get role NAME` and `supertag get tag NAME`
print it as JSON. Tags and Roles without `execution` run on
whatever harness and model their Worker Hosts offer, starting at low effort.

## Workspaces

A **Workspace** is a named repository that a Tag's Tasks work in. Each Task Attempt gets its own
checkout of the Workspace at an exact commit, and its changes come back as a branch or a patch,
or land on a git server. A Workspace has one of two sources:

- **A local Git repository** that a Worker Host maps by name: a host service's `workspaces` in
  `supertag.yaml`, or `--workspace-id ID --workspace-source PATH` on `supertag worklet`.
  Several hosts may map the same name to their own clones. The Control Plane stores no record of
  it.
- **A remote Workspace**: a repository on any git server, declared as a `Workspace` resource.
  Hosts that serve it (`--remote-workspace NAME`) read each Session's source from the
  server themselves, with the read Workspace Credential the Control Plane grants for that one
  read, so they need no clone and store no credential.

```yaml
apiVersion: supertag/v1
kind: Workspace
metadata:
  name: handbook       # 1-80 letters, digits, '.', '-', or '_', starting with a letter or digit
spec:
  remote: ssh://git@git.acme.internal/handbook.git   # https://, ssh://, user@host:path, or file://
  ref: main                     # optional: the branch new Sessions start from; default branch if omitted
  credential: handbook-rw       # or credentials: { read: NAME, push: NAME }; omit for none
  land: { merge: drafts }       # optional: { merge: TARGET } or { review: { base: BRANCH } }
  forge: github                 # optional: a self-hosted GitHub; github.com needs no forge
```

| Field | Rules |
| --- | --- |
| `remote` | `https://` or `ssh://` URL, scp-style `user@host:path`, `file:///absolute/path` for a bare repository on the Control Plane's machine (readable only by hosts that share its filesystem), or `http://` to a loopback address. Never a password, token, or `ext::` helper |
| `ref` | A branch name. Each new Session pins the commit it names once; every Task of the Session starts there |
| `credential`, `credentials` | Names of [Workspace Credentials](#workspace-credentials) that must exist. `read` reads the source; `push` lands changes |
| `land` | Every delivered Task updates the Session's branch `supertag/session/HASH`, with or without `land`. `{merge: TARGET}` also merges a finished Session into `TARGET`, a branch outside `supertag/`. `{review: {base: BRANCH}}` also opens or updates the Session's draft pull request against `BRANCH`; it needs a GitHub forge and a GitHub App or HTTPS token push credential. |
| `forge` | `github` for GitHub Enterprise Server, whose API is `/api/v3/` on the remote's host. A github.com remote is GitHub without it; any other remote is a plain git server, which has no review |

A Tag names its Workspace in `spec.workspace`:

```yaml
apiVersion: supertag/v1
kind: Tag
metadata: { name: builder }
spec:
  roles: [Builder]
  workspace: { id: app, baseCommit: 4f2c0d1e9b8a7c6d5e4f3a2b1c0d9e8f7a6b5c4d, mcp: [docs-search] }
```

A local Workspace needs a full `baseCommit` or a `ref`, never both. New Sessions start from the
base commit, and later Tasks of a Session continue on the Session's branch,
`supertag/session/HASH`. `ref` names a local branch, such as `main`, instead: the Worklet
that starts a Session's first Task records the commit the branch names in its host's checkout, and the
whole Session works from that commit. See
[Follow a branch instead of a commit](../guides/workspaces.md#follow-a-branch-instead-of-a-commit).
A remote Workspace omits both. `mcp` selects servers from the `.mcp.json` at the base commit. The Tag's Tasks run only on
hosts that serve the Workspace. An Objective has no Workspace of its own: its turns work in the
Workspaces of the Tags that run them.

A local Workspace's `land` lives in its host service's `workspaces` entry in `supertag.yaml`; see
[supertag.yaml](supertag-yaml.md).

### Workspace Credentials

A Workspace Credential is created on the machine that runs the Control Plane with
`supertag workspace credential add NAME`, and one of:

| Kind | Flag | Identifier the Control Plane stores |
| --- | --- | --- |
| SSH key | `--ssh-key PATH`, optionally `--known-hosts PATH` | The key's SHA256 fingerprint |
| HTTPS token | `--https-token` (from `SUPERTAG_WORKSPACE_TOKEN` or a hidden prompt), `--username` | The user name |
| Credential helper | `--credential-helper HELPER` | The helper's program name |
| GitHub App | `--github-app --app-id ID --installation-id ID --private-key PATH` | `app:ID/installation:ID` |

A GitHub App credential reaches only `https://` GitHub remotes. For each operation git delivery
mints a token for the one repository with only what that operation needs: `contents: read` to read,
`contents: write` to push, and `pull_requests: write` to open or update a review's pull request.
Tokens are never stored. The key is a separate copy from any the GitHub surface keeps.

The secret goes to the credential vault the Control Plane reads (`SUPERTAG_CREDENTIAL_VAULT`,
in `SUPERTAG_STATE_DIR` by default) under `workspace-credential/NAME`, never to the database or a
harness. A Worklet that reads the Workspace gets it, or a minted GitHub App token, for that one
read and keeps it only in memory; a credential helper is never handed to a host, so hosts can't
read with one. An SSH key without `--known-hosts` trusts the server's first host key and
remembers it, on the Control Plane and in each Worklet separately. `supertag workspace credential remove NAME` refuses while a Workspace names it.

### Landing

The Worklet that ran a Task lands its verified commits on a remote Workspace's server, from
its own copy of them, right after the Task finished: the harness never pushes. Every delivered
Task updates the Session's branch; `land` adds a merge or a review. The Worklet pushes only
`supertag/session/...` branches and the Workspace's merge target, fast-forward only, whatever the
credential could do. A review's pull request is opened by the Control Plane's git delivery once the
branch is pushed. Git delivery then reads each Session's latest landed branch back with
`ls-remote`; a branch that no longer names the delivered commit was changed outside SuperTag, and
the landing's `reason` says so. That detects such a change but cannot prevent it: protect
`supertag/**` and your target branches on the server. A Landing's state:

| State | Meaning |
| --- | --- |
| `queued` | Waiting for the Worklet that holds the delivery, or, for a pushed review branch, for git delivery to open its pull request |
| `claimed` | A Worklet is pushing, or git delivery is opening the pull request |
| `landed` | The branch or target names `landed_commit`; in review mode, `pull_request` is open from the branch |
| `conflict` | The Session's changes conflict with the target in `conflicts`; nothing was merged, and `follow_up_task_id` merges `target_commit` into the Session |
| `held` | Refused until someone acts, such as a branch changed outside SuperTag, a missing credential, or Git LFS |
| `superseded` | A newer delivery of the same Session replaced it before it landed |

`merge` lands a Work Session when its Tag or an operator closes it or its Objective closes, and
again when a merge follow-up Task succeeds. `review` pushes every delivered Task's branch, then
opens the Session's draft pull request or updates its title and description; it never merges,
closes, reopens, or marks it ready, and holds the landing when the pull request was closed or the
branch has another one. The pull request's merge, reported by the GitHub surface's webhook, closes
the Work Session with the reason `merged`. Merge commits are authored by the Tag's name with a
SuperTag no-reply address, with the requester as a `Co-authored-by` trailer. Content checks are the
server's job: SuperTag runs no tests or hooks before landing.

Volumes attach copies of data outside the checkout with `supertag tag put --workspace-mounts`. See
[Work in a repository with Workspaces](../guides/workspaces.md) and
[Workspace staging](worker.md#workspaces).

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
Worklet whose `--workspace-mount-mappings` maps that exact Volume, credential name, and
destination root claims the Task; a retargeted Volume leaves queued Tasks unplaceable.

The Worklet stages each copy for one Task Attempt and removes it when the Task Attempt ends.
A copy holds at most 10,000 files and visits at most 40,000 entries, and one Task Attempt copies
at most 20 GiB across its copies. Links, hard-linked files, files on another filesystem, and the
names `.git` and `.supertag-*` are refused. A remote E2B or Modal Workspace receives the staged
files at `volumes/<digest>/<name>` inside its checkout; the returned tree never includes them.
Read-only provider-native Modal Volume mounts are on the backlog.

### Read-write copy contract

After a successful Task Attempt, the Worklet writes each changed and created regular file of a
read-write copy directly to its Volume: to a `file://` directory without following links, or to
`s3://` with a streamed, signed `PUT`. It never writes deletions or links, and a failed or
cancelled Task Attempt writes nothing. Before the first write it refuses more than 1,000 changed
files, any file over 5 GiB or the copy's `maxBytes`, a changed total above `maxBytes`, and names
the Volume cannot hold. A refusal writes nothing. Writing in key order stops at the first failure.

Each copy's summary records `volume_id`, `destination`, `status` (`complete`, `partial`, or
`refused`), written `files` with `key`, `size`, and `sha256`, `skipped`, an `error` with `key` and
`reason` when present, and `not_attempted`. `supertag describe task ID` shows it as the Task's
mount writes. A `partial` or `refused` write-back fails the Task.

## Volumes

A Volume names a place where data lives outside git, such as a dataset in a bucket or a directory
on the Worker Host. Volumes are Experimental. There are two kinds, registered separately:

- A **Workspace Volume** holds data Tasks receive as copies; see
  [Workspace Volume copies](#workspace-volume-copies).
- An **artifact Volume** keeps a Tag's work beyond any one Worker Host, such as a copy of every
  capture, when a Tag names it as its `volume`; see
  [Keep every capture on a Volume](artifacts.md#keep-every-capture-on-a-volume).

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
revision. Changing a source is a new revision.

An artifact Volume is registered with `supertag volume put NAME --source SOURCE --operation-id ID`
or a manifest,
whose only field is `spec.source`:

```yaml
apiVersion: supertag/v1
kind: Volume
metadata: { name: archive }
spec:
  source: s3://acme-artifacts/archive
```

`supertag get volume` lists artifact Volumes. The Control Plane maps none of them and carries no
Volume byte: Worklets write and read them, a file Volume through each host's own `--volume`
mapping, an S3 Volume through URLs the Control Plane presigns with the credential `supertag volume
credential set` stores in its vault. For what a Volume keeps when a sandbox or host dies, see
[Persistence](../concepts/persistence.md).

### Volume security

An artifact Volume stores captured Task files governed by artifact grants. Workspace Volume copies
cannot expose an artifact Volume, a parent location, or any location beneath it. Placement checks
registered artifact Volumes; dispatch checks them again. Every host that maps a file Volume, and
anyone holding an S3 Volume's credential, can read every Tag's data on it: use one Volume per
trust domain.

SuperTag compares locations, not source URL strings. File paths compare by component, and on
macOS also case- and Unicode-insensitively, so `/srv/Data` and `/srv/data` are one location.
Because no source carries an endpoint, an `s3://` Workspace Volume compares with an S3 artifact
Volume by bucket name and nested prefix on any endpoint, and SuperTag refuses an overlap in either
direction. So an endpoint alias, such as a virtual-hosted or path-style spelling of the same store,
cannot expose artifact storage to a Task. Distinct prefixes such as `artifacts` and
`artifacts-other` remain separate.

The Worklet checks its mappings again against its own state, its Workspaces, home
configuration, and the artifact paths the Control Plane discloses for each Task Attempt. It
compares real paths and directory identities, so a bind mount or link that reaches protected
storage under another spelling is refused.

## Field managers and apply sets

A manifest from version control, an operator running `supertag tag put`, and a second team's
manifest may all change one Tag. SuperTag records which writer last set each field, so one writer
does not silently undo another.

A **field manager** is the name recorded for that writer:

| Field manager | Writes |
| --- | --- |
| `apply` | `apply -f` without `--set` |
| The set name | `apply -f` with `--set NAME` |
| `provision` | Resources a `control-plane` service's `provision` creates on `supertag up` |
| `cli` | Imperative commands such as `tag put`, `placement runs-on`, and `mailbox-grant allow`, Worker Hosts joining with an Auth Key, and any other change made outside apply |

A field is either one value or one entry of a list. Each entry of a Tag's `spec.roles`,
`spec.runsOn`, and `spec.acceptsMessagesFrom` has its own manager. Every other field, such as a
Role's `spec.purpose`, a Permission Set's `spec.permissions`, or a Team's `spec.members`, is a
single value. Messages name fields by path, such as `spec.purpose` or `spec.roles[Builder]`.

Apply follows four rules for each field:

1. **Omitted and yours: removed.** A field this manager set that the manifest now omits is removed.
   A single value returns to its default.
2. **Omitted and someone else's: kept.** A field set with `supertag tag put` survives.
3. **Changed and someone else's: conflict.** Apply refuses and names the field and its manager.
   `--force-conflicts` applies the change and moves the field to the applying manager.
4. **Same value: no conflict.** Setting the value another manager already set moves the field to
   the applying manager. Each field has one manager.

Imperative commands keep their own rule: they change only what they name. SuperTag stores a digest
of each field's value when apply writes it. A field whose value later differs changed outside
apply, so it belongs to `cli`. A resource with no record belongs entirely to `cli`, so its first
apply conflicts rather than deletes.

An **apply set** is a named group of resources that one input declares. `--set NAME` records every
resource in the input as a member of that set, and writes as field manager `NAME`.
A resource belongs to at most one apply set; applying it under another set moves it. `--prune`
removes the set's members that the input no longer lists, as [Deletion](#deletion) describes,
and keeps, and reports, a member that is still in use. A kept member stays in the set for the next prune. See
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
  ownerTagId: maintainer
  outcome: Keep dependencies current and the build green. Open a pull request for each upgrade.
  ongoing: true
  team: upkeep
  budgetLimitMinor: 50000
  budgetCurrency: USD
  deadline: "2027-01-01T00:00:00Z"
  runtimeActions: [files:write]
```

| Field | Meaning |
| --- | --- |
| `metadata.name` | The Objective ID. |
| `spec.ownerTagId` | Required. The owner Tag. |
| `spec.outcome` | Required. One natural-language statement of the outcome. |
| `spec.ongoing` | `true` for a responsibility that only an operator ends. Default `false`. |
| `spec.team` | An existing Team, declared as its own `Team` manifest or created with `supertag team create`. |
| `spec.budgetLimitMinor`, `spec.budgetCurrency` | The budget, in minor units of an uppercase currency. |
| `spec.deadline` or `spec.deadlineMs` | An RFC 3339 time with a time zone, or milliseconds since the epoch. |
| `spec.runtimeActions` | Runtime actions its turns may receive. Omitted: what the owner's Permission Sets allow when it is created. |

Applying an Objective that does not exist creates it and queues its owner's first turn, as
`supertag objective create` does. Applying it again leaves it alone: change a running Objective
with `objective set-limits`, `set-runtime-actions`, `pause`, `resume`, `cancel`, or `complete`.
`supertag get objective ID` returns the full Objective record as JSON.

## Declared Schedules

A Schedule manifest declares a recurring wake-up, such as a weekly summary, beside the Tag that
does it. Operators only.

```yaml
apiVersion: supertag/v1
kind: Schedule
metadata:
  name: weekly-summary
spec:
  tag: lead
  every: "0 9 * * MON"
  timeZone: Europe/Berlin
  note: Summarize open work and what is blocked.
```

| Field | Meaning |
| --- | --- |
| `metadata.name` | The Schedule ID: 1 to 63 lowercase letters, digits, and hyphens. |
| `spec.tag` | Required. The Tag's ID. It cannot change once the Schedule exists. |
| `spec.every` | Required. A cron expression. Occurrences are at least an hour apart. |
| `spec.timeZone` | An IANA name. Omitted: the Control Plane's time zone. |
| `spec.note` | Required. What the Tag should do when woken, up to 4,000 characters. |

The Schedule fires in the applying operator's conversation with the Tag. Applying it again with a
changed `every`, `timeZone`, or `note` updates it in place, keeps its history, and moves its next
time to the next occurrence. A paused Schedule stays paused; a deleted one becomes active again.
A one-off Schedule cannot be declared; use `supertag schedule create --at`. Each field has a
[field manager](#field-managers-and-apply-sets), and `apply --set NAME --prune` deletes a Schedule
the set no longer declares.

## Declared Surface Accounts

A SurfaceAccount manifest records a connected account's identity and the Gateway that serves it.
It holds no secret: credentials reach that Gateway's vault through `supertag setup surface` or
`supertag gateway credential store`, on the Gateway's machine. A SurfaceLocation manifest binds
one place of that account to a Tag and its policy:

```yaml
apiVersion: supertag/v1
kind: SurfaceAccount
metadata: { name: acme-slack }
spec:
  identity: { provider: slack, teamId: T0123456789 }
  enabled: true
  gateway: local
---
apiVersion: supertag/v1
kind: SurfaceLocation
metadata: { name: eng-channel }
spec:
  accountId: acme-slack
  connectorAccountId: T0123456789
  tagId: lead
  scope: { provider: slack, channelId: C0123456789 }
  enabled: true
  permissionSets: [local-tools]
  contextSets: []
```

| Field | Meaning |
| --- | --- |
| `spec.identity` | The provider and the account's provider ID, such as a Slack `teamId`. |
| `spec.enabled` | Whether the account admits work. |
| `spec.gateway` | The enrolled Gateway that serves it, by the `NAME` of `gateway:NAME`. |

The [collaboration surface guides](../surfaces/README.md) list each provider's identity and scope
fields. `supertag get surface-account NAME` returns the account as JSON.

## Deletion

`supertag delete` removes a Team, Permission Set, Context Set, Volume, Workspace, or surface
location. Tags and Roles are retired instead, and Objectives and Schedules cancelled; none is
erased. Deletion
never erases history, and it refuses a resource that is still in use:

| Resource | Refused while |
| --- | --- |
| Team | An Objective that names it is still open |
| Permission Set, Context Set | A Role lists it, or a surface location activates it |
| Volume | Reserved or verified artifact copies depend on it, or a Tag names it as its `volume` |
| Workspace | Given an out-of-date `--expected-revision` |
| A surface location | Given an out-of-date `--expected-revision` |

`supertag tag retire TAG` retires a Tag, and putting a Role with `status: retired` retires the
Role. A **retired** Tag keeps its row, so Tasks, Sessions, approval requests, Objectives, and
artifacts keep pointing at it. It receives no work, cannot be messaged, and Auth Keys that name it
can no longer join. `get tag` without an ID omits retired Tags; `get tag ID` still returns one. A
new Tag may reuse a retired Tag's name; it gets a new ID.

Deleting a set or Workspace does not change history, because each Task keeps the policy and
Workspace recorded when SuperTag accepted it. `apply --set NAME --prune` deletes the set's members
that the input no longer declares, by the same rules.

## Internal coordination

Each Tag has one Mailbox: plain-text messages from other Tags, handled together in one turn of
the Tag's inbox. Mailboxes are not separately configured. Tags in one Team message each other
without a grant; across Teams, a grant records that a recipient accepts messages from a sender.
Delivery grants no execution authority. See [Mailbox](coordination.md#mailbox) and
[Send messages between Tags](../guides/tag-messaging.md).

A message from the CLI or a reply in the Objective's home thread delivers its next
turn. The owner uses `ask` to put a question to a person. A message grants no authority and
changes no budget. See
[Operator messages](coordination.md#operator-messages).

A harness exposes these tools only to its root harness actor. Native subagents acquire no Tag
identity and no Mailbox; they coordinate through the harness's local primitives. See
[Coordination tools](coordination.md#coordination-tools).

Each Team has one [Workstream](../guides/workstreams.md), its shared record of posts. Every
member reads it, an unaddressed note wakes nobody, and each Tag a post addresses receives it in its
Mailbox. A post has a type: note, question, blocker, evidence, or decision. An unaddressed question
or blocker is addressed to the Objective's owner Tag.
Posts carry information only. See [Workstream](coordination.md#workstream).

For saved Task output, producer provenance, and artifact acquisition, see [artifacts](artifacts.md).
