# Worker service-provider contract

This document defines the language-neutral behavioral contract for extending
SuperTag execution. JSON messages on the network are specified by the schemas
in this directory. SDK interfaces are idiomatic projections of the behaviors
below; their exact method spelling is language-specific.

A **harness runtime** is the place where a harness process, its model
authentication, and its private state live. An **execution environment** is the
place where the harness's workspace tools read files and start processes. They
can be the same local environment. A split-capable harness can instead use a
local harness runtime and a separate execution environment.

Use the narrowest extension point that fits:

1. implement a **harness** to add an agent SDK or CLI;
2. implement a **Harness Runtime Provider** to add a place that can host a harness;
3. implement an **Execution Environment Provider** to add a tool execution target;
4. implement a **Runtime Input Provider** to resolve one kind of admitted input;
5. implement `SessionStateStore` to change where conversation state is stored;
6. implement a complete **Worker** when the standard composition does not fit.

## Behavioral hierarchy

```text
Worker Host
  -> Worklet
     -> Worker
        -> Runtime Input Providers
        -> harness
        -> Harness Runtime Provider
        -> Execution Environment Provider
        -> Session persistence
```

The Control Plane dispatches a wire-format Task Attempt through a Worklet to one
Worker. The Worker resolves Worker-local Runtime Inputs, asks a harness for a
portable launch plan, provisions the selected runtime and execution access, runs
one invocation, and converts its output into the wire-format Task Attempt event
stream.

A Worker Host is the execution location that supplies Workers and capacity. A
Worklet is the persistent supervisor running on that host. The Worklet connects
to the API Server, reports the host descriptor, renews its heartbeat, accepts
assignments, enforces host concurrency, and streams events back. It supervises
execution capacity; it is not the Worker Host and does not define Task behavior.

## Worker

A Worker defines how SuperTag turns an admitted Task into executed work. It
advertises a stable identity, exact Worker Profile revisions, capabilities, and
concurrency. It accepts one immutable Task Attempt Spec and emits an ordered
stream of Task Attempt Events.

Required behavior:

- reject an unsupported profile before performing work;
- run at most `maxConcurrency` Attempts at once, except one more whose `placement.coordinationSlot`
  is true: an Objective owner's activation, which must not wait behind delegated work;
- resolve the admitted context, workspace, tools, and continuity inputs;
- select and configure any harness runtime and execution environment it uses;
- start, monitor, cancel, and clean up every execution lifecycle;
- emit `execution.started` before execution output;
- emit exactly one terminal `execution.completed` or `execution.failed` event after confirmed cleanup; if cleanup cannot be confirmed, fail the execution transport without claiming a terminal outcome;
- preserve Task and Attempt identity on every event;
- honor cancellation when the advertised capability says it can;
- never reuse a session state produced by a failed or cancelled Attempt;
- avoid placing credentials in descriptors, events, errors, or Runtime Input Manifests.

A Worker owns authorization enforcement, Runtime Input resolution, execution,
continuity, cancellation, and event normalization. A Worker may use the standard
SDK composition or implement the contract directly. Standard SDK builders such
as TypeScript `createWorker` and Python `create_worker` return an ordinary
Worker; they do not introduce another runtime abstraction.

For each Attempt, a Worker built from the standard components must:

1. resolve the exact local Worker Profile revision;
2. resolve admitted context, workspace, and surface-permission-derived tools as Runtime Inputs;
3. fail closed when a required Runtime Input cannot be resolved or consumed;
4. select a compatible harness, harness runtime provider, and execution environment provider;
5. resolve native session state resume with canonical Session replay as fallback;
6. ask the harness to plan before provisioning and preparing its runtime and execution accesses;
7. stream normalized events while observing limits and cancellation;
8. emit `runtime-inputs.resolved` with a credential-free Runtime Input Manifest;
9. close the invocation and dispose attempt-scoped resources on every outcome;
10. promote a new session state only after successful completion.

