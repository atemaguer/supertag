use crate::{
    Store, StoreError,
    store::{HostAuthority, Result, invalid, lease_is_live, owned},
};
use sqlx::{Any, Row, Transaction, any::AnyRow};
use supertag_protocol::{
    MAX_RESUMED_CHECKPOINT_BYTES, v2::*, valid_sha256, validate_checkpoint_reference,
};

impl Store {
    /// The Session's checkpoint for this Attempt to resume, and the Worker Host holding its bytes,
    /// unless it is dropped: too big or older than [`IDLE_MS`]. A dropped checkpoint loses its
    /// rows here, and the turn starts fresh with a recap of the Session. A Session keeps one
    /// harness, so its checkpoint is its harness's. Only the holder can resume it; another host
    /// starts fresh the same way.
    pub async fn get_checkpoint(
        &self,
        host: &HostAuthority,
        attempt: &InspectAttemptRequest,
    ) -> Result<GetCheckpointResponse> {
        let now = self.execution_now_ms();
        let mut tx = self.pool.begin().await?;
        let task = require_running(&mut tx, host, attempt, now).await?;
        let row = current_in(&mut tx, &task).await?;
        tx.commit().await?;
        let Some(row) = row else {
            return Ok(GetCheckpointResponse::default());
        };
        let reference = reference_row(&row)?;
        let completed: Option<i64> = row.try_get("checkpoint_completed_at_ms")?;
        let dropped = reference.byte_length > MAX_RESUMED_CHECKPOINT_BYTES as u64
            || completed.is_none_or(|completed| completed < now - IDLE_MS);
        if !dropped {
            return Ok(GetCheckpointResponse {
                reference: Some(reference),
                holder_host_id: row
                    .try_get::<Option<String>, _>("holder_host_id")?
                    .unwrap_or_default(),
            });
        }
        let (mut tx, _) = self.write().await?;
        let task = require_running(&mut tx, host, attempt, now).await?;
        let tag: String = task.try_get("tag_id")?;
        let session: String = task.try_get("session_id")?;
        sqlx::query(
            "DELETE FROM supertag_v2_session_checkpoints WHERE tag_id=$1 AND session_id=$2 AND attempt_id=$3",
        )
        .bind(&tag)
        .bind(&session)
        .bind(row.try_get::<String, _>("attempt_id")?)
        .execute(&mut *tx)
        .await?;
        prune_session_in(&mut tx, &tag, &session, None).await?;
        tx.commit().await?;
        Ok(GetCheckpointResponse::default())
    }

    /// Drops the checkpoints nothing will resume: those of Sessions idle for [`IDLE_MS`] or of
    /// Objectives ended for [`ENDED_OBJECTIVE_MS`], and rows no Session points at. Their holders
    /// delete the files once [`Store::list_held_checkpoints`] no longer names them.
    pub async fn sweep_checkpoints(&self) -> Result<()> {
        let now = self.execution_now_ms();
        // Most passes find nothing: take the write lock only when there is work.
        let mut tx = self.pool.begin().await?;
        let work =
            !expired_in(&mut tx, now).await?.is_empty() || !orphans_in(&mut tx).await?.is_empty();
        tx.commit().await?;
        if !work {
            return Ok(());
        }
        let (mut tx, _) = self.write().await?;
        for row in expired_in(&mut tx, now).await? {
            let tag: String = row.try_get("tag_id")?;
            let session: String = row.try_get("session_id")?;
            sqlx::query(
                "DELETE FROM supertag_v2_session_checkpoints WHERE tag_id=$1 AND session_id=$2",
            )
            .bind(&tag)
            .bind(&session)
            .execute(&mut *tx)
            .await?;
            prune_session_in(&mut tx, &tag, &session, None).await?;
        }
        let orphans = orphans_in(&mut tx).await?;
        discard_in(&mut tx, &orphans).await?;
        tx.commit().await?;
        Ok(())
    }

