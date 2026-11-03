# Coordinate Tasks toward an Objective

A **Tag** is a persistent AI identity with its own responsibilities and permissions. An
**Objective** is an outcome owned by a Tag, a **Task** is one assignment toward it, and a **Team**
groups Tags under one lead. Together, your Teams of Tags make up an **autonomous organization**:
Teams may pursue different Objectives but share one Control Plane, its rules, and its record of the
work. The **Control Plane** is the service that stores and coordinates the organization. A **Worker
Host** is a machine or sandbox that runs work; its **Worklet** connects it to the Control Plane, and
a **Worker** is the code there that completes Tasks. See the [glossary](../reference/glossary.md)
for other terms.

Use this guide to create an Objective, give its owner Teams and assignments, and approve and review
the results. It fits work where several Teams should contribute to one outcome, such as a feature that spans
backend, frontend, and test work.

## Before you start

- A Control Plane and a connected Worklet, set up by following [Run a Worker](workers.md). Codex,
  Claude Code, and OpenCode use the credentials already configured on the Worker Host; credentials
  are never command-line flags or Task input fields.
- A future ISO timestamp saved in `OBJECTIVE_DEADLINE` in your shell.

Tasks select compatible Workers through their execution requirements. Tags do not bind to a
**Worker Profile**, a saved recipe for running a Worker.

## 1. Create the Tag

```sh
supertag create tag executive
```

This Tag will own the Objective.

## 2. Create the Objective

```sh
supertag create objective usage-dashboard \
  --owner executive \
  --outcome 'Customers can see their current usage in the dashboard. Done when the end-to-end usage dashboard suite passes and a security review accepts the change.' \
  --deadline "$OBJECTIVE_DEADLINE" \
  --budget-minor 200000 \
  --budget-currency USD
```

