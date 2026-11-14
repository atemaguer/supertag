# Write an Objective

An **Objective** is a desired outcome with an accountable **Tag**: a persistent AI actor with its
own responsibilities and permissions. For example, an engineering team could deliver a tested
database upgrade rather than just edit a dependency file. Use an Objective when several pieces of
work need one definition of success. A **Session** is one Tag's thread of **Tasks**, one Task per
turn; a **Team** is a flat list of member Tags.

With SuperTag, you define outcomes instead of tasks. Give the owner a result to achieve and evidence to collect,
then let it split the work into Sessions of its own Tag and of its Team's Tags. Start with
[installation](../operations/install.md) if you do not yet have a configured CLI and owner Tag.

## State the outcome

Describe the end state in terms someone can verify. Name the affected product, repository,
or users. “Improve reliability” leaves scope open; “Checkout retries cannot create duplicate
orders” gives the team a concrete result.

The template suggested by `supertag init` is:

> \<desired end state\>. Done when \<specific evidence\>. Keep \<constraints\>. Use
> \<boundaries\>. Between steps, \<how to choose the next action\>. If blocked, stop and report
> \<what you tried and what would unlock it\>.

Replace the placeholders and omit sentences you do not need. These are parts of one outcome
statement, not separate configuration fields. Number distinct deliverables when you want to
track their coverage in the [Objective overview](objective-overview.md).

## Define done-when evidence

Write what a reviewer must inspect before accepting the result. Specify test cases, expected
behavior, and where the team should leave results. A passing test suite alone may miss the
feature you asked for. Include a regression test that reproduces the original problem, an
independent review, and a summary linking the changes to each requirement.

Distinguish “ready for deployment” from “deployed.” If you want a reviewed branch, say so.
If you want a production rollout, define the approval point and the evidence after rollout.

## Set constraints and when to ask

Record what must remain stable: public interfaces, supported platforms, data retention, or
latency. Name the allowed repositories and exclusions. State when the owner should stop and
ask you, such as a destructive migration or a new paid dependency. Ask for the blocker, what was
tried, and the decision needed.

A **Permission Set** selects allowed actions. Prose constraints guide the team; they do not
grant permissions or replace approval rules. See [identity and permissions](../reference/iam.md).
A **Workspace** names a repository available to the Objective's Tasks. Select an existing
Workspace when the work needs repository access.

## Choose a budget and deadline

Allow for implementation, independent review, and fixing findings. Set monetary limits with
both `--budget-minor` and `--budget-currency`: `30000` with `USD` means $300. Without a currency,
the budget limits Task allocations instead of provider-reported cost. A monetary budget tracks
provider-reported spend; it is not a quote for completing the outcome.

Use `--deadline` with an ISO timestamp and an explicit timezone, such as
`2027-03-31T17:00:00Z`. Choose a future date that leaves time for review. Writing a date or dollar
amount only in the outcome does not configure these limits. See the exact
[budget](../reference/coordination.md#the-budget-pool) and
[deadline](../reference/coordination.md#deadlines) behavior before relying on them.

## Three team-scale examples

These are example briefs. Adjust their limits and acceptance evidence to your repository.

### Prevent duplicate checkout orders

**Outcome:** Retried checkout requests create at most one order per idempotency key.

**Done when:** Builders add concurrent-request and timeout regression tests. A separate reviewer
checks transaction boundaries. The final report includes test results and a reviewed branch.

**Constraints:** Keep the public API compatible. Do not deploy or alter production data.
Ask before changing the database schema. **Budget:** $300 USD. **Deadline:** three working days,
converted to an explicit timestamp when creating the Objective.

### Upgrade the supported database version

**Outcome:** The service runs on the next supported database major version.

**Done when:** One builder updates deployment configuration; another checks queries and migrations.
A reviewer verifies the integration suite on both supported versions, a staging restore rehearsal,
and a rollback procedure. Deliver the reviewed changes and rehearsal results.

**Constraints:** Preserve existing data and support the current database during transition.
Stop for approval before any production operation. **Budget:** $600 USD. **Deadline:** one week.

### Prepare a public API release

**Outcome:** Client developers can use the new pagination API with accurate SDKs and documentation.

**Done when:** API and SDK builders deliver matching behavior. A docs builder updates examples.
An independent reviewer runs contract tests and follows the migration guide in a sample client.
The final report links each deliverable and identifies unresolved findings.

**Constraints:** Keep existing pagination working. Deliver a release candidate; do not publish
packages. Ask before adding dependencies. **Budget:** $450 USD. **Deadline:** five working days.

## Create and inspect the Objective

For the first example, assume `lead` is an existing owner Tag with execution capacity and
Choose your own ID, budget, and future deadline:

```sh
supertag objective create checkout-retries \
  "Retried checkout requests create at most one order per idempotency key. Done when concurrency and timeout regression tests pass, an independent reviewer accepts transaction handling, and a report links the reviewed branch and test results. Keep the public API compatible. Do not deploy or alter production data. Ask before changing the database schema." \
  --owner lead --budget-minor 30000 --currency USD --deadline 2027-03-31T17:00:00Z --state-directory ~/.supertag
```

Creating the Objective queues its owner's first turn and refuses a request it cannot accept,
with the reason. Then inspect progress:

```sh
supertag watch objective checkout-retries
supertag describe objective checkout-retries
```

The CLI takes the statement as one argument after the ID; there are no separate done-when or
constraint flags. Objectives can also be declared as resource manifests. `supertag.yaml` configures services;
do not add these fields at its top level. See [Define and complete an Objective](objectives.md)
for creation and [declared Objectives](../reference/resource-model.md#declared-objectives) for
manifest fields.

## Decide when to split an Objective

Keep one Objective when the team shares one acceptance decision, budget, and deadline. Use
Tasks for implementation, documentation, and review that contribute to that same result.

Split when outcomes can be accepted independently, need different owners or deadlines, or
have different approval boundaries. For example, separate a database upgrade rehearsal from
its production rollout when the rollout depends on a later operator decision. Record the
required reviewed result as an input to the later Objective so work does not start prematurely.

For continuing work without a finish date, read
[Maintain an ongoing responsibility](ongoing-responsibilities.md). To give the owner a Team to
hand work to, continue with [Organize Tags into Teams](teams.md).
