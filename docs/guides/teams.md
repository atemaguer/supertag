# Organize Tags into Teams

A **Tag** is a persistent AI actor with its own responsibilities and permissions. A **Team** is
a flat list of member Tags with an optional limit on how much work runs at once. An **Objective**
is an outcome owned by a Tag, worked on in **Sessions**: threads of **Tasks**, one Task per turn.
The **Control Plane** is the SuperTag service that stores and runs this work. See the
[glossary](../reference/glossary.md) for other terms.

A Team answers three questions:

- Which Tags may an Objective's owner hand work to.
- Which Tags may message each other without a grant.
- Who shares the **Workstream**, the Team's record of posts.

Together, your Teams of Tags make up an **autonomous organization**: Teams may pursue different
Objectives but share one Control Plane, its rules, and its record of the work. A **Role**
describes an enduring responsibility held by a Tag; membership of a Team is separate and grants
no permissions. Local subagents that an agent system creates inside one execution are not members.

## Before you start

- The `supertag` CLI configured with operator access to the Control Plane. Creating a Team is an
  operator action; Tags do not create Teams.
- Active Tags for the members, each bound to a **Worker Host**: a machine or sandbox that runs
  work.

## 1. Create a Team

This example moves 12 production services from shared API keys to short-lived credentials
issued to each service. Configure each member's access separately. Give `identity` access to
the trust policy repository and `migration` access to the service repositories. Give
`verification` read-only access to test results and telemetry, and `rollout` access to the
staging tools it uses to rehearse cutovers and rollbacks.

```sh
supertag team create service-identity --member lead --member identity --member migration \
  --member verification --member rollout
supertag get team
supertag get team service-identity
```

```text
team/service-identity created.
```

A Team has a name, its members, and an optional concurrency limit. There is no lead, no hierarchy,
and no Objective of its own: several Objectives can name the same Team.

## 2. Change the membership

`--member` replaces the whole member list, so pass every member you want to keep:

```sh
supertag team update service-identity --member lead --member identity --member migration \
  --member verification --member rollout --member observability
```

The CLI reads the Team's current revision for you and retries once after an unrelated change.
Pass `--revision N` to fail on any concurrent change instead. A stale revision still succeeds,
without a change, when the Team already has the values you set.

## 3. Name the Team on an Objective

```sh
supertag objective create service-identity-migration \
  "Move 12 production services to short-lived credentials issued to each service. Keep requests working through each rollout wave. Done when service checks pass and the old keys are retired. Ask me to approve each production cutover and retirement of the shared keys." \
  --owner lead --team service-identity --state-directory ~/.supertag
```

`lead` owns the Objective and starts work Sessions with the other Tags for each wave. Each
Tag runs under its own Roles, narrowed to the Objective's runtime actions, and draws on the
Objective's budget. A Tag must be active and bound to a Worker Host to take delegated work.
The operator approves production cutovers and retirement of the shared keys.

A **Workspace** tells SuperTag where repository work belongs. Add `--workspace NAME` for each
Workspace the Objective needs.

An Objective manifest can declare the Team instead of naming an existing one:

```yaml
apiVersion: supertag/v1
kind: Objective
metadata:
  name: service-identity-migration
spec:
  owner: lead
  outcome: >-
    Move 12 production services to short-lived credentials issued to each service.
    Keep requests working through each rollout wave.
    Done when service checks pass and the old keys are retired.
    Ask me to approve each production cutover and retirement of the shared keys.
  team:
    name: Service identity
    members: [lead, identity, migration, verification, rollout]
    maxConcurrency: 2
```

The declared Team's ID is the Objective's ID. `spec.team` may also be the name of an existing
Team. Which Team an Objective names is fixed once it exists; a declared Team's name, members, and
`maxConcurrency` change in place when you apply the file again. See
[Declare Objectives](../operations/resources.md#declare-objectives).

## 4. Delete the Team

```sh
supertag delete team service-identity
```

Deletion is refused while an open Objective names the Team. Cancel or complete those Objectives
first.

Verify the deletion with `supertag get team`.

## Throttle a Team on purpose

By default a Team has no concurrency limit, so its members start work as soon as a Worker Host has
a free slot. Set a limit only when you want fewer turns running at once, for example to protect a
rate-limited service:

```sh
supertag team update service-identity --max-concurrency 2
```

The limit counts turns across every open Objective that names the Team; later turns wait, and a
waiting turn holds no slot. Remove it again with an empty value, so Worker Host capacity is the
only limit:

```sh
supertag team update service-identity --max-concurrency ""
```

Use `supertag describe objective service-identity-migration` to see the Team's limit or confirm
that only Worker Host capacity limits the number of turns.

## Messaging inside and outside the Team

Two Tags in the same Team may send each other messages with no further configuration: a message
arrives in the recipient's inbox and it handles it in a turn of its own. To let a Tag accept
messages from a Tag outside its Teams, grant the route explicitly:

```sh
supertag mailbox-grant allow on-call rollout
supertag get mailbox-grant --tag rollout
```

A grant says only "this recipient accepts messages from this sender". It is directional, and it
grants no execution authority. See [Send messages between Tags](tag-messaging.md).

Every member also shares the Team's Workstream: a post is a note every member can read, and a post
addressed to Tags reaches their inboxes. See [Share a Team's Workstream](workstreams.md).

## If something goes wrong

- **An update fails with a revision conflict.** Read the Team again and retry with its current
  revision.
- **Deletion is refused.** An open Objective names the Team. `supertag get objective` shows
  which Objectives are still open.
- **The owner cannot hand work to a Tag.** It must be a member of the Objective's Team, active,
  and runnable by a Worker Host. `supertag placement explain TASK_ID` says why its Task waits.
- **Turns stay pending while Worker Hosts have free slots.** The Team may have a concurrency
  limit, counted across every Objective that names it. Check
  `supertag describe objective ID`, and remove the limit if nobody meant to throttle the Team.
- **A Tag cannot message another Tag.** They share no Team and there is no grant; see
  [Send messages between Tags](tag-messaging.md).

## Next

- [Define and complete an Objective](objectives.md)
- [Share a Team's Workstream](workstreams.md)
- [Send messages between Tags](tag-messaging.md)
- [Team rules](../reference/coordination.md#teams)
