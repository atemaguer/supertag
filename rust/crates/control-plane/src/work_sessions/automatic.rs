//! An approval resumes the exact child under its original starter's pool.
use super::*;
use crate::store::{current_work_policy_in, next_order, task_in};

pub(crate) async fn continue_in(
    tx: &mut Transaction<'_, Any>,
    source: &Task,
    prompt: &str,
    now: i64,
) -> Result<()> {
    let Some(row)=sqlx::query("SELECT w.*,k.starter_task_id AS source_starter FROM supertag_v2_work_sessions w JOIN supertag_v2_work_session_tasks k ON k.task_id=w.latest_task_id AND k.kind=1 JOIN supertag_v2_tasks t ON t.task_id=k.task_id WHERE k.task_id=$1 AND t.state=3 AND t.cleanup_pending=0 AND EXISTS (SELECT 1 FROM supertag_v2_work_session_reports r WHERE r.child_task_id=k.task_id)")
  .bind(&source.task_id).fetch_optional(&mut **tx).await? else {return Ok(())};
    let session: String = row.try_get("work_session_id")?;
    let objective: Option<String> = row.try_get("objective_id")?;
    let starter = task_in(tx, &row.try_get::<String, _>("source_starter")?).await?;
    if let Some(id) = &objective {
        let state=sqlx::query("SELECT status,paused_at_ms,deadline_ms FROM supertag_v2_objectives WHERE objective_id=$1").bind(id).fetch_one(&mut **tx).await?;
        if matches!(state.try_get::<i64, _>("status")?, 5 | 6)
            || state.try_get::<Option<i64>, _>("paused_at_ms")?.is_some()
            || state
                .try_get::<Option<i64>, _>("deadline_ms")?
                .is_some_and(|deadline| deadline <= now)
        {
            return Ok(());
        }
    }
    let open:i64=sqlx::query_scalar("SELECT COUNT(*) FROM supertag_v2_work_sessions w JOIN supertag_v2_tasks t ON t.task_id=w.latest_task_id WHERE w.parent_tag_id=$1 AND w.parent_session_id=$2 AND (t.state IN (1,2,6,7) OR t.cleanup_pending=1)")
  .bind(&starter.tag_id).bind(&starter.session_id).fetch_one(&mut **tx).await?;
    if open >= MAX_OPEN {
        return Ok(());
    }
    let current = Box::pin(current_work_policy_in(
        tx,
        source,
        &starter,
        objective.as_deref(),
    ))
    .await;
    match current {
        Ok(current)
            if continuation::require_unchanged_authority(
                source,
                &current,
                source.tag_id != starter.tag_id,
            )
            .is_ok() => {}
        Ok(_)
        | Err(
            StoreError::PermissionDenied
            | StoreError::NotFound(_)
            | StoreError::FailedPrecondition(_)
            | StoreError::InvalidArgument(_),
        ) => {
            return stop_in(
                tx,
                source,
                &starter,
                &session,
                objective.as_deref(),
                "permissions",
            )
            .await;
        }
        Err(error) => return Err(error),
    }
    let limits = match crate::budget_pool::child_in(
        tx,
        &starter,
        objective.as_deref(),
        source.execution_limits.as_ref(),
    )
    .await
    {
        Ok(value) => value,
        Err(StoreError::FailedPrecondition(_)) => {
            return stop_in(
                tx,
                source,
                &starter,
                &session,
                objective.as_deref(),
                "budget",
            )
            .await;
        }
        Err(error) => return Err(error),
    };
    let order = next_order(tx).await?;
    let mut next = insert_task_from_snapshot(tx, order, source, &session, prompt).await?;
    crate::budget_pool::set_in(tx, &mut next, limits).await?;
    sqlx::query("INSERT INTO supertag_v2_work_session_tasks (task_id,work_session_id,kind,starter_task_id) VALUES ($1,$2,1,$3)").bind(&next.task_id).bind(&session).bind(&starter.task_id).execute(&mut **tx).await?;
    if let Some(id) = objective {
        sqlx::query("INSERT INTO supertag_v2_objective_tasks (task_id,objective_id,kind) VALUES ($1,$2,'work')").bind(&next.task_id).bind(id).execute(&mut **tx).await?;
    }
    sqlx::query("UPDATE supertag_v2_work_sessions SET latest_task_id=$1 WHERE work_session_id=$2")
        .bind(&next.task_id)
        .bind(&session)
        .execute(&mut **tx)
        .await?;
    sqlx::query("UPDATE supertag_v2_approval_waits SET continuation_task_id=$1 WHERE task_id=$2 AND continuation_task_id IS NULL").bind(&next.task_id).bind(&source.task_id).execute(&mut **tx).await?;
    Ok(())
}

async fn stop_in(
    tx: &mut Transaction<'_, Any>,
    source: &Task,
    starter: &Task,
    session: &str,
    objective: Option<&str>,
    reason: &str,
) -> Result<()> {
    let order = next_order(tx).await?;
    let prompt = format!(
        "The Work Session ({session}) was not continued after the operator's approval decision because its {reason} changed or no longer permits new work. Report this to the person directing the parent Session. Do not retry the approved action from this notice."
    );
    let mut notice =
        insert_task_from_snapshot(tx, order, starter, &starter.session_id, &prompt).await?;
    let limits =
        crate::budget_pool::owed_in(tx, starter, objective, starter.execution_limits.as_ref())
            .await?;
    crate::budget_pool::set_in(tx, &mut notice, limits).await?;
    sqlx::query("UPDATE supertag_v2_tasks SET allowed_actions='[]' WHERE task_id=$1")
        .bind(&notice.task_id)
        .execute(&mut **tx)
        .await?;
    if let Some(id) = objective {
        sqlx::query("INSERT INTO supertag_v2_objective_tasks (task_id,objective_id,kind) VALUES ($1,$2,'notice')").bind(&notice.task_id).bind(id).execute(&mut **tx).await?;
    }
    sqlx::query("INSERT INTO supertag_v2_work_session_tasks (task_id,work_session_id,kind) VALUES ($1,$2,2)").bind(&notice.task_id).bind(session).execute(&mut **tx).await?;
    let event = format!("work-session-approval-stop:{}", source.task_id);
    let digest = format!("{:x}", Sha256::digest(event.as_bytes()));
    sqlx::query("INSERT INTO supertag_v2_inbound_events (account_id,event_id,request_digest,task_id,conversation_id,thread_id) SELECT account_id,$1,$2,$3,conversation_id,thread_id FROM supertag_v2_inbound_events WHERE task_id=$4").bind(event).bind(digest).bind(&notice.task_id).bind(&starter.task_id).execute(&mut **tx).await?;
    sqlx::query("INSERT INTO supertag_v2_approval_continuation_stops (task_id,reason,notice_task_id) VALUES ($1,$2,$3)").bind(&source.task_id).bind(reason).bind(&notice.task_id).execute(&mut **tx).await?;
    Ok(())
}

#[cfg(test)]
mod tests;
