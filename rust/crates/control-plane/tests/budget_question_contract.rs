mod support;
use sqlx::{Connection, Executor};
use supertag_control_plane::{Store, StoreError};
use supertag_protocol::v2::*;
use uuid::Uuid;
const OP: &str = "operator:budget-question";
const NOW: i64 = 1_900_000_000_000;
async fn contract(url: &str) {
    let mut store = Store::open(url).await.unwrap().with_execution_clock(|| NOW);
    store
        .put_tag("owner", "Ask a decision", vec!["files:read".into()])
        .await
        .unwrap();
    let host = support::register_host(&store, "budget-question").await;
    for stale in [false, true] {
        let id = if stale { "stale" } else { "answer" };
        let objective = store
            .create_objective(
                OP,
                &CreateObjectiveRequest {
                    operation_id: format!("create-{id}"),
                    objective_id: id.into(),
                    owner_tag_id: "owner".into(),
                    outcome: "Ask a decision".into(),
                    ongoing: true,
                    budget_limit_minor: Some(1000),
                    budget_currency: Some("USD".into()),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        let claim = store
            .claim_task(&host, &format!("claim-{id}"))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(claim.task.unwrap().task_id, objective.starting_task_id);
        let attempt = InspectAttemptRequest {
            task_id: objective.starting_task_id.clone(),
            attempt_id: claim.attempt_id,
            lease_token: claim.lease_token,
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
        store
            .report_attempt_usage(
                &host,
                &ReportAttemptUsageRequest {
                    attempt: Some(attempt.clone()),
                    sequence: 1,
                    amount_minor: Some(900),
                    currency: Some("USD".into()),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        store
            .ask_question(
                &host,
                &AskQuestionRequest {
                    attempt: Some(attempt.clone()),
                    operation_id: "question".into(),
                    text: "Which release should I inspect?".into(),
                },
            )
            .await
            .unwrap();
        store
            .finish_task(
                &host,
                &FinishTaskRequest {
                    task_id: attempt.task_id.clone(),
                    attempt_id: attempt.attempt_id.clone(),
                    lease_token: attempt.lease_token.clone(),
                    succeeded: true,
                    result: "Waiting for a decision".into(),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        let mut connection = sqlx::AnyConnection::connect(url).await.unwrap();
        let notices:i64=sqlx::query_scalar("SELECT COUNT(*) FROM supertag_v2_objective_tasks n JOIN supertag_v2_tasks notice ON notice.task_id=n.task_id JOIN supertag_v2_tasks owner ON owner.task_id=$1 WHERE n.objective_id=$2 AND n.kind='notice' AND notice.accepted_order>owner.accepted_order").bind(&attempt.task_id).bind(id).fetch_one(&mut connection).await.unwrap();
        assert_eq!(notices, 1);
        connection.close().await.unwrap();
        store.close().await;
        store = Store::open(url).await.unwrap().with_execution_clock(|| NOW);
        let request = ListInboxItemsRequest {
            objective_id: id.into(),
            kind: InboxItemKind::Question.into(),
            ..Default::default()
        };
        let items = store.list_inbox_items(OP, &request).await.unwrap().items;
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].task_id, attempt.task_id);
        if stale {
            store
                .submit_task(
                    OP,
                    &SubmitTaskRequest {
                        tag_id: "owner".into(),
                        session_id: objective.session_id,
                        operation_id: "new-real-turn".into(),
                        prompt: "Use a different plan".into(),
                        ..Default::default()
                    },
                )
                .await
                .unwrap();
            assert!(
                store
                    .list_inbox_items(OP, &request)
                    .await
                    .unwrap()
                    .items
                    .is_empty()
            );
        }
        let answer = AnswerQuestionRequest {
            task_id: attempt.task_id,
            operation_id: format!("answer-{id}"),
            text: "Inspect the fixture release".into(),
        };
        if stale {
            assert!(matches!(
                store.answer_question(OP, &answer).await,
                Err(StoreError::FailedPrecondition(_))
            ));
        } else {
            let (one, two) = tokio::join!(
                store.answer_question(OP, &answer),
                store.answer_question(OP, &answer)
            );
            let one = one.unwrap();
            assert_eq!(one, two.unwrap());
            assert_eq!(
                one.execution_limits
                    .unwrap()
                    .max_reported_cost
                    .unwrap()
                    .amount_minor,
                100
            );
        }
        store
            .cancel_objective(
                OP,
                &ObjectiveActionRequest {
                    objective_id: id.into(),
                    operation_id: format!("cancel-{id}"),
                    reason: "Fixture complete".into(),
                },
            )
            .await
            .unwrap();
    }
    store.close().await;
}
#[tokio::test]
async fn sqlite_budget_notice_preserves_question_freshness() {
    let d = tempfile::tempdir().unwrap();
    Box::pin(contract(&format!(
        "sqlite://{}?mode=rwc",
        d.path().join("questions.db").display()
    )))
    .await;
}
#[tokio::test]
#[ignore = "requires SUPERTAG_RUST_TEST_POSTGRES_URL_FILE"]
async fn postgres_budget_notice_preserves_question_freshness() {
    let a =
        std::fs::read_to_string(std::env::var_os("SUPERTAG_RUST_TEST_POSTGRES_URL_FILE").unwrap())
            .unwrap();
    let name = format!("supertag_budget_question_{}", Uuid::new_v4().simple());
    let mut admin = sqlx::PgConnection::connect(a.trim()).await.unwrap();
    admin
        .execute(format!("CREATE DATABASE {name}").as_str())
        .await
        .unwrap();
    let mut u = url::Url::parse(a.trim()).unwrap();
    u.set_path(&name);
    let result = tokio::task::LocalSet::new()
        .run_until(async move {
            tokio::task::spawn_local(async move { Box::pin(contract(u.as_str())).await }).await
        })
        .await;
    admin
        .execute(format!("DROP DATABASE {name} WITH (FORCE)").as_str())
        .await
        .unwrap();
    admin.close().await.unwrap();
    result.unwrap();
}
