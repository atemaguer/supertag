mod support;

use sqlx::{Connection, Executor};
use std::sync::{
    Arc,
    atomic::{AtomicI64, Ordering},
};
use supertag_control_plane::{HostAuthority, Store, StoreError};
use supertag_protocol::v2::*;
use uuid::Uuid;

const NOW: i64 = 1_900_000_000_000;
const ALICE: &str = "operator:alice";

async fn tag(store: &Store, approver: &str) {
    store
        .put_tag_spec(PutTagRequest {
            tag_id: "owner".into(),
            instructions: "Coordinate the work".into(),
            allowed_actions: vec!["workstream:post".into()],
            approval_rules: vec![ApprovalRule {
                action: "workstream:post".into(),
                operator_ids: vec![approver.into()],
            }],
            ..Default::default()
        })
        .await
        .unwrap();
}
async fn claim(store: &Store, host: &HostAuthority, expected: &str) -> InspectAttemptRequest {
    let claimed = store
        .claim_task(host, &Uuid::new_v4().to_string())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(claimed.task.unwrap().task_id, expected);
    InspectAttemptRequest {
        task_id: expected.into(),
        attempt_id: claimed.attempt_id,
        lease_token: claimed.lease_token,
    }
}
async fn start(store: &Store, host: &HostAuthority, attempt: &InspectAttemptRequest) {
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
}
fn post(
    attempt: &InspectAttemptRequest,
    operation: &str,
    body: &str,
) -> PostAttemptWorkstreamRequest {
    PostAttemptWorkstreamRequest {
        attempt: Some(attempt.clone()),
        operation_id: operation.into(),
        body: body.into(),
        to_tag_ids: vec![],
    }
}
fn decision(
    id: &str,
    operation: &str,
    approve: bool,
    scope: ApprovalScope,
) -> DecideApprovalRequest {
    DecideApprovalRequest {
        approval_id: id.into(),
        operation_id: operation.into(),
        approve,
        scope: scope as i32,
        valid_until_ms: None,
        reason: if approve {
            "Reviewed exact arguments".into()
        } else {
            "Use another approach".into()
        },
    }
}
async fn finish(
    store: &Store,
    host: &HostAuthority,
    attempt: &InspectAttemptRequest,
    ids: Vec<String>,
) {
    store
        .finish_task(
            host,
            &FinishTaskRequest {
                task_id: attempt.task_id.clone(),
                attempt_id: attempt.attempt_id.clone(),
                lease_token: attempt.lease_token.clone(),
                succeeded: true,
                result: "Waiting for the operator".into(),
                waiting_approval_ids: ids,
                ..Default::default()
            },
        )
        .await
        .unwrap();
}

