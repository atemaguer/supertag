mod support;
use sqlx::{Connection, Executor};
use std::sync::{
    Arc,
    atomic::{AtomicI64, Ordering},
};
use supertag_control_plane::{HostAuthority, Store, StoreError};
use supertag_protocol::v2::*;
use uuid::Uuid;
const OPERATOR: &str = "operator:alice";
const NOW: i64 = 1_893_456_000_000;
fn request(attempt: &InspectAttemptRequest, operation: &str) -> StartWorkSessionRequest {
    StartWorkSessionRequest {
        attempt: Some(attempt.clone()),
        operation_id: operation.into(),
        title: "Inspect fixture".into(),
        instruction: "Review only fixture data".into(),
        ..Default::default()
    }
}
fn outcome(attempt: &InspectAttemptRequest) -> FinishTaskRequest {
    FinishTaskRequest {
        task_id: attempt.task_id.clone(),
        attempt_id: attempt.attempt_id.clone(),
        lease_token: attempt.lease_token.clone(),
        succeeded: true,
        result: "Finished fixture turn".into(),
        ..Default::default()
    }
}
async fn submit(store: &Store, tag: &str, session: &str) -> Task {
    store
        .submit_task(
            OPERATOR,
            &SubmitTaskRequest {
                tag_id: tag.into(),
                session_id: session.into(),
                operation_id: Uuid::new_v4().to_string(),
                prompt: "Inspect fixture".into(),
            },
        )
        .await
        .unwrap()
}
async fn claim(store: &Store, host: &HostAuthority) -> (Task, InspectAttemptRequest) {
    let assignment = store
        .claim_task(host, &Uuid::new_v4().to_string())
        .await
        .unwrap()
        .unwrap();
    let task = assignment.task.unwrap();
    let attempt = InspectAttemptRequest {
        task_id: task.task_id.clone(),
        attempt_id: assignment.attempt_id,
        lease_token: assignment.lease_token,
    };
    (task, attempt)
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
async fn claim_start(store: &Store, host: &HostAuthority, expected: &str) -> InspectAttemptRequest {
    let (task, attempt) = claim(store, host).await;
    assert_eq!(task.task_id, expected);
    start(store, host, &attempt).await;
    attempt
}
async fn no_child_capacity(store: &Store, host: &HostAuthority) {
    // Report turns remain runnable in the parent Session while child capacity is
    // full. Drain only those, and assert that no queued child obtains a lease.
    for _ in 0..8 {
        let Some(assignment) = store
            .claim_task(host, &Uuid::new_v4().to_string())
            .await
            .unwrap()
        else {
            return;
        };
        let task = assignment.task.unwrap();
        assert!(
            !task.session_id.starts_with("work/"),
            "child exceeded shared capacity"
        );
        let attempt = InspectAttemptRequest {
            task_id: task.task_id,
            attempt_id: assignment.attempt_id,
            lease_token: assignment.lease_token,
        };
        start(store, host, &attempt).await;
        store.finish_task(host, &outcome(&attempt)).await.unwrap();
    }
    panic!("unexpected unbounded report work");
}
async fn contract(url: String) {
    let clock = Arc::new(AtomicI64::new(NOW));
    let now = clock.clone();
    let store = Store::open(&url)
        .await
        .unwrap()
        .with_execution_clock(move || now.load(Ordering::SeqCst));
    let host = support::register_host(&store, "owner-host").await;
    let other = support::register_host(&store, "other-host").await;
    for tag in ["owner", "recipient"] {
        store
            .put_tag(tag, "Fixture identity", vec![])
            .await
            .unwrap();
    }
    store
        .put_tag("sender", "Send fixture mail", vec!["mailbox:send".into()])
        .await
        .unwrap();
    // No operator-controlled Session ID can masquerade as an internal child.
    assert!(matches!(
        store
            .submit_task(
                OPERATOR,
                &SubmitTaskRequest {
                    tag_id: "owner".into(),
                    session_id: "work/forged".into(),
                    operation_id: "forged-child".into(),
                    prompt: "Unauthorized child".into()
                }
            )
            .await,
        Err(StoreError::InvalidArgument(_))
    ));
    assert!(matches!(
        store
            .accept_event(
                "connector:fixture",
                &AcceptEventRequest {
                    account_id: "fixture".into(),
                    event_id: "forged-child".into(),
                    tag_id: "owner".into(),
                    session_id: "work/forged".into(),
                    prompt: "Unauthorized child".into(),
                    destination: Some(ReplyDestination {
                        conversation_id: "fixture".into(),
                        thread_id: None
                    })
                }
            )
            .await,
        Err(StoreError::InvalidArgument(_))
    ));

    // A real Mailbox root is internal delivery, not authority to delegate work.
    store
        .change_mailbox_grant(
            OPERATOR,
            &ChangeMailboxGrantRequest {
                operation_id: "mail-grant".into(),
                sender_tag_id: "sender".into(),
                recipient_tag_id: "recipient".into(),
                granted: true,
            },
        )
        .await
        .unwrap();
    let sender = submit(&store, "sender", "ordinary").await;
    let sender_attempt = claim_start(&store, &host, &sender.task_id).await;
    store
        .send_attempt_tag_message(
            &host,
            &SendAttemptTagMessageRequest {
                attempt: Some(sender_attempt.clone()),
                operation_id: "mail".into(),
                recipient_tag_id: "recipient".into(),
                text: "Read this fixture notice".into(),
            },
        )
        .await
        .unwrap();
    store
        .finish_task(&host, &outcome(&sender_attempt))
        .await
        .unwrap();
    let (mail, mail_attempt) = claim(&store, &host).await;
    assert!(mail.session_id.starts_with("inbox:"));
    start(&store, &host, &mail_attempt).await;
    assert!(matches!(
        store
            .start_work_session(&host, &request(&mail_attempt, "mail-child"))
            .await,
        Err(StoreError::PermissionDenied)
    ));
    store
        .finish_task(&host, &outcome(&mail_attempt))
        .await
        .unwrap();

    // An expired native Attempt cannot create a new Work Session.
    let stale = submit(&store, "owner", "stale").await;
    let stale_attempt = claim_start(&store, &host, &stale.task_id).await;
    clock.fetch_add(31_000, Ordering::SeqCst);
    assert!(matches!(
        store
            .start_work_session(&host, &request(&stale_attempt, "stale-child"))
            .await,
        Err(StoreError::FailedPrecondition(_))
    ));
    store
        .finish_task(&host, &outcome(&stale_attempt))
        .await
        .unwrap();
    store
        .resolve_attempt(
            OPERATOR,
            &ResolveAttemptRequest {
                task_id: stale.task_id,
                attempt_id: stale_attempt.attempt_id,
                operation_id: "resolve-stale".into(),
                decision: AttemptDecision::Failed as i32,
                evidence: "Fixture native execution stopped".into(),
                confirmed_stopped: true,
            },
        )
        .await
        .unwrap();

    let first = submit(&store, "owner", "parent").await;
    let first_attempt = claim_start(&store, &host, &first.task_id).await;
    let mut wrong = request(&first_attempt, "wrong-target");
    wrong.target_tag_id = Some("recipient".into());
    assert!(matches!(
        store.start_work_session(&host, &wrong).await,
        Err(StoreError::PermissionDenied)
    ));
    wrong = request(&first_attempt, "wrong-workspace");
    wrong.workspace_id = Some("unbound".into());
    assert!(matches!(
        store.start_work_session(&host, &wrong).await,
        Err(StoreError::FailedPrecondition(_))
    ));
    assert!(matches!(
        store
            .start_work_session(&other, &request(&first_attempt, "wrong-host"))
            .await,
        Err(StoreError::PermissionDenied)
    ));
    wrong = request(&first_attempt, "wrong-lease");
    wrong.attempt.as_mut().unwrap().lease_token = "wrong".into();
    assert!(matches!(
        store.start_work_session(&host, &wrong).await,
        Err(StoreError::PermissionDenied)
    ));
    let same = request(&first_attempt, "same");
    let (left, right) = tokio::join!(
        store.start_work_session(&host, &same),
        store.start_work_session(&host, &same)
    );
    let first_child = left.unwrap();
    assert_eq!(first_child, right.unwrap());
    let mut children = vec![first_child];
    let mut changed = same.clone();
    changed.instruction = "Changed request".into();
    assert!(matches!(
        store.start_work_session(&host, &changed).await,
        Err(StoreError::Conflict(_))
    ));
    for index in 1..4 {
        children.push(
            store
                .start_work_session(&host, &request(&first_attempt, &format!("child-{index}")))
                .await
                .unwrap(),
        );
    }
    let per_turn = store
        .start_work_session(&host, &request(&first_attempt, "fifth"))
        .await
        .unwrap_err();
    assert!(matches!(per_turn, StoreError::FailedPrecondition(_)));
    assert!(per_turn.to_string().contains("four"));
    // A replay does not consume another slot after reaching the bound.
    assert_eq!(
        store
            .start_work_session(&host, &same)
            .await
            .unwrap()
            .work_session_id,
        children[0].work_session_id
    );
    let mut claimed = vec![];
    for child in &children {
        let (task, attempt) = claim(&store, &other).await;
        assert_eq!(task.task_id, child.latest_task_id);
        assert_eq!(task.state(), TaskState::Claimed);
        claimed.push(attempt);
    }
    let second = submit(&store, "owner", "parent").await;
    assert!(
        store
            .claim_task(&host, "owner-still-running")
            .await
            .unwrap()
            .is_none()
    );
    store
        .finish_task(&host, &outcome(&first_attempt))
        .await
        .unwrap();
    let second_attempt = claim_start(&store, &host, &second.task_id).await;
    for index in 4..8 {
        children.push(
            store
                .start_work_session(&host, &request(&second_attempt, &format!("child-{index}")))
                .await
                .unwrap(),
        );
    }
    store
        .finish_task(&host, &outcome(&second_attempt))
        .await
        .unwrap();
    let third = submit(&store, "owner", "parent").await;
    let third_attempt = claim_start(&store, &host, &third.task_id).await;
    let parent_limit = store
        .start_work_session(&host, &request(&third_attempt, "ninth-open"))
        .await
        .unwrap_err();
    assert!(matches!(parent_limit, StoreError::FailedPrecondition(_)));
    assert!(parent_limit.to_string().contains("eight"));
    store
        .finish_task(&host, &outcome(&third_attempt))
        .await
        .unwrap();
    no_child_capacity(&store, &host).await; // Four claimed reservations hold capacity.
    for attempt in &claimed {
        start(&store, &other, attempt).await;
    }
    assert!(matches!(
        store
            .start_work_session(&other, &request(&claimed[0], "nested-child"))
            .await,
        Err(StoreError::PermissionDenied)
    ));
    no_child_capacity(&store, &host).await; // Four running native Attempts hold it.
    store.cancel_task(&claimed[0].task_id).await.unwrap();
    no_child_capacity(&store, &host).await; // Cancelled, cleanup outstanding still counts.
    clock.fetch_add(31_000, Ordering::SeqCst);
    store.sweep_expired_attempts().await.unwrap();
    for attempt in &claimed[1..] {
        assert_eq!(
            store.get_task(&attempt.task_id).await.unwrap().state(),
            TaskState::Uncertain
        );
    }
    no_child_capacity(&store, &host).await; // Uncertain + cancelled cleanup cannot be replaced.
    store
        .finish_task(&other, &outcome(&claimed[0]))
        .await
        .unwrap();
    let (task, new_claim) = claim(&store, &host).await;
    assert_eq!(task.task_id, children[4].latest_task_id);
    assert_eq!(task.state(), TaskState::Claimed);
    no_child_capacity(&store, &other).await; // One new claim plus three Uncertain is still four.
    store
        .resolve_attempt(
            OPERATOR,
            &ResolveAttemptRequest {
                task_id: claimed[1].task_id.clone(),
                attempt_id: claimed[1].attempt_id.clone(),
                operation_id: "release-uncertain".into(),
                decision: AttemptDecision::Failed as i32,
                evidence: "Audited fixture cleanup".into(),
                confirmed_stopped: true,
            },
        )
        .await
        .unwrap();
    let (task, _) = claim(&store, &other).await;
    assert_eq!(task.task_id, children[5].latest_task_id);
    no_child_capacity(&store, &other).await;
    assert_eq!(
        store.get_task(&new_claim.task_id).await.unwrap().state(),
        TaskState::Claimed
    );
    store.close().await;
}
#[tokio::test]
async fn sqlite_work_session_admission() {
    let dir = tempfile::tempdir().unwrap();
    contract(format!(
        "sqlite://{}?mode=rwc",
        dir.path().join("admission.db").display()
    ))
    .await;
}
#[tokio::test]
#[ignore = "requires dedicated PostgreSQL"]
async fn postgres_work_session_admission() {
    let file = std::env::var_os("SUPERTAG_RUST_TEST_POSTGRES_URL_FILE").expect("URL file");
    let admin_url = std::fs::read_to_string(file).unwrap();
    let mut url = url::Url::parse(admin_url.trim()).unwrap();
    let db = format!("supertag_work_admission_{}", Uuid::new_v4().simple());
    let mut admin = sqlx::PgConnection::connect(admin_url.trim()).await.unwrap();
    admin
        .execute(format!("CREATE DATABASE {db}").as_str())
        .await
        .unwrap();
    url.set_path(&db);
    let result = tokio::task::LocalSet::new()
        .run_until(async move { tokio::task::spawn_local(contract(url.to_string())).await })
        .await;
    admin
        .execute(format!("DROP DATABASE {db} WITH (FORCE)").as_str())
        .await
        .unwrap();
    admin.close().await.unwrap();
    result.unwrap();
}
