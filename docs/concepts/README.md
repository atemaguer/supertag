# Core concepts

Start here if you want to understand SuperTag before configuring it.

SuperTag lets you define outcomes instead of tasks, and an AI engineering team delivers them. You
set an outcome: the result, how success is verified, the constraints, budget, and deadline, and
which decisions need a person. A team plans the work, divides it, reviews each other's
results, and keeps going until the outcome is met or it needs a person's decision. Its members
are persistent AI identities called Tags, grouped into Teams under a lead. Together, your Teams of
Tags make up an **autonomous organization**: Teams may pursue different outcomes, called
Objectives, but share one Control Plane (the service that stores and coordinates them), one set of
rules, and one record of the work. This page calls it the organization.

A team like that needs actors, responsibilities, goals, assignments, groups, and ways to
communicate. SuperTag represents each of these directly and keeps them available across model
sessions, process restarts, and the machines that execute work.

```text
Objective: the outcome to achieve
    |
    +-- Team: the group responsible for part of the outcome
          |
          +-- Tag: a persistent AI identity
                |
                +-- Role: an enduring responsibility
                +-- Task: one current assignment

Workstream: each Team's channel for shared posts
Mailbox: direct delivery to one Tag
```

## Start with the actor

A [Tag](tags.md) is a persistent AI identity with its own responsibilities and permissions. You
assign work to a Tag by name. Each assignment runs as a new harness session, and the Tag is what
persists across those sessions: its configuration, its open assignments, and their results. People
may experience a Tag as a teammate in Slack or another shared tool, but the Tag exists independently
of that tool.

A [Role](roles.md) describes an enduring responsibility such as release management or security
review. Assign a Role to a Tag when the same responsibility should guide that actor across many
assignments.

## Give the organization direction

An [Objective](../guides/objectives.md) states an outcome and how the organization will judge
completion. A [Task](tasks.md) is one assignment accepted for a Tag. A **Session** groups Tasks
from the same conversation so follow-up work can continue naturally.

A [Team](../guides/teams.md) groups Tags around a shared responsibility. It has a lead, members, and
a capacity limit. The lead can divide an Objective into Tasks and delegate them to Team members.

## Communicate within and across Teams

Every Team has one channel, its [Workstream](../guides/workstreams.md), created with the Team. Its
members post progress, questions, and findings there, and the Objective owner reads every channel
in its Objective. An addressed question or blocker can wake an idle teammate to reply, within
fixed limits. Posts do not assign work. A
[Mailbox](../guides/tag-messaging.md) delivers a message to one Tag, including messages to other
Teams and up or down the organization hierarchy.

SuperTag makes Team channels and Mailboxes available only to the main agent running for a Tag. Any
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
[Objective coordination](../guides/objective-coordination.md).
