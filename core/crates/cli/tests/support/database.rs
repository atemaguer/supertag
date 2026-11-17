//! Runs one split-process test body against SQLite and against a disposable PostgreSQL database.
//!
//! The test crate must declare `prerequisites` (from `core/test-support`) before this module.
#![allow(dead_code)]

use std::{future::Future, panic::AssertUnwindSafe, str::FromStr};

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
            let url = format!(
                "sqlite://{}?mode=rwc",
                directory.path().join("control-plane.db").display()
            );
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
            let mut admin = PgConnection::connect_with(&options).await?;
            drop_abandoned_databases(&mut admin, false).await?;
            let name = format!(
                "{PREFIX}{}_{}",
                std::process::id(),
                uuid::Uuid::new_v4().simple()
            );
            // template0 never accepts connections, so concurrent cases cannot contend for it.
            admin
                .execute(format!("CREATE DATABASE {name} TEMPLATE template0").as_str())
                .await?;
            let mut guard = DatabaseGuard {
                options: options.clone(),
                name: Some(name.clone()),
            };
            let url = options.database(&name).to_url_lossy().to_string();
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

/// Every per-case database name starts with this, then the owning test process's PID.
const PREFIX: &str = "supertag_rust_process_";

/// Drops `name` even while a service the body left running holds or reopens connections: new
/// connections are refused first, then `FORCE` ends the existing ones. A backend that does not
/// exit within PostgreSQL's five-second grace still fails the drop, so it is retried.
pub async fn drop_database(admin: &mut PgConnection, name: &str) -> Result<()> {
    let mut attempt = 0;
    loop {
        let _ = admin
            .execute(format!("ALTER DATABASE {name} ALLOW_CONNECTIONS false").as_str())
            .await;
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
    Ok(sqlx::AnyConnection::connect(url).await?)
}

/// Declares the cases of a split-process test that runs once per database backend. For each
/// `async fn NAME(database: String) -> Result<()>` named here, the macro adds `NAME::sqlite` and
/// `NAME::postgres`. An `#[ignore = "..."]` before the name applies to both cases; otherwise only
/// the PostgreSQL case is ignored, because it needs `SUPERTAG_RUST_TEST_POSTGRES_URL_FILE`.
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
