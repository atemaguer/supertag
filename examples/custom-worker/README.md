# Python SDK execution interfaces

These intentionally small examples exercise the Python SDK's in-process execution interfaces,
using only the published SDK. A Worker Host runs custom execution only through a harness adapter;
see [Write a harness adapter](../../docs/guides/harness-adapters.md).

Create a virtual environment, install the published Python SDK, and run the
verification with Python:

```sh
python -m venv .venv
source .venv/bin/activate
python -m pip install supertag
python verify.py
```

The example contains:

- `worker.py` — an implementation of the SDK's in-process Worker interface;
- `harness.py` — a harness that creates a result from an approved input file;
- `environment.py` — an attempt-scoped Environment Provider; and
- `verify.py` — Worker, harness, and environment conformance checks.

The environment is deliberately small and local. It demonstrates the lifecycle
and path boundary, not a production sandbox; a real provider must enforce its
own network, mount, and secret policies.

These Worker interfaces run in process and do not connect to a Control Plane by
themselves. To run Tasks from a Worker Host, wrap them in a harness adapter with
`supertag.harness_adapter` and pass its executable to the Worker Host's
`--adapter` option; see the [Python SDK](../../sdks/python/README.md).
