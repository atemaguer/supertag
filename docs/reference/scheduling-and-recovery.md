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
execution field, see
[Inspect the latest Task execution](control-plane-api.md#inspect-the-latest-task-execution). For
Objective-specific behavior after a restart, see
[After a Control Plane restart](coordination.md#after-a-control-plane-restart).

## Worker Host selection

A Tag may be bound to several Worker Hosts. The Control Plane limits and ranks that host pool
using policy, affinity, health, and reported capacity.

The eligible pool is the Tag's bound hosts that carry every label the Task requires: the Tag's
`runsOn` labels, plus `workspace:NAME` for a Task in a named Workspace. When no bound host
qualifies, the Task waits and records a `labels:...` scheduling requirement. Labels only narrow
the pool; they never add a host. See [Worker Host labels](resource-model.md#worker-host-labels).

An **owner activation** is a Task in which an Objective’s owner reviews new information and
decides what to do next. It may be queued, running, or waiting. A **durable wait** stores the
conditions for resuming a Task, so a Control Plane restart does not lose the wait.

Queue order:

- The Control Plane considers an Objective owner's queued Tasks first. An owner reviews results
  and plans the next round, so its Team's delegated Tasks cannot keep it from a free slot.
- An owner never runs two activations for the same Objective at once, and a new trigger never
  queues behind another activation. See [Owner triggers](#owner-triggers).
- Within that group and among all other Tasks, it considers queued Tasks by accepted priority,
  then by availability time and stable Task ID.
- A waiting Task moves up one effective priority tier after each 15 minutes that it remains
  eligible.
- Once Tasks share an effective tier, the older eligible Task runs first. This bounded aging
  prevents a continuous urgent queue from starving ordinary work.

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
- A Task whose dependencies are not all accepted gets no reservation; see
  [Waiting for dependencies](#waiting-for-dependencies).

When no host can run the Task:

- If every bound host is temporarily unavailable, the Task remains queued.
- If the Tag has no bindings, SuperTag rejects the Task with instructions to bind a host.

`supertag describe task TASK_ID` shows the eligible Worker Hosts, selected Worker Host, Worklet,
Worker, and stored reservation phase. This is stored scheduling evidence; the command does not
contact the Worker Host.

## Waiting for dependencies

A Task with dependencies runs only after each of them is accepted. Until then, the Control Plane
does not offer the Task to any Worker Host. It records one scheduling check that names each
dependency that is not yet accepted and its status. `supertag describe task TASK_ID` shows it:

```text
Last scheduling check: waiting at 2026-10-01T09:14:02.118Z
Waiting for step2-ref-delivery (running), step3-sandboxes (submitted).
```

A dependency that the Control Plane cannot read shows as `unavailable`. The record changes only
when a dependency's status changes. Submission alone does not release the Task: a manager must
accept the dependency. Once every dependency is accepted, the Task goes through
[Worker Host selection](#worker-host-selection) like any other.

## Waiting for capacity

Each Worker runs a limited number of Task Attempts at once. Built-in Workers derive the default from the machine: floor(min(CPU cores, memory in GB / 3) / 2),
kept from 2 through 8.
Set it with `concurrency` on a [host service](supertag-yaml.md#host-concurrency), or with
`supertag connect worklet --concurrency N`. A Worker Host's capacity is the sum over its Workers.
A host service takes a changed `concurrency` without a restart. It reports the new limit to the
Control Plane at once, and scheduling uses it from then on.

Each Worker also has one **coordination slot** beyond its concurrency. An Objective owner's
activation and a conversation's turn, including its report turns, may use it. The owner starts
even when delegated Tasks fill every slot, and a conversation still answers while its work
Sessions fill them. Other Tasks, work Sessions included, start only while fewer Task Attempts than
the concurrency run. A work Session that can't start doesn't hold back conversation turns. For example, a Worker with
concurrency 1 runs one builder Task and an owner activation together. A Worker with concurrency 4
runs four builder Tasks and an owner activation.
`supertag status` includes that coordination slot in its capacity. It shows `5/5` for this
example and labels the additional slot, so the five running Task Attempts do not appear to
exceed capacity.

A Task that some eligible host could run, but whose matching Workers are all busy, stays queued.
The Control Plane records why, and `supertag describe task TASK_ID` shows it:

```text
Last scheduling check: waiting at 2026-10-01T09:14:02.118Z
Waiting for a free claude-code slot on Worker Host laptop (2 of 2 busy: 7f3c..., 9a41...)
```

The record names each eligible host, the harnesses that could run the Task, the host's capacity,
and the Tasks whose running Task Attempts fill it. For an owner's activation, the capacity includes
the coordination slots. When no eligible host has a matching Worker
connected, it says so instead. The record changes only when the wait changes. Once the Task is
placed, the next check records it as compatible. A slot not held by a running Task Attempt may be
reserved for a starting one, or the host may be draining.

A Worker can be free while the Control Plane still declines to start the Task. For example, its
Team's `maxConcurrency` is full, or its Tag already runs an activation in the same Objective. The
record then states the cause:

```text
Last scheduling check: waiting at 2026-10-01T09:14:02.118Z
Not started: Team builders runs at most 2 Tasks at once (maxConcurrency); running now: 7f3c..., 1 Task in other Objectives.
A Worker was free; the Task starts when this clears.
```

The second line depends on what holds the Task:

| `code` | Second line |
| --- | --- |
| `retry_delay`, `objective_activation`, `dependencies`, `team_concurrency` | The Task starts when this clears. |
| `approval` | The Task starts once it is approved. |
| `objective` | The Task starts only if the Objective admits new work again, such as after a resume or a raised limit. |
| `inactive_tag`, `team` | The Task cannot start until an operator fixes this. |

`supertag describe objective` shows the same cause as a `claim_declined` explanation for the
Task.

`read_task` returns the same record as `scheduling`, with `reason: "claim"` and a `claim` object.
Its `code` is one of the values above, and `message` explains it. The object may also carry
`taskIds`, `teamId`, `tagId`, or `availableAt`. A Team can serve several Objectives. When it does,
a `team_concurrency` reason lists in `taskIds` and `message` only the running Tasks in the Task's
own Objective. It gives just a count of Tasks running in other Objectives.

Unlike a [scheduling incompatibility](coordination.md#scheduling-incompatibility), a wait for
capacity creates no manager Task. The Task starts when a slot frees. When several Tasks wait for
the same slot, an Objective owner's Task takes it before delegated Tasks; see
[Worker Host selection](#worker-host-selection).

```text
Worker slots:  [builder Task 1] [builder Task 2]   coordination slot: [      ]
10:00  builder Task 3 queued   ->  waits for builder Task 1 or 2 to finish
10:05  owner review queued     ->  starts at once in the coordination slot
```

### Owner triggers

An Objective owner is woken by several triggers: its start Task, a change to a Task it delegated,
an assessment when its last activation ended, and a Mailbox message, such as an operator's message.
SuperTag gives each Objective at most one open owner activation: a queued, running, or waiting owner
Task in the Objective's Leadership Team. When a trigger arrives while one is open, SuperTag
delivers the trigger to that activation instead of starting another:

- A queued activation receives the trigger when it starts.
- A waiting activation wakes at once, with wake reason `delivery`.
- A running activation finishes its current Task Attempt. The activation then continues with
  another Task Attempt that receives the trigger, instead of closing.

The Task Attempt lists its triggers as `deliveries` in its context. They include changes to delegated
Tasks that arrived while the activation was queued or waiting, such as the result its wake
reason names. A change the activation already received is not delivered to it again, and neither
is a change it made itself by accepting, rejecting, or cancelling a Task. A delivered message gets no
Task of its own, so the activation handles it under the activation's recorded policy, as it would
a message it reads itself. A Task Attempt that succeeds marks its delivered messages processed. One
that fails returns them to the Mailbox, so the owner's next activation receives them. A surface
instruction keeps its own Task, because it carries the authority of the person who sent it. It
starts when the running activation ends.

```text
10:00  owner start Task queued; Worker slots full of builder Tasks
10:01  operator message arrives   ->  delivered to the queued start Task; no second Task
10:02  start Task runs in the coordination slot, with the message in its context
10:04  builder result arrives      ->  delivered to the running start Task
10:06  start Task Attempt ends     ->  the start Task continues and reviews the result
```

## Placement by harness and model

Each Task records a harness, model, and effort when SuperTag accepts it; see
[execution settings](coordination.md#execution-settings). Placement then works like this:

- Each Worker profile advertises its harness, the models that harness serves, and the efforts it
  applies. A host's first model for a harness is its default. Configure them with
  `models` in [supertag.yaml](supertag-yaml.md#host-models) or repeated
  `supertag connect worklet --model`.
- A Task with a harness runs only on a profile of that harness. A Task with a model runs only on a
  profile that lists that model. A profile that lists no models serves none by name.
- When no bound host offers the model, the Task waits. Its scheduling record names
  `execution.model`, and the responsible manager gets a Task to resolve it, as for other
  [scheduling incompatibilities](coordination.md#scheduling-incompatibility).
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
| Unsatisfiable execution limits | Refused at assignment, naming the limits the Tag's connected profiles enforce. |

## Conversation turn order

Each turn of a conversation or work Session is a Task. The Control Plane dispatches due turns
oldest first:

- A Session's next turn waits until its earlier turns finish, so a turn never overtakes an earlier
  one of the same Session.
- A turn that no bound host can run now waits without holding back other Sessions' turns, of the
  same Tag or another. Each pass tries up to 50 due turns.
- A conversation runs at most four work Sessions at once; the rest wait their turn.
- A waiting turn records why, once each time the reason changes. `supertag describe task` shows
  it as `Waiting: REASON`, and `supertag message tag` prints `· waiting: REASON`.

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
- A self-escalation is a continuation that starts at once. When the Tag working a Task calls
  [`escalate_task`](coordination.md#self-escalation), SuperTag records the new execution, stops
  the current Task Attempt as it does for a wait, and queues the same Task again. The next Task
  Attempt runs with the new model or effort, on the same Task branch. It keeps the Task's
  original reservation and is not charged again. A Task may escalate itself at most twice.
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
- An assigned Task returns to the queue when it holds no reserved budget and has attempts left.
  Otherwise it fails and needs explicit reassignment, as after an expired lease.
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
and `read_task` receive the sanitized reason. The journal writes the reason to the receipt and to
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
| `supertag describe task` | `Assignment: uncertain`, why, and the recover command |
| `supertag describe objective` | The Task as `uncertain`, its reason and recover command, and the inbox item under "Needs you" |
| Operator inbox | A `task-attention` item whose first command is the exact `supertag recover worklet` command |
| `supertag ps` | The host's uncertain Task Attempts, with the commands to stop the host, recover, and start it |
| `read_task` | The assignment's `uncertainAttempt` |

The uncertainty also wakes waiters. A waiting Task wakes with reason `uncertain_tasks` when it
names the uncertain Task in `submittedTaskIds` or `acceptedTaskIds`, or requested it. It wakes once:
waiting on the Task again does not wake again for the same uncertainty.

To recover, follow
[A Task is uncertain](../guides/troubleshooting.md#a-task-is-uncertain). After an operator confirms
the Task Attempt stopped and the host reconnects, the Task fails with its outcome recorded as
unknown, and the uncertainty clears. It also clears when the host reports the Task Attempt running or
finished again.

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
