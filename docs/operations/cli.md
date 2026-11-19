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
| `--gateway NAME` | A Gateway saved under `NAME` by `supertag connect` or the desktop app |
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
- a `host` service named after this machine, which maps the repository as a Workspace, runs
  every harness `init` found signed in, the lead's first, so Tags you create later can use any
  of them, and runs up to three Task Attempts at once across those harnesses (`concurrency: 3`),
  so one stuck Task does not hold every Tag.

Codex sandboxes its own commands. A Claude Code lead runs its commands in Claude Code's own
sandbox wherever that sandbox can start (macOS, or Linux with bubblewrap and socat) and the
installed `claude` is 2.1.323 or later: `init` sets `sandbox-commands: [claude-code]` on the host
and grants `commands:execute`, without asking. See
[Sandboxed Claude Code commands](../reference/supertag-yaml.md#sandboxed-claude-code-commands).
Where it can't, `init` says why. Cursor and OpenCode have no sandbox of their own, so for them,
and for Claude Code without its sandbox, `init` asks how the lead may run commands, defaulting to
not at all:

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

The `local-tools` Permission Set grants `files:read`, `files:write`, and `schedule:create`, which lets
the lead set [Schedules](../reference/coordination.md#schedules), wake-ups for itself, plus `commands:execute` when the host may run
the lead's commands, which it always may on Codex. It also grants `web:fetch` on every harness but
Cursor, which has no tool for reading web pages, and `init` says so: the lead can read web pages, and its commands can reach the network. Web pages
can carry instructions, so for a lead that handles secrets, remove `web:fetch` from
`supertag.yaml` and run `supertag up`. Current Codex models also need it: they run commands only in
Codex code mode, which SuperTag starts only for Tasks that may also fetch from the web. To keep a
Codex lead offline, also select a Codex model that is not code-mode-only; see
[Codex commands and models](requirements.md#codex-commands-and-models). A lead whose commands run in
local-vm containers gets no `web:fetch`: the containers have no network, and run no Task that may
fetch from any site. A `web:fetch` with a
[network scope](../reference/iam.md#network-scopes) lets its commands reach the sites it names.

Each new Session of `lead` starts from that branch's current commit (`workspace.ref`), so commits
you make there reach the next Session. When HEAD is detached, `init` pins the checked-out commit
(`workspace.baseCommit`) instead and says so. To follow another branch or pin a commit, apply a
Tag manifest; see
[Work in a repository with Workspaces](../guides/workspaces.md#2-bind-a-tag-to-the-workspace).

`supertag init --yes` accepts every default. See [supertag.yaml and local state](../reference/supertag-yaml.md)
for the file.

A script or app can run `init` without a terminal:

- `supertag init --check --json --directory PATH` prints what `init` would find, and changes
  nothing: whether `PATH` is a Git repository with commits, and its branch; for each harness
  (Codex, Claude Code, Cursor, OpenCode), whether it is installed, signed in with the credentials
  a Worker Host would use, and, for a harness that runs through Node.js, whether that Node.js and
  the Node bridge installed beside `supertag` can run it; and whether `~/.supertag/supertag.yaml` exists and already maps the repository. Each
  problem carries one plain `fix` line and, when the fix is a command, that command as
  `fix_command`; each harness also has an `install_url`. A sign-in check that takes longer than 30
  seconds is reported as unknown. `ready` is true when the folder and at least one checked harness
  are usable. Add `--harness codex` to check only that harness. Without `--json`,
  `supertag init --check` prints the same findings as readable text.
- `supertag init --yes --harness codex --directory PATH` (or `--harness claude-code`) sets up that
  folder with that harness for the lead and starts SuperTag, as `init` does; the host also runs
  the other installed harnesses that are signed in. It stops before writing anything when the
  named harness is not installed or not signed in. On a machine that is already set up, it adds
  the folder as described in [Add another repository](#add-another-repository), and the Tag uses
  the lead's harness. With `--json`, it prints one object: the Tag, Workspace, harness, and
  Control Plane address on success, or `error`, `fix`, and `fix_command` with a non-zero exit
  status on failure. Its progress goes to standard error.

### Run and stop SuperTag

| Command | Does |
| --- | --- |
| `supertag up` | Starts the services in `supertag.yaml` in the background and returns when they are ready |
| `supertag up --foreground` | Runs them in this terminal, with their logs, until you interrupt it |
| `supertag down` | Drains this machine's Worker Hosts through their Worklets, waits for running Task Attempts, and stops every service |
| `supertag down --force` | Stops without waiting for running Task Attempts |
| `supertag ps` | Lists this machine's services and their state, and under each Worker Host its running Workers |
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


### Add another repository

Run `supertag init` in another repository to add it. On a machine that is already set up, `init`
offers, defaulting to yes, to add the repository as a Workspace of the local host and to create a
Tag named after it, on the lead's harness and Roles, that works in it. It then restarts the
services. Talk to that Tag to work in that repository. If you have edited `supertag.yaml` by hand
(comments, variables, or several local hosts), `init` leaves the file alone and prints the steps
instead.

To add a repository as a Workspace without creating a Tag for it, run `supertag workspace add`
with its folder:

```sh
supertag workspace add ~/code/site
```

It checks that the folder is in a Git repository with a commit, adds the repository under the
local host's `workspaces` in `~/.supertag/supertag.yaml`, named after its folder (`--name` picks
another name), and restarts the changed services as `supertag up` does. It then prints the
`supertag tag put` command that creates a Tag working in it, following the branch checked out
there. A repository the host already maps is left as it is. The desktop app's New Tag form runs
the same command when you choose **Choose a folder…** as the Workspace.

### Try another harness

A Tag keeps the harness it was created with, so `lead` can't switch from Claude Code to Codex.
To try another harness, create a second Tag on it, for example with **+** in the desktop app,
whose New Tag form offers every harness this machine's Worker Hosts run. Its **Web access**
switch, on by default, grants the new Tag `web:fetch`. It starts off for a harness whose hosts run
Tasks only in sandboxes without network, and stays off for Cursor. `init` gives the host
every harness it found signed in. Run `supertag init` again to add one you signed in to later:
on a machine that is already set up, it offers, defaulting to yes, to add each signed-in harness
the host does not run yet. To do it by hand, add the harness to the host's `harnesses` in
`~/.supertag/supertag.yaml`, for example `harnesses: [claude-code, codex]`, then run:

```sh
supertag up
supertag tag put codex-lead --instructions "Work in this repository." \
  --harness codex --workspace-id WORKSPACE --workspace-ref BRANCH \
  --allow files:read --allow files:write --allow commands:execute --allow web:fetch
```

`WORKSPACE` is the name `init` gave the Workspace, under the host's `workspaces`, and `BRANCH` the
branch its Sessions start from. To start over
instead, run `supertag down` and move `~/.supertag` aside before `supertag init`; that also leaves
your Tags and conversations behind.

### Let the lead run commands

A Claude Code, Cursor, or OpenCode lead set up without commands reads and edits files but runs
none. To let it run commands, first choose where they run on the host in
`~/.supertag/supertag.yaml`: for Claude Code, `sandbox-commands: [claude-code]` to run them in its
own sandbox; `environment: local-vm` with Docker running; or
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

`supertag message` talks to a Tag from the terminal; see
[Send messages from the CLI](#send-messages-from-the-cli) and
[Talk to a Tag from your terminal](../guides/talk-to-a-tag.md). The desktop app gives your
conversations a window of their own.

The desktop app finds the local Control Plane on its own. While `supertag up` runs one from
`SUPERTAG_STATE_DIR` or `~/.supertag`, it lists it as **Local** and connects with the local
operator token, with nothing to enter. With no saved Control Plane last used, it opens Local at
launch. The token is read at each connect and never saved. When no local Control Plane runs, it
says so, names `supertag up`, and offers the saved Control Planes. When SuperTag isn't set up in
that state directory yet, it names `supertag init` instead, as `supertag ps` and every operator
command do. At launch, when SuperTag is set up in that state directory
but its services are stopped, and no saved Control Plane was last used, it shows "Starting
SuperTag…", runs `supertag up` itself with your login shell's `PATH` (the copy bundled with the
app, else the one on that `PATH` or in `~/.local/bin`), and connects. If that `supertag` is another version than the app's, the app says so and names
the install command instead of starting it. If `up` fails, the app shows what it printed and
where the logs are.

## Send messages from the CLI

`message` sends a message to your conversation with a Tag, the same conversation the desktop app
shows. It waits for the reply and prints the Tag's messages as they arrive:

```sh
supertag message lead "What changed in the payment module this week?"
git diff | supertag message lead
supertag message lead "Start on the release notes." --no-wait
```

Without the text, `message` reads the message from standard input. `--no-wait` returns once the
message is accepted; the reply shows in the conversation. The command fails when the Tag's turn
fails, and prints why.

The reply goes to standard output. Anything else goes to standard error, with the command to run
next:

- The Tag's turn waits for your approval. Decide it with `supertag approval approve ID` or
  `supertag approval deny ID --reason TEXT`, and the command keeps waiting for the reply.
- The turn finished by asking you a question. The command prints the reply, names
  `supertag question answer TASK_ID TEXT`, and exits 0.
- The message was sent into a turn that was already running, and its delivery is uncertain. The
  command keeps waiting, because operator recovery may still deliver it.
- The connection to the Gateway is lost. The command says so, and says again when the connection
  is back. After 5 minutes without the Gateway, it exits non-zero. The reply still shows in
  the conversation.

`task submit` sends one turn of work to a Tag in a Session you name. A new Session name starts a
new Session; reusing it continues one. These Sessions are separate from your conversation with
the Tag, and don't appear in the desktop app. `task submit` refuses that
conversation's own Session and suggests `message` instead. Start a separate Session like this:

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
supertag get task --tag lead
supertag describe objective flaky-tests
supertag get host
supertag watch objective flaky-tests
```

`get task` without an ID lists the Tasks you may see, newest first, 20 at a time; `--tag` and `--session`
narrow it, and `--cursor` with the `next_cursor` it returns reads the next page.

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
branch per Session. The Worklet that ran the Task writes it into the repository its host maps for a
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
```

Commands also read the names the desktop app saves. Add `--server-ca-file` when the
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
