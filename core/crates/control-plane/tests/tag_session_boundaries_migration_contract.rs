//! Upgrading to Tag Session boundaries drops the Objective's Team and the Team's concurrency
//! limit. A Work Session an Objective delegated to another Tag before the upgrade keeps running:
//! its Task still runs and settles, and its report still returns to the Objective's Session.
use std::future::Future;

use sqlx::{AnyPool, Connection, Executor};
use supertag_control_plane::Store;
use supertag_protocol::v2::TaskState;
use uuid::Uuid;

/// The schema version just before `0124_tag_session_boundaries`.
const PRIOR: u32 = 123;
const OPERATOR: &str = "operator:alice";
const WORK: &str = "work/8f0a54b2-36a5-4d5c-9b0e-3d6f2a1c7e90";

async fn seed_prior_version(url: &str) {
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
    // `lead` owns Objective `goal`, which names Team `crew` (at most two turns at once). Its first
    // turn delegated a Work Session to `builder`, whose Task is still running.
    sqlx::raw_sql(&format!(
        "INSERT INTO supertag_v2_tags (tag_id,instructions,allowed_actions,revision)
         VALUES ('lead','x','[]',1),('builder','x','[]',1);
         INSERT INTO supertag_v2_teams (team_id,name,max_concurrency,revision,created_at_ms,updated_at_ms)
         VALUES ('crew','crew',2,1,1,1);
         INSERT INTO supertag_v2_team_members (team_id,tag_id) VALUES ('crew','lead'),('crew','builder');
         INSERT INTO supertag_v2_objectives (objective_id,owner_tag_id,session_id,outcome,ongoing,status,revision,limit_state,created_at_ms,updated_at_ms,team_id)
         VALUES ('goal','lead','objective/goal','Ship',0,1,1,'{{}}',1,1,'crew');
         INSERT INTO supertag_v2_objective_sessions (tag_id,session_id,objective_id)
         VALUES ('lead','objective/goal','goal');
         INSERT INTO supertag_v2_tasks (task_id,tag_id,session_id,prompt,instructions,allowed_actions,tag_revision,state,accepted_order,accepted_at_ms,attempt_id)
         VALUES ('parent','lead','objective/goal','Start','x','[]',1,3,10,100,'a1'),
                ('child','builder','{WORK}','Build it','x','[]',1,2,11,110,'a2');
         UPDATE supertag_v2_objectives SET starting_task_id='parent' WHERE objective_id='goal';
         INSERT INTO supertag_v2_objective_tasks (task_id,objective_id,kind)
         VALUES ('parent','goal','work'),('child','goal','work');
         INSERT INTO supertag_v2_work_sessions (work_session_id,title,parent_tag_id,parent_session_id,starter_task_id,tag_id,latest_task_id,objective_id,created_order)
         VALUES ('{WORK}','Build','lead','objective/goal','parent','builder','child','goal',11);
         INSERT INTO supertag_v2_work_session_tasks (task_id,work_session_id,kind,starter_task_id)
         VALUES ('child','{WORK}',1,'parent');
         UPDATE supertag_v2_write_order SET revision=20 WHERE singleton=1;"
    ))
    .execute(&mut *tx)
    .await
    .unwrap();
    tx.commit().await.unwrap();
    pool.close().await;
}

async fn contract(url: String) {
    seed_prior_version(&url).await;
    let store = Store::open(&url).await.unwrap();
    assert_eq!(store.migrated(), Some((i64::from(PRIOR), 127)));
    let pool = AnyPool::connect(&url).await.unwrap();
    // The Objective names no Team, and a Team has no concurrency limit.
    assert!(
        sqlx::query("SELECT team_id FROM supertag_v2_objectives")
            .fetch_all(&pool)
            .await
            .is_err()
    );
    assert!(
        sqlx::query("SELECT max_concurrency FROM supertag_v2_teams")
            .fetch_all(&pool)
            .await
            .is_err()
    );
    let objective = store.get_objective(OPERATOR, "goal").await.unwrap();
    assert_eq!(objective.owner_tag_id, "lead");
    let team = store.get_team(OPERATOR, "crew").await.unwrap();
    assert_eq!(team.member_tag_ids, ["builder", "lead"]);
    // A change to the Objective still reaches its watch.
    store
        .pause_objective(
            OPERATOR,
            &supertag_protocol::v2::ObjectiveActionRequest {
                operation_id: "pause".into(),
                objective_id: "goal".into(),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    // The delegated Work Session is still open and its Task still running.
    let open: (Option<i64>, String) = sqlx::query_as(
        "SELECT w.closed_at_ms,w.tag_id FROM supertag_v2_work_sessions w WHERE w.work_session_id=$1",
    )
    .bind(WORK)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(open, (None, "builder".to_owned()));
    assert_eq!(
        store.get_task("child").await.unwrap().state(),
        TaskState::Running
    );
    // When it settles, its report still returns to the Objective's Session.
    sqlx::query("UPDATE supertag_v2_tasks SET state=$1,result='Built' WHERE task_id='child'")
        .bind(TaskState::Succeeded as i64)
        .execute(&pool)
        .await
        .unwrap();
    store.sweep_work_sessions().await.unwrap();
    let report: (String, String, String) = sqlx::query_as(
        "SELECT t.tag_id,t.session_id,t.prompt FROM supertag_v2_work_session_reports r
         JOIN supertag_v2_tasks t ON t.task_id=r.report_task_id WHERE r.child_task_id='child'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(report.0, "lead");
    assert_eq!(report.1, "objective/goal");
    assert!(report.2.contains("Built"), "{}", report.2);
    pool.close().await;
    store.close().await;
}

#[tokio::test]
async fn sqlite_tag_session_boundaries_migration() {
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
        "supertag_rust_tag_session_boundaries_migration_{}",
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
    outcome.expect("PostgreSQL Tag Session boundaries migration contract failed");
}

#[tokio::test]
#[ignore = "requires SUPERTAG_RUST_TEST_POSTGRES_URL_FILE for a dedicated PostgreSQL test server"]
async fn postgres_tag_session_boundaries_migration() {
    on_postgres(contract).await;
}
