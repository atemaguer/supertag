//! Runs one split-process test body against SQLite and against a disposable PostgreSQL database.
//!
//! The test crate must declare `prerequisites` (from `core/test-support`) before this module.
#![allow(dead_code)]

use std::{future::Future, os::unix::fs::PermissionsExt, panic::AssertUnwindSafe, str::FromStr};

use anyhow::{Context, Result};
use futures_util::FutureExt;
use sqlx::{
    ConnectOptions, Connection, Executor,
    postgres::{PgConnectOptions, PgConnection},
};

#[derive(Clone, Copy, Debug)]
pub enum Backend {
    Sqlite,
    Postgres,
}

/// Runs `test` with a Control Plane database URL for `backend`. PostgreSQL cases each get their
/// own database, dropped afterwards even when the body fails, panics, or is cancelled; a database
/// left by a killed test process is dropped by the next PostgreSQL case. The body is boxed because
/// split-process test futures are large.
pub async fn run<F, Fut>(backend: Backend, test: F) -> Result<()>
where
    F: FnOnce(String) -> Fut,
    Fut: Future<Output = Result<()>>,
{
    match backend {
        Backend::Sqlite => {
            let directory = tempfile::TempDir::new()?;
            let url = migrated_sqlite(directory.path(), "control-plane.db").await?;
            Box::pin(test(url)).await
        }
        Backend::Postgres => {
            let Some(path) =
                crate::prerequisites::env("postgres", "SUPERTAG_RUST_TEST_POSTGRES_URL_FILE")?
            else {
                return Ok(());
            };
            let admin_url = std::fs::read_to_string(&path)
                .context("read SUPERTAG_RUST_TEST_POSTGRES_URL_FILE")?;
            let options = PgConnectOptions::from_str(admin_url.trim())?;
            let started = std::time::Instant::now();
            let mut admin = PgConnection::connect_with(&options).await?;
            drop_abandoned_databases(&mut admin, false).await?;
            let name = format!(
                "{PREFIX}{}_{}",
                std::process::id(),
                uuid::Uuid::new_v4().simple()
            );
            // A copy of the migrated template, so the Control Plane starts without replaying
            // every migration. The template accepts no connections, so concurrent cases cannot
            // contend for it.
            create_migrated_postgres(&mut admin, &options, &name).await?;
            let mut guard = DatabaseGuard {
                options: options.clone(),
                name: Some(name.clone()),
            };
            let url = options.database(&name).to_url_lossy().to_string();
            timing("pg-create", started);
            let outcome = AssertUnwindSafe(Box::pin(test(url))).catch_unwind().await;
            guard.name = None;
            let cleanup = drop_database(&mut admin, &name).await;
            admin.close().await?;
            match outcome {
                Ok(result) => {
                    cleanup?;
                    result
                }
                Err(panic) => std::panic::resume_unwind(panic),
            }
        }
    }
}

/// Appends `label elapsed_ms` to the file named by SUPERTAG_TEST_TIMINGS, when set.
pub fn timing(label: &str, started: std::time::Instant) {
    if let Some(path) = std::env::var_os("SUPERTAG_TEST_TIMINGS") {
        use std::io::Write;
        if let Ok(mut file) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
        {
            let _ =
                file.write_all(format!("{label}\t{}\n", started.elapsed().as_millis()).as_bytes());
        }
    }
}

/// A digest of the Control Plane's migrations, naming the migrated templates: a changed
/// migration gets a new template.
fn migrations_digest() -> Result<String> {
    use sha2::{Digest, Sha256};
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../control-plane/migrations");
    let mut digest = Sha256::new();
    for backend in ["sqlite", "postgresql"] {
        let mut files: Vec<_> = std::fs::read_dir(root.join(backend))?
            .map(|entry| entry.map(|entry| entry.path()))
            .collect::<std::io::Result<_>>()?;
        files.sort();
        for file in files {
            digest.update(file.file_name().unwrap_or_default().as_encoded_bytes());
            digest.update(std::fs::read(&file)?);
        }
    }
    Ok(format!("{:x}", digest.finalize())[..16].to_owned())
}

