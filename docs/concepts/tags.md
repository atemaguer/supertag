# Tags

> **Tags are the persistent AI actors that make up a SuperTag organization.**

A **Tag** is a persistent AI actor that holds Roles, owns Objectives, and performs work under
delegated authority. Its identity, work history, and memory outlive the models and machines that
run its work. For example, a reviewer Tag
may read a repository and review changes. It keeps that responsibility and its review history when
its next Task runs on a different model. A Tag keeps the harness it was created with; to use
another harness, create a new Tag, or have the Tag start a work Session on that harness.

You assign work to a Tag by name. A Tag can talk to people in several conversations and start
separate work Sessions. A **Session** groups turns of work, and a **Task** is one turn. The Tag's
**Mailbox** receives messages from other Tags. The same Tag can work across several tools and
keeps its assignments and results across Sessions. Tags work in Teams. Together, your Teams of
Tags make up an **autonomous organization**. Teams may pursue different goals and share one
Control Plane, its rules, and its record of the work.

A Tag is persistent, proactive, and multiplayer:

- **Persistent.** It keeps its goal, responsibilities, and work history while different coding
  agents and machines do the work.
- **Proactive.** Give it a responsibility, as an ongoing
  [Objective](../guides/ongoing-responsibilities.md), and it acts on new reports and alerts without
  being asked. Related responsibilities belong to the same Tag.
- **Multiplayer.** Your teammates direct Tags on the same Control Plane, and Tags in a Team
  message each other and settle details without involving you. See [multiplayer](multiplayer.md).

In security terms, the Tag is a non-human identity in SuperTag's identity and access
management (IAM) model. Each Task still has its own requester, source, policy, and execution needs.

The Tag's identity anchors security and accountability. Knowledge, authority, and audit history
attach to the Tag across harness sessions and execution processes.

Terms used on this page (see the [glossary](../reference/glossary.md)):

- A **Role** describes how a Tag works and what it may do.
- A **Team** is a flat list of member Tags.
- A **Session** groups Tasks from the same conversation.
- A **Context Set** selects reusable knowledge that may be added to a Task; a **Permission Set**
  selects allowed actions.
- A **harness** is the agent system a Task runs on, such as Codex, Claude Code, or Cursor; a
  **Worker Host** is the machine it runs on.
- A **Skill** is a reusable instruction package.
- The **Control Plane** is the service that stores and coordinates the organization; a
  **collaboration surface** links it to an external work tool such as Slack.

One Tag can serve as a shared reviewer in an engineering channel. Several accountable Tags with
distinct Roles can form Teams and work as an autonomous engineering team or organization.

Several people can steer the same Tag, continue its work, and use approved results across Tasks,
channels, and platforms. Unrelated conversations still remain separate Sessions.

## What defines a Tag

| Dimension | Team-facing meaning | SuperTag mechanism |
| --- | --- | --- |
| Identity | Which Tag is acting | Stable Tag ID and audit identity |
| Availability | Where it can be invoked | Tag added to an exact channel, repository, chat, or team |
| Knowledge | What a Task may know | Session continuity and Context Sets |
| Permissions | What it may do | Permission Sets and provider-native authorization |
| Standards | How it works, and to what standards | Roles listed on the Tag |
| Responsibilities | What it must achieve or maintain | Objectives it owns |
| Way of working | How each Task executes | Execution settings (harness, models, efforts), Skills, and environment |

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
Tag + origin + requester + active context + active permissions + execution settings
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
which Task to run. If a responsibility needs its own name, Mailbox, Task history, Team membership,
or accountability, create a separate Tag instead. See
[When to use a Tag or a Role](roles.md#when-to-use-a-tag-or-a-role) for examples.

## Next

- Follow one request through [Tasks and Sessions](tasks.md).
- Learn when to use [Context Sets versus Permission Sets](context-and-permissions.md).
- Decide whether a responsibility needs a [Tag or a Role](roles.md#when-to-use-a-tag-or-a-role).
- See how shared work enables [multiplayer](multiplayer.md).
- For policy snapshots, actions, and security invariants, continue to the [IAM reference](../reference/iam.md).
