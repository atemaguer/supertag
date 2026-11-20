# Scheduling and interrupted execution

How the **Control Plane**, the service that stores the organization and schedules its work, picks a
**Worker Host** for each Task, and what happens when execution is interrupted. A **Task** is one
turn of a Tag's work; a **Task Attempt** is one execution of it on a Worker Host. Terms are defined
in the [glossary](glossary.md); the host's side is in the [Worker Host reference](worker.md).

## Worker Host selection

Each connected host's Worklet claims work: it asks for a Task it can run. The Control Plane offers
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
`requirement` is `worklet`, `labels:NAMES`, or, when the Task's harness cannot run what the
Task accepted, `execution-limits`, `runtime-actions`, or `context` (a required Skill). It is
`checkpoint-holder` while the Task waits, up to 10 minutes, for the Worker Host that holds its
Session's checkpoint; see [Session checkpoints](control-plane.md#session-checkpoints). When the
eligible hosts have no free slot for the Task's harness, it is `capacity`, and the summary names
each host's state: busy, offline, draining, or a slot kept by an uncertain Task Attempt, with the
`supertag task resolve-attempt` command that frees it. It is `harness` when no eligible host runs
the Task's harness. A Task waiting for the Session's last delivery reports `workspace-holder` with
the name of the Worker Host holding it: a local Workspace's Session continues only on that host,
and a remote Workspace's waits until that host's Worklet has pushed the Session's branch. The desktop app shows this summary under a waiting message.

## Placement by harness and model

A Tag's or Role's `execution` names a harness, its allowed models (default first), and efforts. A
Task runs on a host that serves that harness and lists the selected model. A host advertises its
models with `models` in `supertag.yaml`, or `--harness-model` and `--harness-models`.

## Waiting for capacity

A Task that no host can run waits, without holding back other Sessions' Tasks. Concurrency is
limited in two places:

| Limit | Set by |
| --- | --- |
| Task Attempts on a host, across its harnesses | The host service's `concurrency`, 1 through 16, and `harness-limits` for one harness within it |
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
window, as do the desktop app's Tag details. A Tag manifest sets it with `spec.startRate`. A new Tag has no start rate.

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

### Interrupted Task Attempts

When a host or its Worklet stops or loses contact while a Task Attempt runs, the Control Plane cannot know
whether the work finished or changed anything outside SuperTag:

