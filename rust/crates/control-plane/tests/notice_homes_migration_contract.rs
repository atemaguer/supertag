//! Upgrading to notice homes keeps every earlier Objective report keyed to the start thread it
//! was posted to, so no report is posted a second time after the upgrade.
use std::future::Future;

use sqlx::{Connection, Executor};
use supertag_control_plane::Store;
use uuid::Uuid;

/// The schema version just before `0073_objective_notice_homes`.
const PRIOR: u32 = 72;

async fn seed_prior_version(url: &str) {
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
    sqlx::raw_sql(
        "INSERT INTO supertag_v2_tags (tag_id,instructions,allowed_actions,revision)
         VALUES ('owner','Accepted before the migration','[]',1);
         INSERT INTO supertag_v2_tasks (task_id,tag_id,session_id,prompt,instructions,allowed_actions,tag_revision,state,accepted_order)
         VALUES ('old-report','owner','surface-status:old','Objective old report budget-80','Accepted before the migration','[]',1,3,1),
                ('old-notice','owner','surface-status:other','Objective old other notice','Accepted before the migration','[]',1,3,2);
         INSERT INTO supertag_v2_objectives (objective_id,owner_tag_id,session_id,outcome,ongoing,status,revision,limit_state,created_at_ms,updated_at_ms)
         VALUES ('old','owner','objective-session','Release the importer',0,1,1,'{}',1,1);
         INSERT INTO supertag_v2_objective_notices (objective_id,notice_key,task_id)
         VALUES ('old','report:budget-80','old-report'),('old','approval:other','old-notice');
         UPDATE supertag_v2_write_order SET revision=2 WHERE singleton=1;",
    )
    .execute(&mut *tx)
    .await
    .unwrap();
    tx.commit().await.unwrap();
    pool.close().await;
}

async fn contract(url: String) {
    seed_prior_version(&url).await;
    let store = Store::open(&url).await.unwrap();
    store.close().await;
    let pool = sqlx::AnyPool::connect(&url).await.unwrap();
    let rows: Vec<(String, Option<String>)> = sqlx::query_as(
        "SELECT notice_key, home FROM supertag_v2_objective_notices WHERE objective_id='old' ORDER BY notice_key",
    )
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(
        rows,
        [
            ("approval:other".to_owned(), None),
            (
                "report:budget-80@thread".to_owned(),
                Some("thread".to_owned())
            ),
        ]
    );
    pool.close().await;
}

#[tokio::test]
async fn sqlite_notice_homes_migration() {
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
        "supertag_rust_notice_homes_migration_{}",
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
    outcome.expect("PostgreSQL notice homes migration contract failed");
}

#[tokio::test]
#[ignore = "requires SUPERTAG_RUST_TEST_POSTGRES_URL_FILE for a dedicated PostgreSQL test server"]
async fn postgres_notice_homes_migration() {
    on_postgres(contract).await;
}
