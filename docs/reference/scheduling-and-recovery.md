# Scheduling and interrupted execution

How the **Control Plane**, the service that stores the organization and schedules its work, picks a
**Worker Host** for each Task, and what happens when execution is interrupted. A **Task** is one
turn of a Tag's work; a **Task Attempt** is one execution of it on a Worker Host. Terms are defined
in the [glossary](glossary.md); the host's side is in the [Worker Host reference](worker.md).

## Worker Host selection

Worker Hosts claim work: each connected host asks for a Task it can run. The Control Plane offers
a queued Task only to a host that:

1. may run the Task's Tag: a local host in the same `supertag.yaml` as its Control Plane runs
   every Tag, and an enrolled host runs the Tags its Auth Key named, or every Tag with
   `--all-tags`;
2. carries every label in the Tag's `runsOn`;
3. serves the Task's harness and, when the Task names one, its model, and can enforce the limits
   the Task requires;
4. maps the Task's Workspace and any Workspace Volume it copies;
5. is ready, not draining, and has a free slot for that harness.

`supertag placement explain TASK_ID` reports which condition keeps a Task queued, and
`supertag describe task TASK_ID` includes the same explanation.

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

`supertag metrics` shows queued Tasks, host capacity, and how long Tasks waited.

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
sandboxes accepts at most 3600 seconds. The host stops a Task Attempt that reaches its limit.

## Leases and unknown outcomes

A host holds a lease on each running Task Attempt and renews it while the Task Attempt runs. Each
lease is fenced by the Task Attempt's generation: once a lease is lost, the host can no longer
record events, results, or deliveries for that Task Attempt.

### Uncertain Task Attempts

When a host stops or loses contact while a Task Attempt runs, the Control Plane cannot know
whether the work finished or changed anything outside SuperTag. It does not run the Task again on
its own:

- A host restarted after it was killed checks the processes it recorded for the Task Attempt. When
  every one is gone, it records the Task Attempt as failed with an unknown outcome and takes new
  work.
- Otherwise, and always for a Task Attempt that used a remote sandbox or shared execution, the
  Task Attempt is **uncertain**. It appears in the operator inbox as `task-attention` and in
  `supertag metrics` under recovery.

Check what the Task Attempt did, then record a decision:

```sh
supertag task resolve-attempt TASK_ID ATTEMPT_ID --decision failed \
  --evidence "The sandbox is gone and no commit was delivered." --confirmed-stopped \
  --control-plane team
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

The Codex adapter retries explicit model, provider, or server capacity rejections up to twice
within the same Task Attempt, and records each retry as Task progress. Any output or tool call
prevents a replay. Claude Code retries retryable API errors itself, inside the same request, and
SuperTag records each retry as progress. Quota, authentication, and billing errors end the Task
Attempt.

A message whose delivery to a running Task is uncertain waits for
`supertag input resolve INPUT_ID retry|fail --evidence TEXT`, and an uncertain reply to a
collaboration surface for `supertag reply resolve`.
