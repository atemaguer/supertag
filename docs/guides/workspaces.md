# Work in a repository with Workspaces

A **Tag** is a persistent AI actor with its own responsibilities and permissions. An
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

Each local Task gets its own git worktree on the branch of its **Session**, one Tag's thread of
Tasks: `supertag/session/<id>`. Every Task of the Session commits to that one branch; see
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
| `pull-request` | The Worker pushes the Session's branch to the GitHub `source` and opens one draft pull request per Session. See [Deliver pull requests](#deliver-pull-requests). |

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
  ref: main                               # base for Session branches
  setup: npm ci                           # optional; runs on the base commit of each new worktree
  mcp: [sentry]                           # optional; selected servers from .mcp.json
  skills: [docs-conventions]              # optional; Skills from the host checkout
  delivery: branch                        # branch, patch, or pull-request
```

```sh
supertag apply -f workspace.yaml
```

Every field is optional for a workspace without mounts. A workspace with mounts needs a git
`source`. Without `ref`, Session branches start from the checkout's current branch, or
from the source's default branch in a clone, else `main`. `source` must not contain credentials;
each Worker Host supplies its own. Tags work in Teams: flat lists of member Tags. Together, your Teams of Tags
make up an **autonomous organization**: Teams may pursue different Objectives but share one
Control Plane, its rules, and its record of the work. A Workspace can live in the same input as
the rest of your organization; `supertag apply -f` applies Workspaces first.

<!-- supertag-cli: native start -->

### Attach data outside the repository

A Workspace Volume copy places a Volume's files at an absolute path outside the Task's git
checkout. For example, an analysis Task can read a dataset at `/srv/supertag-mounts/datasets`
without committing it to git. Three parties agree on each copy:

1. The operator registers the Volume with the Control Plane. A source is a canonical
   `file:///ABSOLUTE/PATH` or an `s3://BUCKET/PREFIX` with a credential name. The name is a label,
   never a secret:

   ```bash
   supertag workspace-volume put datasets --source file:///srv/data/datasets
   supertag workspace-volume put reports --source s3://acme-data/reports --credential team-data
   ```

2. Each Worker Host owner maps the Volume with `supertag worker-host --workspace-mount-mappings FILE`.
   The mapping names the same source, the private directory copies land in, and, for `s3://`, the
   endpoint, region, and the environment variables that hold the keys. Only the host owner chooses
   the endpoint, so a host's keys never sign a request to a server someone else picked:

   ```json
   [
     { "volumeId": "datasets", "source": "file:///srv/data/datasets",
       "destinationRoot": "/srv/supertag-mounts" },
     { "volumeId": "reports", "source": "s3://acme-data/reports", "credential": "team-data",
       "endpoint": "https://s3.eu-west-2.amazonaws.com", "region": "eu-west-2",
       "credentialEnvPrefix": "REPORTS", "destinationRoot": "/srv/supertag-mounts" }
   ]
   ```

   The host reads `REPORTS_ACCESS_KEY_ID`, `REPORTS_SECRET_ACCESS_KEY`, and optionally
   `REPORTS_SESSION_TOKEN` from its own environment. `destinationRoot` must be an existing,
   owner-only directory.

3. The Tag declares its copies with `supertag tag put TAG --workspace-mounts FILE`:

   ```json
   [
     { "volumeId": "datasets", "destination": "/srv/supertag-mounts/datasets" },
     { "volumeId": "reports", "destination": "/srv/supertag-mounts/reports",
       "maxBytes": 5368709120, "access": "read-write" }
   ]
   ```

Each destination sits directly in a mapped `destinationRoot`. `maxBytes` defaults to 1 GiB and may
be at most 20 GiB. `access` defaults to `read-only`. A `read-write` copy requires the Tag's
`files:write` action. Copies require `files:read`, and a Tag with copies may not run commands or
fetch from the web, so its harness reaches only the checkout and its copies. Codex, Claude Code,
Cursor, and OpenCode Tasks take copies. The Control Plane freezes each Volume's revision when it
accepts the Task, and only a Worker Host that maps that exact Volume and credential name claims it.
`supertag get workspace-volume datasets` shows the registered source and revision.

