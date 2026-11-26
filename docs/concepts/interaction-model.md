# How you direct your Tags

With most coding agents, you direct work one task at a time and coordinate the agents running in
parallel yourself. SuperTag changes both: you give Tags jobs, not tasks. You talk to one Tag,
which keeps what it owns from one piece of work to the next, and for bigger work you define the
outcome once and the Tag delivers it with its Team.

An **Objective** records that outcome and how success will be checked. A **Tag** is a persistent,
proactive, multiplayer AI actor with its own identity, responsibilities, permissions, and work history. A **Session** is one Tag's thread of
work and a **Task** is one turn of it; a **Team** is a flat list of member Tags.

For example, ask a Tag to move the product to usage-based billing, with a passing
reconciliation suite and an independent review. An Objective is useful when delivery needs several
pieces of work, reviews, or execution environments. A short question or a small edit can stay in a
conversation with the Tag.

## Talk to a Tag

A conversation with a Tag is a Session of its own. It can happen in the SuperTag desktop app,
in a Slack thread, or on a GitHub issue. A quick question gets an answer. For longer work the Tag
starts a work Session, tells you, and reports the result back in the same conversation. When the
work needs you, the question or approval appears there too, and your next message continues the
conversation. An Objective's progress is in its own conversation and in `supertag describe
objective`. See [Talk to a Tag](../guides/talk-to-a-tag.md).

## Declare an outcome, then steer the work

In a chat-and-task loop, you choose the next piece of work, read its result, and prompt again.
That gives you close control when you are exploring a problem. A declarative Objective instead
states the desired result, evidence for completion, constraints, budget, and deadline. You can
describe an Objective in plain language; declarative does not mean you must write configuration.

For the billing example, specify which plans must reconcile, what must remain compatible, and
whether a person must approve the result. The owning Tag plans the work, starts work Sessions for it,
and reviews what they report. When it needs another Tag, it asks its own Tag's inbox, which
messages that Tag. You
inspect progress, answer questions, and redirect the owner in the Objective's thread when the
requirements change. You do not need to supply every next step.

Completion records an assessment and its evidence. SuperTag does not independently prove that
the assessment is true. Request a separate reviewer and human approval in the outcome when
those checks matter. The owner reports its assessment, and a person completes the Objective, or
approves the assessment when the owner submitted it for review. An Objective that asks you a question
waits for your answer: its turn ends, and the answer starts the next one. The question appears in
the operator inbox and in the Objective overview.

Together, your Teams of Tags make up an **autonomous organization**: Teams may pursue different
Objectives but share one Control Plane, its rules, and its record of the work.
The **Control Plane** stores the organization and schedules work. A **Worker Host** is a machine
or sandbox supplying execution capacity. Each Task Attempt runs there in a **Worker**, which
drives a **harness**, an agent system such as Codex or Claude Code. Work can span hosts and harness sessions while the Objective
and its results remain recorded. See [Define and complete an Objective](../guides/objectives.md).

## Or use an operator thread

An operator thread is a coding-agent session, in Claude Code, Codex, or Cursor, given SuperTag's
skill instructions. It drives SuperTag through the CLI: it helps you turn a conversation into an
Objective, inspect progress, and relay your decisions. It is a way to operate SuperTag, rather than
another organizational resource. Unlike a conversation with a Tag, nothing brings results back
into that thread on its own; it checks the inbox when you ask.

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

Two features in coding agents cover part of this model. As of **November 2026**, their documentation
describes them as follows:

| Feature | Documented behavior | How SuperTag relates |
| --- | --- | --- |
| [`/goal` in Claude Code](https://code.claude.com/docs/en/goal) | Sets a completion condition for the current session. After each turn, a model checks the condition, and Claude keeps working until it holds. | An Objective is a completion condition for a team. It lasts across sessions and machines, and budgets and approvals apply. |
| [`/goal` in Codex](https://learn.chatgpt.com/docs/developer-commands?surface=cli) | Keeps a goal attached to the active chat while work continues. You can edit, pause, resume, or clear it. | The Objective belongs to the organization, not to one chat. |
| [Projects in Claude Code](https://code.claude.com/docs/en/claude-projects) | One conversation starts a thread for each task and runs the threads as parallel cloud sessions that share repositories, instructions, and memory. | A conversation with a Tag can start a work Session for each longer task, as many running as Worker Hosts have capacity for, and the Tag reports each result back in that conversation. Each Tag has its own permissions and runs on the hosts you choose. |
| [Projects in Cursor](https://cursor.com/docs/agent/projects) | A coordinator agent plans the work, delegates it to agents running in parallel on Cloud Agents, and returns finished work to you. Teammates can join a Project, each with their own coordinator, and the coordinators sync with each other. | The owning Tag plans the work and starts Work Sessions for it, and asks other Team members for their part through its inbox; they run on Worker Hosts you connect, with any supported harness. Teammates' Tags message each other and share their Team's Workstream, on different coding agents and machines. |

Project capabilities change. The questions below help you compare their documented behavior with
SuperTag without assuming that the products use the same contracts.

| Decision | SuperTag | What to check in the Project documentation |
| --- | --- | --- |
| Where does work run? | Tasks run on eligible Worker Hosts bound to their Tags. | Which local or hosted environments execute work, and who configures them. |
| Who reviews? | The owner reviews submitted results; the outcome can require a separate reviewer or a person's approval. | Who assesses changes and what makes a result final. |
| What is the goal contract? | An Objective records the outcome, owner, limits, status, and completion assessment across Sessions. | How goals, success criteria, and completion persist between sessions. |
| Can several people direct work? | Multiplayer lets people continue shared work through configured collaboration tools, under access rules. Teammates' Tags message each other and settle details without involving you. | How people share direction, results, and access. |
| How is spending controlled? | Objective budgets with a currency cap provider-reported spend; reporting delays can produce overruns. | Which spending limits apply, what they count, and when they stop execution. |

Choose a single coding-agent chat, with or without `/goal`, when you can supervise one bounded
change and assess the result yourself.
Choose a Project when its documented execution, review, sharing, and spending behavior meet your
needs within the coding product you already use. Choose SuperTag when you want persistent,
proactive, multiplayer actors for engineering work: Tags that keep the goal between pieces of work,
act on their responsibilities without being asked, coordinate with your teammates' Tags, and run on
the coding agents and machines you choose.

For details, see [multiplayer](multiplayer.md),
[Worker Hosts, Worklets, Workers, and harnesses](workers.md), and
[monetary budgets](../reference/coordination.md#monetary-budgets).
