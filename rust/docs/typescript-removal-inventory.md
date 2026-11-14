# TypeScript removal inventory

Internal contributor record for the cutover from the TypeScript runtime to the Rust services. It
is not user documentation. It lists every TypeScript package, app, test directory, script, and
deployment definition at `6c934be8` (the last commit that contained the TypeScript runtime), the
decision to keep or remove it, and the evidence. A second step, approved on 2026-11-14 and
recorded in [Legacy protocols](#legacy-protocols) and [Bridge package pruning](#bridge-package-pruning),
deleted the `supertag.operator.v1` and Worklet protocols and pruned the kept packages to what the
Rust services start.

**Keep** means the Rust system uses it at build or run time, or the Go terminal UI, the desktop
app, the generated bindings, the documentation checks, or the capability ledger check needs it.
Everything else that only served the TypeScript Control Plane, Gateway, CLI, or Worker runtime is
removed. Removed code remains available at `6c934be8`.

Evidence was gathered with `git grep` over `rust/`, `apps/tui`, `apps/desktop`, `scripts/`,
`.github/workflows/`, `deploy/`, and `sdks/`, and by building and testing what remains.

## Packages and apps

| Path | Package | Decision | Evidence |
| --- | --- | --- | --- |
| `packages/runtime/harnesses/claude-code` | `@supertag/worker-claude-code` | Keep, pruned | `rust/crates/cli/src/node_bridges.rs` starts `dist/rust-adapter/entry.js`; `rust/scripts/node_bridges.py` packages it; `language_runtime.rs`, `github_workspace_runtime.rs`, and `support/mcp_runtime.rs` start it and its `fixtures/*.mjs`; `worker-host/src/mcp/stdio.rs` uses `fixtures/rust-mcp-stdio-provider.mjs`; `rust-port.yml` builds it |
| `packages/runtime/harnesses/cursor` | `@supertag/worker-cursor` | Keep, pruned | `node_bridges.rs` and `node_bridges.py`; `cursor_runtime.rs` starts `dist/rust-adapter/adapter.js`; `rust-port.yml` `runtime` and `linux-root` jobs build it |
| `packages/runtime/harnesses/opencode` | `@supertag/worker-opencode` | Keep, pruned | `node_bridges.rs` and `node_bridges.py`; `opencode_runtime.rs` includes `fixtures/native-opencode.mjs` and starts `dist/rust-adapter/entry.js` |
| `packages/runtime/environments/e2b` | `@supertag/worker-environment-e2b` | Keep, pruned | `node_bridges.py` packages `dist/rust-provider/main.js` as the E2B Workspace provider; `rust-port.yml` builds it |
| `packages/runtime/environments/modal` | `@supertag/worker-environment-modal` | Keep, pruned | `node_bridges.py` packages `dist/rust-provider/main.js` as the Modal Workspace provider; `rust-port.yml` builds it |
| `packages/runtime/sdk` | `@supertag/worker-sdk` | Keep, pruned | Dependency of all five bridges and `supertag-ai` (`internal/rust-harness`, `internal/rust-workspace-provider`, `internal/process-inventory`, `redaction`); `cursor_runtime.rs` loads `dist/rust-harness` and `dist/rust-workspace-provider`; `generate-bindings.py` writes `src/rust-harness/gen` |
| `packages/core` | `@supertag/core` | Keep, pruned | Dependency of `@supertag/worker-sdk` and `@supertag/worker-cursor`; 13 of 49 source files remain |
| `apps/desktop` | `@supertag/desktop` | Keep | Tauri app; `rust-port.yml` `desktop` job builds its frontend before `cargo clippy` |
| `apps/tui` | Go module | Keep | Go terminal UI started by `supertag tui`; `rust-port.yml` builds it for `operator_runtime.rs` |
| `packages/operator-api/go` | Go module | Remove (2026-11-14) | Generated `supertag.operator.v1` Go types and Connect clients. The TUI's presentation types moved to `apps/tui/views`; the protoc Go plugins it pinned moved to `rust/bindings/go` |
| `packages/operator-api` (TypeScript: `src`, `package.json`, tests) | `@supertag/operator-api` | Remove | Imported only by `apps/cli` and TypeScript tests |
| `apps/cli` | `@supertag/cli` | Remove | The TypeScript CLI and runtime composition root; the Rust CLI replaces it |
| `packages/control-plane` | `@supertag/control-plane` | Remove | TypeScript Control Plane; no import from kept code |
| `packages/store` | `@supertag/store` | Remove | Drizzle store and migrations for the TypeScript Control Plane; Rust has its own migrations in `rust/crates/control-plane/migrations` |
| `packages/surfaces/{sdk,slack,github,lark,linear,teams}` | `@supertag/surface-*` | Remove | TypeScript Gateway connectors; the Rust Gateway replaces them |
| `packages/runtime/transport` | `@supertag/worker-transport` | Remove | TypeScript Worklet transport (`supertag.worklet.v1`); used only by `apps/cli`, `supertag-ai`, and tests |
| `packages/runtime/harnesses/codex` | `@supertag/worker-codex` | Remove | No Node bridge for Codex: `node_bridges.rs` lists only Claude Code, Cursor, and OpenCode, and the Rust `codex-adapter` crate runs Codex natively |
| `packages/runtime/resources/github` | `@supertag/worker-github` | Remove | TypeScript Worker resource; imported only by `apps/cli` |
| `packages/runtime/environments/shared-execution` | `@supertag/worker-environment-shared-execution` | Remove | TypeScript shared execution; Rust has `rust/crates/shared-execution`. No kept package depends on it |
| `packages/supertag-ai` | `supertag-ai` (npm) | Keep, reduced (2026-11-14) | The TypeScript SDK, as the approved design keeps it: only `control-plane-client` (`createControlPlaneClient`) and `harness` (`openHarness`, effect receipts), which speak `supertag.runtime.v2`. The CLI, Control Plane, store, transport, surfaces, Worker, and harness entry points stay removed. `scripts/verify-control-plane-client.mjs` runs against the native Control Plane and a Worker Host in `rust-port.yml` |
| `deploy/shared` | `@supertag/deployment` | Remove | Served only `apps/cli`'s `setup deployment --platform railway|fly` and `deploy/generate.ts`; `rust/crates/cli/src/deployment.rs` is the Rust port |
| `deploy/cloudflare` | `supertag-cloudflare-deployment` (own npm lockfile) | Keep | Native-service tunnel Worker; `rust/scripts/smoke_deployment_http_platforms.py` reads `src/routing.ts`; `tests/cloudflare-tunnel-worker.test.ts` tests it |

## Deployment definitions

| Path | Decision | Evidence |
| --- | --- | --- |
| `deploy/docker/rust-service.Dockerfile`, `rust-release.Dockerfile`, `rust-hosted-entrypoint.sh`, `rust-hosted-pair.sh` | Keep | Used by `rust/scripts/native_release_docker.py`, `smoke_deployment_http_platforms.py`, and `split_service_images.py` |
| `deploy/compose.native.yaml`, `compose.native.ingress.yaml`, `deploy/native/`, `deploy/render/`, `deploy/modal/` | Keep | Named by `rust/crates/cli/src/deployment.rs` and the Rust smoke scripts |
| `deploy/docker/worker/Dockerfile` | Keep | Workspace sandbox base image, independent of the runtime language; `publish-worker-base.yml` |
| `deploy/docker/Dockerfile`, `Dockerfile.dockerignore`, `entrypoint.sh`, root `.dockerignore` | Remove | Built the TypeScript CLI image (`pnpm --filter @supertag/cli deploy`); Rust images build from isolated contexts |
| `deploy/compose.yaml`, `deploy/.env.example` | Remove | Started the TypeScript Control Plane |
| `deploy/fly/`, `deploy/railway/`, `deploy/generate.ts` | Remove | TypeScript Fly.io and Railway definitions and their generator; `deploy/native/fly` and `deploy/native/railway` replace them |

## Tests

| Path | Decision | Evidence |
| --- | --- | --- |
| `tests/*.test.ts` (304 of 306 files) | Remove | Import `apps/cli`, `packages/control-plane`, `packages/store`, transport, surfaces, or removed scripts |
| `tests/cloudflare-tunnel-worker.test.ts` | Keep | Tests `deploy/cloudflare` |
| `tests/operator-docs.test.ts` | Keep | Documentation guard; reads only Markdown |
| `tests/spec/wire-schemas.test.ts` | Keep, trimmed | Validates the JSON Schemas left in `spec/`; the cases for the deleted manifest, Task Attempt, and Worklet schemas are removed |
| `tests/e2e/`, `tests/runtime/` | Remove | Drive the TypeScript Control Plane, Worklets, and MCP proxies |
| `tests/fixtures/*` except `rust-harness-interop` | Remove | Docker, gRPC, and Python fixtures for the TypeScript Worklet protocol |
| `tests/fixtures/rust-harness-interop` | Keep | Standalone Rust interoperability spike; `ci.yml` `rust-harness-interop` job |
| `tests/support/` | Remove | The first step kept 10 helpers for tests in kept packages; after the pruning no remaining test imports any of them |
| `tests/rust-port-baseline/` old and Rust drivers, `cases.json`, `baseline.test.ts` | Remove | The old driver imports the TypeScript Control Plane and store; the Rust driver's adapter imports `packages/supertag-ai/dist/harness.js`. The design retires the baseline at cutover |
| `tests/rust-port-baseline/capability-ledger.test.ts` | Keep, converted | See [Capability ledger](#capability-ledger) |
| `tests/rust-port-cutover/` | Keep | Fresh-state cutover rehearsal. `rehearse.py` archives a legacy commit with `git archive` and runs `legacy.ts` inside that snapshot, so it needs a legacy commit at or before `6c934be8`, not this checkout's TypeScript |
| `tests/native-deployment/`, `tests/native-release/` | Keep | Native service and release rehearsals |
| `packages/runtime/environments/{e2b,modal}/*-live.ts` (codex-split, session, shared-execution, mixed-mcp) | Remove | Drove the TypeScript Worker runtime with the removed Codex harness and shared-execution package |
| `packages/runtime/environments/modal/modal-native-mounts.test.ts` | Remove | Imports `apps/cli/src/host-volumes.js` |
| `apps/tui/e2e_test.go` | Remove | Opt-in end-to-end test that launched the TypeScript CLI (`apps/cli/src/index.ts` through `tsx`); `operator_runtime.rs` drives the TUI through the Rust CLI |
| Tests inside kept packages | Keep those of kept code | See [Bridge package pruning](#bridge-package-pruning) |

## Scripts and examples

| Path | Decision | Evidence |
| --- | --- | --- |
| `scripts/check-docs*.mjs`, `docs-*.mjs`, `*.test.mjs` | Keep, updated | `pnpm docs:check`; now checks every command and flag against `docs/reference/cli.md`. The install test requires the native install; the first-run and freed-page tests were removed with the pages they checked. The `typescript` CI job runs `node --test scripts/*.test.mjs`, which no job ran before |
| `scripts/check-proto-generation.mjs`, `check-proto-breaking.mjs`, `protoc-gen-manifest-schema.mjs`, `protoc-gen-operator-docs.mjs` | Remove (2026-11-14) | Generated and checked outputs of `spec/proto`, which is deleted; `rust/scripts/generate-bindings.py --check` checks the remaining bindings |
| `scripts/check-docs-node.mjs` | Keep, updated | No longer reads the sandbox MCP bridge's Node minimum from the removed `sandbox-workspace-environment.ts`; every page must name the package's Node requirement |
| `scripts/install-harness-clis.mjs` | Keep, reduced | Installs Claude Code for the kept harness tests; the Codex part read the removed Codex package |
| `scripts/with-test-postgres*.mjs`, `test-verify*.mjs`, `check-migration-journals*.mjs` | Remove | Served the TypeScript store and its PostgreSQL suites |
| `scripts/harness-conformance.ts`, `server-harness-conformance.ts`, `codex-*`, `session-*`, `sandbox-conformance.ts`, `manager-isolation-probe*.ts`, `cli-operator-live.ts`, `check-cli-deployment.ts`, `hosted-render-validation*.ts`, `artifact-*`, `*-organization-*`, `coordination-grpc-live.ts`, `worklet-*`, `test-mixed-harness-grpc-live.mjs`, `proto-python-conformance.mjs`, `scripts/fixtures/` | Remove | Live and conformance runners for the TypeScript runtime; each imports a removed package or drives the TypeScript CLI |
| `scripts/stage-cli-release.sh`, `verify-public-installer.sh`, `notarize-release-tui.sh`, `install.sh` | Remove | The npm `supertag-ai` release and installer chain |
| `examples/organizations/` | Keep | Manifests only |
| `examples/custom-worker/*.py` | Keep | `sdks/python/tests/test_custom_worker_example.py` runs `verify.py` in process |
| `examples/custom-worker/*.mjs`, `package.json` | Remove | Used `supertag-ai` |
| `examples/ongoing-support/`, `examples/shared-organization/`, `examples/objective-walkthrough/` | Remove | Drove the TypeScript services through `supertag-ai`, JavaScript Workers, and WebSocket Worklets |

## CI workflows

| Workflow | Decision | Change |
| --- | --- | --- |
| `ci.yml` | Keep, updated | Dropped the TypeScript `verify` job (store migrations, `pnpm test` over the TypeScript runtime, `supertag-ai` packaging, CLI deployment check) and `compatibility`. Added `typescript` (Node 22.13.0 and 24: install, Claude Code CLI, `pnpm check`, `pnpm build`, `pnpm test`, and `node --test scripts/*.test.mjs`, with full history so the ledger check can confirm its committed lists). `protocol-conformance` is removed with `spec/proto` (2026-11-14). The `typescript` job also typechecks `supertag-ai`. `rust-harness-interop`, `python-sdk`, and `tui` are unchanged |
| `rust-port.yml` | Keep, updated | Builds the five bridges and the TUI and runs the Rust, Linux-root, desktop, crash-durability, and bindings jobs. The `runtime` job runs `supertag-ai`'s `test:package` with the built CLI; the operator API Go module is gone from its path filters |
| `native-release-check.yml` | Keep | Native archives; header comment no longer names the removed workflows |
| `publish-python.yml` | Keep, manual only | No longer runs on `release: published`: with the npm workflows removed, a GitHub Release would otherwise publish only the Python SDK. See decision 4 |
| `publish-worker-base.yml` | Keep | Workspace base image; unchanged |
| `publish.yml`, `release-cli.yml`, `verify-installer.yml` | Remove | Published `supertag-ai` to npm, uploaded `install.sh`, and verified the npm installer |

## Root configuration

`pnpm-workspace.yaml` drops `deploy/shared`, the `keytar` build allowance, and the Microsoft
Teams release-age exclusions. `tsconfig.json` references only the kept packages;
`tsconfig.simulation.json` and `tsconfig.benchmarks.json` are removed. `package.json` drops the
store, CLI, `supertag-ai`, deployment-generator, Docker, and live-runner scripts, the
`postinstall` Drizzle generation, and the `ws` dev dependencies, and makes `pnpm supertag` run the
Rust CLI through `cargo run`. The second step removes `buf.yaml`, `buf.gen.yaml`, the `proto:*`
scripts, and `pnpm check`'s protobuf step, and drops `better-sqlite3`.

## Legacy protocols

Approved on 2026-11-14 (decision 4 below). The native services speak only `supertag.runtime.v2`
from `rust/proto`; nothing served the older contracts.

| Removed | What it was |
| --- | --- |
| `spec/proto` (`supertag.operator.v1`, `worklet.v1`, `environment.v1`, `session.v1`, `artifact.v1`, `coordination.v1`), `buf.yaml`, `buf.gen.yaml`, `spec/proto/accepted-breaking-changes.json` | The TypeScript-era protobuf contracts and their Buf configuration |
| `packages/operator-api/go` | Generated `operatorv1` Go types and Connect clients |
| `spec/manifests/`, `docs/reference/operator-api/` | Manifest JSON Schemas and the operator API reference generated from `operator.v1` |
| `spec/worklet-transport.md`, `worklet-descriptor`, `worklet-transport-message`, `worker-host-descriptor`, `task-attempt-spec`, and `task-attempt-event` schemas, `spec/fixtures/worklet-transport/` | The Worklet wire protocol (version 18) |
| Python `supertag.operator` and `supertag/operator/v1`, `scripts/generate_operator_api.py`, `examples/message_tag.py` | The Python Connect client for `operator.v1` |
| Python `supertag.transport` (`WorkletConnection`), `supertag.durable` (`DurableLocalWorklet`, `FileAttemptJournal`), `WORKLET_PROTOCOL_VERSION`, the protocol 18, transport, and durable tests, and `examples/codex_worker.py` and `openai_agents_worker.py` | The Python side of the Worklet protocol; the examples connected Workers over it |
| The TUI's Connect-over-HTTP/1.1 client (`client.New` for `operator.v1`, the `FollowMessage` follower, legacy watch frames) and every `RuntimeV2()` branch | The TUI's path to the TypeScript Control Plane |

The terminal UI keeps its presentation model as plain Go structs in `apps/tui/views`, generated
once from the removed `operatorv1` types and pruned to the fields it reads; `runtime.v2` replies
are projected into them as before. The handover must name protocol `runtime.v2`. The TUI's client
tests for the `operator.v1` fake (30) are removed; the `runtime.v2` client tests stay. The main
package's fake Control Plane now serves `runtime.v2` Tags, Worker Hosts, Teams, and Workstream
posts; 36 tests whose fixtures needed `operator.v1` conversation history, follow streams,
Objectives, inbox items, or creation are removed, and `operator_runtime.rs` drives the built TUI
against a real Control Plane. The protoc Go plugins that `rust/scripts/generate-bindings.py` runs
are now pinned in the `rust/bindings/go` module. The remaining `spec/` schemas (resource envelope,
`supertag.yaml`, Objective, Team, Workstream post) keep their tests.

## Bridge package pruning

Approved on 2026-11-14 (decision 5 below). The kept packages were pruned at declaration level:
starting from the files the Rust side starts or loads (each `rust-adapter/entry.ts`, Cursor's
`rust-adapter/adapter.ts`, `runner.ts`, and `stop-watchdog-main.ts`, the E2B and Modal
`rust-provider/main.ts`, the Worker SDK's `rust-harness` and `rust-workspace-provider` modules
including `transport.ts`, the generated bindings, and `supertag-ai`'s two entry points), the
TypeScript checker followed every identifier to its declaration, and each top-level declaration
nothing reachable uses was removed. 65 source files were deleted and 28 trimmed; the Worker SDK
went from about 37,300 to 9,300 lines outside its generated bindings.

Tests that exercised only removed code went with it (70 test files, including the Worker, harness,
environment, Worklet, artifact store, and conformance suites, and the live runners behind the root
`test:*:live` scripts). The redaction and Claude query tests lose only the cases for removed
functions. Dependencies nothing imports any more (`@aws-sdk/client-s3`, `better-sqlite3`, unused
`zod`) and the Worker SDK's `installed-cli` export are removed.

Some types from the Worklet era remain because live code still reaches them: the E2B and Modal
providers construct `SandboxExecutionEnvironmentProvider` for its options, which keeps
`TaskAttemptSpec` and related interfaces. Narrowing those is a follow-up refactor, not dead-code
removal.

## Capability ledger

`tests/rust-port-baseline/capability-ledger.test.ts` cited TypeScript test files that no longer
exist, and required every tracked TypeScript test file to be cited. The ledger is frozen at
`6c934be8`, and the test now:

- still checks every cited Rust test name against the current Rust sources, so renaming or
  deleting Rust evidence fails;
- requires every other cited path (Rust, Go, Python, scripts, and docs included) to exist now,
  unless it is in `tests/rust-port-baseline/removed-at-cutover.txt`, the 1,367 tracked files at
  `6c934be8` that the cutover deleted (both steps). A later deletion of a cited file therefore fails;
- checks the test-file assignment against `frozen-test-files.txt`, the 591 TypeScript, Go, and
  Python test files at `6c934be8`.

Both lists are committed, so `pnpm test` passes in a shallow clone or a source archive. When the
freeze commit is present, one more test confirms the lists against it; the `typescript` CI job
checks out full history so that test runs. Converting the check to a Rust test was rejected: it
would duplicate the Markdown parser in Rust for a frozen document, and Vitest still runs for the
kept packages.

## Documentation

`scripts/check-docs.mjs` previously read command help from the built TypeScript CLI. It now checks
every page against `docs/reference/cli.md`, the reference generated from the Rust CLI's help
(moved from `rust/docs/cli-reference.md`), including plain `supertag`, which opens the terminal UI.
The documentation pass rewrote README, every page under `docs/`, and `skills/` for the Rust system,
including `docs/guides/deployment-setup.md`, the Fly.io and Railway guides (against
`deploy/native`), and a harness adapter guide that replaced the Python Worker, custom Worker, MCP
routing, and shared execution pages. The protocol removal deleted the generated operator API
reference, pointed `spec/objectives.md` and `spec/workstreams.md` at `runtime.v2`, and reduced the
`supertag-ai` and Python SDK READMEs to the remaining entry points. No page is exempt from the
command check. The ledger row "Documentation describes the shipped product" records the remaining
semantic pass over the long reference pages.

## Decisions for the operator

1. **npm package and installer.** Partly decided on 2026-11-14: `supertag-ai` stays as the npm
   TypeScript SDK with `control-plane-client` and `harness`. `install.sh` and the npm release
   workflows stay removed, and no workflow publishes `supertag-ai` or native archives. Choose the
   native distribution channel (GitHub Release assets with a new curl installer, an npm launcher,
   or both) and how `supertag-ai` is published before the next release.
2. **Ledger rows this removal puts into effect.** Removing the TypeScript code makes each row
   below final in this checkout, though the ledger still records it as awaiting approval. Approve
   them, or keep the code, before the removal merges. The code remains at `6c934be8`.
   - Proposed drops:
     - `{ secretRef: NAME }` stdio MCP environment references ("stdio MCP servers and MCP
       credential redirect protection").
     - The metrics inbox section, native subagent figures, reservations, reply retries, RPC
       counters, and separate placement latency ("Workstream post store, coordination metrics,
       spend aggregation").
     - The `task.worker-host-removed` Task event ("Auth Keys, enrollment, revoke, drain/resume
       hosts").
     - The TypeScript operator commands without a Rust command: `message tag`,
       `message objective`, `watch inbox`, `--output yaml`, `worker-profile`, `delete --dry-run`,
       `delete surface`, `enroll worker-host --out`, `create objective --workspace|--dry-run`, and
       `list objective --owner`.
   - Changes not yet approved:
     - JSON written with `\u` escapes for unsafe characters, and exit code 2 for usage errors
       ("CLI help, plain language, terminal safety").
     - The audit sink is off unless configured, where TypeScript wrote to standard error.
     - Revoking a removed host stays an explicit `supertag host revoke`.
     - No Workspace write-back after a failed Task Attempt, and no whole-bucket S3 sources.
   - Open: redacting host-supplied uncertainty reasons, marked "to port in the final cleanup
     pass". After the removal its TypeScript reference exists only at `6c934be8`.
   - Partial: the 53 Partial rows keep their recorded gaps; their TypeScript reference
     implementation now exists only at `6c934be8`.
3. **User documentation rewrite.** 50 pages still describe the TypeScript CLI, npm installation,
   `supertag-ai` custom Workers, and Docker Compose with the removed `deploy/compose.yaml`
   (`docs/operations/control-plane.md`, `skills/deploy-supertag`). Approve rewriting them against
   the Rust CLI, which removes the pending list.
4. **Legacy protocol definitions.** Decided and done on 2026-11-14; see
   [Legacy protocols](#legacy-protocols). Before that, `spec/proto` still held `supertag.worklet.v1`,
   `environment.v1`, `session.v1`, `artifact.v1`, and `coordination.v1`, which no kept code uses,
   and `supertag.operator.v1`, which only the terminal UI uses for its view types. The
   `spec/*.schema.json` wire schemas, `docs/reference/operator-api`, and the Python SDK's
   `supertag/operator/v1` bindings come from the same era. Decide whether to delete them (an
   accepted breaking change for `proto:breaking`) and move the TUI to the `runtime.v2` Go bindings.
   No file under `rust/crates` serves `supertag.operator.v1`, so the Python SDK's operator client
   cannot reach a Rust Control Plane. `publish-python.yml` stays manual only; decide what the next
   Python SDK release contains before running it.
5. **Pruning inside kept packages.** Decided and done on 2026-11-14 for the TypeScript packages;
   see [Bridge package pruning](#bridge-package-pruning). The Python SDK keeps its in-process Worker
   composition (`create_worker`, `LocalWorklet`, the Codex harness, conformance helpers) because
   the OpenAI Agents adapter is built on part of it; pruning it to the adapter is open.
6. **Existing npm installations.** `rust/scripts/install_native_release.py` recognizes the npm
   `install.sh` layout so a native install can replace it. Keep or remove that recognition.
7. **Version numbering.** The root `package.json` and the Python SDK say `0.2.0-alpha.9`, which
   mirrored the removed `supertag-ai`; `scripts/check-docs.mjs` and the Python pin test read
   "the release" from the root `package.json`. The Rust workspace, the native archive, and the
   terminal UI build say `0.1.0` (`rust/Cargo.toml`). Choose the next release's version and its
   single source. Picking a release number is a release decision, so it was not done on this
   branch.

## Follow-ups not done here

- Rust source comments that cite removed TypeScript files as the origin of a port (45 files
  under `rust/crates`) were left unchanged to keep this branch mergeable with concurrent
  Rust work.
- `CHANGELOG.md` gets its entry at integration, per `AGENTS.md`.
- `ROADMAP.md` still links the removed Fly.io guide; it was left alone because it has
  uncommitted operator edits elsewhere.
