# SuperTag and other agent systems

SuperTag is open infrastructure for persistent, proactive, multiplayer AI actors. Each actor, a
Tag, owns outcomes and ongoing responsibilities. Your coding agents do the work; the Tag keeps the
goal, acts on its responsibilities without being asked, and coordinates with your teammates' Tags.
It runs on the coding agents and machines you choose.

Engineering works out of the box. The same infrastructure runs marketing, sales, support, or any
other function, and it is the base for a product of your own. This page compares SuperTag with
systems in each of those roles.

If these terms are new, start with [core concepts](README.md).

Security and accountability are part of that design. Each **Tag** is a persistent, proactive,
multiplayer AI actor with its own identity, responsibilities, permissions, and work history.
SuperTag gives each Tag a non-human identity in its access
model. A **Context Set** selects reusable knowledge that may be included, a **Permission Set**
selects allowed actions, and a **Task** is one turn of work that records the policy that
applies to it.

A **Role** describes how a Tag works and what it may do. A **Team** is a flat list of member
Tags, and its shared record of posts is its **Workstream**. An **Objective** is an outcome a Tag
owns. A **Mailbox** is a Tag's inbox for messages from other Tags. Together, your Teams of Tags make up an **autonomous
organization**: Teams may pursue different Objectives but share one Control Plane, its rules, and
its record of the work. The **Control Plane** is the service that stores the organization
and applies its rules. **Worker Hosts** are machines or sandboxes that run the work. On a Worker
Host, each Task Attempt runs in a **Worker** that drives a **harness**, an agent system such as
Codex.

Agent systems evolve quickly. This comparison describes what each project is mainly built around as
of November 2026. The links point to the projects' own documentation.

## Different layers

