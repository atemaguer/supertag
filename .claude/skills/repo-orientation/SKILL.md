---
name: repo-orientation
description: Decide which crate, package, or app a change belongs in. Read before adding files or moving code.
---

# Repo orientation

The services and CLI are Rust. The terminal UI is Go. The TypeScript that remains runs under
Worker Hosts, in the desktop app, or in the `supertag-ai` SDK.

## Top-level layout

| Directory | Holds |
| --- | --- |
| `core/` | The Rust workspace: `Cargo.toml`, `Cargo.lock`, the toolchain pin, `crates/*`, `test-support/` |
| `proto/` | The `supertag.runtime.v2` protobuf contract every language uses, and the shared execution provider's `supertag.environment.v2` |
| `sdks/` | One directory per language: the hand-written SDK and its generated bindings |
| `harnesses/` | Node harness bridges and Workspace providers a Worker Host starts, and their shared SDK |
| `apps/` | The Go terminal UI and the Tauri desktop app |
| `scripts/` | Repository checks, binding generation, and release, packaging, and install scripts |
| `deploy/` | Container images and platform definitions for the native services |
| `docs/` | User documentation; `docs/development/` holds contributor records |
| `examples/`, `skills/` | Examples, and instructions for agents that use SuperTag |
| `tests/` | Repository-level checks and native release and deployment smoke notes |

## Where code belongs

| Path | Owns |
| --- | --- |
| `core/crates/cli` | The `supertag` CLI, local supervisor, and process tests |
| `core/crates/control-plane` | Store, migrations, admission, scheduling, recovery, public API |
| `core/crates/gateway` | Collaboration surfaces: ingress, rendering, reply delivery, notifications |
| `core/crates/worker-host` | A Worker Host: `worklet/` registers, claims, holds leases, journals, recovers, and owns checkouts, checkpoints, held artifacts, and landings; `worker/` runs one Task Attempt: adapter, guardian, egress and provider proxies, Context Items, MCP, captures |
| `core/crates/{protocol,api,transport}` | Wire types, gRPC services, tunnel and TLS transport |
| `core/crates/local-state` | The local state directory and local Control Plane discovery, shared by the CLI and the desktop app |
| `core/crates/{workspaces,github,shared-execution,credential-vault,codex-adapter}` | Workspaces, GitHub, shared execution, credential vault, native Codex adapter |
| `proto/supertag/runtime/v2` | The public API contract; `scripts/generate-bindings.py` regenerates every binding from it |
| `sdks/typescript` | The `supertag-ai` npm SDK (`src/`) and the generated TypeScript bindings (`gen/`) |
| `sdks/python` | The `supertag` PyPI SDK (`src/supertag`, which ships its own `_runtime_v2` bindings) and the generated bindings (`gen/`) |
| `sdks/go` | The Go module `github.com/atemaguer/supertag/sdks/go`: generated messages and Connect clients |
| `harnesses/{claude-code,cursor,opencode}` | Node harness bridges a Worker Host starts |
| `harnesses/environments/{e2b,modal}` | Node Workspace providers a Worker Host starts |
| `harnesses/sdk` | `@supertag/worker-sdk`, the code those bridges share; its domain types are in `src/domain` |
| `apps/tui` | Go terminal UI; runtime.v2 client in `client/`, presentation types in `views/` |
| `apps/desktop` | Tauri desktop app; its crate depends on `core/crates` by path |

## Boundaries

- `supertag-ai` is the only public npm package; never suggest installing `@supertag/*`. Its
  entry points speak only the native services' `supertag.runtime.v2` APIs.
- A Node bridge is packaged with the native release by `scripts/node_bridges.py`; a new
  bridge needs an entry there and in `core/crates/cli/src/node_bridges.rs`.
