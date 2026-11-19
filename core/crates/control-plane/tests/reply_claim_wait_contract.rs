//! A Gateway account's reply claim that finds nothing ready is held until a reply is ready,
//! writes nothing while it waits, and is answered at once when the Control Plane drains.
mod support;

use std::time::{Duration, Instant};

use sqlx::{Connection, Executor};
use supertag_control_plane::{Store, StoreError};
use supertag_protocol::v2::*;
use uuid::Uuid;

const CONNECTOR: &str = "connector:acme";

/// How many write transactions the store has begun: each takes the next write order.
async fn writes(url: &str) -> i64 {
    sqlx::any::install_default_drivers();
    let mut connection = sqlx::AnyConnection::connect(url).await.unwrap();
    let revision =
        sqlx::query_scalar("SELECT revision FROM supertag_v2_write_order WHERE singleton=1")
            .fetch_one(&mut connection)
            .await
            .unwrap();
    connection.close().await.unwrap();
    revision
}

async fn queue_task(store: &Store, event_id: &str) -> String {
    store
        .accept_event(
            CONNECTOR,
            &AcceptEventRequest {
                account_id: "acme".into(),
                event_id: event_id.into(),
                tag_id: "reviewer".into(),
                session_id: format!("session-{event_id}"),
                prompt: "Review this".into(),
                destination: Some(ReplyDestination {
                    conversation_id: "channel".into(),
                    thread_id: Some(format!("thread-{event_id}")),
                }),
                ..Default::default()
            },
        )
        .await
        .unwrap()
        .task_id
}

async fn finish(store: &Store, host: &supertag_control_plane::HostAuthority, task_id: &str) {
    let assignment = store
        .claim_task(host, &format!("claim-{task_id}"))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(assignment.task.as_ref().unwrap().task_id, task_id);
    store
        .start_task(
            host,
            &StartTaskRequest {
                task_id: task_id.into(),
                attempt_id: assignment.attempt_id.clone(),
                lease_token: assignment.lease_token.clone(),
            },
        )
        .await
        .unwrap();
    store
        .finish_task(
            host,
            &FinishTaskRequest {
                task_id: task_id.into(),
                attempt_id: assignment.attempt_id,
                lease_token: assignment.lease_token,
                result: "Reviewed".into(),
                succeeded: true,
                ..Default::default()
            },
        )
        .await
        .unwrap();
}

async fn exercise(url: &str) {
    let store = Store::open(url).await.unwrap();
    store
        .put_tag("reviewer", "Review", vec!["files:read".into()])
        .await
        .unwrap();
    let host = support::register_host(&store, "worker").await;
    let task_id = queue_task(&store, "event-1").await;

    // An idle held claim reads, rechecking at least once a second, but writes nothing.
    let before = writes(url).await;
    let at = Instant::now();
    let idle = store
        .claim_reply_waiting(CONNECTOR, "idle", Duration::from_millis(2_200))
        .await
        .unwrap();
    assert_eq!(idle, ClaimReplyResponse::default());
    assert!(
        at.elapsed() >= Duration::from_millis(2_100) && at.elapsed() < Duration::from_secs(4),
        "{:?}",
        at.elapsed()
    );
    assert_eq!(writes(url).await, before, "an idle held claim wrote");

    // A held claim returns promptly once the Task's reply is ready.
    let held = store.claim_reply_waiting(CONNECTOR, "held", Duration::from_secs(6));
    let ready = async {
        tokio::time::sleep(Duration::from_millis(200)).await;
        finish(&store, &host, &task_id).await;
        Instant::now()
    };
    let (claim, ready_at) = tokio::join!(held, ready);
    let claim = claim.unwrap();
    assert!(
        ready_at.elapsed() < Duration::from_millis(900),
        "{:?}",
        ready_at.elapsed()
    );
    let reply = claim.reply.clone().expect("the held claim took the reply");
    assert_eq!(reply.state(), ReplyState::Claimed);
    assert_eq!(reply.text, "Reviewed");
    // Replaying the operation returns the same claim, without a wait.
    assert_eq!(
        store
            .claim_reply_waiting(CONNECTOR, "held", Duration::from_secs(6))
            .await
            .unwrap(),
        claim
    );

    // A claim for another account is never woken by this one's reply.
    let other = store
        .claim_reply_waiting("connector:other", "other", Duration::from_millis(300))
        .await
        .unwrap();
    assert!(other.reply.is_none());

    // A held claim fenced to a lease that is not the account's current one is refused at once.
    let owner = store
        .claim_connector(
            CONNECTOR,
            &ClaimConnectorRequest {
                owner_id: "gateway-a".into(),
            },
        )
        .await
        .unwrap();
    assert!(owner.granted);
    let at = Instant::now();
    assert!(matches!(
        store
            .claim_owned_reply(
                CONNECTOR,
                &ClaimReplyRequest {
                    operation_id: "stale-owner".into(),
                    connector_lease_token: "not-the-lease".into(),
                    wait_ms: 6_000,
                },
            )
            .await,
        Err(StoreError::FailedPrecondition(_))
    ));
    assert!(at.elapsed() < Duration::from_secs(1), "{:?}", at.elapsed());
    // The owner's held claim waits for its account, here with nothing ready.
    let owned = store
        .claim_owned_reply(
            CONNECTOR,
            &ClaimReplyRequest {
                operation_id: "owned".into(),
                connector_lease_token: owner.lease_token.clone(),
                wait_ms: 300,
            },
        )
        .await
        .unwrap();
    assert!(owned.reply.is_none());

    // Draining answers every held claim at once.
    let held: Vec<_> = (0..3)
        .map(|index| {
            let store = store.clone();
            tokio::task::spawn_local(async move {
                store
                    .claim_reply_waiting(
                        CONNECTOR,
                        &format!("drain-{index}"),
                        Duration::from_secs(8),
                    )
                    .await
            })
        })
        .collect();
    tokio::time::sleep(Duration::from_millis(300)).await;
    let at = Instant::now();
    store.close_follows();
    for claim in held {
        assert!(claim.await.unwrap().unwrap().reply.is_none());
    }
    assert!(at.elapsed() < Duration::from_secs(1), "{:?}", at.elapsed());
    store.close().await;
}

#[tokio::test]
async fn sqlite_reply_claim_wait_contract() {
    let directory = tempfile::tempdir().unwrap();
    let url = format!(
        "sqlite://{}?mode=rwc",
        directory.path().join("state.db").display()
    );
    tokio::task::LocalSet::new().run_until(exercise(&url)).await;
}

#[tokio::test]
#[ignore = "requires SUPERTAG_RUST_TEST_POSTGRES_URL_FILE for a dedicated PostgreSQL test server"]
async fn postgres_reply_claim_wait_contract() {
    let path = std::env::var_os("SUPERTAG_RUST_TEST_POSTGRES_URL_FILE")
        .expect("PostgreSQL test URL file required");
    let admin_url = std::fs::read_to_string(path).unwrap();
    let database = format!("supertag_rust_reply_wait_{}", Uuid::new_v4().simple());
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
