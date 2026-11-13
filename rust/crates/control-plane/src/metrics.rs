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

        Ok(MetricSnapshot {
            captured_at_ms,
            resources: Some(resources),
            scheduling: Some(MetricScheduling {
                queued: tasks.queued,
                worker_hosts,
            }),
            tasks: Some(tasks),
            usage: Some(usage),
            mailbox: Some(mailbox),
            reply_delivery: Some(reply_delivery),
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
