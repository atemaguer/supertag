//! Operator metrics snapshot (`OrganizationService.GetMetrics` in
//! packages/store/src/coordination-metrics-store.ts). Every figure is a database aggregate, so the
//! snapshot stays complete as tables grow and never inherits a list API's page limit.
use std::collections::BTreeMap;

use sqlx::Row;
use supertag_protocol::v2::*;
use tonic::{Request, Response, Status};

use crate::{ControlPlane, Store, store::Result};

impl Store {
    pub async fn metrics(&self) -> Result<MetricSnapshot> {
        let captured_at_ms = self.execution_now_ms();
        let row = sqlx::query(
            "SELECT \
             (SELECT COUNT(*) FROM supertag_v2_tags WHERE retired_at_ms IS NULL) AS tags, \
             (SELECT COUNT(*) FROM supertag_v2_roles) AS roles, \
             (SELECT COUNT(*) FROM supertag_v2_role_assignments) AS role_assignments, \
             (SELECT COUNT(*) FROM supertag_v2_surface_accounts) AS surface_accounts, \
             (SELECT COUNT(*) FROM supertag_v2_permission_sets) AS permission_sets, \
             (SELECT COUNT(*) FROM supertag_v2_context_sets) AS context_sets, \
             (SELECT COUNT(*) FROM (SELECT DISTINCT tag_id, session_id FROM supertag_v2_tasks) sessions) AS sessions, \
             (SELECT COUNT(*) FROM supertag_v2_mailbox_messages WHERE task_id IS NULL) AS mailbox_pending, \
             (SELECT MIN(created_at_ms) FROM supertag_v2_mailbox_messages WHERE task_id IS NULL) AS mailbox_oldest, \
             (SELECT COUNT(*) FROM supertag_v2_replies WHERE state IN ($1,$2,$3)) AS reply_backlog, \
             (SELECT COUNT(*) FROM supertag_v2_replies WHERE state=$4) AS reply_failed",
        )
        .bind(ReplyState::Pending as i64)
        .bind(ReplyState::Claimed as i64)
        .bind(ReplyState::Uncertain as i64)
        .bind(ReplyState::Failed as i64)
        .fetch_one(&self.pool)
        .await?;
        let count = |name: &str| row.try_get::<i64, _>(name);
        let resources = MetricResources {
            tags: count("tags")?,
            roles: count("roles")?,
            role_assignments: count("role_assignments")?,
            surface_accounts: count("surface_accounts")?,
            permission_sets: count("permission_sets")?,
            context_sets: count("context_sets")?,
            sessions: count("sessions")?,
        };
        let mailbox = MetricBacklog {
            pending: count("mailbox_pending")?,
            oldest_pending_at_ms: row.try_get("mailbox_oldest")?,
        };
        let reply_delivery = MetricReplyDelivery {
            backlog: count("reply_backlog")?,
            failed: count("reply_failed")?,
        };

        let mut tasks = MetricTaskCounts::default();
        for row in
            sqlx::query("SELECT state, COUNT(*) AS count FROM supertag_v2_tasks GROUP BY state")
                .fetch_all(&self.pool)
                .await?
        {
            let count: i64 = row.try_get("count")?;
            tasks.total += count;
            match TaskState::try_from(i32::try_from(row.try_get::<i64, _>("state")?).unwrap_or(-1))
            {
                Ok(TaskState::Queued) => tasks.queued += count,
                Ok(TaskState::Claimed) => tasks.claimed += count,
                Ok(TaskState::Running) => tasks.running += count,
                Ok(TaskState::Uncertain) => tasks.uncertain += count,
                Ok(TaskState::Succeeded) => tasks.succeeded += count,
                Ok(TaskState::Failed) => tasks.failed += count,
                Ok(TaskState::Cancelled) => tasks.cancelled += count,
                _ => {}
            }
        }

        // The spend report already counts each claimed Attempt once; its groups partition them.
        let spend = self
            .spend_report(&GetSpendRequest {
                by: SpendGrouping::Objective as i32,
                since_ms: None,
            })
            .await?;
        let mut usage = MetricUsage::default();
        let mut cost = BTreeMap::<String, u64>::new();
        for group in spend.groups {
            usage.attempts += group.attempts as i64;
            usage.unknown_token_attempts += group.unknown_token_attempts as i64;
            usage.unknown_cost_attempts += group.unknown_cost_attempts as i64;
            usage.estimated_cost_attempts += group.estimated_cost_attempts as i64;
            if let Some(tokens) = group.reported_tokens {
                usage.reported_tokens = Some(usage.reported_tokens.unwrap_or(0) + tokens);
            }
            for amount in group.reported_cost {
                *cost.entry(amount.currency).or_default() += amount.amount_minor;
            }
        }
        usage.reported_cost = cost
            .into_iter()
            .map(|(currency, amount_minor)| SpendAmount {
                currency,
                amount_minor,
            })
            .collect();

        let mut worker_hosts = vec![];
        let mut cursor = String::new();
        loop {
            let page = self
                .list_hosts(&ListHostsRequest { limit: 500, cursor })
                .await?;
            worker_hosts.extend(page.hosts.into_iter().map(|host| MetricWorkerHost {
                phase: host.phase,
                draining: host.draining,
                capacity: host.capacity,
                available_slots: host.available_slots,
                active_attempts: host.active_attempts,
                host_id: host.host_id,
            }));
            if page.next_cursor.is_empty() {
                break;
            }
            cursor = page.next_cursor;
        }

        let recovery = self.recovery_metrics(captured_at_ms).await?;
        let mut scheduling = self.latency_metrics().await?;
        scheduling.queued = tasks.queued;
        scheduling.worker_hosts = worker_hosts;

        Ok(MetricSnapshot {
            captured_at_ms,
            resources: Some(resources),
            scheduling: Some(scheduling),
            recovery: Some(recovery),
            tasks: Some(tasks),
            usage: Some(usage),
            mailbox: Some(mailbox),
            reply_delivery: Some(reply_delivery),
        })
    }
}

