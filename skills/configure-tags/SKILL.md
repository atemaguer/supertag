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
[glossary](../../docs/reference/glossary.md). Every operator command names its Control Plane:
`--state-directory ~/.supertag` for local services, or `--control-plane NAME`.

## Create a Tag

```sh
supertag tag put reviewer --instructions "Review changes for correctness and tests." \
  --allow files:read --harness claude-code --state-directory ~/.supertag
```

`tag put` creates or replaces a Tag's instructions, allowed actions, harness, models
(`--model`, default first), efforts (`--effort`), and Workspace (`--workspace-id`). A Worker Host
runs a Tag only when the host may run it: a local host runs every Tag, and a shared one runs the
Tags its Auth Key names. `supertag placement runs-on TAG LABEL...` keeps a Tag on hosts with those
labels. `supertag tag retire TAG` retires a Tag and keeps its history; `--dry-run` shows what
retirement would detach.

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
    - { target: mcp, action: github/create_pull_request, resource: "repository:acme/api", approval_required: true }
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
supertag diff -f team.yaml --state-directory ~/.supertag
supertag apply -f team.yaml --state-directory ~/.supertag
```

A grant with `approval_required: true` waits in the operator inbox for each call. To apply a set
only in one channel, activate it at that location:

```sh
supertag permission-set activate engineering-access --tag builder --provider slack \
  --channel-id C0123456789
```

## Manage an organization as a set

`--set NAME` makes an apply set own the resources and Tag relationships it declares; with
`--prune`, it removes those the files no longer declare and never touches others. Preview with
`diff` first:

```sh
supertag diff -f org/ --set org --prune --state-directory ~/.supertag
supertag apply -f org/ --set org --prune --state-directory ~/.supertag
```

## Inspect

```sh
supertag describe tag builder --state-directory ~/.supertag
supertag get role --state-directory ~/.supertag
supertag get permission-set engineering-access --state-directory ~/.supertag
supertag get role-assignment --state-directory ~/.supertag
supertag get surface-location --state-directory ~/.supertag
```

## Cross-surface continuity

A Tag is one actor across every surface. A Session started in Slack stays a Slack thread; the
same Tag asked on GitHub starts its own Session. Share results between them with captured
artifacts and Context Sets, not by granting one location's history to another.

## Verify

- `describe tag` shows the expected Roles, harness, and Workspace.
- `diff` against the same files prints nothing to change after `apply`.
- A Task that needs a missing grant fails closed, and `describe task` names the refusal.
