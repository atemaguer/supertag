//! Calmer surface delivery: a person's messages sent while a turn runs go into that turn, those
//! queued behind it are answered together by the next run, only the message that starts a run is
//! acknowledged, and a refused message is answered once.
mod support;

use sqlx::{Connection, Executor};
use std::sync::{
    Arc,
    atomic::{AtomicI64, Ordering},
};
use supertag_control_plane::{HostAuthority, Store};
use supertag_protocol::v2::*;
use uuid::Uuid;

const PRINCIPAL: &str = "connector:slack-test";
const OPERATOR: &str = "operator:alice";
const BASE: i64 = 1_790_000_000_000;
const ACKNOWLEDGEMENT: &str = "Got it. I’m looking into this now.";
const FOLLOWED: &str = "Got it. I’m looking into this now.\n\nAlso reading your follow-up.";

fn message(thread: &str, ts: &str, text: &str) -> AcceptSlackEventRequest {
    AcceptSlackEventRequest {
        account_id: "slack-test".into(),
        event_id: format!("Ev{}", ts.replace('.', "")),
        team_id: "TTEAM1".into(),
        channel_id: "CCHANNEL1".into(),
        message_ts: ts.into(),
        thread_ts: thread.into(),
        prompt: text.into(),
        mention_tag_id: (thread == ts).then(|| "builder".into()),
        actor_id: "UALICE1".into(),
    }
}

async fn send(store: &Store, thread: &str, ts: &str, text: &str) -> Task {
    store
        .accept_slack_event(PRINCIPAL, &message(thread, ts, text))
        .await
        .unwrap()
        .task
        .unwrap()
}

struct Run {
    assignment: Assignment,
}

impl Run {
    async fn claim(store: &Store, host: &HostAuthority, op: &str) -> Self {
        Self {
            assignment: store.claim_task(host, op).await.unwrap().unwrap(),
        }
    }

    fn task_id(&self) -> &str {
        &self.assignment.task.as_ref().unwrap().task_id
    }

    fn joined(&self) -> Vec<&str> {
        self.assignment
            .joined
            .iter()
            .map(|message| message.text.as_str())
            .collect()
    }

    fn attempt(&self) -> InspectAttemptRequest {
        InspectAttemptRequest {
            task_id: self.task_id().into(),
            attempt_id: self.assignment.attempt_id.clone(),
            lease_token: self.assignment.lease_token.clone(),
        }
    }

    async fn start(&self, store: &Store, host: &HostAuthority) {
        store
            .start_task(
                host,
                &StartTaskRequest {
                    task_id: self.task_id().into(),
                    attempt_id: self.assignment.attempt_id.clone(),
                    lease_token: self.assignment.lease_token.clone(),
                },
            )
            .await
            .unwrap();
    }

    async fn finish(&self, store: &Store, host: &HostAuthority) {
        store
            .finish_task(
                host,
                &FinishTaskRequest {
                    task_id: self.task_id().into(),
                    attempt_id: self.assignment.attempt_id.clone(),
                    lease_token: self.assignment.lease_token.clone(),
                    result: format!("Answer to {}", self.task_id()),
                    succeeded: true,
                    ..Default::default()
                },
            )
            .await
            .unwrap();
    }
}

/// The acknowledgement text of each Task that has one.
async fn acknowledgements(url: &str) -> Vec<(String, String)> {
    let mut connection = sqlx::AnyConnection::connect(url).await.unwrap();
    let rows =
        sqlx::query_as("SELECT task_id,text FROM supertag_v2_reply_progress ORDER BY ready_order")
            .fetch_all(&mut connection)
            .await
            .unwrap();
    connection.close().await.unwrap();
    rows
}

/// The Tasks and notices each reply answers, oldest first.
async fn replies(url: &str) -> Vec<(Option<String>, String)> {
    let mut connection = sqlx::AnyConnection::connect(url).await.unwrap();
    let rows = sqlx::query_as("SELECT task_id,text FROM supertag_v2_replies ORDER BY ready_order")
        .fetch_all(&mut connection)
        .await
        .unwrap();
    connection.close().await.unwrap();
    rows
}

async fn assert_joined(store: &Store, follower: &Task, answering: &str) {
    let stored = store.get_task(&follower.task_id).await.unwrap();
    assert_eq!(stored.state(), TaskState::Succeeded);
    assert_eq!(
        stored.result.as_deref(),
        Some(format!("Input accepted by Task {answering}.").as_str())
    );
}