impl Store {
    /// Attempts that may have executed: those `ResolveAttempt` accepts, cancelled Attempts whose
    /// cleanup is unconfirmed, and the decisions operators recorded; Sessions whose next Task
    /// waits behind an unfinished one, as the claim query skips them; and live inputs whose
    /// delivery is unknown.
    async fn recovery_metrics(&self, now: i64) -> Result<MetricRecovery> {
        let row = sqlx::query(
            "SELECT \
             (SELECT COUNT(*) FROM supertag_v2_tasks WHERE attempt_id IS NOT NULL AND (state=$1 \
               OR (state IN ($2,$3) AND cleanup_pending=1 \
                 AND (lease_expires_at_ms IS NULL OR lease_expires_at_ms<=$4)))) AS awaiting, \
             (SELECT COUNT(*) FROM supertag_v2_tasks WHERE state=$3 AND cleanup_pending=1 AND cleanup_observed=0) AS unconfirmed, \
             (SELECT COUNT(*) FROM supertag_v2_attempt_resolutions WHERE decision=$5) AS failed, \
             (SELECT COUNT(*) FROM supertag_v2_attempt_resolutions WHERE decision=$6) AS retried, \
             (SELECT COUNT(*) FROM (SELECT DISTINCT pending.tag_id, pending.session_id \
               FROM supertag_v2_tasks pending WHERE pending.state=$7 AND EXISTS ( \
                 SELECT 1 FROM supertag_v2_tasks active WHERE active.tag_id=pending.tag_id \
                   AND active.session_id=pending.session_id \
                   AND (active.state IN ($8,$2,$1) OR active.cleanup_pending=1))) blocked) AS blocked, \
             (SELECT COUNT(*) FROM supertag_v2_live_inputs WHERE state=$9) AS unknown_inputs",
        )
        .bind(TaskState::Uncertain as i64)
        .bind(TaskState::Running as i64)
        .bind(TaskState::Cancelled as i64)
        .bind(now)
        .bind(AttemptDecision::Failed as i64)
        .bind(AttemptDecision::Retry as i64)
        .bind(TaskState::Queued as i64)
        .bind(TaskState::Claimed as i64)
        .bind(LiveInputState::Unknown as i64)
        .fetch_one(&self.pool)
        .await?;
        Ok(MetricRecovery {
            awaiting_decision: row.try_get("awaiting")?,
            cleanup_unconfirmed: row.try_get("unconfirmed")?,
            resolved_failed: row.try_get("failed")?,
            resolved_retried: row.try_get("retried")?,
            blocked_sessions: row.try_get("blocked")?,
            unknown_live_inputs: row.try_get("unknown_inputs")?,
        })
    }

