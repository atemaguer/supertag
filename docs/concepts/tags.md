# Tags

> **Tags are the persistent AI identities that make up a SuperTag organization.**

A **Tag** is a persistent AI identity with its own responsibilities and permissions. For example, a
reviewer Tag is responsible for reviewing changes and may read the repository but not edit it. You
assign work to a Tag by name. Each assignment runs as a new harness session, and the Tag is what
persists across those sessions: its configuration, its open assignments, and their results. SuperTag
calls each accepted request or assignment a **Task**, and the place where a Tag receives internal
messages its **Mailbox**. When people call on the Tag from Slack or another shared tool, they
experience it as an AI teammate. The same Tag can work across several tools without losing its
identity. Tags work in Teams under a lead. Together, your Teams of Tags make up an **autonomous
organization**: Teams may pursue different goals but share one Control Plane, its rules, and its
record of the work.

In security terms, the Tag is a non-human identity in SuperTag's identity and access
management (IAM) model. Each Task still has its own requester, source, policy, and execution needs.

This identity is the anchor for security and governance. Knowledge, authority, responsibilities,
work, and audit history attach to an accountable Tag rather than to an interchangeable model
session or temporary execution process.

Terms used on this page (see the [glossary](../reference/glossary.md)):

- A **Role** is an enduring responsibility assigned to a Tag.
- A **Team** is a group of Tags under one lead and shared responsibility.
- A **Session** groups Tasks from the same conversation.
- A **Context Set** selects reusable knowledge that may be added to a Task; a **Permission Set**
  selects allowed actions.
- A **Worker** is the code that completes a Task; a **Worker Profile** is a saved recipe for that
  execution; a **harness** connects the Worker to an agent system such as Codex, Claude Code, or Cursor.
- A **Skill** is a reusable instruction package.
- The **Control Plane** is the service that stores and coordinates the organization; a
  **collaboration surface** links it to an external work tool such as Slack.

One Tag can serve as a shared AI teammate in an engineering channel. Several accountable Tags with
distinct Roles can form Teams and work as an autonomous engineering team or organization.

Several people can steer the same Tag, continue its work, and use approved results across Tasks,
channels, and platforms. Unrelated conversations still remain separate Sessions.

## What defines a Tag

| Dimension | Team-facing meaning | SuperTag mechanism |
| --- | --- | --- |
| Identity | Which teammate is acting | Stable Tag ID and audit identity |
| Availability | Where it can be invoked | Tag added to an exact channel, repository, chat, or team |
| Knowledge | What a Task may know | Session continuity and Context Sets |
| Permissions | What it may do | Permission Sets and provider-native authorization |
| Responsibilities | Which enduring duties guide it | Roles listed on the Tag |
| Way of working | How each Task executes | Task execution requirements, selected Worker Profile, harness, Skills, and environment |

## Where people can call on a Tag

People mention the provider-facing `@SuperTag` identity. The channel, repository, chat, or team
determines which Tag receives the request:

```text
@SuperTag in #engineering -> engineering Tag
@SuperTag in #security    -> security Tag (or another configured Tag)
```

Adding a Tag associates it with one stable surface-account scope. A scope can have at most one
enabled Tag, so every request has one clear destination. The Control Plane stores that association
as part of the Tag's configured locations rather than exposing another resource.

## Where a Tag appears is separate from what it can do

Adding a Tag to a location does not give it general access to everything there. When someone sends
it a request, that request provides only enough access to handle the originating interaction:

- receive the invocation;
- read its originating thread or work item;
- reply to that same origin.

It does not implicitly grant channel history, repository contents, issue creation, or broader tools. Add those through Permission Sets.

## How a request becomes a Task

Before work starts, SuperTag combines the Tag with the current request:

```text
Tag + origin + requester + active context + active permissions + Worker policy
  = Task with recorded policy
```

The source and requester may reduce what the Task can do; they cannot add authority. Policy changes
affect later Tasks, while accepted Tasks keep the policy recorded when they were created.

## Assign responsibilities

A Tag lists the Roles it holds. For example, this actor is both a release manager and a security
reviewer:

```yaml
apiVersion: supertag/v1
kind: Tag
metadata:
  name: release-manager
spec:
  roles:
    - Release Manager
    - Security Reviewer
```

All active Roles listed on a Tag apply to its work. A Role does not create another actor or choose
which Task to run. If a responsibility needs its own name, mailbox, Task history, Team membership,
or accountability, create a separate Tag instead. See
[When to use a Tag or a Role](roles.md#when-to-use-a-tag-or-a-role) for examples.

## Next

- Follow one request through [Tasks and Sessions](tasks.md).
- Learn when to use [Context Sets versus Permission Sets](context-and-permissions.md).
- Decide whether a responsibility needs a [Tag or a Role](roles.md#when-to-use-a-tag-or-a-role).
- See how shared work enables [multiplayer continuity](multiplayer.md).
- For policy snapshots, actions, and security invariants, continue to the [IAM reference](../reference/iam.md).
