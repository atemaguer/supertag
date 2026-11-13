//! A replica that freezes inside a write cannot stall the others on PostgreSQL.

use std::time::{Duration, Instant};

use sqlx::{Connection, Executor};

use super::Store;

#[tokio::test]
#[ignore = "requires SUPERTAG_RUST_TEST_POSTGRES_URL_FILE"]
async fn postgres_frozen_replica_releases_the_write_lock() -> anyhow::Result<()> {
    let path = std::env::var_os("SUPERTAG_RUST_TEST_POSTGRES_URL_FILE")
        .ok_or_else(|| anyhow::anyhow!("set SUPERTAG_RUST_TEST_POSTGRES_URL_FILE"))?;
    let url = std::fs::read_to_string(path)?;
    let mut admin = sqlx::PgConnection::connect(url.trim()).await?;
    let database = format!("supertag_rust_frozen_{}", uuid::Uuid::new_v4().simple());
    admin
        .execute(format!("CREATE DATABASE {database}").as_str())
        .await?;
    let mut test_url = url::Url::parse(url.trim())?;
    test_url.set_path(&database);
    let result = tokio::task::LocalSet::new()
        .run_until(async move {
            tokio::task::spawn_local(async move { frozen(test_url.as_str()).await }).await
        })
        .await;
    admin
        .execute(format!("DROP DATABASE {database} WITH (FORCE)").as_str())
        .await?;
    result?
}

async fn frozen(url: &str) -> anyhow::Result<()> {
    let frozen = Store::open(url).await?;
    let other = Store::open(url).await?;
    let timeout: String = sqlx::query_scalar("SHOW idle_in_transaction_session_timeout")
        .fetch_one(&frozen.pool)
        .await?;
    assert_eq!(timeout, "15s");
    // The frozen replica holds the write lock and never issues another statement.
    let (mut held, _) = frozen.write().await?;
    let started = Instant::now();
    tokio::time::timeout(Duration::from_secs(40), other.write())
        .await
        .map_err(|_| anyhow::anyhow!("the frozen replica still holds the write lock"))??
        .0
        .commit()
        .await?;
    assert!(started.elapsed() >= Duration::from_secs(10));
    // PostgreSQL ended the frozen session, so its transaction can no longer commit anything.
    assert!(sqlx::query("SELECT 1").execute(&mut *held).await.is_err());
    drop(held);
    other.put_tag("engineer", "Carry on", vec![]).await?;
    frozen.close().await;
    other.close().await;
    Ok(())
}
