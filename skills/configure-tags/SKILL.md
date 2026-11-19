---
name: configure-tags
description: Create Tags and grant them knowledge and authority with Context Sets and Permission Sets, using imperative commands or declarative manifests. Read when a Tag needs to do more than reply in its thread.
---

# Configure Tags, permissions, and context

A Tag starts with the mention lifecycle only: receive an invocation, read its originating
thread, reply there. Everything beyond that is granted explicitly.

The distinction that governs every decision here:

> **Context Sets define what equips a Task. Permission Sets define what the Task is authorized
> to do through collaboration surfaces and harness/runtime tools.**

Knowledge is not authority. A captured artifact may mention a repository; that does not
authorize repository access. Context, declared authority, and native provider access must all
agree, or the Task fails closed.

For the vocabulary, see [Tasks and Sessions](../../docs/concepts/tasks.md) and the
[glossary](../../docs/reference/glossary.md). Operator commands use the local services unless
they pass `--gateway NAME`.

## Create a Tag

```sh
supertag tag put reviewer --instructions "Review changes for correctness and tests." \
  --allow files:read --harness claude-code
```

`tag put` creates or replaces a Tag's instructions, allowed actions, harness, models
(`--model`, default first), efforts (`--effort`), and Workspace (`--workspace-id`, with a pinned
`--workspace-base COMMIT` or a followed local branch, `--workspace-ref BRANCH`). A Worker Host
runs a Tag only when the host may run it: a local host runs every Tag, and a shared one runs the
Tags its Auth Key names. `supertag placement runs-on TAG LABEL...` keeps a Tag on hosts with those
labels. `supertag tag retire TAG` retires a Tag and keeps its history; `--dry-run` shows what
retirement would detach.

One Tag may be the Control Plane's lead Tag, the default Tag `supertag init` creates, which the
terminal UI and desktop app show first. `tag put TAG --lead` or a manifest's `spec.lead: true`
makes a Tag the lead; the Control Plane refuses a second lead and names the current one, so clear
it first with `--lead false`. `tag put` without `--lead` keeps the Tag's current value. An
operator can also create a Tag from the desktop app's New Tag dialog, which offers every harness
and Workspace the connected Worker Hosts serve and, on the local services, can add a folder as a
new Workspace (`supertag workspace add PATH` does the same from the CLI).

A Tag may have 8 [work Sessions](../../docs/reference/coordination.md#open-work-sessions) open at
once by default. Raise or lower it, from 1 to 64, with `tag put TAG --max-work-sessions N` or a
manifest's `spec.maxWorkSessions`.

## Grant authority and knowledge

Permission Sets and Context Sets are **shared** resources. Declare them in manifests, then
reference them through a Role, or activate them at a surface location. The binding decides where
a set applies; a set does not belong to a single Tag. See
[Manage Control Plane resources](../../docs/operations/resources.md).

Grant the narrowest thing that works. Harness tools use the `runtime` target with portable
actions; MCP tools use the `mcp` target with `SERVER/TOOL`:

```yaml
apiVersion: supertag/v1
kind: PermissionSet
metadata: { name: engineering-access }
spec:
  permissions:
    - { target: runtime, action: commands:execute }
    - { target: runtime, action: files:write }
    - { target: mcp, action: github/create_pull_request, resource: "repository:acme/api", approvalRequired: true }
---
apiVersion: supertag/v1
kind: Role
metadata: { name: Builder }
spec:
  purpose: Implement bounded changes with tests.
  instructions: Run the project's checks before reporting, and report the exact commands.
  permissionSets: [engineering-access]
  execution: { harness: claude-code }
---
apiVersion: supertag/v1
kind: Tag
metadata: { name: builder }
spec:
  roles: [Builder]
```

```sh
supertag diff -f team.yaml
supertag apply -f team.yaml
```

A grant with `approvalRequired: true` waits in the operator inbox for each call.

A Tag sets [Schedules](../../docs/reference/coordination.md#schedules), wake-ups for itself,
only when it holds `{ target: runtime, action: schedule:create }`. `supertag init` grants it to
the lead; add it to a set to let another Tag follow up on its own, and leave it out to stop one.

Every Tag keeps [Memory](../../docs/reference/coordination.md#memory) unless its spec sets
`memory: false` (or `supertag tag put TAG --memory false`): short notes it writes with `remember`
and a daily review of its work, plus its harness's own memory (Claude Code's auto-memory,
Codex's memory notes), which Worklets keep per Tag. Turn it off for a Tag that must not carry anything between
conversations. `supertag delete memory --native TAG` drops the harness memory alone.

Two harness rules decide whether `commands:execute` works:

- Claude Code, Cursor, and OpenCode run commands without a sandbox. Their Tasks that may run
  commands run only on a host that lists the harness in `allow-unsandboxed-commands`, as the
  `Builder` above needs `allow-unsandboxed-commands: [claude-code]`; otherwise they wait.
- Current Codex models run commands only in Codex code mode, which SuperTag starts only for a Task
  that also has `web:fetch`. A Codex Tag that should run commands needs
  `{ target: runtime, action: web:fetch }` too, which also opens the network to its commands; see
  [Codex commands and models](../../docs/operations/requirements.md#codex-commands-and-models).

To apply a set only in one channel, activate it at that location:

```sh
supertag permission-set activate engineering-access --tag builder --provider slack \
  --channel-id C0123456789
```

## Manage an organization as a set

`--set NAME` makes an apply set own the resources and Tag relationships it declares; with
`--prune`, it removes those the files no longer declare and never touches others. Preview with
`diff` first:

```sh
supertag diff -f org/ --set org --prune
supertag apply -f org/ --set org --prune
```

## Inspect

```sh
supertag describe tag builder
supertag get role
supertag get permission-set engineering-access
supertag get role-assignment
supertag get surface-location
```

## Cross-surface continuity

A Tag is one actor across every surface. A Session started in Slack stays a Slack thread; the
same Tag asked on GitHub starts its own Session. Share results between them with captured
artifacts and Context Sets, not by granting one location's history to another.

## Verify

- `describe tag` shows the expected Roles, harness, and Workspace.
- `diff` against the same files prints nothing to change after `apply`.
- A Task that needs a missing grant fails closed, and `describe task` names the refusal.