### What a copy does

Each Task Attempt gets its own fresh copy. The Worker Host makes it after it prepares the checkout,
so `setup` never sees the data, and no prepared environment, such as a Modal image or an E2B
template, contains it.

1. The Worker Host stages the copy under a random name in `destinationRoot`, with the Volume's
   credential, which never leaves the Worker Host process. The Task and its harness receive file
   contents only.
2. It stops and refuses the Task Attempt when a copy passes its `maxBytes`, when one Task Attempt's
   copies together pass 20 GiB, or when a copy holds more than 10,000 files or 40,000 entries. An
   `s3://` listing is checked before any download.
3. It refuses symbolic links, files with another hard link, files on another filesystem, and the
   names `.git` and `.supertag-*`. A file that changes while it is copied fails the Task Attempt.
4. It renames the finished copy to its destination without replacing anything there. A read-only
   copy has write permission removed; a read-write copy stays writable.

Files stream through fixed-size buffers, so a 20 GiB copy needs no more memory than a small one.
The Worker Host journals each copy, so a restarted host removes what an interrupted Task Attempt
left. Copies are removed when the Task Attempt ends.

### Copies in a remote Workspace

A Cursor Worker Host with an E2B or Modal Workspace stages each copy on the host first, exactly as
above. It then uploads only the copy's files into the sandbox, at
`volumes/<digest>/<name>` inside the checkout, and tells the Task those paths. The Volume
credential and the Volume's location never reach the sandbox or the provider. A read-only copy is
sealed in the sandbox, and the file tools refuse writes there. Copies never return in the
Workspace delivery. After a successful Task Attempt, the Worker Host lists each read-write copy in
the sandbox and brings back only changed and created files, which it then writes back as below.

Remote copies need `python3` in the sandbox image. An upload or capture waits one second per MiB
beyond its base timeout, and the sandbox lifetime still bounds the Task Attempt.

Read-only provider-native Modal Volume mounts are on the backlog. Today every Volume reaches a
Task as a copy.

### Save changes to a Volume

Set `"access": "read-write"` when a Task must save generated files beside its input data. For
example, a Task can read `/srv/supertag-mounts/reports/rows.csv` and write `results.csv` next to it.
After a successful Task Attempt, the Worker Host writes each changed and created regular file
directly to the Volume: a `file://` file is written without following links and renamed into
place, and an `s3://` object is streamed with a signed `PUT`. Deletions and links are not written.
A failed or cancelled Task Attempt writes nothing.

Before any write, SuperTag checks the whole change set. Each copy writes at most 1,000 files, one
file may be at most 5 GiB, and all changed files together must fit the copy's `maxBytes`. A change
set over a bound, or a copy holding a name the Volume cannot hold, is `refused` and nothing is
written. Writing stops at the first failure and is `partial`. Either fails the Task. The Worker
Host journals each summary before reporting it, so a restarted host never writes twice.

`supertag describe task ID` shows the summary for each Task Attempt: the Volume, status
(`complete`, `partial`, or `refused`), the written files (key, size, SHA-256), skipped files, any
error, and files not attempted.

### Keep artifact storage separate

A Workspace Volume must stay outside artifact storage, where saved outputs live. The Control Plane
refuses a Workspace Volume at, inside, or around an artifact Volume, by path and by S3 bucket and
prefix. The Worker Host checks its mappings again against its own state, its Workspaces, and the
artifact paths the Control Plane discloses for the Task Attempt, including filesystem aliases. Use
[artifact inputs](../reference/artifacts.md) to give a Task access to selected saved outputs.

### Local copies

A local copy is still a copy, even of a `file://` Volume on the same disk. Read-only is protection
against accidents, not a security boundary, for a harness that runs without a sandbox. Two Task
Attempts never share a destination: the second is refused while the first copy exists.

