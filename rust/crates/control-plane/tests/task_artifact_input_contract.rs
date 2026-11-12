mod support;

use sha2::{Digest, Sha256};
use sqlx::{Connection, Executor};
use supertag_control_plane::{HostAuthority, Store, StoreError};
use supertag_protocol::v2::*;
use uuid::Uuid;

const OPERATOR: &str = "operator:inputs";
const BASE: &str = "1111111111111111111111111111111111111111";

async fn objective(store: &Store, id: &str) -> Objective {
    store
        .create_objective(
            OPERATOR,
            &CreateObjectiveRequest {
                operation_id: id.into(),
                objective_id: id.into(),
                owner_tag_id: "research".into(),
                outcome: "Provide reviewed evidence".into(),
                ongoing: true,
                ..Default::default()
            },
        )
        .await
        .unwrap()
}

async fn start(store: &Store, host: &HostAuthority, operation: &str) -> InspectAttemptRequest {
    let assignment = store
        .claim_task_with_profile(
            host,
            operation,
            &["repo".into()],
            HarnessKind::Cursor,
            &[],
            Some(&HarnessExecutionProfile {
                task_artifact_inputs: true,
                remote_file_workspace: true,
                ..Default::default()
            }),
        )
        .await
        .unwrap()
        .unwrap();
    let task_id = assignment.task.unwrap().task_id;
    store
        .start_task(
            host,
            &StartTaskRequest {
                task_id: task_id.clone(),
                attempt_id: assignment.attempt_id.clone(),
                lease_token: assignment.lease_token.clone(),
            },
        )
        .await
        .unwrap();
    InspectAttemptRequest {
        task_id,
        attempt_id: assignment.attempt_id,
        lease_token: assignment.lease_token,
    }
}

async fn capture(
    store: &Store,
    host: &HostAuthority,
    attempt: &InspectAttemptRequest,
    operation: &str,
) -> CapturedArtifact {
    let request = CommitArtifactCaptureRequest {
        attempt: Some(attempt.clone()),
        operation_id: operation.into(),
        description: Some(ArtifactDescription {
            title: "Immutable report".into(),
            kind: "research".into(),
            summary: None,
        }),
        files: ["other.txt", "report.txt"]
            .into_iter()
            .map(|path| ArtifactFile {
                path: path.into(),
                blob: Some(BlobReference {
                    sha256: format!("{:x}", Sha256::digest(path.as_bytes())),
                    byte_length: path.len() as u64,
                }),
                git_output: None,
            })
            .collect(),
        ..Default::default()
    };
    store
        .reserve_artifact_capture(host, &request)
        .await
        .unwrap();
    store.commit_artifact_capture(host, &request).await.unwrap()
}

