mod support;

use sha2::{Digest, Sha256};
use sqlx::{Connection, Executor};
use std::sync::{
    Arc,
    atomic::{AtomicI64, Ordering},
};
use supertag_control_plane::{Store, StoreError};
use supertag_protocol::v2::*;
use uuid::Uuid;

const OP: &str = "operator:publisher";
const PUBLISHER: &str = "publisher:github/github";
const BASE: &str = "1111111111111111111111111111111111111111";
const HEAD: &str = "2222222222222222222222222222222222222222";

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
                github_source: None,
            }),
            ..Default::default()
        })
        .await
        .unwrap();
    store
        .put_permission_set(
            OP,
            &PutPermissionSetRequest {
                operation_id: "permissions".into(),
                permission_set: Some(PermissionSet {
                    set_id: "repository".into(),
                    name: "repository".into(),
                    permissions: vec![
                        PolicyPermission {
                            target: PolicyPermissionTarget::Surface as i32,
                            surface_account_id: "github".into(),
                            scope: "repository:123".into(),
                            action: "contents:read".into(),
                            ..Default::default()
                        },
                        PolicyPermission {
                            target: PolicyPermissionTarget::Surface as i32,
                            surface_account_id: "github".into(),
                            scope: "repository:123".into(),
                            action: "pull-requests:create".into(),
                            approval_required: true,
                            ..Default::default()
                        },
                    ],
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

async fn completed(store: &Store, session: &str) -> Task {
    let task = store
        .submit_task(
            OP,
            &SubmitTaskRequest {
                tag_id: "engineer".into(),
                session_id: session.into(),
                operation_id: Uuid::new_v4().to_string(),
                prompt: "Update workspace".into(),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    finish_given(store, task, false, false, HEAD).await
}
async fn finish_given(
    store: &Store,
    task: Task,
    question: bool,
    complete: bool,
    head: &str,
) -> Task {
    let host = support::register_host(store, &Uuid::new_v4().to_string()).await;
    let assignment = store
        .claim_task_with_sources(
            &host,
            "claim",
            (&[], &["project".into()]),
            HarnessKind::Unspecified,
            &[],
            None,
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(assignment.task.unwrap().task_id, task.task_id);
    let attempt = InspectAttemptRequest {
        task_id: task.task_id.clone(),
        attempt_id: assignment.attempt_id,
        lease_token: assignment.lease_token,
    };
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
    if question {
        store
            .ask_question(
                &host,
                &AskQuestionRequest {
                    operation_id: "question".into(),
                    attempt: Some(attempt.clone()),
                    text: "May I finish this change?".into(),
                },
            )
            .await
            .unwrap();
    }
    let previous = store
        .get_workspace_continuation(&host, &attempt)
        .await
        .unwrap();
    let start = previous
        .as_ref()
        .map_or(BASE, |delivery| delivery.head_commit.as_str());
    let changed = start != head;
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
            bundle: Some(blob(b"bundle")),
        }),
    };
    store
        .reserve_workspace_delivery(&host, &delivery)
        .await
        .unwrap();
    store
        .commit_workspace_delivery(&host, &delivery)
        .await
        .unwrap();
    let request = FinishTaskRequest {
        task_id: attempt.task_id,
        attempt_id: attempt.attempt_id,
        lease_token: attempt.lease_token,
        result: "Verified change".into(),
        succeeded: true,
        workspace_delivery: delivery.delivery,
        objective_signal: if complete {
            ObjectiveSignal::Completed as i32
        } else {
            ObjectiveSignal::Progress as i32
        },
        ..Default::default()
    };
    let finished = store.finish_task(&host, &request).await.unwrap();
    assert_eq!(finished, store.finish_task(&host, &request).await.unwrap());
    finished
}

async fn claim(store: &Store, op: &str) -> ClaimGithubPublicationResponse {
    store
        .claim_github_publication(
            PUBLISHER,
            &ClaimGithubPublicationRequest {
                operation_id: op.into(),
            },
        )
        .await
        .unwrap()
}
fn lease(claim: &ClaimGithubPublicationResponse) -> GithubPublicationLease {
    GithubPublicationLease {
        publication_id: claim.publication.as_ref().unwrap().publication_id.clone(),
        lease_token: claim.lease_token.clone(),
    }
}
fn receipt(job: &GithubPublication) -> GithubPullRequestReceipt {
    GithubPullRequestReceipt {
        number: 7,
        url: "https://github.com/acme/project/pull/7".into(),
        repository_id: 123,
        repository: "acme/project".into(),
        head_branch: job.head_branch.clone(),
        base_branch: "main".into(),
        head_commit: HEAD.into(),
        open: true,
        merged: false,
        draft: true,
        title: job.title.clone(),
        body: job.body.clone(),
    }
}
async fn known_push_resume(store: &Store, clock: &Arc<AtomicI64>) {
    let task = Box::pin(completed(store, "known-push")).await;
    let initial = claim(store, "known-push-claim").await;
    let planned = store
        .plan_github_publication(
            PUBLISHER,
            &PlanGithubPublicationRequest {
                lease: Some(lease(&initial)),
                operation_id: "known-push-plan".into(),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    store
        .decide_approval(
            OP,
            &DecideApprovalRequest {
                approval_id: planned.approval_id.unwrap(),
                operation_id: "known-push-approval".into(),
                approve: true,
                scope: ApprovalScope::Once as i32,
                ..Default::default()
            },
        )
        .await
        .unwrap();
    let active = claim(store, "known-push-approved").await;
    store
        .plan_github_publication(
            PUBLISHER,
            &PlanGithubPublicationRequest {
                lease: Some(lease(&active)),
                operation_id: "known-push-recheck".into(),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    store
        .begin_github_publication_effect(
            PUBLISHER,
            &BeginGithubPublicationEffectRequest {
                lease: Some(lease(&active)),
                operation_id: "known-push-begin".into(),
                phase: GithubPublicationPhase::Push as i32,
            },
        )
        .await
        .unwrap();
    store
        .record_github_publication_effect(
            PUBLISHER,
            &RecordGithubPublicationEffectRequest {
                lease: Some(lease(&active)),
                operation_id: "known-push-receipt".into(),
                phase: GithubPublicationPhase::Push as i32,
                state: GithubPublicationState::Claimed as i32,
                pushed_commit: Some(HEAD.into()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    clock.fetch_add(30_000, Ordering::SeqCst);
    let restored = claim(store, "known-push-restored").await;
    assert!(
        !restored.read_only,
        "a proven push before Create reservation is safely resumable"
    );
    let job = restored.publication.as_ref().unwrap();
    assert_eq!(job.task_id, task.task_id);
    assert_eq!(job.phase(), GithubPublicationPhase::Push);
    assert!(
        store
            .begin_github_publication_effect(
                PUBLISHER,
                &BeginGithubPublicationEffectRequest {
                    lease: Some(lease(&restored)),
                    operation_id: "known-push-no-recheck".into(),
                    phase: GithubPublicationPhase::Create as i32
                }
            )
            .await
            .is_err()
    );
    assert!(
        store
            .plan_github_publication(
                PUBLISHER,
                &PlanGithubPublicationRequest {
                    lease: Some(lease(&restored)),
                    operation_id: "known-push-no-proof".into(),
                    ..Default::default()
                }
            )
            .await
            .is_err()
    );
    store
        .plan_github_publication(
            PUBLISHER,
            &PlanGithubPublicationRequest {
                lease: Some(lease(&restored)),
                operation_id: "known-push-proof".into(),
                pushed_commit: Some(HEAD.into()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert!(
        store
            .begin_github_publication_effect(
                PUBLISHER,
                &BeginGithubPublicationEffectRequest {
                    lease: Some(lease(&restored)),
                    operation_id: "known-push-no-repush".into(),
                    phase: GithubPublicationPhase::Push as i32
                }
            )
            .await
            .is_err()
    );
    store
        .begin_github_publication_effect(
            PUBLISHER,
            &BeginGithubPublicationEffectRequest {
                lease: Some(lease(&restored)),
                operation_id: "known-push-create".into(),
                phase: GithubPublicationPhase::Create as i32,
            },
        )
        .await
        .unwrap();
    store
        .record_github_publication_effect(
            PUBLISHER,
            &RecordGithubPublicationEffectRequest {
                lease: Some(lease(&restored)),
                operation_id: "known-push-published".into(),
                phase: GithubPublicationPhase::Create as i32,
                state: GithubPublicationState::Published as i32,
                pull_request: Some(receipt(job)),
                ..Default::default()
            },
        )
        .await
        .unwrap();
}
async fn contract(url: &str) {
    let clock = Arc::new(AtomicI64::new(1_000_000));
    let timer = clock.clone();
    let store = Store::open(url)
        .await
        .unwrap()
        .with_execution_clock(move || timer.load(Ordering::SeqCst));
    Box::pin(setup(&store)).await;
    let task = Box::pin(completed(&store, "work")).await;
    let jobs = store
        .list_github_publications(OP, &ListGithubPublicationsRequest::default())
        .await
        .unwrap();
    assert_eq!(jobs.publications.len(), 1);
    assert_eq!(jobs.publications[0].task_id, task.task_id);
    assert_eq!(
        store.get_task(&task.task_id).await.unwrap().state(),
        TaskState::Succeeded
    );
    assert!(
        store
            .claim_github_publication(
                "publisher:github/other",
                &ClaimGithubPublicationRequest {
                    operation_id: "other".into()
                }
            )
            .await
            .unwrap()
            .publication
            .is_none()
    );
    let (first, replay) = tokio::join!(claim(&store, "claim"), claim(&store, "claim"));
    assert_eq!(first, replay);
    assert!(!first.read_only);
    assert!(claim(&store, "concurrent").await.publication.is_none());
    let plan = PlanGithubPublicationRequest {
        lease: Some(lease(&first)),
        operation_id: "plan".into(),
        existing: None,
        pushed_commit: None,
    };
    let waiting = store
        .plan_github_publication(PUBLISHER, &plan)
        .await
        .unwrap();
    assert_eq!(waiting.state(), GithubPublicationState::WaitingApproval);
    assert_eq!(
        waiting,
        store
            .plan_github_publication(PUBLISHER, &plan)
            .await
            .unwrap()
    );
    let approval_id = waiting.approval_id.unwrap();
    let approval = store.get_approval(OP, &approval_id).await.unwrap();
    assert_eq!(approval.state(), ApprovalState::Pending);
    assert!(approval.canonical_arguments_json.contains(HEAD));
    let inbox = store
        .list_inbox_items(OP, &ListInboxItemsRequest::default())
        .await
        .unwrap();
    assert!(inbox.items.iter().any(|item| {
        item.approval
            .as_ref()
            .is_some_and(|a| a.approval_id == approval_id)
    }));
    let decision = DecideApprovalRequest {
        approval_id: approval_id.clone(),
        operation_id: "approve".into(),
        approve: true,
        valid_until_ms: Some(clock.load(Ordering::SeqCst) + 10_000),
        scope: ApprovalScope::Once as i32,
        ..Default::default()
    };
    let approved = store.decide_approval(OP, &decision).await.unwrap();
    assert_eq!(approved.state(), ApprovalState::Approved);
    assert_eq!(
        approved,
        store.decide_approval(OP, &decision).await.unwrap()
    );
    assert!(approved.continuation_task_id.is_none());
    drop(store);
    let timer = clock.clone();
    let store = Store::open(url)
        .await
        .unwrap()
        .with_execution_clock(move || timer.load(Ordering::SeqCst));
    let second = claim(&store, "approved-claim").await;
    assert!(
        store
            .begin_github_publication_effect(
                PUBLISHER,
                &BeginGithubPublicationEffectRequest {
                    lease: Some(lease(&second)),
                    operation_id: "without-fresh-discovery".into(),
                    phase: GithubPublicationPhase::Push as i32
                }
            )
            .await
            .is_err()
    );

    store
        .plan_github_publication(
            PUBLISHER,
            &PlanGithubPublicationRequest {
                lease: Some(lease(&second)),
                operation_id: "recheck".into(),
                existing: None,
                pushed_commit: None,
            },
        )
        .await
        .unwrap();
    assert!(
        store
            .begin_github_publication_effect(
                PUBLISHER,
                &BeginGithubPublicationEffectRequest {
                    lease: Some(lease(&second)),
                    operation_id: "out-of-order".into(),
                    phase: GithubPublicationPhase::Create as i32
                }
            )
            .await
            .is_err()
    );
    let push = BeginGithubPublicationEffectRequest {
        lease: Some(lease(&second)),
        operation_id: "push".into(),
        phase: GithubPublicationPhase::Push as i32,
    };
    let sending = store
        .begin_github_publication_effect(PUBLISHER, &push)
        .await
        .unwrap();
    assert_eq!(sending.state(), GithubPublicationState::Sending);
    assert_eq!(
        sending,
        store
            .begin_github_publication_effect(PUBLISHER, &push)
            .await
            .unwrap()
    );
    store
        .record_github_publication_effect(
            PUBLISHER,
            &RecordGithubPublicationEffectRequest {
                lease: Some(lease(&second)),
                operation_id: "pushed".into(),
                phase: GithubPublicationPhase::Push as i32,
                state: GithubPublicationState::Claimed as i32,
                pushed_commit: Some(HEAD.into()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    let create = store
        .begin_github_publication_effect(
            PUBLISHER,
            &BeginGithubPublicationEffectRequest {
                lease: Some(lease(&second)),
                operation_id: "create".into(),
                phase: GithubPublicationPhase::Create as i32,
            },
        )
        .await
        .unwrap();
    assert!(
        store
            .record_github_publication_effect(
                PUBLISHER,
                &RecordGithubPublicationEffectRequest {
                    lease: Some(lease(&second)),
                    operation_id: "cannot-declare-ambiguous-effect-absent".into(),
                    phase: GithubPublicationPhase::Create as i32,
                    state: GithubPublicationState::Held as i32,
                    reason: "Unknown result".into(),
                    ..Default::default()
                }
            )
            .await
            .is_err()
    );
    store
        .cancel_github_publication(
            OP,
            &CancelGithubPublicationRequest {
                publication_id: create.publication_id.clone(),
                operation_id: "cancel-in-flight".into(),
                reason: "Stop any further writes".into(),
            },
        )
        .await
        .unwrap();
    clock.fetch_add(30_000, Ordering::SeqCst);
    let replacement = claim(&store, "replacement").await;
    assert!(replacement.read_only);
    assert!(
        store
            .renew_github_publication(PUBLISHER, &lease(&replacement))
            .await
            .unwrap()
            .read_only,
        "read-only reconciliation remains possible after approval validity expires"
    );
    assert!(
        store
            .renew_github_publication(PUBLISHER, &lease(&second))
            .await
            .is_err()
    );
    assert!(
        store
            .begin_github_publication_effect(
                PUBLISHER,
                &BeginGithubPublicationEffectRequest {
                    lease: Some(lease(&replacement)),
                    operation_id: "repost".into(),
                    phase: GithubPublicationPhase::Create as i32
                }
            )
            .await
            .is_err()
    );
    let settle = RecordGithubPublicationEffectRequest {
        lease: Some(lease(&replacement)),
        operation_id: "observed".into(),
        phase: GithubPublicationPhase::Create as i32,
        state: GithubPublicationState::Published as i32,
        pull_request: Some(receipt(&create)),
        ..Default::default()
    };
    let mut wrong = settle.clone();
    wrong.operation_id = "unproved-metadata".into();
    wrong.pull_request.as_mut().unwrap().body = "old metadata".into();
    assert!(
        store
            .record_github_publication_effect(PUBLISHER, &wrong)
            .await
            .is_err()
    );
    let published = store
        .record_github_publication_effect(PUBLISHER, &settle)
        .await
        .unwrap();
    assert_eq!(published.state(), GithubPublicationState::Published);
    assert_eq!(
        published,
        store
            .record_github_publication_effect(PUBLISHER, &settle)
            .await
            .unwrap()
    );
    assert!(claim(&store, "finished").await.publication.is_none());
    assert_eq!(
        store.get_task(&task.task_id).await.unwrap().state(),
        TaskState::Succeeded
    );
    let cancelled_task = Box::pin(completed(&store, "cancelled")).await;
    let job = store
        .list_github_publications(
            OP,
            &ListGithubPublicationsRequest {
                task_id: cancelled_task.task_id.clone(),
                ..Default::default()
            },
        )
        .await
        .unwrap()
        .publications
        .remove(0);
    let request = CancelGithubPublicationRequest {
        publication_id: job.publication_id,
        operation_id: "cancel".into(),
        reason: "Keep this change local".into(),
    };
    let cancelled = store.cancel_github_publication(OP, &request).await.unwrap();
    assert_eq!(cancelled.state(), GithubPublicationState::Cancelled);
    assert_eq!(
        cancelled,
        store.cancel_github_publication(OP, &request).await.unwrap()
    );
    assert_eq!(
        store
            .get_task(&cancelled_task.task_id)
            .await
            .unwrap()
            .state(),
        TaskState::Succeeded
    );
    assert!(matches!(
        store
            .cancel_github_publication("host:worker", &request)
            .await,
        Err(StoreError::PermissionDenied)
    ));
    let old = Box::pin(completed(&store, "superseded")).await;
    let old_job = store
        .list_github_publications(
            OP,
            &ListGithubPublicationsRequest {
                task_id: old.task_id.clone(),
                ..Default::default()
            },
        )
        .await
        .unwrap()
        .publications
        .remove(0);
    let later = store
        .submit_task(
            OP,
            &SubmitTaskRequest {
                tag_id: "engineer".into(),
                session_id: "superseded".into(),
                operation_id: "newer-work".into(),
                prompt: "Refine the result".into(),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert!(
        claim(&store, "later-turn-active")
            .await
            .publication
            .is_none()
    );
    let later = Box::pin(finish_given(
        &store,
        later,
        false,
        false,
        "3333333333333333333333333333333333333333",
    ))
    .await;
    assert_eq!(
        store
            .get_github_publication(
                OP,
                &GetGithubPublicationRequest {
                    publication_id: old_job.publication_id
                }
            )
            .await
            .unwrap()
            .state(),
        GithubPublicationState::Cancelled
    );
    let latest = claim(&store, "latest-head").await;
    assert_eq!(latest.publication.as_ref().unwrap().task_id, later.task_id);
    let waiting = store
        .plan_github_publication(
            PUBLISHER,
            &PlanGithubPublicationRequest {
                lease: Some(lease(&latest)),
                operation_id: "latest-plan".into(),
                existing: None,
                pushed_commit: None,
            },
        )
        .await
        .unwrap();
    store
        .decide_approval(
            OP,
            &DecideApprovalRequest {
                approval_id: waiting.approval_id.unwrap(),
                operation_id: "latest-approve".into(),
                approve: true,
                scope: ApprovalScope::Once as i32,
                ..Default::default()
            },
        )
        .await
        .unwrap();
    let fresh = claim(&store, "latest-approved").await;
    let changed = store
        .plan_github_publication(
            PUBLISHER,
            &PlanGithubPublicationRequest {
                lease: Some(lease(&fresh)),
                operation_id: "changed-while-approval".into(),
                existing: Some(receipt(fresh.publication.as_ref().unwrap())),
                pushed_commit: None,
            },
        )
        .await
        .unwrap();
    assert_eq!(
        changed.state(),
        GithubPublicationState::Held,
        "provider history changed while approving first publication"
    );
    Box::pin(known_push_resume(&store, &clock)).await;
    let objective = store
        .create_objective(
            OP,
            &CreateObjectiveRequest {
                operation_id: "objective".into(),
                objective_id: "reviewed-change".into(),
                owner_tag_id: "engineer".into(),
                outcome: "Finish the change after asking".into(),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    let first = store.get_task(&objective.starting_task_id).await.unwrap();
    let first = Box::pin(finish_given(&store, first, true, false, HEAD)).await;
    assert!(
        claim(&store, "question-blocked")
            .await
            .publication
            .is_none()
    );
    let answer = store
        .answer_question(
            OP,
            &AnswerQuestionRequest {
                task_id: first.task_id.clone(),
                operation_id: "answer".into(),
                text: "Yes, finish it".into(),
            },
        )
        .await
        .unwrap();
    assert!(claim(&store, "answer-running").await.publication.is_none());
    let task = answer;
    let done = Box::pin(finish_given(&store, task, false, true, HEAD)).await;
    assert!(
        !done.workspace_delivery.unwrap().committed,
        "no-op answer retains original published head"
    );
    let available = claim(&store, "question-settled").await;
    assert_eq!(
        available.publication.as_ref().unwrap().task_id,
        first.task_id
    );
    let waiting = store
        .plan_github_publication(
            PUBLISHER,
            &PlanGithubPublicationRequest {
                lease: Some(lease(&available)),
                operation_id: "objective-plan".into(),
                existing: None,
                pushed_commit: None,
            },
        )
        .await
        .unwrap();
    let id = waiting.approval_id.unwrap();
    assert_eq!(
        store.get_approval(OP, &id).await.unwrap().state(),
        ApprovalState::Pending,
        "completed Objective does not invalidate exact publication approval"
    );
    assert!(
        store
            .decide_approval(
                OP,
                &DecideApprovalRequest {
                    approval_id: id.clone(),
                    operation_id: "broad-scope".into(),
                    approve: true,
                    scope: ApprovalScope::Objective as i32,
                    ..Default::default()
                }
            )
            .await
            .is_err()
    );
    store
        .decide_approval(
            OP,
            &DecideApprovalRequest {
                approval_id: id,
                operation_id: "exact-objective-publication".into(),
                approve: true,
                scope: ApprovalScope::Once as i32,
                ..Default::default()
            },
        )
        .await
        .unwrap();
}

#[tokio::test]
async fn sqlite_publication_contract() {
    let directory = tempfile::tempdir().unwrap();
    Box::pin(contract(&format!(
        "sqlite://{}?mode=rwc",
        directory.path().join("state.db").display()
    )))
    .await;
}
#[tokio::test]
#[ignore = "requires dedicated PostgreSQL server"]
async fn postgres_publication_contract() {
    let file =
        std::env::var_os("SUPERTAG_RUST_TEST_POSTGRES_URL_FILE").expect("test database file");
    let admin_url = std::fs::read_to_string(file).unwrap();
    let mut url = url::Url::parse(admin_url.trim()).unwrap();
    let database = format!("supertag_publication_{}", Uuid::new_v4().simple());
    let mut admin = sqlx::PgConnection::connect(admin_url.trim()).await.unwrap();
    admin
        .execute(format!("CREATE DATABASE {database}").as_str())
        .await
        .unwrap();
    url.set_path(&database);
    let result = tokio::task::LocalSet::new()
        .run_until(async move {
            tokio::task::spawn_local(async move { Box::pin(contract(url.as_str())).await }).await
        })
        .await;
    admin
        .execute(format!("DROP DATABASE {database} WITH (FORCE)").as_str())
        .await
        .unwrap();
    result.unwrap();
}