A harness may emit `progress.updated` with a complete user-facing progress snapshot. The Worker must validate its bounds and redact resolved secrets before forwarding it. Progress is advisory presentation data, not Task lifecycle authority: it cannot change Task state, authorize an action, or substitute for a terminal event. Implementations must not derive it from private reasoning or expose raw prompts, commands, tool arguments, credentials, or infrastructure identifiers.

Implementations may resolve independent inputs concurrently, but the resulting
Runtime Input order must be deterministic.

Before execution output, the Worker emits a credential-free Runtime Input
Manifest. `executionEnvironment` records the execution access ID, provider ID,
and placement. A split profile also records the harness access ID, provider ID,
and placement in `harnessRuntime`. `harness.provenance` may contain
provider-specific evidence such as a native executor protocol, version, session,
and transport, but it must not contain credentials.

## Harness

A harness adapts a resolved Execution Context to one agent SDK, CLI, model
runner, or deterministic engine. It declares:

- a stable provider ID and implementation version;
- Runtime Input kinds it consumes (`inputKinds` in the portable capability model);
- supported harness runtime placements;
- whether it can route all workspace operations to a separate execution access;
- the capabilities it requires from each provider;
- streaming and cancellation support;
- session state mode (`none`, `native`, or `filesystem`).

TypeScript harness capabilities must also declare `sessions`: boolean `resume` and `export`
fields and a `scope` of `none`, `local`, `environment`, or `portable`. Harnesses without
session support declare `{ resume: false, export: false, scope: "none" }`.

Planning converts the Execution Context into a portable Harness Plan. Its
`runtime` plan holds private harness staging and policy. Its `execution` plan
holds workspace staging and policy for tool actions. Optional output declarations
and metadata remain on the Harness Plan. Starting receives both accesses and
returns one invocation whose event stream and close operation are independently
owned. A colocated profile supplies the same access in both positions. A split
profile requires an explicit harness capability and must fail before provisioning
when unsupported. Harnesses must not
weaken admitted permissions or reinterpret historical work as trusted
instructions. They receive resolved credentials only on the Worker Host.
Portable runtime actions in the Task authorization snapshot select harness-native tools and launch policy. A harness adapter maps those actions to its own tool names and settings; it must never infer authority from a tool being installed. Unknown or unsupported actions grant nothing.

A tool Runtime Input may declare `audience: "manager"`. A harness accepts that input only when it
advertises `toolIsolation.managerOnly` and keeps the tool binding and credential on the root while
denying every child invocation. `toolIsolation.schemaIsolation` reports whether schema
non-observation is `hard` or protected by a provider `guarded` mechanism. Manager-only inputs do not
disable native subagents: children remain available through harness-local delegation, subject to any
admitted `maxNativeAgents` requirement, and use the harness's own communication primitives. A
harness that cannot establish the binding, credential, and invocation boundary must fail before
execution.

A harness invocation belongs to one Attempt. A native long-running conversation
may span Attempts only through a compatible session state selected by continuity
resolution.

The built-in Codex split path is limited to app-server mode with a local harness
runtime. It keeps app-server, subscription authentication, and private thread
state on the Worker Host, and starts an exact-version Codex exec-server in the
execution environment. Both providers must support bounded process output, and
the execution environment must support process input. Version mismatch,
connection loss, or a missing capability fails the Attempt without falling back
to local tool execution. Codex native subagents remain disabled. Codex exec mode
does not support split execution.

Tasks may require provider-neutral harness controls with `execution.limits`.
`maxNativeAgents` is a hard ceiling on native child agents. `maxReportedTokens`
interrupts when cumulative provider reports reach the threshold; reports can
arrive late or in batches, so this is not a billing or exact token ceiling. A
Worker Profile advertises these controls as capabilities and must reject a Task
before work when its harness cannot enforce a requested control. Harness-native
defaults may be stricter than a Task requirement, never looser.

`usage.updated` reports cumulative Attempt token usage. Its optional
`reportedCost` is an actual provider-reported charge with currency; it is separate from the Task's
`maxCostMinor`, which reserves estimated Objective budget. The two are comparable only when the
Objective explicitly denominates its budget in the same currency. Missing provider cost means
unknown, not zero. Durable Worklets retain
usage and native-agent events in the Attempt journal, while compatible harness
session state may retain provider counters only as baselines for resumed Attempts.

