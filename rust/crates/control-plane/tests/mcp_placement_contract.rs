mod support;

use sqlx::{Connection, Executor};
use supertag_control_plane::Store;
use supertag_protocol::v2::*;
use uuid::Uuid;

const OPERATOR: &str = "operator:mcp-placement";

async fn submit(store: &Store, session: &str) -> Task {
    store
        .submit_task(
            OPERATOR,
            &SubmitTaskRequest {
                tag_id: "mcp-tag".into(),
                session_id: session.into(),
                operation_id: format!("submit-{session}"),
                prompt: "Find the repository's release record.".into(),
                ..Default::default()
            },
        )
        .await
        .unwrap()
}

async fn contract(url: &str) {
    let store = Store::open(url).await.unwrap();
    store
        .put_tag_spec(PutTagRequest {
            tag_id: "mcp-tag".into(),
            instructions: "Use the approved tools.".into(),
            workspace: Some(WorkspaceSpec {
                workspace_id: "repo".into(),
                base_commit: "a".repeat(40),
                github_source: None,
            }),
            ..Default::default()
        })
        .await
        .unwrap();
    let granted = store
        .put_permission_set(
            OPERATOR,
            &PutPermissionSetRequest {
                operation_id: "put-grants".into(),
                permission_set: Some(PermissionSet {
                    set_id: "mcp-grants".into(),
                    name: "mcp-grants".into(),
                    approvers: vec!["operator:mcp-placement".into()],
                    permissions: vec![
                        PolicyPermission {
                            target: PolicyPermissionTarget::Mcp.into(),
                            action: "catalog/list*".into(),
                            resource: "repository:acme/docs".into(),
                            ..Default::default()
                        },
                        PolicyPermission {
                            target: PolicyPermissionTarget::Mcp.into(),
                            action: "catalog/publish".into(),
                            approval_required: true,
                            ..Default::default()
                        },
                    ],
                    ..Default::default()
                }),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    let role = store
        .put_role(
            OPERATOR,
            &PutRoleRequest {
                operation_id: "put-role".into(),
                role: Some(Role {
                    role_id: "mcp-role".into(),
                    name: "mcp-role".into(),
                    purpose: "Use the catalog".into(),
                    permission_set_ids: vec![granted.set_id.clone()],
                    status: RoleStatus::Active.into(),
                    ..Default::default()
                }),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    store
        .assign_role(
            OPERATOR,
            &AssignRoleRequest {
                operation_id: "assign-role".into(),
                role: role.role_id,
                tag_id: "mcp-tag".into(),
            },
        )
        .await
        .unwrap();
    let blocked = submit(&store, "accepted-mcp").await;
    assert_eq!(
        blocked.policy_snapshot.as_ref().unwrap().permission_sets,
        vec![granted.clone()]
    );

    for (host_id, harness, profile) in [
        ("claude", HarnessKind::ClaudeCode, None),
        ("custom", HarnessKind::Unspecified, None),
        (
            "remote",
            HarnessKind::Cursor,
            Some(HarnessExecutionProfile {
                remote_file_workspace: true,
                ..Default::default()
            }),
        ),
    ] {
        let host = support::register_host(&store, host_id).await;
        assert!(
            store
                .claim_task_with_profile(
                    &host,
                    "without-mcp",
                    &["repo".into()],
                    harness,
                    &[],
                    profile.as_ref()
                )
                .await
                .unwrap()
                .is_none(),
            "{host_id} cannot enforce the accepted MCP grants"
        );
    }

    store
        .put_permission_set(
            OPERATOR,
            &PutPermissionSetRequest {
                operation_id: "replace-grants".into(),
                expected_revision: Some(granted.revision),
                permission_set: Some(PermissionSet {
                    permissions: vec![PolicyPermission {
                        target: PolicyPermissionTarget::Runtime.into(),
                        action: "files:read".into(),
                        ..Default::default()
                    }],
                    ..granted
                }),
            },
        )
        .await
        .unwrap();
    let ordinary = submit(&store, "accepted-runtime-only").await;
    let host = support::register_host(&store, "plain").await;
    let assignment = store
        .claim_task_with_profile(
            &host,
            "ordinary",
            &["repo".into()],
            HarnessKind::ClaudeCode,
            &[],
            None,
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(assignment.task.unwrap().task_id, ordinary.task_id);
    let current = store.get_task(&blocked.task_id).await.unwrap();
    assert_eq!(current.state(), TaskState::Queued);
    assert!(current.attempt_id.is_none());
    assert_eq!(current.policy_snapshot, blocked.policy_snapshot);
    let mut profile = HarnessExecutionProfile {
        mcp_servers: vec![McpServerCapability {
            name: "catalog".into(),
            mapped_tools: vec!["List_docs".into(), "publish".into()],
        }],
        ..Default::default()
    };
    assert!(
        store
            .claim_task_with_profile(
                &host,
                "wrong-mapping",
                &["repo".into()],
                HarnessKind::ClaudeCode,
                &[],
                Some(&profile),
            )
            .await
            .unwrap()
            .is_none()
    );
    profile.mcp_servers[0].mapped_tools.push("list_docs".into());
    let selected = store
        .claim_task_with_profile(
            &host,
            "right-mapping",
            &["repo".into()],
            HarnessKind::ClaudeCode,
            &[],
            Some(&profile),
        )
        .await
        .unwrap()
        .unwrap();
    let task = selected.task.unwrap();
    assert_eq!(task.task_id, blocked.task_id);
    assert_eq!(task.policy_snapshot, blocked.policy_snapshot);
    store.close().await;
}

#[tokio::test]
async fn sqlite_keeps_mcp_work_queued_without_a_compatible_host() {
    let directory = tempfile::tempdir().unwrap();
    Box::pin(contract(&format!(
        "sqlite://{}?mode=rwc",
        directory.path().join("mcp-placement.db").display()
    )))
    .await;
}

#[tokio::test]
#[ignore = "requires SUPERTAG_RUST_TEST_POSTGRES_URL_FILE for a dedicated PostgreSQL test server"]
async fn postgres_keeps_mcp_work_queued_without_a_compatible_host() {
    let path = std::env::var_os("SUPERTAG_RUST_TEST_POSTGRES_URL_FILE")
        .expect("PostgreSQL test URL file required");
    let admin_url = std::fs::read_to_string(path).unwrap();
    let name = format!("supertag_mcp_placement_{}", Uuid::new_v4().simple());
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
    outcome.expect("PostgreSQL MCP placement contract failed");
}
