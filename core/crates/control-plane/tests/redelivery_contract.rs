//! Redelivery after a lost Worker (session-input-queue design, stage 1): when the Attempt's own
//! Worker Host reclaims an interrupted Attempt, the Control Plane runs its Task again as a new
//! Attempt, keeping the Task ID, after a short backoff, unless the lost Attempt did something
//! repeating could do twice, or the Task already had three Attempts. A Task that is not run
//! again fails, says why, and raises one operator Inbox item.
mod support;

use std::sync::{
    Arc,
    atomic::{AtomicI64, Ordering},
};

use sqlx::{AnyPool, Connection, Executor};
use supertag_control_plane::{AttemptAccess, HostAuthority, Store};
use supertag_protocol::v2::{
    AppendEventRequest, Assignment, AttemptDecision, BeginEffectRequest, HarnessBeginEffectRequest,
    HarnessExecutionProfile, HarnessKind, InboxItem, InboxItemKind, InspectAttemptRequest,
    ListInboxItemsRequest, ReclaimAttemptRequest, StartTaskRequest, SubmitTaskRequest,
    TaskEventKind, TaskState,
};
use uuid::Uuid;

const BASE: i64 = 1_790_000_000_000;
const OPERATOR: &str = "operator:alice";
const EVIDENCE: &str = "every recorded process group is gone: 4242";

struct Fixture {
    store: Store,
    host: HostAuthority,
    clock: Arc<AtomicI64>,
    pool: AnyPool,
}

impl Fixture {
    fn at(&self, ms: i64) {
        self.clock.store(BASE + ms, Ordering::SeqCst);
    }

    async fn submit(&self, tag: &str, session: &str, operation: &str) -> String {
        self.store
            .submit_task(
                OPERATOR,
                &SubmitTaskRequest {
                    output_policy: None,
                    execution_limits: None,
                    tag_id: tag.into(),
                    session_id: session.into(),
                    operation_id: operation.into(),
                    prompt: format!("Do {operation}"),
                    input_artifacts: vec![],
                },
            )
            .await
            .unwrap()
            .task_id
    }

    async fn claim(&self, operation: &str, harness: HarnessKind) -> Option<Assignment> {
        let profile = HarnessExecutionProfile::default();
        self.store
            .claim_task_with_profile(&self.host, operation, &[], harness, &[], Some(&profile))
            .await
            .unwrap()
    }

