mod support;

use sqlx::{Connection, Executor};
use supertag_control_plane::Store;
use supertag_protocol::v2::*;
use uuid::Uuid;

const OPERATOR: &str = "operator:alice";
const NOW: i64 = 1_893_456_000_000;

fn objective(id: &str) -> CreateObjectiveRequest {
    CreateObjectiveRequest {
        objective_id: id.into(),
        operation_id: format!("create-{id}"),
        owner_tag_id: "lead".into(),
        outcome: "Verify the fixture".into(),
        team_id: Some("team".into()),
        ongoing: true,
        ..Default::default()
    }
}

async fn contract(url: String) {
    let store = Store::open(&url)
        .await
        .unwrap()
        .with_execution_clock(|| NOW);
    let host = support::register_host(&store, "first-host").await;
    let other = support::register_host(&store, "second-host").await;
    store
        .put_tag("lead", "Fixture identity", vec![])
        .await
        .unwrap();
    store
        .create_team(
            OPERATOR,
            &CreateTeamRequest {
                operation_id: "create-team".into(),
                team_id: "team".into(),
                name: "Fixture team".into(),
                member_tag_ids: vec!["lead".into()],
                max_concurrency: Some(1),
            },
        )
        .await
        .unwrap();
    let first = store
        .create_objective(OPERATOR, &objective("first"))
        .await
        .unwrap();
    let second = store
        .create_objective(OPERATOR, &objective("second"))
        .await
        .unwrap();
    let claim = store.claim_task(&host, "first").await.unwrap().unwrap();
    assert_eq!(claim.task.unwrap().task_id, first.starting_task_id);
    store
        .start_task(
            &host,
            &StartTaskRequest {
                task_id: first.starting_task_id.clone(),
                attempt_id: claim.attempt_id.clone(),
                lease_token: claim.lease_token.clone(),
            },
        )
        .await
        .unwrap();
    assert!(
        store
            .claim_task(&other, "before-cancel")
            .await
            .unwrap()
            .is_none()
    );
    let cancelled = store
        .cancel_objective(
            OPERATOR,
            &ObjectiveActionRequest {
                objective_id: first.objective_id,
                operation_id: "cancel-first".into(),
                reason: "Stop fixture execution".into(),
            },
        )
        .await
        .unwrap();
    assert_eq!(cancelled.status(), ObjectiveStatus::Cancelled);
    assert!(
        store
            .claim_task(&other, "after-cancel")
            .await
            .unwrap()
            .is_none(),
        "a closed Objective still occupies its Team slot until execution cleanup is confirmed"
    );
    store.close().await;

    let store = Store::open(&url)
        .await
        .unwrap()
        .with_execution_clock(|| NOW);
    assert!(
        store
            .claim_task(&other, "after-restart")
            .await
            .unwrap()
            .is_none()
    );
    let cleanup = FinishTaskRequest {
        task_id: first.starting_task_id,
        attempt_id: claim.attempt_id,
        lease_token: claim.lease_token,
        succeeded: true,
        result: "Late result must not replace cancellation".into(),
        ..Default::default()
    };
    let receipt = store.finish_task(&host, &cleanup).await.unwrap();
    assert_eq!(receipt.state(), TaskState::Cancelled);
    let claim = store
        .claim_task(&other, "after-cleanup")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(claim.task.unwrap().task_id, second.starting_task_id);
    store
        .start_task(
            &other,
            &StartTaskRequest {
                task_id: second.starting_task_id,
                attempt_id: claim.attempt_id,
                lease_token: claim.lease_token,
            },
        )
        .await
        .unwrap();
    store
        .create_objective(OPERATOR, &objective("third"))
        .await
        .unwrap();
    assert_eq!(store.finish_task(&host, &cleanup).await.unwrap(), receipt);
    assert!(
        store
            .claim_task(&host, "after-cleanup-replay")
            .await
            .unwrap()
            .is_none()
    );
    store.close().await;
}

#[tokio::test]
async fn sqlite_cancelled_objective_holds_team_capacity_until_cleanup() {
    let dir = tempfile::tempdir().unwrap();
    contract(format!(
        "sqlite://{}?mode=rwc",
        dir.path().join("team.db").display()
    ))
    .await;
}

#[tokio::test]
#[ignore = "requires SUPERTAG_RUST_TEST_POSTGRES_URL_FILE for a dedicated PostgreSQL test server"]
async fn postgres_cancelled_objective_holds_team_capacity_until_cleanup() {
    let path = std::env::var_os("SUPERTAG_RUST_TEST_POSTGRES_URL_FILE")
        .expect("dedicated PostgreSQL URL file required");
    let admin_url = std::fs::read_to_string(path).unwrap();
    let mut url = url::Url::parse(admin_url.trim()).unwrap();
    let name = format!("supertag_rust_team_cleanup_{}", Uuid::new_v4().simple());
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
    outcome.expect("PostgreSQL Team cleanup capacity contract failed");
}
