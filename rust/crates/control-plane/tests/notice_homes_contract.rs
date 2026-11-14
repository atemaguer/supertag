//! Where an Objective's limit notices post, and their withdrawal before delivery, on both
//! databases. TypeScript parity: `objectiveHome` and `BudgetNotifications` in
//! `packages/control-plane/src/{objective-sessions,budget-notifications}.ts`,
//! `tests/budget-notification-delivery.test.ts` (`revoked=none|tag`), and the Inbox enricher's
//! budget notice status.
mod support;

use std::{
    future::Future,
    sync::{
        Arc,
        atomic::{AtomicI64, Ordering},
    },
};

use sqlx::{Connection, Executor};
use supertag_control_plane::{HostAuthority, Store, StoreError};
use supertag_protocol::v2::*;
use uuid::Uuid;

const OPERATOR: &str = "operator:local";
const CONNECTOR: &str = "connector:slack-notices";
const NOW: i64 = 1_893_456_000_000;
const WITHDRAWN: &str =
    "Operator notification was superseded, resolved, or its destination is no longer verified";

/// A plain mention by tag `helper` in a new Slack thread: a surface Task whose thread an
/// operator can choose for an Objective's notices.
async fn thread_task(store: &Store, host: &HostAuthority, thread: &str) -> String {
    let task = store
        .accept_slack_event(
            CONNECTOR,
            &AcceptSlackEventRequest {
                account_id: "slack-notices".into(),
                event_id: format!("Ev{thread}"),
                team_id: "TTEAM1".into(),
                channel_id: "CNOTICES".into(),
                message_ts: thread.into(),
                thread_ts: thread.into(),
                prompt: "Post the release notices here".into(),
                mention_tag_id: Some("helper".into()),
                actor_id: "UALICE1".into(),
            },
        )
        .await
        .unwrap()
        .task
        .unwrap()
        .task_id;
    // The mention's own turn runs and answers; only its thread matters here.
    let attempt = claim(store, host, &task).await;
    finish(store, host, &attempt).await;
    task
}