async fn contract(url: &str) {
    let clock = Arc::new(AtomicI64::new(NOW));
    let now = clock.clone();
    let mut store = Store::open(url)
        .await
        .unwrap()
        .with_execution_clock(move || now.load(Ordering::SeqCst));
    tag(&store, "alice").await;
    store
        .create_team(
            ALICE,
            &CreateTeamRequest {
                operation_id: "team".into(),
                team_id: "engineering".into(),
                name: "Engineering".into(),
                member_tag_ids: vec!["owner".into()],
                max_concurrency: None,
            },
        )
        .await
        .unwrap();
    let host = support::register_host(&store, "host").await;
    let other = support::register_host(&store, "other").await;
    let task = store
        .submit_task(
            ALICE,
            &SubmitTaskRequest {
                output_policy: None,
                execution_limits: None,
                tag_id: "owner".into(),
                session_id: "ordinary".into(),
                operation_id: "first".into(),
                prompt: "Post the update".into(),
                input_artifacts: vec![],
            },
        )
        .await
        .unwrap();
    let attempt = claim(&store, &host, &task.task_id).await;
    let request = post(&attempt, "post", "An update");
    assert!(matches!(
        store.post_attempt_workstream(&host, &request).await,
        Err(StoreError::FailedPrecondition(_))
    ));
    start(&store, &host, &attempt).await;
    assert!(matches!(
        store.post_attempt_workstream(&other, &request).await,
        Err(StoreError::PermissionDenied)
    ));
    let pending = store
        .post_attempt_workstream(&host, &request)
        .await
        .unwrap();
    assert!(pending.post.is_none());
    let approval = pending.approval.unwrap();
    assert_eq!(approval.state(), ApprovalState::Pending);
    assert_eq!(approval.resource, "engineering");
    assert_eq!(
        approval.canonical_arguments_json,
        r#"{"body":"An update","to_tag_ids":[]}"#
    );
    let replay = store
        .post_attempt_workstream(&host, &request)
        .await
        .unwrap();
    assert_eq!(
        replay.approval.as_ref().unwrap().approval_id,
        approval.approval_id
    );
    assert!(matches!(
        store
            .post_attempt_workstream(&host, &post(&attempt, "post", "Changed action"))
            .await,
        Err(StoreError::Conflict(_))
    ));
    assert!(matches!(
        store
            .decide_approval(
                "operator:bob",
                &decision(
                    &approval.approval_id,
                    "unauthorized",
                    true,
                    ApprovalScope::Once
                )
            )
            .await,
        Err(StoreError::PermissionDenied)
    ));
    // Policy is frozen when accepted; changing the Tag cannot nominate another decider.
    tag(&store, "bob").await;
    let approve = decision(&approval.approval_id, "approve", true, ApprovalScope::Once);
    let granted = store.decide_approval(ALICE, &approve).await.unwrap();
    assert_eq!(granted.decided_by.as_deref(), Some("alice"));
    assert_eq!(
        store.decide_approval(ALICE, &approve).await.unwrap(),
        granted
    );
    let posted = store
        .post_attempt_workstream(&host, &request)
        .await
        .unwrap();
    assert!(posted.post.is_some());
    assert_eq!(
        store
            .post_attempt_workstream(&host, &request)
            .await
            .unwrap()
            .post,
        posted.post
    );
    assert!(
        store
            .get_approval(ALICE, &approval.approval_id)
            .await
            .unwrap()
            .consumed_at_ms
            .is_some()
    );
    let another = store
        .post_attempt_workstream(&host, &post(&attempt, "another", "Different body"))
        .await
        .unwrap();
    assert!(another.post.is_none());
    let denied_id = another.approval.unwrap().approval_id;
    let mut empty_denial = decision(
        &denied_id,
        "empty-denial",
        false,
        ApprovalScope::Unspecified,
    );
    empty_denial.reason.clear();
    assert!(matches!(
        store.decide_approval(ALICE, &empty_denial).await,
        Err(StoreError::InvalidArgument(_))
    ));
    store
        .decide_approval(
            ALICE,
            &decision(&denied_id, "deny", false, ApprovalScope::Unspecified),
        )
        .await
        .unwrap();
    assert_eq!(
        store
            .post_attempt_workstream(&host, &post(&attempt, "another", "Different body"))
            .await
            .unwrap()
            .approval
            .unwrap()
            .state(),
        ApprovalState::Denied
    );
    finish(&store, &host, &attempt, vec![]).await;
    assert!(matches!(
        store.post_attempt_workstream(&host, &request).await,
        Err(StoreError::FailedPrecondition(_))
    ));

    tag(&store, "alice").await;
    let private = store
        .send_message(
            ALICE,
            &SendMessageRequest {
                output_policy: None,
                execution_limits: None,
                tag_id: "owner".into(),
                conversation: "private-approval".into(),
                operation_id: "private-request".into(),
                text: "A private update".into(),
            },
        )
        .await
        .unwrap()
        .task
        .unwrap();
    let private_attempt = claim(&store, &host, &private.task_id).await;
    start(&store, &host, &private_attempt).await;
    let private_request = store
        .post_attempt_workstream(
            &host,
            &post(&private_attempt, "private-post", "Private arguments"),
        )
        .await
        .unwrap()
        .approval
        .unwrap();
    assert!(matches!(
        store
            .get_approval("operator:bob", &private_request.approval_id)
            .await,
        Err(StoreError::NotFound(_))
    ));
    assert!(
        store
            .list_approvals(
                "operator:bob",
                &ListApprovalsRequest {
                    task_id: private.task_id.clone(),
                    ..Default::default()
                }
            )
            .await
            .unwrap()
            .approvals
            .is_empty()
    );
    assert!(
        !store
            .list_inbox_items(
                "operator:bob",
                &ListInboxItemsRequest {
                    kind: InboxItemKind::Approval as i32,
                    ..Default::default()
                }
            )
            .await
            .unwrap()
            .items
            .iter()
            .any(|item| item.task_id == private.task_id)
    );
    let private_decision = decision(
        &private_request.approval_id,
        "private-approve",
        true,
        ApprovalScope::Once,
    );
    assert!(matches!(
        store
            .decide_approval("operator:bob", &private_decision)
            .await,
        Err(StoreError::NotFound(_))
    ));
    // A caller-chosen operation matching the old deterministic continuation name
    // must not prevent the private Session from receiving its actual continuation.
    finish(
        &store,
        &host,
        &private_attempt,
        vec![private_request.approval_id.clone()],
    )
    .await;
    let collision = store
        .send_message(
            ALICE,
            &SendMessageRequest {
                output_policy: None,
                execution_limits: None,
                tag_id: "owner".into(),
                conversation: "another-conversation".into(),
                operation_id: format!("approval-continuation:{}", private.task_id),
                text: "An unrelated message".into(),
            },
        )
        .await
        .unwrap()
        .task
        .unwrap();
    let continuation = store
        .decide_approval(ALICE, &private_decision)
        .await
        .unwrap()
        .continuation_task_id
        .unwrap();
    assert!(
        store
            .get_message(ALICE, "owner", &continuation)
            .await
            .is_ok()
    );
    assert!(matches!(
        store
            .get_message("operator:bob", "owner", &continuation)
            .await,
        Err(StoreError::NotFound(_))
    ));
    let unrelated = claim(&store, &host, &collision.task_id).await;
    start(&store, &host, &unrelated).await;
    finish(&store, &host, &unrelated, vec![]).await;
    let continued = claim(&store, &host, &continuation).await;
    start(&store, &host, &continued).await;
    assert!(
        store
            .post_attempt_workstream(
                &host,
                &post(&continued, "retry-private", "Private arguments")
            )
            .await
            .unwrap()
            .post
            .is_some()
    );
    finish(&store, &host, &continued, vec![]).await;
    tag(&store, "bob").await;
    let excluded = store
        .send_message(
            ALICE,
            &SendMessageRequest {
                output_policy: None,
                execution_limits: None,
                tag_id: "owner".into(),
                conversation: "excluded-owner".into(),
                operation_id: "excluded-owner".into(),
                text: "An undecidable private action".into(),
            },
        )
        .await
        .unwrap()
        .task
        .unwrap();
    let excluded_attempt = claim(&store, &host, &excluded.task_id).await;
    start(&store, &host, &excluded_attempt).await;
    assert!(matches!(
        store
            .post_attempt_workstream(
                &host,
                &post(&excluded_attempt, "excluded", "Private action")
            )
            .await,
        Err(StoreError::PermissionDenied)
    ));
    assert!(
        store
            .list_approvals(
                ALICE,
                &ListApprovalsRequest {
                    task_id: excluded.task_id.clone(),
                    ..Default::default()
                }
            )
            .await
            .unwrap()
            .approvals
            .is_empty()
    );
    finish(&store, &host, &excluded_attempt, vec![]).await;
    tag(&store, "alice").await;
    let objective = store
        .create_objective(
            ALICE,
            &CreateObjectiveRequest {
                operation_id: "objective".into(),
                objective_id: "approval-objective".into(),
                owner_tag_id: "owner".into(),
                outcome: "Coordinate a release".into(),
                team_id: Some("engineering".into()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    let attempt = claim(&store, &host, &objective.starting_task_id).await;
    start(&store, &host, &attempt).await;
    let first = store
        .post_attempt_workstream(&host, &post(&attempt, "one", "First post"))
        .await
        .unwrap()
        .approval
        .unwrap();
    let second = store
        .post_attempt_workstream(&host, &post(&attempt, "two", "Second post"))
        .await
        .unwrap()
        .approval
        .unwrap();
    for invalid_id in ["missing-request".to_owned(), approval.approval_id.clone()] {
        let invalid = FinishTaskRequest {
            task_id: attempt.task_id.clone(),
            attempt_id: attempt.attempt_id.clone(),
            lease_token: attempt.lease_token.clone(),
            succeeded: true,
            result: "Waiting for the operator".into(),
            waiting_approval_ids: vec![invalid_id],
            ..Default::default()
        };
        assert!(matches!(
            store.finish_task(&host, &invalid).await,
            Err(StoreError::InvalidArgument(_))
        ));
        assert_eq!(
            store.get_task(&attempt.task_id).await.unwrap().state(),
            TaskState::Running
        );
    }
    finish(
        &store,
        &host,
        &attempt,
        vec![second.approval_id.clone(), first.approval_id.clone()],
    )
    .await;
    finish(
        &store,
        &host,
        &attempt,
        vec![first.approval_id.clone(), second.approval_id.clone()],
    )
    .await;
    let replay = FinishTaskRequest {
        task_id: attempt.task_id.clone(),
        attempt_id: attempt.attempt_id.clone(),
        lease_token: attempt.lease_token.clone(),
        succeeded: true,
        result: "Waiting for the operator".into(),
        waiting_approval_ids: vec![first.approval_id.clone()],
        ..Default::default()
    };
    assert!(matches!(
        store.finish_task(&host, &replay).await,
        Err(StoreError::Conflict(_))
    ));
    store.close().await;
    let now = clock.clone();
    store = Store::open(url)
        .await
        .unwrap()
        .with_execution_clock(move || now.load(Ordering::SeqCst));
    assert!(
        store
            .claim_task(&other, "no-idle-wake")
            .await
            .unwrap()
            .is_none()
    );
    store
        .decide_approval(
            ALICE,
            &decision(
                &first.approval_id,
                "first-approve",
                true,
                ApprovalScope::Once,
            ),
        )
        .await
        .unwrap();
    assert!(
        store
            .claim_task(&other, "still-waiting")
            .await
            .unwrap()
            .is_none()
    );
    let approve_second = decision(
        &second.approval_id,
        "second-approve",
        true,
        ApprovalScope::Objective,
    );
    let (left, right) = tokio::join!(
        store.decide_approval(ALICE, &approve_second),
        store.decide_approval(ALICE, &approve_second)
    );
    let decided = left.unwrap();
    assert_eq!(decided, right.unwrap());
    let continuation = decided
        .continuation_task_id
        .clone()
        .expect("one continuation");
    assert_eq!(
        store
            .get_approval(ALICE, &first.approval_id)
            .await
            .unwrap()
            .continuation_task_id
            .as_deref(),
        Some(continuation.as_str())
    );
    let resumed = claim(&store, &host, &continuation).await;
    assert!(
        store
            .claim_task(&other, "no-duplicate-continuation")
            .await
            .unwrap()
            .is_none()
    );
    start(&store, &host, &resumed).await;
    // Explicit Objective scope can cover different arguments, still on the same resource.
    assert!(
        store
            .post_attempt_workstream(&host, &post(&resumed, "scope-use", "Third post"))
            .await
            .unwrap()
            .post
            .is_some()
    );
    assert!(matches!(
        store.decide_approval("host:host", &approve_second).await,
        Err(StoreError::PermissionDenied)
    ));
    // A fresh report or approval cannot extend a native execution lease.
    clock.store(NOW + 30_000, Ordering::SeqCst);
    assert!(matches!(
        store
            .post_attempt_workstream(&host, &post(&resumed, "expired-attempt", "Too late"))
            .await,
        Err(StoreError::FailedPrecondition(_))
    ));
    store
        .cancel_objective(
            ALICE,
            &ObjectiveActionRequest {
                objective_id: objective.objective_id,
                operation_id: "cancel-objective".into(),
                reason: "End test".into(),
            },
        )
        .await
        .unwrap();
    store.sweep_approvals().await.unwrap();
    assert_eq!(
        store
            .get_approval(ALICE, &second.approval_id)
            .await
            .unwrap()
            .state(),
        ApprovalState::Expired
    );
    let expires = store
        .submit_task(
            ALICE,
            &SubmitTaskRequest {
                output_policy: None,
                execution_limits: None,
                tag_id: "owner".into(),
                session_id: "expired-grant".into(),
                operation_id: "expired-grant".into(),
                prompt: "Check short approval validity".into(),
                input_artifacts: vec![],
            },
        )
        .await
        .unwrap();
    let expires_attempt = claim(&store, &host, &expires.task_id).await;
    start(&store, &host, &expires_attempt).await;
    let expires_request = post(&expires_attempt, "expires", "Limited validity");
    let approval = store
        .post_attempt_workstream(&host, &expires_request)
        .await
        .unwrap()
        .approval
        .unwrap();
    let mut grant = decision(
        &approval.approval_id,
        "expires-decision",
        true,
        ApprovalScope::Once,
    );
    grant.valid_until_ms = Some(NOW + 35_000);
    store.decide_approval(ALICE, &grant).await.unwrap();
    clock.store(NOW + 35_000, Ordering::SeqCst);
    let expired = store
        .post_attempt_workstream(&host, &expires_request)
        .await
        .unwrap();
    assert!(expired.post.is_none());
    assert_eq!(expired.approval.unwrap().state(), ApprovalState::Expired);
    finish(&store, &host, &expires_attempt, vec![]).await;
    // More live Objective grants than one maintenance batch must not pin a later
    // abandoned request forever. All records are admitted through the actual gate.
    for index in 0..130 {
        let id = format!("fair-{index}");
        let objective = store
            .create_objective(
                ALICE,
                &CreateObjectiveRequest {
                    operation_id: id.clone(),
                    objective_id: id.clone(),
                    owner_tag_id: "owner".into(),
                    outcome: "Keep an ongoing responsibility".into(),
                    ongoing: true,
                    team_id: Some("engineering".into()),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        let attempt = claim(&store, &host, &objective.starting_task_id).await;
        start(&store, &host, &attempt).await;
        let approval = store
            .post_attempt_workstream(&host, &post(&attempt, "request", "A scoped update"))
            .await
            .unwrap()
            .approval
            .unwrap();
        store
            .decide_approval(
                ALICE,
                &decision(
                    &approval.approval_id,
                    &format!("decide-{id}"),
                    true,
                    ApprovalScope::Objective,
                ),
            )
            .await
            .unwrap();
        finish(&store, &host, &attempt, vec![]).await;
    }
    let tail = store
        .submit_task(
            ALICE,
            &SubmitTaskRequest {
                output_policy: None,
                execution_limits: None,
                tag_id: "owner".into(),
                session_id: "sweep-tail".into(),
                operation_id: "sweep-tail".into(),
                prompt: "Abandoned request".into(),
                input_artifacts: vec![],
            },
        )
        .await
        .unwrap();
    let tail_attempt = claim(&store, &host, &tail.task_id).await;
    start(&store, &host, &tail_attempt).await;
    let tail_approval = store
        .post_attempt_workstream(&host, &post(&tail_attempt, "tail", "Never sent"))
        .await
        .unwrap()
        .approval
        .unwrap();
    finish(&store, &host, &tail_attempt, vec![]).await;
    store.sweep_approvals().await.unwrap();
    let mut inspection = sqlx::AnyConnection::connect(url).await.unwrap();
    let state: i64 =
        sqlx::query_scalar("SELECT state FROM supertag_v2_approvals WHERE approval_id=$1")
            .bind(&tail_approval.approval_id)
            .fetch_one(&mut inspection)
            .await
            .unwrap();
    assert_eq!(state, ApprovalState::Pending as i64);
    store.sweep_approvals().await.unwrap();
    let state: i64 =
        sqlx::query_scalar("SELECT state FROM supertag_v2_approvals WHERE approval_id=$1")
            .bind(&tail_approval.approval_id)
            .fetch_one(&mut inspection)
            .await
            .unwrap();
    assert_eq!(state, ApprovalState::Expired as i64);
    inspection.close().await.unwrap();
    store.close().await;
}

#[tokio::test]
async fn sqlite_approval_authority_and_single_continuation() {
    let directory = tempfile::tempdir().unwrap();
    contract(&format!(
        "sqlite://{}?mode=rwc",
        directory.path().join("approvals.db").display()
    ))
    .await;
}
#[tokio::test]
#[ignore = "requires SUPERTAG_RUST_TEST_POSTGRES_URL_FILE for a dedicated PostgreSQL server"]
async fn postgres_approval_authority_and_single_continuation() {
    let path = std::env::var_os("SUPERTAG_RUST_TEST_POSTGRES_URL_FILE")
        .expect("PostgreSQL test URL file required");
    let admin_url = std::fs::read_to_string(path).unwrap();
    let name = format!("supertag_approvals_{}", Uuid::new_v4().simple());
    let mut admin = sqlx::PgConnection::connect(admin_url.trim()).await.unwrap();
    admin
        .execute(format!("CREATE DATABASE {name}").as_str())
        .await
        .unwrap();
    let mut url = url::Url::parse(admin_url.trim()).unwrap();
    url.set_path(&name);
    let result = tokio::task::LocalSet::new()
        .run_until(async move {
            tokio::task::spawn_local(async move { contract(url.as_str()).await }).await
        })
        .await;
    admin
        .execute(format!("DROP DATABASE {name} WITH (FORCE)").as_str())
        .await
        .unwrap();
    admin.close().await.unwrap();
    result.expect("PostgreSQL approval contract failed");
}

async fn approval_inbox(store: &Store, objective: &str) -> Vec<InboxItem> {
    store
        .list_inbox_items(
            ALICE,
            &ListInboxItemsRequest {
                kind: InboxItemKind::Approval as i32,
                objective_id: objective.into(),
                ..Default::default()
            },
        )
        .await
        .unwrap()
        .items
}
fn objective_action(objective: &str, operation: &str) -> ObjectiveActionRequest {
    ObjectiveActionRequest {
        objective_id: objective.into(),
        operation_id: operation.into(),
        reason: String::new(),
    }
}
async fn coverage_contract(url: &str) {
    let clock = Arc::new(AtomicI64::new(NOW));
    let now = clock.clone();
    let mut store = Store::open(url)
        .await
        .unwrap()
        .with_execution_clock(move || now.load(Ordering::SeqCst));
    tag(&store, "alice").await;
    store
        .create_team(
            ALICE,
            &CreateTeamRequest {
                operation_id: "team".into(),
                team_id: "engineering".into(),
                name: "Engineering".into(),
                member_tag_ids: vec!["owner".into()],
                max_concurrency: None,
            },
        )
        .await
        .unwrap();
    let host = support::register_host(&store, "host").await;

    // Coverage must agree for requests already pending in an executing turn,
    // explicit Finish waits, operator views, and effect retries after restart.
    let objective = store
        .create_objective(
            ALICE,
            &CreateObjectiveRequest {
                operation_id: "covered".into(),
                objective_id: "covered".into(),
                owner_tag_id: "owner".into(),
                outcome: "Publish approved updates".into(),
                team_id: Some("engineering".into()),
                ongoing: true,
                ..Default::default()
            },
        )
        .await
        .unwrap();
    let attempt = claim(&store, &host, &objective.starting_task_id).await;
    start(&store, &host, &attempt).await;
    let first = store
        .post_attempt_workstream(&host, &post(&attempt, "first", "First update"))
        .await
        .unwrap()
        .approval
        .unwrap();
    let sibling = store
        .post_attempt_workstream(&host, &post(&attempt, "sibling", "Second update"))
        .await
        .unwrap()
        .approval
        .unwrap();
    let later = store
        .post_attempt_workstream(&host, &post(&attempt, "later", "Later update"))
        .await
        .unwrap()
        .approval
        .unwrap();
    let denied = store
        .post_attempt_workstream(&host, &post(&attempt, "denied", "Do not publish"))
        .await
        .unwrap()
        .approval
        .unwrap();
    store
        .decide_approval(
            ALICE,
            &decision(
                &denied.approval_id,
                "deny",
                false,
                ApprovalScope::Unspecified,
            ),
        )
        .await
        .unwrap();
    let mut grant = decision(
        &first.approval_id,
        "objective-grant",
        true,
        ApprovalScope::Objective,
    );
    grant.valid_until_ms = Some(NOW + 20_000);
    let decided = store.decide_approval(ALICE, &grant).await.unwrap();
    let covered = store
        .get_approval(ALICE, &sibling.approval_id)
        .await
        .unwrap();
    assert_eq!(covered.state(), ApprovalState::Approved);
    assert_eq!(
        covered.grant_approval_id.as_deref(),
        Some(first.approval_id.as_str())
    );
    assert_eq!(covered.covered_at_ms, Some(NOW));
    assert_eq!(
        covered.canonical_arguments_json,
        sibling.canonical_arguments_json
    );
    assert_eq!(covered.arguments_digest, sibling.arguments_digest);
    assert_eq!(covered.decided_by, decided.decided_by);
    assert_eq!(covered.decided_at_ms, decided.decided_at_ms);
    assert_eq!(covered.valid_until_ms, grant.valid_until_ms);
    assert_eq!(covered.scope(), ApprovalScope::Objective);
    assert!(approval_inbox(&store, "covered").await.is_empty());
    // Reuse the original pending operation, not a newly requested effect.
    assert!(
        store
            .post_attempt_workstream(&host, &post(&attempt, "sibling", "Second update"))
            .await
            .unwrap()
            .post
            .is_some()
    );
    let listed = store
        .list_approvals(
            ALICE,
            &ListApprovalsRequest {
                objective_id: "covered".into(),
                state: ApprovalState::Approved as i32,
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert_eq!(listed.approvals.len(), 3);
    assert_eq!(
        listed
            .approvals
            .iter()
            .find(|a| a.approval_id == sibling.approval_id)
            .unwrap()
            .grant_approval_id
            .as_deref(),
        Some(first.approval_id.as_str())
    );

    let still_denied = store
        .get_approval(ALICE, &denied.approval_id)
        .await
        .unwrap();
    assert_eq!(still_denied.state(), ApprovalState::Denied);
    assert!(still_denied.grant_approval_id.is_none());
    assert!(matches!(
        store
            .decide_approval(
                ALICE,
                &decision(
                    &sibling.approval_id,
                    "conflicting-decision",
                    false,
                    ApprovalScope::Unspecified
                )
            )
            .await,
        Err(StoreError::FailedPrecondition(_))
    ));
    // A new operation ID cannot evade an existing denial via a broader grant.
    let denied_retry = store
        .post_attempt_workstream(&host, &post(&attempt, "denied-again", "Do not publish"))
        .await
        .unwrap();
    assert!(denied_retry.post.is_none());
    assert_eq!(
        denied_retry.approval.unwrap().state(),
        ApprovalState::Denied
    );
    finish(
        &store,
        &host,
        &attempt,
        vec![
            first.approval_id.clone(),
            sibling.approval_id.clone(),
            later.approval_id.clone(),
            denied.approval_id.clone(),
        ],
    )
    .await;
    let continuation = store
        .get_approval(ALICE, &sibling.approval_id)
        .await
        .unwrap()
        .continuation_task_id
        .unwrap();
    assert_eq!(
        store
            .get_approval(ALICE, &first.approval_id)
            .await
            .unwrap()
            .continuation_task_id
            .as_deref(),
        Some(continuation.as_str())
    );
    store.close().await;
    let now = clock.clone();
    store = Store::open(url)
        .await
        .unwrap()
        .with_execution_clock(move || now.load(Ordering::SeqCst));
    assert_eq!(
        store
            .get_approval(ALICE, &sibling.approval_id)
            .await
            .unwrap()
            .grant_approval_id
            .as_deref(),
        Some(first.approval_id.as_str())
    );
    let next = claim(&store, &host, &continuation).await;
    start(&store, &host, &next).await;
    let effect = post(&next, "retry-sibling", "Second update");
    let sent = store.post_attempt_workstream(&host, &effect).await.unwrap();
    assert!(sent.post.is_some());
    assert_eq!(
        store
            .post_attempt_workstream(&host, &effect)
            .await
            .unwrap()
            .post,
        sent.post
    );
    assert!(
        store
            .claim_task(&host, "only-one-continuation")
            .await
            .unwrap()
            .is_none()
    );
    clock.store(NOW + 20_000, Ordering::SeqCst);
    // Expired derived authority remains expired. A new operation can request a
    // new decision, without overwriting or silently reviving the covered row.
    let retry = store
        .post_attempt_workstream(&host, &post(&next, "after-expiry", "Later update"))
        .await
        .unwrap();
    assert!(retry.post.is_none());
    let renewed = retry.approval.unwrap();
    assert_eq!(renewed.state(), ApprovalState::Pending);
    assert_ne!(renewed.approval_id, later.approval_id);
    assert!(renewed.grant_approval_id.is_none());
    assert_eq!(
        store
            .get_approval(ALICE, &later.approval_id)
            .await
            .unwrap()
            .state(),
        ApprovalState::Expired
    );
    finish(&store, &host, &next, vec![]).await;
    assert_eq!(
        store
            .get_approval(ALICE, &sibling.approval_id)
            .await
            .unwrap()
            .state(),
        ApprovalState::Expired
    );
    store.sweep_approvals().await.unwrap();
    assert_eq!(
        store
            .get_approval(ALICE, &denied.approval_id)
            .await
            .unwrap()
            .state(),
        ApprovalState::Denied
    );

    // Pause never replaces the latest approval wait with a generic resume Task.
    // Exercise both resolved-while-paused and still-pending-at-resume paths.
    for resolved_while_paused in [true, false] {
        let key = if resolved_while_paused {
            "paused-resolved"
        } else {
            "paused-pending"
        };
        let objective = store
            .create_objective(
                ALICE,
                &CreateObjectiveRequest {
                    operation_id: key.into(),
                    objective_id: key.into(),
                    owner_tag_id: "owner".into(),
                    outcome: "Wait for approval".into(),
                    team_id: Some("engineering".into()),
                    ongoing: true,
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        let attempt = claim(&store, &host, &objective.starting_task_id).await;
        start(&store, &host, &attempt).await;
        let first = store
            .post_attempt_workstream(&host, &post(&attempt, "one", "One"))
            .await
            .unwrap()
            .approval
            .unwrap();
        let second = store
            .post_attempt_workstream(&host, &post(&attempt, "two", "Two"))
            .await
            .unwrap()
            .approval
            .unwrap();
        finish(
            &store,
            &host,
            &attempt,
            vec![first.approval_id.clone(), second.approval_id.clone()],
        )
        .await;
        store
            .pause_objective(ALICE, &objective_action(key, &format!("{key}-pause")))
            .await
            .unwrap();
        let grant = decision(
            &first.approval_id,
            &format!("{key}-grant"),
            true,
            ApprovalScope::Objective,
        );
        if resolved_while_paused {
            store.decide_approval(ALICE, &grant).await.unwrap();
            assert!(
                store
                    .get_approval(ALICE, &first.approval_id)
                    .await
                    .unwrap()
                    .continuation_task_id
                    .is_none()
            );
        }
        let resume = objective_action(key, &format!("{key}-resume"));
        store.resume_objective(ALICE, &resume).await.unwrap();
        store.resume_objective(ALICE, &resume).await.unwrap();
        if !resolved_while_paused {
            assert!(
                store
                    .claim_task(&host, &format!("{key}-still-waiting"))
                    .await
                    .unwrap()
                    .is_none()
            );
            assert_eq!(approval_inbox(&store, key).await.len(), 2);
            store.decide_approval(ALICE, &grant).await.unwrap();
        }
        assert!(approval_inbox(&store, key).await.is_empty());
        let one = store.get_approval(ALICE, &first.approval_id).await.unwrap();
        let two = store
            .get_approval(ALICE, &second.approval_id)
            .await
            .unwrap();
        assert_eq!(one.continuation_task_id, two.continuation_task_id);
        let continuation = one.continuation_task_id.unwrap();
        let next = claim(&store, &host, &continuation).await;
        start(&store, &host, &next).await;
        assert!(
            store
                .post_attempt_workstream(&host, &post(&next, "retry", "Two"))
                .await
                .unwrap()
                .post
                .is_some()
        );
        assert!(
            store
                .claim_task(&host, &format!("{key}-no-generic-resume"))
                .await
                .unwrap()
                .is_none()
        );
        finish(&store, &host, &next, vec![]).await;
        store
            .cancel_objective(ALICE, &objective_action(key, &format!("{key}-cancel")))
            .await
            .unwrap();
        assert_eq!(
            store
                .get_approval(ALICE, &second.approval_id)
                .await
                .unwrap()
                .state(),
            ApprovalState::Expired
        );
    }

    // A continuation queued just before pause is also preserved; Once authority
    // remains bound to that exact Task, with no additional generic resume turn.
    let objective = store
        .create_objective(
            ALICE,
            &CreateObjectiveRequest {
                operation_id: "queued-once".into(),
                objective_id: "queued-once".into(),
                owner_tag_id: "owner".into(),
                outcome: "Resume the exact approved turn".into(),
                team_id: Some("engineering".into()),
                ongoing: true,
                ..Default::default()
            },
        )
        .await
        .unwrap();
    let attempt = claim(&store, &host, &objective.starting_task_id).await;
    start(&store, &host, &attempt).await;
    let pending = store
        .post_attempt_workstream(&host, &post(&attempt, "once", "Approved once"))
        .await
        .unwrap()
        .approval
        .unwrap();
    finish(&store, &host, &attempt, vec![pending.approval_id.clone()]).await;
    let approved = store
        .decide_approval(
            ALICE,
            &decision(
                &pending.approval_id,
                "grant-once",
                true,
                ApprovalScope::Once,
            ),
        )
        .await
        .unwrap();
    let expected = approved.continuation_task_id.unwrap();
    store
        .pause_objective(ALICE, &objective_action("queued-once", "pause-queued"))
        .await
        .unwrap();
    store
        .resume_objective(ALICE, &objective_action("queued-once", "resume-queued"))
        .await
        .unwrap();
    let next = claim(&store, &host, &expected).await;
    start(&store, &host, &next).await;
    assert!(
        store
            .post_attempt_workstream(&host, &post(&next, "retry-once", "Approved once"))
            .await
            .unwrap()
            .post
            .is_some()
    );
    finish(&store, &host, &next, vec![]).await;
    assert!(
        store
            .claim_task(&host, "queued-once-no-extra-turn")
            .await
            .unwrap()
            .is_none()
    );

    // New Task policy is frozen independently. An old Objective grant cannot
    // override a changed named-operator rule in the continuation's snapshot.
    let objective = store
        .create_objective(
            ALICE,
            &CreateObjectiveRequest {
                operation_id: "changed-rule".into(),
                objective_id: "changed-rule".into(),
                owner_tag_id: "owner".into(),
                outcome: "Honor each Task policy".into(),
                team_id: Some("engineering".into()),
                ongoing: true,
                ..Default::default()
            },
        )
        .await
        .unwrap();
    let attempt = claim(&store, &host, &objective.starting_task_id).await;
    start(&store, &host, &attempt).await;
    let pending = store
        .post_attempt_workstream(&host, &post(&attempt, "old-rule", "Policy-bound action"))
        .await
        .unwrap()
        .approval
        .unwrap();
    store
        .decide_approval(
            ALICE,
            &decision(
                &pending.approval_id,
                "old-rule-grant",
                true,
                ApprovalScope::Objective,
            ),
        )
        .await
        .unwrap();
    tag(&store, "bob").await;
    finish(&store, &host, &attempt, vec![pending.approval_id.clone()]).await;
    let continuation = store
        .get_approval(ALICE, &pending.approval_id)
        .await
        .unwrap()
        .continuation_task_id
        .unwrap();
    let next = claim(&store, &host, &continuation).await;
    start(&store, &host, &next).await;
    let effect = post(&next, "new-rule", "Policy-bound action");
    let refused = store.post_attempt_workstream(&host, &effect).await.unwrap();
    assert!(refused.post.is_none());
    let pending = refused.approval.unwrap();
    assert_eq!(pending.state(), ApprovalState::Pending);
    assert_eq!(pending.operator_ids, vec!["bob"]);
    assert!(pending.grant_approval_id.is_none());
    let grant = decision(
        &pending.approval_id,
        "new-rule-grant",
        true,
        ApprovalScope::Once,
    );
    assert!(matches!(
        store.decide_approval(ALICE, &grant).await,
        Err(StoreError::PermissionDenied)
    ));
    store.decide_approval("operator:bob", &grant).await.unwrap();
    assert!(
        store
            .post_attempt_workstream(&host, &effect)
            .await
            .unwrap()
            .post
            .is_some()
    );
    finish(&store, &host, &next, vec![]).await;
    store.close().await;
}

#[tokio::test]
async fn sqlite_objective_coverage_and_paused_approval_waits() {
    let directory = tempfile::tempdir().unwrap();
    coverage_contract(&format!(
        "sqlite://{}?mode=rwc",
        directory.path().join("coverage.db").display()
    ))
    .await;
}
#[tokio::test]
#[ignore = "requires SUPERTAG_RUST_TEST_POSTGRES_URL_FILE for a dedicated PostgreSQL server"]
async fn postgres_objective_coverage_and_paused_approval_waits() {
    let path = std::env::var_os("SUPERTAG_RUST_TEST_POSTGRES_URL_FILE")
        .expect("PostgreSQL test URL file required");
    let admin_url = std::fs::read_to_string(path).unwrap();
    let name = format!("supertag_approval_coverage_{}", Uuid::new_v4().simple());
    let mut admin = sqlx::PgConnection::connect(admin_url.trim()).await.unwrap();
    admin
        .execute(format!("CREATE DATABASE {name}").as_str())
        .await
        .unwrap();
    let mut url = url::Url::parse(admin_url.trim()).unwrap();
    url.set_path(&name);
    let result = tokio::task::LocalSet::new()
        .run_until(async move {
            tokio::task::spawn_local(async move { coverage_contract(url.as_str()).await }).await
        })
        .await;
    admin
        .execute(format!("DROP DATABASE {name} WITH (FORCE)").as_str())
        .await
        .unwrap();
    admin.close().await.unwrap();
    result.expect("PostgreSQL coverage contract failed");
}
