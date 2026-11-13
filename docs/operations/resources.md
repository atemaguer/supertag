# Manage Control Plane resources

A **Tag** is a persistent AI actor with its own responsibilities and permissions, and Tags work
in Teams. Together, your Teams of Tags make up an **autonomous organization**: Teams
may pursue different goals but share one set of rules and one record of the work. Inspect,
configure, and control the resources stored by a **Control Plane** (the service that stores and
coordinates the organization) from the CLI. The CLI manages local and remote Control Planes through
the same authenticated API. If these terms are new, start with [core
concepts](../concepts/README.md) or the [glossary](../reference/glossary.md).

This page uses these terms:

- A **Role** is an
  enduring responsibility assigned to a Tag.
- A **Session** is one Tag's thread of work. A **Task** is one turn of a Session, and a
  **Task Attempt** is one execution or retry of a Task.
- A **Permission Set** lists actions a Task may perform. A **Context Set** holds reusable knowledge
  that may be added to a Task.
- A **Team** is a flat list of member Tags. A Tag's **Mailbox** is its inbox for messages from
  other Tags.
- An **Objective** is an outcome a Tag owns, with success criteria, a budget, and a deadline. A
  **Workspace** is a named repository that an Objective's work happens in.
- A **Worker Host** is a machine, container, VM, or sandbox that provides execution capacity. A
  **Worklet** connects it to the Control Plane.
- A **Worker** is the code that completes a Task, through a **harness** that connects it to an
  agent system such as Codex or Claude Code. A **Worker Profile** is a saved, versioned recipe for
  running a Worker.
- A **Volume** is a named storage location, such as a bucket prefix or a directory on a Worker
  Host.

## Before you start

