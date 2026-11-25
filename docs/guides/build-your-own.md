# Build your own organization: marketing

None of SuperTag's infrastructure is specific to engineering. **Tags** are persistent, proactive, multiplayer AI actors,
each with its own identity, responsibilities, permissions, and work history. **Roles**,
**Teams**, **Objectives**, permissions, **Memory**, **Schedules**, events, and approvals work the
same way for any kind of work. You adapt SuperTag to a function by choosing four things:

| Choose | For marketing |
| --- | --- |
| Roles | The brand voice, what each Tag may claim, and how each function works |
| Permissions | Read and edit the website repository, read the public web, and publish nothing without a person |
| Tools | The repository, web search, and your own publishing server if you want one |
| Events | Releases from engineering and analytics numbers from your own relay |

This guide builds a marketing organization from the example in
[`examples/marketing-org/`](../../examples/marketing-org/). You write two manifests and, for
events, a small relay of your own. See the [glossary](../reference/glossary.md) for other terms.

## The organization

```text
you (head of marketing)
 └─ marketing-lead       owns campaign outcomes, reports weekly with the numbers
     ├─ content           writer and editor: drafts posts, docs pages, and release notes in your voice
     ├─ product-marketing turns each release from engineering into launch copy
     ├─ growth            reads traffic and signup numbers, proposes and tracks experiments
     ├─ social            drafts launch posts, publishes only when you approve
     └─ research          watches competitors and customer conversations, briefs the team
```

The six Tags form one **Team**, `marketing`. A Team is a flat list of Tags that message each other
without a grant and share a **Workstream**, a record of posts every member reads. The chart's
lines are how the work flows, not a hierarchy: SuperTag has no reporting lines. The lead directs
the others by message, and you direct the lead.

| Tag | Role | May | Standing work |
| --- | --- | --- | --- |
| `marketing-lead` | Marketing Lead | Read and edit the repository, set its own follow-ups | A campaign Objective, the weekly report |
| `content` | Content Writer | Read and edit the repository | Requests from the team |
| `product-marketing` | Product Marketer | Read and edit the repository, read the web | Launch copy for each release |
| `growth` | Growth Analyst | Read and edit the repository | Analytics reports and experiments |
| `social` | Social Drafter | Read and edit the repository; publish only with approval, once you add a publishing server | Requests from the team |
| `research` | Market Researcher | Read the repository and the web, set its own follow-ups | The weekly competitor watch |

## Before you start

- SuperTag running on your machine from `supertag init`. See
  [Installation](../operations/install.md).
- Claude Code signed in on that machine. Codex works too; the example's header says what to
  change.
- Your website or docs repository on that machine, with at least one commit. This guide uses
  `~/code/website` on branch `main`. Add a `BRAND.md` with your voice and rules, and a
  `COMPETITORS.md` listing the competitors to watch.

Add the repository as a **Workspace**, a named repository that a Tag's Tasks work in:

```sh
supertag workspace add ~/code/website
```

The Workspace is named after the folder, here `website`. Copy the example into a directory of
your own, outside the repository. Then replace `app` with `website` in each Tag's
`workspace: { id: app, ref: main }`, and `main` with your branch if it differs.

