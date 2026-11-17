mod support;

use std::time::{Duration, Instant};

use sqlx::{Connection, Executor};
use supertag_control_plane::Store;
use supertag_protocol::v2::*;
use tokio_stream::{Stream, StreamExt};
use tonic::Status;
use uuid::Uuid;

const ALICE: &str = "operator:alice";
const BOB: &str = "operator:bob";
/// Less than the follow's unsignalled recheck, so a change arriving within it was pushed.
const PUSHED: Duration = Duration::from_millis(1_000);

fn send(text: &str, operation: &str) -> SendMessageRequest {
    SendMessageRequest {
        tag_id: "engineer".into(),
        text: text.into(),
        operation_id: operation.into(),
        ..Default::default()
    }
}

fn follow(after: u64, conversation_id: &str) -> FollowConversationRequest {
    FollowConversationRequest {
        tag_id: "engineer".into(),
        conversation_id: conversation_id.into(),
        after,
        refresh_task_ids: vec![],
    }
}

async fn next(
    stream: &mut (impl Stream<Item = Result<FollowConversationResponse, Status>> + Unpin),
    within: Duration,
) -> Option<FollowConversationResponse> {
    match tokio::time::timeout(within, stream.next()).await {
        Ok(Some(response)) => Some(response.unwrap()),
        Ok(None) => panic!("the follow ended"),
        Err(_) => None,
    }
}

/// The next response that changes messages, skipping responses that only say why turns wait.
async fn next_messages(
    stream: &mut (impl Stream<Item = Result<FollowConversationResponse, Status>> + Unpin),
    within: Duration,
) -> ListMessagesResponse {
    let deadline = Instant::now() + within;
    loop {
        let left = deadline.saturating_duration_since(Instant::now());
        let response = next(stream, left)
            .await
            .expect("no change was pushed in time");
        if let Some(messages) = response.messages {
            return messages;
        }
    }
}

fn task(page: &ListMessagesResponse) -> &Task {
    page.messages[0].task.as_ref().unwrap()
}

