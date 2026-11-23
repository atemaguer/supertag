<div align="center">

<h1>
  <img src="assets/images/supertag-mascot-round.png" alt="SuperTag's orange mascot waving" width="64" height="64">
  SuperTag
</h1>

**Persistent, proactive, multiplayer AI actors for engineering work.**

Open source and self-hosted, on the coding agents you already use.

**Give them jobs, not tasks.**

[Jobs, not tasks](#give-them-jobs-not-tasks) · [Persistent](#persistent) · [Proactive](#proactive) · [Multiplayer](#multiplayer) · [Run it yourself](#run-it-yourself) · [Run your first Tag](#run-your-first-tag) · [Documentation](docs/README.md)

<p>
  <img src="assets/images/supertag-meet-the-tags.png" alt="Meet the Tags — nine SuperTag mascots with round and elongated builds, colorful jackets, hats, and glasses" width="900" height="360">
</p>

</div>

A **Tag** is a persistent AI actor with its own identity, responsibilities, permissions, and work
history. Its job is made of those responsibilities and the outcomes it delivers. It keeps the work
going between sessions, acts without being asked, and works with your teammates' Tags. Your coding
agents, Claude Code, Codex, Cursor, or OpenCode, still write the code.

## Give them jobs, not tasks

Today you give a coding agent a task: a prompt, a diff, a review, then the next prompt. It can
investigate a bug, write a fix, and run tests. But you remember what happened last time, notice the
next failure, and decide what happens next. When the work is bigger than one task, you become its
project manager: you split the work, start a coding agent on each piece, and carry context between
them.

A Tag has a job instead. A job is made of the responsibilities a Tag keeps up, such as keeping
main green, and the outcomes it delivers, such as moving 12 services to short-lived credentials.

| A task | A job |
| --- | --- |
| "Fix this flaky test" | "Keep main green", and deliver the outcomes you give it |
| Starts when you prompt it | Acts when CI fails, an alert fires, or a teammate asks |
| Ends when the diff merges | Continues, and remembers what it learned |
| You check whether it worked | It brings the evidence: the checks it ran and what it verified |
| Any coding agent session can take it | Has its own identity, permissions, and history |

Each outcome is an **Objective**. It records the evidence you'll use to decide when it's done,
and any constraints, budget, or deadline you set. The owning Tag decides what work to start,
hands pieces to the other Tags on its **Team**, reviews what comes back, and brings you findings,
branches, and the decisions that need your approval. You steer the owning Tag; you don't manage
its coding agents.

To move 12 services to short-lived credentials, give `lead` the rollout Objective. It coordinates
Tags that update trust policy and service code, review tests and telemetry, and rehearse the
cutover. You approve production cutovers and decide when to retire the shared keys.

Give each Tag its own job and permissions. You could let `lead` coordinate, give a builder
permission to edit the repository, and give a reviewer read-only access.

[Write an Objective](docs/guides/write-an-objective.md) · [How you direct work](docs/concepts/interaction-model.md)

## What a job needs

A job outlasts any one session, includes work nobody asked for yet, and involves other people.
Tags are built for all three.

### Persistent

A job outlasts the session that started it. Your coding agents do a Tag's work one piece at a
time, and the Tag is what persists between the pieces. The same Tag can investigate today's issue, review the results tomorrow, and answer
questions about both next week, even when the next piece of work runs on another coding agent or
machine. It can recall its earlier work and Objectives on its own.

<a name="next-add-your-teams-chat"></a>

Reach the same Tag from the tools you use. Talk to it in the terminal, or add a Slack channel,
GitHub repository, or Linear team to its locations. Each conversation has its own thread, and the
same Tag keeps the responsibilities you assigned it. [Connect a work tool](docs/surfaces/README.md)

### Proactive

Part of every job is noticing what needs doing. Give a Tag an ongoing responsibility, and it
works to fulfill it without waiting to be asked.
Each responsibility is an ongoing Objective, and related responsibilities belong to the same Tag.
Say `reliability` keeps your service healthy. It owns four ongoing Objectives:

| Ongoing Objective | Wakes on | Does | Leaves to you |
| --- | --- | --- | --- |
| Triage production errors | A new or regressed Sentry issue | Reproduces it, finds the change that caused it, and prepares a fix with a failing test | Merging and rolling back |
| Watch the service | A PagerDuty, Datadog, or health-check alert | Builds a timeline from logs, recent deploys, and the error spike, and prepares a revert branch | Rolling back or escalating |
| Keep main green | A failed CI run on main | Finds the breaking commit, tells a flaky test from a real failure, and prepares a fix or revert | Merging and quarantining tests |
| Keep dependencies safe | A Dependabot or Snyk advisory | Checks whether the project is affected and prepares the upgrade with test results | Major upgrades and merging |

When Sentry reports a new error, `reliability` takes it up under the first Objective. It decides
whether the error matters, starts work to reproduce and fix it, and brings you the branch, the
test, and any decision that's yours. Because one Tag holds all four, it can recall what it learned
under the others, such as the failing deploy it looked at an hour earlier. When nothing needs
doing, it rests until the next report, message, or result. Run it on an always-on host, and it
keeps its responsibilities while your laptop is off.

Give a different kind of responsibility to another Tag when it needs different permissions. A
`support` Tag that triages bug reports can read the repository and talk to reporters without
being able to prepare reverts.

You choose which events reach a Tag and what it may do in response. Forward alerts and reports
to an Objective through the Control Plane API, or mention the Tag in Slack, GitHub, or Linear.
[Set up an ongoing responsibility](docs/guides/ongoing-responsibilities.md)

### Multiplayer

Jobs on a team overlap. Self-host one shared Control Plane, and your team works with Tags
together. Each teammate directs
Tags from their own terminal or connected tools, and private terminal conversations stay private
to each person. One person can ask `reliability` about an error in Slack, and another can follow up on
the same findings on GitHub.

Your teammates' Tags coordinate with each other without involving you. When your Tag needs
something from a teammate's Tag, it messages that Tag directly. They work out the details between
themselves and record what they agreed in their Team's shared Workstream. You hear about it when a
decision is yours. The Tags can run on different coding agents and machines, so
a Tag on your laptop running Claude Code can work with one on a teammate's machine running Codex
toward the same Objective.

![You, Alex, and Sam direct your respective Tags alongside shared Tags for a team or organization, including shared specialists. The Tags coordinate with one another, and their work sessions run across Worker Hosts including your machine, teammates' machines, and VMs. One shared Control Plane coordinates the team.](assets/images/supertag-shared-control-plane.png)

[How multiplayer works](docs/concepts/multiplayer.md) · [Self-host SuperTag](docs/guides/self-hosting.md)

<a name="get-started"></a>

## Run your first Tag

On a Mac or Linux, install Git and [Claude Code](https://code.claude.com/docs/en/setup)
or [Codex](https://developers.openai.com/codex/cli/), and sign in to it. For Claude Code, run
`claude` and log in. For Codex, sign in with `codex -c 'cli_auth_credentials_store="file"' login`,
which keeps the login in a file SuperTag's Tasks can use; a plain `codex login` on macOS keeps it
in the Keychain, which they can't. Claude Code also needs Node.js; see
[requirements and sign-in](docs/operations/requirements.md) for versions.

[Install SuperTag](docs/operations/install.md), then run this from an existing Git repository with
at least one commit.

```sh
curl -fsSL https://github.com/atemaguer/supertag/releases/latest/download/install.sh | sh
export PATH="$HOME/.local/bin:$PATH"
supertag init
supertag message lead "Read this repository and tell me what you would improve first."
```

`supertag init` checks your coding agent's sign-in, asks a few questions, and starts SuperTag in
the background. Keep the default Tag name, `lead`. It works in this repository, starting from the
latest commit of the branch you have checked out. `supertag message` sends your message to
`lead` and prints the reply as it arrives.

Follow up in the same conversation with another `supertag message lead`. When you’re ready to give
it part of a job, start an Objective like this.

```sh
supertag message lead "/goal Add a test for an uncovered edge case. Done when the new test and its suite pass. Ask me before changing application code."
```

A Codex lead runs the tests. A Claude Code lead set up without Docker or the unsandboxed opt-in
reads and edits files but runs no commands, so it reports that condition as unchecked; see
[Let the lead run commands](docs/operations/cli.md#let-the-lead-run-commands).

`supertag get inbox-item` lists the questions the Tag asks you; answer one with
`supertag question answer TASK_ID "..."`. When the Objective is ready, `supertag status` shows it
as `review`. Each delivered change arrives in your
repository as a `supertag/session/...` branch. Review it, then approve the Objective or ask for a
revision:

```sh
supertag describe objective OBJECTIVE_ID
supertag objective review OBJECTIVE_ID approve
supertag objective review OBJECTIVE_ID request-changes --feedback "Also cover the empty case."
```

Prefer a window to the terminal? On a Mac (Apple silicon or Intel) or Linux, [install the desktop app](docs/operations/install.md#install-the-desktop-app):
it carries its own `supertag`, sets SuperTag up on first launch, and talks to the same Tags.

[Installation options](docs/operations/install.md) · [Talk to a Tag](docs/guides/talk-to-a-tag.md) · [Run your first Team](docs/guides/first-team.md) · [Direct SuperTag from your coding agent](docs/guides/coding-agent-operator.md)

## Run it yourself

SuperTag is open source under Apache 2.0, and every part of it runs where you choose. A job
needs access to your code, your services, and your accounts, so you decide where that access
lives.

![Clients and collaboration tools reach the Control Plane through the Gateway. The Control Plane stores Tags and permissions in SQLite or PostgreSQL and schedules work. On each Worker Host, a Worklet claims Tasks from the Control Plane and starts a Worker for each Task Attempt. The laptop runs Codex and the server runs Claude Code, each through a harness adapter.](assets/images/supertag-architecture.png)

- **Your machines.** `supertag init` starts a local **Control Plane**, the service that stores
  your Tags and schedules their work, and connects your computer as a **Worker Host**, a machine
  or sandbox that runs the work. When your team joins, deploy the Control Plane where everyone can
  reach it, and connect laptops, servers, CI runners, or Modal and E2B sandboxes as Worker Hosts.
  Keep a Tag with an ongoing responsibility, such as `reliability`, on an always-on host.
- **Your coding agents and models.** Each Tag runs on the coding agent and model you choose,
  signed in with your own account or key.
- **Your limits.** Each Tag can do only what its permissions allow, and you choose which actions
  wait for your approval. Codex runs commands in its own sandbox, and Claude Code, Cursor, and
  OpenCode can run theirs in local containers. A Tag reaches only the network addresses you
  allow. On Codex and in containers, its host adds credentials such as a Sentry token to allowed
  requests, so the Tag's commands never see them.

[Self-host SuperTag](docs/guides/self-hosting.md) · [Connect a Worker Host](docs/guides/workers.md) · [Set permissions and approvals](docs/concepts/context-and-permissions.md) · [See how the parts fit together](docs/concepts/how-it-works.md)

## Works with

| | Options |
| --- | --- |
| **Coding agents** | Claude Code · Codex · Cursor · OpenCode · OpenAI Agents · [your own harness adapter](docs/guides/harness-adapters.md) |
| **Where you talk to Tags** | Terminal · [Slack](docs/surfaces/slack.md) · [GitHub](docs/surfaces/github.md) · [Linear](docs/surfaces/linear.md) · [Lark/Feishu](docs/surfaces/lark.md) · [Microsoft Teams](docs/surfaces/teams.md) |
| **Where work runs** | Laptops · servers · CI runners · [Modal and E2B sandboxes](docs/guides/workers.md#run-a-harness-in-a-sandbox) |

## When to choose SuperTag

| Compared with | Good at | What's missing | What SuperTag adds |
| --- | --- | --- | --- |
| **Coding agents** · [Claude Code](https://code.claude.com/docs/en/overview), [Codex](https://learn.chatgpt.com/docs/codex/cli), [OpenCode](https://opencode.ai/docs/) | Writing, fixing, and testing code while you work with them. | When you close the chat, the work stops. You have to remember the goal and start the next step yourself. | **The work keeps going.** A Tag remembers the goal and puts a coding agent on the next step itself. It also responds to new errors and alerts without you asking. Your coding agents still write the code. |
| **Parallel agent tools** · [Paradev (formerly Superset)](https://docs.paradev.com/recipes/parallel-workstreams), [Conductor](https://www.conductor.build/docs/concepts/parallel-agents) ([winding down](https://www.conductor.build/announcement)) | Running several coding agents at once and showing you all the changes. | You still decide what each agent works on and check that the results fit together. | **Someone else manages the agents.** Tell a Tag what you want done and how to check it. It hands out the pieces, checks they fit, and sends you the results. |
| **Agent projects** · [Cursor Projects](https://cursor.com/docs/agent/projects), [Claude Code Projects](https://code.claude.com/docs/en/claude-projects), [GitHub Copilot Projects](https://docs.github.com/en/copilot/how-tos/github-copilot-app/working-with-projects) | Several agents working toward one goal over weeks or months. In Cursor, teammates can join the same project. | Each project runs one company's agents, mostly on that company's cloud. | **Mix coding agents and machines.** Your Tag can run on Claude Code on your laptop while a teammate's runs on Codex on theirs, and they still work together. |
| **Hosted AI teammates** · [Devin Bots](https://devin.ai/blog/introducing-devin-bots), [OpenAI dots](https://openai.com/index/introducing-dots/), [Grok Bot](https://x.ai/news/introducing-grok-bot) | An AI helper that's always available, remembers past work, and acts on its own. | It runs on the company's models and cloud computers, by the company's rules. | **Run it yourself.** Tags use the coding agents you already pay for, run on your own machines, and can only do what you allow. |
| **Self-hosted agents** · [OpenClaw](https://docs.openclaw.ai/concepts/multi-agent), [Hermes Agent](https://hermes-agent.nousresearch.com/docs/user-guide/features/kanban) | Running your own AI agents with their own tools and memory, for any kind of task. | They're general assistants. They aren't built around your coding agents, code review, or checking that engineering work is done. | **Built for engineering work.** Tags run on Claude Code, Codex, Cursor, or OpenCode. Code changes come back as branches for your review, and each outcome comes with a way to check it's done. |

[See how SuperTag fits with other agent systems](docs/concepts/supertag-and-other-agent-systems.md).

## Build on SuperTag

Use the same infrastructure to give your own application persistent actors. The Control Plane's
gRPC API lets your application create and direct Tags, send them work, and inspect their
progress. For example, you could forward Sentry errors to a `reliability` Tag and show its branches and test
results in your own review interface. Generated Go, TypeScript, and Python
bindings come with the repository. [Explore the API](docs/reference/control-plane-api.md)

To bring your own execution system, write a **harness adapter**: a program that the Worker of
each Task Attempt starts and that drives your agent through the harness protocol.
The built-in Python and TypeScript adapters are working examples to read.

The TypeScript SDK, `supertag-ai` on npm, and the Python SDK, `supertag` on PyPI, connect an
application to SuperTag and a harness adapter to the **Worker**, the process that started it for its Task Attempt:

```sh
npm install supertag-ai
python -m pip install 'supertag==0.3.8'
```

[Write a harness adapter](docs/guides/harness-adapters.md) · [Connect your own collaboration surface](docs/reference/connector-contract.md) · [Check API stability](docs/reference/api-stability.md)

## FAQ

**What can a Tag do without asking me?** Only what its permissions allow. You decide which
actions need your approval first. Repository changes always come back as branches for you to
review, and merging stays with you.
[Set permissions and approvals](docs/concepts/context-and-permissions.md)

**How do I control changes to my repository?** Set what each Tag is allowed to do. Repository
work happens in a separate pinned checkout and comes back as a branch you can review.
[Work with repository branches](docs/guides/workspaces.md)

**Do I need a server?** You can start the Control Plane and run work on your laptop. For shared
access or work that should stay available when your laptop is off, deploy the Control Plane and
connect a Worker Host that stays online. [Self-host SuperTag](docs/guides/self-hosting.md)

## Contributing and license

See the [contributor guide](CONTRIBUTING.md) for repository setup and checks. SuperTag is licensed
under [Apache 2.0](LICENSE).