/// A Control Plane SQLite store named `file` in `directory`, copied from this process's migrated
/// store, so the Control Plane starts without replaying every migration. Returns its URL.
pub async fn migrated_sqlite(directory: &std::path::Path, file: &str) -> Result<String> {
    let database = directory.join(file);
    let template = sqlite_template().await?;
    std::fs::copy(template, &database)?;
    std::fs::set_permissions(&database, std::fs::Permissions::from_mode(0o600))?;
    // The template is checkpointed when made, so it has no write-ahead log; copy one anyway if
    // it does, as the database's committed rows would otherwise be missing from the copy.
    let mut log = template.as_os_str().to_owned();
    log.push("-wal");
    if std::path::Path::new(&log).exists() {
        let copy = directory.join(format!("{file}-wal"));
        std::fs::copy(&log, &copy)?;
        std::fs::set_permissions(&copy, std::fs::Permissions::from_mode(0o600))?;
    }
    Ok(format!("sqlite://{}?mode=rwc", database.display()))
}

/// Creates PostgreSQL database `name` from the migrated template, so the Control Plane starts
/// without replaying every migration. The template accepts no connections, so concurrent cases
/// cannot contend for it.
pub async fn create_migrated_postgres(
    admin: &mut PgConnection,
    options: &PgConnectOptions,
    name: &str,
) -> Result<()> {
    let template = postgres_template(admin, options).await?;
    admin
        .execute(format!("CREATE DATABASE {name} TEMPLATE {template}").as_str())
        .await?;
    Ok(())
}

/// This test process's migrated SQLite store, made once and copied for each case.
async fn sqlite_template() -> Result<&'static std::path::Path> {
    static TEMPLATE: tokio::sync::OnceCell<tempfile::TempDir> = tokio::sync::OnceCell::const_new();
    let directory = TEMPLATE
        .get_or_try_init(|| async {
            let directory = tempfile::TempDir::new()?;
            let url = format!(
                "sqlite://{}?mode=rwc",
                directory.path().join("template.db").display()
            );
            let store = supertag_control_plane::Store::open(&url).await?;
            store.close().await;
            // The store writes through a write-ahead log: fold it into the file so a copy of
            // the file alone holds every migrated row.
            let mut connection = sqlx::SqliteConnection::connect(&url).await?;
            sqlx::query("PRAGMA wal_checkpoint(TRUNCATE)")
                .execute(&mut connection)
                .await?;
            connection.close().await?;
            anyhow::Ok(directory)
        })
        .await?;
    Ok(Box::leak(
        directory.path().join("template.db").into_boxed_path(),
    ))
}

/// Every migrated PostgreSQL template's name starts with this, then the migrations' digest.
const TEMPLATE_PREFIX: &str = "supertag_rust_template_";
/// `pg_advisory_lock` key that serializes template creation across test processes.
const TEMPLATE_LOCK: i64 = 0x5375_7065_7254_706c;

async fn template_exists(admin: &mut PgConnection, name: &str) -> Result<bool> {
    Ok(
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM pg_database WHERE datname=$1")
            .bind(name)
            .fetch_one(admin)
            .await?
            == 1,
    )
}

