//! Start rates: an operator's cap on how often a Tag's Task Attempts start, such as at most 10 an
//! hour, to smooth bursts like many Schedules coming due at once.
//!
//! A start is a claim, already recorded with its time. The window slides: a Task of a Tag at its
//! rate is not claimable, and stays queued until the oldest start in the window ages out. Nothing
//! is dropped or reordered, and other Tags keep running. A person's turn always starts, and
//! counts, so background work never keeps a person waiting. Claims serialize through the
//! Control Plane's write lock on both databases, so two replicas never both take the last start.
use sqlx::{Any, Row, Transaction, any::AnyRow};
use supertag_protocol::v2::{StartRate, Task};

use crate::store::{Result, invalid};

const MAX_STARTS: u32 = 10_000;
const MIN_PER_MS: u64 = 60 * 1000;
const MAX_PER_MS: u64 = 7 * 24 * 60 * 60 * 1000;

/// A Tag row's start rate, if it has one.
pub(crate) fn from_row(row: &AnyRow) -> Result<Option<StartRate>> {
    let starts: Option<i64> = row.try_get("start_rate_starts")?;
    let per: Option<i64> = row.try_get("start_rate_per_ms")?;
    Ok(starts.zip(per).map(|(starts, per)| StartRate {
        starts: starts as u32,
        per_ms: per as u64,
    }))
}

/// The start rate a Tag being written gets: as requested (`starts` 0 removes it), else as it was.
pub(crate) async fn requested_in(
    tx: &mut Transaction<'_, Any>,
    tag_id: &str,
    requested: Option<StartRate>,
) -> Result<Option<StartRate>> {
    match requested {
        Some(rate) if rate.starts == 0 => Ok(None),
        Some(rate) => {
            if rate.starts > MAX_STARTS {
                return Err(invalid("a start rate allows 1 to 10,000 starts"));
            }
            if !(MIN_PER_MS..=MAX_PER_MS).contains(&rate.per_ms) {
                return Err(invalid("a start rate's period is 1 minute to 7 days"));
            }
            Ok(Some(rate))
        }
        None => {
            let row = sqlx::query(
                "SELECT start_rate_starts,start_rate_per_ms FROM supertag_v2_tags WHERE tag_id=$1",
            )
            .bind(tag_id)
            .fetch_optional(&mut **tx)
            .await?;
            row.as_ref().map(from_row).transpose().map(Option::flatten)
        }
    }
}

async fn rate_in(tx: &mut Transaction<'_, Any>, tag_id: &str) -> Result<Option<StartRate>> {
    requested_in(tx, tag_id, None).await
}

/// The Tag's starts in the window ending now, oldest first, at most `starts` of them.
async fn starts_in(
    tx: &mut Transaction<'_, Any>,
    tag_id: &str,
    rate: &StartRate,
    now: i64,
) -> Result<Vec<i64>> {
    Ok(sqlx::query_scalar(
        "SELECT c.claimed_at_ms FROM supertag_v2_claims c JOIN supertag_v2_tasks t ON t.task_id=c.task_id
         WHERE t.tag_id=$1 AND c.claimed_at_ms>$2 AND c.task_id IS NOT NULL
         ORDER BY c.claimed_at_ms LIMIT $3",
    )
    .bind(tag_id)
    .bind(now - rate.per_ms as i64)
    .bind(i64::from(rate.starts))
    .fetch_all(&mut **tx)
    .await?)
}

/// How many of the Tag's Attempts started in its rate's window; zero without a rate.
pub(crate) async fn in_window_in(
    tx: &mut Transaction<'_, Any>,
    tag_id: &str,
    now: i64,
) -> Result<u32> {
    let Some(rate) = rate_in(tx, tag_id).await? else {
        return Ok(0);
    };
    // A person's turns start over the rate, so the window may hold more than `starts`.
    let count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM supertag_v2_claims c JOIN supertag_v2_tasks t ON t.task_id=c.task_id
         WHERE t.tag_id=$1 AND c.claimed_at_ms>$2",
    )
    .bind(tag_id)
    .bind(now - rate.per_ms as i64)
    .fetch_one(&mut **tx)
    .await?;
    Ok(u32::try_from(count).unwrap_or(u32::MAX))
}

/// When a Task held back by its Tag's start rate may start next, or `None` when the rate does
/// not hold it back. A person's turn is never held back.
pub(crate) async fn held_until_in(
    tx: &mut Transaction<'_, Any>,
    task: &Task,
    now: i64,
) -> Result<Option<(StartRate, i64)>> {
    let Some(rate) = rate_in(tx, &task.tag_id).await? else {
        return Ok(None);
    };
    let starts = starts_in(tx, &task.tag_id, &rate, now).await?;
    if (starts.len() as u32) < rate.starts || crate::attention::person_turn_in(tx, task).await? {
        return Ok(None);
    }
    Ok(Some((rate, starts[0] + rate.per_ms as i64)))
}

/// Whether the Task may start now under its Tag's start rate.
pub(crate) async fn can_start_in(
    tx: &mut Transaction<'_, Any>,
    task: &Task,
    now: i64,
) -> Result<bool> {
    Ok(held_until_in(tx, task, now).await?.is_none())
}

/// A rate as people write it: `10/1h`.
pub(crate) fn describe(rate: &StartRate) -> String {
    let per = rate.per_ms / 1000;
    let period = if per.is_multiple_of(86_400) {
        format!("{}d", per / 86_400)
    } else if per.is_multiple_of(3600) {
        format!("{}h", per / 3600)
    } else {
        format!("{}m", per / 60)
    };
    format!("{}/{period}", rate.starts)
}

/// A time of day, in the Control Plane's zone, with its date when it is not today.
pub(crate) fn clock(ms: i64, zone: chrono_tz::Tz) -> String {
    use chrono::TimeZone;
    let Some(at) = zone.timestamp_millis_opt(ms).single() else {
        return String::new();
    };
    at.format("%Y-%m-%d %H:%M %Z").to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rates_read_as_people_write_them() {
        let rate = |starts, per_ms| StartRate { starts, per_ms };
        assert_eq!(describe(&rate(10, 3_600_000)), "10/1h");
        assert_eq!(describe(&rate(3, 90 * 60_000)), "3/90m");
        assert_eq!(describe(&rate(1, 2 * 86_400_000)), "1/2d");
    }
}
