mod support;

use sha2::Digest;
use sqlx::{Connection, Executor};
use supertag_control_plane::{ControlPlane, HostAuthority, Store, StoreError};
use supertag_protocol::{authenticated_request, v2::connector_server::Connector, v2::*};
use tonic::{Code, Status};
use uuid::Uuid;

const KEY: &str = "fixture-private-gateway";
const CONNECTOR: &str = "connector:fixture";
const OPERATOR: &str = "operator:alice";
const TAG: &str = "reviewer";
const HARNESS: HarnessKind = HarnessKind::Codex;

fn selection(model: Option<&str>, effort: Option<&str>) -> ExecutionSelection {
    ExecutionSelection {
        model: model.map(str::to_owned),
        effort: effort.map(str::to_owned),
    }
}

async fn put_tag(store: &Store, models: &[&str], efforts: &[&str]) -> PolicyExecutionSettings {
    let execution = PolicyExecutionSettings {
        harness: Some("codex".into()),
        models: models.iter().map(|model| (*model).into()).collect(),
        efforts: efforts.iter().map(|effort| (*effort).into()).collect(),
        shared_execution_environment_id: None,
    };
    store
        .put_tag_spec(PutTagRequest {
            tag_id: TAG.into(),
            instructions: "Review the changes".into(),
            harness_kind: HARNESS as i32,
            execution: Some(execution.clone()),
            ..Default::default()
        })
        .await
        .unwrap();
    execution
}

fn event(id: &str, requested: ExecutionSelection) -> AcceptEventRequest {
    AcceptEventRequest {
        account_id: "fixture".into(),
        event_id: id.into(),
        tag_id: TAG.into(),
        session_id: format!("event-{id}"),
        prompt: "Review this change".into(),
        destination: Some(ReplyDestination {
            conversation_id: "channel".into(),
            thread_id: Some(id.into()),
        }),
        requested_execution: Some(requested),
    }
}

async fn accept(
    cp: &ControlPlane,
    principal: &str,
    input: &AcceptEventRequest,
) -> Result<Task, Status> {
    // The Gateway names the connector account it acts for; the first Gateway trusted with every
    // Tag to act for an unmanaged account keeps it.
    let mut request = authenticated_request(input.clone(), KEY, Some("gateway:fixture")).unwrap();
    request.metadata_mut().insert(
        supertag_protocol::CONNECTOR_ACCOUNT_HEADER,
        principal
            .strip_prefix("connector:")
            .unwrap()
            .parse()
            .unwrap(),
    );
    cp.accept_event(request)
        .await
        .map(tonic::Response::into_inner)
}

async fn claim(store: &Store, host: &HostAuthority, model: &str) -> Option<Assignment> {
    store
        .claim_task_with_profile(
            host,
            &Uuid::new_v4().to_string(),
            &[],
            HARNESS,
            &[],
            Some(&HarnessExecutionProfile {
                model_ids: vec![model.into()],
                default_model: Some(model.into()),
                ..Default::default()
            }),
        )
        .await
        .unwrap()
}

async fn start(
    store: &Store,
    host: &HostAuthority,
    task: &Task,
    model: &str,
) -> InspectAttemptRequest {
    let assignment = claim(store, host, model).await.unwrap();
    let assigned = assignment.task.unwrap();
    assert_eq!(assigned.task_id, task.task_id);
    let execution = assigned.attempt_execution.unwrap();
    assert_eq!(execution.model_source(), ModelSource::Task);
    assert_eq!(execution.selection, task.execution_selection);
    let running = store
        .start_task(
            host,
            &StartTaskRequest {
                task_id: task.task_id.clone(),
                attempt_id: assignment.attempt_id.clone(),
                lease_token: assignment.lease_token.clone(),
            },
        )
        .await
        .unwrap();
    assert_eq!(running.state(), TaskState::Running);
    assert_eq!(running.attempt_execution, Some(execution));
    InspectAttemptRequest {
        task_id: task.task_id.clone(),
        attempt_id: assignment.attempt_id,
        lease_token: assignment.lease_token,
    }
}

fn input(task: &Task) -> QueueInputRequest {
    QueueInputRequest {
        task_id: task.task_id.clone(),
        operation_id: format!("input-{}", task.session_id),
        text: "Also check the tests".into(),
    }
}

