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
        attempt: Some(attempt),
        operation_id: "capture".into(),
        description: Some(ArtifactDescription {
            title: "Release evidence".into(),
            kind: "report".into(),
            summary: None,
        }),
        native_session_id: Some("native-release-1".into()),
        files: vec![ArtifactFile {
            path: "evidence.txt".into(),
            blob: Some(BlobReference {
                sha256: "a".repeat(64),
                byte_length: 12,
            }),
        }],
    };
    assert!(matches!(
        store.commit_artifact_capture(&host, &capture).await,
        Err(StoreError::FailedPrecondition(_))
    ));
    assert!(matches!(
        store.reserve_artifact_capture(&intruder, &capture).await,
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
    reopened.close().await;
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
