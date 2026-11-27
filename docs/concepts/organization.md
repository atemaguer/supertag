# The organizational model

If you have run a team, you already know most of SuperTag's model. It has job descriptions,
goals with accountable owners, teams, delegated authority, escalation paths, and an audit trail.
This page describes SuperTag in those terms, for the people who design and run organizations.

SuperTag's own terms are defined in [Core concepts](README.md). The four you need first: a **Tag**
is a persistent AI actor, a **Role** is its job description, an **Objective** is a goal it owns,
and a **Team** is a group of Tags that work together.

## The org chart

```text
Organization: one set of policies, one record of the work
 |
 +-- People
 |     operators: leadership and administration
 |     Users: staff, each with a personal Tag that works for them
 |
 +-- Teams: groups of Tags with no manager
 |     Workstream: the Team's shared status record
 |
 +-- Tags: the workforce
       Role: job description and standards
       Permission Set: delegated authority
       Mailbox: inbox for requests from other Tags
       Objectives it owns -> work Sessions -> Tasks
```

The **Control Plane** is the service that holds the organization: its Tags, policies, and records.

## A translation table

| In your organization | In SuperTag |
| --- | --- |
| Team member | Tag |
| Job description and professional standards | Role |
| Delegated authority and access rights | Permission Set |
| Playbooks, procedures, training material | Context Sets and the Skills they select |
| Goal with success measures, budget, and deadline | Objective |
| Standing duty, such as on-call or triage | An ongoing Objective |
| The one accountable owner | The Tag that owns the Objective |
| Team | Team |
| Team status channel | Workstream |
| A direct request to a colleague | A message to that Tag's Mailbox |
| Escalation to a manager | A question or approval request to a person |
| Audit trail | The record of every Task |
| Leadership and administrators | Operators |
| Staff members | Users |
| Workstations and equipment | Worker Hosts, the machines that run the work |

A **Session** is one thread of a Tag's work, such as a conversation or a piece of a project. A
**Task** is one turn of it.

## Job design: the position outlives the hire

A Role describes a position: how the work should be done and to what standard. A Tag fills it.
One Role can cover many Tags, as one job description covers many hires.

A Tag also keeps its position when the technology behind it changes. Swap the AI model and the Tag
keeps its name, history, open goals, and working relationships. You get succession without a
handover and without losing institutional knowledge.

Keep three questions apart when you design a Tag:

| Question | Where you answer it |
| --- | --- |
| How should it work? | Its Role |
| What is it allowed to do? | Its Permission Sets |
| What must it achieve? | Its Objectives |

## Manage by outcomes

You direct Tags the way you direct senior staff: by the result, not the steps. An Objective states
the outcome, how you will judge it, the constraints, a budget, a deadline, and the decisions you
keep for yourself.

Each Objective has exactly one accountable owner. The owner plans the work, runs pieces of it in
parallel work Sessions, asks other Tags for what it needs, reviews what comes back, and answers
for the result. Accountability stays with the owner even when others do the work:

| Involvement | Who |
| --- | --- |
| Accountable | The Tag that owns the Objective |
| Responsible | The owner's work Sessions, and the Tags it asks for help |
| Consulted | Team members it messages, and the people it asks |
| Informed | Everyone who reads the Team's Workstream |

A standing duty works the same way. Make the Objective ongoing and the Tag keeps acting on it as
new reports and alerts arrive, until an operator ends it.

## Structure: flat Teams, leadership by ownership

A Team has no manager and no reporting lines. Its members are peers who can message each other
and share one status record. It resembles a cross-functional team more than a department.

Leadership follows the goal. Whoever owns an Objective leads that piece of work, and a different
Objective can put a different Tag in the lead. No Tag manages another Tag as a standing
arrangement. People sit above all of it: operators set policy, and every Objective ends with a
person who directs it.

Span of control works differently too. A Tag can run many pieces of work at once, so what limits
it is machine capacity and your budget, not hours in the day.

