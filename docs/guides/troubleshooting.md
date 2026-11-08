# Troubleshoot the first reply

Use this checklist when a new SuperTag installation does not reply, replies
only with the smoke-test message, or leaves a **Task**—one accepted request or assignment—pending.

The **Control Plane** is the SuperTag service that receives requests and schedules work. A
**collaboration surface** is an external work tool, such as Slack or GitHub, where SuperTag meets
people; a **Surface Account** is one connected workspace or account there. A **Tag** is a persistent
AI identity with its own responsibilities and permissions. A **Worker Host** is a machine,
container, VM, or sandbox that provides execution capacity. Its **Worklet** connects it to the
Control Plane, and a **Worker** on it completes Tasks.

If the service and execution terms are new, start with
[How SuperTag fits together](../concepts/how-it-works.md).

## 1. Check the Control Plane

```sh
supertag status control-plane
```

For a hosted Control Plane, also check its endpoints:

```sh
curl --fail https://YOUR-GATEWAY/healthz
curl --fail https://YOUR-GATEWAY/readyz
```

`healthz` confirms that the process is alive. `readyz` confirms that the
Control Plane can admit work and that required collaboration surface and Worklet dependencies are
ready. A hosted CLI must first be connected with `supertag connect control-plane`.

## 2. Check the Surface Account

```sh
supertag list surface
```

Confirm that the expected workspace is connected. If it is
missing or disconnected, run `supertag setup surface PROVIDER` again, or apply its
SurfaceAccount manifest again. Both replace credentials safely; do not put tokens on the command
line or in a manifest.

For Slack Socket Mode, the app must be installed in the same workspace, invited
to the channel, and running with both the bot token and app-level token. Hosted
HTTP collaboration surfaces need a public HTTPS callback at the exact path shown in their
collaboration surface guide.

## 3. Check the Tag locations

```sh
supertag list tag
supertag describe tag engineering
```

The Tag's `LOCATIONS` output must include the exact channel, repository, chat, or team where the
request originated. Stable provider IDs matter; a display name is not enough.

Start a new conversation by mentioning the actual `@SuperTag` app identity.
After SuperTag has replied in that thread, ordinary human replies continue the
same **Session**, the group of Tasks from one conversation, without another mention.

<a id="4-separate-surface-testing-from-worker-testing"></a>

## 4. Separate collaboration surface testing from Worker testing

To test the collaboration surface alone, start a Control Plane with `supertag start control-plane` and connect
no Worklet. Its default embedded responder answers every mention with a fixed smoke-test reply.
That proves ingress, Tag routing, durable admission, and reply delivery without requiring a model
login. If the smoke-test reply arrives but a setup from `supertag init` stays silent, the collaboration surface
works and the problem is the Worker Host. Run `supertag ps` to see whether the **host service**,
the `host` entry in `supertag.yaml` that connects the machine as a Worker Host, is connected, and `supertag logs -f HOST_SERVICE` for its log.

For request-specific answers, you need a connected Worker Host. Follow the Worker Host
enrollment setup in [Run a Worker](workers.md), then connect a Worklet whose
profile matches the Tag:

```sh
supertag list worker-host
supertag connect worklet --transport websocket \
  --harness codex \
  --workspace /absolute/path/to/codebase \
  --worker-profile local-codex
```

If the Worklet is disconnected, or its Worker Host is unready, draining, at
capacity, or advertises a different profile or required Context type, the
Control Plane leaves the Task pending instead of sending it to an incompatible
Worker.

## 5. Inspect the Task

```sh
supertag list task
supertag events task TASK_ID
```

- No Task usually means collaboration surface delivery, mention detection, account
  selection, or Tag routing failed.
