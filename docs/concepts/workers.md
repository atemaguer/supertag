# Worker Hosts, Worklets, Workers, and harnesses

The parts on this page run each **Task**, one turn of work for a **Tag**, a persistent AI actor
with its own responsibilities and permissions. The **Control Plane**, the service that stores the
organization, decides what work to accept and keeps a lasting record of it. The work itself runs
in four layers. The [glossary](../reference/glossary.md) lists other terms.

| Layer | Plain-language meaning | Like, in Kubernetes | Like, in Ray |
| --- | --- | --- | --- |
| Worker Host | A machine, container, VM, or sandbox that provides capacity to run Tasks | A node | A node |
| Worklet | The program on a Worker Host that connects it to the Control Plane: `supertag worklet`. It claims Tasks, holds their leases, and starts and supervises Workers | The kubelet | The raylet |
| Worker | A process the Worklet starts for one Task Attempt. It runs a harness adapter and the harness it drives, in their own process group | A pod | A worker process |
| Harness | The agent system that does the work: Codex, Claude Code, Cursor, OpenCode, OpenAI Agents, or your own | The application in a container | The code a worker runs |

Two more terms come up below:

| Term | Plain-language meaning |
| --- | --- |
| Task Attempt | One execution of a Task on a Worker Host. A retry is another Task Attempt |
| Harness adapter | The process a Worker starts for its Task Attempt to drive the harness |
| Execution environment | Where the Task's files and commands live: a local checkout, an E2B or Modal sandbox, or a shared execution environment |

The Worklet handles control: what to run, and whether it is still allowed to. The Worker handles
the work. A Worker's own calls never carry the Worker Host's credential. It reports with a
credential of its own that names its one Task Attempt and stops working when the Worklet's lease
on it ends.

## Follow one Task

```text
Collaboration surface or CLI
        │ message
        v
Control Plane ── accepts, stores, and queues the Task for its Tag
        ▲
        │ claim (outbound connection)
Worklet ── prepares a pinned checkout ── starts a Worker (harness adapter)
        │                                           │
        │                           drives Codex, Claude Code, ...
        └── reports events, usage, the result, and the delivered commits
```

1. A message reaches the Control Plane, which accepts it as a Task for a Tag and records the
   permissions and knowledge that apply.
2. The Worklet on a Worker Host that may run the Tag, and carries the labels the Tag requires,
   claims the Task. Its claim is a lease the Worklet renews while the work runs.
3. The Worklet prepares a checkout of the Tag's Workspace pinned to an exact commit, resolves the
   Task's Skills, and starts a Worker in it: the harness adapter and its harness.
4. The Worker runs the agent, reports its progress with the Task Attempt's own credential, and
   hands the Worklet its result and a Session checkpoint. The Worklet completes the Task Attempt.
5. The Worklet verifies the commits the Task made and delivers them as the branch
   `supertag/session/...`: it writes the branch into the repository it maps, or pushes it to a
   remote Workspace's git server.

## Worker Host and Worklet

A Worker Host is the capacity side of SuperTag. It can be your laptop, a server, a CI runner, or
a container. It enrolls once with an **Auth Key** and keeps its own credential.

Its Worklet is the `supertag worklet` program, which `supertag up` runs for each host service
in `supertag.yaml`. The Worklet reports the host's harnesses, models, labels, and concurrency,
and claims only Tasks of the Tags the host may run. It runs up to `concurrency` Workers of each
harness at once, and keeps one journal with an entry for each Task Attempt they run.

A host never receives other hosts' credentials or the Control Plane's database credential. It
holds the harness sign-ins and MCP credentials its Tasks use, and the Worklet passes each Worker
only its own harness's. See [Run Worker Hosts](../guides/workers.md).

## Worker, harness, and harness adapter

A Worker exists for one Task Attempt. It is a process of its own, which the Worklet starts once it
has started the Task Attempt and prepared its checkout. The Worker runs the harness in its own
process group, with a scratch directory and a token that work only for that Task Attempt, and
stops every process it left when the Task Attempt ends. A Worker dies with its Worklet; the
Worklet's next start recovers the Task Attempt from its journal.

The Control Plane gives each Task Attempt a credential when it starts. The Worker's events,
questions, messages, and other reports carry it, and it cannot claim, start, or finish work. It
ends with the Task Attempt's lease, so a Worker whose Worklet lost the lease can no longer report
anything. A Worker never holds the host's own credential. It hands its outcome to the Worklet,
which finishes the Task Attempt, and asks the Worklet for the few host calls its Task Attempt
needs; the Worklet makes them for that Task Attempt only. The Worker sends its reports to the
data endpoint the Control Plane names. That is usually a Gateway, which passes them on unchanged,
since the credential alone decides what they may do; under `supertag up`, it is the local Gateway.
The Worker has no other route: when the Gateway is unreachable, its reports wait and retry rather
than going to the Control Plane. A Workspace checkout, a Session checkpoint, and captured artifacts
outlast the Worker; the Worklet keeps them.

The harness is the agent system that does the work. The harness adapter connects one Task Attempt
to it: it receives the Task, its Session checkpoint, and its allowed capabilities from its Worker,
drives the agent, and reports back. Codex's adapter is built into `supertag`. Claude Code, Cursor,
and OpenCode use Node bridges, and OpenAI Agents uses the `supertag` Python package. You can write
your own; see [Write a harness adapter](../guides/harness-adapters.md).

Harness-native subagents stay inside one Task Attempt and use their harness's own coordination.
Work that another Tag should do goes through SuperTag: a work Session, a Mailbox message, or a
Workstream post.

## Execution environment

By default a Task runs in a local checkout on the host. Codex runs commands inside its own
sandbox, and Claude Code inside its own on a host with `sandbox-commands`, which `supertag init`
sets where that sandbox can start. Claude Code, Cursor, and OpenCode Tasks also run well in
**local-vm** containers: the host keeps each
Workspace in a container on its own Docker, where their file tools and commands run with
no network. Otherwise Claude Code, OpenCode, and Cursor run commands in a local checkout only when
the host opts in with `allow-unsandboxed-commands`, because those commands run as the host's user
without an operating-system sandbox.

They can also keep a Workspace in an E2B or Modal sandbox, and Cursor
Tasks can use a shared execution environment that several Sessions use.
Either way, the harness and its credentials stay on the host. See [Run a harness in a sandbox](../guides/workers.md#run-a-harness-in-a-sandbox).

## What a Worker Host keeps

A host's state directory holds its credential, its execution journal, Workspace checkouts, and
the artifacts and Workspace deliveries its Tasks produce. The Control Plane stores none of those
files and passes none of them on. Other hosts' Worklets read artifacts from the host directly or
from a Volume, and its Worklet pushes each delivery to its Session branch in the Workspace's git
remote, or writes it into a local Workspace's repository. The journal lets a restarted Worklet
recover an interrupted Task Attempt without running it twice. See [Persistence](persistence.md).

## Next

- [Run Worker Hosts](../guides/workers.md)
- [Worker Host reference](../reference/worker.md)
- [Scheduling and interrupted execution](../reference/scheduling-and-recovery.md)
