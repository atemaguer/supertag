//! Upgrading past notes keeps every note that took effect as a seed for its Tag and audience,
//! drops what a turn only staged, removes the notes tables, their receipts, triggers and watch
//! notices, and leaves everything else alone. Opening the upgraded database again changes
//! nothing, and the seeds reach the next turn on the Tag's own harness.
use std::future::Future;

use sqlx::{AnyPool, Connection, Executor, Row};
use supertag_control_plane::{AttemptAccess, Store};
use supertag_protocol::v2::*;
use uuid::Uuid;

mod support;

/// The schema version just before `0121_native_memory_seeds`.
const PRIOR: u32 = 120;
const ALICE: &str = "operator:alice";

async fn seed_prior_version(url: &str) -> (i64, i64) {
    sqlx::any::install_default_drivers();
    let pool = AnyPool::connect(url).await.unwrap();
    let sqlite = url.starts_with("sqlite:");
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
                .is_some_and(|version| version <= PRIOR)
        })
        .collect();
    paths.sort();
    assert_eq!(paths.len(), PRIOR as usize);
    let mut tx = pool.begin().await.unwrap();
    for path in paths {
        sqlx::raw_sql(&std::fs::read_to_string(path).unwrap())
            .execute(&mut *tx)
            .await
            .unwrap();
    }
    // Three Tags: `keeper` keeps memory and has shared notes, one of Alice's, one a running turn
    // was forgetting, and one a turn staged and never finished; `quiet` turned memory off later
    // but kept its notes; `gone` was retired with a note left behind. Notes carry what people
    // actually wrote: quotes, newlines, and non-ASCII.
    sqlx::raw_sql(
        "INSERT INTO supertag_v2_tags (tag_id,instructions,allowed_actions,revision)
         VALUES ('keeper','x','[]',1),('quiet','x','[]',1),('gone','x','[]',1);
         UPDATE supertag_v2_tags SET memory=0 WHERE tag_id='quiet';
         INSERT INTO supertag_v2_tasks (task_id,tag_id,session_id,prompt,instructions,allowed_actions,tag_revision,state,accepted_order,accepted_at_ms)
         VALUES ('t1','keeper','ops','x','x','[]',1,3,1,1000),
                ('t2','keeper','person:alice','x','x','[]',1,3,2,1000),
                ('t3','quiet','ops','x','x','[]',1,3,3,1000);
         INSERT INTO supertag_v2_tag_memories (memory_id,tag_id,audience_principal,text,state,created_by,source_task_id,origin_attempt_id,replaces,created_at_ms,updated_at_ms,last_seen_at_ms)
         VALUES ('mem_release','keeper',NULL,'Releases ship from main; tag them vX.Y.Z.',2,'tag:keeper','t1',NULL,NULL,1000,1000,5000),
                ('mem_runbook','keeper',NULL,'Runbook: docs/oncall.md (\"Paging\" section).
Ask #ops first.',2,'tag:keeper','t1',NULL,NULL,2000,2500,NULL),
                ('mem_alice','keeper','operator:alice','Alice prefers squash merges — linear history for bisect.',2,'tag:keeper','t2',NULL,NULL,3000,3000,NULL),
                ('mem_forgetting','keeper',NULL,'Staging is in eu-north-1.',3,'tag:keeper','t1','attempt-gone',NULL,4000,4100,NULL),
                ('mem_staged','keeper',NULL,'Never took effect.',1,'tag:keeper','t1','attempt-gone','mem_forgetting',4200,4200,NULL),
                ('mem_quiet','quiet',NULL,'Café closes at six.',2,'tag:quiet','t3',NULL,NULL,5000,5000,NULL),
                ('mem_retired','gone',NULL,'A retired Tag kept this.',2,'tag:gone',NULL,NULL,NULL,6000,6000,NULL);
         UPDATE supertag_v2_tags SET retired_at_ms=7000 WHERE tag_id='gone';
         INSERT INTO supertag_v2_memory_receipts (principal,operation_id,request_digest,memory_id)
         VALUES ('task:t1','op-1','d1','mem_release'),('task:t2','op-1','d2','mem_alice');",
    )
    .execute(&mut *tx)
    .await
    .unwrap();
    let memory_notices: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM supertag_v2_watch_notices WHERE kind=8")
            .fetch_one(&mut *tx)
            .await
            .unwrap();
    let other_notices: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM supertag_v2_watch_notices WHERE kind<>8")
            .fetch_one(&mut *tx)
            .await
            .unwrap();
    tx.commit().await.unwrap();
    // A note whose Tag no longer exists, which only a database without the foreign key could
    // hold: SQLite with foreign keys off for the connection, PostgreSQL without the constraint.
    let mut connection = pool.acquire().await.unwrap();
    let orphan = "INSERT INTO supertag_v2_tag_memories (memory_id,tag_id,audience_principal,text,state,created_by,created_at_ms,updated_at_ms)
                  VALUES ('mem_orphan','vanished',NULL,'Nobody keeps this.',2,'tag:vanished',6500,6500)";
    let unchecked = if sqlite {
        "PRAGMA foreign_keys=OFF"
    } else {
        "ALTER TABLE supertag_v2_tag_memories DROP CONSTRAINT supertag_v2_tag_memories_tag_id_fkey"
    };
    sqlx::raw_sql(unchecked)
        .execute(&mut *connection)
        .await
        .unwrap();
    sqlx::raw_sql(orphan)
        .execute(&mut *connection)
        .await
        .unwrap();
    if sqlite {
        sqlx::raw_sql("PRAGMA foreign_keys=ON")
            .execute(&mut *connection)
            .await
            .unwrap();
    }
    drop(connection);
    pool.close().await;
    (memory_notices, other_notices)
}

