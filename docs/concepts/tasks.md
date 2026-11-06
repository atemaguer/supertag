# Tasks and Sessions

A **Tag** is a persistent AI identity with its own responsibilities and permissions. A **Task** is
one request or assignment that SuperTag has accepted for that Tag. SuperTag stores it so the work
can be inspected, retried, or recovered. A **Session** groups Tasks from the same conversation so
later requests can continue earlier work.

Tasks are also how a team divides an outcome. When Tags pursue an **Objective**, an outcome owned by
one Tag, the owner and the leads of each **Team**, a group of Tags under one lead, assign Tasks to
Team members. Each submitted result waits for review before it counts.

If someone asks `@SuperTag` a question and then follows up in the same thread,
SuperTag creates two Tasks in one Session. Each Task still has its own status, result, and
permissions.

An Objective owner starts each activation with a brief of stored state. For example, an operator's
"never delegate full verification" direction stays available after the owner acts on it and wakes
again. The brief keeps operator direction separate from recent activity, with excerpts and references
when messages exceed its space. Approval decisions contribute the operator's reason, without the
AI-written request summary. See the [owner brief reference](../reference/coordination.md#owner-wakes)
for its contents and bounds.

## Follow one request

```text
message or mention
  -> SuperTag checks and stores the Task
  -> an execution system performs the work
  -> SuperTag stores the result
  -> SuperTag replies in the original thread
```

SuperTag checks the request before running it. It identifies the Tag, requester, source, enduring
responsibilities, available knowledge, allowed actions, workspace, and execution needs. SuperTag
calls those reusable responsibilities **Roles**. **Context Sets** select reusable knowledge, and
**Permission Sets** select allowed actions. SuperTag records these decisions on the Task. A later
policy change affects later Tasks without rewriting work that was already accepted.

## Owner activations and operator input

An **owner activation** is a Task that runs an Objective owner's coordination work. Each
[Task Attempt](#task-attempt) starts with a fresh conversation and a short brief of stored state:
the outcome, recent changes, open work, results, findings, and operator input that still needs
handling.

For example, an operator tells a release owner to wait for a specific candidate. That message
stays in later briefs until an owner Task Attempt receives it and then acts. An unrelated Task
running under the same Tag cannot clear it. Receiving or reading the message alone does not clear
it either. A later reply to the operator, child assignment, or actual Objective change records
handling. A no-op update does not.

When many messages accumulate, the brief favors the newest complete messages and points to stored
history for the rest. An owner waiting for operator input wakes when it arrives. It cannot begin
that wait while earlier input still needs handling. These rules help direction survive restarts
and fresh conversations. See [owner wakes](../reference/coordination.md#owner-wakes) for exact
bounds and [wait conditions](../reference/coordination.md#wait-conditions) for handling rules.

## Task

A Task records what the requester asked SuperTag to do. It keeps the status, policy, execution
needs, source, and final result. Each Task Attempt records the execution recipe that ran it; the Tag and
Session do not choose a permanent recipe.

A Task may remain pending while no compatible execution capacity is ready. Losing a connection to
an execution machine does not erase the Task.

## Session

A Session groups the Tasks that belong to one native conversation, such as a
Slack thread, GitHub issue, Linear issue, Lark chat thread, Teams channel
thread, or CLI conversation. Replies in an established Session do not need to mention `@SuperTag`
again.

Continuity within a Session is automatic and limited to that conversation. Each Session maps to one
native harness session. A new Task resumes that native session whenever the harness can load it: the
same Tag, the same Session, the same harness, and the same reply audience. A different profile of
the same harness, or a newer revision of it, can resume too.

Resuming carries the conversation, not authority. Each Task runs under the permissions, Context
Sets, workspace, and tools admitted for that Task, so a policy change applies on the next turn.
One tradeoff follows. If an operator removes a permission, earlier tool output stays in the resumed
transcript, such as a file read under the old permission. It grants no new access, but it is not
erased. The transcript holds only what people in that same conversation already saw.

When there is no usable native state, the Task receives bounded history entries from earlier
completed Tasks in the Session instead. This replay covers a first turn, a switch to another
harness, lost state, and a failed turn. A Task never receives the replay alongside a resume.

Different threads remain different Sessions, even when they invoke the same Tag. They still share
one memory: each conversation sees the Tag's open Objectives, and the Tag can search and read its
other Sessions when a question needs them. A Session is **shared** or **private**, depending on its
conversation: a direct chat or a person's CLI conversation is private to that person. See
[across Sessions](multiplayer.md#across-sessions-one-tag-one-memory).

An Objective started in a conversation reports back there: its questions, progress, approval
notices, and completion. That conversation is the Objective's home Session. The work itself runs in
the Objective's own Tasks, so planning and tool output stay out of the thread.

You can also talk to a Tag from a terminal with `supertag message tag`. See
[Talk to a Tag from the CLI](../guides/talk-to-a-tag.md).

## Task Attempt

A **Task Attempt** is one execution of a Task. Most Tasks need one Task
Attempt, but a retry after a disconnect or temporary failure creates another.
Task Attempts stream lifecycle events and output while the Task remains the
stable unit users inspect.

Only a successful Task Attempt completes the Task. Ordinary failed Task Attempts do not advance
reusable harness state or same-Session continuity. A confirmed budget stop is a narrow exception:
a successfully archived native Session can resume the same Task after an authorized allocation
renewal. It does not become successful conversation history.

## When a budget runs out

An execution budget is an allocation for one Task Attempt, not a guarantee that its assignment will fit.
SuperTag records a confirmed budget stop on the Task and leaves unfinished work stopped. It does
not automatically grant another allocation. Accepted artifacts and completed Objectives keep their
outcomes; a later manager overrun does not revoke them.

The responsible manager can use an ordinary message to a **Mailbox**, a Tag's direct delivery point,
to explain what is complete, what remains, and the allocation requested. Another authorized
Objective owner or Team lead, or an operator, decides whether to renew the allocation, reduce scope,
defer, or stop. A message expresses a decision; the authorized Task update applies it. A Tag cannot
renew its own exhausted Task. If that Tag has already stopped, the durable Task record remains
available without another model turn. A waiting parent can observe the failed child through its
existing wait mechanism.

For Objective assignments, renewal starts a new Task Attempt on the same Task. Earlier usage and allocations remain in its history.
A compatible, successfully archived native Session can preserve progress; it does not preserve a
workspace or grant new permissions. If no safe archive exists, native resumption is unavailable.
Ordinary surface conversations also stop automatic retry on confirmed exhaustion, but this
renewal interface applies to Objective assignments. A new surface request does not automatically
resume the failed native archive.
Codex's reported-token control may overshoot between usage reports; this remains visible separately
from delivery status.

Allocation fields, charging, and reserved versus spent amounts are defined in
[Budgets and allocation](../reference/coordination.md#budgets-and-allocation). To renew an
exhausted Task or increase an Objective's allocation, follow
[Respond to budget and operator requests](../guides/objective-decisions.md).

## Results and reusable artifacts

The Task itself stores the request text, response text, and structured result. Its result includes
observable outcomes and references; execution events remain attached to the producing Task Attempt.
A reviewer's result can also carry findings: problems it found, each with a severity of high,
medium, or low. The owner closes a medium or low finding as fixed or accepted. A high finding
closes only when the reviewer that reported it confirms the fix in a later review, or when an
operator closes it. See [review findings](../reference/coordination.md#review-findings).
There is no separate handoff resource created for every response.

For automatic conversation continuity, SuperTag derives bounded history entries from completed
Tasks in the same Session. These entries exclude hidden reasoning, credentials, and raw tool logs.
They are historical context, not new instructions or permission grants.

Reusable work is saved explicitly in the [artifact catalog](../reference/artifacts.md), with its
producing Task and Task Attempt and an immutable file manifest. A normal chat response is not
automatically published as an artifact. Context Sets can select permitted artifact metadata from
other Sessions; an agent then inspects or retrieves the selected artifact through its tools.

## Details for integrators

The sections below explain scheduling and live-input behavior. You can skip them if you only need
the core concepts. They use these [glossary](../reference/glossary.md) terms: the **Control
Plane** stores and schedules work; a **Worklet** connects a **Worker Host** to it; a **Worker
Profile** is a saved recipe for running a **Worker**, the code that completes a Task; a
**harness** connects the Worker to an agent system.
[Worker Host selection](../reference/scheduling-and-recovery.md#worker-host-selection) explains
how the Control Plane ranks hosts and orders the queue.

### Execution requirements

`Task.execution` describes placement requirements independently of Tag identity:

```json
{
  "requires": [{ "id": "supertag.process-output-streaming", "version": 1 }],
  "prefers": [{ "id": "supertag.process-input-streaming", "version": 1 }],
  "harness": "codex"
}
```

`requires` filters candidates; `prefers` ranks compatible candidates. Capability versions are
positive integers. Optional `profile: { "id": "local-codex", "revision": "1" }` constrains
selection to an exact recipe. An empty object leaves selection to the Control Plane's compatibility
checks. These requirements do not grant permissions or change the authorization snapshot.

An Objective coordinator supplies `execution` on `assign_task`; `requiresApproval` keeps the Task
queued until an operator updates its approval field.
A trusted integrator admitting a collaboration surface event can use the Control Plane embedding API:

```ts
await controlPlane.ingestSurfaceEvent(event, {
  execution: { harness: "codex" },
});
```

This is an integration option, not an instruction inferred from untrusted message text.
The CLI creates Tags with `supertag create tag NAME`; it has no Tag profile binding or general
Task execution flag. Worklet profile flags describe available execution recipes.

The Control Plane freezes the selected profile on the Task Attempt before execution. Recovery observes
that same Task Attempt and selection; it does not choose another Worker Profile for accepted work.
Sessions have no profile binding. A Session's native state prefers the profile that produced it,
and any profile of the same harness can resume it.

### Cancelling assigned work

An authorized Objective owner or Team lead can cancel an assignment. Cancellation stops further
results from that execution from being accepted. The Task event history records who cancelled it,
when, and its previous status in `task.cancelled`. This event is saved with the cancellation itself, so
an interrupted Worker does not need to report the action afterward.

A Worker completes its own assignment by returning its output. It should not cancel its Task or
try to accept its own running work to signal completion.

### Reusing an execution selection

The Control Plane remembers a selected profile for each Tag and set of execution
requirements. Later Tasks prefer that profile while it remains eligible and has
capacity. Context support is checked again; permissions continue to be enforced by normal
admission and execution.

If the cached profile is unavailable or no longer compatible, scheduling selects
another eligible profile and updates the cache. A Session with native state takes precedence. Its
Task prefers the profile that produced the state while that profile can run the Task, then
another profile of the same harness. Either way, the Task waits for that profile's capacity rather
than switch harness. When no profile of that harness can run the Task, scheduling picks any
eligible profile, and the Task continues from the replayed history.

This is an in-memory scheduling preference, not a Tag binding or a reservation.
The cache holds at most 1,000 selections, expires each selection after five minutes,
and evicts the least recently used entry when full. Collaboration surface and Objective
Tasks share the Control Plane cache. Restarting the Control Plane discards it and triggers
fresh selection. It does not keep Worker Hosts or sandboxes alive.

### Messages while work is running

A Session has one active conversational execution. New human messages are persisted before
routing. When the active harness advertises native input support, SuperTag delivers the message
to that exact Task Attempt using the harness's queue or steering behavior. An accepted input is
not also executed as a separate Task, unless the harness withdraws it unread at the final result,
as described below. Explicit Objective commands and messages with different
execution requirements or authority wait for a separate execution.

An uncertain acknowledgement holds the message to avoid duplicate delivery. If the same Task
Attempt later confirms that it withdrew the unread message, SuperTag clears that uncertainty.
The message runs once as its own Task on the next activation.

Without live input support, messages wait in Session order. Before the next execution starts,
SuperTag refreshes its Session history and selects the latest compatible completed session state.
Delegated Tasks can still run independently.

Codex app-server mode supports steering. Claude Code supports queueing when it runs through the
Agent SDK, which it does for Session continuity, forwarded tools, and split execution. Claude Code
reads queued input at its next turn boundary: between tool calls, or as a new turn after a turn
that ended with background work still running. The final result ends live input. Claude Code
takes no more input, and input it hasn't taken yet waits for the next Task Attempt. If Claude Code
still holds taken input the model hasn't read, SuperTag kills the process at once and waits for
it to exit before it uses the result. That unread input also waits for the next Task Attempt, even
when Claude Code had already accepted it: a teammate's message returns to the next digest, and a
person's message in the thread runs as its own Task after the current work, once. Nothing after
the final result changes the Task Attempt's outcome: no later turn, error, cancellation, or time
limit. For example, cancelling while SuperTag waits for Claude Code to exit still completes the
Task Attempt with that result. Only a cleanup failure does: the Task Attempt then fails. After the final result, SuperTag also refuses every tool call. It kills Claude Code at any
later model or hook activity, or when the process is still running 10 seconds after the result.
On macOS and Linux, it tracks detached tools and children whose parents already exited. It stops
those processes before committing the Task branch. If process inspection or ownership is uncertain,
it reports a cleanup failure and withholds the result and normal completion. It also refuses to
launch Claude Code when process inspection is unavailable. A one-shot Claude Code CLI run and the
OpenCode adapter use the Control Plane queue. A custom harness can
advertise `inputMode: "queue"` or `"steer"` alongside its
`input` control operation; it must process accepted input before reporting successful completion
and exporting its session state.

### When delivery is uncertain

If delivery or execution completion is uncertain, SuperTag blocks further execution in that
Session rather than retrying the message or resuming an older session state. The durable delivery
record retains the exact target Task Attempt. If that Task Attempt later withdraws the input as
unread before SuperTag queues a recovery notice, the message returns to the next activation
automatically. Do not resend it while that execution is active.

If the target Task Attempt ends without resolving delivery, SuperTag sends a recovery notice.
This includes deliveries left waiting for acknowledgement when the Control Plane crashes.
After restart, SuperTag waits for both the target Task Attempt to end and the 10-second
acknowledgement window to expire. A live acknowledgement wait does not trigger a notice.
It says the message may not have been delivered and asks you to resend it in a new thread.
The original Session stays blocked because its saved conversation may already contain the input.
Once SuperTag queues this notice, late acknowledgements cannot change the unknown outcome.
A late withdrawal cannot trigger an automatic retry.
Restarting the Control Plane preserves this decision and does not queue a second notice.
This message path does not yet infer answers to specific harness clarification or permission requests.

## Where to go next

- Learn how [Worker Hosts, Worklets, Workers, and harnesses](workers.md) execute a Task Attempt.
- See how [multiplayer continuity](multiplayer.md) shares completed work.
- Inspect Tasks and Task Attempts with the [resource commands](../operations/resources.md).
