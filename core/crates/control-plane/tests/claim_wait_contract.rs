mod support;

use std::time::{Duration, Instant};

use sqlx::{Connection, Executor};
use supertag_control_plane::Store;
use supertag_protocol::v2::*;
use uuid::Uuid;

fn claim(operation: &str, wait_ms: u32) -> ClaimTaskRequest {
    ClaimTaskRequest {
        operation_id: operation.into(),
        wait_ms,
        ..Default::default()
    }
}

async fn exercise(database: &str) {
    let store = Store::open(database).await.unwrap();
    store
        .put_tag("engineer", "Process this request", vec![])
        .await
        .unwrap();
    let host = support::register_host(&store, "waiting-host").await;

    // Without a wait, an empty claim answers at once, as before.
    let at = Instant::now();
    assert!(
        store
            .claim_task_waiting(&host, &claim("now", 0), Duration::ZERO)
            .await
            .unwrap()
            .is_none()
    );
    assert!(at.elapsed() < Duration::from_secs(1));

    // A held claim takes a Task as soon as one is sent.
    let waiting = claim("held", 6_000);
    let held = store.claim_task_waiting(&host, &waiting, Duration::from_secs(6));
    let send = async {
        tokio::time::sleep(Duration::from_millis(500)).await;
        let sent = Instant::now();
        let message = store
            .send_message(
                "operator:alice",
                &SendMessageRequest {
                    tag_id: "engineer".into(),
                    text: "Wake the host".into(),
                    operation_id: "wake".into(),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        (sent, message.task.unwrap().task_id)
    };
    let (assignment, (sent, task_id)) = tokio::join!(held, send);
    let assignment = assignment.unwrap().expect("the held claim took the Task");
    assert_eq!(assignment.task.unwrap().task_id, task_id);
    assert!(
        sent.elapsed() < Duration::from_millis(900),
        "{:?}",
        sent.elapsed()
    );

    // A held claim that finds nothing answers empty when its wait ends, at most 8 seconds.
    let at = Instant::now();
    assert!(
        store
            .claim_task_waiting(&host, &claim("empty", 700), Duration::from_millis(700))
            .await
            .unwrap()
            .is_none()
    );
    assert!(at.elapsed() >= Duration::from_millis(650) && at.elapsed() < Duration::from_secs(3));

    // A host holds at most 16 claims at once, across its lanes; another answers at once.
    let held: Vec<_> = (0..16)
        .map(|index| {
            let store = store.clone();
            let host = host.clone();
            tokio::task::spawn_local(async move {
                store
                    .claim_task_waiting(
                        &host,
                        &claim(&format!("cap-{index}"), 3_000),
                        Duration::from_secs(3),
                    )
                    .await
            })
        })
        .collect();
    tokio::time::sleep(Duration::from_millis(400)).await;
    let at = Instant::now();
    assert!(
        store
            .claim_task_waiting(&host, &claim("seventeenth", 3_000), Duration::from_secs(3))
            .await
            .unwrap()
            .is_none()
    );
    assert!(at.elapsed() < Duration::from_secs(1), "{:?}", at.elapsed());

    // Draining answers every held claim at once.
    let at = Instant::now();
    store.close_follows();
    for claim in held {
        assert!(claim.await.unwrap().unwrap().is_none());
    }
    assert!(at.elapsed() < Duration::from_secs(1), "{:?}", at.elapsed());
    store.close().await;
}

async fn send(store: &Store, text: &str) -> String {
    store
        .send_message(
            "operator:alice",
            &SendMessageRequest {
                tag_id: "coder".into(),
                text: text.into(),
                operation_id: text.into(),
                ..Default::default()
            },
        )
        .await
        .unwrap()
        .task
        .unwrap()
        .task_id
}

fn codex(operation: &str, wait_ms: u32, harness: HarnessKind) -> ClaimTaskRequest {
    ClaimTaskRequest {
        harness_kind: harness as i32,
        ..claim(operation, wait_ms)
    }
}

/// A Session's next Task goes first to the host its last Task finished on, while that host is
/// waiting and may run it; otherwise any host takes it at once.
async fn exercise_sticky(database: &str) {
    let store = Store::open(database).await.unwrap();
    store
        .put_tag_configured("coder", "Code", vec![], None, HarnessKind::Codex)
        .await
        .unwrap();
    let warm = support::register_host(&store, "warm-host").await;
    let other = support::register_host(&store, "other-host").await;
    let first = send(&store, "First turn").await;
    let assignment = store
        .claim_task_waiting(
            &warm,
            &codex("warm-1", 0, HarnessKind::Codex),
            Duration::ZERO,
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(assignment.task.as_ref().unwrap().task_id, first);
    store
        .start_task(
            &warm,
            &StartTaskRequest {
                task_id: first.clone(),
                attempt_id: assignment.attempt_id.clone(),
                lease_token: assignment.lease_token.clone(),
            },
        )
        .await
        .unwrap();
    store
        .finish_task(
            &warm,
            &FinishTaskRequest {
                task_id: first.clone(),
                attempt_id: assignment.attempt_id.clone(),
                lease_token: assignment.lease_token.clone(),
                result: "Done".into(),
                succeeded: true,
                ..Default::default()
            },
        )
        .await
        .unwrap();

    // The warm host waits to claim; the other host is left without the Session's next Task.
    let waiting = codex("warm-2", 6_000, HarnessKind::Codex);
    let held = store.claim_task_waiting(&warm, &waiting, Duration::from_secs(6));
    let race = async {
        tokio::time::sleep(Duration::from_millis(300)).await;
        let second = send(&store, "Second turn").await;
        let taken = store
            .claim_task_waiting(
                &other,
                &codex("other-1", 0, HarnessKind::Codex),
                Duration::ZERO,
            )
            .await
            .unwrap();
        (second, taken)
    };
    let (assignment, (second, taken)) = tokio::join!(held, race);
    assert!(taken.is_none(), "another host took the warm Session's Task");
    let assignment = assignment
        .unwrap()
        .expect("the warm host took its Session's Task");
    assert_eq!(assignment.task.as_ref().unwrap().task_id, second);
    let finish = FinishTaskRequest {
        task_id: second.clone(),
        attempt_id: assignment.attempt_id.clone(),
        lease_token: assignment.lease_token.clone(),
        result: "Done".into(),
        succeeded: true,
        ..Default::default()
    };
    store
        .start_task(
            &warm,
            &StartTaskRequest {
                task_id: second.clone(),
                attempt_id: assignment.attempt_id.clone(),
                lease_token: assignment.lease_token.clone(),
            },
        )
        .await
        .unwrap();
    store.finish_task(&warm, &finish).await.unwrap();

    // A warm host whose claim can no longer run the Task is not waited for.
    let waiting = codex("warm-3", 6_000, HarnessKind::Cursor);
    let held = store.claim_task_waiting(&warm, &waiting, Duration::from_millis(1_500));
    let race = async {
        tokio::time::sleep(Duration::from_millis(300)).await;
        let third = send(&store, "Third turn").await;
        let taken = store
            .claim_task_waiting(
                &other,
                &codex("other-2", 0, HarnessKind::Codex),
                Duration::ZERO,
            )
            .await
            .unwrap();
        (third, taken)
    };
    let (held, (third, taken)) = tokio::join!(held, race);
    assert!(held.unwrap().is_none());
    assert_eq!(taken.unwrap().task.unwrap().task_id, third);
    store.close().await;
}

#[tokio::test]
async fn sqlite_claim_wait_contract() {
    let local = tokio::task::LocalSet::new();
    local.run_until(exercise("sqlite::memory:")).await;
    local.run_until(exercise_sticky("sqlite::memory:")).await;
}

#[tokio::test]
#[ignore = "requires SUPERTAG_RUST_TEST_POSTGRES_URL_FILE for a dedicated PostgreSQL test server"]
async fn postgres_claim_wait_contract() {
    let path = std::env::var_os("SUPERTAG_RUST_TEST_POSTGRES_URL_FILE")
        .expect("PostgreSQL test URL file required");
    let admin_url = std::fs::read_to_string(path).unwrap();
    let database = format!("supertag_rust_claim_wait_{}", Uuid::new_v4().simple());
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
            tokio::task::spawn_local(async move {
                exercise(url.as_str()).await;
                exercise_sticky(url.as_str()).await;
            })
            .await
        })
        .await;
    admin
        .execute(format!("DROP DATABASE {database} WITH (FORCE)").as_str())
        .await
        .unwrap();
    result.unwrap();
}
