//! What migrations 0117 (one message model for Mailbox and Workstream) and 0118 (person
//! conversations) cost on a large database. Synthetic data only: a schema at 0116 is filled with
//! about 100,000 messages (60,000 Mailbox messages across 50 Tags with their send operations,
//! 25,000 Workstream posts across 10 Teams with addressed copies, 15,000 turns across 200 person
//! conversations, with read and delivery state), then each migration is applied as `Store::open`
//! applies it, inside one transaction. The run prints each migration's wall time, the database
//! size as it grows, and checks that every row arrived.
//!
//! A benchmark, not a contract: CI runs ignored tests, so it also needs
//! `SUPERTAG_MIGRATION_BENCHMARK=1`.
//!
//! ```sh
//! SUPERTAG_MIGRATION_BENCHMARK=1 cargo test --manifest-path core/Cargo.toml --release \
//!   -p supertag-control-plane --test messaging_migration_benchmark -- --ignored --nocapture
//! ```
//!
//! The PostgreSQL case also needs `SUPERTAG_RUST_TEST_POSTGRES_URL_FILE`.
use std::future::Future;
use std::time::{Duration, Instant};

use sqlx::{AnyPool, Connection, Executor};
use supertag_control_plane::Store;
use uuid::Uuid;

/// The schema version just before `0117_unified_messages`.
const PRIOR: u32 = 116;
const DIRECT: i64 = 60_000;
/// The newest direct messages and posts are still waiting for an inbox turn.
const DIRECT_DELIVERED: i64 = 54_000;
const POSTS: i64 = 25_000;
const POSTS_DELIVERED: i64 = 22_500;
const TURNS: i64 = 15_000;

fn enabled() -> bool {
    let on = std::env::var_os("SUPERTAG_MIGRATION_BENCHMARK").is_some_and(|value| value == "1");
    if !on {
        eprintln!("skipped: set SUPERTAG_MIGRATION_BENCHMARK=1 to run the migration benchmark");
    }
    on
}

fn migration(sqlite: bool, version: u32) -> String {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("migrations")
        .join(if sqlite { "sqlite" } else { "postgresql" });
    let mut paths: Vec<_> = std::fs::read_dir(root)
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .filter(|path| {
            path.file_name()
                .unwrap()
                .to_str()
                .unwrap()
                .get(..4)
                .and_then(|prefix| prefix.parse::<u32>().ok())
                == Some(version)
        })
        .collect();
    assert_eq!(paths.len(), 1, "one migration numbered {version}");
    std::fs::read_to_string(paths.pop().unwrap()).unwrap()
}

