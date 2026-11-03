# SuperTag documentation

SuperTag lets you define outcomes instead of tasks, and an AI engineering team delivers them. You
state an **Objective**: what done means, how it's verified, a budget, and a deadline. A team of
**Tags** plans the work, runs it in parallel, reviews it, and comes back for the decisions you
reserved. A Tag is a persistent AI identity with its own responsibilities and permissions. You can
direct the team from the coding agent you already use.

A **Team** groups Tags under a lead. Together, your Teams of Tags make up an **autonomous
organization**: Teams may pursue different Objectives but share one Control Plane, its rules, and
its record of the work. The **Control Plane** stores the organization and schedules work.
A **Worker Host** is a machine or sandbox that runs that work. A **collaboration surface** connects
an external work tool, such as Slack or GitHub.

## Start here

Follow this order on your first visit:

1. [Install SuperTag](operations/install.md).
2. [Give a Tag its first Objective](../README.md#get-started), then use the
   [CLI walkthrough](operations/cli.md) to inspect the result. [Write an Objective](guides/write-an-objective.md)
   explains how to state outcomes your team can verify.
3. [Add a teammate](guides/first-team.md) and coordinate a lead and a builder in a [Team](guides/teams.md).
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
| Choose how to direct an AI engineering team | [The interaction model](concepts/interaction-model.md) |
| Give several Tags a shared outcome | [Coordinate Tasks toward an Objective](guides/objective-coordination.md) |
| Keep a Tag responsible as conditions change | [Maintain an ongoing responsibility](guides/ongoing-responsibilities.md) |
| Understand progress, blockers, and results | [Check an Objective's progress](guides/objective-overview.md) |
| Answer a budget or operator request, or review a result | [Respond to budget and operator requests](guides/objective-decisions.md) |
| Get alerts for inbox decisions | [Set up operator notifications](guides/notifications.md) |
| Start from a ready-made team definition | [Example organizations](../examples/organizations/README.md) |
| Run Claude and Codex against one shared workspace | [Two managers, one shared workspace](../examples/shared-organization/README.md) |
| Connect Slack, GitHub, Lark/Feishu, Linear, or Teams | [Connection guides](surfaces/README.md) |
| Run Codex, Claude Code, Cursor, or OpenCode | [Run a Worker](guides/workers.md) |
| Let Tags change a repository on their own branches | [Work in a repository with Workspaces](guides/workspaces.md) |
| Add another execution system | [Build a custom Worker or harness](guides/custom-workers.md) |
| Run an always-on deployment | [Self-host SuperTag](guides/self-hosting.md) |
| Compare SuperTag with other agent systems | [SuperTag and other agent systems](concepts/supertag-and-other-agent-systems.md) |
| Look up a term | [Glossary](reference/glossary.md) |

## Learn the core concepts

Read these in order when you want the complete mental model:

1. A [Tag](concepts/tags.md) is a persistent AI identity with its own responsibilities and
   permissions.
2. A [Role](concepts/roles.md) is an enduring responsibility assigned to a Tag.
3. An [Objective](guides/objectives.md) is a desired outcome. A [Task](concepts/tasks.md) is one
   current assignment, and a Session groups Tasks from the same conversation.
4. A [Team](guides/teams.md) is a group of Tags with a lead and shared capacity.
5. Every Team has one channel, its [Workstream](guides/workstreams.md), where members post. There
   are no other Workstreams, and a channel has no status or revision of its own. A
   [Mailbox](guides/tag-messaging.md) delivers an internal message to one Tag; a Team's lead and
   members message each other without a grant.

Security and governance add two more resources. A
[Context Set](concepts/context-and-permissions.md) selects reusable knowledge that may be added to a
Task. A [Permission Set](concepts/context-and-permissions.md) selects actions that the Task may
perform.

Once those ideas are clear, learn where the organization and its work run:

- The [Control Plane](concepts/how-it-works.md) stores the organization, applies policy, and schedules work.
- A [Worker Host](concepts/workers.md) is a machine or sandbox that provides execution capacity.
- A **Worklet** connects a Worker Host to the Control Plane. A **Worker** completes a Task. A
  **harness** connects a Worker to an agent system such as Codex, Claude Code, or Cursor. The
  [execution overview](concepts/workers.md) explains how they fit together.
- [Multiplayer continuity](concepts/multiplayer.md) explains how people share completed work safely.
- [Persistence](concepts/persistence.md) explains what survives when a sandbox or host dies.

The **Gateway** is the part of the Control Plane that receives and sends collaboration surface
traffic. The **API Server** is the part that handles management requests and Worker Host
connections.

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

- [Self-host SuperTag](guides/self-hosting.md) — choose Docker Compose, Railway, Render, Cloudflare, or a native service
- [Railway](guides/deploy-railway.md) — hosted Control Plane, PostgreSQL, and persistent storage
- [Render](guides/deploy-render.md) — Blueprint-managed Control Plane, PostgreSQL, and persistent storage
- [Fly.io](guides/deploy-fly.md) — always-on Machine with PostgreSQL and a persistent volume
- [Modal](guides/deploy-modal.md) — always-on Server with external PostgreSQL and credentials
- [Cloudflare](guides/deploy-cloudflare.md) — container-hosted Control Plane with PostgreSQL and Vault
- [Deployment setup](guides/deployment-setup.md) — shared configuration and verification for Railway, Render, and Cloudflare
- [Control Plane operations](operations/control-plane.md) — health, persistence, deployment, and databases
- [Operator notifications](guides/notifications.md) — alert the operator about inbox items
- [Manage resources](operations/resources.md) — get, describe, diff, apply, delete, watch, and cancel
- [supertag.yaml and local state](reference/supertag-yaml.md) — the services `supertag up` runs (a local Control Plane and this machine as a Worker Host), their settings, and what lives in `~/.supertag/`
- [Troubleshoot the first reply](guides/troubleshooting.md) — trace a request from its source to its Worker
- [Credential storage](reference/credential-storage.md) — where secrets live and which process can read them
- [MCP tools for GitHub, Slack, Linear, Teams, and Lark](surfaces/worker-tools.md) — preset tools and resource grants

## Coordinate work

- [Write an Objective](guides/write-an-objective.md) — outcomes, evidence, constraints, and limits

- [Define and complete an Objective](guides/objectives.md)
- [Coordinate Tasks toward an Objective](guides/objective-coordination.md)
- [Organize Tags into Teams](guides/teams.md)
- [Coordinate in a Team channel](guides/workstreams.md)
- [Send messages between Tags](guides/tag-messaging.md)
- [Maintain an ongoing responsibility](guides/ongoing-responsibilities.md)
- [Check an Objective's progress](guides/objective-overview.md)
- [Respond to budget and operator requests](guides/objective-decisions.md)
- [Work in a repository with Workspaces](guides/workspaces.md)

## Build and extend SuperTag

- [Build a custom Worker or harness](guides/custom-workers.md)
- [Build a Python Worker](guides/python-workers.md)
- [Run a Worker in Modal](guides/modal-workers.md)
- [Add a custom Context type](guides/custom-context.md)
- [Extend harness execution](guides/harness-runtime.md)
- [Route MCP tools to the right client](guides/mcp-tools.md)
- [Share an execution environment](guides/shared-execution.md)
- [Output rendering](reference/output-rendering.md)

## Implementation reference

Use these pages when you are implementing an integration, protocol, or Control Plane component:

- [Resource model](reference/resource-model.md) — public resources and their common shape
- [Identity and policy resolution](reference/iam.md) — identity, admission, permissions, and security rules
- [Context resolution](reference/context-resolution.md) — how declared knowledge becomes Worker input
- [Objective coordination reference](reference/coordination.md) — Objective, Team, budget, review, wait, and completion rules
- [Mailbox and Team channel reference](reference/mailbox.md) — grants, delivery, replies, history, and Team channel rules
- [Worker reference](reference/worker.md) — execution contracts, events, continuity, and failure behavior
- [Devcontainer settings for remote workspaces](reference/devcontainer-subset.md) — supported repository toolchain settings and refusals
- [Scheduling and interrupted execution](reference/scheduling-and-recovery.md) — Worker Host selection, unknown outcomes, and reclaiming capacity
- [Artifacts](reference/artifacts.md) — storage, limits, handoff, and custom Worker integration
- [Control Plane model](reference/control-plane.md) — service responsibilities and controllers
- [Control Plane API Server](reference/control-plane-api.md) — authenticated API boundaries
- [Reliable external actions](reference/action-effects.md) — retries, receipts, and uncertain outcomes
- [API stability](reference/api-stability.md) — compatibility levels and change policy
- [Language-neutral wire specification](../spec/README.md) — schemas and protocol versions

The [contribution guide](../CONTRIBUTING.md) and [security policy](../SECURITY.md) live at the
repository root.
