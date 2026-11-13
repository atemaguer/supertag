//! Control Plane replicas on one database: schema setup, shared maintenance, and the SQLite
//! single-process rule. `cli/tests/replicas_runtime.rs` runs real replicas as processes.

mod support;

use std::{
    fs::File,
    path::Path,
    sync::{
        Arc,
        atomic::{AtomicI64, Ordering},
    },
    time::Duration,
};

use sqlx::{Connection, Executor};
use supertag_control_plane::Store;
use supertag_protocol::v2::*;
use tokio::task::JoinSet;
use uuid::Uuid;

const TICK: Duration = Duration::from_secs(1);

fn sqlite_url(path: &Path) -> String {
    format!("sqlite://{}?mode=rwc", path.display())
}

/// Exactly one of `stores` claims the pass due now, and none claims it again before it is due.
async fn one_claim_per_tick(stores: &[Store]) {
    let mut claims = JoinSet::new();
    for store in stores {
        let store = store.clone();
        claims.spawn(async move { store.claim_maintenance(TICK).await.unwrap() });
    }
    let claimed = claims.join_all().await.into_iter().filter(|won| *won);
    assert_eq!(claimed.count(), 1, "one replica runs each maintenance pass");
    for store in stores {
        assert!(!store.claim_maintenance(TICK).await.unwrap());
    }
}

#[tokio::test]
async fn sqlite_admits_one_control_plane_process_and_shares_its_lock_within_it() {
    let directory = tempfile::tempdir().unwrap();
    let database = directory.path().join("state.db");
    let url = sqlite_url(&database);
    let first = Store::open(&url).await.unwrap();
    // Store handles in one process share the database and its lock.
    let second = Store::open(&url).await.unwrap();
    one_claim_per_tick(&[first.clone(), second.clone()]).await;
    let lock = directory.path().join("state.db.lock");
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(&lock).unwrap().permissions().mode();
        assert_eq!(mode & 0o077, 0, "the lock file is private");
    }
    // Another process opens its own file description, which the held lock refuses.
    let other = File::open(&lock).unwrap();
    assert!(matches!(
        other.try_lock(),
        Err(std::fs::TryLockError::WouldBlock)
    ));
    first.close().await;
    second.close().await;
    drop((first, second));
    other.try_lock().unwrap();
    let error = Store::open(&url)
        .await
        .err()
        .expect("a second process is refused");
    assert!(
        error
            .to_string()
            .contains("use PostgreSQL to run several Control Plane replicas"),
        "{error}"
    );
    drop(other);
    Store::open(&url).await.unwrap().close().await;
}