The example needs one host service that runs Claude Code with `claude-opus-5-5` and
`claude-sonnet-5-5`. No Tag runs commands, so it needs no command sandbox. The header of
`organization.yaml` shows the `supertag.yaml` settings. See
[host models](../reference/supertag-yaml.md#host-models).

## 1. Write the Roles and the voice

A **Role** describes how a Tag works and what it may do. Its instructions apply to every **Task**,
one turn of a Tag's work. The example has one Role per function, and one shared Role every Tag
holds:

```yaml
apiVersion: supertag/v1
kind: Role
metadata: { name: brand-voice }
spec:
  displayName: Brand Voice
  purpose: Write in the company's voice and claim only what is true.
  instructions: >-
    Read the brand guide in the repository (BRAND.md) before writing anything. ...
    Claim only what a release note, a merged change, a published page, or a measured number
    supports, and link the source in your report. Never state prices, discounts, customer
    names, or numbers you were not given. ...
```

Put what every Tag shares in `brand-voice`: the voice, what may be claimed, and what must never
appear. Put each function's method in its own Role, such as `growth-analyst`: compare each
report with the last one, and propose an experiment only with a hypothesis and the number it
should move.

Each function Role sets its `execution`: the harness, the allowed models, and the efforts.
`brand-voice` sets none. When two of a Tag's Roles set the same field to different values,
SuperTag refuses the change. See
[execution settings](../reference/resource-model.md#execution-settings).

Write the instructions for the kind of turn that reads them. A Tag works in several kinds of
**Session**, one thread of its work:

| Session | Reaches other Tags | So the instructions say |
| --- | --- | --- |
| An Objective's conversation | Only by asking its own Tag with `ask_tag` | "From your Objective, ask your own Tag to post the brief" |
| The Tag's inbox, where messages arrive | With `send_message` and `post` | "Reply to the Tag that asked with the branch" |
| A work Session | Not at all; it reports to the Session that started it | "Start a work Session that writes the page" |

See [who receives which tools](../reference/coordination.md#who-receives-which-tools).

**Check:** nothing yet. You apply the file in step 3.

## 2. Write the Permission Sets and approvals

A **Permission Set** lists the actions a Tag may take. Anything it doesn't list is denied. The
example has four:

| Set | Grants | Held by |
| --- | --- | --- |
| `drafting` | `files:read`, `files:write` | Every Tag except `research` |
| `reading` | `files:read` | `research` |
| `web-research` | `web:fetch` (GET and HEAD), `web:search` | `product-marketing`, `research` |
| `follow-ups` | `schedule:create` | `marketing-lead`, `research` |

No Tag runs commands, pushes, or deploys. Edits come back as branches; see step 4. Web pages can
carry instructions, so the Tags that read the web publish nothing. Narrow `web:fetch` to the sites
you watch with `hosts`; see [network scopes](../reference/iam.md#network-scopes).

A fifth set gates publishing:

```yaml
apiVersion: supertag/v1
kind: PermissionSet
metadata: { name: social-publishing }
spec:
  permissions:
    - { target: mcp, action: social/publish_post, approvalRequired: true }
```

`approvalRequired: true` makes each call wait for a recorded decision by an operator. Tags never
decide one. SuperTag has no built-in publishing tool: `social` is an MCP server you provide. The
example leaves this set off the `social-drafter` Role, so `social` drafts and a person posts.
[Publish with approval](#publish-with-approval) adds it.

No Tag holds a tool that spends money, so no Tag can buy ads or change prices. Each Objective's
budget caps what its model turns cost.

**Check:** nothing yet. You apply the file in step 3.

## 3. Create the Tags and the Team

Each Tag names its Roles and its Workspace:

```yaml
apiVersion: supertag/v1
kind: Tag
metadata: { name: product-marketing }
spec:
  displayName: Product Marketing
  roles: [product-marketer, brand-voice]
  workspace: { id: website, ref: main }
```

`metadata.name` is the Tag's ID, a lowercase DNS label such as `product-marketing`.
`displayName` is the name people see. See [Resource IDs](../reference/resource-model.md#resource-ids).
`ref: main` starts each new Session from the commit `main` names at that time.

The Team lists all six Tags. Keep each in this Team only: a Tag in two Teams can still message
both, but it can't post to a Workstream.

Preview and apply the file:

```sh
supertag diff -f marketing/organization.yaml
supertag apply -f marketing/organization.yaml
```

**Check:** `supertag describe tag research` lists `files:read`, `schedule:create`,
`web:fetch methods GET,HEAD`, and `web:search` under `Permissions`. Each line says which Role and
Permission Set grant it. `supertag describe tag product-marketing` lists `files:read`,
`files:write`, `web:fetch`, and `web:search`, and no `schedule:create`. A second
`supertag diff -f marketing/organization.yaml` prints `No changes.`

Say hello before you give it work:

```sh
supertag message marketing-lead "Read BRAND.md and tell me in three lines how you'd describe our product."
```

## 4. Get content as branches

Content lives in the repository and arrives as branches for review. When a Tag writes a page, it
starts a work Session. After each Task, the **Worker Host**, the machine that runs the work,
commits the edits and verifies them. It writes them into your repository as the branch
`supertag/session/HASH`, one branch per Session. The Tag's report names the branch.

Ask for a page:

```sh
supertag message content "Draft a blog post announcing CSV export, from docs/features/export.md."
```

To review the result as a pull request instead, declare the repository as a remote Workspace
with `land: { review: { base: main } }`. Each delivery then updates a draft pull request on
GitHub. It never merges one. See [Landing](../reference/resource-model.md#landing).

**Check:** `git -C ~/code/website branch --list 'supertag/session/*'` lists the new branch.
`git -C ~/code/website log -p main..supertag/session/HASH` shows the post. Merge it when you're
happy; nothing reaches the site before you do.

## 5. Add the weekly report and the competitor watch

`objectives.yaml` holds the standing work. An **Objective** is an outcome a Tag owns, with a
budget. `ongoing: true` makes it a responsibility that only an operator ends:

```yaml
apiVersion: supertag/v1
kind: Objective
metadata: { name: competitor-watch }
spec:
  ownerTagId: research
  outcome: >-
    Every Monday, check the competitors listed in the repository's COMPETITORS.md: their pricing
    pages, changelogs, and announcements. Set yourself a weekly Schedule for it on the first turn.
    Brief the team on each change that affects our positioning, with its source link and date,
    and say nothing in a week when nothing changed. ...
  ongoing: true
  budgetLimitMinor: 10000
  budgetCurrency: USD
```

`research` holds `schedule:create`, so its first turn sets its own weekly **Schedule**, a
wake-up, in the Objective's conversation. Each week's turn counts against the Objective's
budget, here USD 100.00. It asks its own Tag to post each brief to the Workstream, where the
team reads it.

The weekly report is a declared Schedule:

```yaml
apiVersion: supertag/v1
kind: Schedule
metadata: { name: marketing-weekly }
spec:
  tag: marketing-lead
  every: "0 9 * * MON"
  timeZone: UTC
  note: >-
    Report last week to the head of marketing. Read the Team's Workstream for growth's numbers
    and research's briefs, ...
```

A declared Schedule fires in your own conversation with the Tag. `growth` posts the week's
numbers to the Workstream, so the report reads them there. The file also holds `launch-copy`,
`track-experiments`, and a campaign Objective with a deadline, `spring-launch`. Rewrite each
outcome for your company, then apply it. Applying starts the Tags:

```sh
supertag apply -f marketing/objectives.yaml
```

**Check:** `supertag describe schedule marketing-weekly` shows the cron expression, the time zone,
and `Next due at`. `supertag describe objective competitor-watch` shows `working`. After its
first turn, `supertag get schedule` lists the weekly Schedule research set for itself.

## 6. Send releases and analytics as events

SuperTag doesn't poll your release pipeline or your analytics tool. A small relay of your own
decides when something happened and sends it. Each event becomes the next turn of an ongoing
Objective's conversation. Find the conversation's ID:

```sh
supertag get objective launch-copy
```

Note `session_id`. Send each event there, with an operation ID built from the event's own ID:

```sh
supertag task submit --tag product-marketing --session SESSION_ID --operation-id release-42 \
  "Release 42 shipped. Notes: https://github.com/acme/app/releases/tag/release-42. Merged: usage-based billing (#812), CSV export (#815)."
```

A retry with the same `--operation-id` returns the first Task and sends nothing new, so a relay
can retry safely. Send analytics to `track-experiments` the same way, with an ID such as
`analytics-2026-w47` for each weekly export.

A relay on another machine calls a shared **Control Plane**, the service that stores and runs
this work. It uses `--gateway URL` and an **Operator Token** of its own in
`SUPERTAG_OPERATOR_TOKEN`. Create one with `supertag operator-token create marketing-relay`. An
application can call the [Control Plane API](../reference/control-plane-api.md) directly instead:
`Conversations.SendMessage` with `tag_id`, `conversation` set to the `session_id`, the event's
`text`, and the same `operation_id`. See
[Deliver evidence to the Objective](ongoing-responsibilities.md#2-deliver-evidence-to-the-objective).

**Check:** `supertag describe objective launch-copy` lists the release under
**Objective conversation**. Submitting the same command again prints the same `task_id`.
`supertag watch objective launch-copy` shows the turn start when a Worker Host is free.

## 7. Work with engineering's Tags

Both organizations can run on one Control Plane. The
[engineering organization](engineering-organization.md) has a `release-manager` Tag that
prepares each week's release. It shares no Team with `product-marketing`, so a message between
them needs a grant. A grant names an existing Tag, so add it after both organizations are
applied:

```sh
supertag mailbox-grant allow release-manager product-marketing
supertag mailbox-grant allow product-marketing release-manager
```

The first lets `release-manager` announce a release. The second lets `product-marketing` ask
about one. Grants are one-way. To keep them in your manifests instead, add
`acceptsMessagesFrom: [release-manager]` to the `product-marketing` Tag, and
`acceptsMessagesFrom: [product-marketing]` to `release-manager`'s.

Then tell `release-manager` to announce each release. Add a sentence like this to its Role's
instructions: "After the operator ships a release, send product-marketing the version, the
notes, and the merged changes with send_message."

A message lands in `product-marketing`'s inbox, not in its `launch-copy` conversation. Its Role
handles both: the inbox turn starts the work Session itself. Use one path per release, the relay
or the message, so the copy isn't written twice.

**Check:** `supertag get mailbox-grant --tag product-marketing` lists both grants. After a
release, `supertag get message --mailbox product-marketing` shows the announcement from
`release-manager`.

## Where people approve

| Decision | Where it waits | How you decide |
| --- | --- | --- |
| Anything reaching the site | A branch, or a draft pull request | Merge it, or ask for changes |
| Publishing a social post | An approval request, once you [add publishing](#publish-with-approval) | `supertag get approval`, then `supertag approval approve ID` or `supertag approval deny ID --reason TEXT` |
| Launch dates, positioning, budget, unsourced claims | A question from an Objective | `supertag get inbox-item`, then `supertag question answer TASK_ID TEXT` |
| An experiment that spends money or changes prices | A proposal in a report | You run it yourself; no Tag holds a tool for it |
| More budget for an Objective | A `limited` Objective | `supertag objective set-limits NAME --budget-minor AMOUNT` |

## Publish with approval

To let `social` publish, provide the tool and gate it:

1. Write or choose an MCP server with a `publish_post` tool for your networks. SuperTag doesn't
   ship one.
2. Run a Claude Code Worker Host whose MCP catalog names it `social`. A catalog is set with
   `supertag worklet --mcp-catalog`, not in `supertag.yaml`. That host also maps the `website`
   Workspace. See [MCP tools](../surfaces/worker-tools.md) and
   [Run a host without supertag.yaml](workers.md#run-a-host-without-supertagyaml).
3. Add `social-publishing` to the `social-drafter` Role's `permissionSets`, and apply. Add it
   only after that host runs. A Task whose grants name a server no bound host provides waits.

Each publish then waits in your inbox with its exact arguments. A `once` approval lets that one
call run.

**Check:** `supertag get permission-set social-publishing` shows `"approval_required":true`.

## What SuperTag does for you

- **It keeps running.** Each message, Schedule, and event becomes a queued Task. A Worker Host
  claims it when free, and an interrupted Task runs again.
- **It remembers.** Each Tag keeps Memory across its Sessions, so `research` remembers last
  month's pricing change, and a daily review corrects it. See
  [Memory](../reference/coordination.md#memory).
- **It enforces limits.** Every Task runs with the Permission Sets in force when it was accepted.
  Gated calls wait for a recorded decision, and budgets cap spend.
- **It coordinates.** Tags message each other and post to the Workstream, under
  [wake limits](tag-messaging.md#wake-limits) that stop loops.
- **It records everything.** `supertag describe task ID` shows what a turn did, and
  `supertag audit` shows who changed the configuration.

## What you build yourself

| Need | Today |
| --- | --- |
| Releases and analytics as events | Your relay calls the API. SuperTag ships no release, analytics, or webhook connector for them |
| Customer conversations for `research` | Add `research` to a Slack channel, or relay excerpts as events. Remove names first; SuperTag doesn't redact them |
| Publishing to social networks | Your own MCP server, on a host started with `--mcp-catalog`, for Claude Code Tasks only |
| Publishing the site | Your site's own deploy from `main`, after you merge |
| A weekly chart of the numbers | `growth` reports in text. SuperTag has no dashboard for your metrics |

## Other functions you could build

Each uses the same machinery with other Roles, tools, and events.

- **Sales.** An account Tag per segment drafts outreach and keeps notes per account in Memory.
  Events are CRM changes from your relay; sending an email is a gated MCP tool.
- **Customer support.** A triage Tag reads each new ticket and routes it to specialists. A
  refund over a limit waits for approval, and real bugs go to engineering's Tags by message.
- **Finance operations.** A Tag reconciles each bank export against the ledger and flags
  differences. Payments stay with people; the Tag prepares them for approval.
- **Recruiting.** A Tag screens each application against the role's written criteria and
  schedules follow-ups. People make every hiring decision.
- **Research.** A Tag owns a question as an Objective, reads sources, and keeps a living report
  in a repository. Each revision arrives as a branch you review.

## Going further

- **Your own interface.** Create Tags, send work, and follow progress through the
  [Control Plane API](../reference/control-plane-api.md). Generated Go, TypeScript, and Python
  bindings live in [`sdks/`](../../sdks/README.md).
- **SDKs.** The TypeScript SDK is `supertag-ai` on npm, and the Python SDK is `supertag` on PyPI.
  See [API stability](../reference/api-stability.md).
- **A connector for your tools.** A Connector carries messages between SuperTag and a chat or
  work tool, such as a CMS or an analytics service. See the
  [Connector contract](../reference/connector-contract.md).
- **Another agent system.** Run your own agent underneath a Tag with a harness adapter. See
  [Write a harness adapter](harness-adapters.md).
- **Skills and knowledge.** Context Sets add Skills, such as your style guide, to a Role. See
  [Configure Tags](../../skills/configure-tags/SKILL.md).

## Troubleshooting

- **`diff` refuses `acceptsMessagesFrom: [release-manager]` with `missing Tag/release-manager`.**
  A grant names an existing Tag. Apply the engineering organization first, or leave the line out.
- **`diff` refuses a Role with `gets execution.harness from Roles ... with different values`.**
  Two of a Tag's Roles set the harness differently. Leave `execution` off `brand-voice`.
- **A Tag never answers.** Run `supertag placement explain TASK_ID`. `No Worker Host is bound`
  means no running host maps the `website` Workspace or serves the Role's model.
- **A Task waits for an MCP server.** `describe task` says
  `No bound Worker Host provides MCP server social`. Remove `social-publishing` from the Role, or
  start the host that serves it.
- **`release-manager`'s message is refused as not permitted.** The grant is missing. Run
  `supertag mailbox-grant allow release-manager product-marketing`.
- **An Objective lacks a permission you added.** An Objective keeps the runtime actions its
  owner had when it was created. `supertag get objective NAME` lists them as `runtime_actions`.
  Replace the list with `supertag objective set-runtime-actions NAME --runtime-action ACTION`,
  repeated for every action it should have.
- **The weekly report has no numbers.** `growth` posts them only after an analytics event. Check
  `supertag get workstream-post --team marketing`.
- **The same release was written up twice.** It arrived both from the relay and from
  `release-manager`. Use one path.
- **An Objective stopped.** `limited` means its budget is spent. Raise it with
  `supertag objective set-limits NAME --budget-minor AMOUNT`.
- **Apply refuses a change to an Objective.** `ownerTagId`, `outcome`, and `ongoing` are fixed.
  Create a new Objective under a new name.

## Next

- [Set up an autonomous engineering organization](engineering-organization.md)
- [Maintain an ongoing responsibility](ongoing-responsibilities.md)
- [Organize Tags into Teams](teams.md)
- [Send messages between Tags](tag-messaging.md)
- [Resource model](../reference/resource-model.md)
