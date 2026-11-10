# Core concepts

Start here if you want to understand SuperTag before configuring it.

SuperTag gives engineering work a persistent owner. A Tag is a persistent AI actor with a stable
identity, responsibilities, permissions, and work history. You talk to a Tag or give it an outcome
with success criteria, constraints, a budget, a deadline, and decisions that need a person. It
plans the work, hands pieces to other Tags on its Team, reviews what they report, and keeps going
until the outcome is met or it needs a person's decision. Together, your Teams of
Tags make up an **autonomous organization**: Teams may pursue different outcomes, called
Objectives, but share one Control Plane (the service that stores and coordinates them), one set of
rules, and one record of the work. This page calls it the organization.

A team like that needs actors, responsibilities, goals, work, groups, and ways to
communicate. SuperTag represents each of these directly and keeps them available across model
sessions, process restarts, and the machines that execute work.

```text
Objective: the outcome to achieve, owned by one Tag
    |
    +-- Session: one Tag's thread of work, started beneath the Objective
          |
          +-- Task: one turn of that Session

Team: a flat list of member Tags the Objective may hand work to
Role: an enduring responsibility carried by a Tag
Workstream: a Team's shared record of posts
Mailbox: a Tag's inbox for messages from other Tags
```

## Start with the actor

You assign work to a [Tag](tags.md) by name. It can carry on conversations in several tools and
start separate work Sessions. The same Tag keeps its configuration, open assignments, and results
across those Sessions and when the model or harness changes.

A [Role](roles.md) describes an enduring responsibility such as release management or security
review. Assign a Role to a Tag when the same responsibility should guide that actor across many
pieces of work.

## Give the organization direction

An [Objective](../guides/objectives.md) states an outcome and how the organization will judge
completion. It has a budget, a deadline, and a status. A **Session** is one Tag's thread of work,
and a [Task](tasks.md) is one turn of a Session.

A person directs an Objective in the terminal UI or its home thread. Its owner Tag asks the
person a question when it needs a decision. The work happens in Sessions started beneath it,
including Sessions of other Tags in its Team.

A [Team](../guides/teams.md) is a flat list of member Tags with an optional concurrency limit. An
Objective names one Team; its owner may start a Session of any member, and members may message
each other.

## Communicate within and across Teams

A Tag's [Mailbox](../guides/tag-messaging.md) is its own inbox. Messages from other Tags arrive
there, and several pending messages are handled together in one turn. A message is plain text.

A Team's [Workstream](../guides/workstreams.md) is its shared record of posts. Every member can
read it. A post wakes nobody; a post addressed to Tags reaches those Tags' inboxes.

SuperTag makes Mailboxes and Workstreams available only to the main agent running for a Tag. Any
subagents coordinate inside that local execution instead of communicating as independent members of
the organization.

## Control knowledge and authority

Each Tag is a non-human identity in SuperTag's identity and access management (IAM) model.
A **Context Set** selects reusable knowledge that may be added to a Task. A **Permission Set**
selects actions the Task may perform. Together, [Context Sets and Permission
Sets](context-and-permissions.md) keep two questions separate:

- What reusable knowledge may be added to this Task?
- What actions may this Task perform?

SuperTag answers both questions before work runs and records the result on the Task. The execution
system can narrow those limits, but cannot widen them.

## See where the work runs

The **Control Plane** is the service that stores the organization, applies its rules, and schedules
work. A **Worker Host** is a machine or sandbox that provides execution capacity. A **Worklet**
connects that host to the Control Plane. A **Worker** completes a Task. A **harness** connects the
Worker to an agent system such as Codex or Claude Code.

Read [how SuperTag fits together](how-it-works.md) and the
[execution overview](workers.md) for more detail. Keeping organization and execution separate lets
one organization use different agent systems without making any one of them its source of truth.

When you are ready to use these pieces together, follow
[Define and complete an Objective](../guides/objectives.md).
