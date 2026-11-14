//! Approval decisions continue a turn's remaining budget rather than resetting it.
use super::*;
use sqlx::{Connection, Executor};

const NOW: i64 = 1_900_000_000_000;
const OPERATOR: &str = "operator:budget-root";
fn limits(tokens: u64, amount_minor: u64) -> ExecutionLimits {
    ExecutionLimits {
        max_reported_tokens: Some(tokens),
        max_reported_cost: Some(ReportedCostLimit {
            amount_minor,
            currency: "USD".into(),
        }),
        max_native_agents: Some(0),
    }
}
async fn contract(url: &str) {
    let store = Store::open(url).await.unwrap().with_execution_clock(|| NOW);
    store
        .seed_host(
            "budget-root",
            &Sha256::digest(b"synthetic budget-root credential"),
        )
        .await
        .unwrap();
    let registration = store.register_host("budget-root", "one").await.unwrap();
    let host = HostAuthority::new("host:budget-root", registration.generation).unwrap();
    store
        .put_tag_spec(PutTagRequest {
            tag_id: "lead".into(),
            instructions: "Observe the agreed limits".into(),
            allowed_actions: vec!["mailbox:send".into()],
            approval_rules: vec![ApprovalRule {
                action: "mailbox:send".into(),
                operator_ids: vec!["budget-root".into()],
            }],
            ..Default::default()
        })
        .await
        .unwrap();
    let mut next = store
        .send_message(
            OPERATOR,
            &SendMessageRequest {
                output_policy: None,
                tag_id: "lead".into(),
                conversation: "bounded-root".into(),
                operation_id: "begin".into(),
                text: "Request one reviewed action".into(),
                execution_limits: Some(limits(10_000, 500)),
            },
        )
        .await
        .unwrap()
        .task
        .unwrap();
    for (index, tokens, cost, remaining_tokens, remaining_cost) in [
        (1, 6_000, 150, 4_000, 350),
        (2, 2_000, 200, 2_000, 150),
        (3, 1_000, 126, 1_000, 24),
    ] {
        let assigned = store
            .claim_task(&host, &format!("claim-{index}"))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(assigned.task.unwrap().task_id, next.task_id);
        let attempt = InspectAttemptRequest {
            task_id: next.task_id.clone(),
            attempt_id: assigned.attempt_id,
            lease_token: assigned.lease_token,
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
        assert!(
            matches!(
                store
                    .start_work_session(
                        &host,
                        &StartWorkSessionRequest {
                            attempt: Some(attempt.clone()),
                            operation_id: format!("forbidden-child-{index}"),
                            title: "Must not start".into(),
                            instruction: "No delegation is allowed".into(),
                            ..Default::default()
                        }
                    )
                    .await,
                Err(StoreError::FailedPrecondition(_) | StoreError::PermissionDenied)
            ),
            "zero native-agent cap must survive every approval continuation"
        );
        store
            .report_attempt_usage(
                &host,
                &ReportAttemptUsageRequest {
                    attempt: Some(attempt.clone()),
                    sequence: 1,
                    native_usage: Some(NativeTokenUsage {
                        input_tokens: tokens,
                        total_tokens: Some(tokens),
                        ..Default::default()
                    }),
                    amount_minor: Some(cost),
                    currency: Some("USD".into()),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        let (mut tx, order) = store.write().await.unwrap();
        let approval = gate_in(
            &mut tx,
            &host,
            &RequestApprovalRequest {
                attempt: Some(attempt.clone()),
                operation_id: format!("effect-{index}"),
                action: "mailbox:send".into(),
                resource: "tag:reviewer".into(),
                arguments_json: format!("{{\"text\":\"review {index}\"}}"),
                summary: "Review before sending".into(),
            },
            NOW,
            order,
        )
        .await
        .unwrap()
        .approval
        .unwrap();
        tx.commit().await.unwrap();
        store
            .finish_task(
                &host,
                &FinishTaskRequest {
                    task_id: attempt.task_id.clone(),
                    attempt_id: attempt.attempt_id.clone(),
                    lease_token: attempt.lease_token,
                    succeeded: true,
                    result: "Awaiting operator decision".into(),
                    waiting_approval_ids: vec![approval.approval_id.clone()],
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        let decision = DecideApprovalRequest {
            approval_id: approval.approval_id,
            operation_id: format!("decision-{index}"),
            approve: index == 1,
            scope: if index == 1 {
                ApprovalScope::Once as i32
            } else {
                ApprovalScope::Unspecified as i32
            },
            reason: "Reviewed bounded continuation".into(),
            ..Default::default()
        };
        store.decide_approval(OPERATOR, &decision).await.unwrap();
        store.decide_approval(OPERATOR, &decision).await.unwrap();
        store.sweep_approvals().await.unwrap();
        if index == 3 {
            let continuation: Option<String> = sqlx::query_scalar(
                "SELECT continuation_task_id FROM supertag_v2_approval_waits WHERE task_id=$1",
            )
            .bind(&attempt.task_id)
            .fetch_one(&store.pool)
            .await
            .unwrap();
            assert_eq!(
                continuation, None,
                "cost remainder below five percent cannot create another work turn"
            );
            let stops = sqlx::query("SELECT reason,notice_task_id FROM supertag_v2_approval_continuation_stops WHERE task_id=$1").bind(&attempt.task_id).fetch_all(&store.pool).await.unwrap();
            assert_eq!(stops.len(), 1);
            assert_eq!(stops[0].get::<String, _>("reason"), "budget");
            let notice = store
                .get_task(&stops[0].get::<String, _>("notice_task_id"))
                .await
                .unwrap();
            assert_eq!(
                notice.execution_limits,
                Some(limits(remaining_tokens, remaining_cost)),
                "owed notice receives only the remaining reported pool"
            );
            assert!(notice.allowed_actions.is_empty());
            let history = ListMessagesRequest {
                tag_id: "lead".into(),
                conversation: "bounded-root".into(),
                limit: 100,
                cursor: String::new(),
            };
            let visible = store.list_messages(OPERATOR, &history).await.unwrap();
            assert_eq!(
                visible
                    .messages
                    .iter()
                    .filter(|message| message
                        .task
                        .as_ref()
                        .is_some_and(|task| task.task_id == notice.task_id))
                    .count(),
                1,
                "one stop notice is visible in its private Conversation"
            );
            assert!(
                store
                    .list_messages("operator:outsider", &history)
                    .await
                    .unwrap()
                    .messages
                    .is_empty(),
                "private notice must not leak to another operator"
            );
            let mut tx = store.pool.begin().await.unwrap();
            assert!(!task_waits_in(&mut tx, &attempt.task_id).await.unwrap());
            tx.commit().await.unwrap();
            store.cancel_task(&notice.task_id).await.unwrap();
            break;
        }
        let id: String = sqlx::query_scalar(
            "SELECT continuation_task_id FROM supertag_v2_approval_waits WHERE task_id=$1",
        )
        .bind(&attempt.task_id)
        .fetch_one(&store.pool)
        .await
        .unwrap();
        next = store.get_task(&id).await.unwrap();
        assert_eq!(
            next.execution_limits,
            Some(limits(remaining_tokens, remaining_cost)),
            "approval turn {index} must draw from the original turn's cumulative pool"
        );
        assert_ne!(next.task_id, attempt.task_id);
    }
    objective_notice_case(&store, &host).await;
    store.close().await;
}

async fn objective_notice_case(store: &Store, host: &HostAuthority) {
    let objective = store
        .create_objective(
            OPERATOR,
            &CreateObjectiveRequest {
                objective_id: "notice-budget".into(),
                operation_id: "create-notice-budget".into(),
                owner_tag_id: "lead".into(),
                outcome: "Verify a budget warning cannot replace a pending decision".into(),
                ongoing: true,
                budget_limit_minor: Some(1_000),
                budget_currency: Some("USD".into()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    let assignment = store
        .claim_task(host, "objective-claim")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(assignment.task.unwrap().task_id, objective.starting_task_id);
    let attempt = InspectAttemptRequest {
        task_id: objective.starting_task_id,
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
    store
        .report_attempt_usage(
            host,
            &ReportAttemptUsageRequest {
                attempt: Some(attempt.clone()),
                sequence: 1,
                amount_minor: Some(980),
                currency: Some("USD".into()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    let notices: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM supertag_v2_objective_tasks link JOIN supertag_v2_tasks n ON n.task_id=link.task_id JOIN supertag_v2_tasks owner ON owner.task_id=$1 WHERE link.objective_id=$2 AND link.kind='notice' AND n.accepted_order>owner.accepted_order").bind(&attempt.task_id).bind(&objective.objective_id).fetch_one(&store.pool).await.unwrap();
    assert!(
        notices > 0,
        "fixture must create a later administrative budget warning"
    );
    let (mut tx, order) = store.write().await.unwrap();
    let approval = gate_in(
        &mut tx,
        host,
        &RequestApprovalRequest {
            attempt: Some(attempt.clone()),
            operation_id: "warning-effect".into(),
            action: "mailbox:send".into(),
            resource: "tag:reviewer".into(),
            arguments_json: "{\"text\":\"warning fixture\"}".into(),
            summary: "Approve the bounded action".into(),
        },
        NOW,
        order,
    )
    .await
    .unwrap()
    .approval
    .unwrap();
    tx.commit().await.unwrap();
    store
        .finish_task(
            host,
            &FinishTaskRequest {
                task_id: attempt.task_id.clone(),
                attempt_id: attempt.attempt_id.clone(),
                lease_token: attempt.lease_token,
                succeeded: true,
                result: "Wait for approval".into(),
                waiting_approval_ids: vec![approval.approval_id.clone()],
                ..Default::default()
            },
        )
        .await
        .unwrap();
    let items = store
        .list_inbox_items(
            OPERATOR,
            &ListInboxItemsRequest {
                objective_id: objective.objective_id,
                kind: InboxItemKind::Approval as i32,
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert_eq!(
        items
            .items
            .iter()
            .filter(|item| item
                .approval
                .as_ref()
                .is_some_and(|a| a.approval_id == approval.approval_id))
            .count(),
        1,
        "administrative notices cannot expire the owner's explicit approval wait"
    );
    let decision = DecideApprovalRequest {
        approval_id: approval.approval_id,
        operation_id: "warning-decision".into(),
        approve: true,
        scope: ApprovalScope::Once as i32,
        reason: "Reviewed".into(),
        ..Default::default()
    };
    store.decide_approval(OPERATOR, &decision).await.unwrap();
    store.sweep_approvals().await.unwrap();
    store.decide_approval(OPERATOR, &decision).await.unwrap();
    let continuation: Option<String> = sqlx::query_scalar(
        "SELECT continuation_task_id FROM supertag_v2_approval_waits WHERE task_id=$1",
    )
    .bind(&attempt.task_id)
    .fetch_one(&store.pool)
    .await
    .unwrap();
    assert_eq!(continuation, None);
    let stops = sqlx::query(
        "SELECT notice_task_id FROM supertag_v2_approval_continuation_stops WHERE task_id=$1",
    )
    .bind(&attempt.task_id)
    .fetch_all(&store.pool)
    .await
    .unwrap();
    assert_eq!(stops.len(), 1);
    let notice = store
        .get_task(&stops[0].get::<String, _>("notice_task_id"))
        .await
        .unwrap();
    assert!(notice.allowed_actions.is_empty());
    assert_eq!(
        notice
            .execution_limits
            .unwrap()
            .max_reported_cost
            .unwrap()
            .amount_minor,
        20
    );
}
#[tokio::test]
async fn sqlite_root_approval_retains_remaining_turn_budget() {
    let d = tempfile::tempdir().unwrap();
    Box::pin(contract(&format!(
        "sqlite://{}?mode=rwc",
        d.path().join("root-approval.db").display()
    )))
    .await;
}
#[tokio::test]
#[ignore = "requires SUPERTAG_RUST_TEST_POSTGRES_URL_FILE"]
async fn postgres_root_approval_retains_remaining_turn_budget() {
    let text =
        std::fs::read_to_string(std::env::var_os("SUPERTAG_RUST_TEST_POSTGRES_URL_FILE").unwrap())
            .unwrap();
    let mut admin = sqlx::PgConnection::connect(text.trim()).await.unwrap();
    let db = format!("supertag_root_approval_{}", Uuid::new_v4().simple());
    admin
        .execute(format!("CREATE DATABASE {db}").as_str())
        .await
        .unwrap();
    let mut url = url::Url::parse(text.trim()).unwrap();
    url.set_path(&db);
    let result = tokio::task::LocalSet::new()
        .run_until(async move {
            tokio::task::spawn_local(async move { Box::pin(contract(url.as_str())).await }).await
        })
        .await;
    admin
        .execute(format!("DROP DATABASE {db} WITH (FORCE)").as_str())
        .await
        .unwrap();
    admin.close().await.unwrap();
    result.unwrap();
}
