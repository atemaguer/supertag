//! The durable operator notification outbox on both databases.
//! TypeScript parity: `tests/operator-channel.test.ts` ("operator channel outbox").
mod support;

use sqlx::{Connection, Executor};
use std::sync::{
    Arc,
    atomic::{AtomicI64, Ordering},
};
use supertag_control_plane::{
    HostAuthority, Store, StoreError,
    operator_notifications::{LEASE_MS, RETRY_BASE_MS, WINDOW_MS},
};
use supertag_protocol::v2::*;
use uuid::Uuid;

const OPERATOR: &str = "operator:local";
const NOW: i64 = 1_900_000_000_000;
const SLACK: &str = "slack:C0OPERATOR";
const WEBHOOK: &str = "webhook:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

fn slack() -> NotificationDestination {
    NotificationDestination {
        key: SLACK.into(),
        provider: NotificationProvider::Slack as i32,
    }
}
fn desktop() -> NotificationDestination {
    NotificationDestination {
        key: "desktop".into(),
        provider: NotificationProvider::Desktop as i32,
    }
}
fn webhook() -> NotificationDestination {
    NotificationDestination {
        key: WEBHOOK.into(),
        provider: NotificationProvider::Webhook as i32,
    }
}

struct Fixture {
    store: Store,
    clock: Arc<AtomicI64>,
    host: HostAuthority,
}

impl Fixture {
    fn advance(&self, ms: i64) {
        self.clock.fetch_add(ms, Ordering::SeqCst);
    }

    async fn claim(
        &self,
        destinations: &[NotificationDestination],
    ) -> Option<(OperatorNotification, String)> {
        let response = self
            .store
            .claim_operator_notification(
                OPERATOR,
                &ClaimOperatorNotificationRequest {
                    destinations: destinations.to_vec(),
                },
            )
            .await
            .unwrap();
        response.notification.map(|n| (n, response.lease_token))
    }

    async fn settle(
        &self,
        notification: &OperatorNotification,
        lease: &str,
        outcome: Result<&str, &str>,
    ) -> Result<OperatorNotification, StoreError> {
        self.store
            .settle_operator_notification(
                OPERATOR,
                &SettleOperatorNotificationRequest {
                    notification_id: notification.notification_id.clone(),
                    lease_token: lease.into(),
                    delivered: outcome.is_ok(),
                    external_message_id: outcome.ok().map(Into::into),
                    error: outcome.err().unwrap_or_default().into(),
                },
            )
            .await
    }

    async fn latest(&self, destination: &str, objective: &str) -> OperatorNotification {
        self.store
            .latest_operator_notification(destination, objective)
            .await
            .unwrap()
            .expect("a recorded notification")
    }

    async fn objective(&self, id: &str) -> Objective {
        self.store
            .create_objective(
                OPERATOR,
                &CreateObjectiveRequest {
                    operation_id: format!("create-{id}"),
                    objective_id: id.into(),
                    owner_tag_id: "owner".into(),
                    outcome: "Ship the fix".into(),
                    team_id: Some("engineering".into()),
                    ..Default::default()
                },
            )
            .await
            .unwrap()
    }

