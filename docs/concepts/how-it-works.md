# How SuperTag fits together

With SuperTag, a Tag, a persistent AI identity, owns engineering work: you talk to it or hand it an
outcome, and it runs the work on your coding agents. Tags are grouped into Teams. Together, your
Teams of Tags make up an **autonomous organization**: Teams may pursue different outcomes but share
one Control Plane, its rules, and its record of the work. SuperTag's architecture separates the
durable organization and its rules from the systems that execute individual pieces of work.

If these terms are new, start with [core concepts](README.md).

SuperTag has two top-level runtime components: the **Control Plane**, the service that stores and
coordinates the organization, and **Worker Hosts**, machines or sandboxes that provide execution
capacity. SuperTag stores each accepted turn of work as a **Task** for a **Tag**. A Tag is
a persistent AI identity with its own responsibilities and permissions.

The diagram below also uses these terms (see the [glossary](../reference/glossary.md)):

- A **Worker** is the code that completes a Task.
- A **harness** connects that Worker to an agent system.
- The **Gateway** is the part of the Control Plane that receives and sends traffic for external
  work tools.
- The **API Server** handles management requests and execution connections.
- A **Worklet** is the supervisor that connects a Worker Host to that API Server.
- A **Worker Profile** is a saved, versioned recipe for running a Worker.

This separation also protects the organization. Before a Worker receives a Task, the Control Plane
records who is acting, who requested the work, where the request came from, which reusable
knowledge may be added, which actions are allowed, which approvals apply, and which execution
limits must be followed. A harness cannot expand the Task's permissions.

```text
Slack / GitHub / Linear / Lark / Teams       CLI / API
                    |                            |
                    v                            v
             Gateway transport       Control Plane API Server
                    \___________________________/
                                 |
                        SuperTag Control Plane
                        - organizational resources and policy
                        - controllers, scheduling, and recovery
                        - durable state and audit
                                 |
                       API Server / Worklet API
                                 |
                                 v
                            Worker Hosts
                        - one Worklet per host
                        - health and execution capacity
                        - Workers and Worker Profiles
                        - Codex / Claude Code / custom harnesses
                        - local processes or remote sandboxes
```

The first deployment can run the whole Control Plane in one process. These boundaries describe
responsibility and public contracts; they do not require every subsystem to be deployed separately.

This separation supports deployments ranging from one shared AI teammate in an engineering channel
to a multi-Team engineering organization distributed across many Worker Hosts. See
[SuperTag and other agent systems](supertag-and-other-agent-systems.md) for how the organizational
layer relates to assistants, agent runtimes, and coding harnesses.

## The Control Plane

The Control Plane is the source of truth for the organization. It owns Tags and their enduring
responsibilities, called **Roles**. It owns **Objectives**, the outcomes Tags pursue, and **Teams**,
flat lists of member Tags. Each Team has a **Workstream**, its shared record of posts. It owns
**Sessions**, each one Tag's thread of work, the **Tasks** that are their turns, and
**Mailboxes**, where a Tag receives messages from other Tags. It also owns **Context Sets**, which select reusable knowledge for a Task,
**Permission Sets**, which select the actions a Task may perform, and budgets, recorded policy,
events, and audit history. It accepts new work, schedules it, keeps long-running records consistent,
and recovers interrupted operations.

Humans can direct the organization from **collaboration surfaces**, external work tools such as
Slack or GitHub, in single-player or multiplayer workflows. Tags coordinate through Sessions
started beneath an Objective, through Mailbox messages, and through their Team's Workstream.
Harness-native subagents remain inside one Worker execution and use their harness's local
coordination primitives.

## The API Server

The Control Plane API Server is the authoritative management and resource API boundary. It
authenticates operator requests, validates resource representations, applies admission rules, and
exposes desired and observed state through versioned resources. Watch behavior also belongs to this
boundary; the current CLI implements it by polling resource versions.

