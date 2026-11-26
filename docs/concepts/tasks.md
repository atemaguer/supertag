# Tasks and Sessions

A **Tag** is a persistent, proactive, multiplayer AI actor with its own identity, responsibilities, permissions, and work history. A **Session**
is one thread of that Tag's work: a conversation with a person, the conversation of an
**Objective** it owns, its inbox, or a piece of work started beneath one of those. A **Task** is
one turn of a Session. SuperTag stores each Task so the work can be inspected, retried, or
recovered.

If someone asks `@SuperTag` a question and then follows up in the same thread,
SuperTag creates two Tasks in one Session. Each Task still has its own status, result, and
permissions.

## Follow one request

```text
message or mention
  -> SuperTag checks and stores the Task
  -> an execution system performs the work
  -> SuperTag stores the result
  -> SuperTag replies in the original thread
```

SuperTag checks the request before running it. It identifies the Tag, requester, source, Roles,
available knowledge, allowed actions, workspace, and execution needs. **Roles** describe how the
Tag works and what it may do. **Context Sets** select reusable knowledge, and
**Permission Sets** select allowed actions. SuperTag records these decisions on the Task. A later
policy change affects later Tasks without rewriting work that was already accepted.

## An Objective's conversation

An Objective is a conversation with a goal. It runs where it was created, such as a Slack thread,
a GitHub issue, or a conversation in the desktop app. Each turn is a Task of the owner Tag, and
the owner replies in the same conversation.

Turns are delivered, never scheduled. A turn runs when the Objective starts, when a Session
beneath it reports, when a person messages it, when an approval is decided, and when SuperTag
sends a budget or deadline notice. Each turn ends done or waiting. When a turn ends with nothing
running and nothing asked while the Objective is still working, SuperTag wakes the Objective once
to continue or finish. The owner finishes it, or reports it blocked, with `report_objective`;
only `report_objective` changes an Objective's status from a turn. If the woken turn also ends
idle, the Objective stays working and shows as idle until a person acts.

A person directs the Objective from the CLI or by replying in its home thread. The
owner asks the person a question with `ask`, which ends the turn. The answer arrives as the
next turn. See [Define and complete an Objective](../guides/objectives.md).

## Task

A Task records what the requester asked SuperTag to do. It keeps the status, policy, execution
needs, source, and final result. Each Task Attempt records the Worker Host, harness, and model that ran it; the
Tag and Session do not choose a permanent host.

A Task may remain pending while no compatible execution capacity is ready.
`supertag placement explain TASK_ID` names the Worker Hosts that could take it and why the others
cannot. Losing a connection to an execution machine does not erase the Task.

## Session

A Session groups the Tasks that belong to one native conversation, such as a
Slack thread, GitHub issue, Linear issue, Lark chat thread, Teams channel
thread, or conversation in the desktop app. Replies in an established Session do not need to
mention `@SuperTag` again.

### Continuity and recaps

Continuity within a Session is automatic and limited to that conversation. The Session's record
is its Tasks and their events: each request, each result, and the messages the Tag wrote along
the way. SuperTag keeps that record. A native harness session is a faster way to continue it. A
new Task resumes the Session's native session whenever the harness can load it: the same Tag, the
same Session, the same harness, and the same reply audience. Another Worker Host that serves the
same harness can resume it too.

Resuming carries the conversation, not authority. Each Task runs under the permissions, Context
Sets, workspace, and tools admitted for that Task, so a policy change applies on the next turn.
One tradeoff follows. If an operator removes a permission, earlier tool output stays in the resumed
transcript, such as a file read under the old permission. It grants no new access, but it is not
erased. The transcript holds only what people in that same conversation already saw.

When there is no usable native state, the Task starts a fresh native session with a recap of
the Session's last ten finished turns instead. Each turn in the recap carries its request, its
result, and the messages the Tag wrote during it. A Tag that reads its Sessions can reread older
turns with `read_session`, and what happened during one turn with `read_turn`. A Task never
receives the recap alongside a resume.

The recap covers a first turn, lost state, and a turn that failed for a reason other than its
spending limit. SuperTag also drops a Session's native state on purpose, so the next turn starts
from the recap:

