# Run your first Team

A **Tag** is a persistent AI identity with its own responsibilities and permissions. A **Team** is a
group of Tags led by one Tag. Use a Team when one Tag should implement a change and another should
inspect the result. An **Objective** is the outcome they work toward; a **Task** is one assignment
within it.

This walkthrough adds a `builder` to the `lead` from the [quickstart](../../README.md#get-started).
The builder writes a greeting file, and the lead checks it before accepting the Task.

## Before you start

Finish the quickstart in a git repository with at least one commit. It creates `lead`, the
`local-tools` **Permission Set** (allowed file edits and commands), and a **Workspace** named
after your repository. A Workspace tells SuperTag where repository work belongs; this guide
uses `app`.

The **Control Plane** coordinates work. Your **Worker Host** supplies execution capacity through
a signed-in harness such as Codex or Claude Code. Check that both services are running:

```sh
supertag up
supertag ps
supertag list worker-host
```

Use the connected Worker Host's name below instead of `YOUR_HOST`. Both Tags can use this one
host. They are separate actors even when they use the same harness and machine.

## 1. Add the builder

Keep this walkthrough's input files outside the repository, so the Objective can change only
`TEAM-HELLO.md` there. Create a separate directory and work from it:

```sh
mkdir -p ~/supertag-first-team
cd ~/supertag-first-team
```

A **Role** supplies instructions and permissions for a Tag. Save this as `builder.yaml` in
`~/supertag-first-team`:

```yaml
apiVersion: supertag/v1
kind: Role
metadata:
  name: Builder
spec:
  purpose: Implement small, verifiable repository changes.
  instructions: Complete the assigned Task, check the result, and report what changed.
  permissionSets: [local-tools]
---
apiVersion: supertag/v1
kind: Tag
metadata:
  name: builder
spec:
  roles: [Builder]
```

Apply the manifest and bind the builder to your connected host:

```sh
supertag apply -f builder.yaml
supertag update tag builder --add-worker-host YOUR_HOST
supertag describe tag builder
```

The Role grants the same local file-editing and command permissions that `init` gave `lead`.
Team membership alone does not grant these permissions. Give this builder only work you trust
to run on the selected host.

## 2. Create the Objective and Team

Create the Objective without starting it, so you can form its Team first:

```sh
supertag create objective team-greeting --owner lead --workspace app --no-start \
  --outcome 'Use Team first-team. Assign builder a Task to create TEAM-HELLO.md containing exactly: Hello from the team. Done when you have inspected the delivered file and accepted the builder Task. Change no other files; do not push.'
supertag create team first-team --objective team-greeting \
  --name 'First team' --lead lead --member builder
supertag list team --objective team-greeting
```

Use new Objective and Team IDs if these already exist. Keep the Team ID in the outcome in sync.
The Team command prints:

```text
team/first-team created.
```

The list command shows:

```text
ID          NAME        STATUS  LEAD  OBJECTIVE
first-team  First team  active  lead  team-greeting
```

The Team has a lead and one other member. The host's capacity controls how many Tasks can run
at once; this example does not need a second machine.

## 3. Start the lead

```sh
supertag start objective team-greeting
supertag watch objective team-greeting
```

Starting creates the lead's coordination Task. The lead assigns a Task to `builder`, waits for
its result, and checks the delivered file. Each Task has its own git worktree. The builder's
change stays on its delivered branch until you choose to integrate it.

## 4. Check the work

```sh
supertag describe objective team-greeting
supertag list team --objective team-greeting
```

Check that **Tasks** includes a Task assigned to `builder` and that the lead accepted it.
Under **Delivered**, copy the builder's branch name and review command. Inspect the file on
that branch, replacing `BUILDER_BRANCH` below:

```sh
git show BUILDER_BRANCH:TEAM-HELLO.md
```

It should contain `Hello from the team.`. An accepted Task means its reviewer accepted the
result; it does not merge the branch into your checkout.

**Needs you** lists any decision the lead requires. Answer through
`supertag message objective team-greeting 'YOUR ANSWER'`. If no builder Task starts, inspect
`supertag describe tag builder` for the host binding, then use
[first-reply troubleshooting](troubleshooting.md). A provider error needs a working harness
sign-in before the Team can finish.

## Stop or continue

```sh
supertag down
```

This stops your local services. `supertag up` starts them again. To stop unfinished work as well,
run `supertag cancel objective team-greeting` before shutting down.

Next, [connect Slack or another collaboration surface](../surfaces/README.md), or learn how to
[organize larger Teams](teams.md) and [coordinate Tasks toward an Objective](objective-coordination.md).
