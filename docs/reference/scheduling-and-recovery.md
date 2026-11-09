# Scheduling and interrupted execution

This page states how the **Control Plane**, the service that stores and schedules work, picks a
**Worker Host** for a **Task**, and what happens when a **Task Attempt**—one execution of that
Task—is interrupted.

Other terms on this page are defined in the glossary: [Tag](glossary.md#tag),
[Role](glossary.md#role), [Objective](glossary.md#objective), [Team](glossary.md#team),
[Mailbox](glossary.md#mailbox), [host service](glossary.md#host-service),
[Auth Key](glossary.md#auth-key), [Worklet](glossary.md#worklet),
[Worker Profile](glossary.md#worker-profile), [Worker](glossary.md#worker), and
[Workspace](glossary.md#workspace).

For the implementer contract behind these rules, see
[Durable Worklet execution](worker.md#durable-worklet-execution). For the meaning of each stored
execution field, see [`WorkService`](operator-api/work.md) and
[Execution evidence](control-plane-api.md#execution-evidence). For
Objective-specific behavior after a restart, see
[After a Control Plane restart](coordination.md#after-a-control-plane-restart).

## Worker Host selection

A Tag may be bound to several Worker Hosts. The Control Plane limits and ranks that host pool
using policy, affinity, health, and reported capacity.

The eligible pool is the Tag's bound hosts that carry every label the Task requires: the Tag's
`runsOn` labels, plus `workspace:NAME` for a Task in a named Workspace. When no bound host
qualifies, the Task waits and records a `labels:...` scheduling requirement. Labels only narrow
the pool; they never add a host. See [Worker Host labels](resource-model.md#worker-host-labels).

A **durable wait** stores the conditions for resuming a Task, so a Control Plane restart does not
lose the wait.

Queue order:

- The Control Plane takes due turns by the time they became available, then by the order they
  were admitted, so the oldest due turn runs first.
- One Session runs one turn at a time. A second delivery into a Session waits until its current
  turn ends, and is then delivered as the Session's next Task.
- A Session's turn waits while its Objective is paused, completed or cancelled, and while turns
  across the Sessions of every Objective naming its Team already reach the Team's
  `maxConcurrency`. A held turn stays pending and consumes no Task Attempt.
- A Session runs at most four work Sessions at once; the rest queue.

Host and profile choice:

- Within an eligible Worker Host pool, required capabilities and an explicit profile are hard
  constraints.
- Preferred capabilities rank compatible profiles, and normalized load ranks hosts.
- Stable Worklet, Worker, and profile IDs break ties, so the same observations produce the same
  choice.
- The selected host's **Worklet**, the supervisor that connects the host to the Control Plane,
  then chooses a concrete Worker and compatible profile from current local capacity and briefly
  holds that slot.

Placement reservations:

- SuperTag records and pins the placement and its expiring reservation on the Task Attempt before
  dispatch.
- Acceptance consumes the reservation once.
- Expired or mismatched reservations are rejected before execution, and the Control Plane
  schedules a fresh Task Attempt.
- If Team, Tag, or approval checks decline the Task before a Task Attempt is created, the Control
  Plane releases the unused reservation immediately and records no Task event. Expiry remains
  the fallback for disconnections.

When no host can run the Task:

- If every bound host is temporarily unavailable, the Task remains queued.
- If the Tag has no bindings, SuperTag rejects the Task with instructions to bind a host.

`supertag describe task TASK_ID` shows the eligible Worker Hosts, selected Worker Host, Worklet,
Worker, and stored reservation phase. This is stored scheduling evidence; the command does not
contact the Worker Host.

## Waiting for capacity

Each Worker runs a limited number of Task Attempts at once. Built-in Workers derive the default from the machine: floor(min(CPU cores, memory in GB / 3) / 2),
kept from 2 through 8.
Set it with `concurrency` on a [host service](supertag-yaml.md#host-concurrency), or with
`supertag connect worklet --concurrency N`. A Worker Host's capacity is the sum over its Workers.
A host service takes a changed `concurrency` without a restart. It reports the new limit to the
Control Plane at once, and scheduling uses it from then on.

Each Worker also has one **coordination slot** beyond its concurrency. A conversation's turn,
including its report turns, may use it, so a Tag still answers a person while its work Sessions
fill every ordinary slot. Other Tasks, work Sessions included, start only while fewer Task
Attempts than the concurrency run. A work Session that cannot start does not hold back
conversation turns. For example, a Worker with concurrency 1 runs one work Session and one
conversation turn together, and a Worker with concurrency 4 runs four work Sessions and one
conversation turn.
`supertag status` includes that coordination slot in its capacity. It shows `5/5` for this
example and labels the additional slot, so the five running Task Attempts do not appear to
exceed capacity.

A Task that some eligible host could run, but whose matching Workers are all busy, stays queued
with no record. The Control Plane records a scheduling check only when no bound Worker Host
*qualifies*: the host pool lacks a required label, cannot check out the Workspace, needs an MCP
login, or refuses an unsandboxed command. `supertag describe task TASK_ID` shows that check on a
pending Task:

```text
Last scheduling check: incompatible at 2026-10-01T09:14:02.118Z
Waiting: no bound Worker Host has labels gpu.
Unmet requirements: labels:gpu
```

The record changes only when the requirement changes. Once a qualifying host appears, the next
check records the Task as `compatible`.

`supertag get task ID` carries the same record under `scheduling`, with fields `status`
(`SCHEDULING_STATUS_INCOMPATIBLE` or `SCHEDULING_STATUS_COMPATIBLE`), `unmetRequirements`,
`reason`, `unsandboxedCommands`, `workspaceRefusals`, `observedAt` and `sequence`.

Other holds are silent. A turn waits without a record while its Session already runs a turn,
while its Objective is paused or closed, and while the Sessions of every Objective naming its
Team already reach the Team's `maxConcurrency`. Read
[Queue order](#worker-host-selection) for those rules, and
[Check an Objective's progress](../guides/objective-overview.md) for what is running under one
Objective.

A wait for capacity creates no other Task. The Task starts when a slot frees.

```text
Worker slots:  [work Session 1] [work Session 2]   coordination slot: [      ]
10:00  work Session 3 queued    ->  waits for work Session 1 or 2 to finish
10:05  a person's message       ->  starts at once in the coordination slot
```

### Objective turns

An Objective's conversation runs one turn at a time. A trigger that arrives while a turn runs,
such as a work Session's result, an operator's message or an approval decision, becomes the
conversation's next Task; it does not start a second turn. See
[What delivers a turn](coordination.md#what-delivers-a-turn).

```text
10:00  Objective's first turn queued; Worker slots full of work Sessions
10:01  operator message arrives   ->  waits; the running turn keeps its own input
10:03  first turn ends            ->  the message runs as the conversation's next turn
10:06  work Session reports       ->  runs as the turn after that
```

## Placement by harness and model

Each Task records a harness, model, and effort when SuperTag accepts it, from the acting Tag's
own range. Placement then works like this:

- Each Worker profile advertises its harness, the models that harness serves, and the efforts it
  applies. A host's first model for a harness is its default. Configure them with
  `models` in [supertag.yaml](supertag-yaml.md#host-models) or repeated
  `supertag connect worklet --model`.
- A Task with a harness runs only on a profile of that harness. A Task with a model runs only on a
  profile that lists that model. A profile that lists no models serves none by name.
- When no bound host offers the model, the Task waits and its scheduling record names
  `execution.model`.
- Effort never blocks placement. A harness without an effort option runs the Task and records that
  it ignored the effort. Tasks start at `low` unless the Tag or its Roles set another effort.
- A Task without a model runs with the host's default model, and the Task Attempt records which
  one that was.

## Task Attempt limits

These limits are fixed defaults:

| Limit | Default |
| --- | --- |
| Task Attempt time limit | 60 minutes. `supertag connect worklet --timeout-ms` changes it for that Worklet. |
| Claude Code turns | No SuperTag cap; Claude Code's own limits apply. A Worker Profile's `maxTurns` configuration still sets one. |
| Unsatisfiable execution limits | Refused at admission, naming the limits the Tag's connected profiles enforce. |

## Conversation turn order

Each turn of a conversation or work Session is a Task. The Control Plane dispatches due turns
oldest first:

- A Session's next turn waits until its earlier turns finish, so a turn never overtakes an earlier
  one of the same Session.
- A turn that no bound host can run now waits without holding back other Sessions' turns, of the
  same Tag or another. Each pass tries due turns until one runs, however many wait ahead of it.
- A conversation runs at most four work Sessions at once; the rest wait their turn.
- A waiting turn records why, once each time the reason changes. `supertag describe task` shows
  it as `Waiting: REASON`, and the terminal UI shows it in the conversation. The reason clears
  once a host can run the turn, also after a Control Plane restart.

For example, a turn in Slack thread A waits for an MCP server login. A later message in thread B,
for the same Tag or another, runs at once. A second message in thread A waits behind the first.

## Leases and unknown outcomes

A **lease** is the time-limited claim the Control Plane records for the owner running a Task. An
**unknown outcome** means SuperTag cannot tell whether an interrupted Task Attempt finished or what it
did.

The **Task Attempt journal** is a record on the Worker Host of accepted execution, its identity, and its
ordered events. The CLI Worklet keeps one.

- A disconnected connection can reconnect and inspect the journal.
- A Worker process crash can leave the execution outcome unknown. Reconnecting does not authorize
  starting the same side effect again.
- A cancellation request and observed termination are separate facts.
- The gRPC connection requires a journal-backed Worklet and does not switch to WebSocket when a
  request fails. See [Worklet connection transports](worker.md#worklet-connection-transports) for
  protocol versions.

Continuation and interruption:

- The Control Plane handles continuation. If a manager records a Task wait, SuperTag schedules a
  new Task Attempt after the condition is met.
- After a connection is interrupted, the Control Plane checks the Worklet's saved execution record
  before continuing.
- An expired lease means the Task needs recovery; it does not prove that its execution stopped.
- Reconnect the original Worklet with its existing state directory so that it can report any saved
  result or verified cleanup. Reconnecting alone cannot resolve an execution whose state is still
  unknown.
- A clean Worklet shutdown can confirm cancellation and release capacity.
- After a forced process kill, execution may remain unknown and keep its slot reserved to prevent
  duplicate work.
- Cancelling the Task records your intent, but does not prove that a disconnected process stopped.
- For a cancelled Task, the Control Plane releases its slot when the selected, connected Worklet
  confirms that its journal has no record of accepting the Task Attempt. A different host's missing
  record cannot confirm this.
- Use `supertag describe task` and `supertag events task` to distinguish the Task's status from
  confirmed execution cleanup.
- A Worker Host appearing ready does not by itself establish that an interrupted Task Attempt is safe
  to run again.
- There is no `resume task` command. `supertag resume worker-host` only returns a deliberately
  drained host to scheduling.

Ephemeral Worker Hosts are the one exception. An ephemeral host joined with an ephemeral
[Auth Key](resource-model.md#auth-keys), such as a CI job. After it stays disconnected for 30
seconds, the Control Plane revokes it, so it can never report again. Its interrupted Task Attempts then
count as stopped, and their Tasks run again on another bound host:

- A request from a collaboration surface gets a new Task Attempt, within the usual attempt limit.
- A delivered turn gets a new Task Attempt while it has attempts left. Otherwise it fails, and
  the Session needs a new turn, as after an expired lease.
- The Task's events record `task.worker-host-removed` with the removed host's ID.

Side effects the lost process already made are not undone. Use persistent hosts for work that must
not repeat.

### Uncertain Task Attempts

A Task Attempt is **uncertain** when its Worker Host's Task Attempt journal records the outcome as
`unknown`. For example, the Worker could not confirm cleanup in time, or the Worklet stopped while
the Task Attempt ran. The Task Attempt may have executed, so SuperTag never runs it again on its own.
It keeps its Worker slot until an operator recovers it.

When cleanup fails, the Worker Host log records the Task Attempt ID and the redacted underlying
causes. If an earlier cleanup failure makes a Worker reject a later Task Attempt before its harness
starts, that later Task Attempt fails with guidance to inspect the log and restart the Worker Host.
Its slot is released. The earlier Task Attempt stays uncertain until its own cleanup is confirmed.

The journal keeps why the receipt became `unknown`: the error's name and message, with known
secrets redacted. These include secret-bearing host environment values, such as provider API keys,
and URL usernames, passwords, and credential query parameters. Encoded copies of known secrets
are also removed. For example, `https://user:password@example.com` becomes
`https://[REDACTED]@example.com`. Redaction happens before truncation and storage, so the inbox
and `supertag get task` receive the sanitized reason. The journal writes the reason to the receipt and to
an `execution.uncertain` journal event.
Worker Host acceptance and placement failures use the same policy before the Control Plane can
store them as admission rejection events or release reasons. See the
[Worker reference](worker.md) for the credential-name and value rules.
Causes and stack traces are never kept; a Worker reports those details, redacted, in its own
events.

When the Control Plane reads an `unknown` receipt for a Task's running Task Attempt, it records the
uncertainty on the Task once, with that reason, and appends a `task.attempt-uncertain` Task event.
The Task's status stays `running`, but no Control Plane runs it, so every view shows it as
uncertain instead of a running Task with an expired lease:

| Where | What it shows |
| --- | --- |
| `supertag describe task` | `uncertain`, why, and the recover command |
| `supertag describe objective` | The Task as `uncertain`, its reason and recover command, and the inbox item under "Needs you" |
| Operator inbox | A `task-attention` item whose first command is the exact `supertag recover worklet` command |
| `supertag ps` | The host's uncertain Task Attempts, with the commands to stop the host, recover, and start it |
| `supertag get task` | `latestAttempt` with its uncertainty |

An uncertain Task of a work Session reports nothing to the Session that started it until an
operator settles it.

To recover, follow
[A Task is uncertain](../guides/troubleshooting.md#a-task-is-uncertain). After an operator confirms
the Task Attempt stopped and the host reconnects, the Task fails with its outcome recorded as
unknown, and the uncertainty clears. It also clears when the host reports the Task Attempt running or
finished again.

#### The Session waits while execution may run

A Task of a Session, such as a conversation, an Objective, or a work Session, can fail because
its Task Attempt's completion could not be confirmed. A cancelled Task can still be cleaning up.
Either way, its Session takes no new turn while that execution may still run. Later turns,
including ones already queued, wait.

The Session resumes once the Worker Host's journal records that the Task Attempt stopped:

- The Worker finished, failed, or completed cancellation on its own.
- The Worker verified cleanup itself when it reconnected.
- An operator ran `supertag recover worklet --confirm-stopped` and started the host again.

It also resumes when the Task Attempt ran on an ephemeral Worker Host that the Control Plane
removed after its reconnect grace. That host can never run the Task Attempt again, and the Task's
events record `task.worker-host-removed`.

Every 10 seconds the Control Plane checks the next 20 blocked Sessions, so each one is checked
in turn. It also checks when `supertag describe task` reads the Task Attempt. The Task keeps its
outcome and never runs again. The Session's waiting turns then run in order, and its inbox item
goes away. `supertag describe task` shows `Execution cleanup evidence: confirmed`.

A Session blocked for another reason, such as a message whose delivery to a running Task Attempt
could not be confirmed, stays blocked. Its inbox item gives the reason and makes no promise
that recovery releases it.

### When the Control Plane sleeps

A laptop that sleeps also suspends a Control Plane that runs on it. While it sleeps, it cannot
renew leases. Each lease lasts 30 seconds and renews every 5 seconds, so most leases expire during
a sleep. Without help, every running Task Attempt would then fail with `Attempt authority expired`.

So the Control Plane watches for a suspend in two ways:

- Its clock jumps: more than 15 seconds pass between two of its checks, which normally run every
  fraction of a second.
- On macOS, the host reports a system wake newer than the last one it saw.

After a suspend, running Task Attempts get a 60-second grace. During the grace, the Control Plane
still accepts a lease it owns that was valid when the suspend began, and renews it. Task Attempts
then continue as if nothing happened. Collaboration surface Task Attempts, which answer chat messages, keep their
leases the same way. The grace has no settings.

The suspend begins at the sleep time the host reports. Without one, it begins at the Control
Plane's last check before the clock jumped.

The grace never revives a lease that expired before the suspend or one another Control Plane owns.
A lease that is not renewed within the grace expires as usual. Each running Task records the
suspend as a `task.lease-grace` event with its start, its end, and how it was noticed.

Close the lid with care. Keeping the machine awake prevents only idle sleep. A sleep still pauses
the harness, and remote Worker Hosts cannot reach a sleeping Control Plane. `supertag ps` warns
when a laptop runs Task Attempts on battery or would sleep when its lid closes. See
[Keeping the machine awake](supertag-yaml.md#keeping-the-machine-awake).

## Reclaiming capacity

A reserved slot from an interrupted Task Attempt is released in one of two ways.

When a local Task Attempt ends, the Worker stops its harness and tool processes before releasing
its slot. It sends SIGTERM to their process group and tracked descendants, then SIGKILL after a
short grace period. It also checks same-user processes whose current directory is inside the
Task Attempt directory and processes carrying its private launch marker. This catches detached
children that change directory and outlive their launcher. It confirms a process start time before
signalling a recorded PID. The Worker removes
that directory after confirming cleanup. This also applies when a Task Attempt waits for more work.
If process inspection fails, cleanup reports an error and retains the directory for inspection.

Automatic reclaim, for colocated local execution:

- A restarted Worklet can reclaim the slot when its private ownership records verify that the
  original process and all recorded process groups are gone.
- It records the interrupted execution as failed with an unknown outcome; it does not run it
  again.
- This automatic check does not establish that actions in external services succeeded or stopped,
  and does not verify remote sandboxes.
- Missing or incomplete ownership records leave capacity reserved.

Operator confirmation, when automatic verification is unavailable, uses
`supertag recover worklet`. The procedure is in
[A Worker Host stays at capacity after a forced kill](../guides/troubleshooting.md#a-worker-host-stays-at-capacity-after-a-forced-kill).
Its rules:

- Run it on the original Worker Host with its existing state directory. Stop the host service
  first with `supertag down SERVICE`, or end the `supertag connect worklet` process.
- A dead Worklet PID alone is not sufficient evidence that the Task Attempt stopped.
- The command refuses while a running host owns a journal for the recorded Worker Host. It also
  refuses when it cannot identify the recorded Worker Host: the owned journal may hold the live
  record. It ignores a running service whose stored credential identifies a different Worker Host.
  When it refuses, it names the owned journal and says to stop that host service first.
- It finds the journal itself. A host service's journal is `hosts/SERVICE/attempt-journal`; the
  command checks that the service's stored credential names the Worker Host recorded on the Task
  Attempt. A Worklet started with `supertag connect worklet` keeps its journal in
  `workers/WORKER_ID/attempt-journal`.
- It skips symlinked journal paths, and checks again that the journal's directories are unchanged
  before it writes, so it never follows a link out of the state directory.
- If several journals match, or a host journal has no matching Worker Host credential, it refuses
  and names the candidate paths and host services. Check which Worker Host ran the Task Attempt,
  then retry with `--host NAME`, the host service name in `supertag.yaml`. `--host` searches only
  that service's journal and skips the credential check; an unknown name is refused with the list
  of host services in the state directory.
- It records the local operator identity, time, and reason. It does not stop processes or verify
  your confirmation for you.
- After you reconnect the Worklet with its original configuration, the Control Plane reconciles
  the receipt and releases the reservation. An active Task's lease may need to expire first.
- The Task remains failed or cancelled, and its previous outcome remains unknown.
- Other queued work can then use the reclaimed capacity.
- Keep the journal. Deleting it discards execution evidence.

## Automatic retries

A provider capacity error means the selected model cannot accept a request right now. For example,
Codex may report “selected model is at capacity.” The Codex app-server retries explicit
terminal model, provider, or server capacity rejections:

- It retries up to twice, after 250 ms and 500 ms, and records each retry as Task progress.
- It stays in the same Task Attempt and keeps the original timeout and limits.
- Any native item, output, tool request, or usage report prevents replay.
- Quota, authentication, and ambiguous transport failures are not retried by this policy.

Claude Code retries retryable API errors itself, such as 529 overloaded, server errors, and
connection failures, inside the same request:

- SuperTag records each native retry as Task progress, with the error, attempt count, and delay.
- SuperTag does not replay the query, because a replay could repeat tool calls.
- When the retries run out, the Task Attempt fails with the provider error. SuperTag never treats that
  error text as the agent's response.
- Claude Code decides which errors it retries. Rate limits, usage limits, and authentication or
  billing errors end the Task Attempt.
