//! Remote Workspaces and git delivery, on SQLite and PostgreSQL.
//!
//! - Workspace Credentials hold names and non-secret identifiers only, and cannot be removed
//!   while a Workspace names them.
//! - A remote Workspace's Session is pinned to one commit by git delivery before its Tasks run,
//!   and a source that cannot be read fails the Session's queued Tasks.
//! - `branch` queues a landing per delivered Task; a newer delivery supersedes an unclaimed one.
//! - `merge` lands once the Session's work is reported done, and a conflict gives the Session a
//!   follow-up Task that merges the target, which lands again when it succeeds.
//! - Only git delivery claims landings, and the claim names the push credential and the holder.

mod support;

use sha2::{Digest, Sha256};
use sqlx::{Connection, Executor};
use supertag_control_plane::{GIT_DELIVERY_PRINCIPAL, HostAuthority, Store, StoreError};
use supertag_protocol::v2::*;
use uuid::Uuid;

const OP: &str = "operator:ada";
const BASE: &str = "1111111111111111111111111111111111111111";
const REMOTE: &str = "ssh://git@git.acme.internal/handbook.git";

async fn credential(store: &Store, name: &str) -> WorkspaceCredential {
    store
        .put_workspace_credential(
            OP,
            &PutWorkspaceCredentialRequest {
                operation_id: Uuid::new_v4().to_string(),
                credential: Some(WorkspaceCredential {
                    name: name.into(),
                    kind: WorkspaceCredentialKind::SshKey as i32,
                    identifier: "SHA256:fixture".into(),
                    revision: 0,
                }),
                expected_revision: None,
            },
        )
        .await
        .unwrap()
}

fn workspace(land: Option<workspace_land::Mode>) -> Workspace {
    Workspace {
        workspace_id: "project".into(),
        remote: REMOTE.into(),
        r#ref: "main".into(),
        credentials: Some(WorkspaceCredentialNames {
            read: "handbook".into(),
            push: "handbook".into(),
        }),
        land: land.map(|mode| WorkspaceLand { mode: Some(mode) }),
        ..Default::default()
    }
}

async fn put(store: &Store, value: Workspace) -> Result<Workspace, StoreError> {
    let expected_revision = store
        .get_workspace(
            OP,
            &GetWorkspaceRequest {
                workspace_id: value.workspace_id.clone(),
            },
        )
        .await
        .ok()
        .map(|prior| prior.revision);
    store
        .put_workspace(
            OP,
            &PutWorkspaceRequest {
                operation_id: Uuid::new_v4().to_string(),
                workspace: Some(value),
                expected_revision,
            },
        )
        .await
}

async fn setup(store: &Store, land: workspace_land::Mode) {
    credential(store, "handbook").await;
    put(store, workspace(Some(land))).await.unwrap();
    store
        .put_tag_spec(PutTagRequest {
            tag_id: "engineer".into(),
            name: Some("Docs Writer".into()),
            instructions: "Change the handbook".into(),
            allowed_actions: vec!["files:write".into()],
            workspace: Some(WorkspaceSpec {
                workspace_id: "project".into(),
                ..Default::default()
            }),
            ..Default::default()
        })
        .await
        .unwrap();
}

/// Pins every pending Session source to `BASE`, as git delivery does after reading the remote.
async fn pin_all(store: &Store) -> usize {
    let pending = store
        .list_pending_workspace_sources(
            GIT_DELIVERY_PRINCIPAL,
            &ListPendingWorkspaceSourcesRequest::default(),
        )
        .await
        .unwrap();
    for pin in &pending.pins {
        let pinned = store
            .pin_workspace_source(
                GIT_DELIVERY_PRINCIPAL,
                &PinWorkspaceSourceRequest {
                    pin_id: pin.pin_id.clone(),
                    selector_digest: pin.selector_digest.clone(),
                    resolved_ref: "main".into(),
                    commit: BASE.into(),
                    error: String::new(),
                },
            )
            .await
            .unwrap();
        assert_eq!(pinned.resolved.unwrap().commit, BASE);
    }
    pending.pins.len()
}