    /// The digests of the checkpoints `host` holds that a Session still points at, or a running
    /// Attempt of `host` reserved, in digest order after `after`. The host deletes every other
    /// checkpoint file it holds.
    pub async fn list_held_checkpoints(
        &self,
        host: &HostAuthority,
        input: &ListHeldCheckpointsRequest,
    ) -> Result<ListHeldCheckpointsResponse> {
        let limit = match input.limit {
            0 => HELD_PAGE,
            1..=HELD_PAGE => input.limit,
            _ => return Err(invalid("limit must be between 1 and 1000")),
        };
        if !input.after_sha256.is_empty() && !valid_sha256(&input.after_sha256) {
            return Err(invalid("after_sha256 must be a checkpoint digest"));
        }
        let mut tx = self.pool.begin().await?;
        let digests: Vec<String> = sqlx::query_scalar(&format!(
            "SELECT DISTINCT c.sha256 FROM supertag_v2_checkpoints c
             JOIN supertag_v2_tasks t ON t.task_id=c.task_id
             WHERE c.holder_host_id=$2 AND c.sha256>$3
               AND (EXISTS (SELECT 1 FROM supertag_v2_session_checkpoints s WHERE s.attempt_id=c.attempt_id)
                    OR NOT {NOT_RUNNING})
             ORDER BY c.sha256 LIMIT $4"
        ))
        .bind(TaskState::Running as i64)
        .bind(host.id())
        .bind(&input.after_sha256)
        .bind(i64::from(limit) + 1)
        .fetch_all(&mut *tx)
        .await?;
        tx.commit().await?;
        let more = digests.len() > limit as usize;
        let sha256: Vec<String> = digests.into_iter().take(limit as usize).collect();
        Ok(ListHeldCheckpointsResponse {
            next_after_sha256: more.then(|| sha256.last().cloned()).flatten(),
            sha256,
        })
    }

    pub async fn reserve_checkpoint(
        &self,
        host: &HostAuthority,
        input: &CommitCheckpointRequest,
    ) -> Result<CheckpointReference> {
        let (attempt, reference) = checkpoint_input(input)?;
        let (mut tx, _) = self.write().await?;
        require_running(&mut tx, host, attempt, self.execution_now_ms()).await?;
        if let Some(prior) = reservation_in(&mut tx, attempt).await? {
            check_reference(&prior, reference)?;
        } else {
            // The caller holds the bytes: only it can resume them.
            sqlx::query("INSERT INTO supertag_v2_checkpoints (attempt_id,task_id,harness,format,byte_length,sha256,holder_host_id) VALUES ($1,$2,$3,$4,$5,$6,$7)")
                .bind(&attempt.attempt_id)
                .bind(&attempt.task_id)
                .bind(&reference.harness)
                .bind(&reference.format)
                .bind(reference.byte_length as i64)
                .bind(&reference.sha256)
                .bind(host.id())
                .execute(&mut *tx).await?;
        }
        tx.commit().await?;
        Ok(reference.clone())
    }

    pub async fn commit_checkpoint(
        &self,
        host: &HostAuthority,
        input: &CommitCheckpointRequest,
    ) -> Result<CheckpointReference> {
        let (attempt, reference) = checkpoint_input(input)?;
        let (mut tx, _) = self.write().await?;
        let task = owned(
            &mut tx,
            host,
            &attempt.task_id,
            &attempt.attempt_id,
            &attempt.lease_token,
        )
        .await?;
        let reservation = reservation_in(&mut tx, attempt).await?.ok_or_else(|| {
            StoreError::FailedPrecondition("checkpoint reservation is missing".into())
        })?;
        check_reference(&reservation, reference)?;
        if reservation.try_get::<i64, _>("committed")? == 0 {
            require_running_row(&task, self.execution_now_ms())?;
            sqlx::query(
                "UPDATE supertag_v2_checkpoints SET committed=1 WHERE attempt_id=$1 AND task_id=$2",
            )
            .bind(&attempt.attempt_id)
            .bind(&attempt.task_id)
            .execute(&mut *tx)
            .await?;
        }
        tx.commit().await?;
        Ok(reference.clone())
    }
}

/// How long another Worker Host leaves a queued Task to the host holding its Session's
/// checkpoint, from when the Task could first run. After that, another host starts it fresh.
pub const HOLDER_WAIT_MS: i64 = 10 * 60 * 1000;

