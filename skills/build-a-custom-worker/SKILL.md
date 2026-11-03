---
name: build-a-custom-worker
description: Integrate another agent SDK, CLI, or execution system with SuperTag using the supertag-ai SDK. Read when the shipped Codex and Claude Code Workers do not fit.
---

# Build a custom Worker or harness

```sh
npm install supertag-ai
```

ESM only; use the Node.js runtime in [Requirements](../../docs/operations/requirements.md). `supertag-ai` is the **only** package to depend on — never
`@supertag/*`, which is private and carries no compatibility promise.

Read [Worker Hosts, Worklets, Workers, and harnesses](../../docs/concepts/workers.md) first if
those execution boundaries are not yet clear. Getting them wrong is the cause of most
integration failures below.

## Pick the integration level

| Goal | Implement | SuperTag still owns |
| --- | --- | --- |
| Add another agent SDK, CLI, or harness | `Harness` | Runtime Input resolution, capability checks, environment lifecycle, normalized events, session state |
| Replace the execution model entirely | `Worker` | The Worklet still owns the Control Plane connection; the Worker Host remains the capacity boundary |

**Default to a harness.** A full `Worker` is a small interface but makes you responsible for
authorization enforcement, context handling, lifecycle events, cancellation, and failure
behavior. Choose it only when your engine cannot fit the component lifecycle.

## Keep the process boundary clear

The `supertag` CLI launches only the built-in TypeScript Workers and performs Control Plane operations.
An SDK-built Worker is an ordinary application owned by its implementer. Give it a normal entry
point and start it with `node`, `bun`, `python`, its package script, its container command, or its
process supervisor. Do not invent a SuperTag CLI subcommand or a language-specific Worker CLI for
custom applications.

To replace one piece and keep the runtime, implement just that provider:

| Goal | Implement |
| --- | --- |
| Run in another sandbox or on custom infrastructure | `ExecutionEnvironmentProvider` |
| Resolve another admitted knowledge resource | `ContextResolver` |
| Resolve an operational workspace | `WorkspaceResolver` |
| Expose permission-scoped external actions | `ToolProvider` + a compatible `ToolAdapter` |
| Store native conversation continuity elsewhere | `SessionStateStore` |

For a new kind of reusable knowledge only, keep the shipped runtime and follow
[Add a custom Context type](../../docs/guides/custom-context.md).

## Entry points

```ts
import { createWorker, LocalWorklet, defaultTaskResult } from "supertag-ai";
import { type Harness, type ExecutionContext } from "supertag-ai/worker";
import { connectWorklet } from "supertag-ai/transport";
import { assertConformance, runWorkerConformance } from "supertag-ai/testing";
```

Stability per entry point is in
[API stability](../../docs/reference/api-stability.md). `supertag-ai/transport` is Experimental;
the Worker, harness, and standard composition contracts are Beta.

The normative, language-neutral contract is the
[Worker SPI](../../spec/worker-spi.md). The TypeScript SDK is a projection of
it — for a non-TypeScript implementation, work from the SPI and the JSON Schemas at
`supertag-ai/spec/*`, and see [Build a Python Worker](../../docs/guides/python-workers.md).

Full worked examples for both options are in
[Build a custom Worker or harness](../../docs/guides/custom-workers.md). Follow that guide for
code; this skill covers the decisions and the traps.

## Component identities must agree

The single most common failure. When calling `createWorker`:

- `profile.harness.provider` equals `harness.id`
- `profile.execution.provider` equals `environment.id`
- the Task Attempt's admitted Worker Profile reference equals `profile.ref`, **including revision**

A mismatch does not error loudly — the Control Plane simply finds no eligible host and the Task stays
pending.

## Capability declaration is enforced

`describe()` is a contract, not documentation. Declare only the `inputKinds` and
`runtimePlacements` you actually consume. A required Runtime Input your harness does not
support fails **before** the harness starts — which is the intended fail-closed behavior, not a
bug.

Registries fail closed the same way. Add a `ContextResolverRegistry`,
`WorkspaceResolverRegistry`, or `ToolProviderRegistry` only when the harness genuinely supports
Skills, workspaces, or permission-derived tools. A missing resolver rejects the Task rather than
silently dropping an admitted input.

## Verify before connecting to a Control Plane

```ts
const report = await runWorkerConformance({ worker: new CustomWorker(), attempt: fixture });
assertConformance(report);
```

The probe checks advertised profiles and capabilities, event identity and ordering, exactly one
terminal event, and cancellation when claimed. `supertag-ai/testing` also has probes for
harnesses, collaboration surfaces, execution environments, Tool Providers, Tool Adapters, and transport
negotiation. Run these in your own test runner first — a conformance failure against a live
Control Plane is much harder to diagnose.

[`examples/custom-worker`](../../examples/custom-worker) is a working external package,
deliberately outside the monorepo workspace, validated against the packed tarball.

## Connect

`connectWorklet` waits for first registration and returns a persistent connection that
heartbeats, reconnects after transient drops, forwards cancellation, and streams Task Attempt
events. Give the Worklet and its Worker Host separate stable IDs. Handle `SIGINT`/`SIGTERM` and
call `connection.stop()`.

Convert the Control Plane URL yourself: `http:` → `ws:`, `https:` → `wss:`, and default the path to
`/worklets`.

## Production checklist

- WSS only; keep each enrolled Worker Host credential in its local secret manager, never in argv or source
- Immutable Worker Profile revisions — increment when behavior or policy changes
- Advertise only capabilities you implement
- Forward `AbortSignal` into every SDK call and child process
- Bound execution time, output size, filesystem access, and network access
- Keep collaboration surface and MCP credentials on the Worker Host; never in profiles, Runtime Input
  Manifests, or events
- Emit exactly one terminal `execution.completed` or `execution.failed` per started Task Attempt
- Use a `SessionStateStore` only when the harness can safely validate and resume native state
- Test disconnects, cancellation, unsupported required inputs, and profile mismatches

A full `Worker` receives immutable authorization and Context Plan snapshots but SuperTag does
**not** interpret them for you. Enforce those boundaries yourself before reading context,
mounting resources, exposing tools, or taking external action.

## Preserve catalog artifact identity

For reusable work, capture output files before returning the Task result. Its `artifacts` field
contains `{artifactId, paths}` selections from captures owned by the exact current Task Attempt; a raw
blob URI is not a result selection. The TypeScript composition registers dynamic captures and
declared harness outputs automatically. A full custom Worker must perform upload and capture
itself through the Task Attempt-authenticated catalog contract.

Admitted attachments carry `artifactId`, `path`, a pinned byte reference, and producer provenance.
Preserve that identity and the relative path during materialization. The TypeScript helper
`artifactInputPath` computes the built-in mount location. Record acquisition before delivery,
verify manifest content, and acknowledge delivery only after the environment receives the files;
report uncertain writes rather than replaying them. Captured input lineage is computed by the
server, not asserted by the agent.

Let the current SDK negotiate its supported Worklet protocol with the Control Plane. Python
exposes the selection and attachment wire fields but does not provide the TypeScript runtime's automatic artifact transfer implementation.
See [artifacts](../../docs/reference/artifacts.md) for the HTTP contract and access boundaries.
