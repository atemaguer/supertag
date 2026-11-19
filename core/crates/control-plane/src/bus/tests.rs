use std::time::{Duration, Instant};

use sqlx::{Connection, Executor};
use supertag_protocol::v2::*;
use tokio::time::timeout;
use tokio_stream::{Stream, StreamExt};
use tonic::Status;

use super::*;

const ALICE: &str = "operator:alice";
/// Longer than any wait below, so whatever arrives in time came from a hint, not the poll.
const NO_POLL: Duration = Duration::from_secs(30);

async fn sqlite() -> Store {
    let store = Store::open("sqlite::memory:").await.unwrap();
    store.live.bus.set_poll(NO_POLL);
    store
}

/// Records a watch notice of `kind` about `tag_id` without publishing a hint; returns its
/// position.
async fn record(store: &Store, kind: WatchKind, tag_id: &str) -> i64 {
    let (mut tx, _) = store.write().await.unwrap();
    insert(&mut tx, kind, tag_id).await;
    tx.commit().await.unwrap();
    store.feed_head().await.unwrap()
}

async fn insert(tx: &mut sqlx::Transaction<'_, sqlx::Any>, kind: WatchKind, tag_id: &str) {
    sqlx::query("INSERT INTO supertag_v2_watch_append SELECT $1, 1, $2, $2, '', '', '', '', ''")
        .bind(kind as i64)
        .bind(tag_id)
        .execute(&mut **tx)
        .await
        .unwrap();
}

fn reads(store: &Store) -> (u64, u64) {
    (
        store.live.bus.tail_reads.load(Ordering::Relaxed),
        store.live.bus.stream_reads.load(Ordering::Relaxed),
    )
}

fn follow(after: u64, conversation_id: &str) -> FollowConversationRequest {
    FollowConversationRequest {
        tag_id: "engineer".into(),
        conversation_id: conversation_id.into(),
        after,
        refresh_task_ids: vec![],
    }
}

fn send(operation: &str) -> SendMessageRequest {
    SendMessageRequest {
        tag_id: "engineer".into(),
        text: format!("Message {operation}"),
        operation_id: operation.into(),
        ..Default::default()
    }
}

async fn next(
    stream: &mut (impl Stream<Item = std::result::Result<FollowConversationResponse, Status>> + Unpin),
    within: Duration,
) -> Option<FollowConversationResponse> {
    match timeout(within, stream.next()).await {
        Ok(Some(response)) => Some(response.unwrap()),
        Ok(None) => panic!("the follow ended"),
        Err(_) => None,
    }
}

/// The next response that changes messages.
async fn next_messages(
    stream: &mut (impl Stream<Item = std::result::Result<FollowConversationResponse, Status>> + Unpin),
    within: Duration,
) -> Option<ListMessagesResponse> {
    let deadline = Instant::now() + within;
    loop {
        let left = deadline.saturating_duration_since(Instant::now());
        if let Some(messages) = next(stream, left).await?.messages {
            return Some(messages);
        }
    }
}

#[tokio::test]
async fn a_hint_goes_out_after_the_write_it_covers_and_no_read_sees_uncommitted_notices() {
    let store = sqlite().await;
    // The guard a write holds for its whole call publishes when the call is over, not before.
    let mut changes = store.live.bus.changes.subscribe();
    let guard = store.hint_after_commit();
    assert!(!changes.has_changed().unwrap());
    drop(guard);
    assert!(changes.has_changed().unwrap());
    changes.mark_unchanged();

    // A hint while a write is open delivers nothing of it; its commit does.
    let mut watch = store.watch_feed(|_| true).await.unwrap();
    let (mut tx, _) = store.write().await.unwrap();
    insert(&mut tx, WatchKind::Tag, "pending").await;
    store.live.bus.hint();
    assert!(
        timeout(Duration::from_millis(300), watch.next())
            .await
            .is_err()
    );
    tx.commit().await.unwrap();
    drop(store.hint_after_commit());
    match timeout(Duration::from_secs(2), watch.next()).await.unwrap() {
        Delivery::Notice(notice) => assert_eq!(notice.change.tag_id, "pending"),
        Delivery::Gap => panic!("expected the committed notice"),
    }
}

