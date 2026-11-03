# supertag-ai

This package is the command-line interface and extension SDK for SuperTag. With SuperTag, you define
outcomes instead of tasks, and an AI engineering team delivers them.

Start with [the bundled core concepts](dist/docs/concepts/README.md)
before choosing an SDK extension point.

SuperTag calls each AI actor a **Tag**. A **Task** is one assignment accepted for that Tag. A
**Worker** completes the Task, and an optional **harness** connects the Worker to an agent system.
A **Role** describes an enduring responsibility held by a Tag. The **Control Plane** is the service
that stores and coordinates the organization. A **Worker Host** is a machine or sandbox where work
runs, and a **Worklet** connects that host to the Control Plane. An **execution environment**
provides the files, processes, and network used by a harness. A **collaboration surface** links SuperTag to an
external work tool. This SDK lets applications extend each of these boundaries.

Security and governance use the same resource model. Context Sets select reusable knowledge,
Permission Sets select allowed actions, and each Task carries its recorded policy into execution.

Install from a repository clone using [the installation guide](../../docs/operations/install.md).
The build contains the CLI, SDK, and documentation under `dist/docs/`. Keep the clone in place.

After building, add the SDK to your application from the local checkout:

```sh
npm install /absolute/path/to/supertag/packages/supertag-ai
```

Replace the path with your SuperTag checkout. The globally linked CLI is available as `supertag`.

The main entry point contains Worker components and the persistent Worklet transport client:

```ts
import {
  createWorker,
  LocalExecutionEnvironmentProvider,
  LocalHarnessRuntimeProvider,
  LocalWorklet,
  connectWorklet,
} from "supertag-ai";
```

Use explicit subpaths for optional implementations and lower-level extension contracts:

```ts
import { type Role, tagIdSchema } from "supertag-ai/core";
import { CoordinationClient } from "supertag-ai/coordination";
import { type Surface } from "supertag-ai/surfaces";
import { CodexHarness } from "supertag-ai/harnesses/codex";
import { ClaudeCodeHarness } from "supertag-ai/harnesses/claude-code";
import { OpenCodeHarness } from "supertag-ai/harnesses/opencode";
import { E2BExecutionEnvironmentProvider } from "supertag-ai/environments/e2b";
import { ModalExecutionEnvironmentProvider } from "supertag-ai/environments/modal";
import { GitHubRepositoryWorkspaceResolver } from "supertag-ai/resources/github";
import { ControlPlane } from "supertag-ai/control-plane";
```

The public `Role` contract describes a reusable responsibility. Operators define Roles through the
Control Plane resource API and list them in `Tag.spec.roles`; built-in status is reported by the
Control Plane without requiring applications to know an internal identifier.

## Public entry points

| Import | Stability | Purpose |
| --- | --- | --- |
| `supertag-ai` | Beta | Worker Host, Worklet, Worker, local harness runtime and execution components, and Worklet transport |
| `supertag-ai/core` | Beta | Tag, Role, Context Set, Permission Set, Task, Session, and surface-neutral domain contracts |
| `supertag-ai/worker` | Beta | Worker, harness, environment, Context Resolver, tool, and sessionState contracts |
| `supertag-ai/transport` | Experimental | Persistent remote Worklet connection and protocol |
| `supertag-ai/messaging` | Experimental | Durable Tag messaging, Team channels (Workstreams), and custom Worker consumer |
| `supertag-ai/coordination` | Experimental | Typed operator client and redacted coordination inbox contract |
| `supertag-ai/testing` | Beta | Reusable extension conformance probes |
| `supertag-ai/spec/*` | Experimental | Language-neutral JSON Schemas for Worker interoperability |
| `supertag-ai/surfaces` | Beta | Custom collaboration surface contract and Markdown pipeline |
| `supertag-ai/control-plane` | Experimental | Embeddable Control Plane service boundary |
| `supertag-ai/harnesses/*` | Experimental | Shipped Codex, Claude Code, and OpenCode harnesses |
| `supertag-ai/environments/e2b` | Experimental | Shipped E2B execution environment |
| `supertag-ai/environments/modal` | Experimental | Shipped Modal execution environment |
| `supertag-ai/environments/shared-execution` | Experimental | Task Attempt access to a shared execution service |
| `supertag-ai/resources/*` | Experimental | Permission-derived MCP and workspace integrations |

The package is ESM-only. See [Requirements](../../docs/operations/requirements.md) for the supported Node.js runtime. The CLI includes the shipped collaboration surface and harness integrations. E2B, Modal, and shared execution are loaded only through their explicit subpaths.

The CLI launches SuperTag's built-in TypeScript Workers. Applications built with the SDK keep
their own entry point and run through `node`, `bun`, a package script, a container command, or a
process supervisor; they do not become `supertag` subcommands.

Wire schemas can be resolved directly from the installed package, for example
`supertag-ai/spec/task-attempt-spec.schema.json`. See the
[custom Worker and harness guide](dist/docs/guides/custom-workers.md)
for a complete implementation and Control Plane connection walkthrough, or the
[custom Context guide](dist/docs/guides/custom-context.md)
to add a namespaced knowledge type without replacing the Worker.

The testing entry point currently provides conformance probes for Workers,
harnesses, collaboration surfaces, execution environments, Tool Providers, Tool Adapters,
and Worklet transport version negotiation. The repository also contains an
[external extension example](https://github.com/atemaguer/supertag/tree/main/examples/custom-worker)
with custom Worker, harness, and Environment Provider implementations verified
against the built distribution.

## License

Apache-2.0

For surface-independent coordination, see the [Tag messaging guide](dist/docs/guides/tag-messaging.md).

Operators can list pending Task approvals and reviews without reading Task instructions, results,
or acceptance criteria:

```ts
const coordination = new CoordinationClient({
  baseUrl: "https://supertag.example.com",
  token: process.env.SUPERTAG_COORDINATION_TOKEN!,
});
const pending = await coordination.inbox({ objectiveId: "objective-release" });
```

The inbox is a versioned projection over existing Tasks and Teams. Each action is a partial
`update_task` invocation with the current status fence and any fields the operator still needs to
supply. Authority and stale-write checks run again when the update is submitted.

The experimental `supertag-ai/messaging` client also creates and tracks Objectives with
success criteria and explicit completion assessments. See the [Objective guide](../../docs/guides/objectives.md).
