# Context Sets and Permission Sets

SuperTag keeps knowledge and authority separate for every **Task**, one assignment accepted for a
**Tag**, a persistent AI identity with its own responsibilities and permissions.
This is a basic security and governance rule:

> **Context Sets control which reusable knowledge may be added to a Task. Permission Sets control
> what the Task can do.**

Before a Task runs, SuperTag decides which reusable knowledge may be added and which actions are
allowed. Other terms on this page (see the [glossary](../reference/glossary.md)): a **Session**
groups Tasks from the same thread of work; an **Objective** is an outcome a Tag owns; a **Team**
is a flat list of member Tags; a **Skill** is a reusable package of instructions and supporting files; a
**Worker** is the code that completes a Task, and a **harness** connects that Worker to an agent
system; the **Control Plane** stores the **autonomous organization**, all your Teams of Tags with
their shared rules and record of the work, and applies its policy; a **collaboration surface**
links SuperTag to an external work tool.

A [Role](roles.md) is an enduring responsibility assigned to a Tag. It can combine both kinds of
set with a purpose and behavioral instructions. Each Role listed on a Tag contributes its sets to
that Tag's work.

| Concept | Question |
| --- | --- |
| Tag location | Where can people call on the Tag? |
| Context Set | Which shared work, knowledge, and Skills may be added here? |
| Permission Set | Which actions may it perform on connected resources here? |

## Context Sets

Use a Context Set to select:

- Skills available to a Worker;
- metadata summaries of captured [artifacts](../reference/artifacts.md), such as research reports,
  from named source locations for the Tag;
- custom knowledge types resolved by your Workers.

Earlier work from the same conversation is available automatically. Use a Context Set when work
from another Session or tool should be available too. Artifact selections provide IDs and bounded
metadata; the agent retrieves chosen content through its artifact tools. A chat response does not
become a shared artifact unless the agent explicitly captures an output.

Define the set in a resource manifest, apply it, and then activate it for a Tag and location:

```yaml
apiVersion: supertag/v1
kind: ContextSet
metadata:
  name: shared-engineering
spec:
  items:
    - itemKey: skill:code-review
      type: supertag/skill
      version: 1
      required: true
      config:
        reference: code-review
```

```sh
supertag apply -f shared-engineering.yaml
supertag activate context-set shared-engineering --tag engineering \
  --provider github --repo acme/api
```

Artifact selectors use exact collaboration-surface sources and same-Tag work. They are not
available on an Objective's own Tasks through Roles; those Tasks use the catalog's Objective
visibility rules instead.

### Custom knowledge types

A **Context Item** is one entry in a Context Set. A **Context Resolver** is Worker code that turns
an Item into values the harness can use; SuperTag calls those values **Runtime Inputs**. Custom
Context Items use a namespaced type and version:

Add custom items to the Context Set manifest and reapply it with
`supertag apply -f shared-engineering.yaml`.

See [Add a custom Context type](../guides/custom-context.md) for the resolver contract.

Activating a set makes it apply at a particular location. Activation is one-way: this example makes
selected Slack work available from `acme/api`; it does not expose GitHub work back to Slack.

## Permission Sets

Use a Permission Set for collaboration surface resource/actions such as:

- `slack/slack_read_channel` on a Slack channel;
- `messages:read` in a Lark/Feishu chat;
- `contents:read` on a GitHub repository;
- `issues:read` in a Linear team;
- `messages:read` in a Teams channel.

Permission Sets also control powerful tools supplied by a harness or execution environment:

- `commands:execute` allows command or shell tools;
- `files:write` allows file-editing tools and a writable workspace;
- `web:fetch` and `web:search` allow their respective web tools;
- `browser:use` allows browser or computer-use tools when the selected harness supports them.

```yaml
apiVersion: supertag/v1
kind: PermissionSet
metadata:
  name: engineering-access
spec:
  permissions:
    - target: runtime
      action: commands:execute
    - target: runtime
      action: files:write
```

```sh
supertag apply -f engineering-access.yaml
supertag activate permission-set engineering-access --tag engineering \
  --provider slack --channel-id C_ENGINEERING
```

A permission allows an action; it does not automatically add that resource to every prompt. Runtime
actions use names that work across harnesses. Workers translate them into harness-specific controls,
so Permission Sets do not contain names such as Claude Code `Bash` or Codex feature flags.

### Tools of MCP servers

An MCP server gives a Tag tools, such as Sentry's issue tools. A host service lists the
servers its machine provides; see [host MCP servers](../reference/supertag-yaml.md#host-mcp-servers).
A Task can use a server's tool only when a Permission Set grants it as `server/tool`:

```yaml
apiVersion: supertag/v1
kind: PermissionSet
metadata:
  name: triage
spec:
  permissions:
    - { target: mcp, action: "sentry/get_issue_details" }
    - { target: mcp, action: "sentry/update_issue", approval: required }
    - { target: mcp, action: "notion/*" }
```

`notion/*` grants every tool of the `notion` server. The Tag never sees a tool that no grant
names, and SuperTag refuses a call to one. A Task with these grants runs only on a host that
provides `sentry` and `notion`. See [MCP server tools](../reference/iam.md#mcp-server-tools) for
the exact rules.

### Actions that need a decision

Some granted actions should still wait for a person, such as merging a pull request or running
commands during a release. Mark those permissions `approval: required`. List `approvers` to let a
specific operator or a Tag, such as a release manager Tag, decide instead of any operator.

```yaml
apiVersion: supertag/v1
kind: PermissionSet
metadata:
  name: release-engineering
spec:
  approvers:
    - tag:release-manager
  permissions:
    - target: mcp
      action: "github/merge_pull_request"
      resource: "repository:acme/api"
      approval: required
    - target: runtime
      action: commands:execute
      approval: required
```

A gated collaboration surface or MCP call does not run. It returns "approval pending" with a request ID, and the AI
actor continues other work or waits. A Task that would receive a gated runtime action waits for
approval before it starts, whatever its manager asked for. The decider approves once, or for every
matching action in the Objective, so repeated work does not ask again. Shell commands and file
writes inside a harness are not yet gated one by one; the Task-level hold is the control today.
See [IAM approval](../reference/iam.md#approval) for precedence and scope.

Direct activation and Role composition serve different needs. Activate a Context Set or Permission
Set directly when it applies only at a particular location or situation. Reference the set from a
Role when it follows an enduring responsibility wherever a Tag performs work. Both paths still pass
through the same admission and native-provider checks.

## Combine sets without a hierarchy

Multiple sets may be active at one origin:

```text
#engineering: engineering context + engineering permissions
#security:    engineering + security context, engineering + security permissions
```

This gives the security location both bundles without making the security bundle available from
the engineering location. You can combine sets directly without creating a policy hierarchy.

## The boundary to remember

An artifact may mention a repository, but it cannot authorize repository access. A credential may technically reach a workspace, but it cannot create a Tag permission. Context, declared authority, and native provider access must all agree.

This separation lets an operator share relevant organizational knowledge without silently granting
the ability to act on its source. The Control Plane resolves both dimensions at admission and
captures them independently for the Task.

For Runtime Input resolution, immutable plans, Skills, and target selection, see the [context resolution reference](../reference/context-resolution.md).
