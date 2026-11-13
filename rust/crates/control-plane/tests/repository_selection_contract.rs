//! A surface message selects one of its Tag's authorized GitHub Workspaces.
//! TypeScript parity: `captureWorkspacePlan` (`packages/control-plane/src/index.ts`),
//! `tests/e2e/permission-target-workspace.test.ts`, and
//! `packages/control-plane/repository-references.test.ts`.
mod support;

use sqlx::{Connection, Executor};
use supertag_control_plane::Store;
use supertag_protocol::v2::{
    surface_account_identity::Provider as Identity, surface_location_scope::Provider as Scope, *,
};
use uuid::Uuid;

const OPERATOR: &str = "operator:alice";
const SLACK: &str = "connector:slack-test";
const GITHUB: &str = "github-surface";
const PROJECT_BASE: &str = "1111111111111111111111111111111111111111";
const API_BASE: &str = "2222222222222222222222222222222222222222";

fn mention(sequence: u64, thread: u64, tag: &str, prompt: &str) -> AcceptSlackEventRequest {
    AcceptSlackEventRequest {
        account_id: "slack-test".into(),
        event_id: format!("event-{sequence}"),
        team_id: "TTEAM1".into(),
        channel_id: "CCHANNEL1".into(),
        message_ts: format!("1794470000.{sequence:06}"),
        thread_ts: format!("1794470000.{thread:06}"),
        prompt: prompt.into(),
        mention_tag_id: Some(tag.into()),
        actor_id: "UALICE1".into(),
    }
}

async fn slack(store: &Store, sequence: u64, thread: u64, prompt: &str) -> Task {
    store
        .accept_slack_event(SLACK, &mention(sequence, thread, "engineer", prompt))
        .await
        .unwrap()
        .task
        .unwrap()
}

async fn catalog(store: &Store, id: &str, repository_id: u64, repository: &str, commit: &str) {
    store
        .put_github_workspace(
            OPERATOR,
            &PutGithubWorkspaceRequest {
                operation_id: format!("workspace-{id}"),
                workspace: Some(GithubWorkspace {
                    workspace_id: id.into(),
                    source: Some(GithubWorkspaceSource {
                        account_id: GITHUB.into(),
                        repository_id,
                        repository: repository.into(),
                        commit_sha: commit.into(),
                        ..Default::default()
                    }),
                    ..Default::default()
                }),
                expected_revision: None,
            },
        )
        .await
        .unwrap();
}

async fn grant(store: &Store, repositories: &[u64], expected: Option<u64>) {
    store
        .put_permission_set(
            OPERATOR,
            &PutPermissionSetRequest {
                operation_id: format!("read-{repositories:?}-{expected:?}"),
                permission_set: Some(PermissionSet {
                    set_id: "source-read".into(),
                    name: "source-read".into(),
                    permissions: repositories
                        .iter()
                        .map(|id| PolicyPermission {
                            target: PolicyPermissionTarget::Surface as i32,
                            surface_account_id: GITHUB.into(),
                            scope: format!("repository:{id}"),
                            action: "contents:read".into(),
                            ..Default::default()
                        })
                        .collect(),
                    ..Default::default()
                }),
                expected_revision: expected,
            },
        )
        .await
        .unwrap();
}

fn selected(task: &Task) -> (Option<&str>, Option<&str>, Option<&str>) {
    (
        task.workspace
            .as_ref()
            .map(|workspace| workspace.workspace_id.as_str()),
        task.workspace
            .as_ref()
            .and_then(|workspace| workspace.github_source.as_ref())
            .and_then(|source| source.source.as_ref())
            .map(|source| source.commit_sha.as_str()),
        task.workspace_selection.as_deref(),
    )
}

