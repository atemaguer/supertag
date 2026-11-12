#[path = "support/report_scope.rs"]
mod report_scope;
mod support;

use prost::Message;
use sha2::{Digest, Sha256};
use sqlx::{Connection, Executor};
use std::sync::{
    Arc,
    atomic::{AtomicI64, Ordering},
};
use supertag_control_plane::{HostAuthority, Store, StoreError};
use supertag_protocol::v2::*;
use uuid::Uuid;

const OPERATOR: &str = "operator:reviews";
const BASE: &str = "1111111111111111111111111111111111111111";
const HEAD: &str = "2222222222222222222222222222222222222222";
const NOW: i64 = 1_900_000_000_000;

async fn open(url: &str, clock: &Arc<AtomicI64>) -> Store {
    let clock = clock.clone();
    Store::open(url)
        .await
        .unwrap()
        .with_execution_clock(move || clock.load(Ordering::SeqCst))
}

async fn start(store: &Store, host: &HostAuthority, expected: &str) -> InspectAttemptRequest {
    let assignment = store
        .claim_task_with_workspaces(host, &Uuid::new_v4().to_string(), &["repo".into()])
        .await
        .unwrap()
        .unwrap();
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

async fn finish(
    store: &Store,
    host: &HostAuthority,
    attempt: &InspectAttemptRequest,
    head: Option<&str>,
) {
    finish_waiting(store, host, attempt, head, vec![]).await;
}

async fn finish_waiting(
    store: &Store,
    host: &HostAuthority,
    attempt: &InspectAttemptRequest,
    head: Option<&str>,
    waiting: Vec<String>,
) {
    let mut input = FinishTaskRequest {
        task_id: attempt.task_id.clone(),
        attempt_id: attempt.attempt_id.clone(),
        lease_token: attempt.lease_token.clone(),
        result: "Completed fixture".into(),
        succeeded: true,
        waiting_approval_ids: waiting,
        ..Default::default()
    };
    if let Some(head) = head {
        let prior = store
            .get_workspace_continuation(host, attempt)
            .await
            .unwrap();
        let start = prior
            .as_ref()
            .map_or(BASE, |value| value.head_commit.as_str());
        let blob = BlobReference {
            sha256: "a".repeat(64),
            byte_length: 10,
        };
        let delivery = WorkspaceDeliveryRequest {
            attempt: Some(attempt.clone()),
            delivery: Some(WorkspaceDeliveryReference {
                workspace_id: "repo".into(),
                delivery_id: format!(
                    "{:x}",
                    Sha256::digest(
                        serde_json::to_vec(&(&attempt.task_id, &attempt.attempt_id)).unwrap()
                    )
                ),
                base_commit: BASE.into(),
                start_commit: start.into(),
                head_commit: head.into(),
                committed: start != head,
                changed_files: u64::from(start != head),
                patch: Some(BlobReference {
                    byte_length: if start == head { 0 } else { 10 },
                    ..blob.clone()
                }),
                bundle: Some(blob),
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
        input.workspace_delivery = delivery.delivery;
    }
    store.finish_task(host, &input).await.unwrap();
}

fn request(
    attempt: &InspectAttemptRequest,
    operation: &str,
    reviewer: &str,
    commit: &str,
) -> SendAttemptTagMessageRequest {
    SendAttemptTagMessageRequest {
        attempt: Some(attempt.clone()),
        operation_id: operation.into(),
        recipient_tag_id: reviewer.into(),
        text: "Review this exact commit".into(),
        review: Some(CommitReviewSubmission {
            kind: Some(commit_review_submission::Kind::Commit(commit.into())),
        }),
    }
}

fn response(attempt: &InspectAttemptRequest, request: &str) -> SendAttemptTagMessageRequest {
    SendAttemptTagMessageRequest {
        attempt: Some(attempt.clone()),
        operation_id: "verdict".into(),
        recipient_tag_id: "owner".into(),
        text: "Approved after inspecting the immutable patch".into(),
        review: Some(CommitReviewSubmission {
            kind: Some(commit_review_submission::Kind::Response(
                CommitReviewResponse {
                    request_id: request.into(),
                    verdict: CommitReviewDecision::Approved.into(),
                },
            )),
        }),
    }
}

async fn contract(url: &str) {
    gated_request_contract(url).await;
    let clock = Arc::new(AtomicI64::new(NOW));
    let store = open(url, &clock).await;
    let pool = sqlx::AnyPool::connect(url).await.unwrap();
    let host = support::register_host(&store, "reviews").await;
    store
        .put_tag_with_workspace(
            "owner",
            "Coordinate the review",
            vec!["files:read".into(), "mailbox:send".into()],
            Some(WorkspaceSpec {
                workspace_id: "repo".into(),
                base_commit: BASE.into(),
            }),
        )
        .await
        .unwrap();
    for tag in ["reviewer", "second", "stranger", "gated"] {
        store
            .put_tag(
                tag,
                "Inspect the commit",
                vec!["files:read".into(), "mailbox:send".into()],
            )
            .await
            .unwrap();
        for (sender, recipient) in [("owner", tag), (tag, "owner")] {
            store
                .change_mailbox_grant(
                    OPERATOR,
                    &ChangeMailboxGrantRequest {
                        operation_id: format!("{sender}-{recipient}"),
                        sender_tag_id: sender.into(),
                        recipient_tag_id: recipient.into(),
                        granted: true,
                    },
                )
                .await
                .unwrap();
        }
    }
    store
        .put_tag_spec(PutTagRequest {
            tag_id: "gated".into(),
            instructions: "Inspect the commit".into(),
            allowed_actions: vec!["files:read".into(), "mailbox:send".into()],
            approval_rules: vec![ApprovalRule {
                action: "mailbox:send".into(),
                operator_ids: vec!["reviews".into()],
            }],
            ..Default::default()
        })
        .await
        .unwrap();
    let objective = store
        .create_objective(
            OPERATOR,
            &CreateObjectiveRequest {
                operation_id: "goal".into(),
                objective_id: "goal".into(),
                owner_tag_id: "owner".into(),
                outcome: "Ship a reviewed change".into(),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    let owner = start(&store, &host, &objective.starting_task_id).await;
    assert!(matches!(
        store
            .send_attempt_tag_message(&host, &request(&owner, "undelivered", "reviewer", HEAD))
            .await,
        Err(StoreError::FailedPrecondition(_))
    ));
    let child = store
        .start_work_session(
            &host,
            &StartWorkSessionRequest {
                attempt: Some(owner.clone()),
                operation_id: "implementation".into(),
                title: "Implement".into(),
                instruction: "Change the fixture".into(),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    let no_op_child = store
        .start_work_session(
            &host,
            &StartWorkSessionRequest {
                attempt: Some(owner.clone()),
                operation_id: "unchanged".into(),
                title: "Inspect".into(),
                instruction: "Inspect without changes".into(),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    finish(&store, &host, &owner, Some(BASE)).await;
    let work = start(&store, &host, &child.latest_task_id).await;
    finish(&store, &host, &work, Some(HEAD)).await;
    let unchanged = start(&store, &host, &no_op_child.latest_task_id).await;
    finish(&store, &host, &unchanged, Some(BASE)).await;
    let child = store
        .get_work_session(OPERATOR, &child.work_session_id)
        .await
        .unwrap();
    let report = start(&store, &host, child.report_task_id.as_ref().unwrap()).await;
    assert!(
        store
            .attempt_capabilities(&host, &report)
            .await
            .unwrap()
            .may_request_commit_review
    );
    assert!(
        matches!(
            store
                .send_attempt_tag_message(
                    &host,
                    &request(&report, "other-child-commit", "reviewer", BASE)
                )
                .await,
            Err(StoreError::FailedPrecondition(_))
        ),
        "an owner report cannot request a different child's commit"
    );
    assert!(matches!(
        store
            .send_attempt_tag_message(
                &host,
                &request(&report, "wrong-commit", "reviewer", &"3".repeat(40))
            )
            .await,
        Err(StoreError::FailedPrecondition(_))
    ));
    let input = request(&report, "first-review", "reviewer", HEAD);
    let (left, right) = tokio::join!(
        store.send_attempt_tag_message(&host, &input),
        store.send_attempt_tag_message(&host, &input)
    );
    let first = left.unwrap().message.unwrap();
    assert_eq!(right.unwrap().message.unwrap(), first);
    let pinned = first.review.as_ref().unwrap();
    assert_eq!(pinned.source_task_id, work.task_id);
    assert_eq!(pinned.commit, HEAD);
    assert!(pinned.verdict.is_none());
    assert!(matches!(
        store
            .get_review_artifact(
                &host,
                &GetReviewArtifactRequest {
                    attempt: Some(report.clone()),
                    review_id: first.message_id.clone()
                }
            )
            .await,
        Err(StoreError::PermissionDenied)
    ));
    let second = store
        .send_attempt_tag_message(&host, &request(&report, "second-review", "second", HEAD))
        .await
        .unwrap()
        .message
        .unwrap();
    let continuation = store
        .continue_work_session(
            &host,
            &ContinueWorkSessionRequest {
                attempt: Some(report.clone()),
                operation_id: "obsolete-child".into(),
                work_session_id: child.work_session_id.clone(),
                message: "Inspect one more detail".into(),
            },
        )
        .await
        .unwrap();
    assert!(
        !store
            .attempt_capabilities(&host, &report)
            .await
            .unwrap()
            .may_request_commit_review
    );
    assert!(matches!(
        store
            .send_attempt_tag_message(
                &host,
                &request(&report, "obsolete-commit", "reviewer", HEAD)
            )
            .await,
        Err(StoreError::FailedPrecondition(_))
    ));
    assert_eq!(
        store
            .send_attempt_tag_message(&host, &input)
            .await
            .unwrap()
            .message
            .unwrap(),
        first,
        "accepted request replay stays stable after the child advances"
    );
    finish(&store, &host, &report, Some(BASE)).await;
    let no_op_child = store
        .get_work_session(OPERATOR, &no_op_child.work_session_id)
        .await
        .unwrap();
    let no_op_report = start(&store, &host, no_op_child.report_task_id.as_ref().unwrap()).await;
    let no_op_review = store
        .send_attempt_tag_message(
            &host,
            &request(&no_op_report, "no-op-review", "gated", BASE),
        )
        .await
        .unwrap()
        .message
        .unwrap();
    finish(&store, &host, &no_op_report, Some(BASE)).await;
    assert_eq!(
        store.get_objective("goal").await.unwrap().status(),
        ObjectiveStatus::Working
    );
    let idle: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM supertag_v2_objective_notices WHERE objective_id='goal' AND notice_key LIKE 'idle:%'").fetch_one(&pool).await.unwrap();
    assert_eq!(
        idle, 0,
        "a pending commit review prevents premature finite-Objective idle continuation"
    );
    let page = store
        .list_objective_commit_reviews(&ListObjectiveCommitReviewsRequest {
            objective_id: "goal".into(),
            limit: 1,
            before_order: 0,
        })
        .await
        .unwrap();
    assert_eq!(page.reviews[0].request_id, no_op_review.message_id);
    assert_ne!(page.next_before_order, 0);
    let page2 = store
        .list_objective_commit_reviews(&ListObjectiveCommitReviewsRequest {
            objective_id: "goal".into(),
            limit: 1,
            before_order: page.next_before_order,
        })
        .await
        .unwrap();
    assert_eq!(page2.reviews[0].request_id, second.message_id);
    let page3 = store
        .list_objective_commit_reviews(&ListObjectiveCommitReviewsRequest {
            objective_id: "goal".into(),
            limit: 1,
            before_order: page2.next_before_order,
        })
        .await
        .unwrap();
    assert_eq!(page3.reviews[0].request_id, first.message_id);
    assert_eq!(page3.next_before_order, 0);
    let assignment = store
        .claim_task_with_workspaces(&host, "reviewer-first", &["repo".into()])
        .await
        .unwrap()
        .unwrap();
    assert_eq!(assignment.task.as_ref().unwrap().tag_id, "reviewer");
    let reviewer = InspectAttemptRequest {
        task_id: assignment.task.unwrap().task_id,
        attempt_id: assignment.attempt_id,
        lease_token: assignment.lease_token,
    };
    let artifact = GetReviewArtifactRequest {
        attempt: Some(reviewer.clone()),
        review_id: first.message_id.clone(),
    };
    assert!(matches!(
        store.get_review_artifact(&host, &artifact).await,
        Err(StoreError::FailedPrecondition(_))
    ));
    store
        .start_task(
            &host,
            &StartTaskRequest {
                task_id: reviewer.task_id.clone(),
                attempt_id: reviewer.attempt_id.clone(),
                lease_token: reviewer.lease_token.clone(),
            },
        )
        .await
        .unwrap();
    let frozen = store.get_review_artifact(&host, &artifact).await.unwrap();
    assert_eq!(
        frozen,
        store
            .get_task(&work.task_id)
            .await
            .unwrap()
            .workspace_delivery
            .unwrap()
    );
    let wrong_token = GetReviewArtifactRequest {
        attempt: Some(InspectAttemptRequest {
            lease_token: "wrong".into(),
            ..reviewer.clone()
        }),
        ..artifact.clone()
    };
    assert!(matches!(
        store.get_review_artifact(&host, &wrong_token).await,
        Err(StoreError::PermissionDenied)
    ));
    let other_host = support::register_host(&store, "wrong-host").await;
    assert!(matches!(
        store.get_review_artifact(&other_host, &artifact).await,
        Err(StoreError::PermissionDenied)
    ));
    store
        .put_tag("owner", "Changed future settings", vec![])
        .await
        .unwrap();
    assert_eq!(
        store.get_review_artifact(&host, &artifact).await.unwrap(),
        frozen
    );
    store
        .pause_objective(
            OPERATOR,
            &ObjectiveActionRequest {
                objective_id: "goal".into(),
                operation_id: "pause".into(),
                reason: "Await operator".into(),
            },
        )
        .await
        .unwrap();
    let verdict = response(&reviewer, &first.message_id);
    let (left, right) = tokio::join!(
        store.send_attempt_tag_message(&host, &verdict),
        store.send_attempt_tag_message(&host, &verdict)
    );
    let recorded = left.unwrap().review.unwrap();
    assert_eq!(right.unwrap().review.unwrap(), recorded);
    assert_eq!(recorded.verdict.as_ref().unwrap().task_id, reviewer.task_id);
    let mut conflict = verdict.clone();
    conflict.operation_id = "conflicting-verdict".into();
    conflict.text = "Changed opinion".into();
    assert!(matches!(
        store.send_attempt_tag_message(&host, &conflict).await,
        Err(StoreError::Conflict(_))
    ));
    store.sweep_commit_reviews().await.unwrap();
    let notices: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM supertag_v2_objective_notices WHERE notice_key LIKE 'review:%'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        notices, 0,
        "paused Objectives retain verdicts without executing notices"
    );
    finish(&store, &host, &reviewer, None).await;
    assert!(matches!(
        store.get_review_artifact(&host, &artifact).await,
        Err(StoreError::FailedPrecondition(_))
    ));
    // Restore the owner binding before the paused Objective is resumed.
    store
        .put_tag_with_workspace(
            "owner",
            "Coordinate the review",
            vec!["files:read".into(), "mailbox:send".into()],
            Some(WorkspaceSpec {
                workspace_id: "repo".into(),
                base_commit: BASE.into(),
            }),
        )
        .await
        .unwrap();
    store.close().await;
    let store = open(url, &clock).await;
    store
        .resume_objective(
            OPERATOR,
            &ObjectiveActionRequest {
                objective_id: "goal".into(),
                operation_id: "resume".into(),
                reason: "Continue".into(),
            },
        )
        .await
        .unwrap();
    // A changed owner binding prevents admission, but cannot erase a verdict or
    // make its outbox entry block the sweeper transaction indefinitely.
    store
        .put_tag("owner", "A temporarily incompatible binding", vec![])
        .await
        .unwrap();
    store.sweep_commit_reviews().await.unwrap();
    let deferred: i64 = sqlx::query_scalar(
        "SELECT notice_retry_at_ms FROM supertag_v2_commit_reviews WHERE request_id=$1",
    )
    .bind(&first.message_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(deferred, NOW + 30_000);
    let notices: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM supertag_v2_objective_notices WHERE notice_key=$1",
    )
    .bind(format!("review:{}", first.message_id))
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(notices, 0);
    store.close().await;
    let store = open(url, &clock).await;
    store
        .put_tag_with_workspace(
            "owner",
            "Coordinate the review",
            vec!["files:read".into(), "mailbox:send".into()],
            Some(WorkspaceSpec {
                workspace_id: "repo".into(),
                base_commit: BASE.into(),
            }),
        )
        .await
        .unwrap();
    clock.store(NOW + 30_001, Ordering::SeqCst);
    store.sweep_commit_reviews().await.unwrap();
    store.sweep_commit_reviews().await.unwrap();
    let notices: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM supertag_v2_objective_notices WHERE notice_key=$1",
    )
    .bind(format!("review:{}", first.message_id))
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(notices, 1);
    let review = store
        .list_objective_commit_reviews(&ListObjectiveCommitReviewsRequest {
            objective_id: "goal".into(),
            ..Default::default()
        })
        .await
        .unwrap()
        .reviews
        .into_iter()
        .find(|r| r.request_id == first.message_id)
        .unwrap();
    assert_eq!(review, recorded);
    let second_id: String = sqlx::query_scalar(
        "SELECT task_id FROM supertag_v2_mailbox_tasks WHERE recipient_tag_id='second'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    let second_attempt = start(&store, &host, &second_id).await;
    assert!(matches!(
        store
            .send_attempt_tag_message(&host, &response(&second_attempt, &first.message_id))
            .await,
        Err(StoreError::PermissionDenied) | Err(StoreError::NotFound(_))
    ));
    store
        .cancel_objective(
            OPERATOR,
            &ObjectiveActionRequest {
                objective_id: "goal".into(),
                operation_id: "close".into(),
                reason: "Stop".into(),
            },
        )
        .await
        .unwrap();
    let closed_verdict = store
        .send_attempt_tag_message(&host, &response(&second_attempt, &second.message_id))
        .await
        .unwrap()
        .review
        .unwrap();
    assert!(
        closed_verdict.verdict.is_some(),
        "closure retains the attributable audit verdict"
    );
    store.sweep_commit_reviews().await.unwrap();
    let notices: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM supertag_v2_objective_notices WHERE notice_key=$1",
    )
    .bind(format!("review:{}", second.message_id))
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        notices, 0,
        "closed Objectives are not restarted by reviewer replies"
    );
    assert_eq!(
        store
            .get_task(&continuation.latest_task_id)
            .await
            .unwrap()
            .state(),
        TaskState::Cancelled
    );
    finish(&store, &host, &second_attempt, None).await;
    let gated_id: String = sqlx::query_scalar(
        "SELECT task_id FROM supertag_v2_mailbox_tasks WHERE recipient_tag_id='gated'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    let gated = start(&store, &host, &gated_id).await;
    let patch = store
        .get_review_artifact(
            &host,
            &GetReviewArtifactRequest {
                attempt: Some(gated.clone()),
                review_id: no_op_review.message_id.clone(),
            },
        )
        .await
        .unwrap();
    assert!(!patch.committed);
    assert_eq!(
        patch.patch.as_ref().unwrap().byte_length,
        0,
        "a no-op delivery honestly retains an empty patch"
    );
    let gated_input = response(&gated, &no_op_review.message_id);
    let pending = store
        .send_attempt_tag_message(&host, &gated_input)
        .await
        .unwrap();
    assert!(pending.review.is_none());
    let approval = pending.approval.unwrap();
    let stored = store
        .list_objective_commit_reviews(&ListObjectiveCommitReviewsRequest {
            objective_id: "goal".into(),
            ..Default::default()
        })
        .await
        .unwrap()
        .reviews;
    assert!(
        stored
            .iter()
            .find(|r| r.request_id == no_op_review.message_id)
            .unwrap()
            .verdict
            .is_none()
    );
    store
        .finish_task(
            &host,
            &FinishTaskRequest {
                task_id: gated.task_id.clone(),
                attempt_id: gated.attempt_id.clone(),
                lease_token: gated.lease_token.clone(),
                result: "Waiting for verdict approval".into(),
                succeeded: true,
                waiting_approval_ids: vec![approval.approval_id.clone()],
                ..Default::default()
            },
        )
        .await
        .unwrap();
    let decided = store
        .decide_approval(
            OPERATOR,
            &DecideApprovalRequest {
                approval_id: approval.approval_id,
                operation_id: "approve-verdict".into(),
                approve: true,
                scope: ApprovalScope::Once.into(),
                reason: "Inspected exact response".into(),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    let continued = start(
        &store,
        &host,
        decided.continuation_task_id.as_ref().unwrap(),
    )
    .await;
    assert_eq!(
        store
            .get_review_artifact(
                &host,
                &GetReviewArtifactRequest {
                    attempt: Some(continued.clone()),
                    review_id: no_op_review.message_id.clone()
                }
            )
            .await
            .unwrap(),
        patch
    );
    let gated_input = response(&continued, &no_op_review.message_id);
    let approved = store
        .send_attempt_tag_message(&host, &gated_input)
        .await
        .unwrap()
        .review
        .unwrap();
    assert_eq!(
        approved.verdict.as_ref().unwrap().task_id,
        continued.task_id
    );
    let duplicate = store
        .send_attempt_tag_message(
            &host,
            &SendAttemptTagMessageRequest {
                operation_id: "duplicate-verdict".into(),
                ..gated_input
            },
        )
        .await
        .unwrap();
    assert!(duplicate.duplicate);
    assert_eq!(duplicate.review.unwrap(), approved);
    finish(&store, &host, &continued, None).await;
    let unrelated = store
        .submit_task(
            OPERATOR,
            &SubmitTaskRequest {
                execution_limits: None,
                tag_id: "reviewer".into(),
                session_id: "unrelated".into(),
                operation_id: "unrelated".into(),
                prompt: "Other work".into(),
            },
        )
        .await
        .unwrap();
    let unrelated = start(&store, &host, &unrelated.task_id).await;
    assert!(matches!(
        store
            .get_review_artifact(
                &host,
                &GetReviewArtifactRequest {
                    attempt: Some(unrelated.clone()),
                    review_id: first.message_id.clone()
                }
            )
            .await,
        Err(StoreError::PermissionDenied)
    ));
    let correlated = store
        .send_attempt_tag_message(&host, &response(&unrelated, &first.message_id))
        .await
        .unwrap();
    assert!(correlated.duplicate);
    assert_eq!(
        correlated.review.unwrap(),
        recorded,
        "another authorized reviewer root may repeat the correlated verdict without changing its original attribution"
    );
    store.cancel_task(&unrelated.task_id).await.unwrap();
    assert!(matches!(
        store
            .get_review_artifact(
                &host,
                &GetReviewArtifactRequest {
                    attempt: Some(unrelated),
                    review_id: first.message_id.clone()
                }
            )
            .await,
        Err(StoreError::FailedPrecondition(_))
    ));
    // A history page must fit the transport even when every maximum-length
    // UTF-16 summary uses three-byte UTF-8 characters. Populate audit-only rows
    // after closure to exercise the projection without scheduling fixture work.
    let summary = "界".repeat(8_000);
    let mut tx = pool.begin().await.unwrap();
    for i in 0..60 {
        let id = format!("page-{i}");
        sqlx::query("INSERT INTO supertag_v2_mailbox_messages (message_id,sender_tag_id,recipient_tag_id,source_task_id,origin,objective_id,text,hops,created_at_ms,delivery_order) SELECT $1,sender_tag_id,recipient_tag_id,source_task_id,origin,objective_id,text,hops,created_at_ms,$2 FROM supertag_v2_mailbox_messages WHERE message_id=$3")
            .bind(&id).bind(10_000_i64+i).bind(&first.message_id).execute(&mut *tx).await.unwrap();
        sqlx::query("INSERT INTO supertag_v2_commit_reviews (request_id,objective_id,requester_tag_id,reviewer_tag_id,source_task_id,workspace_id,commit_sha,delivery,requested_at_ms,created_order,decision,summary,verdict_task_id,recorded_at_ms) SELECT $1,objective_id,requester_tag_id,reviewer_tag_id,source_task_id,workspace_id,commit_sha,delivery,requested_at_ms,$2,decision,$3,verdict_task_id,recorded_at_ms FROM supertag_v2_commit_reviews WHERE request_id=$4")
            .bind(id).bind(10_000_i64+i).bind(&summary).bind(&first.message_id).execute(&mut *tx).await.unwrap();
    }
    tx.commit().await.unwrap();
    let mut seen = std::collections::BTreeSet::new();
    let mut cursor = 0;
    loop {
        let page = store
            .list_objective_commit_reviews(&ListObjectiveCommitReviewsRequest {
                objective_id: "goal".into(),
                limit: 100,
                before_order: cursor,
            })
            .await
            .unwrap();
        assert!(page.encoded_len() <= supertag_protocol::MAX_MESSAGE_BYTES);
        if cursor == 0 {
            assert_ne!(
                page.next_before_order, 0,
                "byte limit must page this result"
            );
        }
        for review in page.reviews {
            assert!(seen.insert(review.request_id));
        }
        cursor = page.next_before_order;
        if cursor == 0 {
            break;
        }
    }
    assert_eq!(seen.len(), 63);
    pool.close().await;
    store.close().await;
}

async fn gated_request_contract(url: &str) {
    let clock = Arc::new(AtomicI64::new(NOW));
    let store = open(url, &clock).await;
    let host = support::register_host(&store, "scoped-review-host").await;
    store
        .put_tag_spec(PutTagRequest {
            tag_id: "scoped-owner".into(),
            instructions: "Only review this child".into(),
            allowed_actions: vec!["files:read".into(), "mailbox:send".into()],
            workspace: Some(WorkspaceSpec {
                workspace_id: "repo".into(),
                base_commit: BASE.into(),
            }),
            approval_rules: vec![ApprovalRule {
                action: "mailbox:send".into(),
                operator_ids: vec!["reviews".into()],
            }],
            ..Default::default()
        })
        .await
        .unwrap();
    store
        .put_tag("scoped-reviewer", "Review", vec![])
        .await
        .unwrap();
    store
        .change_mailbox_grant(
            OPERATOR,
            &ChangeMailboxGrantRequest {
                operation_id: "scoped-route".into(),
                sender_tag_id: "scoped-owner".into(),
                recipient_tag_id: "scoped-reviewer".into(),
                granted: true,
            },
        )
        .await
        .unwrap();
    let objective = store
        .create_objective(
            OPERATOR,
            &CreateObjectiveRequest {
                operation_id: "scoped-goal".into(),
                objective_id: "scoped-goal".into(),
                owner_tag_id: "scoped-owner".into(),
                outcome: "Review each child".into(),
                ongoing: true,
                ..Default::default()
            },
        )
        .await
        .unwrap();
    let owner = start(&store, &host, &objective.starting_task_id).await;
    let mut children = vec![];
    for id in ["a", "b"] {
        children.push(
            store
                .start_work_session(
                    &host,
                    &StartWorkSessionRequest {
                        attempt: Some(owner.clone()),
                        operation_id: format!("scoped-child-{id}"),
                        title: id.into(),
                        instruction: "Inspect the fixture".into(),
                        ..Default::default()
                    },
                )
                .await
                .unwrap(),
        );
    }
    finish(&store, &host, &owner, Some(BASE)).await;
    let other_host = support::register_host(&store, "scoped-other-host").await;
    let child_a_attempt = start(&store, &host, &children[0].latest_task_id).await;
    let child_b_attempt = start(&store, &other_host, &children[1].latest_task_id).await;
    finish(&store, &other_host, &child_b_attempt, Some(BASE)).await;
    finish(&store, &host, &child_a_attempt, Some(HEAD)).await;
    let child_a = store
        .get_work_session(OPERATOR, &children[0].work_session_id)
        .await
        .unwrap();
    let child_b = store
        .get_work_session(OPERATOR, &children[1].work_session_id)
        .await
        .unwrap();
    let report_b = start(&store, &host, child_b.report_task_id.as_ref().unwrap()).await;
    finish(&store, &host, &report_b, Some(BASE)).await;
    let report = start(&store, &host, child_a.report_task_id.as_ref().unwrap()).await;
    let original_report_task = store.get_task(&report.task_id).await.unwrap();
    let pending = store
        .send_attempt_tag_message(
            &host,
            &request(&report, "gated-request", "scoped-reviewer", HEAD),
        )
        .await
        .unwrap();
    assert!(pending.message.is_none());
    let approval = pending.approval.unwrap();
    finish_waiting(
        &store,
        &host,
        &report,
        Some(BASE),
        vec![approval.approval_id.clone()],
    )
    .await;
    // Editing live Tag policy while a scoped report waits must not broaden its continuation.
    store
        .put_tag_spec(PutTagRequest {
            tag_id: "scoped-owner".into(),
            instructions: "Changed future owner instructions".into(),
            allowed_actions: vec![
                "files:read".into(),
                "mailbox:send".into(),
                "files:write".into(),
            ],
            workspace: Some(WorkspaceSpec {
                workspace_id: "repo".into(),
                base_commit: BASE.into(),
            }),
            ..Default::default()
        })
        .await
        .unwrap();
    let approved = store
        .decide_approval(
            OPERATOR,
            &DecideApprovalRequest {
                approval_id: approval.approval_id,
                operation_id: "approve-request".into(),
                approve: true,
                scope: ApprovalScope::Once.into(),
                reason: "Approve only this exact request".into(),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    let continued = start(
        &store,
        &host,
        approved.continuation_task_id.as_ref().unwrap(),
    )
    .await;
    report_scope::assert_restricted_report_continuation(
        &store,
        &host,
        &continued,
        &original_report_task,
        &child_b.work_session_id,
        "scoped-reviewer",
    )
    .await;
    assert!(matches!(
        store
            .send_attempt_tag_message(
                &host,
                &request(&continued, "wrong-inherited-child", "scoped-reviewer", BASE)
            )
            .await,
        Err(StoreError::FailedPrecondition(_))
    ));
    let sent = store
        .send_attempt_tag_message(
            &host,
            &request(
                &continued,
                "approved-inherited-child",
                "scoped-reviewer",
                HEAD,
            ),
        )
        .await
        .unwrap()
        .message
        .unwrap();
    assert_eq!(sent.review.unwrap().source_task_id, child_a.latest_task_id);
    let child_continuation = store
        .continue_work_session(
            &host,
            &ContinueWorkSessionRequest {
                attempt: Some(continued.clone()),
                operation_id: "same-child-after-approved-request".into(),
                work_session_id: child_a.work_session_id.clone(),
                message: "Follow up on the same inspected child".into(),
            },
        )
        .await
        .unwrap();
    assert_eq!(child_continuation.work_session_id, child_a.work_session_id);
    finish(&store, &host, &continued, Some(BASE)).await;
    let claim = store
        .claim_task_with_workspaces(&host, "scoped-reviewer", &["repo".into()])
        .await
        .unwrap()
        .unwrap();
    assert_eq!(claim.task.as_ref().unwrap().tag_id, "scoped-reviewer");
    let reviewer = InspectAttemptRequest {
        task_id: claim.task.unwrap().task_id,
        attempt_id: claim.attempt_id,
        lease_token: claim.lease_token,
    };
    store
        .start_task(
            &host,
            &StartTaskRequest {
                task_id: reviewer.task_id.clone(),
                attempt_id: reviewer.attempt_id.clone(),
                lease_token: reviewer.lease_token.clone(),
            },
        )
        .await
        .unwrap();
    finish(&store, &host, &reviewer, None).await;
    store
        .cancel_objective(
            OPERATOR,
            &ObjectiveActionRequest {
                objective_id: "scoped-goal".into(),
                operation_id: "close-scoped-goal".into(),
                reason: "Fixture complete".into(),
            },
        )
        .await
        .unwrap();
    assert_eq!(
        store
            .get_task(&child_continuation.latest_task_id)
            .await
            .unwrap()
            .state(),
        TaskState::Cancelled
    );
    store
        .put_tag(
            "scoped-reviewer",
            "Record the already inspected review",
            vec!["mailbox:send".into()],
        )
        .await
        .unwrap();
    store
        .change_mailbox_grant(
            OPERATOR,
            &ChangeMailboxGrantRequest {
                operation_id: "scoped-reverse-route".into(),
                sender_tag_id: "scoped-reviewer".into(),
                recipient_tag_id: "scoped-owner".into(),
                granted: true,
            },
        )
        .await
        .unwrap();
    let root = store
        .submit_task(
            OPERATOR,
            &SubmitTaskRequest {
                execution_limits: None,
                tag_id: "scoped-reviewer".into(),
                session_id: "separate-review-session".into(),
                operation_id: "separate-review-session".into(),
                prompt: "Record the verdict from the review".into(),
            },
        )
        .await
        .unwrap();
    let root = start(&store, &host, &root.task_id).await;
    assert!(matches!(
        store
            .get_review_artifact(
                &host,
                &GetReviewArtifactRequest {
                    attempt: Some(root.clone()),
                    review_id: sent.message_id.clone()
                }
            )
            .await,
        Err(StoreError::PermissionDenied)
    ));
    let verdict = store
        .send_attempt_tag_message(
            &host,
            &SendAttemptTagMessageRequest {
                attempt: Some(root.clone()),
                operation_id: "separate-root-verdict".into(),
                recipient_tag_id: "scoped-owner".into(),
                text: "Approved based on the inspected commit".into(),
                review: Some(CommitReviewSubmission {
                    kind: Some(commit_review_submission::Kind::Response(
                        CommitReviewResponse {
                            request_id: sent.message_id,
                            verdict: CommitReviewDecision::Approved.into(),
                        },
                    )),
                }),
            },
        )
        .await
        .unwrap();
    assert!(!verdict.duplicate);
    assert_eq!(
        verdict.review.unwrap().verdict.unwrap().task_id,
        root.task_id
    );
    finish(&store, &host, &root, None).await;
    store.close().await;
}

#[tokio::test]
async fn sqlite_commit_reviews() {
    let dir = tempfile::tempdir().unwrap();
    contract(&format!(
        "sqlite://{}?mode=rwc",
        dir.path().join("reviews.db").display()
    ))
    .await;
}

#[tokio::test]
#[ignore = "requires dedicated PostgreSQL"]
async fn postgres_commit_reviews() {
    let admin_url = std::fs::read_to_string(
        std::env::var_os("SUPERTAG_RUST_TEST_POSTGRES_URL_FILE").expect("URL file"),
    )
    .unwrap();
    let mut url = url::Url::parse(admin_url.trim()).unwrap();
    let db = format!("supertag_reviews_{}", Uuid::new_v4().simple());
    let mut admin = sqlx::PgConnection::connect(admin_url.trim()).await.unwrap();
    admin
        .execute(format!("CREATE DATABASE {db}").as_str())
        .await
        .unwrap();
    url.set_path(&db);
    let result = tokio::task::LocalSet::new()
        .run_until(async move {
            tokio::task::spawn_local(async move { contract(url.as_str()).await }).await
        })
        .await;
    admin
        .execute(format!("DROP DATABASE {db} WITH (FORCE)").as_str())
        .await
        .unwrap();
    admin.close().await.unwrap();
    result.unwrap();
}