- the Session has been idle for 14 days;
- the native state is larger than 8 MiB, or the harness could not keep it at all;
- the Session's Objective ended 3 days ago;
- on Codex, the Tag's tools changed, so the fresh session registers today's tools.

So a conversation never grows too large to continue, and a Tag can change model without losing
it. A Session keeps one harness for its whole life, because a Tag keeps the harness it was
created with. A fresh native session loses the earlier tool output and the harness's own
reasoning; the recap and `read_turn` recover what matters.

### Memory

A Tag also keeps a memory: what a person told it to remember, corrections, decisions and their
reasons, and pointers to where things live. It is the memory its harness keeps itself, such as
Claude Code's auto-memory, which the Worker Host keeps for the Tag; for OpenCode and Cursor, which
keep none of their own, the Worker Host keeps a folder in the same format. What a person's conversation
keeps stays private to that person. A Work Session's own turn can only propose changes. Once a
day, after enough work, the Tag rereads its shared Sessions in a quiet review turn, corrects its
memory against them, and merges or drops what was proposed. People list and delete memories on
the Worker Host's machine; to change one, they tell the Tag. See
[Memory](../reference/coordination.md#memory).

### Other Sessions

Different threads remain different Sessions, even when they invoke the same Tag. A Tag reads
its other Sessions with `search_sessions` and `read_session`, but only shared
Sessions and those private to the same person. A direct chat or a conversation in the desktop app
is private to that person. See
[across Sessions](multiplayer.md#across-sessions-one-tag-many-conversations).

A conversation, or an Objective's conversation, can hand longer work to a **work Session** with
`start_session`. A work Session is a Session whose parent is the Session that started it. Its
first Task runs an instruction the Tag wrote, under the permissions and Context Sets of the Task
that started it, never more. It has its own native harness session, so its tool output stays out
of the conversation, and it inherits the conversation's audience. It
[sees only its own work](#what-a-work-session-sees). A work Session can't start more work
Sessions or create an Objective. Worker Host capacity controls how many run at once beneath one
Session. One Task starts or continues at most 16, or its `maxNativeAgents`
when lower, and in a conversation they [share its budget](#how-work-sessions-share-a-budget). A
Session holds at most the Tag's `maxWorkSessions` unfinished work Sessions.

A work Session runs the Tag's harness unless `start_session` names another, such as
`claude-code` for a Tag that runs on Codex. It keeps that harness for its whole life, and it and
the Session that started it exchange only messages: the instruction, its report, its questions,
and `continue_session`. A Tag can relay a change while the work Session is running. For example,
Alice's inbox can pass Bob's API change to Alice's running work Session. Codex reads
the relay during the turn; Claude Code reads it at its next tool call. If the harness cannot
receive it, SuperTag queues the message as the work Session's next turn. A relay identifies its
source and grants no new permissions. SuperTag runs it only on a Worker Host bound to the Tag that runs that
harness, and checks its permissions against what that harness can enforce, as for any Task: a
harness no bound host runs, or one that can't enforce the work Session's permissions, refuses the
start. The work Session uses the host's default model for that harness, because the Tag's models
are for its own harness.

When a work Session's Task completes, fails, or is cancelled, the Session that started it gets one
report turn: a new Task that resumes that Session's native session. It carries
the work Session's title, status, and result, and the Tag reports it to the person in the
original conversation. SuperTag records each report once, even across a restart. The report turn
has the starting Task's permissions and
can't create an Objective, because no person asked for one. An Objective's owner reviews a report
by reading it, then accepts it in its reply or sends fixes with `continue_session`.

An Objective started in a conversation reports back there: its questions, progress, approval
notices, and completion. The work itself runs in the Sessions started beneath it, so planning and
tool output stay out of the thread.

You can also talk to a Tag in the desktop app or with `supertag message`. See
[Talk to a Tag from your terminal](../guides/talk-to-a-tag.md).

### A Tag's inbox

A Tag's **Mailbox** is its inbox for messages from other Tags. A message is plain text with a
type, such as a question or a blocker, sent with `send_message`, and it arrives as a turn of the
recipient Tag. A blocker starts that turn at once; other messages wait a few seconds, so a burst
lands in one turn. Messages that arrive while that turn runs are handled together in the next
one, so a Tag answers a burst of messages once. A message's status is the status of the Task that
handled it, and it counts as seen once a turn takes it. Wake limits stop Tags from waking each
other in a loop; over a limit a message waits for the next turn and is never dropped.

A Tag may message another Tag when the two share a Team, or when the recipient accepts messages
from the sender. A grant is exactly that: this recipient accepts messages from this sender. See
[Send messages between Tags](../guides/tag-messaging.md).

The inbox is the Tag's main Session. Only it and the Tag's conversations with people reach other
Tags. An Objective's conversation and its work Sessions know only their own Tag. When an
Objective needs something from another Tag, its turn asks its own Tag's inbox with `ask_tag`,
and goes on working. The inbox turn may message other Tags, then answers the Objective with
`send_message`. The answer arrives as the Objective's next turn, like a work Session's report.
While an answer is due, the Objective is waiting, not idle.

### What a work Session sees

A work Session sees only its own work. It doesn't get the Tag's open Objectives, and it can't
read the Tag's other Sessions or Objectives. Its own history comes from its native session, and
it can reread its own earlier turns with `read_session` and `read_turn`, so the Tag's
instruction has to carry everything else it needs. Information passes between work
Sessions only through the conversation.

Nothing a work Session writes is posted while it works; the only thing posted mid-run is
SuperTag's own [approval notice](#when-a-work-session-needs-the-person). Its Task streams its
activity, which `supertag task events` prints. The Tag speaks
when the work Session finishes or waits, in a report turn. Nothing a work Session writes reaches
a person without a Tag turn.

### When a work Session needs the person

A work Session's Task ends in one of two ways: done, or waiting. It waits on an answer from the
person or on an approval, never inside a running Task. When it needs a decision or a
fact, it asks with `ask`, and its Task completes **waiting on you**. The report turn puts the
question to the person, and the conversation lists the work Sessions still waiting. When the person
answers, a later conversation Task passes the answer on with `continue_session`. That starts the
work Session's next Task, which resumes the work Session's own native session. The answer is the
Tag's relay of what the person said, so it grants nothing. The next Task runs under the continuing
conversation Task's permissions and counts against its limits. If the conversation's permissions
changed since the work Session last ran, the Tag starts a new work Session instead. Only the
the Tag that owns a work Session can relay to it. A stopped work Session starts its next Task
after its report turn has run.

When a work Session's Task calls an action that needs approval, the call doesn't run. The Task
ends, completed and **waiting on approval** of that request. The approval notice posts to the
conversation. The notice names the request and the permission that requires approval. Decide it
with `supertag approval approve` or `supertag approval deny`.
The notice says the work Session continues on its own once the person decides.
`supertag get approval` shows the work Session's description of the request. A work Session's
Task gets one notice per permission while its requests wait, however many it makes. The report
turn tells the person briefly what the work Session waits for. A chat message never approves an
action.

The request stays pending while the work Session waits on it. A decision starts the work
Session's next Task without a conversation turn, and that Task carries the decision. It runs under
the waiting Task's own permissions and context, and spends what is left of the waiting Task's
limits: the person approved that exact action, so nothing broadens. After an approval, the next
Task retries the call and it runs, once. After a denial, the next Task gets the reason and can try
another way or report back. Its report reaches the conversation like any other. A decision made
while the Task still runs takes effect when it completes. If the Tag's permissions changed while
the work Session waited, or its limits are spent, the work Session doesn't continue, and the
conversation is told why.

### Where a work Session's edits go

A work Session keeps its edits the way an Objective Task does. It works in the Workspace of the
Task that started it, even when it runs on another Tag, and the Worklet commits its changes
to the work Session's own branch, such as `supertag/session/0f3c2a9e`. A Task with no Workspace
starts its work Sessions without one. See
[Workspaces](../reference/resource-model.md#workspaces).

A work Session has one branch, and every Task of it works there. A continued Task picks up the
branch at the work Session's latest commit, sees the earlier edits, and commits on top of them. A
Task that only asked the person commits nothing and leaves the branch as it was. The report turn
names the branch, so the Tag can tell the person where the changes are. The conversation turns
themselves keep their own workspace. Editing still needs `files:write`.

A work Session with a Workspace also gets the MCP servers the Workspace provides. Its conversation's
turns use only MCP servers that the Tag's Worker Hosts declare; see
[MCP server placement](../reference/iam.md#placement).

### How work Sessions share a budget

A conversation Task and the work Tasks it starts or continues share one budget pool: that Task's
reported token and cost limits. Each new work Task may spend what the pool has left: the limit
minus what the conversation Task and every work Task drawing on the pool reported so far. Work
Tasks still running hold nothing back, so work Tasks running at once can overspend the pool by
what they spend in flight. For example, a Task limited to 10,000 tokens that reported 6,000 gives
its first work Task 4,000, and its second 4,000 too while the first has reported nothing. Once
the first reports 3,000, a third gets 1,000.

When less than a twentieth of the limit is left, in tokens or in cost, SuperTag refuses
`start_session` and `continue_session`, and the Tag does the work in its own turn.
`continue_session` draws from the turn that continues the work Session, not the one that started
it. The Task that continues a work Session after an approval decision draws from the same pool as
the Task that waited; with too little left, the work Session stops, and the conversation hears
why. A Task without reported limits passes none on. A work Task whose harness cannot enforce
one of the pool's limits, such as a Codex Tag under a cost limit, runs without it; what it reports
still counts against the pool. Report turns sit outside the pool and run
under the starting Task's full limits, so a result reaches the person even when the pool is spent.

### One budget pool per Objective

An Objective has one budget pool, and everything beneath it draws from the same pool: its own
turns and every work Session started under it. Each turn may spend at most what the budget has
left, in the Objective's currency. When less than a twentieth of the budget is left, the pool is
spent: SuperTag admits no new turn and refuses `start_session`. A finished work Session's report
turn still comes in, capped at what is left. Once the running Task Attempts settle, the
Objective's status becomes `limited`, and SuperTag tells the person in its thread.
Raise the budget with `supertag objective set-limits ID --budget-minor N` to continue.

## Task Attempt

A **Task Attempt** is one execution of a Task. Most Tasks need one Task
Attempt, but a retry after a disconnect or temporary failure creates another.
Task Attempts stream lifecycle events and output while the Task remains the
stable unit users inspect.

### When a Task Attempt is interrupted

A Worker, the process that runs a Task Attempt on its host, can die mid-turn, for example when
the laptop running it restarts. When the host proves every process of that Task Attempt stopped,
SuperTag runs the Task again on its own, as long as repeating it cannot do something twice:

```text
you   check why CI is red on #412
Tag   Looking at CI now.
      (the host restarts; the Task Attempt is lost)
Tag   Two jobs failed: lint and the cursor test. ...
      (a new Task Attempt of the same Task, told what it already said)
```

The new Task Attempt starts from a fresh checkout, so half-made edits are gone. It continues the
Session from its last saved state and is told what the lost run already said, so it doesn't
repeat itself. SuperTag does not run the Task again when the lost run left an external write in
doubt, started delivering changes, published an artifact, already sent its reply, ran an action
that needed approval, or may have run a command that reached the network outside a sandbox. A
Task gets at most three Task Attempts. Otherwise the Task fails with an unknown outcome, and the
operator inbox says which Task, which Tag, and why. See
[Redelivery](../reference/scheduling-and-recovery.md#redelivery).

Only a successful Task Attempt completes the Task. Ordinary failed Task Attempts do not advance
reusable harness state or same-Session continuity. A confirmed budget stop is a narrow exception:
a successfully archived native Session can resume the same Task after an authorized allocation
renewal. It does not become successful conversation history.

## When a budget runs out

An execution budget is an allocation for one Task Attempt, not a guarantee that the work will fit.
SuperTag records a confirmed budget stop on the Task and leaves unfinished work stopped. It does
not automatically grant another allocation. Accepted artifacts and completed Objectives keep their
outcomes; a later overrun does not revoke them.

A Tag cannot raise its own limits. A person raises an Objective's budget with
`supertag objective set-limits ID --budget-minor N`; the Objective's next turn runs against the larger
pool. Raising it starts a new Task Attempt on a Task stopped by the budget. Earlier usage and
allocations remain in its history. A compatible, successfully archived native session can preserve
progress; it does not preserve a workspace or grant new permissions. If no safe archive exists,
native resumption is unavailable. Ordinary surface conversations also stop automatic retry on
confirmed exhaustion, and a new surface request does not automatically resume the failed native
archive. Codex's reported-token control may overshoot between usage reports; this remains visible
separately from delivery status.

Allocation fields, charging, and reserved versus spent amounts are defined in
[Budgets and allocation](../reference/coordination.md#budgets-and-allocation). To raise an
Objective's budget, follow
[Respond to budget and operator requests](../guides/objective-decisions.md).

## Results and reusable artifacts

The Task itself stores the request text, response text, and structured result. Its result includes
observable outcomes and references; execution events remain attached to the producing Task Attempt.
There is no separate handoff resource created for every response.

When a Task can't resume its Session's native harness session, SuperTag derives its recap from up
to ten earlier finished Tasks in that Session. The recap holds each request, result, and the
messages the Tag wrote, each bounded. It excludes hidden reasoning, credentials, and raw tool
logs. It is historical context, not new instructions or permission grants.

Reusable work is saved explicitly in the [artifact catalog](../reference/artifacts.md), with its
producing Task and Task Attempt and an immutable file manifest. A normal chat response is not
automatically published as an artifact. Context Sets can select permitted artifact metadata from
other Sessions; an agent then inspects or retrieves the selected artifact through its tools.

## Details for integrators

The sections below explain execution settings and live-input behavior. You can skip them if you only need
the core concepts. They use these [glossary](../reference/glossary.md) terms: the **Control
Plane** stores and schedules work; a **Worker Host** runs it; a **harness** is the agent system a
Task runs on.
[Worker Host selection](../reference/scheduling-and-recovery.md#worker-host-selection) explains
how the Control Plane ranks hosts and orders the queue.

### Execution settings

A Tag's or Role's `execution` names the harness, models, and reasoning efforts its Tasks may use,
with the defaults first; a Tag's own settings override its Roles'. Worklets advertise the
harnesses and models their Worker Hosts serve, and a Tag's `runsOn` labels narrow which hosts may run it. These
settings choose where work runs; they grant no permission. A Task that asks for an execution
limit its harness cannot enforce, such as a token limit on Claude Code, is
refused when it is submitted. See
[execution settings](../reference/resource-model.md#execution-settings).

The Control Plane records the selected harness and model on the Task before execution. Recovery
keeps that selection. A Session's native state can be resumed by any Worker Host that serves the
harness that produced it. A Tag keeps the harness it was created with: `supertag tag put` and
`supertag apply` refuse to change it, so to move work to another harness, create a new Tag. A
[work Session](#other-sessions) may still run another harness than the Tag that started it.

### Cancelling a Task

An operator cancels one Task with `supertag task cancel ID`, and every open Task of an Objective
with `supertag objective cancel ID`. Cancellation stops further
results from that execution from being accepted, and the Worklet stops its Worker.
The Task event history records who cancelled it, when, and its previous status. This event is
saved with the cancellation itself, so an interrupted Worklet does not need to report the
action afterward.

A harness adapter completes its own Task by returning its result. It should not cancel its Task to
signal completion.

### Messages while work is running

A Session has one active conversational execution. New human messages are persisted before
routing. This holds for a conversation in the desktop app, and
for a thread in Slack, Microsoft Teams or Lark. When the active harness advertises native input
support, SuperTag delivers the message to that exact Task Attempt using the harness's queue or
steering behavior. An accepted input is not also executed as a separate Task, unless the harness
withdraws it unread at the final result, as described below. Messages with different execution
requirements or authority wait for a separate execution, and so does input queued by someone
other than the person the running turn answers: it waits for its own turn. A `/goal` message never
reaches a turn: the Control Plane creates its Objective and answers it. SuperTag never interrupts a
running turn for a new message.

An uncertain acknowledgement holds the message to avoid duplicate delivery. If the same Task
Attempt later confirms that it withdrew the unread message, SuperTag clears that uncertainty.
The message waits for the Session's next turn and runs there once.

Without live input support, messages wait in Session order, as described in
[messages that wait](#messages-that-wait). Before the next execution starts, SuperTag refreshes
its Session's recap and selects the Session's native state, if it can resume it. Sessions started
beneath this one still run independently.

Codex supports steering. Claude Code runs through the Agent SDK and supports queueing. Claude Code
reads queued input at its next turn boundary: between tool calls, or as a new turn after a turn
that ended with background work still running. The final result ends live input. Claude Code
takes no more input, and input it hasn't taken yet waits for the next Task Attempt. If Claude Code
still holds taken input the model hasn't read, SuperTag kills the process at once and waits for
it to exit before it uses the result. That unread input also waits for the next Task Attempt, even
when Claude Code had already accepted it: another Tag's message returns to the Tag's inbox, and a
person's message in the thread waits for the next turn, once. Nothing after
the final result changes the Task Attempt's outcome: no later turn, error, cancellation, or time
limit. For example, cancelling while SuperTag waits for Claude Code to exit still completes the
Task Attempt with that result. Only a cleanup failure does: the Task Attempt then fails. After the final result, SuperTag also refuses every tool call. It kills Claude Code at any
later model or hook activity, or when the process is still running 10 seconds after the result.
On macOS and Linux, it tracks detached tools and children whose parents already exited. It stops
those processes before committing the Task branch. If process inspection or ownership is uncertain,
it reports a cleanup failure and withholds the result and normal completion. It also refuses to
launch Claude Code when process inspection is unavailable. The OpenCode and Cursor adapters use
the Control Plane queue. A custom
[harness adapter](../guides/harness-adapters.md) takes live input with `Harness.TakeLiveInput` and
records what it did with `SettleLiveInput`; it must process accepted input before it completes the
Task Attempt and exports its checkpoint.

### Messages that wait

When the next execution starts, it also takes in the person's messages queued behind it. Several
quick messages get one turn and one reply:

```text
you   check why CI is red on #412
you   also the flaky cursor test
you   and post the fix as a PR if it's small
Tag   (one turn reads all three; one reply answers them)
```

The first message runs, and the harness gets the later ones after its prompt, oldest first. Each
joined message settles as input that Task accepted, so it gets no reply of its own. A turn takes
in at most 10 messages and 16 KiB of joined text. The Tag's own turns end the run of messages it
takes in, which keeps them in order: a Schedule firing, a notice, a Mailbox delivery or a report.
So does a message from someone else, or with a different audience or execution requirements: it
waits for its own turn. In a Slack, Microsoft Teams or Lark thread, everyone's messages count as
the thread's, so one turn can take in several people's messages. GitHub and Linear events always
run as their own turns. The first claim of a turn fixes the messages it answers: a retry or a
replayed claim presents the same ones, and the messages a lost Task Attempt took in.

### When delivery is uncertain

If delivery or execution completion is uncertain, SuperTag blocks further execution in that
Session rather than retrying the message or resuming an older session state. Uncertain execution
blocks the Session until someone decides about it, from the inbox, the conversation, or
`supertag task resolve-attempt`. When its Worklet confirmed that it stopped and it recorded no
effect, SuperTag records it as failed on its own a minute later and the Session's next turns run;
the uncertain Task still never runs again on its own (see
[Uncertain Task Attempts](../reference/scheduling-and-recovery.md#uncertain-task-attempts)). The durable delivery
record retains the exact target Task Attempt. If that Task Attempt later withdraws the input as
unread before SuperTag queues a recovery notice, the message returns to the Session's next turn
automatically. Do not resend it while that execution is active. When SuperTag runs the Task
again after a lost Worker, the new Task Attempt answers the message instead, and no one needs to
decide (see [Redelivery](../reference/scheduling-and-recovery.md#redelivery)).

If the target Task Attempt ends without resolving delivery, SuperTag sends a recovery notice.
This includes deliveries left waiting for acknowledgement when the Control Plane crashes.
After restart, SuperTag waits for both the target Task Attempt to end and the 10-second
acknowledgement window to expire. A live acknowledgement wait does not trigger a notice.
It says the message may not have been delivered and asks you to resend it in a new thread.
The original Session stays blocked because its saved conversation may already contain the input.
Once SuperTag queues this notice, late acknowledgements cannot change the unknown outcome.
A late withdrawal cannot trigger an automatic retry.
Restarting the Control Plane preserves this decision and does not queue a second notice.
This message path does not infer answers to specific harness clarification or permission requests.

## Where to go next

- Learn how [Worker Hosts, Worklets, Workers, and harnesses](workers.md) execute a Task Attempt.
- See how [multiplayer](multiplayer.md) shares completed work.
- Inspect Tasks and Task Attempts with the [resource commands](../operations/resources.md).
