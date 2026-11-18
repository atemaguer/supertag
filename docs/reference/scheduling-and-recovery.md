# Scheduling and interrupted execution

How the **Control Plane**, the service that stores the organization and schedules its work, picks a
**Worker Host** for each Task, and what happens when execution is interrupted. A **Task** is one
turn of a Tag's work; a **Task Attempt** is one execution of it on a Worker Host. Terms are defined
in the [glossary](glossary.md); the host's side is in the [Worker Host reference](worker.md).

## Worker Host selection

Worker Hosts claim work: each connected host's Worklet asks for a Task it can run. The Control Plane offers
a queued Task only to a host that:

1. may run the Task's Tag: a local host in the same `supertag.yaml` as its Control Plane runs
   every Tag, and an enrolled host runs the Tags its Auth Key named, or every Tag with
   `--all-tags`;
2. carries every label in the Tag's `runsOn`;
3. serves the Task's harness and, when the Task names one, its model, and can enforce the limits
   the Task requires;
4. maps the Task's Workspace and any Workspace Volume it copies;
5. is ready, not draining, and has a free slot for that harness.

A Session stays warm for 5 minutes on the Worker Host its last Task finished on. For its first
2 seconds, a new Task of that Session is left for the warm host when that host can take it: it is
waiting to claim and may run the Task, or, seen from another Control Plane replica, it is ready
with a free slot, bound to the Tag, and serves the Task's harness. A busy, draining, or offline
warm host is not waited for. Warm Sessions are recorded in the database, so every replica honours
them and they survive a Control Plane restart.

`supertag placement explain TASK_ID` reports which condition keeps a Task queued, and
`supertag describe task TASK_ID` includes the same explanation as `waiting_for`. Its
`requirement` is `worker-host`, `labels:NAMES`, or, when the Task's harness cannot run what the
Task accepted, `execution-limits`, `runtime-actions`, or `context` (a required Skill). It is
`checkpoint-holder` while the Task waits, up to 10 minutes, for the Worker Host that holds its
Session's checkpoint; see [Session checkpoints](control-plane.md#session-checkpoints). When the
eligible hosts have no free slot for the Task's harness, it is `capacity`, and the summary names
each host's state: busy, offline, draining, or a slot kept by an uncertain Task Attempt, with the
`supertag task resolve-attempt` command that frees it. It is `harness` when no eligible host runs
the Task's harness. A Task waiting for the Session's last delivery reports `workspace-holder` with
the name of the Worker Host holding it: a local Workspace's Session continues only on that host,
and a remote Workspace's waits until that host has pushed the Session's branch. The desktop app and the terminal UI show this summary under a waiting message.

## Placement by harness and model

A Tag's or Role's `execution` names a harness, its allowed models (default first), and efforts. A
Task runs on a host that serves that harness and lists the selected model. A host advertises its
models with `models` in `supertag.yaml`, or `--harness-model` and `--harness-models`.

## Waiting for capacity

A Task that no host can run waits, without holding back other Sessions' Tasks. Concurrency is
limited in three places:

| Limit | Set by |
| --- | --- |
| Task Attempts per harness on a host | The host service's `concurrency`, 1 through 16 |
| Tasks a Team runs at once across its Objectives | `team create --max-concurrency`, or a Team manifest's `maxConcurrency` |
| Native agents and work Sessions one turn may start | `task submit --max-native-agents` |

`supertag metrics` shows queued Tasks, host capacity, and how long Tasks waited: before a claim,
between claim and start, and, for the last 500 started Task Attempts, the median and longest time from
start to a ready Workspace, an attached harness adapter, and the harness's first event, and from
the harness finishing to the Worklet reporting the result.

### Start rates

Concurrency limits how many Tasks run at once, not how many start in an hour. A **start rate**
caps how often a Tag's Task Attempts start, to smooth bursts such as many Schedules coming due at
09:00:

```sh
supertag tag put lead --instructions "Release engineering" --start-rate 10/1h
supertag tag put lead --instructions "Release engineering" --start-rate none
```

