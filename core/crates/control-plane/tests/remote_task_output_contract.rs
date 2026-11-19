//! A Task Attempt whose Workspace runs in a remote (E2B, Modal, or an operator's own) sandbox
//! keeps the files it leaves in its Task output directory, for Claude Code as for Cursor: the
//! Worker Host commits them as the managed Task output.
mod support;

use sqlx::{Connection, Executor};
use supertag_control_plane::{HostAuthority, Store, StoreError};
use supertag_protocol::v2::*;
use uuid::Uuid;

const OPERATOR: &str = "operator:outputs";
const BASE: &str = "1111111111111111111111111111111111111111";

async fn tag(store: &Store, tag: &str, harness: HarnessKind) {
    store
        .put_tag_spec(PutTagRequest {
            tag_id: tag.into(),
            instructions: "Write the report".into(),
            harness_kind: harness.into(),
            allowed_actions: vec!["files:read".into(), "files:write".into()],
            workspace: Some(WorkspaceSpec {
                workspace_id: "repo".into(),
                base_commit: BASE.into(),
                ..Default::default()
            }),
            ..Default::default()
        })
        .await
        .unwrap();
}

/// Submits a Task to `tag` and runs it on `host`'s remote lane for `harness`.
async fn remote_attempt(
    store: &Store,
    host: &HostAuthority,
    tag: &str,
    harness: HarnessKind,
) -> InspectAttemptRequest {
    store
        .submit_task(
            OPERATOR,
            &SubmitTaskRequest {
                tag_id: tag.into(),
                session_id: format!("report-{tag}"),
                operation_id: format!("submit-{tag}"),
                prompt: "Write the report".into(),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    let assignment = store
        .claim_task_with_profile(
            host,
            &format!("claim-{tag}"),
            &["repo".into()],
            harness,
            &[],
            Some(&HarnessExecutionProfile {
                remote_file_workspace: true,
                declared_task_outputs: true,
                ..Default::default()
            }),
        )
        .await
        .unwrap()
        .expect("the remote lane claims its harness's Task");
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

fn output(attempt: &InspectAttemptRequest) -> CommitArtifactCaptureRequest {
    CommitArtifactCaptureRequest {
        source_storage_id: Some(support::ARTIFACT_STORAGE.into()),
        operation_id: format!("output-{}", attempt.attempt_id),
        description: Some(ArtifactDescription {
            title: "Task output".into(),
            kind: "task-output".into(),
            summary: None,
        }),
        managed_task_output: true,
        files: vec![ArtifactFile {
            path: format!(
                "{}/report.md",
                supertag_protocol::artifacts::managed_output_directory(&attempt.attempt_id)
            ),
            blob: Some(BlobReference {
                sha256: "b".repeat(64),
                byte_length: 9,
            }),
            git_output: None,
        }],
        ..Default::default()
    }
}

async fn exercise(url: &str) {
    let store = Store::open(url).await.unwrap();
    let host = support::register_host(&store, "remote-host").await;
    support::hold_artifacts(&store, &host).await;
    for (name, harness) in [
        ("cursor", HarnessKind::Cursor),
        ("claude", HarnessKind::ClaudeCode),
    ] {
        tag(&store, name, harness).await;
        let attempt = remote_attempt(&store, &host, name, harness).await;
        let request = output(&attempt);
        store
            .reserve_artifact_capture(
                &supertag_control_plane::AttemptAccess::new(&host, &attempt),
                &request,
            )
            .await
            .unwrap_or_else(|error| panic!("{name} reserves its Task output: {error:?}"));
        let committed = store
            .commit_artifact_capture(
                &supertag_control_plane::AttemptAccess::new(&host, &attempt),
                &request,
            )
            .await
            .unwrap_or_else(|error| panic!("{name} commits its Task output: {error:?}"));
        assert_eq!(
            committed.summary.unwrap().producer.unwrap().task_id,
            attempt.task_id
        );
        // A path outside the Task output directory is still refused.
        let mut stray = output(&attempt);
        stray.operation_id = format!("stray-{}", attempt.attempt_id);
        stray.files[0].path = "report.md".into();
        assert!(matches!(
            store
                .reserve_artifact_capture(
                    &supertag_control_plane::AttemptAccess::new(&host, &attempt),
                    &stray
                )
                .await,
            Err(StoreError::InvalidArgument(_))
        ));
    }
}

#[tokio::test]
async fn sqlite_remote_task_output() {
    let dir = tempfile::tempdir().unwrap();
    exercise(&format!(
        "sqlite://{}?mode=rwc",
        dir.path().join("outputs.db").display()
    ))
    .await;
}

#[tokio::test]
#[ignore = "requires SUPERTAG_RUST_TEST_POSTGRES_URL_FILE for a dedicated PostgreSQL test server"]
async fn postgres_remote_task_output() {
    let path =
        std::env::var_os("SUPERTAG_RUST_TEST_POSTGRES_URL_FILE").expect("test database file");
    let admin_url = std::fs::read_to_string(path).unwrap();
    let database = format!("supertag_remote_output_{}", Uuid::new_v4().simple());
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
