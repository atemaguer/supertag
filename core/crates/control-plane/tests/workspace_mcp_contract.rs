//! Workspace MCP servers and lapsed MCP logins at the Control Plane, on SQLite and PostgreSQL.
//!
//! TypeScript parity: `tests/workspace-mcp-snapshot.test.ts` (the first Attempt's digest binds
//! every retry), `packages/control-plane/workspace-mcp-digest.test.ts`, and the `mcp-login`
//! placement hold and Inbox item of `tests/mcp-oauth-login.test.ts`.
mod support;

use std::sync::{
    Arc,
    atomic::{AtomicI64, Ordering},
};

use sqlx::{Connection, Executor};
use supertag_control_plane::{HostAuthority, Store, StoreError};
use supertag_protocol::v2::*;
use uuid::Uuid;

const OPERATOR: &str = "operator:workspace-mcp";
const BASE: i64 = 1_790_000_000_000;
const LEASE: i64 = 30_000;

fn digest(fill: char) -> String {
    format!("sha256:{}", fill.to_string().repeat(64))
}

fn record(digest: &str, binding: char) -> WorkspaceMcpRecord {
    WorkspaceMcpRecord {
        digest: digest.into(),
        servers: vec![McpServerCapability {
            name: "local".into(),
            provider_binding: Some(binding.to_string().repeat(64)),
            ..Default::default()
        }],
    }
}

fn inspect(assignment: &Assignment) -> InspectAttemptRequest {
    InspectAttemptRequest {
        task_id: assignment.task.as_ref().unwrap().task_id.clone(),
        attempt_id: assignment.attempt_id.clone(),
        lease_token: assignment.lease_token.clone(),
    }
}

async fn start(store: &Store, host: &HostAuthority, attempt: &InspectAttemptRequest) {
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
}

async fn put_record(
    store: &Store,
    host: &HostAuthority,
    attempt: &InspectAttemptRequest,
    record: WorkspaceMcpRecord,
) -> Result<(), StoreError> {
    store
        .record_workspace_mcp(
            host,
            &RecordWorkspaceMcpRequest {
                attempt: Some(attempt.clone()),
                record: Some(record),
            },
        )
        .await
}

async fn reserve(
    store: &Store,
    host: &HostAuthority,
    attempt: &InspectAttemptRequest,
    binding: char,
) -> Result<ReserveMcpEffectResponse, StoreError> {
    store
        .reserve_mcp_effect(
            host,
            &ReserveMcpEffectRequest {
                attempt: Some(attempt.clone()),
                operation_id: format!("read-{binding}"),
                server: "local".into(),
                tool: "read_env".into(),
                arguments_json: "{}".into(),
                provider_binding: binding.to_string().repeat(64),
                tool_schema_sha256: "e".repeat(64),
            },
        )
        .await
}

