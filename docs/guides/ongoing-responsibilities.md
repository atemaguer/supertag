# Maintain an ongoing responsibility

A **Tag** is a persistent AI actor with its own responsibilities and permissions. A **Role**
describes a Tag's enduring responsibility. An **Objective** is an outcome owned by a Tag, with a
budget, a deadline, and a status; it works in **Sessions**, threads of **Tasks** with one Task per
turn. A **Team** is a flat list of member Tags, and its **Workstream** is the Team's shared record
of posts. A **Worker Host** is a machine or sandbox that runs work. See the
[glossary](../reference/glossary.md) for other terms.

Use this guide to keep a Tag responsible for work that becomes necessary again as conditions
change. In the example, a support manager maintains the Team's response policy as overdue tickets
reveal gaps.

An ordinary Objective must keep moving: a turn that ends with nothing running and nothing asked
gets one wake, and a second such turn blocks the Objective. **An ongoing Objective is exempt.**
When nothing needs doing it ends its turn and rests until its next message, report, or notice.
Only an operator can end it.

## Before you start

- Tags for the manager (`support-manager`) and a specialist (`support-specialist`), each bound to
  a connected Worker Host.
- A Role such as `Support Policy Owner` assigned to the manager. Its instructions should explain
  the condition to watch, the evidence needed to change the policy, and who may apply changes. See
  [Roles](../concepts/roles.md).

## 1. Declare the Objective and its Team

Standing work belongs in configuration, beside the Tags that do it. Save the responsibility as
`support-policy.yaml`:

```yaml
apiVersion: supertag/v1
kind: Objective
metadata:
  name: support-policy
spec:
  owner: support-manager
  outcome: >-
    Maintain the support response policy. Investigate each overdue-ticket report that arrives in
    this conversation, and change the policy only after a specialist's written proposal.
    Post every policy change to the Workstream. Between steps, handle the oldest unresolved
    report first. If blocked, stop and report what you tried and what would unlock it.
  ongoing: true
  budget: { minor: 50000, currency: USD }
  team:
    name: support
    members: [support-specialist]
    maxConcurrency: 2
```

`metadata.name` is the Objective's ID. `outcome` is one statement of the result, how it is
verified, and what must not change. `ongoing: true` makes this a continuing responsibility that
only an operator can end. `spec.team` declares the Objective's own Team, whose ID is the
Objective's ID and whose name is `support`; it may also be the name of an existing Team. A
`--team` option takes either the ID or the exact name. The manager may hand work to any of its
members.

Preview and apply it:

```sh
supertag diff -f support-policy.yaml
supertag apply -f support-policy.yaml
```

Applying creates the Objective, creates the Team, and starts the manager: it takes its first turn
in the Objective's own conversation. Applying again changes nothing. Keep the manifest in a
directory with the Tags it names, and apply them together as a set, such as
`supertag apply -f support/ --set support`.

The same Objective can be created with a command instead:

```sh
supertag create team support --member support-specialist
supertag create objective support-policy --owner support-manager --team support --ongoing \
  --budget-minor 50000 --budget-currency USD \
  --outcome "Maintain the support response policy. Investigate each overdue-ticket report that arrives in this conversation, and change the policy only after a specialist's written proposal."
```

**Check:** `supertag describe objective support-policy` shows status `working`, the Team and its
members, and the manager's first turn under **Work**.

## 2. Deliver evidence to the Objective

An ongoing Objective wakes when a message, Session report, approval decision, or budget or
deadline notice reaches its conversation. To send a finding, select the Objective in the
terminal UI, press `m`, and enter it. For example, “Overdue ticket 42: first response took
90 minutes against a 30-minute target. Plan: enterprise.” Press Enter to send it as the
manager's next turn.