async fn contract(url: String) {
    let store = Store::open(&url).await.unwrap();
    store
        .put_tag("engineer", "Answer questions", vec!["files:read".into()])
        .await
        .unwrap();
    // A GitHub Surface Account with a managed repository location for the origin case.
    store
        .put_surface_account(
            OPERATOR,
            &PutSurfaceAccountRequest {
                operation_id: "github-account".into(),
                account: Some(SurfaceAccount {
                    account_id: GITHUB.into(),
                    identity: Some(SurfaceAccountIdentity {
                        provider: Some(Identity::Github(GithubSurfaceIdentity {
                            external_account_id: "installation-12".into(),
                        })),
                    }),
                    enabled: true,
                    revision: 0,
                }),
                expected_revision: None,
            },
        )
        .await
        .unwrap();
    store
        .put_surface_location(
            OPERATOR,
            &PutSurfaceLocationRequest {
                operation_id: "github-location".into(),
                location: Some(SurfaceLocation {
                    location_id: GITHUB.into(),
                    account_id: GITHUB.into(),
                    connector_account_id: "github/surface".into(),
                    scope: Some(SurfaceLocationScope {
                        provider: Some(Scope::Github(GithubSurfaceRepository {
                            repository_id: 123,
                        })),
                    }),
                    tag_id: "engineer".into(),
                    enabled: true,
                    ..Default::default()
                }),
                expected_revision: None,
            },
        )
        .await
        .unwrap();
    catalog(&store, "project", 123, "acme/project", PROJECT_BASE).await;
    catalog(&store, "api", 124, "acme/api", API_BASE).await;

    // Without a read grant, a named repository fails before any execution, with the reason as
    // its surface reply. A path that only looks like a reference is ordinary text.
    let refused = slack(
        &store,
        1,
        1,
        "@SuperTag In acme/project, why does deployment create two release records?",
    )
    .await;
    assert_eq!(refused.state(), TaskState::Failed);
    assert_eq!(
        refused.result.as_deref(),
        Some("Tag engineer is not allowed to use GitHub repository acme/project")
    );
    assert_eq!(selected(&refused), (None, None, Some("refused")));
    let reply = store
        .claim_reply(SLACK, "refused-reply")
        .await
        .unwrap()
        .reply
        .unwrap();
    assert_eq!(reply.task_id, refused.task_id);
    assert_eq!(
        reply.text,
        "I ran into a problem while working on this: Tag engineer is not allowed to use GitHub repository acme/project"
    );
    let host = support::register_host(&store, "worker").await;
    assert!(
        store
            .claim_task(&host, "nothing-refused")
            .await
            .unwrap()
            .is_none()
    );
    let path = slack(&store, 2, 2, "Look at src/lib/index.ts and ./src").await;
    assert_eq!(path.state(), TaskState::Queued);
    assert_eq!(selected(&path), (None, None, None));

    // The only readable repository is the default; a later turn keeps it.
    grant(&store, &[123], None).await;
    store
        .put_role(
            OPERATOR,
            &PutRoleRequest {
                operation_id: "reader-role".into(),
                role: Some(Role {
                    role_id: "reader".into(),
                    name: "reader".into(),
                    purpose: "Read the permitted repositories".into(),
                    permission_set_ids: vec!["source-read".into()],
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
            OPERATOR,
            &AssignRoleRequest {
                operation_id: "assign-reader".into(),
                role: "reader".into(),
                tag_id: "engineer".into(),
            },
        )
        .await
        .unwrap();
    let default = slack(&store, 3, 3, "Why does deployment fail?").await;
    assert_eq!(
        selected(&default),
        (Some("project"), Some(PROJECT_BASE), Some("default"))
    );
    let later = slack(&store, 4, 3, "Thanks. Is acme/project the only one?").await;
    assert_eq!(selected(&later), selected(&default));
    // Once a repository is readable, a reference to another one runs the Task and asks the
    // requester to name one the Tag may read, as TypeScript's `selection-required` does.
    let other = slack(&store, 5, 5, "In acme/other, why?").await;
    assert_eq!(other.result, None);
    assert_eq!(selected(&other), (None, None, Some("required")));
    assert!(other.instructions.ends_with(
        "The request does not identify a GitHub repository. Ask the requester to name exactly one of: acme/project. Do not inspect or make claims about a repository until they do."
    ));

    // Two readable repositories: an unnamed one asks the requester to choose, and the answer in
    // the same thread selects it.
    grant(&store, &[123, 124], Some(1)).await;
    let ask = slack(&store, 6, 6, "Why does deployment fail?").await;
    assert_eq!(selected(&ask), (None, None, Some("required")));
    assert!(ask.instructions.ends_with(
        "The request does not identify a GitHub repository. Ask the requester to name exactly one of: acme/api, acme/project. Do not inspect or make claims about a repository until they do."
    ));
    let answered = slack(&store, 7, 6, "Use `Acme/API`, please.").await;
    assert_eq!(
        selected(&answered),
        (Some("api"), Some(API_BASE), Some("request"))
    );
    assert!(!answered.instructions.contains("does not identify"));
    let ambiguous = slack(&store, 8, 8, "see socket/socket.io and acme/api.").await;
    assert_eq!(selected(&ambiguous).2, Some("request"));
    assert_eq!(selected(&ambiguous).0, Some("api"));

    // A GitHub message works in its own repository, whatever else it names.
    let origin = store
        .accept_github_event(
            "connector:github/surface",
            &AcceptGithubEventRequest {
                account_id: "github/surface".into(),
                delivery_id: "delivery-1".into(),
                repository_id: 123,
                repository: "acme/project".into(),
                number: 7,
                source_id: 456,
                kind: GithubEventKind::IssueComment.into(),
                action: GithubEventAction::Created.into(),
                prompt: "Compare with acme/api".into(),
                tag_id: "engineer".into(),
                is_pull_request: false,
            },
        )
        .await
        .unwrap()
        .task
        .unwrap();
    assert_eq!(
        selected(&origin),
        (Some("project"), Some(PROJECT_BASE), Some("origin"))
    );

    // A revoked read stops a later turn of a selected Session instead of running without it.
    // The turn is accepted and fails at admission with the reason, so the surface replies rather
    // than retrying the message (TypeScript fails it at resolution).
    grant(&store, &[124], Some(2)).await;
    let revoked = slack(&store, 9, 3, "One more question").await;
    assert_eq!(revoked.state, TaskState::Failed as i32);
    assert_eq!(selected(&revoked), (None, None, Some("refused")));
    assert_eq!(
        revoked.result.as_deref(),
        Some(
            "Tag engineer is no longer allowed to use the GitHub Workspace project this Session selected"
        )
    );
    // The Session keeps its selection: restoring the read lets the next turn use it again.
    grant(&store, &[123, 124], Some(3)).await;
    let restored = slack(&store, 11, 3, "And now?").await;
    assert_eq!(
        selected(&restored),
        (Some("project"), Some(PROJECT_BASE), Some("default"))
    );

    // A Tag's configured Workspace is never replaced by a message.
    store
        .put_tag_spec(PutTagRequest {
            tag_id: "configured".into(),
            instructions: "Configured".into(),
            allowed_actions: vec!["files:read".into()],
            workspace: Some(WorkspaceSpec {
                workspace_id: "local".into(),
                base_commit: PROJECT_BASE.into(),
                ..Default::default()
            }),
            ..Default::default()
        })
        .await
        .unwrap();
    let configured = store
        .accept_slack_event(SLACK, &mention(10, 10, "configured", "Look at acme/api"))
        .await
        .unwrap()
        .task
        .unwrap();
    assert_eq!(selected(&configured), (Some("local"), None, None));
    // Operator submissions are not surface messages and never select.
    let submitted = store
        .submit_task(
            OPERATOR,
            &SubmitTaskRequest {
                tag_id: "engineer".into(),
                session_id: "operator".into(),
                operation_id: "operator-submit".into(),
                prompt: "Look at acme/api".into(),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert_eq!(selected(&submitted), (None, None, None));
    store.close().await;
}

#[tokio::test]
async fn sqlite_repository_selection_contract() {
    let dir = tempfile::tempdir().unwrap();
    contract(format!(
        "sqlite://{}?mode=rwc",
        dir.path().join("selection.db").display()
    ))
    .await;
}

#[tokio::test]
#[ignore = "requires SUPERTAG_RUST_TEST_POSTGRES_URL_FILE for a dedicated PostgreSQL test server"]
async fn postgres_repository_selection_contract() {
    let path =
        std::env::var_os("SUPERTAG_RUST_TEST_POSTGRES_URL_FILE").expect("test database file");
    let admin_url = std::fs::read_to_string(path).unwrap();
    let mut url = url::Url::parse(admin_url.trim()).unwrap();
    let name = format!("supertag_repository_selection_{}", Uuid::new_v4().simple());
    let mut admin = sqlx::PgConnection::connect(admin_url.trim()).await.unwrap();
    admin
        .execute(format!("CREATE DATABASE {name}").as_str())
        .await
        .unwrap();
    url.set_path(&name);
    let outcome = tokio::task::LocalSet::new()
        .run_until(async move { tokio::task::spawn_local(contract(url.to_string())).await })
        .await;
    admin
        .execute(format!("DROP DATABASE {name} WITH (FORCE)").as_str())
        .await
        .unwrap();
    outcome.unwrap();
}
