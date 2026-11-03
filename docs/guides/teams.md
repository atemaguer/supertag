# Organize Tags into Teams

A **Tag** is a persistent AI identity with its own responsibilities and permissions. A **Team** is a
group of Tags that share a responsibility, with a lead, members, and a limit on how much work runs
at once. An **Objective** is an outcome owned by a Tag, and a **Task** is one assignment toward it.
The **Control Plane** is the SuperTag service that stores and schedules this work. See the
[glossary](../reference/glossary.md) for other terms.

Use this guide to group Tags into a Team for an Objective, change it as work evolves, review its
history, and dissolve it when the work is done.

Together, your Teams of Tags make up an **autonomous organization**: Teams may pursue different
Objectives but share one Control Plane, its rules, and its record of the work.
Team membership answers where a Tag works in the organization. A **Role** describes an enduring
responsibility held by a Tag. Local subagents that an agent system creates inside one execution are
not Team members.

## Before you start

- The `supertag` CLI configured with operator access to the Control Plane. These are operator
  commands; agents use `create_team` and `update_team` instead.
- An Objective, such as `launch`, created as in [Define and complete an Objective](objectives.md).
- Tags for the lead and members.

## 1. Create a Team

```sh
supertag create team engineering --objective launch --name Engineering --lead engineering-lead --member backend --member frontend
supertag list team
supertag list team --objective launch
```

Without `--objective`, the list includes Teams from every unfinished Objective, even when the
organization has more than 200 Objectives.

The Objective owner or an operator creates root Teams. A parent Team lead can create subteams with
`--parent`.

