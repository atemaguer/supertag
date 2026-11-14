//! A Tag whose local Workspace follows a branch: each new Session resolves it once, on the host
//! running its first Attempt, and every Task of the Session keeps the recorded commit.
mod support;

use sqlx::{Connection, Executor};
use supertag_control_plane::{HostAuthority, Store, StoreError};
use supertag_protocol::v2::*;
use uuid::Uuid;

const OPERATOR: &str = "operator:workspace-ref-test";
const REPOSITORY: &str = "project";
const FIRST: &str = "1111111111111111111111111111111111111111";
const MOVED: &str = "2222222222222222222222222222222222222222";

fn following(branch: &str) -> WorkspaceSpec {
    WorkspaceSpec {
        workspace_id: REPOSITORY.into(),
        base_ref: branch.into(),
        ..Default::default()
    }
}

async fn put(store: &Store, workspace: WorkspaceSpec) -> Result<Tag, StoreError> {
    store
        .put_tag_spec(PutTagRequest {
            tag_id: "engineer".into(),
            instructions: "Change the repository".into(),
            workspace: Some(workspace),
            ..Default::default()
        })
        .await
}

async fn submit(store: &Store, session_id: &str) -> Result<Task, StoreError> {
    store
        .submit_task(
            OPERATOR,
            &SubmitTaskRequest {
                tag_id: "engineer".into(),
                session_id: session_id.into(),
                operation_id: Uuid::new_v4().to_string(),
                prompt: "Change the repository".into(),
                ..Default::default()
            },
        )
        .await
}

async fn start(store: &Store, host: &HostAuthority, expected: &str) -> InspectAttemptRequest {
    let assignment = store
        .claim_task_with_workspaces(host, &Uuid::new_v4().to_string(), &[REPOSITORY.into()])
        .await
        .unwrap()
        .unwrap_or_else(|| panic!("no claim for {expected}"));
    assert_eq!(assignment.task.unwrap().task_id, expected);
    let attempt = InspectAttemptRequest {
        task_id: expected.into(),
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

fn resolve(attempt: &InspectAttemptRequest, commit: &str) -> ResolveWorkspaceRefRequest {
    ResolveWorkspaceRefRequest {
        attempt: Some(attempt.clone()),
        base_commit: commit.into(),
    }
}

fn base(task: &Task) -> &str {
    &task.workspace.as_ref().unwrap().base_commit
}

async fn exercise(url: &str) {
    let store = Store::open(url).await.unwrap();
    let host = support::register_host(&store, "primary").await;
    let other = support::register_host(&store, "secondary").await;

    // A Workspace pins a commit or follows a branch, never both, and only a branch name counts.
    let both = WorkspaceSpec {
        base_commit: FIRST.into(),
        ..following("main")
    };
    assert!(matches!(
        put(&store, both).await,
        Err(StoreError::InvalidArgument(message)) if message.contains("not both")
    ));
    for invalid in ["refs/heads/main", "-main", "a..b", FIRST] {
        assert!(
            matches!(
                put(&store, following(invalid)).await,
                Err(StoreError::InvalidArgument(_))
            ),
            "{invalid}"
        );
    }
    assert!(matches!(
        put(&store, following("")).await,
        Err(StoreError::InvalidArgument(message)) if message.contains("branch to follow")
    ));

    let tag = put(&store, following("main")).await.unwrap();
    assert_eq!(tag.workspace, Some(following("main")));
    assert_eq!(
        store.get_tag("engineer").await.unwrap().workspace,
        Some(following("main"))
    );

    // Admission records the branch and leaves the commit for the Session's first Attempt.
    let first = submit(&store, "alpha").await.unwrap();
    let queued = submit(&store, "alpha").await.unwrap();
    assert_eq!(first.workspace, Some(following("main")));
    assert_eq!(queued.workspace, Some(following("main")));

    let attempt = start(&store, &host, &first.task_id).await;
    assert!(matches!(
        store
            .resolve_workspace_ref(&host, &resolve(&attempt, "main"))
            .await,
        Err(StoreError::InvalidArgument(_))
    ));
    assert!(matches!(
        store
            .resolve_workspace_ref(&other, &resolve(&attempt, FIRST))
            .await,
        Err(StoreError::PermissionDenied)
    ));
    let resolved = store
        .resolve_workspace_ref(&host, &resolve(&attempt, FIRST))
        .await
        .unwrap();
    assert_eq!(base(&resolved), FIRST);
    assert_eq!(resolved.workspace.as_ref().unwrap().base_ref, "main");
    // The first resolution wins: a repeated report after the branch moved changes nothing.
    let repeated = store
        .resolve_workspace_ref(&host, &resolve(&attempt, MOVED))
        .await
        .unwrap();
    assert_eq!(base(&repeated), FIRST);
    // A queued Task of the Session, and one admitted later, keep the Session's commit.
    assert_eq!(base(&store.get_task(&queued.task_id).await.unwrap()), FIRST);
    let later = submit(&store, "alpha").await.unwrap();
    assert_eq!(base(&later), FIRST);
    assert_eq!(later.workspace.as_ref().unwrap().base_ref, "main");

    // Another Session resolves the branch anew.
    let fresh = submit(&store, "beta").await.unwrap();
    assert_eq!(fresh.workspace, Some(following("main")));

    // A pinned Task has nothing to resolve.
    store.cancel_task(&first.task_id).await.unwrap();
    store.cancel_task(&queued.task_id).await.unwrap();
    store.cancel_task(&later.task_id).await.unwrap();
    store.cancel_task(&fresh.task_id).await.unwrap();
    let pinned = WorkspaceSpec {
        workspace_id: REPOSITORY.into(),
        base_commit: MOVED.into(),
        ..Default::default()
    };
    put(&store, pinned.clone()).await.unwrap();
    // Switching from a branch to a pinned commit needs a new Session.
    assert!(matches!(
        submit(&store, "alpha").await,
        Err(StoreError::FailedPrecondition(_))
    ));
    let task = submit(&store, "gamma").await.unwrap();
    assert_eq!(task.workspace, Some(pinned));
    let attempt = start(&store, &other, &task.task_id).await;
    assert!(matches!(
        store
            .resolve_workspace_ref(&other, &resolve(&attempt, FIRST))
            .await,
        Err(StoreError::FailedPrecondition(_))
    ));
    store.close().await;
}

#[tokio::test]
async fn sqlite_workspace_ref_contract() {
    exercise("sqlite::memory:").await;
}

#[tokio::test]
#[ignore = "requires SUPERTAG_RUST_TEST_POSTGRES_URL_FILE for a dedicated PostgreSQL test server"]
async fn postgres_workspace_ref_contract() {
    let path = std::env::var_os("SUPERTAG_RUST_TEST_POSTGRES_URL_FILE")
        .expect("PostgreSQL test URL file required");
    let admin_url = std::fs::read_to_string(path).unwrap();
    let database = format!("supertag_rust_workspace_ref_{}", Uuid::new_v4().simple());
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
