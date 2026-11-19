# Objective coordination reference

This page is the exact contract behind SuperTag's [Objective](glossary.md#objective),
[Team](glossary.md#team), [Mailbox](glossary.md#mailbox) and
[Workstream](glossary.md#workstream) guides.

An **Objective** is an outcome a [Tag](glossary.md#tag) owns, with a budget, a deadline and a
status. A **Tag** is a persistent AI actor with its own responsibilities and permissions. A
**Session** is one thread of that Tag's work, and a **Task** is one turn of a Session. A **Team**
is a flat list of member Tags. A Tag's **Mailbox** is its inbox for messages from other Tags, and
a Team's **Workstream** is its shared record of posts.

For procedures, start with [Define and complete an Objective](../guides/objectives.md),
[Organize Tags into Teams](../guides/teams.md), [Share progress in a
Workstream](../guides/workstreams.md), [Send messages between
Tags](../guides/tag-messaging.md), [Maintain an ongoing
responsibility](../guides/ongoing-responsibilities.md), [Check an Objective's
progress](../guides/objective-overview.md), and [Respond to budget and operator
requests](../guides/objective-decisions.md).

Other terms used here are defined in the glossary: [Role](glossary.md#role),
[Task Attempt](glossary.md#task-attempt), [Permission Set](glossary.md#permission-set),
[Control Plane](glossary.md#control-plane), [Gateway](glossary.md#gateway),
[Surface Account](glossary.md#surface-account), [Worker Host](glossary.md#worker-host),
[harness adapter](glossary.md#harness-adapter), and [Workspace](glossary.md#workspace).

## How coordination works

Three rules cover every exchange in SuperTag.

1. **Delivery is a Task.** A person's message, a work Session's result, a Mailbox message, an
   addressed Workstream post, an answer and an approval decision all arrive the same way: as the
   next Task of one Session of the recipient Tag, carrying who it is from.
2. **One wait state.** A Task ends done or waiting. `ask` waits on an answer; a gated action waits
   on an approval. The reply arrives as that Session's next Task.
3. **One address rule.** A work Session may address only the Session that started it. A Tag's
   conversations, its Objectives' conversations and its inbox turns may address the work Sessions
   they started, Tags in their Team, and the Workstream. To get another Tag's work, start a
   Session of that Tag with `start_session {tag}`.

An Objective is a conversation with a goal. A person directs it from the terminal UI or the
thread where it was created. Its owner Tag asks the person when it needs a decision. The work
happens in Sessions started beneath it, including Sessions of other Tags in its Team.

### A worked example

Maya runs `@SuperTag /goal Ship SSO for the admin app` in a Slack channel where the Tag
`planner` listens. SuperTag creates the Objective `ship-sso-for-7f3a9c2e`, says so in the thread,
and starts its conversation there.

```text
#admin-app thread
  Maya      @SuperTag /goal Ship SSO for the admin app
  SuperTag  Started Objective ship-sso-for-7f3a9c2e: Ship SSO for the admin app
  planner   Starting. I'll have builder do the provider work and reviewer check it.
            ├─ work Session of builder   "SAML provider"      → reports back
            └─ work Session of reviewer  "Security review"    → reports back
  planner   Do we need SCIM provisioning in this release?        (ask)
  Maya      No, next quarter.
  planner   Done. SSO ships behind the sso flag, and the security review passed.
```

`planner` owns the Objective, and `builder` and `reviewer` are the other members of its Team. Each
work Session's result returns to the Objective's conversation as a turn. `planner`'s `ask` reaches
Maya in the thread and in `supertag get inbox-item`; her reply is the conversation's next turn. Every
turn, in every Session, draws on the Objective's one budget pool.

## Objectives

### Creating an Objective

- Creation requires an outcome statement: the result, how success is verified, what must not
  change, and when to ask a person. The outcome may be up to 8,000 characters, and is fixed
  afterwards. Changing it takes a new Objective.
- The ID is caller-chosen and required: `supertag objective create OBJECTIVE_ID OUTCOME --owner TAG`.
- The owner Tag must be active.
- `--team TEAM` names the Team whose members the Objective may start work Sessions of. Without
  one, every work Session runs on the owner Tag.
- `--deadline` takes an RFC 3339 time with a time zone. See [Deadlines](#deadlines).
- `--budget-minor` and `--currency` set the [budget pool](#the-budget-pool).
- `--runtime-action` narrows the Objective's [runtime actions](#objective-runtime-actions);
  `--no-runtime-actions` grants none.
- `--ongoing` makes the Objective a continuing responsibility that only an operator ends.
- The Objective's work runs in the Workspaces of the Tags that do it: the owner's, and those of
  the Tags its work Sessions run on. See [Workspaces](../guides/workspaces.md).
- Creating an Objective starts it: the Control Plane queues the first turn of its conversation in
  the same step. Every refusal is an error, and nothing is stored. A turn that no Worker Host can
  take waits; `supertag placement explain TASK_ID` says why. See [Waiting turns](#waiting-turns).
- `--operation-id` makes a retry return the first result instead of creating twice.
- Retrying the same definition returns the existing record with its current status. A different
  definition with the same ID is refused.

A person creates an Objective from any conversation with `/goal <outcome>`. The command must
start the person's own message; in a Slack or Microsoft Teams channel, it follows the mention of
the app: `@SuperTag /goal <outcome>`. The Control Plane parses only that message, never history,
quotes, code, or model output, and the message never reaches a turn. The Control Plane creates
the Objective itself, answers with its ID, and starts its first turn at once:

- The conversation's Tag owns it. Its ID is the outcome's first words and a random suffix, such
  as `ship-sso-for-7f3a9c2e`.
- From a Slack or Microsoft Teams thread, that thread is its home: later messages there steer it,
  its turns answer there, and the runtime actions are what that location grants the Tag.
- From a conversation in the terminal UI, the desktop app, or the API, the person who wrote
  `/goal` creates it with their own authority, and the conversation is its home. The Objective has
  the conversation's audience: only that person's turns see it. The Control Plane alone records
  which conversation created an Objective; no command or API call can set it.
- `/goal` with no outcome creates nothing; the answer says how to write the command. Use
  `supertag objective create`, or the terminal UI's Create Objective form, to set a Team, a
  deadline, or a budget.

### Objective runtime actions

Runtime actions, such as `files:write` and `commands:execute`, let a turn edit files or run
commands. `runtimeActions` is the Objective's ceiling for them.

- Omitted, it defaults to the actions the owner Tag's Permission Sets allow: the union across its
  active Roles, resolved once at creation and stored. Later Permission Set changes do not rewrite
  it.
- An Objective created from a thread gets the invoking Task's runtime actions, and its turns keep
  that Task's approval requirements.
- An operator's explicit list only narrows. SuperTag drops an action the owner's Permission Sets
  do not allow and returns a warning naming it.
- Every turn of the Objective, in the owner's conversation and in each work Session, runs with
  that Tag's Roles narrowed to this list. The Permission Sets of the home thread's location do not
  apply: the Objective is not a conversation there.
- An inherited action keeps its approval requirement. A turn waits for approval when its own
  Permission Sets, or the owner's, mark the action `approvalRequired: true`.
- If both the Objective and the delegating Task allow `files:delegate-write`, a different
  Team member whose Role grants `files:write` can write in its delegated Session. The
  owner's own Sessions receive no write access from this grant.
- Only operators change the list afterwards, with
  `supertag objective set-runtime-actions ID --runtime-action ACTION ...`. The new list replaces the old one,
  stays within the owner's Permission Sets at that moment, and applies to turns admitted
  afterwards.

### The home thread

The Objective's **home thread** is where its conversation runs and replies. The Control Plane
picks it in this order:

1. the verified surface Task an operator set as the Objective's notification Task;
2. the surface Task that created the Objective;
3. the Control Plane's default operator notification Task.

Without any of these, the Objective has no home thread; direct it from the terminal UI or the CLI.

Every turn of the conversation is delivered into that thread's location, and the owner's final
reply is posted there exactly as written. While an Objective is open, a plain reply in its home
thread goes to the Objective, not to the thread's own conversation with the Tag.

### What delivers a turn

| Trigger | What arrives |
| --- | --- |
| Start | SuperTag's note that the Objective has started |
| A work Session's result | That Session's report |
| An operator message | The person's text, as written |
| An answer to `ask` | The person's answer |
| An approval decision | SuperTag's record of the decision |
| A budget, deadline or overlap notice | SuperTag's text |
| An idle turn | SuperTag's wake, once; see [The idle rule](#the-idle-rule) |

Each delivery is one Task. The Control Plane allows one due turn per Session, so an Objective's
conversation is a serial actor: a second trigger during a running turn waits and is delivered
next.

### Operator messages

A message delivers the next turn of the conversation, attributed to the operator. Send it from
the Objective view in the terminal UI with `m`. For scripts, submit a turn to the owner in the
Objective's Session with `supertag task submit`; see [Control Plane API](control-plane-api.md#operator-services).

In a Slack home thread, a plain reply also delivers the next turn. `@SuperTag approve`
acts as `supertag objective review ID approve`, and `@SuperTag pause` and `@SuperTag resume` act as the
pause and resume commands. The operator ID is the provider and the user, such as `slack:U123`.
Anyone who may create Objectives in that channel may do this.

- A message never changes a budget, permissions or any other resource. Apply the resource change
  with its own command first; replying "approved" alone changes no allocation.
- A `blocked` Objective returns to `working` on a message. A `limited`, paused, `completed`, or
  `cancelled` Objective takes no messages; a message to one is refused until an operator raises
  the limit or resumes it, and for good once it is closed.
- The same `idempotencyKey` with the same text returns the original delivery; the CLI generates a
  new key for each command.
- The owner's answer to the message is its next reply in the home thread.

`supertag objective review ID approve` completes a `ready_for_review` Objective. The owner's
assessment, recorded with `ready_for_review`, becomes the completion summary.
`supertag objective review ID request-changes --feedback TEXT` returns it to `working` with that
feedback as the owner's next turn. `supertag objective complete ID --summary-file FILE` completes
any open Objective with an operator's assessment.

### Asking a person

An Objective's turn calls `ask {text}` with one concise question, then ends its turn. The
Task ends waiting. The question reaches the person in the home thread and as a `question` item
in the operator inbox. An answer from **Waiting on you** in the terminal UI or from the home
thread becomes the conversation's next turn. The same tool in a work Session asks the Session that started it.

### Work and delegation

An Objective's turn starts work with `start_session {title, instruction, tag?, harness?}`:

- The instruction must be self-contained. A work Session sees only its own work, never the
  Objective's conversation or the Tag's other Sessions.
- Without `tag`, the work Session runs on the owner Tag. With `tag`, it runs on another Tag, whose
  parent Session is the Objective's conversation. The target must be active, bound to a Worker
  Host and a member of the Objective's Team; otherwise the call is refused and says why.
- A delegated Session runs with the target Tag's Roles, narrowed to the Objective's runtime
  actions and to the starting turn's authorization.
- Only an Objective's own turn is offered `tag`. A conversation's or an inbox turn's
  `start_session` runs on its own Tag.
- The work Session works in the Workspace of the Task that started it, including when it runs on
  another Tag. Edits go to that Session's one branch, and each later Task of the Session commits
  on top of them.
- `harness` names a built-in harness for the work Session: `codex`, `claude-code`,
  `openai-agents`, `opencode`, or `cursor`. Without it, the work Session runs its Tag's harness.
  The work Session keeps that harness for its whole life, including when it is continued, and
  talks to the Session that started it only through messages. The start is refused when the name
  is unknown, when `tag` names another Tag whose harness differs, when no Worker Host bound to the
  Tag runs that harness, or when that harness can't enforce the work Session's permissions or
  limits. A work Session on another harness uses that host's default model.
- At most four work Sessions run at once per Session; later ones wait.

A work Session's result returns to the Objective's conversation as a turn. The owner reads it,
then either accepts it in its reply or sends fixes with `continue_session {sessionId, message}`.
`continue_session` across Tags is checked against a fresh authorization, not the authorization
captured when the Session started.

### Open work Sessions

A Tag may have at most `maxWorkSessions` work Sessions **open** at once, 8 by default. The count
covers every work Session the Tag started, across all its conversations and Objectives. A work
Session stays open after it reports, so the Tag can send fixes with `continue_session`. It closes
when:

- the Tag calls `close_session` because the work is done or no longer needed;
- an operator runs `supertag session close ID`;
- the pull request its Workspace's review landing opened is merged, which the Gateway's GitHub
  connector reports (`closed: pull request merged`). A pull request closed without merging leaves the work
  Session open, so it can still send a revision;
- its Objective completes or is cancelled.

A work Session that has had no turn, continuation, or delivery change for 14 days also closes, as
`closed after 14 days without activity`, so the limit cannot fill up with abandoned work.
Closing a work Session leaves a turn it already queued. An explicit close is final: the work
Session cannot be continued. An idle close is not: `continue_session` reopens the work Session
when the Tag is under its limit, and at the limit is refused with the same list as
`start_session`. `supertag get session ID` shows `closed_at_ms` and `close_reason`, and the
desktop app and the terminal UI mark a closed work Session, such as `closed: idle`.

At the limit, `start_session` starts nothing and the turn goes on. The tool returns an error
that lists the open work Sessions, each with its ID, title, and state, and asks the Tag to
continue one or close one. A work Session in a conversation the turn may not see is listed without
its title. The `start_session` description says how many are open, such as "3 of 8", and so do
`supertag get session`, `supertag get tag`, the desktop app's conversation, and the terminal UI's
work Sessions pane.

Set the limit, from 1 to 64, with `supertag tag put TAG --max-work-sessions N`, the
`maxWorkSessions` field of a Tag manifest, or the New Tag form of the desktop app or the terminal
UI.

### The idle rule

An Objective's turn should end with work running, a question asked, or the Objective finished.
When a turn ends with none of those, and the Objective is still `working` and not paused:

1. The Control Plane wakes the conversation once, saying that nothing is running and nothing was
   asked, and asking the owner to continue or to call `report_objective`.
2. When that woken turn also ends idle, nothing more happens: the Objective stays `working` with
   `idle_since_ms` set. `describe objective` and the terminal UI's Objective view say "Idle since
   …", and the owner Tag's **Activity** in the desktop app and the terminal UI lists it. A message
   or new work clears it, and so does any status change.

Only the owner's `report_objective` changes an Objective's status from a turn (`blocked`,
`ready_for_review`, or `completed`); operators change it with their own commands.

An Objective is idle only when all of these hold: its latest conversation turn completed or
failed, it asked no question and waits on no approval, no turn is pending or running in any of its
Sessions, no work Session result is unreported, and no active [Schedule](#schedules) will wake it. Ongoing Objectives are exempt: they may rest
until their next message.

### Statuses

Statuses are `working`, `blocked`, `limited`, `ready_for_review`, `completed` and `cancelled`.

- A harness adapter reports an Objective signal with each owner turn's result: `progress`,
  `ready_for_review`, `completed`, or `blocked`. With the built-in adapters, the owner calls
  [`report_objective`](#the-tools); a turn that does not call it reports `progress`. An operator
  records a status with the commands below.
- An operator completes with `supertag objective complete ID`, and approves or sends back a
  `ready_for_review` assessment with `supertag objective review ID`. Neither can set `cancelled`;
  see [Cancelling an Objective](#cancelling-an-objective).
- The CLI commands `objective set-limits`, `objective set-runtime-actions`, `objective complete`
  and `team update` take `--expected-revision` as optional. Given, the change is refused when the
  resource changed since that revision. Without it, `team update` reads the current revision, and
  after a conflict caused by another writer it rereads and retries once, only when the other
  change left the fields it is changing untouched.
- `blocked` records that the Objective cannot go on without a person. It is not an execution
  pause.
- `limited` records a spent budget or a passed deadline. Only an operator raising the budget or
  moving the deadline leaves it, and that returns the Objective to `working`.

### Completing an Objective

- A completion records an assessment of the outcome, citing its evidence. It is an explicit
  recorded decision, not automatic verification. A signal from the owner's turn uses the turn's
  result as the assessment; `objective complete` takes it from `--summary-file`.
- An owner stops at `ready_for_review` instead when the statement asks for a person's review, and
  an operator approves it or sends changes with `objective review`.
- An Objective created with `--ongoing` is a continuing responsibility. Only an operator ends it.
- Completion admits no new turns. The exact Task Attempt that completed the Objective may finish
  its reply and clean up.
- Pending approval requests of the Objective expire.
- Queued and waiting Tasks in the Objective's Sessions are cancelled, each with a recorded reason.
- The Objective's Team is not deleted. A Team outlives the Objectives that name it; see
  [Teams](#teams).

The Control Plane settles these leftovers right after completion or cancellation, and again on its
regular sweep.

### Pausing an Objective

- Only an operator pauses or resumes, with `supertag objective pause ID` and
  `supertag objective resume ID`, the `Objectives` service's `PauseObjective` and
  `ResumeObjective`, or
  `@SuperTag pause` and `@SuperTag resume` in the home thread. No coordination tool
  pauses, so no Tag can.
- A pause records `pausedAt` and leaves `status` unchanged. While it is set, no turn of any of the
  Objective's Sessions starts: deliveries stay pending rather than failing. Running Task Attempts
  keep their authority and settle normally.
- Resuming clears `pausedAt` and delivers a turn summarizing what changed while the Objective was
  paused. Completed and cancelled Objectives cannot be paused. Both calls are idempotent and
  report `changed`.

### Cancelling an Objective

- Only an operator cancels, with `supertag objective cancel ID [--reason TEXT]` or
  `Objectives.CancelObjective`. No Objective signal can set `cancelled`.
- `cancelled` is terminal. Later status, deadline and budget updates fail, and no new turn, wake
  or limit warning follows.
- The Objective records its cancellation time and optional reason. The revision increments once.
- Every queued, claimed, running, or uncertain Task in the Objective's Sessions is cancelled, and
  running Task Attempts stop.
- Cancellation needs no revision. Cancelling a cancelled Objective succeeds and cancels any Task
  still open. Cancelling a completed Objective fails with
  `failed_precondition`.

## Budgets and allocation

### Units and currency

- `budgetLimitMinor` (CLI `--budget-minor`) is the Objective's limit in minor units chosen by the
  operator: `200000` is $2,000 in US cents.
- `budgetCurrency` (CLI `--currency`) denominates those units. It must be an uppercase
  three-letter code, such as `USD`, and is valid only with a limit.
- A budget without a currency stays an internal allocation. It cannot be compared with
  provider-reported money.

### The budget pool

An Objective with a budget in a currency has one pool, and every turn beneath it draws on the
same pool: the conversation's turns and every work Session's Tasks, however deep.

- Each turn is admitted with `maxReportedCost` capped at the limit less the Objective's reported
  spend. A turn that asked for less keeps its own smaller ceiling.
- Turns still running hold nothing back, so turns running at once can overspend the pool by what
  they spend in flight.
- When what remains falls below 5% of the limit, no new turn is admitted. `start_session` and
  `continue_session` are refused, and so is an operator's message; the refusal names the command
  that raises the limit.
- A finished work Session's report turn is still admitted below 5%, capped at what remains, so
  the owner hears the result. With nothing left, it stops on its first model call.
- Reported spend is the sum of the latest provider-reported cost of each Task Attempt in the
  Objective's Sessions, in the Objective's currency. The Control Plane recomputes it from
  persisted usage evidence on its regular sweep, so it survives restarts.
- Codex costs are estimates from token usage and model prices, so the total can differ from
  provider billing.

A conversation outside an Objective has a pool of the same shape for each turn: that turn's
reported token and cost limits, shared with the work Sessions it starts or continues. See
[how work Sessions share a budget](../concepts/tasks.md#how-work-sessions-share-a-budget).

### Monetary budgets

A budget with a currency caps provider-reported cost across the whole Objective. A turn whose
harness enforces a reported cost limit, Claude Code in USD, runs with what is left as its limit.
Other turns run without one: their cost still counts once reported, and no new turn starts once
the pool is spent, but a running turn can spend past what was left. Codex and Cursor report
estimated USD cost; OpenCode reports none, so its turns count as unknown and never move the
total. See [execution limits](worker.md#execution-limits).

| Reported spend | Effect |
| --- | --- |
| Reaches 80% of the limit | One `objective_budget_threshold` warning, delivered to the conversation and the operator inbox |
| Reaches the limit | New turns are refused; running Task Attempts finish, then the Objective becomes `limited` |

Running Task Attempts keep their authority when the pool runs out, and their eventual cost counts
toward reported spend even above the limit. `supertag describe objective ID` shows the overrun.
The Objective becomes `limited` once they have all settled, and only a raised budget or a moved
deadline leaves that status.

A Task Attempt that finished without reporting cost counts as unknown, not zero. The overview's
`pool` counts those Task Attempts in `unknown_cost_attempts`: actual spend may be higher than the
reported total.

For example, an Objective has `budgetLimitMinor` 300000 and `budgetCurrency` `USD`, a $3,000 cap.
At $2,400 reported the operator receives one warning. At $3,000 new turns stop while running Task
Attempts finish. If they finish at $3,080, the Objective shows an $80 overrun and status
`limited`. Raising the limit to 400000 returns it to `working`.

### Increasing the limit

- Only an operator raises a finite limit, with
  `supertag objective set-limits ID --budget-minor N [--expected-revision N]`, or
  `Objectives.SetLimits`. Tags cannot.
- The new limit must exceed the old one and keep the currency. A stale revision is rejected;
  refresh the inbox before deciding.
- Admission resumes once the new limit exceeds reported spend, and warnings are raised again
  against it. The increase is audited in the Objective's change history.

The API rules are in
[`SetLimits`](control-plane-api.md#operator-services). For the
procedure, see [Respond to budget and operator requests](../guides/objective-decisions.md).

## Deadlines

A deadline is fixed behavior, not a setting. Its *window* runs from when an operator last set the
deadline, or from the Objective's creation, to the deadline itself.

| When | Effect |
| --- | --- |
| 24 hours before | One `objective_deadline_approaching` warning |
| A quarter of the window left | One `objective_deadline_approaching` warning |
| 1 hour before | One `objective_deadline_approaching` warning |
| At the deadline | New turns are refused; one `deadline_passed` notice |
| After the grace period | Running Task Attempts lose authority and stop |

A warning whose time had already passed when the deadline was set is skipped, and warnings at the
same offset count once. Each warning states the time left in readable units, such as "about 15
minutes left".

| Window | Warnings | Grace |
| --- | --- | --- |
| 2 days | 24 hours, 12 hours and 1 hour left | 15 minutes |
| 12 hours | 3 hours and 1 hour left | 15 minutes |
| 60 minutes | 15 minutes left | 15 minutes |
| 20 minutes | 5 minutes left | 5 minutes |

The grace period is 15 minutes, capped at a quarter of the window and never less than 1 minute. A
deadline that had already passed when it was set keeps the full 15 minutes. During the grace
period running Task Attempts keep their authority and may finish, and the owner may still complete
the Objective with evidence.

Each warning and the deadline passing reach the conversation as a notice and the operator inbox as
an `objective_limit` item.

Only an operator moves a deadline, with `supertag objective set-limits ID --deadline ISO`. The new
deadline may replace one that passed; normal delivery resumes, the owner receives one notice with
the old and new deadline, and warnings are raised again against a window that starts at the move.

When the deadline's grace period ends, or the Objective is completed or cancelled, the Control
Plane cancels the Objective's open Tasks, and their running Task Attempts stop.

## Coordination tools

### Who receives which tools

Only the root harness actor receives SuperTag coordination tools. Harness-native subagents are
local to one execution and are not Tags. Codex native subagents are disabled, because Codex cannot
yet give them a tool set distinct from the root actor's. The Codex adapter and the Claude Code,
Cursor, and OpenCode adapters offer the same tools; a custom harness adapter calls the matching
services its Worklet serves.

Which tools a Task gets depends on the kind of turn it is. SuperTag refuses a direct call to a
tool the turn does not get; it does not only leave it out of the list.

| Turn | Tools |
| --- | --- |
| An Objective's conversation | `start_session`, `continue_session`, `ask`, `report_objective`, `send_message`, `read_mailbox`, `post`, `read_workstream`, `read_review_patch`, `schedule` and `cancel_schedule` (with `schedule:create`), `remember` and `forget`, and the [Session reads](#recalling-other-sessions) |
| A conversation with a person, or a surface thread | `start_session`, `continue_session`, `send_message`, `read_mailbox`, `post`, `read_workstream`, `read_review_patch`, `schedule` and `cancel_schedule` (with `schedule:create`), `remember` and `forget`, and the Session reads |
| A Tag's inbox | `start_session`, `continue_session`, `send_message`, `read_mailbox`, `post`, `read_workstream`, `read_review_patch`, `remember` and `forget`, the Session reads, and `stay_quiet` |
| A Tag's memory review | `remember` and `forget`, the Session reads, and `stay_quiet` |
| A work Session's report turn | `remember` and `forget`, and the Session reads |
| A work Session's turn | `ask` |

A turn no person is waiting on also gets `stay_quiet`: a Schedule's wake-up, an Objective's
notice or idle wake, a memory review, and an inbox turn. See [Quiet results](#quiet-results).

A work Session sees only its own work: it cannot message another Tag, start more work, or read
the Tag's other Sessions or Objectives. It may reread its own earlier turns with `read_session`
and `read_turn`. Its final reply returns to the Session that started it.
A gated action needs no tool of its own: SuperTag requests approval
when the Tag makes the call; see [Approval requests](#approval-requests). The [artifact tools](artifacts.md#agent-tools) are separate.

### The tools

| Tool | Input | Effect |
| --- | --- | --- |
| `start_session` | `title` (up to 120 characters), `instruction` (up to 8,000), optional `harness`, and `tag` on an Objective's own turn | Starts a work Session; see [Work and delegation](#work-and-delegation) |
| `continue_session` | `sessionId`, `message` (up to 8,000 characters) | Starts that work Session's next Task |
| `close_session` | `sessionId` | Closes one of the Tag's work Sessions, so it stops counting toward the [limit](#open-work-sessions) |
| `ask` | `text` (up to 16,000 characters; 2,000 in a work Session) | Ends the Task waiting on a person's answer |
| `report_objective` | `status` (`ready_for_review`, `completed`, or `blocked`; not `completed` for an ongoing Objective), `summary` (up to 16,000 characters) | When the turn ends, sets the Objective's status; the summary becomes the turn's result |
| `send_message` | `to`, `text` (up to 8,000 characters), optional commit review | Delivers a message to another Tag's Mailbox |
| `read_mailbox` | optional `limit` (1–16), `cursor` | Reads the Tag's Mailbox |
| `post` | `text` (up to 16,384 characters), optional `to` (up to 20 Tags) | Posts to the Team's Workstream |
| `read_workstream` | `afterSequence` or `cursor`, `limit` (1–16, default 16) | Reads the Team's Workstream |
| `read_review_patch` | a commit review | Reads the patch a [commit review](#commit-reviews) asks about |
| `list_sessions` | `limit` (1–20, default 20), `offset` | Lists the Tag's other visible Sessions, most recent first |
| `search_sessions` | `query` (1–200 characters), `limit` (1–20) | Finds completed turns of visible Sessions whose request or result contains the query |
| `read_session` | `sessionId`, `limit` (1–20), `before` | Reads one page of a visible Session's finished turns, oldest first |
| `read_turn` | `taskId`, `limit` (1–100, default 50), `after` | Reads one page of what happened during a visible finished turn: the Tag's messages, its activity, and its progress, in order |
| `list_objectives` | `limit` (1–20), `offset` | Lists the Tag's open Objectives it may see |
| `read_objective` | optional `objectiveId` | Reads an Objective's status, limits, budget pool, Team, and Sessions |
| `schedule` | `note` (up to 4,000 characters), and `at` or `every`, optional `timeZone` | When the turn succeeds, creates a [Schedule](#schedules) that wakes the Tag later in this Session |
| `cancel_schedule` | `scheduleId` | Cancels one of the Tag's Schedules in this Session |
| `remember` | `text` (up to 500 characters), optional `replaces` | When the turn succeeds, keeps a [note](#memory), replacing the one `replaces` names |
| `forget` | `memoryId` | When the turn succeeds, forgets one of the Tag's notes |
| `stay_quiet` | `note` (up to 500 characters) | Ends the turn without posting anything; see [Quiet results](#quiet-results) |

Reads return history, never instructions, and grant no authority.

`report_objective` is offered only on a turn of the owner's Session of an open Objective. Its
status applies when the turn succeeds. A turn that fails, asks a question, or waits for approval
reports progress instead, so `ask` and `report_objective` exclude each other. When it is called
more than once, the last call wins. Only an operator ends an `--ongoing` Objective, so on its
turns the tool offers `ready_for_review` and `blocked` only. A `completed` report is refused and
the turn goes on. No tool creates an Objective. A person's `/goal` creates one; see
[Creating an Objective](#creating-an-objective).

### Recalling other Sessions

A Tag is one actor across many conversations. Each turn of a conversation, an Objective's
conversation, or the Tag's inbox starts with the Tag's portfolio: its open Objectives that the turn
may see, most recently updated first, and a reminder that it can recall its other Sessions. The
portfolio is state, not instructions, and is bounded to about 3,800 characters.

- A turn sees a Session of its own Tag that is shared, or private to the same person. See
  [Shared and private Sessions](../concepts/multiplayer.md#shared-and-private-sessions).
  Sessions of other Tags are never visible.
- `list_sessions` and `search_sessions` leave out the turn's own Session. `read_session` reads the
  turn's own Session too.
- Each listed Session carries its ID, its audience, where it came from (such as `slack` and
  `channel:C123`), its first request (up to 200 characters), and its last activity.
- `search_sessions` matches completed turns, newest first, and returns up to 240 characters around
  the first match in the request and the result.
- A work Session's own turns get only `read_session` and `read_turn`, for the work Session
  itself, so a continued work Session that starts without its native session can page back
  past its recap.
- `read_session` returns finished turns of the Tag, each with its request (up to 2,000 characters)
  and result (up to 4,000). Pass a page's `nextBefore` as `before` for the page before it.
- `read_turn` returns one finished turn's events, each with its sequence, its kind (`message`,
  `activity`, or `progress`), and its text (up to 4,000 characters). It reads turns of the same
  Sessions `read_session` does, the turn's own Session included. Pass a page's `nextAfter` as
  `after` for the next page. Take a `taskId` from `read_session`, `search_sessions`, or the
  Session's recap.
- `read_objective` without `objectiveId` reads the Objective this turn works for. An Objective's
  own turn reads only its own Objective; another turn reads an Objective the Tag owns whose
  Session it may see. It returns no turn prompts, results, or failure text.
- Each read looks past Sessions it may not see until it has a full page, so older visible
  Sessions and turns are never left out, and `list_objectives` counts every open Objective.

### Schedules

A **Schedule** wakes a Tag later in one Session: once, as a follow-up, or on a recurrence. When a
person says "check PR 412 again in two hours", the Tag calls `schedule` and replies with the time.
Two hours later the Tag gets a new turn with its note, and its reply appears in the same
conversation or thread as an ordinary message.

```text
schedule(note: "Check PR 412: CI status and new review comments", at: "2h")
schedule(note: "Summarize open work", every: "0 9 * * MON", timeZone: "Europe/Berlin")
```

- `at` is a duration ahead, such as `90m`, `2h`, or `3d`, or a time such as `2026-11-17T09:00`.
  It is from 1 minute to 366 days ahead. Words such as "next Tuesday" are refused.
- `every` is a five-field cron expression, or `@hourly`, `@daily`, or `@weekly`. Its occurrences
  are at least an hour apart. It is read in its time zone, across daylight saving changes.
- A time without an offset, and every recurrence, is read in `timeZone`, an IANA name. Without it,
  SuperTag uses the Control Plane's time zone: the `time-zone` in `supertag.yaml` or
  `SUPERTAG_TIME_ZONE`, else the machine's, else UTC.
  The tool's description names it and the time the turn started.
- A Schedule the tool creates takes effect when its turn succeeds. A turn that fails, is cancelled,
  or loses its lease creates none, so a retried turn never schedules twice.
- The tool's result names the Schedule and lists the Tag's other Schedules in the Session, and the
  turn's portfolio lists them too. Call `cancel_schedule` to drop a duplicate.
- A Schedule in a conversation fires in the conversation's latest Session, where the next message
  would go. That Session may lack the earlier context, so the note should say what to do and why.
- A Schedule in a surface thread replies in that thread.

When a Schedule is due, the Control Plane queues an ordinary Task for the Tag. It never starts a
run itself: the Session runs one turn at a time, in order, and the Tag's current Permission Sets
apply. The turn's prompt says why the Tag was woken; the conversation shows only the Tag's reply,
with a "Scheduled" caption, and nothing while the turn runs: no message, no typing indicator, and
no work in the conversation list. A message you send while it runs joins it, so from then on it
answers you and shows as it works. When the check finds nothing that needs attention, the Tag calls
`stay_quiet` and nothing is posted; see [Quiet results](#quiet-results). The prompt also says how
the Schedule's last ten fires landed, such as "Of this Schedule's last 4 fires: 2 posted (2 read,
1 answered); 2 stayed quiet.", so the Tag can calibrate when to speak.

| Situation | What happens |
| --- | --- |
| The Control Plane was down past a one-off | It fires once, late, and says when it was due |
| A recurrence missed several occurrences | It fires once, counts the rest as missed, and continues at the next future occurrence |
| The previous wake-up is still queued | The occurrence counts as missed; no second turn queues |
| The Schedule is in an Objective's Session | Its turns count against the Objective's budget. A paused or limited Objective keeps them queued |
| The Objective closes, or the Tag is retired | Its Schedules are cancelled |

An active Schedule is a wait: an Objective whose owner scheduled a check is not idle. A woken turn
resets the [idle rule](#the-idle-rule), as a person's message does.

Limits: a Tag holds at most 25 Schedules that have not finished, and one turn creates at most 3.
A turn gets the tools only when its Tag holds the `schedule:create` runtime action; see
[the IAM reference](iam.md#current-action-vocabulary).

Operators manage Schedules with `supertag schedule create`, `pause`, `resume`, and `backfill`,
and `get`, `describe`, and `delete schedule`, or declare recurring ones in
[manifests](resource-model.md#declared-schedules); see
[Ask a Tag to follow up](../guides/talk-to-a-tag.md#ask-a-tag-to-follow-up). A client sees and
changes the Schedules of its own conversations. `backfill ID --from TIME` queues one turn for
each occurrence since `TIME` that queued none, at most 24; a replayed occurrence is never
replayed again. The Watch reports each Schedule change as `WATCH_KIND_SCHEDULE`.

### Memory

A Tag keeps a short notebook of what it cannot look up again: a person's preferences,
corrections, decisions and their reasons, and pointers to where things live. Notes are pointers,
not copies; the Tag's Sessions stay the record. Each root turn's portfolio lists the notes it may
see, newest first, as state rather than instructions. The Tag's own instructions still rule.

```text
remember(text: "Atem prefers squash merges and small PRs.")
remember(text: "Release checklist: docs/operations/release.md", replaces: "mem_4f1c…")
forget(memoryId: "mem_9a2b…")
```

- **Who sees a note.** A note takes the turn's audience. One written in a person's conversation is
  private to that person; one written in a surface thread, an operator's Objective, the inbox, or
  a review is shared. A turn sees the shared notes and its own person's, never another person's.
  This is the rule that decides which [Sessions a turn sees](#recalling-other-sessions).
- **When it applies.** A call takes effect when its turn succeeds. A turn that fails, is
  cancelled, or loses its lease changes nothing, so a retried turn never writes twice. The tool's
  result lists the notes the turn now sees.
- **Limits.** A note is at most 500 characters. A turn sees at most 40 notes and 6,000 characters
  of them. At the limit, `remember` is refused with the oldest notes named, so the Tag can forget
  or merge them (`remember` with `replaces`). One turn writes or forgets at most 10 notes.
- **Who may write.** Root turns of a Tag that keeps memory. A Work Session's own turn, and a turn
  a GitHub or Linear event started, get no `remember` or `forget`: an issue or pull request may
  hold text someone outside wrote. Otherwise, asking the Tag for work and teaching it are the
  same trust. Anyone on a surface location's `allowed-users` may do both; the Gateway drops
  everyone else's messages before the Control Plane sees them.

**The daily review.** Once a day, after at least ten finished turns since the last one, the Tag
gets a review turn in its reserved Session `memory:TAG`. The turn lists the shared Sessions with
work since the last review. The Tag rereads them with `read_session` and `read_turn`, then
merges, replaces, adds, and forgets notes. The review has only the Session reads, the memory
tools, and `stay_quiet`: it cannot message anyone, start work, or schedule. It runs read-only in
the Tag's Workspace: of the Tag's actions it keeps only `files:read`, so it cannot change files or
run commands, whatever the Tag may do in other turns. It ends with
`stay_quiet`, so it posts nothing and raises nothing unread. A review is never queued while another
is still queued or running. `supertag describe tag` shows when the Tag last reviewed.

A Tag with `memory: false` (`supertag tag put TAG --memory false`, or `spec.memory` in a Tag
manifest) keeps no notes, has neither tool, and never reviews. Retiring a Tag deletes its notes.

People read notes with `supertag get memories [--tag TAG]` and `supertag describe memory ID`, and
delete one with `supertag delete memory ID`. The desktop app shows a Tag's notes in its details
panel, opened from the Tag's name above the conversation, and the terminal UI under **Notes** in
the command palette; both delete a note too. They never write a note: they tell the Tag
("remember that I prefer squash merges", "forget that"). An operator sees shared notes and those
of clients' conversations; a client sees shared notes and its own. Each note records when a turn
last had it in its context (`last_seen_at` in `describe memory`), so a note no turn has used for
a long time is easy to spot. `supertag watch memory` follows notes as they are kept, rewritten,
and deleted.

### Harness memory

Some harnesses keep a memory of their own. Claude Code's auto-memory, for
example, is a folder of Markdown files with a `MEMORY.md` index, which Claude Code reads at the
start of each turn and updates with its file tools. A Tag that keeps memory keeps its harness's
memory too, beside its [notes](#memory), across Tasks:

- **Where it lives.** On the Worker Host that ran the turn, in its artifact storage
  (`--artifact-directory`, by default `artifacts` in its state directory), which every [Worker](glossary.md#worker) of the
  host shares, at `tags/<SHA-256 of TAG>/native-memory/HARNESS/SCOPE/current`, beside
  the Tag's Session checkpoints. The Control Plane never holds the files, only a record of what
  each host holds: the revision, file count, size, and a digest.
- **Who shares it.** It follows the audience rule for notes: one store for the Tag's shared turns
  and one for each person's conversations, so one person's conversation never feeds another's.
  A turn a GitHub or Linear event started gets none.
- **Parallel turns.** Each turn works on its own copy. When the harness stops, the host merges the
  copy back file by file: a file only one turn changed takes that change; a file two turns changed
  keeps the later one and saves the earlier as `NAME.conflict-ATTEMPT.md` beside it; the
  `MEMORY.md` index keeps both turns' lines.
- **Limits.** A store holds at most 1,000 files and 4 MiB, and a file at most 256 KiB. A turn's
  changes that would pass a limit, or that add a link or special file, are not kept.
- **Another host.** Each Worker Host's Worklet keeps its own copy. A Tag whose next turn runs on another
  host starts from that host's copy, or from none, and a host that is removed takes its copy with
  it. The Tag's notes and Sessions stay; harness memory is a convenience on top of them.
- **On a Volume.** A Tag that names a Volume (`supertag tag put TAG --volume NAME`) keeps its
  harness memory there instead, so every Worker Host that maps the Volume uses the same memory.
  The Volume holds the files and a manifest of them as objects that never change, at
  `tags/<SHA-256 of TAG>/native-memory/HARNESS/SCOPE/objects/`; the Control Plane keeps only which
  manifest is current. When two turns end at once, the second merges onto what the first kept, as
  on one host. Objects the store no longer names, and all of them after
  `supertag delete memory --native`, are deleted from the Volume like other Volume garbage; so are
  objects a turn wrote but never kept, once that turn has ended and an hour has passed since it
  wrote them.

Claude Code and Codex keep harness memory this way:

- **Claude Code** keeps its auto-memory folder. A read-only turn may still write to its memory
  folder, and nowhere else. The folder belongs to the store, not to the checkout, so a turn in
  another checkout path, or on another host, finds the same memory. In a remote Workspace (E2B,
  Modal, or a local-vm container) the folder stays on the Worker Host, where Claude Code runs:
  Claude Code keeps its memories there with its own file tools, confined to the folder, while
  every tool that touches the Workspace runs in the sandbox, which never reaches the folder.
- **Codex** keeps its memory folder: notes it saves with its memory tools, and the summary it
  reads at the start of each turn. Each turn is told to search its notes before answering
  anything that may depend on earlier work. Codex's own consolidation, which folds the notes into
  that summary with extra model calls, runs only in the Tag's daily review turn: the turn waits up
  to 3 minutes after it finishes for Codex to complete it, so later turns read the notes in the
  summary without searching. Codex doesn't report the consolidation's tokens, so a Codex review
  turn is reported unpriced, with only its own tokens counted. Codex's git repository inside the
  folder is not kept.

OpenCode and Cursor keep no memory of their own on the Worker Host. Codex doesn't run in remote
Workspaces.

`supertag describe tag` lists the copies Worker Hosts hold (`native_memory`), and
`supertag delete memory --native TAG` drops all of them: each host deletes
its copies before it next runs one of the Tag's Tasks. A Tag with `memory: false` keeps no harness
memory either.

### Quiet results

A Tag speaks when it has something to say. A recurring check that finds nothing, such as "check
CI every morning" on a green morning, ends with `stay_quiet` instead of a reply:

```text
stay_quiet(note: "CI is green on main; nothing changed since yesterday.")
```

- **Who may.** Only a turn no person is waiting on: a Schedule's wake-up, an Objective's notice or
  idle wake, a memory review, or an inbox turn. A person's message is always answered: a turn a
  person's message started or joined, an approval's continuation, and a work Session's turns never
  get the tool, and the Control Plane ignores a quiet finish from them.
- **When.** Only when nothing changed since what the Tag last reported. A small change, or a
  problem it reported that is now resolved, is still reported; a problem the person already knows
  about and someone is handling, with nothing new, is not, and neither is movement within a stated
  normal range or a blip that recovered before the Tag reported it.
- **What it does.** The turn succeeds and nothing is posted to its thread or conversation. The
  conversation leaves it out, and it raises nothing unread. A reported Objective status or a wait
  for approvals still posts.
- **What stays.** The Task, its events, and its result, which is the note. `supertag describe task` shows `quiet: true`, and the Schedule still names it as its
  latest turn.

**How a Tag's messages land.** The Control Plane counts a Tag's unprompted turns that had someone
to reach, a Schedule's wake-up or an Objective's notice in a conversation or thread: each posted
reply, whether a person read it in their conversation or answered it in the same Session within a
day, and each check that stayed quiet. Collaboration surfaces have no read receipts, so there
only answers count.
`supertag describe tag` shows the last 30 days under `attention`:

```json
"attention": {"window_days": 30, "posted": 12, "read": 9, "answered": 4, "quiet": 20}
```

The desktop app shows the same counts under **Activity** in the Tag's details, and the terminal
UI under **Activity** in its command palette.

Nothing throttles a Tag on these numbers yet.

**Pacing.** At most one unprompted message reaches a person's conversation or a surface thread in
30 minutes. A later one is held: it posts nothing, stays out of the conversation, and counts as
nothing unread. When the 30 minutes end, the held messages go out together. In a conversation each
appears as the newest message. In a surface thread they post as one reply: the newest in full,
under a list of the earlier ones' first lines ("2 earlier updates from lead:"). A message from the
person releases them at once, before the Tag answers. In a conversation only a Schedule's turn is
held, since the desktop app and the terminal UI show any other unprompted turn while it runs. A
reported Objective status or a wait for approvals is never held.

### Identity and preconditions

- Coordination calls are authenticated by a credential scoped to the active Task Attempt. The
  Control Plane derives the acting Tag from that Task Attempt and never accepts a caller-supplied
  identity.
- A Task cannot use that credential after its lease ends. A **lease** is the Control Plane's
  time-limited claim that one Task Attempt is running.
- `to` on `send_message` and `post`, and `tag` on `start_session`, take a Tag's name or its ID. An
  active Tag's ID matches first; otherwise SuperTag uses the active Tag with that name. Active Tag
  names are unique.

## Mailbox

A Tag's Mailbox is its own inbox. Messages other Tags send it arrive there, and every message
waiting when a turn starts is handled together in that one turn.

- A message carries plain text, 1 to 8,000 characters. An optional `review` links a
  commit review request or verdict to an Objective.
- `send_message {to, text}` is allowed from a Tag's conversations, its Objectives' conversations
  and its own inbox turns. A work Session cannot send: its result reaches the Session that started
  it.
- A Tag may message another when they share a Team, or when the recipient accepts messages from
  it. A grant is exactly that: "this recipient accepts messages from this sender". Operators set
  one with `supertag mailbox-grant allow SENDER RECIPIENT` and remove it with
  `supertag mailbox-grant revoke SENDER RECIPIENT`; a Tag manifest's `acceptsMessagesFrom`
  declares the same thing. `supertag get mailbox-grant --tag TAG` lists them. Without either,
  the call returns 403 and names the reason.
- A message to a Tag that is retired, or to the sender itself, is refused.

### Delivery and batching

Sending stores the message, then delivers a turn of the recipient's inbox unless one is already
waiting to start, which takes this message too. The tool result reports `queued` or `batched`. The
turn takes every message bound to it when it starts: three messages that arrive together become
one turn, not three.

A message that arrives between the claim and the binding is not lost. It stays unbound, and the
Control Plane's sweep delivers a turn for it. An inbox turn that binds nothing settles completed
without dispatch.

An inbox turn runs in the Tag's own inbox Session under the Tag's own Roles. It carries no Objective and draws on no pool. SuperTag records
its final reply in the Session. Answering a sender takes another `send_message`.

### Limits

- At most **3** messages per Task. A fourth returns 429.
- A chain of messages may pass through at most **4** inbox turns. A message sent from an inbox turn
  carries one more hop than the messages that turn handled; above the limit the call returns 409
  and tells the Tag to answer in its reply instead.
- Posts addressed with `post {to}` deliver messages too, and those do not count against the
  per-Task send limit.

### Commit reviews

- An Objective's owner sends `send_message {to, text, review: {commit}}` from the Objective's
  conversation. The full Git hash must match a current delivery by one of its work Sessions.
- The requested reviewer sends `send_message {to, text, review: {requestId, verdict}}` from a
  root Session. `to` is the requester. The request fixes the Objective and commit, and
  `verdict` is `approved` or `changes_requested`. The Control Plane records one verdict per
  request and accepts a repeat of the same verdict and text. The tool returns `recorded`.
- `read_review_patch` reads the patch on the reviewer's Worker Host, never through the Control
  Plane. The host reads it from its own storage when it holds the delivery. Otherwise it fetches
  the delivery's Session branch from a remote Workspace's git remote with a read-only credential
  for that one operation, rebuilds the patch, and checks its length and SHA-256 against the
  delivery. A local Workspace's patch is readable only on the Worker Host that holds it, and a
  Session branch that hasn't been pushed yet fails `Unavailable`.
- The Objective overview lists requests and verdicts, and a working Objective receives the
  verdict as a conversation turn. The verdict neither approves an Objective nor grants actions.

### Status and history

A message's status is the status of the Task that handled it: `pending` until a turn takes it,
then `handled` when that Task completed, or `failed` when it failed or was cancelled.

`supertag get message --mailbox TAG [--limit N]` lists the messages a Tag sent and received,
newest first, with a cursor for older pages. The Tag reads its own Mailbox with `read_mailbox`.

## Workstream

A Team's Workstream is its shared record of posts. Every member can read it, and every post stays.

- `post {text, to?}` adds one post. A post wakes nobody. Each Tag named in `to` must be a Team
  member and receives the post in its Mailbox.
- The Team is the Objective's Team for an Objective's turn, and otherwise the Tag's only Team. A
  Tag in several Teams gets 409 listing them; a Tag in none gets 409 saying so.
- A post body holds 1 to 16,384 characters, and `to` names at most 20 Tags.
- Posting the same text to the same Tags again in the same Task stores nothing new and returns the
  earlier post.
- Posts carry information only. A post cannot approve, assign, accept or close anything.
- `read_workstream` returns the newest posts, or the posts after `afterSequence`, oldest first.
  Each post has its sequence in the Team's Workstream, from 1.
- `supertag get workstream-post --team TEAM [--after-sequence N] [--limit N]` reads the same
  record as an operator.

## Teams

A Team is a flat list of member Tags with an optional concurrency limit. It stands alone: any
number of Objectives may name one Team.

- `supertag team create NAME --member TAG [--member TAG ...] [--max-concurrency N]` creates one.
  An Objective manifest's `team:` declares either an existing Team's name or the Objective's own
  Team as `{name?, members, maxConcurrency?}`; see
  [Declared Objectives](resource-model.md#declared-objectives).
- Every member must be an active Tag, the name must be unused, and a Team holds at most 100
  members.
- `supertag team update NAME [--member TAG ...] [--max-concurrency N | --clear-concurrency] [--name TEXT] [--expected-revision N]`
  replaces the fields it names; see [Statuses](#statuses) for the revision check. `supertag get team` and
  `supertag get team NAME` read them.
- `supertag delete team NAME` deletes the Team and its Workstream posts. It is refused with 409
  while an Objective that is not completed or cancelled names the Team.
  A Team created again with a deleted Team's ID continues after the deleted Team's last
  revision, so a revision read before the deletion cannot update the new Team.
- Membership does two things: members may message one another without a grant, and an Objective
  may start work Sessions of its Team's members.
- `--max-concurrency N` limits how many turns run at once across the Sessions of every open
  Objective naming the Team. Later turns stay pending and consume no Task Attempt. Without it,
  Worker Host capacity is the only limit.
- No coordination tool creates or changes a Team. Teams are operator configuration.

## Approval requests

An approval request records one ask for a person or a named approver. SuperTag creates one when
a Task is about to perform an action whose permission has `approvalRequired: true`: an MCP tool
call that the Worker's policy proxy forwards, a Mailbox message, or a Workstream post.

Each request stores the Objective, Task, Task Attempt, Session, requesting Tag, the action and
resource, the canonical tool arguments and their `sha256` digest, a short summary, and who may
decide it.
Its status is `pending`, `approved`, `denied` or `expired`. A pending request expires when its
Task finishes, unless the Task ended waiting on it. When the Objective is completed or cancelled,
every pending request expires.

### Matching a call to a decision

For each gated call, the Control Plane checks in order:

1. An approved `objective`-scope request in the same Objective covers the same Tag, action and
   resource, and has not passed `validUntil`. The call runs.
2. An approved `once`-scope request for the same Task, action and arguments digest has not been
   used. The Control Plane marks it consumed, and the call runs. A request from any Task of the
   same Session matches.
3. The latest identical request was denied. The call returns the denial reason, and a denial in
   one Task of a Session holds for its later Tasks too. Work the person later allows takes a new
   Session.
4. Otherwise the Control Plane reuses an identical pending request, from the same Task or any Task
   of the same Session, or creates one. The call returns "approval pending" with the request ID.

A pending call does not run and holds no execution capacity.

### A turn waiting on approval

When a gated call is pending, the call is not made, and its tool result names the request and tells
the turn to end with a brief final reply. Then:

1. The Task completes, and its outcome records `approvals`: the IDs of the requests it was told to
   end on, oldest first. That includes a request decided while the Task still ran, as long as no
   call used the decision. A Task with a question or approvals ends waiting.
2. SuperTag posts a notice once per permission, in its own words. An Objective's turn posts it to
   the home thread, a work Session's to the Session that started it, and an inbox turn's to the
   operator inbox only.
3. The request stays pending while that Task is completed, lists the request in `approvals` and is
   still its Session's latest Task. Otherwise it expires like any other request.
4. Approving or denying admits the Session's next Task. A decision made while the Task still ran
   does this when the Task completes. The Task's message lists each request's ID and decision,
   with any denial reason, and asks the Tag to retry an approved action with its exact arguments
   or choose another approach for a denied or expired one. It runs under the waiting Task's own authorization and context, with no
   new grants. The approval records it as `continuation_task_id`.
5. The retried call matches the approval, because a `once` approval covers the same action and
   arguments in any Task of that Session. The Control Plane records `consumed_at_ms` on the
   approval.

The Control Plane continues a waiting Session after each decision, and also retries every few
seconds and on start, so a restart does not leave it waiting. It continues each waiting Task once;
a second decision for the same Task admits nothing, because that Task is no longer its Session's
latest.

A work Session does not continue when the Tag's permissions changed while it waited, or when too
little of its budget is left. The conversation then gets a notice in SuperTag's words, and the
Session waits on nothing. After a permission change, start a new work Session.

### Deciding

| Decider | Interface |
| --- | --- |
| Operator | `supertag get inbox-item --kind approval` or `supertag get approval`, then `supertag approval approve ID` or `supertag approval deny ID --reason TEXT` |
| Named approver | A Permission Set's `approvers` names the operators or client devices that may decide; see [IAM approval](iam.md#approval). Tags never decide approval requests |

- An approval chooses `once` (the default) or `objective` scope, optionally until `validUntil`.
  An `objective` approval covers every matching call in that Objective until `validUntil`.
- A denial requires a reason.
- Pending requests are batched into one notice per Objective to its notification destination,
  when one is configured. The [operator channel](../operations/control-plane.md#operator-notifications), when
  configured, also receives requests that no Objective thread carries.

`supertag get approval ID` shows each step: `requested_at_ms`, the decider in `decided_by` with
`decided_at_ms` and any `reason`, `valid_until_ms`, and `consumed_at_ms`. The operator API mirrors
the CLI with the `Inbox` service's `ListApprovals`, `GetApproval`, and `DecideApproval`; see
[Control Plane API](control-plane-api.md).

## Overlap warnings

Two work Sessions of one Objective can edit the same file in separate worktrees. A local Worker
Host compares each running Task Attempt's worktree with its base on every heartbeat, about every
30 seconds, using git diff and status, including untracked files. Renames count as both paths, and
`.git/` is ignored. It reports at most 500 changed paths per Task Attempt; more are marked
truncated and are not compared.

When two running Task Attempts of the same Objective change the same path in the same repository,
SuperTag delivers one notice to the Objective's conversation naming both Tasks, up to 20 shared
paths and the repository, and asks the owner to coordinate them. Each pair of Task Attempts and
batch of paths is reported once. A remote environment without a readable local worktree is
skipped.

## Overview fields

`supertag describe objective ID` presents one view of an Objective; see
[Check an Objective's progress](../guides/objective-overview.md).
`supertag describe objective ID --output json` prints the same view as JSON:

| Field | Holds |
| --- | --- |
| `objective` | The Objective record, including status, revision, budget and deadline |
| `as_of_ms` | When the Control Plane read the view |
| `team` | The Objective's Team with its ID, name, members, `max_concurrency` and running turns; null when the owner works alone |
| `pool` | The budget pool: its measure, currency, limit, spend, what is left, any overrun, and the Task Attempts with unknown or estimated cost |
| `deadline` | The deadline, the time left or since it passed, and the end of its grace period |
| `attention` | Approval, question, review, pause, budget and deadline items needing a person, each with its next commands |
| `sessions` | Each of the Objective's Sessions with the Tag running it, its status, its latest Task's delivery, and the failure of a failed latest turn |
| `total_sessions` | The number of Sessions, including any the view leaves out |
| `conversation` | The newest turns of the Objective's conversation |
| `posts` | The newest Workstream posts of the Objective's Team |
| `tasks`, `total_tasks`, `next_offset` | One page of Tasks, the number on all pages, and the offset of the next page |
| `notices` | Limit and coordination notices raised for the Objective |
| `pending_approvals` | The number of the Objective's approval requests waiting for a decision |

`supertag watch objective ID` prints the Objective's progress as a timeline until it closes.

### Allocation and usage

- `pool` always describes the whole Objective, even on a later Task page.
- It sums each Task Attempt's latest cumulative report exactly once and counts the Task Attempts
  that reported no cost or no tokens. Missing reports stay unknown, never zero.
- Amounts in different currencies stay separate and are never converted.

### Queue time

Queue age alone does not establish a capacity shortage: Team concurrency, the Tag's other running
work and Worker Host availability all delay a claim.

### Waiting turns

A turn queued with nothing running it says why through
`supertag placement explain TASK_ID`: it names each bound Worker Host and why it cannot take the
Task, such as a disconnected host, a missing harness or Workspace, or labels that do not match.

### Access

The overview requires an operator credential. See the [Control Plane API](control-plane-api.md).

## Operator inbox

`supertag get inbox-items` lists the questions and work waiting for an operator, computed from
pending state when you ask. It creates no resource and grants no authority: the operator acts
through the same commands as always. Filter it with `--objective ID` or `--kind KIND`, and page
with `--limit` and `--cursor`. It prints JSON with `items`, `next_cursor`, and `truncated_kinds`,
the kinds with more pending items than the page holds. `supertag watch inbox-item` takes the same
`--objective` and `--kind` filters and prints each item once as it appears: every item already
waiting first, then new ones. It rereads the inbox every two seconds, and an item that leaves the
inbox and returns prints again.

| Kind | Appears when |
| --- | --- |
| `approval` | An approval request waits for a decision |
| `question` | An Objective's latest turn called `ask` and waits on the answer |
| `budget` | The Objective's budget pool is used up |
| `limit` | A budget warning, budget exhaustion, deadline warning or deadline passage |
| `task-attention` | A Task needs an operator, such as an uncertain Task Attempt |
| `mcp-login` | A queued Task needs an MCP server whose login lapsed on every Worker Host serving it |

- Each item carries `key`, `occurrence`, `kind`, `objective_id`, `task_id`, `reason`, and
  `operator_eligible`, which is false for an item only a Tag can act on. A `question` item
  carries the question, an `approval` item the approval's ID, requesting Tag, action, resource
  and summary.
- To answer a `question` item, use **Waiting on you** in the terminal UI or
  `supertag question answer TASK_ID TEXT`; pass `-` as the text to read the answer from standard
  input, which keeps it out of the process list. Decide an approval with
  `supertag approval approve APPROVAL_ID` or `supertag approval deny APPROVAL_ID --reason TEXT`.
- Item identity for notification is the item's `occurrence`: its `key`, plus the Task Attempt
  when the item cites a Task. The same decision after another Task Attempt is a new occurrence.
- `notification.status` says whether the operator heard about the item: `not configured`,
  `pending`, `delivered`, `failed` or `unavailable`.
- A `limit` item appears once per warning or passage and disappears when the operator raises the
  budget or moves the deadline, or when the Objective finishes.
- An `mcp-login` item names the server; log the Worker Host in with `supertag mcp login SERVER`.
  See [MCP OAuth login](../surfaces/worker-tools.md#write-the-hosts-catalog).

The inbox remains the stored route in a headless deployment; external delivery is optional. A
missing or unusable destination never removes an item. `supertag test notification [--objective
ID]` sends one sample through every destination the Gateway notifies and reports the result for
each. It creates no item. Destination order is
in [Operator notifications](../operations/control-plane.md#operator-notifications).

## After a Control Plane restart

- Restarting the Control Plane preserves admitted work. Acceptance is recorded before
  acknowledgement, and disconnecting an event observer does not cancel execution.
- A Worklet keeps running its Task Attempts while it reconnects, and it records their events,
  results and deliveries only while it still holds their leases. A Task Attempt whose host lost
  its lease is never run again on its own: it becomes uncertain and needs an operator decision.
  See [Leases and unknown outcomes](scheduling-and-recovery.md#leases-and-unknown-outcomes).
- Inspect results and any external effects before starting the work again. Successful recovery is
  not proof that an external action did not happen.
- Coordination credentials are bound to one Task Attempt and its lease. They do not broaden the
  Tag, Objective, Task or tool authority captured at admission, and they stop working when the
  lease ends.

`supertag describe task TASK_ID` shows the Task's state and its Task Attempts.
