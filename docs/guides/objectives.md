# Define and complete an Objective

A **Tag** is a persistent AI actor with its own responsibilities and permissions. An
**Objective** is an outcome owned by a Tag, with a budget, a deadline, and a status. A **Session**
is one Tag's thread of **Tasks**, and a Task is one turn of a Session; a **Task Attempt** is one
execution of a Task. A **Team** is a flat list of member Tags. The **Control Plane** is the
SuperTag service that stores and runs this work. See the [glossary](../reference/glossary.md) for
other terms.

An Objective is a conversation with a goal. You can direct it from the terminal UI or its home
thread. Its owner Tag asks you a question when it needs a decision. Work happens in Sessions
started beneath it, including Sessions of other Tags in its Team.

Use this guide to record an outcome, follow the owner's work, and close the Objective with an
explicit assessment. Ordinary questions and small requests do not need an Objective. See
[Talk to a Tag from your terminal](talk-to-a-tag.md).

## Before you start

- The `supertag` CLI configured with operator access to a Control Plane.
- An active Tag to own the Objective, such as `lead`, bound to a connected **Worker Host**: a
  machine or sandbox that runs work.

## Write an Objective a Tag can finish

Start with an outcome statement in plain language. Describe the result, how to verify it, what to
preserve, and when to ask a person. Set a budget or deadline when you want to bound the work.

Write the statement so that someone other than the owner could check the result. "Improve billing"
gives the owner nothing to check. This does:

> Customers are billed for metered usage. Done when the billing reconciliation suite passes and a
> billing review accepts the change. Keep the public API unchanged. If a migration could drop
> data, stop and ask.

A statement that follows this template gives the owner everything it needs. Every sentence after
the first is optional:

> \<desired end state\>. Done when \<specific evidence\>. Keep \<constraints\>. Use
> \<boundaries\>. Between steps, \<how to choose the next action\>. If blocked, stop and report
> \<what you tried and what would unlock it\>.

The owner follows a "Between steps" sentence when it chooses each next action, and an "If blocked"
sentence when it stops. See [Write an Objective](write-an-objective.md) for worked examples.

Which actions the Objective's work may take, and which need a person, come from **Permission
Sets** (lists of allowed actions) and approvals, not the statement.

Limits behave the same way for every Objective:

- A budget with a currency caps provider-reported spend across the whole Objective. You get one
  warning at 80%. When the pool is spent, the Objective becomes `limited` and no new turn starts.
  A Claude Code turn runs with what is left as a USD limit. Codex, Cursor, and OpenCode enforce no
  cost limit, so their turns run without one and a running turn can spend past the budget. Codex
  and Cursor report estimated USD cost; OpenCode reports none, so a budget never stops it.
- A deadline warns you and the owner 24 hours before, 1 hour before, and when a quarter of the
  time remains. At the deadline, nothing new starts.

