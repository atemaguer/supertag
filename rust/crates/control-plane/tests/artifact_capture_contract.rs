mod support;

use sqlx::{Connection, Executor};
use supertag_control_plane::{Store, StoreError};
use supertag_protocol::v2::*;
use uuid::Uuid;

const PRODUCER: &str = "operator:alice";
const OTHER: &str = "operator:bob";

async fn exercise(url: &str) {
    let store = Store::open(url).await.unwrap();
    store
        .put_tag("release", "Record evidence", vec!["files:read".into()])
        .await
        .unwrap();
    let task = store
        .send_message(
            PRODUCER,
            &SendMessageRequest {
                tag_id: "release".into(),
                conversation: "release".into(),
                text: "Capture the report".into(),
                operation_id: "message".into(),
                ..Default::default()
            },
        )
        .await
        .unwrap()
        .task
        .unwrap();
    let host = support::register_host(&store, "producer").await;
    let intruder = support::register_host(&store, "intruder").await;
    let assignment = store.claim_task(&host, "claim").await.unwrap().unwrap();
    let attempt = InspectAttemptRequest {
        task_id: task.task_id.clone(),
        attempt_id: assignment.attempt_id.clone(),
        lease_token: assignment.lease_token,
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
    let capture = CommitArtifactCaptureRequest {
        declared_task_output: false,
        attempt: Some(attempt),
        operation_id: "capture".into(),
        description: Some(ArtifactDescription {
            title: "Release evidence".into(),
            kind: "report".into(),
            summary: None,
        }),
        native_session_id: Some("native-release-1".into()),
        managed_task_output: false,
        files: vec![ArtifactFile {
            git_output: None,
            path: "evidence.txt".into(),
            blob: Some(BlobReference {
                sha256: "a".repeat(64),
                byte_length: 12,
            }),
        }],
        source_storage_id: None,
    };
    assert!(matches!(
        store.commit_artifact_capture(&host, &capture).await,
        Err(StoreError::FailedPrecondition(_))
    ));
    assert!(matches!(
        store.reserve_artifact_capture(&intruder, &capture).await,
        Err(StoreError::PermissionDenied)
    ));
    let mut managed = capture.clone();
    managed.managed_task_output = true;
    assert!(matches!(
        store.reserve_artifact_capture(&host, &managed).await,
        Err(StoreError::InvalidArgument(_))
    ));
    managed.files[0].path = format!(
        "{}/evidence.txt",
        supertag_protocol::artifacts::managed_output_directory(&assignment.attempt_id)
    );
    assert!(matches!(
        store.reserve_artifact_capture(&host, &managed).await,
        Err(StoreError::PermissionDenied)
    ));
    let (one, two) = tokio::join!(
        store.reserve_artifact_capture(&host, &capture),
        store.reserve_artifact_capture(&host, &capture)
    );
    let reservation = one.unwrap();
    assert_eq!(two.unwrap(), reservation);
    let summary = reservation.summary.as_ref().unwrap();
    let producer = summary.producer.as_ref().unwrap();
    assert_eq!(producer.task_id, task.task_id);
    assert_eq!(producer.tag_id, task.tag_id);
    assert_eq!(producer.session_id, task.session_id);
    assert_eq!(producer.attempt_id, assignment.attempt_id);
    assert_eq!(producer.native_session_id, capture.native_session_id);
    assert!(matches!(
        store
            .get_captured_artifact(PRODUCER, &summary.artifact_id)
            .await,
        Err(StoreError::NotFound(_))
    ));
    let list = ListCapturedArtifactsRequest {
        task_id: task.task_id.clone(),
        limit: 1,
        before_order: 0,
    };
    assert!(
        store
            .list_captured_artifacts(PRODUCER, &list)
            .await
            .unwrap()
            .artifacts
            .is_empty()
    );
    assert_eq!(
        store
            .commit_artifact_capture(&host, &capture)
            .await
            .unwrap(),
        reservation
    );
    assert!(matches!(
        store
            .get_captured_artifact(OTHER, &summary.artifact_id)
            .await,
        Err(StoreError::NotFound(_))
    ));
    assert!(matches!(
        store.list_captured_artifacts(OTHER, &list).await,
        Err(StoreError::NotFound(_))
    ));
    assert_eq!(
        store
            .list_captured_artifacts(PRODUCER, &list)
            .await
            .unwrap()
            .artifacts
            .as_slice(),
        std::slice::from_ref(summary)
    );
    let mut changed = capture.clone();
    changed.description.as_mut().unwrap().title = "Different evidence".into();
    assert!(matches!(
        store.commit_artifact_capture(&host, &changed).await,
        Err(StoreError::Conflict(_))
    ));
    store.cancel_task(&task.task_id).await.unwrap();
    assert_eq!(
        store
            .commit_artifact_capture(&host, &capture)
            .await
            .unwrap(),
        reservation
    );
    let late = CommitArtifactCaptureRequest {
        operation_id: "late".into(),
        ..capture
    };
    assert!(matches!(
        store.reserve_artifact_capture(&host, &late).await,
        Err(StoreError::FailedPrecondition(_))
    ));
    store.close().await;
    let reopened = Store::open(url).await.unwrap();
    assert_eq!(
        reopened
            .get_captured_artifact(PRODUCER, &summary.artifact_id)
            .await
            .unwrap(),
        reservation
    );
    submission(&reopened, &host, &summary.artifact_id).await;
    reopened.close().await;
    let reopened = Store::open(url).await.unwrap();
    let submitted = reopened
        .list_messages(
            PRODUCER,
            &ListMessagesRequest {
                tag_id: "release".into(),
                conversation: "submitted-report".into(),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    let result = submitted.messages[0].task.as_ref().unwrap();
    assert_eq!(result.artifacts.len(), 1);
    assert_eq!(result.artifacts[0].paths, ["deliverable.txt"]);
    reopened.close().await;
}

async fn submission(store: &Store, host: &supertag_control_plane::HostAuthority, other_id: &str) {
    let task = store
        .send_message(
            PRODUCER,
            &SendMessageRequest {
                tag_id: "release".into(),
                conversation: "submitted-report".into(),
                text: "Submit the verified deliverable".into(),
                operation_id: "submit-report".into(),
                ..Default::default()
            },
        )
        .await
        .unwrap()
        .task
        .unwrap();
    let assignment = store
        .claim_task(host, "submit-claim")
        .await
        .unwrap()
        .unwrap();
    let attempt = InspectAttemptRequest {
        task_id: task.task_id,
        attempt_id: assignment.attempt_id,
        lease_token: assignment.lease_token,
    };
    store
        .start_task(
            host,
            &StartTaskRequest {
                task_id: attempt.task_id.clone(),
                attempt_id: attempt.attempt_id.clone(),
                lease_token: attempt.lease_token.clone(),
            },
        )
        .await
        .unwrap();
    let capture = CommitArtifactCaptureRequest {
        attempt: Some(attempt.clone()),
        operation_id: "deliverable".into(),
        description: Some(ArtifactDescription {
            title: "Release deliverable".into(),
            kind: "report".into(),
            summary: None,
        }),
        files: vec![ArtifactFile {
            git_output: None,
            path: "deliverable.txt".into(),
            blob: Some(BlobReference {
                sha256: "a".repeat(64),
                byte_length: 12,
            }),
        }],
        ..Default::default()
    };
    let reserved = store
        .reserve_artifact_capture(host, &capture)
        .await
        .unwrap();
    let artifact_id = reserved.summary.unwrap().artifact_id;
    let mut finish = FinishTaskRequest {
        task_id: attempt.task_id,
        attempt_id: attempt.attempt_id,
        lease_token: attempt.lease_token,
        result: "Verified result".into(),
        succeeded: true,
        artifacts: vec![ArtifactSelection {
            artifact_id: other_id.into(),
            paths: vec!["evidence.txt".into()],
        }],
        ..Default::default()
    };
    assert!(store.finish_task(host, &finish).await.is_err());
    finish.artifacts[0].artifact_id = artifact_id;
    finish.artifacts[0].paths = vec!["deliverable.txt".into()];
    assert!(store.finish_task(host, &finish).await.is_err());
    store.commit_artifact_capture(host, &capture).await.unwrap();
    finish.artifacts[0].paths = vec!["missing.txt".into()];
    assert!(store.finish_task(host, &finish).await.is_err());
    assert_eq!(
        store.get_task(&finish.task_id).await.unwrap().state(),
        TaskState::Running
    );
    finish.artifacts[0].paths = vec!["deliverable.txt".into()];
    let result = store.finish_task(host, &finish).await.unwrap();
    assert_eq!(result.artifacts, finish.artifacts);
    assert_eq!(store.finish_task(host, &finish).await.unwrap(), result);
    finish.artifacts.clear();
    assert!(matches!(
        store.finish_task(host, &finish).await,
        Err(StoreError::Conflict(_))
    ));
}

#[tokio::test]
async fn sqlite_artifact_capture() {
    let dir = tempfile::tempdir().unwrap();
    exercise(&format!(
        "sqlite://{}?mode=rwc",
        dir.path().join("artifacts.db").display()
    ))
    .await;
}

#[tokio::test]
#[ignore = "requires SUPERTAG_RUST_TEST_POSTGRES_URL_FILE for a dedicated PostgreSQL test server"]
async fn postgres_artifact_capture() {
    let path =
        std::env::var_os("SUPERTAG_RUST_TEST_POSTGRES_URL_FILE").expect("test database file");
    let admin_url = std::fs::read_to_string(path).unwrap();
    let database = format!("supertag_artifact_capture_{}", Uuid::new_v4().simple());
    let mut admin = sqlx::PgConnection::connect(admin_url.trim()).await.unwrap();
    admin
        .execute(format!("CREATE DATABASE {database}").as_str())
        .await
        .unwrap();
    let mut url = url::Url::parse(admin_url.trim()).unwrap();
    url.set_path(&database);
    let result = tokio::task::LocalSet::new()
        .run_until(async move {
            tokio::task::spawn_local(async move { exercise(url.as_str()).await }).await
        })
        .await;
    admin
        .execute(format!("DROP DATABASE {database} WITH (FORCE)").as_str())
        .await
        .unwrap();
    result.unwrap();
}
