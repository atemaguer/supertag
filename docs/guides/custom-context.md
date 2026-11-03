# Add a custom Context type

Teach SuperTag to supply your own kind of knowledge, such as runbooks, architecture decisions, a
schema catalog, or an internal knowledge package, when SuperTag has no built-in handler for it.

- A **Tag** is a persistent AI identity with its own responsibilities and permissions. A **Role** is
  an enduring responsibility assigned to a Tag.
- A **Context Set** names reusable knowledge that SuperTag may add to a **Task**, one accepted
  assignment for a Tag.
- Each entry in a Context Set is a **Context Item** with a type.
- A **Context Resolver** is part of a **Worker**, the code that completes a Task. It turns the
  declaration into inputs for the **harness**, the coding agent that runs the Task, such as
  Claude Code or Codex.
- A **Skill** is a reusable package of instructions and supporting files.
- Tags work in Teams under a lead. Together, your Teams of Tags make up an **autonomous
  organization**: Teams may pursue different goals but share one Control Plane, its rules,
  and its record of the work.
- The **Control Plane** is the SuperTag service that stores the organization and schedules work.

See the [glossary](../reference/glossary.md) for other terms.

## Before you start

- A custom Worker that you build and run. See [Build a custom Worker](custom-workers.md).
- A Control Plane you can apply manifests to with `supertag apply -f`.
- A namespaced type name you control, such as `acme.io/runbook`.

## 1. Declare the Context Item

Every item has a namespaced type, contract version, stable key, required flag, and non-secret
configuration. Declare it in a resource manifest:

```yaml
apiVersion: supertag/v1
kind: ContextSet
metadata:
  name: operations
spec:
  items:
    - itemKey: runbook:payments
      type: acme.io/runbook
      version: 1
      required: true
      config:
        name: payments
```

Apply the manifest with `supertag apply -f operations.yaml`. Set `required: false`
when a Task may continue on Workers that do not install the resolver. Attach the Context Set to a
Tag through a Role or with
`supertag activate context-set operations --tag TAG --provider PROVIDER [provider scope flags]`.

Keep `config` below 64 KiB. Store locators, selectors, and secret references—not credentials or large document bodies.

## 2. Implement the resolver

This TypeScript example resolves an allowlisted runbook into a portable Resource input:

```ts
import type {
  ContextInput,
  ContextResolver,
  ResolutionContext,
} from "supertag-ai/worker";
import type { TagContextPlanItem } from "supertag-ai/core";

export class RunbookResolver implements ContextResolver {
  readonly type = "acme.io/runbook";
  readonly versions = [1] as const;
  readonly outputKinds = ["resource"] as const;

  async resolve(
    item: TagContextPlanItem,
    _context: ResolutionContext,
  ): Promise<ContextInput> {
    const name = item.config["name"];
    if (typeof name !== "string") throw new Error("Runbook name is required");

    const allowed = new Map([
      ["payments", "file:///opt/acme/runbooks/payments.md"],
    ]);
    const uri = allowed.get(name);
    if (uri === undefined) throw new Error(`Runbook ${name} is not allowed`);

    return {
      id: `runbook:${name}`,
      kind: "resource",
      required: item.required,
      source: {
        uri,
        mediaType: "text/markdown",
        provenance: { contextType: this.type, contextVersion: item.version },
      },
    };
  }
}
```

In the TypeScript SDK, `outputKinds` must declare every Context Input kind
the resolver may produce. A profile advertises this context contract only when
its harness supports all declared kinds. This is a conservative bound, not a list
of alternatives the Worker chooses between. Registration requires a nonempty list;
outputs are also checked at execution time. `ContextResolverRegistry` associates
each output with its admitted Context Item automatically.

Python uses the same wire contract with idiomatic member names:

```python
class RunbookResolver:
    type = "acme.io/runbook"
    versions = (1,)

    async def resolve(self, item, context):
        name = item["config"]["name"]
        return {
            "id": f"runbook:{name}",
            "kind": "resource",
            "required": item["required"],
            "source": {"uri": f"file:///opt/acme/runbooks/{name}.md"},
        }
```

## 3. Add the resolver to the Worker

Register the resolver when you create the Worker:

```ts
import { createWorker } from "supertag-ai";
import { ContextResolverRegistry } from "supertag-ai/worker";

const contextResolvers = new ContextResolverRegistry([
  new RunbookResolver(),
]);

const worker = createWorker({
  id: "acme-worker",
  profiles,
  harnesses,
  environments,
  contextResolvers,
});
```

The Worker advertises `acme.io/runbook@1` when it connects. The Control Plane will not assign a required item to an incompatible Worker. An unsupported optional item is recorded in the Runtime Input Manifest and execution may continue.

## Check that it worked

1. Run `supertag get context-set operations` and confirm the item with `itemKey: runbook:payments`
   appears in its spec.
2. Start the Worker, then send the Tag a request from a location where the Context Set is active.
3. Run `supertag events task TASK_ID`. The event whose type ends in `runtime-inputs.resolved`
   lists an input with `sourceItemKey: runbook:payments` under `inputs`. An unsupported optional
   item appears under `omitted` with a reason instead.

## Rules

A resolver may narrow the admitted Task, but it must not expand it. Context Sets never grant
permission to access the source.

- It must not create permissions or credentials for a **collaboration surface**, the external work
  tool such as Slack or GitHub where SuperTag meets people.
- External reads must already be authorized by the Task's authorization snapshot: the permissions
  SuperTag recorded when it accepted the Task.
- It must reject unsupported versions and invalid configuration.
- It should use allowlists, bounded reads, and clear provenance.
- Historical or external text must remain untrusted context, not system instructions.

The full envelope is defined in the [Custom Context Item contract](../reference/context-resolution.md#custom-context-item-contract).

## Built-in Context types

Skills use `supertag/skill@1`; captured artifact selections use `supertag/artifacts@1`. They
follow the same envelope even though SuperTag provides their resolvers. Artifact selections
resolve into bounded, explicitly untrusted metadata instructions with artifact IDs and retrieval
guidance. Automatic history from the same **Session**, the group of Tasks from one conversation,
uses the separate `history` [Runtime Input](../reference/glossary.md#runtime-input) kind and is not a
Context Item.

## If something goes wrong

- **The Task stays pending.** The item is `required: true` and no connected Worker advertises
  `acme.io/runbook@1`. Check that the Worker registers the resolver and advertises the version in
  the Context Set. See [Troubleshooting](troubleshooting.md).
- **The item is listed under `omitted`.** The item is optional and the Worker that ran the Task
  did not support it. Install the resolver on that Worker or set `required: true`.
- **The resolver rejects the item.** Check that `config` matches what the resolver expects and stays
  below 64 KiB. See the [Custom Context Item contract](../reference/context-resolution.md#custom-context-item-contract).

## Next

- [Context resolution](../reference/context-resolution.md) describes the complete lifecycle.
- The [Worker SPI](../../spec/worker-spi.md) defines the resolver interfaces.
- [Context Sets and Permission Sets](../concepts/context-and-permissions.md) explains why knowledge
  and authority stay separate.