/// The synthetic workload. Every statement is plain SQL both databases run; `blob` is the
/// dialect's literal for a one-byte delivery record.
fn seed_sql(blob: &str) -> String {
    format!(
        "CREATE TABLE supertag_v2_bench_n AS
         WITH RECURSIVE n(i) AS (SELECT CAST(1 AS BIGINT) UNION ALL SELECT i + 1 FROM n WHERE i < {DIRECT})
         SELECT i FROM n;

         INSERT INTO supertag_v2_tags (tag_id,instructions,allowed_actions,revision)
         SELECT 'tag-' || (i - 1), 'x', '[]', 1 FROM supertag_v2_bench_n WHERE i <= 50;
         INSERT INTO supertag_v2_teams (team_id,name,revision,created_at_ms,updated_at_ms,next_post_sequence)
         SELECT 'team-' || (i - 1), 'Team ' || (i - 1), 1, 1, 1, {next_post}
         FROM supertag_v2_bench_n WHERE i <= 10;
         -- Tag k is in Team k % 10; the first 20 Tags are also in Team (k + 3) % 10.
         INSERT INTO supertag_v2_team_members (team_id,tag_id)
         SELECT 'team-' || ((i - 1) % 10), 'tag-' || (i - 1) FROM supertag_v2_bench_n WHERE i <= 50
         UNION ALL
         SELECT 'team-' || ((i + 2) % 10), 'tag-' || (i - 1) FROM supertag_v2_bench_n WHERE i <= 20;
         INSERT INTO supertag_v2_objectives (objective_id,owner_tag_id,session_id,outcome,ongoing,status,revision,limit_state,created_at_ms,updated_at_ms)
         SELECT 'obj-' || (i - 1), 'tag-' || ((i - 1) % 50), 'objective/obj-' || (i - 1), 'Ship', 0, 1, 1, '{{}}', 1, 1
         FROM supertag_v2_bench_n WHERE i <= 100;

         -- 10,000 work Tasks send the Tags' messages and posts; a third work on an Objective.
         INSERT INTO supertag_v2_tasks (task_id,tag_id,session_id,prompt,instructions,allowed_actions,tag_revision,state,accepted_order,accepted_at_ms)
         SELECT 'src-' || i, 'tag-' || (i % 50), 'ordinary', 'Work', 'x', '[]', 1, 3, i, 1000000000000 + i * 3000
         FROM supertag_v2_bench_n WHERE i <= 10000;
         INSERT INTO supertag_v2_objective_tasks (task_id,objective_id,kind)
         SELECT 'src-' || i, 'obj-' || (i % 100), 'work' FROM supertag_v2_bench_n
         WHERE i <= 10000 AND i % 3 = 0;

         -- Posts: post j belongs to Team j % 10, written by one of its five home Tags; every fifth
         -- is addressed to two other members.
         CREATE TABLE supertag_v2_bench_post AS
         SELECT j, author, author + 50 * (1 + (j / 50) % 199) AS k
         FROM (SELECT i AS j, (i % 10) + 10 * ((i / 10) % 5) AS author
               FROM supertag_v2_bench_n WHERE i <= {POSTS}) x;
         INSERT INTO supertag_v2_workstream_posts (post_id,team_id,author_tag_id,source_task_id,to_tag_ids,body,effect_digest,sequence,created_at_ms)
         SELECT 'post-' || j, 'team-' || (j % 10), 'tag-' || author, 'src-' || k,
                CASE WHEN j % 5 = 0
                     THEN '[\"tag-' || ((author + 10) % 50) || '\",\"tag-' || ((author + 20) % 50) || '\"]'
                     ELSE '[]' END,
                'Post ' || j || ': progress on the current change', 'e' || j, (j - 1) / 10 + 1,
                1000000000000 + j * 1200
         FROM supertag_v2_bench_post;

         -- Mailbox rows: direct message j comes from work Task k's Tag and goes to one of five
         -- partners. Addressed copies follow, then copies of posts whose Team was deleted.
         CREATE TABLE supertag_v2_bench_mail AS
         SELECT j, 'msg-' || j AS message_id, 'tag-' || (k % 50) AS sender,
                'tag-' || ((k % 50 + 1 + j % 5) % 50) AS recipient, 'src-' || k AS source_task_id,
                1 AS origin, CAST(NULL AS TEXT) AS post_id,
                CASE WHEN k % 3 = 0 THEN 'obj-' || (k % 100) END AS objective_id,
                'Message ' || j || ': please look at the failing check' AS body, j % 3 AS hops,
                CASE WHEN j <= {DIRECT_DELIVERED}
                     THEN 'inbox-' || ((k % 50 + 1 + j % 5) % 50) || '-d' || (j / 400) END AS task_id,
                1000000000000 + j * 500 AS created_at_ms, j AS delivery_order
         FROM (SELECT i AS j, (i - 1) / 6 + 1 AS k FROM supertag_v2_bench_n) x
         UNION ALL
         SELECT 0, 'copy-' || p.j || '-' || r.i, 'tag-' || p.author,
                'tag-' || ((p.author + 10 * r.i) % 50), 'src-' || p.k, 2, 'post-' || p.j,
                CASE WHEN p.k % 3 = 0 THEN 'obj-' || (p.k % 100) END,
                'Post ' || p.j || ': progress on the current change', 1,
                CASE WHEN p.j <= {POSTS_DELIVERED}
                     THEN 'inbox-' || ((p.author + 10 * r.i) % 50) || '-w' || (p.j / 300) END,
                1000000000000 + p.j * 1200, {DIRECT} + 2 * p.j + r.i
         FROM supertag_v2_bench_post p
         JOIN supertag_v2_bench_n r ON r.i <= 2
         WHERE p.j % 5 = 0
         UNION ALL
         SELECT 0, 'orphan-' || o.i || '-' || r.i, 'tag-' || (o.i % 50),
                'tag-' || ((o.i + r.i) % 50), 'src-' || (o.i + 50 * r.i), 2, 'gone-' || o.i,
                NULL, 'Old team note ' || o.i, 2, NULL, 999000000000 + o.i, {DIRECT} + 2 * {POSTS} + 2 * o.i + r.i
         FROM supertag_v2_bench_n o
         JOIN supertag_v2_bench_n r ON r.i <= 2
         WHERE o.i <= 50;

         INSERT INTO supertag_v2_tasks (task_id,tag_id,session_id,prompt,instructions,allowed_actions,tag_revision,state,accepted_order,accepted_at_ms)
         SELECT task_id, recipient, 'inbox:' || recipient, 'Inbox', 'x', '[]', 1, 3,
                100000 + ROW_NUMBER() OVER (ORDER BY task_id), 1000000000000
         FROM (SELECT DISTINCT task_id, recipient FROM supertag_v2_bench_mail WHERE task_id IS NOT NULL) x;
         INSERT INTO supertag_v2_mailbox_tasks (task_id,recipient_tag_id,bound)
         SELECT DISTINCT task_id, recipient, 1 FROM supertag_v2_bench_mail WHERE task_id IS NOT NULL;
         INSERT INTO supertag_v2_mailbox_messages (message_id,sender_tag_id,recipient_tag_id,source_task_id,origin,workstream_post_id,objective_id,text,hops,task_id,created_at_ms,delivery_order)
         SELECT message_id, sender, recipient, source_task_id, origin, post_id, objective_id, body,
                hops, task_id, created_at_ms, delivery_order
         FROM supertag_v2_bench_mail;
         INSERT INTO supertag_v2_mailbox_send_operations (source_task_id,operation_id,request_digest,message_id)
         SELECT source_task_id, 'send-' || j, 'sd-' || j, message_id FROM supertag_v2_bench_mail WHERE origin = 1;
         INSERT INTO supertag_v2_workstream_operations (source_task_id,operation_id,request_digest,post_id)
         SELECT 'src-' || k, 'post-' || j, 'pd-' || j, 'post-' || j FROM supertag_v2_bench_post;
         -- Every 200th direct message is a commit review request.
         INSERT INTO supertag_v2_commit_reviews (request_id,objective_id,requester_tag_id,reviewer_tag_id,source_task_id,workspace_id,commit_sha,delivery,requested_at_ms,created_order)
         SELECT message_id, 'obj-' || (j % 100), sender, recipient, source_task_id, 'ws', 'sha' || j,
                {blob}, created_at_ms, j
         FROM supertag_v2_bench_mail WHERE origin = 1 AND j % 200 = 0;

         -- Person conversations: 40 people each talk with 5 Tags, 200 conversations over two
         -- Sessions each. Every 25th turn is a Schedule's fire (an unprompted post); a Work
         -- Session started from each conversation reports back into its first Session.
         CREATE TABLE supertag_v2_bench_turn AS
         SELECT j, p, 'operator:p' || (p / 5) AS principal, 'tag-' || ((p % 5) * 10 + (p / 5) % 10) AS tag,
                'conversation/' || p || '-' || CASE WHEN j > {half} THEN 1 ELSE 0 END AS session
         FROM (SELECT i AS j, i % 200 AS p FROM supertag_v2_bench_n WHERE i <= {TURNS}) x;
         INSERT INTO supertag_v2_conversations (session_id,principal,tag_id,created_order)
         SELECT session, principal, tag, 500000 + ROW_NUMBER() OVER (ORDER BY session)
         FROM (SELECT DISTINCT session, principal, tag FROM supertag_v2_bench_turn) x;
         INSERT INTO supertag_v2_tasks (task_id,tag_id,session_id,prompt,instructions,allowed_actions,tag_revision,state,result,accepted_order,accepted_at_ms,completed_at_ms)
         SELECT 'turn-' || j, tag, session, 'Question ' || j, 'x', '[]', 1, 3, 'Answer ' || j,
                400000 + 2 * j, 1000000000000 + j * 4000, 1000000000000 + j * 4000 + 900
         FROM supertag_v2_bench_turn;
         INSERT INTO supertag_v2_conversation_messages (task_id,session_id,principal,operation_id,request_digest,accepted_order)
         SELECT 'turn-' || j, session, principal,
                CASE WHEN j % 25 = 0 THEN 'schedule/sched-' || p || '/' || j ELSE 'op-' || j END,
                'cd-' || j, 400000 + 2 * j
         FROM supertag_v2_bench_turn;
         INSERT INTO supertag_v2_schedules (schedule_id,tag_id,session_id,audience_principal,note,at_ms,state,created_by,created_at_ms,updated_at_ms)
         SELECT DISTINCT 'sched-' || p, tag, 'conversation/' || p || '-0', principal, 'Check', 1, 1, principal, 1, 1
         FROM supertag_v2_bench_turn;
         INSERT INTO supertag_v2_schedule_fires (schedule_id,due_at_ms,task_id,fired_at_ms)
         SELECT 'sched-' || p, j, 'turn-' || j, 1000000000000 + j * 4000
         FROM supertag_v2_bench_turn WHERE j % 25 = 0;
         INSERT INTO supertag_v2_proactive_posts (task_id,tag_id,session_id,conversation_order,posted_at_ms,quiet,audience,delivered_at_ms)
         SELECT 'turn-' || j, tag, session, 400000 + 2 * j, 1000000000000 + j * 4000, 0,
                'conversation:' || principal, 1000000000000 + j * 4000
         FROM supertag_v2_bench_turn WHERE j % 25 = 0;
         INSERT INTO supertag_v2_tasks (task_id,tag_id,session_id,prompt,instructions,allowed_actions,tag_revision,state,accepted_order,accepted_at_ms)
         SELECT DISTINCT 'child-' || p, tag, 'work/ws-' || p, 'Child', 'x', '[]', 1, 3, 600000 + p, 1000000000000
         FROM supertag_v2_bench_turn;
         INSERT INTO supertag_v2_tasks (task_id,tag_id,session_id,prompt,instructions,allowed_actions,tag_revision,state,result,accepted_order,accepted_at_ms)
         SELECT 'report-' || j, tag, session, 'Report', 'x', '[]', 1, 3, 'Reported', 400000 + 2 * j + 1,
                1000000000000 + j * 4000 + 1
         FROM supertag_v2_bench_turn WHERE j % 50 = 7 AND j <= {half};
         INSERT INTO supertag_v2_work_sessions (work_session_id,title,parent_tag_id,parent_session_id,starter_task_id,tag_id,latest_task_id,created_order)
         SELECT DISTINCT 'ws-' || p, 'Fix', tag, 'conversation/' || p || '-0',
                'turn-' || CASE WHEN p = 0 THEN 200 ELSE p END, tag, 'child-' || p, 600000 + p
         FROM supertag_v2_bench_turn;
         INSERT INTO supertag_v2_work_session_tasks (task_id,work_session_id,kind)
         SELECT DISTINCT 'child-' || p, 'ws-' || p, 1 FROM supertag_v2_bench_turn
         UNION ALL
         SELECT 'report-' || j, 'ws-' || p, 2 FROM supertag_v2_bench_turn WHERE j % 50 = 7 AND j <= {half};
         -- Each person read their conversation up to a recent turn.
         INSERT INTO supertag_v2_conversation_reads (principal,tag_id,read_order,read_at_ms)
         SELECT principal, tag, 400000 + 2 * j, 1000000000000 + j * 4000 FROM supertag_v2_bench_turn
         WHERE j > {TURNS} - 400 AND j <= {TURNS} - 200;

         UPDATE supertag_v2_write_order SET revision = 1000000 WHERE singleton = 1;
         DROP TABLE supertag_v2_bench_turn;
         DROP TABLE supertag_v2_bench_mail;
         DROP TABLE supertag_v2_bench_post;
         DROP TABLE supertag_v2_bench_n;",
        next_post = POSTS / 10 + 1,
        half = TURNS / 2,
    )
}