For a monitoring script, use
[`ObjectiveService.MessageObjective`](../reference/operator-api/objective.md#messageobjective).
Check [`InboxService.ListInboxItems`](../reference/operator-api/inbox.md#listinboxitems) first and
hold the report while the manager waits for an answer. Configure the API credentials and save
`call-operator-api.py` from the
[operator API example](../reference/control-plane-api.md#send-messages-and-answer-questions).
Send the report's `summary` as `text` and give it a key unique to that report. Reuse the same key
when retrying delivery.

```sh
jq '{id: "support-policy", text: .summary, idempotencyKey: "ticket-42-overdue-report-1"}' overdue-report.json |
  python3 call-operator-api.py ObjectiveService/MessageObjective
```

If the Objective has a Slack or Lark home thread, you can also reply there. See
[Respond to an Objective](objective-decisions.md#reply-from-a-collaboration-thread).

**Check:** `supertag watch objective support-policy` shows the manager's turn starting within
seconds of the message.

## 3. Let the manager delegate and review

The manager investigates, then starts a Session of `support-specialist` for the proposal. That
Session runs under the specialist's own Roles, narrowed to the Objective's runtime actions, and
draws on the Objective's single budget pool. When it ends, its report comes back as a turn in the
Objective's conversation; the manager reviews it, accepts it in its reply, or sends fixes back to
the same Session.

```sh
supertag describe objective support-policy
```

```text
Work: 2 Sessions
  completed  support-manager     Objective conversation            (Task b81e5d47-2fa0-4c69-9d31-7e05a3bc8164)
  completed  support-specialist  Propose a response-time policy    (Task 81ba…)
```

Once the manager applies a change, it posts the decision to the Team's Workstream, where every
member reads it:

```sh
supertag list workstream-post --team support --limit 20
```

With nothing left to do, the manager ends its turn. The Objective stays `working` and waits. No
wake is scheduled, and it is never marked `blocked` for resting.

## 4. Answer the manager's questions

When the manager needs a decision, it asks and ends its turn. Select the question under
**Waiting on you** in the terminal UI, type your answer, and press Enter. You can also reply in
the Objective's home thread.

Apply any resource change, such as a budget increase, before you answer. A message alone
changes neither budgets nor permissions. See [Respond to an Objective](objective-decisions.md).

## 5. Change or end the responsibility

Edit the manifest and apply it again. Apply changes `deadline`, a larger `budget`,
`runtimeActions`, and the declared Team's name, members, and `maxConcurrency` in place. It
refuses changes to `owner`, `outcome`, `ongoing`, `workspaces`, and which Team the Objective
names, because the owner treats them as the definition of the work. Give the declaration a new
name to create a new Objective instead.

To end the responsibility, remove it from the file and apply with `--prune` and the input's set.
Prune cancels the Objective and keeps its history. See
[Manage Control Plane resources](../operations/resources.md#declare-objectives). An operator can
also cancel it directly:

```sh
supertag cancel objective support-policy --reason "Policy moved to the new support platform"
```

**Check:** `supertag get objective support-policy` shows status `cancelled` with your reason.

## Rules for your application

- Treat each report as evidence to assess. Receiving one does not authorize the actions it
  describes.
- SuperTag does not poll your ticket system. Something outside SuperTag decides when a finding is
  worth a message. A cron job can send it through the [operator API](#2-deliver-evidence-to-the-objective).
- Include an identifier, such as the ticket number, in every message. The manager reads the
  conversation's history, so a repeated identifier is how it recognizes a report it already
  handled.
- Review before application is your policy, not SuperTag's. Say it in the outcome statement and
  require the evidence in the "Done when" sentence.
- For changes to an external system, use its own authorization, version checks, and operation IDs.
  A network timeout does not establish whether a write happened; inspect the external operation's
  status before retrying. See [action effects](../reference/action-effects.md).

## If something goes wrong

- **The manager never woke after a message.** Check `supertag describe objective support-policy`:
  a `Runnable: no.` line names what holds its turns, such as a Tag with no connected Worker Host,
  a pause, or a spent budget pool.
- **The Objective is `limited`.** The budget pool is spent. Raise it with
  `supertag update objective support-policy --budget-minor AMOUNT`; a budget can only increase.
- **Work waits although the budget has room.** The Team's `maxConcurrency` counts turns across
  every Objective that names the Team. See
  [Throttle a Team on purpose](teams.md#throttle-a-team-on-purpose).
- **A turn needs attention.** Run `supertag list inbox --kind task-attention --output text`.
- **Apply refuses a change.** `owner`, `outcome`, `ongoing`, `workspaces`, and which Team the
  Objective names are fixed. Create a new Objective for a different definition.

## Next

- [Define and complete an Objective](objectives.md)
- [Respond to an Objective](objective-decisions.md)
- [Share a Team's Workstream](workstreams.md)
- [Check an Objective's progress](objective-overview.md)