- The installed `supertag` CLI, connected to a Control Plane with `supertag connect control-plane`,
  or the local Control Plane that `supertag init` or `supertag up` started, which commands use when
  no other is selected. See [Control Plane operations](control-plane.md#manage-a-remote-control-plane).
- For Task and Worker Host sections, at least one enrolled Worker Host.

## 1. Select a Control Plane

Select a saved Control Plane once with `supertag use control-plane NAME`, or override it for one
command with `--control-plane NAME`.

## 2. List and describe resources

```sh
supertag list tag
supertag describe tag engineering
supertag list permission-set
supertag list task
supertag describe task TASK_ID
supertag events task TASK_ID
```

`list` shows a text table with columns suited to each resource. Use `--output json` or
`--output yaml` for a structured collection. Resource kinds use singular names, such as `list tag`;
`list tags` is rejected. `get` returns one exact resource as JSON. `describe` defaults to a readable view for a Tag, Task, Session, or Worker Host; add `--output json` when a script needs
the resource envelope. For a Task, `describe` summarizes its Session and Objective, its phase,
its Workspace and delivery, its findings, and its latest execution Task Attempt. It distinguishes
the machine running the harness from the environment running its tools, and says when execution
evidence is missing. A pending Task shows its last scheduling check and what it waits for. A Task
Attempt that ended to register a wait is reported as a wait, not a failure.

## 3. Watch a resource

`watch` prints the current resource as JSON, then emits a new document whenever its resource
version changes; add `--once` for scripts that only need one snapshot. `watch objective ID` is
different: it prints a readable timeline of the Objective, one line per event, until it closes; see
[Follow it as it happens](../guides/objective-overview.md#2-follow-it-as-it-happens).

Commands that create or change something, such as `cancel task` or `drain worker-host`, print a
one-line summary. Add `--output json` for the full record.

## Check that it worked

`supertag list tag` shows your Tags and their Roles, harness settings, Worker Hosts, and state.
`supertag describe task TASK_ID` shows a readable summary of one Task. It lists each Task Attempt
with its provider-reported cost, or says when a harness reported none.

While a Task Attempt runs, `describe task` also shows the shell command its harness is running
and how long it has run:

```text
Latest Attempt: 6f1c… (running)
Command: running `npm test` for 24m
```

A long command can record no other event for many minutes. This line tells it apart from a hang.
It appears only when the harness reports commands, as Codex and Claude Code do. The command is
written by the AI, so SuperTag prints it as plain text. It removes terminal control characters
and cuts it to 80 characters.

These views use stored records. They do not contact a Worker or establish that an unresponsive
process has stopped. Use `supertag describe task TASK_ID` for the complete stored execution view.
Blocked progress in the event history can explain an unconfirmed cleanup, including the failed
cleanup step and a redacted cause. It does not count as a terminal execution event.

## Follow a Task

Each Task is one turn of a Session. Operators do not create Tasks directly: a person's message, an
Objective's start, a report, a Mailbox message, or an answer each produce one. Follow any of them
by ID:

```sh
supertag describe task TASK_ID
supertag events task TASK_ID
supertag watch task TASK_ID
```

`describe task` shows the latest Task Attempt once execution begins. The Tag
must be bound to at least one enrolled Worker Host, and a bound host must advertise a compatible
Worker Profile before execution can begin.

If a Task waits on an answer or an approval, or a Task Attempt is interrupted, the Control Plane
schedules the next turn when the answer arrives, the decision lands, or capacity returns. There is
no operator resume command for a Task; `resume worker-host` only ends a deliberate host drain. See
the [CLI operator guide](cli.md) for a complete local run.

## Apply configuration

On a Rust deployment, the CLI reads the same manifest envelope and connects through the
Gateway. Use the `--gateway` option for a remote Gateway and supply the operator token through
`SUPERTAG_OPERATOR_TOKEN`. Use `--state-directory` for a local deployment started by the Rust CLI.
Preview shows the planned resource and relationship changes before writing. The Rust CLI
supports files, directories, and standard input.

The Rust resource catalog accepts `SurfaceAccount`, `Volume`, `Workspace`, `ContextSet`,
`PermissionSet`, `Role`, `Tag`, `Team`, `SurfaceLocation`, and `Objective`. A Surface Account
identifies the connected service. A `SurfaceLocation` binds an exact channel, repository, or
team to a Tag. A Workspace declaration uses a `github` source, and a Volume uses a file URL
or an S3 bucket and prefix. Provider credentials stay in Gateway configuration.

1. Save a Tag, Role, Permission Set, or Context Set as YAML or JSON. For example, a Tag selects its
   enduring responsibilities by name:

   ```yaml
   apiVersion: supertag/v1
   kind: Tag
   metadata:
     name: release-manager
   spec:
     roles:
       - Release Manager
       - Security Reviewer
     workerHosts:
       - developer-laptop
   ```

   A Role defines reusable policy and does not list its Tags:

   ```yaml
   apiVersion: supertag/v1
   kind: Role
   metadata:
     name: Security Reviewer
   spec:
     purpose: Review changes that affect customer data.
     instructions: Require evidence and state unresolved risk.
     contextSets:
       - security-guidelines
     permissionSets:
       - engineering-read
   ```

   Context Sets use the same envelope:

   ```yaml
   apiVersion: supertag/v1
   kind: ContextSet
   metadata:
     name: review-practices
   spec:
     items:
       - itemKey: skill:review
         type: supertag/skill
         version: 1
         required: true
         config:
           reference: review-guidelines
   ```

2. Preview and apply it:

   ```sh
   supertag diff -f review-practices.yaml
   supertag apply -f review-practices.yaml
   ```

Check that it worked: running `diff` again prints `No changes.`

Apply is idempotent. The Control Plane reconciles desired configuration while preserving generated IDs,
timestamps, and observed status. A Role's `status.assignedTags` remains read-only. Tasks, Sessions,
and Worker Hosts are observed or enrolled resources, so they cannot be applied from a manifest.
Surface Accounts can; see [Declare Surface Accounts](#declare-surface-accounts).

### Declare an organization in one input

One `-f` input can hold a whole organization. Separate manifests in one YAML file with `---`, put
them in a JSON array, or pass a directory. For a directory, SuperTag reads every `.yaml`, `.yml`,
and `.json` file in name order. It does not read subdirectories.

This file declares a small engineering organization. One Role and one Permission Set are shared by
two Tags. `builder` answers in a Slack channel and a GitHub repository. `reviewer` answers in its
own Slack channel. Each Tag accepts messages from the other:

```yaml
apiVersion: supertag/v1
kind: Tag
metadata:
  name: builder
spec:
  roles: [Engineer]
  locations:
    - provider: slack
      channelId: C0123BUILD
      permissionSets: [engineering-runtime]
    - provider: github
      repo: acme/api
  acceptsMessagesFrom: [reviewer]
---
apiVersion: supertag/v1
kind: Tag
metadata:
  name: reviewer
spec:
  roles: [Engineer]
  locations:
    - provider: slack
      channelId: C0123REVIEW
  acceptsMessagesFrom: [builder]
---
apiVersion: supertag/v1
kind: Role
metadata:
  name: Engineer
spec:
  purpose: Ship small, reviewed changes to the API.
  instructions: Keep each change small and include tests.
  contextSets: []
  permissionSets: [engineering-runtime]
---
apiVersion: supertag/v1
kind: PermissionSet
metadata:
  name: engineering-runtime
spec:
  permissions:
    - target: runtime
      action: commands:execute
```

Preview and apply it the same way:

```sh
supertag diff -f engineering.yaml
supertag apply -f engineering.yaml
```

`diff` prints a plan of what `apply` would change. `apply` prints one `configured` line per
manifest.

Each location takes a `provider` and the same scope values as
`supertag update tag NAME --add-location PROVIDER`, spelled in camelCase:

| Provider | Scope fields |
| --- | --- |
| `slack` | `channelId` |
| `github` | `repo` (owner/name) or `repoId` |
| `lark` | `chatId` |
| `linear` | `team` (name or key) or `teamId` |
| `teams` | `teamId` and `channelId` |

Add `account` when more than one account exists for the provider. It takes the Surface Account's
manifest name or its external ID, such as the Slack workspace ID. `permissionSets` and `contextSets` activate those sets at that location, as
`supertag activate permission-set` and `supertag activate context-set` do.

`acceptsMessagesFrom` lists the Tags allowed to send this Tag Mailbox messages. Each entry has
the effect of `supertag grant mailbox RECIPIENT --sender SENDER`. Tags that share a Team message
each other without a grant.

These rules apply to every input:

- **Order does not matter.** SuperTag applies Surface Accounts, then Workspaces, then Context
  Sets, then Permission Sets, then Roles, then Tags, then Objectives. Tags in one input can accept
  messages from each other.
- **Apply removes only what it set.** A field that a previous apply set and the manifest now omits
  is removed; a location goes as `--remove-location` removes it. Fields set another way, such as a
  location added with `supertag update tag`, stay. Lists merge entry by entry. See
  [Share resources with the CLI and other inputs](#share-resources-with-the-cli-and-other-inputs).
- **Validation comes first.** SuperTag checks every manifest before applying any. Each Role, set,
  Workspace, and Tag a manifest names must be in the input or already exist. Defining the same kind and
  name twice is an error.
- **Apply is not transactional.** If one manifest fails, SuperTag stops. It reports which manifests
  were applied and which were not, and exits with a nonzero status. Fix the problem and apply again;
  applied manifests stay unchanged.

### Read a plan

`diff` prints one line for each resource that `apply` would change, then a summary:

```text
~ Role Engineer     spec.purpose: "Ship reviewed changes." -> "Ship small changes."
! Tag backend       spec.locations[slack:C0123BUILD] owned by cli  (use --force-conflicts)
+ Tag ios-dev
~ Tag reviewer      spec.roles: + Release Manager
- Role old-oncall
Plan: 1 to create, 2 to update, 1 to delete, 1 conflict.
```

| Mark | Meaning |
| --- | --- |
| `+` | Apply creates the resource. |
| `~` | Apply changes the listed fields. In a list, `+` adds an entry, `-` removes one, and `~` changes one. |
| `-` | `--prune` deletes the resource, or cancels an Objective. |
| `=` | Apply leaves the resource as it is. `--prune` would delete it, but something still uses it, or a declared Objective was cancelled. The line says why. |
| `!` | The input changes a field another writer owns, or a field that cannot change. Apply refuses until you resolve it. |

`diff` accepts the same `--set`, `--prune`, and `--force-conflicts` flags as `apply`, and changes
nothing. When nothing would change, it prints `No changes.`

### Share resources with the CLI and other inputs

An operator might add a Slack channel to a Tag with `supertag update tag` while the Tag's other
settings live in a manifest. SuperTag records which writer, called a **field manager**, last set
each field, so the next apply keeps that channel. `supertag apply` writes as `apply`. Imperative
commands, and any change made outside `supertag apply`, write as `cli`.

Say `builder.yaml` declares two locations for `builder`, and an operator runs:

```sh
supertag update tag builder --add-location slack --channel-id C0123OPS
supertag activate context-set review-practices --tag builder --provider github --repo acme/api
```

The next `diff -f builder.yaml` keeps the new Slack channel, because `cli` added it. The
activation changed a location that `builder.yaml` declares, so the plan reports a conflict:

```text
! Tag builder   spec.locations[github:123456] owned by cli  (use --force-conflicts)
Plan: 0 to create, 0 to update, 0 to delete, 1 conflict.
```

`apply` then refuses before changing anything, and names each conflicting field and its manager.
Choose one:

- Put the change in the manifest. Once the manifest sets the same value, it owns the field again.
- Run `supertag apply -f builder.yaml --force-conflicts` to apply the manifest's value and take
  ownership.

`supertag init` creates its starter resources in the `init` set. To move one into your own set,
write its desired fields in a manifest and run `supertag diff -f FILE --set NAME`.
If the plan says a changed field is owned by `init`, review the change, then run
`supertag apply -f FILE --set NAME --force-conflicts`. Fields with the same value transfer
ownership without a conflict.

The full rules, and how each list is keyed, are in
[Field managers and apply sets](../reference/resource-model.md#field-managers-and-apply-sets).

### Declare Objectives

An Objective records an outcome a Tag owns until it is done. Ongoing responsibilities, such as
keeping dependencies current, are standing work, so they belong in configuration beside the Tags
that do them. A manifest declares one Objective and the Teams that work on it:

```yaml
apiVersion: supertag/v1
kind: Objective
metadata:
  name: dependency-upkeep
spec:
  owner: maintainer
  outcome: >-
    Keep dependencies current and the build green. Open a pull request for each upgrade,
    and ask before a major version change.
  ongoing: true
  workspaces: [app]
  budget: { minor: 50000, currency: USD }
  deadline: 2027-01-01T00:00:00Z
  runtimeActions: [files:write]
  team: { name: upkeep, members: [builder], maxConcurrency: 2 }
```

`metadata.name` is the Objective's ID. `owner` and `outcome` are required; the rest is optional:

| Field | Meaning | After creation |
| --- | --- | --- |
| `owner` | The Tag accountable for the outcome. | Fixed |
| `outcome` | One statement: the result, how it is verified, what must not change, and when to ask a person. | Fixed |
| `ongoing` | `true` for a responsibility that only an operator ends. | Fixed |
| `workspaces` | Workspaces its Tasks may work in. | Fixed |
| `budget` | `minor` units, with an optional three-letter `currency`. | Increases in place |
| `deadline` | An ISO timestamp. | Changes in place |
| `runtimeActions` | Narrows the runtime actions its Tasks may receive. Omitted: what the owner's Permission Sets allow. | Changes in place |
| `team` | An existing Team's name, or a map of `members` with optional `name` and `maxConcurrency` that declares the Objective's own Team. | Which Team is fixed; a declared Team's fields change in place |

The Objective's status is observed, not declared, so a manifest has no `status`.

**Applying creates and starts it.** SuperTag creates the Objective, starts its conversation as
`supertag create objective` does, and creates a Team declared in place. That Team's ID is the
Objective's ID. If the Objective cannot start, for example because its owner Tag has no Worker
Host, apply warns. A later apply starts it once the cause is fixed.

**Fixed fields refuse changes.** The owner and its Tasks treat the outcome, owner, and Workspaces as
the definition of the work, so changing them in place would change work already accepted. Apply
refuses and names the field:

```text
! Objective dependency-upkeep   spec.outcome: outcome changed; an Objective's outcome is fixed once it exists. Give the declaration a new name to create a new Objective, then cancel dependency-upkeep or let --prune cancel it
```

Give the declaration a new name. The new name creates a new Objective, and the old one keeps
running until you cancel it or prune it. Removing `deadline`, `budget`, or `runtimeActions` from the
manifest keeps the current value, because none of them can be cleared.

**A declared Team follows field ownership.** Apply creates the Team the input declares and keeps
its name, members, and concurrency in step with the input. A Team named by name, or created with
`supertag create team`, stays as it is. A Team that an operator changed with
`supertag update team` belongs to `cli` until apply takes ownership with `--force-conflicts`.

**Prune cancels.** Removing a declared Objective from a set's input and applying with `--prune`
cancels it, as `supertag cancel objective` does. Its Tasks, results, and history stay. Without
`--prune`, apply reports it and leaves it running. Prune cancels Objectives before it deletes Tags,
so removing an Objective and its owner Tag together takes one prune:

```text
Objective/dependency-upkeep cancelled; its history is kept
Tag/maintainer deleted
```

A cancelled Objective cannot run again. If its name stays in the input, apply leaves it as it is and
says so.

Check that it worked: `supertag describe objective dependency-upkeep` shows its first Task, and
`supertag diff -f dependency-upkeep.yaml` prints `No changes.`

### Declare Surface Accounts

A **Surface Account** is one connected account in an external work tool, such as a Slack
workspace or a GitHub token. `supertag setup surface PROVIDER` creates one interactively. A shared
Control Plane can declare it in a manifest instead, beside the Tags that use it:

```yaml
apiVersion: supertag/v1
kind: SurfaceAccount
metadata:
  name: acme-slack
spec:
  provider: slack
  displayName: Acme Slack
  configuration:
    transport: socket
  secrets:
    botToken: { env: SLACK_BOT_TOKEN }
    appToken: { file: secrets/slack-app-token }
```

A manifest never holds a secret value. Each entry under `secrets` says where the value comes from:

| Reference | Value comes from |
| --- | --- |
| `{ env: VARIABLE }` | An environment variable of the `supertag apply` process. |
| `{ file: PATH }` | A file. A relative path starts from the manifest's directory. |
| `{ secretRef: NAME }` | A named secret that the program applying the manifest resolves, such as an entry in `supertag.yaml`'s `secrets` for a [provisioned](../reference/supertag-yaml.md#provision-surface-accounts) manifest. `supertag apply -f` has no such resolver and refuses it. |

A literal value, such as `botToken: xoxb-…`, fails validation, and the error does not repeat it.
`provider` is `slack`, `github`, `lark`, `linear`, or `teams`. `configuration` takes the same
non-secret options as setup, and `displayName` replaces the name the provider reports. Each
[collaboration surface guide](../surfaces/README.md#declare-a-surface-account-in-a-manifest) lists its
provider's options and secrets.

**Apply verifies, then stores.** Apply reads each referenced value and asks the Control Plane
whether it matches the stored credential. When the account is new, or anything changed, the CLI
checks the values with the provider exactly as setup does, before it writes any manifest in the
input. A rejected token stops apply with the provider's message, such as
`Slack auth.test failed: invalid_auth`. The values then travel to the Control Plane over the same
authenticated request as setup and go into the credential vault.

**Unchanged accounts stay untouched.** When nothing changed, apply contacts no provider and
rewrites nothing, so the Gateway keeps its connection:

```text
SurfaceAccount/acme-slack configured; credentials unchanged
```

To rotate a secret, change the value behind the reference and apply again. Apply sees the new
value, verifies it, and stores it.

**`diff` reads no secrets.** It compares `provider`, `displayName`, `configuration`, and the
references themselves. A changed reference appears as a field change; a changed value behind an
unchanged reference appears only when you apply.

**Tags can use a new account in the same input.** A Tag location's `account` may name the
Surface Account by its manifest name. Apply creates the account before the Tag. The Tag records
the provider's account ID, so later plans stay stable:

```yaml
apiVersion: supertag/v1
kind: Tag
metadata:
  name: builder
spec:
  locations:
    - provider: slack
      account: acme-slack
      channelId: C0123456789
```

**The account keeps its identity.** A manifest name stays bound to the provider account it first
named. Credentials for another Slack workspace, or a second manifest for the same workspace, are
refused. To move a name, delete the account and apply again.

**Setup accounts are adopted.** Applying a manifest for an account that setup created gives it the
manifest's name once its credentials verify. Its ID and history stay.

`supertag get surface acme-slack --output yaml` exports the manifest with its references.
`supertag delete surface acme-slack` retires the account, as described in
[Delete a resource](#delete-a-resource).

Check that it worked: `supertag get surface acme-slack` shows `spec.secrets` with your
references, and a second `supertag apply` prints `credentials unchanged`.

### Manage an organization as a set

An **apply set** is a named group of resources that one input declares. Name it with `--set`:

```sh
supertag apply -f engineering/ --set engineering
```

SuperTag records every resource in the input as a member of `engineering` and writes as field
manager `engineering`. A second team can manage its own input as another set; each set's fields
are its own.

To delete members that you removed from the input, add `--prune`:

```sh
supertag diff -f engineering/ --set engineering --prune
supertag apply -f engineering/ --set engineering --prune
```

Prune touches only members of the named set. It cancels Objectives first, then deletes Tags and
the sets and Workspaces they use, and retires Surface Accounts last. It deletes each member exactly as [`supertag delete`](#delete-a-resource)
does, with the same protection. It keeps a member that something still uses and reports why, for example:

```text
Tag/reviewer deleted
Role/Engineer not deleted: is in use by Tag builder
```

Prune never erases audit history. A pruned Tag or Role is retired, not erased. A kept member stays
in the set, so the next prune tries again. `--prune` without `--set` is an error, because only a
set says which resources the input owns.

Check that it worked: `supertag diff -f engineering/ --set engineering --prune` prints
`No changes.`

### supertag.yaml is not a manifest

`apply` and `diff` read only resource manifests, each with `apiVersion`, `kind`, `metadata`, and
`spec`. `supertag.yaml` lists the services `supertag up` runs and declares no resources of its
own, so `supertag apply -f supertag.yaml` is refused with guidance. Its `provision` list can
reference or embed manifests to create when missing; see
[Provision resources](../reference/supertag-yaml.md#provision-resources). An earlier
`supertag.yaml` that listed `tags`, `roles`, and other resource sections by name is refused the
same way. Move each entry into a manifest: its key becomes `metadata.name`, and its value becomes
`spec`. For example, `tags: { lead: { roles: [Lead] } }` becomes:

```yaml
apiVersion: supertag/v1
kind: Tag
metadata:
  name: lead
spec:
  roles: [Lead]
```

Apply a directory of such manifests as a set with `--set NAME`, and add `--prune` to delete what
you remove. See [supertag.yaml and local state](../reference/supertag-yaml.md).

### Adopt existing resources

Resources created before field managers existed, or with imperative commands, belong to `cli`.
Their first apply keeps every field the manifest omits, and conflicts on every field it changes.
Adopt them once:

1. Export the current state and edit it to what you want, or use your existing manifests.
2. Review the plan: `supertag diff -f engineering/ --set engineering`.
3. Apply once with `--force-conflicts`:

   ```sh
   supertag apply -f engineering/ --set engineering --force-conflicts
   ```

From then on the set owns every field its input declares. Fields that `cli` set and the input omits
stay until you remove them with an imperative command, or declare them and then drop them.

### Export the organization

Print any Workspace, Surface Account, Tag, Role, Permission Set, Context Set, or Objective as an
apply-able manifest:

```sh
supertag get tag builder --output yaml
supertag get tag --output yaml > tags.yaml
supertag get objective dependency-upkeep --output yaml
```

Without a name, `get` prints every resource of that kind, separated by `---`. An Objective always
needs its ID. Its export lists its Team and its current runtime actions, but not its
status. A Role listing skips
built-in Roles, which exist on every Control Plane. The export lists every Tag field, including
`locations` and `acceptsMessagesFrom`, so applying it manages all of them. Location scopes appear
as stable IDs, such as `repoId` rather than `repo`. A Surface Account export lists its secret
references, never their values; a listing skips accounts set up with `supertag setup surface`,
which have no references to export.

Check that it worked: `supertag diff -f tags.yaml` prints `No changes.` Keep the exported files in
version control and apply changes from there. The first apply of an export takes ownership of every
field it lists, because each value already matches.

## Delete a resource

Remove a Tag, Role, Permission Set, Context Set, Workspace, or Surface Account with
`supertag delete`. Objectives are never deleted; cancel one with `supertag cancel objective ID` to keep its history. Preview it
first with `--dry-run`, which changes nothing:

```sh
supertag delete permission-set deploy --dry-run
supertag delete permission-set deploy
```

SuperTag refuses to delete something that is still in use, and lists everything that uses it:

```text
SuperTag failed: permission-set deploy is in use by Role Engineer and Tag release (location slack:C01).
```

Remove those references first, then delete again. There is no flag to force a deletion. This table
lists what keeps each kind in use:

| Kind | In use while |
| --- | --- |
| Tag | It owns an Objective that is not completed or cancelled, it belongs to any Team, it has pending or running Tasks, or a Permission Set names it as an approver. |
| Role | Any Tag holds it. Built-in Roles can never be deleted. |
| Permission Set, Context Set | A Role lists it, or it is activated at a Tag location. |
| Workspace | An Objective that is not completed or cancelled names it, or a Tag location lists it in `workspaces`. |
| Surface Account | A Tag location uses it, or a Permission Set grants an action through it. |

Deleting never erases history:

- **A Tag is retired.** SuperTag removes its locations and their set activations, Worker Host
  bindings, Mailbox grants in both directions, and Role assignments. The Tag
  itself stays, so its Tasks, Sessions, approvals, Objectives, and artifacts still name it. A
  retired Tag receives no work, cannot be messaged, and cannot be bound to a Worker Host. An Auth
  Key that names it can no longer join a host.
- **A Role is retired.** It keeps its assignment history and loses its set references.
- **A Permission Set, Context Set, or Workspace is deleted.** Each Task keeps the policy and
  workspace recorded when SuperTag accepted it, so history does not change.
- **A Surface Account is retired.** SuperTag removes its stored credential, and the Gateway stops
  receiving events for it. The account stays, so delivery history still names it. Replies still
  waiting to be sent through it fail. Its name is free at once. Setting up or applying the same
  provider account again reconnects it.

`--dry-run` shows what goes with the resource:

```text
Dry run: Tag release would be retired. Nothing was changed.
Would remove with it:
  location slack:C01 with Permission Set deploy
  Worker Host build-01 binding
  Role Engineer assignment
  Mailbox grant from Tag lead
  membership in apply set engineering
```

`supertag list tag` hides retired Tags. `supertag get tag release` still shows a retired Tag, with
`status.phase: retired`, until a new Tag takes the name. The name is free as soon as the Tag
retires: `supertag create tag release` then creates a new Tag with a new ID, and old history keeps
pointing at the retired one.

A Worker Host that declares a deleted Workspace keeps its checkout. SuperTag stops offering the
Workspace until one with that name exists again.

Check that it worked: `supertag get permission-set deploy` reports that it does not exist, and
`supertag get tag release` reports `status.phase: retired`.

## Cancel a Task

```sh
supertag cancel task TASK_ID
```

The Control Plane records the request, propagates cancellation to the active Worker, and records the
resulting Task and Task Attempt events. Cancellation is cooperative: a Worker must honor its
`AbortSignal` or the matching cancellation primitive in another SDK.

Check that it worked: `supertag events task TASK_ID` shows the resulting Task and Task Attempt events.

To stop a whole Objective, use `supertag cancel objective ID --reason TEXT`. It cancels every open
Task of the Objective; see [Cancel an Objective](../guides/objectives.md#cancel-an-objective).

## Inspect Sessions

A Session groups related Tasks for one Tag and can preserve a harness's native conversation
state. Inspect the stored record and its native archive metadata with:

```sh
supertag list session
supertag get session SESSION_ID
supertag describe session SESSION_ID
```

`get` returns JSON. `describe` shows the recorded native conversation ID and whether a resumable
archive exists, without exposing the archive contents. SuperTag resumes a compatible native
Session automatically on later work. There is no manual Session resume command. A native Session
preserves conversation state; it does not preserve workspace files.

## Inspect artifacts

An **artifact** is an immutable manifest for files captured from a completed Task Attempt. The
manifest records the producing Task and Task Attempt, exact paths, byte sizes, and content digests.

1. List and inspect artifacts:

   ```sh
   supertag list artifact --task TASK_ID --limit 20
   supertag get artifact ARTIFACT_ID
   ```

2. See which Worker Hosts hold the files, listed under `Storage:`:

   ```sh
   supertag describe task TASK_ID
   ```

Check that it worked: each artifact names at least one Worker Host.

The Control Plane stores no artifact bytes; the Worker Hosts that captured them keep them. Other
Tasks that take the artifact as an input read exact files directly from the Worker Host that holds
them. `supertag list artifact` and `supertag get artifact` show where each copy is.

To save a file on your machine:

```sh
supertag download artifact ARTIFACT_ID --path outputs/report.md --out report.md
```

It reads a Volume that holds a copy, with your machine's own `volume-credentials` mapping in
supertag.yaml, or fetches the file from the Worker Host that serves it under a grant that expires
in a minute. Either way it checks the file's digest before writing. When your machine can reach
neither, it names the Worker Hosts and Volumes that hold the file. See
[Artifact storage](control-plane.md#artifact-storage).

## Inspect and drain Worker Hosts

Worklets maintain outbound connections and heartbeat leases for their Worker Hosts.

1. Inspect the scheduler's view:

   ```sh
   supertag list worker-host
   supertag describe worker-host WORKER_HOST_ID
   supertag list worker-profile
   ```

   A Worker Host reports `Connected`, `Ready`, `Draining`, and `Unreachable` conditions together
   with its Worklet ID, latest heartbeat, advertised capacity, active Task Attempts, and available
   slots.

2. Drain a Worker Host before maintenance so it finishes active Task Attempts but receives no new
   assignments:

   ```sh
   supertag drain worker-host WORKER_HOST_ID
   # update the host or restart its Worklet
   supertag resume worker-host WORKER_HOST_ID
   ```

Check that it worked: `describe worker-host` reports `Draining` after the drain and `Ready` after
the resume.

The Control Plane schedules a Task only when a Ready Worker Host has capacity and advertises a
profile matching the Task's execution requirements. The selected profile becomes immutable on the
Task Attempt. When no host is eligible, the Task remains pending without consuming a Task Attempt.
Active assignment leases are renewed during execution; if a Worklet disconnects or stops
heartbeating, its host becomes unreachable, its active Task Attempt fails, and durable work becomes
eligible for recovery. See [Scheduling and interrupted execution](../reference/scheduling-and-recovery.md).

## If something goes wrong

- **A Task stays pending.** No Ready Worker Host with capacity advertises a matching profile. Check
  `supertag describe worker-host WORKER_HOST_ID` and
  [Troubleshoot the first reply](../guides/troubleshooting.md).
- **A Worker Host stays at capacity after a forced kill.** See
  [Troubleshooting](../guides/troubleshooting.md#a-worker-host-stays-at-capacity-after-a-forced-kill).
- **A download fails.** The Control Plane holds no artifact bytes; they stay on the Worker Hosts
  that hold copies. See [Artifact storage](control-plane.md#artifact-storage).

## Next

- [CLI operator guide](cli.md)
- [Control Plane operations](control-plane.md)
- [Control Plane API](../reference/control-plane-api.md)
