//! An uncertain Task Attempt of any Task blocks its Session's later turns, so the operator Inbox
//! shows it, a conversation turn included, with what it blocks and what its host confirmed. Its
//! owner may decide about it once the host confirmed execution stopped, and SuperTag records it
//! as failed on its own when the host confirmed it stopped and it recorded no effect. On SQLite
//! and PostgreSQL.
mod support;

use std::sync::{
    Arc,
    atomic::{AtomicI64, Ordering},
};

use sha2::{Digest, Sha256};
use sqlx::{AnyPool, Connection, Executor, Row};
use supertag_control_plane::{AttemptAccess, HostAuthority, Store, StoreError};
use supertag_protocol::v2::*;
use uuid::Uuid;

const BASE: i64 = 1_790_000_000_000;
const OPERATOR: &str = "operator:alice";
const ADA: &str = "client:ada";
const MALLORY: &str = "client:mallory";
/// The lease of an Attempt that never renews it.
const LEASE: i64 = 30_000;
const GRACE: i64 = 60_000;

struct Fixture {
    store: Store,
    host: HostAuthority,
    clock: Arc<AtomicI64>,
    pool: AnyPool,
}

/// Enrolls `client:NAME` with a client Auth Key limited to `tags`.
async fn enroll_client(store: &Store, name: &str, tags: &[&str]) {
    let key = Sha256::digest(format!("client key {name}")).to_vec();
    store
        .create_auth_key(
            OPERATOR,
            &CreateAuthKeyRequest {
                name: format!("{name}-key"),
                role: PrincipalRole::Client.into(),
                operation_id: format!("{name}-key"),
                key_digest: key.clone(),
                allowed_tag_ids: tags.iter().map(|tag| (*tag).into()).collect(),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    store
        .enroll(
            &key,
            &EnrollRequest {
                role: PrincipalRole::Client.into(),
                name: name.into(),
                operation_id: format!("{name}-enroll"),
                token_digest: Sha256::digest(format!("client credential {name}")).to_vec(),
            },
        )
        .await
        .unwrap();
}

impl Fixture {
    fn at(&self, ms: i64) {
        self.clock.store(BASE + ms, Ordering::SeqCst);
    }

    /// `principal` writes `text` to `tag`; returns the turn's Task.
    async fn say_to(&self, principal: &str, tag: &str, text: &str) -> Task {
        self.store
            .send_message(
                principal,
                &SendMessageRequest {
                    tag_id: tag.into(),
                    text: text.into(),
                    operation_id: Uuid::new_v4().to_string(),
                    ..Default::default()
                },
            )
            .await
            .unwrap()
            .task
            .unwrap()
    }

    async fn claim(&self) -> Option<Assignment> {
        self.store
            .claim_task(&self.host, &Uuid::new_v4().to_string())
            .await
            .unwrap()
    }

    /// Claims `task_id` and starts its harness.
    async fn running(&self, task_id: &str) -> InspectAttemptRequest {
        let claimed = self.claim().await.expect("a claimable Task");
        assert_eq!(claimed.task.as_ref().unwrap().task_id, task_id);
        let attempt = InspectAttemptRequest {
            task_id: task_id.into(),
            attempt_id: claimed.attempt_id,
            lease_token: claimed.lease_token,
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

    /// The host's Finish, after the lease lapsed: its receipt that execution stopped.
    async fn finish_late(&self, attempt: &InspectAttemptRequest) {
        let task = self
            .store
            .finish_task(
                &self.host,
                &FinishTaskRequest {
                    task_id: attempt.task_id.clone(),
                    attempt_id: attempt.attempt_id.clone(),
                    lease_token: attempt.lease_token.clone(),
                    succeeded: true,
                    result: "Done.".into(),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        assert_eq!(task.state(), TaskState::Uncertain, "{task:?}");
    }

    async fn items(&self, principal: &str) -> Vec<InboxItem> {
        self.store
            .list_inbox_items(
                principal,
                &ListInboxItemsRequest {
                    kind: InboxItemKind::TaskAttention as i32,
                    page_size: 100,
                    ..Default::default()
                },
            )
            .await
            .unwrap()
            .items
            .into_iter()
            .filter(|item| item.key.starts_with("task_attention:"))
            .collect()
    }

    async fn item(&self, principal: &str, task_id: &str) -> InboxItem {
        let items: Vec<_> = self
            .items(principal)
            .await
            .into_iter()
            .filter(|item| item.task_id == task_id)
            .collect();
        assert_eq!(items.len(), 1, "{items:?}");
        items.into_iter().next().unwrap()
    }

    async fn resolve(
        &self,
        principal: &str,
        attempt: &InspectAttemptRequest,
        decision: AttemptDecision,
        confirmed_stopped: bool,
    ) -> Result<AttemptResolution, StoreError> {
        self.store
            .resolve_attempt(
                principal,
                &ResolveAttemptRequest {
                    task_id: attempt.task_id.clone(),
                    attempt_id: attempt.attempt_id.clone(),
                    operation_id: Uuid::new_v4().to_string(),
                    decision: decision as i32,
                    evidence:
                        "Resolved from the desktop app: cleanup confirmed per execution report"
                            .into(),
                    confirmed_stopped,
                },
            )
            .await
    }

    async fn state(&self, task_id: &str) -> TaskState {
        self.store.get_task(task_id).await.unwrap().state()
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
    for tag in ["worker", "helper", "runner"] {
        store.put_tag(tag, "Answer", vec![]).await.unwrap();
    }
    enroll_client(&store, "ada", &["worker", "helper"]).await;
    enroll_client(&store, "mallory", &["worker", "helper"]).await;
    let f = Fixture {
        store,
        host,
        clock,
        pool,
    };

    // A conversation turn whose lease lapsed is uncertain; the person's next message waits.
    let first = f.say_to(ADA, "worker", "Check CI").await;
    let attempt = f.running(&first.task_id).await;
    f.at(LEASE);
    assert_eq!(f.store.sweep_expired_attempts().await.unwrap(), 1);
    assert_eq!(f.state(&first.task_id).await, TaskState::Uncertain);
    let next = f.say_to(ADA, "worker", "Any news?").await;
    assert_eq!(next.state(), TaskState::Queued);
    assert!(f.claim().await.is_none(), "the next turn waits");

    // The operator Inbox shows it, though it is no Objective's Task, and so does its owner's.
    let item = f.item(OPERATOR, &first.task_id).await;
    assert_eq!(item.kind(), InboxItemKind::TaskAttention);
    assert_eq!(
        item.attempt_id.as_deref(),
        Some(attempt.attempt_id.as_str())
    );
    assert!(item.objective_id.is_empty());
    let uncertain = item.uncertain_attempt.clone().unwrap();
    assert_eq!(uncertain.tag_id, "worker");
    assert_eq!(uncertain.session_id, first.session_id);
    assert_eq!(uncertain.blocked_tasks, 1);
    let report = uncertain.execution_report.clone().unwrap();
    assert_eq!(report.cleanup(), AttemptCleanup::Unknown);
    assert_eq!(uncertain.auto_resolve_at_ms, 0);
    assert!(
        uncertain.held_reason.contains("not confirmed"),
        "{uncertain:?}"
    );
    assert!(item.reason.contains("1 later turn") || item.reason.contains("One later turn"));
    assert!(!item.reason.contains("Check CI"), "no conversation text");
    f.item(ADA, &first.task_id).await;
    assert!(
        f.items(MALLORY).await.is_empty(),
        "another client sees nothing"
    );

    // Before the host confirms it stopped, its owner cannot decide, nor may it vouch for that.
    assert!(matches!(
        f.resolve(ADA, &attempt, AttemptDecision::Failed, false)
            .await,
        Err(StoreError::FailedPrecondition(_))
    ));
    assert!(matches!(
        f.resolve(ADA, &attempt, AttemptDecision::Failed, true)
            .await,
        Err(StoreError::FailedPrecondition(_))
    ));

    // The host's late Finish confirms it stopped. It recorded no effect, so SuperTag records it
    // as failed once the grace period after the lease passed.
    f.finish_late(&attempt).await;
    let uncertain = f
        .item(OPERATOR, &first.task_id)
        .await
        .uncertain_attempt
        .unwrap();
    let report = uncertain.execution_report.clone().unwrap();
    assert_eq!(report.cleanup(), AttemptCleanup::Confirmed);
    assert!(report.complete);
    assert_eq!(uncertain.auto_resolve_at_ms, BASE + LEASE + GRACE);
    assert!(uncertain.held_reason.is_empty());
    f.at(LEASE + GRACE - 1);
    assert_eq!(f.store.sweep_expired_attempts().await.unwrap(), 0);
    assert_eq!(f.state(&first.task_id).await, TaskState::Uncertain);
    f.at(LEASE + GRACE);
    assert_eq!(f.store.sweep_expired_attempts().await.unwrap(), 1);
    let failed = f.store.get_task(&first.task_id).await.unwrap();
    assert_eq!(failed.state(), TaskState::Failed);
    assert!(
        failed
            .result
            .as_deref()
            .unwrap()
            .contains("outcome is unknown"),
        "{failed:?}"
    );
    let resolution = f
        .store
        .get_attempt_resolution(&f.host, &attempt)
        .await
        .unwrap()
        .unwrap();
    assert!(resolution.automatic, "{resolution:?}");
    assert_eq!(resolution.decision(), AttemptDecision::Failed);
    let audited =
        sqlx::query("SELECT actor, action FROM supertag_v2_audit_entries WHERE target=$1")
            .bind(format!("Task/{}", first.task_id))
            .fetch_all(&f.pool)
            .await
            .unwrap();
    assert_eq!(audited.len(), 1);
    assert_eq!(audited[0].get::<String, _>("actor"), "control-plane");
    assert_eq!(audited[0].get::<String, _>("action"), "attempt.resolve");
    assert!(f.items(OPERATOR).await.is_empty(), "the item goes with it");
    assert!(matches!(
        f.resolve(OPERATOR, &attempt, AttemptDecision::Retry, true)
            .await,
        Err(StoreError::Conflict(_))
    ));
    // The queue moves on.
    let claimed = f.claim().await.unwrap();
    assert_eq!(claimed.task.unwrap().task_id, next.task_id);
    f.store.cancel_task(&next.task_id).await.unwrap();

    // An Attempt that already said something to the person waits for a person, however long.
    let at = 10 * GRACE;
    f.at(at);
    let said = f.say_to(ADA, "helper", "Deploy it").await;
    let attempt = f.running(&said.task_id).await;
    f.store
        .append_event(
            &AttemptAccess::new(&f.host, &attempt),
            &AppendEventRequest {
                sequence: 1,
                text: "Deploying now.".into(),
                kind: TaskEventKind::Message as i32,
            },
        )
        .await
        .unwrap();
    f.at(at + LEASE);
    f.store.sweep_expired_attempts().await.unwrap();
    let after = f.say_to(ADA, "helper", "Thanks").await;
    f.finish_late(&attempt).await;
    f.at(at + LEASE + 100 * GRACE);
    assert_eq!(f.store.sweep_expired_attempts().await.unwrap(), 0);
    assert_eq!(f.state(&said.task_id).await, TaskState::Uncertain);
    let uncertain = f
        .item(OPERATOR, &said.task_id)
        .await
        .uncertain_attempt
        .unwrap();
    assert_eq!(uncertain.auto_resolve_at_ms, 0);
    assert!(
        uncertain.held_reason.contains("already said something"),
        "{uncertain:?}"
    );
    assert_eq!(
        uncertain.execution_report.unwrap().cleanup(),
        AttemptCleanup::Confirmed
    );
    // Its owner may mark it failed, but only an operator may run it again; no one else decides.
    assert!(matches!(
        f.resolve(MALLORY, &attempt, AttemptDecision::Failed, false)
            .await,
        Err(StoreError::PermissionDenied)
    ));
    assert!(matches!(
        f.resolve(ADA, &attempt, AttemptDecision::Retry, false).await,
        Err(StoreError::FailedPrecondition(message)) if message.contains("only an operator")
    ));
    let resolution = f
        .resolve(ADA, &attempt, AttemptDecision::Failed, false)
        .await
        .unwrap();
    assert_eq!(resolution.client_id, "ada");
    assert!(resolution.operator_id.is_empty() && !resolution.automatic);
    assert_eq!(f.state(&said.task_id).await, TaskState::Failed);
    assert!(f.items(ADA).await.is_empty());
    let claimed = f.claim().await.unwrap();
    assert_eq!(claimed.task.unwrap().task_id, after.task_id);
    f.store.cancel_task(&after.task_id).await.unwrap();

    // A Task an operator submitted, outside any conversation or Objective, is shown too, and an
    // operator who confirmed it stopped may run it again.
    let at = at + 200 * GRACE;
    f.at(at);
    let submitted = f
        .store
        .submit_task(
            OPERATOR,
            &SubmitTaskRequest {
                tag_id: "runner".into(),
                session_id: "manual".into(),
                operation_id: "manual".into(),
                prompt: "Run it".into(),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    let attempt = f.running(&submitted.task_id).await;
    f.at(at + LEASE);
    f.store.sweep_expired_attempts().await.unwrap();
    let item = f.item(OPERATOR, &submitted.task_id).await;
    assert_eq!(item.uncertain_attempt.unwrap().blocked_tasks, 0);
    assert!(f.items(ADA).await.is_empty(), "a client sees only its own");
    assert!(matches!(
        f.resolve(ADA, &attempt, AttemptDecision::Failed, false)
            .await,
        Err(StoreError::PermissionDenied | StoreError::FailedPrecondition(_))
    ));
    let resolution = f
        .resolve(OPERATOR, &attempt, AttemptDecision::Retry, true)
        .await
        .unwrap();
    assert_eq!(resolution.operator_id, "alice");
    assert_eq!(f.state(&submitted.task_id).await, TaskState::Queued);
    assert!(f.items(OPERATOR).await.is_empty());

    f.pool.close().await;
    f.store.close().await;
}

#[tokio::test]
async fn sqlite_uncertain_attempt_contract() {
    let directory = tempfile::tempdir().unwrap();
    let url = format!(
        "sqlite://{}?mode=rwc",
        directory.path().join("uncertain.db").display()
    );
    contract(&url).await;
}

#[tokio::test]
#[ignore = "requires SUPERTAG_RUST_TEST_POSTGRES_URL_FILE for a dedicated PostgreSQL test server"]
async fn postgres_uncertain_attempt_contract() {
    let path = std::env::var_os("SUPERTAG_RUST_TEST_POSTGRES_URL_FILE")
        .expect("PostgreSQL test URL file required");
    let admin_url = std::fs::read_to_string(path).unwrap();
    let name = format!("supertag_rust_uncertain_{}", Uuid::new_v4().simple());
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
    outcome.expect("PostgreSQL uncertain Attempt contract failed");
}
