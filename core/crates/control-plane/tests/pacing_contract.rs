//! Pacing: at most one unprompted post reaches a person's conversation or a surface thread in 30
//! minutes. Later ones are held, out of the conversation and posting nothing, then go out together
//! when the window ends, or at once when the person writes, before the Tag answers.
mod support;

use std::sync::{
    Arc,
    atomic::{AtomicI64, Ordering},
};

use sqlx::{Connection, Executor};
use supertag_control_plane::{HostAuthority, Store};
use supertag_protocol::v2::*;
use uuid::Uuid;

const ALICE: &str = "operator:alice";
const CONNECTOR: &str = "connector:acme";
const MINUTE: i64 = 60_000;
/// Sun 17 Mar 2030 17:46:40 UTC.
const NOW: i64 = 1_900_000_000_000;

async fn open(url: &str, clock: &Arc<AtomicI64>) -> Store {
    let clock = Arc::clone(clock);
    Store::open(url)
        .await
        .unwrap()
        .with_execution_clock(move || clock.load(Ordering::SeqCst))
        .with_time_zone("UTC")
        .unwrap()
}

/// Claims and starts the next queued Task.
async fn next(store: &Store, host: &HostAuthority) -> (Task, InspectAttemptRequest) {
    let claim = store
        .claim_task(host, &Uuid::new_v4().to_string())
        .await
        .unwrap()
        .expect("a queued Task");
    let task = claim.task.unwrap();
    let identity = InspectAttemptRequest {
        task_id: task.task_id.clone(),
        attempt_id: claim.attempt_id,
        lease_token: claim.lease_token,
    };
    store
        .start_task(
            host,
            &StartTaskRequest {
                task_id: identity.task_id.clone(),
                attempt_id: identity.attempt_id.clone(),
                lease_token: identity.lease_token.clone(),
            },
        )
        .await
        .unwrap();
    (task, identity)
}

async fn finish(
    store: &Store,
    host: &HostAuthority,
    identity: &InspectAttemptRequest,
    result: &str,
) -> Task {
    store
        .finish_task(
            host,
            &FinishTaskRequest {
                task_id: identity.task_id.clone(),
                attempt_id: identity.attempt_id.clone(),
                lease_token: identity.lease_token.clone(),
                result: result.into(),
                succeeded: true,
                ..Default::default()
            },
        )
        .await
        .unwrap()
}

/// Moves the clock to `minutes` past [`NOW`], fires the one due Schedule, and runs its turn.
async fn fire(
    store: &Store,
    host: &HostAuthority,
    clock: &Arc<AtomicI64>,
    minutes: i64,
    result: &str,
) -> Task {
    clock.store(NOW + minutes * MINUTE, Ordering::SeqCst);
    assert_eq!(store.sweep_schedules().await.unwrap(), 1);
    let (_, turn) = next(store, host).await;
    finish(store, host, &turn, result).await
}

async fn schedule(store: &Store, minutes: i64) {
    store
        .create_schedule(
            ALICE,
            &CreateScheduleRequest {
                operation_id: format!("check-{minutes}"),
                tag_id: "lead".into(),
                note: "Check CI".into(),
                at: format!("{minutes}m"),
                every: String::new(),
                time_zone: None,
            },
        )
        .await
        .unwrap();
}

async fn say(store: &Store, text: &str) -> ConversationMessage {
    store
        .send_message(
            ALICE,
            &SendMessageRequest {
                tag_id: "lead".into(),
                text: text.into(),
                operation_id: Uuid::new_v4().to_string(),
                ..Default::default()
            },
        )
        .await
        .unwrap()
}

async fn conversation(store: &Store) -> Conversation {
    store
        .list_conversations(ALICE, &ListConversationsRequest {})
        .await
        .unwrap()
        .conversations
        .into_iter()
        .find(|conversation| conversation.tag_id == "lead")
        .unwrap()
}

/// The conversation's messages, oldest first: each Task ID and its order.
async fn shown(store: &Store) -> Vec<(String, u64)> {
    let mut messages: Vec<(String, u64)> = store
        .list_messages(
            ALICE,
            &ListMessagesRequest {
                tag_id: "lead".into(),
                limit: 50,
                ..Default::default()
            },
        )
        .await
        .unwrap()
        .messages
        .into_iter()
        .map(|message| (message.task.unwrap().task_id, message.order))
        .collect();
    messages.sort_by_key(|(_, order)| *order);
    messages
}

fn ids(messages: &[(String, u64)]) -> Vec<&str> {
    messages.iter().map(|(id, _)| id.as_str()).collect()
}

