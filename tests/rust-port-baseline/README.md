# Portable behavioral baseline

These five scenarios record selected behavior of the TypeScript system at `0b6a8ff` before the
Rust rewrite. The assertions consume semantic JSON results; only `old-system-driver.ts` imports
the old implementation. A future Rust driver can produce the same results without preserving
the old API, database schema, package structure, or transport.

Run from the repository root after installing dependencies:

```sh
pnpm exec vitest run tests/rust-port-baseline
```

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

## Driver contract

Set `SUPERTAG_BASELINE_DRIVER` to an executable path to replace the old-system driver. It receives
three arguments: scenario ID, backend (`sqlite`, `postgresql`, or `filesystem`), and a disposable
state directory. It must emit exactly one stdout line prefixed `BASELINE_RESULT ` containing:

```json
{"version":1,"scenario":"admission-retry","backend":"sqlite","facts":{"sameTaskOnRetry":true,"sameTaskAfterRestart":true,"taskCount":1,"executionCount":1,"status":"completed"}}
```

`cases.json` owns the expected semantic facts. Failures must return nonzero. Diagnostics may use
stderr; omit credentials. The parent enforces a deadline and removes the disposable directory.
The test-only old driver is retired when the Rust driver covers the approved behavior ledger.