async fn count(pool: &AnyPool, sql: &str) -> i64 {
    sqlx::query_scalar(sql).fetch_one(pool).await.unwrap()
}

trait Size {
    async fn bytes(&self, pool: &AnyPool) -> u64;
}

struct SqliteFile(std::path::PathBuf);

impl Size for SqliteFile {
    async fn bytes(&self, _: &AnyPool) -> u64 {
        ["", "-wal", "-journal"]
            .iter()
            .filter_map(|suffix| {
                let mut path = self.0.clone().into_os_string();
                path.push(suffix);
                std::fs::metadata(path).ok().map(|meta| meta.len())
            })
            .sum()
    }
}

struct PostgresDatabase;

impl Size for PostgresDatabase {
    async fn bytes(&self, pool: &AnyPool) -> u64 {
        count(
            pool,
            "SELECT CAST(pg_database_size(current_database()) AS BIGINT)",
        )
        .await as u64
    }
}

fn mib(bytes: u64) -> String {
    format!("{:.1} MiB", bytes as f64 / 1_048_576.0)
}

fn secs(duration: Duration) -> String {
    format!("{:.2} s", duration.as_secs_f64())
}

async fn benchmark(url: String, size: impl Size) {
    sqlx::any::install_default_drivers();
    let sqlite = url.starts_with("sqlite:");
    let label = if sqlite { "SQLite" } else { "PostgreSQL" };
    // PostgreSQL measures the database's size from a second connection while the migrations'
    // transaction is open.
    let pool = sqlx::any::AnyPoolOptions::new()
        .max_connections(if sqlite { 1 } else { 2 })
        .connect(&url)
        .await
        .unwrap();
    if sqlite {
        // As `Store::open` runs a file database.
        sqlx::raw_sql("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL")
            .execute(&pool)
            .await
            .unwrap();
    }

    let started = Instant::now();
    let mut tx = pool.begin().await.unwrap();
    for version in 1..=PRIOR {
        sqlx::raw_sql(&migration(sqlite, version))
            .execute(&mut *tx)
            .await
            .unwrap();
    }
    let blob = if sqlite { "X'00'" } else { "'\\x00'::bytea" };
    sqlx::raw_sql(&seed_sql(blob))
        .execute(&mut *tx)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    if sqlite {
        sqlx::raw_sql("PRAGMA wal_checkpoint(TRUNCATE)")
            .execute(&pool)
            .await
            .unwrap();
    } else {
        sqlx::raw_sql("VACUUM ANALYZE")
            .execute(&pool)
            .await
            .unwrap();
    }
    let seeded = started.elapsed();

    // What the old tables hold.
    let direct = count(
        &pool,
        "SELECT COUNT(*) FROM supertag_v2_mailbox_messages WHERE origin = 1",
    )
    .await;
    let copies = count(
        &pool,
        "SELECT COUNT(*) FROM supertag_v2_mailbox_messages WHERE origin = 2",
    )
    .await;
    let posts = count(&pool, "SELECT COUNT(*) FROM supertag_v2_workstream_posts").await;
    let orphans = count(
        &pool,
        "SELECT COUNT(DISTINCT workstream_post_id) FROM supertag_v2_mailbox_messages m
         WHERE origin = 2 AND NOT EXISTS
             (SELECT 1 FROM supertag_v2_workstream_posts p WHERE p.post_id = m.workstream_post_id)",
    )
    .await;
    let addressed = count(
        &pool,
        "SELECT COUNT(*) FROM supertag_v2_workstream_posts WHERE to_tag_ids <> '[]'",
    )
    .await;
    let turns = count(
        &pool,
        "SELECT COUNT(*) FROM supertag_v2_conversation_messages",
    )
    .await;
    let reports = count(
        &pool,
        "SELECT COUNT(*) FROM supertag_v2_work_session_tasks WHERE kind = 2",
    )
    .await;
    let send_operations = count(
        &pool,
        "SELECT COUNT(*) FROM supertag_v2_mailbox_send_operations",
    )
    .await;
    let post_operations = count(
        &pool,
        "SELECT COUNT(*) FROM supertag_v2_workstream_operations",
    )
    .await;
    let reviews = count(&pool, "SELECT COUNT(*) FROM supertag_v2_commit_reviews").await;
    let sessions = count(&pool, "SELECT COUNT(*) FROM supertag_v2_conversations").await;
    let people = count(
        &pool,
        "SELECT COUNT(*) FROM (SELECT DISTINCT principal, tag_id FROM supertag_v2_conversations) x",
    )
    .await;
    let notices = count(&pool, "SELECT COUNT(*) FROM supertag_v2_watch_notices").await;
    let head_before = count(
        &pool,
        "SELECT head FROM supertag_v2_watch_state WHERE singleton = 1",
    )
    .await;
    assert_eq!(direct, DIRECT);
    assert_eq!(posts, POSTS);
    assert_eq!(turns, TURNS);

    let before = size.bytes(&pool).await;
    let mut peak = before;

    // Both migrations in one transaction, as `Store::open` applies them.
    let mut tx = pool.begin().await.unwrap();
    let clock = Instant::now();
    sqlx::raw_sql(&migration(sqlite, 117))
        .execute(&mut *tx)
        .await
        .unwrap();
    let m117 = clock.elapsed();
    let after_117 = size.bytes(&pool).await;
    peak = peak.max(after_117);
    let clock = Instant::now();
    sqlx::raw_sql(&migration(sqlite, 118))
        .execute(&mut *tx)
        .await
        .unwrap();
    let m118 = clock.elapsed();
    let after_118 = size.bytes(&pool).await;
    peak = peak.max(after_118);
    let clock = Instant::now();
    tx.commit().await.unwrap();
    let commit = clock.elapsed();
    let committed = size.bytes(&pool).await;
    peak = peak.max(committed);
    if sqlite {
        sqlx::raw_sql("PRAGMA wal_checkpoint(TRUNCATE)")
            .execute(&pool)
            .await
            .unwrap();
    }
    let settled = size.bytes(&pool).await;

    // Every row arrived.
    let messages = count(&pool, "SELECT COUNT(*) FROM supertag_v2_messages").await;
    let direct_after = count(
        &pool,
        "SELECT COUNT(*) FROM supertag_v2_messages m JOIN supertag_v2_conversations c
             ON c.conversation_id = m.conversation_id
         WHERE c.kind = 1 AND substr(c.direct_key, 1, 2) = 't:'",
    )
    .await;
    let channel_after = count(
        &pool,
        "SELECT COUNT(*) FROM supertag_v2_messages m JOIN supertag_v2_conversations c
             ON c.conversation_id = m.conversation_id
         WHERE c.kind = 2 AND c.archived_at_ms IS NULL",
    )
    .await;
    let archived_after = count(
        &pool,
        "SELECT COUNT(*) FROM supertag_v2_messages m JOIN supertag_v2_conversations c
             ON c.conversation_id = m.conversation_id
         WHERE c.kind = 2 AND c.archived_at_ms IS NOT NULL",
    )
    .await;
    let turns_after = count(
        &pool,
        "SELECT COUNT(*) FROM supertag_v2_messages m JOIN supertag_v2_conversations c
             ON c.conversation_id = m.conversation_id
         WHERE c.kind = 1 AND substr(c.direct_key, 1, 2) = 'p:' AND m.task_id IS NOT NULL",
    )
    .await;
    let addressees = count(&pool, "SELECT COUNT(*) FROM supertag_v2_message_addressees").await;
    let operations = count(&pool, "SELECT COUNT(*) FROM supertag_v2_message_operations").await;
    let wakes = count(
        &pool,
        "SELECT COUNT(*) FROM supertag_v2_session_inputs WHERE kind = 4",
    )
    .await;
    let pending_wakes = count(
        &pool,
        "SELECT COUNT(*) FROM supertag_v2_session_inputs WHERE kind = 4 AND task_id IS NULL",
    )
    .await;
    // Every Mailbox row is covered by exactly one wake of its recipient.
    let covered = count(
        &pool,
        "SELECT COUNT(*) FROM supertag_v2_messages m
         JOIN supertag_v2_session_inputs w ON w.conversation_id = m.conversation_id
             AND m.seq BETWEEN w.first_seq AND w.last_seq
         JOIN supertag_v2_conversations c ON c.conversation_id = m.conversation_id
         WHERE c.kind = 1 AND substr(c.direct_key, 1, 2) = 't:'
           AND EXISTS (SELECT 1 FROM supertag_v2_message_addressees a
                       WHERE a.conversation_id = m.conversation_id AND a.seq = m.seq
                         AND a.tag_id = w.tag_id)",
    )
    .await;
    let members = count(
        &pool,
        "SELECT COUNT(*) FROM supertag_v2_conversation_members",
    )
    .await;
    let sessions_after = count(
        &pool,
        "SELECT COUNT(*) FROM supertag_v2_conversation_sessions",
    )
    .await;
    let people_after = count(
        &pool,
        "SELECT COUNT(*) FROM supertag_v2_conversations
         WHERE kind = 1 AND substr(direct_key, 1, 2) = 'p:'",
    )
    .await;
    let reviews_after = count(&pool, "SELECT COUNT(*) FROM supertag_v2_commit_reviews").await;
    let notices_after = count(&pool, "SELECT COUNT(*) FROM supertag_v2_watch_notices").await;
    let head_after = count(
        &pool,
        "SELECT head FROM supertag_v2_watch_state WHERE singleton = 1",
    )
    .await;

    assert_eq!(direct_after, direct);
    assert_eq!(channel_after, posts);
    assert_eq!(archived_after, orphans);
    assert_eq!(turns_after, turns + reports);
    assert_eq!(messages, direct + posts + orphans + turns + reports);
    // A direct message names its recipient; an addressed post its two addressees; an orphan
    // copy its recipients.
    assert_eq!(addressees, direct + 2 * addressed + 2 * orphans);
    assert_eq!(operations, send_operations + post_operations + turns);
    assert_eq!(covered, direct);
    assert_eq!(sessions_after, sessions);
    assert_eq!(people_after, people);
    assert_eq!(reviews_after, reviews);
    assert_eq!(notices_after, notices);
    assert_eq!(head_after, head_before, "the migrations announce nothing");
    pool.close().await;

    // The Control Plane opens the migrated database without applying 0117 or 0118 again.
    let store = Store::open(&url).await.unwrap();
    assert!(store.migrated().is_none_or(|(from, _)| from == 118));
    store.close().await;

    println!(
        "{label}: seeded {} messages ({direct} direct, {posts} posts, {orphans} posts of deleted Teams, \
         {copies} addressed copies, {turns} person turns and {reports} reports) and {notices} watch \
         notices in {}",
        direct + posts + orphans + turns + reports,
        secs(seeded),
    );
    println!(
        "{label}: 0117 {}, 0118 {}, commit {}",
        secs(m117),
        secs(m118),
        secs(commit)
    );
    println!(
        "{label}: size before {}, after 0117 {}, after 0118 {}, committed {}, settled {}, peak {}",
        mib(before),
        mib(after_117),
        mib(after_118),
        mib(committed),
        mib(settled),
        mib(peak)
    );
    println!(
        "{label}: {messages} messages, {addressees} addressees, {operations} operations, {wakes} \
         wakes ({pending_wakes} pending), {members} members, {people_after} person conversations"
    );
}