| System | What it is built around | How it relates to SuperTag |
| --- | --- | --- |
| [Claude Tag](https://www.anthropic.com/news/introducing-claude-tag) | A shared AI teammate in Slack that can use channel context, tools, and proactive work | A recognizable multiplayer application pattern that can be built on organizational infrastructure |
| [OpenAI dots](https://openai.com/index/introducing-dots/) | An always-on agent on OpenAI's models with its own cloud computer. It works toward your goals in the background and hands heavy work to Codex | Also persistent and proactive. Tags run on the coding agents you choose, on your own machines, under rules you set, and you can build your own dots-like assistant on SuperTag |
| [Grok Bot](https://x.ai/news/introducing-grok-bot) | A team of always-on Bots that share a computer in the cloud, message each other, and can manage one another | A team of agents inside one product. Tags coordinate across different coding agents and machines |
| [Cursor Projects](https://cursor.com/docs/agent/projects) and [Claude Code Projects](https://code.claude.com/docs/en/claude-projects) | A coordinator agent that plans long-running work and delegates it to agents, mostly in the vendor's cloud. Cursor lets teammates join a Project | Each runs one vendor's agents. Teammates' Tags can run on Claude Code, Codex, Cursor, or OpenCode and still work together |
| [OpenClaw](https://docs.openclaw.ai/) | A self-hosted personal assistant Gateway with channels, routing, and [multiple isolated agents](https://docs.openclaw.ai/concepts/multi-agent) | A personal assistant. Tags are built for teams and organizations: they have Roles, work in Teams, own outcomes that come with evidence, and act only within the permissions and approvals you set |
| [Hermes Agent](https://hermes-agent.nousresearch.com/docs/) | A general autonomous agent with persistent memory, specialist Bots, goals, and [multi-agent Kanban coordination](https://hermes-agent.nousresearch.com/docs/user-guide/features/kanban) | A general agent runtime. SuperTag focuses on Teams with Roles, shared outcomes, permissions, and work across different coding agents and machines |
| [Claude Managed Agents](https://platform.claude.com/docs/en/managed-agents/overview) and the [OpenAI Agents API](https://developers.openai.com/api/docs/guides/agents-api/overview) | Agent platforms that run agents you build as a managed service, with hosted sessions and sandboxes | Each runs one company's models, with the agent loop on that company's servers, and leaves identity, teams, and responsibilities to you. SuperTag runs on your machines across Claude Code, Codex, Cursor, and OpenCode, with Tags, Roles, Teams, and outcomes ready to configure |
| [Codex](https://learn.chatgpt.com/docs/codex/cli), [Claude Code](https://code.claude.com/docs/en/overview), and [OpenCode](https://opencode.ai/docs/) | harnesses that execute agentic work in a local or hosted environment | Execution systems a SuperTag Worker Host can run one accepted Task on |
| SuperTag | An organizational Control Plane and Worker Hosts | The layer that records who acts, why work exists, how Teams coordinate, and which limits apply |

These categories overlap. Grok Bot coordinates several Bots, and dots plans teams of dots. OpenClaw
can route work among isolated agents. Hermes Agent can coordinate specialist Bots and persistent
work boards. Coding harnesses can delegate to native subagents. SuperTag focuses on designing and
operating the **autonomous organization itself**.

## What SuperTag keeps over time

SuperTag represents the parts of an organization that must survive any one prompt, model process,
or harness session:

- **Tags and Roles** define accountable actors, how they work, and what they may do.
- **Teams** establish membership.
- **Objectives, Sessions, and Tasks** connect desired outcomes to the work that delivers them and
  to its evidence.
- **Workstreams and Mailboxes** carry communication. A Team's Workstream holds the posts its
  members share. A Mailbox is where one Tag receives another's messages, inside a Team or across
  Teams by grant.
- **Context Sets and Permission Sets** separate reusable knowledge from authority.
- **Requester and source rules, budgets, approvals, and Task policy records**
  prevent execution from silently gaining more authority.
- **Recovery and audit** preserve accountability when work spans processes, retries, and hosts.
- **Worker Hosts, Workers, and harnesses** let the same organization use different execution
  engines and run across distributed capacity.

Coordination inside a harness stays local to that harness. Its manager and native subagents can use
the harness's own communication primitives for tightly coupled work. Communication between Tags crosses the
SuperTag boundary through durable Tasks and Mailboxes. Members of one Team also share its
Workstream.

## Applications built on SuperTag

SuperTag's own engineering Tags are one application of its infrastructure. You can build others
for your own use case, such as a support assistant in your team's Slack, a research Team, or an
operations Tag that watches your systems, with the same identity, memory, permissions, events,
and coordination. Most of that is configuration: a Tag, its Roles and permissions, its Objectives
and Schedules, and the places people reach it. Your own application can direct it through the
[Control Plane API](../reference/control-plane-api.md).

The same infrastructure can support increasingly broad applications:

```text
shared AI teammate  ->  specialized AI Team  ->  multi-Team AI organization
```

A Slack-native multiplayer teammate is one product experience. A larger application may give
several Tags distinct Roles, place them in Teams, and let them message each other and share a
Workstream.
Another may provide no chat surface at all and direct the organization through an API or a custom
control interface.

“Autonomous” means the organization can work on its own within limits. Humans decide the authority,
budgets, approval points, knowledge boundaries, and intervention paths. SuperTag checks those rules
before work reaches execution.
SuperTag does not provide the underlying model intelligence, and describing a “Claude Tag-like”
application pattern does not claim compatibility with or affiliation to Anthropic's product.

To build an organization for another function from configuration, follow
[Build your own organization: marketing](../guides/build-your-own.md).

## Choose by the layer you need

- Use a hosted AI teammate when you want an always-available helper and accept that it runs on
  the company's models and cloud computers, by the company's rules.
- Use a self-hosted personal assistant when the main need is your own general-purpose agents with
  tools and memory, rather than teams with Roles, shared outcomes, review, and approvals.
- Use an agent platform when you want to build an agent as a managed service on one company's
  models, and design identity, teams, and responsibilities yourself.
- Use a coding agent when the main need is agentic software work while you work with it.
- Use a parallel agent tool or agent projects when you want several coding agents at once and will
  decide what each works on, or when one company's agents are enough.
- Use SuperTag when you want persistent, proactive, multiplayer AI actors that run on your own
  machines and coding agents: Tags that keep the work going, act without being asked, work in
  Teams with Roles, and own outcomes within the permissions and approvals you set. Engineering
  works out of the box. For another function, or for a product of your own, build on the same
  infrastructure.

Continue to [How SuperTag fits together](how-it-works.md) for the runtime architecture or start with
[Tags](tags.md), [Roles](roles.md), [Teams](../guides/teams.md), and
[Define and complete an Objective](../guides/objectives.md) for the organizational model.
