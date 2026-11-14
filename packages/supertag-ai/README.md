# supertag-ai

**Persistent AI actors for engineering work.**

SuperTag is the open alternative to dots for engineering work. A **Tag** is a persistent AI actor
with a stable identity, responsibilities, permissions, and work history. It exists independently of
the model or harness executing its work. Talk to it in your terminal, in Slack, or on a GitHub issue.
It runs the work on your coding agents (Claude Code, Codex, Cursor, or OpenCode), asks when a
decision is yours, and returns a git branch to review.

For bigger work, give a Tag an **Objective**: an outcome with done-when evidence, a budget, a
deadline, and the approvals you keep. For example: “People can invite teammates to a workspace and
choose their role. Done when the end-to-end tests pass and the API docs cover it. Ask me before
changing the database schema.” The Tag plans the work and starts a **Session** for each piece,
including Sessions of the other Tags on its **Team**, a flat list of member Tags. A **Task** is one
turn of a Session. Objectives and their history survive individual agent sessions and restarts.

This package contains the **CLI and TypeScript extension SDK**. It is the only public SuperTag npm
package; applications use its public entry points rather than private workspace packages.

[Documentation](https://github.com/atemaguer/supertag/blob/main/docs/README.md) ·
[Repository](https://github.com/atemaguer/supertag) ·
[First Team walkthrough](https://github.com/atemaguer/supertag/blob/main/docs/guides/first-team.md) ·
[Changelog](https://github.com/atemaguer/supertag/blob/main/CHANGELOG.md)

## Install the CLI

Use Node.js 22.13.0 or newer on macOS or Linux:

```sh
npm install -g supertag-ai
supertag --version
```

No SuperTag source checkout is required. If npm's global prefix is not writable, follow the
[installation guide](https://github.com/atemaguer/supertag/blob/main/docs/operations/install.md)
for a user-owned prefix and PATH setup. SuperTag is in alpha; the
[API stability policy](https://github.com/atemaguer/supertag/blob/main/docs/reference/api-stability.md)
describes compatibility and which extension interfaces are stable enough to build on.

## Get a first result

Start in a git repository with at least one commit. Install and sign in to the coding harnesses
you want to use before setup; a **harness** connects a Worker to an agent system such as Codex or
Claude Code. Cursor uses an API key rather than the Cursor app's sign-in. See
[requirements and harness sign-in](https://github.com/atemaguer/supertag/blob/main/docs/operations/requirements.md).

```sh
cd /path/to/your/repository
supertag init
supertag ps
```

`init` sets up a local **Control Plane**, the service that stores your organization and schedules
work, and connects your machine as a **Worker Host**, which provides execution capacity. A
**Worker** completes a Task, and a **Worklet** connects its host to the Control Plane.

Keep the default lead Tag name `lead`. Replace `YOUR_WORKSPACE` below with the Workspace name
printed by setup; a **Workspace** connects a repository to SuperTag.

```sh
supertag create objective first-reply --owner lead --workspace YOUR_WORKSPACE \
  --budget-minor 1000 --budget-currency USD \
  --outcome 'Create SUPERTAG-HELLO.md containing exactly: Hello from SuperTag. Done when the file exists and you have checked its contents. Do this yourself without delegating; change no other files.'
supertag watch objective first-reply
supertag describe objective first-reply
```

Work arrives on a separate git branch for you to review. Use the branch and review commands printed
by `describe objective`; your original checkout stays on its current branch. Stopping `watch` does
not stop the work. `supertag down` stops the local services, and `supertag up` starts them again.

Next, [add a builder and run your first Team](https://github.com/atemaguer/supertag/blob/main/docs/guides/first-team.md).
You can also give your coding agent the
[operator skill](https://github.com/atemaguer/supertag/blob/main/docs/guides/coding-agent-operator.md)
and use one conversation to create Objectives, follow progress, answer questions, and review results.

## What you can use today

- **Choose each Tag's coding harness.** Codex, Claude Code, Cursor, OpenCode, or a custom harness.
  See [harness runtime](https://github.com/atemaguer/supertag/blob/main/docs/guides/harness-runtime.md)
  for supported execution modes and credential handling.
- **Run work where your code lives.** Use local or remote Worker Hosts, with execution adapters
  for Modal and E2B. Supported harness/provider combinations and current limits are documented in
  [shared execution](https://github.com/atemaguer/supertag/blob/main/docs/guides/shared-execution.md).
- **Direct the team from your tools.** Use the CLI or API, or connect Slack, GitHub, Linear,
  Lark/Feishu, and Microsoft Teams through
  [collaboration surfaces](https://github.com/atemaguer/supertag/blob/main/docs/surfaces/README.md).
- **Keep explicit authority.** A **Permission Set** lists allowed actions; a **Context Set**
  selects reusable knowledge. Tasks retain the policy recorded when accepted. Set approval points,
  inspect the operator inbox, and track reported usage and spend.
- **Keep work going across interruptions.** Persistent organization state, resumable sessions,
  durable delivery, and recorded recovery support work across sessions and hosts. See
  [scheduling and recovery](https://github.com/atemaguer/supertag/blob/main/docs/reference/scheduling-and-recovery.md).

For a team deployment, follow
[self-hosting](https://github.com/atemaguer/supertag/blob/main/docs/guides/self-hosting.md).
For ongoing work such as dependency upkeep or backlog triage, see
[ongoing responsibilities](https://github.com/atemaguer/supertag/blob/main/docs/guides/ongoing-responsibilities.md).

## Build with the TypeScript SDK

Add the package to your application:

```sh
npm install supertag-ai
```

The package is ESM-only and includes TypeScript declarations. Its root entry point exposes the
common Worker and Worklet building blocks:

```ts
import {
  createWorker,
  LocalExecutionEnvironmentProvider,
  LocalHarnessRuntimeProvider,
  LocalWorklet,
  connectWorklet,
} from "supertag-ai";
```

Use explicit entry points for integrations and lower-level contracts:

| Entry point | Use it for |
| --- | --- |
| `supertag-ai` | Worker composition, local execution, and Worklet connections |
| `supertag-ai/core` | Domain types and resource schemas |
| `supertag-ai/worker` | Custom Workers, harnesses, input resolution, tools, environments, and continuity |
| `supertag-ai/transport` | Worklet transport and protocol contracts |
| `supertag-ai/messaging` | Tag messaging, Team channels, and custom Worker consumers |
| `supertag-ai/coordination` | Typed client for the operator inbox |
| `supertag-ai/control-plane-client` | Node.js gRPC client for the Rust Control Plane |
| `supertag-ai/harness` | Connect a Node.js harness adapter to its Worker Host |
| `supertag-ai/testing` | Extension conformance probes |
| `supertag-ai/surfaces` | Custom collaboration surfaces |
| `supertag-ai/control-plane` | Embedding the Control Plane |
| `supertag-ai/harnesses/codex` | Codex harness |
| `supertag-ai/harnesses/claude-code` | Claude Code harness |
| `supertag-ai/harnesses/cursor` | Cursor harness |
| `supertag-ai/harnesses/opencode` | OpenCode harness |
| `supertag-ai/environments/e2b` | E2B execution adapter |
| `supertag-ai/environments/modal` | Modal execution adapter |
| `supertag-ai/environments/shared-execution` | Shared execution service integration |
| `supertag-ai/resources/github` | GitHub workspace and permission-derived resource integrations |
| `supertag-ai/spec/*` | Language-neutral wire schemas |

With a Rust SuperTag deployment, use the Control Plane client to list Tags, the persistent AI
actors in your organization.

```ts
import { createControlPlaneClient } from "supertag-ai/control-plane-client";

const client = createControlPlaneClient({
  url: process.env.SUPERTAG_CONTROL_PLANE_URL!,
  token: process.env.SUPERTAG_OPERATOR_TOKEN!,
});
try {
  const { tags } = await client.operator.listTags({}, { timeoutMs: 5_000 });
  for (const tag of tags) console.log(tag.name);
} finally {
  client.close();
}
```

Use an HTTPS origin for a remote Control Plane. Local cleartext connections use a loopback IP
address. Pass `ca` for private TLS and `identity` when the Control Plane requires a client
certificate.
Each service exposes typed protobuf requests and responses. `client.events.watch` returns an
async iterable and accepts an `AbortSignal`. Resume a watch with its last `resumeToken`. The
first call negotiates the SuperTag protocol version with the Control Plane; a Control Plane from
an incompatible release fails it with `Code.FailedPrecondition`.

In a Rust deployment, a Worker Host is the machine or sandbox that provides execution.
It launches a harness adapter to run one Task Attempt, which is a single try at completing
a unit of work. Pass the executable to the Worker Host through its `--adapter` option.
The adapter opens the execution connection from standard input.

```ts
import { openHarness, receipt } from "supertag-ai/harness";

const harness = await openHarness(process.stdin);
try {
  const run = await receipt(() => harness.client.attach({}));
  const result = `Received work for ${run.task?.tagId}`;
  await receipt(() => harness.client.publish({ sequence: 1n, text: result }));
  await receipt(() => harness.client.complete({ succeeded: true, result }));
} finally {
  harness.close();
}
```

Reuse the same sequence number and request body when retrying an event. The Worker Host
records the outcome after the adapter exits successfully. Keep process output and native
provider calls inside the adapter's execution scope.

See the [entry-point stability table](https://github.com/atemaguer/supertag/blob/main/docs/reference/api-stability.md#package-entry-points)
before selecting an extension boundary. The
[custom Worker guide](https://github.com/atemaguer/supertag/blob/main/docs/guides/custom-workers.md)
and [external example](https://github.com/atemaguer/supertag/tree/main/examples/custom-worker)
show complete implementations. To add reusable knowledge, follow
[custom Context types](https://github.com/atemaguer/supertag/blob/main/docs/guides/custom-context.md).

Custom Workers are ordinary applications run through Node.js, Bun, a container, or a process
supervisor. The CLI launches SuperTag's built-in TypeScript Workers; it does not turn custom
Workers into CLI subcommands. Optional execution integrations load through their explicit entry points.

The installed package includes guides under `dist/docs/` and wire schemas under `dist/spec/`.
For example, resolve a schema through `supertag-ai/spec/task-attempt-spec.schema.json`.
To find bundled collaboration surface guides and manifests, run `supertag setup surface slack --help`.

## Python Workers

The matching Python SDK is published separately as `supertag` on PyPI:

```sh
python -m pip install 'supertag==0.3.0a1'
```

Pin the prerelease explicitly so pip selects the matching SDK. Python applications can compose
custom Workers and use the Codex or OpenAI Agents harness integrations. See the
[Python Worker guide](https://github.com/atemaguer/supertag/blob/main/docs/guides/python-workers.md)
for installation extras, examples, and Control Plane connection details.

## Contributing and support

Report issues or propose improvements in the
[GitHub repository](https://github.com/atemaguer/supertag/issues). Read
[CONTRIBUTING.md](https://github.com/atemaguer/supertag/blob/main/CONTRIBUTING.md)
for source setup and checks, and use
[SECURITY.md](https://github.com/atemaguer/supertag/blob/main/SECURITY.md)
for private vulnerability reports.

## License

[Apache-2.0](https://github.com/atemaguer/supertag/blob/main/LICENSE).