    async fn running(&self, task_id: &str) -> InspectAttemptRequest {
        // Clock jumps outlive the host's presence; register it again before each claim.
        self.store
            .register_host("notify-host", "test-incarnation")
            .await
            .unwrap();
        let assignment = self
            .store
            .claim_task(&self.host, &Uuid::new_v4().to_string())
            .await
            .unwrap()
            .expect("a queued Task");
        assert_eq!(assignment.task.unwrap().task_id, task_id);
        let attempt = InspectAttemptRequest {
            task_id: task_id.into(),
            attempt_id: assignment.attempt_id,
            lease_token: assignment.lease_token,
        };
        self.store
            .start_task(
                &self.host,
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

    /// The running Attempt's lease lapses: the Task needs attention.
    async fn expire(&self) {
        self.advance(30_000);
        self.store.sweep_expired_attempts().await.unwrap();
    }

    async fn retry(&self, attempt: &InspectAttemptRequest) {
        self.store
            .resolve_attempt(
                OPERATOR,
                &ResolveAttemptRequest {
                    task_id: attempt.task_id.clone(),
                    attempt_id: attempt.attempt_id.clone(),
                    operation_id: format!("retry-{}", attempt.attempt_id),
                    decision: AttemptDecision::Retry as i32,
                    evidence: "Confirmed the host stopped".into(),
                    confirmed_stopped: true,
                },
            )
            .await
            .unwrap();
    }

    async fn ask(&self, id: &str) {
        let objective = self.objective(id).await;
        let attempt = self.running(&objective.starting_task_id).await;
        self.store
            .ask_question(
                &self.host,
                &AskQuestionRequest {
                    attempt: Some(attempt.clone()),
                    operation_id: "ask".into(),
                    text: "Which release? https://private.example/token".into(),
                },
            )
            .await
            .unwrap();
        self.store
            .finish_task(
                &self.host,
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

    async fn approval(&self, attempt: &InspectAttemptRequest, operation: &str) -> Approval {
        self.store
            .post_attempt_workstream(
                &self.host,
                &PostAttemptWorkstreamRequest {
                    attempt: Some(attempt.clone()),
                    operation_id: operation.into(),
                    body: format!("Update {operation}"),
                    to_tag_ids: vec![],
                },
            )
            .await
            .unwrap()
            .approval
            .expect("a pending approval")
    }
}

async fn contract(url: &str) {
    let clock = Arc::new(AtomicI64::new(NOW));
    let now = clock.clone();
    let store = Store::open(url)
        .await
        .unwrap()
        .with_execution_clock(move || now.load(Ordering::SeqCst));
    store
        .put_tag_spec(PutTagRequest {
            tag_id: "owner".into(),
            instructions: "Coordinate the work".into(),
            allowed_actions: vec!["files:read".into(), "workstream:post".into()],
            approval_rules: vec![ApprovalRule {
                action: "workstream:post".into(),
                operator_ids: vec!["local".into()],
            }],
            ..Default::default()
        })
        .await
        .unwrap();
    store
        .create_team(
            OPERATOR,
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
    let host = support::register_host(&store, "notify-host").await;
    let f = Fixture { store, clock, host };

    // Nothing is configured: nothing is recorded or sent.
    let first = f.objective("first").await;
    let attempt = f.running(&first.starting_task_id).await;
    f.expire().await;
    assert!(f.claim(&[]).await.is_none());
    assert!(matches!(
        f.store
            .claim_operator_notification(
                OPERATOR,
                &ClaimOperatorNotificationRequest {
                    destinations: vec![NotificationDestination {
                        key: "webhook:https://hooks.example/x".into(),
                        provider: NotificationProvider::Webhook as i32,
                    }],
                },
            )
            .await,
        Err(StoreError::InvalidArgument(_))
    ));
    assert!(matches!(
        f.store
            .claim_operator_notification(
                "connector:slack",
                &ClaimOperatorNotificationRequest {
                    destinations: vec![slack()],
                },
            )
            .await,
        Err(StoreError::PermissionDenied)
    ));

    // One message per Objective per window, then a summary of what waited.
    let (message, lease) = f.claim(&[slack()]).await.expect("first message");
    assert_eq!(
        message.text,
        format!(
            "Objective first needs you: Task {task} is uncertain: Attempt {attempt} may have executed, and only an operator on its Worker Host can recover it\n`supertag describe objective first`",
            task = first.starting_task_id,
            attempt = attempt.attempt_id
        )
    );
    assert_eq!(message.kinds, ["task_attention"]);
    assert_eq!(message.command, "supertag describe objective first");
    assert_eq!(message.attempt_count, 1);
    assert_eq!(message.max_attempts, 5);
    assert_eq!(message.status(), OperatorNotificationStatus::Delivering);
    let delivered = f
        .settle(&message, &lease, Ok("1794470009.000001"))
        .await
        .unwrap();
    assert_eq!(delivered.status(), OperatorNotificationStatus::Delivered);
    assert_eq!(
        delivered.external_message_id.as_deref(),
        Some("1794470009.000001")
    );
    // A settled lease cannot be settled again, and nothing repeats.
    assert!(matches!(
        f.settle(&message, &lease, Err("late")).await,
        Err(StoreError::FailedPrecondition(_))
    ));
    assert!(f.claim(&[slack()]).await.is_none());

    // A second occurrence inside the window waits.
    f.retry(&attempt).await;
    let second = f.running(&first.starting_task_id).await;
    f.expire().await;
    assert!(f.claim(&[slack()]).await.is_none());
    f.advance(WINDOW_MS - 30_000 + 1_000);
    let (summary, lease) = f.claim(&[slack()]).await.expect("summary");
    assert_eq!(
        summary.text,
        format!(
            "Objective first has 1 more item that needs you:\n- Task {task} is uncertain: Attempt {attempt} may have executed, and only an operator on its Worker Host can recover it: `supertag resolve-attempt {task} {attempt} --decision retry --evidence TEXT --confirmed-stopped`\n`supertag inbox list --objective first`",
            task = first.starting_task_id,
            attempt = second.attempt_id
        )
    );
    assert_eq!(summary.command, "supertag inbox list --objective first");

    // A failed delivery is retried after backoff, with URLs removed from its error.
    let failed = f
        .settle(
            &summary,
            &lease,
            Err("failed at https://hooks.example/x?token=private"),
        )
        .await
        .unwrap();
    assert_eq!(failed.status(), OperatorNotificationStatus::Pending);
    assert_eq!(
        failed.last_error.as_deref(),
        Some("failed at <redacted URL>")
    );
    assert!(f.claim(&[slack()]).await.is_none());
    f.advance(RETRY_BASE_MS);
    let (retried, lease) = f.claim(&[slack()]).await.expect("retry");
    assert_eq!(retried.notification_id, summary.notification_id);
    assert_eq!(retried.attempt_count, 2);
    f.settle(&retried, &lease, Ok("1794470009.000002"))
        .await
        .unwrap();
    let latest = f.latest(SLACK, "first").await;
    assert_eq!(latest.status(), OperatorNotificationStatus::Delivered);
    assert_eq!(latest.attempt_count, 2);
    assert!(latest.last_error.is_none());

    // Desktop coalesces Objectives; each destination keeps its own ledger. An item resolved
    // before delivery is dropped without sending.
    f.ask("question").await;
    let (desktop_message, desktop_lease) = f
        .claim(&[desktop(), webhook()])
        .await
        .expect("desktop or webhook message");
    let desktop_first = desktop_message.destination_key == "desktop";
    if desktop_first {
        assert_eq!(desktop_message.objective_id, "*");
        assert_eq!(
            desktop_message.text,
            "SuperTag has 2 new items across 2 Objectives.\n`supertag inbox list`"
        );
        assert_eq!(desktop_message.max_attempts, 3);
    }
    let mut webhook_messages = 0;
    // Drain every message except the leased one.
    loop {
        let Some((next, lease)) = f.claim(&[desktop(), webhook()]).await else {
            break;
        };
        assert!(!next.text.contains("private.example"));
        if next.destination_key == WEBHOOK {
            webhook_messages += 1;
        }
        f.settle(&next, &lease, Ok("receipt")).await.unwrap();
    }
    assert_eq!(webhook_messages + usize::from(!desktop_first), 2);
    f.settle(&desktop_message, &desktop_lease, Ok("receipt"))
        .await
        .unwrap();
    f.store
        .cancel_objective(
            OPERATOR,
            &ObjectiveActionRequest {
                objective_id: "question".into(),
                operation_id: "cancel-question".into(),
                reason: "Superseded".into(),
            },
        )
        .await
        .unwrap();

    // A blocking approval goes out at once, even inside the window.
    let approvals = f.objective("approvals").await;
    let running = f.running(&approvals.starting_task_id).await;
    let request = f.approval(&running, "first-post").await;
    let (first_approval, lease) = f.claim(&[slack()]).await.expect("approval");
    assert_eq!(
        first_approval.text,
        format!(
            "Objective approvals needs you: Approval {} (work is waiting): {} (requested by Tag owner)\n`supertag describe objective approvals`",
            request.approval_id, request.summary
        )
    );
    f.settle(&first_approval, &lease, Ok("approval-1"))
        .await
        .unwrap();
    let again = f.approval(&running, "second-post").await;
    let (immediate, lease) = f.claim(&[slack()]).await.expect("immediate approval");
    assert!(immediate.text.contains(&again.approval_id));
    assert!(immediate.text.contains("(work is waiting)"));

    // An unsettled claim is claimed again only after its lease lapses.
    assert!(f.claim(&[slack()]).await.is_none());
    f.store
        .decide_approval(
            OPERATOR,
            &DecideApprovalRequest {
                approval_id: again.approval_id.clone(),
                operation_id: "deny".into(),
                approve: false,
                scope: ApprovalScope::Unspecified as i32,
                valid_until_ms: None,
                reason: "Not now".into(),
            },
        )
        .await
        .unwrap();
    f.advance(LEASE_MS);
    // The re-claimed message's only item was resolved meanwhile: it is settled unsent.
    assert!(f.claim(&[slack()]).await.is_none());
    assert!(matches!(
        f.settle(&immediate, &lease, Ok("late")).await,
        Err(StoreError::FailedPrecondition(_))
    ));
    let dropped = f.latest(SLACK, "approvals").await;
    assert_eq!(dropped.notification_id, immediate.notification_id);
    assert_eq!(dropped.status(), OperatorNotificationStatus::Delivered);
    assert!(dropped.external_message_id.is_none());

    // An unavailable desktop notifier is tried three times, then the message fails for good.
    let last = f.objective("desktop-only").await;
    f.running(&last.starting_task_id).await;
    f.expire().await;
    f.advance(WINDOW_MS);
    for attempt in 1..=3 {
        let (message, lease) = loop {
            if let Some(claimed) = f.claim(&[desktop()]).await {
                break claimed;
            }
            f.advance(1_000);
        };
        assert_eq!(message.attempt_count, attempt);
        f.settle(&message, &lease, Err("Desktop notification unavailable"))
            .await
            .unwrap();
    }
    f.advance(15 * 60_000);
    assert!(f.claim(&[desktop()]).await.is_none());
    let failed = f.latest("desktop", "*").await;
    assert_eq!(failed.status(), OperatorNotificationStatus::Failed);
    assert_eq!(failed.attempt_count, 3);
    assert_eq!(
        failed.last_error.as_deref(),
        Some("Desktop notification unavailable")
    );

    // Two Gateways claiming at once record each occurrence once.
    let other = NotificationDestination {
        key: "slack:T0TEAM/U0OPERATOR".into(),
        provider: NotificationProvider::Slack as i32,
    };
    let pair = [other.clone()];
    let (a, b) = tokio::join!(f.claim(&pair), f.claim(&pair));
    let claimed: Vec<_> = [a, b].into_iter().flatten().collect();
    let mut connection = sqlx::AnyConnection::connect(url).await.unwrap();
    let (rows,): (i64,) = sqlx::query_as(
        "SELECT COUNT(*) FROM supertag_v2_operator_notification_items WHERE destination_key=$1",
    )
    .bind(&other.key)
    .fetch_one(&mut connection)
    .await
    .unwrap();
    let (messages,): (i64,) = sqlx::query_as(
        "SELECT COUNT(*) FROM supertag_v2_operator_notifications WHERE destination_key=$1",
    )
    .bind(&other.key)
    .fetch_one(&mut connection)
    .await
    .unwrap();
    assert_eq!(rows, messages, "one item per message here");
    assert!(messages >= 1);
    assert!(claimed.len() as i64 <= messages);
    let unique: std::collections::BTreeSet<_> = claimed
        .iter()
        .map(|(n, _)| n.notification_id.clone())
        .collect();
    assert_eq!(unique.len(), claimed.len(), "a message was leased twice");
    connection.close().await.unwrap();
}

#[tokio::test]
async fn sqlite_operator_notifications() {
    let dir = tempfile::tempdir().unwrap();
    contract(&format!(
        "sqlite://{}?mode=rwc",
        dir.path().join("notifications.db").display()
    ))
    .await;
}

#[tokio::test]
#[ignore = "requires SUPERTAG_RUST_TEST_POSTGRES_URL_FILE for a dedicated PostgreSQL test server"]
async fn postgres_operator_notifications() {
    let path = std::env::var_os("SUPERTAG_RUST_TEST_POSTGRES_URL_FILE").unwrap();
    let admin_url = std::fs::read_to_string(path).unwrap();
    let mut url = url::Url::parse(admin_url.trim()).unwrap();
    let name = format!("supertag_rust_notify_{}", Uuid::new_v4().simple());
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
