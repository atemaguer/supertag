# How SuperTag fits together

With SuperTag, a **Tag** owns engineering work. It is a persistent AI actor with a stable identity,
responsibilities, permissions, and work history. Talk to it or give it an outcome, and it runs the
work on your coding agents. Give it an ongoing Objective, and it acts on new reports without being
asked; Tags in a Team message each other to coordinate. Tags are grouped into Teams. Together, your Teams of Tags make up an
**autonomous organization**: Teams may pursue different outcomes but share one Control Plane, its
rules, and its record of the work. SuperTag's architecture separates the durable organization and
its rules from the systems that execute individual pieces of work.

If these terms are new, start with [core concepts](README.md).

SuperTag has three kinds of services, all run by the one `supertag` program:

- The **Control Plane** stores and coordinates the organization. Worker Hosts and Gateways
  connect to its API.
- **Worker Hosts** are machines or sandboxes that provide execution capacity. On each, a
  **Worklet** (`supertag worker-host`) connects the host to the Control Plane and claims Tasks.
  For each Task Attempt it starts a **Worker**, a process of its own that runs a **harness
  adapter**, the program that drives an agent system such as Codex or Claude Code, and that
  harness.
- A **Gateway** is the endpoint clients connect to: the CLI, the terminal UI, the desktop app,
  and applications built on the SDKs. It forwards their calls to the Control Plane, and it
  connects collaboration surfaces, such as Slack or GitHub.

SuperTag stores each accepted turn of work as a **Task** for a Tag. The Tag exists independently
of the model or harness that executes the Task.

This separation also protects the organization. Before a Worklet receives a Task, the Control
Plane records who is acting, who requested the work, where the request came from, which reusable
knowledge may be added, which actions are allowed, which approvals apply, and which execution
limits must be followed. A harness cannot expand the Task's permissions.

```text
Slack / GitHub / Linear / Lark / Teams     CLI / terminal UI / desktop app / your application
                 |                                         |
                 └──────────────> Gateway <────────────────┘
                                     |  forwards calls as a client
                                     v
                          Control Plane: one gRPC API (https:// or wss://)
                          - organizational resources and policy
                          - scheduling, leases, and recovery
                          - durable state and audit (SQLite or PostgreSQL)
                                     ^
                                     | outbound connections
                     Worker Hosts, each running a Worklet
                          - claims Tasks the host's Tags may run
                          - prepares pinned Workspace checkouts
                          - starts a Worker per Task Attempt: a harness adapter
                            for Codex, Claude Code, Cursor, OpenCode, OpenAI
                            Agents, or your own
                          - local processes, E2B or Modal sandboxes, or a shared
                            execution environment
```

On a laptop, `supertag up` runs a Control Plane, a Gateway, and this machine's Worklet side by
side. A shared deployment runs the Control Plane and Gateway on a server or hosting platform, and
teammates' machines connect as Worker Hosts. See
[SuperTag and other agent systems](supertag-and-other-agent-systems.md) for how the
organizational layer relates to assistants, agent runtimes, and coding harnesses.

## The Control Plane

The Control Plane is the source of truth for the organization. It owns Tags and their enduring
responsibilities, called **Roles**. It owns **Objectives**, the outcomes Tags pursue, and
**Teams**, flat lists of member Tags. Each Team has a **Workstream**, its shared record of posts.
It owns **Sessions**, each one Tag's thread of work, the **Tasks** that are their turns, and
**Mailboxes**, where a Tag receives messages from other Tags. It also owns **Context Sets**, which
select reusable knowledge for a Task, **Permission Sets**, which select the actions a Task may
perform, and budgets, recorded policy, events, and audit history. It accepts new work, schedules
it, keeps long-running records consistent, and recovers interrupted operations.

Every caller authenticates with its own credential, and the Control Plane checks each call
against one table of roles: operators, client devices, Worker Hosts, and Gateways. See
[Identity and access](../reference/iam.md).

