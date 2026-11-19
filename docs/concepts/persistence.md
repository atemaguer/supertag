# What survives when a sandbox or host dies

A few terms first:

- A **Task** is one unit of work an agent runs, such as a code change or a review.
- A **Worker Host** is a machine that runs Tasks: a laptop, a server, or a cloud machine. A remote
  sandbox (Modal, e2b) is a short-lived machine started for one Task, away from its Worker Host.
- A **harness** is the agent system a Task runs on, such as Codex, Claude Code, or Cursor. On
  the Worker Host, a **Worker** drives it through a harness adapter for one Task Attempt, and
  the host's **Worklet** keeps what outlasts that Worker.
- The **Control Plane** is the service that records Tasks and their results and keeps the catalog
  of artifacts, the files Tasks produce. It never stores their bytes: the Worker Host that produced
  them keeps them.
- A **Volume** is named storage that outlives any one machine, such as an S3 bucket.

SuperTag storage works like Docker storage. A container's filesystem disappears with the
container, and you mount a volume to keep data. In SuperTag, remote sandboxes and cloud Worker
Hosts are the containers. Volumes are the volumes.
Anything that isn't on a Volume, or delivered somewhere durable, is lost when the sandbox or host
dies.

## What survives

| Where it lives | Survives the sandbox or host dying? |
| --- | --- |
| Files in a remote sandbox (Modal, e2b) | No |
| A cloud Worker Host's state: Task worktrees, undelivered branches, staged outputs, caches | No, unless that state is on a Volume |
| Artifacts stored on a Worker Host that isn't persistent | No |
| Artifacts stored on a persistent Worker Host | Yes, while that host's disk lasts |
| Artifacts on a Tag's Volume | Yes, per the Volume's own durability |
| Delivered git branches and pull requests | Yes, in the git remote |
| The Control Plane's catalog, Tasks, and results | Yes, in its database: PostgreSQL, or a local SQLite file that commits durably through a write-ahead log (`-wal` and `-shm` files beside it, owner-only like the database) |
| Session checkpoints, which let a later Task resume the harness session | Yes, on the Worker Host that wrote them, until dropped; see [Session checkpoints](../reference/control-plane.md#session-checkpoints) |
| A harness's own memory, such as Claude Code's auto-memory | Only on a Tag's Volume, per the Volume's durability; otherwise on the Worker Host that ran the turn, while its disk lasts; see [Harness memory](../reference/coordination.md#harness-memory) |

## Compared with Docker

| Docker | SuperTag |
| --- | --- |
| A container | A remote sandbox or a cloud Worker Host |
| The container's writable layer | Task worktrees, staged outputs, and caches on that host |
| A named volume | A Volume |
| Pushing an image or copying data out | Delivering a branch or pull request |

Docker doesn't refuse to run a container without a volume. SuperTag doesn't refuse either.
Temporary output is a valid choice, as long as it's a known one.

## Copies of Volume data

A **Workspace** names a git repository. A Task can also receive data from a **Volume**, a host
directory or an S3 bucket and prefix, outside its checkout. For example, an analysis Task can read
a dataset from a bucket without adding it to git.

A Task always receives a copy. The Task Attempt's Worker makes it fresh, after the
checkout and `setup`, so prepared images and snapshots never contain the data. The Worker
reads the source with the Worker Host's own credential, and the Task and its harness see only the files. In a
remote E2B or Modal Workspace, only the files enter the sandbox.

A copy pins what the Task read: a later change to the source does not reach a running Task. A
read-only copy cannot preserve Task output. A read-write copy can: after a successful Task
Attempt, the Worklet writes changed and created files back to the Volume, and records what it
wrote. A failed Task Attempt writes nothing, and deletions are never written.

SuperTag offers no live read-write mounts: a write through one would bypass the Worklet's
bounded, recorded write-back. See
[Attach data outside the repository](../guides/workspaces.md#attach-data-outside-the-repository).

## Where artifacts are kept

The Control Plane keeps the artifact catalog: what each artifact is, who made it, who may use it,
and where each copy lives. It never stores the files. The Worker Host whose Task captured them
keeps them in its own artifact storage. When another Task reads a file, the Control Plane checks
the read and grants it, and the reading host's Worklet fetches the bytes from its own storage or
straight from the producing host's Worklet. The Control Plane relays no files. A GitHub
publication is the exception: it keeps the delivery in private scratch until it has pushed it.

So an artifact is readable only while its Worker Host is running and connected, unless it also has
a Volume copy. For example, a laptop's artifacts are unreachable while the laptop sleeps, and the
error names the laptop's Worker Host. A Tag whose `volume` names a Volume gets a copy of every
capture there, such as in a bucket prefix, written by the capturing host itself before the
capture succeeds; it outlives the host, for the hosts and people that use the Volume. For
details, see [Run the Control Plane](../operations/control-plane.md#artifact-storage) and
[Artifacts](../reference/artifacts.md).

## Credentials and local access

Catalog grants control what SuperTag Worklets fetch. They do not isolate a Task from files its
operating-system account can read. In particular, a Worker Host's artifact storage under `~/.supertag`, `file://` artifact
Volumes, and Volume credential files are readable by Codex sandboxes
and by Claude Code, OpenCode, or Cursor with `allow-unsandboxed-commands` when running under that
account. Those Tasks can read local copies without catalog grants, and credentials may give access to other artifacts on a shared Volume.
Keeping credentials outside the workspace does not prevent these reads. Use separate operating-system
identities or an isolation boundary that denies access to supervisor storage for untrusted Tasks.

## Ephemeral Worker Hosts

A Worker Host that joins with an ephemeral Auth Key (`supertag auth-key create NAME --role host
--ephemeral`) is removed once it goes offline. Use one for a CI runner or a cloud machine that
does not come back. Its host record marks it ephemeral. Its Workspace deliveries go with it, and
so do its artifacts, unless they have a Volume copy. Give the Tags that run there a `volume` so
that every capture does.

Downloads check availability, size, and digest at the time of retrieval. Volume durability still
depends on the storage provider and its retention settings. For the commands, see
[CLI](../operations/cli.md).

## Related

- [Work in a repository with Workspaces](../guides/workspaces.md)
- [Volumes](../reference/resource-model.md#volumes)
- [Worker Hosts, Worklets, Workers, and harnesses](workers.md)