async fn grant(store: &Store, tag: &str, actions: &[&str]) {
    let set = store
        .put_permission_set(
            OPERATOR,
            &PutPermissionSetRequest {
                operation_id: format!("grants-{tag}"),
                permission_set: Some(PermissionSet {
                    set_id: format!("{tag}-grants"),
                    name: format!("{tag}-grants"),
                    permissions: actions
                        .iter()
                        .map(|action| PolicyPermission {
                            target: PolicyPermissionTarget::Mcp.into(),
                            action: (*action).into(),
                            ..Default::default()
                        })
                        .collect(),
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
                operation_id: format!("role-{tag}"),
                role: Some(Role {
                    role_id: format!("{tag}-role"),
                    name: format!("{tag}-role"),
                    purpose: "Use MCP tools".into(),
                    permission_set_ids: vec![set.set_id],
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
                operation_id: format!("assign-{tag}"),
                role: role.role_id,
                tag_id: tag.into(),
            },
        )
        .await
        .unwrap();
}

async fn workspace_contract(store: &Store, clock: &AtomicI64) {
    let spec = |names: &[&str]| WorkspaceSpec {
        workspace_id: "repo".into(),
        base_commit: "a".repeat(40),
        mcp_servers: names.iter().map(|name| (*name).into()).collect(),
        ..Default::default()
    };
    assert!(matches!(
        store
            .put_tag_spec(PutTagRequest {
                tag_id: "mcp-tag".into(),
                instructions: "Use the repository tools.".into(),
                workspace: Some(spec(&["Not A Name"])),
                ..Default::default()
            })
            .await,
        Err(StoreError::InvalidArgument(_))
    ));
    store
        .put_tag_spec(PutTagRequest {
            tag_id: "mcp-tag".into(),
            instructions: "Use the repository tools.".into(),
            workspace: Some(spec(&["zeta", "local", "local"])),
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(
        store
            .get_tag("mcp-tag")
            .await
            .unwrap()
            .workspace
            .unwrap()
            .mcp_servers,
        ["local", "zeta"]
    );
    grant(store, "mcp-tag", &["local/read_*"]).await;
    let task = store
        .submit_task(
            OPERATOR,
            &SubmitTaskRequest {
                tag_id: "mcp-tag".into(),
                session_id: "workspace".into(),
                operation_id: "submit-workspace".into(),
                prompt: "Read the repository environment.".into(),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert_eq!(
        task.workspace.as_ref().unwrap().mcp_servers,
        ["local", "zeta"]
    );

    // Only a Claude Code host with a local Workspace can run the Workspace's servers.
    for (id, harness, profile) in [
        ("codex", HarnessKind::Codex, None),
        (
            "remote",
            HarnessKind::ClaudeCode,
            Some(HarnessExecutionProfile {
                remote_file_workspace: true,
                ..Default::default()
            }),
        ),
    ] {
        let host = support::register_host(store, id).await;
        assert!(
            store
                .claim_task_with_profile(
                    &host,
                    id,
                    &["repo".into()],
                    harness,
                    &[],
                    profile.as_ref()
                )
                .await
                .unwrap()
                .is_none(),
            "{id} cannot run Workspace MCP servers"
        );
    }
    // No host catalog declares `local`: the Workspace provides it.
    let host = support::register_host(store, "claude").await;
    let claimed = store
        .claim_task_with_profile(
            &host,
            "first",
            &["repo".into()],
            HarnessKind::ClaudeCode,
            &[],
            None,
        )
        .await
        .unwrap()
        .unwrap();
    let first = inspect(&claimed);
    assert_eq!(first.task_id, task.task_id);
    assert!(
        claimed
            .task
            .unwrap()
            .attempt_execution
            .unwrap()
            .mcp_servers
            .is_empty()
    );
    start(store, &host, &first).await;
    // A Workspace server can be used only as this Attempt recorded it.
    assert!(matches!(
        reserve(store, &host, &first, 'b').await,
        Err(StoreError::PermissionDenied)
    ));
    for (invalid, expected) in [
        (record("sha256:short", 'b'), "invalid"),
        (
            WorkspaceMcpRecord {
                servers: vec![McpServerCapability {
                    name: "local".into(),
                    mapped_tools: vec!["read_env".into()],
                    provider_binding: Some("b".repeat(64)),
                    resource_bindings: vec![],
                }],
                ..record(&digest('1'), 'b')
            },
            "invalid",
        ),
        (
            WorkspaceMcpRecord {
                servers: vec![
                    record(&digest('1'), 'b').servers[0].clone(),
                    McpServerCapability {
                        name: "zeta".into(),
                        provider_binding: Some("c".repeat(64)),
                        ..Default::default()
                    },
                ],
                ..record(&digest('1'), 'b')
            },
            "ungranted",
        ),
    ] {
        let result = put_record(store, &host, &first, invalid).await;
        match expected {
            "invalid" => assert!(matches!(result, Err(StoreError::InvalidArgument(_)))),
            _ => assert!(matches!(result, Err(StoreError::PermissionDenied))),
        }
    }
    let intruder = support::register_host(store, "intruder").await;
    assert!(matches!(
        put_record(store, &intruder, &first, record(&digest('1'), 'b')).await,
        Err(StoreError::PermissionDenied)
    ));
    put_record(store, &host, &first, record(&digest('1'), 'b'))
        .await
        .unwrap();
    put_record(store, &host, &first, record(&digest('1'), 'b'))
        .await
        .unwrap();
    assert!(matches!(
        put_record(store, &host, &first, record(&digest('2'), 'b')).await,
        Err(StoreError::Conflict(_))
    ));
    assert!(reserve(store, &host, &first, 'b').await.unwrap().ungated);
    assert!(matches!(
        reserve(store, &host, &first, 'c').await,
        Err(StoreError::PermissionDenied)
    ));

    // The Attempt is lost; the operator retries the Task on another Attempt.
    clock.store(BASE + 2 * LEASE, Ordering::SeqCst);
    store.sweep_expired_attempts().await.unwrap();
    assert_eq!(
        store.get_task(&task.task_id).await.unwrap().state(),
        TaskState::Uncertain
    );
    store
        .resolve_attempt(
            OPERATOR,
            &ResolveAttemptRequest {
                task_id: task.task_id.clone(),
                attempt_id: first.attempt_id.clone(),
                operation_id: "retry".into(),
                decision: AttemptDecision::Retry.into(),
                evidence: "The Worker Host stopped. Retry.".into(),
                confirmed_stopped: true,
            },
        )
        .await
        .unwrap();
    let retried = store
        .claim_task_with_profile(
            &host,
            "retry",
            &["repo".into()],
            HarnessKind::ClaudeCode,
            &[],
            None,
        )
        .await
        .unwrap()
        .unwrap();
    let second = inspect(&retried);
    assert_eq!(second.task_id, task.task_id);
    assert_ne!(second.attempt_id, first.attempt_id);
    start(store, &host, &second).await;
    // The first Attempt's digest binds the retry: a changed `.mcp.json` entry is refused.
    let refused = put_record(store, &host, &second, record(&digest('2'), 'b'))
        .await
        .unwrap_err();
    assert!(
        matches!(&refused, StoreError::FailedPrecondition(message) if message.contains("changed since this Task's first Task Attempt")),
        "{refused:?}"
    );
    assert!(matches!(
        reserve(store, &host, &second, 'b').await,
        Err(StoreError::PermissionDenied)
    ));
    // The same declaration with another host value of a referenced variable is accepted; its
    // launch binding is the retry's own.
    put_record(store, &host, &second, record(&digest('1'), 'd'))
        .await
        .unwrap();
    assert!(reserve(store, &host, &second, 'd').await.unwrap().ungated);
    assert!(matches!(
        reserve(store, &host, &second, 'b').await,
        Err(StoreError::PermissionDenied)
    ));
}

fn report(sequence: u64, profile: HarnessExecutionProfile) -> ReportHostRequest {
    ReportHostRequest {
        sequence,
        capacity: 1,
        available_slots: 1,
        readiness: HostReadiness::Ready as i32,
        harness_kind: HarnessKind::ClaudeCode as i32,
        execution_profile: Some(profile),
        ..Default::default()
    }
}

async fn login_contract(store: &Store) {
    store
        .put_tag_spec(PutTagRequest {
            tag_id: "login-tag".into(),
            instructions: "Search the docs.".into(),
            ..Default::default()
        })
        .await
        .unwrap();
    grant(store, "login-tag", &["docs/search"]).await;
    let objective = store
        .create_objective(
            OPERATOR,
            &CreateObjectiveRequest {
                operation_id: "objective".into(),
                objective_id: "docs-objective".into(),
                owner_tag_id: "login-tag".into(),
                outcome: "Answer from the docs".into(),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    let docs = McpServerCapability {
        name: "docs".into(),
        provider_binding: Some("f".repeat(64)),
        ..Default::default()
    };
    let host = support::register_host(store, "login-host").await;
    let duplicate = HarnessExecutionProfile {
        mcp_servers: vec![docs.clone()],
        mcp_login_servers: vec!["docs".into()],
        ..Default::default()
    };
    assert!(matches!(
        store.report_host(&host, &report(1, duplicate)).await,
        Err(StoreError::InvalidArgument(_))
    ));
    let lapsed = HarnessExecutionProfile {
        mcp_login_servers: vec!["docs".into()],
        ..Default::default()
    };
    store
        .report_host(&host, &report(2, lapsed.clone()))
        .await
        .unwrap();
    let list = |kind: InboxItemKind| ListInboxItemsRequest {
        kind: kind as i32,
        ..Default::default()
    };
    let items = store
        .list_inbox_items(OPERATOR, &list(InboxItemKind::McpLogin))
        .await
        .unwrap()
        .items;
    assert_eq!(items.len(), 1, "{items:?}");
    assert_eq!(items[0].task_id, objective.starting_task_id);
    assert_eq!(items[0].objective_id, "docs-objective");
    assert_eq!(
        items[0].key,
        format!("mcp_login:{}:docs", objective.starting_task_id)
    );
    assert!(items[0].reason.contains("supertag mcp login docs"));
    let since = items[0].actionable_since_ms;
    // Every kind includes it; a later report of the same lapse keeps its place.
    store
        .report_host(&host, &report(3, lapsed.clone()))
        .await
        .unwrap();
    let all = store
        .list_inbox_items(OPERATOR, &list(InboxItemKind::Unspecified))
        .await
        .unwrap()
        .items;
    assert!(
        all.iter()
            .any(|item| item.key == items[0].key && item.actionable_since_ms == since)
    );
    // The Task waits: the host does not offer the server while its login lapsed.
    assert!(
        store
            .claim_task_with_profile(
                &host,
                "held",
                &[],
                HarnessKind::ClaudeCode,
                &[],
                Some(&lapsed),
            )
            .await
            .unwrap()
            .is_none()
    );
    let restored = HarnessExecutionProfile {
        mcp_servers: vec![docs],
        ..Default::default()
    };
    store
        .report_host(&host, &report(4, restored.clone()))
        .await
        .unwrap();
    assert!(
        store
            .list_inbox_items(OPERATOR, &list(InboxItemKind::McpLogin))
            .await
            .unwrap()
            .items
            .is_empty()
    );
    let claimed = store
        .claim_task_with_profile(
            &host,
            "restored",
            &[],
            HarnessKind::ClaudeCode,
            &[],
            Some(&restored),
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(claimed.task.unwrap().task_id, objective.starting_task_id);
}

async fn contract(url: &str) {
    let clock = Arc::new(AtomicI64::new(BASE));
    let reader = clock.clone();
    let store = Store::open(url)
        .await
        .unwrap()
        .with_execution_clock(move || reader.load(Ordering::SeqCst));
    Box::pin(workspace_contract(&store, &clock)).await;
    Box::pin(login_contract(&store)).await;
    store.close().await;
}

#[tokio::test]
async fn sqlite_pins_workspace_mcp_and_holds_tasks_for_lapsed_logins() {
    let directory = tempfile::tempdir().unwrap();
    Box::pin(contract(&format!(
        "sqlite://{}?mode=rwc",
        directory.path().join("workspace-mcp.db").display()
    )))
    .await;
}

#[tokio::test]
#[ignore = "requires SUPERTAG_RUST_TEST_POSTGRES_URL_FILE for a dedicated PostgreSQL test server"]
async fn postgres_pins_workspace_mcp_and_holds_tasks_for_lapsed_logins() {
    let path = std::env::var_os("SUPERTAG_RUST_TEST_POSTGRES_URL_FILE")
        .expect("PostgreSQL test URL file required");
    let admin_url = std::fs::read_to_string(path).unwrap();
    let name = format!("supertag_workspace_mcp_{}", Uuid::new_v4().simple());
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
    outcome.expect("PostgreSQL Workspace MCP contract failed");
}