async fn contract(url: &str) {
    let cp = ControlPlane::open(url, KEY.into(), "operator:local".into())
        .await
        .unwrap();
    // A seeded Gateway is trusted with every Tag, so it may serve unmanaged accounts.
    cp.seed_enrollment(
        supertag_control_plane::Role::Gateway,
        "fixture",
        &sha2::Sha256::digest(b"fixture gateway"),
    )
    .await
    .unwrap();
    let store = Store::open(url).await.unwrap();
    let mut read = sqlx::AnyConnection::connect(url).await.unwrap();
    let range = put_tag(&store, &["first", "chosen"], &["medium", "high"]).await;
    let chosen_request = event("chosen", selection(Some("chosen"), Some("high")));
    assert_eq!(
        accept(&cp, "connector:other", &chosen_request)
            .await
            .unwrap_err()
            .code(),
        Code::PermissionDenied
    );

    for invalid in [
        selection(Some("outside"), Some("high")),
        selection(Some("chosen"), Some("low")),
    ] {
        let mut rejected = chosen_request.clone();
        rejected.requested_execution = Some(invalid);
        assert_eq!(
            accept(&cp, CONNECTOR, &rejected).await.unwrap_err().code(),
            Code::InvalidArgument
        );
    }
    for table in ["tasks", "inbound_events"] {
        let count: i64 = sqlx::query_scalar(&format!("SELECT COUNT(*) FROM supertag_v2_{table}"))
            .fetch_one(&mut read)
            .await
            .unwrap();
        assert_eq!(count, 0, "rejected choice changed {table}");
    }

    // The same provider event can still be admitted after an invalid choice was rejected.
    let chosen = accept(&cp, CONNECTOR, &chosen_request).await.unwrap();
    assert_eq!(
        chosen.execution_selection,
        chosen_request.requested_execution
    );
    assert_eq!(
        chosen.policy_snapshot.as_ref().unwrap().execution.as_ref(),
        Some(&range)
    );
    let wrong = support::register_host(&store, "first-model-host").await;
    assert!(claim(&store, &wrong, "first").await.is_none());
    assert_eq!(store.get_task(&chosen.task_id).await.unwrap(), chosen);
    let matching = support::register_host(&store, "chosen-model-host").await;
    let attempt = start(&store, &matching, &chosen, "chosen").await;

    // The follower resolves the same range, but would run with its default choices.
    assert!(matches!(
        store.queue_input(OPERATOR, &input(&chosen)).await,
        Err(StoreError::FailedPrecondition(_))
    ));
    assert!(
        store
            .take_input(
                &matching,
                &TakeInputRequest {
                    attempt: Some(attempt)
                }
            )
            .await
            .unwrap()
            .is_none()
    );
    let count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM supertag_v2_tasks WHERE tag_id=$1 AND session_id=$2",
    )
    .bind(TAG)
    .bind(&chosen.session_id)
    .fetch_one(&mut read)
    .await
    .unwrap();
    assert_eq!(count, 1, "mismatched live input left a follower Task");

    // An explicit default and the implicit default resolve to the same execution.
    let default = accept(
        &cp,
        CONNECTOR,
        &event("default", selection(Some("first"), Some("medium"))),
    )
    .await
    .unwrap();
    let attempt = start(&store, &wrong, &default, "first").await;
    let queued = store.queue_input(OPERATOR, &input(&default)).await.unwrap();
    assert_eq!(
        store
            .take_input(
                &wrong,
                &TakeInputRequest {
                    attempt: Some(attempt)
                }
            )
            .await
            .unwrap()
            .unwrap()
            .input_id,
        queued.input_id
    );
    let follower = store.get_task(&queued.follower_task_id).await.unwrap();
    assert_eq!(follower.execution_selection, default.execution_selection);

    let effort_only = accept(
        &cp,
        CONNECTOR,
        &event("effort-only", selection(None, Some("high"))),
    )
    .await
    .unwrap();
    assert_eq!(
        effort_only.execution_selection,
        Some(selection(Some("first"), Some("high")))
    );

    let admitted_before_edit = store.get_task(&chosen.task_id).await.unwrap();
    put_tag(&store, &["replacement"], &["low"]).await;
    drop(cp);
    let cp = ControlPlane::open(url, KEY.into(), "operator:local".into())
        .await
        .unwrap();
    assert_eq!(
        accept(&cp, CONNECTOR, &chosen_request).await.unwrap(),
        admitted_before_edit
    );
    let mut changed = chosen_request.clone();
    changed.requested_execution = Some(selection(Some("replacement"), Some("low")));
    assert_eq!(
        accept(&cp, CONNECTOR, &changed).await.unwrap_err().code(),
        Code::AlreadyExists
    );
    assert_eq!(
        store.get_task(&chosen.task_id).await.unwrap(),
        admitted_before_edit
    );
    read.close().await.unwrap();
    store.close().await;
}

#[tokio::test]
async fn sqlite_connector_choices_are_frozen_and_fence_live_input() {
    let directory = tempfile::tempdir().unwrap();
    Box::pin(contract(&format!(
        "sqlite://{}?mode=rwc",
        directory.path().join("execution-override.db").display()
    )))
    .await;
}

#[tokio::test]
#[ignore = "requires SUPERTAG_RUST_TEST_POSTGRES_URL_FILE for a dedicated PostgreSQL test server"]
async fn postgres_connector_choices_are_frozen_and_fence_live_input() {
    let path = std::env::var_os("SUPERTAG_RUST_TEST_POSTGRES_URL_FILE")
        .expect("PostgreSQL test URL file required");
    let admin_url = std::fs::read_to_string(path).unwrap();
    let name = format!("supertag_execution_override_{}", Uuid::new_v4().simple());
    let mut admin = sqlx::PgConnection::connect(admin_url.trim()).await.unwrap();
    admin
        .execute(format!("CREATE DATABASE {name}").as_str())
        .await
        .unwrap();
    let mut url = url::Url::parse(admin_url.trim()).unwrap();
    url.set_path(&name);
    let outcome = tokio::task::LocalSet::new()
        .run_until(async move {
            tokio::task::spawn_local(async move { Box::pin(contract(url.as_str())).await }).await
        })
        .await;
    admin
        .execute(format!("DROP DATABASE {name} WITH (FORCE)").as_str())
        .await
        .unwrap();
    admin.close().await.unwrap();
    outcome.expect("PostgreSQL execution override contract failed");
}
