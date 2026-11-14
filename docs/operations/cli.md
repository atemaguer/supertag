# Direct work with the CLI

The `supertag` command sets up this machine, runs SuperTag's services, and directs the work of
your Tags, the persistent AI actors with their own responsibilities and permissions. This page is
a tour by task. Every command and flag is listed in the [CLI reference](../reference/cli.md).

Terms used here: the **Control Plane** stores your organization and schedules its work. A
**Worker Host** is a machine or sandbox that runs that work. A **Task** is one turn of a Tag's
work in a **Session**, one thread of work. An **Objective** is an outcome a Tag owns until it is
met. See the [glossary](../reference/glossary.md) for other terms.

## How commands find the Control Plane

Commands that read or change your organization talk to one Control Plane. Name it on each
command:

| You pass | Commands use |
| --- | --- |
| `--state-directory ~/.supertag` | The Control Plane that `supertag up` runs on this machine, with this machine's local operator credential |
| `--control-plane NAME` | A Control Plane saved under `NAME` by `supertag connect`, the terminal UI, or the desktop app |
| `--control-plane https://HOST` or `wss://HOST` | That Control Plane, with the Operator Token in `SUPERTAG_OPERATOR_TOKEN` |

`--control-plane` may also come before the command, as in `supertag --control-plane team get tag`.
The examples on this page use your local services. Against a shared Control Plane, replace
`--state-directory ~/.supertag` with `--control-plane NAME`.

`supertag status`, `supertag tag update`, and `supertag setup surface` default to the local
services when you name neither.

## Start in a repository

Run `supertag init` from a Git repository with at least one commit:

```sh
cd ~/code/app
supertag init
```

`init` finds the harnesses on your `PATH`, checks each one's sign-in with the credentials a
Worker Host will have, and asks for a Control Plane port, a harness, and the Tag's name. It writes
`~/.supertag/supertag.yaml` with two services and starts them in the background:

- a `control-plane` service, which also creates a `local-tools` Permission Set, a `Lead` Role,
  and the `lead` Tag, bound to the repository's Workspace at the commit checked out when `init`
  ran; and
- a `host` service named after this machine, which maps the repository as a Workspace.

New Sessions of `lead` start from that commit. To move them to a newer one, put the binding again
with `supertag tag put lead --workspace-id ID --workspace-base COMMIT`; see
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
changed and waits for their running Task Attempts unless you pass `--force`.

### Run as a service

A service with `restart: unless-stopped` makes `supertag up` install a per-user service unit
(launchd on macOS, systemd on Linux) that starts SuperTag again after a failure or a login.
`supertag down --remove-services` also uninstalls the unit.

## Talk to a Tag

The terminal UI is the place for conversations. Plain `supertag` opens it for your local
services; `supertag tui --control-plane NAME` opens it for a saved Control Plane. See
[Talk to a Tag from your terminal](../guides/talk-to-a-tag.md).

## Send messages from the CLI

`task submit` sends one turn of work to a Tag. A new Session name starts a new conversation;
reusing it continues one:

```sh
supertag task submit --tag lead --session first-look \
  "Read this repository and tell me what you would improve first." \
  --state-directory ~/.supertag
```

It prints the Task as JSON, including its `task_id`. Follow and steer it:

```sh
supertag watch task --state-directory ~/.supertag
supertag task events TASK_ID --state-directory ~/.supertag
supertag task input TASK_ID "Focus on the payment module." --state-directory ~/.supertag
supertag task cancel TASK_ID --state-directory ~/.supertag
```

`task input` delivers a message to a running Task, or queues it as the Session's next turn when
the Task cannot take it. `describe task TASK_ID` explains a Task that is waiting, such as one
with no Worker Host that may run its Tag.

## See what your organization is doing

`get KIND` lists a kind of resource as JSON, and `get KIND ID` reads one. `describe KIND ID`
prints one in readable text:

```sh
supertag get tag --state-directory ~/.supertag
supertag describe objective flaky-tests --state-directory ~/.supertag
supertag get host --state-directory ~/.supertag
supertag watch objective flaky-tests --state-directory ~/.supertag
```

`watch` streams change notices and reconnects from its last resume token. `watch objective ID`
follows one Objective as a timeline until it closes. `supertag metrics` prints counts of Tasks,
usage, Worker Host capacity, and backlogs.

## Organize Tags

Create or change a Tag directly:

```sh
supertag tag put reviewer --instructions "Review changes for correctness and tests." \
  --allow files:read --harness claude-code --state-directory ~/.supertag
```

For anything larger, keep your organization in manifest files and apply them. `diff` previews
the change:

```sh
supertag diff -f organization.yaml --state-directory ~/.supertag
supertag apply -f organization.yaml --state-directory ~/.supertag
```

See [Manage Control Plane resources](resources.md) for manifests and apply sets, and
[Organize Tags into Teams](../guides/teams.md) for Teams.

## Give a Tag an Objective

```sh
supertag objective create flaky-tests \
  "The checkout tests pass ten runs in a row. Evidence: links to the CI runs." \
  --owner lead --team core --deadline 2026-12-01T17:00:00Z \
  --budget-minor 2000 --currency USD --state-directory ~/.supertag
supertag watch objective flaky-tests --state-directory ~/.supertag
```

The ID comes first and is yours to choose. See [Write an Objective](../guides/write-an-objective.md)
and [Define and complete an Objective](../guides/objectives.md).

## Answer what is waiting on you

```sh
supertag get inbox-item --state-directory ~/.supertag
supertag question answer TASK_ID "Use the staging database." --state-directory ~/.supertag
supertag approval approve APPROVAL_ID --state-directory ~/.supertag
supertag approval deny APPROVAL_ID --reason "Not before the release freeze." --state-directory ~/.supertag
supertag objective review flaky-tests approve --state-directory ~/.supertag
```

`question answer TASK_ID -` reads the answer from standard input, which keeps a long or sensitive
answer out of the shell history and the process list. See
[Respond to an Objective](../guides/objective-decisions.md).

## Bring delivered work into your repository

A Task that changes a Workspace delivers its commits. For a Workspace that `supertag.yaml` maps,
`supertag up` imports each delivery into the repository as the branch `supertag/session/SESSION`,
one branch per Session. Import a delivery yourself, or into another clone, with `fetch`:

```sh
supertag fetch TASK_ID --repository ~/code/app --state-directory ~/.supertag
supertag task download TASK_ID --kind patch --output change.patch --state-directory ~/.supertag
```

See [Work in a repository with Workspaces](../guides/workspaces.md).

## Spend and audit

```sh
supertag spend --by tag --state-directory ~/.supertag
supertag audit --since 2026-11-01 --state-directory ~/.supertag
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
supertag get objective --control-plane team
supertag tui --control-plane team
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
