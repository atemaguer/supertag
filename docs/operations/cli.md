# Direct work with the CLI

The `supertag` command sets up this machine, runs SuperTag's services, and directs the work of
your Tags, the persistent AI actors with their own responsibilities and permissions. This page is
a tour by task. Every command and flag is listed in the [CLI reference](../reference/cli.md).

Terms used here: the **Control Plane** stores your organization and schedules its work. A
**Worker Host** is a machine or sandbox that runs that work. A **Task** is one turn of a Tag's
work in a **Session**, one thread of work. An **Objective** is an outcome a Tag owns until it is
met. See the [glossary](../reference/glossary.md) for other terms.

## How commands find the Gateway

Commands that read or change your organization talk to one **Gateway**, the SuperTag service
that clients and operators connect to. It forwards each command to its **Control Plane**, the
service that stores your organization, which checks what your credential allows. Commands pick
the Gateway in this order:

| You pass | Commands use |
| --- | --- |
| `--gateway NAME` | A Gateway saved under `NAME` by `supertag connect`, the terminal UI, or the desktop app |
| `--gateway https://HOST` or `wss://HOST` | That Gateway, with the Operator Token in `SUPERTAG_OPERATOR_TOKEN` |
| `--state-directory DIR` | The Gateway that `supertag up` runs from `DIR`, with that directory's local operator credential |
| `SUPERTAG_GATEWAY_URL` set to a saved name or a URL | That Gateway, as with `--gateway` |
| Nothing | The Gateway that `supertag up` runs on this machine, from `SUPERTAG_STATE_DIR` or `~/.supertag` |

`--gateway` may also come before the command, as in `supertag --gateway team get tag`.
The examples on this page use your local services, so they name no Gateway. Against a shared
deployment, add `--gateway NAME`. If a Gateway is down, an operator can pass the Control Plane's
own URL to `--gateway`: it serves the same commands.

When no local Gateway is running and you name none, a command stops with `no local Gateway is
running from DIR; start one with supertag up, or pass --gateway`.

## Start in a repository

Run `supertag init` from a Git repository with at least one commit:

```sh
cd ~/code/app
supertag init
```

`init` finds the harnesses on your `PATH`, checks each one's sign-in with the credentials a
Worker Host will have, and asks for a Control Plane port, a harness, a Workspace name, and the
Tag's name; for OpenCode it also asks for a `provider/model`. Claude Code runs through Node.js
22.13.0 or later; without it on `PATH`, `init` says so and doesn't offer Claude Code. It writes
`~/.supertag/supertag.yaml` with two services and starts them in the background:

- a `control-plane` service, which also creates a `local-tools` Permission Set, a `Lead` Role,
  and the `lead` Tag, bound to the repository's Workspace and following the branch checked out
  when `init` ran; and
- a `host` service named after this machine, which maps the repository as a Workspace and runs
  up to three Task Attempts at once (`concurrency: 3`), so one stuck Task does not hold every Tag.

Codex sandboxes its own commands. Claude Code, Cursor, and OpenCode don't, so for them `init`
asks how the lead may run commands, defaulting to not at all:

