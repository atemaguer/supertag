# SuperTag Python SDK

The Python SDK has three parts:

- `supertag.harness_adapter`: write a harness adapter that a SuperTag Worker Host starts to run one
  Task Attempt.
- `supertag.openai_agents_adapter`: the OpenAI Agents harness adapter that a Worker Host starts for
  a Tag whose harness is `openai-agents`.
- `supertag.control_plane_client`: call a SuperTag Control Plane from Python.

It also contains the Worker composition interfaces (`create_worker`, harnesses, execution
environments, Runtime Inputs, and Session continuity) that the OpenAI Agents adapter is built on.

For the SuperTag CLI and Control Plane, see [Requirements](../../docs/operations/requirements.md).
Python dependencies are declared in [pyproject.toml](pyproject.toml).

Install the published SDK from PyPI. Pin this prerelease explicitly:

```sh
python -m pip install 'supertag[runtime]==0.2.0a9'
python -m pip install 'supertag[runtime,agents]==0.2.0a9'
```

The `runtime` extra installs gRPC and protobuf for the adapter and Control Plane clients; `agents`
installs the OpenAI Agents SDK. For source development, see [CONTRIBUTING.md](../../CONTRIBUTING.md).

## Run a Python harness adapter with a Worker Host

A Worker Host is the machine or sandbox that provides execution. It launches a harness
adapter to run one Task Attempt, which is a single try at completing a unit of work. Install
the SDK with its `runtime` extra. Pass the executable to the Worker Host through its
`--adapter` option.

```python
import asyncio
import sys

from supertag.harness_adapter import open_harness, runtime

async def main():
    async with open_harness(sys.stdin.buffer) as harness:
        run = await harness.client.Attach(runtime.HarnessAttachRequest(), timeout=5)
        result = f"Received work for {run.task.tag_id}"
        await harness.client.Publish(
            runtime.HarnessPublishRequest(sequence=1, text=result), timeout=5
        )
        await harness.client.Complete(
            runtime.HarnessCompleteRequest(succeeded=True, result=result), timeout=5
        )

asyncio.run(main())
```

The Worker Host supplies a private execution connection on standard input. It records the
outcome after the adapter exits successfully. Reuse the same sequence number and request
body when retrying an event.

The OpenAI Agents adapter runs as `python -m supertag.openai_agents_adapter`; the Worker Host starts
it for a Tag whose harness is `openai-agents`. It needs `OPENAI_API_KEY` and the `agents` extra.

## Call the Control Plane

Use `supertag.control_plane_client`. The `runtime` extra installs gRPC and protobuf. This example
lists Tags, the persistent AI actors in your organization.

```python
import os

from supertag.control_plane_client import ControlPlaneClientSync, runtime

with ControlPlaneClientSync(
    os.environ["SUPERTAG_CONTROL_PLANE_URL"], os.environ["SUPERTAG_OPERATOR_TOKEN"]
) as client:
    response = client.operator.ListTags(runtime.ListTagsRequest(), timeout=5)
    for tag in response.tags:
        print(tag.name)
```

`ControlPlaneClient` exposes the same services with `async with` and awaitable unary calls.
The generated gRPC methods use the protobuf RPC names, such as `ListTags` and `Watch`.
Pass a `timeout` in seconds to bound a call. Watch streams can resume from their last
`resume_token`. Use HTTPS for a remote Control Plane and a loopback IP address for local
cleartext. Pass a PEM `ca` for private TLS and a PEM certificate chain and key as
`identity=(cert, key)` if the Control Plane requires mutual TLS. The first call negotiates the
SuperTag protocol version with the Control Plane and raises `ControlPlaneProtocolError` when the
Control Plane runs an incompatible release.

## Compose a Worker in process

`create_worker(WorkerOptions(...))` composes Worker Profiles, harnesses, execution environment
providers, and optional `RuntimeInputProvider` values into the `Worker` contract, and
`LocalWorklet` runs Workers in the same process. The OpenAI Agents adapter uses them to run one
Task Attempt; they do not connect to a Control Plane by themselves.

Each `HarnessPlan` separates private `runtime` staging from workspace `execution` staging. A
harness receives both accesses. `ContextResolver`, `WorkspaceResolver`, and `ToolProvider` are
focused convenience interfaces built on Runtime Inputs. A `ToolAdapter` turns an allowed
`ToolInput` into the configuration expected by a particular harness. Pass an
`InMemorySessionStateStore` or a `FileSessionStateStore` for Session continuity.

The built-in local environment provider is attempt-scoped and gives child processes only common
process-launch plumbing variables plus values explicitly projected by the provider or process
specification. It supports `supertag.process-output-streaming` version 1: pass
`ProcessSpec(stream_output=True)` and consume `async for chunk in process.output()`. POSIX
processes run in owned process groups; cancellation and timeouts escalate from termination to kill
before cleanup. An environment must raise `ExecutionCleanupError` when it cannot confirm cleanup.

Custom harnesses can emit `TaskProgress(...).event()` to provide a bounded progress summary and
checklist. Progress is a complete latest-wins snapshot, not a reasoning trace: never include
prompts, commands, tool arguments, credentials, or runtime identifiers.
