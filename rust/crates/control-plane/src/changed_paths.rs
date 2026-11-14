//! Overlap warnings: two running Attempts of one Objective change the same path of one Workspace.
//!
//! TypeScript parity: `packages/control-plane/src/overlap-warnings.ts` (`detectOverlapWarnings`)
//! and `apps/cli/src/worker-changed-paths.ts`. Worker Hosts report each running Attempt's changed
//! paths; the Objective's conversation is told once per Attempt pair and newly shared batch of
//! paths. Deliberate difference: a host reports through the Attempt's own execution authority on
//! a per-Attempt timer rather than on its host heartbeat, so a report from a stale or replaced
//! Attempt is refused.
use std::collections::BTreeSet;

use sha2::{Digest, Sha256};
use sqlx::Row;
use supertag_protocol::{
    MAX_MESSAGE_BYTES,
    changed_paths::{MAX_CHANGED_PATHS, reportable_path},
    v2::*,
};
use tonic::{Request, Response, Status};

use crate::{
    ControlPlane, HostAuthority, Store, StoreError,
    store::{Result, invalid, lease_is_live, owned, task_row},
};

/// The most shared paths one warning names.
const OVERLAP_PATHS_SHOWN: usize = 20;

impl Store {
    pub async fn report_changed_paths(
        &self,
        host: &HostAuthority,
        input: &ReportChangedPathsRequest,
    ) -> Result<ReportChangedPathsResponse> {
        let attempt = input
            .attempt
            .as_ref()
            .ok_or_else(|| invalid("Attempt identity is required"))?;
        if input.paths.len() > MAX_CHANGED_PATHS
            || !input.paths.iter().all(|path| reportable_path(path))
        {
            return Err(invalid(
                "changed paths must be at most 500 Workspace-relative paths",
            ));
        }
        let paths: BTreeSet<&str> = input.paths.iter().map(String::as_str).collect();
        let (mut tx, _) = self.write().await?;
        let now = self.execution_now_ms();
        let row = owned(
            &mut tx,
            host,
            &attempt.task_id,
            &attempt.attempt_id,
            &attempt.lease_token,
        )
        .await?;
        let task = task_row(&row)?;
        if task.state() != TaskState::Running || !lease_is_live(&row, now)? {
            return Err(StoreError::FailedPrecondition(
                "changed paths require a live running Attempt".into(),
            ));
        }
        let objective: Option<String> = sqlx::query_scalar(
            "SELECT objective_id FROM supertag_v2_objective_tasks WHERE task_id=$1",
        )
        .bind(&task.task_id)
        .fetch_optional(&mut *tx)
        .await?;
        let (Some(objective_id), Some(workspace)) = (objective, task.workspace.as_ref()) else {
            tx.commit().await?;
            return Ok(ReportChangedPathsResponse::default());
        };
        let workspace_id = &workspace.workspace_id;
        // Reports of Attempts that stopped running are never compared again.
        sqlx::query("DELETE FROM supertag_v2_attempt_changed_paths WHERE objective_id=$1 AND NOT EXISTS (SELECT 1 FROM supertag_v2_tasks t WHERE t.task_id=supertag_v2_attempt_changed_paths.task_id AND t.attempt_id=supertag_v2_attempt_changed_paths.attempt_id AND t.state=$2)")
            .bind(&objective_id).bind(TaskState::Running as i64).execute(&mut *tx).await?;
        sqlx::query("INSERT INTO supertag_v2_attempt_changed_paths (attempt_id,task_id,objective_id,workspace_id,paths,truncated,reported_at_ms) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(attempt_id) DO UPDATE SET paths=excluded.paths,truncated=excluded.truncated,reported_at_ms=excluded.reported_at_ms")
            .bind(&attempt.attempt_id).bind(&task.task_id).bind(&objective_id).bind(workspace_id)
            .bind(serde_json::to_string(&paths)?).bind(i64::from(input.truncated)).bind(now)
            .execute(&mut *tx).await?;
        let mut response = ReportChangedPathsResponse {
            compared: true,
            ..Default::default()
        };
        if input.truncated || paths.is_empty() {
            tx.commit().await?;
            return Ok(response);
        }
        // Every Attempt that still runs is compared, whether or not its lease renewal is late:
        // hosts do not resend an unchanged scan, so a skipped comparison would never recur.
        let others = sqlx::query("SELECT c.attempt_id,c.task_id,c.paths FROM supertag_v2_attempt_changed_paths c JOIN supertag_v2_tasks t ON t.task_id=c.task_id AND t.attempt_id=c.attempt_id WHERE c.objective_id=$1 AND c.workspace_id=$2 AND c.attempt_id<>$3 AND c.truncated=0 AND t.state=$4 ORDER BY c.attempt_id")
            .bind(&objective_id).bind(workspace_id).bind(&attempt.attempt_id)
            .bind(TaskState::Running as i64).fetch_all(&mut *tx).await?;
        for other in others {
            let other_attempt: String = other.try_get("attempt_id")?;
            let other_task: String = other.try_get("task_id")?;
            let other_paths: Vec<String> =
                serde_json::from_str(&other.try_get::<String, _>("paths")?)?;
            let shared: Vec<&str> = other_paths
                .iter()
                .map(String::as_str)
                .filter(|path| paths.contains(path))
                .collect();
            if shared.is_empty() {
                continue;
            }
            response.overlapping_attempt_ids.push(other_attempt.clone());
            let (lower, higher) = if attempt.attempt_id < other_attempt {
                (attempt.attempt_id.as_str(), other_attempt.as_str())
            } else {
                (other_attempt.as_str(), attempt.attempt_id.as_str())
            };
            let mut fresh = Vec::new();
            for path in shared {
                let inserted = sqlx::query("INSERT INTO supertag_v2_attempt_overlaps (objective_id,lower_attempt_id,higher_attempt_id,path,recorded_at_ms) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING")
                    .bind(&objective_id).bind(lower).bind(higher).bind(path).bind(now)
                    .execute(&mut *tx).await?;
                if inserted.rows_affected() == 1 {
                    fresh.push(path);
                }
            }
            if fresh.is_empty() {
                continue;
            }
            let digest = format!("{:x}", Sha256::digest(fresh.join("\n")));
            let shown = fresh[..fresh.len().min(OVERLAP_PATHS_SHOWN)].join(", ");
            let more = if fresh.len() > OVERLAP_PATHS_SHOWN {
                format!(" and {} more", fresh.len() - OVERLAP_PATHS_SHOWN)
            } else {
                String::new()
            };
            let text = format!(
                "Tasks {} and {other_task} of this Objective are both changing {shown}{more} in Workspace {workspace_id}. Coordinate them before their changes conflict: continue one work Session with what the other changes, or let one finish first.",
                task.task_id
            );
            crate::objectives::overlap_notice_in(
                &mut tx,
                &objective_id,
                &format!("overlap:{lower}:{higher}:{}", &digest[..16]),
                &text,
                now,
            )
            .await?;
        }
        tx.commit().await?;
        Ok(response)
    }
}

impl ControlPlane {
    pub fn attempt_changed_paths_service(
        &self,
    ) -> attempt_changed_paths_server::AttemptChangedPathsServer<Self> {
        attempt_changed_paths_server::AttemptChangedPathsServer::new(self.clone())
            .max_decoding_message_size(MAX_MESSAGE_BYTES)
            .max_encoding_message_size(MAX_MESSAGE_BYTES)
    }
}

#[tonic::async_trait]
impl attempt_changed_paths_server::AttemptChangedPaths for ControlPlane {
    async fn report(
        &self,
        request: Request<ReportChangedPathsRequest>,
    ) -> std::result::Result<Response<ReportChangedPathsResponse>, Status> {
        let host = self.host_authority(&request)?;
        Ok(Response::new(
            self.store
                .report_changed_paths(&host, request.get_ref())
                .await?,
        ))
    }
}
