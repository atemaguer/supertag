# Run your first Team

A **Tag** is a persistent, proactive, multiplayer AI actor with its own identity, responsibilities, permissions, and work history. A **Team** is
a flat list of member Tags. An **Objective** is an outcome owned by one Tag; it works in
**Sessions**, threads of **Tasks** with one Task per turn. Use a Team when one Tag should own an
outcome and another should do part of the work.

This walkthrough adds a `builder` to the `lead` from the [quickstart](../../README.md#get-started).
The lead's Objective asks the lead's own inbox for help, the lead messages the builder, the
builder writes a file in a turn of its own, and the lead posts the result to the Team's
**Workstream** (its shared record of posts). An Objective's turns never message other Tags
themselves: only a Tag's inbox does.

## Before you start

Finish the quickstart and send your first message to `lead` with `supertag message`. The quickstart creates `lead`, the
`local-tools` **Permission Set** (allowed file reads and edits, Schedules the Tag sets for itself, and commands when the host can run them), and a **Workspace** named
after your repository: an entry under the host's `workspaces` in `supertag.yaml` that maps the name
to your checkout, with `lead` bound to it. Commands below use the local Control Plane, which they
find without a flag.

The **Control Plane** coordinates work. Your **Worker Host** supplies execution capacity: its **Worklet**
runs each Task on a signed-in harness such as Codex or Claude Code. Check that both services are running:

```sh
supertag up
supertag ps
supertag get host
```

A Worker Host in the same `supertag.yaml` as the local Control Plane runs every Tag, so both Tags
can use this one host. They are separate actors even when they use the same harness and machine.

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
  name: builder
spec:
  displayName: Builder
  purpose: Implement small, verifiable repository changes.
  instructions: Do the work you are given, check the result, and report what changed.
  permissionSets: [local-tools]
---
apiVersion: supertag/v1
kind: Tag
metadata:
  name: builder
spec:
  roles: [builder]
  workspace: { id: WORKSPACE, ref: main }
```

Replace `WORKSPACE` with the name `supertag get workspace` lists for your repository, and `main`
with its branch. Apply the manifest:

```sh
supertag apply -f builder.yaml
supertag describe tag builder
```

The Role grants the same local file-editing and command permissions that `init` gave `lead`.
Membership of a Team grants none of these. Give this builder only work you trust to run on the
selected host. The builder does its work in its own turns, so it needs its own Workspace
binding. `local-tools` also grants `web:fetch`, unless the
harness is Cursor or the host runs Tasks in local-vm containers: the builder can read web pages, and its commands can reach
the network. Current Codex models need it to run commands; see
[Codex commands and models](../operations/requirements.md#codex-commands-and-models).

## 2. Create the Team

```sh
supertag team create first-team --member lead --member builder
supertag get team first-team
```

The Team is a flat list: both Tags are members, and neither leads. Members may message each other
and share one Workstream.

## 3. Create the Objective

Create the Objective with the CLI, which names its ID:

```sh
supertag objective create team-greeting \
  'Create TEAM-HELLO.md containing exactly: Hello from the team. Ask builder, through your own inbox, to write the file; review what it reports. Done when you have checked the delivered file and a one-line summary is posted to the Workstream. Change no other files; do not push.' \
  --owner lead
```

It prints the Objective as JSON. Creating the Objective starts it. The lead takes its first turn
in the Objective's own conversation and asks its own Tag with `ask_tag`. The lead's inbox turn
messages `builder`. The builder takes the message in its inbox turn, writes the file, and answers
the lead. The lead's next inbox turn answers the Objective, posts the summary to the Workstream,
and the answer arrives as the Objective's next turn. Use new Objective and Team IDs if these
already exist.

## 4. Follow the work

Follow its Sessions and see what needs your attention from a shell:

```sh
supertag watch objective team-greeting
supertag describe objective team-greeting
```

`describe` lists the Objective's conversation under **Work**:

```text
Work: 1 Session
  succeeded  lead     Objective conversation  (3 Tasks, latest Task 6c2b48d0-9e13-4a77-b5f2-80ad1e6c4932)
```

The builder's turns run in its own inbox Session, `inbox:builder`. Read them with
`supertag get session inbox:builder`. Each Session's work arrives in your repository as its own
branch under `supertag/session/`, so the change stays there until you choose to integrate it. You
are still in `~/supertag-first-team`, which is not a git checkout, so inspect the file with
`git -C`, replacing `APP_CHECKOUT` with your repository and `BUILDER_BRANCH` with the builder's
branch from `git -C APP_CHECKOUT branch --list 'supertag/session/*'`:

```sh
git -C APP_CHECKOUT show BUILDER_BRANCH:TEAM-HELLO.md
```

It should contain `Hello from the team.`

## 5. Check the post and the message

```sh
supertag get workstream-post --team first-team
supertag get message --mailbox builder
```

The first command shows the lead's one-line summary in the Team's Workstream, which every member
can read. The second shows the lead's message to `builder`, with `state`
`TAG_MESSAGE_STATE_PENDING` until the builder's inbox takes it and `TAG_MESSAGE_STATE_HANDLED`
afterwards.

Once the file and the post check out, record the result:

```sh
printf '%s\n' "builder wrote TEAM-HELLO.md; lead posted the summary." | \
  supertag objective complete team-greeting --summary-file -
```

`supertag get inbox-item` lists the lead's questions; answer one with
`supertag question answer TASK_ID TEXT`. Your answer becomes its next turn. If the builder takes no turn, check `supertag placement explain TASK_ID`, then use [first-reply troubleshooting](troubleshooting.md). A provider error needs a
working harness sign-in before the Team can finish.

## Stop or continue

```sh
supertag down
```

This stops your local services. `supertag up` starts them again. To stop unfinished work as well,
run `supertag objective cancel team-greeting` before shutting down.

Next, [connect Slack or another collaboration surface](../surfaces/README.md), or read
[Organize Tags into Teams](teams.md) and
[Define and complete an Objective](objectives.md).