See [monetary budgets](../reference/coordination.md#the-budget-pool) and
[deadlines](../reference/coordination.md#deadlines).

## 1. Create the Objective

Open `supertag`, select `lead`, and enter a goal in its conversation.

```text
/goal Customers are billed for metered usage. Done when the billing reconciliation suite passes and a billing review accepts the change.
```

The Control Plane creates the Objective, answers in the conversation with its ID, and starts the
owner's first turn. The Objective appears in the rail; select it to open its progress view. The owner's turns work in the owner Tag's
[Workspace](../reference/resource-model.md#workspaces). Enter `/goal` on its own to set a Team or
budget in the form. You can also open the form with Ctrl-K and **Create Objective**.

Use the CLI when scripting creation, choosing the Objective's ID, or setting a deadline. You can
also [declare the Objective in a manifest](../operations/resources.md#declare-objectives).

```sh
supertag objective create usage-billing \
  "Customers are billed for metered usage. Done when the billing reconciliation suite passes and a billing review accepts the change. Keep the public API unchanged." \
  --owner lead --deadline 2027-03-31T23:00:00Z --budget-minor 200000 --currency USD
```

The command prints the Objective as JSON, including its `session_id` and the
`starting_task_id` of the owner's first turn.

Creating the Objective starts it: the owner takes its first turn at once, in the Objective's own
conversation. Running the same command again is refused, because the ID already exists. To retry
after a lost response, pass the same `--operation-id` both times; the retry returns the first
result and never starts a second turn. The terminal UI makes an ID from the first words of the
outcome plus a short suffix, such as `customers-are-billed-7f3e9a2c`.

In this example, the owner starts its own work Sessions. To let it hand work to other Tags,
create a Team and name it with `--team`. See [Organize Tags into Teams](teams.md).

Read it back, and list Objectives; filter the JSON with a tool such as `jq`:

```sh
supertag get objective usage-billing
supertag get objective | jq '.objectives[] | select(.owner_tag_id == "lead")'
```

A list page holds at most 12 Objectives; pass the last ID as `--after-id` for the next page. The
other `supertag objective` commands each print the updated Objective as JSON. The outcome, owner,
and Team are fixed once created; an operator can later move the deadline, raise the budget, or
change runtime actions.

Standing work belongs in configuration instead. An `Objective` manifest declares the same fields,
and `supertag apply` creates and starts it. See
[Maintain an ongoing responsibility](ongoing-responsibilities.md).

### Runtime actions

Runtime actions let the Objective's work act on a machine, such as `files:write` to edit files and
`commands:execute` to run commands. By default, an Objective gets every runtime action the owner's
Permission Sets allow through its **Roles**, the enduring responsibilities assigned to it. Each
turn of the Objective runs with its Tag's Roles, narrowed to this list; a location's Permission
Sets never apply, because the Objective is not a conversation there.

SuperTag records the list at creation, and `supertag get objective` shows it as `runtime_actions`.
A later Permission Set change does not rewrite it. To keep an Objective narrower, list the actions
it may use:

```sh
supertag objective create docs-review \
  "Fix the broken links in the docs. Done when the link checker passes." \
  --owner lead --runtime-action files:write
```

A list can only narrow. An action the owner's Permission Sets do not allow is left out, with a
warning. To change the list later, replace it:

```sh
supertag objective set-runtime-actions docs-review --runtime-action files:write \
  --runtime-action commands:execute
```

The update applies to turns that start afterwards. An action marked `approvalRequired: true` still
waits for approval, whoever runs it. See [Approval](../reference/iam.md#approval).

Give a lead `files:delegate-write` in its Role's Permission Set when it coordinates edits
from a read-only Workspace. Include that action in the Objective's runtime actions if you
set the list explicitly. A builder in the Team can then write in a delegated Session if
its own Role allows `files:write`. Both the lead's delegation approval rules and the
builder's write approval rules apply. To switch an existing Objective to this model,
replace its recorded runtime actions with the delegation action and any other actions
the lead still needs.

### When the first turn waits

Creation refuses an unknown owner Tag or Team, and an ID that already exists. It does not check whether a Worker Host can run the owner's turns: the first turn is
accepted and waits until one can. If nothing starts, find the waiting Task under **Work** in
`supertag describe objective ID`, then run `supertag describe task TASK_ID` or
`supertag placement explain TASK_ID` to see why each bound Worker Host cannot take it. See the
[creation rules](../reference/coordination.md#creating-an-objective).

## 2. Create it from a collaboration thread instead

In a verified Slack or Microsoft Teams channel, an authenticated person can start an Objective by
mentioning the app with `/goal`:

> @SuperTag /goal Customers can see their current usage in the dashboard, verified by the
> end-to-end usage dashboard suite, within two weeks and a $2,000 budget.

SuperTag creates the Objective and answers with its ID. That thread becomes the Objective's home
thread: every reply the owner writes posts there, and a plain reply in the thread reaches the
owner as its next turn. See
[Respond to an Objective](objective-decisions.md#reply-from-a-collaboration-thread).

Rules:

- Only `/goal`, at the start of a person's own message and right after the mention, creates an
  Objective. An ordinary mention cannot, and the Tag cannot create one on its own. Quoted commands and
  commands embedded in other text do not count.
- The Objective inherits the requesting turn's runtime permission ceiling. The request cannot
  grant additional collaboration surface access.
- The Objective's work runs in the Workspace of the owner's turn, and Sessions it starts,
  including those of other Tags, work there too. See
  [Work in a repository with Workspaces](workspaces.md).
- In the home thread, `@SuperTag approve`, `@SuperTag pause`, and `@SuperTag resume` act on the
  Objective. A chat message saying "approved" approves nothing, and an action approval goes
  through `supertag approval approve`.
- A custom [harness adapter](harness-adapters.md) offers the coordination tools through the Worker
  Host's harness services to support this flow.

## 3. Watch the owner work

The owner plans the work and starts it in Sessions beneath the Objective. A Session of the owner's
own Tag does work the owner keeps close; a Session of another Tag in the Objective's Team
delegates it. Each Session reports back into the Objective's conversation when it ends, and the
owner reviews the report, accepts it in its reply, or sends fixes.

```sh
supertag watch objective usage-billing
supertag describe objective usage-billing
```

`describe` lists the Objective's conversation and every Session beneath it under **Work**, with
each one's latest turn:

```text
Work: 3 Sessions
  waiting    lead  Objective conversation  (2 Tasks, latest Task 3a7d1f92-5c08-4b21-ae6f-1d94c2b70e35)
  succeeded  lead  Meter API calls per customer  (1 Task, latest Task 2f1c…)
  running    lead  Add the usage tables  (1 Task, latest Task 9ab3…)
```

See [Check an Objective's progress](objective-overview.md) for the whole view.

Three rules shape what the owner can do:

- **One budget pool.** The owner's turns and every Session beneath it draw on the same budget. A
  turn may spend at most what the budget has left; below a small floor, no new turn or Session
  starts and the Objective becomes `limited`.
- **Delegation stays inside the Team.** The owner may start a Session of any Tag in the
  Objective's Team that is active and bound to a Worker Host. That Tag runs under its own Roles,
  narrowed to the Objective's runtime actions and to the owner's own turn.
- **The Objective keeps moving or stops.** When a turn ends with nothing running and no question
  asked while the Objective is still `working`, SuperTag wakes the owner once and asks it to
  continue or to report the Objective's status. If that woken turn also ends that way, the Objective
  becomes `blocked`. An `--ongoing` Objective is exempt: it may
  rest until its next message.

An outstanding commit review also keeps an Objective waiting for work. When the reviewer
records a verdict, SuperTag attaches it to the exact commit and delivers it to the lead in
the Objective's conversation. See [Request a commit review](tag-messaging.md#request-a-commit-review).

## 4. Answer a question

When the owner needs a decision, it asks and ends its turn. In the terminal UI, open **Waiting
on you**, select its question, type your answer, and press Enter. The answer is the owner's
next turn. You can also answer in the Objective's home thread. See
[Respond to an Objective](objective-decisions.md).

## 5. Complete it, or review it first

The owner reports its assessment, with the evidence for each condition, in the Objective's
conversation. When the outcome is met, it calls `report_objective` with `completed` or
`ready_for_review` and a summary, and the Objective finishes with that summary. The owner can also
report `blocked`. You can record the result yourself with `supertag objective complete`.

If the owner stopped at `ready_for_review`, open the Objective in the terminal UI to read its
assessment. To request changes, run
`supertag objective review usage-billing request-changes --feedback TEXT`. The Objective returns
to `working` and the owner acts on your text. To approve, run
`supertag objective review usage-billing approve`; approval completes the Objective with the
owner's assessment as the summary.

Complete an Objective directly with your own assessment:

```sh
printf '%s\n' "Reconciliation suite passed in CI run 1482; billing review approved." | \
  supertag objective complete usage-billing --summary-file -
```

Completion records an assessment; it does not verify the claims automatically. Once the Objective
completes, SuperTag cancels what is left beneath it.

**Check:** `supertag describe objective usage-billing` shows `completed` and your summary as its
**Result**.

## Change the deadline or budget

Only an operator can change limits:

```sh
supertag objective set-limits usage-billing --deadline 2027-04-15T23:00:00Z
supertag objective set-limits usage-billing --budget-minor 300000
```

A new deadline can replace one that already passed. A budget can only increase. A new deadline
reaches the owner as a notice in its conversation, and the Objective leaves `limited` once
its limits leave room, so work can continue. Warnings restart for the new deadline, measured from when you set it.

Without `--expected-revision`, the change applies to the Objective as it is now. Pass
`--expected-revision N` to refuse the change when the Objective changed since you read revision
`N`.

**Check:** `supertag describe objective usage-billing` no longer lists the budget or deadline
limit under **Needs you**.

## Keep a responsibility open

For a continuing responsibility, such as keeping dependencies patched as advisories arrive, create
the Objective with `--ongoing` (`ongoing: true` in a manifest). Only an operator can end it, and
it is exempt from the stall rule: when nothing needs doing, the owner ends its turn and waits for
the next message, report, or notice. `--ongoing` alone does not schedule periodic work.

**Check:** follow [Maintain an ongoing responsibility](ongoing-responsibilities.md) to wire up the
evidence that wakes it.

## Pause and resume an Objective

Pause an Objective to hold its work without losing any of it, for example while you review its
direction. Only an operator can pause or resume. Tags cannot, including the owner.

```sh
supertag objective pause usage-billing
```

While an Objective is paused:

- no turn starts in the Objective's conversation or in any Session beneath it;
- Task Attempts that are already running finish and record their results;
- messages, reports, and notices wait, so nothing is lost;
- `supertag describe objective` lists the pause under **Needs you** with the resume command.

```sh
supertag objective resume usage-billing
```

Resuming gives the owner a turn with a summary of how long the Objective was paused and what
changed meanwhile. Pausing a paused Objective, or resuming one that is not paused, changes
nothing. In the Objective's Slack or Lark thread, `@SuperTag pause` and `@SuperTag resume` do the
same.

**Check:** `supertag describe objective usage-billing` shows the pause under **Needs you**, and no
longer does after you resume it.

## Cancel an Objective

Cancel an Objective when the outcome no longer matters. Only an operator can cancel.

```sh
supertag objective cancel usage-billing --reason "Billing moved to next quarter"
```

Cancellation is final. SuperTag cancels every open Task of the Objective, so running Task Attempts
stop, and records your reason on the Objective.

Cancel takes no revision. Repeating it is harmless. A completed Objective cannot be cancelled,
and a cancelled one cannot be reopened; create a new Objective to pick the work back up.

**Check:** `supertag describe objective usage-billing` shows status `cancelled`, the time, and the
reason.

## If something goes wrong

- **Creation is refused because the Objective ID already exists.** Choose a new ID; see
  [creation rules](../reference/coordination.md#creating-an-objective).
- **A status update reports a conflict.** Someone changed the same field while you were updating
  it. Reload the Objective before deciding whether to retry.
- **The first turn stays queued.** No Worker Host can take it yet. Run
  `supertag placement explain TASK_ID` with the Task that `supertag describe objective ID` lists
  under **Work**; it names each bound host and why it cannot take the Task.
- **The Objective is `blocked`.** Its turns ended twice with nothing running and nothing asked.
  Open the Objective in the terminal UI, review its last turn, and press `m` to give it a direction.
- **The Objective is `limited`.** Its budget pool is spent or its deadline passed. Raise the
  budget or move the deadline to let work continue.
- **Nothing starts although the budget has room.** The Objective may be paused, or its Team's
  `maxConcurrency` may already be reached across every Objective that names the Team. See
  [Organize Tags into Teams](teams.md#throttle-a-team-on-purpose).
- **Delegation is refused.** The target Tag is not a member of the Objective's Team, is not
  active, or has no bound Worker Host. Check `supertag get team NAME` and
  `supertag describe tag NAME`.
- **Work stopped before the deadline or budget should have been reached.** Reported spend counts
  only what each **harness** (the coding agent that runs a Task, such as Claude Code or Codex)
  reports; unpriced Task Attempts are listed on the budget line.

## Next

- [Check an Objective's progress](objective-overview.md)
- [Respond to an Objective](objective-decisions.md)
- [Organize Tags into Teams](teams.md)
- [Share a Team's Workstream](workstreams.md)
- [Objective coordination reference](../reference/coordination.md)
- [Control Plane API](../reference/control-plane-api.md)
