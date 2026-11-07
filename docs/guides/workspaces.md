# Work in a repository with Workspaces

A **Tag** is a persistent AI identity with its own responsibilities and permissions. An
**Objective** is an outcome a Tag owns, and its **Tasks** are the assignments toward it. A
**Workspace** is a named repository that an Objective's Tasks work in, such as `app`. A **Worker
Host** is a machine that runs Tasks; it declares a local checkout, keeps a clone of the Workspace's
`source`, or runs a provider that prepares the source for each Task. A **Worker** is the code on
that host that completes each Task. You can attach a **Volume**, a named storage location, to give
each Task data outside its repository. A read-write mount can also save changed files back to that
location. An operator defines the mount on the workspace. An Objective names the Workspaces its
Tasks may use. Tags then work in the repository without seeing each other's unfinished changes. See
the [glossary](../reference/glossary.md) for other terms.

Use this guide when Tags should change a repository and hand the changes back as branches,
patches, or GitHub pull requests. Without a Workspace, a Task sees a copy of a folder, and edits
stay inside that copy.

## How it works

Each local Task of an Objective gets its own git worktree on branch `supertag/<objective>/<task>`.
A work Session's Tasks use `supertag/session/<id>`, then `supertag/session/<id>-2` and so on; see
[where a work Session's edits go](../concepts/tasks.md#where-a-work-sessions-edits-go). A worktree is
a second working directory of the same repository, so nothing is copied. The harness, such as
Claude Code, Codex, or OpenCode, edits files there directly. A prepared environment provider
starts a separate sandbox for each Task. After each **Task Attempt**, one execution of a Task, the
Worker commits the changes
to the Task branch and delivers them as the Workspace's `delivery` says:

| Delivery | Result |
| --- | --- |
| `branch` (default) | The Task branch stays in your repository. The Task result names the branch and its head commit. |
| `patch` | The Worker also saves `git format-patch` output of the Task branch as an artifact (a captured output file) on the Task result. The branch stays too. |
| `pull-request` | The Worker pushes the Task branch to the GitHub `source` and opens one draft pull request per Task. See [Deliver pull requests](#deliver-pull-requests). |

The Worker reads patches and pull requests from the Task branch's git ref. On a host with a bare
clone, a provider can return commits in a git bundle. Before the Worker moves that branch, it
checks the bundle's 32 MiB limit, digest, integrity, single ref, and ancestry from the Task's
base commit. The host imports only the verified Task ref; hooks and working tree filters do not
run during this import.

Your own working tree and current branch never change. Parallel Tags never share files, because each
Task has its own worktree.

The Worker checks whether a provider can serve the Workspace before preparing it. A provider
that cannot serve it gives a refusal reason. `supertag describe task ID` shows the reason when
placement waits, and shows the prepared environment's digest, provider, and trusted commit after
the Worker reports them. The digest identifies the setup artifact used for that Task Attempt.
On a host with several **Worker Profiles**, saved recipes for running a Worker, placement can choose any profile that supports the
Workspace provider. If all eligible profiles refuse it, the reason appears before a Task Attempt
starts. The Objective's Runnable condition shows the same reason for source Workspaces.

## Before you start

- A local **Control Plane**, the SuperTag service that stores and schedules work, and the
  `supertag` CLI; see [Get started](../../README.md#get-started).
- A git repository, such as `~/code/app`.
- An enrolled Worker Host; see [Run a Worker](workers.md).
- A Tag bound to that host whose **Roles**, its assigned responsibilities, grant the `files:write`
  runtime action, so it may edit files.

## 1. Declare the Workspace

Save this as `workspace.yaml`:

```yaml
apiVersion: supertag/v1
kind: Workspace
metadata:
  name: app
spec:
  source: https://github.com/acme/app.git # optional; hosts without a checkout clone it
  ref: main                               # base for Task branches
  setup: npm ci                           # optional; runs on the base commit of each new worktree
  mcp: [sentry]                           # optional; selected servers from .mcp.json
  skills: [docs-conventions]              # optional; Skills from the host checkout
  delivery: branch                        # branch, patch, or pull-request
```

```sh
supertag apply -f workspace.yaml
```

Every field is optional for a workspace without mounts. A workspace with mounts needs a git
`source`. Without `ref`, Task branches start from the checkout's current branch, or
from the source's default branch in a clone, else `main`. `source` must not contain credentials;
each Worker Host supplies its own. Tags work in Teams under a lead. Together, your Teams of Tags
make up an **autonomous organization**: Teams may pursue different Objectives but share one
Control Plane, its rules, and its record of the work. A Workspace can live in the same input as
the rest of your organization; `supertag apply -f` applies Workspaces first.

### Attach data outside the repository

A workspace mount places a Volume's files at an absolute path outside the Task's git checkout.
For example, an analysis Task can read a dataset at `/mnt/datasets` without committing it to git.
Declare the Volume separately, then add this to the workspace's `spec`:

```yaml
source: https://github.com/acme/app.git
mounts:
  - volume: datasets
    path: /mnt/datasets
    access: read-only
    strategy: copy
    maxBytes: 1073741824
```

`source` remains a git repository. Each mount names a Volume and a normalized absolute path.
`access` defaults to `read-only`, and `strategy` defaults to `copy`. `maxBytes` is an optional
positive integer byte limit, capped at 20 GiB. The path must stay outside the checkout and staged Task files;
mount paths cannot overlap each other. Set `access: read-write` to save changes to the Volume source. `strategy: mount` uses a provider-native mount where supported; unsupported combinations are refused with a reason. Tasks cannot add or change workspace mounts.
Use `supertag describe workspace app` to inspect the declared mounts.

### What a copy mount does

Each Task Attempt gets its own fresh copy. The Worker Host makes it when the Task Attempt starts,
after `setup` and the checkout. So `setup` never sees the data, and no prepared environment, such
as a Modal image or an E2B template, contains it.

Before it clones, prepares, or creates a sandbox, the Worker Host checks each mount. It refuses the
Task Attempt, naming the Volume, when the Volume was deleted or its credential has no readable
[`volume-credentials`](../reference/supertag-yaml.md#host-service) mapping on this host. A `file://` Volume needs a `{ path: DIR }` mapping that contains its source after links resolve. It also
refuses a `file://` Volume in or containing SuperTag's own state or secret files.
Sources cannot contain the host user's home directory. A source under a hidden directory directly
inside home, or under `Library`, needs explicit path consent within that directory. SuperTag
rechecks these rules while listing and copying, after resolving symbolic links.

1. The Worker Host lists the Volume's files first. It stops and refuses the Task Attempt as soon
   as the listing passes the mount's `maxBytes` (at most 20 GiB), or 1 GiB without one, or 10,000 files. The
   combined files across all mounts must fit in 20 GiB per Task Attempt, including each copy of a
   repeated Volume. Their manifests must also fit in 2 MiB, so very long keys allow fewer files.
   Nothing is downloaded before all listings fit.
2. It downloads each file with the Volume's credential, which stays on the Worker Host. The
   Task, the harness, and a sandbox provider such as Modal or E2B receive file contents only.
3. It writes the files under the mount path. A read-only copy has write permission removed; a read-write copy allows changes.
4. It records a manifest on the Task Attempt: each file's key, size, and ETag (or a SHA-256 for
   a `file://` Volume), plus a digest of the whole manifest.

SuperTag refuses the copy, naming the Volume, when a key would land outside the mount path.
Examples are a key containing `..`, a key starting with `/`, or one file that is also a
directory of another. Symbolic links in a `file://` Volume are skipped, never followed. Files with
more than one hard link are refused: another path could expose a file outside the allowed source.
SuperTag checks the opened file’s identity, link count, and change times against the listing.
Sources in temporary directories or declared checkouts are refused because Tasks can write there.
This also prevents planting a hard link whose original path was later replaced. If a file
changes while it is being copied, the Task Attempt fails instead of mixing versions. A refused
copy fails the Task Attempt as a Workspace setup failure before the harness starts.

Where the copy lands depends on the Worker Host:

| Worker Host | Copy location | When it is removed |
| --- | --- | --- |
| Local | `path` on the host. It must not exist, must not be in a temporary directory such as `/tmp` or `TMPDIR`, and the Worker user must be able to create it | When the Task Attempt ends |
| Remote sandbox (Modal, E2B) | `path` inside the Task Attempt's sandbox. It must not exist in the prepared environment | With the sandbox |

Remote copy mounts require `python3` in the sandbox image to receive and write the copied files.
Install it in the image before starting a Workspace that uses mounts.

### Save changes to a Volume

Set `access: read-write` on a mount when a Task must save generated files beside its input data. For example, a Task can read `/mnt/datasets/rows.csv` and write `/mnt/datasets/results.csv`. The default remains `read-only`. A `copy` mount uploads files the Task created or changed at finalize to its `s3://`, `r2://`, or `file://` source. It does not propagate deletions or follow symbolic links. The Worker uploads sequentially without retries.

Before any upload, SuperTag checks the entire output set. Each mount allows at most 1,000 files per Task Attempt. One file may be at most 5 GiB, and all changed files together must fit the mount's `maxBytes`. If a bound is exceeded, the upload is refused and nothing is uploaded. An upload failure after earlier files landed fails the Task Attempt with a reason naming the mount and key. Its partial output manifest identifies what landed, while the git result is still delivered. The owner decides whether to rerun; a rerun uploads those files again.

`strategy: mount` writes directly to the source through Modal CloudBucketMount or Modal Volumes. e2b refuses native mounts that would need keys inside the sandbox. Parallel Tasks writing one key use last-write-wins. An interrupted Task Attempt may leave partial writes. Writes land before review. Object stores are not POSIX filesystems: tools needing rename, append, or locks should not use native mount paths.

`supertag describe task ID` shows a **Writes** section for each Task Attempt. Each mount's output manifest lists its Volume, source, path, status (`complete`, `partial`, or `refused`), upload time, uploaded objects (key, size, SHA-256), skipped files, any error (key and reason), and files not attempted. The Objective overview summarizes these writes.

### Keep artifact storage separate

A mount must also stay outside every Worker Host's artifact Volume, where saved outputs live.
For example, a symlink to another host's artifact directory cannot expose those outputs as a
dataset. The Control Plane checks locations before dispatch. The consuming host checks every
cataloged file artifact location again by real path, including locations used only by other hosts.
This protects against filesystem aliases that exist only on the consuming host. Use
[artifact inputs](../reference/artifacts.md) to give a Task access to selected saved outputs.

### Local copies

A local copy is still a copy, even of a `file://` Volume on the same disk. A local harness that
runs without a sandbox can read any file the host user can, so treat read-only as protection
against accidents, not a security boundary. Locally, two running Task Attempts can't share a mount
path; the second one is refused.

A sandboxed local harness can usually write temporary directories. There it could swap a
directory above the mount path for a symbolic link, so SuperTag refuses local mount paths in
temporary directories. Choose a path under the host’s configured
[`local-mount-root`](../reference/supertag-yaml.md#local-mount-root), such as
`/srv/supertag-mounts/datasets`. Dot directories below that root are refused. SuperTag records each directory it creates for a copy and removes a copy only when
every directory above it is still the one it recorded. If anything changed, SuperTag stops and
leaves the path in place, and a later Task Attempt refuses it until you remove it.
SuperTag rechecks home and system destination restrictions when creating the local copy, so a
path redirected into a home configuration directory after the initial check is refused.

### Inspect copies

`supertag describe task` shows each Task Attempt's manifest, with up to 20 files per mount. When
a retry copied different content, the line says so:

```text
Mounts (Task Attempt 2):
  datasets  /mnt/datasets  copy read-only  2 objects, 1.2 KiB  sha256:4f1c0e2a1b2c (changed since Task Attempt 1)
    notes/readme.txt  210 B  etag "d41d8cd98f00b204e9800998ecf8427e"
    rows.csv  1.0 KiB  etag "9b2cf535f27731c974343645a3985328"
```

### Prepare each worktree with setup

`setup` is one shell command, such as `npm ci`, that prepares a new Task worktree. It runs on the
Worker Host, outside the harness sandbox, so the Worker runs it only on content you chose. The
Worker checks the worktree out at the Task's base commit, which comes from your `ref`, and runs
`setup` there. It then checks out the Task's own content in place. Files that `.gitignore`
matches, such as `node_modules/`, stay, so the Task starts with its dependencies installed. Setup
never runs on a Task branch or on any other commit a Tag made. It runs again only when the
base commit or the command changes.

Setup gets its own temporary directory, so it reads no cache that a Task left in the shared one.
The Worker removes that directory when setup finishes. Setup outputs then become the worktree's
own files. Some package managers, such as pnpm, hardlink files from a global store into
`node_modules/` on Linux, so editing one would change the store. The Worker replaces each such
file with a private copy before the Task starts.

If a Task changes dependencies, such as adding a package to `package.json`, its harness installs
them inside its own sandbox. That needs `commands:execute`, and network access when the install
downloads packages.

A review Task can consume an artifact, such as a patch, from a submitted Task in the same
Workspace. Its worktree then shows that Task's submitted commit. The Worker runs `setup` on the
base commit first, then checks out the submitted commit, so the reviewer can run checks with
dependencies installed. The reviewed change's own package scripts never run on the Worker Host. If
the change adds dependencies, the reviewer installs them inside its sandbox. SuperTag takes the
submitted commit from the delivery that the reviewed Task's Worker recorded, never from a change
the Task reported itself. A retried review continues its own branch only if that branch contains
the submitted commit.

A failed `setup` stops the Task before its harness starts. `supertag describe task ID` shows the
failure, and the Task result records `failureKind: "workspace-setup"`. The assigning owner sees the
failed Task on its next wake, with the output labeled as untrusted setup output.

If a reviewer creates another checkout or archive, that copy needs its own setup before checks.
Reviewers and verifiers should put temporary copies under `SUPERTAG_SCRATCH_DIR`. The Worker
removes that directory when their Task Attempt ends. Keep repository edits in the prepared
checkout and requested deliverables in their designated output paths.
For example, a detached copy of an npm project needs `npm ci` before `npm test`.

### Select repository Skills

A **Skill** is reusable guidance for a Tag. For example, `docs-conventions` can explain how
your team writes documentation. Put `SKILL.md` under `.claude/skills/docs-conventions/` or
`.agents/skills/docs-conventions/` in the host's checkout, then list its name in `spec.skills`.
SuperTag reads listed Skills from the host checkout, including gitignored directories. It pins a
copy outside the Task worktree when the Task first runs, so later checkout edits cannot change
that Task's Skill. Every Task in the Workspace receives its listed Skills. `supertag describe task
ID` shows each delivered Skill's source and content digest. If both Skill directories contain the
same name, `.claude/skills/` takes precedence. Workspace Skills take precedence over Skills with the same
name from a **Context Set**, a reusable knowledge selection attached to a Tag.

For a `file:` source, SuperTag reads Skills from that local source checkout. For a remote source,
the host keeps a primary checkout for Skills alongside its managed clone.

### Select Skills from a GitHub catalog

A GitHub Skill catalog is a repository that holds reusable Skill directories. Use one when several
workspaces share guidance without copying it into each project. For example, if
`github.com/acme/agent-skills` contains `catalog/review/SKILL.md`, add this to the Workspace
`spec`:

```yaml
skillCatalog:
  repository: acme/agent-skills
  path: catalog
  revision: main
  skills: [review]
```

`revision` may be a branch, tag, or full commit SHA. The Worker Host resolves it to an exact
commit when the Task first runs, fetches the selected Skill directories, and records each Skill's
source and digest. Later Task Attempts use the same pinned content if the branch changes. The
catalog must have a `SKILL.md` in each selected directory. A missing Skill or inaccessible
repository stops Workspace setup with an error naming the repository or Skill.

The Worker Host caches the selected files locally. If a later Task Attempt runs on another host,
that host fetches the pinned commit by its SHA. If the commit is no longer available upstream,
the new host cannot recover the pinned Skill. Restore the commit in the repository, run the Task
again on the original host, or start a new Task to pin the current catalog. SuperTag never
substitutes newer Skill contents for an existing Task's pin.

Public repositories need no credentials. For private repositories, configure Git access on the
Worker Host with its existing Git credential helper, `gh auth setup-git`, or a `GITHUB_TOKEN` environment
variable. Keep credentials out of the Workspace YAML. Local Workspace Skills in `spec.skills` and Context Set Skills still
work; Workspace Skills take precedence when names overlap. A name may appear in either local
`skills` or `skillCatalog.skills`, but not both.
The Worker uses a surface credential for the catalog only when the Task's **Permission Set**, its
list of allowed actions, grants
that repository. Otherwise, it uses the host's Git credential setup.

### Select repository MCP servers

An MCP server gives a Task tools from another service. A Workspace can name servers in its
repository's `.mcp.json`, such as a Sentry server for issue details. SuperTag uses only names in
`spec.mcp`; adding a server to the repository does not add it to the Workspace.

For `mcp: [sentry]`, the repository can contain:

```json
{
  "mcpServers": {
    "sentry": {
      "type": "http",
      "url": "https://sentry.example/mcp",
      "headers": { "Authorization": "Bearer ${SUPERTAG_MCP_SENTRY_TOKEN}" }
    }
  }
}
```

Set `SUPERTAG_MCP_SENTRY_TOKEN` on the Worker Host, in its environment or in `~/.supertag/.env`.
A missing variable stops the Task before the server is used.

#### Only `SUPERTAG_MCP_` variables

A repository's `.mcp.json` may reference only variables whose names start with `SUPERTAG_MCP_`.
The Worker Host's own credentials, such as `GITHUB_TOKEN`, `SUPERTAG_AUTH_KEY`, or a model API
key, are therefore out of a repository's reach. A reference to any other variable, such as
`${GITHUB_TOKEN}`, stops the Task when it starts. The message names the variable and this rule;
SuperTag never sends the literal `${GITHUB_TOKEN}` text instead. To give a repository server a
token, set it under a new name, such as `SUPERTAG_MCP_GITHUB_TOKEN`. The rule follows GitHub
Copilot's `COPILOT_MCP_` prefix. Servers a **host service**, a `host` entry that connects its machine as a Worker Host, declares in
`supertag.yaml` are trusted
and can reference any variable; see [Host MCP servers](../reference/supertag-yaml.md#host-mcp-servers).

#### stdio servers run from the base commit

A listed server can also be a stdio server, which the Worker starts on the Worker Host:

```json
{
  "mcpServers": {
    "postgres": {
      "command": "npx",
      "args": ["-y", "@acme/db-mcp"],
      "env": { "DATABASE_URL": "${SUPERTAG_MCP_DATABASE_URL}" }
    }
  }
}
```

When a Task Attempt starts, the Worker checks out the Task's base commit into a snapshot it owns.
The snapshot sits beside the Task worktree, never inside it, and outside the directories the
harness sandbox lets it write. SuperTag reads `.mcp.json` from the snapshot and starts stdio
servers there.
Edits in the Task worktree, including a harness rewriting `.mcp.json` or a server's script, never
change which command runs or what code it loads. The snapshot holds committed files only. `setup`
does not run there, and ignored files such as `node_modules/` are absent. A server that needs
dependencies should fetch them itself, as `npx -y` does, or run from an absolute path on the host.

Each `env` value must be exactly one `${SUPERTAG_MCP_*}` reference; a literal value stops the
Task. A reference in `command` or `args` stops the Task, because process arguments are visible to
other processes. The server process gets its `env` and a minimal environment: `PATH`, `HOME`,
`USER`, `LOGNAME`, `SHELL`, `TERM`, `TMPDIR`, `TZ`, and locale variables. It never inherits the
Worker's credentials. The harness never sees the command or `env`, and reaches the server only
through the policy proxy.

#### One configuration per Task

SuperTag records a digest of the selected server definitions before any server starts, even to
list its tools. The first Task Attempt's digest binds the Task. A retry whose selected entries
differ stops before starting anything. That can happen when a Task Attempt without commits lets the
retry start from a newer base commit with a changed `.mcp.json`. Start a new Task to use the
changed configuration.

Granted tools run through the Task's policy proxy, and these servers are available on any host
that can check out or clone the Workspace. Only Tasks with the Workspace get them. A conversation
turn has no Workspace, so it runs without a server only the Workspace provides; the Tag hands that
work to a work Session, which gets the Workspace. See
[MCP server placement](../reference/iam.md#placement). A selected server cannot share a name with a host
service MCP server; the Task stops with an error if the names collide. The proxy keeps header
values on the host and strips them if the server redirects to another origin. Keep secrets in
environment variables rather than in `.mcp.json`.

### MCP servers in a remote sandbox

In an E2B or Modal Workspace environment, a stdio server runs inside the Task's own sandbox, not on
the Worker Host. It runs from a copy of the trusted commit, placed beside the Task's checkout when
the environment is prepared. Edits to the checkout's `.mcp.json` or server script change nothing.
Calls still pass through the Worker's policy proxy, so grants and approvals apply unchanged. The
proxy stays on the Worker Host's loopback; a colocated harness reaches it through a relay
on the sandbox's own loopback.

The sandbox image must contain the runtimes used by its stdio servers and the MCP bridge. For
example, Modal's default `python:3.13-slim` image includes Python but no Node.js. A server declared
with `command: "node"` needs Node.js installed from trusted content during preparation. Files from
the trusted commit, including the server copy, land beside the Task checkout in the prepared image;
the Task's later changes to its checkout do not replace that copy.

The Task can read and change anything in its sandbox, including that copy and the server's
environment. So a server with any `env` entry is refused there, because every entry names a Worker
Host credential. The message names the server and the variable, such as
`Workspace MCP server postgres references host credential SUPERTAG_MCP_DATABASE_URL`. Run such a
Workspace on a local profile, or serve the server over HTTP: HTTP servers keep the policy proxy, and
their headers stay on the Worker Host. Install a stdio server's packages in `setup`, because the
Task's network policy can block `npx -y`.

SuperTag talks to a stdio server through a small Node.js program in the sandbox. So when a
Workspace selects a stdio server, the prepared image needs Node.js 18 or later. An image without
`node`, such as `python:3.13-slim`, gets it from the image's own package archive with `apt-get`,
before the repository is copied in. It installs as root, even when your devcontainer's Dockerfile
ends with `USER`, and then switches back to that user. On an image without `apt-get`, install Node.js in the image or
in `setup`. Otherwise preparation fails with
`Workspace stdio MCP servers need Node.js 18 or later in the sandbox`.

## 2. Give Worker Hosts the repository

A Worker Host serves a Workspace in one of two ways:

| Way | When to use it |
| --- | --- |
| Declare a checkout | You already have the repository on the host, such as your laptop |
| Clone the source | The host has no checkout, such as a shared build machine; the Workspace needs `source` |

SuperTag prefers a host that declares a checkout. It uses a host that clones only when no bound
host with a checkout can take the Task.

### Declare a checkout

Name the Workspace when you connect the Worklet:

```sh
supertag connect worklet --worklet-url http://127.0.0.1:3435 --worker-host laptop \
  --harness claude-code --workspace app=~/code/app
```

Repeat `--workspace NAME=PATH` for more Workspaces. The host tells the Control Plane only the
names; the paths stay on the host. An unnamed `--workspace PATH` names a folder that Tasks
without a Workspace may inspect as a copy. For the top level of a git repository, the copy holds
tracked files, untracked files that git does not ignore, and `.git`. Ignored entries such as
`node_modules/`, `.venv/`, and `.env` stay on the host. Any other folder is copied whole. The copy
keeps symbolic links whose target stays inside the folder. A copied link that points outside it
fails the Task Attempt, so a copy never exposes other files on the host.

Check which hosts declare a checkout:

```sh
supertag describe workspace app
```

### Clone the source

A host clones without any flag. The first Task for a Workspace creates a clone under
`~/.supertag/workspaces/<workspace>/clone`. Before each new Task worktree, the host fetches the
source, so every Task starts from current work. Two Tasks on the same host share the clone safely.

Git authenticates the way it does for you on that host: your SSH agent or credential helper. For
an `https://github.com/...` source, the host can use `GITHUB_TOKEN` when a **Surface Account**,
one connected GitHub account, and the Tag's Permission Sets name that repository. SuperTag hands the token to one git command
at a time; it never writes it to git configuration or remote URLs. The token is separate from
[GitHub MCP tool credentials](../surfaces/worker-tools.md#github).

A host clones only when every Worker Profile on it runs its harness in the local process
environment.

### Run in e2b or Modal sandboxes

A host service can run its Task Attempts in remote sandboxes instead of on its own machine. Set
`environment` on the host service in supertag.yaml:

```yaml
services:
  cloud:
    type: host
    control-plane: https://supertag.example.com
    harnesses: [codex]
    environment: { modal: { app: supertag-workers, image: node:22-bookworm } }
```

Such a host serves a Workspace by its `source` only, so it takes no `workspaces` paths. Its
provider prepares an environment for a trusted commit: an E2B template or a Modal image, with
`setup` run inside the provider, never on the Worker Host. Each Task gets its own sandbox from it.
A repository without a devcontainer starts from `image`. See
[Host environment](../reference/supertag-yaml.md#host-environment) for every setting.

For Claude Code and Cursor, the harness runs on the Worker Host. Only read, write, edit,
glob, grep, ls, and foreground commands run in the sandbox. Provider keys and native Session
state stay on the host; these split paths never copy model keys into sandbox files,
environment variables, or processes. The image needs `python3` and POSIX shell tools, plus
project dependencies, rather than an installed Claude Code or Cursor executable.

Write and edit need `files:write`; commands need both `commands:execute` and `files:write` in
the Task's **Permission Set**, its allowed actions. Remove `allow-unsandboxed-commands` from
services with `environment`; startup refuses that combination. See
[Built-in harness paths](shared-execution.md#built-in-harness-paths) for disabled tools,
Skills, and repository-rule limits. Codex uses app-server on the Worker Host and exec-server
in the sandbox. A host service with `environment` refuses OpenCode because its provider key
would enter the sandbox. Remove `environment` to run OpenCode locally.
The provider's own credentials, `E2B_*` and `MODAL_TOKEN_*`, stay on the Worker Host.

On the E2B Hobby plan, a sandbox lives at most one hour, so a longer Task Attempt is cut off. Use a
plan with longer sandboxes, or Modal, for long Tasks.

Check how each host serves the Workspace:

```sh
supertag describe workspace app
```

```text
Prepared environments:
  cloud (modal)   sha256:4f1c0e2a  trusted 1a2b3c4  2h ago
  laptop (local)  per Task
```

A local host prepares one worktree per Task. A row with `refuses:` names why that host's provider
cannot take the Workspace's Tasks. `supertag describe task ID` shows the environment a Task
Attempt used, such as `Environment: modal, prepared sha256:4f1c0e2a, trusted commit 1a2b3c4`.

## 3. Name the Workspace on an Objective

```sh
supertag create objective faster-search --owner lead \
  --outcome 'Search returns results in under 200 ms. Done when the benchmark passes.' \
  --workspace app
```

The Objective gets the runtime actions the owner's Roles allow, such as `files:write`. Add
`--runtime-action` options only to narrow them.

Repeat `--workspace` to name several. SuperTag rejects names that no Workspace defines. Creating
the Objective also starts the owner; see
[Coordinate Tasks toward an Objective](objective-coordination.md#start-the-owner).

Which Workspace a Task uses:

- The owner's first Task uses the Objective's first Workspace.
- With exactly one Workspace, every Task uses it.
- With several, a lead chooses one per Task with `assign_task`'s `workspace` field. A Task without
  a choice gets no Workspace.
- A Task that handles a message, such as one an operator sends with `supertag message objective`,
  uses the recipient's previous Workspace in the Objective, else the Objective's only Workspace. It
  gets its own worktree like any other Task.

The choice, the base `ref`, and the Task branch are recorded when SuperTag accepts the Task. A
retry or continuation of the same Task reuses the same branch.

## Start from Slack or GitHub

People can also create an Objective from a conversation, with `@SuperTag objective <outcome>`. The
Objective gets its Workspaces from where the Tag was mentioned, the way GitHub's Slack app links a
channel to a repository. Nobody types a Workspace name in the message.

### Slack, Lark, Teams, and Linear

List Workspaces on the Tag's location, then apply the manifest:

```yaml
apiVersion: supertag/v1
kind: Tag
metadata:
  name: lead
spec:
  locations:
    - provider: slack
      channelId: C0123456789
      workspaces: [app]
```

```sh
supertag apply -f lead.yaml
```

Now this message in that channel creates an Objective that names `app`:

> @SuperTag objective Search returns results in under 200 ms. Done when the benchmark passes.

`supertag apply` rejects a Workspace that does not exist. `supertag describe tag lead` shows each
location with the Workspaces its Objectives get. A location without `workspaces` creates
Objectives without one. `supertag update tag --add-location` cannot set `workspaces`; use a
manifest.

### GitHub

A GitHub location needs no list. An Objective created from an issue or pull request gets every
Workspace whose `source` is that repository. These sources all match `acme/app`, in any letter case:

```text
https://github.com/acme/app
https://github.com/acme/app.git
git@github.com:acme/app.git
ssh://git@github.com/acme/app
```

To choose different Workspaces, list `workspaces` on the GitHub location; the list then wins.

### What the Tag may change

The Tag that creates the Objective may name fewer of those Workspaces with `create_objective`'s
`workspaces` argument. It cannot add one the location does not attach; SuperTag returns an error
naming the allowed Workspaces. The Tag receives creation warnings, such as no bound Worker Host
with a checkout of `app`, and can tell the person in the thread.

## 4. See the branches appear

A Task that names a Workspace runs only on a bound Worker Host that declares a checkout of it, or
that can clone its `source`. A host that declares a checkout of `app` carries the label
`workspace:app`. Until a suitable host connects, the Task waits, and `supertag describe task ID`
explains why:

```text
Unmet requirements: workspace.checkout-or-clone:app
No connected Worker Host bound to this Tag declares a checkout of Workspace app or can clone its source.
```

A Workspace without `source` reports `labels:workspace:app` instead, because only a declared
checkout can serve it. The Task also needs any labels in its Tag's `runsOn`. See
[Worker Host labels](../reference/resource-model.md#worker-host-labels).

As Tasks finish, list their branches in your checkout. Task Attempts that made no commits, such as
reviews, leave no branch.

```sh
git -C ~/code/app branch --list 'supertag/*'
git -C ~/code/app log --oneline main..supertag/faster-search/TASK_ID
```

Each commit is authored by `SuperTag <supertag@localhost>` and names its Task and Task Attempt.
`supertag describe task ID` shows the Task's Workspace and branch. `supertag events task ID` shows
the base commit, head commit, and number of changed files for each Task Attempt. The Task result,
which leads read with `read_task`, names the branch and its head commit. Review a branch, then
merge it yourself. On a host that clones, the branches live in its clone; use `pull-request`
delivery to get them back to your repository.

## Build on another Task's work

A Task often continues where another Task stopped. For example, a lead accepts `add-export`, then
asks for `document-export`, which needs the new export code. To say "build on `add-export`", make
it a dependency, not a line in the instruction:

```json
{ "taskId": "document-export", "dependencies": ["add-export"], "instruction": "Document the export command" }
```

`document-export` runs only after `add-export` is accepted. Before its harness starts, the Worker
starts its Task branch from the Workspace base merged with the branch `add-export` delivered. The
harness never runs `git merge`. This matters for Codex, whose sandbox cannot write the repository's
shared git directory.

- Each accepted dependency in the same Workspace is merged, in the order the dependencies are
  listed. The Worker merges the head commit recorded for the accepted Task Attempt.
- A dependency that delivered no commits, such as a review, passes on its own dependencies'
  branches.
- A dependency branch the base already contains is skipped. When a branch already contains the
  base, the Task branch starts at its head without a merge commit.
- The Task measures its own changes from the merge. Its patch, changed-file count, and review
  cover only its own work.
- Each dependency's commits are ancestors of the new branch, so
  `git merge-base --is-ancestor DEPENDENCY_HEAD TASK_HEAD` confirms that a change includes it.
- A merge conflict fails the Task Attempt before its harness starts, with `failureKind:
  "workspace-setup"`. The error names the dependency and the conflicting paths, for example
  `conflicts in README.md, src/export.ts`. Resolve the conflict on one dependency's branch, or
  assign the Task without one of them.
- With `branch` delivery, a dependency's commit stays on the Worker Host that ran it. A host that
  clones fetches the commit from the source when the source has it, for example from a pull
  request. Otherwise the Task Attempt fails before its harness starts and says what to do: push
  the dependency's branch to the source, or run the Task on the dependency's Worker Host.
- A review keeps starting at the exact submitted commit it reviews; dependencies are not merged
  into it.

A fix round works the same way. Once the reviewed Task is accepted, make the fix Task depend on it.
The fix then starts from the reviewed change.

## Deliver pull requests

With `delivery: pull-request`, each Task gets one GitHub pull request, the way dependency update
bots work. The Workspace `source` must be a GitHub repository, such as
`https://github.com/acme/app.git` or `git@github.com:acme/app.git`. `supertag apply` rejects other
sources.

```yaml
apiVersion: supertag/v1
kind: Workspace
metadata:
  name: app
spec:
  source: https://github.com/acme/app.git
  delivery: pull-request
```

The pull request follows the Task:

| Task event | Pull request |
| --- | --- |
| First Task Attempt that completes with commits | The Worker pushes `supertag/<objective>/<task>` and opens a **draft** into `ref`, or the repository's default branch |
| A later Task Attempt of the same Task | The Worker pushes to the same branch and updates the same pull request |
| The lead accepts the Task | The Control Plane marks the pull request **ready for review** |
| The Task is cancelled, or its result is rejected | The Control Plane comments and **closes** the pull request |
| The Objective is cancelled | Each open Task is cancelled, so its pull request closes |

The title comes from the Task Attempt's summary; the body adds its evidence and names the
Objective and Task. SuperTag never merges. A pull request that someone closes on GitHub stays
closed; later Task Attempts do not reopen it or push to it.

If GitHub is unreachable, returns a server error, or rate-limits the Control Plane, SuperTag
retries marking the pull request ready or closing it. The first retry comes after 1 minute, and the
wait doubles up to 1 hour, for at most 10 attempts. A retry that finds the pull request already
ready or closed counts as done. SuperTag does not retry a pull request that no longer exists or a
permission denial, because waiting will not fix them.

Pull-request delivery needs three things:

1. The Tag's Permission Sets grant `pull-requests:create` on the repository. Without it, the
   Worker does not push, and the Task result says why.
2. The Worker Host has a `GITHUB_TOKEN` restricted by GitHub to that repository. This is
   separate from the [MCP preset credential](../surfaces/worker-tools.md#github).
3. The Control Plane has the same GitHub Surface Account, which it uses to mark pull requests
   ready and close them.

To have a person approve before any code leaves the host, add `approval: required` to the
`pull-requests:create` permission:

```yaml
    - target: surface
      surfaceAccountId: SURFACE_ACCOUNT_ID
      scope: repository:123456
      reference: acme/app
      action: pull-requests:create
      approval: required
```

The Worker then asks for approval before it opens the pull request, and waits up to ten minutes
for a decision. Approve with `supertag approve request ID`. If nobody decides in time, or the
request is denied, nothing is pushed, and the Task result records why. A later Task Attempt of
the same Task opens the pull request once the request is approved. Pushes that update an open
pull request do not ask again. See [Approval](../reference/iam.md#approval).

`supertag describe task ID` shows the pull request and its state:

```text
Pull request: acme/app#42 (draft) https://github.com/acme/app/pull/42
```

When a ready or close step failed, it also shows the error and when SuperTag retries:

```text
Pull request update failed: GitHub pull request close failed with HTTP 503 (retrying at 2027-03-02T10:04:00.000Z)
```

`(not retrying)` means the failure was permanent or the retries ran out. Finish that step on
GitHub.

## Where files live

| Item | Location |
| --- | --- |
| Task worktree | `~/.supertag/workspaces/<workspace>/worktrees/<task>` |
| Host-managed clone | `~/.supertag/workspaces/<workspace>/clone`, on hosts without a checkout |
| Task branch | Your checkout's repository or the host's clone, `supertag/<objective>/<task>` |
| Patch (`patch` delivery) | An artifact on the Task result |
| Pull request (`pull-request` delivery) | GitHub, from the pushed Task branch |

The Worker keeps a Task's worktree while the Task can still be retried. It removes the worktree
after a Task Attempt completes and keeps the branch. A later Task Attempt of the same Task recreates the
worktree: it runs `setup` again on the base commit, then checks out that branch. The branch holds
AI-authored commits, so its package scripts and lockfile changes never run on the Worker Host. A
kept worktree is reused without running `setup` again. A Task Attempt that made no commits, such as a
review, leaves no branch whatever its outcome: the Worker deletes the empty branch with the
worktree, the Task result names no branch, and a retry starts afresh from the base.

The Worker commits every change to a tracked file and every untracked file that git does not
ignore, except well-known generated paths that are never source: `__pycache__/`, `*.pyc`, `*.pyo`,
`.pytest_cache/`, `.mypy_cache/`, `.ruff_cache/`, `.tox/`, `.venv/`, `*.egg-info/`, `.coverage`,
`.coverage.*`, `htmlcov/`, `node_modules/`, `.next/`, and `.DS_Store`, at any depth. A symlink
with one of these directory names, such as a shared `.venv`, is left out too. A repository
without a `.gitignore` therefore gets no test caches or installed packages on its Task branch. The
list only skips untracked files: a file already committed under one of these paths, such as a
vendored `node_modules/vendor.js`, is committed when a Task changes it. The list also wins over a
`.gitignore` negation such as `!keep.pyc`; commit such a file yourself to track it. `dist/` and
`build/` are not on the list, because some repositories commit them; ignore them in `.gitignore`
when yours does not.

Files on a remote sandbox or ephemeral Worker Host are lost when it stops. See
[What survives when a sandbox or host dies](../concepts/persistence.md).

## Current limits

This release supports Worker Hosts with a local git checkout or a clone of the source, and Worker
Profiles that run their harness in the local process environment.

- **Git repositories only.** A Worklet refuses to declare a folder that is not a git repository.
- **Local process environment only.** Shared execution, Docker, E2B, and Modal profiles cannot use
  a checkout yet. A host that also runs a local profile still advertises its Workspaces, and
  SuperTag places their Tasks on the local profile. A host with no local profile advertises none,
  so their Tasks wait instead of running elsewhere. A Worker built with the SDK can register E2B
  or Modal Workspace environments, which serve a Workspace from its source, not a declared
  checkout; see [Remote Workspace environments](../reference/worker.md#remote-workspace-environments).
- **GitHub pull requests only.** `pull-request` delivery supports sources on github.com. One pull
  request covers one Task; grouping several Tasks into one pull request is not available yet.
- **Git commands inside the worktree are not policed yet.** The Worker pushes only the Task branch,
  and only for `pull-request` delivery. It never resets your working tree or changes your current
  branch. The Tag can still run git itself inside its
  worktree. The worktree shares `.git` with your checkout, so a command such as `git push` or a
  branch deletion affects your repository. Grant `commands:execute` only to Tags you trust with
  that.
- **Worker git commands skip hooks.** Worker commits use `--no-verify`, so a failing pre-commit
  hook never loses work. No Worker git command runs a hook, including one under a relative
  `core.hooksPath` such as husky's `.husky`, because the Task can edit those files. Run your checks
  before you merge.
- **Setup runs your base commit's code on the Worker Host.** Package install scripts at the base
  commit run with the Worker Host user's filesystem access, before the harness sandbox starts. The
  setup process does not inherit provider credentials through its environment by default. Tools
  that write to `/tmp` directly, ignoring `TMPDIR`, still share it with Tasks. Use a low privilege
  Worker Host for repositories you do not trust.
- **Worker git commands ignore your global git config.** Checkout, `git add`, `git commit`, and
  the Worker's other worktree commands use only the repository's own config, so a Task's
  `.gitattributes` cannot select a filter driver you configured globally. The one exception is
  `lfs`, taken from your config by name when git-lfs is installed. Worker checkouts leave Git LFS
  pointers; run `git lfs pull` in `setup` or in the Task. A global `core.excludesFile` does not
  apply to Worker commits. Fetch and push keep your global config for credential helpers.
- **A changed repository config stops the Task Attempt.** The Worker records the repository's
  local git config, the worktree's config, and `info/attributes` when a Task Attempt starts. If
  they change, for example because the Task added a filter driver, the Worker runs no further git
  command for the Task and leaves its worktree as it is. The Task fails with `failureKind:
  "workspace-integrity"` and appears under `supertag list inbox --kind task-attention`. Inspect the
  repository config before retrying. A Task running `git push -u` or `git remote add` fails the
  same way.
- **Only Codex sandboxes the commands it runs.** Its sandbox cannot write the repository's shared
  git directory. Claude Code, Cursor, and OpenCode run commands as the Worker Host user, so none of the
  protections above stop them. Give them `commands:execute` only for trusted Tags, or use a low
  privilege Worker Host.

See [Workspace staging](../reference/worker.md#workspace-staging) and
[Workspace git safety](../reference/worker.md#workspace-git-safety) for the Worker contract.