## Harness Runtime Provider

A Harness Runtime Provider advertises a stable provider ID, capabilities, and
enforceable guarantees. Its `provisionRuntime` operation consumes the Task,
Profile, runtime plan, and lifetime, then returns a harness runtime access. The
access uses the common file-and-process contract so a harness can stage private
configuration and launch its process there.

A Harness Runtime Provider is responsible for the harness process and private
state. It does not become the destination for workspace tools in a split profile.
The built-in split harnesses currently use `LocalHarnessRuntimeProvider`, which
keeps their model sign-in on the Worker Host. Omitting a separate harness runtime
preserves colocated execution by using the execution access for both roles.

## Execution Environment Provider

An Execution Environment Provider advertises a stable provider ID, capabilities,
and placement (`local`, `remote`, or `managed`). Provisioning consumes the Task,
Profile, and one destination-specific Environment Plan and returns an isolated
environment with:

- a root and traversal-safe path resolution;
- plan preparation for files, mounts, secrets, and network policy;
- bounded process execution and cancellation;
- optional bounded binary reads for declared output export;
- optional session state capture;
- idempotent disposal.

The provider owns environment creation, policy enforcement, and teardown. The
Worker owns when those operations occur. Attempt-scoped environments
must be disposed after success, failure, or cancellation. Session- and
Worker-Host-scoped environments require explicit lease and idle-lifetime semantics;
providers must reject unsupported lifetimes instead of silently changing them.

The TypeScript providers prepare directory mounts before staged files and reject staged-file
collisions with existing mounted content. Read-only permissions are applied after preparation.
An artifact input nested beneath a workspace mount must survive that preparation unchanged.

Remote or managed placement is not itself a security guarantee. Providers report
only isolation, network enforcement, process-tree termination, and scoped HTTP
behavior that they actually enforce. The shared-execution provider reports no
filesystem or network enforcement by default; an operator may declare stronger
guarantees only when the deployed service establishes them. A harness mode that
delegates sandboxing to an external execution environment must fail unless the
required guarantees and admitted actions are present.

## Automatic output collection

A Task may opt into automatic collection through `execution.outputs`. Providers advertising
`supertag.environment.output-files` version 1 must implement three operations (the TypeScript
names below are projections of this language-neutral contract):

- `prepareOutputDirectory(path)` creates or verifies a relative directory beneath the exclusive
  Attempt root. Reject traversal, symbolic links, and non-directory collisions.
- `listOutputFiles({ roots, maxFiles })` returns `{ path, sizeBytes }` entries relative to that
  root. Bound traversal as well as returned file count, reject links and special files, and fail
  explicitly if the complete manifest cannot be returned within the bound.
- `readBytes(path)` performs bounded binary reads without following symbolic links. Files must
  remain stable during collection; do not represent a partial read as a complete output.

The Worker prepares the output directory before starting the harness and exposes its absolute
path as `SUPERTAG_OUTPUT_DIR`. Automatic scans apply only to an exclusive Attempt workspace.
The default directory is `outputs/`; inclusion and required patterns select submitted
files. Exclusions, including enforced input, credential, dependency, and cache exclusions, still
apply to required patterns. A missing required file fails collection. Limits are at most
100 files, 32 MiB per file, and 64 MiB total, including generated Git manifests.

Local, E2B, and Modal providers implement these operations. The shared-execution service
currently does not advertise this capability; it must reject Tasks requiring it. An extension
in another language can implement the same operations without invoking Python. The built-in
Linux sandbox adapters use a bounded Python helper for filesystem enumeration and directory
preparation.

Git handling is read-only. Selected source files can be represented by a manifest referencing
an exact commit only when a configured remote advertises that exact commit. Selected dirty
bytes are still captured. If remote availability cannot be proven, preserve selected bytes
and mark the manifest as lacking confirmed remote durability. A remote inside the disposable
workspace does not qualify. Selected deletions and the initial commit are recorded; this is a
partial selected snapshot, not a complete repository backup. Explicitly included generated
reports are eligible even when Git ignores them. `git: ignore` must not silently omit a
required deliverable.

