# SuperTag and other agent systems

SuperTag gives engineering work a persistent owner, a Tag, that runs on any model, harness, and
environment. Models and agent systems perform the work. SuperTag keeps the actors, responsibilities, goals, authority, communication, and
results organized over time.

If these terms are new, start with [core concepts](README.md).

Security and accountability are part of that design. Each **Tag** is a persistent AI actor with its
own responsibilities and permissions. SuperTag gives each Tag a non-human identity in its access
model. A **Context Set** selects reusable knowledge that may be included, a **Permission Set**
selects allowed actions, and a **Task** is one turn of work that records the policy that
applies to it.

A **Role** is an enduring responsibility assigned to a Tag. A **Team** is a flat list of member
Tags, and its shared record of posts is its **Workstream**. An **Objective** is an outcome a Tag
owns. A **Mailbox** is a Tag's inbox for messages from other Tags. Together, your Teams of Tags make up an **autonomous
organization**: Teams may pursue different Objectives but share one Control Plane, its rules, and
its record of the work. The **Control Plane** is the service that stores the organization
and applies its rules. **Worker Hosts** are machines or sandboxes that run the work. On them, a
**Worker** completes each Task, often through a **harness** that connects it to an agent system such
as Codex.

Agent systems evolve quickly. This comparison describes what each project is mainly built around as
of September 2026. The links point to the projects' own documentation.

## Different layers

| System | What it is built around | How it relates to SuperTag |
| --- | --- | --- |
| [Claude Tag](https://www.anthropic.com/news/introducing-claude-tag) | A shared AI teammate in Slack that can use channel context, tools, and proactive work | A recognizable multiplayer application pattern that can be built on organizational infrastructure |
| [OpenAI dots](https://openai.com/index/introducing-dots/) | An always-on personal agent with its own cloud computer, plus specialist dots that hold roles inside a company | Personal and role-based actors that an organization can also define as Tags, on any model |
| [Grok Bot](https://x.ai/news/introducing-grok-bot) | A team of always-on Bots with their own computer, where Bots message each other and one can manage the rest | A team of agents inside one product; SuperTag keeps Teams, authority, and records across different harnesses and hosts |
| [OpenClaw](https://docs.openclaw.ai/) | A self-hosted personal assistant Gateway with channels, sessions, routing, and [multiple isolated agents](https://docs.openclaw.ai/concepts/multi-agent) | An assistant and agent runtime; SuperTag adds lasting organization records and controls |
| [Hermes Agent](https://hermes-agent.nousresearch.com/docs/) | A general autonomous agent with persistent memory, specialist Bots, goals, and [multi-agent Kanban coordination](https://hermes-agent.nousresearch.com/docs/user-guide/features/kanban) | An agent runtime and coordination system; SuperTag focuses on organization identity, authority, and work across different harnesses and hosts |
| [Codex](https://learn.chatgpt.com/docs/codex/cli), [Claude Code](https://code.claude.com/docs/en/overview), and [OpenCode](https://opencode.ai/docs/) | harnesses that execute agentic work in a local or hosted environment | Execution systems a SuperTag Worker can use for one accepted Task |
| SuperTag | An organizational Control Plane and Worker Hosts | The layer that records who acts, why work exists, how Teams coordinate, and which limits apply |

These categories overlap. Grok Bot coordinates several Bots, and dots plans teams of dots. OpenClaw
can route work among isolated agents. Hermes Agent can coordinate specialist Bots and persistent
work boards. Coding harnesses can delegate to native subagents. SuperTag focuses on designing and
operating the **autonomous organization itself**.

## What SuperTag keeps over time

SuperTag represents the parts of an organization that must survive any one prompt, model process,
or harness session:

- **Tags and Roles** define accountable actors and their enduring responsibilities.
- **Teams** establish membership and a shared concurrency limit.
- **Objectives, Sessions, and Tasks** connect desired outcomes to the work that delivers them and
  to its evidence.
- **Workstreams and Mailboxes** carry communication. A Team's Workstream holds the posts its
  members share. A Mailbox is where one Tag receives another's messages, inside a Team or across
  Teams by grant.
- **Context Sets and Permission Sets** separate reusable knowledge from authority.
- **Requester and source rules, budgets, approvals, scoped credentials, and Task policy records**
  prevent execution from silently gaining more authority.
- **Recovery and audit** preserve accountability when work spans processes, retries, and hosts.
- **Worker Hosts, Workers, and harnesses** let the same organization use different execution
  engines and run across distributed capacity.

Coordination inside a harness stays local to that harness. Its manager and native subagents can use
the harness's own communication primitives for tightly coupled work. Communication between Tags crosses the
SuperTag boundary through durable Tasks and Mailboxes. Members of one Team also share its
Workstream.

## Applications built on SuperTag

The same infrastructure can support increasingly broad applications:

```text
shared AI teammate  ->  specialized AI Team  ->  multi-Team AI organization
```

A Slack-native multiplayer teammate is one product experience. A larger application may give
several Tags distinct Roles, place them in Teams, and let an Objective's owner start Sessions of
its teammates.
Another may provide no chat surface at all and direct the organization through an API or a custom
control interface.

“Autonomous” means the organization can work on its own within limits. Humans decide the authority,
budgets, approval points, knowledge boundaries, and intervention paths. SuperTag checks those rules
before work reaches execution.
SuperTag does not provide the underlying model intelligence, and describing a “Claude Tag-like”
application pattern does not claim compatibility with or affiliation to Anthropic's product.

## Choose by the layer you need

- Use a multiplayer assistant when the product is one shared collaborator in an existing channel.
- Use an agent runtime when the main need is to run one or more agents with sessions, tools,
  memory, and local delegation.
- Use a coding harness when the main need is agentic software work in a repository or sandbox.
- Use SuperTag when the durable unit you need to design and operate is an organization: accountable
  actors organized into Teams, pursuing Objectives, coordinating across boundaries, and executing
  through interchangeable Workers and harnesses.

Continue to [How SuperTag fits together](how-it-works.md) for the runtime architecture or start with
[Tags](tags.md), [Roles](roles.md), [Teams](../guides/teams.md), and
[Define and complete an Objective](../guides/objectives.md) for the organizational model.
