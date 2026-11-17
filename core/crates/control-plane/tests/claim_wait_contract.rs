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

    // A host holds at most four claims at once; a fifth answers at once.
    let held: Vec<_> = (0..4)
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
            .claim_task_waiting(&host, &claim("fifth", 3_000), Duration::from_secs(3))
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

#[tokio::test]
async fn sqlite_claim_wait_contract() {
    let local = tokio::task::LocalSet::new();
    local.run_until(exercise("sqlite::memory:")).await;
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
            tokio::task::spawn_local(async move { exercise(url.as_str()).await }).await
        })
        .await;
    admin
        .execute(format!("DROP DATABASE {database} WITH (FORCE)").as_str())
        .await
        .unwrap();
    result.unwrap();
}
