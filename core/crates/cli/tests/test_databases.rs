//! Cleanup for the PostgreSQL databases split-process test cases create (support/database.rs).
//!
//! Every PostgreSQL case already drops databases whose test process is gone before it starts.
//! Run this to also clear older leftovers by hand:
//!
//! ```sh
//! SUPERTAG_RUST_TEST_POSTGRES_URL_FILE=<file holding the admin URL> \
//!   cargo test -p supertag-cli --test test_databases -- --ignored drop_abandoned
//! ```
#[path = "../../../test-support/prerequisites.rs"]
mod prerequisites;

#[path = "support/database.rs"]
#[allow(unused_macros)]
mod database;

use std::str::FromStr;

use anyhow::{Context, Result};
use sqlx::{
    Connection, Executor,
    postgres::{PgConnectOptions, PgConnection},
};

/// A database whose test process is gone (here a PID no process can have) is dropped by the next
/// PostgreSQL case; the case's own database is dropped after it.
#[tokio::test]
#[ignore = "requires an isolated PostgreSQL server via SUPERTAG_RUST_TEST_POSTGRES_URL_FILE"]
async fn the_next_case_drops_a_killed_process_database() -> Result<()> {
    let Some(path) = prerequisites::env("postgres", "SUPERTAG_RUST_TEST_POSTGRES_URL_FILE")? else {
        return Ok(());
    };
    let url =
        std::fs::read_to_string(&path).context("read SUPERTAG_RUST_TEST_POSTGRES_URL_FILE")?;
    let mut admin = PgConnection::connect_with(&PgConnectOptions::from_str(url.trim())?).await?;
    let abandoned = format!(
        "supertag_rust_process_{}_{}",
        i32::MAX,
        uuid::Uuid::new_v4().simple()
    );
    admin
        .execute(format!("CREATE DATABASE {abandoned} TEMPLATE template0").as_str())
        .await?;
    let mut used = None;
    database::run(database::Backend::Postgres, |url| {
        used = url
            .rsplit('/')
            .next()
            .map(|name| name.split('?').next().unwrap_or(name).to_owned());
        async { Ok(()) }
    })
    .await?;
    let used = used.context("the case received no database")?;
    let remaining: Vec<String> =
        sqlx::query_scalar("SELECT datname FROM pg_database WHERE datname = $1 OR datname = $2")
            .bind(&abandoned)
            .bind(&used)
            .fetch_all(&mut admin)
            .await?;
    admin.close().await?;
    assert!(remaining.is_empty(), "left behind: {remaining:?}");
    Ok(())
}

#[tokio::test]
#[ignore = "drops abandoned test databases on the server in SUPERTAG_RUST_TEST_POSTGRES_URL_FILE"]
async fn drop_abandoned_postgres_test_databases() -> Result<()> {
    let Some(path) = prerequisites::env("postgres", "SUPERTAG_RUST_TEST_POSTGRES_URL_FILE")? else {
        return Ok(());
    };
    let url =
        std::fs::read_to_string(&path).context("read SUPERTAG_RUST_TEST_POSTGRES_URL_FILE")?;
    let mut admin = PgConnection::connect_with(&PgConnectOptions::from_str(url.trim())?).await?;
    let dropped = database::drop_abandoned_databases(&mut admin, true).await?;
    admin.close().await?;
    eprintln!("dropped {} abandoned test databases", dropped.len());
    Ok(())
}
