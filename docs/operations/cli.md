# Direct work with the CLI

Run SuperTag end to end on one computer. This page uses these terms:

- A **Task** is one request or assignment accepted by SuperTag. A **Task Attempt** is one execution
  or retry of a Task.
- The **Control Plane** stores and schedules the work.
- A **Worker Host** is an enrolled computer or sandbox that can execute it.
- A **Worklet** connects that host to the Control Plane and advertises a **Worker Profile**, which
  tells the scheduler what kind of work its **Worker**, the code that completes a Task, can run.
- A **harness** connects the Worker to Codex, Claude Code, Cursor, or OpenCode.
- A **Tag** is a persistent AI identity with its own responsibilities and permissions.
- An **Objective** is an outcome a Tag owns until it is met.

The shortest path is [Start in a repository](#start-in-a-repository): `supertag init` sets up your
repository, you create an Objective, follow it with `supertag watch objective`, and find its result
with `supertag describe objective`. The [Get started](../../README.md#get-started) quickstart walks
through that path. Tags work in Teams under a lead. Together, your Teams of Tags make up an
**autonomous organization**: Teams may pursue different Objectives but share one Control Plane, its
rules, and its record of the work. The rest of this page then does each step by hand: configure an
organization, connect execution capacity, assign a Task, and download its result. Use it to learn
the CLI before you run Worker Hosts elsewhere.

See the [glossary](../reference/glossary.md) for other terms. Commands follow this shape:

```text
supertag ACTION RESOURCE [PRIMARY_TARGET] [flags]
```

For example, `supertag list task` returns a JSON collection, `supertag get task TASK_ID` returns
one Task as JSON, and `supertag describe task TASK_ID` presents the same stored evidence for a
person to read. `get` remains JSON even when a readable `describe` view exists.

Text views replace terminal controls and invisible fillers in reported values with spaces
and limit stacked combining marks. Escape payload text remains visible. For example, a Worker
Host name cannot clear the screen or add a fake output line.
This applies to descriptions, lists, status, warnings, errors, and the inbox. Default JSON
views on a terminal also filter reported values. Explicit `--output json` and piped `get` or
`watch` output retain the original values for scripts.

Commands that create or change something print a one-line summary for a person, such as
`objective/cli-demo created` or `task/cli-demo-task cancelled.`, with warnings on standard error.
Add `--output json` to print the full record instead, for scripts. `get`, `list`, and `events`
always print JSON.

`supertag start objective ID [--output json]` starts an Objective created with `--no-start`.
It creates the owner's first Task and prints the new status, deadline and budget when set, and
`supertag describe objective ID` as the next step. With `--output json`, it prints the structured
start result. An unknown ID or an Objective already started returns an error.

## See what your organization is doing

`supertag status` answers "what is my organization doing right now" on one screen. It takes no
arguments. Run it when you come back to a running organization, before you read the details of
any one Objective.

```sh
supertag status
supertag status --output json
```

```text
Worker Hosts
  laptop  ready  2/3 Task Attempts running (claude-code 0/1, codex 2/2)

Tags
  builder  busy: operator-reads:item1-status, operator-reads:item2-list
    operator-reads:item1-status  running `npm test` for 24m
  lead  idle

Objectives not finished
  operator-reads  working; owner lead; $13.80 of $30.00; deadline in 1h 9m; 2 need you

Operator inbox: 2 items; see supertag list inbox
```

It shows:

- Each Worker Host's connection, and its running Task Attempts against capacity for each harness.
- Each Tag as idle, or busy with the Tasks it is running.
- The shell command each running Task is running, and for how long, when its harness reports
  commands. Codex and Claude Code report them. A long test run shows here, so you can tell it
  from a hang.
- Each Objective that is not completed or cancelled: its status, owner, spend against budget,
  time to its deadline, and how many inbox items wait for you. An unpriced Task Attempt shows
  its token count and a warning that the monetary budget cannot be enforced for that usage.
- How many items wait in your operator inbox. `supertag list inbox` lists them.

## View organization spend

`supertag spend` summarizes cost and token usage across Task Attempts. Codex records usage from completed turns in both execution modes. Its cost is estimated only when the provider publishes a model price. Spend and objective views label estimates, show unpriced models with their token counts, and monetary Objective budgets include only priced costs. For
example, use it to see how much an Objective's work has cost so far. It groups by Objective by
default; `--by tag` groups by the executing Tag and `--by day` groups by UTC calendar day.
Each unknown cost says why. `no price for gpt-x in 2; tokens recorded` means the Harness reported
tokens for a model missing from the Codex Harness price table, which ships with `supertag-ai`;
upgrade `supertag-ai` to get new prices. `no cost reported in 1` means the Task
Attempt reported no cost.

```sh
supertag spend
supertag spend --by day --since 2026-10-01T00:00:00Z --output json
```

`--since` selects Task Attempts started at or after an ISO timestamp with a timezone. Text output
shows cost in major units with the currency, such as `$13.80`; `--output json` keeps minor units
(`1380`). Separate currencies stay separate. Unreported cost and tokens
appear as unknown; a partial group includes the reported sum and an unknown Task Attempt count.
Objective rows show the Objective's budget, or `none` when it has no budget. A budget without a
currency is an allocation limit rather than a provider cost limit.

## Before you start

- SuperTag installed, with `supertag --version` succeeding.
- A harness ready on this Worker Host: for example, Codex or Claude Code installed and signed in,
  or Cursor configured with `CURSOR_API_KEY`.
- A workspace that the harness may inspect.
- Two terminal windows.

Provider credentials stay in the provider's normal local store. Worker Host credentials are kept
under `~/.supertag`; neither belongs in a command-line flag.

## Start in a repository

The shortest path is one command. From a git repository, run:

```sh
cd ~/code/app
supertag init
```

`init` checks `claude`, `codex`, and `opencode` on your PATH. It detects Cursor when
`CURSOR_API_KEY` is set, `cursor-agent` is on your PATH, or an `agent` binary identifies itself as Cursor.
Cursor Tasks require the key even if a CLI is installed.
With none available, it stops before
asking or changing anything and explains how to install one. Then it asks a few questions, with
each default in brackets; press Enter to accept it, or pass `--yes` to accept them all:

1. The local **Control Plane**: its port (`3434`) and database (SQLite in `~/.supertag/`, or a
   `postgresql://` URL).
2. This computer as a **Worker Host**: the harnesses it serves, noting the ones that show a local
   sign-in, and the directory to work in (this repository). OpenCode needs a model, so choosing it
   asks for one as `provider/model`, and `--yes` leaves it out unless it is the only harness, in
   which case `init` stops and asks you to run it in a terminal. The directory becomes a
   **Workspace**, a named repository that Tasks work in, named after it, such as `app`. Its origin
   URL is the source and its default branch the base. `init` also asks how finished work comes
   back: as a branch (the default), a patch, or a draft pull request for a GitHub repository.
   When you choose Claude Code or OpenCode, `init` explains that they run commands as you,
   without a sandbox, so their Tags should get only trusted work. It asks whether to allow that,
   defaulting to yes, and writes the answer as `allow-unsandboxed-commands`. `--yes` allows it and
   prints how to undo it. See
   [Unsandboxed harnesses](../reference/supertag-yaml.md#unsandboxed-harnesses).
   Cursor uses its SDK and requires its own authentication; its app login does not suffice.
   See [Cursor setup](requirements.md#cursor-setup-and-limits).
3. The lead **Tag**, named `lead` by default, and what it may do: read only, edit files and run
   commands (the default), or also open pull requests. Pull requests need a GitHub collaboration surface, which you can add later.

`init` then writes `~/.supertag/supertag.yaml` with two services: `control-plane`, the local Control
Plane, and a host service named after this computer, such as `studio`. It brings up the Control
Plane with `supertag up` and creates the Workspace, the **Permission Set** `local-tools` (the
actions the Tag may perform), the **Role** `Lead` (its enduring responsibility), and the Tag through
the Control Plane's API. Then it brings up the host service, binds it to the Tag, checks that each
harness Worker registered, and prints the command for a first Objective:

```sh
supertag create objective --owner lead --workspace app \
  --outcome 'The README explains local setup. Done when a new contributor can follow it.'
```

Creating the Objective also starts its owner, `lead`, with a first coordination Task. The command
prints the Objective's ID and the next commands:

```sh
supertag watch objective ID      # one line per event, until the Objective closes
supertag describe objective ID   # status, what was delivered, and what needs you
```

When a Task delivers a branch, `describe objective` shows where it is in your repository and the
`git diff` and `git switch` commands to review it.

`init` writes nothing in the repository. All state lives in `~/.supertag/`, or the directory
`SUPERTAG_STATE_DIR` names; see [supertag.yaml and local state](../reference/supertag-yaml.md).

Rerun `init` whenever you like. It shows the current setup and offers to keep it, change it, or
exit. In another repository, it offers to add that repository as another Workspace of the same host
service; there is one local Control Plane per computer. A rerun never deletes a resource or undoes a
change you made with manifests. Without a terminal, such as in a script, pass `--yes`.

### Run and stop SuperTag

`supertag up` brings up the services in `supertag.yaml`, in the background, and returns:

```sh
supertag up              # every service: the Control Plane first, then hosts
supertag ps              # each service's state, address, and process
supertag logs -f         # every log, each line prefixed with its service
supertag down            # stops hosts first, then the Control Plane
```

`up` starts services in `depends_on` order and waits for each to become healthy. The Control Plane
is healthy when it answers `/healthz`. A host is healthy when it is connected and every harness
Worker registered. Name services to bring up only those and what they depend on, such as
`supertag up studio`. `supertag logs studio` and `supertag down studio` take names the same way.

Run `supertag up` again after you edit the file. It leaves alone a service whose settings did not
change and restarts one whose settings did. A host whose only change is `concurrency` keeps
running and takes the new limit at once; see
[Changing concurrency](../reference/supertag-yaml.md#changing-concurrency).
`supertag up --dry-run` prints what it would start, restart, drain, change, or leave, and which
settings changed. `supertag config` prints the resolved file,
or every problem in it. See [supertag.yaml and local state](../reference/supertag-yaml.md).

A host restart never cuts off running work. SuperTag first drains the Worker Host, so it takes no
new Task Attempts, and waits for running ones to finish. The wait lasts at most the longest
remaining Task Attempt time limit plus 30 seconds, and never more than 30 minutes. With the default
60-minute limit, that is up to 30 minutes; an idle host restarts at once. Progress prints every 10
seconds. `--force` or Ctrl-C stops waiting, and interrupted Task Attempts follow the usual
[recovery rules](../reference/scheduling-and-recovery.md#leases-and-unknown-outcomes).
`supertag down` drains each Worker Host and lists the Task and Task Attempt IDs it waits for.
It waits up to five minutes. If work remains, it reports those IDs, exits non-zero, and leaves
the host and subsequent services running. Run `supertag down SERVICE --force` to stop now, or
run `supertag down` again after the work finishes. A Control Plane restart does not drain;
running Task Attempts may see a brief disconnect, and hosts reconnect.

`supertag down` without names stops every service on this computer, including services the file no
longer names.

To retire a host service, delete it from `supertag.yaml`. Until you remove it, `supertag up` and
`supertag ps` list it as no longer in the file. Then name it, as in `supertag down studio`:

1. `down` drains and stops the host, if it runs.
2. It removes the host's service unit.
3. It unbinds the host's Worker Host from its Tags. This step needs operator access to the host's
   Control Plane, which the local Control Plane always gives. On a teammate's Control Plane, an
   operator unbinds it.
4. It revokes the Worker Host with the host's own credential.
5. It removes the host's state, including its logs, from `~/.supertag/hosts/`.

`down` removes the host's state only after it unbinds and revokes the Worker Host. If it cannot,
it keeps the state, including the host's credential, and says why. This happens when the Control
Plane cannot be reached, you lack operator access to it, or the credential cannot be read. Fix the
cause and run the same `supertag down` again.

### Run in the foreground or as a service

`supertag up --foreground` runs services in the terminal until Ctrl-C. With several services, each
log line starts with its service name, such as `control-plane |`. Use it to debug startup.

`restart: unless-stopped` on a service keeps it running after restarts:

```yaml
services:
  control-plane:
    type: control-plane
    restart: unless-stopped
  studio:
    type: host
    harnesses: [claude-code]
    allow-unsandboxed-commands: [claude-code]
    workspaces: { app: ~/code/app }
    restart: unless-stopped
```

The next `supertag up` installs a per-user service unit for each such service. The unit starts it
when you log in and restarts it if it fails. On macOS a unit is a LaunchAgent, such as
`~/Library/LaunchAgents/ai.supertag.control-plane.plist`. On Linux it is a systemd user unit,
such as `~/.config/systemd/user/supertag-control-plane.service`; to keep units
running while you are logged out, run `loginctl enable-linger $USER` once. `ps`, `logs`, and `down`
work with units: `down` stops them until the next login, and `supertag down --remove-services`
uninstalls them. Units are not supported on Windows yet.

A unit does not inherit your shell's environment. `supertag up` copies `PATH`, `HOME`, and the
`SUPERTAG_*` overrides that hold no secret into the unit. Put secrets and other variables a service
needs in `~/.supertag/.env`. A value that only your shell holds never restarts a unit's service;
`up` warns and names it instead. See
[Environment under a unit](../reference/supertag-yaml.md#environment-under-a-unit).

### Which Control Plane commands use

Commands such as `supertag create objective` use the local Control Plane with this computer's local
operator credential, so the Objective command above needs no setup. `--control-plane NAME`,
`SUPERTAG_CONTROL_PLANE`, and a saved connection from `supertag connect control-plane URL` choose
another Control Plane, and `SUPERTAG_OPERATOR_TOKEN` replaces the credential.

### See who changed what

The Control Plane records each change an operator makes, such as an apply, a delete, an approval,
or an Objective message, with who made it and whether it worked. List the latest changes:

```sh
supertag audit
supertag audit --actor token:laptop-2 --since 2026-10-01T00:00:00Z --output json
```

See [Audit log](control-plane.md#audit-log).

### Join a teammate's Control Plane

For a Control Plane your team shares, an operator gives you an **Auth Key**, a secret that lets a
computer join as a Worker Host. Save it in a file, and add a host service that names the shared
Control Plane to `~/.supertag/supertag.yaml`:

```yaml
services:
  laptop:
    type: host
    control-plane: https://supertag.example.com
    auth-key: laptop-key
    harnesses: [claude-code]
    workspaces: { app: ~/code/app }
secrets:
  laptop-key: { file: ~/laptop.key }
```

Then run `supertag up`. The host joins with the key, stores its own credential in
`~/.supertag/hosts/laptop/`, and runs in the background. Later runs use that credential and ignore
the key. Resources on the shared Control Plane change only when someone with an **Operator Token**,
a named credential that can manage the Control Plane, runs `supertag apply -f` with manifests. See
[Add teammates](../guides/self-hosting.md#add-teammates).

The rest of this walkthrough does each step by hand with `supertag start control-plane` and
`supertag connect worklet`. It shows what `init` does, and it is how deployments and scripts run
SuperTag. Neither command reads `supertag.yaml`. On a computer with an `init` setup, run
`supertag down` first, so the walkthrough's Control Plane can use port 3434.

## 1. Start the Control Plane

In terminal 1, prepare the database and start a local Control Plane with a gRPC listener for the
Worklet:

```sh
supertag migrate database

SUPERTAG_WORKLET_TRANSPORT=remote \
SUPERTAG_WORKLET_GRPC_PORT=3435 \
supertag start control-plane
```

Keep this process running. Its management API listens on `127.0.0.1:3434`; the Worklet listener in
this example is `127.0.0.1:3435`. Loopback gRPC may use plaintext. A non-loopback gRPC listener
requires the TLS certificate and key settings shown by `supertag start control-plane --help`.

In terminal 2, confirm that the CLI can reach the saved local Control Plane:

```sh
supertag status control-plane
```

## 2. Give a Tag a Role and allowed actions

The Tag accepts the Task. Its Role describes an enduring responsibility, and a Permission Set lists
the actions that work under that Role may perform. One file can hold all three manifests, separated
by `---`.

Save this as `~/.supertag/cli-demo/local-builder.yaml`, after `mkdir -p "$HOME/.supertag/cli-demo"`:

```yaml
apiVersion: supertag/v1
kind: PermissionSet
metadata:
  name: local-tools
spec:
  permissions:
    - target: runtime
      action: commands:execute
    - target: runtime
      action: files:write
---
apiVersion: supertag/v1
kind: Role
metadata:
  name: Local Builder
spec:
  purpose: Inspect a local project and produce requested files.
  instructions: Use workspace evidence and report uncertainty clearly.
  contextSets: []
  permissionSets:
    - local-tools
---
apiVersion: supertag/v1
kind: Tag
metadata:
  name: local-builder
spec:
  roles:
    - Local Builder
```

Apply it. SuperTag checks every manifest first, then applies the Permission Set, the Role, and the
Tag in dependency order, whatever their order in the file:

```sh
supertag apply -f "$HOME/.supertag/cli-demo/local-builder.yaml"

supertag describe tag local-builder
```

The Tag has no Worker Host yet, so it cannot run Tasks. The next step adds one.

## 3. Create an Auth Key for this computer

The host that joins with an Auth Key is bound to the key's Tags:

```sh
supertag create auth-key local-laptop --tag local-builder
```

The command prints a secret that starts with `stak_`, only once. The key joins one host and expires
after one hour. Put the secret in an environment variable for the next step rather than in a
command:

```sh
read -rs SUPERTAG_AUTH_KEY && export SUPERTAG_AUTH_KEY
```

## 4. Connect a harness Worklet

Still in terminal 2, choose the workspace the harness may use and start the Worklet in the
background. The Worklet redeems the key, joins as Worker Host `local-laptop`, and stores the host's
credential under `~/.supertag/worker-hosts/` with mode `0600`. The default connection keeps artifact
copies locally but advertises no transfer endpoint. The catalog will show the holding Worker Host;
downloading later needs a reachable transfer endpoint or a shared artifact **Volume**, a named
storage location such as a bucket prefix. See
[artifact transfer setup](../guides/workers.md#keep-artifacts-on-worker-hosts). For Codex:

```sh
WORKSPACE="$(pwd)"

supertag connect worklet \
  --worklet-url http://127.0.0.1:3435 \
  --transport grpc \
  --worker-host local-laptop \
  --harness codex \
  --worker-profile local-codex \
  --workspace "$WORKSPACE" \
  > "$HOME/.supertag/cli-demo/worklet.log" 2>&1 &
WORKLET_PID=$!
```

For Claude Code, replace the harness and profile lines with:

```sh
  --harness claude-code \
  --worker-profile local-claude-code \
  --allow-unsandboxed-commands \
```

For Cursor, set `CURSOR_API_KEY` in the Worklet process environment and replace the harness and
profile lines with `--harness cursor` and `--worker-profile local-cursor`. The bundled SDK runs
Cursor; no Cursor CLI installation is required. Keep `--allow-unsandboxed-commands` for Tasks that
may run commands: Cursor's sandbox policy is workspace-writable, so it is not an enforced boundary.
See [Cursor setup](requirements.md#cursor-setup-and-limits).

Claude Code runs commands as you, without a sandbox, so it runs Tasks that may run commands only
with `--allow-unsandboxed-commands`; see
[Unsandboxed harnesses](../reference/supertag-yaml.md#unsandboxed-harnesses).

The public `--worklet-url` is the Worklet listener, which can differ from the saved management API
address. HTTP and HTTPS Worklet URLs default to gRPC, but this example states the transport
explicitly. The transport does not silently fall back to WebSocket. Joining uses the saved
management API, because the gRPC listener does not serve it.

Later runs of the same command use the stored credential and ignore any key. On a computer that
already holds operator credentials for this Control Plane, as here, `connect worklet` could also
enroll the host without a key; an operator would then bind it with `supertag update tag`.

For Codex Tasks that request a reported-token limit, connect with
`--codex-execution-mode app-server`; see [Limit reported tokens](../guides/workers.md#optional-limit-reported-tokens).

Check the Control Plane's stored view:

```sh
supertag describe worker-host local-laptop
```

Wait until it reports the expected Worklet and Worker Profile. This view uses the last stored
heartbeat and does not probe the process on demand. If the host does not become ready, inspect
`~/.supertag/cli-demo/worklet.log`.

The background process keeps the walkthrough to two terminals. Use a service supervisor for an
always-on Worker Host.

## 5. Create an Objective and Team

An **Objective** states the outcome and criteria for success. Its runtime actions are an upper
bound for every Task under it. They default to the owner's, so this Objective allows the same two
actions as the Role. A **Team** groups Tags working toward that Objective; this example uses the
Tag as its lead.

Creating an Objective normally starts its owner, which then plans and assigns the work itself.
This walkthrough assigns its Task by hand instead, so `--no-start` creates the Objective without
starting the owner:

```sh
supertag create objective cli-demo \
  --outcome "Produce a short evidence-based description of this workspace that explains the project's purpose and cites workspace evidence." \
  --owner local-builder \
  --no-start

supertag create team cli-demo-team \
  --objective cli-demo \
  --name "CLI demo" \
  --lead local-builder
```

## 6. Assign and follow a Task

Task assignment uses the Tag's generated ID. Read the Tag as JSON, copy `metadata.id`, and put it in
`TAG_ID`:

```sh
supertag get tag local-builder
TAG_ID="PASTE_METADATA_ID_HERE"
```

Create the instruction file:

```sh
cat > "$HOME/.supertag/cli-demo/instructions.txt" <<'EOF'
Inspect this workspace. Write a short plain-text summary of what the project does to
outputs/report.txt. Use only evidence from files in this workspace.
EOF
```

Assign the Task. Omitting a profile lets the scheduler choose any compatible Worker advertised by
a bound Worker Host:

```sh
supertag assign task cli-demo-task \
  --objective cli-demo \
  --team cli-demo-team \
  --tag "$TAG_ID" \
  --instruction-file "$HOME/.supertag/cli-demo/instructions.txt" \
  --criterion "outputs/report.txt contains a concise workspace summary" \
  --output-file outputs/report.txt
```

When the Objective statement lists numbered items, add `--item N` for each item the Task serves,
such as `--item 1 --item 3`. `supertag describe objective` then shows the Task under those items.

Inspect the current state, durable events, or subsequent resource changes:

```sh
supertag describe task cli-demo-task
supertag events task cli-demo-task
supertag watch task cli-demo-task
```

`watch` prints JSON whenever the stored resource version changes and continues until you press
Control-C. `supertag get task cli-demo-task` always returns the current Task as JSON.

SuperTag continues waiting Tasks automatically. If a Worklet is interrupted or killed mid-Task,
see [Scheduling and interrupted execution](../reference/scheduling-and-recovery.md#leases-and-unknown-outcomes).

Rules:

- There is no `resume task` command. `resume worker-host` only returns a deliberately drained
  host to scheduling.

## 7. Inspect continuity and the artifact

A **Session** groups related Tasks for the Tag. `describe task` prints the Session ID. Use it to
inspect the stored continuity record:

```sh
supertag describe session SESSION_ID
supertag get session SESSION_ID
```

The readable view reports whether a resumable native archive and native Codex or Claude Code
conversation ID were recorded. SuperTag supplies that state automatically to a later compatible
Task. There is no manual Session resume command, and native Session state does not preserve
workspace files.

After a successful Task Attempt captures `outputs/report.txt`, list its artifact metadata:

```sh
supertag list artifact --task cli-demo-task --limit 20
supertag get artifact ARTIFACT_ID
supertag describe task cli-demo-task
```

To download, first configure the Worklet with a transfer endpoint reachable from your machine,
or an artifact Volume your machine can read. Follow the
[Worker setup guide](../guides/workers.md#keep-artifacts-on-worker-hosts) before running the Task.
Operator downloads do not use loopback endpoints: the catalog cannot establish that your machine
is the serving host. Use a reachable HTTPS endpoint or your own Volume credential mapping.

With that storage setup, download the saved file:

```sh
supertag download artifact ARTIFACT_ID \
  --path outputs/report.txt \
  --out "$HOME/.supertag/cli-demo/report.txt"
```

The Control Plane keeps the artifact catalog, never the bytes: each copy stays on the Worker Host
that stores it. `list`, `get`, and `describe task` show each recorded holder, including disconnected
hosts. A recorded holder is not a promise that its bytes are reachable now. With the default
connection above, `download` reports the holding host and points to `supertag describe task`.
A consuming Task on another host likewise needs a reachable endpoint or shared Volume.

## 8. Stop the local processes

Stop the background Worklet from terminal 2:

```sh
kill "$WORKLET_PID"
```

Then press Control-C in terminal 1 to stop the Control Plane. The durable organization, Tasks,
events, and Session metadata remain under `~/.supertag` for the next run. Artifact bytes remain
in the producing Worker Host's state directory, or on its configured artifact Volume. Copies held
only on ephemeral storage are lost when that storage disappears.

## Check that it worked

If you configured downloads, the downloaded report summarizes your workspace:

```sh
cat "$HOME/.supertag/cli-demo/report.txt"
```

`supertag describe task cli-demo-task` shows the Task as completed, and
`supertag list artifact --task cli-demo-task` lists `outputs/report.txt`.

## If something goes wrong

- **The Worker Host never reports the expected Worklet.** Read
  `~/.supertag/cli-demo/worklet.log`, then work through
  [Troubleshoot the first reply](../guides/troubleshooting.md#4-separate-surface-testing-from-worker-testing).
- **The Task stays pending.** No compatible Worker Host is ready; see
  [Inspect the Task](../guides/troubleshooting.md#5-inspect-the-task) and
  [Worker Host selection](../reference/scheduling-and-recovery.md#worker-host-selection).
- **The Task waits for approval.** A Permission Set of the Tag marks one of its runtime actions
  `approval: required`. List the request and approve it:

  ```sh
  supertag list approval --objective cli-demo
  supertag approve request REQUEST_ID
  ```

  `--scope objective` approves every matching action in the Objective. Deny with
  `supertag deny request REQUEST_ID --reason TEXT`. See [IAM approval](../reference/iam.md#approval).
- **A Task shows as uncertain.** Its Task Attempt may have executed, so SuperTag won't run it again,
  and it holds a Worker slot. `supertag ps`, `describe task`, and the inbox show the recover command.
  Follow [A Task is uncertain](../guides/troubleshooting.md#a-task-is-uncertain).
- **The host stays at capacity after you killed the Worklet.** Follow
  [A Worker Host stays at capacity after a forced kill](../guides/troubleshooting.md#a-worker-host-stays-at-capacity-after-a-forced-kill).
- **`download artifact` can reach no copy.** The Control Plane stores no artifact bytes, so the
  command reads a Volume that holds a copy, using this machine's own `volume-credentials` in
  supertag.yaml, or fetches from the Worker Host that serves it. When neither works, it names the
  Worker Hosts and Volumes that hold the file. Map that Volume's credential on this machine, or
  download from a machine that can reach the serving host. See
  [artifacts](../reference/artifacts.md#storage-and-limits).

## Next

- [Run a Worker](../guides/workers.md) for remote Worker Hosts and production supervision.
- [Manage Control Plane resources](resources.md) for the complete resource inspection model.
- [Scheduling and interrupted execution](../reference/scheduling-and-recovery.md) for how hosts are
  chosen and interrupted work is recovered.
