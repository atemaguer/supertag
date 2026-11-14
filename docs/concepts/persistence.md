# What survives when a sandbox or host dies

A few terms first:

- A **Task** is one unit of work an agent runs, such as a code change or a review.
- A **Worker Host** is a machine that runs Tasks: a laptop, a server, or a cloud machine. A remote
  sandbox (Modal, e2b) is a short-lived machine a Worker Host starts for a Task.
- A **Worker** is the code on a Worker Host that completes a Task. A **harness** connects it to an
  agent system such as Codex, Claude Code, or Cursor.
- The **Control Plane** is the service that records Tasks and their results and keeps the catalog
  of artifacts, the files Tasks produce. It keeps their bytes in a transfer directory, never in its
  database.
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
| Artifacts on an artifact Volume | Yes, per the Volume's own durability |
| Delivered git branches and pull requests | Yes, in the git remote |
| The Control Plane's catalog, Tasks, and results | Yes, in its database |

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

A Task always receives a copy. The Worker Host makes it fresh for each Task Attempt, after the
checkout and `setup`, so prepared images and snapshots never contain the data. The Worker Host
reads the source with its own credential, and the Task and its harness see only the files. In a
remote E2B or Modal Workspace, only the files enter the sandbox.

A copy pins what the Task read: a later change to the source does not reach a running Task. A
read-only copy cannot preserve Task output. A read-write copy can: after a successful Task
Attempt, the Worker Host writes changed and created files back to the Volume, and records what it
wrote. A failed Task Attempt writes nothing, and deletions are never written.

Read-only provider-native Modal Volume mounts are on the backlog. Live read-write mounts are not
offered: a write through one would bypass the Worker Host's bounded, recorded write-back.
[Attach data outside the repository](../guides/workspaces.md#attach-data-outside-the-repository)

## Where artifacts are kept

The Control Plane keeps the artifact catalog: what each artifact is, who made it, who may use it,
and where each copy lives. Each capture also stores the files in the Control Plane's transfer
directory, a private directory beside its database. Redeploying a hosted Control Plane keeps them
only when that directory sits on a persistent volume.

Two other copies can outlive the transfer directory. A Worker Host set up for direct transfer
keeps its own copy and serves it to other hosts; that copy lasts as long as the host's disk. An
operator can also copy a file to an artifact Volume, such as a bucket prefix; that copy outlives
both. For details, see [Run the Control Plane](../operations/control-plane.md#artifact-storage) and
[Artifacts](../reference/artifacts.md).

## Credentials and local access

Catalog grants control what SuperTag Worker Hosts fetch. They do not isolate a Task from files its
operating-system account can read. In particular, `~/.supertag/checkpoints`, `file://` artifact
Volumes, and Volume credential files are readable by Codex read-only and workspace-write sandboxes
and by unsandboxed Claude Code when running under that account. Those Tasks can read local copies
without catalog grants, and credentials may give access to other artifacts on a shared Volume.
Keeping credentials outside the workspace does not prevent these reads. Use separate operating-system
identities or an isolation boundary that denies access to supervisor storage for untrusted Tasks.

## Ephemeral storage is visible

A Worker Host can be declared ephemeral when it joins. Remote sandboxes always count as ephemeral.
SuperTag doesn't hide this. Host and Task listings mark ephemeral storage and say where each output
and artifact lives. Starting work warns, without refusing, when an ephemeral host would hold the
only copy of artifacts.

This warning describes recorded storage, not independently verified durability. For example, an
ephemeral host can report an upload to its artifact Volume. That one report records both the Volume
copy and its upload receipt; the receipt is not separate evidence that bytes were written. Once
all files have matching available Volume records and receipts, the artifact's warning clears.
The Control Plane checks the producing Task Attempt, host, and configured Volume, but never reads
the bytes. A faulty or dishonest host can therefore clear the warning without storing the files.
Missing warnings do not prove that artifacts exist, remain readable, or survive host removal.
Downloads check availability, size, and digest at the time of retrieval; Volume durability still
depends on the storage provider and its retention settings. For the commands, see
[CLI](../operations/cli.md).

## Related

- [Work in a repository with Workspaces](../guides/workspaces.md)
- [Volumes](../reference/resource-model.md#volumes)
- [Worker Hosts and harnesses](workers.md)
