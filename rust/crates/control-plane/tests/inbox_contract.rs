mod support;

use sqlx::{Connection, Executor};
use std::sync::{
    Arc,
    atomic::{AtomicI64, Ordering},
};
use supertag_control_plane::{HostAuthority, Store, StoreError};
use supertag_protocol::v2::*;
use uuid::Uuid;

const OPERATOR: &str = "operator:inbox-test";
const NOW: i64 = 1_900_000_000_000;
async fn create(store: &Store, id: &str) -> Objective {
    store
        .create_objective(
            OPERATOR,
            &CreateObjectiveRequest {
                operation_id: format!("create-{id}"),
                objective_id: id.into(),
                owner_tag_id: "owner".into(),
                outcome: "Resolve the decision".into(),
                ..Default::default()
            },
        )
        .await
        .unwrap()
}
async fn claim(store: &Store, host: &HostAuthority, id: &str) -> InspectAttemptRequest {
    let assignment = store
        .claim_task(host, &Uuid::new_v4().to_string())
        .await
        .unwrap()
        .expect("expected Task");
    assert_eq!(assignment.task.unwrap().task_id, id);
    InspectAttemptRequest {
        task_id: id.into(),
        attempt_id: assignment.attempt_id,
        lease_token: assignment.lease_token,
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
fn ask(attempt: &InspectAttemptRequest, text: &str) -> AskQuestionRequest {
    AskQuestionRequest {
        attempt: Some(attempt.clone()),
        operation_id: "ask".into(),
        text: text.into(),
    }
}
async fn finish(store: &Store, host: &HostAuthority, attempt: &InspectAttemptRequest) {
    store
        .finish_task(
            host,
            &FinishTaskRequest {
                task_id: attempt.task_id.clone(),
                attempt_id: attempt.attempt_id.clone(),
                lease_token: attempt.lease_token.clone(),
                succeeded: true,
                result: "Waiting for your answer".into(),
                ..Default::default()
            },
        )
        .await
        .unwrap();
}
async fn list(store: &Store, id: &str) -> ListInboxItemsResponse {
    store
        .list_inbox_items(
            OPERATOR,
            &ListInboxItemsRequest {
                objective_id: id.into(),
                ..Default::default()
            },
        )
        .await
        .unwrap()
}
async fn cancel(store: &Store, id: &str) {
    store
        .cancel_objective(
            OPERATOR,
            &ObjectiveActionRequest {
                objective_id: id.into(),
                operation_id: format!("cancel-{id}"),
                reason: "Complete test".into(),
            },
        )
        .await
        .unwrap();
}
async fn ready_question(
    store: &Store,
    host: &HostAuthority,
    id: &str,
    text: &str,
) -> (Objective, InspectAttemptRequest) {
    let objective = create(store, id).await;
    let attempt = claim(store, host, &objective.starting_task_id).await;
    start(store, host, &attempt).await;
    store
        .ask_question(host, &ask(&attempt, text))
        .await
        .unwrap();
    finish(store, host, &attempt).await;
    (objective, attempt)
}
async fn contract(url: &str) {
    let clock = Arc::new(AtomicI64::new(NOW));
    let now = clock.clone();
    let store = Store::open(url)
        .await
        .unwrap()
        .with_execution_clock(move || now.load(Ordering::SeqCst));
    store
        .put_tag("owner", "Original policy", vec!["files:read".into()])
        .await
        .unwrap();
    let host = support::register_host(&store, "question-host").await;
    let other = support::register_host(&store, "other-host").await;
    let objective = create(&store, "question").await;
    let attempt = claim(&store, &host, &objective.starting_task_id).await;
    let text = format!("Which option? {}", "x".repeat(600));
    let input = ask(&attempt, &format!("  {text}  "));
    assert!(matches!(
        store.ask_question(&host, &input).await,
        Err(StoreError::FailedPrecondition(_))
    ));
    start(&store, &host, &attempt).await;
    assert!(matches!(
        store.ask_question(&other, &input).await,
        Err(StoreError::PermissionDenied)
    ));
    let question = store.ask_question(&host, &input).await.unwrap();
    assert_eq!(question.text, text);
    assert_eq!(question.published_at_ms, None);
    assert_eq!(store.ask_question(&host, &input).await.unwrap(), question);
    assert!(matches!(
        store
            .ask_question(
                &host,
                &AskQuestionRequest {
                    text: "Changed".into(),
                    ..input.clone()
                }
            )
            .await,
        Err(StoreError::Conflict(_))
    ));
    assert!(matches!(
        store
            .ask_question(
                &host,
                &AskQuestionRequest {
                    operation_id: "second-question".into(),
                    ..input.clone()
                }
            )
            .await,
        Err(StoreError::Conflict(_))
    ));
    assert!(list(&store, "question").await.items.is_empty());
    assert!(matches!(
        store.get_question(OPERATOR, &attempt.task_id).await,
        Err(StoreError::NotFound(_))
    ));
    // Asking and completing the Objective in the same result are incompatible.
    assert!(matches!(
        store
            .finish_task(
                &host,
                &FinishTaskRequest {
                    task_id: attempt.task_id.clone(),
                    attempt_id: attempt.attempt_id.clone(),
                    lease_token: attempt.lease_token.clone(),
                    succeeded: true,
                    result: "Finished".into(),
                    objective_signal: ObjectiveSignal::Completed as i32,
                    ..Default::default()
                }
            )
            .await,
        Err(StoreError::InvalidArgument(_))
    ));
    finish(&store, &host, &attempt).await;
    finish(&store, &host, &attempt).await;
    store.sweep_objectives().await.unwrap();
    assert!(
        store
            .claim_task(&other, "question-prevents-idle")
            .await
            .unwrap()
            .is_none()
    );
    let page = list(&store, "question").await;
    assert_eq!(page.items.len(), 1);
    assert_eq!(page.items[0].kind(), InboxItemKind::Question);
    assert_eq!(page.items[0].key, format!("question:{}", attempt.task_id));
    assert!(page.items[0].operator_eligible);
    assert!(page.items[0].question.as_ref().unwrap().truncated);
    assert_eq!(
        page.items[0]
            .question
            .as_ref()
            .unwrap()
            .text
            .chars()
            .count(),
        500
    );
    assert_eq!(
        store
            .get_question(OPERATOR, &attempt.task_id)
            .await
            .unwrap()
            .text,
        text
    );
    assert!(matches!(
        store
            .list_inbox_items("host:question-host", &ListInboxItemsRequest::default())
            .await,
        Err(StoreError::PermissionDenied)
    ));
    store
        .put_tag("owner", "New accepted policy", vec![])
        .await
        .unwrap();
    let answer = AnswerQuestionRequest {
        task_id: attempt.task_id.clone(),
        operation_id: "answer-once".into(),
        text: "  Use the safe option.  ".into(),
    };
    let (one, two) = tokio::join!(
        store.answer_question(OPERATOR, &answer),
        store.answer_question(OPERATOR, &answer)
    );
    let answer_task = one.unwrap();
    assert_eq!(answer_task, two.unwrap());
    assert_eq!(answer_task.session_id, objective.session_id);
    assert_eq!(answer_task.prompt, "Use the safe option.");
    assert_eq!(answer_task.instructions, "New accepted policy");
    assert_eq!(
        store
            .get_question(OPERATOR, &attempt.task_id)
            .await
            .unwrap()
            .answer_task_id
            .as_deref(),
        Some(answer_task.task_id.as_str())
    );
    assert!(list(&store, "question").await.items.is_empty());
    assert!(matches!(
        store
            .answer_question(
                OPERATOR,
                &AnswerQuestionRequest {
                    text: "Different".into(),
                    ..answer.clone()
                }
            )
            .await,
        Err(StoreError::Conflict(_))
    ));
    assert!(matches!(
        store
            .answer_question(
                OPERATOR,
                &AnswerQuestionRequest {
                    operation_id: "other-answer".into(),
                    ..answer.clone()
                }
            )
            .await,
        Err(StoreError::FailedPrecondition(_))
    ));
    cancel(&store, "question").await;
    store.close().await;
    let now = clock.clone();
    let store = Store::open(url)
        .await
        .unwrap()
        .with_execution_clock(move || now.load(Ordering::SeqCst));
    assert_eq!(
        store
            .answer_question(OPERATOR, &answer)
            .await
            .unwrap()
            .task_id,
        answer_task.task_id
    );

    let (race, race_attempt) = ready_question(&store, &host, "race", "May I continue?").await;
    let first = AnswerQuestionRequest {
        task_id: race_attempt.task_id.clone(),
        operation_id: "first-answer".into(),
        text: "Yes".into(),
    };
    let second = AnswerQuestionRequest {
        operation_id: "second-answer".into(),
        text: "No".into(),
        ..first.clone()
    };
    let (one, two) = tokio::join!(
        store.answer_question(OPERATOR, &first),
        store.answer_question(OPERATOR, &second)
    );
    assert_ne!(one.is_ok(), two.is_ok());
    assert!(matches!(
        one.as_ref().err().or(two.as_ref().err()),
        Some(StoreError::FailedPrecondition(_))
    ));
    cancel(&store, &race.objective_id).await;
    let (race, race_attempt) = ready_question(&store, &host, "cancel-race", "May I proceed?").await;
    let input = AnswerQuestionRequest {
        task_id: race_attempt.task_id,
        operation_id: "cancel-race-answer".into(),
        text: "Proceed".into(),
    };
    let (answer, ()) = tokio::join!(
        store.answer_question(OPERATOR, &input),
        cancel(&store, &race.objective_id)
    );
    assert!(list(&store, &race.objective_id).await.items.is_empty());
    if let Ok(task) = answer {
        assert_eq!(
            store.get_task(&task.task_id).await.unwrap().state(),
            TaskState::Cancelled
        );
    }

    let (stale, stale_attempt) = ready_question(&store, &host, "stale", "Which route?").await;
    store
        .submit_task(
            OPERATOR,
            &SubmitTaskRequest {
                tag_id: "owner".into(),
                session_id: stale.session_id,
                operation_id: "newer-turn".into(),
                prompt: "I have new instructions".into(),
            },
        )
        .await
        .unwrap();
    assert!(list(&store, "stale").await.items.is_empty());
    assert!(matches!(
        store
            .answer_question(
                OPERATOR,
                &AnswerQuestionRequest {
                    task_id: stale_attempt.task_id,
                    operation_id: "stale-answer".into(),
                    text: "Left".into()
                }
            )
            .await,
        Err(StoreError::FailedPrecondition(_))
    ));
    cancel(&store, "stale").await;

    let aborted = create(&store, "aborted").await;
    let abort_attempt = claim(&store, &host, &aborted.starting_task_id).await;
    start(&store, &host, &abort_attempt).await;
    store
        .ask_question(&host, &ask(&abort_attempt, "Question before cancellation"))
        .await
        .unwrap();
    cancel(&store, "aborted").await;
    finish(&store, &host, &abort_attempt).await;
    assert!(list(&store, "aborted").await.items.is_empty());
    assert!(matches!(
        store.get_question(OPERATOR, &abort_attempt.task_id).await,
        Err(StoreError::NotFound(_))
    ));
    let failed = create(&store, "failed").await;
    let failed_attempt = claim(&store, &host, &failed.starting_task_id).await;
    start(&store, &host, &failed_attempt).await;
    store
        .ask_question(
            &host,
            &ask(&failed_attempt, "Question before native failure"),
        )
        .await
        .unwrap();
    store
        .finish_task(
            &host,
            &FinishTaskRequest {
                task_id: failed_attempt.task_id.clone(),
                attempt_id: failed_attempt.attempt_id.clone(),
                lease_token: failed_attempt.lease_token.clone(),
                succeeded: false,
                result: "Execution failed".into(),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert!(list(&store, "failed").await.items.is_empty());
    assert!(matches!(
        store.get_question(OPERATOR, &failed_attempt.task_id).await,
        Err(StoreError::NotFound(_))
    ));
    cancel(&store, "failed").await;
    let (paused, paused_attempt) =
        ready_question(&store, &host, "paused", "Can this continue?").await;
    store
        .pause_objective(
            OPERATOR,
            &ObjectiveActionRequest {
                objective_id: paused.objective_id.clone(),
                operation_id: "pause-question".into(),
                reason: "Wait".into(),
            },
        )
        .await
        .unwrap();
    assert!(matches!(
        store
            .answer_question(
                OPERATOR,
                &AnswerQuestionRequest {
                    task_id: paused_attempt.task_id,
                    operation_id: "paused-answer".into(),
                    text: "Continue".into()
                }
            )
            .await,
        Err(StoreError::FailedPrecondition(_))
    ));
    assert_eq!(list(&store, "paused").await.items.len(), 1);
    cancel(&store, "paused").await;

    for id in ["Page-A", "page-a", "page-B"] {
        ready_question(&store, &host, id, "Choose a direction").await;
    }
    let all = list(&store, "").await;
    assert_eq!(all.items.len(), 3);
    let mut keys = vec![];
    let mut cursor = String::new();
    loop {
        let page = store
            .list_inbox_items(
                OPERATOR,
                &ListInboxItemsRequest {
                    page_size: 1,
                    cursor,
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        assert_eq!(page.as_of_ms, NOW);
        keys.extend(page.items.iter().map(|i| i.key.clone()));
        cursor = page.next_cursor;
        if cursor.is_empty() {
            break;
        }
        assert!(matches!(
            store
                .list_inbox_items(
                    OPERATOR,
                    &ListInboxItemsRequest {
                        cursor: cursor.clone(),
                        kind: InboxItemKind::TaskAttention as i32,
                        ..Default::default()
                    }
                )
                .await,
            Err(StoreError::InvalidArgument(_))
        ));
    }
    assert_eq!(
        keys,
        all.items.iter().map(|i| i.key.clone()).collect::<Vec<_>>()
    );
    for id in ["Page-A", "page-a", "page-B"] {
        cancel(&store, id).await;
    }

    let expired = create(&store, "expired").await;
    let attempt = claim(&store, &host, &expired.starting_task_id).await;
    start(&store, &host, &attempt).await;
    clock.store(NOW + 30_000, Ordering::SeqCst);
    assert!(matches!(
        store.ask_question(&host, &ask(&attempt, "Too late")).await,
        Err(StoreError::FailedPrecondition(_))
    ));
    store.sweep_expired_attempts().await.unwrap();
    let attention = list(&store, "expired").await;
    assert_eq!(attention.items.len(), 1);
    assert_eq!(attention.items[0].kind(), InboxItemKind::TaskAttention);
    assert_eq!(
        attention.items[0].attempt_id.as_deref(),
        Some(attempt.attempt_id.as_str())
    );
    cancel(&store, "expired").await;
    let budget = store
        .create_objective(
            OPERATOR,
            &CreateObjectiveRequest {
                operation_id: "create-budget".into(),
                objective_id: "budget".into(),
                owner_tag_id: "owner".into(),
                outcome: "Stay within budget".into(),
                budget_limit_minor: Some(100),
                budget_currency: Some("USD".into()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    let attempt = claim(&store, &host, &budget.starting_task_id).await;
    start(&store, &host, &attempt).await;
    store
        .report_attempt_usage(
            &host,
            &ReportAttemptUsageRequest {
                attempt: Some(attempt.clone()),
                sequence: 1,
                amount_minor: Some(100),
                currency: Some("USD".into()),
                estimated: false,
                ..Default::default()
            },
        )
        .await
        .unwrap();
    let items = list(&store, "budget").await.items;
    assert!(
        items
            .iter()
            .any(|i| i.kind() == InboxItemKind::ObjectiveBudget)
    );
    finish(&store, &host, &attempt).await;
    store
        .set_objective_limits(
            OPERATOR,
            &SetObjectiveLimitsRequest {
                objective_id: "budget".into(),
                operation_id: "raise-budget".into(),
                budget_limit_minor: Some(200),
                budget_currency: Some("USD".into()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert!(
        !list(&store, "budget")
            .await
            .items
            .iter()
            .any(|i| i.kind() == InboxItemKind::ObjectiveBudget)
    );
    cancel(&store, "budget").await;
    let deadline_ms = clock.load(Ordering::SeqCst) + 120_000;
    let deadline = store
        .create_objective(
            OPERATOR,
            &CreateObjectiveRequest {
                operation_id: "create-deadline".into(),
                objective_id: "deadline".into(),
                owner_tag_id: "owner".into(),
                outcome: "Finish before the deadline".into(),
                deadline_ms: Some(deadline_ms),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    let attempt = claim(&store, &host, &deadline.starting_task_id).await;
    start(&store, &host, &attempt).await;
    finish(&store, &host, &attempt).await;
    clock.store(deadline_ms + 1, Ordering::SeqCst);
    store.sweep_objectives().await.unwrap();
    let page = list(&store, "deadline").await;
    assert!(
        page.items
            .iter()
            .any(|i| i.kind() == InboxItemKind::ObjectiveLimit)
    );
    for item in page
        .items
        .iter()
        .filter(|i| i.kind() == InboxItemKind::ObjectiveLimit)
    {
        assert!(item.reason.contains("has passed"));
        assert!(!item.reason.contains("seconds remain"));
    }
    cancel(&store, "deadline").await;
    assert!(list(&store, "deadline").await.items.is_empty());
    store.close().await;
}
#[tokio::test]
async fn sqlite_inbox_contract() {
    let dir = tempfile::tempdir().unwrap();
    contract(&format!(
        "sqlite://{}?mode=rwc",
        dir.path().join("inbox.db").display()
    ))
    .await;
}
#[tokio::test]
#[ignore = "requires SUPERTAG_RUST_TEST_POSTGRES_URL_FILE for a dedicated PostgreSQL test server"]
async fn postgres_inbox_contract() {
    let path = std::env::var_os("SUPERTAG_RUST_TEST_POSTGRES_URL_FILE").unwrap();
    let admin_url = std::fs::read_to_string(path).unwrap();
    let mut url = url::Url::parse(admin_url.trim()).unwrap();
    let name = format!("supertag_rust_inbox_{}", Uuid::new_v4().simple());
    let mut admin = sqlx::PgConnection::connect(admin_url.trim()).await.unwrap();
    admin
        .execute(format!("CREATE DATABASE {name}").as_str())
        .await
        .unwrap();
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
    result.unwrap();
}
