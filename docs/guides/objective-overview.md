# Check an Objective's progress

Use this guide when work appears stuck, results need review, or you want to compare the budget
with reported usage. The overview reads existing records; it does not start, approve, cancel, or
retry work.

A **Tag** is a persistent AI actor with its own responsibilities and permissions. An
**Objective** is an outcome owned by a Tag. It works in **Sessions**: threads of **Tasks**, one
Task per turn, and each execution of a Task is a **Task Attempt**. A **Team** is a flat list of
member Tags, and its **Workstream** is the Team's shared record of posts. A **Workspace** is a
named repository the work happens in. A **Worker Host** is a machine or sandbox that runs work.
The **Control Plane** is the SuperTag service that stores and runs it. See the
[glossary](../reference/glossary.md) for other terms.

## Before you start

- The `supertag` CLI configured with operator access to the Control Plane.
- An Objective ID, from `supertag get objective`.

## 1. Read the overview

```sh
supertag describe objective OBJECTIVE_ID
```

The view leads with what you decide on, then the details:

```text
Objective usage-billing-7f3k: working
Outcome: Bill customers for metered usage. Done when the reconciliation suite passes.
Owner: lead
Team: Metering (backend, frontend, qa)
Budget: $12.40 of $2,000.00 spent
Deadline: 2027-03-31T23:00:00Z (about 138 days left)

Delivered:
  Meter API calls per customer (backend, Task 2f1c…)
    Commit 0123456789ab in Workspace app, 4 changed files since fedcba987654

Needs you:
  1 approval request waits for a decision.
    supertag get inbox-items --objective usage-billing-7f3k

Work: 3 Sessions
  waiting    lead     Objective conversation (2 Tasks, latest Task 8d50…)
  completed  backend  Meter API calls per customer (1 Task, latest Task 2f1c…)
  running    backend  Add the usage tables (1 Task, latest Task 9ab3…)

Details:
  Revision: 7
  Team Metering: at most 2 turns at once across its Objectives; 1 running now
  Tasks: 4 Tasks
  Follow it: supertag watch objective usage-billing-7f3k
  Full record: supertag describe objective usage-billing-7f3k --output json
```

- **Owner** is the owner Tag. **Team** is the Team the Objective names, with its members; it is
  absent when the owner works alone.
- **Budget** is unlimited, or how much of the pool is spent. One pool covers the Objective's own
  conversation and every Session beneath it. Task Attempts with unknown cost are called out,
  because the budget cannot count them.
