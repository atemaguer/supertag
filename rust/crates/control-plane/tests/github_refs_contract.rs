mod support;

use sqlx::{Connection, Executor};
use supertag_control_plane::{Store, StoreError};
use supertag_protocol::v2::*;
use uuid::Uuid;

const OP: &str = "operator:refs";
const READER: &str = "source:github/account";
const SHA: &str = "1111111111111111111111111111111111111111";

async fn setup(store: &Store) {
    store
        .put_surface_account(
            OP,
            &PutSurfaceAccountRequest {
                operation_id: "account".into(),
                account: Some(SurfaceAccount {
                    account_id: "account".into(),
                    enabled: true,
                    identity: Some(SurfaceAccountIdentity {
                        provider: Some(surface_account_identity::Provider::Github(
                            GithubSurfaceIdentity {
                                external_account_id: "installation:42".into(),
                            },
                        )),
                    }),
                    gateway: "local".into(),
                    ..Default::default()
                }),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    store
        .put_github_workspace(
            OP,
            &PutGithubWorkspaceRequest {
                operation_id: "source".into(),
                workspace: Some(GithubWorkspace {
                    workspace_id: "project".into(),
                    source: Some(GithubWorkspaceSource {
                        account_id: "account".into(),
                        repository_id: 123,
                        repository: "acme/project".into(),
                        revision: Some("release/stable".into()),
                        ..Default::default()
                    }),
                    ..Default::default()
                }),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    store
        .put_tag_spec(PutTagRequest {
            tag_id: "engineer".into(),
            instructions: "Read the accepted source".into(),
            allowed_actions: vec!["files:read".into()],
            workspace: Some(WorkspaceSpec {
                workspace_id: "project".into(),
                ..Default::default()
            }),
            ..Default::default()
        })
        .await
        .unwrap();
    store
        .put_permission_set(
            OP,
            &PutPermissionSetRequest {
                operation_id: "permission".into(),
                permission_set: Some(PermissionSet {
                    set_id: "read-source".into(),
                    name: "Read source".into(),
                    permissions: vec![PolicyPermission {
                        target: PolicyPermissionTarget::Surface as i32,
                        surface_account_id: "account".into(),
                        scope: "repository:123".into(),
                        action: "contents:read".into(),
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
                operation_id: "role".into(),
                role: Some(Role {
                    role_id: "reader".into(),
                    name: "Reader".into(),
                    purpose: "Read source".into(),
                    status: RoleStatus::Active as i32,
                    permission_set_ids: vec!["read-source".into()],
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
                operation_id: "assign".into(),
                tag_id: "engineer".into(),
                role: "reader".into(),
            },
        )
        .await
        .unwrap();
}
fn submit(operation: &str, session: &str) -> SubmitTaskRequest {
    SubmitTaskRequest {
        tag_id: "engineer".into(),
        session_id: session.into(),
        operation_id: operation.into(),
        prompt: "Read repository".into(),
        ..Default::default()
    }
}
async fn contract(url: String) {
    let store = Store::open(&url).await.unwrap();
    assert!(matches!(
        store
            .put_tag_spec(PutTagRequest {
                tag_id: "unconfigured".into(),
                workspace: Some(WorkspaceSpec {
                    workspace_id: "local".into(),
                    ..Default::default()
                }),
                ..Default::default()
            })
            .await,
        Err(StoreError::InvalidArgument(_))
    ));
    setup(&store).await;
    let host = support::register_host(&store, "refs").await;
    let first = store
        .submit_task(OP, &submit("first", "session"))
        .await
        .unwrap();
    let second = store
        .submit_task(OP, &submit("second", "session"))
        .await
        .unwrap();
    assert!(first.workspace.as_ref().unwrap().base_commit.is_empty());
    assert!(
        store
            .claim_task_with_sources(
                &host,
                "pending",
                (&[], &["project".into()]),
                HarnessKind::Unspecified,
                &[],
                None
            )
            .await
            .unwrap()
            .is_none()
    );
    assert!(matches!(
        store
            .list_pending_github_sources(
                "operator:refs",
                &ListPendingGithubSourcesRequest::default()
            )
            .await,
        Err(StoreError::PermissionDenied)
    ));
    assert!(
        store
            .list_pending_github_sources(
                "source:github/other",
                &ListPendingGithubSourcesRequest::default()
            )
            .await
            .unwrap()
            .pins
            .is_empty()
    );
    let pins = store
        .list_pending_github_sources(READER, &ListPendingGithubSourcesRequest::default())
        .await
        .unwrap();
    assert_eq!(pins.pins.len(), 1);
    let pin = &pins.pins[0];
    assert_eq!(
        pin.selector
            .as_ref()
            .unwrap()
            .source
            .as_ref()
            .unwrap()
            .revision
            .as_deref(),
        Some("release/stable")
    );
    let input = PinGithubSourceRequest {
        pin_id: pin.pin_id.clone(),
        selector_digest: pin.selector_digest.clone(),
        resolved_revision: "release/stable".into(),
        commit_sha: SHA.into(),
    };
    let mut wrong = input.clone();
    wrong.selector_digest = "0".repeat(64);
    assert!(matches!(
        store.pin_github_source(READER, &wrong).await,
        Err(StoreError::Conflict(_))
    ));
    wrong = input.clone();
    wrong.resolved_revision = "other".into();
    assert!(store.pin_github_source(READER, &wrong).await.is_err());
    assert!(matches!(
        store.pin_github_source("source:github/other", &input).await,
        Err(StoreError::PermissionDenied)
    ));
    let (a, b) = tokio::join!(
        store.pin_github_source(READER, &input),
        store.pin_github_source(READER, &input)
    );
    let pinned = a.unwrap();
    assert_eq!(pinned, b.unwrap());
    for id in [&first.task_id, &second.task_id] {
        let workspace = store.get_task(id).await.unwrap().workspace.unwrap();
        assert_eq!(workspace.base_commit, SHA);
        let source = workspace.github_source.unwrap().source.unwrap();
        assert_eq!(source.commit_sha, SHA);
        assert_eq!(source.revision.as_deref(), Some("release/stable"));
    }
    // A competing reader may see a newer head; the first committed pin always wins.
    wrong = input.clone();
    wrong.commit_sha = "2".repeat(40);
    assert_eq!(
        store.pin_github_source(READER, &wrong).await.unwrap(),
        pinned
    );
    drop(store);
    let store = Store::open(&url).await.unwrap();
    assert_eq!(
        store.pin_github_source(READER, &input).await.unwrap(),
        pinned
    );
    let third = store
        .submit_task(OP, &submit("third", "session"))
        .await
        .unwrap();
    assert_eq!(third.workspace.unwrap().base_commit, SHA);
    assert!(
        store
            .list_pending_github_sources(READER, &ListPendingGithubSourcesRequest::default())
            .await
            .unwrap()
            .pins
            .is_empty()
    );
    assert!(
        store
            .claim_task_with_workspaces(&host, "local-cannot-serve-github", &["project".into()])
            .await
            .unwrap()
            .is_none()
    );
    let assignment = store
        .claim_task_with_sources(
            &host,
            "resolved",
            (&[], &["project".into()]),
            HarnessKind::Unspecified,
            &[],
            None,
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(assignment.task.unwrap().task_id, first.task_id);
    let another = store
        .submit_task(OP, &submit("new-session", "another"))
        .await
        .unwrap();
    assert!(another.workspace.unwrap().base_commit.is_empty());
    let pending = store
        .list_pending_github_sources(READER, &ListPendingGithubSourcesRequest::default())
        .await
        .unwrap();
    assert_eq!(pending.pins.len(), 1);
    assert_ne!(pending.pins[0].pin_id, pinned.pin_id);
    // Catalog changes cannot retarget an existing Session or its pending pin.
    let mut source = store
        .get_github_workspace(
            OP,
            &GetGithubWorkspaceRequest {
                workspace_id: "project".into(),
            },
        )
        .await
        .unwrap();
    let revision = source.revision;
    source.source.as_mut().unwrap().revision = Some("other".into());
    store
        .put_github_workspace(
            OP,
            &PutGithubWorkspaceRequest {
                operation_id: "change".into(),
                workspace: Some(source),
                expected_revision: Some(revision),
            },
        )
        .await
        .unwrap();
    assert!(matches!(
        store.submit_task(OP, &submit("retarget", "session")).await,
        Err(StoreError::FailedPrecondition(_))
    ));
    assert_eq!(
        store
            .list_pending_github_sources(READER, &ListPendingGithubSourcesRequest::default())
            .await
            .unwrap()
            .pins,
        pending.pins
    );
    let old = &pending.pins[0];
    let completed = store
        .pin_github_source(
            READER,
            &PinGithubSourceRequest {
                pin_id: old.pin_id.clone(),
                selector_digest: old.selector_digest.clone(),
                resolved_revision: "release/stable".into(),
                commit_sha: "3".repeat(40),
            },
        )
        .await
        .unwrap();
    assert_eq!(
        completed
            .selector
            .as_ref()
            .unwrap()
            .source
            .as_ref()
            .unwrap()
            .revision
            .as_deref(),
        Some("release/stable")
    );
    assert_eq!(
        store
            .get_task(&another.task_id)
            .await
            .unwrap()
            .workspace
            .unwrap()
            .base_commit,
        "3".repeat(40)
    );
}
#[tokio::test]
async fn sqlite_github_refs_contract() {
    let dir = tempfile::tempdir().unwrap();
    contract(format!(
        "sqlite://{}?mode=rwc",
        dir.path().join("state.db").display()
    ))
    .await;
}
#[tokio::test]
#[ignore = "requires dedicated PostgreSQL server"]
async fn postgres_github_refs_contract() {
    let admin_url = std::fs::read_to_string(
        std::env::var_os("SUPERTAG_RUST_TEST_POSTGRES_URL_FILE").expect("database file"),
    )
    .unwrap();
    let mut url = url::Url::parse(admin_url.trim()).unwrap();
    let database = format!("supertag_refs_{}", Uuid::new_v4().simple());
    let mut admin = sqlx::PgConnection::connect(admin_url.trim()).await.unwrap();
    admin
        .execute(format!("CREATE DATABASE {database}").as_str())
        .await
        .unwrap();
    url.set_path(&database);
    let result = tokio::task::LocalSet::new()
        .run_until(async move { tokio::task::spawn_local(contract(url.to_string())).await })
        .await;
    admin
        .execute(format!("DROP DATABASE {database} WITH (FORCE)").as_str())
        .await
        .unwrap();
    result.unwrap();
}