Required reads and local Git metadata collection finish before remote verification. A remote
probe failure can therefore fall back to buffered selected bytes, including when a sandbox
provider terminates its process boundary on timeout. Providers must not advertise automatic
collection merely because their harness can invoke a capture tool.

## Saved outputs

`HarnessPlan.outputs` optionally declares at most 20 files, each at most 32 MiB, relative to the
execution environment root. A Worker configured with an `ArtifactStore` reads these files through
the environment's optional `readBytes` operation after the harness finishes and before disposal.
Unsupported binary reads, missing files, and failed storage writes fail the Attempt; a successful
catalog-backed Task result includes `{artifactId, paths}` selections for the captured entries.
A standalone Worker with only byte storage emits `artifact.created` events but cannot submit
uncataloged bytes as Task artifacts. Task output policies above provide explicit automatic
collection; no implicit workspace-wide export occurs.

`HarnessPlan.artifactSources` optionally selects generated content relative to the **runtime**
root, independently of execution workspace outputs. Each source has a unique `id` (1–40 ASCII
letters, digits, dots, underscores, or hyphens; first character alphanumeric), `directory`,
nonempty `include` patterns, optional `exclude`, optional `category`, `bundleDepth` (0–16,
default 0), `submit` (default false), and `restore` (default false). Patterns are relative to the
source directory. `restore: true` requires `submit: true` so downstream use always names an exact
admitted artifact rather than an implicit latest version.
A depth of zero captures one source bundle; larger depths partition by relative path components.
The TypeScript Worker requires an Attempt-exclusive runtime and catalog connection, baselines
selected bytes before harness startup, and publishes only changed, nonempty bundles after normal
completion. A changed bundle contains its full current selection. Entirely deleted bundles produce
no tombstone. Each bundle is independently idempotent in the durable output journal; only groups
with `submit: true` are added automatically to the Task result.

Before plans are materialized, the TypeScript Worker matches admitted artifact entries named
`harness/<harness-id>/<source-id>/<relative-path>` against sources with `restore: true`. It removes
the matching ordinary workspace mount and stages a writable copy at
`<source.directory>/<relative-path>` in the harness runtime. Restoration is limited to exact
`inputArtifacts` frozen at Task admission. The Worker records acquisition before transfer,
acknowledges delivery after environment preparation, and establishes the collection baseline only
after restored bytes are present. A changed restored bundle becomes a new artifact and retains the
admitted artifact as catalog lineage; unchanged content is not recaptured. Destination collisions
fail before harness startup. Implementations must not infer or fetch a latest artifact.

`EnvironmentAccess.listOutputFiles` accepts optional `include` and `exclude` patterns relative
to each query root. Implementations must prune unrelated directories, enforce enumeration limits,
reject selected symlinks, and return runtime-root-relative file paths. Capture validates provider
manifests and reads each file twice to detect concurrent changes. This is not an atomic filesystem
snapshot. Home collection limits are 100 files, 64 MiB total, and 32 MiB per file. Baseline reads
use the same limits. Runtime cleanup waits until selected bytes have been frozen in the journal.
This in-process TypeScript behavior is not automatically implemented by custom Workers in other
languages; they can publish equivalent captures through the catalog protocol.

`ArtifactStore.put` stores bytes and returns an immutable content reference; `get` retrieves and
verifies that reference. The current TypeScript materialization and Task admission paths
use `supertag-artifact:sha256:<hex>` URIs with the matching `sha256:<hex>` digest. Other adapters
must preserve this reference format and enforce their own storage access controls. The supplied production backend uses S3-compatible blob storage behind the Control Plane;
Workers retrieve bytes through Attempt-authenticated requests.