- With Docker running, it offers to run the harness's Tasks in containers on it (`environment:
  local-vm`), defaulting to no. The first Task then builds the container image, which takes a few
  minutes. See [local-vm containers](../reference/supertag-yaml.md#local-vm-containers).
- It asks whether to let the harness run commands without a sandbox, defaulting to no. A yes
  prints what that allows and becomes the host's `allow-unsandboxed-commands`. See
  [Unsandboxed harnesses](../reference/supertag-yaml.md#unsandboxed-harnesses).
- With neither, the lead reads and edits files and replies, but runs no commands. `--yes` takes
  this default. To change it later, see [Let the lead run commands](#let-the-lead-run-commands).

`init` doesn't offer containers for Codex, which runs commands in its own operating-system
sandbox. To run a Codex host's Tasks in containers anyway, add `environment: local-vm` to its
service in supertag.yaml and run `supertag up`. Each image then gets the host's Codex version;
see [local-vm containers](../reference/supertag-yaml.md#local-vm-containers).

The `local-tools` Permission Set grants `files:read` and `files:write`, plus `commands:execute` when the host may run
the lead's commands, which it always may on Codex. For a Codex `lead`, it also grants `web:fetch`,
and `init` says so: current Codex models run commands only in Codex
code mode, which SuperTag starts only for Tasks that may also fetch from the web. Code-mode
commands can reach the network. To keep them offline, remove `web:fetch` from `supertag.yaml`,
select a Codex model that is not code-mode-only, and run `supertag up`. See
[Codex commands and models](requirements.md#codex-commands-and-models).

Each new Session of `lead` starts from that branch's current commit (`workspace.ref`), so commits
you make there reach the next Session. When HEAD is detached, `init` pins the checked-out commit
(`workspace.baseCommit`) instead and says so. To follow another branch or pin a commit, apply a
Tag manifest; see
[Work in a repository with Workspaces](../guides/workspaces.md#2-bind-a-tag-to-the-workspace).

`supertag init --yes` accepts every default. See [supertag.yaml and local state](../reference/supertag-yaml.md)
for the file.

### Run and stop SuperTag

| Command | Does |
| --- | --- |
| `supertag up` | Starts the services in `supertag.yaml` in the background and returns when they are ready |
| `supertag up --foreground` | Runs them in this terminal, with their logs, until you interrupt it |
| `supertag down` | Drains this machine's Worker Hosts, waits for running Task Attempts, and stops every service |
| `supertag down --force` | Stops without waiting for running Task Attempts |
| `supertag ps` | Lists this machine's services and their state |
| `supertag logs -f` | Follows the service logs; name `control-plane`, `gateway`, or a host to narrow them |
| `supertag config` | Prints the resolved `supertag.yaml`, or every problem in it |
| `supertag status` | Shows Worker Hosts, Tags, unfinished Objectives, and the operator inbox |
| `supertag version` | Prints this CLI's version and the version of the running services |

Run `supertag up` again after editing `supertag.yaml`. It restarts only the services that
changed and waits for their running Task Attempts unless you pass `--force`. After you install a
new CLI, `supertag up` restarts services that run another build with the new one; see
[Upgrade](install.md#upgrade).

### Run as a service

A service with `restart: unless-stopped` makes `supertag up` install a per-user service unit
(launchd on macOS, systemd on Linux) that starts SuperTag again after a failure or a login.
`supertag down --remove-services` also uninstalls the unit.


### Try another harness

A Tag keeps the harness it was created with, so `lead` can't switch from Claude Code to Codex.
To try another harness, add it to the host and create a second Tag on it. Add the harness to the
host's `harnesses` in `~/.supertag/supertag.yaml`, for example `harnesses: [claude-code, codex]`,
then run:

```sh
supertag up
supertag tag put codex-lead --harness codex --workspace-id WORKSPACE --workspace-ref BRANCH \
  --allow files:read --allow files:write --allow commands:execute --allow web:fetch
```

`WORKSPACE` is the name `init` gave the Workspace, under the host's `workspaces`, and `BRANCH` the
branch its Sessions start from. To start over
instead, run `supertag down` and move `~/.supertag` aside before `supertag init`; that also leaves
your Tags and conversations behind.

### Let the lead run commands

A Claude Code, Cursor, or OpenCode lead set up without commands reads and edits files but runs
none. To let it run commands, first choose where they run on the host in
`~/.supertag/supertag.yaml`: `environment: local-vm` with Docker running, or
`allow-unsandboxed-commands: [claude-code]` (or the harness's name) to run them on this machine as
you. Then grant `commands:execute` in the lead's Permission Set and restart the services.
`--force-conflicts` is needed because `init` created the set; the `&&` stops before `up` if the
apply fails:

```sh
supertag apply --set provision --force-conflicts -f - <<'END' &&
apiVersion: supertag/v1
kind: PermissionSet
metadata: { name: local-tools }
spec:
  permissions:
    - { target: runtime, action: commands:execute }
    - { target: runtime, action: files:read }
    - { target: runtime, action: files:write }
    - { target: runtime, action: schedule:create }
END
supertag up
```

`supertag up` creates provisioned resources only when they are missing, so the older
`local-tools` entry under `provision` in `supertag.yaml` doesn't take the grant away; add
`commands:execute` there too to keep the file in step. Granting `commands:execute` without a
place to run the commands makes every Task of the lead wait, with `unsandboxed-commands` in
`supertag placement explain`.

## Talk to a Tag

The terminal UI is the place for conversations. Plain `supertag` opens it for your local
services; `supertag tui --gateway NAME` opens it for a saved Control Plane. See
[Talk to a Tag from your terminal](../guides/talk-to-a-tag.md).

The terminal UI and the desktop app find the local Control Plane on their own. While
`supertag up` runs one from `SUPERTAG_STATE_DIR` or `~/.supertag`, each lists it as **Local**
and connects with the local operator token, with nothing to enter. With no saved Control Plane
last used, each opens Local at launch. The token is read at each connect and never saved. When no
local Control Plane runs, they say so, name `supertag up`, and offer the saved Control Planes.

## Send messages from the CLI

`task submit` sends one turn of work to a Tag. A new Session name starts a new conversation;
reusing it continues one:

```sh
supertag task submit --tag lead --session first-look \
  "Read this repository and tell me what you would improve first."
