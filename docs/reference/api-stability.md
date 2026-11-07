# API stability

SuperTag is still below version 1.0. This page explains which contracts
extension authors can rely on and how changes are communicated.

If the [organization](glossary.md#autonomous-organization) and execution terms are new, start with
[core concepts](../concepts/README.md).

This page uses these SuperTag terms, each defined in the glossary: [Tag](glossary.md#tag),
[Role](glossary.md#role), [Objective](glossary.md#objective), [Team](glossary.md#team),
[Task](glossary.md#task), [Task Attempt](glossary.md#task-attempt), [Session](glossary.md#session),
[Context Set](glossary.md#context-set), [Context Item](glossary.md#context-item),
[Permission Set](glossary.md#permission-set), [Control Plane](glossary.md#control-plane),
[Worker Host](glossary.md#worker-host), [host service](glossary.md#host-service),
[Worklet API](glossary.md#worklet-api), [Worklet](glossary.md#worklet),
[Worker](glossary.md#worker), [Volume](glossary.md#volume), [Workspace](glossary.md#workspace),
[Runtime Input Provider](glossary.md#runtime-input-provider),
[Runtime Input](glossary.md#runtime-input), [Context Resolver](glossary.md#context-resolver),
[Tool Adapter](glossary.md#tool-adapter), [Tool Provider](glossary.md#tool-provider), and
[Workspace Resolver](glossary.md#workspace-resolver).

## What counts as a public contract

A contract is public only when it is documented as public and exported from a
supported `supertag-ai` package entry point, or published as a Control Plane Worklet API
protocol or Control Plane resource schema. A TypeScript export alone does not make an API
stable.

Files inside workspace packages, database tables, CLI implementation details,
and undocumented exports are internal. Depending on them may require changes
at any time.

## Stability levels

| Level | Meaning |
| --- | --- |
| Stable | Intended for long-term use. Breaking changes follow the release and deprecation rules below. |
| Beta | Ready for real use, but feedback may require breaking changes in a minor pre-1.0 release. |
| Experimental | An early design that may change or disappear without a deprecation period. |
| Internal | An implementation detail with no compatibility promise. |

## Current stability by API area

### Wire and coordination contracts

| API area | Level | Compatibility boundary |
| --- | --- | --- |
| Task Attempt, event, Worker Host descriptor, Worklet descriptor, and transport JSON schemas | Beta | Published wire fields, versions, and checked-in fixtures |
| Task result `findings` and the harness `Finding:` line format | Experimental | The [finding shape and rules](coordination.md#review-findings): severities, statuses, Control Plane ids, and strict validation; `read_task` `openFindings` |
| Closing findings: `update_task` `finding`, result `fixedFindings`, and the harness `Fixed finding:` line format | Experimental | The [closure rules](coordination.md#closing-a-finding): who may close each severity, re-review acceptance, `closedBy`, `closedAt`, and `findingClosures` |
| Worklet transport behavior | Beta | Negotiation, registration, heartbeat, dispatch, cancellation, and ordered events |
| Protobuf/gRPC adapters | Experimental | Compatibility and conformance foundations; Worklet connections to HTTP(S) origins choose gRPC by default |

### Worker and provider contracts

| API area | Level | Compatibility boundary |
| --- | --- | --- |
| `Worklet`, Worker Host descriptor, and `Worker` SDK contracts | Beta | Behavior in the [Worker SPI](../../spec/worker-spi.md), not exact cross-language method spelling |
| Standard `createWorker` and `create_worker` composition | Beta | Produces a Worker that resolves inputs, plans, provisions, executes, normalizes, and cleans up |
| `Harness` contract | Beta | Capability declaration, plan/start lifecycle, normalized events, and continuity behavior |
| Execution Environment Provider contract | Beta | Provision/prepare/process/dispose behavior and declared placement/lifetime |
| Runtime Input Provider, Context Resolver, and Workspace Resolver contracts | Beta | Versioned Context types, fail-closed capability matching, admitted-input resolution, and Runtime Input provenance |
| Tool Provider and Tool Adapter contracts | Experimental | Semantic capability boundary and normalized calls; concrete adapter APIs may change |

### Resources and execution environments

| API area | Level | Compatibility boundary |
| --- | --- | --- |
| Workspace resource, in-place workspace inputs, `WorkspaceResolver.finalize`, `WorkspaceEnvironmentResolver`, source credentials, pull-request publishers, and `requestSurfaceActionApproval` | Experimental | Named Workspaces served as per-Task git worktrees of declared checkouts or host-managed clones, with GitHub pull-request delivery; later steps add other environments |
| Volume resource: `spec.source`, `spec.credential`, and `apply`, `get`, `list`, and `describe volume` | Experimental | Named `s3://`, `r2://`, and `file://` storage locations that hold a credential name, never a value |
| Host `volume-credentials` mappings `{ modal-secret: NAME }`, `{ modal-oidc-role: ARN }`, and `{ modal-volume: NAME }` | Experimental | Provider-held native bucket authentication and exact-name Modal Volume consent; OIDC is S3 only. Copies refuse these references. |
| Volume `gs://BUCKET/PREFIX/` sources | Experimental | Modal native GCS mounts; copy refuses this scheme. |
| Volume `modal-volume://NAME/PREFIX/` sources | Experimental | Required credential maps to exact-name host consent. Mounted with declared access in the host's configured Modal environment; all source queries and copy are refused. |
| Native Modal mount live suite: `SUPERTAG_MODAL_MOUNTS_LIVE`, `SUPERTAG_MODAL_MOUNTS_BUCKET`, `SUPERTAG_MODAL_MOUNTS_SECRET`, `SUPERTAG_MODAL_MOUNTS_VOLUME` | Experimental | Opt-in bucket and Modal Volume reads and read-write checks; see [contributor verification](../../CONTRIBUTING.md#live-modal-native-mounts). |
| Storage durability reporting: Task `status.storage`, the `ps` JSON row `ephemeral`, and the storage lines and warnings in `ps`, `describe`, `up`, and `connect worklet` | Experimental | Worker Host durability from `status.ephemeral`, remote sandboxes counted as ephemeral, and where each Task file, output, and artifact copy lives; see [storage durability](resource-model.md#storage-durability) |
| Workspace environment contract: `WorkspaceEnvironment`, `LocalWorkspaceEnvironment`, `SandboxWorkspaceEnvironment`, `E2BWorkspaceEnvironment`, `ModalWorkspaceEnvironment`, Workspace bundles, `PreparedWorkspaceCache`, `deliverWorkspace`, and `runWorkspaceEnvironmentConformance` | Experimental | `refuse`, `prepare`, `start`, `finalize`, and `evict` over a trusted Workspace definition; prepared digests, warm prepare, fixed cache and bundle limits, and checked ref delivery; Worker Hosts select local, e2b, or Modal through the host service `environment` |

### Public interfaces and internals

| API area | Level | Compatibility boundary |
| --- | --- | --- |
| `SessionStateStore` and continuity resolution | Beta | Exact-ref matching and resume → replay → fresh behavior |
| Shipped Codex, Claude Code, local execution, E2B, MCP, and collaboration surface providers | Experimental | Provider IDs and documented configuration only; implementation details are not contracts |
| Control-plane resource API and CLI commands | Beta | Documented resource shapes and commands; output prose is not machine-stable |
| `supertag message objective --reply-to MESSAGE_ID` and `supertag recover worklet --host NAME` | Beta | Flag names and meaning: answer one pending question by message ID; select the host service whose journal recovery writes. Error prose is not machine-stable |
| `supertag start objective ID [--output json]` | Beta | Starts an Objective created with `--no-start` through `start_objective`; text is for people and JSON is the structured start result |
| `supertag message tag`, the `/api/v1/tags/:name/messages` routes and their reply stream, and the conversation tools `list_sessions`, `search_sessions`, `read_session`, `list_objectives`, `start_session`, `continue_session`, `ask`, `message_parent`, and `skip_reply` | Experimental | Routes, message record fields including `startedSessions`, AI SDK UI message stream parts (`text-*`, `data-activity`, `finish`, `error`), tool names and inputs, and work Session limits (four per turn, eight unfinished per conversation, four running); output prose is not machine-stable |
| Tag messaging HTTP v1 and `supertag-ai/messaging` | Experimental | Authenticated Tag addressing, message types, idempotency, leases, processing receipts, Team channel access and post types, and Objective definitions/completion |
| `supertag-ai/control-plane` embedding API | Experimental | Control Plane service boundary; no persistence-schema compatibility promise |
| Conformance helpers and test fixtures | Beta | Published assertions and fixtures; helper implementation details may change |
| Undocumented exports, package internals, and database tables | Internal | No compatibility promise |

No current contract is Stable merely because an SDK exports it. Exact status is
also recorded at the relevant package entry point. When a language SDK uses
idiomatic names, wire compatibility is defined by its explicit encoder/decoder,
not by matching in-memory member names across languages.

Worker descriptors require `profileCapabilities`; Worker-wide claims do not substitute for
profile declarations. TypeScript Context Resolvers require `outputKinds`, and Runtime Input
Providers require `contextOutputs` for each advertised context contract. Omission declares no
Context Item outputs; providers cannot emit outputs for another provider's contract. Internal
coordination and context selection helpers require an explicit profile. TypeScript harnesses
require explicit `sessions` declarations, including when session support is disabled.

## Package entry points

Each `supertag-ai` import path has its own stability level:

| Import | Level | Main exports |
| --- | --- | --- |
| `supertag-ai` | Beta | `createWorker`, `LocalWorklet`, `LocalExecutionEnvironmentProvider`, `LocalHarnessRuntimeProvider`, `connectWorklet`, `defaultTaskResult`, and core Worker types |
| `supertag-ai/core` | Beta | Tag, Role, Context Set, Permission Set, Task, Session, and other surface-neutral domain contracts |
| `supertag-ai/worker` | Beta | Worker, harness, execution environment, Context Resolver, tool, and `SessionStateStore` contracts |
| `supertag-ai/testing` | Beta | Conformance probes such as `runWorkerConformance` and `assertConformance` |
| `supertag-ai/surfaces` | Beta | Custom collaboration surface contract and Markdown pipeline |
| `supertag-ai/transport` | Experimental | Persistent remote Worklet connection, protocol, and gRPC adapters |
| `supertag-ai/messaging` | Experimental | Tag messaging, Team channels, and the custom Worker consumer |
| `supertag-ai/coordination` | Experimental | `CoordinationClient` and the redacted coordination inbox contract |
| `supertag-ai/control-plane` | Experimental | Embeddable Control Plane service boundary |
| `supertag-ai/spec/*` | Experimental | Language-neutral JSON Schemas and fixtures |
| `supertag-ai/harnesses/codex`, `/claude-code`, `/cursor`, `/opencode` | Experimental | Shipped Codex, Claude Code, Cursor, and OpenCode harnesses |
| `supertag-ai/environments/e2b`, `/modal`, `/shared-execution` | Experimental | Shipped E2B, Modal, and shared execution environments |
| `supertag-ai/resources/github` | Experimental | Permission-derived MCP and workspace integrations |

The root entry point re-exports the common Worker and Worklet symbols, including `createWorker`,
`LocalWorklet`, and `connectWorklet`. Import them from `supertag-ai`. The same symbols are also
exported from `supertag-ai/worker` or `supertag-ai/transport`; either path works.

Concrete scheduling selection helpers and process-output buffering are internal. Artifact
transfer signing, verification, grant bounds, and the transfer HTTP path are also internal.
These helpers are not exported from `supertag-ai/worker`. Documented extension helpers,
including `descriptorForProfile` and `LocalHarnessExecutionControl`, remain available.

The Python SDK exposes `create_worker`, `WorkerOptions`, and `RuntimeInputProvider` for Worker
composition. `RuntimeInputPipeline` is internal and is not exported from `supertag` or listed in
`supertag.runtime.__all__`. Python remote Worklets use protocol 18 only, authenticate with
`credential`, and require `DurableLocalWorklet` with a persistent journal.

## Release policy

SuperTag uses semantic version numbers, with these pre-1.0 rules:

- patch releases should contain compatible fixes and documentation changes;
- minor releases may change Beta contracts and may remove Experimental ones;
- known breaking changes are called out in the changelog and release notes;
- security or data-integrity fixes may require an immediate incompatible
  change.

Before 1.0, there is no guaranteed deprecation window. When practical, a Beta
API is marked deprecated for at least one published minor release before it is
removed. Experimental and Internal APIs may be changed without that period.

After 1.0, removing or incompatibly changing a Stable contract requires a major
release. The project intends to provide a documented migration and at least one
minor release or 60 days of deprecation, whichever is longer, unless keeping
the behavior would create a security or data-integrity risk.

## CLI and Control Plane versions

The CLI and the Control Plane are released together, so the safest pair is the same version. A
teammate's CLI can still drift from a shared Control Plane. A newer CLI may send a field that an
older Control Plane rejects. This policy says which pairs SuperTag supports.

| CLI and Control Plane | Support | CLI warning |
| --- | --- | --- |
| Same version | Supported | None |
| Same major and minor, different patch | Supported | None |
| Same major and minor, different prerelease, such as `0.2.0-alpha.1` and `0.2.0-alpha.2` | Supported | Yes |
| From 1.0 on, one minor release apart in either direction | Supported | Yes |
| Before 1.0, different minor releases, such as `0.2` and `0.3` | Not supported | Yes, stronger |
| Further apart, or different major releases | Not supported | Yes, stronger |

Before 1.0, a minor release may break compatibility the way a major release does later. A
prerelease difference is supported, but prereleases can still change commands.

`supertag version` prints both versions and the pair's support. Other commands print at most one
warning per command to stderr, never to stdout. Set `SUPERTAG_NO_VERSION_WARNING=1` to silence it,
for example in CI. When a Control Plane on another version rejects a request with HTTP 400, or
with a 404 for an unknown route, the CLI adds a hint naming both versions.

Every Control Plane response carries a `SuperTag-Version` header, including errors. The
unauthenticated `GET /healthz` also returns `version` in its body and nothing else about the
build. The CLI sends `SuperTag-Client-Version` on each request. A Control Plane without the
header predates version reporting, so the CLI cannot judge the pair.

Worklets require transport protocol 18 and durable acceptance for remote execution. Older transport
versions and the `pairingToken` handshake are rejected. `supertag describe worker-host` shows the
negotiated protocol. Connections follow the [Worklet transport](../../spec/worklet-transport.md)
rules.

## Contract changes

A proposal is required before changing a lasting public contract. The process
is described in
[CONTRIBUTING.md](../../CONTRIBUTING.md#propose-a-contract-change).

A contract proposal should answer:

- Which stability level does the contract have?
- Can old and new implementations communicate safely?
- What happens to persisted data and in-flight Tasks?
- Can callers detect that a capability is unsupported?
- What migration and conformance tests are needed?

Bug fixes that make an implementation match its documented contract are not
normally breaking changes, even when someone relied on the bug.

## Deprecation notices

Deprecations should identify the replacement, the first deprecated version,
and the earliest possible removal version. Notices belong in generated or
runtime warnings where useful, the changelog, release notes, and the relevant
reference documentation.

Objectives use the experimental [Objective API](../../spec/objectives.md). Tag credentials
can read owned Objectives and those their active Teams serve; only the owner or an
operator may change Objective status. Team membership does not grant messaging rights.
