# What survives when a sandbox or host dies

A few terms first:

- A **Task** is one unit of work an agent runs, such as a code change or a review.
- A **Worker Host** is a machine that runs Tasks: a laptop, a server, or a cloud machine. A remote
  sandbox (Modal, e2b) is a short-lived machine a Worker Host starts for a Task.
- A **Worker** is the code on a Worker Host that completes a Task. A **harness** connects it to an
  agent system such as Codex, Claude Code, or Cursor.
- The **Control Plane** is the service that records Tasks and their results and keeps the catalog
  of artifacts, the files Tasks produce. It never stores the artifact files themselves.
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

## Copies and live mounts

A **Workspace** names a git repository and can attach data from a Volume outside its checkout.
For example, an analysis repository can read a dataset from a bucket without adding it to git.
The mount strategy determines whether a Task reads a separate copy or the live source.

| Strategy | What the Task reads | When to choose it |
| --- | --- | --- |
| Copy | Files copied into its environment before the harness starts, with a recorded manifest | A bounded dataset that fits in the Task environment |
| Native mount | Live data from the source, without a copy manifest | A large dataset or data that must remain live |

Native mounts attach at Task start, after setup. They can be read-only or read-write.
Mounted content never becomes part of prepared images or setup snapshots. A live source can change
between reads or Task runs, so a mount does not pin a dataset version. Object stores do not offer
all local filesystem operations; keep tools that require rename, append, or locks in the checkout.

The provider enforces the declared access and holds storage credentials outside the Task's
environment and harness.
Local and e2b providers refuse native mounts. SuperTag refuses unsupported strategies before
calling a provider and never silently substitutes a copy.

Modal attaches S3, R2, GCS, and Modal Volume sources with their declared access.
[Attach persistent storage to a Workspace](../guides/workers.md#run-cursor-in-a-sandbox)

Both strategies leave the source outside the sandbox's lifecycle. A copied dataset inside a
sandbox disappears with that sandbox; the source remains subject to its own storage durability.
Read-only mounts do not preserve Task outputs. Deliver those through git or store them as artifacts.

## Where artifacts are kept

Artifacts stay on the Worker Host whose Task captured them. The Control Plane keeps only the
catalog: what each artifact is, who made it, who may use it, and which hosts or Volumes hold a copy. It
never stores the files, so redeploying a hosted Control Plane loses no artifacts.

Another Task that may use an artifact downloads it directly from the host that holds it. The host
services that `supertag up` starts on an operator's laptop are persistent, so their copies last as
long as that disk. A copy held only on an ephemeral Worker Host is lost when that host stops.

A host can store its artifacts on an artifact Volume instead, such as a bucket prefix. Those copies
outlive the host. Each producing **Task Attempt**, one execution or retry of a Task, has its own
copies on the Volume. Reporting the same digest from another Task Attempt does not grant access to
those copies. Hosts that can't reach each other, like two laptops behind NAT, share artifacts
through a common artifact Volume. Without a reachable host or a shared Volume, the artifact is
unavailable to that Task, and the error says where it is. For details, see
[Run the Control Plane](../operations/control-plane.md#artifact-storage) and
[Artifacts](../reference/artifacts.md).

Default hosts do not advertise a transfer endpoint reachable from another machine. Dependent Tasks
that need artifact inputs fail with the unavailable error when placed on another host. The same
applies to resumed Sessions (continued conversations) restoring harness-home artifacts on another
host. Configure a shared artifact Volume or a reachable transfer endpoint before moving that work.
Native Session transcripts remain separate state on the Control Plane; they do not supply missing
harness-home artifact bytes.

## Read live data beside a checkout

A Workspace names a git repository and can attach a Volume beside its checkout. For example,
a training Task can read a shared model dataset without first copying the whole dataset.
Modal can attach buckets and Modal Volumes as native read-only mounts. Setup runs before these
mounts exist, so prepared images and snapshots never contain their data.

The mount is live: another writer can change the source while a Task runs. SuperTag records the
source, prefix, destination, and attachment time. It does not freeze the files or produce a copy
manifest. Disposing the sandbox removes its attachment; the source stays with its storage provider.
Read-only mounts cannot preserve new Task output. Capture outputs as artifacts or deliver git changes.

Credentials stay with Modal. A host names a Modal Secret or an S3 OIDC role; a Modal Volume uses
the provider's identity with the host's consent to that specific Volume.
The host controls the Modal environment. The harness receives neither bucket credentials nor Modal account tokens.
Local and e2b environments support copies only, and SuperTag never silently substitutes a copy.
See [Volumes](../reference/resource-model.md#native-source-settings) for supported sources.

Object stores do not behave like local disks. They lack the rename, append, and locking behavior
that tools such as git and SQLite expect. Keep the checkout and writable tool state outside mounts.

## Credentials and local access

Catalog grants control what SuperTag Workers fetch. They do not isolate a Task from files its
operating-system account can read. In particular, `~/.supertag/artifacts`, `file://` artifact
Volumes, and volume-credential files are readable by Codex read-only and workspace-write sandboxes
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
- [Worker Hosts and Workers](workers.md)