Artifact mounts are materialized into binary staged files before provisioning. Catalog inputs
carry `artifactId`, `path`, and producer provenance alongside their admitted byte reference.
The Worker records an acquisition before transfer and acknowledges delivery after environment
preparation; this proves delivery, not model comprehension. The supplied Codex and Claude Code
harnesses preserve each entry's relative path beneath a separate per-artifact input directory. Their references
must come from admitted Task inputs; a content digest identifies bytes and does not confer
authority. Task assignments can snapshot selected outputs from visible submitted,
accepted, or rejected Tasks without accepting those source Tasks. Rejection preserves evidence
for repairs. Output provenance persists with the input
snapshot and the original Task result.

## Runtime Input Providers and resolution

Runtime Input Provider is the common behavioral category for Worker-local
resolution. Every provider receives an immutable **Resolution Context** containing
the Attempt and exact Worker Profile. SDKs may expose narrower registries:

- **Context Resolvers** resolve only Control Plane-admitted, versioned Context Plan
  items such as Skills, shared Task history, and namespaced custom types;
- **Workspace Resolvers** resolve only the captured Task workspace target;
- **Tool Providers** resolve only admitted Surface permissions into semantic Tool
  Capabilities and runtime bindings;
- profile instructions are trusted, non-secret configuration and require no
  external lookup.

Provider outputs include stable Runtime Input IDs,
required/optional status, provenance, and the originating Context Item key when
applicable. They must not expand authority, fetch unadmitted collaboration
content, or treat a Context Set as a permission source. Unknown required items
fail resolution; optional omissions appear in the Runtime Input Manifest.

Each Context Resolver declares one namespaced type and the positive integer
versions it implements. Worker descriptors aggregate these declarations as
`contextTypes`. Scheduling must not assign a Task with a required Context Item
unless the selected Worker declares the exact type/version pair. Context Plan
version 7 defines the shared envelope: `type`, `version`, `itemKey`, `required`,
bounded non-secret `config`, and optional trusted Control Plane `snapshot` data.

The TypeScript SDK requires local compatibility declarations through resolver
`outputKinds` or Runtime Input Provider `contextOutputs` (type, versions, and
`inputKinds`). These declare all possible output kinds, not alternative producers:
every provider for a contract must be compatible with the selected harness.
Every advertised context type and version requires an output contract; registration rejects omissions.
Declared provider outputs must identify their originating `sourceItemKey` and stay
within the declared bound. These local declarations filter the existing descriptor
`contextTypes`; they do not add wire fields or imply new Python SDK properties.

Portable Runtime Input kinds currently include `instruction`, `skill`,
`history`, `workspace`, `tool`, `resource`, `secret`, `sessionState`, and
`harness-specific`. The resolved collection is exposed as `inputs`. This list is
an SDK SPI and not a wire discriminator unless
also published in a JSON schema.

## Session state storage and continuity

`SessionStateStore` is an internal adapter for a Session's opaque native conversation state.
It loads, saves, and optionally deletes a stored record by `SessionStateRef`; exact reference
matching prevents a stale or mismatched restore. Built-in connected TypeScript Workers use
the Control Plane database through an authenticated Worker API. The optional
`session.persistence` connection carries a Session-only credential independently of coordination
tools; Workers keep it outside prompts, native tool configuration, and event output. Standalone Workers may use
in-memory or local file storage, but these do not provide cross-host durability.

Native transcripts remain private Session data, outside the artifact catalog. A stored revision
is not automatically eligible for resumption: completion, compatibility, and current ownership
are checked separately. A failed or partially synchronized run must not advance the automatic
resume point. Workspace snapshots have a separate lifecycle.

Continuity resolution is deterministic:

1. **resume** when the harness accepts the prior session state format;
2. **replay** when canonical bounded Session history exists but native resume is
   absent or incompatible;
3. **fresh** otherwise.

Replay remains available to a resume operation so a harness can recover if its
native session state fails to load. Stored metadata never replaces the Control Plane's
canonical Session and Task history.

## Ownership and cleanup

| Resource | Created by | Closed or promoted by |
| --- | --- | --- |
| Worklet connection | transport | transport/operator |
| Attempt execution | Worker | same Worker, on every outcome |
| Resolved Runtime Input | provider | Worker after the Attempt |
| Execution environment | Environment Provider | Worker according to lifetime |
| Harness invocation | Harness | Worker after its event stream ends |
| Candidate session state | Harness/environment | Worker after successful completion |
| Stored session state | Session storage | Session retention policy |