    async fn start(&self, assignment: &Assignment) -> InspectAttemptRequest {
        let attempt = InspectAttemptRequest {
            task_id: assignment.task.as_ref().unwrap().task_id.clone(),
            attempt_id: assignment.attempt_id.clone(),
            lease_token: assignment.lease_token.clone(),
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

    /// Submits a Task, claims it on a `harness` lane, and starts its harness.
    async fn running(
        &self,
        tag: &str,
        session: &str,
        harness: HarnessKind,
    ) -> InspectAttemptRequest {
        let task_id = self.submit(tag, session, session).await;
        let claimed = self
            .claim(&format!("claim-{session}"), harness)
            .await
            .unwrap();
        assert_eq!(claimed.task.as_ref().unwrap().task_id, task_id);
        self.start(&claimed).await
    }

    async fn reclaim(&self, attempt: &InspectAttemptRequest) -> AttemptDecision {
        self.store
            .reclaim_attempt(
                &self.host,
                &ReclaimAttemptRequest {
                    attempt: Some(attempt.clone()),
                    evidence: EVIDENCE.into(),
                },
            )
            .await
            .unwrap()
            .decision()
    }

    async fn say(
        &self,
        attempt: &InspectAttemptRequest,
        sequence: u64,
        text: &str,
        kind: TaskEventKind,
    ) {
        self.store
            .append_event(
                &AttemptAccess::new(&self.host, attempt),
                &AppendEventRequest {
                    sequence,
                    text: text.into(),
                    kind: kind as i32,
                },
            )
            .await
            .unwrap();
    }

    async fn interrupted_items(&self) -> Vec<InboxItem> {
        self.store
            .list_inbox_items(
                OPERATOR,
                &ListInboxItemsRequest {
                    objective_id: String::new(),
                    kind: InboxItemKind::TaskAttention as i32,
                    page_size: 100,
                    cursor: String::new(),
                },
            )
            .await
            .unwrap()
            .items
            .into_iter()
            .filter(|item| item.key.starts_with("task_interrupted:"))
            .collect()
    }

    /// Reclaims `attempt` and asserts its Task failed for `reason`, with one Inbox item naming
    /// the Task, its Tag, and the reason.
    async fn refused(&self, attempt: &InspectAttemptRequest, tag: &str, reason: &str) {
        assert_eq!(self.reclaim(attempt).await, AttemptDecision::Failed);
        let task = self.store.get_task(&attempt.task_id).await.unwrap();
        assert_eq!(task.state(), TaskState::Failed, "{task:?}");
        let result = task.result.unwrap();
        assert!(
            result.contains("The outcome is unknown")
                && result.contains(&format!("did not run the Task again because {reason}")),
            "{result}"
        );
        let items: Vec<_> = self
            .interrupted_items()
            .await
            .into_iter()
            .filter(|item| item.task_id == attempt.task_id)
            .collect();
        assert_eq!(items.len(), 1, "{items:?}");
        let item = &items[0];
        assert_eq!(item.kind(), InboxItemKind::TaskAttention);
        assert_eq!(
            item.attempt_id.as_deref(),
            Some(attempt.attempt_id.as_str())
        );
        assert!(
            item.reason.contains(&format!("Task {}", attempt.task_id))
                && item.reason.contains(&format!("of Tag {tag}"))
                && item.reason.contains(reason),
            "{}",
            item.reason
        );
    }

    /// Records what the Worker did through a path this contract does not drive itself.
    async fn insert(&self, sql: &str, values: &[&str]) {
        let mut query = sqlx::query(sql);
        for value in values {
            query = query.bind(value.to_string());
        }
        query.execute(&self.pool).await.unwrap();
    }
}

async fn contract(url: &str) {
    let clock = Arc::new(AtomicI64::new(BASE));
    let observed = clock.clone();
    let store = Store::open(url)
        .await
        .unwrap()
        .with_execution_clock(move || observed.load(Ordering::SeqCst));
    sqlx::any::install_default_drivers();
    let pool = AnyPool::connect(url).await.unwrap();
    let host = support::register_host(&store, "laptop").await;
    store.put_tag("worker", "Answer", vec![]).await.unwrap();
    store
        .put_tag("runner", "Run commands", vec!["commands:execute".into()])
        .await
        .unwrap();
    store
        .put_tag(
            "fetcher",
            "Run commands online",
            vec!["commands:execute".into(), "web:fetch".into()],
        )
        .await
        .unwrap();
    let f = Fixture {
        store,
        host,
        clock,
        pool,
    };

    // Allowed: the Task keeps its ID and gets a new Attempt once its backoff ends, told what
    // the lost run already said. A later Task of the Session waits behind it.
    let first = f
        .running("worker", "allowed", HarnessKind::Unspecified)
        .await;
    f.say(&first, 1, "Looking into it.", TaskEventKind::Message)
        .await;
    f.say(&first, 2, "Reading the logs", TaskEventKind::Activity)
        .await;
    assert_eq!(f.reclaim(&first).await, AttemptDecision::Retry);
    let task = f.store.get_task(&first.task_id).await.unwrap();
    assert_eq!(task.state(), TaskState::Queued, "{task:?}");
    assert!(task.result.is_none() && task.attempt_id.is_none());
    let later = f.submit("worker", "allowed", "later").await;
    assert!(f.interrupted_items().await.is_empty());
    f.at(4_999);
    assert!(
        f.claim("during-backoff", HarnessKind::Unspecified)
            .await
            .is_none(),
        "neither the redelivered Task nor the later one is claimable before 5 s"
    );
    f.at(5_000);
    let second = f
        .claim("redelivered", HarnessKind::Unspecified)
        .await
        .unwrap();
    assert_eq!(second.task.as_ref().unwrap().task_id, first.task_id);
    assert_ne!(second.attempt_id, first.attempt_id);
    let redelivery = second.redelivery.clone().unwrap();
    assert_eq!(redelivery.interrupted_attempts, 1);
    assert_eq!(redelivery.already_said, ["Looking into it."]);
    // A replayed claim presents the same note.
    assert_eq!(
        f.claim("redelivered", HarnessKind::Unspecified)
            .await
            .unwrap()
            .redelivery,
        Some(redelivery)
    );
    let second = f.start(&second).await;
    f.say(&second, 1, "Still on it.", TaskEventKind::Message)
        .await;

    // The second redelivery waits 30 s.
    assert_eq!(f.reclaim(&second).await, AttemptDecision::Retry);
    f.at(5_000 + 29_999);
    assert!(
        f.claim("second-backoff", HarnessKind::Unspecified)
            .await
            .is_none()
    );
    f.at(5_000 + 30_000);
    let third = f
        .claim("redelivered-again", HarnessKind::Unspecified)
        .await
        .unwrap();
    assert_eq!(third.task.as_ref().unwrap().task_id, first.task_id);
    assert!(third.attempt_id != first.attempt_id && third.attempt_id != second.attempt_id);
    let redelivery = third.redelivery.clone().unwrap();
    assert_eq!(redelivery.interrupted_attempts, 2);
    assert_eq!(
        redelivery.already_said,
        ["Looking into it.", "Still on it."]
    );

    // The cap: a third interrupted Attempt fails the Task, with one Inbox item.
    let third = f.start(&third).await;
    f.refused(&third, "worker", "it had already run 3 Task Attempts")
        .await;
    // The later Task of the Session runs now, and is no redelivery.
    let next = f.claim("later", HarnessKind::Unspecified).await.unwrap();
    assert_eq!(next.task.as_ref().unwrap().task_id, later);
    assert!(next.redelivery.is_none());
    f.reclaim(&f.start(&next).await).await;

    // An in-doubt effect receipt: the provider may have committed the write.
    let doubt = f.running("worker", "doubt", HarnessKind::Unspecified).await;
    f.store
        .begin_effect(
            &AttemptAccess::new(&f.host, &doubt),
            &BeginEffectRequest {
                effect: Some(HarnessBeginEffectRequest {
                    idempotency_key: "ticket/1".into(),
                    operation: "create_ticket".into(),
                    arguments_json: "{}".into(),
                }),
            },
        )
        .await
        .unwrap();
    f.refused(
        &doubt,
        "worker",
        "an external write it started never reported its outcome",
    )
    .await;

    // A delivery of the Session's changes that started.
    let delivery = f
        .running("worker", "delivery", HarnessKind::Unspecified)
        .await;
    f.insert(
        "INSERT INTO supertag_v2_workspace_deliveries (attempt_id, task_id, reference) VALUES ($1, $2, 'reference')",
        &[&delivery.attempt_id, &delivery.task_id],
    )
    .await;
    f.refused(
        &delivery,
        "worker",
        "it started delivering the Session's changes",
    )
    .await;

    // A published artifact.
    let artifact = f
        .running("worker", "artifact", HarnessKind::Unspecified)
        .await;
    f.insert(
        "INSERT INTO supertag_v2_artifact_captures (artifact_id, attempt_id, task_id, operation_id, request_digest, payload) VALUES ('artifact-1', $1, $2, 'capture', 'digest', 'payload')",
        &[&artifact.attempt_id, &artifact.task_id],
    )
    .await;
    f.refused(&artifact, "worker", "it published an artifact")
        .await;

    // An action that needed approval ran: its approval was granted to this Attempt.
    let approved = f
        .running("worker", "approved", HarnessKind::Unspecified)
        .await;
    f.insert(
        "INSERT INTO supertag_v2_approvals (approval_id, attempt_id, task_id, tag_id, session_id, action, resource, canonical_arguments_json, arguments_digest, rule_digest, summary, operator_ids, state, requested_at_ms, requested_order) VALUES ('approval-1', $1, $2, 'worker', 'approved', 'workstream:post', 'engineering', '{}', 'digest', 'rule', 'Post', '[]', 2, 0, 900000000)",
        &[&approved.attempt_id, &approved.task_id],
    )
    .await;
    f.insert(
        "INSERT INTO supertag_v2_approval_operations (attempt_id, operation_id, request_digest, approval_id, granted) VALUES ($1, 'post', 'digest', 'approval-1', 1)",
        &[&approved.attempt_id],
    )
    .await;
    f.refused(&approved, "worker", "it ran an action that needed approval")
        .await;

    // Commands on a lane that runs them unsandboxed may have reached the network.
    let unsafe_commands = f
        .running("runner", "commands", HarnessKind::Unspecified)
        .await;
    f.refused(
        &unsafe_commands,
        "runner",
        "it could run commands with network access outside a sandbox",
    )
    .await;
    // Codex runs them in its own sandbox, without network unless the Task has web:fetch.
    let sandboxed = f.running("runner", "sandboxed", HarnessKind::Codex).await;
    assert_eq!(f.reclaim(&sandboxed).await, AttemptDecision::Retry);
    let online = f.running("fetcher", "online", HarnessKind::Codex).await;
    f.refused(
        &online,
        "fetcher",
        "it could run commands with network access outside a sandbox",
    )
    .await;

    // Each refusal raised exactly one item.
    assert_eq!(f.interrupted_items().await.len(), 7);
    // The Inbox shows them for a week.
    f.at(5_000 + 30_000 + 7 * 24 * 60 * 60 * 1000);
    assert!(f.interrupted_items().await.is_empty());
    f.pool.close().await;
    f.store.close().await;
}

#[tokio::test]
async fn sqlite_redelivery_contract() {
    let directory = tempfile::tempdir().unwrap();
    let url = format!(
        "sqlite://{}?mode=rwc",
        directory.path().join("redelivery.db").display()
    );
    contract(&url).await;
}

#[tokio::test]
#[ignore = "requires SUPERTAG_RUST_TEST_POSTGRES_URL_FILE for a dedicated PostgreSQL test server"]
async fn postgres_redelivery_contract() {
    let path = std::env::var_os("SUPERTAG_RUST_TEST_POSTGRES_URL_FILE")
        .expect("PostgreSQL test URL file required");
    let admin_url = std::fs::read_to_string(path).unwrap();
    let name = format!("supertag_rust_redelivery_{}", Uuid::new_v4().simple());
    let mut admin = sqlx::PgConnection::connect(admin_url.trim()).await.unwrap();
    admin
        .execute(format!("CREATE DATABASE {name}").as_str())
        .await
        .unwrap();
    let mut url = url::Url::parse(admin_url.trim()).unwrap();
    url.set_path(&name);
    let local = tokio::task::LocalSet::new();
    let outcome = local
        .run_until(async move {
            tokio::task::spawn_local(async move { contract(url.as_str()).await }).await
        })
        .await;
    admin
        .execute(format!("DROP DATABASE {name} WITH (FORCE)").as_str())
        .await
        .unwrap();
    admin.close().await.unwrap();
    outcome.expect("PostgreSQL redelivery contract failed");
}
