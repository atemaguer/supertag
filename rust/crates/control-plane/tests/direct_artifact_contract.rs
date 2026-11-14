mod support;
use sqlx::{Connection, Executor};
use supertag_control_plane::{HostAuthority, Store};
use supertag_protocol::v2::*;
use uuid::Uuid;
const OP: &str = "operator:artifact-reader";
use sha2::{Digest, Sha256};
use std::sync::{
    Arc,
    atomic::{AtomicI64, Ordering},
};

async fn message(store: &Store, operator: &str, conversation: &str, operation: &str) -> Task {
    store
        .send_message(
            operator,
            &SendMessageRequest {
                tag_id: "writer".into(),
                conversation: conversation.into(),
                text: "Use evidence".into(),
                operation_id: operation.into(),
                ..Default::default()
            },
        )
        .await
        .unwrap()
        .task
        .unwrap()
}
async fn claim(store: &Store, host: &HostAuthority, operation: &str) -> InspectAttemptRequest {
    let assignment = store.claim_task(host, operation).await.unwrap().unwrap();
    let attempt = InspectAttemptRequest {
        task_id: assignment.task.unwrap().task_id,
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
    attempt
}
async fn finish(store: &Store, host: &HostAuthority, attempt: &InspectAttemptRequest) {
    store
        .finish_task(
            host,
            &FinishTaskRequest {
                task_id: attempt.task_id.clone(),
                attempt_id: attempt.attempt_id.clone(),
                lease_token: attempt.lease_token.clone(),
                succeeded: true,
                result: "Recorded evidence".into(),
                ..Default::default()
            },
        )
        .await
        .unwrap();
}
fn capture(attempt: &InspectAttemptRequest, operation: &str) -> CommitArtifactCaptureRequest {
    CommitArtifactCaptureRequest {
        attempt: Some(attempt.clone()),
        operation_id: operation.into(),
        description: Some(ArtifactDescription {
            title: "Evidence".into(),
            kind: "report".into(),
            summary: Some("Bounded test evidence".into()),
        }),
        files: vec![
            ArtifactFile {
                git_output: None,
                path: "readme.txt".into(),
                blob: Some(BlobReference {
                    sha256: "a".repeat(64),
                    byte_length: 10,
                }),
            },
            ArtifactFile {
                git_output: None,
                path: "private.txt".into(),
                blob: Some(BlobReference {
                    sha256: "b".repeat(64),
                    byte_length: 20,
                }),
            },
        ],
        ..Default::default()
    }
}
async fn commit(
    store: &Store,
    host: &HostAuthority,
    input: &CommitArtifactCaptureRequest,
) -> CapturedArtifact {
    store.reserve_artifact_capture(host, input).await.unwrap();
    store.commit_artifact_capture(host, input).await.unwrap()
}
async fn exercise(url: &str) {
    let clock = Arc::new(AtomicI64::new(1_000_000));
    let time = clock.clone();
    let store = Store::open(url)
        .await
        .unwrap()
        .with_execution_clock(move || time.load(Ordering::SeqCst));
    store
        .put_tag("writer", "Exact scoped evidence", vec!["files:read".into()])
        .await
        .unwrap();
    let source = support::register_host(&store, "direct-producer").await;
    let reader = support::register_host(&store, "direct-consumer").await;
    let storage = RegisterArtifactSourceRequest {
        storage_id: Uuid::new_v4().to_string(),
    };
    assert_eq!(
        store
            .register_artifact_source(&source, &storage)
            .await
            .unwrap()
            .storage_id,
        storage.storage_id
    );
    let wrong_storage = RegisterArtifactSourceRequest {
        storage_id: Uuid::new_v4().to_string(),
    };
    assert!(
        store
            .register_artifact_source(&source, &wrong_storage)
            .await
            .is_err()
    );
    let producing = message(&store, OP, "direct-artifacts", "direct-produce").await;
    let attempt = claim(&store, &source, "direct-produce").await;
    assert_eq!(attempt.task_id, producing.task_id);
    let mut request = capture(&attempt, "direct-capture");
    request.source_storage_id = Some(wrong_storage.storage_id.clone());
    assert!(
        store
            .reserve_artifact_capture(&source, &request)
            .await
            .is_err()
    );
    request.source_storage_id = Some(storage.storage_id.clone());
    let capture = commit(&store, &source, &request).await;
    assert_eq!(
        store
            .commit_artifact_capture(&source, &request)
            .await
            .unwrap(),
        capture
    );
    finish(&store, &source, &attempt).await;
    let id = capture.summary.as_ref().unwrap().artifact_id.clone();

    let consuming = message(&store, OP, "direct-artifacts", "direct-consume").await;
    let consumer = claim(&store, &reader, "direct-consume").await;
    assert_eq!(consuming.task_id, consumer.task_id);
    let acquisition = store
        .acquire_artifact(
            &reader,
            &AcquireArtifactRequest {
                attempt: Some(consumer.clone()),
                artifact_id: id.clone(),
                operation_id: "direct-selection".into(),
                paths: vec!["readme.txt".into()],
                delivery: ArtifactDelivery::Read.into(),
                destination: None,
            },
        )
        .await
        .unwrap();
    let mut selected = GetAcquiredArtifactFileRequest {
        attempt: Some(consumer),
        acquisition_id: acquisition.acquisition_id,
        path: "private.txt".into(),
    };
    assert!(
        store
            .issue_artifact_transfer(&reader, &selected)
            .await
            .is_err()
    );
    selected.path = "readme.txt".into();
    assert!(
        store
            .issue_artifact_transfer(&source, &selected)
            .await
            .is_err()
    );
    let grant = store
        .issue_artifact_transfer(&reader, &selected)
        .await
        .unwrap();
    assert_eq!(grant.source_host_id, "direct-producer");
    assert_eq!(grant.file.as_ref(), acquisition.files.first());
    assert_eq!(grant.valid_for_ms, 10_000);
    let mut redemption = AuthorizeArtifactTransferRequest {
        token: grant.token.clone(),
        file: Some(WorkerArtifactDownloadRequest {
            artifact_id: id,
            path: selected.path.clone(),
            blob: grant.file.as_ref().unwrap().blob.clone(),
        }),
    };
    let initial = store
        .authorize_artifact_transfer(&source, &redemption)
        .await
        .unwrap();
    assert_eq!(initial.producer_attempt_id, attempt.attempt_id);
    assert_eq!(initial.file, grant.file);
    assert!(
        store
            .authorize_artifact_transfer(&reader, &redemption)
            .await
            .is_err()
    );
    redemption
        .file
        .as_mut()
        .unwrap()
        .blob
        .as_mut()
        .unwrap()
        .byte_length += 1;
    assert!(
        store
            .authorize_artifact_transfer(&source, &redemption)
            .await
            .is_err()
    );
    redemption
        .file
        .as_mut()
        .unwrap()
        .blob
        .as_mut()
        .unwrap()
        .byte_length -= 1;

    let token_digest = Sha256::digest(grant.token.as_bytes()).to_vec();
    let mut raw = sqlx::AnyConnection::connect(url).await.unwrap();
    let persisted: Vec<u8> = sqlx::query_scalar(
        "SELECT token_digest FROM supertag_v2_artifact_transfer_grants WHERE consumer_host_id='direct-consumer'",
    ).fetch_one(&mut raw).await.unwrap();
    assert_eq!(persisted, token_digest);
    raw.close().await.unwrap();

    // A new generation must present the same retained storage identity.
    let host = store
        .register_host("direct-producer", "replacement-incarnation")
        .await
        .unwrap();
    let replacement = HostAuthority::new("host:direct-producer", host.generation).unwrap();
    assert!(
        store
            .authorize_artifact_transfer(&source, &redemption)
            .await
            .is_err()
    );
    assert!(
        store
            .issue_artifact_transfer(&reader, &selected)
            .await
            .is_err()
    );
    store
        .register_artifact_source(&replacement, &storage)
        .await
        .unwrap();
    assert!(
        store
            .authorize_artifact_transfer(&replacement, &redemption)
            .await
            .is_err()
    );
    let renewed = store
        .issue_artifact_transfer(&reader, &selected)
        .await
        .unwrap();
    redemption.token = renewed.token;
    assert!(
        store
            .authorize_artifact_transfer(&replacement, &redemption)
            .await
            .is_ok()
    );
    clock.fetch_add(10_000, Ordering::SeqCst);
    assert!(
        store
            .authorize_artifact_transfer(&replacement, &redemption)
            .await
            .is_err()
    );
    let final_grant = store
        .issue_artifact_transfer(&reader, &selected)
        .await
        .unwrap();
    redemption.token = final_grant.token;
    store.revoke_host("direct-consumer").await.unwrap();
    assert!(
        store
            .authorize_artifact_transfer(&replacement, &redemption)
            .await
            .is_err()
    );
}

#[tokio::test]
async fn sqlite_direct_artifact_authority() {
    let directory = tempfile::tempdir().unwrap();
    exercise(&format!(
        "sqlite://{}?mode=rwc",
        directory.path().join("state.db").display()
    ))
    .await;
}

#[tokio::test]
#[ignore = "requires dedicated PostgreSQL server"]
async fn postgres_direct_artifact_authority() {
    let base =
        std::fs::read_to_string(std::env::var_os("SUPERTAG_RUST_TEST_POSTGRES_URL_FILE").unwrap())
            .unwrap();
    let mut url = url::Url::parse(base.trim()).unwrap();
    let database = format!("supertag_direct_artifact_{}", Uuid::new_v4().simple());
    let mut admin = sqlx::PgConnection::connect(base.trim()).await.unwrap();
    admin
        .execute(format!("CREATE DATABASE {database}").as_str())
        .await
        .unwrap();
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