```

It prints the Task as JSON, including its `task_id`. Follow and steer it:

```sh
supertag watch task
supertag task events TASK_ID
supertag task input TASK_ID "Focus on the payment module."
supertag task cancel TASK_ID
```

`task input` delivers a message to a running Task, or queues it as the Session's next turn when
the Task cannot take it. `describe task TASK_ID` explains a Task that is waiting, such as one
with no Worker Host that may run its Tag, and `placement explain TASK_ID` lists which bound
Worker Hosts can take it and why the others cannot.

`task submit` also takes execution limits, such as `--max-reported-tokens`. A limit the Tag's
harness cannot enforce is refused at submission, with the limits that harness supports.

## See what your organization is doing

`get KIND` lists a kind of resource as JSON, and `get KIND ID` reads one. `describe KIND ID`
prints one in readable text:

```sh
supertag get tag
supertag describe objective flaky-tests
supertag get host
supertag watch objective flaky-tests
```

`watch` streams change notices and reconnects from its last resume token. `watch objective ID`
follows one Objective as a timeline until it closes. `supertag metrics` prints counts of Tasks,
usage, Worker Host capacity, backlogs, and how long recent Task Attempts took from start to a ready
Workspace, an attached harness, and the harness's first event, and from the harness finishing to
the result being reported.

## Organize Tags

Create or change a Tag directly:

```sh
supertag tag put reviewer --instructions "Review changes for correctness and tests." \
  --allow files:read --harness claude-code
```

For anything larger, keep your organization in manifest files and apply them. `diff` previews
the change:

```sh
supertag diff -f organization.yaml
supertag apply -f organization.yaml
```

See [Manage Control Plane resources](resources.md) for manifests and apply sets, and
[Organize Tags into Teams](../guides/teams.md) for Teams.

## Give a Tag an Objective

```sh
supertag objective create flaky-tests \
  "The checkout tests pass ten runs in a row. Evidence: links to the CI runs." \
  --owner lead --team core --deadline 2026-12-01T17:00:00Z \
  --budget-minor 2000 --currency USD
supertag watch objective flaky-tests
```

The ID comes first and is yours to choose. See [Write an Objective](../guides/write-an-objective.md)
and [Define and complete an Objective](../guides/objectives.md).

## Answer what is waiting on you

```sh
supertag get inbox-item
supertag watch inbox-item
supertag question answer TASK_ID "Use the staging database."
supertag approval approve APPROVAL_ID
supertag approval deny APPROVAL_ID --reason "Not before the release freeze."
supertag objective review flaky-tests approve
```

`watch inbox-item` prints each item once as it appears, until you stop it.
`question answer TASK_ID -` reads the answer from standard input, which keeps a long or sensitive
answer out of the shell history and the process list. See
[Respond to an Objective](../guides/objective-decisions.md).

## Bring delivered work into your repository

A Task that changes a Workspace delivers its commits as the branch `supertag/session/HASH`, one
branch per Session. The Worker Host that ran the Task writes it into the repository it maps for a
local Workspace, or pushes it to a remote Workspace's git server, where you `git fetch` it. See [Work in a repository with Workspaces](../guides/workspaces.md).

## Spend and audit

```sh
supertag spend --by tag
supertag audit --since 2026-11-01
```

`spend` reports recorded spend by Objective, Tag, or day. `audit` lists operator changes, newest
first, with who made them.

## Join a teammate's Control Plane

Save a shared Control Plane under a name. `connect` reads one secret, from
`SUPERTAG_OPERATOR_TOKEN` or a masked prompt:

- an **Operator Token** an administrator issued you with `supertag operator-token create`; or
- a client **Auth Key** (`stak_...`) from `supertag auth-key create NAME --role client`, which
  enrolls this device as `client:NAME` and saves only the device's own credential.

```sh
supertag connect https://supertag.example.com --name team
supertag get objective --gateway team
supertag tui --gateway team
```

The terminal UI and the desktop app read the same saved names. Add `--server-ca-file` when the
Control Plane's certificate comes from a private CA. See
[Manage a remote Control Plane](control-plane.md#manage-a-remote-control-plane).

## Output and errors

`get` prints JSON. `describe`, `status`, `ps`, `watch`, `spend`, `metrics`, and `audit` print
readable text, or JSON with `--output json`. A usage error exits with status 2 and names the
missing or unknown argument with the command's usage line.

## Next

- [CLI reference](../reference/cli.md)
- [Manage Control Plane resources](resources.md)
- [Run Worker Hosts](../guides/workers.md)