## The Gateway

The Gateway is the boundary for clients and collaboration surfaces. The CLI, the terminal UI,
the desktop app, and SDK applications connect to it, and it forwards their calls to the Control
Plane under the caller's own credential. It also receives and authenticates surface traffic,
turns it into Tasks through the Control Plane's connector API, delivers replies, and sends
operator notifications. For that work it is an ordinary client of the Control Plane with its own
credential. Worker Hosts do not register or claim work through it: their Worklets connect to
the Control Plane. A Gateway also carries running Task Attempts' events, streamed text, and
other reports, under each Task Attempt's own credential, but never the host's. When a deployment
names such a Gateway, the host's Workers send their reports only there; `supertag up` names its
local Gateway.

For example, when someone mentions `@SuperTag` in Slack, the Gateway passes the message, its
origin, and its requester to the Control Plane. The Control Plane finds the Tag configured for
that channel, accepts and stores the Task, and schedules it. When the work finishes, the Gateway
carries the reply back to the thread.

The Gateway does not decide organizational policy, create Tasks or Teams on its own, or schedule
work. It holds the surface credentials, and nothing else does.

## How identity and access are decided

A Tag is a non-human identity in SuperTag's access model. Its configured locations determine where
it can be invoked. Roles describe enduring responsibilities. Context Sets declare reusable
knowledge that may enter a Task, and Permission Sets declare surface-backed or runtime actions
the Tag may take.

Before accepting the work, the Control Plane combines those resources with the request's source,
requester, Workspace, and execution needs. It records the result on the Task. Later changes do
not rewrite that accepted Task. Context cannot create permission, and harness credentials cannot
expand the allowed actions.

## How the work runs

Each Worker Host's Worklet connects outbound and reports the host's harnesses, models, labels, and
capacity. The Control Plane places a Task only on a ready Worker Host that may run its Tag and carries the
labels the Tag requires. A Task stays queued when none is available, and
`supertag placement explain` says why. A Task that asks for an execution limit its Tag's harness
cannot enforce is refused when it is submitted, instead of waiting forever.

On the Worker Host, each **Task Attempt**, one execution of a Task, runs in its own pinned
checkout of the Tag's Workspace. The Worklet prepares the checkout and starts a Worker, a process
of its own for that Task Attempt. The Worker resolves the Task's Skills and supervises the
harness. Its harness adapter drives the agent and reports progress,
usage, and the result through the harness protocol. When the Task changes the Workspace, the
Worklet verifies the commits and delivers them as a `supertag/session/...` branch: it writes the
branch into the repository a local Workspace maps, or pushes it to a remote Workspace's git
server. Artifacts stay on the Worker Host that produced them or on a Volume. The Control Plane
stores only their records and relays no files: other Tasks read artifacts from the host directly.

## What survives a failure

The Control Plane stores each Task before a Worklet claims it. Task Attempts, events,
results, and outbound replies have their own recovery paths. A crashed adapter, a lost connection,
or a collaboration surface failure does not erase accepted work. See
[Scheduling and interrupted execution](../reference/scheduling-and-recovery.md).

Each Task stores its request and result. A later Task in the same Session resumes that Session's
native harness session from its checkpoint, which stays on the Worker Host that wrote it, so the
next Task prefers that host. When no usable checkpoint is at hand, such as on another host, it
starts fresh from a recap of the Session's earlier turns instead. Reusable outputs are
explicitly captured as artifacts.

## Extension points

Teams can add a harness by writing a [harness adapter](../guides/harness-adapters.md), connect a
collaboration surface by writing a [connector](../reference/connector-contract.md), and build
their own clients on the [Control Plane API](../reference/control-plane-api.md). All of them
share the same durable Task, identity, and permission boundaries.

Continue with [Tags](tags.md), [Tasks and Sessions](tasks.md), or
[Worker Hosts, Worklets, Workers, and harnesses](workers.md), depending on which boundary you need to understand next.
