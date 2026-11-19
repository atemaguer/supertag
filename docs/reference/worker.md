# Worker Host reference

The exact behavior of a **Worker Host**'s **Worklet**, the `supertag worker-host` program that
connects a machine or sandbox to the **Control Plane** and runs **Task Attempts**, and of the
**Workers** it starts: a **harness adapter** and its harness for each Task Attempt. Below, "the
host" means the Worklet acting for its Worker Host. For the ideas, read
[Worker Hosts, Worklets, Workers, and harnesses](../concepts/workers.md); to run one, read
[Run Worker Hosts](../guides/workers.md). Other terms are in the [glossary](glossary.md).

## Boundary

| The Worklet owns, on its Worker Host | The Control Plane owns |
| --- | --- |
| Harness sign-ins, MCP credentials, network credentials, and Volume keys on this machine | Tags, policy, admission, and the accepted Task |
| Workspace checkouts and the Task Attempt's files | Scheduling, leases, and recovery decisions |
| The execution journal and captured artifact bytes | The artifact catalog, events, results, and audit |
| Starting and supervising Workers, which supervise the adapter processes | Which hosts may run which Tags |

A Worklet never receives the database credential, a Gateway's surface credentials, or another
host's credential. A Worker's own calls never carry the host's credential. A harness adapter receives only
its own harness's provider credentials and a bootstrap token scoped to one Task Attempt.

## Enrollment and credentials

A host enrolls once, with a host Auth Key, under a name that is never reused: `host:NAME`. It
keeps its credential in its state directory. A reusable key that finds the name taken enrolls the
host as `NAME-2`, `NAME-3`, and so on. A key created with `--ephemeral` removes its hosts once they
go offline, and their running Task Attempts return to the queue. `host rotate-credential` replaces
the credential; `host revoke` refuses it at once.

