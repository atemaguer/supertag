# Troubleshoot the first reply

Trace a request from where someone asked a **Tag**, a persistent AI actor with its own
responsibilities and permissions, to the **Worker Host** that runs it and back. Work through the
steps in order; each checks one layer. Terms are defined in the [glossary](../reference/glossary.md).

Commands talk to a **Gateway**, which forwards them to the **Control Plane**, the service that
stores your organization. Without `--gateway NAME`, they use this machine's local services, as
shown.

If you asked in the terminal UI, the desktop app, or with `supertag message`, skip steps 2 and 3:
they cover Slack, GitHub and other surfaces. Start with step 1, then find the Task with `supertag watch task` while you send the
message again, and continue at step 5.

## 1. Check the services

```sh
supertag ps
supertag status
```

`ps` should show `control-plane`, `gateway`, and each host as `running`. The CLI, the terminal
UI, and the desktop app all connect through the Gateway. If `ps` says SuperTag isn't set up on
this machine yet, run `supertag init` in your git repository. If a service stopped, run `supertag up` and read its log with
`supertag logs control-plane`, `supertag logs gateway`, or `supertag logs HOST`. For a shared
deployment, run `supertag verify deployment URL --env-file operator.env`.

`supertag up` runs every local service under one supervisor. When any of them exits on its own,
the supervisor stops the rest and exits too, so `ps` shows them all stopped and
`supertag logs supervisor` names the service that exited first. Read that service's log, then
run `supertag up` to start them all again. The desktop app shows **Not connected** meanwhile and
reconnects on its own, and messages you sent in the meantime are sent once SuperTag runs again.
To have SuperTag started again after a failure without you, set `restart: unless-stopped`; see
[Run as a service](../operations/cli.md#run-as-a-service).

If a command says `no local Gateway is running`, start the local services with
`supertag up`, or pass `--gateway URL` or the `--gateway NAME` of a saved
Gateway. If it says SuperTag isn't set up on this machine yet, there is no `supertag.yaml` in the
state directory: run `supertag init` in your git repository first.

If `supertag up` says another program is using an address, such as `127.0.0.1:3434`, stop that
program, or choose another port under `services.control-plane.ports` in `supertag.yaml` before
the first `supertag up`.

## 2. Check the Surface Account

```sh
supertag get surface-account
supertag logs gateway
```

The account must exist, be enabled, and name the Gateway that serves it. If it is missing, run
`supertag setup surface PROVIDER` against the same Control Plane. Then check that events arrive:

- Lark, and Slack in Socket Mode, keep a long connection; the Gateway log shows it connecting.
- GitHub, Linear, Microsoft Teams, and Slack without Socket Mode send webhooks. The public HTTPS URL must forward to
  the Gateway's loopback listener and path, and the provider's delivery log should show success.
  A failed signature check is refused before anything is stored.

Invite the app or bot to the channel; enrolling an account does not add it.

## 3. Check the Tag locations

```sh
supertag get surface-location
```

A mention starts work only at an enabled location for the exact channel, repository, chat, or
team ID, and only from an allowed user when the location restricts them. Add a location with
`supertag tag update TAG --add-location PROVIDER ...`. Messages in unrelated threads, and replies
in threads that no mention started, are ignored by design.

## 4. Find the Task

Mention the Tag again while watching:

```sh
supertag watch task
supertag describe task TASK_ID
```

No Task means steps 2 and 3 failed. A refused request's reason is in the Gateway log, and a
refused Task's description names the missing permission.

## 5. Check placement

```sh
supertag placement explain TASK_ID
supertag get host
```

A queued Task waits until a ready Worker Host may run its Tag, carries the Tag's `runsOn` labels,
and serves its harness and model. `placement explain` names which is missing:

| Reason | Fix |
| --- | --- |
| No Worker Host may run the Tag | Start a host, or enroll one with an Auth Key that names the Tag |
| Hosts lack the required labels | `supertag placement runs-on TAG LABEL...`, or add the label to a host |
| No host serves the harness | Add the harness to a host's `harnesses` |
| `model`: no host lists the model the Task names | Add the model to a host's `models`, or choose a model a host lists |
| Hosts are busy or draining | Wait, raise `concurrency`, or `supertag host resume HOST` |
| An uncertain Task Attempt keeps a host's slot | Confirm it stopped, then run the `supertag task resolve-attempt` command it names |
| `unsandboxed-commands`: no host lets the harness run commands | Set `environment: local-vm` on a host, add the harness to a host's `allow-unsandboxed-commands`, or remove `commands:execute` |
| `file-scope`: the harness cannot enforce the Task's path scope | Run the Tag on a harness that can, or change the scope; see [Path scopes](../reference/iam.md#path-scopes) |
| `workspace-holder`: a Task waits for the Worker Host holding its Session's last delivery: a local Workspace continues only there, and a remote Workspace waits for that host to push the Session's branch | Start the host it names, or cancel the Task. To continue Sessions on any host, use a remote Workspace |
| `checkpoint-holder`: a queued Task waits up to 10 minutes for the Worker Host holding its Session's checkpoint | Nothing: the holder resumes it, or after the wait another host starts it from the recap |
| `network-scope`: the harness or host cannot enforce the Task's network scope, or no host offers its credential | Run the Tag on Codex, or on a Claude Code host that can run its sandbox (on Linux, install bubblewrap and socat); add the credential to a host's `network-credentials`; or change the scope; see [Network scopes](../reference/iam.md#network-scopes) |

Each entry under `hosts` also gives that Worker Host's own `requirement` and `reason` when none
of its Workers for the Task's harness could run the Task: `harness` when it runs no such
harness, or `model`, `unsandboxed-commands`, or `file-scope` as above. Use them to find the host to change.

## 6. Check the harness

A host that cannot sign in to its harness stops with the reason in its log. Check it the way the
host does:

```sh
supertag sign-in codex
supertag sign-in claude-code
```

If it reports not signed in, follow the sign-in instructions it prints, as the same user that
runs the host, and run `supertag up`. Keys belong in `~/.supertag/.env`: a service unit does not
inherit your shell. Claude Code, Cursor, and OpenCode Tasks that may run commands also need
`environment: local-vm` or `allow-unsandboxed-commands` on the host; see
[Run Worker Hosts](workers.md#harnesses-without-a-sandbox). A local-vm host whose Tasks fail to
start needs Docker running for the host's user. local-vm refuses Podman for now; switch the
host to Docker.
A Codex Tag on a code-mode-only model needs `web:fetch` as well as `commands:execute` to run
commands; see [Codex commands and models](../operations/requirements.md#codex-commands-and-models).

## 7. Check the run and the reply

```sh
supertag task events TASK_ID
supertag get reply
```

`task events` shows the run's progress and result: each line has a `kind`, `message` for what
the Tag wrote, `activity` for what it did, or `progress` for its plan. `get reply` shows whether
the Gateway delivered the reply. When a Task failed, `supertag logs HOST_NAME` shows why: the
Worklet logs the failure with the last lines its harness adapter wrote to standard error,
secrets hidden. When the Worklet itself failed the Task, for example because it could not
capture the output, the result is a fixed message and `supertag describe task TASK_ID` shows the
reason under the execution report's `failure_detail`: at most eight lines, secrets hidden, shown
to operators only and never in a reply, conversation, or client's view of the Task. A reply whose delivery is uncertain waits for
`supertag reply resolve REPLY_ID --decision ... --evidence ...` after you check the thread.

## A Task Attempt is uncertain

A Worklet that was killed or lost its execution lease while running a **Task Attempt**, one
execution of a Task, may not know whether the work finished. It shows in the inbox as
`task-attention`, in `supertag metrics` under recovery, and in `supertag ps`. The Worker Host's log
names it, and the host's slot for its harness stays taken until you decide, so later messages to
Tags on that host wait. Check what the Task Attempt did, then record a decision:

```sh
supertag task resolve-attempt TASK_ID ATTEMPT_ID --decision failed \
  --evidence "The process is gone and no commit was delivered." --confirmed-stopped
```

`--decision retry` runs the Task again. See
[Scheduling and interrupted execution](../reference/scheduling-and-recovery.md).

## A Task failed because the repository changed

A Task Attempt fails when the repository's Git configuration, hooks, or attributes changed while
it ran, because SuperTag's own Git commands must not run anything a Task wrote. Restore the
repository's configuration and send the work again.

## Next

- [Run Worker Hosts](workers.md)
- [Connect a collaboration surface](../surfaces/README.md)
