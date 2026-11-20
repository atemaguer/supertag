//! A person's messages on their Session's input queue (session-input-queue design, stage 2): each
//! message records one input when it is admitted, a replayed send records none, a claim joins only
//! the later messages that act for the same person and reply to the same audience, and a message
//! from another requester waits for its own turn instead of going into a running Attempt.
mod support;

use std::sync::{
    Arc,
    atomic::{AtomicI64, Ordering},
};

use sqlx::{AnyPool, Connection, Executor, Row};
use supertag_control_plane::{AttemptAccess, HostAuthority, Store};
use supertag_protocol::v2::*;
use uuid::Uuid;

const ALICE: &str = "operator:alice";
const BOB: &str = "operator:bob";
const HOUR: i64 = 3_600_000;
/// Sun 17 Mar 2030 17:46:40 UTC.
const NOW: i64 = 1_900_000_000_000;

struct Fixture {
    store: Store,
    host: HostAuthority,
    clock: Arc<AtomicI64>,
    pool: AnyPool,
}

/// One input as stored.
#[derive(Debug, PartialEq, Eq)]
struct Input {
    kind: i64,
    source_key: String,
    requester: String,
    audience: String,
    task_id: Option<String>,
    bound_at_claim: i64,
    offer_task_id: Option<String>,
    offer_state: Option<i64>,
}

impl Fixture {
    async fn send(&self, text: &str, operation: &str) -> ConversationMessage {
        self.store
            .send_message(
                ALICE,
                &SendMessageRequest {
                    output_policy: None,
                    execution_limits: None,
                    tag_id: "engineer".into(),
                    text: text.into(),
                    operation_id: operation.into(),
                },
            )
            .await
            .unwrap()
    }

