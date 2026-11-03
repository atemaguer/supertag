# Define and complete an Objective

A **Tag** is a persistent AI identity with its own responsibilities and permissions. An
**Objective** is an outcome owned by a Tag, with a statement of how success is verified. A **Task**
is one assignment toward it, and a **Task Attempt** is one execution of a Task. A **Team** groups
Tags under a lead, and each Team has one channel, its **Workstream**, where its members post. A
**Mailbox** is where one Tag receives direct messages. The **Control Plane** is the SuperTag service
that stores and schedules this work. See the [glossary](../reference/glossary.md) for other terms.

Use this guide to record an outcome, share it with the Tags working on it, and close it with an
explicit assessment. Ordinary questions and one-off Tasks do not need an Objective.

## Before you start

- The `supertag` CLI configured with operator access to a Control Plane.
- An active Tag to own the Objective, such as `leadership`.
- For the SDK step, a Tag Mailbox credential file for the owner; see [Tag messaging](tag-messaging.md).

## Write an Objective a team can finish

An Objective works like a goal in Claude Code or Codex, but a team pursues it across sessions and
machines. It has three parts:

- **An outcome statement,** in plain language: the result, how success is verified, what must not
  change, and when to ask a person.
- **A budget,** as an amount and currency (`--budget-minor`, `--budget-currency`).
- **A deadline,** as a timestamp (`--deadline`).

Write the statement so that someone other than the owner could check the result. "Improve billing"
gives the team nothing to check. This does:

> Customers are billed for metered usage. Done when the billing reconciliation suite passes and a
> billing review accepts the change. Keep the public API unchanged. If a migration could drop
> data, mark the Objective blocked and say what you need.

A statement that follows this template gives the owner everything it needs. Every sentence after
the first is optional:

> \<desired end state\>. Done when \<specific evidence\>. Keep \<constraints\>. Use
> \<boundaries\>. Between steps, \<how to choose the next action\>. If blocked, stop and report
> \<what you tried and what would unlock it\>.

The owner follows a "Between steps" sentence when it chooses each next action, and an "If blocked"
sentence when it stops. `supertag init` suggests this template for your first Objective.

A larger Objective can list its parts as numbered items, one per line:

> Make the operator views easier to read.
>
> 1. Map statement items to Tasks.
> 2. Separate owner reports from questions.
> 3. Show waiting Task Attempts as waiting, not cancelled.

