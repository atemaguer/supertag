//! Each Attempt's egress proxy log, reported by the Worker Host that runs it.
//!
//! The host's proxy decides every web request a Task with a network scope makes and keeps the
//! first [`MAX_REQUESTS`] with totals. The host reports the log, cumulatively, while it still owns
//! the Attempt; a later report replaces an earlier one. `GetTask` returns every Attempt's log.

use prost::Message;
use sqlx::{Any, Row};
use supertag_protocol::v2::{AttemptNetworkLog, NetworkLog, ReportNetworkLogRequest};

use crate::{
    Store,
    store::{HostAuthority, Result, invalid},
};

/// Requests a host keeps per Attempt.
pub const MAX_REQUESTS: usize = 500;
const MAX_FIELD_CHARS: usize = 300;

fn bounded_line(value: &str, what: &str) -> Result<()> {
    if value.chars().count() > MAX_FIELD_CHARS || value.chars().any(char::is_control) {
        return Err(invalid(&format!(
            "a network log {what} must be one line of at most {MAX_FIELD_CHARS} characters"
        )));
    }
    Ok(())
}

fn validate(log: &NetworkLog) -> Result<()> {
    if log.requests.len() > MAX_REQUESTS {
        return Err(invalid(&format!(
            "a network log keeps at most {MAX_REQUESTS} requests"
        )));
    }
    let (mut allowed, mut denied) = (0_u64, 0_u64);
    for record in &log.requests {
        if record.method.len() > 16
            || !record
                .method
                .chars()
                .all(|c| c.is_ascii_uppercase() || c == '-')
        {
            return Err(invalid("a network log method must be an uppercase token"));
        }
        bounded_line(&record.origin, "origin")?;
        bounded_line(&record.path, "path")?;
        bounded_line(&record.reason, "reason")?;
        if !record.credential.is_empty() {
            supertag_protocol::network_scope::validate_credential_name(&record.credential)
                .map_err(|reason| invalid(&reason))?;
        }
        if record.allowed {
            allowed += 1;
        } else {
            denied += 1;
        }
    }
    if log.allowed < allowed || log.denied < denied {
        return Err(invalid(
            "a network log's totals must count every request it keeps",
        ));
    }
    Ok(())
}

impl Store {
    /// Record the owning host's network log for its running Attempt, replacing an earlier one.
    pub async fn report_network_log(
        &self,
        host: &HostAuthority,
        request: &ReportNetworkLogRequest,
    ) -> Result<()> {
        let attempt = request
            .attempt
            .as_ref()
            .ok_or_else(|| invalid("Task Attempt is required"))?;
        let log = request
            .log
            .as_ref()
            .ok_or_else(|| invalid("network log is required"))?;
        validate(log)?;
        let (mut transaction, order) = self.write().await?;
        crate::store::owned(
            &mut transaction,
            host,
            &attempt.task_id,
            &attempt.attempt_id,
            &attempt.lease_token,
        )
        .await?;
        sqlx::query(
            "INSERT INTO supertag_v2_attempt_network_logs (task_id,attempt_id,recorded_order,log) VALUES ($1,$2,$3,$4)
             ON CONFLICT(task_id,attempt_id) DO UPDATE SET log=excluded.log",
        )
        .bind(&attempt.task_id)
        .bind(&attempt.attempt_id)
        .bind(order)
        .bind(log.encode_to_vec())
        .execute(&mut *transaction)
        .await?;
        transaction.commit().await?;
        Ok(())
    }
}

/// Every Attempt's network log, oldest Attempt first.
pub(crate) async fn logs_for(
    pool: &sqlx::Pool<Any>,
    task_id: &str,
) -> Result<Vec<AttemptNetworkLog>> {
    let rows = sqlx::query(
        "SELECT attempt_id,log FROM supertag_v2_attempt_network_logs WHERE task_id=$1 ORDER BY recorded_order",
    )
    .bind(task_id)
    .fetch_all(pool)
    .await?;
    rows.iter()
        .map(|row| {
            Ok(AttemptNetworkLog {
                attempt_id: row.try_get("attempt_id")?,
                log: Some(crate::policy::decode::<NetworkLog>(
                    &row.try_get::<Vec<u8>, _>("log")?,
                )?),
            })
        })
        .collect()
}
