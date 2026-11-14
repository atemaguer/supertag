# Custom Worker examples

These intentionally small examples show custom SuperTag extension points using
only the published Python SDK. Custom Workers are ordinary applications
launched by their language runtime.

Create a virtual environment, install the published Python SDK, and run the
verification with Python:

```sh
python -m venv .venv
source .venv/bin/activate
python -m pip install supertag
python verify.py
```

The example contains:

- `worker.py` — a direct Worker implementation;
- `harness.py` — a harness that creates a result from an approved input file;
- `environment.py` — an attempt-scoped Environment Provider; and
- `verify.py` — Worker, harness, and environment conformance checks.

The environment is deliberately small and local. It demonstrates the lifecycle
and path boundary, not a production sandbox; a real provider must enforce its
own network, mount, and secret policies.

They deliberately have no custom Worker CLI wrapper; deployment can use
`python`, a package script, a process manager, or a container entrypoint.
