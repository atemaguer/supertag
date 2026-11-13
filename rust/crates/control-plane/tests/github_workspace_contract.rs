mod support;

use sqlx::{Connection, Executor};
use supertag_control_plane::{Store, StoreError};
use supertag_protocol::v2::*;
use uuid::Uuid;

const OP: &str = "operator:github-workspace";
const BASE: &str = "1111111111111111111111111111111111111111";

fn catalog() -> PutGithubWorkspaceRequest {
    PutGithubWorkspaceRequest {
        operation_id: "create-source".into(),
        workspace: Some(GithubWorkspace {
            pull_request: None,
            workspace_id: "project".into(),
            source: Some(GithubWorkspaceSource {
                account_id: "github-account".into(),
                repository_id: 123,
                repository: "acme/project".into(),
                commit_sha: BASE.into(),
                ..Default::default()
            }),
            revision: 0,
        }),
        expected_revision: None,
    }
}

fn submit(operation: &str, session: &str) -> SubmitTaskRequest {
    SubmitTaskRequest {
        output_policy: None,
        tag_id: "engineer".into(),
        session_id: session.into(),
        operation_id: operation.into(),
        prompt: "Read the pinned repository".into(),
        execution_limits: None,
        input_artifacts: vec![],
    }
}

async fn version39(url: &str) {
    sqlx::any::install_default_drivers();
    let pool = sqlx::AnyPool::connect(url).await.unwrap();
    let backend = if url.starts_with("sqlite:") {
        "sqlite"
    } else {
        "postgresql"
    };
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("migrations")
        .join(backend);
    let mut paths: Vec<_> = std::fs::read_dir(root)
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .filter(|path| {
            path.file_name()
                .unwrap()
                .to_str()
                .unwrap()
                .get(..4)
                .and_then(|value| value.parse::<u32>().ok())
                .is_some_and(|value| value <= 39)
        })
        .collect();
    paths.sort();
    assert_eq!(paths.len(), 39);
    let mut tx = pool.begin().await.unwrap();
    for path in paths {
        sqlx::raw_sql(&std::fs::read_to_string(path).unwrap())
            .execute(&mut *tx)
            .await
            .unwrap();
    }
    sqlx::raw_sql("INSERT INTO supertag_v2_tags(tag_id,instructions,allowed_actions,revision) VALUES ('historical','Old policy','[]',1);
    INSERT INTO supertag_v2_tasks(task_id,tag_id,session_id,prompt,instructions,allowed_actions,tag_revision,state,accepted_order,workspace_id,workspace_base_commit) VALUES ('historical-task','historical','old','Original work','Old policy','[]',1,1,1,'local-source','1111111111111111111111111111111111111111');
    INSERT INTO supertag_v2_claims(principal,operation_id,task_id,attempt_id,lease_token) VALUES('host:historical','old-claim','historical-task','old-attempt','old-lease');
    UPDATE supertag_v2_write_order SET revision=1 WHERE singleton=1;").execute(&mut *tx).await.unwrap();
    tx.commit().await.unwrap();
    pool.close().await;
}

async fn contract(url: String) {
    version39(&url).await;
    let store = Store::open(&url).await.unwrap();
    let historical = store.get_task("historical-task").await.unwrap();
    assert_eq!(historical.prompt, "Original work");
    assert!(
        historical
            .workspace
            .as_ref()
            .unwrap()
            .github_source
            .is_none()
    );
    let pool = sqlx::AnyPool::connect(&url).await.unwrap();
    let prior_scope: String = sqlx::query_scalar(
        "SELECT gateway_workspace_scope FROM supertag_v2_claims WHERE operation_id='old-claim'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(prior_scope, "[]");
    pool.close().await;
    let local_host = support::register_host(&store, "local").await;
    assert!(
        store
            .claim_task_with_sources(
                &local_host,
                "gateway-cannot-serve-local",
                (&[], &["local-source".into()]),
                HarnessKind::Unspecified,
                &[],
                None
            )
            .await
            .unwrap()
            .is_none()
    );
    assert_eq!(
        store
            .claim_task_with_workspaces(&local_host, "local-source", &["local-source".into()])
            .await
            .unwrap()
            .unwrap()
            .task
            .unwrap()
            .task_id,
        historical.task_id
    );
    store.cancel_task(&historical.task_id).await.unwrap();
    let create = catalog();
    assert!(store.put_github_workspace(OP, &create).await.is_err());
    store
        .put_surface_account(
            OP,
            &PutSurfaceAccountRequest {
                operation_id: "account".into(),
                account: Some(SurfaceAccount {
                    account_id: "github-account".into(),
                    identity: Some(SurfaceAccountIdentity {
                        provider: Some(surface_account_identity::Provider::Github(
                            GithubSurfaceIdentity {
                                external_account_id: "installation:42".into(),
                            },
                        )),
                    }),
                    enabled: true,
                    gateway: "local".into(),
                    ..Default::default()
                }),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert!(matches!(
        store.put_github_workspace("host:attacker", &create).await,
        Err(StoreError::PermissionDenied)
    ));
    let (a, b) = tokio::join!(
        store.put_github_workspace(OP, &create),
        store.put_github_workspace(OP, &create)
    );
    let accepted = a.unwrap();
    assert_eq!(accepted, b.unwrap());
    assert_eq!(accepted.revision, 1);
    let mut changed = create.clone();
    changed
        .workspace
        .as_mut()
        .unwrap()
        .source
        .as_mut()
        .unwrap()
        .repository_id = 124;
    assert!(matches!(
        store.put_github_workspace(OP, &changed).await,
        Err(StoreError::Conflict(_))
    ));
    let tag = PutTagRequest {
        tag_id: "engineer".into(),
        instructions: "Read only".into(),
        allowed_actions: vec!["files:read".into()],
        workspace: Some(WorkspaceSpec {
            mcp_servers: vec![],
            mounts: vec![],
            workspace_id: "project".into(),
            base_commit: BASE.into(),
            github_source: None,
        }),
        ..Default::default()
    };
    store.put_tag_spec(tag.clone()).await.unwrap();
    let mut forged = tag.clone();
    forged.workspace.as_mut().unwrap().github_source = Some(accepted.clone());
    assert!(matches!(
        store.put_tag_spec(forged).await,
        Err(StoreError::InvalidArgument(_))
    ));
    // Local file permission is not authority to retrieve a private GitHub source.
    assert!(matches!(
        store.submit_task(OP, &submit("ungranted", "work")).await,
        Err(StoreError::PermissionDenied)
    ));
    let permissions = store
        .put_permission_set(
            OP,
            &PutPermissionSetRequest {
                operation_id: "source-permission".into(),
                permission_set: Some(PermissionSet {
                    set_id: "source-read".into(),
                    name: "source-read".into(),
                    permissions: vec![PolicyPermission {
                        target: PolicyPermissionTarget::Surface as i32,
                        surface_account_id: "github-account".into(),
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
                operation_id: "source-role".into(),
                role: Some(Role {
                    role_id: "reader".into(),
                    name: "reader".into(),
                    purpose: "Read the permitted repository".into(),
                    permission_set_ids: vec![permissions.set_id.clone()],
                    status: RoleStatus::Active as i32,
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
                operation_id: "assign-reader".into(),
                role: "reader".into(),
                tag_id: "engineer".into(),
            },
        )
        .await
        .unwrap();
    let task = store
        .submit_task(OP, &submit("accepted", "work"))
        .await
        .unwrap();
    assert_eq!(
        task.workspace.as_ref().unwrap().github_source,
        Some(accepted.clone())
    );
    let mut gated = permissions.clone();
    gated.permissions[0].approval_required = true;
    store
        .put_permission_set(
            OP,
            &PutPermissionSetRequest {
                operation_id: "gate-source".into(),
                permission_set: Some(gated),
                expected_revision: Some(permissions.revision),
            },
        )
        .await
        .unwrap();
    assert!(matches!(
        store
            .submit_task(OP, &submit("gated-source", "needs-approval"))
            .await,
        Err(StoreError::FailedPrecondition(_))
    ));
    // The already accepted Task keeps its original allowed source read.
    let host = support::register_host(&store, "worker").await;
    assert!(
        store
            .claim_task(&host, "without-source")
            .await
            .unwrap()
            .is_none()
    );
    let claimed = store
        .claim_task_with_sources(
            &host,
            "with-source",
            (&[], &["project".into()]),
            HarnessKind::Unspecified,
            &[],
            None,
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(claimed.task.as_ref().unwrap().task_id, task.task_id);
    assert_eq!(
        store
            .claim_task_with_sources(
                &host,
                "with-source",
                (&[], &["project".into()]),
                HarnessKind::Unspecified,
                &[],
                None
            )
            .await
            .unwrap(),
        Some(claimed.clone())
    );
    assert!(matches!(
        store
            .claim_task_with_workspaces(&host, "with-source", &["project".into()])
            .await,
        Err(StoreError::Conflict(_))
    ));
    let attempt = InspectAttemptRequest {
        task_id: task.task_id.clone(),
        attempt_id: claimed.attempt_id,
        lease_token: claimed.lease_token,
    };
    assert!(matches!(
        store.get_github_workspace_source(&host, &attempt).await,
        Err(StoreError::FailedPrecondition(_))
    ));
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
    assert_eq!(
        store
            .get_github_workspace_source(&host, &attempt)
            .await
            .unwrap(),
        accepted
    );
    let other = support::register_host(&store, "other").await;
    assert!(
        store
            .get_github_workspace_source(&other, &attempt)
            .await
            .is_err()
    );
    let mut wrong = attempt.clone();
    wrong.lease_token = "wrong".into();
    assert!(
        store
            .get_github_workspace_source(&host, &wrong)
            .await
            .is_err()
    );
    // A later catalog change cannot redirect an already accepted source.
    changed.operation_id = "source-update".into();
    changed.expected_revision = Some(accepted.revision);
    changed
        .workspace
        .as_mut()
        .unwrap()
        .source
        .as_mut()
        .unwrap()
        .repository = "acme/other".into();
    let updated = store.put_github_workspace(OP, &changed).await.unwrap();
    assert_eq!(updated.revision, 2);
    assert_eq!(
        store
            .get_github_workspace_source(&host, &attempt)
            .await
            .unwrap(),
        accepted
    );
    assert!(matches!(
        store
            .submit_task(OP, &submit("changed-authority", "other-work"))
            .await,
        Err(StoreError::PermissionDenied)
    ));
    assert_eq!(
        store.put_github_workspace(OP, &create).await.unwrap(),
        accepted
    );
    let delete = DeleteGithubWorkspaceRequest {
        operation_id: "delete".into(),
        workspace_id: "project".into(),
        expected_revision: updated.revision,
    };
    assert!(matches!(
        store.delete_github_workspace(OP, &delete).await,
        Err(StoreError::FailedPrecondition(_))
    ));
    let mut unbound = tag;
    unbound.workspace = None;
    store.put_tag_spec(unbound).await.unwrap();
    store.delete_github_workspace(OP, &delete).await.unwrap();
    // Historical source authority is immutable and does not need a mutable catalog row.
    drop(store);
    let store = Store::open(&url).await.unwrap();
    assert_eq!(
        store
            .get_github_workspace_source(&host, &attempt)
            .await
            .unwrap(),
        accepted
    );
    store.cancel_task(&task.task_id).await.unwrap();
    assert!(matches!(
        store.get_github_workspace_source(&host, &attempt).await,
        Err(StoreError::FailedPrecondition(_))
    ));
}

#[tokio::test]
async fn sqlite_github_workspace_contract() {
    let directory = tempfile::tempdir().unwrap();
    contract(format!(
        "sqlite://{}?mode=rwc",
        directory.path().join("state.db").display()
    ))
    .await;
}

#[tokio::test]
#[ignore = "requires dedicated PostgreSQL server"]
async fn postgres_github_workspace_contract() {
    let file =
        std::env::var_os("SUPERTAG_RUST_TEST_POSTGRES_URL_FILE").expect("test database file");
    let admin_url = std::fs::read_to_string(file).unwrap();
    let mut url = url::Url::parse(admin_url.trim()).unwrap();
    let database = format!("supertag_github_workspace_{}", Uuid::new_v4().simple());
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
