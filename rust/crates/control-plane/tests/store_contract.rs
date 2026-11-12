use std::path::Path;

use sqlx::{Connection, Executor};
use supertag_control_plane::{Store, StoreError};
use supertag_protocol::v2::{
    AppendEventRequest, FinishTaskRequest, StartTaskRequest, SubmitTaskRequest, TaskState,
};
use uuid::Uuid;

fn request(operation: &str) -> SubmitTaskRequest {
    SubmitTaskRequest {
        tag_id: "reviewer".into(),
        session_id: "review-session".into(),
        operation_id: operation.into(),
        prompt: "Review the patch".into(),
    }
}

async fn contract(store: &Store) {
    let tag = store
        .put_tag("reviewer", "Be precise", vec!["files:read".into()])
        .await
        .unwrap();
    assert_eq!(tag.revision, 1);

    // Concurrent retries return the same accepted work and immutable policy snapshot.
    let body = request("lost-response");
    let (first, retry) = tokio::join!(
        store.submit_task("operator:alice", &body),
        store.submit_task("operator:alice", &body),
    );
    let first = first.unwrap();
    assert_eq!(first, retry.unwrap());
    store
        .put_tag(
            "reviewer",
            "Changed instructions",
            vec!["files:write".into()],
        )
        .await
        .unwrap();
    let replay = store.submit_task("operator:alice", &body).await.unwrap();
    assert_eq!(replay.instructions, "Be precise");
    assert_eq!(replay.allowed_actions, ["files:read"]);
    assert_eq!(replay.tag_revision, 1);
    let mut conflicting = body.clone();
    conflicting.prompt = "A different operation".into();
    assert!(matches!(
        store.submit_task("operator:alice", &conflicting).await,
        Err(StoreError::Conflict(_))
    ));

    // Competing hosts cannot both own the same accepted Task.
    let (left, right) = tokio::join!(
        store.claim_task("host:left", "claim-left"),
        store.claim_task("host:right", "claim-right"),
    );
    let (owner, claim_operation, assignment) = match (left.unwrap(), right.unwrap()) {
        (Some(assignment), None) => ("host:left", "claim-left", assignment),
        (None, Some(assignment)) => ("host:right", "claim-right", assignment),
        other => panic!("one claim must win: {other:?}"),
    };
    assert_eq!(assignment.task.as_ref().unwrap().task_id, first.task_id);
    assert_eq!(
        store.claim_task(owner, claim_operation).await.unwrap(),
        Some(assignment.clone())
    );
    let start = StartTaskRequest {
        task_id: first.task_id.clone(),
        attempt_id: assignment.attempt_id.clone(),
        lease_token: assignment.lease_token.clone(),
    };
    assert!(matches!(
        store.start_task("host:intruder", &start).await,
        Err(StoreError::PermissionDenied)
    ));
    let mut forged = start.clone();
    forged.lease_token = "wrong".into();
    assert!(matches!(
        store.start_task(owner, &forged).await,
        Err(StoreError::PermissionDenied)
    ));
    assert_eq!(
        store.start_task(owner, &start).await.unwrap().state,
        TaskState::Running as i32
    );
    assert_eq!(
        store.start_task(owner, &start).await.unwrap().state,
        TaskState::Running as i32
    );

    // Event replay is content checked, ordered, and independently readable.
    let event = AppendEventRequest {
        task_id: first.task_id.clone(),
        attempt_id: start.attempt_id.clone(),
        lease_token: start.lease_token.clone(),
        sequence: 1,
        text: "Inspected patch".into(),
    };
    let accepted = store.append_event(owner, &event).await.unwrap();
    assert_eq!(store.append_event(owner, &event).await.unwrap(), accepted);
    let mut conflict = event.clone();
    conflict.text = "Conflicting replay".into();
    assert!(matches!(
        store.append_event(owner, &conflict).await,
        Err(StoreError::Conflict(_))
    ));
    conflict.sequence = 3;
    assert!(matches!(
        store.append_event(owner, &conflict).await,
        Err(StoreError::FailedPrecondition(_))
    ));
    assert_eq!(
        store.list_events(&first.task_id, 0, 10).await.unwrap(),
        [accepted]
    );

    let finish = FinishTaskRequest {
        task_id: first.task_id.clone(),
        attempt_id: start.attempt_id.clone(),
        lease_token: start.lease_token.clone(),
        result: "Review complete".into(),
        succeeded: true,
        objective_signal: 0,
    };
    let completed = store.finish_task(owner, &finish).await.unwrap();
    assert_eq!(completed.state, TaskState::Succeeded as i32);
    assert_eq!(store.finish_task(owner, &finish).await.unwrap(), completed);
    assert_eq!(store.cancel_task(&first.task_id).await.unwrap(), completed);
    let mut conflicting_result = finish;
    conflicting_result.result = "Another result".into();
    assert!(matches!(
        store.finish_task(owner, &conflicting_result).await,
        Err(StoreError::Conflict(_))
    ));

    // A new request gets the new policy, and cancelling before start prevents execution.
    let second = store
        .submit_task("operator:alice", &request("new-work"))
        .await
        .unwrap();
    assert_eq!(second.instructions, "Changed instructions");
    assert_eq!(second.allowed_actions, ["files:write"]);
    let assignment = store
        .claim_task("host:left", "next-claim")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(assignment.task.as_ref().unwrap().task_id, second.task_id);
    store.cancel_task(&second.task_id).await.unwrap();
    let start = StartTaskRequest {
        task_id: second.task_id.clone(),
        attempt_id: assignment.attempt_id,
        lease_token: assignment.lease_token,
    };
    assert!(matches!(
        store.start_task("host:left", &start).await,
        Err(StoreError::FailedPrecondition(_))
    ));
    assert_eq!(
        store.get_task(&second.task_id).await.unwrap().state,
        TaskState::Cancelled as i32
    );

    // A running cancellation retains Session ownership until the host observes cleanup.
    let running = store
        .submit_task("operator:alice", &request("cleanup-running"))
        .await
        .unwrap();
    let assignment = store
        .claim_task("host:cleanup", "cleanup-claim")
        .await
        .unwrap()
        .unwrap();
    let start = StartTaskRequest {
        task_id: running.task_id.clone(),
        attempt_id: assignment.attempt_id,
        lease_token: assignment.lease_token,
    };
    store.start_task("host:cleanup", &start).await.unwrap();
    let waiting = store
        .submit_task("operator:alice", &request("cleanup-waiting"))
        .await
        .unwrap();
    store.cancel_task(&running.task_id).await.unwrap();
    assert!(
        store
            .claim_task("host:next", "empty-claim")
            .await
            .unwrap()
            .is_none()
    );
    let finish = FinishTaskRequest {
        task_id: running.task_id.clone(),
        attempt_id: start.attempt_id,
        lease_token: start.lease_token,
        result: "late success".into(),
        succeeded: true,
        objective_signal: 0,
    };
    let cancelled = store.finish_task("host:cleanup", &finish).await.unwrap();
    assert_eq!(cancelled.state, TaskState::Cancelled as i32);
    assert!(cancelled.result.is_none());
    assert_eq!(
        store.finish_task("host:cleanup", &finish).await.unwrap(),
        cancelled
    );
    // No receipt is retained for an empty poll; the same ID may claim subsequently.
    let next = store
        .claim_task("host:next", "empty-claim")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(next.task.unwrap().task_id, waiting.task_id);
    store.cancel_task(&waiting.task_id).await.unwrap();

    // Cancellation and completion share a transaction boundary: neither can resurrect the other.
    for n in 0..8 {
        let task = store
            .submit_task("operator:alice", &request(&format!("race-{n}")))
            .await
            .unwrap();
        let assignment = store
            .claim_task("host:racer", &format!("claim-race-{n}"))
            .await
            .unwrap()
            .unwrap();
        let start = StartTaskRequest {
            task_id: task.task_id.clone(),
            attempt_id: assignment.attempt_id,
            lease_token: assignment.lease_token,
        };
        store.start_task("host:racer", &start).await.unwrap();
        let finish = FinishTaskRequest {
            task_id: task.task_id.clone(),
            attempt_id: start.attempt_id,
            lease_token: start.lease_token,
            result: "done".into(),
            succeeded: true,
            objective_signal: 0,
        };
        let (cancel, complete) = tokio::join!(
            store.cancel_task(&task.task_id),
            store.finish_task("host:racer", &finish)
        );
        let final_task = store.get_task(&task.task_id).await.unwrap();
        assert_eq!(cancel.unwrap().state, final_task.state);
        match TaskState::try_from(final_task.state).unwrap() {
            TaskState::Succeeded => assert_eq!(complete.unwrap(), final_task),
            TaskState::Cancelled => {
                assert_eq!(complete.unwrap(), final_task);
                assert!(final_task.result.is_none());
            }
            other => panic!("invalid race result {other:?}"),
        }
    }
}

