# SuperTag Python SDK

## Install and start a Worker

Build Python Workers and connect them to a persistent SuperTag Control Plane. The SDK implements
the same language-neutral Worker boundary as the TypeScript SDK:

- Worker Host, Worklet, and Worker descriptors
- protocol 18 Worker Host credential authentication, placement reservations, and durable delivery
- outbound, reconnecting WebSocket transport
- heartbeats, concurrent Task Attempts, and cancellation
- ordered Task Attempt events
- the standard Worker lifecycle and typed execution context
- context, workspace, tool, environment, and continuity extension points
- MCP over HTTP and stdio extension contracts for custom harnesses and Tool Adapters
- reusable conformance checks
- a Codex harness powered by the official `openai-codex` SDK
- an OpenAI Agents harness powered by the official `openai-agents` SDK

It also includes a client for the operator API that the CLI uses; see
[Call the operator API](#call-the-operator-api).

For the SuperTag CLI and Control Plane, see [Requirements](../../docs/operations/requirements.md).
Python Worker dependencies are declared separately in [pyproject.toml](pyproject.toml).

Install the published SDK from PyPI. Pin this prerelease explicitly:

```sh
python -m pip install 'supertag==0.2.0a8'
```

Install either harness integration, or both:

```sh
python -m pip install 'supertag[codex]==0.2.0a8'
python -m pip install 'supertag[agents]==0.2.0a8'
python -m pip install 'supertag[codex,agents]==0.2.0a8'
```

The distribution and import namespace both use the product name:

```python
from supertag import (
    CodexHarness,
    CodexWorker,
    LocalWorklet,
    OpenAIAgentsHarness,
    OpenAIAgentsWorker,
    WorkletConnection,
)
```

For source development, see [CONTRIBUTING.md](../../CONTRIBUTING.md).

The SDK is a library and does not install a Worker CLI. SuperTag's built-in Codex and Claude Code
Workers are TypeScript implementations launched with `supertag connect worklet`. A custom Python
Worker is an ordinary Python application launched with `python`, a package script, a container
command, or a process supervisor.

The repository includes two complete Python Worker applications:

- [`examples/codex_worker.py`](https://github.com/atemaguer/supertag/blob/main/sdks/python/examples/codex_worker.py)
  uses an existing Codex sign-in and Codex's native coding-agent runtime.
- [`examples/openai_agents_worker.py`](https://github.com/atemaguer/supertag/blob/main/sdks/python/examples/openai_agents_worker.py)
  uses `OPENAI_API_KEY`, the OpenAI Agents SDK, a bounded workspace-read tool, and portable Session
  history stored through SuperTag's Session storage interface. SDK tracing is disabled by default so collaboration
  content is not copied into a separate trace.

```sh
export SUPERTAG_WORKLET_TOKEN='credential-for-this-enrolled-worker-host'
export SUPERTAG_CONTROL_PLANE_URL='https://control-plane.example.com'
export SUPERTAG_WORKER_WORKSPACE='/path/to/repository'
python examples/codex_worker.py

# Or use the general OpenAI Agents SDK Harness.
export OPENAI_API_KEY='your-api-key'
python examples/openai_agents_worker.py
```

The Worklet token stays in the environment instead of the command line. The Worklet connects
outward from its Worker Host, so the host does not need a public inbound port.
The examples store their journals in `<state directory>/python-worklets/<worklet-id>`, where the
state directory is `SUPERTAG_STATE_DIR` when set, otherwise `~/.supertag`.
Keep each journal across restarts; run only one application per journal.

## Call the operator API

The operator API is how the CLI and other tools manage a Control Plane: send a Tag a message,
read the inbox, or apply resources. The Control Plane serves it as RPCs defined in
protobuf, in the package `supertag.operator.v1`. A Tag is a persistent AI actor with its own
responsibilities and permissions. The
[operator API reference](../../docs/reference/operator-api/README.md) lists
every RPC.

The `operator` extra installs the client and its dependencies, `connect-python` and `protobuf`.

```sh
python -m pip install 'supertag[operator]==0.2.0a8'
```

`OperatorClient` calls the services asynchronously, and `OperatorClientSync` calls them
synchronously. Each has one attribute per service: `access`, `conversation`, `event`, `host`,
`inbox`, `mailbox`, `objective`, `organization`, `resource`, `surface`, `team`, and `work`. Pass
the Control Plane URL and the admin token or an
[Operator Token](../../docs/reference/glossary.md#operator-token), a named credential for one
teammate or machine:

```python
import os

from supertag.operator import OperatorClientSync
from supertag.operator.v1 import organization_pb2

with OperatorClientSync(
    os.environ["SUPERTAG_CONTROL_PLANE"], os.environ["SUPERTAG_OPERATOR_TOKEN"]
) as client:
    status = client.organization.get_status(organization_pb2.GetStatusRequest())
    print(organization_pb2.ControlPlanePhase.Name(status.phase))
```

It prints `CONTROL_PLANE_PHASE_ACCEPTING` while the Control Plane accepts new work.

The client sends each call as a Connect request with a JSON body over plain HTTPS, so it works
through ordinary proxies, and sends the token as `authorization: Bearer TOKEN`. It uses only the
URL's scheme, host, and port. Leave the token out for an RPC that accepts anonymous calls.

Request and response messages come from the protos. Each proto file has a module of messages,
such as `supertag.operator.v1.conversation_pb2`, and a module of service clients, such as
`supertag.operator.v1.conversation_connect`. Method names are the RPC names in `snake_case`:
`ConversationService.FollowMessage` is `client.conversation.follow_message`.

Calls have no deadline. Pass `timeout_ms` to bound one call. The two server streams,
`conversation.follow_message` and `event.watch`, are iterators that yield each event until the
stream ends. Both send a heartbeat after 15 seconds without another event. To stop following
early, close the iterator with `await stream.aclose()`, or `stream.close()` with
`OperatorClientSync`; that cancels the call.

[`examples/message_tag.py`](https://github.com/atemaguer/supertag/blob/main/sdks/python/examples/message_tag.py)
sends a Tag a message and prints the reply as the Tag writes it:

```sh
export SUPERTAG_CONTROL_PLANE='https://control-plane.example.com'
export SUPERTAG_OPERATOR_TOKEN='admin-token-or-operator-token'
python examples/message_tag.py TAG 'What changed in the last release?'
```

A refused call raises `ConnectError` with a `code`, such as `Code.PERMISSION_DENIED`, and a
`message` for people. `error_detail(error)` returns its `ErrorDetail`, whose stable `reason` is
what code should branch on:

```python
from supertag.operator import ConnectError, error_detail
from supertag.operator.v1 import common_pb2, inbox_pb2

try:
    items = client.inbox.list_inbox_items(inbox_pb2.ListInboxItemsRequest())
except ConnectError as error:
    detail = error_detail(error)
    if detail is not None and detail.reason == common_pb2.ERROR_REASON_DRAINING:
        ...  # The Control Plane is shutting down; retry against its replacement.
    raise
```

See [RPC errors](../../docs/reference/control-plane-api.md#rpc-errors) for each code and reason.

## Compose a custom Worker

For a custom implementation, call `create_worker(WorkerOptions(...))` with Worker Profiles,
harnesses, execution environment providers, and optional `RuntimeInputProvider` values. The
factory returns the ordinary `Worker` contract. A provider's `resolve()` method receives a
`ResolutionContext` and returns typed `RuntimeInput` values.
Each `HarnessPlan` separates private `runtime` staging from workspace `execution`
staging. A harness receives both accesses. Profiles omit a separate runtime by
default, so the Worker prepares and disposes one colocated environment.
`ContextResolver`, `WorkspaceResolver`, and `ToolProvider` are focused convenience
interfaces built on that primitive. A `ToolAdapter` turns an allowed `ToolInput` into the
configuration expected by a particular harness.
Python APIs use `snake_case`; the SDK translates to the Worklet API's camelCase protocol only
inside `from_wire()` and `to_wire()` boundaries.

### Session persistence and execution boundaries

Session persistence is also shared. Pass an `InMemorySessionStateStore` for an ephemeral
Worker or a `FileSessionStateStore` for local continuity. Harnesses receive the same store in
their `ExecutionContext`, so custom and built-in harnesses use one contract.

You may instead implement the `describe()` and `execute()` Worker boundary directly. Place one
or more Workers on a Worker Host supervised by `LocalWorklet`, connect it with
`WorkletConnection`, and run the conformance helpers before connecting to a Control Plane.

The built-in local environment provider is attempt-scoped and gives child processes only common
process-launch plumbing variables plus values explicitly projected by the provider or process
specification. The environment and workspace interfaces are designed for custom local, remote, or
managed providers; the SDK does not claim to enforce network isolation or provision a remote
sandbox by itself.

The Worker runtime redacts resolved credential values from sensitive ToolInput headers and
environment fields before harness events or failure messages cross the Worker transport boundary.
Custom harnesses remain responsible for protecting secrets in any storage they manage directly.

### Progress, tools, and schemas

Custom harnesses can emit `TaskProgress(...).event()` to provide a bounded progress summary and
checklist. Progress is a complete latest-wins snapshot, not a reasoning trace. Keep it to work a
teammate would naturally report: never include prompts, commands, tool arguments, credentials, or
runtime identifiers.

The Python Codex harness and OpenAI Agents harness fail closed when collaboration surface ToolInputs cannot be
enforced through SuperTag's per-call resource-policy boundary. The Agents harness currently exposes
only a path-contained, read-only workspace tool. Custom ToolProvider and ToolAdapter implementations
remain supported, but a custom harness must validate every tool call against the admitted operation,
action, account, and resource scope before invocation.

The JSON Schemas in the repository's `spec/` directory are the source of truth for every language implementation.

## Process lifecycle and custom environments

`HarnessRuntimeProvider` and `HarnessRuntime` describe where a harness process and its private state
live. `ExecutionEnvironmentProvider` and `ExecutionEnvironment` describe where workspace tools act.
These are vendor-neutral Python protocols, and a colocated profile may use one execution environment
for both roles. Custom applications can implement them for their own infrastructure without importing
a particular vendor SDK into the harness. A harness can require exact runtime capabilities through
`HarnessCapabilities.required_runtime_capabilities`; the Worker checks these before provisioning.

The local provider supports `supertag.process-output-streaming` version 1. Pass
`ProcessSpec(stream_output=True)` and consume `async for chunk in process.output()`; each chunk has
`stream` (`stdout` or `stderr`) and `text`. Unconsumed streaming output has a bounded buffer and fails
explicitly on overflow. Without streaming, the provider drains output while retaining bounded trailing
diagnostics. POSIX processes run in owned process groups; cancellation and timeouts escalate from
termination to kill before cleanup. Windows supports direct child termination, not POSIX group ownership.

An environment must raise `ExecutionCleanupError` when it cannot confirm cleanup. The composed Worker
then emits no execution terminal receipt, and the Python Worklet reports a non-retryable job error.
A durable Worklet records cleanup uncertainty as `unknown` and retains the exact Worker's capacity.
A plain legacy Worklet reports a non-retryable job error. Do not automatically retry an unresolved
external execution based on a missing completion.

## Durable Worklets

Wrap your application's `LocalWorklet` with `DurableLocalWorklet` before connecting to the API Server.
Python supports only Worklet protocol 18, including coordination and Session continuity:

```python
from supertag import DurableLocalWorklet, FileAttemptJournal, LocalWorklet, WorkletConnection

worklet = DurableLocalWorklet(
    LocalWorklet("my-worklet", "my-host", (worker,)),
    FileAttemptJournal("/private/worker-state/attempts"),
)
connection = WorkletConnection(control_plane_url, worker_host_credential, worklet)
await connection.start()
# Keep the normal Python application running. On intentional host shutdown:
await connection.stop()
await worklet.shutdown()
```

The journal uses SQLite WAL with synchronous commits and an exclusive POSIX file lock. Its directory
must belong to the current user with permissions `0700`; one supervisor owns it at a time. It stores
receipts, cancellation requests, and redacted ordered events, never execution specifications or
credentials. Preserve this directory on host restart. Windows durable journal locking is not yet
implemented; use a supported POSIX host.

Placement selection holds capacity for 30 seconds and returns a single-use reservation.
Acceptance validates and consumes that reservation, pinning execution to the selected Worker.
Releasing an unused placement frees its capacity immediately.
Acceptance reserves one exact Worker before acknowledgement. A repeated Task Attempt with the same
specification returns its existing receipt; conflicting specifications fail. On restart, unfinished
Task Attempts become `unknown` and retain their Worker reservations. They are never automatically reissued.
There is currently no journal API to release unknown reservations: reconcile the external execution
before any administrative recovery. Losing or replacing the journal loses this protection.

Control Plane disconnection stops only event subscriptions. Execution continues and outputs remain available
through `events(attempt_id, after_sequence)` after reconnect. Intentional `shutdown()` requests
cancellation and waits for Worker cleanup; custom Workers must honor the lifecycle contract.
`LocalWorklet` alone supports in-process execution. Remote connections require the durable wrapper.
Durable transport does not add harness tools, artifact stores, or coordination permissions.

## Captured Task outputs

A Task result names catalog artifacts and explicit file paths, rather than blob URLs.
For example, after a Task Attempt-authenticated catalog capture returns its manifest:

```python
from supertag import ArtifactSelection
from supertag.models import default_task_result

result = default_task_result("Research is ready for review")
result["artifacts"] = [ArtifactSelection(
    artifact_id=captured_manifest["id"],
    paths=("research/findings.md",),
).to_wire()]
```

The catalog verifies that the selected artifact belongs to the submitting Task Attempt. A custom
Worker must upload and capture its files before submitting this result; constructing a selection
does not store any bytes or grant access. Input attachments retain the selected `artifactId`,
entry `path`, immutable byte reference, and producer `provenance`. Consumers must preserve the
relative entry path and verify the digest. Python currently exposes these wire types but does not
supply the TypeScript Worker's automatic capture and materialization implementation.

The Python SDK uses `session_state` in Python interfaces and `sessionState` on the wire.
Native Session state travels over Worklet protocol 18. Python applications must supply their own
durable `SessionStateStore`; the built-in TypeScript Worker's automatic Control Plane storage
is not automatically wired into Python Workers. Local file storage survives a process restart
but does not by itself make native sessions portable between hosts.

`TaskAttemptSpec` preserves `session.persistence` connection details on the wire for custom
storage adapters. These credentials belong to the current Task Attempt and can grant only Session
storage access, independently of coordination tools. Keep them in Worker-side code; the standard
Worker redacts the token from normalized events and errors.