- A [Worker](glossary.md#worker), the process that runs one Task Attempt, dies with its Worklet. A Worklet restarted after it was killed, or one whose Worker
  died, checks the processes it recorded for the Task Attempt, the Worker's own included. When
  every one is gone, it reclaims the Task Attempt and takes new work. The Control Plane then
  either [redelivers the Task](#redelivery) or fails it. A Task Attempt whose harness had
  finished is not interrupted: a new Worker resumes capturing what it produced, and the Worklet
  finishes it.
- Otherwise, and always for a Task Attempt that used a remote sandbox or shared execution, the
  Task Attempt is **uncertain**. It appears in the operator inbox as `task-attention`, whatever
  started it: a conversation turn, an Objective's turn, or a Work Session's. It also appears in
  `supertag metrics` under recovery. An uncertain Task Attempt is never redelivered; a person
  decides, or SuperTag records it as failed when it can [settle it alone](#settled-automatically).

### Redelivery

When a Worklet reclaims a lost Task Attempt, the Control Plane decides in the same transaction
whether the Task runs again. It redelivers the Task unless the lost Task Attempt:

1. left an external write in doubt: an effect receipt that started and never reported its
   outcome, or an MCP call the Control Plane brokered that was never confirmed;
2. started a delivery of the Session's changes, published an artifact, or already sent its reply;
3. ran an action that needed approval;
4. could have run a command with the network reachable outside a sandbox.

The Worker records no exact network activity for a command, so the fourth rule reads what the Task
was admitted with and how the host runs commands. A Task without `commands:execute` runs no
commands and passes. A Task with it passes only when every command runs in a sandbox without
network: Codex's own sandbox, or Claude Code with `sandbox-commands`, and only when the Task was
not also admitted with `web:fetch`, which opens that sandbox's network. Commands that run with
`allow-unsandboxed-commands`, in a remote Workspace sandbox, or through shared execution count as
reaching the network, as do OpenCode, Cursor, and custom harness adapters.

A redelivered Task keeps its ID and gets a new Task Attempt. A Task gets at most three Task
Attempts whose harness started, so at most two redeliveries. The first redelivery waits 5 seconds
before a host can claim the Task, the second 30 seconds. The Session's later turns wait behind it.
Redelivery is on for every Tag; there is no setting.

The new Task Attempt starts from a fresh checkout, so the lost Task Attempt's partial edits are
discarded. It resumes the Session from its last durable checkpoint, or from the recap when there is
none. Its prompt says that an earlier run was interrupted and its file changes discarded. It also
quotes the messages that run already sent to the person, the 20 most recent up to 32 KiB, so the
Tag does not say them twice.

A person's message that reached the lost Task Attempt while it ran, or was on its way to it, is
answered by the redelivered Task: the new Task Attempt gets it after its prompt, with the messages
the Task took in when it was first claimed, and the message gets no turn of its own. That holds
for a message whose delivery was uncertain, so it needs no decision. A message the lost Task
Attempt was never given runs as its own turn after the redelivered Task.

```text
Check CI

A previous run of this request was interrupted before finishing. Any file changes it made were
discarded, so check the current state before continuing. It had already said this to the person
(oldest first):
> Looking at CI now.
Do not repeat what it already said; continue from there.
```

When a rule above applies, or the Task already had three Task Attempts, the Task fails. Its result
says the outcome is unknown and why SuperTag did not run it again. For a week, the operator inbox
shows one `task-attention` item that names the Task, its Tag, and the reason. Operator
notifications carry it too, with `supertag task events TASK_ID` to see what the Task did.

### Uncertain Task Attempts

An uncertain Task Attempt waits for a decision. Its `task-attention` inbox item names the Task,
the Task Attempt, its Tag and Session, how many of the Session's later turns wait behind it, and
what the Task execution report says: whether its Worker Host confirmed cleanup, and whether the
report is complete. The item leaves the inbox once the Task Attempt is resolved.

Check what it did, then record a decision:

```sh
supertag task resolve-attempt TASK_ID ATTEMPT_ID --decision failed \
  --evidence "The sandbox is gone and no commit was delivered." --confirmed-stopped \
  --gateway team
```

`--decision retry` runs the Task again. The decision and its evidence are audited.

#### From the conversation

In the desktop app and the terminal UI, a conversation turn that is uncertain says
**Interrupted: needs attention** and offers **Retry** and **Mark failed**. The terminal UI's inbox
offers the same two decisions on the item. The app records the decision with evidence naming
itself, the person, and the execution report, for example `Resolved from the desktop app by
operator:local: cleanup confirmed, complete true per execution report.` It never claims that
execution stopped: the decision is accepted only once the Worker Host confirmed it, and otherwise
the app says that an operator who checked the host must use `supertag task resolve-attempt`.

An operator may decide for any Task it sees. A client, a person enrolled with a client Auth Key,
may decide only for its own Task, such as its own conversation's turn, and only after the Worker
Host confirmed the Task Attempt stopped, so two executions of the Session cannot overlap. A client
may mark such a turn failed, and run it again only when SuperTag recorded no effect for it (see
below); otherwise only an operator may run it again.

#### Settled automatically

SuperTag records an uncertain Task Attempt as failed on its own, 60 seconds after its lease lapsed,
when both hold:

1. Its Worker Host confirmed that execution stopped and reported no cleanup failure. The host's
   late report that the Task Attempt ended counts, as does the removal of an ephemeral host.
2. SuperTag recorded no effect for the Task that a person must judge: no reply, no message the Tag
   wrote to the person, and no post to a conversation or collaboration surface; no external write,
   MCP call, or approved action; no delivery of the Session's changes, Volume write, or published
   artifact; no message to another Tag or a Team; and no Work Session, Schedule, question, commit
   review, or note it started.

The decision is recorded and audited as `control-plane`, and the Task's result says that the
outcome is unknown and that anything the Task Attempt changed outside SuperTag, such as files or
commands, is not undone. Failing runs nothing again, so it cannot repeat an effect, and the
Session's next turn runs. Every other uncertain Task Attempt, including one whose host never
confirmed it stopped, waits for a person. Until then its inbox item says why, or when SuperTag will
settle it.

#### The Session waits while execution may run

A Session whose Task Attempt is uncertain runs no later turn until the decision is recorded, so
two executions of one Session never overlap.

### Ephemeral hosts

A host that joined with an `--ephemeral` Auth Key is removed once it goes offline. Its running Task
Attempts return to the queue.

## Reclaiming capacity

A Task Attempt that ends, is cancelled, or is resolved frees its host slot. On a draining host
(`supertag host drain`), the Worklet finishes its running Task Attempts and claims no new ones.

## Automatic retries

SuperTag runs a Task again on its own in two cases: a [redelivery](#redelivery) after its Worklet
reclaimed a lost Task Attempt, and the Task Attempts of a removed
[ephemeral host](#ephemeral-hosts). Claude Code retries retryable API errors
itself, such as overload, server, and connection errors, inside the same request before it produces
output, and SuperTag records each retry as Task progress. Rate and usage limits end the Task
Attempt.

A message whose delivery to a running Task is uncertain waits for
`supertag input resolve INPUT_ID retry|fail --evidence TEXT`, and an uncertain reply to a
collaboration surface for `supertag reply resolve`.