The API Server is an internal Control Plane component, not a third top-level service. The current
deployment runs it in the same process and on the same listener as the Gateway. Its Worklet API
registers Worker Hosts, carries Tasks and cancellation, accepts heartbeats and reported
execution events, and reports connection state. Keeping the code boundary separate lets resource and
execution-control behavior evolve independently from collaboration-surface protocols without
requiring another deployment.

## The Gateway

The Gateway is the Control Plane's collaboration-surface transport boundary. It terminates and
authenticates collaboration surface connections, normalizes their protocol messages, forwards them to Control
Plane services, delivers outbound presentations, and reports connection and delivery state.
Management, resource, and Worklet API requests belong to the API Server even when both components
share one HTTP listener.

For example, when someone invokes the provider-facing `@SuperTag` identity, the Gateway receives
the collaboration surface event and passes its normalized origin and requester to the Control Plane. The Control
Plane finds the configured Tag, accepts and stores the Task, and schedules it. When work
finishes, the Gateway carries the resulting presentation back to the originating surface.

The Gateway does not decide organizational policy, create Tasks or Teams on its own, schedule
Workers, or decide who may message whom. It also stays out of arbitrary harness tool and MCP traffic.

## How identity and access are decided

A Tag is a non-human identity in SuperTag's access model. Its configured locations determine where
it can be invoked. Roles describe enduring responsibilities. Context Sets declare reusable knowledge
that may enter a Task, and Permission Sets declare surface-backed or runtime actions the Tag may
take.

Before accepting the work, the Control Plane combines those resources with the request's source,
requester, workspace, and execution needs. It records the result on the Task. Later changes do not
rewrite that accepted Task. Context cannot create permission, and Worker credentials cannot expand
the allowed actions.

## How the work runs

Worklets connect outbound to the API Server's Worklet API and report their Worker Hosts, Workers,
exact profiles, supported Context types, capacity, and health. The Control Plane schedules only a
compatible, ready Worker Host. A Task remains pending when none is available.

On the Worker Host, a Worker defines how the admitted Task becomes executed work. The Worklet
supervises the Task while the Worker owns input resolution, execution orchestration,
lifecycle, and event normalization:

- Context Resolvers provide approved instructions, **Skills** (reusable instruction packages),
  resources, and selected artifact metadata.
- Workspace Resolvers provide the admitted operational workspace.
- Tool Providers turn Permission Sets into allowed tool capabilities and local connections such as
  hosted MCP or a native SDK.
- A harness adapts those inputs to Codex, Claude Code, OpenCode, or another engine.
- An environment provider runs the harness locally or in a remote sandbox.

External actions happen from the Worker side. Their normalized results return through the
Worklet API for the Control Plane to persist.

## What survives a failure

The Control Plane stores each Task before sending it to a Worker. **Task Attempts**, each one
execution or retry of a Task, events, results, and outbound replies have their own recovery paths. A
Worker crash, lost Worklet connection, or collaboration surface failure does not erase accepted
work. See [Scheduling and interrupted execution](../reference/scheduling-and-recovery.md) for how
the Control Plane picks a Worker Host and what happens when execution is interrupted.

Each Task stores its request, response, and result. A later Task in the same Session resumes that
Session's native harness session. When no usable native state exists, it receives bounded history
derived from completed Tasks instead. Every conversation also sees the Tag's open Objectives and
can search the Tag's other Sessions on request. Reusable outputs are explicitly captured as
artifacts. Context Sets can select permitted artifact metadata across Sessions, people, channels,
and platforms without merging the underlying conversations.

## Extension points

Teams can add collaboration surfaces, add arbitrary Context types through
Context Resolvers, add tool mechanisms beyond MCP through Tool Providers and Adapters, add local or
remote execution environments, implement new harnesses, or replace the Worker contract entirely.
These extensions share the same durable Task, identity, permission, Control Plane, and Worklet
transport boundaries.

Continue with [Tags](tags.md), [Tasks and Sessions](tasks.md), or
[Workers and harnesses](workers.md), depending on which boundary you need to understand next.