async fn seeds(pool: &AnyPool) -> Vec<(String, String, String, String, i64)> {
    sqlx::query(
        "SELECT seed_id,tag_id,audience_principal,text,created_at_ms
         FROM supertag_v2_native_memory_seeds ORDER BY seed_id",
    )
    .fetch_all(pool)
    .await
    .unwrap()
    .iter()
    .map(|row| (row.get(0), row.get(1), row.get(2), row.get(3), row.get(4)))
    .collect()
}

async fn contract(url: String) {
    let (memory_notices, other_notices) = seed_prior_version(&url).await;
    assert_eq!(
        memory_notices, 6,
        "every note that took effect was announced"
    );
    let store = Store::open(&url).await.unwrap();
    assert_eq!(store.migrated(), Some((120, 121)));
    let pool = AnyPool::connect(&url).await.unwrap();
    let expected = vec![
        (
            "mem_alice".to_owned(),
            "keeper".to_owned(),
            ALICE.to_owned(),
            "Alice prefers squash merges — linear history for bisect.".to_owned(),
            3000,
        ),
        (
            "mem_forgetting".into(),
            "keeper".into(),
            String::new(),
            "Staging is in eu-north-1.".into(),
            4000,
        ),
        (
            "mem_quiet".into(),
            "quiet".into(),
            String::new(),
            "Café closes at six.".into(),
            5000,
        ),
        (
            "mem_release".into(),
            "keeper".into(),
            String::new(),
            "Releases ship from main; tag them vX.Y.Z.".into(),
            1000,
        ),
        (
            "mem_runbook".into(),
            "keeper".into(),
            String::new(),
            "Runbook: docs/oncall.md (\"Paging\" section).\nAsk #ops first.".into(),
            2000,
        ),
    ];
    // A retired Tag's note, and one whose Tag is gone, are not kept.
    assert_eq!(seeds(&pool).await, expected);
    // The notes, their receipts and their watch notices are gone; other notices stay.
    for table in ["supertag_v2_tag_memories", "supertag_v2_memory_receipts"] {
        assert!(
            sqlx::query(&format!("SELECT 1 FROM {table}"))
                .fetch_optional(&pool)
                .await
                .is_err(),
            "{table} is dropped"
        );
    }
    let left: Vec<(i64, i64)> = sqlx::query(
        "SELECT kind, COUNT(*) FROM supertag_v2_watch_notices GROUP BY kind ORDER BY kind",
    )
    .fetch_all(&pool)
    .await
    .unwrap()
    .iter()
    .map(|row| (row.get(0), row.get(1)))
    .collect();
    assert!(left.iter().all(|(kind, _)| *kind != 8), "{left:?}");
    assert_eq!(
        left.iter().map(|(_, count)| count).sum::<i64>(),
        other_notices
    );
    store.close().await;

    // Opening it again migrates nothing and keeps the seeds as they are.
    let store = Store::open(&url).await.unwrap();
    assert_eq!(store.migrated(), None);
    assert_eq!(seeds(&pool).await, expected);

    // Alice's next turn on the Tag's Codex gets her note to write into her own store.
    let host = support::register_host(&store, "upgraded-host").await;
    store
        .put_tag("keeper", "Keep memory", vec!["files:read".into()])
        .await
        .unwrap();
    store
        .send_message(
            ALICE,
            &SendMessageRequest {
                tag_id: "keeper".into(),
                text: "Hello again".into(),
                operation_id: Uuid::new_v4().to_string(),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    let assignment = store
        .claim_task_waiting(
            &host,
            &ClaimTaskRequest {
                operation_id: Uuid::new_v4().to_string(),
                harness_kind: HarnessKind::Codex.into(),
                ..Default::default()
            },
            std::time::Duration::ZERO,
        )
        .await
        .unwrap()
        .expect("expected Alice's turn");
    let grant = assignment.native_memory.clone().unwrap();
    assert_eq!(
        grant
            .seeds
            .iter()
            .map(|seed| (seed.seed_id.as_str(), seed.text.as_str()))
            .collect::<Vec<_>>(),
        [(
            "mem_alice",
            "Alice prefers squash merges — linear history for bisect."
        )]
    );
    let attempt = InspectAttemptRequest {
        task_id: assignment.task.as_ref().unwrap().task_id.clone(),
        attempt_id: assignment.attempt_id.clone(),
        lease_token: assignment.lease_token.clone(),
    };
    store
        .acknowledge_native_memory_seeds(
            &AttemptAccess::new(&host, &attempt),
            &AcknowledgeNativeMemorySeedsRequest {
                seed_ids: vec!["mem_alice".into()],
            },
        )
        .await
        .unwrap();
    assert_eq!(seeds(&pool).await.len(), 4);
    pool.close().await;
    store.close().await;
}

#[tokio::test]
async fn sqlite_native_memory_seeds_migration() {
    let dir = tempfile::tempdir().unwrap();
    contract(format!(
        "sqlite://{}?mode=rwc",
        dir.path().join("state.db").display()
    ))
    .await;
}

async fn on_postgres<F: Future<Output = ()> + 'static>(run: impl FnOnce(String) -> F) {
    let path = std::env::var_os("SUPERTAG_RUST_TEST_POSTGRES_URL_FILE")
        .expect("dedicated PostgreSQL URL file is required");
    let admin_url = std::fs::read_to_string(path).unwrap();
    let mut url = url::Url::parse(admin_url.trim()).unwrap();
    let name = format!(
        "supertag_rust_native_memory_seeds_migration_{}",
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
    outcome.expect("PostgreSQL native memory seeds migration contract failed");
}

#[tokio::test]
#[ignore = "requires SUPERTAG_RUST_TEST_POSTGRES_URL_FILE for a dedicated PostgreSQL test server"]
async fn postgres_native_memory_seeds_migration() {
    on_postgres(contract).await;
}
