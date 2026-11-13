//! The SQLite database and its WAL and shared-memory files stay private to their owner
//! (`packages/store/sqlite-file-mode.test.ts`).

use std::{
    fs,
    os::unix::fs::{PermissionsExt, symlink},
    path::Path,
};

use sqlx::{Connection, Executor, SqliteConnection};
use supertag_control_plane::Store;

fn mode(path: &Path) -> u32 {
    fs::metadata(path).unwrap().permissions().mode() & 0o777
}

fn files(path: &Path) -> [std::path::PathBuf; 3] {
    let companion = |suffix: &str| {
        let mut name = path.as_os_str().to_owned();
        name.push(suffix);
        std::path::PathBuf::from(name)
    };
    [path.to_owned(), companion("-wal"), companion("-shm")]
}

/// Opens a second connection that keeps the WAL and shared-memory files live with a row in them.
async fn live_wal(path: &Path) -> SqliteConnection {
    let mut seed = SqliteConnection::connect(&format!("sqlite://{}", path.display()))
        .await
        .unwrap();
    seed.execute("PRAGMA journal_mode = WAL").await.unwrap();
    seed.execute("CREATE TABLE IF NOT EXISTS supertag_v2_retained (value TEXT); INSERT INTO supertag_v2_retained VALUES ('kept')")
        .await
        .unwrap();
    seed
}

async fn retained(seed: &mut SqliteConnection) -> String {
    sqlx::query_scalar("SELECT value FROM supertag_v2_retained")
        .fetch_one(seed)
        .await
        .unwrap()
}

/// A umask that lets SQLite create group- and world-readable files, so only the Control Plane's
/// own owner-only steps keep the files private. Every test sets the same mask.
fn permissive_umask() {
    // SAFETY: umask only replaces the process file mode creation mask.
    unsafe { libc::umask(0o022) };
}

#[tokio::test]
async fn creates_a_private_database_and_lets_sqlite_create_private_wal_files() {
    permissive_umask();
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("supertag.db");
    let store = Store::open(&format!("sqlite://{}?mode=rwc", path.display()))
        .await
        .unwrap();
    assert_eq!(mode(&path), 0o600);
    store.put_tag("tag-a", "Work.", Vec::new()).await.unwrap();
    // SQLite gives the WAL and shared-memory files it creates, and recreates, the database's own
    // permissions.
    for _ in 0..2 {
        let seed = live_wal(&path).await;
        assert_eq!(files(&path).map(|file| mode(&file)), [0o600; 3]);
        seed.close().await.unwrap();
    }
    assert_eq!(mode(&path), 0o600);
    store.close().await;
}

#[tokio::test]
async fn opening_tightens_an_existing_database_and_its_live_wal_files() {
    permissive_umask();
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("supertag.db");
    let url = format!("sqlite://{}?mode=rwc", path.display());
    Store::open(&url).await.unwrap().close().await;
    let mut seed = live_wal(&path).await;
    for file in files(&path) {
        fs::set_permissions(&file, fs::Permissions::from_mode(0o644)).unwrap();
    }
    // An existing database is reopened without `mode=rwc`, as `supertag up` does.
    let store = Store::open(&format!("sqlite://{}?mode=rw", path.display()))
        .await
        .unwrap();
    assert_eq!(files(&path).map(|file| mode(&file)), [0o600; 3]);
    assert_eq!(retained(&mut seed).await, "kept");
    store.close().await;
    seed.close().await.unwrap();
}

#[tokio::test]
async fn tightens_the_files_behind_a_database_symlink() {
    permissive_umask();
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("supertag.db");
    let alias = directory.path().join("supertag.db-alias");
    Store::open(&format!("sqlite://{}?mode=rwc", path.display()))
        .await
        .unwrap()
        .close()
        .await;
    let mut seed = live_wal(&path).await;
    symlink(&path, &alias).unwrap();
    for file in files(&path) {
        fs::set_permissions(&file, fs::Permissions::from_mode(0o644)).unwrap();
    }
    let store = Store::open(&format!("sqlite://{}?mode=rwc", alias.display()))
        .await
        .unwrap();
    assert_eq!(files(&path).map(|file| mode(&file)), [0o600; 3]);
    assert_eq!(retained(&mut seed).await, "kept");
    store.close().await;
    seed.close().await.unwrap();
}

#[tokio::test]
async fn creates_the_missing_target_of_a_database_symlink_private() {
    permissive_umask();
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("supertag.db");
    let alias = directory.path().join("supertag.db-alias");
    symlink(&path, &alias).unwrap();
    let store = Store::open(&format!("sqlite://{}?mode=rwc", alias.display()))
        .await
        .unwrap();
    assert_eq!(mode(&path), 0o600);
    store.put_tag("tag-a", "Work.", Vec::new()).await.unwrap();
    let seed = live_wal(&path).await;
    assert_eq!(files(&path).map(|file| mode(&file)), [0o600; 3]);
    seed.close().await.unwrap();
    store.close().await;
}
