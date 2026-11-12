mod support;

use sha2::{Digest, Sha256};
use sqlx::{Connection, Executor};
use supertag_control_plane::{HostAuthority, Store, StoreError};
use supertag_protocol::v2::*;
use uuid::Uuid;

const OPERATOR: &str = "operator:workspace-test";
const REPOSITORY: &str = "project";
const BASE: &str = "1111111111111111111111111111111111111111";
const HEAD: &str = "2222222222222222222222222222222222222222";

async fn submit(store: &Store, session_id: &str) -> Result<Task, StoreError> {
    store
        .submit_task(
            OPERATOR,
            &SubmitTaskRequest {
                execution_limits: None,
                tag_id: "engineer".into(),
                session_id: session_id.into(),
                operation_id: Uuid::new_v4().to_string(),
                prompt: "Review the repository".into(),
            },
        )
        .await
}

async fn claim(
    store: &Store,
    host: &HostAuthority,
    operation: &str,
    expected_task: &str,
) -> InspectAttemptRequest {
    let assignment = store
        .claim_task_with_workspaces(host, operation, &[REPOSITORY.into()])
        .await
        .unwrap()
        .unwrap();
    assert_eq!(assignment.task.unwrap().task_id, expected_task);
    let attempt = InspectAttemptRequest {
        task_id: expected_task.into(),
        attempt_id: assignment.attempt_id,
        lease_token: assignment.lease_token,
    };
    assert!(matches!(
        store.get_workspace_continuation(host, &attempt).await,
        Err(StoreError::FailedPrecondition(_))
    ));
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

fn delivery(attempt: &InspectAttemptRequest, start: &str, head: &str) -> WorkspaceDeliveryRequest {
    let changed = start != head;
    let patch: &[u8] = if changed { b"fixture patch" } else { b"" };
    let bundle = format!("fixture bundle {head}");
    let blob = |bytes: &[u8]| BlobReference {
        sha256: format!("{:x}", Sha256::digest(bytes)),
        byte_length: bytes.len() as u64,
    };
    WorkspaceDeliveryRequest {
        attempt: Some(attempt.clone()),
        delivery: Some(WorkspaceDeliveryReference {
            workspace_id: REPOSITORY.into(),
            delivery_id: format!(
                "{:x}",
                Sha256::digest(
                    serde_json::to_vec(&(&attempt.task_id, &attempt.attempt_id)).unwrap()
                )
            ),
            base_commit: BASE.into(),
            start_commit: start.into(),
            head_commit: head.into(),
            committed: changed,
            changed_files: u64::from(changed),
            patch: Some(blob(patch)),
            bundle: Some(blob(bundle.as_bytes())),
        }),
    }
}

fn finish(
    attempt: &InspectAttemptRequest,
    workspace_delivery: Option<WorkspaceDeliveryReference>,
) -> FinishTaskRequest {
    FinishTaskRequest {
        task_id: attempt.task_id.clone(),
        attempt_id: attempt.attempt_id.clone(),
        lease_token: attempt.lease_token.clone(),
        result: "Workspace Task finished".into(),
        succeeded: true,
        workspace_delivery,
        ..Default::default()
    }
}

async fn exercise(url: &str) {
    let store = Store::open(url).await.unwrap();
    let owner = support::register_host(&store, "primary").await;
    let other = support::register_host(&store, "secondary").await;
    let spec = WorkspaceSpec {
        workspace_id: REPOSITORY.into(),
        base_commit: BASE.into(),
        github_source: None,
    };
    let tag = store
        .put_tag_with_workspace(
            "engineer",
            "Inspect the changes",
            vec![],
            Some(spec.clone()),
        )
        .await
        .unwrap();
    assert_eq!(tag.workspace.as_ref(), Some(&spec));
    let first = submit(&store, "engineering").await.unwrap();
    assert_eq!(first.workspace.as_ref(), Some(&spec));
    assert!(
        store
            .claim_task(&other, "no-workspace")
            .await
            .unwrap()
            .is_none()
    );
    let attempt = claim(&store, &owner, "first", &first.task_id).await;
    assert!(matches!(
        store.claim_task(&owner, "first").await,
        Err(StoreError::Conflict(_))
    ));
    assert_eq!(
        store
            .get_workspace_continuation(&owner, &attempt)
            .await
            .unwrap(),
        None
    );

    let expected = delivery(&attempt, BASE, HEAD);
    let reference = expected.delivery.clone().unwrap();
    let artifact = GetWorkspaceArtifactRequest {
        task_id: first.task_id.clone(),
        kind: WorkspaceArtifactKind::Patch.into(),
    };
    assert!(matches!(
        store.get_workspace_artifact(&artifact).await,
        Err(StoreError::NotFound(_))
    ));
    assert!(matches!(
        store.reserve_workspace_delivery(&other, &expected).await,
        Err(StoreError::PermissionDenied)
    ));
    assert!(matches!(
        store.commit_workspace_delivery(&owner, &expected).await,
        Err(StoreError::FailedPrecondition(_))
    ));
    assert!(matches!(
        store
            .reserve_workspace_delivery(&owner, &delivery(&attempt, HEAD, HEAD))
            .await,
        Err(StoreError::FailedPrecondition(_))
    ));
    assert_eq!(
        store
            .reserve_workspace_delivery(&owner, &expected)
            .await
            .unwrap(),
        reference
    );
    assert!(matches!(
        store
            .reserve_workspace_delivery(&owner, &delivery(&attempt, BASE, BASE))
            .await,
        Err(StoreError::Conflict(_))
    ));
    assert!(matches!(
        store.finish_task(&owner, &finish(&attempt, None)).await,
        Err(StoreError::FailedPrecondition(_))
    ));
    let first_finish = finish(&attempt, Some(reference.clone()));
    assert!(matches!(
        store.finish_task(&owner, &first_finish).await,
        Err(StoreError::FailedPrecondition(_))
    ));
    assert_eq!(
        store
            .commit_workspace_delivery(&owner, &expected)
            .await
            .unwrap(),
        reference
    );
    assert!(matches!(
        store.get_workspace_artifact(&artifact).await,
        Err(StoreError::NotFound(_))
    ));
    let mut incomplete_finish = first_finish.clone();
    incomplete_finish.checkpoint_sha256 = Some("0".repeat(64));
    assert!(matches!(
        store.finish_task(&owner, &incomplete_finish).await,
        Err(StoreError::FailedPrecondition(_))
    ));
    assert_eq!(
        store
            .get_workspace_continuation(&owner, &attempt)
            .await
            .unwrap(),
        None
    );
    let completed = store.finish_task(&owner, &first_finish).await.unwrap();
    assert_eq!(completed.workspace_delivery.as_ref(), Some(&reference));
    assert_eq!(
        store.finish_task(&owner, &first_finish).await.unwrap(),
        completed
    );
    assert_eq!(
        store.get_workspace_artifact(&artifact).await.unwrap(),
        reference
    );

    let later = submit(&store, "engineering").await.unwrap();
    let next = claim(&store, &other, "continue", &later.task_id).await;
    assert_eq!(
        store
            .get_workspace_continuation(&other, &next)
            .await
            .unwrap(),
        Some(reference.clone())
    );
    let change = delivery(&next, HEAD, BASE);
    store
        .reserve_workspace_delivery(&other, &change)
        .await
        .unwrap();
    store
        .commit_workspace_delivery(&other, &change)
        .await
        .unwrap();
    store.cancel_task(&later.task_id).await.unwrap();
    let cancelled = store
        .finish_task(&other, &finish(&next, change.delivery))
        .await
        .unwrap();
    assert_eq!(cancelled.state(), TaskState::Cancelled);
    assert!(cancelled.workspace_delivery.is_none());

    let after_cancel = submit(&store, "engineering").await.unwrap();
    let next = claim(&store, &owner, "after-cancel", &after_cancel.task_id).await;
    assert_eq!(
        store
            .get_workspace_continuation(&owner, &next)
            .await
            .unwrap(),
        Some(reference)
    );
    let no_changes = delivery(&next, HEAD, HEAD);
    store
        .reserve_workspace_delivery(&owner, &no_changes)
        .await
        .unwrap();
    store
        .commit_workspace_delivery(&owner, &no_changes)
        .await
        .unwrap();
    store
        .finish_task(&owner, &finish(&next, no_changes.delivery))
        .await
        .unwrap();

    store
        .put_tag_configured(
            "engineer",
            "Select the accepted harness",
            vec![],
            None,
            HarnessKind::ClaudeCode,
        )
        .await
        .unwrap();
    let selected = submit(&store, "selected-harness").await.unwrap();
    assert_eq!(selected.harness_kind(), HarnessKind::ClaudeCode);
    store
        .put_tag_configured(
            "engineer",
            "Select the next harness",
            vec![],
            None,
            HarnessKind::OpenaiAgents,
        )
        .await
        .unwrap();
    assert_eq!(
        store
            .get_task(&selected.task_id)
            .await
            .unwrap()
            .harness_kind(),
        HarnessKind::ClaudeCode
    );
    assert!(matches!(
        submit(&store, "selected-harness").await,
        Err(StoreError::FailedPrecondition(_))
    ));
    let next_harness = submit(&store, "new-harness").await.unwrap();
    assert_eq!(next_harness.harness_kind(), HarnessKind::OpenaiAgents);
    let python = store
        .claim_task_for_host(&owner, "python-capability", &[], HarnessKind::OpenaiAgents)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(python.task.unwrap().task_id, next_harness.task_id);
    assert!(matches!(
        store
            .claim_task_for_host(&owner, "python-capability", &[], HarnessKind::ClaudeCode)
            .await,
        Err(StoreError::Conflict(_))
    ));
    let claude = store
        .claim_task_for_host(&other, "claude-capability", &[], HarnessKind::ClaudeCode)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(claude.task.unwrap().task_id, selected.task_id);

    store.put_tag("engineer", "Updated", vec![]).await.unwrap();
    assert!(matches!(
        submit(&store, "engineering").await,
        Err(StoreError::FailedPrecondition(_))
    ));
    assert!(
        submit(&store, "new-session")
            .await
            .unwrap()
            .workspace
            .is_none()
    );
    store.close().await;
}

#[tokio::test]
async fn sqlite_workspace_delivery_contract() {
    exercise("sqlite::memory:").await;
}

#[tokio::test]
#[ignore = "requires SUPERTAG_RUST_TEST_POSTGRES_URL_FILE for a dedicated PostgreSQL test server"]
async fn postgres_workspace_delivery_contract() {
    let path = std::env::var_os("SUPERTAG_RUST_TEST_POSTGRES_URL_FILE")
        .expect("PostgreSQL test URL file required");
    let admin_url = std::fs::read_to_string(path).unwrap();
    let database = format!("supertag_rust_workspace_{}", Uuid::new_v4().simple());
    let mut admin = sqlx::PgConnection::connect(admin_url.trim()).await.unwrap();
    admin
        .execute(format!("CREATE DATABASE {database}").as_str())
        .await
        .unwrap();
    let mut url = url::Url::parse(admin_url.trim()).unwrap();
    url.set_path(&database);
    let local = tokio::task::LocalSet::new();
    let result = local
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
