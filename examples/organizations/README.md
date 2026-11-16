# Example organizations

`supertag init` creates one **Tag**, `lead`: a persistent AI actor with its own
responsibilities and permissions. These examples define a whole team in one manifest. Copy one,
change a few names, and apply it.

| Example | Team | Use it when |
| --- | --- | --- |
| [`solo`](solo/organization.yaml) | A lead and two builders, all on Claude Code | You want a lead that delegates, on one machine |
| [`review-team`](review-team/organization.yaml) | A lead, two builders, a reviewer, a security reviewer, and a verifier on its own host | You want every change reviewed and the full checks run before merging |
| [`mixed-harnesses`](mixed-harnesses/organization.yaml) | A Claude Code lead, two Codex builders, a Cursor builder, and a reviewer on another model | You use several coding agents and want each Tag on the one that suits it |

Each file holds a **Permission Set** (what Tasks may do), **Roles** (reusable responsibilities
with instructions, models, and efforts), Tags that hold those Roles and work in one
**Workspace**, and a **Team** of those Tags. The Workspace itself is the repository a Worker Host
serves, declared in its `supertag.yaml`; each file's header comment shows the host settings it
expects. See the [resource model](../../docs/reference/resource-model.md) for every field.

## Apply an example

1. Copy the file into your repository, for example as `supertag/organization.yaml`.
2. Replace the placeholders in each Tag's `workspace: { id: app, ref: main }`:
   - `app` with your Workspace name, the name in your host service's
     [`workspaces`](../../docs/reference/supertag-yaml.md#workspaces).
   - `main` with the branch each new Session starts from. Use `baseCommit: SHA` instead of `ref`
     to pin one commit.
3. Make sure the host serves every harness, model, and Workspace the file names. The file's
   header comment lists them. See [host models](../../docs/reference/supertag-yaml.md#host-models).
   In `review-team`, the verifier runs only on a host labeled `verify` and the other Tags on one
   labeled `team`, through each Tag's `runsOn`; give one host both labels to share it. See
   [Worker Host labels](../../docs/reference/resource-model.md#worker-host-labels).
4. Preview the change, then apply it:

   ```sh
   supertag diff -f supertag/organization.yaml
   supertag apply -f supertag/organization.yaml
   ```

If you ran `supertag init`, the first `diff` shows the `Lead` Role's purpose and instructions as
owned by `cli`. Review them, then take them over once:

```sh
supertag apply -f supertag/organization.yaml --force-conflicts
```

From then on, the file is the source of truth. Edit it and run `supertag apply` again; `supertag
diff` shows what changes first.

## Adjust it

- **Instructions.** Each Role's `instructions` apply to every Task its Tags run. Name your
  repository's checks, conventions, and anything a Tag must never do.
- **Models and effort.** A Role's `execution` sets the harness and the allowed `models` and
  `efforts`, the first of each being the default; a Tag's own `execution` overrides it, as the
  builders in `mixed-harnesses` do. See
  [execution settings](../../docs/reference/resource-model.md#execution-settings).
- **Team size.** Add builders by copying a Tag document with a new name, then add them to the
  Team's `members`.
- **Permissions.** Remove `commands:execute` for Tags that should only read and edit. Claude Code
  and Cursor need `allow-unsandboxed-commands` on the host to run commands; see
  [Harnesses without a sandbox](../../docs/guides/workers.md#harnesses-without-a-sandbox). Codex
  runs commands on code-mode-only models such as gpt-6-sol only with `web:fetch` too, which the
  `Codex Commands` Role in `mixed-harnesses` grants; see
  [Codex commands and models](../../docs/operations/requirements.md#codex-commands-and-models).

A lead hands work to another Tag only when the Objective names a Team that Tag belongs to. Each
example declares that Team as `app-team`; name it in the Objective:

```yaml
apiVersion: supertag/v1
kind: Objective
metadata: { name: importer }
spec:
  ownerTagId: lead
  outcome: ...
  team: app-team
```

Then give the lead its first outcome: see [Write an Objective](../../docs/guides/write-an-objective.md).
