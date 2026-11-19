//! Path scopes through delegated work: when an Objective's owner starts a work Session for a
//! Team member, the member's Task writes only the member's own write paths and outside write
//! directories, hides and keeps read-only the union of both Tags' entries, and reads only the
//! outside directories both Tags may read.

mod support;

use sqlx::{Connection, Executor};
use supertag_control_plane::{HostAuthority, Store};
use supertag_protocol::v2::*;
use uuid::Uuid;

const OP: &str = "operator:alice";

fn strings(values: &[&str]) -> Vec<String> {
    values.iter().map(|value| (*value).to_owned()).collect()
}

fn read(exclude: &[&str], outside: &[&str]) -> PolicyPermission {
    PolicyPermission {
        target: PolicyPermissionTarget::Runtime.into(),
        action: "files:read".into(),
        exclude: strings(exclude),
        additional_directories: strings(outside),
        ..Default::default()
    }
}

/// A Tag on `harness` with direct `actions` and a Role holding one Permission Set with `scope`.
async fn scoped_tag(
    store: &Store,
    tag: &str,
    harness: HarnessKind,
    actions: &[&str],
    scope: Vec<PolicyPermission>,
) {
    store
        .put_tag_spec(PutTagRequest {
            tag_id: tag.into(),
            instructions: format!("{tag} instructions"),
            allowed_actions: strings(actions),
            harness_kind: harness.into(),
            ..Default::default()
        })
        .await
        .unwrap();
    if scope.is_empty() {
        return;
    }
    store
        .put_permission_set(
            OP,
            &PutPermissionSetRequest {
                operation_id: format!("{tag}-set"),
                permission_set: Some(PermissionSet {
                    set_id: format!("{tag}-scope"),
                    name: format!("{tag}-scope"),
                    permissions: scope,
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
                operation_id: format!("{tag}-role"),
                role: Some(Role {
                    role_id: format!("{tag}-role"),
                    name: format!("{tag}-role"),
                    purpose: "Scope file access".into(),
                    permission_set_ids: vec![format!("{tag}-scope")],
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
            OP,
            &AssignRoleRequest {
                operation_id: format!("{tag}-assign"),
                role: format!("{tag}-role"),
                tag_id: tag.into(),
            },
        )
        .await
        .unwrap();
}

async fn run(store: &Store, host: &HostAuthority, task_id: &str) -> InspectAttemptRequest {
    let claim = store
        .claim_task_with_profile(
            host,
            &Uuid::new_v4().to_string(),
            &[],
            HarnessKind::Codex,
            &[],
            None,
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(claim.task.unwrap().task_id, task_id);
    let attempt = InspectAttemptRequest {
        task_id: task_id.into(),
        attempt_id: claim.attempt_id,
        lease_token: claim.lease_token,
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

/// Start an Objective owned by `owner` with `member` on its Team, run its starting Task, and
/// delegate a work Session to `member`; return the member's Task scope.
async fn delegated_scope(
    store: &Store,
    host: &HostAuthority,
    owner: &str,
    member: &str,
) -> Option<FileScope> {
    let team = store
        .create_team(
            OP,
            &CreateTeamRequest {
                operation_id: format!("{owner}-{member}-team"),
                team_id: format!("{owner}-{member}-team"),
                name: format!("{owner} {member} team"),
                member_tag_ids: strings(&[owner, member]),
                max_concurrency: Some(2),
            },
        )
        .await
        .unwrap();
    let objective = store
        .create_objective(
            OP,
            &CreateObjectiveRequest {
                operation_id: format!("{owner}-{member}-objective"),
                objective_id: format!("{owner}-{member}-objective"),
                owner_tag_id: owner.into(),
                outcome: "Change the code".into(),
                ongoing: true,
                team_id: Some(team.team_id),
                runtime_actions: Some(RuntimeActions {
                    actions: strings(&["files:read", "files:delegate-write"]),
                }),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    let attempt = run(store, host, &objective.starting_task_id).await;
    let work = store
        .start_work_session(
            &supertag_control_plane::AttemptAccess::new(host, &attempt),
            &StartWorkSessionRequest {
                operation_id: format!("{owner}-{member}-delegate"),
                title: "Change the code".into(),
                instruction: "Edit src".into(),
                target_tag_id: Some(member.into()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    let task = store.get_task(&work.latest_task_id).await.unwrap();
    assert_eq!(task.allowed_actions, ["files:read", "files:write"]);
    task.policy_snapshot
        .and_then(|snapshot| snapshot.runtime_authority)
        .and_then(|authority| authority.files)
}

async fn contract(url: &str) {
    let store = Store::open(url).await.unwrap();
    let owner_actions = ["files:read", "files:delegate-write", "commands:execute"];
    scoped_tag(
        &store,
        "owner",
        HarnessKind::Codex,
        &owner_actions,
        vec![read(&["secrets/"], &["/opt/shared", "/opt/owner-only"])],
    )
    .await;
    scoped_tag(
        &store,
        "plain-owner",
        HarnessKind::Codex,
        &owner_actions,
        vec![],
    )
    .await;
    // The member's write paths come from its Permission Set; a direct files:write on the Tag
    // stays whole-Workspace.
    let member_scope = || {
        vec![
            PolicyPermission {
                target: PolicyPermissionTarget::Runtime.into(),
                action: "files:write".into(),
                paths: strings(&["src/"]),
                exclude: strings(&["src/generated/"]),
                additional_directories: strings(&["/opt/cache"]),
                ..Default::default()
            },
            read(&["**/.env"], &["/opt/shared", "/opt/member-only"]),
        ]
    };
    scoped_tag(
        &store,
        "builder",
        HarnessKind::ClaudeCode,
        &["files:read"],
        member_scope(),
    )
    .await;
    scoped_tag(
        &store,
        "direct-builder",
        HarnessKind::ClaudeCode,
        &["files:read", "files:write"],
        member_scope(),
    )
    .await;
    let host = support::register_host(&store, "delegation-host").await;

    // The member writes only its own paths; hidden and read-only entries are the union of both
    // Tags'; outside reads are the intersection.
    assert_eq!(
        delegated_scope(&store, &host, "owner", "builder").await,
        Some(FileScope {
            write: strings(&["src/"]),
            read_only: strings(&["src/generated/"]),
            hidden: strings(&["**/.env", "secrets/"]),
            outside_write: strings(&["/opt/cache"]),
            outside_read: strings(&["/opt/shared"]),
        })
    );
    // An unscoped owner adds no entries and, reading no outside directory, leaves the member
    // none to read.
    assert_eq!(
        delegated_scope(&store, &host, "plain-owner", "builder").await,
        Some(FileScope {
            write: strings(&["src/"]),
            read_only: strings(&["src/generated/"]),
            hidden: strings(&["**/.env"]),
            outside_write: strings(&["/opt/cache"]),
            outside_read: vec![],
        })
    );
    // A member whose Tag grants files:write directly writes the whole Workspace, but the
    // delegator's hidden entries still apply.
    assert_eq!(
        delegated_scope(&store, &host, "owner", "direct-builder").await,
        Some(FileScope {
            write: vec![],
            read_only: strings(&["src/generated/"]),
            hidden: strings(&["**/.env", "secrets/"]),
            outside_write: strings(&["/opt/cache"]),
            outside_read: strings(&["/opt/shared"]),
        })
    );
    store.close().await;
}

#[tokio::test]
async fn sqlite_file_scope_delegation() {
    let dir = tempfile::tempdir().unwrap();
    contract(&format!(
        "sqlite://{}?mode=rwc",
        dir.path().join("scope-delegation.db").display()
    ))
    .await;
}

#[tokio::test]
#[ignore = "requires SUPERTAG_RUST_TEST_POSTGRES_URL_FILE for a dedicated PostgreSQL test server"]
async fn postgres_file_scope_delegation() {
    let file = std::env::var_os("SUPERTAG_RUST_TEST_POSTGRES_URL_FILE").expect("URL file");
    let admin_url = std::fs::read_to_string(file).unwrap();
    let mut url = url::Url::parse(admin_url.trim()).unwrap();
    let database = format!("supertag_scope_delegation_{}", Uuid::new_v4().simple());
    let mut admin = sqlx::PgConnection::connect(admin_url.trim()).await.unwrap();
    admin
        .execute(format!("CREATE DATABASE {database}").as_str())
        .await
        .unwrap();
    url.set_path(&database);
    let result = tokio::task::LocalSet::new()
        .run_until(async move {
            tokio::task::spawn_local(async move { contract(url.as_str()).await }).await
        })
        .await;
    admin
        .execute(format!("DROP DATABASE {database} WITH (FORCE)").as_str())
        .await
        .unwrap();
    admin.close().await.unwrap();
    result.unwrap();
}
