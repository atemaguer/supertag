# Build a custom Worker or harness

Connect your own agent system or execution service to SuperTag. Use this guide when the shipped
Codex, Claude Code, Cursor, and OpenCode integrations do not fit the execution system your organization needs.

A **Task** is one accepted request or assignment. A **Worker** is the code that completes it. A
**harness** connects a Worker to an agent system such as Codex or Claude Code. A **Tag** is a
persistent AI actor with its own responsibilities and permissions, and Tags work in Teams: flat
lists of member Tags. Together, your Teams of Tags make up an **autonomous organization**: Teams may pursue
different goals but share one set of rules and one record of the work. A **Worker Host** is a
machine or sandbox that provides execution capacity, and a **Worklet** connects it to the **Control
Plane**, the SuperTag service that stores the organization and schedules work. A **Worker Profile**
is a saved, versioned recipe for running a Worker. See the [glossary](../reference/glossary.md) for
other terms.

You can integrate at one of two levels:

| You want to… | Implement | SuperTag still owns |
| --- | --- | --- |
| Add another agent SDK, CLI, or harness | `Harness` | The Worker still owns input resolution, environment lifecycle, normalized events, and session state |
| Replace the execution model completely | `Worker` | The Worklet still owns the Control Plane connection; the Worker Host remains the capacity boundary |

Start with a custom harness unless your system cannot fit the component lifecycle. A full Worker is
intentionally a small interface, but it also becomes responsible for authorization enforcement,
context handling, lifecycle events, cancellation, and failure behavior.

Custom Workers are ordinary applications, not `supertag` subcommands. Give the application its
own entry point and start it with its language runtime, package script, container command, or
process supervisor. The SuperTag CLI launches only the built-in TypeScript Workers:

```sh
# Built-in Worker owned by SuperTag
supertag connect worklet --harness codex --workspace /path/to/repository

# Custom applications owned by their implementers
node /path/to/custom-worker.mjs
bun run /path/to/custom-worker.ts
python /path/to/custom_worker.py
```

