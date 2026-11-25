# Set up an autonomous engineering organization

Set up a small engineering organization of AI actors from two files. Each actor is a **Tag**: a
persistent, proactive, multiplayer AI actor with its own identity, responsibilities, permissions, and work history.
Twelve Tags fill four functions. A lead takes outcomes from you and splits them across a platform
team and a product team. Shared specialists review and verify their work. A reliability function
watches production, and a release manager prepares a release every week. You approve what merges
and what ships. See the [glossary](../reference/glossary.md) for other terms.

The files are in [`examples/engineering-org`](../../examples/engineering-org/). This guide walks
through them part by part, then gives the lead an outcome and follows it through the teams.

## What you'll build

```text
                         you (operator)
                               |
                         lead (Claude Code)
              .----------------+----------------------.
              |                                       |
      platform (Codex)                       product (Claude Code)
      platform-lead                          product-lead
      infra-builder                          web-builder   api-builder
              |                                       |
              '------ reviewer  security-reviewer  verifier ------'
                         (shared specialists)

      reliability: reliability (Codex), support (read-only)
      release:     release-manager, weekly
```

| Function | Tags | Coding agent | May |
| --- | --- | --- | --- |
| Engineering lead | `lead` | Claude Code, Opus | Edit files and run commands, to integrate |
| Platform | `platform-lead`, `infra-builder` | Codex, gpt-6-sol | Edit, run commands, read package registries |
| Product | `product-lead`, `web-builder`, `api-builder` | Claude Code, Sonnet | Edit and run commands |
| Review | `reviewer`, `security-reviewer` | Claude Code | Read files and run commands in a sandbox; no edits |
| Verification | `verifier` | Claude Code, Sonnet | Run the checks on its own host |
| Reliability | `reliability`, `support` | Codex; Claude Code | `reliability` edits and reads Sentry and GitHub; `support` only reads |
| Release | `release-manager` | Claude Code, Sonnet | Prepare a release branch; you ship it |

Each part of the example answers one question:

| Question | Resource |
| --- | --- |
| How does each function work? | A **Role** per function, with instructions, models, and efforts |
| What may it do? | A **Permission Set** per function, a list of allowed actions |
| Who talks to whom? | A **Team** per team, and grants between the leads |
| What does it own? | **Objectives**: an outcome for the lead, ongoing responsibilities for reliability |
| When does it act on its own? | A **Schedule** for the weekly release, and reports your systems send |

## Before you start

- SuperTag installed and running from `supertag init`. See [Installation](../operations/install.md).
- Claude Code and Codex signed in on the machines that run the Tags.
- Your repository in git on that machine, with at least one commit. This guide uses `~/code/app`
  on branch `main`.
- Copy `examples/engineering-org` into your repository as `supertag/`. In both files, replace
  `app` with your Workspace name, `main` with the branch new Sessions start from, and `acme/app`
  with your repository.

A **Worker Host** is a machine that runs Tags' work. The example places each function on its own
host service, chosen by label. Add the five host services from the header of
`organization.yaml` to `~/.supertag/supertag.yaml`, then restart:

```sh
supertag up
supertag get host
```

| Host service | Label | Runs |
| --- | --- | --- |
| `product-host` | `product` | `lead`, the product team, `release-manager` |
| `platform-host` | `platform` | The platform team, on Codex |
| `review-host` | `review` | `reviewer`, `security-reviewer`, `support`, with sandboxed commands |
| `verify-host` | `verify` | `verifier`, so long test runs take no one else's slot |
| `reliability-host` | `reliability` | `reliability`, with the Sentry and GitHub tokens it reads with |

