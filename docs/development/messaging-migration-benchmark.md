# Messaging migration benchmark

Migrations 0117 and 0118 move the old message tables onto one model of conversations, messages,
members, and wakes. 0117 copies Mailbox messages, Workstream posts, their delivery state, and
their operation receipts. 0118 copies each person's conversations with Tags. The Control Plane
applies both in one transaction when it starts on an older database. This page records what that
costs on a large database.

## The workload

`core/crates/control-plane/tests/messaging_migration_benchmark.rs` builds a schema at 0116 and
fills it with synthetic data only:

| Data | Rows |
| --- | --- |
| Direct Mailbox messages between 50 Tags, five partners each, from 10,000 work Tasks | 60,000, each with a send operation |
| Workstream posts across 10 Teams; every fifth addressed to two members | 25,000, each with an operation; 10,000 addressed copies |
| Addressed copies of posts whose Team was deleted | 100 copies of 50 posts |
| Commit review requests | 300 |
| Person conversation turns: 40 people each talk with 5 Tags, two Sessions each | 15,000 turns, 600 Schedule fires, 150 Work Session reports, 200 read marks |
| Watch notices from seeding | 76,696 |

Ninety percent of the Mailbox rows were delivered by about 7,500 inbox Tasks; the newest 10%
still wait. The test then applies 0117 and 0118 in one transaction, as `Store::open` does. It
checks that every message, addressee, operation, Session, commit review, and watch notice
arrived, that each direct message is covered by a wake of its recipient, and that the migrations append no watch
notice.

Run it in release mode. CI runs ignored tests, so the benchmark also needs
`SUPERTAG_MIGRATION_BENCHMARK=1`:

```sh
SUPERTAG_MIGRATION_BENCHMARK=1 SUPERTAG_RUST_TEST_POSTGRES_URL_FILE=/path/to/private-url-file \
  cargo test --manifest-path core/Cargo.toml --release -p supertag-control-plane \
  --test messaging_migration_benchmark -- --ignored --nocapture --test-threads=1
```

## Results

Measured 2026-11-19 on an Apple M4 Max with 36 GiB of memory and a local PostgreSQL 14.18. Times
are the range over two runs.

| | SQLite | PostgreSQL |
| --- | --- | --- |
| 0117 | 1.6–1.8 s | 5.9–6.1 s |
| 0118 | 0.4–0.5 s | 1.0 s |
| Commit | 0.1–0.4 s | under 0.1 s |
| Size before | 57.3 MiB | 96.2 MiB |
| Size after 0117, uncommitted | 122.0 MiB | 207.7 MiB |
| Size after 0118, uncommitted | 128.5 MiB | 220.8 MiB |
| Peak | 178.9 MiB, at commit (database and write-ahead log) | 220.8 MiB, before commit |
| Size after | 106.2 MiB after a checkpoint | 150.1 MiB |

Afterwards both databases hold 100,200 messages, 70,100 addressees, 100,000 operation receipts,
34,813 wakes (310 pending), 970 members, and 200 person conversations.

Both migrations stay far below 30 seconds at this size, so neither needed a change. Every copy is
set-based, and none needed a new index at this size. Plan for free disk of up to three times the
old database's size during the upgrade: the new tables exist beside the old ones until the
transaction commits.