#[tokio::test]
async fn the_tail_fans_out_each_notice_to_the_streams_subscribed_to_it() {
    let store = sqlite().await;
    let a = store.follow_feed("a").await.unwrap();
    let b = store.follow_feed("b").await.unwrap();
    let mut tags = store
        .watch_feed(|notice| notice.change.kind == WatchKind::Tag as i32)
        .await
        .unwrap();
    let quiet = Duration::from_millis(200);

    // A Task of `a` wakes `a`'s follow alone, and no Watch of Tags.
    let task = record(&store, WatchKind::Task, "a").await;
    store.live.bus.hint();
    let wake = timeout(Duration::from_secs(2), a.wait()).await.unwrap();
    assert_eq!((wake.through, wake.gap, wake.text), (task, false, false));
    assert!(timeout(quiet, b.wait()).await.is_err());

    // A change to Tag `b` reaches the Watch of Tags, and no follow: they hear only of their
    // Tag's Tasks and messages.
    let tag = record(&store, WatchKind::Tag, "b").await;
    store.live.bus.hint();
    match timeout(Duration::from_secs(2), tags.next()).await.unwrap() {
        Delivery::Notice(notice) => assert_eq!(notice.position, tag),
        Delivery::Gap => panic!("expected the Tag notice"),
    }
    assert!(tags.try_next().is_none());
    assert!(timeout(quiet, b.wait()).await.is_err());
    assert!(timeout(quiet, a.wait()).await.is_err());

    // A message of `b` wakes `b`'s follow.
    let message = record(&store, WatchKind::ConversationMessage, "b").await;
    store.live.bus.hint();
    assert_eq!(
        timeout(Duration::from_secs(2), b.wait())
            .await
            .unwrap()
            .through,
        message
    );

    // Streamed text reaches only its Tag's follows, and the tail reads nothing for it.
    let (tail, _) = reads(&store);
    store.live.bus.text("b");
    let wake = timeout(Duration::from_secs(2), b.wait()).await.unwrap();
    assert_eq!((wake.through, wake.text), (0, true));
    assert!(timeout(quiet, a.wait()).await.is_err());
    assert_eq!(reads(&store).0, tail);

    // Pruned notices the tail never read are a gap for every stream.
    record(&store, WatchKind::Task, "a").await;
    record(&store, WatchKind::Task, "a").await;
    store.retain_watch(0).await.unwrap();
    store.live.bus.hint();
    assert!(timeout(Duration::from_secs(2), a.wait()).await.unwrap().gap);
    assert!(timeout(Duration::from_secs(2), b.wait()).await.unwrap().gap);
    assert!(matches!(
        timeout(Duration::from_secs(2), tags.next()).await.unwrap(),
        Delivery::Gap
    ));

    // The tail stops once the last stream closes.
    drop((a, b, tags));
    timeout(Duration::from_secs(2), async {
        while store.live.bus.state.lock().unwrap().tail.is_some() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn a_follow_drops_what_its_first_read_already_returned() {
    let store = sqlite().await;
    store
        .put_tag("engineer", "Follow changes", vec![])
        .await
        .unwrap();
    // A tail that runs behind the feed: a notice recorded without a hint waits for the poll.
    let _other = store.follow_feed("other").await.unwrap();
    record(&store, WatchKind::Task, "engineer").await;
    let mut alice = store
        .follow_conversation(ALICE, follow(0, ""))
        .await
        .unwrap();
    assert_eq!(
        next(&mut alice, Duration::from_secs(1)).await,
        Some(FollowConversationResponse::default())
    );
    let (_, before) = reads(&store);
    // The tail now delivers the notice, which the follow's first read came after.
    store.live.bus.hint();
    assert_eq!(next(&mut alice, Duration::from_millis(300)).await, None);
    assert_eq!(reads(&store).1, before);
    // A later one is read.
    record(&store, WatchKind::Task, "engineer").await;
    store.live.bus.hint();
    assert_eq!(next(&mut alice, Duration::from_millis(300)).await, None);
    assert_eq!(reads(&store).1, before + 1);
}

#[tokio::test]
async fn a_follow_replays_after_its_cursor_and_resyncs_one_too_old_to_replay() {
    let store = sqlite().await;
    store
        .put_tag("engineer", "Follow changes", vec![])
        .await
        .unwrap();
    let first = store.send_message(ALICE, &send("0")).await.unwrap();
    let conversation = first.task.as_ref().unwrap().session_id.clone();
    let mut sent = vec![first];
    // More than a page of messages, which ListMessages holds 32 of.
    for number in 1..=33 {
        sent.push(
            store
                .send_message(ALICE, &send(&number.to_string()))
                .await
                .unwrap(),
        );
    }
    let task_id = |message: &ConversationMessage| message.task.as_ref().unwrap().task_id.clone();
    // A cursor one message behind replays that message, then pushes.
    let mut current = store
        .follow_conversation(ALICE, follow(sent[32].order, &conversation))
        .await
        .unwrap();
    let replayed = next_messages(&mut current, Duration::from_secs(1))
        .await
        .unwrap();
    assert!(replayed.incremental);
    assert_eq!(
        replayed.messages.iter().map(task_id).collect::<Vec<_>>(),
        [task_id(&sent[33])]
    );
    let pushed = store.send_message(ALICE, &send("34")).await.unwrap();
    let page = next_messages(&mut current, Duration::from_secs(1))
        .await
        .unwrap();
    assert!(page.incremental);
    assert_eq!(page.messages[0].task, pushed.task);
    // One more than a page behind is not replayed: the newest page replaces the copy.
    let mut behind = store
        .follow_conversation(ALICE, follow(sent[0].order, &conversation))
        .await
        .unwrap();
    let resync = next_messages(&mut behind, Duration::from_secs(1))
        .await
        .unwrap();
    assert!(!resync.incremental);
    assert_eq!(resync.conversation_id, conversation);
    assert_eq!(resync.messages.len(), 32);
    assert_eq!(resync.messages[0].task, pushed.task);
}

#[tokio::test]
async fn idle_follows_leave_reading_to_the_one_tail() {
    let store = Store::open("sqlite::memory:").await.unwrap();
    store
        .put_tag("engineer", "Follow changes", vec![])
        .await
        .unwrap();
    store.send_message(ALICE, &send("hello")).await.unwrap();
    let mut followers = Vec::new();
    for number in 0..20 {
        let mut stream = store
            .follow_conversation(
                &format!("operator:follower-{number}"),
                FollowConversationRequest {
                    tag_id: "engineer".into(),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        assert!(next(&mut stream, Duration::from_secs(1)).await.is_some());
        followers.push(tokio::spawn(async move {
            while stream.next().await.is_some() {}
        }));
    }
    tokio::time::sleep(Duration::from_millis(100)).await;
    let (tail, streams) = reads(&store);
    let idle = Duration::from_millis(1_500);
    tokio::time::sleep(idle).await;
    let (tail_after, streams_after) = reads(&store);
    // No follow read the store; the tail read it once per poll, not once per follow.
    assert_eq!(streams_after, streams);
    let polls = (idle.as_millis() / store.live.bus.poll().as_millis()) as u64;
    assert!(
        (1..=polls + 2).contains(&(tail_after - tail)),
        "{} tail reads in {idle:?}",
        tail_after - tail
    );
    for follower in followers {
        follower.abort();
    }
}

#[tokio::test]
#[ignore = "requires SUPERTAG_RUST_TEST_POSTGRES_URL_FILE"]
async fn postgres_a_message_accepted_on_one_replica_reaches_a_follower_on_another()
-> anyhow::Result<()> {
    let path = std::env::var_os("SUPERTAG_RUST_TEST_POSTGRES_URL_FILE")
        .ok_or_else(|| anyhow::anyhow!("set SUPERTAG_RUST_TEST_POSTGRES_URL_FILE"))?;
    let url = std::fs::read_to_string(path)?;
    let mut admin = sqlx::PgConnection::connect(url.trim()).await?;
    let database = format!("supertag_rust_hints_{}", uuid::Uuid::new_v4().simple());
    admin
        .execute(format!("CREATE DATABASE {database}").as_str())
        .await?;
    let mut test_url = url::Url::parse(url.trim())?;
    test_url.set_path(&database);
    let result = tokio::task::LocalSet::new()
        .run_until(async move {
            tokio::task::spawn_local(async move { replicas(test_url.as_str()).await }).await
        })
        .await;
    admin
        .execute(format!("DROP DATABASE {database} WITH (FORCE)").as_str())
        .await?;
    result?
}

async fn replicas(url: &str) -> anyhow::Result<()> {
    let a = Store::open(url).await?;
    let b = Store::open(url).await?;
    let mut admin = sqlx::PgConnection::connect(url).await?;
    let listeners = async |admin: &mut sqlx::PgConnection| -> anyhow::Result<i64> {
        Ok(sqlx::query_scalar(
            "SELECT count(*) FROM pg_stat_activity
             WHERE application_name = $1 AND datname = current_database()",
        )
        .bind(listener::APPLICATION_NAME)
        .fetch_one(admin)
        .await?)
    };
    let until = async |admin: &mut sqlx::PgConnection, count: i64| -> anyhow::Result<()> {
        let deadline = Instant::now() + Duration::from_secs(5);
        while listeners(admin).await? != count {
            anyhow::ensure!(Instant::now() < deadline, "expected {count} listeners");
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        Ok(())
    };
    // B's poll is far longer than the wait below, so what arrives in time was notified.
    b.live.bus.set_poll(NO_POLL);
    a.put_tag("engineer", "Follow changes", vec![]).await?;
    let mut follower = b.follow_conversation(ALICE, follow(0, "")).await?;
    assert_eq!(
        next(&mut follower, Duration::from_secs(5)).await,
        Some(FollowConversationResponse::default())
    );
    // B's tail listens on one connection of its own; A runs no stream, so no tail.
    until(&mut admin, 1).await?;

    let accepted = Instant::now();
    let first = a.send_message(ALICE, &send("first")).await?;
    let page = next_messages(&mut follower, Duration::from_secs(1))
        .await
        .ok_or_else(|| anyhow::anyhow!("the message did not reach the other replica in time"))?;
    assert!(accepted.elapsed() < Duration::from_secs(1));
    assert_eq!(page.messages[0].task, first.task);

    // With its listener killed and kept down, B still gets the next message from its poll.
    b.live.bus.set_poll(Duration::from_secs(1));
    b.live.bus.listener_paused.store(true, Ordering::SeqCst);
    sqlx::query(
        "SELECT pg_terminate_backend(pid) FROM pg_stat_activity
         WHERE application_name = $1 AND datname = current_database()",
    )
    .bind(listener::APPLICATION_NAME)
    .execute(&mut admin)
    .await?;
    until(&mut admin, 0).await?;
    // Let the tail settle into its 1 s poll after the listener's reconnect hint.
    tokio::time::sleep(Duration::from_millis(200)).await;
    let second = a.send_message(ALICE, &send("second")).await?;
    let page = next_messages(&mut follower, Duration::from_secs(3))
        .await
        .ok_or_else(|| anyhow::anyhow!("the poll did not bring the message"))?;
    assert_eq!(page.messages[0].task, second.task);
    assert_eq!(listeners(&mut admin).await?, 0);

    // The listener comes back, and with it the push.
    b.live.bus.set_poll(NO_POLL);
    b.live.bus.listener_paused.store(false, Ordering::SeqCst);
    until(&mut admin, 1).await?;
    tokio::time::sleep(Duration::from_millis(1_200)).await;
    let accepted = Instant::now();
    let third = a.send_message(ALICE, &send("third")).await?;
    let page = next_messages(&mut follower, Duration::from_secs(1))
        .await
        .ok_or_else(|| anyhow::anyhow!("the reconnected listener did not push the message"))?;
    assert!(accepted.elapsed() < Duration::from_secs(1));
    assert_eq!(page.messages[0].task, third.task);
    a.close().await;
    b.close().await;
    Ok(())
}
