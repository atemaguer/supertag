# Core concepts

Start here if you want to understand SuperTag before configuring it.

SuperTag is open infrastructure for persistent, proactive, multiplayer AI actors. It runs
engineering work out of the box, and the same infrastructure runs marketing, sales, support, or a
product of your own. You give these actors jobs, not tasks: the responsibilities they keep up and
the outcomes they deliver. A Tag is a persistent, proactive, multiplayer AI actor with its own
identity, responsibilities, permissions, and work history. Give it an ongoing responsibility and it acts on it without being
asked; your teammates' Tags coordinate with it without involving you. You talk to a Tag or give it an outcome
with success criteria, constraints, a budget, a deadline, and decisions that need a person. It
plans the work, hands pieces to other Tags on its Team, reviews what they report, and keeps going
until the outcome is met or it needs a person's decision. Together, your Teams of
Tags make up an **autonomous organization**: Teams may pursue different outcomes, called
Objectives, but share one Control Plane (the service that stores and coordinates them), one set of
rules, and one record of the work. This page calls it the organization.
[The organizational model](organization.md) relates this structure to organization theory.

The Tags SuperTag comes with are built for engineering work. The concepts below are general: the
same actors, permissions, and coordination are the base for building your own assistants and
products for other kinds of work.

A team like that needs actors, responsibilities, goals, work, groups, and ways to
communicate. SuperTag represents each of these directly and keeps them available across harness
sessions, process restarts, and the machines that execute work.

```text
Objective: the outcome to achieve, owned by one Tag
    |
    +-- Session: one Tag's thread of work, started beneath the Objective
          |
          +-- Task: one turn of that Session

Team: a flat list of member Tags that message each other
Role: how a Tag works and what it may do
Workstream: a Team's shared record of posts
Mailbox: a Tag's inbox for messages from other Tags
```

## Start with the actor

You assign work to a [Tag](tags.md) by name. It can carry on conversations in several tools and
start separate work Sessions. The same Tag keeps its configuration, open assignments, and results
across those Sessions and when the model changes. A Tag keeps one harness; its work Sessions may
run another.

A [Role](roles.md) describes how a Tag works and what it may do, such as the standards and
permissions for release management or security review. Assign a Role to a Tag when the same
standards should guide that actor across all of its work. What the Tag must achieve or maintain
is an Objective.

Each concept answers one question:

| Concept | Question |
| --- | --- |
| Tag | Who is acting? |
| Role | How do they work, and to what standards? |
| Permission Set | What may they do? |
| Objective | What must they achieve or maintain? |
| Task | What are they doing right now? |

## Give the organization direction

An [Objective](../guides/objectives.md) states an outcome and how the organization will judge
completion. It has a budget, a deadline, and a status. A **Session** is one Tag's thread of work,
and a [Task](tasks.md) is one turn of a Session.

A person directs an Objective from the CLI or its home thread. Its owner Tag asks the
person a question when it needs a decision. The work happens in work Sessions of the owner Tag
started beneath it. When the Objective needs another Tag, it asks its own Tag's inbox, which
messages that Tag.

A [Team](../guides/teams.md) is a flat list of member Tags. Members may message each other and
share the Team's Workstream.

## Communicate within and across Teams

A Tag's [Mailbox](../guides/tag-messaging.md) is its own inbox. Messages from other Tags arrive
there, and several pending messages are handled together in one turn. A message is plain text
with a type, such as a question or a blocker. Wake limits keep Tags from waking each other in a
loop.

A Team's [Workstream](../guides/workstreams.md) is its shared record of posts. Every member can
read it. A post wakes nobody. Every inbox turn of a member opens with the posts it has not seen,
the ones addressed to it first. To ask a question or raise a blocker, a Tag sends a message.

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
work. A **Worker Host** is a machine or sandbox that provides execution capacity. Its **Worklet**
connects it to the Control Plane and claims Tasks, and a **Worker** runs each Task Attempt: a
**harness adapter** and the **harness** it drives, an agent system such as Codex or Claude Code. A
**Gateway** is the service clients connect to, and it connects collaboration surfaces such as
Slack.

Read [how SuperTag fits together](how-it-works.md) and the
[execution overview](workers.md) for more detail. Keeping organization and execution separate lets
one organization use different agent systems without making any one of them its source of truth.

When you are ready to use these pieces together, follow
[Define and complete an Objective](../guides/objectives.md).
