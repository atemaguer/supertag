# Respond to an Objective

A **Tag** is a persistent AI actor with its own responsibilities and permissions. An
**Objective** is an outcome owned by a Tag, with a budget, a deadline, and a status. It works in
**Sessions**: threads of **Tasks**, one Task per turn. A **Task Attempt** is one execution of a
Task. The **Control Plane** is the SuperTag service that stores and runs this work. See the
[glossary](../reference/glossary.md) for other terms.

An Objective talks in the thread it was created in. Use this guide when it needs you: it asked a
question, an action waits for your approval, its budget or deadline ran out, it stopped, or it
submitted a result for review.

## Before you start

- A started Objective, such as the one in
  [Define and complete an Objective](objectives.md).
- Operator access to the Control Plane through the configured `supertag` CLI.

## Find what needs you

The operator inbox is one list of everything waiting on a person, across Objectives:

```sh
supertag get inbox-item
```

Each item names its kind, its Objective or Task, and why it waits. Filter with `--kind`:
`approval`, `question`, `budget`, `limit`, `task-attention`, `mcp-login`, or `wake-limit`.

To see new items as they arrive, keep this running; press Ctrl-C to stop:

```sh
supertag watch inbox-item
```

```text
approval approval:5c1e9a40-2b7d-4f0e-9a51-3d6c8e2f1b07 objective=usage-dashboard task=8d50c417-3e6b-49aa-b2f1-c07d5e9143ab: Merge pull request 42
```

Add `--output json` for one JSON object per line. To be told without keeping a terminal open,
use the desktop app, which notifies you of a Tag's question, or
[set up operator notifications](notifications.md): a webhook, or a Slack message to a channel or
to you.

## 1. Answer a question

A Tag that needs a decision asks and ends its turn. `supertag get inbox-item` lists its
question; answer it with `supertag question answer TASK_ID TEXT`. The answer becomes the owner's next
turn. You can also reply in the Objective's home thread.

Make any resource change before answering. For example, if the repair needs more budget, run
`supertag objective set-limits service-operations --budget-minor 1500`, then answer “Raised the
budget to 1500. Go ahead with the repair.” The answer is recorded as yours.

A question asked inside a Session beneath the Objective reaches the Objective's conversation
first: the Tag that started that Session decides whether to answer it or to ask you.

## 2. Decide an approval request

An **approval request** appears when a Tag wants an action that a **Permission Set**, the list of
actions a turn may perform, marks `approvalRequired: true`. The inbox shows it as kind `approval`,
with its summary, the requesting Tag, and whether a Task Attempt is waiting on it.

```sh
supertag get approval --objective service-operations
supertag approval approve REQUEST_ID
supertag approval deny REQUEST_ID --reason "Use the staging cluster instead."
```

Either decision continues the waiting Session as its next turn. An approval lets it retry the
same action once; `--objective-scope` admits later turns of this Objective that need the same
action without asking again. A denial gives the Tag your reason, so it can try another way or
report back. A chat message saying "approved" approves nothing. See
[Approval requests](../reference/coordination.md#approval-requests).

## 3. Raise an exhausted budget

One budget pool covers an Objective: its own conversation and every Session beneath it draw on it.
When the pool is spent, no new turn starts, the Objective becomes `limited`, and the inbox lists
it under `budget`.

```sh
supertag get inbox-item --kind budget
supertag objective set-limits service-operations --budget-minor 1500
```

A budget can only increase. The Objective leaves `limited` and work can start again. Only an operator can make this change. See
[budgets and allocation](../reference/coordination.md#the-budget-pool).

## 4. Respond to a budget or deadline warning

```sh
supertag get inbox-item --kind limit
```

An item appears when a monetary budget reaches 80%, or when a deadline is 24 hours
away, 1 hour away, has a quarter of its time left, or has passed. The owner receives the same
warnings in its conversation, so it can replan. At the limit or the deadline, new work has already
stopped. To let work continue, raise the budget or move the deadline:

```sh
supertag objective set-limits service-operations --budget-minor 400000
supertag objective set-limits service-operations --deadline 2027-04-15T23:00:00Z
```

A new deadline reaches the owner as a notice in its conversation. Warnings restart for it,
measured from when you set it. See
[changing the deadline or budget](objectives.md#change-the-deadline-or-budget).

## 5. Restart a blocked Objective

An Objective ends each turn with work running, a question asked, or the outcome finished. When a
turn ends with none of those and the Objective is still `working`, SuperTag wakes it once. If
that woken turn also ends with nothing running and nothing asked, the Objective becomes `blocked`.

Check what the blocked Objective's last turn did with `supertag describe objective ID`. Then send
its owner a direction, such as “Start with the overdue tickets from last week,” as a turn in the
Objective's Session with `supertag task submit --tag OWNER --session SESSION_ID TEXT`. The
Objective returns to `working` and its owner takes a new turn.

An `--ongoing` Objective is exempt from this rule. It may rest with nothing running and waits for
its next message, report, or notice.

## 6. Review a result

An owner stops at `ready_for_review` when it reports the Objective ready for review with
`report_objective` (see
[Complete it, or review it first](objectives.md#5-complete-it-or-review-it-first)). Run
`supertag describe objective ID` to read its assessment and see what needs your attention. To request
a revision, run `supertag objective review service-operations request-changes --feedback TEXT`,
for example with “The runbook still names the old dashboard. Update it.” The Objective returns to
`working` and the owner acts on your text.

To accept the result, run `supertag objective review service-operations approve`. This completes a
`ready_for_review` Objective and uses the owner's assessment as the completion summary.

## Reply from a collaboration thread

An Objective's home thread is the Slack, Lark, GitHub, Linear, or Teams thread it was created in,
or the thread an operator chose as its notification destination. Where SuperTag routes replies for
that surface, you can direct the Objective from the thread itself:

- A plain reply goes to the Objective's conversation. It answers a pending question and moves
  a `blocked` Objective back to `working`. A `limited` Objective refuses it until an operator
  raises the limit.
- `@SuperTag approve` completes a `ready_for_review` Objective.
- `@SuperTag pause` and `@SuperTag resume` pause and resume it, like `supertag objective pause`
  and `supertag objective resume`.

Anyone who may create Objectives in that channel may do this; the message records their user, such
as `slack:U123`, as the operator. Other mentions keep their usual meaning: the Tag answers them in
the conversation.

## Check that it worked

- `supertag get inbox-item` no longer lists the item you acted on.
- `supertag describe objective service-operations` shows `working` after a message, or
  `completed` with the assessment as its **Result** after `approve`.
- `supertag get objective service-operations` shows the new `budget_limit_minor` or
  `deadline_ms`.

## If something goes wrong

- **The update is rejected as stale.** Another change happened since the revision you passed with
  `--expected-revision`. Refresh the Objective and retry with its current revision.
- **`approve` is refused.** The Objective is not `ready_for_review`. Message it instead.
- **A message is refused.** A completed or cancelled Objective takes no more messages. Create a
  new Objective for new direction.
- **The Objective did not act on a message.** Check `supertag describe objective ID` for a pause
  or a limit, and run `supertag placement explain TASK_ID` on the queued turn to see why no
  Worker Host takes it.
- **No external notification arrived.** Each item in `supertag get inbox-item` shows its
  notification status, such as `not configured` or `failed`. See
  [Set up operator notifications](notifications.md).

## Next

- [Check an Objective's progress](objective-overview.md)
- [Define and complete an Objective](objectives.md)
- [Set up operator notifications](notifications.md)
- [Budgets and allocation](../reference/coordination.md#the-budget-pool)