Close and dispose operations must be idempotent. Cleanup errors must not replace
an earlier execution failure, but must remain observable to operators.

## Versioning and capability negotiation

Wire versions, resource API versions, Worker Profile revisions, harness
versions, provider versions, session state formats, and SDK package versions are
independent. Never infer compatibility between these layers.

- Wire compatibility follows the JSON schemas and negotiated transport version.
- A Worker Profile reference matches by exact ID and revision.
- Provider IDs are configuration keys; changing their semantics requires a new
  provider ID or profile revision.
- Harness implementations use their declared version when validating native
  session state and cached adaptations.
- New optional SDK behavior may be capability-gated. New required behavior needs
  a versioned contract and conformance fixtures.

## SDK names and wire names

Wire documents always use the JSON Schema field names, including `taskId`,
`attemptId`, `workerProfile`, `inputs`, and `sourceItemKey`. The portable SPI
uses `inputKinds` for a harness declaration. SDKs should use idiomatic names
inside the language (`task_id` in Python, `taskId` in TypeScript) and perform an
explicit conversion at the wire boundary.

An SDK must not serialize an object by accident from its in-memory member names.
Conformance tests must prove that decoding and re-encoding checked-in fixtures
preserves required wire fields and unknown optional fields. Provider and harness
methods may also follow language conventions as long as their lifecycle and
failure behavior match this specification.

## Conformance minimum

An SDK claiming this SPI should test successful execution, unsupported profiles,
required unsupported Runtime Inputs, cancellation, timeout, environment cleanup,
session state match/mismatch, resume/replay/fresh continuity, malformed wire input,
unknown optional wire fields, and credentials absent from observable output.


## Profile-specific support

A Worker must include `profileCapabilities` in its descriptor. Each entry names an exact
Worker Profile revision and its `capabilities` and `contextTypes`. Routing uses that entry;
a missing or ambiguous entry is unsupported. Descriptors
without the field are invalid; Worker-wide declarations never substitute for profile claims.

Standard `createWorker` composition derives support from the selected harness and environment
provider for each profile. Coordination requires both instruction and tool inputs. Missing
harness or environment registrations are configuration errors detected during description.
Worker-wide capabilities summarize the common support across profiles.

Context type declarations describe resolver support. TypeScript resolvers declare their output
kinds, and resolution checks that the selected harness consumes every required resolved input.
Descriptor matching does not replace this execution-time check. These declarations do not
change transport version negotiation or the `Worker.execute` contract.

## Workspace checkouts

A Worker Host descriptor may include `workspaces`, the names of Workspaces with a checkout
declared on that host. Names only: checkout paths never leave the host. A Worklet advertises them
when at least one profile it hosts reports `supertag.workspace.in-place`, which standard
composition derives for profiles that run the harness and tools together in the local process
environment. The gRPC `Hello` carries the same names in field 8. Omission means no declared
checkouts.

A profile may also report `supertag.workspace.clone` (version 1). Standard composition adds it to
in-place profiles when a Workspace Resolver keeps host-managed clones of Workspace sources. It
travels with the other profile capabilities; no descriptor field or `Hello` field is added.

The Control Plane places a Task whose workspace plan has `status: "workspace"` only on bound hosts
that carry the Tag's `runsOn` labels and can serve it, in this order of preference:

1. hosts that carry the label `workspace:<name>`, that is, advertise its Workspace in
   `workspaces`, on a profile that reports `supertag.workspace.in-place`;
2. when the plan records `source`, hosts on which every profile reports
   `supertag.workspace.clone`.

With no such host it records the scheduling hold `labels:workspace:<name>` when the plan has no
source, or `workspace.checkout-or-clone:<name>` when it does.

A Workspace Resolver that clones fetches the source before creating each Task worktree and
serializes clone, fetch, worktree, and push operations on one repository. Credentials reach git
only through the environment of one command and a command-line credential helper; they are never
written to git configuration, remote URLs, or a credential store.