- **Delivered** lists each Session's latest delivery: its commit and changed files in the
  Workspace, and the `supertag task download` command when it published a patch. A branch
  delivery is imported into your repository as `supertag/session/SESSION`; see
  [Workspaces](workspaces.md#3-see-the-branches-appear).
- **Needs you** lists approval requests, questions, results submitted for review, pauses, and
  budget or deadline limits, each with the command that acts on it. A question appears in full.
  Answer it under **Waiting on you** in the terminal UI.
- **Work** lists the Objective's conversation first, then each Session started beneath it, with
  the status of its latest turn and the Tag that runs it. A turn shows `waiting` when it asked a
  question or waits on an approval. Under a failed turn, the Control Plane explains why in its
  own words, with the next command to run.
- **Details** carries the revision, the Team's concurrency limit, notices such as budget and
  deadline warnings, and the commands that follow the Objective.

When a turn is queued but nothing runs it, ask why with
`supertag placement explain TASK_ID`. It names each bound Worker Host and why it cannot take the
Task, such as a disconnected host, a missing harness, or labels that do not match.

When the owner submits the Objective for review, the overview shows its assessment. Select the
Objective in the terminal UI and press `m` to request changes, or accept the result with
`supertag objective review ID approve`. See [reviewing a result](objective-decisions.md#6-review-a-result).

## 2. Follow it as it happens

```sh
supertag watch objective OBJECTIVE_ID
```

`watch` prints one line per event, with its time and actor, until the Objective is completed or
cancelled:

```text
2026-10-01 15:42:10Z  lead      Started Meter API calls per customer
2026-10-01 15:44:02Z  backend   Requested approval 3f1c…: Run the database migration
2026-10-01 15:44:40Z  operator  Approval 3f1c… approved
2026-10-01 15:47:12Z  lead      Objective conversation: Task 8d50c417-3e6b-49aa-b2f1-c07d5e9143ab is waiting: "Which plans should the first invoice run cover?"
2026-10-01 15:49:31Z  backend   Meter API calls per customer: Task 2f1c… delivered branch supertag/session/2f1c8a3e
2026-10-01 15:52:02Z  frontend  Workstream post 14 to backend: Reconciliation needs the plan ID
```

Events cover the Objective's creation and status changes, each Session's start, every turn's
status and delivery, approval requests and decisions, and the Team's Workstream posts. The first
lines replay what already happened. When the Objective closes, `watch` prints its result and
deliveries and exits. Press Ctrl-C to stop earlier; the work continues. `--output json` prints
one JSON object per line instead, with `at`, `actor`, `kind`, `message`, and, where they apply,
`sessionId`, `taskId`, `status`, `approvalId`, and `delivery`.

## 3. Inspect one turn

```sh
supertag describe task TASK_ID
supertag task events TASK_ID
```

`describe task` shows a turn's state, its Tag, and what it delivered; `events task` shows its
execution events. Captured **artifacts** are saved output files; their IDs and paths connect
results to the producing Task Attempt. See [using artifacts](../reference/artifacts.md) to read
them or pass them to another turn. The overview does not download their contents or native
conversation transcripts.

## 4. Read the whole record

```sh
supertag describe objective OBJECTIVE_ID --output json
```

It prints the `ObjectiveOverview` message in proto3 JSON: the Objective's Sessions with their
latest Task, spend against the budget for the whole Objective, and the first page of Tasks.
The `commitReviews` list records pending requests and verdicts by exact Git commit.
`ObjectiveService.DescribeObjective` pages through the rest. Ordinary `supertag get objective` returns the plain Objective
record.

Together, your Teams of Tags make up an **autonomous organization**: Teams may pursue different
Objectives but share one Control Plane, its rules, and its record of the work.

## 5. Find what needs you across Objectives

The overview's **Needs you** covers one Objective. The operator inbox covers every Objective:

```sh
supertag get inbox-item
supertag get inbox-item --objective OBJECTIVE_ID
supertag get inbox-item
```

Items show the available actions, such as `supertag approval approve ID`. A question shows up
to 500 characters of its text. `watch inbox` prints each new item on one line as
it appears; press Ctrl-C to stop. To be told without watching, configure an
[operator channel](../operations/control-plane.md#operator-notifications) in Slack. How to decide each
kind is in [Respond to an Objective](objective-decisions.md).

## 6. Read the Team's Workstream

Posts live with the Team, not the Objective, so they outlast any one Objective:

```sh
supertag get workstream-post --team TEAM --after-sequence 0 --limit 50
```

See [Share a Team's Workstream](workstreams.md).

## Check that it worked

Every Session you expected appears across the pages, and each held or waiting turn shows a reason.

## Reasons and next actions

The overview explains recorded approval, review, timer or backoff, and wait conditions. It also
shows Team capacity constraints, why no bound Worker Host can take a waiting turn, expired execution
**leases** (the Control Plane's time-limited claim on a running Task Attempt), and budget or deadline
concerns. Explanations are evidence and suggested next steps, not permission grants.

- An expired running lease calls for reconciliation. It does not prove the harness stopped, and it
  does not authorize repeating an external action.
- A spent budget pool stops new turns. The Objective's status becomes `limited`; raise the budget
  to let work continue.
- An Objective marked `blocked` ended two turns with nothing running and nothing asked. Select
  it in the terminal UI and press `m` to direct it. See
  [restart a blocked Objective](objective-decisions.md#5-restart-a-blocked-objective).
- A `cancelled` Objective shows when it was cancelled and the operator's reason. No new work
  starts for it. See [Cancel an Objective](objectives.md#cancel-an-objective).
- No recorded blocker does not establish that work can proceed. Worker Host availability and other
  admission conditions can change between one reading and the next.

## If something goes wrong

- **Access is denied.** The overview needs operator access to the whole Objective; see
  [access](../reference/coordination.md#access).
- **A turn stays pending with no blocker.** Check Worker Host availability with
  [troubleshooting](troubleshooting.md), and the Team's `maxConcurrency`.
- **A running lease expired.** See
  [After a Control Plane restart](../reference/coordination.md#after-a-control-plane-restart).

## Next

- [Respond to an Objective](objective-decisions.md)
- [Define and complete an Objective](objectives.md)
- [Overview fields](../reference/coordination.md#overview-fields)
