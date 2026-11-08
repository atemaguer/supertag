# Organize Tags into Teams

A **Tag** is a persistent AI identity with its own responsibilities and permissions. A **Team** is
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

```sh
supertag create team metering --member backend --member frontend --member qa
supertag list team
supertag get team metering
```

```text
team/metering created.
```

A Team has a name, its members, and an optional concurrency limit. There is no lead, no hierarchy,
and no Objective of its own: several Objectives can name the same Team.

## 2. Change the membership

`--member` replaces the whole member list, so pass every member you want to keep:

```sh
supertag update team metering --member backend --member frontend --member qa --member docs
```

The CLI reads the Team's current revision for you and retries once after an unrelated change.
Pass `--revision N` to fail on any concurrent change instead.

## 3. Name the Team on an Objective

```sh
supertag create objective usage-billing --owner lead --team metering \
  --outcome "Customers are billed for metered usage. Done when the billing reconciliation suite passes."
```

The owner may now start a Session of `backend`, `frontend`, `qa`, or `docs` to do part of the
work. That Tag runs under its own Roles, narrowed to the Objective's runtime actions, and draws on
the Objective's budget. A Tag that is inactive or has no bound Worker Host is refused, because its
work could never run.

An Objective manifest can declare the Team instead of naming an existing one:

```yaml
apiVersion: supertag/v1
kind: Objective
metadata:
  name: usage-billing
spec:
  owner: lead
  outcome: Customers are billed for metered usage. Done when the reconciliation suite passes.
  team:
    name: Metering
    members: [backend, frontend, qa]
    maxConcurrency: 2
```

The declared Team's ID is the Objective's ID. `spec.team` may also be the name of an existing
Team. Which Team an Objective names is fixed once it exists; a declared Team's name, members, and
`maxConcurrency` change in place when you apply the file again. See
[Declare Objectives](../operations/resources.md#declare-objectives).

## 4. Delete the Team

```sh
supertag delete team metering
```

Deletion is refused while an open Objective names the Team. Cancel or complete those Objectives
first.

**Check:** `supertag list team` no longer lists `metering`.

## Throttle a Team on purpose

By default a Team has no concurrency limit, so its members start work as soon as a Worker Host has
a free slot. Set a limit only when you want fewer turns running at once, for example to protect a
rate-limited service:

```sh
supertag update team metering --max-concurrency 2
```

The limit counts turns across every open Objective that names the Team; later turns wait, and a
waiting turn holds no slot. Remove it again with an empty value, so Worker Host capacity is the
only limit:

```sh
supertag update team metering --max-concurrency ""
```

**Check:** `supertag describe objective usage-billing` shows
`Team Metering: at most 2 turns at once across its Objectives`, or
`turns limited only by Worker Host capacity` without a limit.

## Messaging inside and outside the Team

Two Tags in the same Team may send each other messages with no further configuration: a message
arrives in the recipient's inbox and it handles it in a turn of its own. To let a Tag accept
messages from a Tag outside its Teams, grant the route explicitly:

```sh
supertag grant mailbox backend --sender support
supertag list mailbox-grant --mailbox backend
```

A grant says only "this recipient accepts messages from this sender". It is directional, and it
grants no execution authority. See [Send messages between Tags](tag-messaging.md).

Every member also shares the Team's Workstream: a post is a note every member can read, and a post
addressed to Tags reaches their inboxes. See [Share a Team's Workstream](workstreams.md).

## If something goes wrong

- **An update fails with a revision conflict.** Read the Team again and retry with its current
  revision.
- **Deletion is refused.** An open Objective names the Team. `supertag list objective` shows
  which Objectives are still open.
- **The owner cannot hand work to a Tag.** It must be a member of the Objective's Team, active,
  and bound to a Worker Host. Bind it with
  `supertag update tag NAME --add-worker-host HOST`.
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