For `delivery: pull-request`, the resolver hands a completed Task Attempt with commits to a
pull-request publisher. The standard GitHub publisher requires `pull-requests:create` on the
repository, applies `approval: required` to opening the pull request through
`request_action_approval`, pushes the Task branch, and opens a draft or updates the Task's
existing pull request. The Task result records it as a reference with `provider: github`,
`resourceType: pull-request`, `resourceId: OWNER/REPO#NUMBER`, the pull request URL as
`reference`, and `relationship: produced`. The Control Plane reads that reference to mark the
pull request ready for review when the Task is accepted, or to close it when the Task is
cancelled or rejected.

## Placement labels

A Worker Host descriptor may include `labels`, a list of at most 64 unique placement labels. A
label is 1-63 lowercase letters, digits, dots, colons, hyphens, or underscores, starting with a
letter or digit; `workspace:NAME` may be longer because it carries a full Workspace name.
`LocalWorklet` advertises these automatic labels:

| Label | Source |
| --- | --- |
| `linux`, `macos`, `windows` | Operating system |
| `x64`, `arm64` | CPU architecture |
| `harness:NAME` | Each harness reported in `profileCapabilities` |
| `workspace:NAME` | Each advertised Workspace checkout |

Operator-declared labels, such as `gpu`, are added to the same list. The Control Plane also
derives `harness:NAME` and `workspace:NAME` from the rest of the descriptor, so a Worklet that
predates `labels` stays schedulable. It adds labels granted by the Auth Key the host redeemed.

A Tag's `runsOn` labels narrow its bound Worker Hosts to those that carry every label. Labels are
self-reported and only ever decide placement; Tag bindings decide access. The gRPC `Hello`
carries labels in field 9. Omission means no advertised labels.

## Durable supervision

`DurableWorklet` adds acceptance, inspection and observation to a Worklet without replacing the
Worker execution interface:

- `accept(spec)` reserves capacity and persists an Attempt receipt before acknowledging it.
  The same identity and specification is idempotent; changed content under that identity conflicts.
- `inspect(attemptId)` returns persisted status and the last event sequence. Absence and temporary
  unavailability must not be interpreted as a safe execution failure.
- `events(attemptId, after, signal)` observes events strictly after a sequence cursor. Disconnecting
  or cancelling this observer does not cancel execution.
- `cancel(attemptId, reason)` requests cancellation. Its receipt can still be running while cleanup
  continues. Capacity cannot be released merely because a cancellation was requested.

The Control Plane owns Task authority and execution leases. Host journals establish what a supervisor
accepted and observed; they do not authorize another Attempt or grant an agent additional access.
Protocol 18 connections require `durableProtocolVersion: 1` and carry these operations.
The Control Plane rejects WebSocket hellos without this marker before authentication.
An uncertain durable submission never triggers another execution path.

The built-in `FileAttemptJournal` stores private receipts and redacted events in local SQLite
using WAL and FULL synchronization. Each event insert and receipt sequence advance are atomic;
the supervisor reads event pages rather than materializing history. Terminal execution status
is recorded only after the iterator finishes cleanup. The directory-based constructor and explicit
snapshot methods `readAll` and `write` remain available. It does not store full Task
Attempt specifications. A process restart marks unfinished records unknown instead of replaying
execution. Exact Worker dispatch is required when a durable supervisor reserves capacity within a
multi-Worker host; `LocalWorklet.executeOnWorker` implements that binding. Journal retention is
operator-managed in this version.

Task waiting requires durable Worklet execution and uses the existing coordination and
cancellation lifecycle. `wait_for` persists its conditions before the Control Plane cancels the
current Attempt; model cooperation or a final output is not required. Further coordination and artifact access are revoked immediately.
The Worker must honor cancellation and finish its normal cleanup. For durable Worklets, the
Control Plane retains the assignment until the terminal journal receipt confirms cleanup, then marks
it waiting. Missing receipts never imply released execution capacity. A Control Plane restart reconciles
a registered wait by cancelling the existing Attempt and observing its terminal receipt, without
replaying execution. Only a durable wake condition permits a fresh Attempt for the same Task.
The harness continues to emit ordinary execution events; no new event or protocol version is needed.

