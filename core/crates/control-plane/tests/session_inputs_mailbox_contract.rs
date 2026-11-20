//! Tag direct messages on the inbox Session's input queue: every message its recipient has not
//! been given is a row there. A note a wake limit holds is a row that wakes nobody and is bound by
//! the Tag's next inbox turn, which binds messages from several Tags at once. A redelivered inbox
//! Task presents the messages it bound and binds nothing new.
mod support;

use sqlx::{AnyConnection, Connection, Executor};
use std::sync::{
    Arc,
    atomic::{AtomicI64, Ordering},
};
use supertag_control_plane::{AttemptAccess, HostAuthority, Store};
use supertag_protocol::v2::*;
use uuid::Uuid;

const OPERATOR: &str = "operator:alice";
const HOUR_MS: i64 = 3_600_000;
/// The start of an hour window, so a test step never crosses one by accident.
const NOW: i64 = 527_778 * HOUR_MS;
const DEBOUNCE_MS: i64 = 3_000;
const BACKOFF_MS: i64 = 5_000;

struct Fixture {
    store: Store,
    host: HostAuthority,
    clock: Arc<AtomicI64>,
    db: tokio::sync::Mutex<AnyConnection>,
}

/// A Tag message row: session, requester, due time, binding Task, first and last seq.
type Row = (String, String, Option<i64>, Option<String>, i64, i64);

impl Fixture {
    fn now(&self) -> i64 {
        self.clock.load(Ordering::SeqCst)
    }