fn sqlite_url(path: &Path) -> String {
    format!("sqlite://{}?mode=rwc", path.display())
}

#[tokio::test]
async fn sqlite_store_contract_and_reopen() {
    let directory = tempfile::tempdir().unwrap();
    let url = sqlite_url(&directory.path().join("state.db"));
    let store = Store::open(&url).await.unwrap();
    contract(&store).await;
    let accepted = store
        .submit_task("operator:alice", &request("restart"))
        .await
        .unwrap();
    store.close().await;
    let reopened = Store::open(&url).await.unwrap();
    assert_eq!(
        reopened.get_task(&accepted.task_id).await.unwrap(),
        accepted
    );
    assert_eq!(
        reopened
            .submit_task("operator:alice", &request("restart"))
            .await
            .unwrap(),
        accepted
    );
    reopened.close().await;
}

#[tokio::test]
async fn refuses_existing_legacy_sqlite_database() {
    let directory = tempfile::tempdir().unwrap();
    let url = sqlite_url(&directory.path().join("legacy.db"));
    let mut connection = sqlx::SqliteConnection::connect(&url).await.unwrap();
    connection
        .execute("CREATE TABLE Task (id TEXT PRIMARY KEY)")
        .await
        .unwrap();
    connection.close().await.unwrap();
    assert!(Store::open(&url).await.is_err());
}

