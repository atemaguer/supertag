//! A Session's internal inputs (session-input-queue design, stage 2): a Schedule fire, a work
//! Session report, an approval decision, a question's answer, and an Objective's own turns each
//! record one input with the Task admitted for it, once per source event, and the Task's own
//! claim binds it. An input in a person's conversation acts for that person, so a Schedule turn
//! still takes in their message while it runs, and it still ends a run of their joined messages.
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
const MINUTE: i64 = 60_000;
const NOW: i64 = 1_900_000_000_000;

struct Fixture {
    store: Store,
    host: HostAuthority,
    clock: Arc<AtomicI64>,
    pool: AnyPool,
}

/// An input as stored.
#[derive(Debug, PartialEq)]
struct Input {
    kind: i64,
    source_key: String,
    requester: String,
    audience: String,
    task_id: Option<String>,
}

impl Fixture {
    fn advance(&self, ms: i64) {
        self.clock.fetch_add(ms, Ordering::SeqCst);
    }

    /// The input `task_id` was admitted for.
    async fn own(&self, task_id: &str) -> Input {
        let row = sqlx::query(
            "SELECT kind,source_key,requester,audience,task_id FROM supertag_v2_session_inputs
             WHERE admitted_task_id=$1 AND conversation_id IS NULL",
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
        }
    }

    /// How many inputs a source key prefix recorded.
    async fn count(&self, prefix: &str) -> i64 {
        let keys: Vec<String> =
            sqlx::query_scalar("SELECT source_key FROM supertag_v2_session_inputs")
                .fetch_all(&self.pool)
                .await
                .unwrap();
        keys.iter().filter(|key| key.starts_with(prefix)).count() as i64
    }

    /// Asserts `task_id`'s own input and that it waits for a run.
    async fn admitted(&self, task_id: &str, kind: i64, key: &str, requester: &str, audience: &str) {
        assert_eq!(
            self.own(task_id).await,
            Input {
                kind,
                source_key: key.into(),
                requester: requester.into(),
                audience: audience.into(),
                task_id: None,
            }
        );
        assert_eq!(self.count(key).await, 1, "{key:?}");
    }

