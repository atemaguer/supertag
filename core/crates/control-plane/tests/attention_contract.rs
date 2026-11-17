//! Quiet results and attention: a turn no person waits on may finish quietly, posting nothing to
//! its conversation or surface thread and raising no unread; a person's message is always
//! answered; and a Tag's unprompted messages are counted as posted, read, answered, or quiet.
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
const HOUR: i64 = 60 * MINUTE;
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
    quiet: bool,
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
                quiet,
                ..Default::default()
            },
        )
        .await
        .unwrap()
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

async fn shown(store: &Store) -> Vec<String> {
    store
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
        .map(|message| message.task.unwrap().task_id)
        .collect()
}

async fn attention(store: &Store) -> AttentionSummary {
    store.get_tag("lead").await.unwrap().attention.unwrap()
}

fn counts(summary: &AttentionSummary) -> (u32, u32, u32, u32) {
    (
        summary.posted,
        summary.read,
        summary.answered,
        summary.quiet,
    )
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
    conversation_fires(&store, &host, &clock).await;
    surface_fires(&store, &host, &clock).await;
    store.close().await;
}

async fn conversation_fires(store: &Store, host: &HostAuthority, clock: &Arc<AtomicI64>) {
    // A person's message is always answered, even when the harness asks to stay quiet.
    let hello = say(store, "Hello").await;
    let (_, turn) = next(store, host).await;
    let caps = store.attempt_capabilities(host, &turn).await.unwrap();
    assert!(!caps.may_stay_quiet);
    let answered = finish(store, host, &turn, "Hi", true).await;
    assert!(!answered.quiet);
    let listed = conversation(store).await;
    assert_eq!((listed.unread_count, listed.preview.as_str()), (1, "Hi"));
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
    assert_eq!(counts(&attention(store).await), (0, 0, 0, 0));

    let schedule = store
        .create_schedule(
            ALICE,
            &CreateScheduleRequest {
                operation_id: "check-ci".into(),
                tag_id: "lead".into(),
                note: "Check CI".into(),
                at: String::new(),
                every: "@hourly".into(),
                time_zone: None,
            },
        )
        .await
        .unwrap();

    // A check that finds nothing stays quiet: no message, no unread, but its Task is recorded.
    clock.store(NOW + HOUR, Ordering::SeqCst);
    assert_eq!(store.sweep_schedules().await.unwrap(), 1);
    let (fired, turn) = next(store, host).await;
    assert!(fired.prompt.contains("call stay_quiet"), "{}", fired.prompt);
    assert!(!fired.prompt.contains("Of this Schedule's last"));
    assert!(
        store
            .attempt_capabilities(host, &turn)
            .await
            .unwrap()
            .may_stay_quiet
    );
    // While it runs, the conversation shows the turn, as a client may hold it.
    let running = store
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
        .find(|message| message.task.as_ref().unwrap().task_id == fired.task_id)
        .expect("the running turn");
    let quiet = finish(store, host, &turn, "", true).await;
    assert!(quiet.quiet && quiet.state() == TaskState::Succeeded);
    assert!(!shown(store).await.contains(&quiet.task_id));
    let listed = conversation(store).await;
    assert_eq!(listed.unread_count, 0);
    assert_eq!(listed.latest_order, hello.order);
    assert_eq!(listed.preview, "Hi");
    assert!(!listed.working);
    // A client holding the turn as unfinished learns it ended quietly, and drops it.
    let refreshed = store
        .list_messages(
            ALICE,
            &ListMessagesRequest {
                tag_id: "lead".into(),
                limit: 50,
                after: running.order,
                conversation_id: listed.conversation_id.clone(),
                refresh_task_ids: vec![quiet.task_id.clone()],
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert!(refreshed.incremental);
    let refreshed: Vec<_> = refreshed
        .messages
        .iter()
        .filter_map(|message| message.task.as_ref())
        .collect();
    assert_eq!(refreshed.len(), 1);
    assert!(refreshed[0].quiet && refreshed[0].task_id == quiet.task_id);
    // The Schedule still records the turn it ran.
    let read = store
        .get_schedule(ALICE, &schedule.schedule_id)
        .await
        .unwrap();
    assert_eq!(read.last_task_id.as_deref(), Some(quiet.task_id.as_str()));
    assert_eq!(counts(&attention(store).await), (0, 0, 0, 1));

    // A check that finds something posts, and the next fire's prompt says how the last went.
    clock.store(NOW + 2 * HOUR, Ordering::SeqCst);
    assert_eq!(store.sweep_schedules().await.unwrap(), 1);
    let (fired, turn) = next(store, host).await;
    assert!(
        fired.prompt.contains(
            "Of this Schedule's last 1 fire: 0 posted (0 read, 0 answered); 1 stayed quiet."
        ),
        "{}",
        fired.prompt
    );
    let posted = finish(store, host, &turn, "CI is red on main", false).await;
    assert!(!posted.quiet);
    assert!(shown(store).await.contains(&posted.task_id));
    let listed = conversation(store).await;
    assert_eq!(
        (listed.unread_count, listed.preview.as_str()),
        (1, "CI is red on main")
    );
    assert_eq!(counts(&attention(store).await), (1, 0, 0, 1));

    // Alice reads it, then answers within a day.
    store
        .mark_conversation_read(
            ALICE,
            &MarkConversationReadRequest {
                tag_id: "lead".into(),
                order: listed.latest_order,
            },
        )
        .await
        .unwrap();
    assert_eq!(counts(&attention(store).await), (1, 1, 0, 1));
    clock.store(NOW + 2 * HOUR + 10 * MINUTE, Ordering::SeqCst);
    say(store, "Which job?").await;
    let (_, turn) = next(store, host).await;
    finish(store, host, &turn, "The lint job", false).await;
    assert_eq!(
        attention(store).await,
        AttentionSummary {
            posted: 1,
            read: 1,
            answered: 1,
            quiet: 1,
            window_days: 30,
        }
    );
    clock.store(NOW + 3 * HOUR, Ordering::SeqCst);
    assert_eq!(store.sweep_schedules().await.unwrap(), 1);
    let (fired, turn) = next(store, host).await;
    assert!(
        fired.prompt.contains(
            "Of this Schedule's last 2 fires: 1 posted (1 read, 1 answered); 1 stayed quiet."
        ),
        "{}",
        fired.prompt
    );
    finish(store, host, &turn, "", true).await;
    store
        .change_schedule(ALICE, &schedule.schedule_id, ScheduleState::Cancelled)
        .await
        .unwrap();
}

async fn surface_fires(store: &Store, host: &HostAuthority, clock: &Arc<AtomicI64>) {
    clock.store(NOW + 4 * HOUR, Ordering::SeqCst);
    let accepted = store
        .accept_event(
            CONNECTOR,
            &AcceptEventRequest {
                account_id: "acme".into(),
                event_id: "message-1".into(),
                tag_id: "lead".into(),
                session_id: "slack-thread".into(),
                prompt: "Watch the deploy every two hours".into(),
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
    store
        .create_attempt_schedule(
            host,
            &CreateAttemptScheduleRequest {
                attempt: Some(turn.clone()),
                operation_id: "watch-deploy".into(),
                note: "Check the deploy".into(),
                at: "2h".into(),
                every: String::new(),
                time_zone: None,
            },
        )
        .await
        .unwrap();
    // A surface message is a person's: it posts in its thread.
    assert!(!finish(store, host, &turn, "Will do", true).await.quiet);
    let claim = store.claim_reply(CONNECTOR, "delivery-1").await.unwrap();
    let reply = claim.reply.expect("the person's reply");
    assert_eq!(reply.text, "Will do");
    store
        .settle_reply(
            CONNECTOR,
            &SettleReplyRequest {
                reply_id: reply.reply_id,
                lease_token: claim.lease_token,
                state: ReplyState::Delivered as i32,
                provider_receipt: Some("1.0001".into()),
            },
        )
        .await
        .unwrap();

    // The thread's Schedule fires; finding nothing, it posts nothing in the thread.
    clock.store(NOW + 6 * HOUR + MINUTE, Ordering::SeqCst);
    assert_eq!(store.sweep_schedules().await.unwrap(), 1);
    let (fired, turn) = next(store, host).await;
    assert_eq!(fired.session_id, "slack-thread");
    assert!(
        store
            .attempt_capabilities(host, &turn)
            .await
            .unwrap()
            .may_stay_quiet
    );
    assert!(
        finish(store, host, &turn, "Deploy is healthy", true)
            .await
            .quiet
    );
    assert!(
        store
            .claim_reply(CONNECTOR, "delivery-2")
            .await
            .unwrap()
            .reply
            .is_none()
    );
    let summary = attention(store).await;
    assert_eq!((summary.posted, summary.quiet), (1, 3));
}

#[tokio::test]
async fn sqlite_attention_contract() {
    let directory = tempfile::tempdir().unwrap();
    contract(format!(
        "sqlite://{}?mode=rwc",
        directory.path().join("attention.db").display()
    ))
    .await;
}

#[tokio::test]
#[ignore = "requires SUPERTAG_RUST_TEST_POSTGRES_URL_FILE for a dedicated PostgreSQL server"]
async fn postgres_attention_contract() {
    let path = std::env::var_os("SUPERTAG_RUST_TEST_POSTGRES_URL_FILE")
        .expect("PostgreSQL test URL file required");
    let admin_url = std::fs::read_to_string(path).unwrap();
    let name = format!("supertag_attention_{}", Uuid::new_v4().simple());
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
    result.expect("PostgreSQL attention contract failed");
}