#[tokio::test]
#[ignore = "benchmark: set SUPERTAG_MIGRATION_BENCHMARK=1"]
async fn sqlite_messaging_migration_benchmark() {
    if !enabled() {
        return;
    }
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("state.db");
    benchmark(
        format!("sqlite://{}?mode=rwc", path.display()),
        SqliteFile(path),
    )
    .await;
}

async fn on_postgres<F: Future<Output = ()> + 'static>(run: impl FnOnce(String) -> F) {
    let path = std::env::var_os("SUPERTAG_RUST_TEST_POSTGRES_URL_FILE")
        .expect("dedicated PostgreSQL URL file is required");
    let admin_url = std::fs::read_to_string(path).unwrap();
    let mut url = url::Url::parse(admin_url.trim()).unwrap();
    let name = format!(
        "supertag_rust_messaging_migration_benchmark_{}",
        Uuid::new_v4().simple()
    );
    let mut admin = sqlx::PgConnection::connect(admin_url.trim()).await.unwrap();
    admin
        .execute(format!("CREATE DATABASE {name}").as_str())
        .await
        .unwrap();
    url.set_path(&name);
    let outcome = tokio::task::LocalSet::new()
        .run_until(async move { tokio::task::spawn_local(run(url.to_string())).await })
        .await;
    admin
        .execute(format!("DROP DATABASE {name} WITH (FORCE)").as_str())
        .await
        .unwrap();
    admin.close().await.unwrap();
    outcome.expect("PostgreSQL messaging migration benchmark failed");
}

#[tokio::test]
#[ignore = "benchmark: set SUPERTAG_MIGRATION_BENCHMARK=1 and SUPERTAG_RUST_TEST_POSTGRES_URL_FILE"]
async fn postgres_messaging_migration_benchmark() {
    if !enabled() {
        return;
    }
    on_postgres(|url| benchmark(url, PostgresDatabase)).await;
}
