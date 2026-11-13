//! Control Plane replicas on one database: schema setup, shared maintenance, and the SQLite
//! single-process rule. `cli/tests/replicas_runtime.rs` runs real replicas as processes.

use std::{fs::File, path::Path, time::Duration};

use sqlx::{Connection, Executor};
use supertag_control_plane::Store;
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

#[tokio::test]
#[ignore = "requires SUPERTAG_RUST_TEST_POSTGRES_URL_FILE for a dedicated PostgreSQL test server"]
async fn postgres_replicas_start_together_and_share_one_maintenance_pass() {
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
    let local = tokio::task::LocalSet::new();
    let outcome = local
        .run_until(async move {
            tokio::task::spawn_local(async move {
                // Replicas that start together on an empty database migrate it once between them.
                let mut opened = JoinSet::new();
                for _ in 0..4 {
                    let url = url.to_string();
                    opened.spawn_local(async move { Store::open(&url).await.unwrap() });
                }
                let stores = opened.join_all().await;
                let mut connection = sqlx::PgConnection::connect(url.as_str()).await.unwrap();
                let versions: Vec<i64> =
                    sqlx::query_scalar("SELECT version FROM supertag_v2_schema")
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
            .await
        })
        .await;
    admin
        .execute(format!("DROP DATABASE {name} WITH (FORCE)").as_str())
        .await
        .unwrap();
    admin.close().await.unwrap();
    outcome.expect("PostgreSQL replica contract failed");
}
