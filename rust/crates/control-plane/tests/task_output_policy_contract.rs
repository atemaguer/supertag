mod support;

use sha2::{Digest, Sha256};
use sqlx::{Connection, Executor};
use supertag_control_plane::{Store, StoreError};
use supertag_protocol::v2::*;
use uuid::Uuid;

const OPERATOR: &str = "operator:output-policy";
const BASE: &str = "1111111111111111111111111111111111111111";

async fn exercise(url: &str) {
    let store = Store::open(url).await.unwrap();
    store
        .put_tag_spec(PutTagRequest {
            tag_id: "reporter".into(),
            instructions: "Preserve the report".into(),
            allowed_actions: vec!["files:read".into()],
            workspace: Some(WorkspaceSpec {
                workspace_id: "project".into(),
                base_commit: BASE.into(),
                github_source: None,
            }),
            harness_kind: HarnessKind::ClaudeCode.into(),
            ..Default::default()
        })
        .await
        .unwrap();
    let mut request = SubmitTaskRequest {
        tag_id: "reporter".into(),
        session_id: "reports".into(),
        operation_id: "report".into(),
        prompt: "Read and preserve the approved report".into(),
        output_policy: Some(TaskOutputPolicy {
            required: vec!["reports/**/*.md".into(), "reports/**/*.md".into()],
            exclude: vec!["reports/private/**".into()],
            max_bytes: Some(32),
            ..Default::default()
        }),
        ..Default::default()
    };
    let task = store.submit_task(OPERATOR, &request).await.unwrap();
    let policy = task.output_policy.as_ref().unwrap();
    assert_eq!(policy.required, ["reports/**/*.md"]);
    request.output_policy = Some(policy.clone());
    assert_eq!(store.submit_task(OPERATOR, &request).await.unwrap(), task);
    request.output_policy.as_mut().unwrap().max_bytes = Some(64);
    assert!(matches!(
        store.submit_task(OPERATOR, &request).await,
        Err(StoreError::Conflict(_))
    ));
    let host = support::register_host(&store, "local").await;
    assert!(
        store
            .claim_task_with_profile(
                &host,
                "without-policy-capability",
                &["project".into()],
                HarnessKind::ClaudeCode,
                &[],
                None,
            )
            .await
            .unwrap()
            .is_none()
    );
    let assignment = store
        .claim_task_with_profile(
            &host,
            "with-policy-capability",
            &["project".into()],
            HarnessKind::ClaudeCode,
            &[],
            Some(&HarnessExecutionProfile {
                declared_task_outputs: true,
                ..Default::default()
            }),
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(assignment.task.unwrap().output_policy, task.output_policy);
    let attempt = InspectAttemptRequest {
        task_id: task.task_id.clone(),
        attempt_id: assignment.attempt_id,
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
    let blob = |bytes: &[u8]| BlobReference {
        sha256: format!("{:x}", Sha256::digest(bytes)),
        byte_length: bytes.len() as u64,
    };
    let delivery = WorkspaceDeliveryReference {
        workspace_id: "project".into(),
        delivery_id: format!(
            "{:x}",
            Sha256::digest(serde_json::to_vec(&(&attempt.task_id, &attempt.attempt_id)).unwrap())
        ),
        base_commit: BASE.into(),
        start_commit: BASE.into(),
        head_commit: BASE.into(),
        patch: Some(blob(b"")),
        bundle: Some(blob(b"fixture")),
        ..Default::default()
    };
    let upload = WorkspaceDeliveryRequest {
        attempt: Some(attempt.clone()),
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
    let mut finish = FinishTaskRequest {
        task_id: attempt.task_id.clone(),
        attempt_id: attempt.attempt_id.clone(),
        lease_token: attempt.lease_token.clone(),
        succeeded: true,
        workspace_delivery: Some(delivery),
        ..Default::default()
    };
    assert!(matches!(
        store.finish_task(&host, &finish).await,
        Err(StoreError::InvalidArgument(_))
    ));
    let mut capture = CommitArtifactCaptureRequest {
        attempt: Some(attempt),
        operation_id: "output".into(),
        description: Some(ArtifactDescription {
            title: "Report".into(),
            kind: "task-output".into(),
            summary: None,
        }),
        files: vec![ArtifactFile {
            git_output: None,
            path: "reports/private/report.md".into(),
            blob: Some(blob(b"report")),
        }],
        declared_task_output: true,
        ..Default::default()
    };
    assert!(matches!(
        store.reserve_artifact_capture(&host, &capture).await,
        Err(StoreError::InvalidArgument(_))
    ));
    let forged_snapshot = GitOutputSnapshot {
        start_commit: "2".repeat(40),
        head_commit: BASE.into(),
        remote: Some("https://example.invalid/reports.git".into()),
        tracked_paths: vec!["reports/report.md".into()],
        deleted_paths: vec![],
        referenced_paths: vec!["reports/report.md".into()],
    };
    let manifest = supertag_protocol::git_outputs::render(&forged_snapshot).unwrap();
    let mut forged_capture = capture.clone();
    forged_capture.operation_id = "forged-output".into();
    forged_capture.files = vec![ArtifactFile {
        path: supertag_protocol::git_outputs::MANIFEST_PATH.into(),
        blob: Some(blob(&manifest)),
        git_output: Some(forged_snapshot),
    }];
    assert!(matches!(
        store.reserve_artifact_capture(&host, &forged_capture).await,
        Err(StoreError::FailedPrecondition(error)) if error.contains("accepted Workspace start")
    ));
    capture.files[0].path = "reports/report.md".into();
    store
        .reserve_artifact_capture(&host, &capture)
        .await
        .unwrap();
    let committed = store
        .commit_artifact_capture(&host, &capture)
        .await
        .unwrap();
    finish.artifacts.push(ArtifactSelection {
        artifact_id: committed.summary.unwrap().artifact_id,
        paths: vec!["reports/report.md".into()],
    });
    let finished = store.finish_task(&host, &finish).await.unwrap();
    assert_eq!(finished.artifacts, finish.artifacts);
    assert_eq!(finished.state(), TaskState::Succeeded);
    store.close().await;
    let reopened = Store::open(url).await.unwrap();
    assert_eq!(reopened.get_task(&task.task_id).await.unwrap(), finished);
    reopened.close().await;
}

#[tokio::test]
async fn sqlite_declared_outputs() {
    let directory = tempfile::tempdir().unwrap();
    exercise(&format!(
        "sqlite://{}?mode=rwc",
        directory.path().join("outputs.db").display()
    ))
    .await;
}

#[tokio::test]
#[ignore = "requires SUPERTAG_RUST_TEST_POSTGRES_URL_FILE"]
async fn postgres_declared_outputs() {
    let file =
        std::env::var_os("SUPERTAG_RUST_TEST_POSTGRES_URL_FILE").expect("test database file");
    let admin_url = std::fs::read_to_string(file).unwrap();
    let mut url = url::Url::parse(admin_url.trim()).unwrap();
    let database = format!("supertag_outputs_{}", Uuid::new_v4().simple());
    let mut admin = sqlx::PgConnection::connect(admin_url.trim()).await.unwrap();
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