async fn claim(store: &Store, host: &HostAuthority, expected: &str) -> InspectAttemptRequest {
    store
        .register_host("worker", "test-incarnation")
        .await
        .unwrap();
    let assignment = store
        .claim_task(host, &Uuid::new_v4().to_string())
        .await
        .unwrap()
        .expect("a queued Task");
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

async fn finish(store: &Store, host: &HostAuthority, attempt: &InspectAttemptRequest) {
    store
        .finish_task(
            host,
            &FinishTaskRequest {
                task_id: attempt.task_id.clone(),
                attempt_id: attempt.attempt_id.clone(),
                lease_token: attempt.lease_token.clone(),
                succeeded: true,
                result: "Noted.".into(),
                ..Default::default()
            },
        )
        .await
        .unwrap();
}

/// An Objective with a 100 USD budget whose first turn reported `spent` and is still running.
async fn objective(
    store: &Store,
    host: &HostAuthority,
    id: &str,
    notification_task: Option<&str>,
    spent: u64,
) -> InspectAttemptRequest {
    let objective = store
        .create_objective(
            OPERATOR,
            &CreateObjectiveRequest {
                operation_id: format!("create-{id}"),
                objective_id: id.into(),
                owner_tag_id: "owner".into(),
                outcome: "Release the importer".into(),
                budget_limit_minor: Some(100),
                budget_currency: Some("USD".into()),
                notification_task_id: notification_task.map(Into::into),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert_eq!(objective.notification_task_id.as_deref(), notification_task);
    let turn = claim(store, host, &objective.starting_task_id).await;
    report(store, host, &turn, 1, spent).await;
    turn
}

async fn report(
    store: &Store,
    host: &HostAuthority,
    turn: &InspectAttemptRequest,
    sequence: u64,
    amount: u64,
) {
    store
        .report_attempt_usage(
            host,
            &ReportAttemptUsageRequest {
                attempt: Some(turn.clone()),
                sequence,
                native_usage: Some(NativeTokenUsage {
                    input_tokens: 10 * sequence,
                    total_tokens: Some(10 * sequence),
                    ..Default::default()
                }),
                amount_minor: Some(amount),
                currency: Some("USD".into()),
                estimated: false,
            },
        )
        .await
        .unwrap();
    store.sweep_objectives().await.unwrap();
}

/// Claims every reply the connector would deliver now, settles each delivered, and returns
/// each one's thread and text.
async fn deliver(store: &Store) -> Vec<(Option<String>, String)> {
    let mut delivered = Vec::new();
    loop {
        let claim = store
            .claim_reply(CONNECTOR, &Uuid::new_v4().to_string())
            .await
            .unwrap();
        let Some(reply) = claim.reply else {
            return delivered;
        };
        store
            .settle_reply(
                CONNECTOR,
                &SettleReplyRequest {
                    reply_id: reply.reply_id.clone(),
                    lease_token: claim.lease_token,
                    state: ReplyState::Delivered as i32,
                    provider_receipt: Some(format!("receipt-{}", reply.reply_id)),
                },
            )
            .await
            .unwrap();
        delivered.push((
            reply
                .destination
                .and_then(|destination| destination.thread_id),
            reply.text,
        ));
    }
}

/// The notices (not turn answers) among delivered replies, with their threads.
fn notices(delivered: &[(Option<String>, String)], id: &str) -> Vec<(Option<String>, String)> {
    delivered
        .iter()
        .filter(|(_, text)| text.starts_with(&format!("Objective {id:?}:")))
        .cloned()
        .collect()
}

async fn budget_status(store: &Store, id: &str) -> Vec<(InboxNotificationStatus, String)> {
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
        .items
        .into_iter()
        .filter(|item| {
            matches!(
                item.kind(),
                InboxItemKind::ObjectiveBudget | InboxItemKind::ObjectiveLimit
            )
        })
        .map(|item| {
            let notification = item.notification.expect("a status");
            (notification.status(), notification.reason)
        })
        .collect()
}

/// Claims and settles every operator Slack notification due now, and returns whether any told
/// the operator about this Objective's budget or limits (TS `objectiveThreadCarries`).
async fn slack_heard(store: &Store, id: &str) -> bool {
    let mut heard = false;
    loop {
        let claim = store
            .claim_operator_notification(
                OPERATOR,
                &ClaimOperatorNotificationRequest {
                    destinations: vec![NotificationDestination {
                        key: "slack:C0OPERATOR".into(),
                        provider: NotificationProvider::Slack as i32,
                    }],
                },
            )
            .await
            .unwrap();
        let Some(notification) = claim.notification else {
            return heard;
        };
        heard |= notification.item_keys.iter().any(|key| {
            key.starts_with(&format!("objective_budget:{id}:"))
                || key.starts_with(&format!("objective_limit:{id}:"))
        });
        store
            .settle_operator_notification(
                OPERATOR,
                &SettleOperatorNotificationRequest {
                    notification_id: notification.notification_id,
                    lease_token: claim.lease_token,
                    delivered: true,
                    external_message_id: Some("slack-receipt".into()),
                    error: String::new(),
                },
            )
            .await
            .unwrap();
    }
}

/// A person's mention of tag `helper` in an existing thread.
async fn say(store: &Store, thread: &str, message: &str, text: &str) -> Option<Task> {
    store
        .accept_slack_event(
            CONNECTOR,
            &AcceptSlackEventRequest {
                account_id: "slack-notices".into(),
                event_id: format!("Ev{message}"),
                team_id: "TTEAM1".into(),
                channel_id: "CNOTICES".into(),
                message_ts: message.into(),
                thread_ts: thread.into(),
                prompt: text.into(),
                mention_tag_id: Some("helper".into()),
                actor_id: "UALICE1".into(),
            },
        )
        .await
        .unwrap()
        .task
}

/// The operator chose a thread: notices post there, a moved limit withdraws a queued notice,
/// and a home that no longer verifies (its Tag retired) withdraws one too.
async fn chosen_thread(store: &Store, url: &str, host: &HostAuthority, clock: &AtomicI64) {
    // Only a surface Task that verifies may be chosen.
    for task in ["missing-task", "not a name"] {
        let refused = store
            .create_objective(
                OPERATOR,
                &CreateObjectiveRequest {
                    operation_id: format!("refused-{}", task.len()),
                    objective_id: "refused".into(),
                    owner_tag_id: "owner".into(),
                    outcome: "Never created".into(),
                    notification_task_id: Some(task.into()),
                    ..Default::default()
                },
            )
            .await;
        assert!(
            matches!(refused, Err(StoreError::InvalidArgument(_))),
            "{refused:?}"
        );
    }
    // A system Task that copied a person's thread route is not a person's surface Task.
    let copied = thread_task(store, host, "1794470400.100000").await;
    sqlx::any::install_default_drivers();
    let mut connection = sqlx::AnyConnection::connect(url).await.unwrap();
    sqlx::query("UPDATE supertag_v2_inbound_events SET event_id=$1 WHERE task_id=$2")
        .bind(format!("work-session-report:{copied}"))
        .bind(&copied)
        .execute(&mut connection)
        .await
        .unwrap();
    connection.close().await.unwrap();
    let refused = store
        .create_objective(
            OPERATOR,
            &CreateObjectiveRequest {
                operation_id: "refused-system".into(),
                objective_id: "refused".into(),
                owner_tag_id: "owner".into(),
                outcome: "Never created".into(),
                notification_task_id: Some(copied),
                ..Default::default()
            },
        )
        .await;
    assert!(
        matches!(refused, Err(StoreError::InvalidArgument(_))),
        "{refused:?}"
    );
    let thread = "1794470500.100000";
    let home = thread_task(store, host, thread).await;
    let turn = objective(store, host, "chosen", Some(&home), 80).await;
    // The budget warning is queued for the chosen thread and shows as pending in the Inbox.
    assert_eq!(
        budget_status(store, "chosen").await,
        [(
            InboxNotificationStatus::Pending,
            "Waiting for Gateway delivery to the Objective's thread.".into()
        )]
    );
    let posted = notices(&deliver(store).await, "chosen");
    assert_eq!(posted.len(), 1, "{posted:?}");
    assert_eq!(posted[0].0.as_deref(), Some(thread));
    assert!(posted[0].1.contains("reached 80% of the Objective budget"));
    assert_eq!(
        budget_status(store, "chosen").await,
        [(
            InboxNotificationStatus::Delivered,
            "via the Objective's thread".into()
        )]
    );
    // The chosen thread carries the item, so the operator's Slack is not told as well.
    assert!(!slack_heard(store, "chosen").await);
    // The chosen thread directs the Objective: a pause there pauses it (TS
    // `findObjectiveByHomeSession`), and a resume resumes it.
    assert!(
        say(store, thread, "1794470501.100000", "<@UBOT1> pause")
            .await
            .is_some()
    );
    let objective = store
        .get_objective("operator:local", "chosen")
        .await
        .unwrap();
    assert!(objective.paused_at_ms.is_some(), "{objective:?}");
    assert!(
        say(store, thread, "1794470502.100000", "<@UBOT1> resume")
            .await
            .is_some()
    );
    let objective = store
        .get_objective("operator:local", "chosen")
        .await
        .unwrap();
    assert!(objective.paused_at_ms.is_none(), "{objective:?}");
    let answers = deliver(store).await;
    assert!(
        answers
            .iter()
            .any(|(at, text)| at.as_deref() == Some(thread)
                && text.starts_with("Paused. Objective chosen")),
        "{answers:?}"
    );

    // The budget is reached and its notice is queued.
    report(store, host, &turn, 2, 100).await;
    let exhausted = queued_notice(url, "chosen").await;
    // An approaching deadline is queued too; the operator then moves the deadline before the
    // Gateway delivers it, so that notice no longer applies.
    let deadline = NOW + 2 * 60 * 60 * 1000;
    let set = |deadline: i64, operation: &'static str| SetObjectiveLimitsRequest {
        objective_id: "chosen".into(),
        operation_id: operation.into(),
        deadline_ms: Some(deadline),
        ..Default::default()
    };
    store
        .set_objective_limits(OPERATOR, &set(deadline, "deadline"))
        .await
        .unwrap();
    clock.store(deadline - 60 * 60 * 1000, Ordering::SeqCst);
    store.sweep_objectives().await.unwrap();
    let approaching = queued_notice(url, "chosen").await;
    assert_ne!(approaching, exhausted);
    store
        .set_objective_limits(OPERATOR, &set(deadline + 24 * 60 * 60 * 1000, "moved"))
        .await
        .unwrap();
    // Before delivery the chosen thread's Tag is retired, so the thread no longer verifies and
    // nothing else is a home (TS `revoked=tag`). Both notices are withdrawn unsent, and the
    // Inbox reports why.
    store.retire_tag("helper", false).await.unwrap();
    assert!(notices(&deliver(store).await, "chosen").is_empty());
    assert_withdrawn(store, &approaching).await;
    assert_withdrawn(store, &exhausted).await;
    assert!(
        budget_status(store, "chosen")
            .await
            .contains(&(InboxNotificationStatus::Failed, WITHDRAWN.into())),
        "{:?}",
        budget_status(store, "chosen").await
    );
    // The thread no longer carries the item, so the operator's Slack hears about it instead.
    assert!(slack_heard(store, "chosen").await);
    // A later sweep finds no home, so nothing is queued again.
    store.sweep_objectives().await.unwrap();
    assert!(notices(&deliver(store).await, "chosen").is_empty());
}

/// The newest pending notice reply of an Objective.
async fn queued_notice(url: &str, id: &str) -> String {
    sqlx::any::install_default_drivers();
    let mut connection = sqlx::AnyConnection::connect(url).await.unwrap();
    let reply: String = sqlx::query_scalar("SELECT r.reply_id FROM supertag_v2_replies r JOIN supertag_v2_objective_notices n ON n.task_id=r.task_id WHERE n.objective_id=$1 AND r.state=$2 ORDER BY r.ready_order DESC LIMIT 1")
        .bind(id)
        .bind(ReplyState::Pending as i64)
        .fetch_one(&mut connection)
        .await
        .expect("a queued notice");
    connection.close().await.unwrap();
    reply
}

async fn assert_withdrawn(store: &Store, reply: &str) {
    let delivery = store.get_reply_delivery(OPERATOR, reply).await.unwrap();
    assert_eq!(delivery.reply.unwrap().state(), ReplyState::Failed);
    assert!(
        delivery
            .audit
            .iter()
            .any(|entry| entry.kind == "withdrawn" && entry.evidence == WITHDRAWN),
        "{:?}",
        delivery.audit
    );
}

/// An Objective with no chosen or start thread posts to the deployment default once one is
/// configured; before that, the Inbox says no destination is configured.
async fn deployment_default(store: &Store, host: &HostAuthority) {
    assert!(matches!(
        store
            .set_default_notification_task(Some("missing-task"))
            .await,
        Err(StoreError::InvalidArgument(_))
    ));
    let thread = "1794470600.100000";
    let default = thread_task(store, host, thread).await;
    let turn = objective(store, host, "plain", None, 80).await;
    assert!(notices(&deliver(store).await, "plain").is_empty());
    assert_eq!(
        budget_status(store, "plain").await,
        [(
            InboxNotificationStatus::NotConfigured,
            "The Objective has no thread and no operator notification destination is configured."
                .into()
        )]
    );
    assert_eq!(
        store
            .set_default_notification_task(Some(&default))
            .await
            .unwrap(),
        None
    );
    // Every replica shares the one row; another replica's start reports what it replaced.
    assert_eq!(
        store
            .set_default_notification_task(Some(&default))
            .await
            .unwrap(),
        Some(default.clone())
    );
    store.sweep_objectives().await.unwrap();
    let posted = notices(&deliver(store).await, "plain");
    assert_eq!(posted.len(), 1, "{posted:?}");
    assert_eq!(posted[0].0.as_deref(), Some(thread));
    assert!(posted[0].1.contains("reached 80% of the Objective budget"));
    // Its completion report follows to the same thread.
    store
        .finish_task(
            host,
            &FinishTaskRequest {
                task_id: turn.task_id.clone(),
                attempt_id: turn.attempt_id.clone(),
                lease_token: turn.lease_token.clone(),
                succeeded: true,
                result: "Released.".into(),
                objective_signal: ObjectiveSignal::Completed as i32,
                ..Default::default()
            },
        )
        .await
        .unwrap();
    let delivered = deliver(store).await;
    assert!(
        delivered
            .iter()
            .any(|(at, text)| at.as_deref() == Some(thread)
                && text == "Objective plain is completed: Released."),
        "{delivered:?}"
    );
    // Clearing the default leaves later Objectives without a thread.
    assert_eq!(
        store.set_default_notification_task(None).await.unwrap(),
        Some(default)
    );
}

/// Each part runs on its own database so no part's queued Tasks reach another's claims.
async fn contract(url: String, part: usize) {
    let clock = Arc::new(AtomicI64::new(NOW));
    let now = Arc::clone(&clock);
    let store = Store::open(&url)
        .await
        .unwrap()
        .with_execution_clock(move || now.load(Ordering::SeqCst));
    for id in ["owner", "helper"] {
        store
            .put_tag(id, "Deliver carefully", vec!["files:read".into()])
            .await
            .unwrap();
    }
    let host = support::register_host(&store, "worker").await;
    match part {
        0 => chosen_thread(&store, &url, &host, &clock).await,
        _ => deployment_default(&store, &host).await,
    }
    store.close().await;
}

const PARTS: usize = 2;

#[tokio::test]
async fn sqlite_objective_notice_homes() {
    for part in 0..PARTS {
        let dir = tempfile::tempdir().unwrap();
        contract(
            format!(
                "sqlite://{}?mode=rwc",
                dir.path().join("state.db").display()
            ),
            part,
        )
        .await;
    }
}

async fn on_postgres<F: Future<Output = ()> + 'static>(run: impl FnOnce(String) -> F) {
    let path = std::env::var_os("SUPERTAG_RUST_TEST_POSTGRES_URL_FILE")
        .expect("dedicated PostgreSQL URL file is required");
    let admin_url = std::fs::read_to_string(path).unwrap();
    let mut url = url::Url::parse(admin_url.trim()).unwrap();
    let name = format!("supertag_rust_notice_homes_{}", Uuid::new_v4().simple());
    let mut admin = sqlx::PgConnection::connect(admin_url.trim()).await.unwrap();
    admin
        .execute(format!("CREATE DATABASE {name}").as_str())
        .await
        .unwrap();
    url.set_path(&name);
    let outcome = tokio::task::LocalSet::new()
        .run_until(async move { tokio::task::spawn_local(run(url.to_string())).await })
        .await;
    admin
        .execute(format!("DROP DATABASE {name} WITH (FORCE)").as_str())
        .await
        .unwrap();
    admin.close().await.unwrap();
    outcome.expect("PostgreSQL Objective notice homes contract failed");
}

#[tokio::test]
#[ignore = "requires SUPERTAG_RUST_TEST_POSTGRES_URL_FILE for a dedicated PostgreSQL test server"]
async fn postgres_objective_notice_homes() {
    for part in 0..PARTS {
        on_postgres(move |url| contract(url, part)).await;
    }
}