    /// Claims and starts the next queued Task.
    async fn next(&self) -> (Assignment, InspectAttemptRequest) {
        let claim = self
            .store
            .claim_task(&self.host, &Uuid::new_v4().to_string())
            .await
            .unwrap()
            .expect("a queued Task");
        let attempt = InspectAttemptRequest {
            task_id: claim.task.as_ref().unwrap().task_id.clone(),
            attempt_id: claim.attempt_id.clone(),
            lease_token: claim.lease_token.clone(),
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
        (claim, attempt)
    }

    async fn finish(&self, attempt: &InspectAttemptRequest) {
        self.store
            .finish_task(
                &self.host,
                &FinishTaskRequest {
                    task_id: attempt.task_id.clone(),
                    attempt_id: attempt.attempt_id.clone(),
                    lease_token: attempt.lease_token.clone(),
                    result: "Done".into(),
                    succeeded: true,
                    ..Default::default()
                },
            )
            .await
            .unwrap();
    }

    async fn input(&self, task_id: &str) -> Input {
        let row = sqlx::query(
            "SELECT kind,source_key,requester,audience,task_id,bound_at_claim,offer_task_id,offer_state
             FROM supertag_v2_session_inputs WHERE admitted_task_id=$1",
        )
        .bind(task_id)
        .fetch_one(&self.pool)
        .await
        .unwrap();
        Input {
            kind: row.get("kind"),
            source_key: row.get("source_key"),
            requester: row.get("requester"),
            audience: row.get("audience"),
            task_id: row.get("task_id"),
            bound_at_claim: row.get("bound_at_claim"),
            offer_task_id: row.get("offer_task_id"),
            offer_state: row.get("offer_state"),
        }
    }

    async fn inputs_of(&self, task_id: &str) -> i64 {
        sqlx::query_scalar(
            "SELECT COUNT(*) FROM supertag_v2_session_inputs WHERE admitted_task_id=$1",
        )
        .bind(task_id)
        .fetch_one(&self.pool)
        .await
        .unwrap()
    }

    async fn state(&self, task_id: &str) -> TaskState {
        self.store.get_task(task_id).await.unwrap().state()
    }
}

fn task_of(message: &ConversationMessage) -> String {
    message.task.as_ref().unwrap().task_id.clone()
}

fn joined(claim: &Assignment) -> Vec<String> {
    claim.joined.iter().map(|m| m.task_id.clone()).collect()
}

/// Each message records one input, acting for its person and replying to them; a replayed send
/// records none. A claim joins the later messages, and a Schedule fire between them ends the run.
async fn conversation_messages(f: &Fixture) {
    let first = f.send("First", "one").await;
    let first_task = task_of(&first);
    let row = f.input(&first_task).await;
    assert_eq!(
        row,
        Input {
            kind: 2,
            source_key: format!("conversation\n{ALICE}\none"),
            requester: ALICE.into(),
            audience: ALICE.into(),
            task_id: None,
            bound_at_claim: 0,
            offer_task_id: None,
            offer_state: None,
        }
    );
    assert_eq!(f.send("First", "one").await, first, "a replayed send");
    assert_eq!(f.inputs_of(&first_task).await, 1);

    let second = task_of(&f.send("Second", "two").await);
    let third = task_of(&f.send("Third", "three").await);
    let (claim, attempt) = f.next().await;
    assert_eq!(claim.task.as_ref().unwrap().task_id, first_task);
    assert_eq!(joined(&claim), [second.clone(), third.clone()]);
    assert_eq!(
        f.input(&first_task).await.task_id.as_deref(),
        Some(first_task.as_str())
    );
    for id in [&second, &third] {
        let row = f.input(id).await;
        assert_eq!(row.task_id.as_deref(), Some(first_task.as_str()));
        assert_eq!(row.bound_at_claim, 1);
        assert_eq!(row.offer_state, Some(LiveInputState::Accepted as i64));
        assert_eq!(f.state(id).await, TaskState::Succeeded);
    }

    // A message sent while the run works goes into it, offered to its Attempt.
    let fourth = f.send("Fourth", "four").await;
    let offered = fourth
        .live_input
        .clone()
        .expect("folded into the running Attempt");
    assert_eq!(offered.state(), LiveInputState::Pending);
    assert_eq!(offered.task_id, first_task);
    let access = AttemptAccess::new(&f.host, &attempt);
    let taken = f.store.take_input(&access).await.unwrap().unwrap();
    assert_eq!(taken.input_id, offered.input_id);
    let settle = |receipt: LiveInputReceipt| SettleInputRequest {
        input_id: offered.input_id.clone(),
        receipt: receipt.into(),
    };
    f.store
        .settle_input(&access, &settle(LiveInputReceipt::Accepted))
        .await
        .unwrap();
    let fourth_task = task_of(&fourth);
    assert_eq!(
        f.input(&fourth_task).await.task_id.as_deref(),
        Some(first_task.as_str()),
        "accepted mid-run binds it to the run"
    );
    // The harness withdrew it unread: it returns to the queue and runs as its own turn.
    f.store
        .settle_input(&access, &settle(LiveInputReceipt::Withdrawn))
        .await
        .unwrap();
    assert_eq!(
        f.input(&fourth_task).await.task_id,
        None,
        "withdrawal unbinds"
    );
    assert_eq!(f.state(&fourth_task).await, TaskState::Queued);
    f.finish(&attempt).await;
    let (claim, attempt) = f.next().await;
    assert_eq!(claim.task.as_ref().unwrap().task_id, fourth_task);
    assert!(claim.joined.is_empty());
    f.finish(&attempt).await;

    // A Schedule fire ends a run of joined messages.
    f.store
        .create_schedule(
            ALICE,
            &CreateScheduleRequest {
                operation_id: "check-ci".into(),
                tag_id: "engineer".into(),
                note: "Check CI".into(),
                at: String::new(),
                every: "@hourly".into(),
                time_zone: None,
            },
        )
        .await
        .unwrap();
    f.clock.store(NOW + HOUR, Ordering::SeqCst);
    let before = task_of(&f.send("Before the check", "five").await);
    assert_eq!(f.store.sweep_schedules().await.unwrap(), 1);
    let after = task_of(&f.send("After the check", "six").await);
    let (claim, attempt) = f.next().await;
    assert_eq!(claim.task.as_ref().unwrap().task_id, before);
    assert!(claim.joined.is_empty(), "the Schedule fire ends the run");
    f.finish(&attempt).await;
    let (fired, attempt) = f.next().await;
    let fired = fired.task.unwrap();
    assert!(fired.prompt.contains("Check CI"), "{}", fired.prompt);
    assert!(
        f.state(&after).await == TaskState::Queued,
        "it waits behind the fire"
    );
    // A person's message still goes into the running Schedule turn of their conversation.
    let during = f.send("During the check", "seven").await;
    let offered = during
        .live_input
        .clone()
        .expect("folded into the Schedule turn");
    assert_eq!(offered.task_id, fired.task_id);
    assert_eq!(offered.state(), LiveInputState::Pending);
    f.finish(&attempt).await;
    let (claim, attempt) = f.next().await;
    assert_eq!(claim.task.as_ref().unwrap().task_id, after);
    assert_eq!(joined(&claim), [task_of(&during)]);
    f.finish(&attempt).await;
}

/// Live input acts for the principal that queued it. An operator who sends input to a running Task
/// chose that Task, so input from another requester is still offered to it; a claim never joins a
/// message to one of another requester.
async fn live_input_requesters(f: &Fixture) {
    let submitted = f
        .store
        .submit_task(
            ALICE,
            &SubmitTaskRequest {
                output_policy: None,
                execution_limits: None,
                tag_id: "engineer".into(),
                session_id: "review".into(),
                operation_id: "review".into(),
                prompt: "Review the change".into(),
                input_artifacts: vec![],
            },
        )
        .await
        .unwrap();
    let (_, attempt) = f.next().await;
    assert_eq!(attempt.task_id, submitted.task_id);
    let queue = |operation: &str| QueueInputRequest {
        task_id: submitted.task_id.clone(),
        operation_id: operation.into(),
        text: format!("Also {operation}"),
    };
    let own = f.store.queue_input(ALICE, &queue("tests")).await.unwrap();
    assert_eq!(own.state(), LiveInputState::Pending);
    let row = f.input(&own.follower_task_id).await;
    assert_eq!(
        (row.kind, row.source_key.as_str(), row.requester.as_str()),
        (2, format!("live\n{ALICE}\ntests").as_str(), ALICE)
    );
    // A replay returns the same input and records nothing new.
    assert_eq!(
        f.store.queue_input(ALICE, &queue("tests")).await.unwrap(),
        own
    );
    assert_eq!(f.inputs_of(&own.follower_task_id).await, 1);

    let other = f.store.queue_input(BOB, &queue("docs")).await.unwrap();
    assert_eq!(
        other.state(),
        LiveInputState::Pending,
        "an operator chose this Task"
    );
    assert_eq!(other.task_id, submitted.task_id);
    let row = f.input(&other.follower_task_id).await;
    assert_eq!((row.requester.as_str(), row.task_id), (BOB, None));
    assert_eq!(f.state(&other.follower_task_id).await, TaskState::Queued);

    // Never taken, Alice's input falls back to its own turn; Bob's message waits for its own.
    f.finish(&attempt).await;
    let (claim, attempt) = f.next().await;
    assert_eq!(claim.task.as_ref().unwrap().task_id, own.follower_task_id);
    assert!(
        claim.joined.is_empty(),
        "Bob's message is not joined to Alice's"
    );
    f.finish(&attempt).await;
    let (claim, attempt) = f.next().await;
    assert_eq!(claim.task.as_ref().unwrap().task_id, other.follower_task_id);
    assert_eq!(
        f.input(&other.follower_task_id).await.task_id.as_deref(),
        Some(other.follower_task_id.as_str())
    );
    f.finish(&attempt).await;
}

/// `/goal` is answered by the Control Plane at once: its message is bound to its settled Task.
async fn goal_message(f: &Fixture) {
    let goal = f.send("/goal Ship the release", "goal").await;
    let task = task_of(&goal);
    assert_eq!(f.state(&task).await, TaskState::Succeeded);
    let row = f.input(&task).await;
    assert_eq!((row.kind, row.task_id.as_deref()), (2, Some(task.as_str())));
}

async fn contract(url: &str) {
    let clock = Arc::new(AtomicI64::new(NOW));
    let observed = clock.clone();
    let store = Store::open(url)
        .await
        .unwrap()
        .with_execution_clock(move || observed.load(Ordering::SeqCst))
        .with_time_zone("UTC")
        .unwrap();
    sqlx::any::install_default_drivers();
    let pool = AnyPool::connect(url).await.unwrap();
    store.put_tag("engineer", "Answer", vec![]).await.unwrap();
    let host = support::register_host(&store, "laptop").await;
    let f = Fixture {
        store,
        host,
        clock,
        pool,
    };
    conversation_messages(&f).await;
    live_input_requesters(&f).await;
    goal_message(&f).await;
}

#[tokio::test]
async fn sqlite_session_inputs_person_contract() {
    let directory = tempfile::tempdir().unwrap();
    contract(&format!(
        "sqlite://{}?mode=rwc",
        directory.path().join("inputs.db").display()
    ))
    .await;
}

#[tokio::test]
#[ignore = "requires SUPERTAG_RUST_TEST_POSTGRES_URL_FILE for a dedicated PostgreSQL test server"]
async fn postgres_session_inputs_person_contract() {
    let path = std::env::var_os("SUPERTAG_RUST_TEST_POSTGRES_URL_FILE")
        .expect("PostgreSQL test URL file required");
    let admin_url = std::fs::read_to_string(path).unwrap();
    let name = format!("supertag_rust_person_inputs_{}", Uuid::new_v4().simple());
    let mut admin = sqlx::PgConnection::connect(admin_url.trim()).await.unwrap();
    admin
        .execute(format!("CREATE DATABASE {name}").as_str())
        .await
        .unwrap();
    let mut url = url::Url::parse(admin_url.trim()).unwrap();
    url.set_path(&name);
    let outcome = tokio::task::LocalSet::new()
        .run_until(async move {
            tokio::task::spawn_local(async move { contract(url.as_str()).await }).await
        })
        .await;
    admin
        .execute(format!("DROP DATABASE {name} WITH (FORCE)").as_str())
        .await
        .unwrap();
    admin.close().await.unwrap();
    outcome.expect("PostgreSQL person input contract failed");
}
