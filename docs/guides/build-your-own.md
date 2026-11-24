# Build your own support assistant

Build a support assistant for your team's Slack from configuration alone. You write no code.
It is a **Tag**, a persistent AI actor with its own identity, responsibilities, permissions, and
work history. SuperTag runs it on a coding agent you already use, such as Claude Code. See the
[glossary](../reference/glossary.md) for other terms.

## What you'll build

A Tag named `support` that:

- answers questions in one Slack channel from your documentation, and cites the file it used;
- drafts an issue when a question reveals a real bug, or opens it after a person approves;
- remembers each customer's plan, open problems, and what it told them;
- checks every weekday morning for questions it didn't fully answer;
- triages ticket reports that your own systems send it.

The whole assistant is one manifest file and two commands that connect Slack. Each part of the
manifest answers one question:

| Question | Resource |
| --- | --- |
| Who is it? | A **Tag** with a name, a harness, a Workspace, and memory |
| How does it work? | A **Role**, which holds its instructions |
| What may it do? | A **Permission Set**, a list of allowed actions |
| When does it act? | A Slack mention, a **Schedule**, and an ongoing **Objective** that your systems send reports to |
| Where do people reach it? | A Slack channel, through a Tag location |

## Before you start

- SuperTag running on your machine from `supertag init`. See
  [Installation](../operations/install.md).
