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

- <a id="tag"></a>**Tag** — a persistent AI identity with its own responsibilities and permissions.
  You assign work to a Tag by name. Each assignment runs as a new harness session, and the Tag is
  what persists across those sessions: its configuration, its open assignments, and their results.
- <a id="role"></a>**Role** — an enduring responsibility assigned to a Tag. It can include a purpose, instructions,
  reusable knowledge, and allowed actions. See [Roles](../concepts/roles.md).
- <a id="objective"></a>**Objective** — an outcome owned by a Tag, with success criteria and an explicit completion
  assessment. Ongoing responsibilities can be declared in a [manifest](#manifest). See
  [the coordination reference](coordination.md).
- <a id="task"></a>**Task** — one request or assignment accepted for a Tag under a recorded policy. See
  [the task concepts](../concepts/tasks.md).
- <a id="session"></a>**Session** — a group of Tasks from the same conversation. All of a Tag's Sessions share
  its open Objectives and can read each other, except a private Session, such as a direct chat or a
  CLI conversation, which only its one person's Sessions can read. See
  [across Sessions](../concepts/multiplayer.md#across-sessions-one-tag-one-memory).
- <a id="team"></a>**Team** — a group of Tags with a shared responsibility, lead, and capacity boundary. See
  [Team rules](coordination.md#team-rules).
- <a id="finding"></a>**finding** — one problem a reviewer reports in a Task result, with a severity of high, medium,
  or low and a status of open, fixed, or accepted. See
  [Review findings](coordination.md#review-findings).
- <a id="workstream"></a>**Workstream** — a Team's channel: the one shared thread every Team has, created with the Team
  and sharing its ID. Its members post to it and read it, and the Objective owner reads it. Also
  called the **Team channel**. See [Team channel rules](mailbox.md#team-channel-rules).
- <a id="post"></a>**post** — one append-only entry in a Team channel. Its type is `note`, `question`, `blocker`,
  `evidence`, or `decision`, and `to` can address it to Tags in the Team. A post carries no
  authority. An addressed question or blocker can wake an idle teammate within fixed limits. See
  [Coordinate in a Team channel](../guides/workstreams.md).
- <a id="reply-activation"></a>**reply activation** — a budgeted run that lets an idle Tag answer a teammate's addressed
  `question` or `blocker`, sent through a Team channel or same-Team direct message. A `blocker`
  without `to` goes to the Team lead, unless the lead wrote it. Fixed loop brakes limit wakes;
  a wake grants no authority. See [reply activations](mailbox.md#reply-activations).
- <a id="activation-digest"></a>**activation digest** — the unread Team posts and direct messages a Tag sees once when its next
  [Task Attempt](#task-attempt) starts, addressed items first, then blockers and decisions, capped at about 2,000
  tokens. It carries no authority. See [activation digest](mailbox.md#activation-digest).
- <a id="mailbox"></a>**Mailbox** — the direct delivery point through which one Tag receives internal messages. See
  [the Mailbox reference](mailbox.md).

## Security and knowledge

- <a id="skill"></a>**Skill** — a reusable package of instructions and supporting files.
- <a id="context-set"></a>**Context Set** — reusable knowledge, Skills, or captured [artifact](#artifact) selections that may be added to a Task. See
  [Context and permissions](../concepts/context-and-permissions.md).
- <a id="permission-set"></a>**Permission Set** — actions that a Task is allowed to perform through external tools or its
  execution system.
- <a id="approval-request"></a>**approval request** — a recorded ask for a person or named approver to allow an action marked
  `approval: required`, a held Task, or a lead's plan. See
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
  [Task Attempt](#task-attempt) and whose bytes live in cloud storage. See [artifacts](artifacts.md).

## Runtime

- <a id="control-plane"></a>**Control Plane** — the top-level SuperTag service that stores the organization, accepts and
  schedules work, applies policy, recovers interrupted work, and preserves audit history.
- <a id="api-server"></a>**API Server** — the Control Plane subsystem that handles management requests and execution
  connections.
- <a id="collaboration-surface"></a>**collaboration surface** — how SuperTag meets people in an external work tool such as Slack, GitHub, Linear,
  Lark, or Teams. It receives events at a Tag's locations and replies there.
- <a id="location"></a>**location** — a place on a collaboration surface, such as a channel or repository, where a Tag
  receives events and replies.
- <a id="surface-account"></a>**Surface Account** — one enrolled external workspace or account; its credentials remain in a
  vault. Set it up interactively or declare it in a SurfaceAccount manifest whose secrets are
  references.
- <a id="gateway"></a>**Gateway** — the Control Plane subsystem that carries collaboration surface traffic to and from external
  work tools.
- <a id="worker-host"></a>**Worker Host** — a machine, container, VM, or sandbox that provides execution capacity. See
  [Worker Host selection](scheduling-and-recovery.md#worker-host-selection).
- <a id="host-service"></a>**host service** — a `host` entry in `supertag.yaml` that connects its machine as a
  Worker Host. See [host service](supertag-yaml.md#host-service).
- <a id="auth-key"></a>**Auth Key** — an operator-issued secret that lets a machine join as a Worker Host bound to the
  key's Tags, without copying a credential file. See [Auth Keys](resource-model.md#auth-keys).
- <a id="admin-token"></a>**admin token** — the Control Plane's full management credential. A shared Control Plane reads
  it from `SUPERTAG_ADMIN_TOKEN`; a local one also accepts this machine's local operator credential.
- <a id="operator-token"></a>**Operator Token** — a named credential that the admin token's holder issues to one teammate or
  machine. It can manage the Control Plane, except Operator Tokens themselves, and SuperTag records
  its changes as `token:NAME`. See [Operator Tokens](resource-model.md#operator-tokens).
- <a id="label"></a>**label** — a short placement hint on a Worker Host, such as `macos`, `gpu`, or
  `workspace:app`. A Tag's `runsOn` labels keep its Tasks on bound hosts that carry all of them.
  Labels choose among hosts; they never grant access. See
  [Worker Host labels](resource-model.md#worker-host-labels).
- <a id="worklet"></a>**Worklet** — the supervisor program that connects a Worker Host to the Control Plane. See
  [the Worker reference](worker.md).
- <a id="worklet-api"></a>**Worklet API** — the authenticated API Server protocol through which Worklets register Worker
  Hosts, receive assignments, and report execution state.
- <a id="worker"></a>**Worker** — the code that completes an accepted Task.
- <a id="worker-profile"></a>**Worker Profile** — a saved, versioned recipe for running a Worker.
- <a id="volume"></a>**Volume** — a named storage location, such as an S3 or R2 bucket prefix or a directory on the
  Worker Host. It records the name of the credential that reaches the data, never the secret. See
  [Volumes](resource-model.md#volumes).
- <a id="workspace"></a>**Workspace** — a named repository that an Objective's Tasks work in. Each Task gets its own git
  worktree and branch on a Worker Host that declares a checkout or clones the Workspace source, and
  can deliver its work as a GitHub pull request. See
  [Work in a repository with Workspaces](../guides/workspaces.md).
- <a id="harness"></a>**harness** — the connection between a Worker and Codex, Claude Code, OpenCode, or another agent
  system. See [Worker Hosts, Worklets, Workers, and harnesses](../concepts/workers.md).
- <a id="execution-environment"></a>**execution environment** — the local process or remote sandbox where a harness runs.
- <a id="unsandboxed-harness"></a>**unsandboxed harness** — a harness that runs a Task's commands as the Worker Host's user,
  without an operating-system sandbox, such as Claude Code or OpenCode on a host service. A host
  runs Tasks that may run commands on one only after `allow-unsandboxed-commands` opts in. See
  [Unsandboxed harnesses](supertag-yaml.md#unsandboxed-harnesses).
- <a id="task-attempt"></a>**Task Attempt** — one execution or retry of a Task by a Worker. See
  [Scheduling and interrupted execution](scheduling-and-recovery.md).

## Worker extension contracts

- <a id="harness-plan"></a>**Harness Plan** — a Worker's plan for one harness run. It stages files separately for the
  harness runtime and the execution environment. See [Providers](worker.md#providers).
- <a id="runtime-input"></a>**Runtime Input** — a typed value a Worker uses to prepare one Task Attempt, such as an instruction,
  Skill, workspace, tool, or bounded Session history.
- <a id="runtime-input-provider"></a>**Runtime Input Provider** — the shared contract for Worker code that turns admitted inputs into
  Runtime Inputs. [Context Resolvers](#context-resolver), [Workspace Resolvers](#workspace-resolver),
  and [Tool Providers](#tool-provider) implement it.
- <a id="context-resolver"></a>**Context Resolver** — Worker code that turns a supported Context Item into Runtime Inputs.
- <a id="tool-adapter"></a>**Tool Adapter** — Worker code that exposes or executes a compatible tool binding for a harness.
- <a id="tool-provider"></a>**Tool Provider** — Worker code that turns allowed actions into bounded tool capabilities and local
  bindings.
- <a id="workspace-resolver"></a>**Workspace Resolver** — Worker code that prepares the workspace selected when SuperTag accepted
  a Task.

## Execution and recovery terms

- <a id="owner-activation"></a>**owner activation** — a Task in which an Objective’s owner reviews new information and
  decides what to do next. The Task may be queued, running, or waiting. See
  [Owner triggers](scheduling-and-recovery.md#owner-triggers).
- <a id="connection-generation"></a>**connection generation** — an increasing number identifying a Worker Host’s current
  connection. SuperTag rejects execution reports from older connections. See
  [Worklet API](control-plane-api.md#worklet-api).
- <a id="durable-wait"></a>**durable wait** — a pause whose wake conditions SuperTag stores, so the Task can resume
  when a condition is met even after a Control Plane restart. See
  [Scheduling and recovery](scheduling-and-recovery.md).
