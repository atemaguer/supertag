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

## Audit

Audited 2026-11-13 against `rust/crates/control-plane`. "Fixed" rows changed in this audit.

| Area | Mechanism | Concurrent replicas |
| --- | --- | --- |
| Schema check and migration at startup (`Store::open`) | One transaction holding `pg_advisory_xact_lock`; each replica rereads the version after the lock | Fixed. Replicas starting together on an empty database failed with duplicate catalog keys |
| Periodic maintenance (`ControlPlane::maintain`, every sweep below) | `supertag_v2_maintenance_ticks` claim: one replica per one-second tick; a claim far ahead of a replica's clock is taken over | Fixed. Every replica swept every tick, multiplying write-lock traffic; each sweep was already correct alone |
| Attempt expiry, Objective controller, input, mailbox, approval, Work Session, commit review, reply, GitHub publication sweeps | Write lock; state-based and idempotent | Safe |
| Ephemeral Worker Host removal (`sweep_ephemeral_hosts`) | Candidates read unlocked, rechecked under the write lock; absence counts from when this process started watching | Safe. A newly started replica only waits longer; the longest-running replica acts |
| Watch retention (`prune_watch`), artifact transfer grant expiry | Conditional `UPDATE` of the Watch head row; idempotent `DELETE` | Safe |
| Watch positions | Triggers append notices under the Watch head row lock inside the triggering write; positions are gap-free in commit order; the feed ID and resume tokens are shared | Safe. Any replica resumes any token |
| Task claims, Attempt leases and renewal, fencing by host generation | Write lock; lease tokens and deadlines in rows | Safe |
| Reply delivery claims, connector ownership leases | Write lock; fenced lease rows | Safe |
| GitHub publication claims | Write lock; lease rows | Safe |
| Operator notification claims (`claim_operator_notification`) | Write lock; leased outbox rows; the Inbox is read in the claim's transaction | Fixed. The Inbox was read before the lock, so a Gateway could settle, unsent, a message another replica had just recorded for an item its stale read lacked |
| Notification batching window | `MAX(created_at_ms)` read under the write lock | Safe |
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
- A Gateway connects to one Control Plane address. Put replicas behind a TCP load balancer or a
  private DNS name. Gateway replicas are not covered here: a Gateway keeps checkpoints and its
  file credential vault on its own volume.

## Tests

- `control-plane/tests/replica_contract.rs`: `postgres_replicas_start_together_and_share_one_maintenance_pass`
  opens four Stores together on an empty database; `sqlite_admits_one_control_plane_process_and_shares_its_lock_within_it`.
- `cli/tests/replicas_runtime.rs`: `replicas_share_one_postgresql_database_and_survive_killed_replicas`
  runs three Control Plane processes on one PostgreSQL database, each behind a Gateway, submits
  Tasks and creates Objectives through every replica, kills one replica while its Worker Host
  holds a running Attempt and another while Attempts finish and notifications are claimed, and
  asserts one adapter launch per Task, gap-free events, one delivery per operator notification,
  and identical gap-free Watch positions on every stream, each resuming on another replica after
  its own was killed. `sqlite_refuses_a_second_control_plane_process` covers SQLite.
