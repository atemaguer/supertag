# SuperTag Python SDK

Write harness adapters and Control Plane clients for SuperTag in Python. A **harness adapter**
connects an agent system to a SuperTag **Worker Host**, the machine or sandbox that runs a Tag's
work. A **Tag** is a persistent AI actor with its own responsibilities and permissions. The
package includes:

- `supertag.harness_adapter`, which connects an adapter to the Worker Host that launched it;
- an OpenAI Agents harness adapter, `python -m supertag.openai_agents_adapter`, powered by the
  official `openai-agents` SDK; and
- `supertag.control_plane_client`, a gRPC client for the Control Plane API that the CLI uses.

For the SuperTag CLI and Control Plane, see [Requirements](../../docs/operations/requirements.md).
The SDK's dependencies are declared in [pyproject.toml](pyproject.toml).

Install the published SDK from PyPI. Pin this prerelease explicitly:

```sh
python -m pip install 'supertag==0.2.0a9'
```

Harness adapters and the Control Plane client need the `runtime` extra; the OpenAI Agents
adapter also needs `agents`:

```sh
python -m pip install 'supertag[runtime,agents]==0.2.0a9'
```

For source development, see [CONTRIBUTING.md](../../CONTRIBUTING.md).

## Run a Python harness adapter

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

[Write a harness adapter](../../docs/guides/harness-adapters.md) describes the adapter
protocol and how a Worker Host launches an adapter.

## Call the Control Plane API

The Control Plane API is how the CLI and other tools manage a Control Plane: list Tags, read the
inbox, or apply resources. The Control Plane serves it as gRPC services defined in protobuf, in
the package `supertag.runtime.v2`; see the
[Control Plane API](../../docs/reference/control-plane-api.md).

Use `supertag.control_plane_client`. The `runtime` extra installs gRPC and protobuf.
This example lists Tags, the persistent AI actors in your organization.

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
