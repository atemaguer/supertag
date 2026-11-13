# Portable behavioral baseline

These five scenarios record selected behavior of the TypeScript system at `0b6a8ff` before the
Rust rewrite. The assertions consume semantic JSON results. Two drivers produce them:

| `SUPERTAG_BASELINE_DRIVER` | Driver | What it runs |
| --- | --- | --- |
| `old` (default) | `old-system-driver.ts` | The frozen TypeScript Control Plane, store, and runtime in one process. Only this file imports the old implementation. |
| `rust` | `rust-driver.ts` | The built Rust `supertag` binary as separate Control Plane, Gateway, and Worker Host processes. |

Any other value is an error. Run from the repository root after installing dependencies:

```sh
pnpm exec vitest run tests/rust-port-baseline
```

The Rust driver needs the Rust CLI and the built `supertag-ai` package:

```sh
pnpm build
cargo build --manifest-path rust/Cargo.toml --locked -p supertag-cli --bin supertag
SUPERTAG_BASELINE_DRIVER=rust pnpm exec vitest run tests/rust-port-baseline
```

It uses `rust/target/debug/supertag` unless `SUPERTAG_BASELINE_RUST_BINARY` names another
binary.

For the required dual-database run, provide the documented disposable PostgreSQL test server:

```sh
SUPERTAG_BASELINE_REQUIRE_POSTGRES=1 pnpm exec vitest run tests/rust-port-baseline
```

`SUPERTAG_POSTGRES_URL` must already identify that test server. Each SQL scenario gets its own
database; it is dropped when the scenario completes. Without it the three PostgreSQL cases are
reported as skipped. `SUPERTAG_BASELINE_REQUIRE_POSTGRES=1` makes missing configuration an error.
Every scenario runs in a child process with private temporary state and no inherited provider or
operator credentials. This suite makes no model calls or external surface calls.

## Scenarios and limits

| Scenario | Real behavior exercised | Important limit |
| --- | --- | --- |
| Admission retry | Control Plane admission, SQLite/PostgreSQL persistence, execution, restart, stable retry identity | Simulates a lost response by repeating the request; does not drop a real network acknowledgement |
| Permission snapshot | Role grants, Task policy capture, execution input, grant changes, persisted policy after restart | Does not establish sandbox enforcement or approval forwarding |
| Objective deadline | Running Task, grace, cancellation, independent notice Tasks, Objective draining | Moves the configured deadline and explicitly requests the controller sweep; does not wait twenty minutes or replace the clock |
| Durable replay | Actual file journal, acceptance receipt, restart, cursor tail, conflict rejection | Restarts journal/runtime objects, not an OS process during a write; no transport partition |
| Workspace verification | Real Git and subprocesses, pinned source, isolated producer/reviewer Workers, immutable artifacts, independent checks | Exports and verifies a patch; does not establish pull-request delivery or native model correctness |

The first three scenarios use the real Control Plane and store in the isolated driver process;
the harness behavior is deterministic. The last two reuse existing runtime/journal and repository
execution fixtures. Gateway splitting, crashes at commit boundaries, hostile-path coverage,
protocol backpressure, and real deployment tests remain separate acceptance work. A passing suite
is a small behavioral baseline, not complete product parity.

## Rust driver

`rust-driver.ts` starts each service from the built binary with a private temporary state
directory, `127.0.0.1:0` listeners, generated Gateway, operator, and host tokens, and an
environment containing only those tokens, a minimal `PATH`, and a private `HOME`. It drives the
services only through public operations: the `supertag-ai/gateway` gRPC client, the `supertag`
CLI for workspace artifact downloads, and `rust-baseline-adapter.mjs`, a deterministic harness
built on the public `supertag-ai/harness` entry point. It imports no TypeScript Control Plane,
store, or runtime code. Each SQL scenario creates its own PostgreSQL database and drops it with
`WITH (FORCE)` after every process has been killed.

The Rust driver asserts the same `cases.json` facts as the old driver. No expected value differs.
The following are differences in how a fact is observed, not in the behavior being asserted:

| Fact or setup | Old driver | Rust driver |
| --- | --- | --- |
| Task status `completed` | TypeScript status `completed` | Rust `TASK_STATE_SUCCEEDED`, renamed in the rewrite and mapped to `completed` |
| Accepted message | `ControlPlane.messageTag` with an idempotency key | `Conversations.SendMessage` with an operation ID |
| Task count for a Tag | `store.listTasks` | Messages across the Tag's conversations; Rust has no operator Task listing |
| Execution count | Specs received by the scripted Worklet | `started` records written by the baseline adapter after it attaches to a Task |
| Permission change | Remove one Permission Set grant and add another | Replace the Permission Set with a revision-fenced `PutPermissionSet` |
| Restart | New `ControlPlane` object over the same store | `SIGKILL` the Control Plane and Gateway, then start new processes on the same database |
| Objective sweep | Explicit `sweepObjectiveLimits(true)` call | The Control Plane's one-second maintenance sweep; the driver waits 3.5 seconds inside the grace window |
| Task abort | Scripted Worklet saw its abort signal | The adapter process for that Task ended without recording completion |
| `durable-event-replay` backend `filesystem` | `FileAttemptJournal` under a durable local Worklet | The Worker Host's state directory, restarted with the same directory. Control Plane state is a private SQLite file in the disposable directory |
| Durable receipt | Attempt `specDigest` | The Task returned by a repeated `SubmitTask` equals the completed Task |
| Conflicting retry | Same Attempt ID, different Task ID | Same operation ID, different prompt, rejected with `ALREADY_EXISTS` |
| Workspace isolation | Local execution environments mounting a cloned seed | Worker Hosts with `--workspace-source`, each preparing its own pinned checkout |
| Patch handoff to the reviewer | Read-only artifact mounts | The operator downloads the producer's patch with `supertag workspace-artifact`, verifies its SHA-256, and passes it in the reviewer Task's prompt. Rust has no cross-Tag artifact handoff outside Objective artifact inputs and commit reviews |
| Verified artifacts | Patch, evidence, and verification file digests | Producer patch and bundle digests and the reviewer's delivered patch digest. The producer's evidence is its Task result |

## Driver contract

The runner starts the selected driver with Node and `tsx`. A driver receives three arguments:
scenario ID, backend (`sqlite`, `postgresql`, or `filesystem`), and a disposable state directory. It must emit exactly one stdout line prefixed `BASELINE_RESULT ` containing:

```json
{"version":1,"scenario":"admission-retry","backend":"sqlite","facts":{"sameTaskOnRetry":true,"sameTaskAfterRestart":true,"taskCount":1,"executionCount":1,"status":"completed"}}
```

`cases.json` owns the expected semantic facts. Failures must return nonzero. Diagnostics may use
stderr; omit credentials. The parent enforces a deadline and removes the disposable directory.
The test-only old driver is retired when the Rust driver covers the approved behavior ledger
(`rust/docs/rust-port-capability-ledger.md`).
