# Run Python harnesses

Run a **Tag**'s work through Python: a persistent AI actor with its own responsibilities and
permissions receives an assignment, called a **Task**, and a **Worker Host**, the machine or
sandbox that provides execution, runs it through a **harness**, the code that connects the Task
to a model or agent system. A **Task Attempt** is one execution or retry of a Task.

A Worker Host runs Python harnesses in two ways:

- the built-in OpenAI Agents harness, `--harness openai-agents`;
- your own harness adapter, an executable that the Worker Host starts for each Task Attempt,
  `--adapter`.

Both use the Python SDK. Python applications can also call the **Control Plane**, the service that
stores and coordinates the organization, through the SDK's Control Plane client. See the
[glossary](../reference/glossary.md) for other terms.

## Before you start

- Python 3.10 or newer.
- The [SuperTag CLI](../operations/install.md).
- A host Auth Key from the operator, to enroll the Worker Host; see
  [Self-hosting](self-hosting.md).

## 1. Install the Python SDK

Pin this prerelease explicitly; pip does not select it by default:

```sh
python -m pip install 'supertag==0.2.0a9'
python -m pip install 'supertag[runtime]==0.2.0a9'
```

The `runtime` extra installs gRPC and protobuf, which the adapter and Control Plane clients need.
Add a harness integration when you use one:

```sh
python -m pip install 'supertag[codex]==0.2.0a9'
python -m pip install 'supertag[agents]==0.2.0a9'
python -m pip install 'supertag[codex,agents]==0.2.0a9'
```

## 2. Enroll the Worker Host

```sh
export SUPERTAG_AUTH_KEY=stak_...
supertag host enroll --control-plane https://supertag.example.com \
  --state-directory ~/.supertag-host python-host
```

Enrollment saves the host's own credential in the state directory, so later runs need no key.

## 3. Run the OpenAI Agents harness

```sh
export OPENAI_API_KEY='your-api-key'
supertag worker-host --control-plane https://supertag.example.com \
  --state-directory ~/.supertag-host --harness openai-agents \
  --harness-runtime /path/to/venv/bin/python
```

`--harness-runtime` names the Python interpreter whose environment has
`supertag[runtime,agents]`. The Worker Host starts `python -m supertag.openai_agents_adapter` for
each Task Attempt.

## 4. Or run your own adapter

Write an adapter with `supertag.harness_adapter`; the
[Python SDK README](../../sdks/python/README.md#run-a-python-harness-adapter-with-a-worker-host)
has a complete example. Then pass it to the Worker Host:

```sh
supertag worker-host --control-plane https://supertag.example.com \
  --state-directory ~/.supertag-host \
  --adapter /path/to/venv/bin/python --adapter-arg /path/to/adapter.py
```

The Worker Host writes a private execution bootstrap to the adapter's standard input. The adapter
attaches, publishes ordered events, and completes the Task Attempt; the Worker Host records the
outcome after the adapter exits successfully.

## Check that it worked

`supertag get hosts` lists `python-host` as ready. Send a Tag bound to the host a message; its
reply comes from your harness.

## Call the Control Plane from Python

`supertag.control_plane_client` connects an operator application to the Control Plane over gRPC;
see [Call the Control Plane](../../sdks/python/README.md#call-the-control-plane).

## Next

- [Python SDK README](../../sdks/python/README.md) for the adapter, Control Plane client, and
  in-process Worker composition.
- [Self-hosting](self-hosting.md) for Auth Keys and Worker Hosts.