The five can share one machine. All map the same clone of `app`, so each Tag sees the others'
branches. A Tag's `runsOn` names the label its host must carry; see
[Keep a Tag's Tasks on the right hosts](workers.md#keep-a-tags-tasks-on-the-right-hosts).

## 1. Give each function a Role and a Permission Set

A **Role** describes how a Tag works and what it may do. The example has one Role per function:
`engineering-lead`, `team-lead`, `builder`, `reviewer`, `security-reviewer`, `verifier`,
`reliability-owner`, `support-triage`, and `release-manager`. Each holds the function's
instructions and standards, its allowed models and efforts, and its Permission Sets. For example:

```yaml
apiVersion: supertag/v1
kind: Role
metadata: { name: reviewer }
spec:
  displayName: Reviewer
  purpose: Review changes from either team for correctness, test coverage, and whether both sides of a contract agree.
  instructions: >-
    Read the diff against its base with git, and run the affected tests. ...
  permissionSets: [review-tools]
  execution: { harness: claude-code, models: [claude-opus-5-5], efforts: [medium, high] }
```

`metadata.name` is the ID, a lowercase DNS label, and `displayName` is the name people see. In
`execution`, the first model and effort are the defaults.

Two more Roles hold what a team shares: `platform-engineering` and `product-engineering`. Each
names the team's area of the repository and its coding agent. A team lead holds `team-lead` and
its team's Role; a builder holds `builder` and its team's Role. The function Role sets the
efforts, and the team Role sets the harness and models. Two Roles on one Tag may not set one
execution field to different values, so this split keeps them from conflicting.

A **Permission Set** lists the actions a Tag may take. Anything it doesn't list is denied:

| Permission Set | Actions | Held by |
| --- | --- | --- |
| `build-tools` | `files:write`, `commands:execute` | The lead, team leads, builders, the verifier, the release manager |
| `registries` | `web:fetch` to the npm registry, GET and HEAD | The platform team. Codex runs commands on gpt-6-sol only with `web:fetch` |
| `review-tools` | `files:read`, `commands:execute` | The reviewers |
| `read-only` | `files:read` | `support` |
| `reliability-tools` | Edits, commands, and `web:fetch` to Sentry and GitHub with the host's tokens | `reliability` |
| `release-gate` | GitHub pull requests; each merge waits for an operator | No one yet; see [Where people approve](#where-people-approve) |

The reviewers can run git and the tests but have no edit tools. On `review-host`, Claude Code
runs their commands in its own sandbox. There, a Task without `files:write` can write only a
temporary folder, so they can't change the code they review.

**Check:** preview the file. On a fresh Control Plane, every line creates, assigns, adds, or
grants something:

```sh
supertag diff -f supertag/organization.yaml
```

The output includes `create PermissionSet/review-tools`, `create Role/reviewer`, and
`assign Role/reviewer to Tag/reviewer`.

## 2. Create the Tags

Each Tag names its Roles, its Workspace, and the host label it runs on:

```yaml
apiVersion: supertag/v1
kind: Tag
metadata: { name: web-builder }
spec:
  displayName: Web Builder
  roles: [builder, product-engineering]
  workspace: { id: app, ref: main }
  runsOn: [product]
```

`ref: main` starts each new **Session**, one thread of a Tag's work, from the commit `main`
names at that time. Apply the file:

```sh
supertag apply -f supertag/organization.yaml
supertag get tag
```

If you ran `supertag init`, you already have a Tag named `lead`, with a Role of its own. Applying
the example over it would add a second Role to a Tag you use, and the two may set different
models. Rename the example's `lead` first, in both files and in every `acceptsMessagesFrom`.

**Check:** compare a builder and a reviewer:

```sh
supertag describe tag web-builder
supertag describe tag reviewer
```

`web-builder` shows `Harness: claude-code` under `Execution`, and `files:write` and
`commands:execute` under `Permissions`, each from
`Role/builder via PermissionSet/build-tools`. `reviewer` shows `files:read` and
`commands:execute` from `Role/reviewer via PermissionSet/review-tools`, and no `files:write`.
Run `supertag diff -f supertag/organization.yaml` again: it prints `No changes.`

## 3. Connect the teams

A **Team** is a flat list of Tags. Members message one another without a grant and share the
Team's **Workstream**, its record of posts. The example has three:

| Team | Members |
| --- | --- |
| `platform` | `platform-lead`, `infra-builder`, and the three specialists |
| `product` | `product-lead`, `web-builder`, `api-builder`, and the three specialists |
| `reliability` | `reliability`, `support` |

A Tag may be in several Teams, but then it has no Workstream: it can't post to one or read one.
The specialists accept that. They answer by message, and the team lead's request includes the
agreement a change must meet.

The leads need their team's Workstream to record plans, so each stays in one Team. They reach one
another by grant instead of through a Team of leads. Each Tag's `acceptsMessagesFrom` names the
Tags it accepts messages from:

| Tag | Accepts messages from |
| --- | --- |
| `lead` | `platform-lead`, `product-lead`, `release-manager`, and the three specialists |
| `platform-lead` | `lead`, `product-lead` |
| `product-lead` | `lead`, `platform-lead` |
| `reviewer`, `security-reviewer`, `verifier`, `release-manager` | `lead` |

Grants are one-way, so each pair names the other. `lead` and `release-manager` are in no Team.

**Check:**

```sh
supertag get team product
supertag get mailbox-grant --tag lead
```

The Team lists its six members. The grants list both directions for `lead`: six Tags it
accepts messages from, and six that accept messages from it.

## 4. Add the ongoing responsibilities and the Schedule

An **Objective** is an outcome a Tag owns, with a budget. `objectives.yaml` gives `reliability`
two ongoing ones, which only an operator ends:

- `triage-production-errors`: triage every new Sentry issue within the hour, and prepare a fix
  with a test for each one that affects users.
- `keep-main-green`: when CI fails on main, find the commit, tell a flake from a real failure,
  and prepare a fix, a revert, or the test to quarantine.

Both rest until a report arrives. SuperTag doesn't poll Sentry or your CI. Forward each alert to
the Objective's conversation with a small relay that calls the
[Control Plane API](../reference/control-plane-api.md)'s `Conversations.SendMessage`. Use the
alert's ID as the `operation_id`, so a retry never delivers it twice. See
[Deliver evidence to the Objective](ongoing-responsibilities.md#2-deliver-evidence-to-the-objective).
Users' bug reports reach `support` in Slack or Linear; it hands production errors to
`reliability`, its teammate.

A **Schedule** wakes a Tag later with a note. `weekly-release` wakes `release-manager` every
Thursday at 09:00 UTC, in your own conversation with it:

```yaml
apiVersion: supertag/v1
kind: Schedule
metadata: { name: weekly-release }
spec:
  tag: release-manager
  every: "0 9 * * THU"
  timeZone: UTC
  note: >-
    Prepare this week's release. Start a release branch from main, bump the version, write the
    changelog from what merged since the last release tag, and run the full checks. ...
```

The release manager does the work in a work Session of its own, then reports the branch, the
notes, and the check results to you there.

**Check:** preview the file. Don't apply it yet:

```sh
supertag diff -f supertag/objectives.yaml
```

It lists `create Objective/triage-production-errors`, `create Objective/keep-main-green`,
`create Objective/account-data-export`, and `create Schedule/weekly-release`.

## 5. Give the lead an outcome and follow it

The same file gives `lead` one outcome that needs both teams:

```yaml
apiVersion: supertag/v1
kind: Objective
metadata: { name: account-data-export }
spec:
  ownerTagId: lead
  outcome: >-
    Signed-in customers can export all of their account data as one downloadable archive. ...
  budgetLimitMinor: 60000
  budgetCurrency: USD
  deadline: "2027-03-31T00:00:00Z"
```

Rewrite it for your project: what must be true, how it will be checked, what must not change,
and the budget. See [Write an Objective](write-an-objective.md). Then apply the file. That starts
the work:

```sh
supertag apply -f supertag/objectives.yaml
supertag watch objective account-data-export
```

The outcome moves through the organization like this:

1. **The lead plans.** The Objective's turn splits the outcome into a brief per team. An
   Objective's turns reach no other Tag, so it asks `lead`'s own inbox with `ask_tag`.
2. **The lead's inbox sends the briefs.** It messages `platform-lead` and `product-lead`.
3. **Each team lead splits its brief.** It posts the plan and the contract between the teams to
   its Workstream, and messages each builder its change. The two team leads settle the contract
   between themselves.
4. **Builders build.** Each builder works in a work Session and reports its branch and checks to
   its team lead.
5. **Specialists review.** The team lead sends each branch to `reviewer`, and changes to
   credentials or file paths to `security-reviewer` too. Findings go back to the builder.
6. **Each team integrates.** The team lead integrates its reviewed branches, has `verifier` run
   the checks, and reports to `lead`.
7. **The lead integrates and reports.** `lead`'s inbox answers the Objective, which integrates
   both teams' branches. It asks for a commit review from `reviewer` and a full run from
   `verifier`. Then it reports `ready_for_review` with the commit and the evidence.

Only a Tag's inbox and its conversations with people message other Tags. A work Session reports
only to the Session that started it.

**Check:**

```sh
supertag describe objective account-data-export
supertag get workstream-post --team product
supertag get message --mailbox platform-lead
supertag watch message
```

`describe objective` lists the Objective's conversation and its work Sessions. The Workstream
shows the product team's plan, and the Mailbox shows the lead's brief. `supertag objective
commit-reviews account-data-export` shows each reviewer verdict on the integrated commit.

## Where people approve

The Tags prepare; people decide. In this example:

| Decision | How you make it |
| --- | --- |
| Accept the lead's result | `supertag describe objective account-data-export`, then `supertag objective review account-data-export approve`, or `request-changes --feedback TEXT` |
| Merge a branch | You merge it. Tags deliver to their own `supertag/session/...` branches, and the example sets no Workspace `land` that merges for you |
| Ship a release | Reply to the release manager's report, then tag and publish the release yourself |
| Act on a reliability fix | Merge, deploy, roll back, or quarantine yourself; `reliability` only prepares |
| A question from a Tag | `supertag get question`, then `supertag question answer` |
| An exhausted budget | `supertag objective set-limits OBJECTIVE --budget-minor AMOUNT` |

`supertag watch inbox-item` prints each item waiting on you as it appears. See
[Respond to an Objective](objective-decisions.md).

To let the release manager merge a release pull request, but only with your approval, add
`release-gate` to the `release-manager` Role. Each merge then waits for a recorded decision:
`supertag get approval` lists it with its exact arguments, and `supertag approval approve ID`
lets that one call run. This needs the `github` MCP server on the release manager's host. That
host must run `supertag worklet --mcp-catalog`, because `supertag.yaml` has no catalog setting.
Until it does, a Task granted `release-gate` waits for the server, so the example leaves it off.
See [MCP tools](../surfaces/worker-tools.md).

## Run the teams on different coding agents and machines

The platform team runs on Codex, and everyone else on Claude Code. Each Tag's harness comes from
its Roles, and a Tag keeps the harness it was created with. To move a team to another agent,
change its team Role before you create its Tags. A work Session may still name another harness
with `start_session`.

To run each function on its own machine, share one Control Plane. See
[Self-host SuperTag](self-hosting.md). On each machine, add one host service with an `auth-key`.
A host **Auth Key** enrolls one machine, and its `--tag` entries name the Tags it may run:

```sh
supertag auth-key create platform-box --role host --tag platform-lead --tag infra-builder
supertag auth-key create review-box --role host --tag reviewer --tag security-reviewer --tag support
```

Hosts on different machines don't share a clone, so they don't see each other's branches. Serve a
remote Workspace instead: a repository on your git server that every host reads, and where each
Session's branch is pushed. See
[Use a repository on a git server](workspaces.md#use-a-repository-on-a-git-server).

## What SuperTag does for you

- **It keeps the organization running.** Every brief, message, report, and Schedule becomes a
  queued Task. A Worker Host with the right label claims it when free. An interrupted Task runs
  again, within retry limits.
- **It keeps each Tag in its lane.** Every Task runs with its Tag's Permission Sets. A reviewer
  has no edit tools; `support` can only read.
- **It bounds the conversation.** A turn sends at most 3 messages, and wake limits stop Tags
  from waking each other in a loop. See [Wake limits](tag-messaging.md#wake-limits).
- **It records the work.** `supertag describe task ID` shows what a turn did, the Workstreams
  hold each team's decisions, and `supertag audit` shows who changed the configuration.
- **It remembers.** Each Tag keeps **Memory** across its Sessions by default. `reliability`
  recalls under one Objective what it learned under the other.

## Going further

The same resources build other organizations. Change the Roles, the Permission Sets, and the
outcomes:

- **A support desk.** A triage Tag in Slack, specialists per product area, and an ongoing
  Objective your ticket system reports to. See
  [Build your own organization: marketing](build-your-own.md) for another function.
- **Research.** A lead that takes questions, researchers with `web:fetch` to the sources they
  may read, and a reviewer that checks each claim against its source.
- **Operations.** Tags that own runbooks as ongoing Objectives, read your monitoring with
  host-held credentials, and prepare changes for the on-call person.

To build on SuperTag itself:

- **Your own interface.** Create Tags, send work, and follow progress through the
  [Control Plane API](../reference/control-plane-api.md). The TypeScript SDK is `supertag-ai` on
  npm, and the Python SDK is `supertag` on PyPI; see [API stability](../reference/api-stability.md).
- **Another agent system.** Run your own agent underneath a Tag with a harness adapter. See
  [Write a harness adapter](harness-adapters.md).
- **Another chat tool.** Implement a Connector. See the
  [Connector contract](../reference/connector-contract.md).

## What doesn't work yet

- **An Objective's budget covers only its owner.** Work the teams do from their own inboxes draws
  on no Objective's budget. Watch it with `supertag spend`.
- **A Tag in several Teams has no Workstream.** That is why the leads use grants, and why the
  specialists answer only by message.
- **A chain of messages passes through at most four inboxes.** A longer relay is refused, and the
  Tag must answer in its reply. Keep briefs flowing through work Sessions, as the Roles say.
- **Approval-gated release steps need an MCP host.** Only Claude Code Tasks get MCP tools, and
  only from a host started with `supertag worklet --mcp-catalog`.
- **Reports don't arrive by themselves.** SuperTag doesn't poll Sentry or CI. You run the relay.

## Troubleshooting

- **A Tag never starts.** Run `supertag placement explain TASK_ID`. `No Worker Host has labels`
  means no running host carries the Tag's `runsOn` label. Check the host services and run
  `supertag up`.
- **A Codex Tag can't run commands.** It needs `web:fetch` on gpt-6-sol. Check that its team Role
  still lists `registries`.
- **A reviewer's Task waits.** A Claude Code Task with `commands:execute` runs only on a host with
  `sandbox-commands` or `allow-unsandboxed-commands`. Check `review-host`.
- **Apply refuses a Tag's Roles.** Two Roles set one execution field to different values. Set the
  field on the Tag, or move it to one Role.
- **A message is refused as not permitted.** The two Tags share no Team and the recipient has no
  grant for the sender. Add the sender to its `acceptsMessagesFrom`.
- **A post fails with "several Teams".** The Tag is in more than one Team. Send a message instead,
  or keep the Tag in one Team.
- **The Inbox says Tags hit a wake limit.** They woke each other more often than the Team allows.
  If they loop, give the work to one Tag. If the traffic is expected, raise the Team's
  `spec.wakeLimits`; see [Organize Tags into Teams](teams.md).
- **The lead's Objective stopped.** `limited` means its budget is spent. Raise it with
  `supertag objective set-limits account-data-export --budget-minor AMOUNT`.
- **Apply refuses a change to an Objective.** `ownerTagId`, `outcome`, and `ongoing` are fixed.
  Create a new Objective under a new name.

## Next

- [Example organizations](../../examples/README.md)
- [Organize Tags into Teams](teams.md)
- [Send messages between Tags](tag-messaging.md)
- [Maintain an ongoing responsibility](ongoing-responsibilities.md)
- [Respond to an Objective](objective-decisions.md)
- [Resource model](../reference/resource-model.md)