/// The migrated PostgreSQL template for these migrations, made once per cluster. Templates of
/// other migrations are dropped when nothing uses them.
async fn postgres_template(admin: &mut PgConnection, options: &PgConnectOptions) -> Result<String> {
    let name = format!("{TEMPLATE_PREFIX}{}", migrations_digest()?);
    if template_exists(&mut *admin, &name).await? {
        return Ok(name);
    }
    sqlx::query("SELECT pg_advisory_lock($1)")
        .bind(TEMPLATE_LOCK)
        .execute(&mut *admin)
        .await?;
    let made = async {
        if template_exists(&mut *admin, &name).await? {
            return anyhow::Ok(());
        }
        let stale: Vec<String> = sqlx::query_scalar(
            "SELECT datname FROM pg_database WHERE starts_with(datname, $1) AND datname<>$2",
        )
        .bind(TEMPLATE_PREFIX)
        .bind(&name)
        .fetch_all(&mut *admin)
        .await?;
        for old in stale {
            // Another process may still be copying it; it goes on a later run.
            let _ = admin
                .execute(format!("DROP DATABASE IF EXISTS {old}").as_str())
                .await;
        }
        // Migrate under a temporary name, so a template exists only once complete.
        let building = format!("{name}_building");
        admin
            .execute(format!("DROP DATABASE IF EXISTS {building} WITH (FORCE)").as_str())
            .await?;
        admin
            .execute(format!("CREATE DATABASE {building} TEMPLATE template0").as_str())
            .await?;
        let url = options
            .clone()
            .database(&building)
            .to_url_lossy()
            .to_string();
        let store = supertag_control_plane::Store::open(&url).await?;
        store.close().await;
        // A closed pool's backends exit asynchronously; a rename needs them gone.
        admin
            .execute(format!("ALTER DATABASE {building} ALLOW_CONNECTIONS false").as_str())
            .await?;
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(60);
        loop {
            let remaining: i64 = sqlx::query_scalar(
                "SELECT COUNT(pg_terminate_backend(pid)) FROM pg_stat_activity \
                 WHERE datname = $1 AND pid <> pg_backend_pid()",
            )
            .bind(&building)
            .fetch_one(&mut *admin)
            .await?;
            if remaining == 0 {
                break;
            }
            anyhow::ensure!(
                std::time::Instant::now() < deadline,
                "the template's migration connections did not exit"
            );
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
        admin
            .execute(format!("ALTER DATABASE {building} RENAME TO {name}").as_str())
            .await?;
        Ok(())
    }
    .await;
    sqlx::query("SELECT pg_advisory_unlock($1)")
        .bind(TEMPLATE_LOCK)
        .execute(&mut *admin)
        .await?;
    made?;
    Ok(name)
}

/// Every per-case database name starts with this, then the owning test process's PID.
const PREFIX: &str = "supertag_rust_process_";

/// Drops `name` even while a service the body left running holds or reopens connections: new
/// connections are refused first, then its backends are terminated and awaited, then `FORCE`
/// drops it; a drop that still loses a race is retried.
pub async fn drop_database(admin: &mut PgConnection, name: &str) -> Result<()> {
    let _ = admin
        .execute(format!("ALTER DATABASE {name} ALLOW_CONNECTIONS false").as_str())
        .await;
    // FORCE waits only five seconds for terminated backends to exit, which a backend of a
    // service the body left running can exceed on a loaded machine. Terminate them first and
    // wait for them to go, without a deadline that short.
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(60);
    loop {
        let remaining: i64 = sqlx::query_scalar(
            "SELECT COUNT(pg_terminate_backend(pid)) FROM pg_stat_activity \
             WHERE datname = $1 AND pid <> pg_backend_pid()",
        )
        .bind(name)
        .fetch_one(&mut *admin)
        .await?;
        if remaining == 0 || std::time::Instant::now() >= deadline {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    let mut attempt = 0;
    loop {
        match admin
            .execute(format!("DROP DATABASE IF EXISTS {name} WITH (FORCE)").as_str())
            .await
        {
            Ok(_) => return Ok(()),
            Err(error) if attempt < 5 => {
                attempt += 1;
                eprintln!("retrying DROP DATABASE {name}: {error}");
                tokio::time::sleep(std::time::Duration::from_millis(200 * attempt)).await;
            }
            Err(error) => return Err(error).with_context(|| format!("drop database {name}")),
        }
    }
}

/// Drops per-case databases whose test process is gone: a process killed mid-case (a runner
/// timeout, Ctrl-C, `SIGKILL`) never reaches its own cleanup. Each case runs this first, so a
/// cluster keeps only the databases of running cases. `legacy` also drops databases named
/// before the owner's PID was part of the name, when nothing is connected to them.
pub async fn drop_abandoned_databases(
    admin: &mut PgConnection,
    legacy: bool,
) -> Result<Vec<String>> {
    let databases: Vec<(String, i64)> = sqlx::query_as(
        "SELECT datname, (SELECT COUNT(*) FROM pg_stat_activity a WHERE a.datid = d.oid) \
         FROM pg_database d WHERE starts_with(datname, $1)",
    )
    .bind(PREFIX)
    .fetch_all(&mut *admin)
    .await?;
    let mut dropped = Vec::new();
    for (name, connections) in databases {
        let abandoned = match owner(&name) {
            Some(pid) => !process_exists(pid),
            None => legacy && connections == 0,
        };
        if abandoned {
            drop_database(admin, &name).await?;
            dropped.push(name);
        }
    }
    Ok(dropped)
}

/// The test process PID in a per-case database name.
fn owner(name: &str) -> Option<i32> {
    let (pid, _) = name.strip_prefix(PREFIX)?.split_once('_')?;
    pid.parse().ok()
}

fn process_exists(pid: i32) -> bool {
    // SAFETY: signal 0 only checks that the process exists; EPERM means it does.
    let status = unsafe { libc::kill(pid, 0) };
    status == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

/// Drops the database if the case's future is dropped before it finishes (a Tokio timeout or a
/// cancelled task), which skips the cleanup after the body.
struct DatabaseGuard {
    options: PgConnectOptions,
    name: Option<String>,
}

impl Drop for DatabaseGuard {
    fn drop(&mut self) {
        let Some(name) = self.name.take() else {
            return;
        };
        let options = self.options.clone();
        // Drop may run on a runtime thread, which cannot block on another runtime.
        let _ = std::thread::spawn(move || {
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()?;
            runtime.block_on(async {
                let mut admin = PgConnection::connect_with(&options).await?;
                drop_database(&mut admin, &name).await?;
                admin.close().await?;
                anyhow::Ok(())
            })
        })
        .join();
    }
}

/// Opens a direct connection to either backend so a fixture can inspect or adjust persisted state.
pub async fn connect(url: &str) -> Result<sqlx::AnyConnection> {
    sqlx::any::install_default_drivers();
    let mut connection = sqlx::AnyConnection::connect(url).await?;
    if url.starts_with("sqlite:") {
        // The Control Plane under test holds SQLite's write lock for its own transactions; a
        // loaded machine stretches those past the default five-second busy wait.
        connection.execute("PRAGMA busy_timeout = 60000").await?;
    }
    Ok(connection)
}

/// Declares the cases of a split-process test that runs once per database backend. For each
/// `async fn NAME(database: String) -> Result<()>` named here, the macro adds `NAME::sqlite` and
/// `NAME::postgres`. An `#[ignore = "..."]` before the name applies to both cases; otherwise only
/// the PostgreSQL case is ignored, because it needs `SUPERTAG_RUST_TEST_POSTGRES_URL_FILE`.
#[allow(unused_macros)]
macro_rules! database_tests {
    ($(#[$runtime:meta] $(#[ignore = $reason:literal])? $name:ident;)+) => {
        $(
            mod $name {
                #[$runtime]
                $(#[ignore = $reason])?
                async fn sqlite() -> anyhow::Result<()> {
                    crate::database::run(crate::database::Backend::Sqlite, super::$name).await
                }

                #[$runtime]
                #[ignore = database_tests!(@postgres_reason $($reason)?)]
                async fn postgres() -> anyhow::Result<()> {
                    crate::database::run(crate::database::Backend::Postgres, super::$name).await
                }
            }
        )+
    };
    (@postgres_reason) => {
        "requires an isolated PostgreSQL server via SUPERTAG_RUST_TEST_POSTGRES_URL_FILE"
    };
    (@postgres_reason $reason:literal) => {
        concat!(
            $reason,
            "; also requires an isolated PostgreSQL server via SUPERTAG_RUST_TEST_POSTGRES_URL_FILE"
        )
    };
}
