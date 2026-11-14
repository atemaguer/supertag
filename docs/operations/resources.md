# Manage Control Plane resources

Read, watch, declare, and delete the resources that make up your organization in a **Control
Plane**, the service that stores it and schedules its work. Tags are persistent AI actors with
their own responsibilities and permissions; Roles, Permission Sets, Context Sets, Teams,
Objectives, Surface Accounts, and Workspaces shape what they do. See the
[resource model](../reference/resource-model.md) for every kind and the
[glossary](../reference/glossary.md) for terms.

Without `--control-plane`, commands use the Control Plane that `supertag up` runs on this machine.
The examples use these local services; add `--control-plane NAME` for a saved one. See
[How commands find the Control Plane](cli.md#how-commands-find-the-control-plane).

## Read and describe

`get KIND` lists a kind as JSON, and `get KIND ID` reads one. `describe KIND ID` prints one as
readable text, or the full record with `--output json`:

```sh
supertag get tag
supertag get objective flaky-tests
supertag describe tag lead
supertag describe task TASK_ID --output json
```

The kinds are listed in [`supertag get`](../reference/cli.md#supertag-get). A list may be paged:
pass the returned cursor with `--cursor`. Pipe JSON through `jq` to filter it.

## Watch

`watch` streams change notices for Tags, Tasks, conversation messages, Objectives, Teams, and
Workstream posts:

```sh
supertag watch task objective
supertag watch objective flaky-tests
```

A notice says what changed; read the resource for its contents. `watch` reconnects from its last
resume token for 60 seconds after a disconnect, and `--resume-token` continues a previous watch.
`watch objective ID` follows one Objective as a timeline until it closes.

## Check that it worked

```sh
supertag get tag lead
```

prints the Tag as JSON. An unknown ID fails with `not found`.

## Apply configuration

Declare resources in YAML manifests, preview them with `diff`, and create or change them with
`apply`. Each manifest has an `apiVersion`, a `kind`, a `metadata.name`, and a `spec`:

```yaml
apiVersion: supertag/v1
kind: PermissionSet
metadata: { name: local-tools }
spec:
  permissions:
    - { target: runtime, action: commands:execute }
    - { target: runtime, action: files:write }
---
apiVersion: supertag/v1
kind: Role
metadata: { name: Builder }
spec:
  purpose: Implement bounded changes with tests.
  instructions: Run the project's checks before reporting, and report the exact commands.
  permissionSets: [local-tools]
  execution: { harness: codex, models: [gpt-5.5], efforts: [medium, high] }
---
apiVersion: supertag/v1
kind: Tag
metadata: { name: builder }
spec:
  roles: [Builder]
  runsOn: [linux]
---
apiVersion: supertag/v1
kind: Team
metadata: { name: core }
spec:
  members: [lead, builder]
  maxConcurrency: 2
```

```sh
supertag diff -f organization.yaml
supertag apply -f organization.yaml
```

`-f` takes YAML documents, a JSON array, a directory of manifests, or `-` for standard input.
`diff` prints each change, such as `create Tag/builder` or `assign Role/Builder to Tag/builder`;
it prints `No changes.` when the Control Plane already matches. `apply` applies resources in
dependency order. Applying the same files again changes nothing.

| Kind | Declares |
| --- | --- |
| `PermissionSet` | Allowed actions: `target` (`runtime`, `surface`, or `mcp`), `action`, and optionally `resource`, `scope`, and `approval_required` |
| `ContextSet` | Knowledge items a Task may receive, each with a `type`, `version`, and `config` |
| `Role` | `purpose`, `instructions`, `permissionSets`, `contextSets`, and `execution` |
| `Tag` | `roles`, `instructions`, `allowedActions`, `execution`, `workspace`, `runsOn`, and `acceptsMessagesFrom` |
| `Team` | `members` and `maxConcurrency` |
| `Objective` | An outcome; see [Declare Objectives](#declare-objectives) |
| `Workspace` | A GitHub repository source: `github` with `accountId`, `repositoryId`, `repository`, and a `revision` or `commitSha` |
| `Volume` | A storage `source`: `file:///absolute/path` or `s3://bucket/prefix` |
| `SurfaceAccount`, `SurfaceLocation` | A connected account's identity and Gateway, and a location's Tag and policy; see [Declare Surface Accounts](#declare-surface-accounts) |

A manifest never holds a secret. See [Resource model](../reference/resource-model.md) for every
field.

### Declare Objectives

```yaml
apiVersion: supertag/v1
kind: Objective
metadata: { name: dependency-upkeep }
spec:
  ownerTag: lead
  outcome: Keep dependencies current. Report each upgrade with its test results.
  ongoing: true
  team: core
  budgetLimitMinor: 5000
  budgetCurrency: USD
```

Applying an Objective that does not exist creates it and queues its owner's first turn, as
`supertag objective create` does. Applying it again leaves it alone. Change a running Objective
with `objective set-limits`, `pause`, `resume`, `cancel`, or `complete`. `deadline` takes an
RFC 3339 time with a time zone, and `runtimeActions` narrows what its turns may do.

### Declare Surface Accounts

A Surface Account records a connected account's identity and the Gateway that serves it. Its
credentials come from `supertag setup surface` or `supertag gateway credential store` on that
Gateway's machine, never from the manifest:

```yaml
apiVersion: supertag/v1
kind: SurfaceAccount
metadata: { name: acme-slack }
spec:
  identity: { provider: slack, team_id: T0123456789 }
  enabled: true
  gateway: local
---
apiVersion: supertag/v1
kind: SurfaceLocation
metadata: { name: eng-channel }
spec:
  account_id: acme-slack
  connector_account_id: T0123456789
  tag_id: lead
  scope: { provider: slack, channel_id: C0123456789 }
  enabled: true
  permission_set_ids: [local-tools]
```

A location admits work for its Tag at one channel, repository, chat, or team, and may activate
Permission Sets and Context Sets there.

### Manage an organization as a set

An **apply set** owns the resources and Tag relationships its files declare:

```sh
supertag diff -f org/ --set org --prune
supertag apply -f org/ --set org --prune
```

With `--prune`, apply removes the set's resources that the files no longer declare. It never
touches resources created another way. When another apply set, or a change outside apply, set a
field to a different value, apply refuses it; `--force-conflicts` takes ownership. Use one set per
repository of manifests, and run `diff` in review and `apply` after merge.

### supertag.yaml is not a manifest

`supertag.yaml` configures how one machine runs SuperTag's services; manifests configure the
organization. A `control-plane` service may still name manifests to create on start; see
[Provision resources](../reference/supertag-yaml.md#provision-resources).

## Change resources directly

Some changes have their own commands, which suit one-off edits:

| To | Run |
| --- | --- |
| Create or replace a Tag | `supertag tag put TAG --instructions TEXT` |
| Retire a Tag and keep its history | `supertag tag retire TAG` |
| Create or replace a Role, Permission Set, or Context Set from JSON | `supertag role put FILE`, `supertag permission-set put FILE`, `supertag context-set put FILE` |
| Assign a Role | `supertag role-assignment create` |
| Create or change a Team | `supertag team create TEAM --member TAG`, `supertag team update TEAM` |
| Require labels for a Tag's hosts | `supertag placement runs-on TAG LABEL` |
| Allow direct messages between Tags | `supertag mailbox-grant allow SENDER RECIPIENT` |

A change made outside apply is recorded as its own field owner, so a later `apply` of a different
value reports a conflict instead of silently reverting it.

## Delete a resource

```sh
supertag delete permission-set review-tools
supertag delete team core
```

`delete` handles Teams, Permission Sets, Context Sets, Volumes, Workspaces, and surface
locations. It refuses a resource still in use: a Team while an Objective names it, or a Permission
Set a Role uses. Retire a Tag with `tag retire`, and a Role by putting it with `status: retired`.
To preview an apply set's deletions, use `diff --set NAME --prune`.

## Cancel a Task

```sh
supertag task cancel TASK_ID
```

## Inspect Sessions

A **work Session** is a thread of work a Tag starts beneath another Session, such as an
Objective's. List those started from a Session, or read one with its latest Task and report:

```sh
supertag get session --parent-session SESSION_ID
supertag get session WORK_SESSION_ID
```

## Inspect artifacts

```sh
supertag get artifact --task TASK_ID
supertag artifact download ARTIFACT_ID --path report.md --output report.md
```

See [Artifacts](../reference/artifacts.md).

## Inspect and drain Worker Hosts

```sh
supertag get host
supertag describe host HOST_ID
supertag host drain HOST_ID
```

A draining host finishes its running Task Attempts and claims no new ones. See
[Run Worker Hosts](../guides/workers.md).

## If something goes wrong

- **`apply` reports a conflict.** Another apply set or a direct change owns the field. Change the
  value in that owner's files, or rerun with `--force-conflicts`.
- **`delete` is refused.** Remove what still uses the resource first; the error names it.

## Next

- [Resource model](../reference/resource-model.md)
- [Organize Tags into Teams](../guides/teams.md)
