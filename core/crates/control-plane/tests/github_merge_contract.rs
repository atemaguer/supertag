//! A merged pull request closes the Work Session whose GitHub delivery opened it: the connector
//! reports the merge, the Control Plane finds the open Work Session that delivered to that pull
//! request, and closes it as `merged`. Another pull request, a replay, or a Work Session that
//! delivered nowhere changes nothing.

mod support;

use sha2::{Digest, Sha256};
use sqlx::{Connection, Executor};
use supertag_control_plane::{HostAuthority, Store};
use supertag_protocol::v2::*;
use uuid::Uuid;

const OP: &str = "operator:publisher";
const PUBLISHER: &str = "publisher:github/github";
const CONNECTOR: &str = "connector:github/surface";
const BASE: &str = "1111111111111111111111111111111111111111";

async fn setup(store: &Store) {
    store
        .put_surface_account(
            OP,
            &PutSurfaceAccountRequest {
                operation_id: "account".into(),
                account: Some(SurfaceAccount {
                    account_id: "github".into(),
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
                operation_id: "workspace".into(),
                workspace: Some(GithubWorkspace {
                    workspace_id: "project".into(),
                    source: Some(GithubWorkspaceSource {
                        account_id: "github".into(),
                        repository_id: 123,
                        repository: "acme/project".into(),
                        commit_sha: BASE.into(),
                        ..Default::default()
                    }),
                    pull_request: Some(GithubPullRequestDelivery {
                        base_branch: "main".into(),
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
            instructions: "Change the repository".into(),
            allowed_actions: vec!["files:write".into()],
            workspace: Some(WorkspaceSpec {
                workspace_id: "project".into(),
                base_commit: BASE.into(),
                ..Default::default()
            }),
            ..Default::default()
        })
        .await
        .unwrap();
    let surface = |action: &str| PolicyPermission {
        target: PolicyPermissionTarget::Surface as i32,
        surface_account_id: "github".into(),
        scope: "repository:123".into(),
        action: action.into(),
        ..Default::default()
    };
    store
        .put_permission_set(
            OP,
            &PutPermissionSetRequest {
                operation_id: "permissions".into(),
                permission_set: Some(PermissionSet {
                    set_id: "repository".into(),
                    name: "repository".into(),
                    permissions: vec![surface("contents:read"), surface("pull-requests:create")],
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
                    role_id: "engineer-role".into(),
                    name: "engineer".into(),
                    purpose: "Make changes".into(),
                    status: RoleStatus::Active as i32,
                    permission_set_ids: vec!["repository".into()],
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
                role: "engineer-role".into(),
                tag_id: "engineer".into(),
            },
        )
        .await
        .unwrap();
}

/// Claims and starts the next queued Task, which must be `task_id`.
async fn run(store: &Store, host: &HostAuthority, task_id: &str) -> InspectAttemptRequest {
    let assignment = store
        .claim_task_with_sources(
            host,
            &Uuid::new_v4().to_string(),
            (&[], &["project".into()]),
            HarnessKind::Unspecified,
            &[],
            None,
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(assignment.task.unwrap().task_id, task_id);
    let attempt = InspectAttemptRequest {
        task_id: task_id.into(),
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

/// Finishes `attempt` with a committed delivery ending at `head`, or none when `head` is the base.
async fn finish(store: &Store, host: &HostAuthority, attempt: InspectAttemptRequest, head: &str) {
    let changed = head != BASE;
    let blob = |bytes: &[u8]| BlobReference {
        sha256: format!("{:x}", Sha256::digest(bytes)),
        byte_length: bytes.len() as u64,
    };
    let delivery = WorkspaceDeliveryRequest {
        attempt: Some(attempt.clone()),
        delivery: Some(WorkspaceDeliveryReference {
            workspace_id: "project".into(),
            delivery_id: format!(
                "{:x}",
                Sha256::digest(
                    serde_json::to_vec(&(&attempt.task_id, &attempt.attempt_id)).unwrap()
                )
            ),
            base_commit: BASE.into(),
            start_commit: BASE.into(),
            head_commit: head.into(),
            committed: changed,
            changed_files: u64::from(changed),
            patch: Some(blob(if changed { b"patch" } else { b"" })),
            bundle: Some(blob(b"bundle")),
        }),
    };
    store
        .reserve_workspace_delivery(host, &delivery)
        .await
        .unwrap();
    store
        .commit_workspace_delivery(host, &delivery)
        .await
        .unwrap();
    store
        .finish_task(
            host,
            &FinishTaskRequest {
                task_id: attempt.task_id,
                attempt_id: attempt.attempt_id,
                lease_token: attempt.lease_token,
                result: "Verified change".into(),
                succeeded: true,
                workspace_delivery: delivery.delivery,
                ..Default::default()
            },
        )
        .await
        .unwrap();
}

/// Publishes the next queued publication as pull request `number`.
async fn publish(store: &Store, number: u64) -> GithubPublication {
    let claim = store
        .claim_github_publication(
            PUBLISHER,
            &ClaimGithubPublicationRequest {
                operation_id: Uuid::new_v4().to_string(),
            },
        )
        .await
        .unwrap();
    let job = claim.publication.clone().unwrap();
    let lease = GithubPublicationLease {
        publication_id: job.publication_id.clone(),
        lease_token: claim.lease_token.clone(),
    };
    store
        .plan_github_publication(
            PUBLISHER,
            &PlanGithubPublicationRequest {
                lease: Some(lease.clone()),
                operation_id: Uuid::new_v4().to_string(),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    let head = job.delivery.as_ref().unwrap().head_commit.clone();
    for (phase, state, pushed, pull_request) in [
        (
            GithubPublicationPhase::Push,
            GithubPublicationState::Claimed,
            Some(head.clone()),
            None,
        ),
        (
            GithubPublicationPhase::Create,
            GithubPublicationState::Published,
            None,
            Some(GithubPullRequestReceipt {
                number,
                url: format!("https://github.com/acme/project/pull/{number}"),
                repository_id: 123,
                repository: "acme/project".into(),
                head_branch: job.head_branch.clone(),
                base_branch: "main".into(),
                head_commit: head.clone(),
                open: true,
                merged: false,
                draft: true,
                title: job.title.clone(),
                body: job.body.clone(),
            }),
        ),
    ] {
        if phase == GithubPublicationPhase::Create {
            store
                .plan_github_publication(
                    PUBLISHER,
                    &PlanGithubPublicationRequest {
                        lease: Some(lease.clone()),
                        operation_id: Uuid::new_v4().to_string(),
                        pushed_commit: Some(head.clone()),
                        ..Default::default()
                    },
                )
                .await
                .unwrap();
        }
        store
            .begin_github_publication_effect(
                PUBLISHER,
                &BeginGithubPublicationEffectRequest {
                    lease: Some(lease.clone()),
                    operation_id: Uuid::new_v4().to_string(),
                    phase: phase as i32,
                },
            )
            .await
            .unwrap();
        store
            .record_github_publication_effect(
                PUBLISHER,
                &RecordGithubPublicationEffectRequest {
                    lease: Some(lease.clone()),
                    operation_id: Uuid::new_v4().to_string(),
                    phase: phase as i32,
                    state: state as i32,
                    pushed_commit: pushed,
                    pull_request,
                    ..Default::default()
                },
            )
            .await
            .unwrap();
    }
    store
        .get_github_publication(
            OP,
            &GetGithubPublicationRequest {
                publication_id: job.publication_id,
            },
        )
        .await
        .unwrap()
}

/// Starts a Work Session from a conversation turn and runs its child Task to a delivery at
/// `head`; returns the Work Session.
async fn work_session(store: &Store, host: &HostAuthority, name: &str, head: &str) -> WorkSession {
    let parent = store
        .submit_task(
            OP,
            &SubmitTaskRequest {
                tag_id: "engineer".into(),
                session_id: format!("chat-{name}"),
                operation_id: format!("turn-{name}"),
                prompt: format!("Delegate {name}"),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    let attempt = run(store, host, &parent.task_id).await;
    let work = store
        .start_work_session(
            host,
            &StartWorkSessionRequest {
                attempt: Some(attempt.clone()),
                operation_id: format!("start-{name}"),
                title: format!("Change {name}"),
                instruction: format!("Change {name}"),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    finish(store, host, attempt, BASE).await;
    let child = run(store, host, &work.latest_task_id).await;
    finish(store, host, child, head).await;
    // The child's report is the starting Tag's next turn.
    let report = store
        .get_work_session(OP, &work.work_session_id)
        .await
        .unwrap()
        .report_task_id
        .unwrap();
    let attempt = run(store, host, &report).await;
    finish(store, host, attempt, BASE).await;
    work
}

fn merged(delivery: &str, number: u64) -> AcceptGithubEventRequest {
    AcceptGithubEventRequest {
        account_id: "github/surface".into(),
        delivery_id: delivery.into(),
        repository_id: 123,
        repository: "acme/project".into(),
        number,
        source_id: 9_000 + number,
        kind: GithubEventKind::PullRequest as i32,
        action: GithubEventAction::Merged as i32,
        prompt: String::new(),
        tag_id: "engineer".into(),
        is_pull_request: true,
    }
}

async fn reason(store: &Store, work: &WorkSession) -> (bool, WorkSessionCloseReason) {
    let current = store
        .get_work_session(OP, &work.work_session_id)
        .await
        .unwrap();
    (current.closed_at_ms.is_some(), current.close_reason())
}

async fn contract(url: &str) {
    let store = Store::open(url).await.unwrap();
    setup(&store).await;
    let host = support::register_host(&store, "builder-host").await;
    let first = work_session(&store, &host, "first", &"2".repeat(40)).await;
    let published = publish(&store, 7).await;
    assert_eq!(published.state(), GithubPublicationState::Published);
    let second = work_session(&store, &host, "second", &"3".repeat(40)).await;
    publish(&store, 8).await;
    // A Work Session that delivered nothing has no pull request to merge.
    let quiet = work_session(&store, &host, "quiet", BASE).await;

    // Another pull request's merge, or one in another repository, closes nothing.
    let response = store
        .accept_github_event(CONNECTOR, &merged("merge-other", 99))
        .await
        .unwrap();
    assert!(response.task.is_none());
    for work in [&first, &second, &quiet] {
        assert_eq!(
            reason(&store, work).await,
            (false, WorkSessionCloseReason::Unspecified)
        );
    }
    // A merge must carry no prompt and name a pull request.
    let mut prompted = merged("merge-prompted", 7);
    prompted.prompt = "@supertag merge".into();
    assert!(
        store
            .accept_github_event(CONNECTOR, &prompted)
            .await
            .is_err()
    );
    let mut issue = merged("merge-issue", 7);
    issue.kind = GithubEventKind::Issue as i32;
    issue.is_pull_request = false;
    assert!(store.accept_github_event(CONNECTOR, &issue).await.is_err());

    // Merging pull request 7 closes only the Work Session that opened it, and a replay is a no-op.
    for _ in 0..2 {
        assert!(
            store
                .accept_github_event(CONNECTOR, &merged("merge-7", 7))
                .await
                .unwrap()
                .task
                .is_none()
        );
        assert_eq!(
            reason(&store, &first).await,
            (true, WorkSessionCloseReason::Merged)
        );
        assert_eq!(
            reason(&store, &second).await,
            (false, WorkSessionCloseReason::Unspecified)
        );
    }
    // A Work Session closed for another reason keeps that reason.
    store
        .close_work_session(
            OP,
            &CloseWorkSessionRequest {
                work_session_id: second.work_session_id.clone(),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    store
        .accept_github_event(CONNECTOR, &merged("merge-8", 8))
        .await
        .unwrap();
    assert_eq!(
        reason(&store, &second).await,
        (true, WorkSessionCloseReason::Operator)
    );
    assert_eq!(
        reason(&store, &quiet).await,
        (false, WorkSessionCloseReason::Unspecified)
    );
    store.close().await;
}

#[tokio::test]
async fn sqlite_github_merge_contract() {
    let dir = tempfile::tempdir().unwrap();
    contract(&format!(
        "sqlite://{}?mode=rwc",
        dir.path().join("merge.db").display()
    ))
    .await;
}

#[tokio::test]
#[ignore = "requires SUPERTAG_RUST_TEST_POSTGRES_URL_FILE for a dedicated PostgreSQL test server"]
async fn postgres_github_merge_contract() {
    let file = std::env::var_os("SUPERTAG_RUST_TEST_POSTGRES_URL_FILE").expect("URL file");
    let admin_url = std::fs::read_to_string(file).unwrap();
    let mut url = url::Url::parse(admin_url.trim()).unwrap();
    let database = format!("supertag_merge_{}", Uuid::new_v4().simple());
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
