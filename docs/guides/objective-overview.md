# Check an Objective's progress

Use this guide when work appears stuck, results need review, or you want to compare allocations
with reported usage. The overview reads existing records; it does not start, approve, cancel, or
retry work.

A **Tag** is a persistent AI identity with its own responsibilities and permissions. An
**Objective** is an outcome owned by a Tag. Its **Tasks** are individual assignments, organized into
**Teams**, groups of Tags under one lead. Each execution of a Task is a **Task Attempt**. A
**Workspace** is a named repository the Tasks work in. A **Worker Host** is a machine or sandbox
that runs work, and a **Worker** is the code on it that completes Tasks. The **Control Plane** is
the SuperTag service that stores and schedules this work. See the
[glossary](../reference/glossary.md) for other terms.

`supertag watch objective OBJECTIVE_ID` streams Team channel posts and direct messages between
Tags alongside Task and approval events. Each line names its sender, type, recipient for direct
messages, and a short excerpt. Use the channel or **Mailbox** listing for the full text; a
Mailbox is where one Tag receives direct messages.

## Before you start

- The `supertag` CLI configured with operator access to the Control Plane. Team-scoped operator
  credentials cannot read the overview; see [access](../reference/coordination.md#access).
- An Objective ID, from `supertag list objective --owner TAG`.

## 1. Read the overview

```sh
supertag describe objective OBJECTIVE_ID
```

The view leads with what you decide on, then the details:

```text
Objective usage-billing-7f3k: working
Outcome: Bill customers for metered usage. Done when the reconciliation suite passes.
Owner: leadership
Runnable: yes
Budget: $12.40 of $2,000.00 spent

Delivered:
  Task build (backend, accepted)
    Branch supertag/usage-billing-7f3k/build in Workspace app (/Users/you/code/app), 4 changed files
      Review:   git diff main...supertag/usage-billing-7f3k/build
      Check out: git switch supertag/usage-billing-7f3k/build

Needs you:
  Approval 3f1c…: Run the database migration (requested by Tag backend)
    supertag approve request 3f1c…

Tasks: 3 (1 running, 1 waiting, 1 accepted)
  usage-billing-7f3k:start  waiting   leadership  Coordinate the Objective
  build                accepted  backend     Meter API calls per customer
  migrate              running   backend     Add the usage tables
```

- **Owner** is the owner Tag's name. **Budget** is unlimited, or how much of it is spent:
  provider-reported cost for a budget with a currency, allocation units otherwise.
- **Delivered** lists each Task's result: its branch and changed files, a patch with its
  `supertag download artifact` command, a pull request and its state, and output artifacts. When
  the Control Plane runs locally, a branch shows its checkout path, from this computer's host
  configuration, and the
  `git diff` and `git switch` commands that review it.
- **Needs you** lists the decisions only you make, each with its command: approval requests, owner
  questions, a result submitted for review, and budget or deadline limits. An owner question shows
  its full text, with line breaks and each line's leading indentation kept (only leading and trailing blank lines and trailing spaces are dropped) and continuation lines indented under the entry, and when the owner sent it:

  ```text
  Needs you:
    leadership asks (2026-10-01T15:47:12.000Z): "Which plans should the first invoice run cover?"
      supertag message objective usage-billing-7f3k TEXT
  ```
- **Team coordination** lists each Team's unanswered channel questions and blockers. A reply
  linked with `replyTo` removes its parent from this list. Open the Team's channel to read the
  full post and its references. These posts are information; they do not approve or assign work.
  The view shows up to 20 open posts per Team and indicates when more remain.
- **Items** appears when the statement lists numbered items, such as `1. Add metering.` Each item shows
  its state and the Tasks that serve it. The owner records those items when it assigns each Task.

  ```text
  Items:
    1  done         Meter API calls per customer.
       build accepted, also item 3
    2  in progress  Add the usage tables.
       migrate running
    3  done         Document billing setup.
       build accepted, also item 1
    4  not started  Remove password sign-in.
       No Task.
  ```

  | State | Meaning |
  | --- | --- |
  | not started | No Task serves the item, or every Task failed, was rejected, or was cancelled. |
  | in progress | A Task for the item is queued, running, or waiting. |
  | in review | No Task is open, and a result waits for review. |
  | done | No Task is open or in review, and a Task was accepted. |

  "No Task." means the owner has not assigned the item. "also item 3" means one Task served both
  items. A number the statement no longer lists shows as `(not in the statement)`. When no Task in
  the Objective records items, Items shows one line instead:

  ```text
  Items: Tasks in this Objective don't record statement items.
  ```
- **Tasks** shows each Task's state and assignee, why open work is held, and review decisions.
  Delegated work comes first. The owner's own activations, such as its start, follow-up, and
  assessment Tasks, follow it; each closes as `accepted` when it ends, because nobody reviews it.
  Submitted results still need review; a successful execution does not mean its result was accepted
  or the Objective is complete.
- **Details** lists the revision, deadline, Workspaces, Teams, and other attention items.

Allocation units, timing history, and Task Attempt evidence stay in the full record:
`supertag describe objective OBJECTIVE_ID --output json`.

The `Runnable` line says whether the Objective's Tasks can run right now:

```text
Runnable: no. No Worker Host bound to Tag leadership is connected (build-01). Its Tasks wait until one connects.
```

It checks the same conditions creation warns about: the owner Tag has a bound Worker Host, one of
them is connected, a bound host has checked out each named Workspace, and the budget and deadline
still allow new Tasks. Each reason names the next step. `Runnable: yes` means none of these holds
the Tasks; it does not promise that a Worker has capacity. A closed Objective has no `Runnable`
line.

When the owner submitted the Objective for review, the overview shows its assessment and suggests
`supertag approve objective ID` or `supertag message objective ID TEXT`. See
[reviewing a result](objective-decisions.md#6-review-a-result).

## 2. Follow it as it happens

```sh
supertag watch objective OBJECTIVE_ID
```

`watch` prints one line per event, with its time and actor, until the Objective is completed or
cancelled. Events include status changes, Tasks created, started, submitted, accepted, or rejected,
approval requests and decisions, messages between you and the owner, and deliveries:

When a recent Team post or direct message window fills, `watch` warns on stderr that it may have
missed events. Read the Team channel or Mailbox history for the full record.

```text
2026-10-01 15:42:10Z  leadership    Task build for backend: Meter API calls per customer
2026-10-01 15:44:02Z  backend       Requested approval 3f1c…: Push the sign-in branch
2026-10-01 15:44:40Z  operator      Approval 3f1c… approved
2026-10-01 15:47:12Z  leadership    Asked: "Which plans should the first invoice run cover?"
2026-10-01 15:49:31Z  backend       Task build delivered branch supertag/usage-billing-7f3k/build
2026-10-01 15:50:02Z  leadership    Task build accepted: Metering records every API call.
```

The first lines replay what already happened. When the Objective closes, `watch` prints its result
and deliveries and exits. The owner can close the Objective while its own Task Attempt still
commits to a Workspace branch. Then `watch` waits up to 30 seconds for that delivery, prints it in
the timeline, and includes it in the summary. Press Ctrl-C to stop earlier; the work continues.
`--output json` prints one JSON object per line instead, with `at`, `actor`, `kind`, `message`, and, where they apply,
`taskId`, `status`, `approvalId`, and `delivery`.

## 3. Inspect a Task

Run `supertag describe task TASK_ID` to see a Task's state, its Tag, and what it delivered, and
`supertag events task TASK_ID` for its execution events. Captured
**artifacts** are saved output files; their IDs and paths connect results to the producing Attempt
and review assessment. See [using artifacts](../reference/artifacts.md) to read them or pass them to
another Task. The overview does not download their contents or native conversation transcripts.

## 4. Page through a large Objective

```sh
supertag describe objective OBJECTIVE_ID --output json
supertag describe objective OBJECTIVE_ID --limit 25 --offset 25
supertag describe objective OBJECTIVE_ID --team TEAM_ID
```

The default page holds up to 50 Tasks; the maximum is 100. Delegated Tasks come before the owner's
own activations; within each group, Tasks are ordered by creation time and ID. Follow `nextOffset` until it is null. Concurrent changes can move page boundaries, because the
overview reads current records rather than a frozen snapshot. Ordinary `supertag get objective`
still returns the existing Objective JSON.

Together, your Teams of Tags make up an **autonomous organization**: Teams may pursue different
Objectives but share one Control Plane, its rules, and its record of the work.
Per-Tag usage and execution totals cover only the displayed page, so follow pagination before
comparing the whole organization. Missing usage reports remain unknown. See
[overview fields](../reference/coordination.md#overview-fields) for every count, rate, and timing
field.

## 5. Find what needs you across Objectives

The overview's **Needs you** covers one Objective. The operator inbox covers every Objective and
lists only what waits on a person: approval requests, held or submitted Tasks, budget and deadline alerts, and
questions from owners.

```sh
supertag list inbox --output text
supertag list inbox --objective OBJECTIVE_ID --output text
supertag watch inbox
```

Each item ends with the command that acts on it, such as `supertag approve request ID`. A question
from an owner shows its text, up to 500 characters, and when the owner sent it.
`watch inbox` prints each new item on one line as it appears; press Ctrl-C to stop. To be told
without watching, configure an [operator channel](../operations/control-plane.md#operator-channel)
in Slack. How to decide each kind is in
[Respond to budget and operator requests](objective-decisions.md).

## Check that it worked

Every Task you expected appears across the pages, and each blocked or waiting Task shows a reason.

## Reasons and next actions

The overview explains recorded approval, dependency, review, timer or backoff, and wait conditions.
It also shows visible Team capacity constraints, the last stored Worker compatibility diagnosis,
expired execution **leases** (the Control Plane's time-limited claim on a running Attempt), and
Objective deadline or allocation concerns. Explanations are evidence
and suggested next steps, not permission grants. Act through the
[coordination commands](objective-coordination.md), re-reading the affected resource and supplying
its current status or revision.

- A dependency requires **accepted** work; execution completion alone does not satisfy it.
- An expired running lease calls for reconciliation. It does not prove the Worker stopped, and it does not authorize repeating an
  external action.
- Exhausted unallocated budget restricts new admission. Already reserved Tasks are not blocked by
  that fact alone.
- An Objective marked `blocked` records the owner's assessment; it is not an execution pause.
- A `cancelled` Objective shows when it was cancelled and, under attention, `objective_cancelled`
  with the operator's reason. No new work starts for it. See
  [Cancel an Objective](objectives.md#cancel-an-objective).
- `observation_delivery_blocked` explains why new evidence from configured observation sources
  cannot progress. Inspect the source access, budget, or pending assessment Task. See
  [observation delivery](../reference/coordination.md#observation-delivery).
- An active Objective whose owner submitted a root Task without any visible queued, running, or
  waiting work gets a follow-up warning. Review the result to decide whether work remains. A prose
  request for help does not create a Mailbox escalation or a stored wait. Team filters may hide
  other work, so inspect the full Objective before acting. The warning does not restart execution.
- No recorded blocker does not establish that dispatch can proceed. Worker availability,
  cross-Objective capacity, and other admission conditions can change between observations.

## If something goes wrong

- **Access is denied.** The overview needs `read_objective` on the whole Objective; see
  [access](../reference/coordination.md#access).
- **Totals look too small.** Usage totals cover only the displayed page; follow `nextOffset`.
- **A Task stays queued with no blocker.** Check Worker availability with
  [troubleshooting](troubleshooting.md).
- **A running lease expired.** See [After a Control Plane restart](../reference/coordination.md#after-a-control-plane-restart).

## Next

- [Coordinate Tasks toward an Objective](objective-coordination.md)
- [Respond to budget and operator requests](objective-decisions.md)
- [Overview fields](../reference/coordination.md#overview-fields)
