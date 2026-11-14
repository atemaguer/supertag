# Roles

> **A Role describes an enduring responsibility a Tag holds in the organization.**

A **Tag** is a persistent AI actor with its own responsibilities and permissions. A **Role** is a
reusable description of how that actor should carry out an enduring responsibility. Other terms on
this page (see the [glossary](../reference/glossary.md)): a **Task** is one accepted assignment; a
**Mailbox** is the Tag's inbox for messages from other Tags; a **Team** is a flat list of member
Tags; an **Objective** is an outcome owned by a Tag; a **Worker Host** is the machine that
runs a Task. Together, your Teams of Tags make up an **autonomous organization**: Teams may
pursue different Objectives but share one Control Plane, its rules, and its record of the work.

A Role can include:

- a purpose and trusted instructions;
- **Context Sets** that add approved knowledge or reusable instruction packages called **Skills**; and
- **Permission Sets** that authorize collaboration surface and runtime actions.

A Role does not act on its own. It cannot own Tasks, receive mail, run an agent system, or belong to
a Team. The Tag still performs the work. Team membership places the Tag in the organization, and
each Task tells it what to do now.

All active Roles listed on a Tag apply to that Tag's work. Assign only responsibilities that can
coexist. SuperTag captures the applicable Role policy when it admits a Task, so later configuration
changes affect later Tasks without changing work already accepted.

## When to use a Tag or a Role

Create a **Tag** when you need a distinct actor with its own name, Mailbox, Task history, Team
membership, or accountability. Create a **Role** when you need a responsibility that can guide one
or more existing actors.

| Need | Use | Example |
| --- | --- | --- |
| Someone must own release work and receive messages about it | Tag | `release-manager` |
| Several actors should follow the same security review policy | Role | `Security Reviewer` |
| Research needs its own work, results, and Team placement, separate from engineering | Tag | `researcher` |
| Every Tag on a Team should document its work the same way | Role | `Documentation Steward` |

If a security reviewer must independently receive work, report progress, and be accountable
for approval, make it a Tag. If release and payments actors should each apply the same review rules
as part of their existing work, assign both Tags the `Security Reviewer` Role.

## Configure a Role

A Role manifest defines the reusable responsibility:

```yaml
apiVersion: supertag/v1
kind: Role
metadata:
  name: Security Reviewer
spec:
  purpose: Review changes that affect customer data.
  instructions: Require evidence and state unresolved risk.
  contextSets:
    - security-guidelines
  permissionSets:
    - engineering-read
```

A Tag manifest selects the Roles that guide that actor:

```yaml
apiVersion: supertag/v1
kind: Tag
metadata:
  name: release-manager
spec:
  roles:
    - Release Manager
    - Security Reviewer
```

Apply and inspect them with the normal commands:

```console
supertag apply -f security-reviewer.yaml
supertag apply -f release-manager.yaml
supertag describe tag release-manager
supertag get role "Security Reviewer"
```

A Role can also set the harness, models, and reasoning effort its Tags run with, such as Codex at
medium or high effort. A Tag's own settings override its Roles'. See
[execution settings](../reference/resource-model.md#execution-settings).

Apply the Tag manifest again whenever its Role list changes. Removing a Role from `Tag.spec.roles`
removes that responsibility from future Tasks. A Role's status shows which Tags use it, but you edit
the Tags to change that list.

## How a Role carries knowledge and permissions

Use a direct Context Set or Permission Set activation for knowledge or authority that applies only
at a particular location or situation. Put a set in a Role when it should follow an enduring
responsibility. A Role does not bypass normal authorization: the Task's origin, requester, approval
state, the Worker Host's harness sandbox, and provider-native access can still narrow what the Tag may do.

## Where to go next

- Return to [core concepts](README.md).
- Learn how [Context Sets and Permission Sets](context-and-permissions.md) carry knowledge and authority.
- Follow [Define and complete an Objective](../guides/objectives.md) to use Roles in a running organization.
