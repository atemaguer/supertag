# The organizational model

SuperTag organizes AI actors the way organization theory describes human ones: as positions,
goals, groups, and ways to coordinate. This page explains that model and the ideas it borrows.
It also says where the comparison stops holding, because AI actors differ from employees in ways
that matter.

The terms below are defined in [Core concepts](README.md). In short: a **Tag** is a persistent AI
actor, a **Role** says how it works, an **Objective** is an outcome it owns, and a **Team** is a
flat list of Tags that coordinate.

## The model in one picture

```text
Organization: one Control Plane, one set of rules, one record of the work
 |
 +-- People
 |     operators: govern the organization, grant authority, decide approvals
 |     Users: each owns a personal Tag that works for them
 |
 +-- Teams: flat lists of member Tags
 |     Workstream: the Team's shared record of posts
 |
 +-- Tags: persistent actors
       Role: how the Tag works, to what standards
       Permission Set: what it may do
       Mailbox: its inbox for messages from other Tags
       Objectives it owns -> work Sessions -> Tasks
```

The **Control Plane** is the service that stores all of this. Machines that run the work, called
**Worker Hosts**, sit outside the picture on purpose: the organization stays the same whichever
machine or agent system does the work.

## Positions and the people who fill them

Max Weber's account of bureaucracy separates the office from the person who holds it. The office
carries duties, authority, and records; holders come and go. SuperTag makes the same split twice.

| Organization theory | SuperTag |
| --- | --- |
| Office, position | A Role: standards and duties a Tag works to |
| Officeholder | A Tag that holds the Role |
| Delegated authority | A Permission Set, granted by an operator |
| Files and records | Each Task's recorded inputs, decisions, and results |

The second split is between the actor and the model that runs it. A Tag keeps its name, history,
and open Objectives when its model or harness changes, much as a position keeps its files when a
new person fills it. This is what makes a Tag persistent rather than a chat session.

Authority flows from people, never from the work. A Tag cannot widen its own permissions. A
[Skill](context-and-permissions.md) can add instructions, not authority. Execution can narrow what
a Task may do, never widen it.

## How work gets coordinated

Henry Mintzberg describes a few mechanisms organizations use to coordinate work. Each one appears
in SuperTag as a concrete resource.

| Mechanism | Meaning | SuperTag |
| --- | --- | --- |
| Mutual adjustment | Peers coordinate by talking | Mailbox messages between Tags: notes, questions, blockers, evidence, decisions |
| Direct supervision | One actor directs and reviews others' work | An Objective's owner Tag starts work Sessions, then reviews what they report |
| Standardized processes | Work follows a defined method | Roles and Skills |
| Standardized outputs | Work is judged by its result | An Objective's success criteria and completion assessment |
| Standardized skills | Members bring trained capability | The harness and model a Tag runs on, plus its Context Sets |

Most SuperTag work combines three of these. An Objective sets the output. The owner supervises its
own work Sessions. Tags on a Team adjust to each other through their Mailboxes.

James Thompson classifies how work depends on other work. SuperTag handles each kind:

- **Pooled:** Teams pursue separate Objectives but share one Control Plane, one set of rules, and
  the same Worker Hosts.
- **Sequential:** one Tag's output feeds another's, as when a builder's change goes to a reviewer.
  The owner hands the piece over through its inbox.
- **Reciprocal:** two Tags need each other's answers. They trade questions and blockers in their
  Mailboxes until both can proceed.

## Attention is the scarce resource

Herbert Simon observed that a wealth of information creates a poverty of attention. Every message
that wakes a Tag costs a turn, and a person's attention costs more. SuperTag rations both.

- **Posts wake nobody.** A Team's Workstream is a shared record. Members read unseen posts at their
  next inbox turn. Jay Galbraith calls this a lateral information channel: it spreads context
  without interrupting anyone.
- **Messages wake, in batches.** A Mailbox message wakes its Tag, and every message waiting then
  is handled in one turn.
- **Wake limits stop loops.** Tags cannot keep waking each other indefinitely.
- **People handle exceptions.** Frederick Taylor called this the exception principle. A Tag asks a
  person only for a decision it cannot make: a question, an approval, a budget. Everything else
  stays inside the organization.

