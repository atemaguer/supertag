# Custom Worker examples

These intentionally small examples show custom SuperTag extension points using
only published SDK entry points. Custom Workers are ordinary applications
launched by their language runtime; the JavaScript verification also exercises
a custom harness and execution Environment Provider.

## JavaScript

```sh
npm install
npm run verify
```

The JavaScript package contains:

- `worker.mjs` — a direct Worker implementation;
- `harness.mjs` — a harness that plans and produces a result;
- `environment.mjs` — an attempt-scoped Environment Provider; and
- `verify.mjs` — Worker, harness, and environment conformance checks.

The environment is deliberately small and local. It demonstrates the lifecycle
and path boundary, not a production sandbox; a real provider must enforce its
own network, mount, and secret policies.

SuperTag's package validation installs the freshly packed npm tarball into a
temporary copy of this example. That prevents private workspace imports or
unpublished source paths from making the example pass accidentally.

## Python

Create a virtual environment, install the published Python SDK, and run the
verification with Python:

```sh
python -m venv .venv
source .venv/bin/activate
python -m pip install supertag
python verify.py
```

The Python files mirror the JavaScript extension points:

- `worker.py` — a direct Worker implementation;
- `harness.py` — a harness that creates a result from an approved input file;
- `environment.py` — an attempt-scoped Environment Provider; and
- `verify.py` — Worker, harness, and environment conformance checks.

They deliberately have no custom Worker CLI wrapper; deployment can use
`python`, a package script, a process manager, or a container entrypoint.