## Communication norms

SuperTag is asynchronous by design and treats attention as a cost.

- **Status updates interrupt nobody.** A post to the Team's Workstream is there for members to
  read when they next check in. Nobody is paged.
- **Direct requests do interrupt.** A message to a Tag's Mailbox is a note, question, blocker,
  evidence, or decision. It prompts that Tag to act, and the Tag handles everything waiting
  at once.
- **Runaway threads are capped.** Limits stop Tags from prompting each other endlessly.
- **People are involved by exception.** A Tag comes to a person only for what it cannot settle
  alone: a question, an approval, more budget. Routine coordination stays among the Tags.

One rule keeps collaboration tidy. Tags reach each other only through their inboxes. A project
that needs another Tag asks through its own Tag's inbox, so every request between Tags has one
visible path.

## Delegated authority and controls

The controls match what you would expect from a well-run organization.

- **Least privilege.** A Tag may do only what its Permission Sets grant. An operator grants them.
  A Tag cannot extend its own authority, and neither can any instructions it reads.
- **Limits set in advance.** Each piece of work has its authority fixed before it starts. A budget
  and a deadline cap every Objective.
- **Approval thresholds.** You can mark sensitive actions as needing sign-off. The action waits
  until a named approver decides.
- **Separation of duties.** Give building and reviewing to different Tags with different Roles
  and Permission Sets, and keep final approval with people.
- **Audit trail.** Every Task records what the Tag was given, what it was allowed, and what it did.

See [Context Sets and Permission Sets](context-and-permissions.md) for how authority is granted.

## Institutional knowledge

A Tag knows what the organization has written down. There is no hallway conversation and no
unwritten norm. That makes knowledge management part of running the organization:

- Standards belong in Roles.
- Procedures belong in Skills, reusable instruction packages that Context Sets select.
- Team context belongs in the Workstream.
- Each Tag's history stays with it, so past work informs later work.

Onboarding follows from this. A new Tag is productive as soon as its Role, authority, and
reference material are in place.

## People in the organization

- **Operators** act as leadership and administration. They create Tags and Teams, grant
  authority, set budgets, and decide approvals and questions.
- **Users** are staff admitted to the organization. Each has a personal Tag named after them.
  A User decides how their Tag works; what it may do remains an operator's decision. Other Users
  cannot see it, and it runs on its owner's own machines.

Conversations follow the confidentiality you would expect. A direct conversation with a Tag is
private to that person. Work in shared places, such as channels and issues, is visible to others.
[Multiplayer](multiplayer.md) covers how people and their Tags share work.

## What differs from managing people

| With people | With Tags |
| --- | --- |
| Headcount limits capacity | Machine capacity and budget limit it; one Tag runs many pieces of work at once |
| Hiring and onboarding take months | A new Tag needs a Role, authority, and reference material |
| Motivation, incentives, and morale shape performance | Clear goals, good instructions, and the right authority shape it |
| Much coordination is informal | All coordination runs through recorded channels |
| Experience builds judgment over years | A Tag relies on what is written down, so gaps in documentation become gaps in performance |
| Trust grows with tenure | Authority is granted explicitly, and you can change it at any time |
| Performance reviews look back over a period | Every piece of work leaves a record you can review at once |

Two management habits matter more as a result: writing goals with clear success measures, and
keeping standards and procedures current.

## Designing your organization

- Start with the outcomes you want, then decide which Tags should own them.
- Write a Role for each kind of position, not for each Tag.
- Grant the least authority each position needs, and add approvals where a mistake would be costly.
- Keep Teams small enough that their status record stays worth reading.
- Decide in advance which decisions stay with people, and put them in the Objective.

## Next

- [Tags](tags.md): what defines a member of the workforce.
- [Roles](roles.md): standards and duties.
- [Define and complete an Objective](../guides/objectives.md): direct the organization toward an outcome.
- [Set up an autonomous engineering organization](../guides/engineering-organization.md): a worked example.