async fn submit(store: &Store, session: &str, prompt: &str) -> Task {
    store
        .submit_task(
            OP,
            &SubmitTaskRequest {
                tag_id: "engineer".into(),
                session_id: session.into(),
                operation_id: Uuid::new_v4().to_string(),
                prompt: prompt.into(),
                ..Default::default()
            },
        )
        .await
        .unwrap()
}

async fn claim(store: &Store, host: &HostAuthority) -> Option<Assignment> {
    store
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
}

/// Claims and starts the next queued Task, which must be `task_id`.
async fn run(store: &Store, host: &HostAuthority, task_id: &str) -> (InspectAttemptRequest, Task) {
    let assignment = claim(store, host).await.unwrap();
    let task = assignment.task.unwrap();
    assert_eq!(task.task_id, task_id);
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
    (attempt, task)
}

/// Finishes `attempt` with a committed delivery from `start` to `head`.
async fn finish(
    store: &Store,
    host: &HostAuthority,
    attempt: InspectAttemptRequest,
    start: &str,
    head: &str,
) {
    let changed = head != start;
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
            start_commit: start.into(),
            head_commit: head.into(),
            committed: changed,
            changed_files: u64::from(changed),
            patch: Some(blob(if changed { b"patch" } else { b"" })),
            bundle: Some(blob(head.as_bytes())),
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
                result: "Changed the handbook".into(),
                succeeded: true,
                workspace_delivery: delivery.delivery,
                ..Default::default()
            },
        )
        .await
        .unwrap();
}

async fn claim_landing(store: &Store) -> ClaimWorkspaceLandingResponse {
    store
        .claim_workspace_landing(
            GIT_DELIVERY_PRINCIPAL,
            &ClaimWorkspaceLandingRequest {
                operation_id: Uuid::new_v4().to_string(),
            },
        )
        .await
        .unwrap()
}

async fn record(
    store: &Store,
    claim: &ClaimWorkspaceLandingResponse,
    input: RecordWorkspaceLandingRequest,
) -> WorkspaceLanding {
    store
        .record_workspace_landing(
            GIT_DELIVERY_PRINCIPAL,
            &RecordWorkspaceLandingRequest {
                lease: Some(WorkspaceLandingLease {
                    landing_id: claim.landing.as_ref().unwrap().landing_id.clone(),
                    lease_token: claim.lease_token.clone(),
                }),
                operation_id: Uuid::new_v4().to_string(),
                ..input
            },
        )
        .await
        .unwrap()
}