<!-- supertag-cli: native end -->

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
the Objective also starts it; see
[Define and complete an Objective](objectives.md#1-create-the-objective).

Which Workspace a turn uses:

- With exactly one Workspace, every turn of the Objective uses it, including its own conversation.
- With several, the Objective's conversation gets no Workspace, and the owner names one when it
  starts each Session. A Session without a name gets no Workspace.
- A Session keeps the Workspace it started with for all of its turns.

The choice, the base `ref`, and the branch are recorded when SuperTag opens the Task. A retry of
the same Task reuses the same branch.

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
git -C ~/code/app branch --list 'supertag/session/*'
git -C ~/code/app log --oneline main..supertag/session/SESSION_ID
```

Each commit is authored by `SuperTag <supertag@localhost>` and names its Task and Task Attempt.
`supertag describe task ID` shows the Task's Workspace and branch, and
`supertag describe objective ID` lists each Session's branch under **Delivered**.
`supertag events task ID` shows the base commit, head commit, and number of changed files for each
Task Attempt. A Session's report names its branch and head commit. Review a branch, then
merge it yourself. On a host that clones, the branches live in its clone; use `pull-request`
delivery to get them back to your repository.

## Build on earlier work in the same Session

A Session's work accumulates on its one branch. When the Tag that started a Session continues it
with fixes or a follow-up, the next Task checks out the same branch, such as
`supertag/session/0f3c2a9e`, at the Session's latest commit, and commits on top of it.

- The branch holds the whole Session's work, so its patch, changed-file count, and pull request
  cover every Task of the Session, measured from where the branch left the Workspace `ref`.
- A Task that delivered no commits, such as one that only asked a question, leaves the branch
  where it was. When no Task has committed yet, the next one starts the branch from `ref`.
- Commits added on top of the branch since, such as a reviewer's fixup pushed to the pull
  request, are part of it: the next Task starts from them. So is a local commit whose push failed.
- If the branch was rewritten so it no longer contains the Session's last commit, the next Task
  Attempt fails with `failureKind: "workspace-setup"` rather than start over. Restore the branch,
  then retry.
- With `branch` or `patch` delivery the branch stays on the Worker Host that committed it. A later
  Task placed on another Worker Host that lacks the branch fails the same way; bind the Tag to one
  Worker Host for that Workspace, or use `pull-request` delivery.
- If a branch with that name already exists and SuperTag did not create it for this Session, the
  Worker leaves it alone and gives the Session a name with a short suffix, such as
  `supertag/session/0f3c2a9e-1a2b3c4d`. The report names it, and later Tasks keep it.
- Keep the Session's branch checked out nowhere else while the Session works. A Task Attempt whose
  branch is checked out in your checkout, or in a worktree with uncommitted changes, fails with
  `failureKind: "workspace-setup"` before its harness starts.

To build on work another Tag did, start a new Session with an instruction that names the branch to
start from, or merge that branch yourself first. Sessions do not merge each other's branches.

## Deliver pull requests

With `delivery: pull-request`, each Session gets one GitHub pull request on its branch, the way
dependency update bots work. The Workspace `source` must be a GitHub repository, such as
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

The pull request follows the Session's Tasks:

| Task event | Pull request |
| --- | --- |
| First Task Attempt that completes with commits | The Worker pushes `supertag/session/<id>` and opens a **draft** into `ref`, or the repository's default branch |
| A later Task Attempt, or a later Task of the Session | The Worker pushes to the same branch and updates the same pull request |
| A Task that pushed completes, waiting on nothing | The Control Plane marks the pull request **ready for review** |
| A Task that pushed is cancelled | The Control Plane comments and **closes** the pull request, unless an earlier Task of the Session delivered to it |
| A person merges the pull request | Later deliveries hold and keep the commits on the Worker Host |
| The Objective is cancelled | Each open Task is cancelled, so its pull request closes |

The title comes from the Task Attempt's summary; the body adds its evidence and names the
Objective and Task. SuperTag never merges. A pull request that someone closes on GitHub without
merging stays closed; later Task Attempts do not reopen it or push to it. Reopen it on GitHub for
the Session's later Tasks to update it.

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
| Session branch | Your checkout's repository or the host's clone, `supertag/session/<id>` |
| Patch (`patch` delivery) | An artifact on the Task result |
| Pull request (`pull-request` delivery) | GitHub, from the pushed Session branch |

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
  request covers one Session's branch; grouping several Sessions into one pull request is not
  available yet.
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
