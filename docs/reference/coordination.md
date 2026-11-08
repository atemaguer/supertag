# Objective coordination reference

This page is the exact contract behind SuperTag's [Objective](glossary.md#objective),
[Team](glossary.md#team), [Mailbox](glossary.md#mailbox) and
[Workstream](glossary.md#workstream) guides.

An **Objective** is an outcome a [Tag](glossary.md#tag) owns, with a budget, a deadline and a
status. A **Tag** is a persistent AI identity with its own responsibilities and permissions. A
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
[Worklet](glossary.md#worklet), [Worker Profile](glossary.md#worker-profile),
[Worker](glossary.md#worker), and [Workspace](glossary.md#workspace).

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

An Objective is a conversation with a goal. It talks in the thread it was created in: its owner
Tag replies there, a person replies in that thread or with `supertag message objective`, and the
Objective asks the person when it needs a decision. The work happens in Sessions started
beneath it, including Sessions of other Tags in its Team.

### A worked example

Maya runs `@SuperTag objective Ship SSO for the admin app` in a Slack channel where the Tag
`planner` listens. SuperTag creates the Objective `ship-sso-for-7f3k` and starts its conversation
in that thread.

```text
#admin-app thread
  Maya      @SuperTag objective Ship SSO for the admin app
  planner   Starting. I'll have builder do the provider work and reviewer check it.
            ├─ work Session of builder   "SAML provider"      → reports back
            └─ work Session of reviewer  "Security review"    → reports back
  planner   Do we need SCIM provisioning in this release?        (ask)
  Maya      No, next quarter.
  planner   Done. SSO ships behind the sso flag; review found no high findings.
```

`planner` owns the Objective, and `builder` and `reviewer` are the other members of its Team. Each
work Session's result returns to the Objective's conversation as a turn. `planner`'s `ask` reaches
Maya in the thread and in `supertag list inbox`; her reply is the conversation's next turn. Every
turn, in every Session, draws on the Objective's one budget pool.

## Objectives

### Creating an Objective

- Creation requires an outcome statement: the result, how success is verified, what must not
  change, and when to ask a person. The outcome may be up to 8,000 characters, and is fixed
  afterwards. Changing it takes a new Objective.
- The ID is caller-chosen. Through the administrative API and the CLI it is optional: without
  one, the Control Plane generates it from the first three words of the outcome plus four random
  letters or digits, such as `ship-sso-for-7f3k`.
- The owner Tag must be active and bound to a Worker Host.
- `--team TEAM` names the Team whose members the Objective may start work Sessions of. Without
  one, every work Session runs on the owner Tag.
- `--deadline` takes an ISO timestamp. See [Deadlines](#deadlines).
- `--budget-minor` and `--budget-currency` set the [budget pool](#the-budget-pool).
- `--runtime-action` narrows the Objective's [runtime actions](#objective-runtime-actions).
- `--workspace`, repeatable, names up to 16 existing Workspaces. Unknown names are rejected.
- `--ongoing` makes the Objective a continuing responsibility that only an operator ends.
- `--dry-run` validates exactly as creation does, returns the would-be Objective with its
  warnings and `dryRun: true`, and stores nothing.
- Creation returns `warnings`: sentences naming conditions that would hold the Objective's turns,
  each with its next step. They cover an owner with no bound Worker Host, no bound host connected,
  a named Workspace no bound host has checked out, a zero budget, a passed deadline, and runtime
  actions that were dropped. Warnings never stop creation; see [Runnable](#runnable).
- Creating an Objective starts it: the Control Plane admits the first turn of its conversation.
  Starting is idempotent, so a retried creation returns the same first Task. When the first turn
  cannot be admitted, the Objective is still created and `notStarted` gives the reason.
- Retrying the same definition returns the existing record with its current status. A different
  definition with the same ID returns 409.

A Tag creates an Objective from a thread with the `create_objective` tool, and only on an
authenticated human `@SuperTag objective <outcome>` command in the admitted request. That
Objective's home thread is the thread the command arrived in.

### Objectives from a location

An Objective created from a collaboration surface gets the Workspaces of the Tag location the
request arrived at; `create_objective` may pass `workspaces` to name a subset, and any other name
returns 400. The rules are in
[Objectives from a location](resource-model.md#objectives-from-a-location).

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
  Permission Sets, or the owner's, mark the action `approval: required`.
- Only operators change the list afterwards, with
  `supertag update objective ID --runtime-action ACTION ...`. The new list replaces the old one,
  stays within the owner's Permission Sets at that moment, and applies to turns admitted
  afterwards.

### The home thread

The Objective's **home thread** is where its conversation runs and replies. The Control Plane
picks it in this order:

1. the verified surface Task an operator set as the Objective's notification Task;
2. the surface Task that created the Objective;
3. the Control Plane's default operator notification Task.

Without any of these, the conversation runs in the owner Tag's CLI account, and
`supertag message objective` prints the reply.

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

`supertag message objective ID TEXT` (or `-` for standard input) delivers the next turn of the
conversation, attributed to the operator. In a Slack or Lark home thread a plain reply from a
person does the same, `@SuperTag approve` acts as `supertag approve objective`, and
`@SuperTag pause` and `@SuperTag resume` act as the pause and resume commands. The operator ID is
the provider and the user, such as `slack:U123`. Anyone who may create Objectives in that channel
may do this.

- A message never changes a budget, permissions or any other resource. Apply the resource change
  with its own command first; replying "approved" alone changes no allocation.
- A `blocked`, `limited` or `ready_for_review` Objective returns to `working` on a message. A
  `completed` or `cancelled` Objective takes no more messages and returns 409.
- The same `idempotencyKey` with the same text returns the original delivery; the CLI generates a
  new key for each command.
- The owner's answer to the message is its next reply in the home thread.

`supertag approve objective ID` completes a `ready_for_review` Objective. The owner's assessment,
recorded with `ready_for_review`, becomes the completion summary. Without one, the summary reads
`Approved by operator OPERATOR_ID. The owner recorded no assessment.`
`supertag complete objective ID --summary-file FILE` remains for scripts.

### Asking a person

An Objective's turn calls `ask {question}` with one concise question, then ends its turn. The
Task ends waiting. The question reaches the person in the home thread and as a `question` item in
`supertag list inbox`. The answer, through a thread reply or `supertag message objective`,
is the conversation's next turn. The same tool in a work Session asks the Session that started it.

### Work and delegation

An Objective's turn starts work with `start_session {title, instruction, tag?, workspace?}`:

- The instruction must be self-contained. A work Session sees only its own work, never the
  Objective's conversation or the Tag's other Sessions.
- Without `tag`, the work Session runs on the owner Tag. With `tag`, it runs on another Tag, whose
  parent Session is the Objective's conversation. The target must be active, bound to a Worker
  Host and a member of the Objective's Team; otherwise the call is refused and says why.
- A delegated Session runs with the target Tag's Roles, narrowed to the Objective's runtime
  actions and to the starting turn's authorization.
- Only an Objective's own turn may pass `tag`. A conversation's or an inbox turn's
  `start_session` runs on its own Tag.
- With one Workspace, the work Session uses it; with several, name one in `workspace`. Edits go
  to that Session's one branch, and each later Task of the Session commits on top of them.
- At most four work Sessions run at once per Session; later ones wait.

A work Session's result returns to the Objective's conversation as a turn. The owner reads it,
then either accepts it in its reply or sends fixes with `continue_session {sessionId, message}`.
`continue_session` across Tags is checked against a fresh authorization, not the authorization
captured when the Session started.

### The idle rule

An Objective's turn should end with work running, a question asked, or the Objective finished.
When a turn ends with none of those, and the Objective is still `working` and not paused:

1. The Control Plane wakes the conversation once, with "nothing is running; continue or finish".
2. When that woken turn also ends idle, the Objective becomes `blocked` and SuperTag posts a
   notice to the home thread naming the command that directs it.

An Objective is idle only when all of these hold: its latest conversation turn completed or
failed, it asked no question and waits on no approval, no turn is pending or running in any of its
Sessions, and no work Session result is unreported. Ongoing Objectives are exempt: they may rest
until their next message.

### Statuses

Statuses are `working`, `blocked`, `limited`, `ready_for_review`, `completed` and `cancelled`.

- The owner or an operator updates the status. A status update cannot set `cancelled`; see
  [Cancelling an Objective](#cancelling-an-objective).
- Each update requires the current revision and increments it. Conflicting writes return 409.
- The CLI commands `update objective`, `complete objective` and `update team` take `--revision`
  as optional. Without it the CLI reads the current revision, and after a 409
  caused by another writer it rereads and retries once, only when the other change left the
  fields it is changing untouched. With `--revision` it never retries. Coordination tools always
  send `expectedRevision`.
- `blocked` records that the Objective cannot go on without a person. It is not an execution
  pause.
- `limited` records a spent budget or a passed deadline. An update that sets it may carry a
  `completionSummary` of what was finished and what remains. Only an update that also raises the
  budget or moves the deadline leaves that status, and it returns the Objective to `working`.
- An explicit status update can reopen an Objective, which clears its completion summary.

### Completing an Objective

- The owner completes an Objective itself when its statement is satisfied, with
  `update_objective {status: "completed", expectedRevision, completionSummary}`. The summary is
  required, up to 4,000 characters, and must assess the outcome and cite its evidence. It is an
  explicit recorded decision, not automatic verification.
- The owner stops at `ready_for_review` instead only when the statement asks for a person's
  review. `completionSummary` is then its assessment, and an operator approves or sends changes.
- An Objective created with `--ongoing` is a continuing responsibility. Only an operator ends it.
- Completion closes the owner's coordination access at once and admits no new turns. The exact
  Task Attempt that completed the Objective may finish its reply and clean up.
- Pending approval requests of the Objective expire with the reason `Objective completed`.
- Queued and waiting Tasks in the Objective's Sessions are cancelled. Each cancellation records
  a reason, such as
  `Objective ship-sso-for-7f3k completed; this Task can no longer run.`
- The Objective's Team is not deleted. A Team outlives the Objectives that name it; see
  [Teams](#teams).

The Control Plane settles these leftovers right after completion or cancellation, and again on its
regular sweep.

### Pausing an Objective

- Only an operator pauses or resumes, with `supertag pause objective ID` and
  `supertag resume objective ID`, `POST /api/v1/objectives/{id}/pause` and
  `/resume`, or `@SuperTag pause` and `@SuperTag resume` in the home thread. No coordination tool
  pauses, so no Tag can.
- A pause records `pausedAt` and leaves `status` unchanged. While it is set, no turn of any of the
  Objective's Sessions starts: deliveries stay pending rather than failing. Running Task Attempts
  keep their authority and settle normally.
- Resuming clears `pausedAt` and delivers a turn summarizing what changed while the Objective was
  paused. Completed and cancelled Objectives cannot be paused. Both calls are idempotent and
  report `changed`.

### Cancelling an Objective

- Only an operator cancels, with `supertag cancel objective ID [--reason TEXT]` or
  `POST /api/v1/objectives/{id}/cancel`. `update_objective` refuses `cancelled` with 400.
- `cancelled` is terminal. Later status, deadline, budget and notification updates return 409, and
  no new turn, wake or limit warning follows.
- The Objective records `cancelledAt` and `cancellationReason`, up to 2,000 characters. The
  revision increments once and the change history records the operator.
- Every open Task in the Objective's Sessions is cancelled through the same path as
  `supertag cancel task`, pending deliveries fail, running Task Attempts stop, and Workspace pull
  requests close.
- Cancellation needs no revision. Cancelling a cancelled Objective returns success with
  `changed: false` and retries any Task still open. Cancelling a completed Objective returns 409.

## Budgets and allocation

### Units and currency

- `budgetLimitMinor` (CLI `--budget-minor`) is the Objective's limit in minor units chosen by the
  operator: `200000` is $2,000 in US cents.
- `budgetCurrency` (CLI `--budget-currency`) denominates those units. It must be an uppercase
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
  persisted usage evidence about every 10 seconds, so it survives restarts.
- Codex costs are estimates from token usage and model prices, so the total can differ from
  provider billing.

A conversation outside an Objective has a pool of the same shape for each turn: that turn's
reported token and cost limits, shared with the work Sessions it starts or continues. See
[how work Sessions share a budget](../concepts/tasks.md#how-work-sessions-share-a-budget).

### Monetary budgets

A budget with a currency caps provider-reported cost across the whole Objective.

| Reported spend | Effect |
| --- | --- |
| Reaches 80% of the limit | One `objective_budget_threshold` warning, delivered to the conversation and the operator inbox |
| Reaches the limit | New turns are refused; running Task Attempts finish, then the Objective becomes `limited` |

Running Task Attempts keep their authority when the pool runs out, and their eventual cost counts
toward reported spend even above the limit. `supertag describe objective ID` shows the overrun.
The Objective becomes `limited` once they have all settled, and only a raised budget or a moved
deadline leaves that status.

A Task Attempt that finished without reporting cost counts as unknown, not zero. The overview then
shows `budget_coverage_incomplete`: actual spend may be higher than the reported total.

For example, an Objective has `budgetLimitMinor` 300000 and `budgetCurrency` `USD`, a $3,000 cap.
At $2,400 reported the operator receives one warning. At $3,000 new turns stop while running Task
Attempts finish. If they finish at $3,080, the Objective shows an $80 overrun and status
`limited`. Raising the limit to 400000 returns it to `working`.

### Increasing the limit

- Only an operator raises a finite limit, with
  `supertag update objective ID --budget-minor N [--revision N]`, or `update_objective` with
  `budgetLimitMinor` and the current `expectedRevision`. Tags cannot.
- The new limit must exceed the old one and keep the currency. A stale revision is rejected;
  refresh the inbox before deciding.
- Admission resumes once the new limit exceeds reported spend, and warnings are raised again
  against it. The increase is audited in the Objective's change history.

The HTTP rules are in
[Objective allocation recovery](control-plane-api.md#objective-allocation-recovery). For the
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

Only an operator moves a deadline, with `supertag update objective ID --deadline ISO`. The new
deadline may replace one that passed; normal delivery resumes, the owner receives one notice with
the old and new deadline, and warnings are raised again against a window that starts at the move.

When the Control Plane ends a running Task Attempt's authority, the Task Attempt records that
cause as its failure, even when the harness reported its own error first. `supertag describe task`
then reads, for example, `Control Plane revoked Task Attempt authority: Objective deadline
passed`. The other causes are `Objective was cancelled`, `Objective was completed` and
`Objective budget exhausted`. A lost lease reads `Attempt authority expired` or
`Execution lease lost`.

## Coordination tools

### Who receives which tools

Only the root harness actor receives SuperTag coordination tools. Harness-native subagents are
local to one execution and are not Tags. Codex native subagents are disabled, because Codex cannot
yet give them a tool set distinct from the root actor's.

Which tools a Task gets depends on the kind of turn it is. SuperTag refuses a direct call to a
tool the turn does not get; it does not only leave it out of the list.

| Turn | Tools |
| --- | --- |
| An Objective's conversation | `start_session`, `continue_session`, `ask`, `send_message`, `post`, `read_workstream`, `update_objective`, `read_objective`, `list_sessions`, `search_sessions`, `read_session` |
| A Tag's inbox | `start_session`, `continue_session`, `send_message`, `post`, `read_workstream`, `read_objective`, `list_objectives`, `list_sessions`, `search_sessions`, `read_session` |
| A conversation with a person | The inbox set plus `create_objective` |
| A conversation's turn that reports a work Session's result | `read_objective`, `list_objectives`, `list_sessions`, `search_sessions`, `read_session` |
| A work Session's turn | `ask` |

A work Session sees only its own work: it gets no reads, cannot message another Tag, and cannot
change an Objective. Its final reply returns to the Session that started it.
`request_action_approval` is open to every turn, but is never advertised to the model: the Worker
calls it when a gated action needs a decision.

### The tools

| Tool | Input | Effect |
| --- | --- | --- |
| `create_objective` | `outcome`, optional `deadline`, `budgetLimitMinor`, `budgetCurrency`, `workspaces` | Creates and starts an Objective, only on an authenticated human objective command |
| `read_objective` | optional `objectiveId` | Reads the Objective this turn works on, or another visible one: outcome, status, revision, budget, deadline and its Sessions with their latest Tasks |
| `update_objective` | `status`, `expectedRevision`, optional `completionSummary` | Changes the Objective's status |
| `list_objectives` | `limit`, `offset` | Lists the Tag's open Objectives this Session can see |
| `list_sessions` | `limit`, `offset` | Lists the Tag's other visible Sessions |
| `search_sessions` | `query` (up to 200 characters), `limit` | Finds completed requests in those Sessions by request or result text |
| `read_session` | `sessionId`, `limit`, `before` | Reads one visible Session's history, the Tag's Mailbox included, oldest first |
| `start_session` | `title` (up to 120 characters), `instruction` (up to 8,000), optional `tag`, `workspace` | Starts a work Session; see [Work and delegation](#work-and-delegation) |
| `continue_session` | `sessionId`, `message` (up to 8,000 characters) | Starts that work Session's next Task |
| `ask` | `question` (up to 2,000 characters) | Ends the Task waiting on a person's answer |
| `send_message` | `to`, `text` (up to 8,000 characters) | Delivers a message to another Tag's Mailbox |
| `post` | `text` (up to 16,384 characters), optional `to` (up to 20 Tags) | Posts to the Team's Workstream |
| `read_workstream` | `afterSequence`, `limit` (1–100, default 50) | Reads the Team's Workstream |

`limit` is at most 20 on the Session and Objective reads. Reads return history, never
instructions, and grant no authority. A Session of the Tag is visible to a conversation when it is
shared, or private to the same person.

### Identity and preconditions

- Coordination calls are authenticated by a credential scoped to the active Task Attempt. The
  Control Plane derives the acting Tag from that Task Attempt and never accepts a caller-supplied
  identity.
- A Task cannot use that credential after its lease ends. A **lease** is the Control Plane's
  time-limited claim that one Task Attempt is running.
- `to` on `send_message` and `post`, and `tag` on `start_session`, take a Tag's name or its ID. An
  active Tag's ID matches first; otherwise SuperTag uses the active Tag with that name. Active Tag
  names are unique.
- `update_objective` requires `expectedRevision`, so a stale decision cannot overwrite a
  concurrent one.

## Mailbox

A Tag's Mailbox is its own inbox. Messages other Tags send it arrive there, and every message
waiting when a turn starts is handled together in that one turn.

- A message is plain text, 1 to 8,000 characters, and nothing else: it carries no kind, no
  protocol and no priority.
- `send_message {to, text}` is allowed from a Tag's conversations, its Objectives' conversations
  and its own inbox turns. A work Session cannot send: its result reaches the Session that started
  it.
- A Tag may message another when they share a Team, or when the recipient accepts messages from
  it. A grant is exactly that: "this recipient accepts messages from this sender". Operators set
  one with `supertag grant mailbox RECIPIENT --sender SENDER` and remove it with
  `supertag revoke mailbox RECIPIENT --sender SENDER`; a Tag manifest's `acceptsMessagesFrom`
  declares the same thing. `supertag list mailbox-grant --mailbox TAG` lists them. Without either,
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

An inbox turn runs in the Tag's CLI account under the Tag's own Roles, like
`supertag message tag`. It carries no Objective and draws on no pool. Its final reply is recorded
in the Session and sent nowhere; answering a sender takes another `send_message`.

### Limits

- At most **3** messages per Task. A fourth returns 429.
- A chain of messages may pass through at most **4** inbox turns. A message sent from an inbox turn
  carries one more hop than the messages that turn handled; above the limit the call returns 409
  and tells the Tag to answer in its reply instead.
- Posts addressed with `post {to}` deliver messages too, and those do not count against the
  per-Task send limit.

### Status and history

A message's status is the status of the Task that handled it: `pending` until a turn takes it,
then `handled` when that Task completed, or `failed` when it failed or was cancelled.

`supertag list message --mailbox TAG [--limit N]` lists the messages a Tag sent and received,
newest first, with a cursor for older pages. `read_session` on the Tag's inbox shows the same
history as turns.

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
- `supertag list workstream-post --team TEAM [--after-sequence N] [--limit N]` reads the same
  record as an operator.

## Teams

A Team is a flat list of member Tags with an optional concurrency limit. It stands alone: any
number of Objectives may name one Team.

- `supertag create team NAME --member TAG [--member TAG ...] [--max-concurrency N]` creates one.
  An Objective manifest's `team:` declares either an existing Team's name or the Objective's own
  Team as `{name?, members, maxConcurrency?}`; see
  [Declared Objectives](resource-model.md#declared-objectives).
- Every member must be an active Tag, the name must be unused, and a Team holds at most 100
  members.
- `supertag update team NAME [--member TAG ...] [--max-concurrency N] [--name TEXT] [--revision N]`
  replaces the fields it names and requires the current revision. `supertag list team` and
  `supertag get team NAME` read them.
- `supertag delete team NAME` deletes the Team and its Workstream posts. It is refused with 409
  while an Objective that is not completed or cancelled names the Team.
- Membership does two things: members may message one another without a grant, and an Objective
  may start work Sessions of its Team's members.
- `--max-concurrency N` limits how many turns run at once across the Sessions of every open
  Objective naming the Team. Later turns stay pending and consume no Task Attempt. Without it,
  Worker Host capacity is the only limit.
- No coordination tool creates or changes a Team. Teams are operator configuration.

## Approval requests

An approval request records one ask for a person or a named approver. SuperTag creates one, of
kind `surface-action`, when a Worker is about to forward a collaboration surface call whose
permission has `approval: required`.

Each request stores the Objective, Task, Task Attempt, requesting Tag, the actions, a `sha256`
digest of the tool arguments, a short sanitized summary, and the Permission Sets that required it.
Its status is `pending`, `approved`, `denied` or `expired`. A pending request expires when its
Task finishes, unless the Task ended waiting on it. When the Objective is completed or cancelled,
every pending request expires with the reason `Objective completed` or `Objective cancelled`.

### Matching a call to a decision

For each gated call, the Control Plane checks in order:

1. An approved `objective`-scope request in the same Objective covers the same Surface Account,
   scope and action, and has not passed `validUntil`. The call runs.
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

When a gated call is pending, the `request_action_approval` result tells the turn to end with a
brief final reply and no further tool call. Then:

1. The Task completes, and its outcome records `approvals`: the IDs of the requests it was told to
   end on, oldest first. That includes a request decided while the Task still ran, as long as no
   call used the decision. A Task with a question or approvals ends waiting.
2. SuperTag posts a notice once per permission, in its own words. An Objective's turn posts it to
   the home thread, a work Session's to the Session that started it, and an inbox turn's to the
   operator inbox only. It ends with "The work Session continues on its own once you decide."
3. The request stays pending while that Task is completed, lists the request in `approvals` and is
   still its Session's latest Task. Otherwise it expires like any other request.
4. Approving or denying admits the Session's next Task. A decision made while the Task still ran
   does this when the Task completes. The Task's message is the decision:
   "Approval request ID was approved (scope: once). Retry the same call to continue.", or the
   denial with its reason. It runs under the waiting Task's own authorization and context, with no
   new grants. Its `task.admitted` event carries `continued: true` and `approvalRequestId`.
5. The retried call matches the approval, because a `once` approval covers the same action and
   arguments in any Task of that Session. The Control Plane records `approval.consumed` on the
   retrying Task.

The Control Plane continues a waiting Session after each decision, and also retries every few
seconds and on start, so a restart does not leave it waiting. It continues each waiting Task once;
a second decision for the same Task admits nothing, because that Task is no longer its Session's
latest.

A work Session does not continue when the Tag's permissions changed while it waited, or when too
little of its budget is left. The conversation then gets a notice in SuperTag's words, the waiting
Task records a `session.not-continued` event with the `reason` (`permissions` or `budget`), and
the Session waits on nothing. After a permission change, start a new work Session.

### Deciding

| Decider | Interface |
| --- | --- |
| Operator | `supertag list inbox --kind approval` or `supertag list approval`, then `supertag approve request ID` or `supertag deny request ID --reason TEXT` |
| Named Tag approver | A Permission Set names it in `approvers`; see [IAM approval](iam.md#approval) |

- An approval chooses `once` (the default) or `objective` scope, optionally until `validUntil`.
  An `objective` approval covers every matching call in that Objective until `validUntil`.
- A denial requires a reason.
- A Tag cannot decide a request its own Task made.
- Pending requests are batched into one notice per Objective to its notification destination,
  when one is configured. The [operator channel](../operations/control-plane.md#operator-channel), when
  configured, also receives requests that no Objective thread carries.

Task events record each step with the Permission Sets and the decider: `approval.requested`,
`approval.granted-by-scope`, `approval.approved`, `approval.denied` and `approval.consumed`.

The operator API mirrors the CLI:

| Request | Operation |
| --- | --- |
| `GET /api/v1/coordination/approvals?objectiveId=ID&status=pending` | List requests; `status` also accepts `approved`, `denied`, `expired` or `all` |
| `POST /api/v1/coordination/approvals/ID/approve` | Optional body fields `scope` (`once` or `objective`) and `validUntil` |
| `POST /api/v1/coordination/approvals/ID/deny` | Body `{"reason":"TEXT"}` |

Scoped operator credentials need the `list_approvals` and `decide_approval` actions.

## Review findings

A Task's result can carry findings: problems the Task reported about its own work, each with a
severity and an optional location. A finding is part of a result, not a separate resource.

- A result carries at most 50 findings. Each has `severity` (`high`, `medium` or `low`), a
  one-sentence `summary` of at most 500 characters, and an optional `location` such as
  `src/session.ts:42`.
- The Control Plane assigns the identifiers `F1`, `F2`, … in result order, whatever the Worker
  supplied, and refuses any other field. A finding therefore cannot name another Task.
- `supertag describe objective ID` and the Objective overview list the high findings in the
  latest result of each of the Objective's Sessions, so the owner and the operator see what is
  still open.

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

`supertag describe objective ID` and
`GET /api/v1/coordination/objectives/{id}/overview` present one view of an Objective; see
[Check an Objective's progress](../guides/objective-overview.md).

| Field | Holds |
| --- | --- |
| `objective` | The Objective record, including status, revision, budget and deadline |
| `conditions` | One `Runnable` condition; see [Runnable](#runnable) |
| `attention` | Budget, deadline and approval items needing a person |
| `approvals` | The Objective's pending approval requests, when the caller may list them |
| `team` | The Objective's Team with its `id`, `name`, `memberTagIds` and `maxConcurrency`; null when the owner works alone |
| `limits` | The deadline, the time left, the grace period and the notices already raised |
| `pool` | `currency`, `limitMinor`, `spentMinor` and `availableMinor` |
| `conversation` | The newest 25 turns of the Objective's conversation, each `operator`, `supertag` or `owner` |
| `sessions` | Each of the Objective's Sessions with its latest turn, its status, its question and the approvals it waits on |
| `highFindings` | High findings in the latest result of each Session |
| `posts` | Recent Workstream posts of the Objective's Team |
| `tasks`, `pageUsage` | The Task page and its provider usage |
| `total`, `offset`, `nextOffset` | The Task page's position; `nextOffset` is null on the last page |
| `writes` | Bytes each Volume received from these Tasks |
| `tagNames` | Each Tag ID the view mentions, by name |

`supertag watch objective ID` prints the same records as they change.

### Allocation and usage

- Pool totals always describe the whole Objective, even on a later Task page.
- Provider usage totals describe only the displayed Task page. Follow pagination before comparing
  a whole organization's consumption.
- The JSON names those Task IDs, reports missing usage and cost observations, and sums each Task
  Attempt's latest cumulative report exactly once. Missing reports stay unknown, never zero.
- Amounts in different currencies stay separate and are never converted.

### Timing

- `completedExecutionMs` sums the durations of Task Attempts with recorded end times, including
  failed and cancelled ones. It measures a Task Attempt's lifetime, including tool and runtime
  waits.
- Additional Task Attempts include continuations after an approval, so they are not all failures
  or retries.
- Queue age alone does not establish a capacity shortage: Team concurrency, the Tag's other
  running work and Worker Host availability all delay a claim.

### Runnable

`conditions` holds one `Runnable` condition with `status` true or false and a list of `reasons`.
The CLI prints it as `Runnable: yes` or `Runnable: no.` followed by the reasons, and omits it for
a completed or cancelled Objective. It is false when:

- the Objective is completed, past its deadline, or out of budget, or its budget is 0;
- the owner Tag has no bound Worker Host;
- no bound Worker Host is connected, counting an embedded Worklet's host as connected;
- no bound Worker Host declares a checkout of a named Workspace.

Creation reports the same reasons as `warnings`. `true` means none of these holds the Objective's
turns; it does not check Worker capacity, profile compatibility or approvals.

### Access

The overview uses the authenticated administrative API and requires the `read_objective` action
plus access to the requested Objective. See the
[API reference](control-plane-api.md#coordination-operations-experimental) for the HTTP endpoint.

## Operator inbox

`supertag list inbox` is a redacted projection over pending stored state. It creates no resource
and grants no authority: the operator acts through the same commands as always. Filter it by
Objective, kind or status. `supertag watch inbox` polls it once a second and prints each new item
occurrence once.

| Kind | Appears when |
| --- | --- |
| `approval` | An approval request waits for a decision |
| `question` | An Objective's latest turn called `ask` and waits on the answer |
| `objective-budget` | The Objective's budget pool is used up |
| `objective-limit` | A budget warning, budget exhaustion, deadline warning or deadline passage |
| `task-attention` | A Task needs an operator, such as an uncertain Task Attempt |
| `mcp-login` | A Task is held until its Worker Host logs in to an MCP server |

The CLI spells a kind with hyphens and the HTTP API with underscores.

- `supertag list inbox` shows the decisions an operator can make. `--all` adds items only a Tag
  can act on. Text output names both decision makers.
- Every item carries `commands`: the `supertag` commands that act on it, most direct first. A
  `question` item's first command is `supertag message objective ID TEXT`.
- Item identity for watching and notification is the item `key`, plus the Task's attempt count
  when the item cites a Task. The same decision after another Task Attempt is a new occurrence.
- A `question` item carries the question text for an operator who may read the whole Objective.
  Others receive metadata only.
- An `approval` item's `approval` field holds `requestId`, `requestKind`, `summary`,
  `requestingTagId`, `requestingTagName`, `taskId` and `blocking`. `blocking` is true when a
  running or waiting Task Attempt made the request. Approval data appears only for principals with
  the `list_approvals` action; others receive 403 for `kind=approval`. An approval
  requested by an inbox turn has no Objective, so its `objectiveId` is null.
- An `objective-limit` item appears once per warning or passage and disappears when the operator
  raises the budget or moves the deadline, or when the Objective finishes.
- An `mcp-login` item's key is `mcp_login:TASK_ID:SERVER`, and its commands are
  `supertag mcp login SERVER`, then `supertag describe objective ID`. See
  [MCP OAuth login](supertag-yaml.md#mcp-oauth-login).

The inbox remains the stored route in a headless deployment; external delivery is optional. A
missing or unusable destination never removes an item. `supertag test notification [--objective
ID]` sends one sample through every configured `notify` destination and reports one line per
channel: `delivered`, `unavailable` or `failed: REASON`. It creates no item. Destination order is
in [Operator notifications](../operations/control-plane.md#operator-notifications).

## After a Control Plane restart

### Transport protocols

- Built-in connected Worklets use a private local Task Attempt journal and transport protocol 18.
- The Control Plane rejects older transports. Upgrade the Control Plane and Worker Hosts together.

### Recovery of admitted work

- Restarting the Control Plane preserves admitted work. Acceptance is recorded before
  acknowledgement, and disconnecting an event observer does not cancel execution.
- When the original durable Worklet reconnects and its receipt is available, the Control Plane
  resumes observing the same Task Attempt after its lease expires.
- Stored event sequences prevent duplicate journal ingestion. Recovery does not execute a Task
  again or charge its cost again.
- An absent or unknown receipt stays unresolved and needs operator reconciliation. A restarted
  Worklet reports unfinished journal entries as `unknown` and does not rerun them.
- Inspect results and any external effects before starting the work again. Successful recovery is
  not proof that an external action did not happen.

`supertag describe task TASK_ID` reports the latest Task Attempt's host receipt when available.
`unavailable` means the Control Plane cannot currently obtain one; it does not establish that
execution failed. For the field meanings, see
[Inspect the latest Task execution](control-plane-api.md#inspect-the-latest-task-execution).
General recovery rules are in [Scheduling and interrupted
execution](scheduling-and-recovery.md).

### Coordination credentials

Task Attempt coordination credentials are scoped to the Control Plane instance and lease
generation that issued them. During recovery, the original Worklet may exchange that exact Task
Attempt's old credential once for a credential bound to the recovered lease. The exchange does not
broaden the Tag, Objective, Task or tool authority captured at admission. Credentials for another
Task Attempt, surface credentials, and credentials presented outside the recovery window remain
invalid.
