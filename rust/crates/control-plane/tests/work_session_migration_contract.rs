mod support;

use sha2::{Digest, Sha256};
use sqlx::{Connection, Executor};
use supertag_control_plane::Store;
use supertag_protocol::v2::*;
use uuid::Uuid;

const OP: &str = "operator:alice";
const NOW: i64 = 1_893_456_000_000;
const WORK: &str = "work/existing";

async fn seed_version_27(url: &str) {
    sqlx::any::install_default_drivers();
    let pool = sqlx::AnyPool::connect(url).await.unwrap();
    let backend = if url.starts_with("sqlite:") {
        "sqlite"
    } else {
        "postgresql"
    };
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("migrations")
        .join(backend);
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
                .is_some_and(|version| version <= 27)
        })
        .collect();
    paths.sort();
    assert_eq!(paths.len(), 27);
    let mut tx = pool.begin().await.unwrap();
    for path in paths {
        sqlx::raw_sql(&std::fs::read_to_string(path).unwrap())
            .execute(&mut *tx)
            .await
            .unwrap();
    }
    sqlx::raw_sql(
        "INSERT INTO supertag_v2_tags (tag_id,instructions,allowed_actions,revision)
         VALUES ('lead','Accepted before the migration','[\"files:read\"]',1);
         INSERT INTO supertag_v2_tasks (task_id,tag_id,session_id,prompt,instructions,allowed_actions,tag_revision,state,accepted_order)
         VALUES ('old-parent','lead','legacy-parent','Start the child','Accepted before the migration','[\"files:read\"]',1,3,1),
                ('old-child','lead','work/existing','Read fixture','Accepted before the migration','[\"files:read\"]',1,3,2),
                ('old-report','lead','legacy-parent','Existing report','Accepted before the migration','[\"files:read\"]',1,3,3);
         UPDATE supertag_v2_tasks SET attempt_id='old-attempt',host_principal='host:migration-host',host_generation=1,lease_token='old-lease' WHERE task_id='old-parent';
         INSERT INTO supertag_v2_work_sessions (work_session_id,title,parent_tag_id,parent_session_id,starter_task_id,tag_id,latest_task_id,created_order)
         VALUES ('work/existing','Migrated child','lead','legacy-parent','old-parent','lead','old-child',2);
         INSERT INTO supertag_v2_work_session_tasks (task_id,work_session_id,kind)
         VALUES ('old-child','work/existing',1),('old-report','work/existing',2);
         INSERT INTO supertag_v2_work_session_reports (child_task_id,work_session_id,report_task_id,created_order)
         VALUES ('old-child','work/existing','old-report',3);
         UPDATE supertag_v2_write_order SET revision=3 WHERE singleton=1;",
    ).execute(&mut *tx).await.unwrap();
    let digest = format!(
        "{:x}",
        Sha256::digest(
            serde_json::to_vec(&(
                "Migrated child",
                "Read fixture",
                Option::<&str>::None,
                "lead"
            ))
            .unwrap()
        )
    );
    sqlx::query("INSERT INTO supertag_v2_work_session_starts (starter_task_id,operation_id,request_digest,work_session_id) VALUES ('old-parent','old-start',$1,'work/existing')")
        .bind(digest).execute(&mut *tx).await.unwrap();
    let version: i64 = sqlx::query_scalar("SELECT version FROM supertag_v2_schema")
        .fetch_one(&mut *tx)
        .await
        .unwrap();
    assert_eq!(version, 27);
    tx.commit().await.unwrap();
    pool.close().await;
}

