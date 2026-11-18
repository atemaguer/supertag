# Examples

`supertag init` creates one **Tag**, `lead`: a persistent AI actor with its own identity,
responsibilities, permissions, and work history. These examples go further. Each one shows a
part of what makes Tags different, in manifests you can copy, rename, and apply.

| Example | Shows | Tags | Use it when |
| --- | --- | --- | --- |
| [`reliability`](reliability/) | **Proactive.** One Tag owns four ongoing Objectives and acts on each error report, alert, failed CI run, and advisory as it arrives | `reliability` on Codex, `support` on Claude Code with read-only access | You want production errors, alerts, and red builds handled before anyone asks |
| [`multiplayer`](multiplayer/) | **Multiplayer.** Two teammates each direct their own Tag on their own machine and coding agent; the Tags settle details between themselves | `web` on Claude Code, `api` on Codex, a shared `reviewer` on Claude Code | Your team works on one product and you want your Tags to coordinate without you |
| [`review-team`](review-team/) | **Outcomes, with evidence.** A lead owns an outcome and delivers it with builders and independent review | A lead, two builders, a reviewer, a security reviewer, and a verifier on its own host | You want every change reviewed and the full checks run before you see it |

Each example has two files:

- **`organization.yaml`** declares the Tags and what they need: **Permission Sets** (what Tasks
  may do), **Roles** (responsibilities with instructions, models, and efforts), and, where Tags
  work together, a **Team**. Applying it starts nothing.
- **`objectives.yaml`** declares the outcomes and responsibilities the Tags own: **Objectives**
  and, in `reliability`, a **Schedule**. Applying it starts the work, so apply it when you're
  ready.

Each Tag works in one **Workspace**, the repository a Worker Host serves, declared in its
`supertag.yaml`. Each file's header comment shows the host settings it expects. See the
[resource model](../docs/reference/resource-model.md) for every field.

## Apply an example

1. Copy the example's directory into your repository, for example as `supertag/`.
2. Replace the placeholders in each Tag's `workspace: { id: app, ref: main }`:
   - `app` with your Workspace name, the name in your host service's
     [`workspaces`](../docs/reference/supertag-yaml.md#workspaces).
   - `main` with the branch each new Session starts from. Use `baseCommit: SHA` instead of `ref`
     to pin one commit.
3. Make sure the hosts serve every harness, model, and Workspace the file names. The header
   comment lists them. See [host models](../docs/reference/supertag-yaml.md#host-models).
4. Preview the Tags, then apply them:

   ```sh
   supertag diff -f supertag/organization.yaml
   supertag apply -f supertag/organization.yaml
   ```

5. Rewrite the outcomes in `objectives.yaml` for your project: what must be true, how it will be
   checked, what must not change, and the budget. Then apply it to start the work:

   ```sh
   supertag apply -f supertag/objectives.yaml
   supertag describe objective NAME
   ```

From then on, the files are the source of truth. Edit them and run `supertag apply` again;
`supertag diff` shows what changes first. An Objective's owner, outcome, `ongoing`, and Team
can't change once it exists; create a new Objective instead.

## Adjust it

- **Outcomes.** State the result, how it will be verified, and what must not change, in one
  statement. See [Write an Objective](../docs/guides/write-an-objective.md).
- **Responsibilities.** Give related ongoing Objectives to the same Tag, so it can recall what it
  learned under each. Give a responsibility its own Tag only when it needs different permissions,
  as `support` does in `reliability`. See
  [Maintain an ongoing responsibility](../docs/guides/ongoing-responsibilities.md).
- **Instructions.** Each Role's `instructions` apply to every Task its Tags run. Name your
  repository's checks, conventions, and anything a Tag must never do.
- **Models and effort.** A Role's `execution` sets the harness and the allowed `models` and
  `efforts`, the first of each being the default; a Tag's own `execution` overrides it, as `web`
  and `api` do in `multiplayer`. See
  [execution settings](../docs/reference/resource-model.md#execution-settings).
- **Permissions.** Remove `commands:execute` for Tags that should only read and edit. Narrow
  `web:fetch` to the origins each Tag needs, and let the host add credentials the Tasks never
  see; see [network scopes](../docs/reference/iam.md#network-scopes). A Claude Code host runs
  commands only with `allow-unsandboxed-commands`, as your user; to run them in a container
  instead, see [local-vm containers](../docs/reference/supertag-yaml.md#local-vm-containers). Codex runs
  commands on code-mode-only models such as gpt-6-sol only with `web:fetch` too; see
  [Codex commands and models](../docs/operations/requirements.md#codex-commands-and-models).
- **Teams.** A Tag hands work to another Tag only when the Objective names a Team they share, and
  Tags in one Team message each other without further grants. A Tag outside the Team needs an
  `acceptsMessagesFrom` entry on the recipient. Entries are one-way, so in `reliability` each Tag
  names the other: `support` hands over reports, and `reliability` answers.

If you ran `supertag init`, the first `diff` of `review-team` shows the `Lead` Role's purpose and
instructions as owned by `cli`. Review them, then take them over once with
`supertag apply -f supertag/organization.yaml --force-conflicts`.