async fn catalog_contract(url: String) {
    let store = Store::open(&url).await.unwrap();
    // A Workspace may only name credentials that exist.
    let missing = put(&store, workspace(None)).await.unwrap_err();
    assert!(
        matches!(&missing, StoreError::FailedPrecondition(reason) if reason.contains("supertag workspace credential add")),
        "{missing:?}"
    );
    let stored = credential(&store, "handbook").await;
    assert_eq!(stored.revision, credential(&store, "handbook").await.revision);
    // Remotes never carry secrets or transport helpers, and merge targets stay outside supertag/.
    for remote in [
        "https://user:token@github.com/acme/app.git",
        "ext::sh -c id",
        "/srv/git/app.git",
    ] {
        let refused = put(
            &store,
            Workspace {
                remote: remote.into(),
                ..workspace(None)
            },
        )
        .await
        .unwrap_err();
        assert!(matches!(refused, StoreError::InvalidArgument(_)), "{remote}");
    }
    let refused = put(
        &store,
        workspace(Some(workspace_land::Mode::Merge(WorkspaceLandMerge {
            target: "supertag/session/x".into(),
        }))),
    )
    .await
    .unwrap_err();
    assert!(matches!(refused, StoreError::InvalidArgument(_)));
    let created = put(
        &store,
        workspace(Some(workspace_land::Mode::Merge(WorkspaceLandMerge {
            target: "drafts".into(),
        }))),
    )
    .await
    .unwrap();
    assert!(created.revision > 0);
    // The same declaration changes nothing; a stale revision is refused.
    let again = put(&store, created.clone()).await.unwrap();
    assert_eq!(again.revision, created.revision);
    let stale = store
        .put_workspace(
            OP,
            &PutWorkspaceRequest {
                operation_id: Uuid::new_v4().to_string(),
                workspace: Some(workspace(None)),
                expected_revision: Some(created.revision + 7),
            },
        )
        .await
        .unwrap_err();
    assert!(matches!(stale, StoreError::Conflict(_)));
    let listed = store
        .list_workspaces(OP, &ListWorkspacesRequest::default())
        .await
        .unwrap();
    assert_eq!(listed.workspaces, [created.clone()]);
    let credentials = store
        .list_workspace_credentials(OP, &ListWorkspaceCredentialsRequest::default())
        .await
        .unwrap();
    assert_eq!(credentials.credentials[0].identifier, "SHA256:fixture");
    // A credential a Workspace names cannot be removed; nor can a Workspace a Tag uses.
    let named = store
        .delete_workspace_credential(
            OP,
            &DeleteWorkspaceCredentialRequest {
                operation_id: Uuid::new_v4().to_string(),
                name: "handbook".into(),
                expected_revision: stored.revision,
            },
        )
        .await
        .unwrap_err();
    assert!(matches!(named, StoreError::FailedPrecondition(_)));
    store
        .put_tag_spec(PutTagRequest {
            tag_id: "engineer".into(),
            instructions: "Change the handbook".into(),
            workspace: Some(WorkspaceSpec {
                workspace_id: "project".into(),
                ..Default::default()
            }),
            ..Default::default()
        })
        .await
        .unwrap();
    // A remote Workspace selects its branch itself.
    assert!(
        store
            .put_tag_spec(PutTagRequest {
                tag_id: "other".into(),
                instructions: "Change the handbook".into(),
                workspace: Some(WorkspaceSpec {
                    workspace_id: "project".into(),
                    base_ref: "main".into(),
                    ..Default::default()
                }),
                ..Default::default()
            })
            .await
            .is_err()
    );
    let used = store
        .delete_workspace(
            OP,
            &DeleteWorkspaceRequest {
                operation_id: Uuid::new_v4().to_string(),
                workspace_id: "project".into(),
                expected_revision: created.revision,
                dry_run: false,
            },
        )
        .await
        .unwrap_err();
    assert!(matches!(used, StoreError::FailedPrecondition(_)));
    // Only git delivery pins sources and claims landings.
    assert!(matches!(
        store
            .claim_workspace_landing(OP, &ClaimWorkspaceLandingRequest {
                operation_id: "x".into()
            })
            .await,
        Err(StoreError::PermissionDenied)
    ));
    assert!(matches!(
        store
            .list_pending_workspace_sources(
                "delivery:other",
                &ListPendingWorkspaceSourcesRequest::default()
            )
            .await,
        Err(StoreError::PermissionDenied)
    ));
    store.close().await;
}

