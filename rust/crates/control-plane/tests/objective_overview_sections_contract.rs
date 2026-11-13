//! The Objective overview's delivery and failure sections (`tests/objective-overview.test.ts`
//! "explains a failed turn", `tests/objective-watch.test.ts` "describe objective"): each Session
//! names its latest Workspace delivery, and a failed or uncertain latest turn explains itself
//! with the commands that act on it.
use prost::Message;
use sqlx::{AnyConnection, Connection, Executor};
use supertag_control_plane::Store;
use supertag_protocol::v2::*;
use uuid::Uuid;

mod support;

const OPERATOR: &str = "operator:alice";
const NOW: i64 = 1_893_456_000_000;

async fn contract(url: String) {
    let store = Store::open(&url)
        .await
        .unwrap()
        .with_execution_clock(|| NOW);
    let host = support::register_host(&store, "laptop").await;
    store.put_tag("lead", "Lead", vec![]).await.unwrap();
    let objective = store
        .create_objective(
            OPERATOR,
            &CreateObjectiveRequest {
                objective_id: "ship".into(),
                operation_id: "create-ship".into(),
                owner_tag_id: "lead".into(),
                outcome: "Ship the exporter".into(),
                ongoing: true,
                ..Default::default()
            },
        )
        .await
        .unwrap();
    let overview = |store: &Store| {
        let store = store.clone();
        async move {
            store
                .objective_overview(&GetObjectiveOverviewRequest {
                    objective_id: "ship".into(),
                    ..Default::default()
                })
                .await
                .unwrap()
        }
    };
    let owner = overview(&store).await.sessions.remove(0);
    assert!(owner.delivery.is_none() && owner.failure.is_none());

    // A failed turn explains itself with its own text and the command that shows its events.
    let claim = store.claim_task(&host, "claim").await.unwrap().unwrap();
    let task = claim.task.clone().unwrap();
    assert_eq!(task.task_id, objective.starting_task_id);
    store
        .start_task(
            &host,
            &StartTaskRequest {
                task_id: task.task_id.clone(),
                attempt_id: claim.attempt_id.clone(),
                lease_token: claim.lease_token.clone(),
            },
        )
        .await
        .unwrap();
    store
        .finish_task(
            &host,
            &FinishTaskRequest {
                task_id: task.task_id.clone(),
                attempt_id: claim.attempt_id.clone(),
                lease_token: claim.lease_token.clone(),
                succeeded: false,
                result: "The harness is not signed in.".into(),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    let view = overview(&store).await;
    let owner = &view.sessions[0];
    assert_eq!(owner.status(), ObjectiveSessionStatus::Failed);
    let failure = owner.failure.as_ref().unwrap();
    assert_eq!(failure.task_id, task.task_id);
    assert_eq!(failure.state(), TaskState::Failed);
    assert_eq!(failure.message, "The harness is not signed in.");
    assert_eq!(
        failure.next_actions,
        [format!("supertag task events {}", task.task_id)]
    );
    assert!(owner.delivery.is_none());

    // The latest successful delivery is named with its Workspace, commits and changed files,
    // and stays named after a later turn fails.
    let delivery = WorkspaceDeliveryReference {
        workspace_id: "product".into(),
        delivery_id: "delivery-1".into(),
        base_commit: "a".repeat(40),
        start_commit: "a".repeat(40),
        head_commit: "b".repeat(40),
        committed: true,
        changed_files: 3,
        patch: Some(BlobReference::default()),
        bundle: None,
    };
    let mut database = AnyConnection::connect(&url).await.unwrap();
    sqlx::query("UPDATE supertag_v2_tasks SET state=$1, workspace_delivery=$2, completed_at_ms=$3 WHERE task_id=$4")
        .bind(TaskState::Succeeded as i64)
        .bind(delivery.encode_to_vec())
        .bind(NOW)
        .bind(&task.task_id)
        .execute(&mut database)
        .await
        .unwrap();
    database.close().await.unwrap();
    let view = overview(&store).await;
    let owner = &view.sessions[0];
    assert!(owner.failure.is_none());
    assert_eq!(owner.latest_completed_at_ms, Some(NOW));
    assert_eq!(
        owner.delivery,
        Some(ObjectiveSessionDelivery {
            task_id: task.task_id.clone(),
            workspace_id: "product".into(),
            base_commit: "a".repeat(40),
            head_commit: "b".repeat(40),
            committed: true,
            changed_files: 3,
            patch: true,
        })
    );
    store.close().await;
}

#[tokio::test]
async fn sqlite_overview_names_deliveries_and_explains_failed_turns() {
    sqlx::any::install_default_drivers();
    let dir = tempfile::tempdir().unwrap();
    contract(format!(
        "sqlite://{}?mode=rwc",
        dir.path().join("overview.db").display()
    ))
    .await;
}

#[tokio::test]
#[ignore = "requires SUPERTAG_RUST_TEST_POSTGRES_URL_FILE for a dedicated PostgreSQL test server"]
async fn postgres_overview_names_deliveries_and_explains_failed_turns() {
    sqlx::any::install_default_drivers();
    let path = std::env::var_os("SUPERTAG_RUST_TEST_POSTGRES_URL_FILE")
        .expect("dedicated PostgreSQL URL file required");
    let admin_url = std::fs::read_to_string(path).unwrap();
    let mut url = url::Url::parse(admin_url.trim()).unwrap();
    let name = format!(
        "supertag_rust_overview_sections_{}",
        Uuid::new_v4().simple()
    );
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
    outcome.expect("PostgreSQL Objective overview sections contract failed");
}
