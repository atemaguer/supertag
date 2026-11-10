# Example organizations

`supertag init` creates one **Tag**, `lead`: a persistent AI actor with its own
responsibilities and permissions. These examples define a whole team in one manifest. Copy one,
change a few names, and apply it.

| Example | Team | Use it when |
| --- | --- | --- |
| [`solo`](solo/organization.yaml) | A lead and two builders, all on Claude Code | You want a lead that delegates, on one machine |
| [`review-team`](review-team/organization.yaml) | A lead, two builders, a reviewer, a security reviewer, and a verifier on its own host | You want every change reviewed and the full checks run before merging |
| [`mixed-harnesses`](mixed-harnesses/organization.yaml) | A Claude Code lead, two Codex builders, a Cursor builder, and a reviewer on another model | You use several coding agents and want each Tag on the one that suits it |

Each file holds a **Permission Set** (what Tasks may do), a **Workspace** (the repository Tasks
work in), **Roles** (reusable responsibilities with instructions, model, and effort), and Tags
that hold those Roles. See the [resource model](../../docs/reference/resource-model.md) for every
field.

## Apply an example

1. Copy the file into your repository, for example as `supertag/organization.yaml`.
2. Replace the placeholders:
   - `my-laptop` with your Worker Host ID, the host name `supertag ps` shows. In `review-team`,
     `my-laptop-verify` is a second host service for verification runs; use `my-laptop` to share
     one host instead.
   - `app` with your Workspace name, from `supertag list workspace`.
3. Make sure the host serves every harness and model the file names. The file's header comment
   lists them. See [host models](../../docs/reference/supertag-yaml.md#host-models).
4. Preview the change, then apply it:

   ```sh
   supertag diff -f supertag/organization.yaml
   supertag apply -f supertag/organization.yaml
   ```

If you ran `supertag init`, the first `diff` shows the `Lead` Role's purpose and instructions as
owned by `init`. Review them, then take them over once:

```sh
supertag apply -f supertag/organization.yaml --force-conflicts
```

From then on, the file is the source of truth. Edit it and run `supertag apply` again; `supertag
diff` shows what changes first.

## Adjust it

- **Instructions.** Each Role's `instructions` apply to every Task its Tags run. Name your
  repository's checks, conventions, and anything a Tag must never do.
- **Models and effort.** A Role's `execution` sets the harness, model, and allowed efforts; a
  Tag's own `execution` overrides it, as the builders in `mixed-harnesses` do. See
  [execution settings](../../docs/reference/resource-model.md#execution-settings).
- **Team size.** Add builders by copying a Tag document with a new name, then list them in the
  Objective's `team`.
- **Permissions.** Remove `commands:execute` for Tags that should only read and edit. Claude Code
  and Cursor need `allow-unsandboxed-commands` on the host to run commands; see
  [Harnesses without a sandbox](../../docs/guides/workers.md#harnesses-without-a-sandbox).

A lead hands work to another Tag only when the Objective names a Team that Tag belongs to. Declare
that Team in the Objective itself:

```yaml
apiVersion: supertag/v1
kind: Objective
metadata: { name: importer }
spec:
  owner: lead
  outcome: ...
  team: { members: [lead, builder-1, builder-2, reviewer] }
```

Then give the lead its first outcome: see [Write an Objective](../../docs/guides/write-an-objective.md).
