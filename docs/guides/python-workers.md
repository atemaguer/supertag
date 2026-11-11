# Build a Python Worker

Build and connect a **Worker**—the code that completes an accepted assignment, called a
**Task**—in Python. Use the Python SDK when that execution logic is easier to build in Python.

- A **harness** connects the Worker to a model or agent system.
- A **Tag** is a persistent AI actor with its own responsibilities and permissions, and Tags work
  in Teams: flat lists of member Tags. Together, your Teams of Tags make up an **autonomous organization**: Teams
  may pursue different goals but share one set of rules and one record of the work.
- A Python **Worklet** supervises the Workers and connects them to the **Control Plane**, the
  service that stores and coordinates the organization.
- A **Worker Host** is the machine or sandbox where the Worklet runs and provides execution
  capacity.
- A **Task Attempt** is one execution or retry of a Task.

Python and TypeScript Workers follow the same Task lifecycle. See the
[glossary](../reference/glossary.md) for other terms.

## Before you start

- Python 3.10 or newer.
- The [SuperTag CLI](../operations/install.md), installed from npm.
- An enrolled Worker Host and its credential. Enroll one with `supertag enroll worker-host`; see
  [Run a Worker](workers.md). This guide assumes the ID `echo-worker-host`.
- A Tag bound to that Worker Host, so it can receive Tasks:
  `supertag update tag TAG --add-worker-host echo-worker-host`. See
  [Bind the Tag to the host](workers.md#4-bind-more-tags).
- The Control Plane's API URL.

The SuperTag CLI launches and manages the Control Plane and SuperTag's built-in TypeScript Workers.
It does not launch SDK-built Python applications:

```sh
# SuperTag's built-in Codex Worker
export SUPERTAG_WORKLET_TOKEN='credential-for-this-enrolled-worker-host'
supertag connect worklet --transport websocket \
  --worklet-url https://control-plane.example.com \
  --worker-host WORKER_HOST_ID \
  --harness codex \
  --workspace /path/to/repository

# Your custom Python Worker application
python worker.py
```

This keeps the SDK a library. A custom Worker owns its Python entry point, dependencies,
configuration, logging, shutdown behavior, and deployment process just like any other Python
service.

## 1. Install the Python SDK

The SDK's Python distribution is named `supertag`. This guide documents version `0.2.0a9`,
Python's spelling of `0.2.0-alpha.9`.

Install it from PyPI. Pin this prerelease explicitly so pip selects the SDK that matches the CLI:

```sh
python -m pip install 'supertag==0.2.0a9'
```

Confirm the installed version:

```sh
python -c "from importlib.metadata import version; print(version('supertag'))"
```

It reports the matching release; installed metadata may spell it `0.2.0-alpha.9`.

## 2. Write the Worker

The recommended path is to compose a Worker from the shared components:

1. A **Worker Profile** chooses a harness and execution environment.
2. A **harness** describes what it accepts, creates an environment plan, and starts an execution.
3. An **environment provider** prepares the place where the harness runs.
4. **Runtime Input Providers** turn admitted **Context Sets** (reusable knowledge), workspace
   plans, and tools from **Permission Sets** (allowed actions) into typed Runtime Inputs.
5. The Worker owns input filtering, harness and environment orchestration, cancellation, cleanup, results, and session state promotion.

This keeps custom code focused on the parts that are actually different. The following `worker.py`
is complete. Its harness replies with the latest Task message, and it runs in the SDK's local
environment provider:

```python
import asyncio
import os

from supertag import (
    CancellationToken,
    DurableLocalWorklet,
    FileAttemptJournal,
    ExecutionConfiguration,
    ExecutionContext,
    HarnessCapabilities,
    HarnessEnvironmentAccesses,
    HarnessPlan,
    LocalExecutionEnvironmentProvider,
    LocalWorklet,
    ProviderConfiguration,
    WorkerOptions,
    WorkerProfile,
    WorkerProfileRef,
    WorkletConnection,
    create_worker,
)


class EchoExecution:
    def __init__(self, text: str) -> None:
        self._text = text

    async def run(self, cancellation: CancellationToken):
        cancellation.raise_if_cancelled()
        yield {"type": "output.message", "text": f"Received: {self._text}"}

    async def session_state(self):
        return None

    async def close(self) -> None:
        pass


class EchoHarness:
    id = "echo"

    async def describe(self) -> HarnessCapabilities:
        return HarnessCapabilities(
            id=self.id,
            version="1",
            input_kinds=(),
            streaming=True,
            cancellation=True,
            session_persistence="none",
            runtime_placements=("local",),
        )

    async def plan(self, context: ExecutionContext) -> HarnessPlan:
        return HarnessPlan()

    async def start(
        self,
        plan: HarnessPlan,
        environments: HarnessEnvironmentAccesses,
        context: ExecutionContext,
    ) -> EchoExecution:
        messages = context.attempt.input.get("messages", [])
        return EchoExecution(messages[-1]["text"] if messages else "")


environment_provider = LocalExecutionEnvironmentProvider()
profile = WorkerProfile(
    ref=WorkerProfileRef("echo", "1"),
    worker_type="echo",
    harness=ProviderConfiguration(EchoHarness.id),
    execution=ExecutionConfiguration(environment_provider.id),
)
worker = create_worker(
    WorkerOptions(
        id="echo-worker",
        profiles=(profile,),
        harnesses=(EchoHarness(),),
        environments=(environment_provider,),
    )
)


async def main() -> None:
    worklet = DurableLocalWorklet(
        LocalWorklet("echo-worklet", "echo-worker-host", (worker,)),
        FileAttemptJournal("./worker-state/echo-worklet"),
    )
    connection = WorkletConnection(
        os.environ["SUPERTAG_CONTROL_PLANE_URL"],
        os.environ["SUPERTAG_WORKLET_TOKEN"],
        worklet,
    )
    try:
        await connection.run()
    finally:
        await connection.stop()
        await worklet.shutdown()


if __name__ == "__main__":
    asyncio.run(main())
```

Each part has one job:

- The harness declares an `id` and implements `describe()`, `plan()`, and `start()`. `start()`
  returns an execution whose `run()` yields events, plus `session_state()` and `close()`.
- The Worker Profile's `ref` is the profile ID and revision the Worker advertises. Its `harness`
  names a harness `id`, and its `execution` names an environment provider `id`.
  `LocalExecutionEnvironmentProvider` has the ID `local-execution` and creates a fresh temporary
  directory for each Task Attempt.
- `create_worker` returns an ordinary Worker. The Worker adds the start, result, and completion
  events around the harness output.

## 3. Run the Worker

The second `LocalWorklet` argument must be the ID you enrolled with `supertag enroll worker-host`;
the example assumes `echo-worker-host`. Run it with that Worker Host's credential in the
environment:

```sh
export SUPERTAG_WORKLET_TOKEN='credential-for-this-enrolled-worker-host'
export SUPERTAG_CONTROL_PLANE_URL='https://control-plane.example.com'
python worker.py
```

`run()` keeps the Worklet connected and reconnects after a dropped connection.

## Check that it worked

Confirm that the Control Plane recorded the Worker:

```sh
supertag describe worker-host echo-worker-host
```

It lists the `echo-worklet` Worklet and the `echo-worker` Worker with profile `echo@1`. A Task
routed to this host completes with the output `Received:` followed by the latest Task message.

## Connection rules

`LocalWorklet(worklet_id, worker_host_id, workers)` groups one or more Workers. `worker_host_id`
must match the enrolled Worker Host that owns the credential; otherwise authentication fails.
`WorkletConnection(control_plane_url, credential, worklet)` connects that Worklet outward.
`run()` keeps it connected and reconnects after a dropped connection. `stop()` closes it.

The Python SDK always connects over WebSocket; it has no gRPC transport. The `supertag connect
worklet` command defaults to gRPC for HTTP(S) URLs, but that default does not apply here. Point
the Python Worklet at the Control Plane's API URL, which serves the WebSocket Worklet API:

| URL you pass | Connection |
| --- | --- |
| `https://host` or `wss://host` | `wss://host/worklets` |
| `http://host` or `ws://host` | `ws://host/worklets`, loopback hosts only |

The SDK appends `/worklets` unless the path already ends with it. Remote hosts must use HTTPS or
WSS. The URL must not contain credentials, query parameters, or a fragment.

## Optional: Use a built-in Python harness

### 1. Install the integration

The SDK provides two optional OpenAI integrations. Install the one your Worker uses, or install
both while comparing them:

```sh
python -m pip install 'supertag[codex]==0.2.0a9'
python -m pip install 'supertag[agents]==0.2.0a9'
python -m pip install 'supertag[codex,agents]==0.2.0a9'
```

### 2. Run the Codex or Agents SDK Worker

Choose the Codex harness when the Worker needs Codex's coding-agent runtime, native repository
workflow, and thread continuity. Sign in to Codex once, then run the repository's
[`codex_worker.py`](../../sdks/python/examples/codex_worker.py) application:

```sh
export SUPERTAG_WORKLET_TOKEN='credential-for-this-enrolled-worker-host'
export SUPERTAG_CONTROL_PLANE_URL='https://control-plane.example.com'
export SUPERTAG_WORKER_WORKSPACE='/path/to/repository'
python codex_worker.py
```

Choose the OpenAI Agents harness when the Worker needs a general agent loop that can be extended
with Agents SDK tools, handoffs, guardrails, or a custom model provider. Provide an API key and run
[`openai_agents_worker.py`](../../sdks/python/examples/openai_agents_worker.py):

```sh
export OPENAI_API_KEY='your-api-key'
export SUPERTAG_WORKLET_TOKEN='credential-for-this-enrolled-worker-host'
export SUPERTAG_CONTROL_PLANE_URL='https://control-plane.example.com'
export SUPERTAG_WORKER_WORKSPACE='/path/to/repository'
python openai_agents_worker.py
```

Both Worklets connect outward to `/worklets`, receive Tasks, and return streamed Task Attempt
events. The Codex Worker advertises `codex@1`; the Agents SDK Worker advertises
`openai-agents@1`. Neither Worker Host needs a public inbound port.

### What each built-in harness does

The SDK's Codex harness:

- uses OpenAI's official `openai-codex` Python SDK;
- reuses the Worker Host's existing Codex authentication;
- runs with read-only workspace access and denied approval requests;
- includes bounded history from the **Session** (the Tasks from one conversation) and allowlisted
  **Skills** (reusable instruction packages) in the turn input;
- fails closed when a tool for a **collaboration surface**, such as Slack or GitHub, cannot be enforced at the per-call policy boundary;
- interrupts the active Codex turn when the Control Plane cancels a Task; and
- stores opaque thread session state under `~/.supertag/workers/python-codex/` for Session continuity.

The Codex harness uses the local, read-only execution environment. The same Worker contract supports other harnesses or custom remote and managed environment providers. The local provider is attempt-scoped and does not itself enforce network isolation.

The OpenAI Agents harness:

- uses OpenAI's official `openai-agents` Python SDK and streams Responses API output;
- exposes a path-contained, read-only workspace file tool;
- includes bounded Session history, instructions, and allowlisted Skills;
- cancels the active Agents SDK run when the Control Plane cancels the Task;
- stores portable Agents SDK Session items in SuperTag's session state store;
- disables Agents SDK tracing by default so collaboration content is not copied to a separate
  trace; and
- does not expose shell, browser, write, or collaboration surface tools until a policy-enforcing adapter admits
  them.

The Agents SDK is a harness implementation, not a replacement for SuperTag's Worker contract.
SuperTag still owns Task admission, Context and Permission resolution, cancellation, session state
promotion, and Worklet API transport. The Agents SDK owns the model loop inside that boundary.

## Optional: Add Context, workspace, and tool inputs

To give the harness context, workspace, or tool inputs, add Runtime Input Providers to
`WorkerOptions`. The SDK ships one registry for each kind; you supply the resolvers they hold:

```python
from supertag.context import ContextResolverRegistry, WorkspaceResolverRegistry
from supertag.tools import ToolProviderRegistry

runtime_input_providers=(
    ContextResolverRegistry((your_context_resolver,)),
    WorkspaceResolverRegistry((your_workspace_resolver,)),
    ToolProviderRegistry((your_tool_provider,)),
),
```

Each specialized registry implements the same `RuntimeInputProvider` protocol while preserving its own authority boundary. A custom provider must declare a stable `id` and one scope: `context`, `workspace`, `authorization`, or `custom`. Python-facing fields use `snake_case`; camelCase appears only in encoded Worklet API messages.

A Context Resolver also declares its namespaced `type` and supported integer `versions`. The Worker advertises those contracts so the Control Plane can avoid assigning required Context Items to an incompatible Worker Host. See [Add a custom Context type](custom-context.md) for a complete example.

## Keep Task Attempts across restarts

### 1. Wrap the Worklet in a durable journal

Protocol 18 requires a `DurableLocalWorklet`. It records accepted Task Attempts in a persistent
`FileAttemptJournal` directory. The quickstart uses `./worker-state/echo-worklet`, which is relative to the
directory you start the Worklet from: start it from the same directory each time, or use an
absolute path, so restarts reuse the journal. To use another persistent location, configure it as follows:

```python
from supertag import DurableLocalWorklet, FileAttemptJournal, LocalWorklet, WorkletConnection

worklet = DurableLocalWorklet(
    LocalWorklet("echo-worklet", "echo-worker-host", (worker,)),
    FileAttemptJournal("/private/worker-state/attempts"),
)
connection = WorkletConnection(
    os.environ["SUPERTAG_CONTROL_PLANE_URL"],
    os.environ["SUPERTAG_WORKLET_TOKEN"],
    worklet,
)
await connection.start()
# Keep the application running. On intentional host shutdown:
await connection.stop()
await worklet.shutdown()
```

The journal directory must belong to the current user with permissions `0700`. Preserve it across
restarts. Durable journals require a POSIX host. See the
[Python SDK README](../../sdks/python/README.md#durable-worklets) for restart and recovery behavior,
and [Scheduling and interrupted execution](../reference/scheduling-and-recovery.md#leases-and-unknown-outcomes)
for how the Control Plane treats interrupted Task Attempts.

## Optional: Implement the Worker boundary directly

An advanced implementation may instead implement the language-neutral Worker boundary directly. It has two operations:

1. `describe()` tells the Control Plane which profiles and capabilities the Worker supports.
2. `execute(attempt, cancellation)` streams ordered Task Attempt events and ends with exactly one completion or failure event.

## Optional: Test the Worker

Use `run_worker_conformance()` to test lifecycle, identity, event ordering, and cancellation. The schemas and fixtures under [`spec/`](../../spec) remain the language-neutral source of truth.

## Optional: Call the operator API

A Python application can also manage the Control Plane through the operator API. Use it to send
a Tag a message, read the inbox, or watch events. Install the client with the `operator` extra.

```sh
python -m pip install 'supertag[operator]==0.2.0a9'
```

Then call an RPC with the admin token or an
[Operator Token](../reference/glossary.md#operator-token), a named credential for one teammate or
machine:

```python
from supertag.operator import OperatorClientSync
from supertag.operator.v1 import organization_pb2

with OperatorClientSync(
    "https://control-plane.example.com", "admin-token-or-operator-token"
) as client:
    status = client.organization.get_status(organization_pb2.GetStatusRequest())
```

`OperatorClient` is the asynchronous form. The clients and messages come from the same protos as
the CLI's. See [Call the operator API](../../sdks/python/README.md#call-the-operator-api) for
streams and errors, and the
[operator API reference](../reference/operator-api/README.md) for every
RPC.

## If something goes wrong

- **Authentication fails.** The second `LocalWorklet` argument must match the enrolled Worker Host
  that owns the credential; see [Connection rules](#connection-rules).
- **The connection URL is rejected.** Remote hosts must use HTTPS or WSS, without credentials,
  query parameters, or a fragment; see [Connection rules](#connection-rules).
- **`pip` installs an older SDK.** Pin `supertag==0.2.0a9` as in
  [step 1](#1-install-the-python-sdk). pip does not select this prerelease by default.
- **The Worklet keeps reconnecting.** See
  [A remote Worklet keeps disconnecting](troubleshooting.md#a-remote-worklet-keeps-disconnecting).

## Next

- [Add a custom Context type](custom-context.md) for a complete Context Resolver example.
- [Worker reference](../reference/worker.md) for the language-neutral Worker contract.
- [Python SDK README](../../sdks/python/README.md#durable-worklets) for durable restart behavior.
- [Call the operator API](../../sdks/python/README.md#call-the-operator-api) from Python.
