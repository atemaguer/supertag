---
name: repo-orientation
description: Decide which crate, package, or app a change belongs in. Read before adding files or moving code.
---

# Repo orientation

The services and CLI are Rust. The terminal UI is Go. The TypeScript that remains runs under
Worker Hosts or in the desktop app. `rust/docs/typescript-removal-inventory.md` records why each
TypeScript package stays.

## Where code belongs

| Path | Owns |
| --- | --- |
| `rust/crates/cli` | The `supertag` CLI, local supervisor, and process tests |
| `rust/crates/control-plane` | Store, migrations, admission, scheduling, recovery, public API |
| `rust/crates/gateway` | Collaboration surfaces: ingress, rendering, reply delivery, notifications |
| `rust/crates/worker-host` | Execution supervision, journal, adapters, MCP, artifacts |
| `rust/crates/{protocol,api,transport}` | Wire types, gRPC services, tunnel and TLS transport |
| `rust/crates/{workspaces,github,shared-execution,credential-vault,codex-adapter}` | Workspaces, GitHub, shared execution, credential vault, native Codex adapter |
| `rust/proto`, `rust/bindings` | `supertag.runtime.v2` contract and generated Go, TypeScript, and Python bindings |
| `packages/runtime/harnesses/{claude-code,cursor,opencode}` | Node harness bridges a Worker Host starts |
| `packages/runtime/environments/{e2b,modal}` | Node Workspace providers a Worker Host starts |
| `packages/runtime/sdk`, `packages/core` | Shared code for those bridges |
| `apps/tui` | Go terminal UI; uses `packages/operator-api/go` types |
| `apps/desktop` | Tauri desktop app |
| `sdks/python` | Python SDK and harness adapters |
| `deploy/` | Container images and platform definitions for the native services |

## Boundaries

- No package in this checkout is published to npm. Never suggest installing `@supertag/*`.
- A Node bridge is packaged with the native release by `rust/scripts/node_bridges.py`; a new
  bridge needs an entry there and in `rust/crates/cli/src/node_bridges.rs`.