    async fn ordinary(&self, tag: &str) -> InspectAttemptRequest {
        self.store
            .submit_task(
                OPERATOR,
                &SubmitTaskRequest {
                    tag_id: tag.into(),
                    session_id: "ordinary".into(),
                    operation_id: Uuid::new_v4().to_string(),
                    prompt: "Coordinate".into(),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        self.claim(tag).await
    }

    async fn try_claim(&self) -> Option<Assignment> {
        self.store
            .claim_task(&self.host, &Uuid::new_v4().to_string())
            .await
            .unwrap()
    }

    /// Claims and starts the next Task, which must be the Tag's.
    async fn claim(&self, tag: &str) -> InspectAttemptRequest {
        let assignment = self.try_claim().await.expect("queued Task");
        let task = assignment.task.unwrap();
        assert_eq!(task.tag_id, tag);
        let attempt = InspectAttemptRequest {
            task_id: task.task_id,
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

    async fn prompt(&self, attempt: &InspectAttemptRequest) -> String {
        self.store.get_task(&attempt.task_id).await.unwrap().prompt
    }

    async fn finish(&self, attempt: &InspectAttemptRequest) {
        self.store
            .finish_task(
                &self.host,
                &FinishTaskRequest {
                    task_id: attempt.task_id.clone(),
                    attempt_id: attempt.attempt_id.clone(),
                    lease_token: attempt.lease_token.clone(),
                    succeeded: true,
                    result: "Done".into(),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
    }

    async fn send(
        &self,
        attempt: &InspectAttemptRequest,
        to: &str,
        text: &str,
        kind: MessageKind,
    ) -> String {
        self.store
            .send_attempt_tag_message(
                &AttemptAccess::new(&self.host, attempt),
                &SendAttemptTagMessageRequest {
                    kind: kind as i32,
                    operation_id: Uuid::new_v4().to_string(),
                    recipient_tag_id: to.into(),
                    text: text.into(),
                    review: None,
                },
            )
            .await
            .unwrap()
            .wake_deferred
    }

    /// Moves the clock and turns due wakes into inbox Tasks.
    async fn settle(&self, by: i64) {
        self.clock.fetch_add(by, Ordering::SeqCst);
        self.store.sweep_mailbox().await.unwrap();
    }

    async fn set_hourly(&self, operation: &str, limit: Option<u32>) {
        let team = self.store.get_team(OPERATOR, "crew").await.unwrap();
        self.store
            .update_team(
                OPERATOR,
                &UpdateTeamRequest {
                    operation_id: operation.into(),
                    team: "crew".into(),
                    expected_revision: team.revision,
                    wake_limits: Some(TeamWakeLimits {
                        per_tag_per_hour: limit,
                        ..Default::default()
                    }),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
    }

    /// The Tag's message rows, pending ones (`bound` false) or those bound to Tasks, in order.
    async fn rows(&self, tag: &str, bound: bool) -> Vec<Row> {
        let mut db = self.db.lock().await;
        sqlx::query_as(&format!(
            "SELECT session_id,requester,not_before_ms,task_id,first_seq,last_seq
             FROM supertag_v2_session_inputs
             WHERE tag_id=$1 AND kind=4 AND task_id IS {} NULL ORDER BY position",
            if bound { "NOT" } else { "" }
        ))
        .bind(tag)
        .fetch_all(&mut *db)
        .await
        .unwrap()
    }

    async fn bound_to(&self, task_id: &str) -> Vec<(String, Option<i64>)> {
        let mut db = self.db.lock().await;
        sqlx::query_as(
            "SELECT requester,not_before_ms FROM supertag_v2_session_inputs
             WHERE task_id=$1 AND kind=4 ORDER BY requester",
        )
        .bind(task_id)
        .fetch_all(&mut *db)
        .await
        .unwrap()
    }

    /// The wakes counted against the Tag's hourly limit in the current window.
    async fn counted(&self, tag: &str) -> i64 {
        let window = self.now() - self.now().rem_euclid(HOUR_MS);
        let mut db = self.db.lock().await;
        let wakes: Option<i64> = sqlx::query_scalar(
            "SELECT wakes FROM supertag_v2_wake_counts
             WHERE scope=1 AND scope_id=$1 AND window_start_ms=$2",
        )
        .bind(tag)
        .bind(window)
        .fetch_optional(&mut *db)
        .await
        .unwrap();
        wakes.unwrap_or(0)
    }

    async fn state_of(&self, tag: &str, text: &str) -> TagMessageState {
        self.store
            .list_mailbox_messages(
                OPERATOR,
                &ListMailboxMessagesRequest {
                    tag_id: tag.into(),
                    ..Default::default()
                },
            )
            .await
            .unwrap()
            .messages
            .into_iter()
            .find(|m| m.text == text && m.recipient_tag_id == tag)
            .expect("message")
            .state()
    }
}

async fn contract(url: &str) {
    let clock = Arc::new(AtomicI64::new(NOW));
    let now = clock.clone();
    let store = Store::open(url)
        .await
        .unwrap()
        .with_execution_clock(move || now.load(Ordering::SeqCst));
    for tag in ["a", "b", "c", "d"] {
        store
            .put_tag(tag, &format!("Identity {tag}"), vec![])
            .await
            .unwrap();
    }
    store
        .create_team(
            OPERATOR,
            &CreateTeamRequest {
                operation_id: "crew".into(),
                team_id: "crew".into(),
                name: "Crew".into(),
                member_tag_ids: vec!["a".into(), "b".into(), "c".into(), "d".into()],
                ..Default::default()
            },
        )
        .await
        .unwrap();
    let host = support::register_host(&store, "host").await;
    sqlx::any::install_default_drivers();
    let db = tokio::sync::Mutex::new(AnyConnection::connect(url).await.unwrap());
    let f = Fixture {
        store,
        host,
        clock,
        db,
    };
    f.set_hourly("hourly", Some(1)).await;

    // A note over the hourly limit is held: one row with no due time, which wakes nobody.
    let a0 = f.ordinary("a").await;
    assert_eq!(f.send(&a0, "d", "First", MessageKind::Note).await, "");
    f.settle(DEBOUNCE_MS).await;
    let d1 = f.claim("d").await;
    f.finish(&d1).await;
    assert_eq!(
        f.send(&a0, "d", "Held note", MessageKind::Note).await,
        "Tag d was already woken once this hour by other Tags; Tag d will see this message in its next turn."
    );
    assert_eq!(
        f.rows("d", false).await,
        [("inbox:d".into(), "tag:a".into(), None, None, 2, 2)]
    );
    f.settle(DEBOUNCE_MS).await;
    assert!(f.try_claim().await.is_none(), "a held note wakes nobody");
    assert_eq!(f.state_of("d", "Held note").await, TagMessageState::Pending);
    assert_eq!(
        f.counted("d").await,
        1,
        "a held note counts toward no limit"
    );
    f.finish(&a0).await;

    // The next hour a question in the same conversation pulls the held row forward: one row, one
    // activation, and the turn shows both.
    f.settle(HOUR_MS).await;
    let a1 = f.ordinary("a").await;
    assert_eq!(f.send(&a1, "d", "Ready?", MessageKind::Question).await, "");
    let due = f.now() + DEBOUNCE_MS;
    assert_eq!(
        f.rows("d", false).await,
        [("inbox:d".into(), "tag:a".into(), Some(due), None, 2, 3)]
    );
    assert_eq!(f.counted("d").await, 1);
    f.settle(DEBOUNCE_MS).await;
    let d2 = f.claim("d").await;
    let prompt = f.prompt(&d2).await;
    assert!(prompt.contains("Held note") && prompt.contains("Ready?"));
    assert!(
        !prompt.contains("First"),
        "delivered messages stay delivered"
    );
    assert_eq!(f.bound_to(&d2.task_id).await, [("tag:a".into(), Some(due))]);
    assert!(f.try_claim().await.is_none());
    f.finish(&d2).await;
    f.finish(&a1).await;
    assert_eq!(f.state_of("d", "Held note").await, TagMessageState::Handled);
    assert_eq!(f.counted("d").await, 1, "the question counted once");

    // Held rows from two Tags. They count toward no limit, and are no turn already coming: the
    // next hour a note wakes d and counts, and d's turn binds every Tag's messages, held last.
    let b0 = f.ordinary("b").await;
    let c0 = f.ordinary("c").await;
    assert_ne!(f.send(&b0, "d", "From b", MessageKind::Note).await, "");
    assert_ne!(f.send(&c0, "d", "From c", MessageKind::Note).await, "");
    assert_eq!(f.counted("d").await, 1);
    let pending = f.rows("d", false).await;
    assert_eq!(pending.len(), 2);
    assert!(pending.iter().all(|row| row.2.is_none()));
    f.finish(&b0).await;
    f.finish(&c0).await;
    f.settle(HOUR_MS).await;
    assert!(f.try_claim().await.is_none());
    let b1 = f.ordinary("b").await;
    assert_eq!(
        f.send(&b1, "d", "Again from b", MessageKind::Note).await,
        ""
    );
    assert_eq!(f.counted("d").await, 1);
    f.settle(DEBOUNCE_MS).await;
    let d3 = f.claim("d").await;
    let prompt = f.prompt(&d3).await;
    let (again, from_c) = (
        prompt.find("Again from b").unwrap(),
        prompt.find("From c").unwrap(),
    );
    assert!(prompt.contains("From b") && again < from_c, "{prompt}");
    let bound = f.bound_to(&d3.task_id).await;
    assert_eq!(bound.len(), 2);
    assert_eq!((bound[0].0.as_str(), bound[0].1.is_some()), ("tag:b", true));
    assert_eq!(bound[1], ("tag:c".into(), None));
    assert!(f.rows("d", false).await.is_empty());
    f.finish(&d3).await;
    f.finish(&b1).await;

    // A redelivered inbox Task presents what it bound and binds nothing new; later mail waits
    // for the next turn, and no second inbox Task is admitted while the first waits.
    f.set_hourly("default", None).await;
    f.settle(HOUR_MS).await;
    let b2 = f.ordinary("b").await;
    assert_eq!(f.send(&b2, "d", "Urgent", MessageKind::Blocker).await, "");
    let d4 = f.claim("d").await;
    let presented = f.prompt(&d4).await;
    assert!(presented.contains("Urgent"));
    let decision = f
        .store
        .reclaim_attempt(
            &f.host,
            &ReclaimAttemptRequest {
                attempt: Some(d4.clone()),
                evidence: "every recorded process group is gone: 4242".into(),
            },
        )
        .await
        .unwrap()
        .decision();
    assert_eq!(decision, AttemptDecision::Retry);
    let c1 = f.ordinary("c").await;
    assert_eq!(f.send(&c1, "d", "Later", MessageKind::Note).await, "");
    f.finish(&b2).await;
    f.finish(&c1).await;
    f.settle(DEBOUNCE_MS).await;
    assert!(
        f.try_claim().await.is_none(),
        "the redelivered Task waits out its backoff and has no rival"
    );
    f.settle(BACKOFF_MS).await;
    let again = f.claim("d").await;
    assert_eq!(again.task_id, d4.task_id);
    assert_ne!(again.attempt_id, d4.attempt_id);
    assert_eq!(f.prompt(&again).await, presented);
    assert_eq!(f.bound_to(&d4.task_id).await.len(), 1);
    let later = f.rows("d", false).await;
    assert_eq!(later.len(), 1);
    assert_eq!(later[0].1, "tag:c");
    f.finish(&again).await;
    f.settle(0).await;
    let d5 = f.claim("d").await;
    let prompt = f.prompt(&d5).await;
    assert!(prompt.contains("Later") && !prompt.contains("Urgent"));
    f.finish(&d5).await;
    f.store.close().await;
}

#[tokio::test]
async fn sqlite_session_inputs_mailbox_contract() {
    let directory = tempfile::tempdir().unwrap();
    contract(&format!(
        "sqlite://{}?mode=rwc",
        directory.path().join("inputs.db").display()
    ))
    .await;
}

#[tokio::test]
#[ignore = "requires SUPERTAG_RUST_TEST_POSTGRES_URL_FILE for a dedicated PostgreSQL server"]
async fn postgres_session_inputs_mailbox_contract() {
    let path = std::env::var_os("SUPERTAG_RUST_TEST_POSTGRES_URL_FILE")
        .expect("PostgreSQL test URL file required");
    let admin_url = std::fs::read_to_string(path).unwrap();
    let name = format!("supertag_inputs_mailbox_{}", Uuid::new_v4().simple());
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
    result.expect("PostgreSQL Session inputs mailbox contract failed");
}