async fn contract(url: String) {
    let clock = Arc::new(AtomicI64::new(NOW));
    let store = open(&url, &clock).await;
    let host = support::register_host(&store, "worker").await;
    store
        .put_tag(
            "lead",
            "Help",
            vec!["files:read".into(), "schedule:create".into()],
        )
        .await
        .unwrap();
    conversation_pacing(&store, &host, &clock).await;
    surface_pacing(&store, &host, &clock).await;
    store.close().await;
}

async fn conversation_pacing(store: &Store, host: &HostAuthority, clock: &Arc<AtomicI64>) {
    let hello = say(store, "Watch CI for me").await;
    let (_, turn) = next(store, host).await;
    finish(store, host, &turn, "I'll keep an eye on it.").await;
    store
        .mark_conversation_read(
            ALICE,
            &MarkConversationReadRequest {
                tag_id: "lead".into(),
                order: hello.order,
            },
        )
        .await
        .unwrap();
    for minutes in [10, 20, 25, 45] {
        schedule(store, minutes).await;
    }

    // The first unprompted post goes out at once.
    let first = fire(store, host, clock, 10, "CI is red on main.").await;
    assert_eq!(
        ids(&shown(store).await).last(),
        Some(&first.task_id.as_str())
    );
    assert_eq!(conversation(store).await.unread_count, 1);

    // Two more within 30 minutes wait: not shown, not unread, not the preview.
    let second = fire(
        store,
        host,
        clock,
        20,
        "CI is still red.\nThe flaky test failed again.",
    )
    .await;
    let third = fire(store, host, clock, 25, "CI is green again.").await;
    let messages = shown(store).await;
    assert!(!ids(&messages).contains(&second.task_id.as_str()));
    assert!(!ids(&messages).contains(&third.task_id.as_str()));
    let listed = conversation(store).await;
    assert_eq!(listed.unread_count, 1);
    assert_eq!(listed.preview, "CI is red on main.");
    // A client refreshing a turn it holds does not get the held one either.
    let refreshed = store
        .list_messages(
            ALICE,
            &ListMessagesRequest {
                tag_id: "lead".into(),
                limit: 50,
                refresh_task_ids: vec![second.task_id.clone()],
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert!(
        !refreshed
            .messages
            .iter()
            .any(|message| message.task.as_ref().unwrap().task_id == second.task_id)
    );

    // Before the window ends nothing goes out; at its end both go out, as the newest messages.
    clock.store(NOW + 39 * MINUTE, Ordering::SeqCst);
    assert_eq!(store.sweep_attention().await.unwrap(), 0);
    clock.store(NOW + 40 * MINUTE, Ordering::SeqCst);
    assert_eq!(store.sweep_attention().await.unwrap(), 1);
    let messages = shown(store).await;
    let tail: Vec<&str> = ids(&messages).into_iter().rev().take(3).collect();
    assert_eq!(
        tail,
        [
            third.task_id.as_str(),
            second.task_id.as_str(),
            first.task_id.as_str()
        ]
    );
    let listed = conversation(store).await;
    assert_eq!(listed.unread_count, 3);
    assert_eq!(listed.preview, "CI is green again.");

    // The next fire falls in the window the release opened, so it waits; a message from the
    // person releases it at once, ahead of their own message.
    let fourth = fire(store, host, clock, 45, "CI is red again.").await;
    assert!(!ids(&shown(store).await).contains(&fourth.task_id.as_str()));
    let asked = say(store, "What's the state of CI?").await;
    let messages = shown(store).await;
    let position = |id: &str| ids(&messages).iter().position(|shown| *shown == id);
    assert!(
        position(&fourth.task_id).unwrap()
            < position(&asked.task.as_ref().unwrap().task_id).unwrap(),
        "{messages:?}"
    );
    let (_, turn) = next(store, host).await;
    finish(store, host, &turn, "Red: the flaky test again.").await;

    let summary = store.get_tag("lead").await.unwrap().attention.unwrap();
    assert_eq!((summary.posted, summary.quiet), (4, 0));
}

async fn surface_pacing(store: &Store, host: &HostAuthority, clock: &Arc<AtomicI64>) {
    clock.store(NOW + 2 * 60 * MINUTE, Ordering::SeqCst);
    let accepted = store
        .accept_event(
            CONNECTOR,
            &AcceptEventRequest {
                account_id: "acme".into(),
                event_id: "message-1".into(),
                tag_id: "lead".into(),
                session_id: "slack-thread".into(),
                prompt: "Watch the deploy".into(),
                destination: Some(ReplyDestination {
                    conversation_id: "channel".into(),
                    thread_id: Some("thread".into()),
                }),
                requested_execution: None,
            },
        )
        .await
        .unwrap();
    let (task, turn) = next(store, host).await;
    assert_eq!(task.task_id, accepted.task_id);
    for (operation, at) in [
        ("deploy-1", "10m"),
        ("deploy-2", "15m"),
        ("deploy-3", "20m"),
    ] {
        store
            .create_attempt_schedule(
                &supertag_control_plane::AttemptAccess::new(host, &turn),
                &CreateAttemptScheduleRequest {
                    operation_id: operation.into(),
                    note: "Check the deploy".into(),
                    at: at.into(),
                    every: String::new(),
                    time_zone: None,
                },
            )
            .await
            .unwrap();
    }
    finish(store, host, &turn, "Will do").await;
    deliver(store, "delivery-1", "Will do").await;

    // The first check posts; the next two in its window wait and post nothing.
    fire(store, host, clock, 130, "Deploy is at 40%.").await;
    deliver(store, "delivery-2", "Deploy is at 40%.").await;
    fire(
        store,
        host,
        clock,
        135,
        "Deploy is at 80%.\nNo errors so far.",
    )
    .await;
    fire(
        store,
        host,
        clock,
        140,
        "Deploy finished. Error rate is normal.",
    )
    .await;
    assert!(
        store
            .claim_reply(CONNECTOR, "delivery-3")
            .await
            .unwrap()
            .reply
            .is_none()
    );

    // The person writes in the thread: when their turn starts, the held checks post as one reply,
    // the newest in full under the earlier one's first line, before the Tag's answer.
    store
        .accept_event(
            CONNECTOR,
            &AcceptEventRequest {
                account_id: "acme".into(),
                event_id: "message-2".into(),
                tag_id: "lead".into(),
                session_id: "slack-thread".into(),
                prompt: "Is it done?".into(),
                destination: Some(ReplyDestination {
                    conversation_id: "channel".into(),
                    thread_id: Some("thread".into()),
                }),
                requested_execution: None,
            },
        )
        .await
        .unwrap();
    let (_, turn) = next(store, host).await;
    deliver(
        store,
        "delivery-4",
        "1 earlier update from lead:\n• Deploy is at 80%.\n\nDeploy finished. Error rate is normal.",
    )
    .await;
    finish(store, host, &turn, "Yes, it finished.").await;
    deliver(store, "delivery-5", "Yes, it finished.").await;
}

/// Claims the next reply, checks its text, and settles it delivered. Acknowledgements of a
/// person's message come first and are settled on the way.
async fn deliver(store: &Store, operation: &str, text: &str) {
    for attempt in 0..5 {
        let claim = store
            .claim_reply(CONNECTOR, &format!("{operation}-{attempt}"))
            .await
            .unwrap();
        let reply = claim.reply.expect("a reply to deliver");
        store
            .settle_reply(
                CONNECTOR,
                &SettleReplyRequest {
                    reply_id: reply.reply_id.clone(),
                    lease_token: claim.lease_token,
                    state: ReplyState::Delivered as i32,
                    provider_receipt: Some(format!("1.{attempt}")),
                },
            )
            .await
            .unwrap();
        if reply.text == text {
            return;
        }
        assert!(
            reply.text != "Will do" || text == "Will do",
            "unexpected reply {:?}, wanted {text:?}",
            reply.text
        );
    }
    panic!("no reply {text:?}");
}

#[tokio::test]
async fn sqlite_pacing_contract() {
    let directory = tempfile::tempdir().unwrap();
    contract(format!(
        "sqlite://{}?mode=rwc",
        directory.path().join("pacing.db").display()
    ))
    .await;
}

#[tokio::test]
#[ignore = "requires SUPERTAG_RUST_TEST_POSTGRES_URL_FILE for a dedicated PostgreSQL server"]
async fn postgres_pacing_contract() {
    let path = std::env::var_os("SUPERTAG_RUST_TEST_POSTGRES_URL_FILE")
        .expect("PostgreSQL test URL file required");
    let admin_url = std::fs::read_to_string(path).unwrap();
    let name = format!("supertag_pacing_{}", Uuid::new_v4().simple());
    let mut admin = sqlx::PgConnection::connect(admin_url.trim()).await.unwrap();
    admin
        .execute(format!("CREATE DATABASE {name}").as_str())
        .await
        .unwrap();
    let mut url = url::Url::parse(admin_url.trim()).unwrap();
    url.set_path(&name);
    let result = tokio::task::LocalSet::new()
        .run_until(async move {
            tokio::task::spawn_local(async move { contract(url.to_string()).await }).await
        })
        .await;
    admin
        .execute(format!("DROP DATABASE {name} WITH (FORCE)").as_str())
        .await
        .unwrap();
    admin.close().await.unwrap();
    result.expect("PostgreSQL pacing contract failed");
}