    /// The oldest queued Task, time from acceptance to a Task's first claim, and time from
    /// claim to start. Records from before these times were kept are left out.
    async fn latency_metrics(&self) -> Result<MetricScheduling> {
        let oldest_queued_at_ms: Option<i64> =
            sqlx::query_scalar("SELECT MIN(accepted_at_ms) FROM supertag_v2_tasks WHERE state=$1")
                .bind(TaskState::Queued as i64)
                .fetch_one(&self.pool)
                .await?;
        // Sums are cast so PostgreSQL returns BIGINT rather than NUMERIC.
        let queue = sqlx::query(
            "SELECT COUNT(*) AS n, CAST(COALESCE(SUM(wait),0) AS BIGINT) AS total, \
             CAST(COALESCE(MAX(wait),0) AS BIGINT) AS longest FROM ( \
               SELECT CASE WHEN MIN(c.claimed_at_ms) < t.accepted_at_ms THEN 0 \
                 ELSE MIN(c.claimed_at_ms) - t.accepted_at_ms END AS wait \
               FROM supertag_v2_claims c JOIN supertag_v2_tasks t ON t.task_id=c.task_id \
               WHERE c.attempt_id IS NOT NULL AND c.claimed_at_ms IS NOT NULL AND t.accepted_at_ms IS NOT NULL \
               GROUP BY t.task_id, t.accepted_at_ms) waits",
        )
        .fetch_one(&self.pool)
        .await?;
        let start = sqlx::query(
            "SELECT COUNT(*) AS n, CAST(COALESCE(SUM(wait),0) AS BIGINT) AS total, \
             CAST(COALESCE(MAX(wait),0) AS BIGINT) AS longest FROM ( \
               SELECT CASE WHEN started_at_ms < claimed_at_ms THEN 0 \
                 ELSE started_at_ms - claimed_at_ms END AS wait \
               FROM supertag_v2_claims \
               WHERE started_at_ms IS NOT NULL AND claimed_at_ms IS NOT NULL) waits",
        )
        .fetch_one(&self.pool)
        .await?;
        let summary = |row: &sqlx::any::AnyRow| -> Result<(i64, i64, i64)> {
            let count: i64 = row.try_get("n")?;
            let total: i64 = row.try_get("total")?;
            let average = if count == 0 { 0 } else { total / count };
            Ok((count, average, row.try_get("longest")?))
        };
        let (placed_tasks, average_queue_wait_ms, maximum_queue_wait_ms) = summary(&queue)?;
        let (started_attempts, average_start_wait_ms, maximum_start_wait_ms) = summary(&start)?;
        Ok(MetricScheduling {
            oldest_queued_at_ms,
            placed_tasks,
            average_queue_wait_ms,
            maximum_queue_wait_ms,
            started_attempts,
            average_start_wait_ms,
            maximum_start_wait_ms,
            ..Default::default()
        })
    }
}

impl ControlPlane {
    pub fn metrics_service(&self) -> metrics_server::MetricsServer<Self> {
        metrics_server::MetricsServer::new(self.clone())
            .max_decoding_message_size(supertag_protocol::MAX_MESSAGE_BYTES)
            .max_encoding_message_size(supertag_protocol::MAX_MESSAGE_BYTES)
    }
}

#[tonic::async_trait]
impl metrics_server::Metrics for ControlPlane {
    async fn get_metrics(
        &self,
        request: Request<GetMetricsRequest>,
    ) -> std::result::Result<Response<MetricSnapshot>, Status> {
        self.principal(&request, "operator:")?;
        Ok(Response::new(self.store.metrics().await?))
    }
}