- Claude Code signed in on that machine. Codex, Cursor, and OpenCode work for every step except
  [opening issues itself](#optional-let-it-open-github-issues).
- Your documentation in a git repository on that machine, with at least one commit. This guide
  uses `~/code/docs` on branch `main`.
- Permission to create and install a Slack app, and a public channel for the assistant.

Add the documentation repository as a **Workspace**, a named repository that a Tag's Tasks work
in:

```sh
supertag workspace add ~/code/docs
supertag get workspace
```

The Workspace is named after the folder, here `docs`. The Tag reads your documentation there.
Each **Task**, one turn of the Tag's work, gets its own checkout, so your copy stays untouched.

## 1. Write the Role

A **Role** describes how a Tag works and what it may do: its purpose, its instructions, and its
Permission Sets. Create an empty directory for the assistant's configuration, outside the
documentation repository, and save this as `support.yaml`:

```yaml
apiVersion: supertag/v1
kind: Role
metadata:
  name: support
spec:
  displayName: Support
  purpose: Answer questions about our service for the people in the support channel.
  instructions: >-
    Answer from the documentation in your Workspace, and cite the file you used. If the docs
    don't cover a question, say so and don't guess. When a question reveals a real bug, reply
    with a draft issue: a title, the steps to reproduce, what was expected, and what happened.
    Remember each customer: keep a memory per customer with their plan, their open problems,
    and what you told them, and check it before you answer. Never put secrets or credentials
    in memory.
  permissionSets: [support-access]
  execution: { harness: claude-code }
```

`metadata.name` is the Role's ID. IDs are lowercase letters, digits, and `-`; see
[Resource IDs](../reference/resource-model.md#resource-ids). `execution.harness` picks the
coding agent. A Tag keeps the harness it was created with, so choose it now.

**Check:** nothing to check yet. You apply the whole file in step 3.

## 2. Write the Permission Set

A **Permission Set** lists the actions a Tag may take. Anything it doesn't list is denied.
Append it to `support.yaml`:

```yaml
---
apiVersion: supertag/v1
kind: PermissionSet
metadata:
  name: support-access
spec:
  permissions:
    - { target: runtime, action: files:read }
    - { target: runtime, action: schedule:create }
```

| Action | Lets the Tag |
| --- | --- |
| `files:read` | Read the documentation in its Workspace |
| `schedule:create` | Set its own follow-ups, such as "check this again tomorrow" |

The assistant can't edit files, run commands, or read the web. It needs no command sandbox, so
it runs on any Worker Host with Claude Code. Add `{ target: runtime, action: web:fetch }` if it
should also read your public docs site. Web pages can carry instructions, so leave it out for a
Tag that handles secrets.

**Check:** nothing to check yet. You apply the whole file in step 3.

## 3. Create the Tag

Append the Tag:

```yaml
---
apiVersion: supertag/v1
kind: Tag
metadata:
  name: support
spec:
  displayName: Support
  roles: [support]
  workspace: { id: docs, ref: main }
```

`workspace` binds the Tag to the `docs` Workspace. `ref: main` starts each new **Session**, one
thread of the Tag's work, from the commit `main` names at that time. So the assistant reads
current docs in new threads. A new Tag keeps **Memory** by default: its harness's own memory,
which the Worker Host keeps, plus a daily review that corrects it. See
[Memory](../reference/coordination.md#memory).

Preview and apply the file:

```sh
supertag diff -f support.yaml
supertag apply -f support.yaml
```

**Check:** `supertag describe tag support` shows `Harness: claude-code` under `Execution`, the
`docs` Workspace, `Memory: true`, and `files:read` and `schedule:create` under `Permissions`.
Each permission says it comes from `Role/support via PermissionSet/support-access`.

Say hello from the terminal before you connect Slack:

```sh
supertag message support "Which page explains how to rotate an API key?"
```

The Tag answers with a page from your documentation.

## 4. Connect it to a Slack channel

Create the Slack app and enroll it as a **Surface Account**, the connected Slack workspace. Follow
steps 1 and 2 of [Connect Slack](../surfaces/slack.md):

```sh
supertag setup surface slack
```

Invite the app to the support channel, and copy the channel's ID from the **About** tab. Then
add the channel as the Tag's location, where it answers:

```sh
supertag tag update support --add-location slack --channel-id C0123456789
```

The local **Gateway**, the service that carries Slack traffic, serves one Slack location. If
another Tag, such as `lead`, already answers in Slack, remove its location first with
`supertag tag update lead --remove-location slack`. Add `--allowed-user U0123456789`, repeated,
to limit who may ask the assistant for work. The people you allow can also teach it what to
remember.

**Check:** mention the app in the channel with a question. The assistant posts "Got it", then
replaces it with an answer in the thread. Replies in that thread continue the same Session
without another mention. `supertag get surface-location` lists the new location.

### How it remembers customers

Each Slack thread is its own Session. Every thread in the channel shares one memory store, so
what the assistant learns about Acme in one thread is there in the next. It can also search its
earlier threads with its Session tools. Memory is kept per harness, on the Worker Host that ran
the turn. A Tag whose next turn runs on another host starts from that host's copy, unless the Tag
names a Volume. Everyone in the channel shares this memory, so keep one channel per trust
boundary.

To see what it keeps, run `supertag get memories --tag support` on the machine that runs it. To
correct it, tell it in the thread: "Acme moved to the Enterprise plan" or "forget that". See
[Reading and deleting memory](../reference/coordination.md#reading-and-deleting-memory).

## 5. Add the morning check

A **Schedule** wakes a Tag later with a note that says what to do. Append a recurring one to
`support.yaml`, and set `timeZone` to yours:

```yaml
---
apiVersion: supertag/v1
kind: Schedule
metadata:
  name: support-morning-check
spec:
  tag: support
  every: "0 9 * * MON-FRI"
  timeZone: Europe/Berlin
  note: >-
    Morning check. Read your shared Sessions from the last day, including your support channel
    threads and the support-tickets Objective. List every question you didn't fully answer and
    every follow-up you promised, oldest first, with a link or Session ID for each. If there is
    none, stay quiet.
```

```sh
supertag apply -f support.yaml
```

A declared Schedule fires in your own conversation with the Tag. The report appears in the
desktop app, the terminal app, and `supertag message support`, not in Slack. On a morning with
nothing to report, the Tag posts nothing. That turn uses your conversation's memory store, not the
channel's, but it reads the channel's threads.

To get the report in Slack instead, ask in a channel thread: "@Support every weekday at 9:00,
list the questions here you didn't fully answer." The Tag sets the Schedule itself with
`schedule:create`, and the report arrives in that thread. That Schedule lives in Slack, not in
your file.

**Check:** `supertag describe schedule support-morning-check` shows the cron expression, the time
zone, and `Next due at`. After the first morning, it shows a `Fire count` of 1, and
`supertag describe task` on the latest Task shows the run.

## 6. Send it events from your own systems

The assistant reads only what reaches it. SuperTag doesn't poll your ticket system. A script, a
cron job, or a webhook relay in your own systems decides when a ticket needs attention and sends
a report. Give those reports a home: an ongoing **Objective**, an outcome a Tag owns, with a
budget. Append it to `support.yaml`:

```yaml
---
apiVersion: supertag/v1
kind: Objective
metadata:
  name: support-tickets
spec:
  ownerTagId: support
  outcome: >-
    Triage every ticket report that arrives in this conversation. For each one, find the answer
    in the documentation or draft an issue for a real bug, and keep the customer's history
    current in memory. Handle the oldest unanswered report first. If blocked, stop and say what
    you tried and what would unlock it.
  ongoing: true
  budgetLimitMinor: 20000
  budgetCurrency: USD
```

`ongoing: true` makes it a responsibility only an operator ends. With nothing to do, it rests
until the next report. `budgetLimitMinor` caps its spend, here USD 200.00. Apply the file again.
Applying creates the Objective and starts its first turn:

```sh
supertag apply -f support.yaml
supertag get objective support-tickets
```

Note the `session_id`: that is the Objective's conversation. Your system sends each report there
as the Tag's next turn. Give each report an `--operation-id` built from its ticket number. A
retry with the same ID then never sends the report twice:

```sh
supertag task submit --tag support --session SESSION_ID --operation-id ticket-4812 \
  "Ticket 4812 from Acme: no reply for 26 hours. Subject: webhook retries stop after one attempt."
```

A script on another machine sends the same call to a shared Control Plane with
`--gateway URL` and an **Operator Token**, a named credential of its own, in
`SUPERTAG_OPERATOR_TOKEN`. Create the token with `supertag operator-token create ticket-relay`.
Its changes appear under that name in `supertag audit`. An application can call the
[Control Plane API](../reference/control-plane-api.md) directly instead: `Conversations.SendMessage`
with the Tag, the Objective's `session_id`, the report, and the same `operation_id`. See
[Deliver evidence to the Objective](ongoing-responsibilities.md#2-deliver-evidence-to-the-objective).

The Objective's conversation is shared, like a Slack thread, so it uses the channel's memory
store. Its replies stay in SuperTag; they don't post to Slack.

**Check:** `supertag describe objective support-tickets` shows `working` and lists your report
under **Objective conversation**. `supertag watch objective support-tickets` shows the turn
starting within seconds when a Worker Host is free.

## Optional: let it open GitHub issues

By default the assistant drafts issues in its reply, and a person files them. It can open them
itself today, with three limits:

- Only Claude Code Tasks get tools from a Worker Host's MCP catalog.
- `supertag.yaml` has no setting for an MCP catalog. Run a second Worker Host with
  `supertag worklet --mcp-catalog`. That host must also map the `docs` Workspace
  (`--workspace-id docs --workspace-source ~/code/docs`). See
  [Run a host without supertag.yaml](workers.md#run-a-host-without-supertagyaml) and
  [MCP tools](../surfaces/worker-tools.md).
- The `github` preset maps no repository for GitHub's `issue_write` tool. A grant for it can't
  name a repository, so restrict the GitHub token to the repositories the assistant may touch.

Grant it in its own Permission Set, and make every call wait for a person:

```yaml
---
apiVersion: supertag/v1
kind: PermissionSet
metadata:
  name: support-issues
spec:
  permissions:
    - { target: mcp, action: github/issue_read, resource: "repository:acme/service" }
    - { target: mcp, action: github/issue_write, approvalRequired: true }
```

Add `support-issues` to the Role's `permissionSets` only after that host runs. A Task whose
grants name a server that no bound Worker Host provides waits, so adding it early stops every
answer. `issue_write` also updates issues, and the approval covers each call.

**Check:** ask in the channel for an issue. `supertag get approval` lists the request with the
exact arguments. `supertag approval approve ID` lets that one call run.

## What SuperTag does for you

You wrote a file. SuperTag supplies the rest:

- **It keeps running.** Each mention, Schedule, and report becomes a queued Task. A Worker Host
  claims it when free. An interrupted Task runs again, within retry limits.
- **It remembers.** Each thread keeps its history, and the Tag's memory carries over between
  threads. A daily review corrects that memory against what happened.
- **It enforces limits.** Every Task runs with the Permission Sets in force when it was accepted.
  Gated calls wait for a recorded decision, and the Objective's budget caps its spend.
- **It records every action.** `supertag describe task ID` shows what a turn did, and
  `supertag audit` shows who changed the configuration.
- **It works with others.** Put `support` in a **Team**, a flat list of Tags, with your `lead`
  Tag. It can then message `lead` from a Slack thread, for example to hand over an outage. See
  [Organize Tags into Teams](teams.md).

## Going further

- **Your own interface.** Your application can create Tags, send work, and follow progress
  through the [Control Plane API](../reference/control-plane-api.md). Generated Go, TypeScript,
  and Python bindings live in [`sdks/`](../../sdks/README.md).
- **SDKs.** The TypeScript SDK is `supertag-ai` on npm, and the Python SDK is `supertag` on PyPI.
  See [API stability](../reference/api-stability.md).
- **Another agent system.** Write a harness adapter to run your own agent underneath a Tag. See
  [Write a harness adapter](harness-adapters.md).
- **Another chat tool.** Implement a Connector. See the
  [Connector contract](../reference/connector-contract.md).
- **More of the configuration.** Context Sets add Skills and knowledge; see
  [Configure Tags](../../skills/configure-tags/SKILL.md) and
  [Manage Control Plane resources](../operations/resources.md).

## Troubleshooting

- **The Tag never answers.** Run `supertag placement explain TASK_ID`. `No Worker Host is bound`
  or a missing `workspace:docs` label means no running host maps the `docs` Workspace. Run
  `supertag workspace add ~/code/docs` on the host, then `supertag up`.
- **A Task waits for an MCP server.** `describe task` says `No bound Worker Host provides MCP server
  github`. Remove `support-issues` from the Role, or start the host that serves it.
- **Slack shows nothing.** Follow [the first-reply checklist](troubleshooting.md). Check that the
  app is in the channel and that `supertag get surface-location` lists it for `support`.
- **Adding the Slack location fails.** Another Tag holds the Gateway's Slack location. Remove it
  with `supertag tag update TAG --remove-location slack`.
- **It answers without your docs.** Check the Workspace and its branch in
  `supertag describe tag support`. A thread keeps the commit it started on. Start a new thread
  after you update the docs.
- **The morning report never arrives.** `supertag describe schedule support-morning-check` shows
  `Missed count` and the latest Task. A quiet morning posts nothing.
- **The Objective stopped.** `limited` means its budget is spent. Raise it with
  `supertag objective set-limits support-tickets --budget-minor AMOUNT`.
- **Apply refuses a change to the Objective.** `ownerTagId`, `outcome`, and `ongoing` are fixed.
  Create a new Objective under a new name instead.

## Next

- [Connect Slack](../surfaces/slack.md)
- [Maintain an ongoing responsibility](ongoing-responsibilities.md)
- [Talk to a Tag from your terminal](talk-to-a-tag.md)
- [Resource model](../reference/resource-model.md)