async fn contract(url: String) {
    seed_version_27(&url).await;
    let store = Store::open(&url)
        .await
        .unwrap()
        .with_execution_clock(|| NOW);
    let host = support::register_host(&store, "migration-host").await;
    let original = store.get_work_session(OP, WORK).await.unwrap();
    assert_eq!(original.starter_task_id, "old-parent");
    assert_eq!(original.latest_task_id, "old-child");
    assert_eq!(original.report_task_id.as_deref(), Some("old-report"));
    assert_eq!(original.latest_task_state(), TaskState::Succeeded);
    assert_eq!(original.report_task_state(), TaskState::Succeeded);
    let start = StartWorkSessionRequest {
        attempt: Some(InspectAttemptRequest {
            task_id: "old-parent".into(),
            attempt_id: "old-attempt".into(),
            lease_token: "old-lease".into(),
        }),
        operation_id: "old-start".into(),
        title: "Migrated child".into(),
        instruction: "Read fixture".into(),
        ..Default::default()
    };
    assert_eq!(
        store.start_work_session(&host, &start).await.unwrap(),
        original
    );
    let parent = store
        .submit_task(
            OP,
            &SubmitTaskRequest {
                execution_limits: None,
                tag_id: "lead".into(),
                session_id: "legacy-parent".into(),
                operation_id: "later-parent".into(),
                prompt: "Continue the migrated child".into(),
            },
        )
        .await
        .unwrap();
    let claim = store
        .claim_task(&host, "later-parent")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(claim.task.unwrap().task_id, parent.task_id);
    let attempt = InspectAttemptRequest {
        task_id: parent.task_id.clone(),
        attempt_id: claim.attempt_id,
        lease_token: claim.lease_token,
    };
    store
        .start_task(
            &host,
            &StartTaskRequest {
                task_id: attempt.task_id.clone(),
                attempt_id: attempt.attempt_id.clone(),
                lease_token: attempt.lease_token.clone(),
            },
        )
        .await
        .unwrap();
    let request = ContinueWorkSessionRequest {
        attempt: Some(attempt),
        operation_id: "continue-migrated".into(),
        work_session_id: WORK.into(),
        message: "Use the next fixture case".into(),
    };
    let continued = store.continue_work_session(&host, &request).await.unwrap();
    assert_eq!(continued.starter_task_id, parent.task_id);
    assert_ne!(continued.latest_task_id, original.latest_task_id);
    assert_eq!(continued.work_session_id, original.work_session_id);
    assert!(continued.report_task_id.is_none());
    assert_eq!(
        store.start_work_session(&host, &start).await.unwrap(),
        original
    );
    let history = store
        .get_work_session_report(OP, WORK, Some("old-report"))
        .await
        .unwrap();
    assert_eq!(history, original);
    store.close().await;
    let store = Store::open(&url)
        .await
        .unwrap()
        .with_execution_clock(|| NOW);
    assert_eq!(
        store.continue_work_session(&host, &request).await.unwrap(),
        continued
    );
    assert_eq!(
        store
            .get_work_session_report(OP, WORK, Some("old-report"))
            .await
            .unwrap(),
        original
    );
    store.close().await;
}

#[tokio::test]
async fn sqlite_populated_work_session_version_27_upgrade() {
    let directory = tempfile::tempdir().unwrap();
    contract(format!(
        "sqlite://{}?mode=rwc",
        directory.path().join("upgrade.db").display()
    ))
    .await;
}

#[tokio::test]
#[ignore = "requires SUPERTAG_RUST_TEST_POSTGRES_URL_FILE for a dedicated PostgreSQL test server"]
async fn postgres_populated_work_session_version_27_upgrade() {
    let path = std::env::var_os("SUPERTAG_RUST_TEST_POSTGRES_URL_FILE")
        .expect("dedicated PostgreSQL URL file required");
    let admin_url = std::fs::read_to_string(path).unwrap();
    let mut url = url::Url::parse(admin_url.trim()).unwrap();
    let name = format!("supertag_rust_ws_upgrade_{}", Uuid::new_v4().simple());
    let mut admin = sqlx::PgConnection::connect(admin_url.trim()).await.unwrap();
    admin
        .execute(format!("CREATE DATABASE {name}").as_str())
        .await
        .unwrap();
    url.set_path(&name);
    let outcome = tokio::task::LocalSet::new()
        .run_until(async move { tokio::task::spawn_local(contract(url.to_string())).await })
        .await;
    admin
        .execute(format!("DROP DATABASE {name} WITH (FORCE)").as_str())
        .await
        .unwrap();
    admin.close().await.unwrap();
    outcome.expect("PostgreSQL Work Session migration contract failed");
}