- A pending Task usually means no compatible Worker Host is ready. See
  [A Tag stops answering](#a-tag-stops-answering).
- A failed **Task Attempt**, one execution of a Task, includes a bounded error in its events. Check
  authentication for the **harness** (the coding agent that runs the Task, such as Codex or Claude
  Code), workspace access, Context Resolver support, and Worker-local
  tool credentials.
- A completed Task without a visible reply points to collaboration surface egress or
  provider delivery failure.

Never share the output of credential files while troubleshooting. Control Plane
collaboration surface credentials, administrative tokens, Worker Host credentials, and
Worker tool credentials are separate secrets.

## 6. Match a specific symptom

### Claude Code or Codex is missing or too old

SuperTag runs the `claude` and `codex` CLIs installed on the Worker Host, and each must be at least
the version SuperTag's SDK targets. `supertag init` and `supertag up` stop with a message such as
`Codex 0.150.0 is older than 0.156.0, the oldest version SuperTag supports` and the command to fix
it:

- **Claude Code:** `claude update`, or `npm install -g @anthropic-ai/claude-code`.
- **Codex:** `npm install -g @openai/codex`.

Install the CLI as the OS user that runs the host, so it is on that user's `PATH`, then run the
command again. To stop serving a harness instead, remove it from the host service's `harnesses` in
`supertag.yaml`. See [harness requirements](../operations/requirements.md#choose-and-sign-in-to-a-harness).

### A harness is not signed in

`supertag init` labels each installed harness `signed in` or `not signed in` at selection.
The menu gives sign-in instructions for each unsigned harness and selects only signed-in harnesses
by default. If no selected harness passes, setup stops. On the Worker
Host, sign in as the OS user running the host service:
run `codex login` for Codex, run `claude` and follow its sign-in prompt for Claude Code, set
`CURSOR_API_KEY` for Cursor, or set your provider's API-key environment variable for the OpenCode host service. See
[harness sign-in](../operations/requirements.md#choose-and-sign-in-to-a-harness).

Before completing setup, `init` prints `not signed in (the credential check did not succeed)`
for a failed check. Change the setup to select only harnesses you have signed in to, or complete
sign-in and run `supertag init` again.

For Codex file-backed sign-in, `signed in` only checks that a credential is present and readable.
It cannot confirm account access. Run Codex once as the host service's OS user to confirm access.

### A host with a remote environment cannot start

A host service's `environment` puts workspace tools in e2b or Modal. Claude Code, Cursor, and Codex
keep their harness, model credentials, and native Session state on the Worker Host.
Check [Host environment](../reference/supertag-yaml.md#host-environment) against these refusals:

| Refusal | Fix |
| --- | --- |
| `allow-unsandboxed-commands` together with `environment` | Remove the opt-in from that service and run `supertag up`. Workspace commands use the remote sandbox. |
| `opencode cannot run with e2b environment` or `opencode cannot run with modal environment` | OpenCode would need its provider key inside the sandbox. Change `harnesses` to `claude-code`, `codex`, or `cursor`, or remove `environment` to run OpenCode locally. Then run `supertag up` again. |
| Explicit Codex `exec` mode together with a host environment | Remove the mode or select `app-server` in the application that starts the Worklet. Host services have no mode field in `supertag.yaml`. The sandbox runs `codex exec-server` and needs a matching Codex CLI binary. |
| Unsupported harness runtime and execution combination | Use a built-in split path for Claude Code, Cursor, or Codex. OpenCode requires colocated execution. Check the stated reason. |

If sandbox tools fail because a command is missing, add it to the image or the repository's
setup. Claude Code and Cursor split images need `python3` and POSIX shell tools, plus project
dependencies. Their harness executables and provider keys belong on the Worker Host.
See [Built-in harness paths](shared-execution.md#built-in-harness-paths) for disabled tools.

### A split Task refuses commands

When a Claude Code or Cursor Task resolves, the bridge refuses `commands:execute` without
`files:write`. Give the Task both actions in its **Permission Set**, its allowed actions, or
remove command permission. Commands can change workspace files.

### Cursor cannot start a Task

- **No key or invalid key:** Generate a key at [Cursor Dashboard → API Keys](https://cursor.com/dashboard/api),
  set `CURSOR_API_KEY` in `~/.supertag/.env`, then rerun `supertag init` or restart the host.
  Cursor's app and CLI sign-ins do not authenticate the SDK. A host that stops with
  `Cursor model listing failed` shows the reason after the colon. A rejected key during model
  listing or a Task reports `Cursor rejected CURSOR_API_KEY; replace the key`. See
  [Cursor setup](../operations/requirements.md#cursor-setup-and-limits).
- **Only `agent` is installed:** Another tool, including Grok, may own that binary name. The
  Cursor Worker uses the SDK and does not need the CLI. If checking a CLI login, use
  `cursor-agent` or verify that `agent` identifies itself as Cursor.
- **Local sandbox unavailable:** For colocated local execution, run the Worker on supported
  macOS or Linux with Cursor's OS sandbox available. The Worker refuses the run rather than
  widening its file or command access.
- **Unknown model:** Use an ID from `Cursor.models.list`. The refusal lists available IDs.
- **Unpriced usage:** Tokens can be recorded without a cost. For `auto`, SuperTag records
  provider-reported cost when available, but does not estimate one. Other models need provider
  cost or a published price. See [Cursor limits](../operations/requirements.md#cursor-setup-and-limits).

Alternatively, rerun `supertag init`, choose `Change the setup`, and remove the unsigned
harness at `Harnesses this machine serves`. If a Task already failed because a credential
expired after setup, create a new **Objective**, an outcome a Tag owns, with a new ID after restoring
sign-in. Changing
host configuration does not restart a failed Objective.

### supertag up stops before starting anything

`supertag up` checks `supertag.yaml` first. Run `supertag config` to see every problem at once,
each with its file, line, and column. An unset `${VAR}` without a default is an error; set it in
the environment or in `~/.supertag/.env`.

A service that starts as a service unit sees only a few environment variables, not your shell's.
When it works under `supertag up --foreground` but not after a login, move the variables it needs
to `~/.supertag/.env`.

### A Task is uncertain

`supertag describe task` says `Execution state: cleanup is unconfirmed; the recorded phase does
not establish current process activity.`, `supertag ps` lists the Task under `Uncertain:`, or the
operator inbox has a `task-attention` item about one. The Task Attempt may have
executed: for example, its Worker could not confirm cleanup in time. SuperTag will not run it again
on its own, and it keeps a Worker slot. Whoever waits on the Task has already been woken. Its
Session takes no new turn until SuperTag knows the execution stopped. See
[Uncertain Task Attempts](../reference/scheduling-and-recovery.md#uncertain-task-attempts).

First start the Worker Host again with its original state directory, if it is not running. When
the Worker can verify cleanup itself, it records the Task Attempt as stopped on reconnect. The
inbox item then goes away shortly after, and the Session's waiting turns run. In that case
`supertag recover worklet` refuses with `Attempt already has a terminal receipt`; there is nothing
left to recover.

Each of those places shows the reason and the exact recover command. To recover:

1. On the Worker Host that ran it, stop the host service first. A running host owns its journal,
   and the recover command refuses until it stops:

   ```sh
   supertag down laptop
   ```

2. Confirm that the Task Attempt's harness, tool processes, and any remote execution stopped.
   Reconcile external actions before you start replacement work.
3. Run the command that `describe task`, `ps`, or the inbox shows, with your reason:

   ```sh
   supertag recover worklet --worker-id local-codex --task TASK_ID --attempt ATTEMPT_ID \
     --confirm-stopped --reason "No codex process remains; nothing was pushed"
   ```

4. Start the host again with `supertag up laptop`.

To check that it worked, run `supertag describe task TASK_ID`. The Task now shows `failed`, with
its outcome recorded as unknown, and `Execution cleanup evidence: confirmed`. The inbox item is
gone, and the Session's waiting turns run. The Task itself never runs again; start new work if it
should continue.

### A Worker Host stays at capacity after a forced kill

A Worklet killed mid-Task Attempt can leave its slot reserved, so the Worker Host
shows no available capacity. Reconnecting or `supertag cancel task` alone does not
free it, because cancellation records intent only. The interrupted Task settles
as failed with an unknown outcome and never runs again. See
[Scheduling and interrupted execution](../reference/scheduling-and-recovery.md#reclaiming-capacity)
for why the slot stays reserved.

If a dispatch failed before the Worklet accepted the Task Attempt, reconnect the
original Worklet. The Control Plane checks its journal and automatically frees a
cancelled Task's slot when that Worklet reports the Task Attempt never started. Run
`supertag describe task TASK_ID` to see whether the cancelled Task still holds a
slot. An unavailable Worklet or unknown outcome still requires the cleanup steps below.

First restart the Worklet with its original state directory. For colocated
local execution, it can verify cleanup and reclaim the slot itself. If capacity
stays reserved, confirm cleanup yourself:

1. Stop the Worklet: `supertag down SERVICE` for a host service. The recover
   command refuses while a running host owns its journal. Verify that the Task Attempt's
   harness, tool processes, and any remote execution have stopped. A dead Worklet PID alone is not sufficient.
   Reconcile external actions before deciding whether to assign replacement
   work.
2. On the original Worker Host, keep the same state directory and identify the
   Task, Task Attempt, and Worker from `supertag describe task TASK_ID`. The default
   Codex Worker ID is `local-codex`; use the actual ID if you set `--worker-id`
   when connecting. For a host service, use the Worker ID that `describe task`
   shows; the command finds the host service's journal itself.
3. Record your confirmation, including how you verified cleanup:

   ```sh
   supertag recover worklet --worker-id local-codex \
     --task TASK_ID --attempt ATTEMPT_ID --confirm-stopped \
     --reason "Verified the original process groups and remote execution are stopped"
   ```

4. Reconnect the Worklet with its original configuration. Keep its journal.

To check that it worked, run `supertag describe worker-host HOST`. Its
`Recorded available slots` line counts the reclaimed slot once the Control
Plane releases the reservation; an active Task's lease may need to expire first. The command's rules are listed in
[Reclaiming capacity](../reference/scheduling-and-recovery.md#reclaiming-capacity).

### A remote Worklet keeps disconnecting

The Worklet stops reconnecting only when the Control Plane closes the
connection with a permanent code:

| Close code | Meaning | Worklet keeps retrying |
| --- | --- | --- |
| 4001 | Authentication timed out, or the first message was not authentication | yes |
| 4002 | Unsupported protocol version | no |
| 4003 | Authentication failed | no |
| 4004 | Invalid Worklet frame or hello | no |
| 4007 | Connection superseded or stale | no |
| 4008 | Worker Host credential revoked | no |

Every other code is transient. A hosting proxy that rewrites close codes, for
example to `1005`, turns a rejected credential into endless reconnects. In that
case, check the Worker Host credential directly.

### The CLI warns that versions differ

A command prints a line like this to stderr:

```text
Warning: this CLI is 0.3.0 but the Control Plane is 0.2.0-alpha.1, and SuperTag does not support this pair. Commands may fail; upgrade the Control Plane or use a matching CLI.
```

Your CLI and the Control Plane run different SuperTag releases. A newer CLI can send a field or
call a route that an older Control Plane does not know. That Control Plane then rejects the
request. In that case, the error ends with a hint that names both versions:

```text
SuperTag failed: Unknown field: start
Hint: this CLI is 0.3.0 but the Control Plane is 0.2.0-alpha.1, which may not support this request. Upgrade the Control Plane or use a matching CLI.
```

Run `supertag version` to see both versions and whether SuperTag supports the pair. Then upgrade
the older side, or install the CLI that matches the Control Plane. If the hint says the Control
Plane does not report its version, that Control Plane predates version reporting and is older
than your CLI.

The warning never goes to stdout, so `--output json` stays parseable. To silence it, for example
in CI, set `SUPERTAG_NO_VERSION_WARNING=1`. The supported pairs are in
[CLI and Control Plane versions](../reference/api-stability.md#cli-and-control-plane-versions).

### A Tag stops answering

A message gets no reply, and its Task stays pending. The Tag's turn is waiting for a Worker Host.
`supertag message tag` prints the reason once, and `supertag describe task` shows it:

```text
· waiting: no bound Worker Host provides MCP server notes
```

```sh
supertag describe task TASK_ID
```

```text
Last scheduling check: incompatible at 2026-11-07T09:14:02.118Z
Waiting: no bound Worker Host provides MCP server notes.
Unmet requirements: labels:mcp:notes
```

Fix what the reason names:

| Reason | Fix |
| --- | --- |
| `no bound Worker Host provides MCP server NAME` | Add the server to a bound host service's `mcp` map in `supertag.yaml` and run `supertag up`. See [host MCP servers](../reference/supertag-yaml.md#host-mcp-servers). |
| `MCP server NAME needs a login on its Worker Host` | Run `supertag mcp login NAME` on that host. |
| `no bound Worker Host has labels ...` | Connect a host with those labels, or change the Tag's `runsOn`. See [Worker Host labels](../reference/resource-model.md#worker-host-labels). |
| `the Tag has no Worker Host binding` | List a host in the Tag manifest's `spec.workerHosts` and apply it. |

A conversation turn needs only MCP servers a bound host declares. A server only a Workspace
provides never holds a turn; see [MCP server placement](../reference/iam.md#placement). A waiting
turn holds back only later turns of its own conversation, never other conversations.

### A Tag cannot send a message to another Tag

`send_message` is refused when the two Tags share no Team and the recipient has no grant for the
sender. Put both Tags in a Team, or grant the route. A grant is directional and says one thing:
this recipient accepts messages from this sender.

```sh
supertag grant mailbox RECIPIENT --sender SENDER
supertag list mailbox-grant --mailbox RECIPIENT
```

A send is also refused after 3 messages in one turn, or when the message would be the fifth hop
of a chain of messages that answer one another. See
[Allow the route](tag-messaging.md#2-allow-the-route).

## Next

- [Control Plane operations](../operations/control-plane.md) for deployment health and recovery
  details.
- [Scheduling and interrupted execution](../reference/scheduling-and-recovery.md) for how Worker
  Hosts are chosen and interrupted work is recovered.
- The [collaboration surface guides](../surfaces/README.md) for provider-specific setup.
