---
name: configure-tags
description: Create Tags and grant them knowledge and authority with Context Sets and Permission Sets, using imperative commands or declarative manifests. Read when a Tag needs to do more than reply in its thread.
---

# Configure Tags, permissions, and context

A Tag starts with the mention lifecycle only: receive an invocation, read its originating
thread, reply there. Everything beyond that is granted explicitly.

The distinction that governs every decision here:

> **Context Sets define what equips a Task. Permission Sets define what the Task is authorized
> to do through collaboration surfaces and harness/runtime tools.**

Knowledge is not authority. A captured artifact may mention a repository; that does not
authorize repository access. Context, declared authority, and native provider access must all
agree, or the Task fails closed.

For the vocabulary used below, see [Tasks and Sessions](../../docs/concepts/tasks.md) and the
[glossary](../../docs/reference/glossary.md).

## Create a Tag

```sh
supertag create tag engineering --worker-host HOST_ID
```

Bind a connected Worker Host that can run this Tag. A Task may select a Worker Profile and
revision; the selected host must advertise that exact profile or the Task waits for capacity.

## Grant authority and knowledge

Permission Sets and Context Sets are **shared** resources. Declare them in manifests, then
reference them through a Tag's Roles or its locations. The binding decides where a set applies;
a set does not belong to a single Tag. See [resource manifests](../../docs/operations/resources.md).

Grant the narrowest thing that works. Channel history, for instance, is not part of presence —
it needs `history:read` through a Permission Set.

Harness-native tools use the runtime target. Grant portable actions instead of harness-specific names:

Save this as `engineering-access.yaml`:

```yaml
apiVersion: supertag/v1
kind: PermissionSet
metadata:
  name: engineering-access
spec:
  permissions:
    - { target: runtime, action: "commands:execute" }
    - { target: runtime, action: "files:write" }
```

```sh
supertag apply -f engineering-access.yaml
```

For one Tag, add `engineering-access` to that Tag manifest's
`spec.locations[].permissionSets` and apply the manifest. You can also run
`supertag activate permission-set engineering-access --tag engineering --provider slack --channel-id CHANNEL_ID`
for an existing Slack channel location. Choose the provider and scope flags for the Tag's actual
location. A shared Role grants its Permission Sets to every Tag with that Role, so use a location
when only one Tag needs access.

Other standard actions are `web:fetch`, `web:search`, and `browser:use`. The selected Worker maps these names to the controls its harness supports.

## Declarative manifests

Preferred for anything you want reviewed or version-controlled. Tags, Permission Sets, and
Context Sets can be applied from YAML or JSON:

```yaml
apiVersion: supertag/v1
kind: ContextSet
metadata:
  name: review-practices
spec:
  items:
    - itemKey: skill:review
      type: supertag/skill
      version: 1
      required: true
      config:
        reference: review-guidelines
```

```sh
supertag diff -f review-practices.yaml    # always preview first
supertag apply -f review-practices.yaml
```

`apply` is idempotent. The Control Plane reconciles declared items while preserving bindings,
generated IDs, timestamps, and status. Clients own `spec`; the Control Plane owns `metadata` and
`status`.

One `-f` input can declare a whole organization: `---`-separated manifests, a JSON array, or a
directory. SuperTag validates everything first, then applies in dependency order. Apply records a
field manager per field and merges lists by key: it removes only fields it set earlier and now
omits, keeps fields set with imperative commands (manager `cli`), and refuses to change another
manager's value unless you pass `--force-conflicts`. Run `diff` first; it prints a plan with any
conflicts. `--set NAME` groups an input into an apply set, and `--set NAME --prune` deletes that
set's members missing from the input. Export the current state with
`supertag get tag NAME --output yaml`. See `docs/operations/resources.md`.

The same applies after `supertag init`: manage the local Control Plane's resources with manifests
and `supertag apply -f`. `supertag.yaml` lists only the services `supertag up` runs (the
`control-plane` service and `host` services), and `apply -f supertag.yaml` is refused with guidance.
A `control-plane` service's `provision` list can reference or embed manifests that `up` creates
when missing (never changing existing ones), under the apply set `provision`. `init` created Workspace, Permission Set
`local-tools`, Role `Lead`, and Tag `lead` under the `apply` field manager, so a manifest applied
without `--set` updates them; include every field you want to keep, such as `roles: [Lead]`. To let
the local computer run a new Tag's Tasks, bind its host service's Worker Host (its ID is the service
name; `supertag ps` shows it): list it in the Tag manifest's `spec.workerHosts`, or run
`supertag update tag TAG --add-worker-host HOST_ID`. `supertag.yaml` never decides Tag bindings. See `docs/reference/supertag-yaml.md`.

A Tag manifest's `runsOn` lists Worker Host labels, such as `[macos, gpu]`. The Tag's Tasks run
only on bound hosts that carry every label; bindings still decide which hosts may run them at all.
Labels are placement only and are self-reported by hosts. See
`docs/reference/resource-model.md#worker-host-labels`.

`supertag delete tag NAME --dry-run` previews removal. Omit `--dry-run` to remove it.
The command also accepts Role, Permission Set, Context Set, Workspace, and Surface Account kinds.
It refuses anything still in use and lists every reference; remove those first, since
there is no force option. Deleting a Tag retires it: history stays, it gets no more work, and its
name becomes free for a new Tag. Deleting a Surface Account retires it and removes its stored
credential.

A `SurfaceAccount` manifest declares a Surface Account instead of
`supertag setup surface`. Its `spec.secrets` entries are references only:
`{ env: VARIABLE }`, `{ file: PATH }`, or `{ secretRef: NAME }` (needs a caller-supplied resolver;
`apply -f` refuses it). Never write a token into a manifest; a literal value is rejected. Apply
verifies new or changed credentials with the provider before writing anything, and a Tag
location's `account` can name the account by its manifest name in the same input. See
`docs/operations/resources.md#declare-surface-accounts`.

**Tasks, Sessions, and Worker Hosts cannot be applied.** They are observed or enrolled, not
declared. Attempting it is an error, not a no-op.

## Inspect

```sh
supertag list tag
supertag list permission-set
supertag list context-set
supertag describe tag engineering
supertag watch tag                 # streams on resource-version change; use list for a snapshot
```

`get` returns the portable envelope; `describe` adds observed status. A kind is always singular
and hyphenated (`tag`, `permission-set`, `context-set`). Plural and unspaced spellings are
rejected.

## Cross-surface continuity

A Context Set can select captured artifact metadata from an exact source Tag location and activate
it at a destination. An agent can then inspect or retrieve selected work from another Session.

Constraints, all enforced: sharing is directional, source and destination are explicit, artifacts
must belong to the same Tag, matching uses exact resource identity with bounded age and count,
and failed Task Attempts never advance automatic continuity. These source selectors apply to surface
Tasks; an Objective's own Tasks discover artifacts through Objective visibility instead.
Same-Session history is automatic and needs no Context Set.

Details in [Context Sets and Permission Sets](../../docs/concepts/context-and-permissions.md)
and the [context resolution reference](../../docs/reference/context-resolution.md).

## Verify

```sh
supertag describe tag engineering    # presences, permission sets, contexts, worker profile
```

Then exercise it from the surface. If a Task is admitted but does nothing, the usual cause is a
Worker Profile mismatch or a required Runtime Input the harness does not support — see
[troubleshoot](../troubleshoot/SKILL.md).
