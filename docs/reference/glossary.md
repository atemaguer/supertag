# Glossary

This page is a quick reminder of SuperTag's public vocabulary. If these terms are new, start with
[core concepts](../concepts/README.md). Concept pages provide the full explanations.

<a id="autonomous-organization"></a><a id="autonomous-engineering-team"></a>An **autonomous
organization** is your [Teams](#team) of [Tags](#tag), taken together. Teams may pursue different
[Objectives](#objective), but they share one [Control Plane](#control-plane), one set of rules, and
one record of the work. People define each outcome: the result, how success is verified, the
constraints, budget, and deadline, and which decisions need a person. The Tags plan, divide, and
review the work within that authority. Docs shorten it to "organization". The term describes the
whole system rather than another first-class resource.

## Organization

- <a id="tag"></a>**Tag** — a persistent AI actor with a stable identity, responsibilities,
  permissions, and work history. It exists independently of the model or harness executing its
  work. See [Tags](../concepts/tags.md).
- <a id="role"></a>**Role** — an enduring responsibility assigned to a Tag. It can include a purpose, instructions,
  reusable knowledge, and allowed actions. See [Roles](../concepts/roles.md).
- <a id="objective"></a>**Objective** — an outcome a Tag owns, with a budget, a deadline and a
  status. It talks in the thread it was created in, and the work happens in Sessions started
  beneath it. Ongoing responsibilities can be declared in a [manifest](#manifest). See
  [the coordination reference](coordination.md#objectives).
- <a id="task"></a>**Task** — one request or assignment accepted for a Tag under a recorded policy. See
  [the task concepts](../concepts/tasks.md).
- <a id="session"></a>**Session** — a group of Tasks from the same conversation, with its own harness
  session. A Session is shared, such as a channel thread, or private to one person, such as a
  conversation in the terminal UI. A work Session is a Session a
  conversation started for longer work; its parent is that conversation, it sees only its own
  work, and its result returns there through the Tag. See
  [across Sessions](../concepts/multiplayer.md#across-sessions-one-tag-many-conversations) and
  [Session](../concepts/tasks.md#session).
- <a id="team"></a>**Team** — a flat list of member Tags with an optional concurrency limit. Members
  message each other and share the Team's Workstream, and an Objective that names the Team may
  start work Sessions of its members. See [Teams](coordination.md#teams).
- <a id="finding"></a>**finding** — one problem a Task result reports about its own work, with a
  severity of high, medium, or low. See [Review findings](coordination.md#review-findings).
- <a id="workstream"></a>**Workstream** — a Team's shared record of posts. Every member reads it. See
  [Workstream](coordination.md#workstream).
- <a id="post"></a>**post** — one append-only entry in a Team's Workstream. It is plain text and carries
  no authority. A post wakes nobody; each Tag it addresses receives it in that Tag's Mailbox. See
  [Share progress in a Workstream](../guides/workstreams.md).
- <a id="mailbox"></a>**Mailbox** — a Tag's inbox for plain-text messages from other Tags. Everything
  waiting when a turn starts is handled together in that turn. See
  [Mailbox](coordination.md#mailbox).

## Security and knowledge

- <a id="skill"></a>**Skill** — a reusable package of instructions and supporting files.
- <a id="context-set"></a>**Context Set** — reusable knowledge, Skills, or captured [artifact](#artifact) selections that may be added to a Task. See
  [Context and permissions](../concepts/context-and-permissions.md).
- <a id="permission-set"></a>**Permission Set** — actions that a Task is allowed to perform through external tools or its
  execution system.
- <a id="approval-request"></a>**approval request** — a recorded ask for a person or named approver
  to allow an action marked `approval_required: true`, or a planned list of them. See
  [Approval requests](coordination.md#approval-requests).
- <a id="context-item"></a>**Context Item** — one named, versioned declaration inside a Context Set.
- <a id="context-plan"></a>**Context Plan** — the versioned Context Items, Skills, and artifact selections that SuperTag
  captures when it accepts a Task. See [Stored Task inputs](context-resolution.md#stored-task-inputs).
- <a id="manifest"></a>A **manifest** is a YAML file of resources in the common resource envelope, which
  `supertag apply -f` creates or updates. See [Resource envelope](resource-model.md#resource-envelope).
- <a id="field-manager"></a>A **field manager** is the writer that last set one field of an applied resource, such as
  `apply`, an apply set, or `cli`. <a id="apply-set"></a>An **apply set** is a named group of resources that one input
  declares and `--prune` keeps in step. See
  [Field managers and apply sets](resource-model.md#field-managers-and-apply-sets).
- <a id="retired"></a>A **retired** Tag or Role was deleted but keeps its record, so history still names it. A retired
  Tag receives no work, and a new Tag may reuse its name. See [Deletion](resource-model.md#deletion).
- <a id="artifact"></a>An **artifact** is captured reusable work whose catalog entry identifies the producing Task and
  [Task Attempt](#task-attempt) and whose bytes stay on Worker Hosts or mapped Volumes. See [artifacts](artifacts.md).

## Runtime

- <a id="control-plane"></a>**Control Plane** — the SuperTag service that stores the organization, accepts and
  schedules work, applies policy, recovers interrupted work, and preserves audit history. It is the
  one public API for operator clients, Worker Hosts, and Gateways. See
  [Control Plane API](control-plane-api.md).
- <a id="collaboration-surface"></a>**collaboration surface** — how SuperTag meets people in an external work tool such as Slack, GitHub, Linear,
  Lark, or Teams. It receives events at a Tag's locations and replies there.
- <a id="location"></a>**location** — a place on a collaboration surface, such as a channel or repository, where a Tag
  receives events and replies.
- <a id="surface-account"></a>**Surface Account** — one connected external workspace or account and the Gateway that serves
  it. Its credentials stay with that Gateway, in a credential vault.
- <a id="gateway"></a>**Gateway** — the service that carries collaboration surface traffic and operator notifications.
  It is an optional client of the Control Plane with its own credential, `gateway:NAME`.
- <a id="worker-host"></a>**Worker Host** — a machine, container, VM, or sandbox that runs Tasks through harness adapters.
  It connects outbound to the Control Plane. See [Run Worker Hosts](../guides/workers.md).
- <a id="host-service"></a>**host service** — a `host` entry in `supertag.yaml` that connects its machine as a
  Worker Host. See [host service](supertag-yaml.md#host-service).
- <a id="auth-key"></a>**Auth Key** — an operator-issued, short-lived secret that enrolls principals of one role: a
  Worker Host (`host`), a Gateway (`gateway`), or a client device (`client`). See
  [Identities and access](../operations/control-plane.md#identities-and-access).
- <a id="client"></a>**client** — a device running the CLI, the terminal UI, or the desktop app, enrolled with a client
  Auth Key as `client:NAME`.
- <a id="admin-token"></a>**admin token** — the admin Operator Token: the Control Plane's full operator credential, which
  alone manages Operator Tokens. `supertag setup deployment` generates it; a local Control Plane
  also accepts this machine's local operator credential.
- <a id="operator-token"></a>**Operator Token** — a named credential the admin issues to one teammate or automation. SuperTag
  records its changes as `token:NAME`. See [Operator Tokens](resource-model.md#operator-tokens).
- <a id="label"></a>**label** — a short placement hint on a Worker Host, such as `gpu`. A Tag's `runsOn` labels keep
  its Tasks on hosts that carry all of them. Labels choose among hosts; they never grant access.
  See [Worker Host labels](resource-model.md#worker-host-labels).
- <a id="volume"></a>**Volume** — a named storage location: a directory (`file://`) or an S3 bucket prefix
  (`s3://`). It never holds a secret. See [Volumes](resource-model.md#volumes).
- <a id="workspace"></a>**Workspace** — a named repository that a Tag's Tasks work in. Each Task Attempt gets its own
  pinned checkout on a Worker Host, and its commits come back as a `supertag/session/...` branch.
  See [Work in a repository with Workspaces](../guides/workspaces.md).
- <a id="harness"></a>**harness** — the agent system a Task runs on, such as Codex, Claude Code, Cursor, OpenCode, or
  OpenAI Agents. See [Worker Hosts and harnesses](../concepts/workers.md).
- <a id="harness-adapter"></a>**harness adapter** — the process a Worker Host starts for each Task Attempt to drive a
  harness through the harness protocol. See [Write a harness adapter](../guides/harness-adapters.md).
- <a id="execution-environment"></a>**execution environment** — where a Task's files and commands live: a local checkout, an E2B
  or Modal sandbox, or a shared execution environment.
- <a id="unsandboxed-harness"></a>**unsandboxed harness** — a harness that runs a Task's commands as the Worker Host's user,
  without an operating-system sandbox: Cursor or OpenCode on a local host. A host runs their Tasks
  that may run commands only after `allow-unsandboxed-commands` opts in. See
  [Unsandboxed harnesses](supertag-yaml.md#unsandboxed-harnesses).
- <a id="task-attempt"></a>**Task Attempt** — one execution of a Task on a Worker Host; a retry is another Task Attempt.
  See [Scheduling and interrupted execution](scheduling-and-recovery.md).

## Execution and recovery terms

- <a id="connection-generation"></a>**Task Attempt generation** — an increasing number that fences a Task Attempt's lease.
  SuperTag rejects reports from a host that lost the lease. See
  [Leases and unknown outcomes](scheduling-and-recovery.md#leases-and-unknown-outcomes).
- <a id="durable-wait"></a>**durable wait** — a pause whose wake conditions SuperTag stores, so the Task can resume
  when a condition is met even after a Control Plane restart. See
  [Scheduling and recovery](scheduling-and-recovery.md).
