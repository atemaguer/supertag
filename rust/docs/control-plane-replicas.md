# Control Plane replicas

Several Control Plane processes can share one PostgreSQL database. SQLite serves one Control Plane
process: a second process on the same file refuses to start
(`control-plane/src/store/sqlite_files.rs`, an exclusive lock on `<database>.lock`).

## Why replicas are safe

Every Control Plane mutation begins by incrementing the single `supertag_v2_write_order` row
(`Store::write`, `store::next_order`). On PostgreSQL that row lock is held until commit, so
mutations from all replicas, and from the 8 pooled connections inside each replica, run one at a
time in commit order, and each reads the state the previous one committed. Every claim, lease,
sweep, and reconciler below runs inside such a transaction and decides from durable state, never
from process memory. IDs are random UUIDs; orders and Watch positions come from database rows.

Because one row lock orders every write, a replica that freezes or loses its network inside a
transaction would stall every other replica. Each PostgreSQL connection therefore sets
`idle_in_transaction_session_timeout` to 15 seconds and TCP keepalives of 15 seconds idle, 5
seconds between probes, and 3 probes (`POSTGRES_SESSION_LIMITS` in `store.rs`). PostgreSQL ends
such a session and releases its lock; no Control Plane transaction waits on anything but its own
statements. Other replicas stall for about that long.

## Audit

Audited 2026-11-13 against `rust/crates/control-plane`. "Fixed" rows changed in this audit.

| Area | Mechanism | Concurrent replicas |
| --- | --- | --- |
| Schema check and migration at startup (`Store::open`) | One transaction holding `pg_advisory_xact_lock`; each replica rereads the version after the lock | Fixed. Replicas starting together on an empty database failed with duplicate catalog keys |
| Periodic maintenance (`ControlPlane::maintain`, every sweep below) | `supertag_v2_maintenance_ticks` claim: one replica per one-second tick; a claim far ahead of a replica's clock is taken over | Fixed. Every replica swept every tick, multiplying write-lock traffic; each sweep was already correct alone. The claim covers only the periodic pass: RPCs that run sweeps inline (`objective_sweep_in` in Task claims, Attempt renewals, inspection, finishes, and resolutions) still run them on every call. A sweep that keeps failing is retried about once per tick across all replicas |
| Attempt expiry, Objective controller, input, mailbox, approval, Work Session, commit review, reply, GitHub publication sweeps | Write lock; state-based and idempotent | Safe |
| Ephemeral Worker Host removal (`sweep_ephemeral_hosts`) | Candidates read unlocked, rechecked under the write lock; absence counts from the first maintenance pass this process won | Safe. A replica that recently started sweeping only waits longer, so the replica sweeping longest acts first |
| Watch retention (`prune_watch`), artifact transfer grant expiry | Conditional `UPDATE` of the Watch head row; idempotent `DELETE` | Safe |
| Watch positions | Triggers append notices under the Watch head row lock inside the triggering write; positions are gap-free in commit order; the feed ID and resume tokens are shared | Safe. Any replica resumes any token |
| A PostgreSQL session that holds the write lock and goes silent | `idle_in_transaction_session_timeout` and TCP keepalives set on every connection | Fixed. A replica stopped (`SIGSTOP`) or cut off inside a write held the lock until it resumed or a two-hour keepalive fired, stalling every replica |
| Task claims, Attempt leases and renewal, fencing by host generation | Write lock; lease tokens and deadlines in rows | Safe |
| Reply delivery claims, connector ownership leases | Write lock; fenced lease rows | Safe |
| GitHub publication claims | Write lock; lease rows | Safe |
| Operator notification claims (`claim_operator_notification`) | Write lock; leased outbox rows; the Inbox is read in the claim's transaction, at the claim's instant | Fixed. The Inbox was read before the lock, so a Gateway could settle, unsent, a message another replica had just recorded for an item its stale read lacked |
| Notification batching window | `MAX(created_at_ms)` read under the write lock | Safe |
| Default Objective notice Task (`set_default_notification_task`) | One `supertag_v2_notification_defaults` row each replica rewrites at startup from its `SUPERTAG_OPERATOR_NOTIFICATION_TASK_ID`, so every replica picks notice homes and withdraws notices from the same value | Safe when every replica starts with the same value. A replica started with another value, or without it, replaces the default for all replicas; it writes the value it replaced to standard error |
| Apply-set and manifest relationship reconcilers | Write lock; revision fences | Safe |
| Idempotent admission (operation IDs, provider event receipts) | Unique rows checked under the write lock | Safe |
| Operator Token last-use time | Conditional `UPDATE`; advisory only | Safe |
| Audit call tracking | Per-call task-local state; entries commit with each write | Safe |
| Read-only RPCs on unlocked transactions | No writes | Safe |

## Known limits

- Leases, deadlines, and expiries use each replica's wall clock. Keep replica clocks synchronized.
- All replicas must run the same release. An older replica does not stop when a newer one migrates
  the schema; stop every replica before an upgrade that changes it.
- Throughput of mutations is bounded by the single write-order row, as before.
- A frozen or disconnected replica stalls every write for up to 15 seconds, until PostgreSQL ends
  its session. A connection pooler in transaction mode drops the session settings; connect
  replicas to PostgreSQL directly or through a session-mode pooler.
- Operators, Worker Hosts, and Gateways connect to one Control Plane address. Put replicas behind
  a TCP load balancer or a private DNS name.
- Every replica serves transfers (Session checkpoints, workspace bundles, GitHub publication
  blobs) from its `--transfer-directory`. Give all replicas the same directory on a shared volume;
  blobs are content-addressed and published without overwriting, so replicas can write it at once.
- Gateway replicas are not covered here: a Gateway keeps its file credential vault on its own
  volume.

## Tests

- `control-plane/tests/replica_contract.rs`: `postgres_replicas_start_together_and_share_one_maintenance_pass`
  opens four Stores together on an empty database; `sqlite_/postgres_notification_claim_reads_the_inbox_under_its_lock`
  has one replica record a message for an Inbox item that became due after another replica's
  claim started, and fails if that claim reads the Inbox before its lock;
  `sqlite_admits_one_control_plane_process_and_shares_its_lock_within_it`.
- `control-plane/src/store/replica_tests.rs`: `postgres_frozen_replica_releases_the_write_lock`
  holds a write open and silent on one Store and checks that another Store's write proceeds
  after the idle-in-transaction limit.
- `cli/tests/replicas_runtime.rs`:
  `replicas_share_one_postgresql_database_and_survive_killed_replicas` runs three Control Plane
  processes on one PostgreSQL database and one transfer directory, each with a Gateway delivering
  operator notifications, submits Tasks and creates Objectives through every replica, kills one
  replica while its Worker Host holds a running Attempt and another while Attempts finish and
  notifications are claimed, and asserts one adapter launch per Task, gap-free events, one
  delivery per operator notification, and identical gap-free Watch positions on every stream, each
  resuming on another replica after its own was killed. It then kills a Worker Host during an
  Attempt and two of the three replicas; only the periodic maintenance pass expires that Attempt,
  so the survivor must run it. `sqlite_refuses_a_second_control_plane_process` covers SQLite.

Not covered: exactly one maintenance pass per tick across processes (the Store contract checks
the claim), a real process frozen with `SIGSTOP` or partitioned from PostgreSQL, several Gateways
sharing state, and Slack or provider reply delivery through Gateways connected to different
replicas.