/// The Worker Host a queued Task waits for, and until when: the host holding its Session's
/// checkpoint, while that host is ready (connected, not draining), bound to the Tag, and runs
/// the Task's harness, for up to [`HOLDER_WAIT_MS`]. `None` when `claimer` is the holder, the
/// checkpoint would be dropped anyway, or no wait applies, so any eligible host may take it.
pub(crate) async fn holder_wait_in(
    tx: &mut Transaction<'_, Any>,
    task: &Task,
    claimer: Option<&str>,
    now: i64,
) -> Result<Option<(String, i64)>> {
    let Some(row) = sqlx::query(
        "SELECT c.holder_host_id,c.byte_length,t.completed_at_ms,(SELECT accepted_at_ms FROM supertag_v2_tasks q WHERE q.task_id=$3) AS accepted_at_ms
         FROM supertag_v2_session_checkpoints s
         JOIN supertag_v2_checkpoints c ON c.attempt_id=s.attempt_id
         JOIN supertag_v2_tasks t ON t.task_id=c.task_id
         WHERE s.tag_id=$1 AND s.session_id=$2 AND c.committed=1",
    )
    .bind(&task.tag_id)
    .bind(&task.session_id)
    .bind(&task.task_id)
    .fetch_optional(&mut **tx)
    .await?
    else {
        return Ok(None);
    };
    let Some(holder) = row.try_get::<Option<String>, _>("holder_host_id")? else {
        return Ok(None);
    };
    let completed: Option<i64> = row.try_get("completed_at_ms")?;
    if claimer == Some(holder.as_str())
        || row.try_get::<i64, _>("byte_length")? > MAX_RESUMED_CHECKPOINT_BYTES as i64
        || completed.is_none_or(|completed| completed < now - IDLE_MS)
    {
        return Ok(None);
    }
    let accepted: Option<i64> = row.try_get("accepted_at_ms")?;
    let until = accepted.unwrap_or(now).max(completed.unwrap_or(now)) + HOLDER_WAIT_MS;
    if now >= until {
        return Ok(None);
    }
    let bound: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM supertag_v2_hosts h WHERE h.host_id=$1 AND h.revoked_at_ms IS NULL AND (h.all_tags=1 OR EXISTS (SELECT 1 FROM supertag_v2_host_tags scope WHERE scope.host_id=h.host_id AND scope.tag_id=$2))",
    )
    .bind(&holder)
    .bind(&task.tag_id)
    .fetch_one(&mut **tx)
    .await?;
    if bound == 0 {
        return Ok(None);
    }
    let status = crate::store::host_status_in(tx, &holder, now).await?;
    let harness = task.harness_kind();
    let serves = status
        .harnesses
        .iter()
        .any(|lane| harness == HarnessKind::Unspecified || lane.harness_kind() == harness)
        || (status.harnesses.is_empty()
            && (harness == HarnessKind::Unspecified || status.harness_kind() == harness));
    Ok((status.phase() == HostPhase::Ready && serves).then_some((holder, until)))
}

pub(crate) async fn finish_in(
    tx: &mut Transaction<'_, Any>,
    task: &Task,
    input: &FinishTaskRequest,
) -> Result<()> {
    if let Some(digest) = &input.checkpoint_sha256 {
        if !valid_sha256(digest) {
            return Err(invalid("invalid checkpoint digest"));
        }
        let committed: Option<String> = sqlx::query_scalar(
            "SELECT sha256 FROM supertag_v2_checkpoints WHERE attempt_id=$1 AND task_id=$2 AND committed=1",
        )
        .bind(&input.attempt_id)
        .bind(&input.task_id)
        .fetch_optional(&mut **tx)
        .await?;
        if committed.as_ref() != Some(digest) {
            return Err(StoreError::FailedPrecondition(
                "checkpoint commit is missing or mismatched".into(),
            ));
        }
        sqlx::query("INSERT INTO supertag_v2_session_checkpoints (tag_id,session_id,attempt_id) VALUES ($1,$2,$3) ON CONFLICT(tag_id,session_id) DO UPDATE SET attempt_id=excluded.attempt_id")
            .bind(&task.tag_id)
            .bind(&task.session_id)
            .bind(&input.attempt_id)
            .execute(&mut **tx).await?;
    } else {
        sqlx::query(
            "DELETE FROM supertag_v2_session_checkpoints WHERE tag_id=$1 AND session_id=$2",
        )
        .bind(&task.tag_id)
        .bind(&task.session_id)
        .execute(&mut **tx)
        .await?;
    }
    let keep = input
        .checkpoint_sha256
        .as_ref()
        .map(|_| input.attempt_id.as_str());
    prune_session_in(tx, &task.tag_id, &task.session_id, keep).await
}

