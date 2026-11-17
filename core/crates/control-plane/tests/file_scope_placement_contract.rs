//! Path scopes and placement: a host lane claims a scoped Task only when its harness can apply
//! the scope with the strength the Task needs, and `placement explain` names the `file-scope`
//! requirement, or `unsandboxed-commands` when no bound host allows a harness's commands.

mod support;

use sqlx::{Connection, Executor};
use supertag_control_plane::{HostAuthority, Store};
use supertag_protocol::v2::*;
use uuid::Uuid;

const NOW: i64 = 1_800_000_000_000;
const OP: &str = "operator:alice";

fn strings(values: &[&str]) -> Vec<String> {
    values.iter().map(|value| (*value).to_owned()).collect()
}

async fn report(
    store: &Store,
    host: &HostAuthority,
    harness: HarnessKind,
    profile: HarnessExecutionProfile,
) {
    store
        .report_host(
            host,
            &ReportHostRequest {
                sequence: 1,
                capacity: 4,
                available_slots: 4,
                readiness: HostReadiness::Ready.into(),
                harness_kind: harness.into(),
                execution_profile: Some(profile),
                ..Default::default()
            },
        )
        .await
        .unwrap();
}

/// A Tag on `harness` with direct `actions` and the `guard` Role, and one queued Task.
async fn scoped_task(store: &Store, tag: &str, harness: HarnessKind, actions: &[&str]) -> String {
    store
        .put_tag_spec(PutTagRequest {
            tag_id: tag.into(),
            instructions: "Change code".into(),
            allowed_actions: strings(actions),
            harness_kind: harness.into(),
            ..Default::default()
        })
        .await
        .unwrap();
    store
        .assign_role(
            OP,
            &AssignRoleRequest {
                operation_id: format!("assign-{tag}"),
                role: "guard".into(),
                tag_id: tag.into(),
            },
        )
        .await
        .unwrap();
    store
        .submit_task(
            OP,
            &SubmitTaskRequest {
                tag_id: tag.into(),
                session_id: tag.into(),
                operation_id: tag.into(),
                prompt: "Change code".into(),
                ..Default::default()
            },
        )
        .await
        .unwrap()
        .task_id
}

async fn claim(
    store: &Store,
    host: &HostAuthority,
    harness: HarnessKind,
    profile: &HarnessExecutionProfile,
) -> Option<String> {
    store
        .claim_task_with_profile(
            host,
            &Uuid::new_v4().to_string(),
            &[],
            harness,
            &[],
            Some(profile),
        )
        .await
        .unwrap()
        .map(|assignment| assignment.task.unwrap().task_id)
}