The Worklet alone holds the host credential, `host:NAME`. With it, the Worklet registers the host,
claims Tasks, starts, renews, reclaims, and finishes Task Attempts, and moves checkpoints,
deliveries, Volume objects, and artifacts between hosts. A Worker is a separate process that never
receives the host credential. When its Task Attempt needs a call only the host may make, such as a
Volume object grant or a git access token, the Worker asks its Worklet over their
[local channel](#the-local-channel), and the Worklet makes the call only for that Worker's own Task
Attempt.

When the Control Plane starts a Task Attempt, it returns a Task Attempt credential bound to that
Task Attempt, its lease, and the host's current registration. The Worker's calls carry only this
credential:

| A Task Attempt credential may | It may not |
| --- | --- |
| Record the Task Attempt's events, streamed text, usage, milestones, and network log | Claim, start, renew, reclaim, or finish any Task Attempt |
| Ask a question and take live input | Read or write another Task Attempt's data |
| Read the Task Attempt's history, capabilities, and Context Item pins | Register the host or move checkpoints and deliveries |
| Use the Task Attempt's Mailbox, Workstreams, work Sessions, Schedules, notes, MCP effects, Workspace Volumes, and artifacts | Work after the lease ends, other than a cancelled Task Attempt's last reports |

Renewing the lease extends the credential. Finishing or reclaiming the Task Attempt, a lapsed
lease, revoking the host, or a new registration of the host ends it. Cancelling the Task ends its
data calls, but the Task Attempt's usage, milestones, and network log are still recorded until
the Worklet reports that its execution stopped. A Worklet that starts the
same Task Attempt again after a restart receives a new credential, and the old one stops working.
The Worklet passes the credential to the Worker in its assignment and keeps no copy, in memory or
in its journal. The Worker records the Task Attempt's captures and writes back its Workspace
Volume copies before it hands over its outcome, so the Worklet never needs the credential. The
Worklet records that the Task Attempt is finalizing before the Worker starts them. A Worker that
stops before it finishes them, or a Worklet restarted meanwhile, leaves them to a new Worker,
which the Worklet starts for them with a new credential. After three such Workers die, the Task
Attempt fails.

## Data endpoint

A Gateway can carry a Task Attempt's data calls to the Control Plane. It forwards only calls a
Task Attempt credential may make, and passes the credential through unchanged. It never forwards
the host credential's calls. When the deployment names such a Gateway, `RegisterHost` returns
its URL as the data endpoint; see [Control Plane API](control-plane-api.md#authenticate).

| Connection | From | To |
| --- | --- | --- |
| Registration, claims, leases, finishing, checkpoints, and other host calls | The Worklet, with the host credential | The Control Plane |
| The Task Attempt's data calls: events, text, questions, usage, network log, history, Context Item pins, and the `Attempt…` services | The Worker, with the Task Attempt credential | The data endpoint: the named Gateway, or the Control Plane when none is named |
| The few host calls a Task Attempt needs | The Worker | Its Worklet, over their local channel |

Under `supertag up`, the data endpoint is the local Gateway. The Worklet passes the data endpoint
of its latest registration to each Worker it starts. The Worker dials it with the host's own
transport settings: the same URL rules, TLS trust, client certificate, and proxy. It has no
connection to the Control Plane and no fallback to it.

When the data endpoint is unreachable, each data call fails with `the data endpoint URL is
unreachable: REASON` and is retried, as calls to an unreachable Control Plane are. The Worker
logs `a data call will be retried` with that reason once per call, and keeps retrying while the
Task Attempt's lease lasts. A Worker whose calls before launch keep failing hands its Task
Attempt back to the Worklet, which starts the next Worker after a wait that doubles from one second
up to 30 seconds. A data endpoint the Worker cannot dial at all, such as a cleartext
`http://` URL outside loopback, stops the Worker with `the data endpoint URL is not usable:
REASON`. After three Workers stop that way before launching the harness, the Task Attempt fails.

## Placement

A host reports its harnesses, its models per harness, its labels, its concurrency, and its
Workspace mappings. The Control Plane offers a Task only to a host that:

- may run the Task's Tag, from its Auth Key's `--tag` list or `--all-tags`, or because it is a
  host in the same `supertag.yaml` as its local Control Plane;
- carries every label in the Tag's `runsOn`;
- serves the Task's harness and model, and the limits the Task requires;
- maps the Tag's Workspace, and any Workspace Volume the Task copies;
- is ready and not draining.

`supertag placement explain TASK_ID` reports which of these keeps a Task queued.

## Claims and leases

A host claims a Task and holds a lease on its Task Attempt, renewed while the Task Attempt runs. The
lease is fenced by the Task Attempt's generation: a host that lost its lease cannot record events,
results, or deliveries for it. A Task Attempt may run for `--attempt-timeout-seconds`, 3600 by
default and at most 86400; a host whose Workspace runs in an E2B or Modal sandbox accepts at most
3600 and stops the harness early enough to leave time for capture and cleanup.

## The execution journal

Before each step with an effect outside the host, the Worklet records it in its journal: claiming,
starting, preparing inputs, executing, finalizing, finishing, and the final cleanup. A Worker
reports the steps it reaches, and the Worklet records each one before the Worker goes on. A
restarted Worklet reads the journal and finishes or reports what it started, without running a
step twice.

The journal keeps one entry for each slot of the Worklet's pool, beside that slot's checkouts:

```text
STATE_DIRECTORY/
  enrollment.json, incarnation, host.lock   the host's identity and the Worklet's lock
  artifacts/                                artifacts and Workspace deliveries this host holds
  slots/codex-0/                            one slot: one Task Attempt of one harness at a time
    attempt.json                            the journal entry; claim.json while a claim is held
    attempt-processes/, checkpoint.bin      what recovery reads: processes, staged checkpoint
    workspaces/                             the slot's checkouts
```

A host service whose harness was removed leaves its slots stranded. The Worklet moves them to
`STATE_DIRECTORY/retired/` and registers a new incarnation, which fences their Task Attempts.

When a Worker dies while its harness runs, or a Worklet restarts after it was killed then, the
Worklet checks the processes recorded for the interrupted Task Attempt, the Worker's own included. When every one is gone, it
records the Task Attempt as failed with an unknown outcome and does not run it again. Otherwise, and always for a Task Attempt that used a remote sandbox or
shared execution, it waits for `supertag task resolve-attempt`. With `--wait-for-recovery`, the
host stays connected while it waits. See [Scheduling and interrupted execution](scheduling-and-recovery.md).

## Process supervision

The Worklet runs each Task Attempt in a Worker, a `supertag` process of its own in its own process
group. It runs up to `--concurrency` Workers of each harness at once, 1 by default; `supertag up`
sets it from the host service's `concurrency` and changes it without a restart. A lowered size
takes effect as running Task Attempts finish. Background work that belongs to the host, such as
presence, landings, cleanup, and the artifact transfer listener, runs once, in the Worklet.

A Worker is never given the host credential, in its environment, its arguments, or any message.
That is not a boundary within one OS user: the state directory's enrollment holds the credential,
and on macOS `ps eww` shows the environment the Worklet started with, so a harness command that
runs outside its sandbox as that user can read it. The harness's sandbox, or another OS user,
keeps it out. The Worker hides any value shaped like an enrolled credential, in any of its
encodings, from what the harness sends upstream.

A Worker exits when its Worklet does. The Worklet cancels a Worker that is still running 30
minutes past its harness's time limit, 2 minutes after its lease ended, or 5 minutes after it
handed over its outcome, or that does not stop when asked, and kills its process group 10
seconds later. A Worker writes its log lines to its Worklet's standard error, so they appear in
the host's log.

The Worker starts each adapter in its own process group and stops the group when the Task Attempt
is cancelled, times out, or ends. On Linux it is a child subreaper, so processes that leave the
adapter's group are still found and stopped. On macOS it finds such processes with a scan every
100 milliseconds; a process that detaches with a double fork within one scan interval can escape.
Use an isolated Linux host, container, or VM when that matters. Work started through an
already-running daemon, such as a tmux server or `ssh localhost`, also escapes supervision.

### What a Worker holds

| A Worker holds, for its one Task Attempt | Only the Worklet holds |
| --- | --- |
| The Task Attempt credential | The host credential |
| Its harness's provider credentials, and the network credentials its Task's network scope names | The journal, the claims, and every lease |
| The adapter's bootstrap token, its egress and provider proxies, and its MCP servers | Host-wide work: presence, landings, cleanup, and the artifact transfer listener |
| Its scratch directory and the checkout its Worklet prepared | The host's other checkouts, and the checkpoints and deliveries it holds |

### The local channel

A Worker inherits one end of a socket pair from its Worklet as file descriptor 3. The channel
has no name in the filesystem or on the network, so nothing else can connect to it. A Worker
inherits no other descriptor, such as another Worker's channel, and nothing it starts inherits
its own. It is also the Worker's lifeline: when the Worklet dies, the Worker reads end-of-file,
stops its harness, and exits.

| Direction | Messages |
| --- | --- |
| Worklet to Worker | The assignment (the started Task, its prepared checkout, its Session checkpoint, its Task Attempt credential, and the secrets it may use), cancel, drain, lease renewed or lost, and replies |
| Worker to Worklet | Its state (starting, executing, finalizing), the journal steps it reaches, its outcome, and requests for host calls |

The Worklet records each step and the outcome in its journal before it answers, and the Worker
does not go on until it has. The checkout a step names is the one the Worklet assigned, and the
delivery check applies the started Task's path scope; the Worker names neither. A host call
names the Task Attempt it is for, and the Worklet refuses one that names another. After the Worker exits, the Worklet lands any Workspace delivery and
finishes the Task Attempt.

## Execution limits

A Task may require limits. A Task whose Tag's harness cannot enforce a requested limit is refused
when it is submitted. Cursor, OpenCode, and OpenAI Agents enforce none. A Task of a Tag with no
fixed harness waits for a host whose harness enforces its limits, and `supertag placement explain`
names them.

| Limit | Set with | Enforced by |
| --- | --- | --- |
| Reported tokens | `task submit --max-reported-tokens` | Codex: the adapter interrupts the turn when reported usage reaches it. Reports arrive after use, so usage can overshoot |
| Reported cost | `--max-reported-cost-minor` with `--reported-cost-currency` | Claude Code: the provider's own budget, in USD only |
| Native agents and work Sessions | `--max-native-agents` | Codex, for a limit of 0 only |

An Objective with a budget caps each of its turns at what its budget has left when the turn's
harness enforces that limit; otherwise the turn runs without it, and the budget stops only new
turns. Reported tokens are not a billing cap. See [Budgets and allocation](coordination.md#budgets-and-allocation).

## Built-in harnesses

| Harness | Adapter | Credentials it receives | Commands |
| --- | --- | --- | --- |
| `codex` | Built into `supertag`; drives Codex's app-server | `CODEX_API_KEY`, `OPENAI_API_KEY`, and a copy of a file-backed sign-in | In Codex's sandbox, writable only in the checkout and read-write Workspace Volume copies; or, on a host with an E2B, Modal, or own-provider Workspace, in the Task's sandbox through Codex's exec-server. A code-mode-only model, such as gpt-6-sol, runs commands only when the Task also has `web:fetch`; see [Codex commands and models](../operations/requirements.md#codex-commands-and-models) |
| `claude-code` | Node bridge on the Claude Agent SDK | `ANTHROPIC_API_KEY` or the host user's sign-in | In a container with `--local-vm`, or in the Task's sandbox on a host with an E2B or Modal Workspace, with no built-in tool. Without a sandbox, only with `--allow-unsandboxed-commands`; a permission hook keeps file tools in the Task's roots |
| `cursor` | Node bridge on the Cursor SDK | `CURSOR_API_KEY` | In a container with `--local-vm`; in the Task's sandbox on a host with an E2B or Modal Workspace; in a shared execution environment; or without a sandbox, only with `--allow-unsandboxed-commands` |
| `opencode` | Node bridge | The selected provider's API key, or `--opencode-auth-file` | In a container with `--local-vm`, or in the Task's sandbox on a host with an E2B or Modal Workspace, with every built-in tool off. Without a sandbox, only with `--allow-unsandboxed-commands` |
| `openai-agents` | The `supertag` Python package | `OPENAI_API_KEY` | The tools the Task's permissions allow |

`supertag sign-in HARNESS` checks a harness's credentials the way a host uses them, and
`supertag init` runs the same check.

## Workspaces

A Tag's Workspace is a repository the host maps: a local Git source
(`--workspace-id ID --workspace-source PATH`, or `workspaces` in `supertag.yaml`), or a remote
Workspace on a git server (`--remote-workspace ID`, or `ID: { remote: true }` in `supertag.yaml`),
which the host reads and pushes with a credential the Control Plane grants for each operation. One
host may serve both kinds. Each Task Attempt runs in its
own checkout pinned to an exact commit. When a Session's next Task Attempt runs on the same host
and starts from the commit its last completed Task Attempt delivered, the host moves that checkout to
it instead of writing every file again. It removes files Git does not track (except setup
outputs), verifies every tracked file, and rebuilds the `.git` directory from objects it kept
outside the checkout, never the previous harness's. A checkout that fails verification is replaced
by a fresh one. The host keeps the last checkout of at most 8 Sessions per Workspace and base
commit. The host's own Git commands never run repository hooks,
filters, or configuration a Task wrote, and the host fails a Task Attempt whose repository Git
configuration changed while it ran.

`--workspace-setup ID=COMMAND`, or `setup` in a `supertag.yaml` Workspace, runs a shell command
such as `npm ci` in each new checkout before the harness starts. It runs on the host, outside any
harness sandbox, with a 10-minute limit, and receives no provider credentials. A reused checkout
keeps its setup outputs, and setup does not run again. Those outputs are whatever the Session's
previous Task Attempt left in them: its harness could change them (for example, install another
package into `node_modules`), and the host does not check them. Only the same Session of the same
Tag reuses a checkout, so nothing crosses a Tag or Session boundary. Tracked files, including
lockfiles, are always verified against the Task Attempt's start commit.

### Delivery

When the harness finishes a turn a person is waiting on, the host reports its reply at once: the
desktop app and the terminal UI show it, and a surface thread such as Slack gets it in place of its
acknowledgement, while the host delivers the turn's changes. If delivering them fails, the turn
fails: the app shows the error beside the reply, and the thread gets the error as a message of its
own after the reply. A turn no person waits
on, such as a Schedule's, shows its reply only when it finishes, since it may stay quiet.

After the harness finishes, the host commits the Task's changes and verifies them. A new file the
repository's `.gitignore` files match is left out, and so is a new file in a well-known cache,
dependency, or editor location the repository doesn't track: `__pycache__/`, `*.pyc`,
`*.egg-info/`, `.pytest_cache/`, `.mypy_cache/`, `.ruff_cache/`, `.tox/`, `.venv/`, `venv/`,
`.coverage`, `htmlcov/`, `node_modules/`, `.next/`, `.turbo/`, `.parcel-cache/`, `.gradle/`,
`.DS_Store`, and editor swap files, plus `target/` in a repository with a `Cargo.toml`. The
repository's `.gitignore` can re-include any of them with `!`, and a file the repository already
tracks is delivered as usual. It records the
result as a Git bundle, with the ref `refs/heads/supertag-deliveries/DELIVERY_ID`, and a patch. The
bundle carries only what the Task added to its start commit: the Session's previous delivery, or
the Workspace base for its first Task. The host keeps the bundle and patch in its artifact storage
and registers only their digests; the Control Plane never passes them. The host itself writes each
delivery as the branch
`supertag/session/HASH`, one branch per Session that each later Task advances: into the
repository it maps for a local Workspace, before it reports the Task, unless the Workspace is
mapped with `--workspace-patch ID` (`land: patch`); or, for a remote Workspace, by pushing it to
the git server. The host never switches your checkout's branch or changes its files, and leaves a
branch someone moved outside SuperTag as it is.

The Session's next Task continues from that delivery. On the host that produced it, in any of
its slots, it reads the commit from that host's own repository. For a remote Workspace,
any other host reads the Session's branch from the git server; until the producing host has
pushed it, the Task Attempt keeps its slot and retries. A local Workspace's Session continues only
on the host that produced its last delivery, since only that host has its commits: no other host
claims the Task. In either case the Task says it is waiting for that Worker Host wherever a
waiting turn's reason shows, and `supertag placement explain` and `supertag describe task` report
the requirement `workspace-holder`. Start that host, or cancel the Task. To continue Sessions on
any host, use a remote Workspace.

A Task with no commits delivers nothing. A remote Workspace's changes land on its git server;
`supertag get landings` follows them. See [Landing](resource-model.md#landing).

### Workspace Volumes

A Tag may copy data from a **Volume**, a registered directory or S3 prefix, into its Tasks:
`supertag workspace-volume put` registers it, `tag put --workspace-mounts` binds it, and each
serving host maps it with `--workspace-mount-mappings FILE`, which pins an S3 Volume's endpoint,
region, and key variables. A copy is staged after the checkout and `setup`, before the harness
starts, and removed afterwards; the Volume credential never leaves the host. A read-write copy
requires `files:write`; after a successful Task Attempt the host writes changed and created files
back to the Volume, never deletions or links, and records a summary on the Task. Codex, Claude
Code, Cursor, and OpenCode Tasks take copies when they do not run commands or fetch from the web.
A Cursor Task in an E2B or Modal Workspace receives only the files inside its sandbox. Copies are
the only form: read-only provider-native Modal Volume mounts are on the backlog.

## Remote sandboxes and shared execution

A Cursor, Claude Code, OpenCode, or Codex Task can keep its Workspace in an E2B or Modal sandbox
(`--e2b-workspace-provider`, `--modal-workspace-provider`), or in your own provider's
(`--workspace-provider`; see [Run your own provider](sandbox-providers.md#run-your-own-provider)),
while the harness and its credentials stay on the host. Only the checkout moves into the sandbox; keys never do. A Task with
`commands:execute` runs its commands in the sandbox, which has no network access, so the host
needs no `--allow-unsandboxed-commands` (and cannot take it). Each command runs in its own process
group with its own time limit, enforced inside the sandbox. After a Task ran commands or a
Workspace MCP server, the provider stops every process in the sandbox except the ones the sandbox
started with, confirms none is left, and captures the Workspace in the same process; a sandbox it
cannot confirm fails the Task Attempt. Processes already running when the sandbox was
allocated, such as a `cron`, `supervisord`, or other daemon the image or a prepared artifact
starts, count as the sandbox's own: they keep running through Capture, and whatever they write
to the Workspace is captured like the Task's own work. This keeps an honest Task's leftovers (a dev server, a
watcher) from changing the Workspace while it is read. It is not a security boundary: on Modal,
and on E2B through sudo, the Task is root in its sandbox and could defeat it. What protects the
host is that nothing runs on it: the Worklet checks the returned files, and stopping the
sandbox ends everything in it. Capture leaves out every `.git` entry and every untracked path
the checkout's `.gitignore` files match, except the Task output directory. A Task whose
Permission Sets hide paths does not run commands on such a host, and a Task with `web:search`,
`browser:use`, or a `web:fetch` without a network scope does not run on it at all: those tools
would run on the host. With a local-vm or Modal Workspace, a scoped `web:fetch` reaches its hosts through a
relay in the sandbox, for the Task's commands; see [Run a harness in a sandbox](../guides/workers.md#run-a-harness-in-a-sandbox). A repository's
`.devcontainer` settings choose the sandbox image, user, and setup; see
[Devcontainer settings](devcontainer-subset.md). The
[sandbox provider contract](sandbox-providers.md) states what a provider must do.

A Codex host can use the same providers. Codex itself, with its keys, stays on the host. Its
commands and file operations run in the sandbox, through Codex's own exec-server there:
- **Image:** the sandbox image must contain a `codex` of exactly the host's version on
  `/usr/local/bin:/usr/bin:/bin`. Allocation fails otherwise, naming the version. A local-vm host
  installs it in every image it builds; E2B templates and Modal images need it added.
- **Configuration:** Codex reads its configuration from an empty, read-only directory in the
  sandbox, so nothing a Task writes there, such as `~/.codex` or a repository's
  `.codex/config.toml`, adds MCP servers or hooks.
- **Code mode:** code-mode JavaScript runs on the host in Codex's V8 isolate, which has no
  network or file access. Only its tool calls reach the sandbox.
- **Task limits:** the sandbox is the boundary, and Codex's own sandbox is off inside it. So
  Codex runs there only Tasks with `commands:execute` and no path scope.
- **Repository Skills:** Codex reads a repository's own Skills (`.agents/skills`) from the
  checkout, as it does on a local host. They are instructions only. Codex 0.163.0 has no switch
  that turns them off without hiding SuperTag's Skills too.
- **Lost sandbox:** Codex 0.163.0 can't continue a turn in a replacement sandbox: once its
  executor's connection ends, every later tool call in the turn fails. When the provider confirms
  the sandbox gone, the Task Attempt fails and says so, whatever Codex reported. Nothing runs on
  the host instead; send the request again to run it in a new sandbox.

A shared execution environment, served by `supertag-shared-execution`, holds one workspace that
several Cursor Sessions use. The host connects with `--shared-execution-endpoint` and
`SUPERTAG_EXECUTION_ADMIN_TOKEN`. `--shared-execution-commands` allows lease-bound commands on a
Linux provider that runs them as its configured workload user.

## Skills and MCP servers

A host's Skill catalog (`--skill-catalog`) is the allowlist of Skills a Task may load; a GitHub
catalog entry is pinned to the commit a new Task first resolves, and its retries keep it. A host's
MCP catalog (`--mcp-catalog`) lists HTTP and stdio servers for Claude Code Tasks, with presets for
GitHub, Slack, Linear, Microsoft Teams, and Lark. A Task sees a catalog tool only when its
Permission Sets grant it, and calls that require approval wait in the operator inbox. An OAuth
server's login lives on the host: `supertag mcp login NAME`. A Workspace's own `.mcp.json` servers
run only when the Tag lists them with `--workspace-mcp`.

Each MCP catalog credential names a Worker Host variable (`headerEnv`, `clientSecretEnv`,
`privateKeyEnv`) or a file through the matching `File` field (`headerFile`, `clientSecretFile`,
`privateKeyFile`); a stdio server's `env` value is a variable name or `{"file": PATH}`. A file path
is absolute or starts with `~/`, and the file must be a regular file you own with no group or
other permissions, such as mode `0600`. The host reads it again for each Task Attempt and after a
401 or 403, so a replaced file takes effect without a restart. MCP credentials never reach the
Control Plane or a sandbox.

## Artifacts

A Task captures files as artifacts. The host keeps their bytes in its artifact storage
(`STATE_DIRECTORY/artifacts`, or `--artifact-directory`), and the Control Plane records only the
catalog. The host does the same with each Workspace delivery's patch and bundle, which the Control
Plane relays over the host's relay stream to whoever imports the delivery. Artifacts never pass
through the Control Plane: a Task on the same host reads them from its storage, and a host run
with `--artifact-transfer-listen` serves other hosts directly; they pin it with
`--artifact-peer HOST_ID=ORIGIN`. See
[Artifacts](artifacts.md).

## Next

- [Write a harness adapter](../guides/harness-adapters.md)
- [CLI reference: `supertag worker-host`](cli.md#supertag-worker-host)
