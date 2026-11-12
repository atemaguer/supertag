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
        conversation: "project".into(),
        text: text.into(),
        operation_id: operation.into(),
    }
}

fn history(cursor: String) -> ListMessagesRequest {
    ListMessagesRequest {
        tag_id: "engineer".into(),
        conversation: "project".into(),
        limit: 1,
        cursor,
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
        .list_tags(&ListTagsRequest {
            limit: 1,
            cursor: String::new(),
            include_retired: false,
        })
        .await
        .unwrap();
    assert_eq!(page.tags[0].tag_id, "engineer");
    let last = store
        .list_tags(&ListTagsRequest {
            limit: 1,
            cursor: page.next_cursor,
            include_retired: false,
        })
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

    for (principal, task) in [(ALICE, alice), (BOB, bob)] {
        let page = store
            .list_conversations(principal, &ListConversationsRequest::default())
            .await
            .unwrap();
        assert_eq!(page.conversations.len(), 1);
        assert_eq!(page.conversations[0].session_id, task.session_id);
        assert!(page.next_cursor.is_empty());
    }
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