/// A Session resumes a checkpoint for at most this long after its last finished turn.
pub const IDLE_MS: i64 = 14 * 24 * 60 * 60 * 1000;
/// An ended Objective's Sessions keep their checkpoints this long: work that likely never
/// resumes goes well before the idle limit.
pub const ENDED_OBJECTIVE_MS: i64 = 3 * 24 * 60 * 60 * 1000;
const SWEEP_BATCH: i64 = 200;
/// The most digests one `ListHeldCheckpoints` page returns.
const HELD_PAGE: u32 = 1000;
/// A checkpoint row still in use: the reservation or commit of its Task's running Attempt.
/// A Session no Attempt is about to resume or running in now.
const IDLE_SESSION: &str = "NOT EXISTS (SELECT 1 FROM supertag_v2_tasks r WHERE r.tag_id=s.tag_id AND r.session_id=s.session_id AND r.state IN ($5,$6))";
const NOT_RUNNING: &str = "NOT (t.state=$1 AND t.attempt_id=c.attempt_id)";

/// The checkpoint a Session points at, with when its turn finished.
pub(crate) async fn current_in(
    tx: &mut Transaction<'_, Any>,
    task: &AnyRow,
) -> Result<Option<AnyRow>> {
    Ok(sqlx::query("SELECT c.*,t.completed_at_ms AS checkpoint_completed_at_ms FROM supertag_v2_session_checkpoints s JOIN supertag_v2_checkpoints c ON s.attempt_id=c.attempt_id JOIN supertag_v2_tasks t ON t.task_id=c.task_id WHERE s.tag_id=$1 AND s.session_id=$2 AND c.committed=1")
        .bind(task.try_get::<String, _>("tag_id")?)
        .bind(task.try_get::<String, _>("session_id")?)
        .fetch_optional(&mut **tx).await?)
}

/// Sessions whose checkpoint is due to go: idle for [`IDLE_MS`], or of an Objective ended for
/// [`ENDED_OBJECTIVE_MS`], with no turn about to resume it.
async fn expired_in(tx: &mut Transaction<'_, Any>, now: i64) -> Result<Vec<AnyRow>> {
    Ok(sqlx::query(&format!(
        "SELECT s.tag_id,s.session_id FROM supertag_v2_session_checkpoints s
         JOIN supertag_v2_checkpoints c ON c.attempt_id=s.attempt_id
         JOIN supertag_v2_tasks t ON t.task_id=c.task_id
         WHERE (t.completed_at_ms IS NULL OR t.completed_at_ms<$1) AND {IDLE_SESSION}
         UNION
         SELECT s.tag_id,s.session_id FROM supertag_v2_session_checkpoints s
         JOIN supertag_v2_objectives o ON (o.owner_tag_id=s.tag_id AND o.session_id=s.session_id)
            OR EXISTS (SELECT 1 FROM supertag_v2_objective_sessions os
                       WHERE os.objective_id=o.objective_id AND os.tag_id=s.tag_id AND os.session_id=s.session_id)
         WHERE o.status IN ($2,$3) AND o.updated_at_ms<$7 AND {IDLE_SESSION}
         LIMIT $4"
    ))
    .bind(now - IDLE_MS)
    .bind(ObjectiveStatus::Completed as i64)
    .bind(ObjectiveStatus::Cancelled as i64)
    .bind(SWEEP_BATCH)
    .bind(TaskState::Claimed as i64)
    .bind(TaskState::Running as i64)
    .bind(now - ENDED_OBJECTIVE_MS)
    .fetch_all(&mut **tx)
    .await?)
}

