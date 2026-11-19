use sqlx::Row;
use supertag_protocol::v2::{AttemptHistory, AttemptHistoryEntry, TaskEventKind, TaskState};

use crate::{
    Store, StoreError,
    store::{Result, lease_is_live, owned},
};

impl Store {
    /// The recap a turn starts from when it resumes no checkpoint: the Session's last finished
    /// turns with the messages the Tag wrote in each, bounded, scoped to the current execution's
    /// immutable audience.
    pub async fn get_attempt_history(
        &self,
        authority: &crate::AttemptAccess,
    ) -> Result<AttemptHistory> {
        let (host, attempt) = (authority.host(), authority.lease());
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
             ORDER BY prior.accepted_order DESC LIMIT $8",
        )
        .bind(&attempt.task_id)
        .bind(task.try_get::<String, _>("tag_id")?)
        .bind(task.try_get::<String, _>("session_id")?)
        .bind(task.try_get::<i64, _>("accepted_order")?)
        .bind(TaskState::Succeeded as i64)
        .bind(TaskState::Failed as i64)
        .bind(TaskState::Cancelled as i64)
        .bind(RECAP_TURNS)
        .fetch_all(&mut *tx)
        .await?;
        let mut entries = Vec::with_capacity(rows.len());
        for row in rows.iter().rev() {
            let task_id: String = row.try_get("task_id")?;
            let texts: Vec<String> = sqlx::query_scalar(
                "SELECT text FROM supertag_v2_task_events WHERE task_id=$1 AND kind=$2 ORDER BY sequence",
            )
            .bind(&task_id)
            .bind(TaskEventKind::Message as i64)
            .fetch_all(&mut *tx)
            .await?;
            // The Tag's last message is usually its result, which the entry already carries.
            let result: String = row.try_get("result")?;
            let texts = texts.into_iter().filter(|text| *text != result).collect();
            entries.push(AttemptHistoryEntry {
                task_id,
                prompt: bounded(row.try_get("prompt")?, 2_000),
                result: Some(bounded(result, 4_000)),
                messages: messages(texts, MESSAGE_UNITS),
            });
        }
        tx.commit().await?;
        Ok(AttemptHistory { entries })
    }
}

/// How many finished turns a recap carries, and how much of the messages the Tag wrote during
/// each, in UTF-16 units across them.
const RECAP_TURNS: i64 = 10;
const MESSAGE_UNITS: usize = 4_000;

/// The turn's messages, in order, until `limit` units are used; the one that crosses it is cut.
fn messages(texts: Vec<String>, limit: usize) -> Vec<String> {
    let mut left = limit;
    let mut kept = Vec::new();
    for text in texts {
        if left == 0 {
            break;
        }
        let units: usize = text.chars().map(char::len_utf16).sum();
        if units <= left {
            left -= units;
            kept.push(text);
        } else {
            kept.push(bounded(text, left));
            break;
        }
    }
    kept
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
    use super::{bounded, messages};

    #[test]
    fn bounded_history_preserves_unicode_without_exceeding_legacy_utf16_bound() {
        assert_eq!(bounded("a😀b".into(), 3), "a😀\n[truncated]");
        assert_eq!(bounded("a😀b".into(), 2), "a\n[truncated]");
        assert_eq!(bounded("a😀b".into(), 4), "a😀b");
    }

    #[test]
    fn recap_messages_share_one_bound_in_order() {
        assert_eq!(
            messages(vec!["abc".into(), "de".into(), "fgh".into()], 6),
            ["abc", "de", "f\n[truncated]"]
        );
        assert_eq!(messages(vec!["abc".into(), "d".into()], 3), ["abc"]);
        assert!(messages(vec![], 3).is_empty());
    }
}