A declared Objective can also declare its Teams, keyed by name, and `supertag apply` keeps them in
place. See [Declare Objectives](../operations/resources.md#declare-objectives).

Every Team gets one channel, created with it, whose ID is the Team ID. Members post progress,
questions, and findings there, and the Objective owner reads it.
`supertag get workstream engineering` shows it. See [Coordinate in a Team channel](workstreams.md).

## 2. Update the Team

```sh
supertag update team engineering --objective launch --member backend --member frontend --member qa
```

The CLI reads the Team's current revision for you. If someone else changed the same fields first,
the update fails; read the latest Team and reconsider the change. Pass `--revision N` to fail on
any concurrent change instead.

## 3. Review the change history

```sh
supertag events team engineering --objective launch --after-revision 1 --limit 25
```

The history lists changed fields in revision order, with who made each change. Use
`--after-revision` to continue from the last revision you inspected.

## 4. Dissolve the Team

```sh
supertag dissolve team engineering --objective launch
```

Close unfinished Tasks and active subteams first. The Team's channel stays readable but accepts no
more posts.

## Check that it worked

`supertag list team --objective launch` shows `engineering` with status `dissolved`, and
`supertag events team engineering --objective launch` shows each revision.

## Limit how large the hierarchy grows

Scaling ceilings bound how many subteams managers can create. For example, an Engineering Team can
allow at most three child Teams at each level and no more than two levels below itself.

1. Set the ceilings when you create the Team:

   ```sh
   supertag create team engineering --objective launch --name Engineering --lead engineering-lead --max-breadth 3 --max-depth 2
   ```

2. Change one ceiling later; the other stays as it was:

   ```sh
   supertag update team engineering --objective launch --max-breadth 2
   ```

**Check:** `supertag events team engineering --objective launch` shows the new ceiling. Zero
prevents children. See [Team rules](../reference/coordination.md#team-rules) for how ceilings
inherit and when an update is rejected.

## Throttle a Team on purpose

By default a Team has no concurrency limit. Its members start work as soon as a **Worker Host**, a
machine or sandbox that runs work, has a free slot, so independent Tasks run at once. Set a limit only when you want fewer Tasks running,
for example to protect a rate-limited service.

1. Allow at most two of the Team's **Task Attempts**, single executions of a Task, to run at once:

   ```sh
   supertag update team engineering --objective launch --max-concurrency 2
   ```

2. Remove the limit again, so Worker Host capacity is the only limit:

   ```sh
   supertag update team engineering --objective launch --max-concurrency ""
   ```

The limit counts only Task Attempts running for the Team's own members. A waiting Task holds no
slot, and a subteam's work counts against the subteam, not its parent.

**Check:** `supertag describe objective launch` shows `Team Engineering: led by
engineering-lead, 1 of 2 running`, or `3 running, limited only by Worker Host capacity` without a
limit. That count is the one the scheduler enforces.

## Share a Team across Objectives

An operator can link an existing Team to additional Objectives through the Control Plane API. Each
linked Objective can assign work to the Team under its own budget and permission ceiling. A Team
concurrency limit, if set, applies across all of them. The Team's channel keeps each Objective's
posts apart: a linked Objective's owner reads only posts written under it, never earlier ones or
another Objective's.

**Check:** `read_team` returns the Team's governing and linked Objectives. See
[Teams shared across Objectives](../reference/coordination.md#teams-shared-across-objectives)
before removing a link.

## How managers coordinate across Teams

Team leads use SuperTag coordination tools such as `read_team`, `assign_task`, and `send_message`
when work crosses a Team or **harness** boundary; a harness is the coding agent that runs a
Task, such as Claude Code or Codex. See
[coordination tools](../reference/coordination.md#coordination-tools) for the full list and
addressing for each Tag's **Mailbox**, its direct delivery point, and [cross-Team conventions](../reference/coordination.md#cross-team-conventions)
for escalation, priority, governance, and shared knowledge.

Pending decisions for operators appear in `supertag coordinate inbox`; see
[Operator notifications](../operations/control-plane.md#operator-notifications).

### How an Objective owner staffs its own Teams

When an Objective starts, its owner gets a leadership Team, `OBJECTIVE:leadership`, with only
itself as a member. The owner staffs work without operator help:

1. It calls `list_tags` to find the organization's Tags by name, with their Roles, allowed models
   and efforts, and whether a Worker Host is connected for each.
2. It calls `create_team` with `parentTeamId` set to its leadership Team. The Team may include
   any active Tag bound to a Worker Host. The owner leaves out `maxConcurrency` unless it wants to
   throttle that Team.
3. It assigns Tasks to the Team's members with `assign_task`.

Coordination tools take Tag names as well as IDs, so `"memberTagIds": ["builder-opus",
"reviewer"]` works. A Tag with no Worker Host is refused because it could never run the work.
Bind it to a host first with `supertag update tag NAME --add-worker-host HOST`. See
[Staffing from the leadership Team](../reference/coordination.md#staffing-from-the-leadership-team).

Rules:

- Team membership does not grant tool permissions, credentials, or permission to send Mailbox
  messages.
- Subteams stay within their parent's membership and scaling limits. A Team below the leadership
  Team is the exception described above. Concurrency limits do not nest: each Team's limit counts
  only its own members' running work.
- Internal coordination takes the acting Tag from its active Task Attempt and never accepts a
  caller-supplied identity.

## If something goes wrong

- **An update fails with a revision conflict.** Read the Team again and retry with its current
  revision.
- **Dissolving fails.** Close unfinished Tasks and active subteams first.
- **`create_team` says the Team exceeds delegated membership.** The parent is an ordinary Team,
  and its members bound the new Team. An Objective owner should name its leadership Team as the
  parent instead.
- **Tasks stay queued while Worker Hosts have free slots.** The Team may have a concurrency limit.
  Check `supertag describe objective`, and remove the limit if nobody meant to throttle the Team.
- **`create_team` says a Tag has no bound Worker Host.** Bind the Tag to a host, or pick another
  Tag from `list_tags`.
- **A scaling update is rejected.** Existing active Teams already exceed the new ceiling; see
  [Team rules](../reference/coordination.md#scaling).
- **A lead cannot message another Team.** Mailbox grants are separate from membership; see
  [Tag messaging](tag-messaging.md).

## Next

- [Coordinate Tasks toward an Objective](objective-coordination.md)
- [Team rules](../reference/coordination.md#team-rules)
- [Task inputs and dependencies](../reference/coordination.md#task-inputs-and-dependencies)
- [Tag messaging](tag-messaging.md)
