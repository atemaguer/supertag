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
//! - `review` needs a GitHub forge and a credential that can call its API, lands every delivered
//!   Task with the pull request's title and description, records the pull request it opened,
//!   and that pull request's merge closes the Work Session.

mod support;

use sha2::{Digest, Sha256};
use sqlx::{Connection, Executor};
use supertag_control_plane::{
    GIT_DELIVERY_PRINCIPAL, HostAuthority, LandingClaimer, Store, StoreError,
};
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

async fn setup(store: &Store, land: Option<workspace_land::Mode>) {
    credential(store, "handbook").await;
    put(store, workspace(land)).await.unwrap();
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

async fn claim_landing(
    store: &Store,
    claimer: LandingClaimer<'_>,
) -> ClaimWorkspaceLandingResponse {
    store
        .claim_workspace_landing(
            claimer,
            &ClaimWorkspaceLandingRequest {
                operation_id: Uuid::new_v4().to_string(),
            },
        )
        .await
        .unwrap()
}

async fn record(
    store: &Store,
    claimer: LandingClaimer<'_>,
    claim: &ClaimWorkspaceLandingResponse,
    input: RecordWorkspaceLandingRequest,
) -> WorkspaceLanding {
    store
        .record_workspace_landing(
            claimer,
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
    assert_eq!(
        stored.revision,
        credential(&store, "handbook").await.revision
    );
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
        assert!(
            matches!(refused, StoreError::InvalidArgument(_)),
            "{remote}"
        );
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
    assert_eq!(listed.workspaces, std::slice::from_ref(&created));
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
            .claim_workspace_landing(
                LandingClaimer::Delivery(OP),
                &ClaimWorkspaceLandingRequest {
                    operation_id: "x".into()
                }
            )
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
    setup(&store, None).await;
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
    assert!(
        failed.result().contains("no branch main"),
        "{:?}",
        failed.result
    );

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
        [
            WorkspaceLandingState::Queued,
            WorkspaceLandingState::Superseded
        ]
    );

    let claimed = claim_landing(&store, LandingClaimer::Host(&host)).await;
    let landing = claimed.landing.clone().unwrap();
    assert_eq!(landing.mode(), WorkspaceLandingMode::Branch);
    assert_eq!(landing.delivery.as_ref().unwrap().head_commit, second_head);
    assert_eq!(
        landing.branch,
        supertag_protocol::session_branch("engineer", "notes")
    );
    assert_eq!(landing.remote, REMOTE);
    // The host mints its push credential; it learns which of its Attempts holds the commit.
    assert_eq!(claimed.credential, "");
    assert_eq!(claimed.holder.as_ref().unwrap().host_id, "docs-host");
    // ...and the Workspace whose push credential WorkspaceGitAccess.Mint grants for the lease.
    assert_eq!(claimed.workspace.as_ref().unwrap().remote, REMOTE);
    // Only the host holding the delivery lands it, and only it renews or records the lease.
    let other = support::register_host(&store, "other-host").await;
    assert!(
        claim_landing(&store, LandingClaimer::Host(&other))
            .await
            .landing
            .is_none()
    );
    let lease = WorkspaceLandingLease {
        landing_id: landing.landing_id.clone(),
        lease_token: claimed.lease_token.clone(),
    };
    for claimer in [
        LandingClaimer::Host(&other),
        LandingClaimer::Delivery(GIT_DELIVERY_PRINCIPAL),
    ] {
        assert!(
            store
                .renew_workspace_landing(claimer, &lease)
                .await
                .is_err()
        );
    }
    // A landing put back because its holding Worker Host was away waits, and retries as soon as
    // that host reports Ready instead of waiting out its retry.
    record(
        &store,
        LandingClaimer::Host(&host),
        &claimed,
        RecordWorkspaceLandingRequest {
            state: WorkspaceLandingState::Queued as i32,
            reason: "the remote was unreachable".into(),
            retry_after_ms: 60_000,
            ..Default::default()
        },
    )
    .await;
    assert!(
        claim_landing(&store, LandingClaimer::Host(&host))
            .await
            .landing
            .is_none()
    );
    store
        .report_host(
            &host,
            &ReportHostRequest {
                sequence: 1,
                capacity: 1,
                available_slots: 1,
                readiness: HostReadiness::Ready.into(),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    let claimed = claim_landing(&store, LandingClaimer::Host(&host)).await;
    let landed = record(
        &store,
        LandingClaimer::Host(&host),
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
    assert!(
        claim_landing(&store, LandingClaimer::Host(&host))
            .await
            .landing
            .is_none()
    );
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

    // Git delivery reads the pushed branch back once. Only git delivery may.
    assert!(
        store
            .list_unverified_landings(OP, &ListUnverifiedLandingsRequest::default())
            .await
            .is_err()
    );
    let unverified = store
        .list_unverified_landings(
            GIT_DELIVERY_PRINCIPAL,
            &ListUnverifiedLandingsRequest::default(),
        )
        .await
        .unwrap()
        .landings;
    assert_eq!(unverified.len(), 1);
    assert_eq!(
        unverified[0].landing.as_ref().unwrap().landing_id,
        landed.landing_id
    );
    assert_eq!(unverified[0].workspace.as_ref().unwrap().remote, REMOTE);
    // A branch someone moved after the push is recorded on the landing, which stays landed.
    let moved = "9".repeat(40);
    let checked = store
        .record_landing_verification(
            GIT_DELIVERY_PRINCIPAL,
            &RecordLandingVerificationRequest {
                landing_id: landed.landing_id.clone(),
                remote_commit: moved.clone(),
            },
        )
        .await
        .unwrap();
    assert_eq!(checked.state(), WorkspaceLandingState::Landed);
    assert!(
        checked.reason.contains(&moved) && checked.reason.contains("outside SuperTag"),
        "{}",
        checked.reason
    );
    assert!(
        store
            .list_unverified_landings(
                GIT_DELIVERY_PRINCIPAL,
                &ListUnverifiedLandingsRequest::default()
            )
            .await
            .unwrap()
            .landings
            .is_empty()
    );
    store.close().await;
}

/// Starts a Work Session from a conversation turn and runs its child Task to a delivery at
/// `head`, and the report that follows; returns the Work Session.
async fn work_session(store: &Store, host: &HostAuthority, head: &str) -> WorkSession {
    let parent = submit(store, "chat", "Delegate the notes").await;
    pin_all(store).await;
    let (attempt, _) = run(store, host, &parent.task_id).await;
    // A Work Session works in its parent's Workspace: naming another is refused, naming it.
    let elsewhere = store
        .start_work_session(
            host,
            &StartWorkSessionRequest {
                attempt: Some(attempt.clone()),
                operation_id: "start-elsewhere".into(),
                title: "Notes".into(),
                instruction: "Write the notes".into(),
                workspace_id: Some("handbook".into()),
                ..Default::default()
            },
        )
        .await;
    match elsewhere {
        Err(StoreError::FailedPrecondition(reason)) => assert!(
            reason.contains("Workspace handbook is not this Task's Workspace project"),
            "{reason}"
        ),
        other => panic!("{other:?}"),
    }
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
        Some(workspace_land::Mode::Merge(WorkspaceLandMerge {
            target: "drafts".into(),
        })),
    )
    .await;
    let host = support::register_host(&store, "docs-host").await;
    support::hold_artifacts(&store, &host).await;
    let head = "2".repeat(40);
    let work = work_session(&store, &host, &head).await;
    // Unfinished work never lands in a shared branch; the Session's own branch is pushed.
    let pushed = claim_landing(&store, LandingClaimer::Host(&host)).await;
    assert_eq!(
        pushed.landing.as_ref().unwrap().mode(),
        WorkspaceLandingMode::Branch
    );
    record(
        &store,
        LandingClaimer::Host(&host),
        &pushed,
        RecordWorkspaceLandingRequest {
            state: WorkspaceLandingState::Landed as i32,
            landed_commit: head.clone(),
            ..Default::default()
        },
    )
    .await;
    assert!(
        claim_landing(&store, LandingClaimer::Host(&host))
            .await
            .landing
            .is_none()
    );
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
    let claimed = claim_landing(&store, LandingClaimer::Host(&host)).await;
    let landing = claimed.landing.clone().unwrap();
    assert_eq!(landing.mode(), WorkspaceLandingMode::Merge);
    assert_eq!(landing.target, "drafts");
    assert_eq!(landing.session_id, work.work_session_id);
    assert_eq!(landing.author_name, "Docs Writer");
    // The Tag started the Work Session, so the person who asked in its parent co-authors.
    assert_eq!(landing.co_author, "ada <ada@noreply.supertag.invalid>");
    // A conflict is never resolved here: the Session gets a follow-up Task.
    let target = "4".repeat(40);
    let conflict = record(
        &store,
        LandingClaimer::Host(&host),
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
    let claimed = claim_landing(&store, LandingClaimer::Host(&host)).await;
    let landing = claimed.landing.clone().unwrap();
    assert_eq!(landing.delivery.as_ref().unwrap().head_commit, merged);
    let landed = record(
        &store,
        LandingClaimer::Host(&host),
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
    assert!(
        claim_landing(&store, LandingClaimer::Host(&host))
            .await
            .landing
            .is_none()
    );
    store.close().await;
}

const GITHUB_REMOTE: &str = "https://github.com/acme/handbook.git";

fn merged(number: u64, delivery: &str) -> AcceptGithubEventRequest {
    AcceptGithubEventRequest {
        account_id: "github/surface".into(),
        delivery_id: delivery.into(),
        repository_id: 42,
        repository: "acme/handbook".into(),
        number,
        source_id: 5_000 + number,
        kind: GithubEventKind::PullRequest.into(),
        action: GithubEventAction::Merged.into(),
        prompt: String::new(),
        tag_id: "engineer".into(),
        is_pull_request: true,
    }
}

async fn review_contract(url: String) {
    let store = Store::open(&url).await.unwrap();
    let review = |base: &str| {
        Some(workspace_land::Mode::Review(WorkspaceLandReview {
            base: base.into(),
        }))
    };
    // An SSH key cannot call the forge's API; a plain git remote has no review at all.
    credential(&store, "handbook").await;
    let refused = put(
        &store,
        Workspace {
            remote: GITHUB_REMOTE.into(),
            ..workspace(review("main"))
        },
    )
    .await
    .unwrap_err();
    assert!(
        matches!(&refused, StoreError::FailedPrecondition(reason) if reason.contains("GitHub App or HTTPS token")),
        "{refused:?}"
    );
    store
        .put_workspace_credential(
            OP,
            &PutWorkspaceCredentialRequest {
                operation_id: Uuid::new_v4().to_string(),
                credential: Some(WorkspaceCredential {
                    name: "acme-github".into(),
                    kind: WorkspaceCredentialKind::GithubApp as i32,
                    identifier: "app:7/installation:8".into(),
                    revision: 0,
                }),
                expected_revision: None,
            },
        )
        .await
        .unwrap();
    let app = Some(WorkspaceCredentialNames {
        read: "acme-github".into(),
        push: "acme-github".into(),
    });
    let refused = put(
        &store,
        Workspace {
            credentials: app.clone(),
            ..workspace(review("main"))
        },
    )
    .await
    .unwrap_err();
    assert!(
        matches!(&refused, StoreError::InvalidArgument(reason) if reason.contains("--forge github")),
        "{refused:?}"
    );
    // A GitHub App reaches only https:// GitHub remotes.
    let refused = put(
        &store,
        Workspace {
            remote: "git@github.com:acme/handbook.git".into(),
            credentials: app.clone(),
            ..workspace(None)
        },
    )
    .await
    .unwrap_err();
    assert!(
        matches!(&refused, StoreError::FailedPrecondition(reason) if reason.contains("GitHub App")),
        "{refused:?}"
    );
    for base in ["supertag/session/x", "bad..base"] {
        assert!(matches!(
            put(
                &store,
                Workspace {
                    remote: GITHUB_REMOTE.into(),
                    credentials: app.clone(),
                    ..workspace(review(base))
                },
            )
            .await,
            Err(StoreError::InvalidArgument(_))
        ));
    }
    // github.com is GitHub without --forge; a self-hosted host needs it.
    let stored = put(
        &store,
        Workspace {
            remote: GITHUB_REMOTE.into(),
            credentials: app.clone(),
            ..workspace(review("main"))
        },
    )
    .await
    .unwrap();
    assert_eq!(stored.forge(), WorkspaceForge::Github);
    let enterprise = put(
        &store,
        Workspace {
            workspace_id: "enterprise".into(),
            remote: "https://ghe.acme.internal/acme/handbook.git".into(),
            credentials: app.clone(),
            forge: WorkspaceForge::Github as i32,
            ..workspace(review("main"))
        },
    )
    .await
    .unwrap();
    assert_eq!(enterprise.forge(), WorkspaceForge::Github);

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
    let host = support::register_host(&store, "docs-host").await;
    support::hold_artifacts(&store, &host).await;
    let head = "2".repeat(40);
    let work = work_session(&store, &host, &head).await;
    // Every delivered Task lands at once, without waiting for the Session to finish.
    let pushed = claim_landing(&store, LandingClaimer::Host(&host)).await;
    // Git delivery claims nothing until the host pushed the branch.
    assert!(
        claim_landing(&store, LandingClaimer::Delivery(GIT_DELIVERY_PRINCIPAL))
            .await
            .landing
            .is_none()
    );
    // A host never opens the pull request; it records the pushed branch.
    let refused = store
        .record_workspace_landing(
            LandingClaimer::Host(&host),
            &RecordWorkspaceLandingRequest {
                lease: Some(WorkspaceLandingLease {
                    landing_id: pushed.landing.as_ref().unwrap().landing_id.clone(),
                    lease_token: pushed.lease_token.clone(),
                }),
                operation_id: Uuid::new_v4().to_string(),
                state: WorkspaceLandingState::Landed as i32,
                landed_commit: head.clone(),
                pull_request: Some(WorkspacePullRequest::default()),
                ..Default::default()
            },
        )
        .await
        .unwrap_err();
    assert!(
        matches!(refused, StoreError::InvalidArgument(_)),
        "{refused:?}"
    );
    let queued = record(
        &store,
        LandingClaimer::Host(&host),
        &pushed,
        RecordWorkspaceLandingRequest {
            state: WorkspaceLandingState::Landed as i32,
            landed_commit: head.clone(),
            ..Default::default()
        },
    )
    .await;
    assert_eq!(queued.state(), WorkspaceLandingState::Queued);
    assert_eq!(queued.landed_commit, head);
    assert!(
        claim_landing(&store, LandingClaimer::Host(&host))
            .await
            .landing
            .is_none()
    );
    let claimed = claim_landing(&store, LandingClaimer::Delivery(GIT_DELIVERY_PRINCIPAL)).await;
    assert_eq!(claimed.credential, "acme-github");
    assert!(claimed.holder.is_none());
    let landing = claimed.landing.clone().unwrap();
    assert_eq!(landing.mode(), WorkspaceLandingMode::Review);
    assert_eq!(landing.target, "main");
    assert_eq!(landing.session_id, work.work_session_id);
    assert_eq!(landing.title, "Notes");
    assert!(
        landing.body.starts_with("Changed the handbook") && landing.body.contains(&landing.task_id),
        "{}",
        landing.body
    );
    // A review landing names its pull request, on the Workspace's own repository.
    let pull_request = WorkspacePullRequest {
        repository: "acme/handbook".into(),
        repository_id: 42,
        number: 7,
        url: "https://github.com/acme/handbook/pull/7".into(),
    };
    for wrong in [
        None,
        Some(WorkspacePullRequest {
            url: "https://github.com/acme/other/pull/7".into(),
            ..pull_request.clone()
        }),
        Some(WorkspacePullRequest {
            repository: "acme/other".into(),
            ..pull_request.clone()
        }),
    ] {
        let refused = store
            .record_workspace_landing(
                LandingClaimer::Delivery(GIT_DELIVERY_PRINCIPAL),
                &RecordWorkspaceLandingRequest {
                    lease: Some(WorkspaceLandingLease {
                        landing_id: landing.landing_id.clone(),
                        lease_token: claimed.lease_token.clone(),
                    }),
                    operation_id: Uuid::new_v4().to_string(),
                    state: WorkspaceLandingState::Landed as i32,
                    landed_commit: head.clone(),
                    pull_request: wrong,
                    ..Default::default()
                },
            )
            .await
            .unwrap_err();
        assert!(
            matches!(refused, StoreError::InvalidArgument(_)),
            "{refused:?}"
        );
    }
    let landed = record(
        &store,
        LandingClaimer::Delivery(GIT_DELIVERY_PRINCIPAL),
        &claimed,
        RecordWorkspaceLandingRequest {
            state: WorkspaceLandingState::Landed as i32,
            landed_commit: head.clone(),
            pull_request: Some(pull_request.clone()),
            ..Default::default()
        },
    )
    .await;
    assert_eq!(landed.pull_request.as_ref(), Some(&pull_request));
    // Closing another pull request, or replaying the merge, changes nothing else.
    store
        .accept_github_event("connector:github/surface", &merged(8, "other"))
        .await
        .unwrap();
    assert!(
        store
            .get_work_session(OP, &work.work_session_id)
            .await
            .unwrap()
            .closed_at_ms
            .is_none()
    );
    // A merge of its pull request closes the Work Session that opened it.
    for _ in 0..2 {
        let response = store
            .accept_github_event("connector:github/surface", &merged(7, "merged"))
            .await
            .unwrap();
        assert!(response.task.is_none());
        let closed = store
            .get_work_session(OP, &work.work_session_id)
            .await
            .unwrap();
        assert_eq!(closed.close_reason(), WorkSessionCloseReason::Merged);
    }
    store.close().await;
}

fn sqlite(directory: &tempfile::TempDir, name: &str) -> String {
    format!(
        "sqlite://{}?mode=rwc",
        directory.path().join(name).display()
    )
}

async fn postgres(
    contract: fn(String) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()>>>,
) {
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
async fn sqlite_review_landing() {
    let directory = tempfile::tempdir().unwrap();
    Box::pin(review_contract(sqlite(&directory, "review.db"))).await;
}

#[tokio::test]
#[ignore = "requires SUPERTAG_RUST_TEST_POSTGRES_URL_FILE"]
async fn postgres_review_landing() {
    postgres(|url| Box::pin(review_contract(url))).await;
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