`escalate_task` uses the same lifecycle. It stores the Task's new model or effort and a wait that
wakes at once, then cancels the current Attempt. The next Attempt for the same Task carries the new
values in `execution.model` and `execution.effort` and the same `workspacePlan.branch`. Workers
need no change.


## Portable sandbox backends and process ownership

`ExecutionEnvironmentProvider` remains the execution-target boundary. The TypeScript
`SandboxExecutionEnvironmentProvider` is a reusable implementation for attempt-scoped remote
sandboxes; E2B is one backend. Backend implementations supply create, filesystem,
process start/wait/termination, and whole-sandbox termination operations. Other
language SDKs may project these behaviors using their native async and streaming
interfaces. No vendor SDK object belongs in Task Attempt messages.

A backend declares enforceable network modes, read-only staging, bounded
symlink-safe reads, output streaming, and input streaming when supported.
Unsupported requirements must fail before execution. Backend credentials remain
local to the Worker application.
Shared staging must reject collisions and unsafe paths; output reads must enforce
size limits before transferring data. Successful termination means execution has
stopped, not merely that a stop request was accepted.

Harnesses declare required environment capabilities. For
`supertag.process-output-streaming@1`, a process requested with `streamOutput`
provides ordered chunks carrying `stream` (`stdout` or `stderr`) and UTF-8 `text`.
The stream is bounded; overflow fails the invocation instead of silently dropping
structured events. `wait` remains authoritative for exit status. Consumers must
consume streaming output while waiting, and environment disposal must stop every
owned process, including processes the harness failed to await.

For `supertag.process-input-streaming@1`, a process requested with `streamInput`
returns `write` and `endInput` operations. Fixed `stdin` and `streamInput` are
mutually exclusive. Writes are copied, ordered, and bounded; input closes once.
Process exit, cancellation, or environment disposal revokes pending and future
writes. This duplex process contract is required by protocol bridges such as
Codex exec-server.

Cancellation has a bounded cleanup period. Cleanup uncertainty raises
`ExecutionCleanupError` in the TypeScript SDK. The durable Worklet records
`unknown` even if cancellation was requested and retains that Worker's capacity
reservation. Such Attempts must not be automatically replayed. Legacy protocol 9
Workers cannot provide the durable receipt/recovery guarantees introduced in protocol 12.

The local TypeScript process provider uses POSIX process groups and currently
rejects Windows process execution. A local working directory is not a security
sandbox; use an enforcing remote backend for that boundary.

## Automatic Task outputs

A Task opts into Worker-managed file preservation through `execution.outputs`.
This policy is normalized and frozen when the Task is accepted and travels in the
Attempt's execution requirements. A Worker Profile must advertise
`supertag.artifacts.output-policy` version `1` before it may accept such a Task.
Other profiles on the same host cannot supply this capability for it. Custom
Workers may implement the contract in any language; the built-in Python Worker
currently rejects it because it does not implement automatic output collection.

The policy has `directory` (default `outputs`), `include` (default
`["outputs/**"]`, adjusted to `directory`), `required`, `exclude`, `git` (default
`reference`, or `capture` or `ignore`), `maxFiles` (at most 100), and `maxBytes`
(at most 67,108,864). Paths are relative POSIX workspace paths. Patterns support
`*`, `**`, and `?`; traversal, absolute paths, and shell expansion syntax are
invalid. Each required pattern must match an eligible output. Required patterns
also select files outside `include`, but do not override exclusions or enforced
sensitive-file restrictions. `include` and `required` identify submitted
outputs; unrelated explicit captures remain intermediate unless selected in the
Task result. Per-file artifact API limits also apply.

Output-capable Workers must retain collected bytes and stable capture operation
identities until upload, catalog registration, and result delivery can recover
without another harness execution. Successful Task completion requires all
required outputs to be durably registered. A disposable workspace alone is not a
recovery record. Git reference mode must never treat a local-only commit or a
mutable branch as durable source preservation.