The rate is `STARTS/PERIOD`, from 1 to 10,000 starts in 1 minute (`1m`) to 7 days (`7d`), and a
window slides over the last period. While a Tag has started that many Task Attempts in the last
period, its next Task stays queued and starts when the oldest start leaves the window. Nothing is
dropped, and other Tags keep running. A person's message always starts at once and counts toward
the rate, so the Tag's own background work, such as Schedule wake-ups, Objective notices, and
inbox turns, is what waits. A retried Task Attempt is a new start.

A waiting turn says so wherever a waiting turn's reason shows, such as "Tag lead started 10 Task
Attempts in the last 1h, its start rate; the next can start at 2026-11-17 10:42 UTC".
`supertag placement explain TASK` reports the requirement `start-rate`, and
`supertag describe tag` shows `start_rate` with how many Task Attempts started in the current
window, as do the desktop app's Tag details and the terminal UI under **Activity**. A Tag manifest sets it with `spec.startRate`. A new Tag has no start rate.

### Objective turns

An Objective's owner turns and its work Sessions draw on the Objective's budget. When the budget is
used up, no further turn is admitted, and the operator inbox shows a `budget` item.

## Conversation turn order

Each turn of a conversation or work Session is a Task. A Session's next turn waits until its
earlier turn finishes, so turns never overtake each other. A turn that cannot run now waits
without holding back turns of other Sessions, of the same Tag or another.

## Task Attempt limits

A Task Attempt may run for 60 minutes; a host service's `attempt-timeout-seconds`, or
`--attempt-timeout-seconds`, changes that, up to 86400. A host whose Workspaces run in E2B or Modal
sandboxes accepts at most 3600 seconds. The Worklet stops a Task Attempt that reaches its limit.

## Leases and unknown outcomes

A host's Worklet holds a lease on each running Task Attempt and renews it while the Task Attempt
runs. Each lease is fenced by the Task Attempt's generation: once a lease is lost, the Worklet can no longer
record events, results, or deliveries for that Task Attempt.

### Uncertain Task Attempts

When a host or its Worklet stops or loses contact while a Task Attempt runs, the Control Plane cannot know
whether the work finished or changed anything outside SuperTag. It does not run the Task again on
its own:

- A Worklet restarted after it was killed checks the processes it recorded for the Task Attempt. When
  every one is gone, it records the Task Attempt as failed with an unknown outcome and takes new
  work.
- Otherwise, and always for a Task Attempt that used a remote sandbox or shared execution, the
  Task Attempt is **uncertain**. It appears in the operator inbox as `task-attention` and in
  `supertag metrics` under recovery.

Check what the Task Attempt did, then record a decision:

```sh
supertag task resolve-attempt TASK_ID ATTEMPT_ID --decision failed \
  --evidence "The sandbox is gone and no commit was delivered." --confirmed-stopped \
  --gateway team
```

`--decision retry` runs the Task again. The decision and its evidence are audited.

#### The Session waits while execution may run

A Session whose Task Attempt is uncertain runs no later turn until the decision is recorded, so
two executions of one Session never overlap.

### Ephemeral hosts

A host that joined with an `--ephemeral` Auth Key is removed once it goes offline. Its running Task
Attempts return to the queue.

## Reclaiming capacity

A Task Attempt that ends, is cancelled, or is resolved frees its host slot. A draining host
(`supertag host drain`) finishes its running Task Attempts and claims no new ones.

## Automatic retries

Apart from the Task Attempts of a removed [ephemeral host](#ephemeral-hosts), SuperTag does not
run a Task again on its own. Claude Code retries retryable API errors
itself, such as overload, server, and connection errors, inside the same request before it produces
output, and SuperTag records each retry as Task progress. Rate and usage limits end the Task
Attempt.

A message whose delivery to a running Task is uncertain waits for
`supertag input resolve INPUT_ID retry|fail --evidence TEXT`, and an uncertain reply to a
collaboration surface for `supertag reply resolve`.
