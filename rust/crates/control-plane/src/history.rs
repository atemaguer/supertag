use sqlx::Row;
use supertag_protocol::v2::{
    AttemptHistory, AttemptHistoryEntry, InspectAttemptRequest, TaskState,
};

use crate::{
    Store, StoreError,
    store::{HostAuthority, Result, lease_is_live, owned},
};

impl Store {
    /// A bounded continuity view, scoped to the current execution's immutable audience.
    pub async fn get_attempt_history(
        &self,
        host: &HostAuthority,
        attempt: &InspectAttemptRequest,
    ) -> Result<AttemptHistory> {
        let mut tx = self.pool.begin().await?;
        let task = owned(
            &mut tx,
            host,
            &attempt.task_id,
            &attempt.attempt_id,
            &attempt.lease_token,
        )
        .await?;
        if task.try_get::<i64, _>("state")? != TaskState::Running as i64
            || !lease_is_live(&task, self.execution_now_ms())?
        {
            return Err(StoreError::FailedPrecondition(
                "Attempt is not running with current authority".into(),
            ));
        }
        let rows = sqlx::query(
            "SELECT prior.task_id,prior.prompt,prior.result FROM supertag_v2_tasks prior
             JOIN supertag_v2_task_audience audience ON audience.task_id=prior.task_id
             JOIN supertag_v2_task_audience current_audience ON current_audience.task_id=$1
             WHERE prior.tag_id=$2 AND prior.session_id=$3 AND prior.accepted_order<$4
               AND prior.state IN ($5,$6,$7) AND prior.cleanup_pending=0
               AND prior.result IS NOT NULL AND audience.owner=current_audience.owner
             ORDER BY prior.accepted_order DESC LIMIT 5",
        )
        .bind(&attempt.task_id)
        .bind(task.try_get::<String, _>("tag_id")?)
        .bind(task.try_get::<String, _>("session_id")?)
        .bind(task.try_get::<i64, _>("accepted_order")?)
        .bind(TaskState::Succeeded as i64)
        .bind(TaskState::Failed as i64)
        .bind(TaskState::Cancelled as i64)
        .fetch_all(&mut *tx)
        .await?;
        let entries = rows
            .iter()
            .rev()
            .map(|row| {
                Ok(AttemptHistoryEntry {
                    task_id: row.try_get("task_id")?,
                    prompt: bounded(row.try_get("prompt")?, 2_000),
                    result: Some(bounded(row.try_get("result")?, 4_000)),
                })
            })
            .collect::<Result<Vec<_>>>()?;
        tx.commit().await?;
        Ok(AttemptHistory { entries })
    }
}

fn bounded(text: String, limit: usize) -> String {
    let mut units = 0;
    for (index, character) in text.char_indices() {
        units += character.len_utf16();
        if units > limit {
            return format!("{}\n[truncated]", &text[..index]);
        }
    }
    text
}

#[cfg(test)]
mod tests {
    use super::bounded;

    #[test]
    fn bounded_history_preserves_unicode_without_exceeding_legacy_utf16_bound() {
        assert_eq!(bounded("a😀b".into(), 3), "a😀\n[truncated]");
        assert_eq!(bounded("a😀b".into(), 2), "a\n[truncated]");
        assert_eq!(bounded("a😀b".into(), 4), "a😀b");
    }
}
