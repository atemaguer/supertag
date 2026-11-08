# How you direct an AI engineering team

With most coding agents, you direct work one task at a time and coordinate the parallel sessions
yourself. SuperTag changes both: you define an outcome once, and one operator thread
directs a team that delivers it.

An **Objective** records that outcome and how success will be checked. A **Tag** is a persistent
AI identity with its own responsibilities and permissions. A **Session** is one Tag's thread of
work and a **Task** is one turn of it; a **Team** is a flat list of member Tags.

For example, ask a team to move the product to usage-based billing, with a passing
reconciliation suite and an independent review. This model is useful when delivery needs several pieces of work, reviews, or
execution environments. A short question or a small edit can stay in one coding-agent session.

## Declare an outcome, then steer the work

In a chat-and-task loop, you choose the next piece of work, read its result, and prompt again.
That gives you close control when you are exploring a problem. A declarative Objective instead
states the desired result, evidence for completion, constraints, budget, and deadline. You can
describe an Objective in plain language; declarative does not mean you must write configuration.

For the billing example, specify which plans must reconcile, what must remain compatible, and
whether a person must approve the result. The owning Tag plans the work, starts Sessions for it,
including Sessions of other Tags in the Objective's Team, and reviews what they report. You
inspect progress, answer questions, and redirect the owner in the Objective's thread when the
requirements change. You do not need to supply every next step.

Completion records an assessment and its evidence. SuperTag does not independently prove that
the assessment is true. Request a separate reviewer and human approval in the outcome when
those checks matter. The owner normally completes the Objective; when the statement requires
a person's review, it submits the result for that decision. An Objective that asks you a question
waits for your answer: its turn ends, and the answer starts the next one. The question appears in
the operator inbox and in the Objective overview.

Together, your Teams of Tags make up an **autonomous organization**: Teams may pursue different
Objectives but share one Control Plane, its rules, and its record of the work.
The **Control Plane** stores the organization and schedules work. A **Worker Host** is a machine
or sandbox supplying execution capacity. A **Worker** completes a Task there, using an execution
system such as a coding harness. Work can span hosts and harness sessions while the Objective
and its results remain recorded. See [Define and complete an Objective](../guides/objectives.md).

## Use an operator thread

An operator thread is a coding-agent session given SuperTag's skill instructions. It plays the
part of a Project's coordinating conversation: it helps you turn a conversation into an Objective,
inspect the team's progress, and relay your decisions. It is a way to operate SuperTag, rather than
another organizational resource.

For example, use the thread to refine the billing acceptance criteria before starting work. Later,
ask it which results await review or why delivery has stopped. The session uses the SuperTag
access you configured; reading a skill does not grant additional permissions.

The operator session and the owning Tag have different responsibilities. The session helps
you direct the organization. The owning Tag coordinates the accepted Objective. Closing the
operator thread does not delete the Objective, although execution still needs a running
Control Plane and available Worker Hosts.

See [Run SuperTag from your coding agent](../guides/coding-agent-operator.md) for setup
and the working loop.

## Compare `/goal`, Projects, and SuperTag

Two features in coding agents cover part of this model. As of **October 2026**, their documentation
describes them as follows:

| Feature | Documented behavior | How SuperTag relates |
| --- | --- | --- |
| [`/goal` in Claude Code](https://code.claude.com/docs/en/goal) | Sets a completion condition for the current session. After each turn, a model checks the condition, and Claude keeps working until it holds. | An Objective is a completion condition for a team. It lasts across sessions and machines, and budgets and approvals apply. |
| [`/goal` in Codex](https://learn.chatgpt.com/docs/developer-commands?surface=cli) | Keeps a goal attached to the active chat while work continues. You can edit, pause, resume, or clear it. | The Objective belongs to the organization, not to one chat. |
| [Projects in Claude Code](https://code.claude.com/docs/en/claude-projects) | One conversation starts a thread for each task and runs the threads as parallel cloud sessions that share repositories, instructions, and memory. | A conversation with a Tag can start a work Session for each longer task, up to four running at once, and the Tag reports each result back in that conversation. An operator thread plays the same coordinating role across Tags, which have their own permissions and run on the hosts you choose. |
| [Projects in Cursor](https://cursor.com/docs/agent/projects) | A coordinator agent plans the work, delegates it to agents running in parallel on Cloud Agents, and returns finished work to you. | The owning Tag plans the work and starts Sessions for it, including Sessions of other Team members; they run on Worker Hosts you connect, with any supported harness. |

Project capabilities change. The questions below help you compare their documented behavior with
SuperTag without assuming that the products use the same contracts.

| Decision | SuperTag | What to check in the Project documentation |
| --- | --- | --- |
| Where does work run? | Tasks run on eligible Worker Hosts bound to their Tags. | Which local or hosted environments execute work, and who configures them. |
| Who reviews? | The owner reviews submitted results; the outcome can require a separate reviewer or a person's approval. | Who assesses changes and what makes a result final. |
| What is the goal contract? | An Objective records the outcome, owner, limits, status, and completion assessment across Sessions. | How goals, success criteria, and completion persist between sessions. |
| Can several people direct work? | Multiplayer lets people continue shared work through configured collaboration tools, under access rules. | How people share direction, results, and access. |
| How is spending controlled? | Objective budgets with a currency cap provider-reported spend; reporting delays can produce overruns. | Which spending limits apply, what they count, and when they stop execution. |

Choose a single session, with or without `/goal`, when you can supervise one bounded change and
assess the result yourself.
Choose a Project when its documented execution, review, sharing, and spending behavior meet your
needs within the coding product you already use. Choose SuperTag when you need an AI engineering
team with recorded ownership, work, and limits across sessions and execution environments.

For details, see [multiplayer continuity](multiplayer.md),
[Worker Hosts and Workers](workers.md), and
[monetary budgets](../reference/coordination.md#monetary-budgets).
