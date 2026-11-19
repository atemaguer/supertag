//! Hints between Control Plane replicas on PostgreSQL.
//!
//! Every transaction that records watch notices notifies channel [`CHANNEL`] as it commits (see
//! migration 0116), once per transaction and with no content. Each replica's tail keeps one
//! listener connection of its own, outside the pool, and treats a notification as a hint. While
//! the listener is disconnected the tail's poll carries on, and a reconnect is a hint of its own,
//! so a lost notification costs at most one poll interval.
use std::{str::FromStr, sync::Arc, time::Duration};

use sqlx::postgres::{PgConnectOptions, PgListener, PgPoolOptions};
use tokio_util::sync::CancellationToken;

use crate::conversations::Live;

pub(crate) const CHANNEL: &str = "supertag_v2_hints";
/// How the listener's connection names itself to PostgreSQL.
pub(crate) const APPLICATION_NAME: &str = "supertag-hints";
const FIRST_RETRY: Duration = Duration::from_millis(250);
const MAX_RETRY: Duration = Duration::from_secs(30);

/// The listener's connection options for the database at `url`.
pub(crate) fn options(url: &str) -> anyhow::Result<PgConnectOptions> {
    Ok(PgConnectOptions::from_str(url)?.application_name(APPLICATION_NAME))
}

/// Listens until `stop`, reconnecting with jittered backoff.
pub(crate) async fn listen(options: PgConnectOptions, live: Arc<Live>, stop: CancellationToken) {
    let mut retry = FIRST_RETRY;
    loop {
        #[cfg(test)]
        while live
            .bus
            .listener_paused
            .load(std::sync::atomic::Ordering::SeqCst)
        {
            tokio::select! {
                _ = stop.cancelled() => return,
                _ = tokio::time::sleep(Duration::from_millis(20)) => {}
            }
        }
        let connected = tokio::select! {
            _ = stop.cancelled() => return,
            connected = connect(&options) => connected,
        };
        if let Ok(mut listener) = connected {
            retry = FIRST_RETRY;
            // What committed while nobody listened.
            live.bus.hint();
            loop {
                let received = tokio::select! {
                    _ = stop.cancelled() => return,
                    received = listener.try_recv() => received,
                };
                match received {
                    // The payload names only kinds; any of them means the feed may have moved.
                    Ok(Some(_)) => live.bus.hint(),
                    // The connection was lost.
                    Ok(None) | Err(_) => break,
                }
            }
            live.bus.hint();
        }
        tokio::select! {
            _ = stop.cancelled() => return,
            _ = tokio::time::sleep(jittered(retry)) => {}
        }
        retry = (retry * 2).min(MAX_RETRY);
    }
}

async fn connect(options: &PgConnectOptions) -> sqlx::Result<PgListener> {
    let pool = PgPoolOptions::new()
        .max_connections(1)
        .acquire_timeout(Duration::from_secs(10))
        .connect_lazy_with(options.clone());
    let mut listener = PgListener::connect_with(&pool).await?;
    listener.listen(CHANNEL).await?;
    Ok(listener)
}

/// Between half of `retry` and all of it, so replicas that lost the database together do not
/// reconnect together.
fn jittered(retry: Duration) -> Duration {
    let half = retry / 2;
    let spread = half.as_millis().max(1) as u64;
    half + Duration::from_millis((uuid::Uuid::new_v4().as_u128() as u64) % spread)
}