## Delegation, budgets, and oversight

Agency theory, from Michael Jensen and William Meckling, studies what happens when a principal
delegates work to an agent whose actions it cannot fully see. The principal pays to specify the
work, to monitor it, and to recover from mistakes. SuperTag reduces each cost.

| Agency cost | SuperTag's answer |
| --- | --- |
| Specifying the work | An Objective states success criteria, constraints, and the decisions a person keeps |
| Bounding the risk | A budget, a deadline, and a Permission Set fixed before each Task runs |
| Monitoring | A record of every Task: what it saw, what it was allowed, what it did |
| Retaining control | Approval requests for gated actions, decided by operators or a Tag's owner |

The agency problem changes shape with AI actors. A Tag does not shirk or pursue its own career.
Its risks are misunderstanding, overconfidence, and acting on untrusted input. That is why
SuperTag puts its controls on specification and authority rather than on incentives.

## Decomposition and boundaries

Simon argued that complex systems stay manageable when they are nearly decomposable: strong
interactions within parts, weak and narrow ones between them. SuperTag follows that rule.

- An Objective breaks into work Sessions, and each work Session into Tasks.
- Inside one Tag, its Sessions share notes and results.
- Between Tags, one door is open: the inbox. An Objective reaches another Tag only by asking its
  own Tag's inbox, which messages the other Tag.

The narrow interface keeps each Tag's work understandable on its own. Melvin Conway noticed that
systems mirror the communication structure of the organizations that build them. Where you draw
Teams and Mailbox paths will shape what your Tags build.

## Memory and knowing who knows what

Organizational memory is what a group keeps beyond any one member. Daniel Wegner's transactive
memory adds that groups also remember who knows what.

- A Tag's work history lives in the Control Plane and survives restarts and host changes. Its
  harness's own [Memory](../reference/coordination.md#memory) stays on the Worker Host that kept it;
  [Persistence](persistence.md) says what survives where.
- A Team's Workstream is a shared record any member can read later.
- Stable Tag names let Tags route a question to the actor that knows the answer.

## People in the organization

People hold two kinds of position.

- **Operators** govern. They create Tags and Teams, grant authority, set budgets, and decide
  approvals and questions.
- **Users** are people admitted to the Control Plane. Each User owns a personal Tag named after
  them. They configure how it works; what it may do stays an operator's decision. Other Users
  never see it, and it runs on its owner's machines.

A User can also lend a machine to another Tag, to run only that Tag's work Sessions. This resembles
a matrix organization: the machine belongs to one person but contributes capacity to shared work,
without holding the Tag's conversations or long-lived secrets.

## Structure: flat Teams, ownership as hierarchy

A Team has no manager. Its members are peers, which matches Mintzberg's adhocracy: experts
coordinating by mutual adjustment around a shared problem.

Hierarchy comes from ownership instead. The Tag that owns an Objective plans it, hands pieces to
other Tags, reviews what they report, and answers for the result. A Tag owns its Objective; it
never owns another Tag. Different Objectives can give the same Tags different leads.

## Where the analogy stops

Organization theory describes people. These differences change the design:

| People | Tags |
| --- | --- |
| One body, one task at a time | A Tag runs many Sessions at once, bounded by Worker Host capacity |
| Hiring takes weeks | A new Tag takes one configuration change |
| Motivation and incentives shape effort | No incentives; instructions, context, and authority shape the work |
| Informal networks carry much of the coordination | Nothing informal exists; coordination happens only through recorded channels |
| Tacit knowledge lives in heads | Knowledge must be written down: Roles, Skills, Memory, the Workstream |
| Trust builds over time | Trust is granted explicitly and recorded, then narrowed per Task |

The last two rows explain much of SuperTag's design. A Tag remembers and can be trusted with only
what the organization writes down and grants.

## Next

- [Tags](tags.md): what defines an actor.
- [Roles](roles.md): standards and duties.
- [Multiplayer](multiplayer.md): how people and their Tags share work.
- [Define and complete an Objective](../guides/objectives.md): direct the organization toward an outcome.
