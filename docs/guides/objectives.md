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
- A deadline warns you and the owner 24 hours before, 1 hour before, and when a quarter of the
  time remains. At the deadline, nothing new starts.

See [monetary budgets](../reference/coordination.md#the-budget-pool) and
[deadlines](../reference/coordination.md#deadlines).

## 1. Create the Objective

Open `supertag`, select `lead`, and enter a goal in its conversation.

```text
/goal Customers are billed for metered usage. Done when the billing reconciliation suite passes and a billing review accepts the change.
```

SuperTag creates the Objective and starts the owner's first turn. Press Enter again to open its
progress view. In a checkout registered with the local Control Plane, the Objective uses that
[Workspace](../reference/resource-model.md#workspaces). Enter `/goal` on its own to set a Team or
budget in the form. You can also open the form with Ctrl-K and **Create Objective**.

Use the CLI when scripting creation or setting a Workspace or deadline explicitly. You can also
[declare the Objective in a manifest](../operations/resources.md#declare-objectives).

```sh
supertag create objective usage-billing \
  --outcome "Customers are billed for metered usage. Done when the billing reconciliation suite passes and a billing review accepts the change. Keep the public API unchanged." \
  --owner lead \
  --deadline 2027-03-31T23:00:00Z \
  --budget-minor 200000 \
  --budget-currency USD
```

```text
objective/usage-billing created
Started lead with Task 3a7d1f92-5c08-4b21-ae6f-1d94c2b70e35.
Follow it: supertag watch objective usage-billing
See results: supertag describe objective usage-billing
```

Creating the Objective starts it: the owner takes its first turn at once, in the Objective's own
conversation. Running the same command again never starts a second turn. The ID is optional;
without one, SuperTag makes one from the first words of the outcome plus a short suffix, such as
`customers-are-billed-7f3k`.

In this example, the owner starts its own work Sessions. To let it hand work to other Tags,
create a Team and name it with `--team`. See [Organize Tags into Teams](teams.md).

Read it back, and filter the list by owner:

```sh
supertag get objective usage-billing
supertag list objective --owner lead
```

Add `--output yaml` for the full record. `update`, `complete`, `approve`, `pause`, `resume`, and
`cancel objective` each print one line. The outcome, owner, Workspaces, and Team are
fixed once created; an operator can later move the deadline, raise the budget, or change runtime
actions.

Standing work belongs in configuration instead. An `Objective` manifest declares the same fields,
and `supertag apply` creates and starts it. See
[Maintain an ongoing responsibility](ongoing-responsibilities.md).

### Runtime actions

Runtime actions let the Objective's work act on a machine, such as `files:write` to edit files and
`commands:execute` to run commands. By default, an Objective gets every runtime action the owner's
Permission Sets allow through its **Roles**, the enduring responsibilities assigned to it. Each
turn of the Objective runs with its Tag's Roles, narrowed to this list; a location's Permission
Sets never apply, because the Objective is not a conversation there.

SuperTag records the list at creation, and `supertag get objective` shows it as `runtimeActions`.
A later Permission Set change does not rewrite it. To keep an Objective narrower, list the actions
it may use:

```sh
supertag create objective docs-review --owner lead --runtime-action files:write \
  --outcome "Fix the broken links in the docs. Done when the link checker passes."
```

A list can only narrow. An action the owner's Permission Sets do not allow is left out, with a
warning. To change the list later, replace it:

```sh
supertag update objective docs-review --runtime-action files:write --runtime-action commands:execute
```

The update applies to turns that start afterwards. An action marked `approval: required` still
waits for approval, whoever runs it. See [Approval](../reference/iam.md#approval).

### Warnings at creation

Creation checks whether anything would hold the Objective's turns, and prints each finding as a
warning:

```text
Warning: Tag lead has no Worker Host, so its Tasks cannot run. Create an Auth Key and join a host with it: supertag create auth-key NAME --tag lead
```

A warning does not stop creation; the turns wait until you fix the cause. When the owner itself
cannot start, creation says so in one more warning; fix the cause, then run the same command again
with the Objective's ID to start it. Other warnings name a bound Worker Host that is not
connected, a named **Workspace** (a repository the work happens in) that no bound host has checked
out, a zero budget, a deadline that has passed, or an owner whose Permission Sets allow no
[runtime actions](#runtime-actions). Add `--dry-run` to see the warnings and the would-be
Objective without creating anything. An unknown owner Tag, Team, or Workspace is still an error.
See the [creation rules](../reference/coordination.md#creating-an-objective).

## 2. Create it from a collaboration thread instead

In a verified Slack, Lark, GitHub, Linear, or Teams conversation, an authenticated person can
start an Objective with an explicit command:

> @SuperTag objective Customers can see their current usage in the dashboard, verified by the
> end-to-end usage dashboard suite, within two weeks and a $2,000 budget.

The Tag creates the Objective and tells you briefly. That thread becomes the Objective's home
thread: every reply the owner writes posts there, and a plain reply in the thread reaches the
owner as its next turn. See
[Respond to an Objective](objective-decisions.md#reply-from-a-collaboration-thread).

Rules:

- Only the explicit `objective` command creates an Objective. An ordinary mention cannot, even if
  the Tag calls `create_objective`. Quoted commands and commands embedded in other text do not
  count.
- The Objective inherits the requesting turn's runtime permission ceiling. The request cannot
  grant additional collaboration surface access.
- The Objective gets the Workspaces the Tag's location attaches, such as a Slack channel's
  `workspaces` in the Tag manifest. A GitHub location without any gets every Workspace whose
  `source` is that repository. The Tag may name a subset, never another Workspace. See
  [Work in a repository with Workspaces](workspaces.md#start-from-slack-or-github).
- A chat message saying "approved" approves nothing. Approvals go through
  `supertag approve request`.
- A custom **Worker** must advertise the surface coordination capability and pass the supplied
  coordination tools to its harness to support this flow. See
  [Build a custom Worker](custom-workers.md).

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
  waiting    lead     Objective conversation            (Task 3a7d1f92-5c08-4b21-ae6f-1d94c2b70e35)
  completed  lead     Meter API calls per customer      (Task 2f1c…)
  running    lead     Add the usage tables              (Task 9ab3…)
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
  asked while the Objective is still `working`, SuperTag wakes the owner once: "nothing is
  running; continue or finish." If that woken turn also ends that way, the Objective becomes
  `blocked` and SuperTag says so in the home thread. An `--ongoing` Objective is exempt: it may
  rest until its next message.

## 4. Answer a question

When the owner needs a decision, it asks and ends its turn. In the terminal UI, open **Waiting
on you**, select its question, type your answer, and press Enter. The answer is the owner's
next turn. You can also answer in the Objective's home thread. See
[Respond to an Objective](objective-decisions.md).

## 5. Complete it, or review it first

The owner completes the Objective itself when the statement is satisfied, recording an assessment
with the evidence for each condition. You do not need to approve routine results.

If you want to check the result first, say so in the statement, for example “A person reviews the
change before it counts as done.” The owner then stops at `ready_for_review` with its assessment.
Open the Objective in the terminal UI to read it. To request changes, press `m`, describe what
should change, and press Enter. The Objective returns to `working` and the owner acts on your
text.

To approve the result, run `supertag approve objective usage-billing`. Approval completes a
`ready_for_review` Objective using the owner's assessment as the summary. If the owner recorded
none, the summary says who approved it.

Scripts can complete an Objective directly:

```sh
printf '%s\n' "Reconciliation suite passed in CI run 1482; billing review approved." | \
  supertag complete objective usage-billing --summary-file -
```

Completion records an assessment; it does not verify the claims automatically. Once the Objective
completes, SuperTag cancels what is left beneath it.

**Check:** `supertag get objective usage-billing` shows status `completed` and your completion
summary.

## Change the deadline or budget

Only an operator can change limits:

```sh
supertag update objective usage-billing --deadline 2027-04-15T23:00:00Z
supertag update objective usage-billing --budget-minor 300000
```

A new deadline can replace one that already passed. A budget can only increase. Each change
reaches the owner as a notice in its conversation, and the Objective leaves `limited` so work can
continue. Warnings restart for the new deadline, measured from when you set it.

The CLI reads the current revision for you. If someone else changes the Objective at the same
moment, it rereads and retries once, but only when the other change left your fields alone.
Otherwise it reports the conflict. Pass `--revision N` to fail instead of retrying.

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
supertag pause objective usage-billing
```

```text
objective/usage-billing paused; running Task Attempts finish, and no new work starts until: supertag resume objective usage-billing
```

While an Objective is paused:

- no turn starts in the Objective's conversation or in any Session beneath it;
- Task Attempts that are already running finish and record their results;
- messages, reports, and notices wait, so nothing is lost;
- `supertag describe objective` lists the pause under **Needs you** with the resume command.

```sh
supertag resume objective usage-billing
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
supertag cancel objective usage-billing --reason "Billing moved to next quarter"
```

Cancellation is final. SuperTag cancels every open Task of the Objective, so running Task Attempts
stop and their Workspace pull requests close, records why on each one, and posts the reason to the
Objective's home thread. Waiting messages and reports are failed rather than delivered.

Cancel takes no `--revision`. Repeating it is harmless. A completed Objective cannot be cancelled,
and a cancelled one cannot be reopened; create a new Objective to pick the work back up.

**Check:** `supertag describe objective usage-billing` shows status `cancelled`, the time, and the
reason.

## If something goes wrong

- **Creation returns 409.** An Objective with that ID already has a different definition. Choose a
  new ID; see [creation rules](../reference/coordination.md#creating-an-objective).
- **A status update reports a conflict.** Someone changed the same field while you were updating
  it. Reload the Objective before deciding whether to retry.
- **Creation printed a warning.** The Objective exists, but its turns wait until you fix the
  cause. `supertag describe objective ID` shows the same checks on its `Runnable` line.
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
- [Objective HTTP contract](../../spec/objectives.md)
