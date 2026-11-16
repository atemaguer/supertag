mod support;

use sqlx::{Connection, Executor};
use supertag_control_plane::{Store, StoreError};
use supertag_protocol::v2::*;
use uuid::Uuid;

const ALICE: &str = "operator:alice";
const BOB: &str = "operator:bob";

fn send(text: &str, operation: &str) -> SendMessageRequest {
    SendMessageRequest {
        output_policy: None,
        execution_limits: None,
        tag_id: "engineer".into(),
        text: text.into(),
        operation_id: operation.into(),
    }
}

fn history(cursor: String) -> ListMessagesRequest {
    ListMessagesRequest {
        tag_id: "engineer".into(),
        limit: 1,
        cursor,
        ..Default::default()
    }
}

async fn exercise(database: &str) {
    let store = Store::open(database).await.unwrap();
    for tag in ["engineer", "writer"] {
        store
            .put_tag(tag, "Process this request", vec![])
            .await
            .unwrap();
    }
    let page = store
        .list_tags(
            "operator:local",
            &ListTagsRequest {
                limit: 1,
                cursor: String::new(),
                include_retired: false,
            },
        )
        .await
        .unwrap();
    assert_eq!(page.tags[0].tag_id, "engineer");
    let last = store
        .list_tags(
            "operator:local",
            &ListTagsRequest {
                limit: 1,
                cursor: page.next_cursor,
                include_retired: false,
            },
        )
        .await
        .unwrap();
    assert_eq!(last.tags[0].tag_id, "writer");
    assert!(last.next_cursor.is_empty());

    let first = send("Alice first", "same-operation");
    let (created, replay) = tokio::join!(
        store.send_message(ALICE, &first),
        store.send_message(ALICE, &first)
    );
    let created = created.unwrap();
    assert_eq!(replay.unwrap(), created);
    assert!(created.live_input.is_none());
    let alice = created.task.unwrap();
    let bob = store
        .send_message(BOB, &send("Bob private", "same-operation"))
        .await
        .unwrap()
        .task
        .unwrap();
    assert_ne!(alice.session_id, bob.session_id);
    assert!(matches!(
        store
            .send_message(ALICE, &send("Different text", "same-operation"))
            .await,
        Err(StoreError::Conflict(_))
    ));
    assert!(matches!(
        store.get_message(BOB, "engineer", &alice.task_id).await,
        Err(StoreError::NotFound(_))
    ));
    assert_eq!(
        store
            .list_messages(BOB, &history(String::new()))
            .await
            .unwrap()
            .messages[0]
            .task
            .as_ref()
            .unwrap()
            .task_id,
        bob.task_id
    );

    let host = support::register_host(&store, "conversation-host").await;
    let assignment = store
        .claim_task(&host, "conversation-claim")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(assignment.task.unwrap().task_id, alice.task_id);
    let attempt = InspectAttemptRequest {
        task_id: alice.task_id.clone(),
        attempt_id: assignment.attempt_id,
        lease_token: assignment.lease_token,
    };
    store
        .start_task(
            &host,
            &StartTaskRequest {
                task_id: attempt.task_id.clone(),
                attempt_id: attempt.attempt_id.clone(),
                lease_token: attempt.lease_token.clone(),
            },
        )
        .await
        .unwrap();

    // A message carries what its turn shows: each message the Tag wrote and its latest activity
    // or plan, so a history page needs no further reads.
    let events = [
        (TaskEventKind::Message, "Looking at the build."),
        (TaskEventKind::Activity, "Ran cargo test"),
        (TaskEventKind::Progress, "{\"type\":\"progress.updated\"}"),
        (TaskEventKind::Message, "Found the failing test."),
        (TaskEventKind::Activity, "Edited src/lib.rs"),
        (TaskEventKind::Activity, "Ran cargo test again"),
    ];
    for (index, (kind, text)) in events.iter().enumerate() {
        store
            .append_event(
                &host,
                &AppendEventRequest {
                    task_id: attempt.task_id.clone(),
                    attempt_id: attempt.attempt_id.clone(),
                    lease_token: attempt.lease_token.clone(),
                    sequence: index as u64 + 1,
                    text: (*text).into(),
                    kind: *kind as i32,
                },
            )
            .await
            .unwrap();
    }
    let shown = |message: &ConversationMessage| {
        message
            .events
            .iter()
            .map(|event| (event.sequence, event.text.clone()))
            .collect::<Vec<_>>()
    };
    let expected = vec![
        (1, "Looking at the build.".to_owned()),
        (4, "Found the failing test.".to_owned()),
        (6, "Ran cargo test again".to_owned()),
    ];
    let listed = store
        .list_messages(ALICE, &history(String::new()))
        .await
        .unwrap();
    assert_eq!(shown(&listed.messages[0]), expected);
    assert!(!listed.messages[0].events_truncated);
    let read = store
        .get_message(ALICE, "engineer", &alice.task_id)
        .await
        .unwrap();
    assert_eq!(shown(&read), expected);
    // Messages past the page's share are left out, earliest first, and flagged.
    let long = "y".repeat(16_000);
    for sequence in 7..=16 {
        store
            .append_event(
                &host,
                &AppendEventRequest {
                    task_id: attempt.task_id.clone(),
                    attempt_id: attempt.attempt_id.clone(),
                    lease_token: attempt.lease_token.clone(),
                    sequence,
                    text: long.clone(),
                    kind: TaskEventKind::Message as i32,
                },
            )
            .await
            .unwrap();
    }
    let read = store
        .get_message(ALICE, "engineer", &alice.task_id)
        .await
        .unwrap();
    assert!(read.events_truncated);
    assert_eq!(read.events.last().unwrap().sequence, 16);
    assert!(read.events.len() < 10);
    assert!(read.events.iter().all(|event| event.text == long));
    // Events read by a principal that may not see the Task are not found.
    assert_eq!(
        store
            .list_visible_events(ALICE, &alice.task_id, 0, 32)
            .await
            .unwrap()
            .len(),
        16
    );
    assert!(matches!(
        store.list_visible_events(BOB, &alice.task_id, 0, 32).await,
        Err(StoreError::NotFound(_))
    ));

    let second = send("Alice follow-up", "follow-up");
    let response = store.send_message(ALICE, &second).await.unwrap();
    let follower = response.task.unwrap();
    let input = response.live_input.unwrap();
    assert_eq!(input.task_id, alice.task_id);
    assert_eq!(input.follower_task_id, follower.task_id);
    assert_eq!(input.state(), LiveInputState::Pending);
    let taken = store
        .take_input(
            &host,
            &TakeInputRequest {
                attempt: Some(attempt.clone()),
            },
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(taken.input_id, input.input_id);
    let accepted = store
        .settle_input(
            &host,
            &SettleInputRequest {
                attempt: Some(attempt),
                input_id: input.input_id.clone(),
                receipt: LiveInputReceipt::Accepted as i32,
            },
        )
        .await
        .unwrap();
    assert_eq!(accepted.state(), LiveInputState::Accepted);
    let replay = store.send_message(ALICE, &second).await.unwrap();
    assert_eq!(replay.task.unwrap().task_id, follower.task_id);
    assert_eq!(replay.live_input.unwrap().state(), LiveInputState::Accepted);
    let long = store
        .send_message(ALICE, &send(&"x".repeat(17_000), "long-message"))
        .await
        .unwrap();
    assert!(long.live_input.is_none());

    assert!(matches!(
        store
            .queue_input(
                ALICE,
                &QueueInputRequest {
                    task_id: alice.task_id.clone(),
                    operation_id: "outside-conversation".into(),
                    text: "Incorrect path".into(),
                }
            )
            .await,
        Err(StoreError::FailedPrecondition(_))
    ));
    assert!(matches!(
        store
            .submit_task(
                ALICE,
                &SubmitTaskRequest {
                    output_policy: None,
                    execution_limits: None,
                    tag_id: alice.tag_id.clone(),
                    session_id: alice.session_id.clone(),
                    operation_id: "bypass".into(),
                    prompt: "Incorrect path".into(),
                    input_artifacts: vec![],
                }
            )
            .await,
        Err(StoreError::FailedPrecondition(_))
    ));

    let head = store
        .list_messages(ALICE, &history(String::new()))
        .await
        .unwrap();
    assert_eq!(
        head.messages[0].task.as_ref().unwrap().task_id,
        long.task.unwrap().task_id
    );
    let middle = store
        .list_messages(ALICE, &history(head.next_cursor))
        .await
        .unwrap();
    assert_eq!(
        middle.messages[0].task.as_ref().unwrap().task_id,
        follower.task_id
    );
    let oldest = store
        .list_messages(ALICE, &history(middle.next_cursor))
        .await
        .unwrap();
    assert_eq!(
        oldest.messages[0].task.as_ref().unwrap().task_id,
        alice.task_id
    );
    assert!(oldest.next_cursor.is_empty());
    assert!(matches!(
        store.list_messages(ALICE, &history("00".into())).await,
        Err(StoreError::InvalidArgument(_))
    ));

    // One conversation per principal and Tag: every message continues it.
    let all = store
        .list_messages(
            ALICE,
            &ListMessagesRequest {
                tag_id: "engineer".into(),
                limit: 10,
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert_eq!(all.messages.len(), 3);
    assert_eq!(all.conversation_id, alice.session_id);
    assert!(!all.incremental);
    assert!(
        all.messages
            .iter()
            .all(|message| message.task.as_ref().unwrap().session_id == alice.session_id)
    );
    let orders: Vec<u64> = all.messages.iter().map(|message| message.order).collect();
    assert!(
        orders.windows(2).all(|pair| pair[0] > pair[1]),
        "{orders:?}"
    );
    assert!(all.messages.iter().all(|message| message.sent_at_ms > 0));
    let head_order = orders[0];

    // A copy at the head reads only what changed: nothing new, and the unfinished turn it holds.
    let since = |after: u64, conversation_id: &str, refresh: Vec<String>| ListMessagesRequest {
        tag_id: "engineer".into(),
        limit: 10,
        after,
        conversation_id: conversation_id.into(),
        refresh_task_ids: refresh,
        ..Default::default()
    };
    let changes = store
        .list_messages(
            ALICE,
            &since(head_order, &alice.session_id, vec![alice.task_id.clone()]),
        )
        .await
        .unwrap();
    assert!(changes.incremental);
    assert_eq!(
        changes
            .messages
            .iter()
            .map(|message| message.task.as_ref().unwrap().task_id.as_str())
            .collect::<Vec<_>>(),
        [alice.task_id.as_str()]
    );
    let newest = store
        .send_message(ALICE, &send("Alice newest", "newest"))
        .await
        .unwrap();
    let changes = store
        .list_messages(ALICE, &since(head_order, &alice.session_id, vec![]))
        .await
        .unwrap();
    assert!(changes.incremental);
    assert_eq!(changes.messages.len(), 1);
    assert_eq!(changes.messages[0].order, newest.order);
    // A copy of another conversation, or one more than a page behind, gets the newest page.
    let replaced = store
        .list_messages(ALICE, &since(head_order, "conversation/other", vec![]))
        .await
        .unwrap();
    assert!(!replaced.incremental);
    assert_eq!(replaced.messages.len(), 4);
    let behind = store
        .list_messages(
            ALICE,
            &ListMessagesRequest {
                limit: 1,
                ..since(1, &alice.session_id, vec![])
            },
        )
        .await
        .unwrap();
    assert!(!behind.incremental);
    assert!(!behind.next_cursor.is_empty());

    // The conversation list: one row per Tag, its latest message, unread replies, and work.
    let listed = store
        .list_conversations(ALICE, &ListConversationsRequest {})
        .await
        .unwrap();
    assert_eq!(listed.conversations.len(), 1);
    let conversation = &listed.conversations[0];
    assert_eq!(conversation.tag_id, "engineer");
    assert_eq!(conversation.conversation_id, alice.session_id);
    assert_eq!(conversation.session_id, alice.session_id);
    assert_eq!(conversation.preview, "Alice newest");
    assert!(!conversation.preview_from_tag);
    assert_eq!(conversation.latest_order, newest.order);
    assert!(conversation.last_activity_at_ms > 0);
    assert!(conversation.working);
    assert_eq!(conversation.read_order, 0);
    let goal = store
        .send_message(ALICE, &send("/goal", "goal-reply"))
        .await
        .unwrap();
    let listed = store
        .list_conversations(ALICE, &ListConversationsRequest {})
        .await
        .unwrap();
    let conversation = &listed.conversations[0];
    assert!(conversation.preview_from_tag, "{conversation:?}");
    assert!(conversation.preview.starts_with("Say which outcome"));
    assert!(conversation.unread_count >= 1, "{conversation:?}");
    let read = store
        .mark_conversation_read(
            ALICE,
            &MarkConversationReadRequest {
                tag_id: "engineer".into(),
                order: goal.order,
            },
        )
        .await
        .unwrap();
    assert_eq!(read.read_order, goal.order);
    assert_eq!(read.unread_count, 0);
    // A mark never moves back, and another principal's list is its own.
    let read = store
        .mark_conversation_read(
            ALICE,
            &MarkConversationReadRequest {
                tag_id: "engineer".into(),
                order: 1,
            },
        )
        .await
        .unwrap();
    assert_eq!(read.read_order, goal.order);
    let bobs = store
        .list_conversations(BOB, &ListConversationsRequest {})
        .await
        .unwrap();
    assert_eq!(bobs.conversations.len(), 1);
    assert_eq!(bobs.conversations[0].session_id, bob.session_id);
    assert_eq!(bobs.conversations[0].read_order, 0);
    assert!(matches!(
        store
            .mark_conversation_read(
                BOB,
                &MarkConversationReadRequest {
                    tag_id: "writer".into(),
                    order: 1,
                },
            )
            .await,
        Err(StoreError::NotFound(_))
    ));
    store.close().await;
}

#[tokio::test]
async fn sqlite_conversation_contract() {
    exercise("sqlite::memory:").await;
}

#[tokio::test]
#[ignore = "requires SUPERTAG_RUST_TEST_POSTGRES_URL_FILE for a dedicated PostgreSQL test server"]
async fn postgres_conversation_contract() {
    let path = std::env::var_os("SUPERTAG_RUST_TEST_POSTGRES_URL_FILE")
        .expect("PostgreSQL test URL file required");
    let admin_url = std::fs::read_to_string(path).unwrap();
    let database = format!("supertag_rust_conversations_{}", Uuid::new_v4().simple());
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