/// Checkpoint rows no Session points at, other than a running Attempt's.
async fn orphans_in(tx: &mut Transaction<'_, Any>) -> Result<Vec<AnyRow>> {
    Ok(sqlx::query(&format!(
        "SELECT c.attempt_id,c.sha256 FROM supertag_v2_checkpoints c
         JOIN supertag_v2_tasks t ON t.task_id=c.task_id
         WHERE NOT EXISTS (SELECT 1 FROM supertag_v2_session_checkpoints s WHERE s.attempt_id=c.attempt_id)
           AND {NOT_RUNNING} LIMIT $2"
    ))
    .bind(TaskState::Running as i64)
    .bind(SWEEP_BATCH)
    .fetch_all(&mut **tx)
    .await?)
}

/// Deletes the Session's checkpoint rows other than `keep` and a running Attempt's. Their holders
/// delete the files.
async fn prune_session_in(
    tx: &mut Transaction<'_, Any>,
    tag: &str,
    session: &str,
    keep: Option<&str>,
) -> Result<()> {
    let rows = sqlx::query(&format!(
        "SELECT c.attempt_id,c.sha256 FROM supertag_v2_checkpoints c
         JOIN supertag_v2_tasks t ON t.task_id=c.task_id
         WHERE t.tag_id=$2 AND t.session_id=$3 AND c.attempt_id<>$4 AND {NOT_RUNNING}
           AND NOT EXISTS (SELECT 1 FROM supertag_v2_session_checkpoints s WHERE s.attempt_id=c.attempt_id)"
    ))
    .bind(TaskState::Running as i64)
    .bind(tag)
    .bind(session)
    .bind(keep.unwrap_or_default())
    .fetch_all(&mut **tx)
    .await?;
    discard_in(tx, &rows).await
}

async fn discard_in(tx: &mut Transaction<'_, Any>, rows: &[AnyRow]) -> Result<()> {
    for row in rows {
        sqlx::query("DELETE FROM supertag_v2_checkpoints WHERE attempt_id=$1")
            .bind(row.try_get::<String, _>("attempt_id")?)
            .execute(&mut **tx)
            .await?;
    }
    Ok(())
}

fn checkpoint_input(
    input: &CommitCheckpointRequest,
) -> Result<(&InspectAttemptRequest, &CheckpointReference)> {
    let attempt = input
        .attempt
        .as_ref()
        .ok_or_else(|| invalid("Attempt identity required"))?;
    let reference = input
        .reference
        .as_ref()
        .ok_or_else(|| invalid("checkpoint reference required"))?;
    validate_checkpoint_reference(reference).map_err(|status| invalid(status.message()))?;
    Ok((attempt, reference))
}

pub(crate) async fn reservation_in(
    tx: &mut Transaction<'_, Any>,
    attempt: &InspectAttemptRequest,
) -> Result<Option<AnyRow>> {
    Ok(
        sqlx::query("SELECT * FROM supertag_v2_checkpoints WHERE attempt_id=$1 AND task_id=$2")
            .bind(&attempt.attempt_id)
            .bind(&attempt.task_id)
            .fetch_optional(&mut **tx)
            .await?,
    )
}

fn check_reference(row: &AnyRow, reference: &CheckpointReference) -> Result<()> {
    if &reference_row(row)? != reference {
        return Err(StoreError::Conflict(
            "Attempt already reserved a different checkpoint".into(),
        ));
    }
    Ok(())
}

async fn require_running(
    tx: &mut Transaction<'_, Any>,
    host: &HostAuthority,
    attempt: &InspectAttemptRequest,
    now: i64,
) -> Result<AnyRow> {
    let row = owned(
        tx,
        host,
        &attempt.task_id,
        &attempt.attempt_id,
        &attempt.lease_token,
    )
    .await?;
    require_running_row(&row, now)?;
    Ok(row)
}

fn require_running_row(row: &AnyRow, now: i64) -> Result<()> {
    if row.try_get::<i64, _>("state")? != TaskState::Running as i64 || !lease_is_live(row, now)? {
        return Err(StoreError::FailedPrecondition(
            "Attempt is not running with current authority".into(),
        ));
    }
    Ok(())
}

pub(crate) fn reference_row(row: &AnyRow) -> Result<CheckpointReference> {
    Ok(CheckpointReference {
        harness: row.try_get("harness")?,
        format: row.try_get("format")?,
        byte_length: row.try_get::<i64, _>("byte_length")? as u64,
        sha256: row.try_get("sha256")?,
    })
}