The owner records which items each Task serves. It also checks that every item has a Task before
it waits. `supertag describe objective` then lists each item with its Tasks and state, so you can
see that item 3 has no Task yet. See
[check an Objective's progress](objective-overview.md#1-read-the-overview).

Which actions Tags may take, and which need a person, come from **Permission Sets** (lists of
allowed actions) and approvals, not the statement.

Limits behave the same way for every Objective:

- A budget with a currency caps provider-reported spend. You get one warning at 80%. At the limit,
  running work is cancelled and nothing new starts.
- A deadline warns you and the owner 24 hours before, 1 hour before, and when a quarter of the
  time remains. A 60-minute deadline warns once, with about 15 minutes left. At the deadline,
  nothing new starts. Running work gets 15 more minutes to finish, or a quarter of the time you
  gave for short deadlines, and the owner can still complete the Objective.

See [monetary budgets](../reference/coordination.md#monetary-budgets) and
[deadlines](../reference/coordination.md#deadlines).

## 1. Create the Objective from the CLI

```sh
supertag create objective usage-billing \
  --outcome "Customers are billed for metered usage. Done when the billing reconciliation suite passes and a billing review accepts the change. Keep the public API unchanged." \
  --owner leadership \
  --deadline 2027-03-31T23:00:00Z \
  --budget-minor 200000 \
  --budget-currency USD
supertag get objective usage-billing
supertag list objective
# To see only one owner:
supertag list objective --owner leadership
```

The owner filter matches the Tag that owns each Objective. Team membership does not add an
Objective to this list.

The CLI uses operator credentials and resolves Tag names. It prints a short summary:

```text
objective/usage-billing created
Started leadership with Task usage-billing:start.
Follow it: supertag watch objective usage-billing
See results: supertag describe objective usage-billing
```

Add `--output json` for the full Objective record. `update`, `complete`, `approve`, `message`, and
`cancel objective` print one line the same way. The outcome and owner are fixed once created;
operators can later move the deadline, raise the budget, or change runtime actions.

Creating the Objective also starts its owner. SuperTag forms the leadership Team and gives
`leadership` its first coordination Task, and the CLI says so:

```text
Started owner leadership with Task usage-billing:start.
```

The owner then plans the work, forms Teams, assigns Tasks, and reviews the results. Running the
same command again never starts a second owner Task. To create an Objective whose Tasks you assign
yourself, without an owner coordinating, add `--no-start`.

Standing work, such as an ongoing responsibility, can live in configuration instead. An `Objective`
manifest declares the same fields, and `supertag apply` creates and starts it. See
[Maintain an ongoing responsibility](ongoing-responsibilities.md#1-declare-the-ongoing-objective-and-its-teams).

### Runtime actions

Runtime actions let the Objective's Tasks work on a machine, such as `files:write` to edit files
and `commands:execute` to run commands. By default, an Objective gets every runtime action the
owner's Permission Sets allow through its **Roles**, the enduring responsibilities assigned to it. If `leadership` has a Role that allows
`files:write` and `commands:execute`, so does `usage-billing`. The owner's Team works within the
same list.

SuperTag records the list at creation, and `supertag get objective` shows it as
`runtimeActions`. A later Permission Set change does not rewrite it. To keep an Objective
narrower, list the actions it may use:

```sh
supertag create objective docs-review --owner leadership --runtime-action files:write \
  --outcome "Fix the broken links in the docs. Done when the link checker passes."
```

A list can only narrow. An action the owner's Permission Sets do not allow is left out, with a
warning. An owner with no runtime actions gets a warning too, because its Tasks cannot edit files
or run commands. To change the list later, replace it:

```sh
supertag update objective docs-review --runtime-action files:write --runtime-action commands:execute
```

The update applies to Tasks accepted afterwards, and stays within what the owner is allowed now.
An action marked `approval: required` still waits for approval, whoever runs it. See
[Approval](../reference/iam.md#approval).

The ID is optional. Without one, SuperTag makes one from the first words of the outcome plus a
short random suffix, such as `enterprise-customers-can-7f3k`, and prints it.

Creation also checks whether anything would hold the Objective's Tasks, and prints each finding as
a warning:

```text
Warning: Tag leadership has no Worker Host, so its Tasks cannot run. Create an Auth Key and join a host with it: supertag create auth-key NAME --tag leadership
```

A warning does not stop creation; the Tasks wait until you fix the cause. When the owner itself
cannot start, such as a Tag with no **Worker Host** (a machine or sandbox that runs work), creation says so in one more warning. Fix the
cause, then run the same command again with the Objective's ID to start the owner. Other warnings name a
bound Worker Host that is not connected, a named **Workspace** (a repository the Tasks work in) that no bound host has checked out, a
zero budget, a deadline that has passed, or an owner whose Permission Sets allow no
[runtime actions](#runtime-actions). Add `--dry-run` to see the warnings and the would-be
Objective without creating or starting anything. An unknown owner Tag or Workspace is still an error. See the [creation rules](../reference/coordination.md#objective-creation-rules)
and [budgets and allocation](../reference/coordination.md#budgets-and-allocation).

## 2. Add a Team and use its channel

```sh
supertag create team metering --objective usage-billing --name "Metering" \
  --lead backend --member frontend
```

The Team's members can now read the Objective's outcome and status. See
[visibility and access](../reference/coordination.md#visibility-and-access). The Team also has a
channel, `metering`, where its members post progress, questions, and findings. The owner reads every
channel in its Objective. See [Coordinate in a Team channel](workstreams.md).

An addressed question or blocker wakes an idle teammate with a reply activation, a budgeted run
to answer it. A blocker without an addressee goes to the Team lead. Other posts do not trigger
reply activations. Running teammates receive eligible posts live or in their next activation's
digest. For work that needs review and acceptance, assign a Task. See
[reply wakes and their limits](workstreams.md#reply-wakes-and-their-limits).

## 3. Or create the Objective through the SDK

A connected application can use the same API after checking that the human requester is allowed to
create the Objective:

```ts
import { TagMailboxClient } from "supertag-ai/messaging";

const leadership = await TagMailboxClient.fromCredentialFile(credentialFile);
const objective = await leadership.createObjective({
  id: "usage-billing",
  outcome:
    "Customers are billed for metered usage. Done when the billing reconciliation suite passes and a billing review accepts the change.",
  budgetLimitMinor: 200000,
  budgetCurrency: "USD",
});
```

An SDK-created Objective belongs to the authenticated Tag.

## 4. Complete it, or review it first

The owner completes the Objective itself when the statement is satisfied and outstanding work is
settled. It records an assessment with the evidence for each condition. You do not need to approve
routine results.

If you want to check the result first, say so in the statement, for example "A person reviews the
change before it counts as done." The owner then stops at `ready_for_review` with its assessment,
and you decide:

```sh
supertag describe objective usage-billing          # read the owner's assessment and results
supertag approve objective usage-billing            # accept: completes with that assessment
supertag message objective usage-billing "The reconciliation suite skips annual plans. Cover them."
```

`approve` completes the Objective and uses the owner's assessment as its completion summary. If the
owner recorded none, the summary says which operator approved it. `approve` works only on a
`ready_for_review` Objective.

`message` is how you push back, like requesting changes on a pull request. It delivers your text to
the owner's Mailbox, marked as yours, and moves the Objective back to `working`. The owner then
starts again and acts on it. Use `-` to read the text from standard input. See
[Respond to budget and operator requests](objective-decisions.md) for the full set of cases.

An owner completes from the SDK like this:

```ts
const latest = await leadership.getObjective("usage-billing");
await leadership.updateObjectiveStatus(latest.id, {
  status: "completed",
  expectedRevision: latest.revision,
  completionSummary:
    "End-to-end sign-in suite passed in CI run 1482. Security review approved in security-review.",
});
```

Scripts can complete an Objective directly from the CLI:

```sh
printf '%s\n' "End-to-end sign-in suite passed in CI run 1482; security review approved." | \
  supertag complete objective usage-billing --summary-file -
```

Completion records an assessment; it does not verify the claims automatically. The owner's own
activations do not hold completion, but delegated Tasks awaiting review do.

Once the Objective completes, SuperTag ends what is left. It cancels the owner's queued follow-ups,
which can no longer run, and records why on each Task. It dissolves the Objective's Teams once the
owner's last activation ends. See
[Leftovers of a finished Objective](../reference/coordination.md#leftovers-of-a-finished-objective).

## Check that it worked

`supertag get objective usage-billing` shows status `completed` and your completion summary.

## Change the deadline or budget

Only an operator can change limits:

```sh
supertag update objective usage-billing --deadline 2027-04-15T23:00:00Z
supertag update objective usage-billing --budget-minor 300000
```

A new deadline can replace one that already passed; scheduling and owner continuation resume.
When an Objective reaches its budget or finishes its deadline grace period, running Task Attempts
settle and its status becomes `limited`. Its owner gets one bounded activation to record progress,
open work, blockers, and the next useful step. Read that limit summary with
`supertag describe objective usage-billing` before raising the budget or moving the deadline.
The description also shows any reported cost overrun from Tasks that finished after exhaustion.
The owner receives one notice with the new deadline and the time left. Warnings restart for the
new deadline, measured from when you set it. A budget can only increase. Each change is recorded in the Objective's history.

The CLI reads the current revision for you. If someone else changes the Objective at the same
moment, it rereads and retries once, but only when the other change left your fields alone.
Otherwise it reports the conflict. Pass `--revision N` to fail instead of retrying; scripts and AI
actors always send the revision they read.

**Check:** `supertag describe objective usage-billing` no longer lists `deadline_passed` or
`objective_budget_exhausted` under attention.

## Keep a responsibility open

For a continuing responsibility, such as keeping dependencies patched as security advisories arrive,
create the Objective with `--ongoing` (`ongoing: true` in the API). Only an operator can end it.
To deliver new evidence for assessment, add `--observe WORKSTREAM_ID`, naming a Team channel by
its Team ID. `--ongoing` alone does not
schedule periodic work.

**Check:** follow [Maintain an ongoing responsibility](ongoing-responsibilities.md) to set up
observation delivery and confirm the owner wakes for new posts.

## Pause and resume an Objective

Pause an Objective to hold its work without losing any of it, for example while you review its
direction or free capacity for something urgent. Only an operator can pause or resume. Tags cannot,
including the Objective's owner.

```sh
supertag pause objective usage-billing
```

```text
objective/usage-billing paused; running Task Attempts finish, and no new work starts until: supertag resume objective usage-billing
```

While an Objective is paused:

- no new Task, continuation, or follow-up starts, and the owner is not woken;
- Task Attempts that are already running finish and record their results;
- queued Tasks and unread Mailbox messages wait, so nothing is lost;
- `supertag describe objective` lists the pause under `Needs you` with the resume command.

Resume it when work should continue:

```sh
supertag resume objective usage-billing
```

```text
objective/usage-billing resumed; the owner received a summary of what changed while it was paused.
```

Resuming wakes the owner with a message that says how long the Objective was paused, which Tasks
changed meanwhile, and how many queued Tasks may start again. Pausing a paused Objective, or resuming
one that is not paused, changes nothing. In the Objective's Slack or Lark thread, `@SuperTag pause`
and `@SuperTag resume` do the same.

**Check:** `supertag describe objective usage-billing` shows the pause under `Needs you`, and no
longer does after you resume it.

## Cancel an Objective

Cancel an Objective when the outcome no longer matters, for example after priorities change.
Only an operator can cancel. Tags cannot cancel an Objective, including its owner.

```sh
supertag cancel objective usage-billing --reason "Billing moved to next quarter"
```

```text
objective/usage-billing cancelled; 3 open Tasks were cancelled.
```

Cancellation is final. SuperTag then:

- cancels every open Task of the Objective, the same way `supertag cancel task` does, so running
  Task Attempts stop and their Workspace pull requests close;
- records on each cancelled Task why it stopped;
- releases the budget those Tasks had reserved;
- dissolves the Objective's Teams, unless a Team also serves an open Objective;
- stops owner continuation, limit warnings, and observation of Team channels;
- records the reason in the owner's Mailbox and posts it to the Objective's thread on a
  **collaboration surface**, an external work tool such as Slack, when it has one.

The owner's Mailbox notice does not start a new activation. Mailbox messages for the Objective
that no Tag had started are marked failed.

Cancel takes no `--revision`. Repeating it is harmless: SuperTag changes nothing and retries any
open Task that an earlier cancellation could not stop. A completed Objective cannot be cancelled,
and a cancelled one cannot be reopened. To pick the work back up, create a new Objective.

**Check:** `supertag describe objective usage-billing` shows status `cancelled`, the time, and the
reason, its Tasks show `cancelled`, and `supertag list team --objective usage-billing` shows its
Teams `dissolved`.

## If something goes wrong

- **Creation returns 409.** An Objective with that ID already has a different definition. Choose a
  new ID; see [creation rules](../reference/coordination.md#objective-creation-rules).
- **A status update reports a conflict.** Someone changed the same field while you were updating
  it. Reload the Objective before deciding whether to retry.
- **Creation printed a warning.** The Objective exists, but its Tasks wait until you fix the cause.
  `supertag describe objective ID` shows the same checks as its `Runnable` line.
- **Completion is refused because Tasks are unsettled.** See
  [Completing an Objective](../reference/coordination.md#completing-an-objective).
- **The owner stopped before the Objective was complete.** When no other Task in the Objective
  is queued, running, or waiting, SuperTag resumes the owner instead of leaving the Objective idle.
  See [owner continuation](../reference/coordination.md#owner-continuation) for the limits.
  - If the owner finished without completing the Objective, SuperTag asks it for a verdict:
    complete the Objective with evidence, continue the remaining work, or mark it blocked. After
    three such continuations in a row that start no new Tasks, SuperTag waits for you.
  - If the owner's activation failed, SuperTag resumes it from durable state, at most three times.
    It waits and retries later after a provider usage or rate limit, and it does not retry
    authentication, billing, or unavailable-model errors, which you must fix first.
  - A delegated Task that submitted a result always wakes the owner to review it, once per result.
  - When SuperTag will not resume the owner, the owner's line under `Needs you` starts with
    `Needs you: owner stalled`. Reply with `supertag message objective ID TEXT` to wake it.
  - After budget exhaustion or the deadline grace period, the Objective becomes `limited`. Review
    its limit summary, then raise the budget or move the deadline to resume it.
- **Work stopped before the deadline or budget should have been reached.** Check
  `supertag describe objective ID` for `objective_budget_exhausted`, `deadline_passed`, or
  `budget_coverage_incomplete`. Reported spend counts only the cost
  that each **harness** (the coding agent that runs a Task, such as Claude Code or Codex) reports.
- **Another Tag gets 404.** It is not the owner or a member of one of the Objective's Teams; see
  [visibility and access](../reference/coordination.md#visibility-and-access).

## Next

- [Coordinate Tasks toward an Objective](objective-coordination.md)
- [Coordinate in a Team channel](workstreams.md)
- [Objective coordination reference](../reference/coordination.md), including
  [Objective references](../reference/coordination.md#objective-references)
- [Objective HTTP contract](../../spec/objectives.md)
