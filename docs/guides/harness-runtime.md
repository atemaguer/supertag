# Extend harness execution

Add sessions, live control, split execution, and profile configuration to a custom harness. Use
this guide after [Build a custom Worker or harness](custom-workers.md) once the basic harness runs.

A **Task** is one accepted request or assignment, and a **Task Attempt** is one execution or retry
of it. A **Worker** is the code that completes Tasks. Its **harness** translates each Task Attempt
into work performed by an agent runtime. The **harness runtime** hosts the harness process and its
private state. The **execution environment** is where the harness's workspace tools read files and
run processes. A **Worker Host** is the machine or sandbox that provides execution capacity, and
its **Worklet** connects it to the **Control Plane**, the SuperTag service that schedules work. A
**Session** groups the Tasks from one conversation. See the [glossary](../reference/glossary.md)
for other terms.

## Before you start

- A working custom harness composed into a Worker, as in
  [Build a custom Worker or harness](custom-workers.md).
- The `supertag-ai` SDK. Import these extension contracts from `supertag-ai/worker`.
- The [harness lifecycle](../reference/worker.md#harness-lifecycle), which shows where each method
  runs.

## 1. Declare support in `describe()`

The SDK gives a harness two environment accesses: `runtime` hosts its process and private state,
while `execution` receives workspace file and process operations. The default profile supplies one
environment in both positions. To accept a split, advertise `splitExecution`. The built-in Claude
Code harness and Codex app-server mode support this arrangement.

Declare only the features you implement:

- **Session scope.** Set `local`, `environment`, `portable`, or `none`. For example, a harness may
  support native session state on a local machine while using bounded Session history replay in a
  fresh remote sandbox. Declare the difference instead of advertising native restoration for every
  placement.
- **MCP clients.** List supported client locations and transports in
  `HarnessCapabilities.mcpClients`: the harness runtime, the Worker Host, or the execution
  environment. See [Route MCP tools](mcp-tools.md) for the complete matrix.
- **Manager-only tools.** Tool inputs can declare `audience: "manager"`. A harness may accept that
  input only when it can keep the tool unavailable to native children. SuperTag's coordination
  input uses this audience.
- **Controls.** Declare supported live-control operations in `capabilities.control`, as in
  [step 3](#3-start-and-control-a-live-execution).
- **Execution limits.** Advertise the limits the harness enforces; see
  [Execution limits](../reference/worker.md#execution-limits).

## 2. Plan and resolve the execution

Split staging between the two destinations in `plan()`:

- `HarnessPlan.runtime` holds private harness files, authentication material, control sockets,
  harness runtime variables, and its network policy.
- `HarnessPlan.execution` holds workspace inputs and the policy applied where tools act.
- Declared outputs stay on `HarnessPlan` and are exported through the execution access.

`describe()` is enough for a simple process adapter. Implement `resolve()` when support depends on
the installed runtime, prepared environment, or allowed permissions. It returns the effective
`capabilities` and optional runtime identity and version evidence. The Worker validates the result
before it calls `start()` and records it in the Runtime Input Manifest. For the resolution and
staging rules, see [harness lifecycle](../reference/worker.md#harness-lifecycle).

For a distributed example and its current security limits, see
[Share an execution environment](shared-execution.md).

## 3. Start and control a live execution

`HarnessExecution` can expose a `control` implementation and a native `session` reference
`{ harnessId, id }`. The native ID identifies runtime state; it is not a new public resource,
stored conversation state, or an authorization token.

Declare supported operations in `capabilities.control`:

- `input`: supply additional text to the active execution.
- `reply`: answer a registered runtime request with a JSON response.
- `interrupt`: interrupt the current native turn, when implemented by the adapter.

For Session message delivery, also declare `inputMode: "queue"` or `"steer"`. Queue mode accepts
text for a subsequent native turn; steer mode changes the active turn. Finish processing accepted
input before you report success or export the final session state. Codex app-server mode
advertises steering. Claude Code advertises queueing. It acknowledges `accepted` only after the
Agent SDK has taken the text from its streaming prompt and the Claude Code process has produced
output. A resumed query buffers input until that process starts. It reports `rejected` when no
prompt stream is open, or when the command is revoked or times out before the SDK takes the
text. Withdrawn text never reaches Claude Code later. It reports `unknown` when the stream ends
between handing the text over and that confirmation. Its queued text skips slash-command dispatch
and `@path` expansion. A Claude Code run that uses a one-shot CLI process starts without a
control channel.

### Deliver teammate input

An `input` command with `advisory: true` carries information the Task may weigh, such as
[Team coordination](../reference/mailbox.md#live-delivery). If its acceptance is uncertain,
answer `unknown` and keep the execution and its result; don't fail the Task Attempt over it. Codex
app-server mode does this when a turn ends before it acknowledges an advisory steer, while it still
fails the Task Attempt for other uncertain input. `LocalHarnessExecutionControl` aborts the
uncertain advisory command's signal to withdraw queued input, caches its receipt, and keeps the
channel open for later commands. Its default four-second command budget includes queue time,
leaving room for the Worklet's five-second receipt deadline. Advisory dispatch waits at most one
second (or a quarter of a custom command budget), so a stalled teammate item releases the queue
before operator input times out. A command that expires in the queue is rejected without dispatch.
Adapters must honor the abort signal before taking queued input. Other uncertain commands still
close the channel.

### Sender identity and authorization

Teammate input also carries `origin: { kind: "peer", from: senderTagId }`, using the stored
sender identity. Preserve this marker when the native SDK supports it; never derive it from
message text. The installed Claude Code CLI can hold or refuse native peer input without a
matching receipt, and its meta-message path does not reliably attribute replies by input uuid.
SuperTag therefore omits `SDKUserMessage.origin` for Claude Code. The input retains its stored
sender label and untrusted-content framing, skips command expansion, and uses the ordinary queued
input path with a client uuid. Codex also uses this labelled text because its SDK has no peer field.

An input with `requiresInputAuthorization: true` must also carry the ephemeral
`HarnessControlOptions.authorizeInput` callback through Worker and Worklet wrappers.
The Worker rejects it before dispatch unless execution control uses `LocalHarnessExecutionControl`
and the callback is present. That control rejects it unless the adapter declares `authorizeInputAtTake`.
The adapter must call the supplied guard after its own queues, immediately before handing text
to the native session, and reject input when the guard returns false. Never persist the callback,
reuse its answer, or replay an uncertain command. Built-in Claude Code and Codex adapters support
this check. Custom Claude runners must also opt in when binding `ClaudeLiveInput`; an unguarded
binding rejects guarded input. Custom adapters must use `LocalHarnessExecutionControl` with this
check to receive Team input live; other control implementations leave it for the next activation digest.

A malformed `input.withdrawn` command ID is ignored when processing saved events. It cannot block
durable replay or settle a delivery. Valid withdrawal events still retry on storage failures.

### Withdrawing unconfirmed input

Claude Code withdraws accepted input that no reply names before the final result.
A reply names its input by the client uuid that Claude Code stamps on it.
For example, a teammate's note accepted during the final turn can remain unread.
The next activation's digest is the authoritative copy of that withdrawn note.
Cleanup after a durable wait applies withdrawals before settling the Task Attempt.
Withdrawn operator input returns to its pending Task.
The same rule applies when acknowledgement times out or a native write remains unconfirmed.
The saved native transcript may already contain it, so SuperTag keeps that archive
without making it resumable. The next activation starts a fresh native session with
canonical Session history and the digest, which supplies the note once. This sacrifices
native conversation continuity for that activation. The Control Plane enforces this rule
for every adapter, including when a durable wait settles. It refuses promotion when that
Task Attempt has a withdrawal event
or any sent teammate delivery still pending, unknown, or withdrawn. A late native
acknowledgement does not override a delivery already recorded as unknown.
Task Attempts with only confirmed deliveries remain eligible for native resume.

### Preserving the final response

A turn that only answers input after the work finished does not replace the Task Attempt's final
response. For example, cancelling while final token counts are being saved preserves that response.
The Worker still requires successful cleanup before completing the Task Attempt.

`HarnessExecution.run(signal, options)` receives an optional `options.claimFinalResponse()` callback.
Call it synchronously when the final response arrives, before awaiting work or yielding events.
It returns `true` only for the first claim made before the Worker's signal aborts.
Then yield that response as `output.message` with `final: true`. The claim protects delivery through
intervening session, progress, usage, and cleanup events. A claim alone cannot complete the Task Attempt.
Claude Code claims when it reads the final result from stdout, before Agent SDK delivery.

Adapters that do not claim must deliver final output to the Worker before cancellation.
Marking late output `final: true` cannot bypass this cutoff. Once accepted, later output messages
cannot replace the final response. The Worker keeps a structured result received after cancellation
when the adapter claimed the final response before cancellation; otherwise it ignores the result.
Cleanup failure still fails the Task Attempt, even with a successful claim.

### Acknowledge and control commands

Each command carries `id`, `taskId`, and `attemptId`. An acknowledgement reports `accepted`,
`rejected`, or `unknown`. Acceptance means the adapter accepted the command, not that the Task
succeeded.

Use `LocalHarnessExecutionControl` for bounded command history, duplicate-ID handling, request
registration, timeouts, and revocation. Register a request before accepting its reply, and check
allowed permissions before translating a response into any native approval.

A custom Worker application can call the optional `worker.control(command)` method returned by
`createWorker`. It routes only to a matching active Task Attempt and rejects unsupported controls.
Authenticate callers before you expose this method. For duplicate handling, durable delivery, and
Worklet support, see [Live control rules](../reference/worker.md#live-control-rules).

## 4. Configure a profile

Publish `configurationSchema`, a versioned JSON Schema for the non-secret
`profile.harness.configuration` object. The adapter validates and applies its options during
planning. A schema is not permission to bypass Task admission.

The built-in Codex, Claude, and OpenCode adapters accept `model` and `timeoutMs` in this object;
Claude also accepts `maxTurns`. Unknown keys are rejected. The profile's timeout limit remains an
upper bound. Credentials come from explicit host configuration, never from the profile
configuration object.

A Claude model alias such as `opus` or `sonnet` resolves through the Claude Agent SDK bundled with
your SuperTag release, not through a separately installed `claude` CLI. The two can map an alias to
different model versions. When results must be reproducible or comparable, set an exact model ID.
The model that answered is recorded in each Task Attempt's saved session transcript.

## Check that it worked

Run a Task on the Worker, then inspect it:

```sh
supertag describe task TASK_ID
```

The report shows colocated or split placement for the harness runtime and execution environment.
It reads that evidence from the Task's recorded events, so it remains available after a Control
Plane restart. The Runtime Input Manifest also records the resolved harness support; see
[Runtime Input resolution](../reference/worker.md#runtime-input-resolution).

## Run Codex through app-server

Use Codex's bidirectional native protocol for live control, portable Sessions, token limits, and
split execution. The default mode remains `"exec"`.

### 1. Enable app-server mode

Set `executionMode: "app-server"` on `CodexHarness` or `createCodexWorker`. Without a separate
harness runtime, app-server and workspace tools stay colocated and use Codex's native behavior:

```ts
import { createCodexWorker } from "supertag-ai/harnesses/codex";

const worker = createCodexWorker({
  workspace: "/path/to/workspace",
  executionMode: "app-server",
  model: "gpt-5.6-luna",
  sessionStateStore,
});
```

With the CLI, add `--codex-execution-mode app-server` to `supertag connect worklet --harness codex`.

### 2. Split the runtime from execution (optional)

Provide a `LocalHarnessRuntimeProvider` and a separate execution environment provider:

```ts
import { createCodexWorker } from "supertag-ai/harnesses/codex";
import { LocalHarnessRuntimeProvider } from "supertag-ai/worker";

const worker = createCodexWorker({
  workspace: "/workspace/repository",
  executionMode: "app-server",
  harnessRuntime: new LocalHarnessRuntimeProvider(),
  executionEnvironment,
  execServerCommand: "codex",
  sessionStateStore,
});
```

The Worker starts Codex app-server in the local harness runtime and Codex exec-server inside the
execution environment. The execution environment must advertise
`supertag.process-input-streaming@1` and `supertag.process-output-streaming@1`, and its `codex`
command must report the same Codex CLI version as app-server.

Check that it worked: `supertag describe task TASK_ID` reports split placement. For the version
check, `sandboxMode: "external"`, session portability, and provenance, see
[Codex](../reference/worker.md#codex).

## Connect to a supervised server

An environment may implement a scoped HTTP connection to a server process it started:

```ts
const process = await environment.spawn(serverSpec, signal);
if (!environment.connect) throw new Error("Scoped HTTP is unavailable");
const connection = await environment.connect(process, {
  port: 4096,
  timeoutMs: 5_000,
  maxResponseBytes: 1_048_576,
}, signal);
try {
  const response = await connection.request({ path: "/health" }, signal);
  // Decode the bounded response body according to the server protocol.
} finally {
  await connection.close();
}
```

The connection takes an environment-owned process handle and a port. Requests use origin-relative
paths. Closing an idle connection does not stop its server; normal environment cleanup still owns
that process. For bounds and provider support, see
[Scoped server connections](../reference/worker.md#scoped-server-connections).

## If something goes wrong

- **A Task stays queued with a scheduling incompatibility.** No candidate Worker advertises a
  requested `execution.limits` value. See [Execution limits](../reference/worker.md#execution-limits).
- **The Task Attempt fails before the harness starts.** Resolution may narrow support, and required
  unsupported inputs or splits fail before provisioning. See
  [harness lifecycle](../reference/worker.md#harness-lifecycle).
- **Split Codex fails.** Check the capabilities and CLI versions in [Codex](../reference/worker.md#codex).
- **A Session message never reaches the Task Attempt.** The Worklet may not support remote control. See
  [Live control rules](../reference/worker.md#live-control-rules).

## Next

- [Worker reference](../reference/worker.md) for the full harness and environment contracts.
- [Share an execution environment](shared-execution.md) for a distributed execution service.
- [Route MCP tools](mcp-tools.md) for MCP client placement.
- [Run a Worker](workers.md) for the shipped harnesses.
