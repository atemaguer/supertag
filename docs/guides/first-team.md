# Run your first Team

A **Tag** is a persistent AI identity with its own responsibilities and permissions. A **Team** is
a flat list of member Tags. An **Objective** is an outcome owned by one Tag; it works in
**Sessions**, threads of **Tasks** with one Task per turn. Use a Team when one Tag should own an
outcome and another should do part of the work.

This walkthrough adds a `builder` to the `lead` from the [quickstart](../../README.md#get-started).
The lead delegates a file to the builder, reviews what comes back, posts the result to the Team's
**Workstream** (its shared record of posts), and sends the builder a message.

## Before you start

Finish the quickstart and send your first message to `lead` in the terminal UI. From the
repository, run `supertag` to reopen that conversation. The quickstart creates `lead`, the
`local-tools` **Permission Set** (allowed file edits and commands), and a **Workspace** named
after your repository. A Workspace tells SuperTag where repository work belongs; this guide uses
`app`.

The **Control Plane** coordinates work. Your **Worker Host** supplies execution capacity through a
signed-in harness such as Codex or Claude Code. Check that both services are running:

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
  instructions: Do the work you are given, check the result, and report what changed.
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
Membership of a Team grants none of these. Give this builder only work you trust to run on the
selected host.

## 2. Create the Team

```sh
supertag create team first-team --member lead --member builder
supertag get team first-team
```

```text
team/first-team created.
```

The Team is a flat list: both Tags are members, and neither leads. Members may message each other
and share one Workstream.

## 3. Create the Objective

Use the CLI here to set the Workspace explicitly.

```sh
supertag create objective team-greeting --owner lead --team first-team --workspace app \
  --outcome 'Create TEAM-HELLO.md containing exactly: Hello from the team. Have builder write the file; review what it reports. Done when you have checked the delivered file, posted a one-line summary to the Workstream, and sent builder a message saying the file was accepted. Change no other files; do not push.'
```

```text
objective/team-greeting created
Started lead with Task 6c2b48d0-9e13-4a77-b5f2-80ad1e6c4932.
Follow it: supertag watch objective team-greeting
See results: supertag describe objective team-greeting
```

Creating the Objective starts it. The lead takes its first turn in the Objective's own
conversation, starts a Session of `builder` for the file, and gets a turn back there when that
Session reports. Use new Objective and Team IDs if these already exist.

## 4. Follow the work

In another terminal, run `supertag` from your repository and select `team-greeting` under
**Objectives** to follow its Sessions and see what needs your attention. The CLI also shows
progress and results.

```sh
supertag watch objective team-greeting
supertag describe objective team-greeting
```

`describe` lists the Objective's conversation and the Session beneath it under **Work**:

```text
Work: 2 Sessions
  completed  lead     Objective conversation      (Task 6c2b48d0-9e13-4a77-b5f2-80ad1e6c4932)
  completed  builder  Write TEAM-HELLO.md         (Task 4c71…)
```

Under **Delivered**, copy the builder's branch name and the checkout path printed beside it. Each
Session commits to its own branch, so the change stays there until you choose to integrate it. You
are still in `~/supertag-first-team`, which is not a git checkout, so inspect the file with
`git -C`, replacing `APP_CHECKOUT` and `BUILDER_BRANCH`:

```sh
git -C APP_CHECKOUT show BUILDER_BRANCH:TEAM-HELLO.md
```

It should contain `Hello from the team.`

## 5. Check the post and the message

```sh
supertag list workstream-post --team first-team --limit 10
supertag list message --mailbox builder --limit 10
```

The first command shows the lead's one-line summary in the Team's Workstream, which every member
can read. The second shows the lead's message to `builder`, `pending` until the builder's inbox
takes it and `handled` afterwards.

In the terminal UI, open **Waiting on you** to answer a question from the lead. Your answer
becomes its next turn. If no builder Session starts, check `supertag describe tag builder` for the host
binding, then use [first-reply troubleshooting](troubleshooting.md). A provider error needs a
working harness sign-in before the Team can finish.

## Stop or continue

```sh
supertag down
```

This stops your local services. `supertag up` starts them again. To stop unfinished work as well,
run `supertag cancel objective team-greeting` before shutting down.

Next, [connect Slack or another collaboration surface](../surfaces/README.md), or read
[Organize Tags into Teams](teams.md) and
[Define and complete an Objective](objectives.md).