The Control Plane stops accepting and dispatching new work when the deadline passes. The budget is
in minor units, so `200000` is $2,000 in US cents; see
[budgets and allocation](../reference/coordination.md#budgets-and-allocation).

The Objective gets the runtime actions, such as `files:write` and `commands:execute`, that the
owner's **Permission Sets** allow. A Permission Set lists actions a Task may perform. Add repeated `--runtime-action` options only to narrow them. See the
[creation rules](../reference/coordination.md#objective-creation-rules).

## 3. Check that the owner started

<a id="start-the-owner"></a>

Creating the Objective also started its owner. The Control Plane created the leadership Team and
the owner Tag's first coordination Task, and the CLI printed:

```text
Started owner executive with Task usage-dashboard:start.
```

The owner receives instructions to form Teams, assign bounded work, and review evidence. It can call
`create_tag`, `create_team`, and `assign_task` without a new Slack message or other external event.
See [coordination tools](../reference/coordination.md#coordination-tools).

If the CLI instead warned that the owner was not started, fix the cause it names, such as binding
a Worker Host to `executive`. Then run the same `supertag create objective usage-dashboard ...`
command again; it starts the owner once and changes nothing else.

Scripts and API clients can start an Objective created without the owner, such as with
`--no-start`, through `start_objective`. Save this as `start.json`:

```json
{
  "objectiveId": "usage-dashboard",
  "maxCostMinor": 1000
}
```

```sh
supertag coordinate start_objective --input start.json
```

Once the Objective has started, the same command returns the existing start Task.

Once the Objective has started, an addressed same-Team question or blocker can wake an idle Tag
with a reply activation. Other same-Team message types do not start an activation. Cross-Team
messages keep their coordination Task route; see
[automatic coordination Tasks](../reference/mailbox.md#automatic-coordination-tasks).

## 4. Create a Team

For a predictable operator-driven step, create a Team led by the existing owner:

```sh
supertag create team export-design --objective usage-dashboard \
  --name 'Export design' --lead executive
```

Without `--max-concurrency`, the Team runs as much work at once as Worker Hosts have room for. See
[Organize Tags into Teams](teams.md) for more options, including a deliberate throttle.

The Team also gets a channel, `export-design`, where its members post progress, questions, and
findings. See [Coordinate in a Team channel](workstreams.md).

## 5. Assign a Task that needs approval

Copy `ownerTagId` from `supertag get objective usage-dashboard` into `assignedTagId` below. Save the
result as `plan.json`:

```json
{
  "objectiveId": "usage-dashboard",
  "taskId": "export-plan-1",
  "teamId": "export-design",
  "assignedTagId": "REPLACE_WITH_OWNER_TAG_ID",
  "instruction": "Produce a short implementation plan for the usage dashboard. Name the services, migrations, and tests it touches; do not change code.",
  "acceptanceCriteria": ["A plan that names affected services, required migrations, and open risks"],
  "requiresApproval": true,
  "maxCostMinor": 500
}
```

```sh
supertag coordinate assign_task --input plan.json
```

The Control Plane stores the Task and holds it until you approve it. To read it, save
`plan-id.json`:

```json
{"objectiveId":"usage-dashboard","taskId":"export-plan-1"}
```

```sh
supertag coordinate read_task --input plan-id.json
```

## 6. Approve the Task

Every held Task has an approval request. List the pending requests for the Objective:

```sh
supertag list approval --objective usage-dashboard
```

Each entry shows the request ID, the Task, and what it needs. Approve the request for
`export-plan-1`:

```sh
supertag approve request REQUEST_ID
```

To stop the Task instead, deny it with a reason. SuperTag cancels the Task and tells the manager
why:

```sh
supertag deny request REQUEST_ID --reason 'Plan the export after the schema freeze'
```

Once a matching Worker is available, the Control Plane dispatches the Task. A successful run
submits a result; it does not accept the Task or complete the Objective.

You can still approve the Task directly. Save `approve-plan.json`:

```json
{"objectiveId":"usage-dashboard","taskId":"export-plan-1","expectedStatus":"queued","approval":"approved"}
```

```sh
supertag coordinate update_task --input approve-plan.json
```

This also marks its approval request approved.

A Task also waits for approval when its assignee's Permission Set marks a runtime action
`approval: required`, even if the manager did not ask. Approve it with `--scope objective` to
admit later Tasks with that action in this Objective without asking again. Actions on a
**collaboration surface**, an external work tool such as Slack, marked `approval: required` produce requests the same way. See
[IAM approval](../reference/iam.md#approval).

## 7. Review the result

Read the Task and its result with `read_task`, then save `review.json`. The text inbox
shows `supertag coordinate update_task --input TASK-accept-review.json` and
`supertag coordinate update_task --input TASK-reject-review.json`. Use the matching
file name and set `status` and `assessment` for your decision:

```json
{
  "objectiveId": "usage-dashboard",
  "taskId": "export-plan-1",
  "expectedStatus": "submitted",
  "status": "accepted",
  "assessment": "The submitted plan names the affected services, required migrations, and open risks."
}
```

```sh
supertag coordinate update_task --input review.json
```

Use an assessment supported by the actual result. Set `status` to `rejected` when it fails the
criteria. A later assignment can include `"dependencies":["export-plan-1"]`; it becomes eligible
only after this Task is accepted. See
[review and acceptance](../reference/coordination.md#review-and-acceptance).

## Check that it worked

```sh
supertag describe objective usage-dashboard
```

The output lists `export-plan-1` as accepted, with its review evidence and allocation. See
[Check an Objective's progress](objective-overview.md) to read the rest of the overview.

The raw records are also available:

```sh
supertag get objective usage-dashboard
supertag list team --objective usage-dashboard
```

To see the owner's view, save `inspect.json` as `{"objectiveId":"usage-dashboard"}` and run:

```sh
supertag coordinate read_objective --input inspect.json
```

## Start from a collaboration thread

1. With a matching current built-in Worker connected, invoke your Tag in a collaboration thread:

   > @SuperTag objective Customers can see their current usage in the dashboard, verified by the end-to-end usage dashboard suite, within two weeks and a $2,000 budget.

   The Tag creates an Objective bound to that conversation and starts its owner.
2. Reply in the same Slack thread to inspect assignments or ask the owner to act. Replies reuse the
   same **Session**, a group of Tasks from one conversation, without another `@SuperTag` mention.
3. To attach an existing Objective from another thread in the same verified Slack channel and
   account, use:

   > @SuperTag objective attach OBJECTIVE_ID

**Check:** the owner reports progress back to the original thread, and assignments awaiting
approval post a notice there. Approve them with [step 6](#6-approve-the-task).

Rules:

- Only the explicit `objective` command creates an Objective. An ordinary mention cannot, even if
  the model calls `create_objective`. Quoted commands and commands embedded in other text do not
  count. Ordinary conversation does not require an Objective.
- The Objective inherits the invoking Task's runtime permission ceiling. The request cannot grant
  additional collaboration surface access.
- The Objective gets the **Workspaces**, named repositories its Tasks work in, that the Tag's
  location attaches, such as a Slack channel's
  `workspaces` in the Tag manifest. A GitHub location without any gets every Workspace whose
  `source` is that repository. The Tag may pass `workspaces` to `create_objective` to name a
  subset, never another Workspace. See
  [Work in a repository with Workspaces](workspaces.md#start-from-slack-or-github).
- A Session can belong to at most one Objective; several Sessions can share one Objective.
- `attach` names the exact Objective to attach; the model cannot substitute another ID. The
  Objective must belong to the same Tag and permitted audience. Cross-channel attachment is
  rejected.
- Attaching or asking for progress does not start an unstarted Objective; that needs an explicit
  `@SuperTag objective <outcome>` command. Ordinary mentions and `select_objective` cannot adopt an
  arbitrary Objective.
- The binding persists across Control Plane restarts and applies to Tasks accepted afterward. A
  Task already accepted without an Objective stays unbound.
- A chat message saying "approved" does not approve a Task.
- Internal Teams coordinate through assignments, Team channels, and Mailboxes without creating a
  surface channel for each Team.
- Custom Workers must advertise the surface coordination capability and consume the supplied
  coordination tools to support this flow. Use the current SDK connection, which negotiates the
  supported Worklet protocol with the Control Plane.

## Pass captured files to a reviewer

1. Read the producing Task with `read_task` and copy an artifact ID and entry paths from
   `result.taskResult.artifacts`. An **artifact** is a saved capture of a Task's output files.
2. Assign the review with those values in `inputArtifacts`:

   ```json
   {
     "taskId": "review-implementation",
     "teamId": "delivery",
     "assignedTagId": "reviewer",
     "instruction": "Independently test the supplied implementation and report evidence.",
     "acceptanceCriteria": ["Report passing and failing cases"],
     "inputArtifacts": [{"artifactId": "implementation-capture", "paths": ["workspace/app.py"]}]
   }
   ```

   Add `requireAccepted: true` to an entry when the consumer needs already reviewed work.

**Check:** `read_task` on the review lists the selected `inputArtifacts`. Codex and Claude Code
preserve each selected entry's relative path beneath an `inputs/artifact-<id-hash>/` directory and
provide the mounted location in the prompt.

Files come from the Worker Host that holds the producer's copy; the consumer's Worklet downloads
them directly, and the Control Plane never carries them. See
[Artifact storage](../operations/control-plane.md#artifact-storage). They survive cleanup of the
producer's environment while that Worker Host keeps its state directory. See
[inputs and dependencies](../reference/coordination.md#task-inputs-and-dependencies) and
[artifact handoff](../reference/artifacts.md#handoff-and-review) for the rules.

## Wait for results without holding capacity

1. The owner's root **harness** actor (the coding agent session, such as Claude Code or Codex)
   calls `wait_for` with one or more wake conditions. This needs a durable
   Worklet, one that keeps a local record of each run so it can confirm when the run stopped.
   To wait for child results:

   ```json
   {"submittedTaskIds":["audit-log-api","export-e2e-tests"]}
   ```

   To wait for new posts in a Team channel:

   ```json
   {"workstreamPosts":{"workstreamId":"export-design","afterSequence":120}}
   ```

   Add an optional `reason`, such as `"Need the exact candidate hash from operations"`, when
   waiting for another actor.

   When several results are pending, name every one in `submittedTaskIds`. Any delegated result
   submitted for the owner's review wakes it, and so does any delegated Task that fails, so the
   owner reviews each result or failure as it lands. The
   owner's instructions also say to stop sending medium review findings back after two fix rounds
   on the same code and list them in the completion summary. That limit never covers high
   findings: the owner sends a high finding back until it is fixed, or asks the operator before
   completing with it open. The instructions also say to ask the operator before dropping an item
   only for lack of time.
2. The Control Plane stops the current run and releases its capacity. It starts the same Task again
   when a condition is met, including after a restart.
3. The owner wakes in a fresh harness session, not the previous conversation. It gets a short
   Objective brief instead: what changed while it waited, the open Tasks, the results to review,
   and its own wait reason. It reads anything else with `read_objective`, `read_task`, or
   `read_mailbox`. Because the transcript does not grow, a late wake costs about as much as an
   early one. See [owner wakes](../reference/coordination.md#owner-wakes).

**Check:** `supertag describe objective usage-dashboard` shows the Task as waiting, with its conditions.
`supertag describe task usage-dashboard:start` lists each **Task Attempt**, one execution or
retry, of the owner's start Task
with its reported cost. See [wait conditions](../reference/coordination.md#wait-conditions) for
every option and rule.

## Cancel and replace a Task

1. Save `cancel.json` with the Task's current status:

   ```json
   {"objectiveId":"usage-dashboard","taskId":"export-plan-1","expectedStatus":"queued","status":"cancelled"}
   ```

   ```sh
   supertag coordinate update_task --input cancel.json
   ```

2. Assign the replacement under a new stable Task ID.

**Check:** `read_task` shows the old Task as `cancelled`. Cancellation keeps the old record and
prevents a late result from accepting its replacement. Retrying admission with the same ID and
definition returns the existing Task; changing its definition under that ID is rejected.

## Change a Team

1. Update membership, or throttle the Team on purpose:

   ```sh
   supertag update team export-design --objective usage-dashboard --max-concurrency 2
   ```

**Check:** `supertag events team export-design --objective usage-dashboard` shows the change. Close
unfinished assignments before removing their responsible member or dissolving their Team. See
[Team rules](../reference/coordination.md#team-rules).

## If something goes wrong

- **The Task never starts.** Its approval may still be pending; run [step 6](#6-approve-the-task).
  `supertag list approval --objective ID` lists pending approvals.
- **No Worker picks up the Task.** `read_task` may show a `task.scheduling-incompatible` diagnosis.
  Compare its requirements with the connected Worker Profiles; see
  [execution requirements](../reference/coordination.md#execution-requirements),
  [Inspect the latest Task execution](../reference/control-plane-api.md#inspect-the-latest-task-execution),
  and [execution limits](../reference/worker.md#execution-limits).
- **Completion fails with HTTP 409.** Other Tasks are unsettled or messages in a
  **Mailbox**, a Tag's direct delivery point, are pending.
  See [Completing an Objective](../reference/coordination.md#completing-an-objective).
- **A Task failed with `budget-exhausted`.** See
  [Respond to budget and operator requests](objective-decisions.md).
- **A Task failed after delivering commits.** Its work is on its Task branch. Review the branch,
  then accept the Task; see
  [Accepting a failed Task that delivered commits](../reference/coordination.md#accepting-a-failed-task-that-delivered-commits).
- **Execution was interrupted or the Control Plane restarted.** See
  [After a Control Plane restart](../reference/coordination.md#after-a-control-plane-restart).

## Next

- [Respond to budget and operator requests](objective-decisions.md)
- [Maintain an ongoing responsibility](ongoing-responsibilities.md)
- [Organize Tags into Teams](teams.md)
- [Objective coordination reference](../reference/coordination.md)