async fn exercise(url: &str) {
    let store = Store::open(url).await.unwrap();
    store
        .put_tag_spec(PutTagRequest {
            tag_id: "research".into(),
            instructions: "Use only admitted files".into(),
            harness_kind: HarnessKind::Cursor.into(),
            allowed_actions: vec!["files:read".into()],
            workspace: Some(WorkspaceSpec {
                workspace_id: "repo".into(),
                base_commit: BASE.into(),
                github_source: None,
            }),
            ..Default::default()
        })
        .await
        .unwrap();
    let host = support::register_host(&store, "input-host").await;
    let destination = objective(&store, "same-objective").await;
    let producer = start(&store, &host, "produce").await;
    assert_eq!(producer.task_id, destination.starting_task_id);
    let submitted = capture(&store, &host, &producer, "submitted").await;
    let submitted_id = submitted.summary.unwrap().artifact_id;
    let capture_only = capture(&store, &host, &producer, "capture-only").await;
    let capture_only_id = capture_only.summary.unwrap().artifact_id;
    let blob = |bytes: &[u8]| BlobReference {
        sha256: format!("{:x}", Sha256::digest(bytes)),
        byte_length: bytes.len() as u64,
    };
    let delivery = WorkspaceDeliveryReference {
        workspace_id: "repo".into(),
        delivery_id: format!(
            "{:x}",
            Sha256::digest(serde_json::to_vec(&(&producer.task_id, &producer.attempt_id)).unwrap())
        ),
        base_commit: BASE.into(),
        start_commit: BASE.into(),
        head_commit: BASE.into(),
        patch: Some(blob(b"")),
        bundle: Some(blob(b"bundle")),
        ..Default::default()
    };
    let upload = WorkspaceDeliveryRequest {
        attempt: Some(producer.clone()),
        delivery: Some(delivery.clone()),
    };
    store
        .reserve_workspace_delivery(&host, &upload)
        .await
        .unwrap();
    store
        .commit_workspace_delivery(&host, &upload)
        .await
        .unwrap();
    store
        .finish_task(
            &host,
            &FinishTaskRequest {
                task_id: producer.task_id.clone(),
                attempt_id: producer.attempt_id.clone(),
                lease_token: producer.lease_token.clone(),
                result: "Reported evidence".into(),
                succeeded: true,
                workspace_delivery: Some(delivery),
                artifacts: vec![ArtifactSelection {
                    artifact_id: submitted_id.clone(),
                    paths: vec!["report.txt".into()],
                }],
                ..Default::default()
            },
        )
        .await
        .unwrap();
    let mut request = SubmitTaskRequest {
        tag_id: "research".into(),
        session_id: destination.session_id.clone(),
        operation_id: "consumer".into(),
        prompt: "Use the pinned report".into(),
        input_artifacts: vec![TaskArtifactInputSelection {
            artifact_id: submitted_id.clone(),
            paths: vec!["other.txt".into()],
            require_accepted: false,
            publication_approval_id: None,
        }],
        ..Default::default()
    };
    assert!(store.submit_task(OPERATOR, &request).await.is_err());
    request.input_artifacts[0].artifact_id = capture_only_id;
    request.input_artifacts[0].paths = vec!["report.txt".into()];
    assert!(store.submit_task(OPERATOR, &request).await.is_err());
    request.input_artifacts[0].artifact_id = submitted_id;
    request.input_artifacts[0].require_accepted = true;
    assert!(store.submit_task(OPERATOR, &request).await.is_err());
    request.input_artifacts[0].require_accepted = false;
    let objective_session = request.session_id.clone();
    request.session_id = "ordinary-session".into();
    assert!(store.submit_task(OPERATOR, &request).await.is_err());
    request.session_id = objective_session;
    let accepted = store.submit_task(OPERATOR, &request).await.unwrap();
    assert_eq!(accepted.input_artifacts.len(), 1);
    let pinned = &accepted.input_artifacts[0];
    assert_eq!(pinned.source_task_id, producer.task_id);
    assert_eq!(pinned.source_attempt_id, producer.attempt_id);
    assert_eq!(pinned.files.len(), 1);
    assert_eq!(pinned.files[0].path, "report.txt");
    assert_eq!(pinned.files[0].blob, submitted.files[1].blob);
    let restarted = Store::open(url).await.unwrap();
    assert_eq!(
        restarted.submit_task(OPERATOR, &request).await.unwrap(),
        accepted
    );
    request.input_artifacts.clear();
    assert!(matches!(
        store.submit_task(OPERATOR, &request).await,
        Err(StoreError::Conflict(_))
    ));
    assert!(
        store
            .claim_task_with_profile(
                &host,
                "host-without-input-capability",
                &["repo".into()],
                HarnessKind::Cursor,
                &[],
                None
            )
            .await
            .unwrap()
            .is_none()
    );
    let consumer = start(&store, &host, "consume").await;
    assert_eq!(consumer.task_id, accepted.task_id);
    let operation = supertag_protocol::task_artifact_inputs::operation_id(&pinned.artifact_id);
    let mut acquire = AcquireArtifactRequest {
        attempt: Some(consumer.clone()),
        operation_id: operation.clone(),
        artifact_id: pinned.artifact_id.clone(),
        paths: vec!["other.txt".into()],
        delivery: ArtifactDelivery::Materialize.into(),
        destination: Some(
            supertag_protocol::artifacts::materialized_artifact_directory(
                &consumer.attempt_id,
                &operation,
            ),
        ),
    };
    let ordinary = AcquireArtifactRequest {
        operation_id: "ordinary-remote-attachment".into(),
        destination: Some(
            supertag_protocol::artifacts::materialized_artifact_directory(
                &consumer.attempt_id,
                "ordinary-remote-attachment",
            ),
        ),
        paths: vec!["report.txt".into()],
        ..acquire.clone()
    };
    assert!(matches!(
        store.acquire_artifact(&host, &ordinary).await,
        Err(StoreError::PermissionDenied)
    ));
    assert!(store.acquire_artifact(&host, &acquire).await.is_err());
    acquire.paths = vec!["report.txt".into()];
    let receipt = store.acquire_artifact(&host, &acquire).await.unwrap();
    assert_eq!(receipt.files, vec![submitted.files[1].clone()]);
    assert_eq!(
        store.acquire_artifact(&host, &acquire).await.unwrap(),
        receipt
    );

    let foreign = objective(&store, "other-objective").await;
    request.operation_id = "foreign-consumer".into();
    request.session_id = foreign.session_id;
    request.input_artifacts = vec![TaskArtifactInputSelection {
        artifact_id: pinned.artifact_id.clone(),
        paths: vec!["report.txt".into()],
        require_accepted: false,
        publication_approval_id: None,
    }];
    assert!(store.submit_task(OPERATOR, &request).await.is_err());
}

#[tokio::test]
async fn sqlite_task_artifact_inputs() {
    let directory = tempfile::tempdir().unwrap();
    let url = format!(
        "sqlite://{}?mode=rwc",
        directory.path().join("test.db").display()
    );
    Box::pin(exercise(&url)).await;
}

#[tokio::test]
#[ignore = "requires SUPERTAG_RUST_TEST_POSTGRES_URL_FILE"]
async fn postgres_task_artifact_inputs() {
    let file =
        std::env::var_os("SUPERTAG_RUST_TEST_POSTGRES_URL_FILE").expect("test database file");
    let admin_url = std::fs::read_to_string(file).unwrap();
    let mut url = url::Url::parse(admin_url.trim()).unwrap();
    let database = format!("supertag_inputs_{}", Uuid::new_v4().simple());
    let mut admin = sqlx::PgConnection::connect(admin_url.trim()).await.unwrap();
    admin
        .execute(format!("CREATE DATABASE {database}").as_str())
        .await
        .unwrap();
    url.set_path(&database);
    let result = tokio::task::LocalSet::new()
        .run_until(async move {
            tokio::task::spawn_local(Box::pin(async move { exercise(url.as_str()).await })).await
        })
        .await;
    admin
        .execute(format!("DROP DATABASE {database} WITH (FORCE)").as_str())
        .await
        .unwrap();
    result.unwrap();
}