async fn branch_contract(url: String) {
    let now = std::sync::Arc::new(std::sync::atomic::AtomicI64::new(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as i64,
    ));
    let clock = now.clone();
    let store = Store::open(&url)
        .await
        .unwrap()
        .with_execution_clock(move || clock.load(std::sync::atomic::Ordering::SeqCst));
    setup(
        &store,
        workspace_land::Mode::Branch(WorkspaceLandBranch {}),
    )
    .await;
    let host = support::register_host(&store, "docs-host").await;
    support::hold_artifacts(&store, &host).await;

    // A source that cannot be read fails the Session's queued Tasks with the reason.
    let unreadable = submit(&store, "unreadable", "Change it").await;
    let pending = store
        .list_pending_workspace_sources(
            GIT_DELIVERY_PRINCIPAL,
            &ListPendingWorkspaceSourcesRequest::default(),
        )
        .await
        .unwrap();
    assert_eq!(pending.pins.len(), 1);
    store
        .pin_workspace_source(
            GIT_DELIVERY_PRINCIPAL,
            &PinWorkspaceSourceRequest {
                pin_id: pending.pins[0].pin_id.clone(),
                selector_digest: pending.pins[0].selector_digest.clone(),
                error: "the remote has no branch main".into(),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    let failed = store.get_task(&unreadable.task_id).await.unwrap();
    assert_eq!(failed.state(), TaskState::Failed);
    assert!(failed.result().contains("no branch main"), "{:?}", failed.result);

    // A Session's Tasks wait until git delivery pins its source.
    let first = submit(&store, "notes", "Write the notes").await;
    assert!(first.workspace.as_ref().unwrap().base_commit.is_empty());
    assert!(claim(&store, &host).await.is_none());
    assert_eq!(pin_all(&store).await, 1);
    let (attempt, claimed) = run(&store, &host, &first.task_id).await;
    let spec = claimed.workspace.unwrap();
    assert_eq!(spec.base_commit, BASE);
    assert_eq!(spec.remote.as_ref().unwrap().commit, BASE);
    assert_eq!(spec.remote.as_ref().unwrap().resolved_ref, "main");
    // The Tag authors the Session's commits with a no-reply address; the requester co-authors.
    assert_eq!(spec.author_name, "Docs Writer");
    assert_eq!(spec.author_email, "engineer@noreply.supertag.invalid");
    assert_eq!(spec.co_author, "ada <ada@noreply.supertag.invalid>");
    let source = store
        .get_workspace_source(
            &host,
            &DownloadWorkspaceSourceRequest {
                attempt: Some(attempt.clone()),
                merge: false,
            },
        )
        .await
        .unwrap();
    assert_eq!(source.commit, BASE);
    assert!(
        store
            .get_workspace_source(
                &host,
                &DownloadWorkspaceSourceRequest {
                    attempt: Some(attempt.clone()),
                    merge: true,
                },
            )
            .await
            .is_err()
    );
    let first_head = "2".repeat(40);
    finish(&store, &host, attempt, BASE, &first_head).await;

    // The Session's next Task keeps the pin, and its newer delivery supersedes the first.
    let second = submit(&store, "notes", "Polish the notes").await;
    assert_eq!(second.workspace.as_ref().unwrap().base_commit, BASE);
    assert_eq!(pin_all(&store).await, 0);
    let (attempt, _) = run(&store, &host, &second.task_id).await;
    let second_head = "3".repeat(40);
    finish(&store, &host, attempt, &first_head, &second_head).await;
    let landings = store
        .list_workspace_landings(
            OP,
            &ListWorkspaceLandingsRequest {
                session_id: "notes".into(),
                ..Default::default()
            },
        )
        .await
        .unwrap()
        .landings;
    let states: Vec<_> = landings.iter().map(WorkspaceLanding::state).collect();
    assert_eq!(
        states,
        [WorkspaceLandingState::Queued, WorkspaceLandingState::Superseded]
    );

    let claimed = claim_landing(&store).await;
    let landing = claimed.landing.clone().unwrap();
    assert_eq!(landing.mode(), WorkspaceLandingMode::Branch);
    assert_eq!(landing.delivery.as_ref().unwrap().head_commit, second_head);
    assert_eq!(landing.branch, supertag_protocol::session_branch("engineer", "notes"));
    assert_eq!(landing.remote, REMOTE);
    assert_eq!(claimed.credential, "handbook");
    assert_eq!(claimed.holder.as_ref().unwrap().host_id, "docs-host");
    // A landing put back waits before it is claimed again.
    record(
        &store,
        &claimed,
        RecordWorkspaceLandingRequest {
            state: WorkspaceLandingState::Queued as i32,
            reason: "the remote did not answer".into(),
            retry_after_ms: 60_000,
            ..Default::default()
        },
    )
    .await;
    assert!(claim_landing(&store).await.landing.is_none());
    now.fetch_add(61_000, std::sync::atomic::Ordering::SeqCst);
    let claimed = claim_landing(&store).await;
    let landed = record(
        &store,
        &claimed,
        RecordWorkspaceLandingRequest {
            state: WorkspaceLandingState::Landed as i32,
            landed_commit: second_head.clone(),
            ..Default::default()
        },
    )
    .await;
    assert_eq!(landed.state(), WorkspaceLandingState::Landed);
    assert_eq!(landed.landed_commit, second_head);
    assert!(claim_landing(&store).await.landing.is_none());
    let read = store
        .get_workspace_landing(
            OP,
            &GetWorkspaceLandingRequest {
                landing_id: landed.landing_id.clone(),
            },
        )
        .await
        .unwrap();
    assert_eq!(read, landed);
    store.close().await;
}

/// Starts a Work Session from a conversation turn and runs its child Task to a delivery at
/// `head`, and the report that follows; returns the Work Session.
async fn work_session(store: &Store, host: &HostAuthority, head: &str) -> WorkSession {
    let parent = submit(store, "chat", "Delegate the notes").await;
    pin_all(store).await;
    let (attempt, _) = run(store, host, &parent.task_id).await;
    let work = store
        .start_work_session(
            host,
            &StartWorkSessionRequest {
                attempt: Some(attempt.clone()),
                operation_id: "start".into(),
                title: "Notes".into(),
                instruction: "Write the notes".into(),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    finish(store, host, attempt, BASE, BASE).await;
    pin_all(store).await;
    let (child, _) = run(store, host, &work.latest_task_id).await;
    finish(store, host, child, BASE, head).await;
    let report = store
        .get_work_session(OP, &work.work_session_id)
        .await
        .unwrap()
        .report_task_id
        .unwrap();
    let (attempt, _) = run(store, host, &report).await;
    finish(store, host, attempt, BASE, BASE).await;
    work
}

async fn merge_contract(url: String) {
    let store = Store::open(&url).await.unwrap();
    setup(
        &store,
        workspace_land::Mode::Merge(WorkspaceLandMerge {
            target: "drafts".into(),
        }),
    )
    .await;
    let host = support::register_host(&store, "docs-host").await;
    support::hold_artifacts(&store, &host).await;
    let head = "2".repeat(40);
    let work = work_session(&store, &host, &head).await;
    // Unfinished work never lands in a shared branch.
    assert!(claim_landing(&store).await.landing.is_none());
    // Reporting the work done lands it.
    store
        .close_work_session(
            OP,
            &CloseWorkSessionRequest {
                work_session_id: work.work_session_id.clone(),
                delivery_pulled: false,
            },
        )
        .await
        .unwrap();
    let claimed = claim_landing(&store).await;
    let landing = claimed.landing.clone().unwrap();
    assert_eq!(landing.mode(), WorkspaceLandingMode::Merge);
    assert_eq!(landing.target, "drafts");
    assert_eq!(landing.session_id, work.work_session_id);
    assert_eq!(landing.author_name, "Docs Writer");
    // A conflict is never resolved here: the Session gets a follow-up Task.
    let target = "4".repeat(40);
    let conflict = record(
        &store,
        &claimed,
        RecordWorkspaceLandingRequest {
            state: WorkspaceLandingState::Conflict as i32,
            reason: "the Session's changes conflict with drafts in 1 file(s)".into(),
            target_commit: target.clone(),
            conflicts: vec!["notes.md".into()],
            ..Default::default()
        },
    )
    .await;
    assert_eq!(conflict.state(), WorkspaceLandingState::Conflict);
    let follow_up = conflict.follow_up_task_id.clone().unwrap();
    let task = store.get_task(&follow_up).await.unwrap();
    assert_eq!(task.session_id, work.work_session_id);
    assert!(task.prompt.contains("notes.md") && task.prompt.contains("drafts"));
    assert_eq!(task.workspace.as_ref().unwrap().merge_commit, target);
    let (attempt, _) = run(&store, &host, &follow_up).await;
    let source = store
        .get_workspace_source(
            &host,
            &DownloadWorkspaceSourceRequest {
                attempt: Some(attempt.clone()),
                merge: true,
            },
        )
        .await
        .unwrap();
    assert_eq!(source.commit, target);
    // The resolved merge lands again as soon as it is delivered.
    let merged = "5".repeat(40);
    finish(&store, &host, attempt, &head, &merged).await;
    let claimed = claim_landing(&store).await;
    let landing = claimed.landing.clone().unwrap();
    assert_eq!(landing.delivery.as_ref().unwrap().head_commit, merged);
    let landed = record(
        &store,
        &claimed,
        RecordWorkspaceLandingRequest {
            state: WorkspaceLandingState::Landed as i32,
            landed_commit: "6".repeat(40),
            ..Default::default()
        },
    )
    .await;
    assert_eq!(landed.state(), WorkspaceLandingState::Landed);
    // Closing again lands nothing twice.
    store
        .close_work_session(
            OP,
            &CloseWorkSessionRequest {
                work_session_id: work.work_session_id.clone(),
                delivery_pulled: false,
            },
        )
        .await
        .unwrap();
    assert!(claim_landing(&store).await.landing.is_none());
    store.close().await;
}

fn sqlite(directory: &tempfile::TempDir, name: &str) -> String {
    format!(
        "sqlite://{}?mode=rwc",
        directory.path().join(name).display()
    )
}

async fn postgres(contract: fn(String) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()>>>) {
    let admin_url =
        std::fs::read_to_string(std::env::var_os("SUPERTAG_RUST_TEST_POSTGRES_URL_FILE").unwrap())
            .unwrap();
    let database = format!("supertag_git_delivery_{}", Uuid::new_v4().simple());
    let mut admin = sqlx::PgConnection::connect(admin_url.trim()).await.unwrap();
    admin
        .execute(format!("CREATE DATABASE {database}").as_str())
        .await
        .unwrap();
    let mut url = url::Url::parse(admin_url.trim()).unwrap();
    url.set_path(&database);
    let result = tokio::task::LocalSet::new()
        .run_until(async move {
            tokio::task::spawn_local(async move { contract(url.to_string()).await }).await
        })
        .await;
    admin
        .execute(format!("DROP DATABASE {database} WITH (FORCE)").as_str())
        .await
        .unwrap();
    result.unwrap();
}

#[tokio::test]
async fn sqlite_catalog() {
    let directory = tempfile::tempdir().unwrap();
    Box::pin(catalog_contract(sqlite(&directory, "catalog.db"))).await;
}

#[tokio::test]
async fn sqlite_branch_landing() {
    let directory = tempfile::tempdir().unwrap();
    Box::pin(branch_contract(sqlite(&directory, "branch.db"))).await;
}

#[tokio::test]
async fn sqlite_merge_landing() {
    let directory = tempfile::tempdir().unwrap();
    Box::pin(merge_contract(sqlite(&directory, "merge.db"))).await;
}

#[tokio::test]
#[ignore = "requires SUPERTAG_RUST_TEST_POSTGRES_URL_FILE"]
async fn postgres_catalog() {
    postgres(|url| Box::pin(catalog_contract(url))).await;
}

#[tokio::test]
#[ignore = "requires SUPERTAG_RUST_TEST_POSTGRES_URL_FILE"]
async fn postgres_branch_landing() {
    postgres(|url| Box::pin(branch_contract(url))).await;
}

#[tokio::test]
#[ignore = "requires SUPERTAG_RUST_TEST_POSTGRES_URL_FILE"]
async fn postgres_merge_landing() {
    postgres(|url| Box::pin(merge_contract(url))).await;
}
