# Respond to an Objective

A **Tag** is a persistent AI identity with its own responsibilities and permissions. An
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
supertag list inbox --output text
```

Each item names its kind, its Objective, and the command that acts on it. Filter with `--kind`:
`approval`, `question`, `objective-budget`, `objective-limit`, `task-attention`, or `mcp-login`.

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

## 1. Answer a question

A Tag that cannot go on without a decision asks and ends its turn. The question appears as inbox
kind `question`, and in full under **Needs you** in the Objective's description:

```sh
supertag list inbox --kind question --output text
supertag describe objective service-operations
```

```text
Needs you:
  support-manager asks: "The repair needs 500 more. May I continue?"
    supertag message objective service-operations TEXT
```

Apply any resource change first, then answer. Your text arrives as the Objective's next turn:

```sh
supertag update objective service-operations --budget-minor 1500
supertag message objective service-operations "Raised the budget to 1500. Go ahead with the repair."
```

```text
Sent to the conversation of Objective service-operations.
```

The message is recorded as yours. Use `-` in place of the text to read a longer message from
standard input. A message never changes a budget, a permission, or an approval by itself. When
the Objective was created from your CLI, the command follows the owner's reply; otherwise the
reply posts to the Objective's home thread.

A question asked inside a Session beneath the Objective reaches the Objective's conversation
first: the Tag that started that Session decides whether to answer it or to ask you.

## 2. Decide an approval request

An **approval request** appears when a Tag wants an action that a **Permission Set**, the list of
actions a turn may perform, marks `approval: required`. The inbox shows it as kind `approval`,
with its summary, the requesting Tag, and whether a Task Attempt is waiting on it.

```sh
supertag list approval --objective service-operations
supertag approve request REQUEST_ID
supertag deny request REQUEST_ID --reason "Use the staging cluster instead."
```

Either decision continues the waiting Session as its next turn. An approval lets it retry the
same action once; `--scope objective` admits later turns of this Objective that need the same
action without asking again. A denial gives the Tag your reason, so it can try another way or
report back. A chat message saying "approved" approves nothing. See
[Approval requests](../reference/coordination.md#approval-requests).

## 3. Raise an exhausted budget

One budget pool covers an Objective: its own conversation and every Session beneath it draw on it.
When the pool is spent, no new turn starts, the Objective becomes `limited`, and the inbox lists
it under `objective-budget` or `objective-limit`.

```sh
supertag list inbox --kind objective-budget --output text
supertag update objective service-operations --budget-minor 1500
```

A budget can only increase. The Objective leaves `limited`, the owner gets a notice with the new
figure, and work can start again. Only an operator can make this change. See
[budgets and allocation](../reference/coordination.md#the-budget-pool).

## 4. Respond to a budget or deadline warning

```sh
supertag list inbox --kind objective-limit --output text
```

An item appears when a monetary budget reaches 80% or its limit, or when a deadline is 24 hours
away, 1 hour away, has a quarter of its time left, or has passed. The owner receives the same
warnings in its conversation, so it can replan. At the limit or the deadline, new work has already
stopped. To let work continue, raise the budget or move the deadline:

```sh
supertag update objective service-operations --budget-minor 400000
supertag update objective service-operations --deadline 2027-04-15T23:00:00Z
```

The CLI reads the current revision for you; see
[changing the deadline or budget](objectives.md#change-the-deadline-or-budget). Warnings restart
for the new deadline, measured from when you set it.

## 5. Restart a blocked Objective

An Objective ends each turn with work running, a question asked, or the outcome finished. When a
turn ends with none of those and the Objective is still `working`, SuperTag wakes it once. If
that woken turn also ends with nothing running and nothing asked, the Objective becomes `blocked`
and SuperTag says so in its home thread:

```text
Objective service-operations is blocked: its turns ended twice with nothing running and nothing
asked. Reply in this thread or run supertag message objective service-operations to direct it.
```

Read `supertag describe objective service-operations` to see what the last turn did, then direct
it:

```sh
supertag message objective service-operations "Start with the overdue tickets from last week."
```

```text
Sent to the conversation of Objective service-operations.
The Objective moved from blocked back to working.
```

An `--ongoing` Objective is exempt from this rule. It may rest with nothing running and waits for
its next message, report, or notice.

## 6. Review a result

An owner stops at `ready_for_review` when the Objective's statement asks for a person's review.
`supertag describe objective ID` shows its assessment under **Owner's assessment** and the review
under **Needs you**. Approve it or push back:

```sh
supertag approve objective service-operations
supertag message objective service-operations "The runbook still names the old dashboard. Update it."
```

`approve` completes the Objective, using the assessment as the completion summary. If none was
recorded, the summary says who approved it. It refuses an Objective that is not
`ready_for_review`. A message instead returns the Objective to `working` and arrives as its next
turn.

## Reply from a collaboration thread

An Objective's home thread is the Slack, Lark, GitHub, Linear, or Teams thread it was created in,
or the thread an operator chose as its notification destination. Where SuperTag routes replies for
that surface, you can direct the Objective from the thread itself:

- A plain reply is a message to the Objective, exactly like `supertag message objective`. It
  answers a pending question and moves a `blocked`, `limited`, or `ready_for_review` Objective
  back to `working`.
- `@SuperTag approve` completes a `ready_for_review` Objective.
- `@SuperTag pause` and `@SuperTag resume` pause and resume it, like `supertag pause objective`
  and `supertag resume objective`.

Anyone who may create Objectives in that channel may do this; the message records their user, such
as `slack:U123`, as the operator. Other mentions keep their usual meaning: the Tag answers them in
the conversation.

## Check that it worked

- `supertag list inbox --output text` no longer lists the item you acted on.
- `supertag get objective service-operations` shows status `working` after a message, or
  `completed` with the assessment after `approve`.
- `supertag get objective service-operations` shows the new `budgetLimitMinor` or `deadline`.

## If something goes wrong

- **The update is rejected as stale.** Another change happened first. Refresh the Objective and
  retry with its current revision.
- **`approve` is refused.** The Objective is not `ready_for_review`. Message it instead.
- **A message is refused.** A completed or cancelled Objective takes no more messages. Create a
  new Objective for new direction.
- **The Objective did not act on a message.** Check `supertag describe objective ID`: a
  `Runnable: no.` line names what is holding its turns, such as a Tag with no connected Worker
  Host, or a pause.
- **No external notification arrived.** The inbox shows the notification status, such as
  `unconfigured` or `failed`. See
  [Set up operator notifications](notifications.md).

## Next

- [Check an Objective's progress](objective-overview.md)
- [Define and complete an Objective](objectives.md)
- [Operator notifications](../operations/control-plane.md#operator-notifications)
- [Budgets and allocation](../reference/coordination.md#the-budget-pool)
