# Respond to budget and operator requests

A **Tag** is a persistent AI identity with its own responsibilities and permissions. An
**Objective** is an outcome owned by a Tag. A **Task** is one assignment toward it, and a **Task
Attempt** is one execution of a Task. A **Mailbox** is where a Tag receives internal messages. A
**Team** groups Tags under one lead. The **Control Plane** is the SuperTag service that stores and
schedules this work. See the [glossary](../reference/glossary.md) for other terms.

Use this guide when an Objective needs an operator decision: a Task ran out of budget, the
Objective's allocation is used up, the owner sent you a question, or the owner submitted a result
for review. You will apply any change, then approve the result or message the owner.

## Before you start

- A started Objective, such as the one in [Coordinate Tasks toward an Objective](objective-coordination.md).
- Operator access to the Control Plane through the configured `supertag` CLI.
- The decision you want to make. A reply alone never changes resources; see
  [operator decisions](../reference/coordination.md#operator-decisions).

## Find what needs you

The operator inbox is one list of everything waiting on a person, across Objectives:

```sh
supertag list inbox --output text
```

Each item names its kind, its Objective, and the command that acts on it. Filter with `--kind`,
for example `--kind approval` or `--kind operator-message`. The kinds are listed in
[Operator inbox](../operations/control-plane.md#operator-inbox).

To see new items as they arrive, keep this running; press Ctrl-C to stop:

```sh
supertag watch inbox
```

```text
2026-09-30T14:02:11.000Z  approval  Objective usage-dashboard  Approval 5c1e9a40-2b7d-4f0e-9a51-3d6c8e2f1b07 (work is waiting): Merge pull request 42 (requested by Tag reviewer)  -> supertag approve request 5c1e9a40-2b7d-4f0e-9a51-3d6c8e2f1b07
```

Add `--output json` for one JSON object per line. To be told without keeping a terminal open,
configure an [operator channel](../operations/control-plane.md#operator-channel): the Control
Plane posts new items to a Slack channel or sends you a direct message.

## Decide an approval request

An **approval request** appears when a Tag wants an action that a **Permission Set**, the list of
actions a Task may perform, marks `approval: required`, or when a lead asks to approve its plan. The inbox shows it as kind
`approval` with its summary, the requesting Tag, and whether a running Task Attempt is waiting on
it. Decide it:

```sh
supertag approve request REQUEST_ID
supertag deny request REQUEST_ID --reason "Use the staging cluster instead."
```

A Task held for approval appears as kind `task-approval` and names the request that holds it; the
same `approve request` command starts it. `supertag list approval` lists requests in full, including
decided ones. The approval rules are in
[Approval requests](../reference/coordination.md#approval-requests).

## 1. Renew an exhausted Task's allocation

When a **harness**, the coding agent that runs a Task such as Claude Code or Codex, confirms
that a Task Attempt stopped for lack of budget, `read_task` shows
`failureKind: "budget-exhausted"` in its result and `task.budget-exhausted` in its history. The
Task stays failed until someone authorized decides. `supertag list inbox --kind task-budget
--output text` lists these decisions.

The text inbox shows `supertag coordinate update_task --input TASK-renew-budget.json`.
Save that file with the current Task ID and every spending limit the Task already has:

```json
{
  "objectiveId": "usage-dashboard",
  "taskId": "export-plan-1",
  "expectedStatus": "failed",
  "status": "queued",
  "executionLimits": { "maxReportedTokens": 100000 }
}
```

```sh
supertag coordinate update_task --input renew-budget.json
```

The Task returns to the queue with a fresh per-Task Attempt allocation. It may be smaller than the
previous one if little work remains. An authorized Objective owner or Team lead other than the
assignee can make the same update. The rules are in
[renewing an exhausted Task](../reference/coordination.md#renewing-an-exhausted-task).

## 2. Increase the Objective's allocation

Find blocked allocation requests:

```sh
supertag list inbox --kind objective-budget --output text
```

An `objective_budget` item appears when observation assessment would exceed the Objective
allocation, even if no Task failed. Raise the limit:

```sh
supertag update objective service-operations --budget-minor 1500
```

The Control Plane records the increase and retries pending observation admission. Only an
operator can make this change. See
[budgets and allocation](../reference/coordination.md#budgets-and-allocation).

## 3. Respond to a budget or deadline alert

List budget and deadline alerts:

```sh
supertag list inbox --kind objective-limit --output text
```

An item appears when a monetary budget reaches 80% or its limit, or when a deadline is 24 hours
away, 1 hour away, has a quarter of its time left, or passed. The owner receives the same
deadline warnings, so it can replan before the deadline. At the limit or the deadline, new work has already stopped. To let
work continue, raise the budget or move the deadline:

```sh
supertag update objective service-operations --budget-minor 400000
supertag update objective service-operations --deadline 2027-04-15T23:00:00Z
```

The CLI reads the current revision for you; see
[changing the deadline or budget](objectives.md#change-the-deadline-or-budget).

Scheduling and owner continuation resume. A moved deadline reaches the owner as one notice, and
warnings restart for the new deadline. If the owner's activation was cancelled at the budget
limit, the owner resumes and decides what to reassign; other cancelled Tasks stay cancelled. See [monetary budgets](../reference/coordination.md#monetary-budgets)
and [deadlines](../reference/coordination.md#deadlines).

## 4. Read an operator message

List messages from Objective owners:

```sh
supertag list inbox --kind operator-message --output text
```

Each item shows the owner's message and when the owner sent it:

```text
operator message: operator_message:MESSAGE_ID
  Objective: service-operations
  Team: service-operations:leadership
  Decision maker: operator
  Message (sent 2026-10-01T15:47:12.000Z): "The repair needs 500 more. May I continue?"
  Run: supertag message objective service-operations TEXT
```

`supertag describe objective service-operations` shows the same question under **Needs you**.
Text views show CLI commands for each decision. Use `--output json` to inspect the underlying
API actions when integrating with the Control Plane.
The inbox shows at most 500 characters. A longer message says that it continues and names
`supertag describe objective service-operations`, which shows the full text under **Needs you**.

An owner should ask only when a decision is needed. To share progress without requesting a reply,
send `type: "message"` to `recipientObjectiveId` with `body.message` and `needsReply: false`.
For example, report "Item 6 was built with item 3." This appears as **Latest from the owner** in
`supertag describe objective` and in `supertag watch objective`, outside **Needs you** and the
operator decision inbox.

## 5. Apply any change, then reply

Apply the resource change first with the relevant command, such as the allocation increase in
[step 2](#2-increase-the-objectives-allocation). Then message the owner:

```sh
supertag message objective service-operations "Increased the allocation to 1500. Please proceed with the repair."
```

The message reaches the owner's Mailbox with operator attribution, and the owner starts again to act
on it. If the owner has a pending question for you, your message answers the most recent one and
closes its inbox item. A decline or a request for a cheaper approach works the same way. A message
never changes the budget or allocation by itself.

A message also moves the Objective back to `working` when the owner had marked it `blocked`. Use
`-` in place of the text to read a longer message from standard input.

## 6. Review a result

An owner stops at `ready_for_review` when the Objective statement asks for a person's review.
`supertag describe objective ID` shows the owner's assessment and flags the Objective for review.
Then either approve it or push back:

```sh
supertag approve objective service-operations
supertag message objective service-operations "The runbook still names the old dashboard. Update it."
```

`approve` completes the Objective, using the owner's assessment as the completion summary. If the
owner recorded none, the summary says who approved it. It refuses any Objective that is not
`ready_for_review`, and it waits, like completion, until delegated Tasks and Mailbox messages are
settled.

`message` requests changes. The Objective returns to `working`, and the owner starts again with
your message.

When assigning a Task, ask the assignee to clean up processes and services they start before finishing. For example, stop a test database server after the tests finish.

## 7. Reopen a completed Objective

A completed Objective takes new direction only when you say so explicitly:

```sh
supertag message objective service-operations "Also cover the EU region." --reopen
```

Without `--reopen`, the message is refused. With it, the Objective returns to `working`, the reopen
is recorded in the Objective's history with your operator ID, and the owner acts on the message.

## Reply from Slack or Lark

When an Objective reports to a Slack or Lark thread, you can direct it from that thread. The thread is the
one where the Objective was created with `@SuperTag objective`, or the one an operator chose as its
notification destination.

- A plain reply in the thread is a message to the owner, exactly like `supertag message objective`.
  It does not answer a pending question. Link an answer to the question's message ID with
  `supertag message objective ID TEXT --reply-to MESSAGE_ID`. A review comment moves a
  `ready_for_review` Objective back to `working`. A completed Objective needs
  `supertag message objective ID TEXT --reopen` for new direction.
- `@SuperTag approve` in the thread approves a `ready_for_review` Objective.
- `@SuperTag pause` and `@SuperTag resume` pause and resume the Objective, like
  `supertag pause objective` and `supertag resume objective`.

Anyone who may create Objectives in that channel may do this; the message records their user, such
as `slack:U123`, as the operator. Other mentions keep their usual meaning: the Tag answers
them in the conversation.

## Check that it worked

- `supertag list inbox --kind operator-message --output text` no longer lists the answered message.
  Deadline and budget changes, pause, and resume leave unanswered questions in the inbox.
  Approval and completion wait for linked answers. Cancelling resolves unanswered questions with
  the recorded reason `Objective cancelled`. Closing an Objective expires pending approval requests.
- `supertag get objective service-operations` shows status `working` after a message, or
  `completed` with the owner's assessment after `approve`.
- `supertag get objective service-operations` shows the new `budgetLimitMinor`.
- `supertag coordinate read_task` on a renewed Task shows it `queued` again.

## Send an operator message as the owner

This step is for the Objective owner, for example a manager that sees only 50 allocation units
remain when a repair needs about 100. The owner passes this to `send_message`:

```json
{
  "recipientObjectiveId": "service-operations",
  "type": "message",
  "body": {"message": "The new workload needs a repair. I estimate 100 units; only 50 remain. Please increase the allocation or narrow the scope."},
  "idempotencyKey": "changed-workload"
}
```

SuperTag stores the message even when the Objective has no Slack thread or other reporting surface.
The owner can then `wait_for` its Mailbox, with a `reason` explaining why it is waiting. Other
managers first contact the owner through a permitted Mailbox route.

**Check:** the message appears under `supertag list inbox --kind operator-message`.

## If something goes wrong

- **The update is rejected as stale.** Another change happened first. Refresh the inbox and the
  Task or Objective, then retry with the current status or revision.
- **`approve` is refused.** The Objective is not `ready_for_review`, or Tasks or Mailbox messages
  are still unsettled. Message the owner instead, or wait for the work to settle.
- **The owner did not act on a message.** The owner starts only on a started Objective. Check
  `supertag describe objective ID`: a `Runnable: no.` line names what is holding its Tasks.
- **The renewal is rejected.** It may remove an existing limit, exceed the available budget, or
  target a completed Objective. See
  [renewing an exhausted Task](../reference/coordination.md#renewing-an-exhausted-task).
- **No external notification arrived.** The inbox shows the notification status, such as
  `unconfigured` or `failed`. See
  [Operator notifications](../operations/control-plane.md#operator-notifications).
- **A reply through `coordinate send_message` is rejected.** Only one reply wins; see
  [Objective operator messages](../reference/control-plane-api.md#objective-operator-messages).

## Next

- [Operator notifications](../operations/control-plane.md#operator-notifications)
- [Budgets and allocation](../reference/coordination.md#budgets-and-allocation)
- [Check an Objective's progress](objective-overview.md)
- [Coordinate Tasks toward an Objective](objective-coordination.md)