/// Runs `body` with the URL of a new, empty PostgreSQL database, then drops the database.
async fn on_postgres<F>(body: impl FnOnce(String) -> F + 'static)
where
    F: std::future::Future<Output = ()> + 'static,
{
    let path = std::env::var_os("SUPERTAG_RUST_TEST_POSTGRES_URL_FILE")
        .expect("PostgreSQL contract requires a dedicated test server URL file");
    let admin_url = std::fs::read_to_string(path).unwrap();
    let mut url = url::Url::parse(admin_url.trim()).unwrap();
    let name = format!("supertag_rust_cp_{}", Uuid::new_v4().simple());
    let mut admin = sqlx::PgConnection::connect(admin_url.trim()).await.unwrap();
    admin
        .execute(format!("CREATE DATABASE {name}").as_str())
        .await
        .unwrap();
    url.set_path(&name);
    // Opening a Store is a large future that is not `Send`; run the replicas on one thread.
    let outcome = tokio::task::LocalSet::new()
        .run_until(async move { tokio::task::spawn_local(body(url.to_string())).await })
        .await;
    admin
        .execute(format!("DROP DATABASE {name} WITH (FORCE)").as_str())
        .await
        .unwrap();
    admin.close().await.unwrap();
    outcome.expect("PostgreSQL replica contract failed");
}

#[tokio::test]
#[ignore = "requires SUPERTAG_RUST_TEST_POSTGRES_URL_FILE for a dedicated PostgreSQL test server"]
async fn postgres_replicas_start_together_and_share_one_maintenance_pass() {
    on_postgres(|url| async move {
        // Replicas that start together on an empty database migrate it once between them.
        let mut opened = JoinSet::new();
        for _ in 0..4 {
            let url = url.to_string();
            opened.spawn_local(async move { Store::open(&url).await.unwrap() });
        }
        let stores = opened.join_all().await;
        let mut connection = sqlx::PgConnection::connect(url.as_str()).await.unwrap();
        let versions: Vec<i64> = sqlx::query_scalar("SELECT version FROM supertag_v2_schema")
            .fetch_all(&mut connection)
            .await
            .unwrap();
        assert_eq!(versions.len(), 1);
        one_claim_per_tick(&stores).await;
        // A claim further ahead than any clock allows is skew; a replica takes it over.
        connection
            .execute("UPDATE supertag_v2_maintenance_ticks SET due_at_ms=9000000000000000")
            .await
            .unwrap();
        one_claim_per_tick(&stores).await;
        connection.close().await.unwrap();
        for store in stores {
            store.close().await;
        }
    })
    .await;
}

const OPERATOR: &str = "operator:local";

fn destination(key: &str, provider: NotificationProvider) -> NotificationDestination {
    NotificationDestination {
        key: key.into(),
        provider: provider as i32,
    }
}

const SLACK: &str = "slack:C0OPERATOR";
const WEBHOOK: &str = "webhook:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

/// Replica B records a message for an Inbox item that became due after replica A's claim
/// started. A's claim judges messages against the Inbox it reads at its own instant under its
/// lock, so B's message is never settled as delivered without being sent. Before this, A read
/// the Inbox earlier, outside its lock: here, its first clock reading.
async fn claim_reads_the_inbox_under_its_lock(url: &str) {
    const NOW: i64 = 1_900_000_000_000;
    let clock = Arc::new(AtomicI64::new(NOW));
    // Replica A's next clock reading, once, when set.
    let early = Arc::new(AtomicI64::new(0));
    let a = {
        let (clock, early) = (clock.clone(), early.clone());
        Store::open(url)
            .await
            .unwrap()
            .with_execution_clock(move || match early.swap(0, Ordering::SeqCst) {
                0 => clock.load(Ordering::SeqCst),
                early => early,
            })
    };
    let b = {
        let clock = clock.clone();
        Store::open(url)
            .await
            .unwrap()
            .with_execution_clock(move || clock.load(Ordering::SeqCst))
    };
    b.put_tag_spec(PutTagRequest {
        tag_id: "owner".into(),
        instructions: "Coordinate the work".into(),
        allowed_actions: vec!["files:read".into()],
        ..Default::default()
    })
    .await
    .unwrap();
    b.create_team(
        OPERATOR,
        &CreateTeamRequest {
            operation_id: "team".into(),
            team_id: "engineering".into(),
            name: "Engineering".into(),
            member_tag_ids: vec!["owner".into()],
            max_concurrency: None,
        },
    )
    .await
    .unwrap();
    let objective = b
        .create_objective(
            OPERATOR,
            &CreateObjectiveRequest {
                operation_id: "create".into(),
                objective_id: "release".into(),
                owner_tag_id: "owner".into(),
                outcome: "Ship the fix".into(),
                team_id: Some("engineering".into()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    let host = support::register_host(&b, "notify-host").await;
    let assignment = b
        .claim_task(&host, "claim")
        .await
        .unwrap()
        .expect("the Objective's first Task");
    b.start_task(
        &host,
        &StartTaskRequest {
            task_id: objective.starting_task_id.clone(),
            attempt_id: assignment.attempt_id.clone(),
            lease_token: assignment.lease_token.clone(),
        },
    )
    .await
    .unwrap();
    // The Attempt's lease lapses: from now on the Task is an Inbox item.
    clock.fetch_add(30_000, Ordering::SeqCst);
    assert_eq!(b.sweep_expired_attempts().await.unwrap(), 1);
    let due = clock.load(Ordering::SeqCst);
    // B records a message for each destination and leases the Slack one.
    let leased = b
        .claim_operator_notification(
            OPERATOR,
            &ClaimOperatorNotificationRequest {
                destinations: vec![
                    destination(SLACK, NotificationProvider::Slack),
                    destination(WEBHOOK, NotificationProvider::Webhook),
                ],
            },
        )
        .await
        .unwrap()
        .notification
        .expect("B's Slack message");
    assert_eq!(leased.destination_key, SLACK);

    // A's claim starts just before the item was due: nothing is due at its instant.
    let webhook = ClaimOperatorNotificationRequest {
        destinations: vec![destination(WEBHOOK, NotificationProvider::Webhook)],
    };
    early.store(due - 1, Ordering::SeqCst);
    assert!(
        a.claim_operator_notification(OPERATOR, &webhook)
            .await
            .unwrap()
            .notification
            .is_none(),
        "nothing was due when replica A claimed"
    );
    // The webhook message B recorded still waits, and A delivers it.
    let pending = a
        .claim_operator_notification(OPERATOR, &webhook)
        .await
        .unwrap()
        .notification
        .expect("the webhook message was settled without being sent");
    assert_eq!(pending.destination_key, WEBHOOK);
    assert_eq!(pending.item_keys, leased.item_keys);
    assert_eq!(pending.attempt_count, 1);
    a.close().await;
    b.close().await;
}

#[tokio::test]
async fn sqlite_notification_claim_reads_the_inbox_under_its_lock() {
    let directory = tempfile::tempdir().unwrap();
    claim_reads_the_inbox_under_its_lock(&sqlite_url(&directory.path().join("state.db"))).await;
}

#[tokio::test]
#[ignore = "requires SUPERTAG_RUST_TEST_POSTGRES_URL_FILE for a dedicated PostgreSQL test server"]
async fn postgres_notification_claim_reads_the_inbox_under_its_lock() {
    on_postgres(|url| async move { claim_reads_the_inbox_under_its_lock(&url).await }).await;
}
