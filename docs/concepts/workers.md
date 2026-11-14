# Worker Hosts and harnesses

The parts on this page run each **Task**, one turn of work for a **Tag**, a persistent AI actor
with its own responsibilities and permissions. The **Control Plane**, the service that stores the
organization, decides what work to accept and keeps a lasting record of it. **Worker Hosts**
provide the machines or sandboxes where the work runs, and a **harness** connects each Task to an
agent system. The [glossary](../reference/glossary.md) lists other terms.

| Term | Plain-language meaning |
| --- | --- |
| Worker Host | A machine, container, VM, or sandbox that runs Tasks. It connects outbound to the Control Plane |
| Task Attempt | One execution of a Task on a Worker Host. A retry is another Task Attempt |
| Harness | The agent system a Task runs on: Codex, Claude Code, Cursor, OpenCode, OpenAI Agents, or your own |
| Harness adapter | The process a Worker Host starts for each Task Attempt to drive the harness |
| Execution environment | Where the Task's files and commands live: a local checkout, an E2B or Modal sandbox, or a shared execution environment |

## Follow one Task

```text
Collaboration surface or CLI
        │ message
        v
Control Plane ── accepts, stores, and queues the Task for its Tag
        ▲
        │ claim (outbound connection)
Worker Host ── prepares a pinned checkout ── starts the harness adapter
        │                                           │
        │                           drives Codex, Claude Code, ...
        └── reports events, usage, the result, and the delivered commits
```

1. A message reaches the Control Plane, which accepts it as a Task for a Tag and records the
   permissions and knowledge that apply.
2. A Worker Host that may run the Tag, and carries the labels the Tag requires, claims the Task.
   Its claim is a lease the host renews while it works.
3. The host prepares a checkout of the Tag's Workspace pinned to an exact commit, resolves the
   Task's Skills, and starts the harness adapter in it.
4. The adapter runs the agent, reports progress, and completes the Task Attempt with its result
   and a Session checkpoint.
5. The host verifies the commits the Task made and delivers them as a Git bundle. Your machine
   imports them as a `supertag/session/...` branch.

## Worker Host

A Worker Host is the capacity side of SuperTag. It can be your laptop, a server, a CI runner, or
a container. It enrolls once with an **Auth Key** and keeps its own credential. It reports its
harnesses, models, labels, and concurrency, and claims only Tasks of the Tags it may run.

A host never receives other hosts' credentials or the Control Plane's database credential. It
holds the harness sign-ins and MCP credentials its Tasks use, and passes each harness only its
own. See [Run Worker Hosts](../guides/workers.md).

## Harness and harness adapter

The harness is the agent system that does the work. The harness adapter connects one Task Attempt
to it: it receives the Task, its Session checkpoint, and its allowed capabilities from the host,
drives the agent, and reports back. Codex's adapter is built into `supertag`. Claude Code, Cursor,
and OpenCode use Node bridges, and OpenAI Agents uses the `supertag` Python package. You can write
your own; see [Write a harness adapter](../guides/harness-adapters.md).

Harness-native subagents stay inside one Task Attempt and use their harness's own coordination.
Work that another Tag should do goes through SuperTag: a work Session, a Mailbox message, or a
Workstream post.

## Execution environment

By default a Task runs in a local checkout on the host. Codex and Claude Code run commands inside
their own sandbox. OpenCode and Cursor need the host's consent to run commands without one.

Cursor Tasks can also keep their files and commands in an E2B or Modal sandbox, or in a shared
execution environment that several Sessions use, while the harness and its credentials stay on
the host. See [Run Cursor in a sandbox](../guides/workers.md#run-cursor-in-a-sandbox).

## What a Worker Host keeps

A host's state directory holds its credential, its execution journal, output files waiting to
upload, and Workspace checkouts. The journal lets a restarted host recover an interrupted Task
Attempt without running it twice. See [Persistence](persistence.md).

## Next

- [Run Worker Hosts](../guides/workers.md)
- [Worker Host reference](../reference/worker.md)
- [Scheduling and interrupted execution](../reference/scheduling-and-recovery.md)
