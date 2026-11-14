# SuperTag documentation

SuperTag gives engineering work a persistent owner. A **Tag** is a persistent AI actor with a
stable identity, responsibilities, permissions, and work history. It exists independently of the
model or harness executing its work. Talk to it in your terminal, in Slack, or on a GitHub issue.
It runs work on your coding agents, asks when a decision is yours, and returns a git branch to
review. For bigger work, give it an **Objective** with a result to verify, a budget, and a
deadline. The Tag plans the work and hands pieces to other Tags on its Team.

A **Team** is a flat list of member Tags. Together, your Teams of Tags make up an **autonomous
organization**: Teams may pursue different Objectives but share one Control Plane, its rules, and
its record of the work. The **Control Plane** stores the organization and schedules work.
A **Worker Host** is a machine or sandbox that runs that work. A **collaboration surface** connects
an external work tool, such as Slack or GitHub.

## Start here

Follow this order on your first visit:

1. [Install SuperTag](operations/install.md).
2. [Talk to your first Tag](../README.md#get-started) in the terminal UI. The
   [terminal guide](guides/talk-to-a-tag.md) shows how to review a branch or create an Objective.
   [Write an Objective](guides/write-an-objective.md) explains how to state outcomes a Tag can verify.
3. [Add a builder](guides/first-team.md) and put two Tags in a [Team](guides/teams.md).
   To direct SuperTag from Claude Code, Codex, or another coding agent, set up the
   [operator skill guide](guides/coding-agent-operator.md).
4. [Connect a collaboration surface](surfaces/README.md) when you want to work from chat or issues.
5. [Run Worker Hosts](guides/workers.md) when you need more execution capacity.
   The first-run setup already connects your own computer.
6. [Deploy an always-on Control Plane](guides/self-hosting.md).

## Choose your path

| I want to… | Start here |
| --- | --- |
| Check system tools, harness sign-in, and telemetry | [Requirements](operations/requirements.md) |
| Install the version described here | [Installation and version matching](operations/install.md) |
| Add a builder to your first Team | [First Team walkthrough](guides/first-team.md) |
| Set up SuperTag in a repository | [Start in a repository](operations/cli.md#start-in-a-repository) |
| Run SuperTag from your coding agent | [Run SuperTag from your coding agent](guides/coding-agent-operator.md) |
| Run and inspect work from the terminal | [CLI operator walkthrough](operations/cli.md) |
| Understand the main ideas | [Core concepts](concepts/README.md) |
| Choose how to direct your Tags | [The interaction model](concepts/interaction-model.md) |
| Ask a Tag a question from your terminal | [Talk to a Tag from your terminal](guides/talk-to-a-tag.md) |
| Give several Tags a shared outcome | [Define and complete an Objective](guides/objectives.md) |
| Keep a Tag responsible as conditions change | [Maintain an ongoing responsibility](guides/ongoing-responsibilities.md) |
| Understand progress, blockers, and results | [Check an Objective's progress](guides/objective-overview.md) |
| Answer a question, decide an approval, or review a result | [Respond to an Objective](guides/objective-decisions.md) |
| Get alerts for inbox decisions | [Set up operator notifications](guides/notifications.md) |
| Start from a ready-made team definition | [Example organizations](../examples/organizations/README.md) |
| Connect Slack, GitHub, Lark/Feishu, Linear, or Teams | [Connection guides](surfaces/README.md) |
| Run Codex, Claude Code, Cursor, OpenCode, or OpenAI Agents | [Run Worker Hosts](guides/workers.md) |
| Let Tags change a repository on their own branches | [Work in a repository with Workspaces](guides/workspaces.md) |
| Add another agent system | [Write a harness adapter](guides/harness-adapters.md) |
| Look up a command or flag | [CLI reference](reference/cli.md) |
| Run an always-on deployment | [Self-host SuperTag](guides/self-hosting.md) |
| Host the Control Plane on Modal | [Deploy on Modal](guides/deploy-modal.md) |
| Compare SuperTag with other agent systems | [SuperTag and other agent systems](concepts/supertag-and-other-agent-systems.md) |
| Look up a term | [Glossary](reference/glossary.md) |

## Learn the core concepts

Read these in order when you want the complete mental model:

1. A [Tag](concepts/tags.md) is a persistent AI actor with a stable identity, responsibilities,
   permissions, and work history.
2. A [Role](concepts/roles.md) is an enduring responsibility assigned to a Tag.
3. An [Objective](guides/objectives.md) is a desired outcome with a budget, a deadline, and a
   status. A Session is one Tag's thread of work, and a [Task](concepts/tasks.md) is one turn of
   it.
4. A [Team](guides/teams.md) is a flat list of member Tags with an optional concurrency limit.
5. A Team's [Workstream](guides/workstreams.md) is its shared record of posts; every member can
   read it, and a post wakes nobody. A Tag's [Mailbox](guides/tag-messaging.md) is its inbox for
   messages from other Tags; Tags in one Team message each other without a grant.

Two more resources separate knowledge from authority. A
[Context Set](concepts/context-and-permissions.md) selects reusable knowledge that may be added to a
Task. A [Permission Set](concepts/context-and-permissions.md) selects actions that the Task may
perform.

Once those ideas are clear, learn where the organization and its work run:

- The [Control Plane](concepts/how-it-works.md) stores the organization, applies policy, and schedules work.
- A [Worker Host](concepts/workers.md) is a machine or sandbox that provides execution capacity.
- A **harness adapter** runs each Task Attempt on an agent system such as Codex, Claude Code, or
  Cursor. The [execution overview](concepts/workers.md) explains how it fits together.
- [Multiplayer continuity](concepts/multiplayer.md) explains how people share completed work safely.
- [Persistence](concepts/persistence.md) explains what survives when a sandbox or host dies.

The **Gateway** is a separate, optional service that receives and sends collaboration surface
traffic. It connects to the Control Plane as a client, like the CLI and Worker Hosts.

Concept pages explain what each part means and when to use it. They link to commands and technical
reference only when you need to configure or extend that part.

## Connect a collaboration surface

Choose the tool your team already uses:

- [Connection guide overview](surfaces/README.md)
- [Slack](surfaces/slack.md), with the [Slack app manifest](surfaces/slack-app-manifest.yaml)
- [GitHub](surfaces/github.md)
- [Lark / Feishu](surfaces/lark.md)
- [Linear](surfaces/linear.md)
- [Microsoft Teams](surfaces/teams.md)

## Operate SuperTag

- [Self-host SuperTag](guides/self-hosting.md) — choose Docker Compose, Fly.io, Railway, Render, Cloudflare, or Modal
- [Configure a deployment](guides/deployment-setup.md) — `setup`, `check`, and `verify deployment` for every platform
- [Fly.io](guides/deploy-fly.md) — Control Plane and optional Gateway as Machines, with PostgreSQL
- [Railway](guides/deploy-railway.md) — Control Plane behind a TCP Proxy, with PostgreSQL
- [Render](guides/deploy-render.md) — Blueprint-managed Control Plane, optional Gateway, and PostgreSQL, over the WebSocket tunnel
- [Modal](guides/deploy-modal.md) — always-on Control Plane behind a web endpoint, with external PostgreSQL and Vault
- [Cloudflare](guides/deploy-cloudflare.md) — Control Plane in a Container behind a Worker, with external PostgreSQL and Vault
- [Control Plane operations](operations/control-plane.md) — health, persistence, deployment, and databases
- [Operator notifications](guides/notifications.md) — alert the operator about inbox items
- [Manage resources](operations/resources.md) — get, describe, diff, apply, delete, watch, and cancel
- [supertag.yaml and local state](reference/supertag-yaml.md) — the services `supertag up` runs (a local Control Plane, a Gateway, and this machine as a Worker Host), their settings, and what lives in `~/.supertag/`
- [Troubleshoot the first reply](guides/troubleshooting.md) — trace a request from its source to its Worker Host
- [Credential storage](reference/credential-storage.md) — where secrets live and which process can read them
- [MCP tools for GitHub, Slack, Linear, Teams, and Lark](surfaces/worker-tools.md) — preset tools and resource grants

## Coordinate work

- [Write an Objective](guides/write-an-objective.md) — outcomes, evidence, constraints, and limits

- [Define and complete an Objective](guides/objectives.md)
- [Organize Tags into Teams](guides/teams.md)
- [Share a Team's Workstream](guides/workstreams.md)
- [Talk to a Tag from your terminal](guides/talk-to-a-tag.md)
- [Send messages between Tags](guides/tag-messaging.md)
- [Maintain an ongoing responsibility](guides/ongoing-responsibilities.md)
- [Check an Objective's progress](guides/objective-overview.md)
- [Respond to an Objective](guides/objective-decisions.md)
- [Work in a repository with Workspaces](guides/workspaces.md)

## Build and extend SuperTag

- [Write a harness adapter](guides/harness-adapters.md)
- [Connect your own collaboration surface](reference/connector-contract.md)
- [Call the Control Plane API](reference/control-plane-api.md)

## Implementation reference

Use these pages when you are implementing an integration, protocol, or Control Plane component:

- [Resource model](reference/resource-model.md) — public resources and their common shape
- [Identity and policy resolution](reference/iam.md) — identity, admission, permissions, and security rules
- [Context resolution](reference/context-resolution.md) — how declared knowledge becomes harness input
- [Objective coordination reference](reference/coordination.md) — Objective, Team, Mailbox, Workstream, budget, and completion rules
- [CLI reference](reference/cli.md) — every command and flag, generated from the CLI's help
- [Worker Host reference](reference/worker.md) — placement, leases, the journal, harnesses, Workspaces, and delivery
- [Connector contract](reference/connector-contract.md) — how a connector in its own process admits surface events and delivers replies
- [Devcontainer settings for remote workspaces](reference/devcontainer-subset.md) — supported repository toolchain settings and refusals
- [Scheduling and interrupted execution](reference/scheduling-and-recovery.md) — Worker Host selection, unknown outcomes, and reclaiming capacity
- [Artifacts](reference/artifacts.md) — storage, limits, and handoff between Objectives
- [Control Plane model](reference/control-plane.md) — service responsibilities and controllers
- [Control Plane API](reference/control-plane-api.md) — connecting, negotiation, authentication, services, and streams
- [Reliable external actions](reference/action-effects.md) — retries, receipts, and uncertain outcomes
- [API stability](reference/api-stability.md) — compatibility levels and change policy
- [Protocol definitions](../rust/proto/supertag/runtime/v2/runtime.proto) — the `supertag.runtime.v2` protobuf package

The [contribution guide](../CONTRIBUTING.md) and [security policy](../SECURITY.md) live at the
repository root.