async fn exercise(database: &str) {
    let store = Store::open(database).await.unwrap();
    store
        .put_tag("engineer", "Process this request", vec![])
        .await
        .unwrap();

    // A client without a copy and without a conversation opens with an empty response.
    let mut alice = store
        .follow_conversation(ALICE, follow(0, ""))
        .await
        .unwrap();
    let opened = next(&mut alice, PUSHED).await.unwrap();
    assert_eq!(opened, FollowConversationResponse::default());

    // A sent message is pushed at once, as the newest page of the new conversation.
    let sent = store
        .send_message(ALICE, &send("Fix the build", "first"))
        .await
        .unwrap();
    let sent_task = sent.task.clone().unwrap();
    let page = next_messages(&mut alice, PUSHED).await;
    assert!(!page.incremental);
    assert_eq!(page.conversation_id, sent_task.session_id);
    assert_eq!(page.messages.len(), 1);
    assert_eq!(task(&page).task_id, sent_task.task_id);
    assert_eq!(task(&page).state(), TaskState::Queued);

    // Another principal's conversation with the Tag changes nothing Alice follows.
    store
        .send_message(BOB, &send("Bob's question", "bob"))
        .await
        .unwrap();
    // With no Worker Host bound, a turn that stays queued says why, after a moment.
    let waited = next(&mut alice, Duration::from_secs(5)).await.unwrap();
    assert_eq!(waited.messages, None);
    assert_eq!(waited.waits.len(), 1);
    assert_eq!(waited.waits[0].task_id, sent_task.task_id);
    assert!(
        waited.waits[0].reason.contains("No Worker Host"),
        "{:?}",
        waited.waits
    );
    // Claiming, starting, each event and the result are pushed as they commit.
    let host = support::register_host(&store, "follow-host").await;
    let assignment = store
        .claim_task(&host, "follow-claim")
        .await
        .unwrap()
        .unwrap();
    let claimed = next_messages(&mut alice, PUSHED).await;
    assert!(claimed.incremental);
    assert_eq!(task(&claimed).state(), TaskState::Claimed);
    store
        .start_task(
            &host,
            &StartTaskRequest {
                task_id: sent_task.task_id.clone(),
                attempt_id: assignment.attempt_id.clone(),
                lease_token: assignment.lease_token.clone(),
            },
        )
        .await
        .unwrap();
    assert_eq!(
        task(&next_messages(&mut alice, PUSHED).await).state(),
        TaskState::Running
    );
    let append = |sequence: u64, kind: TaskEventKind, text: &str| AppendEventRequest {
        task_id: sent_task.task_id.clone(),
        attempt_id: assignment.attempt_id.clone(),
        lease_token: assignment.lease_token.clone(),
        sequence,
        text: text.into(),
        kind: kind as i32,
    };
    for (sequence, kind, text) in [
        (1, TaskEventKind::Message, "I'll look at the build."),
        (2, TaskEventKind::Activity, "Running cargo test"),
    ] {
        let at = Instant::now();
        store
            .append_event(&host, &append(sequence, kind, text))
            .await
            .unwrap();
        let page = next_messages(&mut alice, PUSHED).await;
        assert!(at.elapsed() < PUSHED);
        let events = &page.messages[0].events;
        assert_eq!(events.last().unwrap().sequence, sequence);
        assert_eq!(events.last().unwrap().text, text);
    }
    // The text of the message being written is pushed as it changes, never stored, and goes
    // with its message once that is recorded.
    let text = |revision: u64, after_sequence: u64, text: &str| PublishTaskTextRequest {
        task_id: sent_task.task_id.clone(),
        attempt_id: assignment.attempt_id.clone(),
        lease_token: assignment.lease_token.clone(),
        after_sequence,
        revision,
        text: text.into(),
    };
    let next_texts = async |stream: &mut _| {
        let response: FollowConversationResponse =
            next(stream, PUSHED).await.expect("no text was pushed");
        response.texts
    };
    store
        .publish_text(&host, &text(1, 2, "The build "))
        .await
        .unwrap();
    let pushed = next_texts(&mut alice).await;
    assert_eq!(
        pushed,
        [TurnText {
            task_id: sent_task.task_id.clone(),
            after_sequence: 2,
            text: "The build ".into()
        }]
    );
    store
        .publish_text(&host, &text(2, 2, "The build passes "))
        .await
        .unwrap();
    assert_eq!(next_texts(&mut alice).await[0].text, "The build passes ");
    // An older revision, or text after an earlier event, changes nothing.
    store.publish_text(&host, &text(1, 2, "The")).await.unwrap();
    store
        .publish_text(&host, &text(3, 1, "Stale"))
        .await
        .unwrap();
    assert_eq!(next(&mut alice, Duration::from_millis(300)).await, None);
    store
        .append_event(
            &host,
            &append(3, TaskEventKind::Message, "The build passes."),
        )
        .await
        .unwrap();
    let recorded = next(&mut alice, PUSHED).await.unwrap();
    assert_eq!(
        recorded.messages.unwrap().messages[0]
            .events
            .last()
            .unwrap()
            .text,
        "The build passes."
    );
    assert_eq!(
        recorded.texts,
        [TurnText {
            task_id: sent_task.task_id.clone(),
            after_sequence: 0,
            text: String::new()
        }]
    );
    // Text of a recorded message, sent late, is not shown again.
    store
        .publish_text(&host, &text(3, 2, "The build passes."))
        .await
        .unwrap();
    assert_eq!(next(&mut alice, Duration::from_millis(300)).await, None);
    // Only a running Attempt's host may show text.
    let other = support::register_host(&store, "other-host").await;
    assert!(
        store
            .publish_text(&other, &text(4, 3, "Not mine"))
            .await
            .is_err()
    );

    store
        .finish_task(
            &host,
            &FinishTaskRequest {
                task_id: sent_task.task_id.clone(),
                attempt_id: assignment.attempt_id.clone(),
                lease_token: assignment.lease_token.clone(),
                result: "The build passes.".into(),
                succeeded: true,
                ..Default::default()
            },
        )
        .await
        .unwrap();
    let finished = next_messages(&mut alice, PUSHED).await;
    assert_eq!(task(&finished).state(), TaskState::Succeeded);
    assert_eq!(task(&finished).result.as_deref(), Some("The build passes."));
    let order = finished.messages[0].order;

    // A reconnecting client with a current copy is told nothing changed.
    let mut again = store
        .follow_conversation(ALICE, follow(order, &sent_task.session_id))
        .await
        .unwrap();
    assert_eq!(
        next(&mut again, PUSHED).await.unwrap(),
        FollowConversationResponse::default()
    );
    // And with a copy from an older order, it gets what it missed.
    let mut behind = store
        .follow_conversation(ALICE, follow(order - 1, &sent_task.session_id))
        .await
        .unwrap();
    let missed = next_messages(&mut behind, PUSHED).await;
    assert!(missed.incremental);
    assert_eq!(task(&missed).task_id, sent_task.task_id);

    // A request ListMessages refuses is refused before the stream opens.
    assert!(
        store
            .follow_conversation(
                ALICE,
                FollowConversationRequest {
                    tag_id: String::new(),
                    ..Default::default()
                }
            )
            .await
            .is_err()
    );

    // Draining ends every follow.
    store.close_follows();
    let ended = tokio::time::timeout(PUSHED, alice.next())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(ended.unwrap_err().code(), tonic::Code::Unavailable);
    store.close().await;
}

#[tokio::test]
async fn sqlite_conversation_follow_contract() {
    exercise("sqlite::memory:").await;
}

#[tokio::test]
#[ignore = "requires SUPERTAG_RUST_TEST_POSTGRES_URL_FILE for a dedicated PostgreSQL test server"]
async fn postgres_conversation_follow_contract() {
    let path = std::env::var_os("SUPERTAG_RUST_TEST_POSTGRES_URL_FILE")
        .expect("PostgreSQL test URL file required");
    let admin_url = std::fs::read_to_string(path).unwrap();
    let database = format!("supertag_rust_follow_{}", Uuid::new_v4().simple());
    let mut admin = sqlx::PgConnection::connect(admin_url.trim()).await.unwrap();
    admin
        .execute(format!("CREATE DATABASE {database}").as_str())
        .await
        .unwrap();
    let mut url = url::Url::parse(admin_url.trim()).unwrap();
    url.set_path(&database);
    let local = tokio::task::LocalSet::new();
    let result = local
        .run_until(async move {
            tokio::task::spawn_local(async move { exercise(url.as_str()).await }).await
        })
        .await;
    admin
        .execute(format!("DROP DATABASE {database} WITH (FORCE)").as_str())
        .await
        .unwrap();
    result.unwrap();
}
