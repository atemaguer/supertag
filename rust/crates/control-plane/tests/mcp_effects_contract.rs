mod support;

use sqlx::{AnyConnection, Connection, Executor};
use supertag_control_plane::{HostAuthority, Store, StoreError};
use supertag_protocol::v2::*;
use uuid::Uuid;

const OPERATOR: &str = "operator:mcp-reviewer";
const TAG: &str = "catalog-writer";
const SERVER: &str = "catalog";
const TOOL: &str = "publish";
const ARGUMENTS: &str = r#"{"owner":"acme","repo":"api","title":"Release"}"#;
const REORDERED: &str = r#"{"title":"Release","repo":"api","owner":"acme"}"#;

async fn fixture(url: &str) -> (Store, HostAuthority) {
    let store = Store::open(url).await.unwrap();
    store
        .put_tag_spec(PutTagRequest {
            tag_id: TAG.into(),
            harness_kind: HarnessKind::ClaudeCode as i32,
            instructions: "Publish the exact approved release.".into(),
            ..Default::default()
        })
        .await
        .unwrap();
    store
        .put_permission_set(
            OPERATOR,
            &PutPermissionSetRequest {
                operation_id: "grants".into(),
                permission_set: Some(PermissionSet {
                    set_id: "catalog-policy".into(),
                    name: "Catalog".into(),
                    approvers: vec![OPERATOR.into()],
                    permissions: vec![
                        PolicyPermission {
                            target: PolicyPermissionTarget::Mcp as i32,
                            action: "catalog/publish".into(),
                            ..Default::default()
                        },
                        PolicyPermission {
                            target: PolicyPermissionTarget::Mcp as i32,
                            action: "catalog/pub*".into(),
                            resource: "repository:acme/api".into(),
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
    store
        .put_role(
            OPERATOR,
            &PutRoleRequest {
                operation_id: "role".into(),
                role: Some(Role {
                    role_id: "publisher".into(),
                    name: "Publisher".into(),
                    purpose: "Publish release entries.".into(),
                    permission_set_ids: vec!["catalog-policy".into()],
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
                operation_id: "assignment".into(),
                tag_id: TAG.into(),
                role: "publisher".into(),
            },
        )
        .await
        .unwrap();
    let host = support::register_host(&store, "mcp-host").await;
    (store, host)
}

fn profile(binding: char) -> HarnessExecutionProfile {
    HarnessExecutionProfile {
        mcp_servers: vec![McpServerCapability {
            name: SERVER.into(),
            mapped_tools: vec![TOOL.into()],
            provider_binding: Some(binding.to_string().repeat(64)),
            resource_bindings: vec![McpResourceBinding {
                tool: TOOL.into(),
                rules: vec![McpResourceRule {
                    prefix: "repository:".into(),
                    separator: "/".into(),
                    components: vec![
                        McpResourceComponent {
                            arguments: vec!["owner".into()],
                        },
                        McpResourceComponent {
                            arguments: vec!["repo".into(), "repository".into()],
                        },
                    ],
                    when: None,
                }],
            }],
        }],
        ..Default::default()
    }
}

async fn submit(store: &Store, session: &str) -> Task {
    store
        .submit_task(
            OPERATOR,
            &SubmitTaskRequest {
                tag_id: TAG.into(),
                session_id: session.into(),
                operation_id: format!("submit-{session}"),
                prompt: "Publish the release.".into(),
                ..Default::default()
            },
        )
        .await
        .unwrap()
}

async fn start(store: &Store, host: &HostAuthority, provider: char) -> InspectAttemptRequest {
    let assignment = store
        .claim_task_with_profile(
            host,
            &Uuid::new_v4().to_string(),
            &[],
            HarnessKind::ClaudeCode,
            &[],
            Some(&profile(provider)),
        )
        .await
        .unwrap()
        .unwrap();
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

fn request(
    attempt: &InspectAttemptRequest,
    operation: &str,
    arguments: &str,
) -> ReserveMcpEffectRequest {
    ReserveMcpEffectRequest {
        attempt: Some(attempt.clone()),
        operation_id: operation.into(),
        server: SERVER.into(),
        tool: TOOL.into(),
        arguments_json: arguments.into(),
        provider_binding: "a".repeat(64),
        tool_schema_sha256: "c".repeat(64),
    }
}

async fn decide(
    store: &Store,
    principal: &str,
    approval: &Approval,
    approve: bool,
) -> Result<Approval, StoreError> {
    store
        .decide_approval(
            principal,
            &DecideApprovalRequest {
                approval_id: approval.approval_id.clone(),
                operation_id: Uuid::new_v4().to_string(),
                approve,
                scope: if approve {
                    ApprovalScope::Once
                } else {
                    ApprovalScope::Unspecified
                } as i32,
                reason: "Reviewed the exact arguments".into(),
                ..Default::default()
            },
        )
        .await
}

async fn finish(
    store: &Store,
    host: &HostAuthority,
    attempt: &InspectAttemptRequest,
    approvals: Vec<String>,
) {
    store
        .finish_task(
            host,
            &FinishTaskRequest {
                task_id: attempt.task_id.clone(),
                attempt_id: attempt.attempt_id.clone(),
                lease_token: attempt.lease_token.clone(),
                succeeded: true,
                result: "Waiting for the reviewed effect.".into(),
                waiting_approval_ids: approvals,
                ..Default::default()
            },
        )
        .await
        .unwrap();
}

async fn approved_effect(store: &Store, host: &HostAuthority) {
    let task = submit(store, "approval-continuation").await;
    let first = start(store, host, 'a').await;
    assert_eq!(first.task_id, task.task_id);
    let ambiguous = request(
        &first,
        "ambiguous",
        r#"{"owner":"acme","repo":"api","repository":"web"}"#,
    );
    assert!(matches!(
        store.reserve_mcp_effect(host, &ambiguous).await,
        Err(StoreError::PermissionDenied)
    ));
    let missing = store
        .reserve_mcp_effect(host, &request(&first, "missing", r#"{"title":"Release"}"#))
        .await
        .unwrap();
    assert_eq!(missing.approval.unwrap().state(), ApprovalState::Pending);
    assert!(missing.dispatch_id.is_none());
    let requested = request(&first, "original", ARGUMENTS);
    let pending = store.reserve_mcp_effect(host, &requested).await.unwrap();
    let approval = pending.approval.unwrap();
    assert_eq!(approval.state(), ApprovalState::Pending);
    assert_eq!(approval.resource, "repository:acme/api");
    assert_eq!(approval.canonical_arguments_json, ARGUMENTS);
    assert!(pending.dispatch_id.is_none());
    assert_eq!(
        store
            .reserve_mcp_effect(host, &request(&first, "original", REORDERED))
            .await
            .unwrap()
            .approval
            .unwrap()
            .approval_id,
        approval.approval_id
    );
    assert!(matches!(
        decide(store, "operator:other", &approval, true).await,
        Err(StoreError::PermissionDenied)
    ));
    finish(store, host, &first, vec![approval.approval_id.clone()]).await;
    decide(store, OPERATOR, &approval, true).await.unwrap();

    let resumed = start(store, host, 'a').await;
    assert_ne!(resumed.task_id, first.task_id);
    let changed = request(
        &resumed,
        "changed",
        r#"{"owner":"acme","repo":"api","title":"Different"}"#,
    );
    assert_eq!(
        store
            .reserve_mcp_effect(host, &changed)
            .await
            .unwrap()
            .approval
            .unwrap()
            .state(),
        ApprovalState::Pending
    );
    let mut new_schema = request(&resumed, "changed-schema", ARGUMENTS);
    new_schema.tool_schema_sha256 = "d".repeat(64);
    assert_eq!(
        store
            .reserve_mcp_effect(host, &new_schema)
            .await
            .unwrap()
            .approval
            .unwrap()
            .state(),
        ApprovalState::Pending
    );

    let original = request(&resumed, "same-effect", REORDERED);
    let another = support::register_host(store, "other-mcp-host").await;
    assert!(matches!(
        store.reserve_mcp_effect(&another, &original).await,
        Err(StoreError::PermissionDenied)
    ));
    let (left, right) = tokio::join!(
        Box::pin(store.reserve_mcp_effect(host, &original)),
        Box::pin(store.reserve_mcp_effect(host, &original)),
    );
    let (left, right) = (left.unwrap(), right.unwrap());
    let (reserved, replay) = if left.dispatch_id.is_some() {
        (left, right)
    } else {
        (right, left)
    };
    assert_eq!(reserved.approval.unwrap().approval_id, approval.approval_id);
    let dispatch = reserved.dispatch_id.unwrap();
    assert!(replay.unconfirmed && replay.dispatch_id.is_none());
    let competing = store
        .reserve_mcp_effect(host, &request(&resumed, "competing", ARGUMENTS))
        .await
        .unwrap();
    assert!(competing.unconfirmed && competing.dispatch_id.is_none());

    let result = r#"{"content":[{"type":"text","text":"done"}]}"#;
    let settled = SettleMcpEffectRequest {
        attempt: Some(resumed.clone()),
        operation_id: original.operation_id.clone(),
        dispatch_id: dispatch,
        result_json: Some(result.into()),
    };
    assert!(matches!(
        store.settle_mcp_effect(&another, &settled).await,
        Err(StoreError::PermissionDenied)
    ));
    store.settle_mcp_effect(host, &settled).await.unwrap();
    store.settle_mcp_effect(host, &settled).await.unwrap();
    let replay = store.reserve_mcp_effect(host, &original).await.unwrap();
    assert_eq!(replay.result_json.as_deref(), Some(result));
    assert!(replay.dispatch_id.is_none());
    let mut changed_receipt = settled;
    changed_receipt.result_json = None;
    assert!(matches!(
        store.settle_mcp_effect(host, &changed_receipt).await,
        Err(StoreError::Conflict(_))
    ));
    let fresh = store
        .reserve_mcp_effect(host, &request(&resumed, "once-consumed", ARGUMENTS))
        .await
        .unwrap();
    assert!(fresh.dispatch_id.is_none());
    assert_eq!(fresh.approval.unwrap().state(), ApprovalState::Pending);
    finish(store, host, &resumed, vec![]).await;
}

async fn denied_and_changed_provider(store: &Store, host: &HostAuthority) {
    submit(store, "denial").await;
    let denied = start(store, host, 'a').await;
    let first = store
        .reserve_mcp_effect(host, &request(&denied, "deny", ARGUMENTS))
        .await
        .unwrap()
        .approval
        .unwrap();
    decide(store, OPERATOR, &first, false).await.unwrap();
    let denial = store
        .reserve_mcp_effect(host, &request(&denied, "other-id", REORDERED))
        .await
        .unwrap();
    assert!(denial.dispatch_id.is_none());
    assert_eq!(denial.approval.unwrap().state(), ApprovalState::Denied);
    finish(store, host, &denied, vec![]).await;

    submit(store, "provider-change").await;
    let original = start(store, host, 'a').await;
    let first = store
        .reserve_mcp_effect(host, &request(&original, "bound", ARGUMENTS))
        .await
        .unwrap()
        .approval
        .unwrap();
    finish(store, host, &original, vec![first.approval_id.clone()]).await;
    decide(store, OPERATOR, &first, true).await.unwrap();
    let changed = start(store, host, 'b').await;
    let mut effect = request(&changed, "binding", REORDERED);
    assert!(matches!(
        store.reserve_mcp_effect(host, &effect).await,
        Err(StoreError::PermissionDenied)
    ));
    effect.provider_binding = "b".repeat(64);
    let new = store.reserve_mcp_effect(host, &effect).await.unwrap();
    assert!(new.dispatch_id.is_none());
    let new = new.approval.unwrap();
    assert_ne!(new.approval_id, first.approval_id);
    assert_eq!(new.state(), ApprovalState::Pending);
}

async fn contract(url: &str) {
    let (store, host) = fixture(url).await;
    // The setup pre-dates any MCP dispatch. Recreate the previous schema by
    // removing only the new table, keeping the existing Host and policy rows.
    store.close().await;
    let mut previous = AnyConnection::connect(url).await.unwrap();
    previous
        .execute("DROP TABLE supertag_v2_mcp_effects")
        .await
        .unwrap();
    previous
        .execute("UPDATE supertag_v2_schema SET version=46 WHERE version=47")
        .await
        .unwrap();
    previous.close().await.unwrap();
    let store = Store::open(url).await.unwrap();
    Box::pin(approved_effect(&store, &host)).await;
    Box::pin(denied_and_changed_provider(&store, &host)).await;
    store.close().await;
    Box::pin(lost_dispatch_after_restart(url)).await;
}

async fn lost_dispatch_after_restart(url: &str) {
    let store = Store::open(url).await.unwrap();
    let host = support::register_host(&store, "mcp-recovery-host").await;
    let task = submit(&store, "uncertain-after-restart").await;
    let attempt = start(&store, &host, 'a').await;
    assert_eq!(task.task_id, attempt.task_id);
    let call = request(&attempt, "lost-response", ARGUMENTS);
    let pending = store
        .reserve_mcp_effect(&host, &call)
        .await
        .unwrap()
        .approval
        .unwrap();
    decide(&store, OPERATOR, &pending, true).await.unwrap();
    let reserved = store.reserve_mcp_effect(&host, &call).await.unwrap();
    let dispatch_id = reserved.dispatch_id.unwrap();
    assert!((1..=12_000).contains(&reserved.dispatch_valid_for_ms));
    store.close().await;

    let store = Store::open(url).await.unwrap();
    let observed = store.reserve_mcp_effect(&host, &call).await.unwrap();
    assert!(observed.unconfirmed && observed.dispatch_id.is_none());
    store
        .settle_mcp_effect(
            &host,
            &SettleMcpEffectRequest {
                attempt: Some(attempt.clone()),
                operation_id: call.operation_id,
                dispatch_id,
                result_json: None,
            },
        )
        .await
        .unwrap();
    finish(&store, &host, &attempt, vec![]).await;
    let mut permission = store
        .get_permission_set(OPERATOR, "catalog-policy")
        .await
        .unwrap();
    permission
        .permissions
        .retain(|grant| !grant.approval_required);
    store
        .put_permission_set(
            OPERATOR,
            &PutPermissionSetRequest {
                operation_id: "remove-gate-after-uncertain-dispatch".into(),
                expected_revision: Some(permission.revision),
                permission_set: Some(permission),
            },
        )
        .await
        .unwrap();
    let next_task = store
        .submit_task(
            OPERATOR,
            &SubmitTaskRequest {
                tag_id: TAG.into(),
                session_id: task.session_id,
                operation_id: "new-turn-after-restart".into(),
                prompt: "Continue".into(),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    let next = start(&store, &host, 'a').await;
    assert_eq!(next.task_id, next_task.task_id);
    let mut retry = request(&next, "new-attempt", REORDERED);
    retry.tool_schema_sha256 = "d".repeat(64);
    let repeat = store.reserve_mcp_effect(&host, &retry).await.unwrap();
    assert!(repeat.unconfirmed && repeat.dispatch_id.is_none() && !repeat.ungated);
    let ordinary = store
        .reserve_mcp_effect(
            &host,
            &request(
                &next,
                "unrelated",
                r#"{"owner":"acme","repo":"api","title":"Another release"}"#,
            ),
        )
        .await
        .unwrap();
    assert!(ordinary.ungated && ordinary.approval.is_none());
    store.close().await;
}

#[tokio::test]
async fn sqlite_requires_a_durable_mcp_dispatch_for_exact_approval() {
    let directory = tempfile::tempdir().unwrap();
    Box::pin(contract(&format!(
        "sqlite://{}?mode=rwc",
        directory.path().join("mcp.db").display()
    )))
    .await;
}

#[tokio::test]
#[ignore = "requires SUPERTAG_RUST_TEST_POSTGRES_URL_FILE for a dedicated PostgreSQL test server"]
async fn postgres_requires_a_durable_mcp_dispatch_for_exact_approval() {
    let path = std::env::var_os("SUPERTAG_RUST_TEST_POSTGRES_URL_FILE")
        .expect("dedicated PostgreSQL URL file");
    let admin_url = std::fs::read_to_string(path).unwrap();
    let name = format!("supertag_mcp_effect_{}", Uuid::new_v4().simple());
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
    outcome.expect("PostgreSQL MCP approval contract failed");
}