async fn contract(url: &str) {
    let store = Store::open(url).await.unwrap().with_execution_clock(|| NOW);
    store
        .put_permission_set(
            OP,
            &PutPermissionSetRequest {
                operation_id: "guard-set".into(),
                permission_set: Some(PermissionSet {
                    set_id: "guard".into(),
                    name: "guard".into(),
                    permissions: vec![PolicyPermission {
                        target: PolicyPermissionTarget::Runtime.into(),
                        action: "files:read".into(),
                        exclude: strings(&["**/.env"]),
                        ..Default::default()
                    }],
                    ..Default::default()
                }),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    store
        .put_role(
            OP,
            &PutRoleRequest {
                operation_id: "guard-role".into(),
                role: Some(Role {
                    role_id: "guard".into(),
                    name: "guard".into(),
                    purpose: "Never read secrets".into(),
                    permission_set_ids: strings(&["guard"]),
                    status: RoleStatus::Active.into(),
                    ..Default::default()
                }),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    let commands = ["files:read", "files:write", "commands:execute"];
    let unsandboxed = HarnessExecutionProfile {
        allow_unsandboxed_commands: true,
        ..Default::default()
    };

    // Claude Code cannot keep commands from reading hidden paths, on any host.
    let claude = support::register_host(&store, "claude").await;
    report(
        &store,
        &claude,
        HarnessKind::ClaudeCode,
        unsandboxed.clone(),
    )
    .await;
    let task = scoped_task(&store, "claude-tag", HarnessKind::ClaudeCode, &commands).await;
    assert_eq!(
        claim(&store, &claude, HarnessKind::ClaudeCode, &unsandboxed).await,
        None
    );
    let waiting = store.diagnose_task_placement(&task).await.unwrap();
    assert_eq!(waiting.requirement, "file-scope");
    assert!(
        waiting
            .summary
            .contains("cannot keep commands from reading hidden paths (**/.env)"),
        "{}",
        waiting.summary
    );
    // Without commands the hook enforces the scope, so the same host claims the Task.
    let tools = scoped_task(
        &store,
        "claude-tools",
        HarnessKind::ClaudeCode,
        &["files:read", "files:write"],
    )
    .await;
    assert_eq!(
        store
            .diagnose_task_placement(&tools)
            .await
            .unwrap()
            .requirement,
        ""
    );
    assert_eq!(
        claim(&store, &claude, HarnessKind::ClaudeCode, &unsandboxed).await,
        Some(tools)
    );

    // Codex enforces hidden paths at the operating-system level.
    let codex = support::register_host(&store, "codex").await;
    let sandboxed = HarnessExecutionProfile::default();
    report(&store, &codex, HarnessKind::Codex, sandboxed.clone()).await;
    let task = scoped_task(&store, "codex-tag", HarnessKind::Codex, &commands).await;
    assert_eq!(
        store
            .diagnose_task_placement(&task)
            .await
            .unwrap()
            .requirement,
        ""
    );
    assert_eq!(
        claim(&store, &codex, HarnessKind::Codex, &sandboxed).await,
        Some(task)
    );
    // With web:fetch too: the network grant lives on the same permission profile.
    let task = scoped_task(
        &store,
        "codex-fetch",
        HarnessKind::Codex,
        &["files:read", "files:write", "commands:execute", "web:fetch"],
    )
    .await;
    assert_eq!(
        store
            .diagnose_task_placement(&task)
            .await
            .unwrap()
            .requirement,
        ""
    );
    assert_eq!(
        claim(&store, &codex, HarnessKind::Codex, &sandboxed).await,
        Some(task)
    );

    // Local Cursor refuses any scope; the reason depends on the host, so explain reports it
    // when no bound host's Cursor lane can apply it.
    let cursor = support::register_host(&store, "cursor").await;
    report(&store, &cursor, HarnessKind::Cursor, sandboxed.clone()).await;
    let task = scoped_task(&store, "cursor-tag", HarnessKind::Cursor, &["files:read"]).await;
    assert_eq!(
        claim(&store, &cursor, HarnessKind::Cursor, &sandboxed).await,
        None
    );
    let waiting = store.diagnose_task_placement(&task).await.unwrap();
    assert_eq!(waiting.requirement, "file-scope");
    assert!(
        waiting.summary.contains("local tools"),
        "{}",
        waiting.summary
    );

    // explain also names a harness's unsandboxed commands when no bound host allows them.
    let opencode = support::register_host(&store, "opencode").await;
    report(&store, &opencode, HarnessKind::Opencode, sandboxed.clone()).await;
    store
        .put_tag_spec(PutTagRequest {
            tag_id: "opencode-tag".into(),
            instructions: "Run tests".into(),
            allowed_actions: strings(&commands),
            harness_kind: HarnessKind::Opencode.into(),
            ..Default::default()
        })
        .await
        .unwrap();
    let task = store
        .submit_task(
            OP,
            &SubmitTaskRequest {
                tag_id: "opencode-tag".into(),
                session_id: "tests".into(),
                operation_id: "opencode-tests".into(),
                prompt: "Run tests".into(),
                ..Default::default()
            },
        )
        .await
        .unwrap()
        .task_id;
    let waiting = store.diagnose_task_placement(&task).await.unwrap();
    assert_eq!(waiting.requirement, "unsandboxed-commands");
    assert!(
        waiting
            .summary
            .contains("add opencode to allow-unsandboxed-commands"),
        "{}",
        waiting.summary
    );
    store.close().await;
}

#[tokio::test]
async fn sqlite_file_scope_placement_contract() {
    let directory = tempfile::tempdir().unwrap();
    contract(&format!(
        "sqlite://{}?mode=rwc",
        directory.path().join("placement.db").display()
    ))
    .await;
}

#[tokio::test]
#[ignore = "requires SUPERTAG_RUST_TEST_POSTGRES_URL_FILE for a dedicated PostgreSQL test server"]
async fn postgres_file_scope_placement_contract() {
    let path = std::env::var_os("SUPERTAG_RUST_TEST_POSTGRES_URL_FILE")
        .expect("PostgreSQL test URL file required");
    let admin_url = std::fs::read_to_string(path).unwrap();
    let name = format!("supertag_file_scope_{}", Uuid::new_v4().simple());
    let mut admin = sqlx::PgConnection::connect(admin_url.trim()).await.unwrap();
    admin
        .execute(format!("CREATE DATABASE {name}").as_str())
        .await
        .unwrap();
    let mut url = url::Url::parse(admin_url.trim()).unwrap();
    url.set_path(&name);
    let outcome = tokio::task::LocalSet::new()
        .run_until(async move {
            tokio::task::spawn_local(async move { contract(url.as_str()).await }).await
        })
        .await;
    admin
        .execute(format!("DROP DATABASE {name} WITH (FORCE)").as_str())
        .await
        .unwrap();
    admin.close().await.unwrap();
    outcome.expect("PostgreSQL file scope placement contract failed");
}
