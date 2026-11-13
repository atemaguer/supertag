//! Runs one split-process test body against SQLite and against a disposable PostgreSQL database.
//!
//! The test crate must declare `prerequisites` (from `rust/test-support`) before this module.
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
/// own database, dropped afterwards even when the body fails or panics. The body is boxed
/// because split-process test futures are large.
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
            let name = format!("supertag_rust_process_{}", uuid::Uuid::new_v4().simple());
            admin
                .execute(format!("CREATE DATABASE {name}").as_str())
                .await?;
            let url = options.database(&name).to_url_lossy().to_string();
            let outcome = AssertUnwindSafe(Box::pin(test(url))).catch_unwind().await;
            // FORCE ends connections from any service a failed body left running.
            let cleanup = admin
                .execute(format!("DROP DATABASE {name} WITH (FORCE)").as_str())
                .await;
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
        $reason
    };
}