async fn open(url: &str, clock: &Arc<AtomicI64>) -> Store {
    let clock = clock.clone();
    Store::open(url)
        .await
        .unwrap()
        .with_execution_clock(move || clock.load(Ordering::SeqCst))
}

async fn contract(url: String) {
    sqlx::any::install_default_drivers();
    let clock = Arc::new(AtomicI64::new(BASE));
    let store = open(&url, &clock).await;
    store
        .put_tag("builder", "Answer", vec!["files:read".into()])
        .await
        .unwrap();
    let host = support::register_host(&store, "worker").await;

    // Batch: three quick messages to an idle thread. Only the first is acknowledged; the claim
    // joins the other two, and one reply answers all three.
    let one = "1794470000.000001";
    let first = send(&store, one, one, "check why CI is red").await;
    let second = send(&store, one, "1794470000.000002", "also the flaky test").await;
    let third = send(&store, one, "1794470000.000003", "and open a PR").await;
    assert_eq!(
        acknowledgements(&url).await,
        [(first.task_id.clone(), ACKNOWLEDGEMENT.into())]
    );
    let run = Run::claim(&store, &host, "claim-one").await;
    assert_eq!(run.task_id(), first.task_id);
    assert_eq!(run.joined(), ["also the flaky test", "and open a PR"]);
    assert_joined(&store, &second, &first.task_id).await;
    assert_joined(&store, &third, &first.task_id).await;
    assert_eq!(
        acknowledgements(&url).await,
        [(first.task_id.clone(), FOLLOWED.into())]
    );
    // A lost claim response replays the same joined messages, also after a restart, and a
    // redelivered message still names its joined Task without new work.
    store.close().await;
    let store = open(&url, &clock).await;
    let replay = Run::claim(&store, &host, "claim-one").await;
    assert_eq!(replay.assignment, run.assignment);
    assert_eq!(
        store
            .accept_slack_event(
                PRINCIPAL,
                &message(one, "1794470000.000002", "also the flaky test")
            )
            .await
            .unwrap()
            .task
            .unwrap()
            .task_id,
        second.task_id
    );
    run.start(&store, &host).await;
    run.finish(&store, &host).await;
    assert_eq!(
        replies(&url).await,
        [(
            Some(first.task_id.clone()),
            format!("Answer to {}", first.task_id)
        )]
    );

    // Fold: a message sent while the turn runs is delivered into it as live input, with no
    // acknowledgement of its own, and the run's acknowledgement shows the follow-up.
    let two = "1794470001.000001";
    let lead = send(&store, two, two, "review the release notes").await;
    let run = Run::claim(&store, &host, "claim-two").await;
    assert!(run.joined().is_empty());
    run.start(&store, &host).await;
    let follow = send(&store, two, "1794470001.000002", "and the changelog").await;
    assert_eq!(follow.state(), TaskState::Queued);
    let input = store
        .take_input(
            &host,
            &TakeInputRequest {
                attempt: Some(run.attempt()),
            },
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(input.follower_task_id, follow.task_id);
    store
        .settle_input(
            &host,
            &SettleInputRequest {
                attempt: Some(run.attempt()),
                input_id: input.input_id,
                receipt: LiveInputReceipt::Accepted.into(),
            },
        )
        .await
        .unwrap();
    assert_joined(&store, &follow, &lead.task_id).await;
    let acknowledged = acknowledgements(&url).await;
    assert_eq!(acknowledged.len(), 2);
    assert_eq!(acknowledged[1], (lead.task_id.clone(), FOLLOWED.into()));
    run.finish(&store, &host).await;
    assert_eq!(replies(&url).await.len(), 2);

    // Fallback: a message the running harness never takes stays queued, and the next claim
    // answers it together with the message queued behind it.
    let three = "1794470002.000001";
    let lead = send(&store, three, three, "summarize the incident").await;
    let run = Run::claim(&store, &host, "claim-three").await;
    run.start(&store, &host).await;
    let missed = send(&store, three, "1794470002.000002", "include the timeline").await;
    run.finish(&store, &host).await;
    let later = send(&store, three, "1794470002.000003", "and the follow-ups").await;
    let next = Run::claim(&store, &host, "claim-four").await;
    assert_eq!(next.task_id(), missed.task_id);
    assert_eq!(next.joined(), ["and the follow-ups"]);
    assert_joined(&store, &later, &missed.task_id).await;
    let acknowledged = acknowledgements(&url).await;
    assert_eq!(
        acknowledged[2..],
        [
            (lead.task_id.clone(), ACKNOWLEDGEMENT.into()),
            (missed.task_id.clone(), FOLLOWED.into())
        ]
    );
    next.start(&store, &host).await;
    next.finish(&store, &host).await;
    assert_eq!(replies(&url).await.len(), 4);

    // An expired reservation keeps its joined messages for the next claim.
    let four = "1794470003.000001";
    send(&store, four, four, "first").await;
    send(&store, four, "1794470003.000002", "second").await;
    let reserved = Run::claim(&store, &host, "claim-five").await;
    assert_eq!(reserved.joined(), ["second"]);
    clock.fetch_add(10 * 60 * 1000, Ordering::SeqCst);
    let reclaimed = Run::claim(&store, &host, "claim-six").await;
    assert_eq!(reclaimed.task_id(), reserved.task_id());
    assert_ne!(
        reclaimed.assignment.attempt_id,
        reserved.assignment.attempt_id
    );
    assert_eq!(reclaimed.joined(), ["second"]);
    reclaimed.start(&store, &host).await;
    reclaimed.finish(&store, &host).await;

    // An internal turn between messages splits the batch, and so does a changed policy.
    let five = "1794470004.000001";
    let lead = send(&store, five, five, "one").await;
    let joined = send(&store, five, "1794470004.000002", "two").await;
    store
        .submit_task(
            OPERATOR,
            &SubmitTaskRequest {
                tag_id: "builder".into(),
                session_id: lead.session_id.clone(),
                operation_id: "internal".into(),
                prompt: "internal turn".into(),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    let after_internal = send(&store, five, "1794470004.000003", "three").await;
    store
        .put_tag("builder", "Answer differently", vec!["files:read".into()])
        .await
        .unwrap();
    let changed = send(&store, five, "1794470004.000004", "four").await;
    let mut order = Vec::new();
    for index in 0.. {
        let Some(assignment) = store
            .claim_task(&host, &format!("split-{index}"))
            .await
            .unwrap()
        else {
            break;
        };
        let run = Run { assignment };
        order.push((
            run.assignment.task.as_ref().unwrap().prompt.clone(),
            run.joined().join("|"),
        ));
        run.start(&store, &host).await;
        run.finish(&store, &host).await;
    }
    assert_eq!(
        order,
        [
            ("one".to_owned(), "two".to_owned()),
            ("internal turn".into(), String::new()),
            ("three".into(), String::new()),
            ("four".into(), String::new()),
        ]
    );
    assert_joined(&store, &joined, &lead.task_id).await;
    for alone in [&after_internal, &changed] {
        assert_eq!(
            store
                .get_task(&alone.task_id)
                .await
                .unwrap()
                .result
                .as_deref(),
            Some(format!("Answer to {}", alone.task_id).as_str())
        );
    }

    // A batch answers at most ten messages and 16 KiB of joined text.
    let six = "1794470005.000001";
    let lead = send(&store, six, six, "message 0").await;
    for index in 1..12 {
        send(
            &store,
            six,
            &format!("1794470005.{:06}", index + 1),
            &format!("message {index}"),
        )
        .await;
    }
    let run = Run::claim(&store, &host, "cap-messages").await;
    assert_eq!(run.task_id(), lead.task_id);
    assert_eq!(run.joined().len(), 9);
    run.start(&store, &host).await;
    run.finish(&store, &host).await;
    let run = Run::claim(&store, &host, "cap-messages-next").await;
    assert_eq!(run.assignment.task.as_ref().unwrap().prompt, "message 10");
    assert_eq!(run.joined(), ["message 11"]);
    run.start(&store, &host).await;
    run.finish(&store, &host).await;
    let seven = "1794470006.000001";
    let large = "x".repeat(6 * 1024);
    send(&store, seven, seven, "lead").await;
    for index in 0..3 {
        send(
            &store,
            seven,
            &format!("1794470006.{:06}", index + 2),
            &large,
        )
        .await;
    }
    let run = Run::claim(&store, &host, "cap-bytes").await;
    assert_eq!(run.joined().len(), 2);
    run.start(&store, &host).await;
    run.finish(&store, &host).await;
    let run = Run::claim(&store, &host, "cap-bytes-next").await;
    assert!(run.joined().is_empty());
    run.start(&store, &host).await;
    run.finish(&store, &host).await;

    // Conversations batch the same way, and show each joined message as taken in.
    let conversation: Vec<ConversationMessage> = {
        let mut sent = Vec::new();
        for text in ["first question", "second question", "third question"] {
            sent.push(
                store
                    .send_message(
                        OPERATOR,
                        &SendMessageRequest {
                            tag_id: "builder".into(),
                            operation_id: format!("send-{text}"),
                            text: text.into(),
                            ..Default::default()
                        },
                    )
                    .await
                    .unwrap(),
            );
        }
        sent
    };
    let run = Run::claim(&store, &host, "conversation").await;
    assert_eq!(
        run.task_id(),
        conversation[0].task.as_ref().unwrap().task_id
    );
    assert_eq!(run.joined(), ["second question", "third question"]);
    run.start(&store, &host).await;
    run.finish(&store, &host).await;
    let history = store
        .list_messages(
            OPERATOR,
            &ListMessagesRequest {
                tag_id: "builder".into(),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    let joined: Vec<_> = history
        .messages
        .iter()
        .filter_map(|message| message.live_input.as_ref())
        .map(|input| (input.task_id.as_str(), input.state()))
        .collect();
    assert_eq!(
        joined,
        [
            (run.task_id(), LiveInputState::Accepted),
            (run.task_id(), LiveInputState::Accepted)
        ]
    );
    // A Schedule firing into the conversation is the Tag's own turn: it splits the batch.
    let ask = |text: &'static str| SendMessageRequest {
        tag_id: "builder".into(),
        operation_id: format!("send-{text}"),
        text: text.into(),
        ..Default::default()
    };
    store
        .send_message(OPERATOR, &ask("before the Schedule"))
        .await
        .unwrap();
    store
        .create_schedule(
            OPERATOR,
            &CreateScheduleRequest {
                operation_id: "schedule".into(),
                tag_id: "builder".into(),
                note: "Check the deploy".into(),
                at: "1h".into(),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    clock.fetch_add(60 * 60 * 1000, Ordering::SeqCst);
    assert_eq!(store.sweep_schedules().await.unwrap(), 1);
    store
        .send_message(OPERATOR, &ask("after the Schedule"))
        .await
        .unwrap();
    let mut runs = Vec::new();
    for index in 0..3 {
        let run = Run::claim(&store, &host, &format!("scheduled-{index}")).await;
        runs.push((
            run.assignment.task.as_ref().unwrap().prompt.clone(),
            run.joined().len(),
        ));
        run.start(&store, &host).await;
        run.finish(&store, &host).await;
    }
    assert_eq!(runs[0], ("before the Schedule".into(), 0));
    assert!(runs[1].0.contains("Check the deploy"), "{runs:?}");
    assert_eq!(runs[1].1, 0);
    assert_eq!(runs[2], ("after the Schedule".into(), 0));
    assert!(
        store
            .claim_task(&host, "nothing-left")
            .await
            .unwrap()
            .is_none()
    );
    store.close().await;
}

#[tokio::test]
async fn sqlite_surface_delivery() {
    let dir = tempfile::tempdir().unwrap();
    contract(format!(
        "sqlite://{}?mode=rwc",
        dir.path().join("delivery.db").display()
    ))
    .await;
}

#[tokio::test]
#[ignore = "requires dedicated PostgreSQL server"]
async fn postgres_surface_delivery() {
    let path =
        std::env::var_os("SUPERTAG_RUST_TEST_POSTGRES_URL_FILE").expect("test database file");
    let admin_url = std::fs::read_to_string(path).unwrap();
    let mut url = url::Url::parse(admin_url.trim()).unwrap();
    let name = format!("supertag_surface_delivery_{}", Uuid::new_v4().simple());
    let mut admin = sqlx::PgConnection::connect(admin_url.trim()).await.unwrap();
    admin
        .execute(format!("CREATE DATABASE {name}").as_str())
        .await
        .unwrap();
    url.set_path(&name);
    let outcome = tokio::task::LocalSet::new()
        .run_until(async move { tokio::task::spawn_local(contract(url.to_string())).await })
        .await;
    admin
        .execute(format!("DROP DATABASE {name} WITH (FORCE)").as_str())
        .await
        .unwrap();
    admin.close().await.unwrap();
    outcome.expect("PostgreSQL surface delivery contract failed");
}