This guide uses the TypeScript SDK. For a Python Worker or harness, follow
[Build a Python Worker](python-workers.md). To replace a single component instead, such as the
execution environment or a Context Resolver, see
[Customization levels](../reference/worker.md#customization-levels). If you only need to add
reusable knowledge, follow [Add a custom Context type](custom-context.md).

## Before you start

- **The SDK from npm.** Add the package to your application; see
  [Install SuperTag](../operations/install.md) for runtime requirements and version matching:

  ```sh
  npm install supertag-ai
  ```

  The examples use the main Worker API and the `supertag-ai/worker` extension contracts. See
  [API stability](../reference/api-stability.md#package-entry-points) for every entry point.

- **An enrolled Worker Host.** Configure the Control Plane to accept Worker Hosts through its
  Worklet API, then enroll one. A custom application reads the host credential directly, so use
  enrollment here; an [Auth Key](../reference/resource-model.md#auth-keys) joins hosts through
  `supertag connect worklet`:

  ```sh
  export SUPERTAG_WORKLET_TRANSPORT=remote
  supertag start control-plane
  supertag enroll worker-host example-worker-host --out example-worker-host.credential.json
  ```

- **A Tag bound to that Worker Host.** Bind each Tag that should use your Worker before assigning it
  work: `supertag update tag TAG --add-worker-host example-worker-host`. See
  [Run a Worker](workers.md#4-bind-more-tags).

- **The Worker Host credential in `SUPERTAG_WORKLET_TOKEN`.** Enrollment writes the credential
  once to that file with mode `0600`. The file is JSON; its `token` field holds the credential.
  Copy that value into the Worker Host's secret manager, and expose it to your application as
  `SUPERTAG_WORKLET_TOKEN`. Keep it out of source code and command-line arguments.

The Worklet connects outbound to the Control Plane's **API Server**, the subsystem that handles
management requests and execution connections. For a Control Plane on another
machine, use HTTPS/WSS so the per-host credential is encrypted in transit.

## 1. Create a harness

A harness translates SuperTag's resolved `ExecutionContext` into one invocation of an agent SDK,
CLI, or other execution engine. This deterministic example launches an isolated Node process and
echoes the resolved prompt. Replace that process call with your SDK or executable while keeping the
same lifecycle.

```ts
import { defaultTaskResult } from "supertag-ai";
import {
  type ExecutionContext,
  type Harness,
  type HarnessCapabilities,
  type HarnessEnvironmentAccesses,
  type HarnessExecution,
  type HarnessPlan,
} from "supertag-ai/worker";

export class ExampleHarness implements Harness {
  readonly id = "example";

  async describe(): Promise<HarnessCapabilities> {
    return {
      id: this.id,
      version: "1",
      inputKinds: ["instruction", "history"],
      streaming: false,
      cancellation: true,
      sessionPersistence: "none",
      sessions: { resume: false, export: false, scope: "none" },
      runtimePlacements: ["local"],
    };
  }

  async plan(context: ExecutionContext): Promise<HarnessPlan> {
    const question = context.attempt.input.messages.findLast(
      (message) => message.role === "requester",
    )?.text;
    if (question === undefined) throw new Error("The Task has no requester message");

    const instructions = context.context.instructions
      .toSorted((left, right) => left.priority - right.priority)
      .map((instruction) => instruction.content);
    const sessionHistory = context.context.history.map((record) => record.content);

    return {
      runtime: {
        files: [],
        mounts: [],
        environmentVariables: {},
        secretBindings: [],
        network: { mode: "none" },
      },
      execution: {
        files: [],
        mounts: [],
        environmentVariables: {},
        secretBindings: [],
        network: { mode: "none" },
      },
      metadata: {
        prompt: [...instructions, ...sessionHistory, question].join("\n\n"),
      },
    };
  }

  async start(
    plan: HarnessPlan,
    environments: HarnessEnvironmentAccesses,
    _context: ExecutionContext,
  ): Promise<HarnessExecution> {
    const prompt = plan.metadata?.["prompt"];
    if (typeof prompt !== "string") throw new Error("Harness Plan is missing its prompt");

    return {
      async *run(signal) {
        const child = await environments.runtime.spawn(
          {
            command: process.execPath,
            args: ["-e", "process.stdin.pipe(process.stdout)"],
            cwd: environments.runtime.rootDirectory,
            environment: plan.runtime.environmentVariables,
            stdin: prompt,
          },
          signal,
        );
        const result = await child.wait();
        if (result.exitCode !== 0) {
          throw new Error(result.stderr || `Harness exited with ${result.exitCode}`);
        }

        const text = result.stdout.trim();
        yield { type: "output.message", text };
        yield { type: "result", result: defaultTaskResult(text) };
      },
      async close() {},
    };
  }
}
```

`describe()` returns `HarnessCapabilities`, an enforceable contract. Declare only the
`inputKinds` and placements that the harness actually consumes. The example sets the required
fields:

| Field | Values |
| --- | --- |
| `id`, `version` | The harness ID used by Worker Profiles, and your implementation version |
| `inputKinds` | Any of `instruction`, `skill`, `history`, `workspace`, `tool`, `resource`, `sessionState`, `secret`, `harness-specific` |
| `streaming`, `cancellation` | `true` or `false` |
| `sessionPersistence` | `none`, `native`, or `filesystem` |
| `runtimePlacements` | Any of `local`, `remote`, `managed` (optional) |

`run(signal)` yields `HarnessEvent` values such as `output.message` and `result`. See
[harness events](../reference/worker.md#harness-events) for every event and the usage and
cancellation rules. The required `sessions` field declares resume, export, and persistence scope.
Optional capability fields declare execution limits, tool isolation,
and MCP client paths; read [Extend harness execution](harness-runtime.md) before you declare them.

## 2. Compose the harness into a Worker

`createWorker` combines the harness with a versioned Worker Profile and an execution environment,
and returns an ordinary Worker. Colocated profiles use that environment for the harness too. Split
profiles separately register a `HarnessRuntimeProvider` through `harnessRuntimes`.

```ts
import {
  createWorker,
  LocalExecutionEnvironmentProvider,
  LocalWorklet,
  type WorkerProfile,
} from "supertag-ai";
import { ExampleHarness } from "./example-harness.js";

const harness = new ExampleHarness();
const environment = new LocalExecutionEnvironmentProvider();

export const profile: WorkerProfile = {
  ref: { id: "example", revision: "1" },
  workerType: "supertag",
  harness: { provider: harness.id },
  execution: {
    provider: environment.id,
    lifetime: { scope: "attempt" },
  },
  instructions: [
    {
      id: "example-system-instruction",
      kind: "instruction",
      required: true,
      scope: "task",
      priority: 0,
      content: "Answer clearly and state when the available evidence is insufficient.",
    },
  ],
  limits: { timeoutMs: 120_000 },
};

const worker = createWorker({
  id: "example-worker",
  profiles: [profile],
  harnesses: [harness],
  environments: [environment],
  maxConcurrency: 1,
});

export const worklet = new LocalWorklet("example-worklet", "example-worker-host", [worker]);
```

The Worklet ID identifies the supervisor and its transport connection. The Worker Host ID
identifies the execution location and capacity that the supervisor reports.

The three identities must agree:

- `profile.harness.provider` equals `harness.id`;
- `profile.execution.provider` equals `environment.id`;
- the Worker Profile selected for the **Task Attempt**, one execution or retry of a Task, equals
  `profile.ref`, including its revision.

This minimal example accepts trusted profile instructions and automatic prior work from the same
**Session**, the group of Tasks from one conversation. To support **Skills**, reusable packages of
instructions and supporting files, operational workspaces, or permission-derived tools, add the matching registry;
see [Resolver registries](../reference/worker.md#resolver-registries).

## 3. Run the conformance probe

Run the reusable conformance probe in your own test runner before you connect to a Control Plane.
This example checks the harness against a prepared local environment.

```ts
import { LocalExecutionEnvironmentProvider } from "supertag-ai";
import { emptyTagContextPlan } from "supertag-ai/core";
import { assertConformance, runHarnessConformance } from "supertag-ai/testing";
import { InMemorySessionStateStore, type TaskAttemptSpec } from "supertag-ai/worker";
import { ExampleHarness } from "./example-harness.js";
import { profile } from "./worker.js";

const capturedAt = new Date().toISOString();
const tag = { id: "example-tag", name: "Example" };
const attempt: TaskAttemptSpec = {
  version: 2,
  taskId: "example-task",
  attemptId: "example-attempt",
  tag,
  input: {
    origin: {
      surface: "slack",
      accountId: "example-account",
      scope: "channel:example",
      sessionKey: "example-session",
      occurredAt: capturedAt,
    },
    messages: [{ id: "message-1", role: "requester", text: "Hello" }],
  },
  authorization: {
    version: 5,
    capturedAt,
    tag,
    origin: {
      tagRouteId: "route-1",
      surfaceAccountId: "example-account",
      provider: "slack",
      scope: "channel:example",
    },
    requester: { id: "user-1", kind: "user" },
    permissionSets: [],
    resources: [],
    runtimeActions: [],
  },
  contextPlan: emptyTagContextPlan(capturedAt),
  workspacePlan: { version: 1, status: "none" },
  execution: {},
  // Must name a profile that the Worker advertises.
  workerProfile: { id: "example", revision: "1" },
};

const harness = new ExampleHarness();
const context = {
  attempt,
  profile,
  inputs: [],
  context: { instructions: [], skills: [], history: [], resources: [] },
  tools: [],
  secrets: [],
  sessionStates: [],
  extensions: [],
  sessionStateStore: new InMemorySessionStateStore(),
};
const plan = await harness.plan(context);
const provider = new LocalExecutionEnvironmentProvider();
const environment = await provider.provision({ task: attempt, profile, plan: plan.execution });
await environment.prepare(plan.execution);
try {
  assertConformance(
    await runHarnessConformance({
      harness,
      context,
      executionEnvironment: environment,
      verifyCancellation: true,
    }),
  );
} finally {
  await environment.dispose("completed");
}
```

`supertag-ai/testing` also contains probes for Workers,
[collaboration surfaces](../reference/glossary.md#collaboration-surface), execution environments,
[Tool Providers](../reference/glossary.md#tool-provider),
[Tool Adapters](../reference/glossary.md#tool-adapter), and Worklet transport negotiation. See
[Conformance probes](../reference/worker.md#conformance-probes) for what each probe checks and for
the published wire schemas.

## 4. Connect the Worklet

Both custom harnesses and full custom Workers use the same `Worklet` transport:

```ts
import { connectWorklet } from "supertag-ai";
import { worklet } from "./worker.js";

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function workletEndpoint(input: string): string {
  const url = new URL(input);
  if (url.protocol === "http:") url.protocol = "ws:";
  else if (url.protocol === "https:") url.protocol = "wss:";
  else if (url.protocol !== "ws:" && url.protocol !== "wss:") {
    throw new Error("Control Plane URL must use HTTP(S) or WS(S)");
  }
  if (url.pathname === "/" || url.pathname === "") url.pathname = "/worklets";
  return url.toString();
}

const connection = await connectWorklet({
  url: workletEndpoint(process.env.SUPERTAG_CONTROL_PLANE_URL ?? "http://127.0.0.1:3434"),
  credential: requiredEnvironment("SUPERTAG_WORKLET_TOKEN"),
  worklet,
  onConnected: () => console.log(`Worklet ${worklet.id} connected`),
  onDisconnected: () => console.warn("Control Plane disconnected; reconnecting"),
  onError: (error) => console.error("Worklet connection error", error),
});

await new Promise<void>((resolve) => {
  process.once("SIGINT", () => resolve());
  process.once("SIGTERM", () => resolve());
});
await connection.stop();
```

Start the application with the credential from your secret manager. This example is JavaScript
already built from the TypeScript snippets above:

```sh
export SUPERTAG_CONTROL_PLANE_URL="http://127.0.0.1:3434"
export SUPERTAG_WORKLET_TOKEN="the-enrolled-host-token"
node /absolute/path/to/custom-worker.mjs
```

`connectWorklet` waits for the first successful registration and returns a persistent
`WorkletConnection`. The connection sends heartbeats, reconnects after transient disconnects,
forwards cancellation, and streams Task Attempt events back through the Worklet API.

To change a running Worker's concurrency, call `setWorkerConcurrency(limit)` on a `LocalWorklet`,
then `connection.heartbeat()`. The heartbeat carries the new limit, so the Control Plane schedules
against it without a reconnect. A lower limit never stops a running Task Attempt. The Control
Plane keeps the previous limit when the new one is above 1,000 per Worker or 10,000 per Worker
Host, the same limits it applies when a Worklet connects.

## Check that it worked

- The conformance probe in step 3 finishes without an error from `assertConformance`.
- The application logs `Worklet example-worklet connected`.
- `supertag describe worker-host example-worker-host` lists your Worker and its profile:

  ```text
  Worker: example-worker (supertag)
    Profile: example@1
  ```

## Select execution for a Task

Create a Tag independently of its execution placement, then bind it to a collaboration channel using the relevant [collaboration surface guide](../surfaces/README.md):

```sh
supertag create tag engineering
```

Tasks carry `execution` requirements. Use `execution.profile: { id: "example", revision: "1" }`
when a Task needs an exact recipe. Otherwise the Control Plane selects a compatible connected
Worker. Each accepted Task Attempt records its concrete `workerProfile`, which stays fixed for that
Task Attempt. See [Execution requirements](../concepts/tasks.md#execution-requirements) for the full
shape.

## Implement a full Worker

Implement `Worker` directly when the standard component composition does not fit your execution
system.

### 1. Write the Worker

```ts
import {
  defaultTaskResult,
  TASK_ATTEMPT_EVENT_STREAM_CAPABILITY,
  type TaskAttemptEvent,
  type TaskAttemptSpec,
  type Worker,
  type WorkerDescriptor,
} from "supertag-ai";

const profile = { id: "custom-system", revision: "1" } as const;

export class CustomWorker implements Worker {
  async describe(): Promise<WorkerDescriptor> {
    return {
      id: "custom-system-worker",
      type: "custom-system",
      capabilities: [TASK_ATTEMPT_EVENT_STREAM_CAPABILITY],
      profiles: [profile],
      contextTypes: [],
      maxConcurrency: 1,
    };
  }

  async *execute(
    spec: TaskAttemptSpec,
    signal?: AbortSignal,
  ): AsyncIterable<TaskAttemptEvent> {
    const identity = { taskId: spec.taskId, attemptId: spec.attemptId };
    const at = () => new Date().toISOString();
    yield {
      type: "execution.started",
      ...identity,
      at: at(),
      workerId: "custom-system-worker",
    };

    try {
      if (
        spec.workerProfile.id !== profile.id ||
        spec.workerProfile.revision !== profile.revision
      ) {
        throw new Error(
          `Unsupported Worker Profile ${spec.workerProfile.id}@${spec.workerProfile.revision}`,
        );
      }
      if (signal?.aborted) {
        throw signal.reason instanceof Error ? signal.reason : new Error("Task cancelled");
      }

      const question = spec.input.messages.findLast(
        (message) => message.role === "requester",
      )?.text;
      if (question === undefined) throw new Error("The Task has no requester message");

      // Replace this with your execution system. Pass `signal` through to it.
      const text = `Custom Worker received: ${question}`;
      yield {
        type: "output.message",
        ...identity,
        at: at(),
        message: { role: "teammate", text },
      };
      yield { type: "result", ...identity, at: at(), result: defaultTaskResult(text) };
      yield { type: "execution.completed", ...identity, at: at() };
    } catch (error) {
      yield {
        type: "execution.failed",
        ...identity,
        at: at(),
        error: {
          name: error instanceof Error ? error.name : "Error",
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }
  }
}
```

The Worker receives immutable authorization and Context Plan snapshots, but SuperTag does not
interpret them on its behalf. Enforce those boundaries before reading context, mounting
resources, exposing tools, or performing external actions. Scheduling matches the Task's requested
profile, harness ID, and capabilities, not the `type` label; see
[Worker](../reference/worker.md#worker).

### 2. Put it in a Worklet

Connect it with the transport code from [step 4](#4-connect-the-worklet):

```ts
import { LocalWorklet } from "supertag-ai";
import { CustomWorker } from "./custom-worker.js";

export const worklet = new LocalWorklet(
  "custom-system-worklet",
  "custom-system-host",
  [new CustomWorker()],
);
```

### 3. Check the Worker contract

Use the `attempt` fixture from [step 3](#3-run-the-conformance-probe) with
`workerProfile: { id: "custom-system", revision: "1" }`:

```ts
import { assertConformance, runWorkerConformance } from "supertag-ai/testing";
import { CustomWorker } from "./custom-worker.js";

assertConformance(await runWorkerConformance({ worker: new CustomWorker(), attempt }));
```

`runWorkerConformance` also accepts an optional `failureAttempt`, which must end in
`execution.failed`, and a `liveCancellationAttempt` for the cancellation check. The Python SDK
takes the same Task Attempt as a wire dictionary:

```python
from supertag import assert_conformance, run_worker_conformance

assert_conformance(await run_worker_conformance(worker, attempt))
```

## Preserve generated files

Keep files a harness produces after its execution environment is removed.

### 1. Configure an artifact store

An **artifact** is a captured output file whose catalog entry identifies the Task that produced it.
The Control Plane stores no artifact bytes, so the Worker Host keeps them. Without an
`artifactStore`, a Worker stores no artifacts. Pass a `WorkletArtifactStore` that keeps copies in a
private `directory` on the Worker Host, or in `copies` you supply. Its `publish` callback records
each stored copy in the catalog, and its `resolve` callback asks for authorized download locations:

```ts
import { createWorker, WorkletArtifactStore } from "supertag-ai/worker";

const worker = createWorker({
  id: "builder",
  profiles,
  harnesses,
  environments,
  artifactStore: (attempt) => {
    const coordination = attempt.coordination;
    if (!coordination) throw new Error("Coordination configuration required");
    const post = async (path: string, body: unknown) => {
      const response = await fetch(new URL(path, coordination.controlPlaneUrl), {
        method: "POST",
        headers: {
          authorization: `Bearer ${coordination.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        redirect: "error",
      });
      if (!response.ok) throw new Error(`Artifact catalog request failed (${response.status})`);
      return response.status === 204 ? undefined : response.json();
    };
    return new WorkletArtifactStore({
      directory: "/var/lib/builder/artifacts",
      publish: async ({ ref, sizeBytes }) => {
        await post("/internal/v1/artifacts/catalog/upload", { digest: ref.digest, sizeBytes });
      },
      resolve: (ref) =>
        post("/internal/v1/artifacts/catalog/resolve-transfer", {
          artifactId: ref.artifactId,
          path: ref.path,
        }),
    });
  },
});
```

The factory runs once per Task Attempt, keeping its credential separate from harness inputs. Keep the
directory on persistent storage outside the harness workspace. This example runs no transfer
server and records no copy in a **Volume**, a named storage location such as a bucket prefix or a
host directory. Consumers on other hosts cannot fetch its copies without a
reachable transfer server or a shared artifact Volume.

### 2. Declare outputs in the plan

```ts
// In your Harness.plan():
// outputs: [{ path: "workspace/dist/product.zip", mediaType: "application/zip" }]
```

Paths in `HarnessPlan.outputs` are relative to the execution environment root. For
`CodexHarnessOptions.outputs`, paths instead start at the Task workspace root; Codex maps them into
the environment. After successful execution, the Worker saves these files before disposing the
environment, emits `artifact.created`, and includes the saved references in the Task result.
Exports are explicit: SuperTag does not copy the entire workspace.

### 3. Reuse a saved file

Place the saved reference in a later harness plan's `mounts`, with a relative `destination`. The
Worker retrieves its bytes through the configured store and stages them before execution. Binary
files remain binary.

Check that it worked: `supertag events task TASK_ID` shows an `artifact.created` event, and the
Task result includes the saved reference.

A missing file or failed export fails the Task Attempt. Environment providers support export through
the optional `readBytes` method; providers without it reject declared exports. For store choices,
limits, and access rules, see
[Custom Worker integration](../reference/artifacts.md#custom-worker-integration) and
[Storage and limits](../reference/artifacts.md#storage-and-limits).

## Use a custom sandbox backend

An `ExecutionEnvironmentProvider` determines where workspace tools act. In a colocated profile it
also hosts the harness; a split profile chooses that host through `HarnessRuntimeProvider`. E2B is
an optional implementation, not the general sandbox interface.

### 1. Wrap your backend

TypeScript integrations can use `SandboxExecutionEnvironmentProvider` and implement its
`SandboxBackend` contract for their infrastructure:

```ts
import { SandboxExecutionEnvironmentProvider, type SandboxBackend } from "supertag-ai/worker";

export function companyEnvironment(backend: SandboxBackend) {
  return new SandboxExecutionEnvironmentProvider({ id: "company-sandbox", backend });
}
```

Your backend's `create` method returns an attempt-scoped sandbox with `mkdir`, `write`, `read`,
`makeReadOnly`, `start`, and `terminate` operations. A started process exposes `wait` and
`terminate`; streaming output arrives through the callback supplied to `start`. The backend
implements filesystem access, process execution, output streaming, and confirmed termination. The
provider handles workspace staging, path checks, output limits, cancellation, and disposal.

### 2. Register and select it

Pass the returned provider in `createWorker({ environments: [...] })` and select
`execution.provider: "company-sandbox"` in the Worker Profile.

Declare only network policies and filesystem protections the backend actually enforces;
SuperTag rejects unsupported requirements before the harness starts. Keep credentials in the
backend's local configuration, never in Worklet API Task messages or command-line flags.

Use the shipped [Modal adapter](modal-workers.md) for Modal sandboxes. For Daytona or internal
infrastructure, adapt the backend operations to that platform's SDK in your Worker application.
Custom Workers in other languages implement the same lifecycle through their own runtime; the
TypeScript backend callbacks are an SDK convenience, not a requirement to run a Node process.

For durable journals and cleanup recovery, see
[Durable Worklet execution](../reference/worker.md#durable-worklet-execution). For E2B, Claude
Code, Codex, and OpenCode behavior inside an environment, see
[Built-in harness behavior](../reference/worker.md#built-in-harness-behavior).

## Production checklist

- Use WSS and keep each Worker Host's `SUPERTAG_WORKLET_TOKEN` in its local secret manager.
- Give every Worker Profile an immutable revision; increment it when behavior or policy changes.
- Advertise only capabilities the implementation actually supports.
- Forward `AbortSignal` into SDK calls and child processes.
- Bound execution time, output size, filesystem access, and network access.
- Keep workspace and MCP credentials inside the Worker Host's secret boundary; never put secrets
  in profiles, Runtime Input Manifests, or events.
- Emit one terminal `execution.completed` or `execution.failed` event for every started Task Attempt.
- Use a durable `SessionStateStore` only when the harness can safely validate and resume its
  native state.
- Test disconnects, cancellation, unsupported required inputs, and profile mismatches before
  production use.

## If something goes wrong

- **The harness fails before it starts.** A required Runtime Input that the harness does not
  declare, or a missing resolver, fails the Task Attempt. See
  [Runtime Input kinds](../reference/worker.md#runtime-input-kinds).
- **Work is not dispatched to your Worker.** Check that the profile ID and revision match the Task
  and that each profile advertises its capabilities. See
  [Capabilities belong to executable profiles](../reference/worker.md#capabilities-belong-to-executable-profiles).
- **The Worklet keeps reconnecting or stops.** See
  [Worklet connection transports](../reference/worker.md#worklet-connection-transports) and
  [A remote Worklet keeps disconnecting](troubleshooting.md#a-remote-worklet-keeps-disconnecting).
- **A Worker Host stays at capacity after a forced kill.** See
  [the recovery procedure](troubleshooting.md#a-worker-host-stays-at-capacity-after-a-forced-kill).

## Next

- [Extend harness execution](harness-runtime.md) for split runtimes, live control, and profiles.
- [Worker reference](../reference/worker.md) for the complete contracts and placement model. The
  normative lifecycle rules are in the [Worker SPI](../../spec/worker-spi.md).
- [`examples/custom-worker`](../../examples/custom-worker) for a
  [Python](../../examples/custom-worker/worker.py) Worker, harness, and Environment Provider.
  The npm package does not include the examples.
- [Self-host SuperTag](self-hosting.md) for a production Control Plane.