#[tokio::test]
async fn refuses_unknown_schema_without_modifying_it() {
    let directory = tempfile::tempdir().unwrap();
    let url = sqlite_url(&directory.path().join("future.db"));
    let mut connection = sqlx::SqliteConnection::connect(&url).await.unwrap();
    connection
        .execute("CREATE TABLE supertag_v2_schema (version BIGINT PRIMARY KEY)")
        .await
        .unwrap();
    connection
        .execute("INSERT INTO supertag_v2_schema (version) VALUES (99)")
        .await
        .unwrap();
    assert!(Store::open(&url).await.is_err());
    let versions: Vec<i64> = sqlx::query_scalar("SELECT version FROM supertag_v2_schema")
        .fetch_all(&mut connection)
        .await
        .unwrap();
    assert_eq!(versions, [99]);
    let tables: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sqlite_schema WHERE type = 'table'")
        .fetch_one(&mut connection)
        .await
        .unwrap();
    assert_eq!(tables, 1);
    connection.close().await.unwrap();
}

#[tokio::test]
#[ignore = "requires SUPERTAG_RUST_TEST_POSTGRES_URL_FILE for a dedicated PostgreSQL test server"]
async fn postgres_store_contract_and_reopen() {
    let path = std::env::var_os("SUPERTAG_RUST_TEST_POSTGRES_URL_FILE")
        .expect("PostgreSQL contract requires a dedicated test server URL file");
    let admin_url = std::fs::read_to_string(path).unwrap();
    let mut url = url::Url::parse(admin_url.trim()).unwrap();
    let name = format!("supertag_rust_cp_{}", Uuid::new_v4().simple());
    let mut admin = sqlx::PgConnection::connect(admin_url.trim()).await.unwrap();
    admin
        .execute(format!("CREATE DATABASE {name}").as_str())
        .await
        .unwrap();
    url.set_path(&name);
    let local = tokio::task::LocalSet::new();
    let outcome = local
        .run_until(async move {
            tokio::task::spawn_local(async move {
                let store = Store::open(url.as_str()).await.unwrap();
                contract(&store).await;
                let accepted = store
                    .submit_task("operator:alice", &request("restart"))
                    .await
                    .unwrap();
                store.close().await;
                let reopened = Store::open(url.as_str()).await.unwrap();
                assert_eq!(
                    reopened.get_task(&accepted.task_id).await.unwrap(),
                    accepted
                );
                assert_eq!(
                    reopened
                        .submit_task("operator:alice", &request("restart"))
                        .await
                        .unwrap(),
                    accepted
                );
                reopened.close().await;
            })
            .await
        })
        .await;
    admin
        .execute(format!("DROP DATABASE {name} WITH (FORCE)").as_str())
        .await
        .unwrap();
    admin.close().await.unwrap();
    outcome.expect("PostgreSQL contract task failed");
}