    /// Claims and starts the next Task, which must be `expected`, and checks its claim bound its
    /// own input when it has one.
    async fn run(&self, expected: &str) -> (Assignment, InspectAttemptRequest) {
        let assignment = self
            .store
            .claim_task(&self.host, &Uuid::new_v4().to_string())
            .await
            .unwrap()
            .expect("a Task to run");
        assert_eq!(assignment.task.as_ref().unwrap().task_id, expected);
        let attempt = InspectAttemptRequest {
            task_id: expected.into(),
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
        (assignment, attempt)
    }

    async fn bound(&self, task_id: &str) {
        assert_eq!(
            self.own(task_id).await.task_id.as_deref(),
            Some(task_id),
            "its own claim binds the input"
        );
    }

    async fn finish(&self, attempt: &InspectAttemptRequest, signal: ObjectiveSignal) {
        self.finish_waiting(attempt, signal, vec![]).await;
    }

    async fn finish_waiting(
        &self,
        attempt: &InspectAttemptRequest,
        signal: ObjectiveSignal,
        waiting_approval_ids: Vec<String>,
    ) {
        self.store
            .finish_task(
                &self.host,
                &FinishTaskRequest {
                    task_id: attempt.task_id.clone(),
                    attempt_id: attempt.attempt_id.clone(),
                    lease_token: attempt.lease_token.clone(),
                    result: "Handled".into(),
                    succeeded: true,
                    objective_signal: signal as i32,
                    waiting_approval_ids,
                    ..Default::default()
                },
            )
            .await
            .unwrap();
    }

    /// Runs and finishes every queued Task.
    async fn drain(&self) {
        while let Some(assignment) = self
            .store
            .claim_task(&self.host, &Uuid::new_v4().to_string())
            .await
            .unwrap()
        {
            let task_id = assignment.task.as_ref().unwrap().task_id.clone();
            let attempt = InspectAttemptRequest {
                task_id: task_id.clone(),
                attempt_id: assignment.attempt_id.clone(),
                lease_token: assignment.lease_token.clone(),
            };
            self.store
                .start_task(
                    &self.host,
                    &StartTaskRequest {
                        task_id,
                        attempt_id: attempt.attempt_id.clone(),
                        lease_token: attempt.lease_token.clone(),
                    },
                )
                .await
                .unwrap();
            self.finish(&attempt, ObjectiveSignal::Progress).await;
        }
    }

    async fn say(&self, tag: &str, operation: &str, text: &str) -> ConversationMessage {
        self.store
            .send_message(
                ALICE,
                &SendMessageRequest {
                    tag_id: tag.into(),
                    text: text.into(),
                    operation_id: operation.into(),
                    ..Default::default()
                },
            )
            .await
            .unwrap()
    }
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
    let host = support::register_host(&store, "laptop").await;
    store
        .put_tag(
            "lead",
            "Help",
            vec!["files:read".into(), "schedule:create".into()],
        )
        .await
        .unwrap();
    store
        .put_tag("owner", "Pursue the outcome", vec!["files:read".into()])
        .await
        .unwrap();
    store
        .put_tag_spec(PutTagRequest {
            tag_id: "parent".into(),
            instructions: "Delegate".into(),
            allowed_actions: vec!["files:read".into()],
            max_work_sessions: Some(8),
            ..Default::default()
        })
        .await
        .unwrap();
    store
        .put_tag_spec(PutTagRequest {
            tag_id: "gate".into(),
            instructions: "Post updates".into(),
            allowed_actions: vec!["workstream:post".into()],
            approval_rules: vec![ApprovalRule {
                action: "workstream:post".into(),
                operator_ids: vec!["alice".into()],
            }],
            ..Default::default()
        })
        .await
        .unwrap();
    store
        .create_team(
            ALICE,
            &CreateTeamRequest {
                wake_limits: None,
                operation_id: "team".into(),
                team_id: "engineering".into(),
                name: "Engineering".into(),
                member_tag_ids: vec!["gate".into()],
                max_concurrency: None,
            },
        )
        .await
        .unwrap();
    let f = Fixture {
        store,
        host,
        clock,
        pool,
    };
    schedule_in_a_conversation(&f).await;
    schedule_outside_a_conversation(&f).await;
    objective_turns(&f).await;
    question_answer(&f).await;
    approval_decision(&f).await;
    work_session_report(&f).await;
    f.pool.close().await;
    f.store.close().await;
}

/// A Schedule fire in Alice's conversation acts for her: it ends a run of her joined messages,
/// and her message folds into it while it runs.
async fn schedule_in_a_conversation(f: &Fixture) {
    let hello = f.say("lead", "hello", "Hello").await.task.unwrap();
    let (_, first) = f.run(&hello.task_id).await;
    f.finish(&first, ObjectiveSignal::Progress).await;
    let schedule = f
        .store
        .create_schedule(
            ALICE,
            &CreateScheduleRequest {
                operation_id: "check".into(),
                tag_id: "lead".into(),
                note: "Check PR 412".into(),
                at: "10m".into(),
                every: String::new(),
                time_zone: None,
            },
        )
        .await
        .unwrap();
    let due = schedule.at_ms.unwrap();
    let before = f
        .say("lead", "before", "First question")
        .await
        .task
        .unwrap();
    f.advance(10 * MINUTE);
    assert_eq!(f.store.sweep_schedules().await.unwrap(), 1);
    // The fire's replay records nothing more.
    assert_eq!(f.store.sweep_schedules().await.unwrap(), 0);
    let fired = f
        .store
        .get_schedule(ALICE, &schedule.schedule_id)
        .await
        .unwrap()
        .last_task_id
        .unwrap();
    let key = format!("schedule\n{}\n{due}", schedule.schedule_id);
    f.admitted(&fired, 5, &key, ALICE, ALICE).await;
    let after = f
        .say("lead", "after", "Second question")
        .await
        .task
        .unwrap();

    // The fire ends the run: Alice's first question joins nothing, and the fire joins nothing.
    let (assignment, attempt) = f.run(&before.task_id).await;
    assert!(assignment.joined.is_empty(), "{:?}", assignment.joined);
    f.finish(&attempt, ObjectiveSignal::Progress).await;
    let (assignment, attempt) = f.run(&fired).await;
    assert!(assignment.joined.is_empty(), "{:?}", assignment.joined);
    f.bound(&fired).await;
    // Alice's message while the fire runs is offered to it.
    let during = f.say("lead", "during", "Also the release branch").await;
    assert_eq!(
        during
            .live_input
            .as_ref()
            .map(|input| input.task_id.as_str()),
        Some(fired.as_str())
    );
    f.finish(&attempt, ObjectiveSignal::Progress).await;
    assert_ne!(after.task_id, fired);
    f.drain().await;
}

/// A Tag's Schedule outside a conversation acts for the Schedule.
async fn schedule_outside_a_conversation(f: &Fixture) {
    let task = f
        .store
        .submit_task(
            ALICE,
            &SubmitTaskRequest {
                tag_id: "lead".into(),
                session_id: "ops".into(),
                operation_id: "ops".into(),
                prompt: "Watch the build".into(),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    let (_, turn) = f.run(&task.task_id).await;
    let schedule = f
        .store
        .create_attempt_schedule(
            &AttemptAccess::new(&f.host, &turn),
            &CreateAttemptScheduleRequest {
                operation_id: "watch".into(),
                note: "Check the build".into(),
                at: "30m".into(),
                every: String::new(),
                time_zone: None,
            },
        )
        .await
        .unwrap()
        .schedule
        .unwrap();
    f.finish(&turn, ObjectiveSignal::Progress).await;
    f.advance(30 * MINUTE);
    assert_eq!(f.store.sweep_schedules().await.unwrap(), 1);
    let fired = f
        .store
        .get_schedule(ALICE, &schedule.schedule_id)
        .await
        .unwrap();
    let task_id = fired.last_task_id.unwrap();
    let key = format!(
        "schedule\n{}\n{}",
        schedule.schedule_id,
        schedule.at_ms.unwrap()
    );
    f.admitted(
        &task_id,
        5,
        &key,
        &format!("schedule:{}", schedule.schedule_id),
        "",
    )
    .await;
    let (_, attempt) = f.run(&task_id).await;
    f.bound(&task_id).await;
    f.finish(&attempt, ObjectiveSignal::Progress).await;
    f.drain().await;
}

/// An Objective's starting Task, its idle notice, and review feedback act for its creator.
async fn objective_turns(f: &Fixture) {
    let request = CreateObjectiveRequest {
        objective_id: "ship".into(),
        operation_id: "create-ship".into(),
        owner_tag_id: "owner".into(),
        outcome: "Ship the change".into(),
        ..Default::default()
    };
    let objective = f.store.create_objective(ALICE, &request).await.unwrap();
    assert_eq!(
        f.store.create_objective(ALICE, &request).await.unwrap(),
        objective
    );
    let home = objective.starting_task_id.clone();
    f.admitted(&home, 1, "objective-home\nship", ALICE, "")
        .await;
    let (_, attempt) = f.run(&home).await;
    f.bound(&home).await;
    f.finish(&attempt, ObjectiveSignal::Progress).await;

    let idle: String = sqlx::query_scalar(
        "SELECT task_id FROM supertag_v2_objective_notices WHERE objective_id='ship'",
    )
    .fetch_one(&f.pool)
    .await
    .unwrap();
    f.admitted(
        &idle,
        8,
        &format!("objective\nship\nidle:{home}"),
        ALICE,
        "",
    )
    .await;
    let (_, attempt) = f.run(&idle).await;
    f.bound(&idle).await;
    f.finish(&attempt, ObjectiveSignal::ReadyForReview).await;

    let review = ReviewObjectiveRequest {
        objective_id: "ship".into(),
        operation_id: "changes".into(),
        approved: false,
        feedback: "Add failure coverage".into(),
    };
    let reviewed = f.store.review_objective(ALICE, &review).await.unwrap();
    assert_eq!(
        f.store.review_objective(ALICE, &review).await.unwrap(),
        reviewed
    );
    let feedback: String = sqlx::query_scalar(
        "SELECT task_id FROM supertag_v2_objective_notices WHERE objective_id='ship'
         AND substr(notice_key,1,7)='review:'",
    )
    .fetch_one(&f.pool)
    .await
    .unwrap();
    let own = f.own(&feedback).await;
    assert_eq!(
        (own.kind, own.requester.as_str(), own.task_id),
        (7, ALICE, None)
    );
    assert!(own.source_key.starts_with("objective\nship\nreview:"));
    assert_eq!(f.count("objective\nship\nreview:").await, 1);
    let (_, attempt) = f.run(&feedback).await;
    f.bound(&feedback).await;
    f.finish(&attempt, ObjectiveSignal::Progress).await;
    cancel(f, "ship").await;
}

/// A question's answer acts for the person who answered, once per operation.
async fn question_answer(f: &Fixture) {
    let objective = f
        .store
        .create_objective(
            ALICE,
            &CreateObjectiveRequest {
                objective_id: "ask".into(),
                operation_id: "create-ask".into(),
                owner_tag_id: "owner".into(),
                outcome: "Choose an option".into(),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    let (_, attempt) = f.run(&objective.starting_task_id).await;
    f.store
        .ask_question(
            &AttemptAccess::new(&f.host, &attempt),
            &AskQuestionRequest {
                operation_id: "ask".into(),
                text: "Which option?".into(),
            },
        )
        .await
        .unwrap();
    f.finish(&attempt, ObjectiveSignal::Progress).await;
    let answer = AnswerQuestionRequest {
        task_id: attempt.task_id.clone(),
        operation_id: "answer".into(),
        text: "The safe one".into(),
    };
    let task = f.store.answer_question(ALICE, &answer).await.unwrap();
    assert_eq!(f.store.answer_question(ALICE, &answer).await.unwrap(), task);
    f.admitted(
        &task.task_id,
        7,
        "answer\noperator:alice\nanswer",
        ALICE,
        "",
    )
    .await;
    let (_, attempt) = f.run(&task.task_id).await;
    f.bound(&task.task_id).await;
    f.finish(&attempt, ObjectiveSignal::Progress).await;
    cancel(f, "ask").await;
}

/// An approval decision in Alice's conversation acts for her, once although decided twice.
async fn approval_decision(f: &Fixture) {
    let waiting = f
        .say("gate", "update", "Post an update")
        .await
        .task
        .unwrap();
    let (_, attempt) = f.run(&waiting.task_id).await;
    let approval = f
        .store
        .post_attempt_workstream(
            &AttemptAccess::new(&f.host, &attempt),
            &PostAttemptWorkstreamRequest {
                operation_id: "post".into(),
                body: "An update".into(),
                to_tag_ids: vec![],
            },
        )
        .await
        .unwrap()
        .approval
        .unwrap();
    f.finish_waiting(
        &attempt,
        ObjectiveSignal::Progress,
        vec![approval.approval_id.clone()],
    )
    .await;
    let decision = DecideApprovalRequest {
        approval_id: approval.approval_id.clone(),
        operation_id: "approve".into(),
        approve: true,
        scope: ApprovalScope::Once as i32,
        valid_until_ms: None,
        reason: "Reviewed exact arguments".into(),
    };
    let decided = f.store.decide_approval(ALICE, &decision).await.unwrap();
    assert_eq!(
        f.store.decide_approval(ALICE, &decision).await.unwrap(),
        decided
    );
    f.store.sweep_approvals().await.unwrap();
    let continuation = decided.continuation_task_id.unwrap();
    f.admitted(
        &continuation,
        7,
        &format!("approval\n{}", waiting.task_id),
        ALICE,
        ALICE,
    )
    .await;
    let (_, attempt) = f.run(&continuation).await;
    f.bound(&continuation).await;
    f.finish(&attempt, ObjectiveSignal::Progress).await;
    f.drain().await;
}

/// A work Session's report to Alice's conversation acts for her, once per settled child.
async fn work_session_report(f: &Fixture) {
    let parent = f
        .say("parent", "delegate", "Inspect this")
        .await
        .task
        .unwrap();
    let (_, parent_attempt) = f.run(&parent.task_id).await;
    let work = f
        .store
        .start_work_session(
            &AttemptAccess::new(&f.host, &parent_attempt),
            &StartWorkSessionRequest {
                operation_id: "child".into(),
                title: "review".into(),
                instruction: "Inspect the fixture".into(),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    f.finish(&parent_attempt, ObjectiveSignal::Progress).await;
    let (_, child) = f.run(&work.latest_task_id).await;
    f.finish(&child, ObjectiveSignal::Progress).await;
    // A replayed finish settles nothing more.
    f.finish(&child, ObjectiveSignal::Progress).await;
    let report: String = sqlx::query_scalar(
        "SELECT report_task_id FROM supertag_v2_work_session_reports WHERE child_task_id=$1",
    )
    .bind(&work.latest_task_id)
    .fetch_one(&f.pool)
    .await
    .unwrap();
    f.admitted(
        &report,
        6,
        &format!("report\n{}", work.latest_task_id),
        ALICE,
        ALICE,
    )
    .await;
    let (_, attempt) = f.run(&report).await;
    f.bound(&report).await;
    f.finish(&attempt, ObjectiveSignal::Progress).await;
    f.drain().await;
}

async fn cancel(f: &Fixture, objective_id: &str) {
    f.store
        .cancel_objective(
            ALICE,
            &ObjectiveActionRequest {
                objective_id: objective_id.into(),
                operation_id: format!("cancel-{objective_id}"),
                reason: "Done testing".into(),
            },
        )
        .await
        .unwrap();
}

#[tokio::test]
async fn sqlite_session_inputs_sources_contract() {
    let directory = tempfile::tempdir().unwrap();
    let url = format!(
        "sqlite://{}?mode=rwc",
        directory.path().join("sources.db").display()
    );
    contract(&url).await;
}

#[tokio::test]
#[ignore = "requires SUPERTAG_RUST_TEST_POSTGRES_URL_FILE for a dedicated PostgreSQL test server"]
async fn postgres_session_inputs_sources_contract() {
    let path = std::env::var_os("SUPERTAG_RUST_TEST_POSTGRES_URL_FILE")
        .expect("PostgreSQL test URL file required");
    let admin_url = std::fs::read_to_string(path).unwrap();
    let name = format!("supertag_rust_sources_{}", Uuid::new_v4().simple());
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
    outcome.expect("PostgreSQL session inputs sources contract failed");
}
