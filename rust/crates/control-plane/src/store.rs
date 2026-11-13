//! Authoritative storage for the first Rust execution slice.
//!
//! Writes take a database lock before reading state. This intentionally serializes
//! this first slice's mutations, including across multiple service instances. A
//! socket, Tokio mutex, or response acknowledgement never owns durable work.

mod authority;
mod execution;
#[path = "github_events.rs"]
mod github_events;
mod hosts;
#[path = "lark_events.rs"]
mod lark_events;
#[path = "linear_events.rs"]
mod linear_events;
#[path = "microsoft_teams.rs"]
mod microsoft_teams;
mod readiness;
#[path = "slack_threads.rs"]
mod slack_threads;
mod sqlite_files;
pub(crate) use authority::lease_is_live;
pub use hosts::HostAuthority;
pub(crate) use readiness::status_in as host_status_in;

use std::{collections::BTreeMap, str::FromStr, sync::Arc, time::Duration};

use prost::Message;
use sha2::{Digest, Sha256};
use sqlx::{
    Any, AnyPool, Row, Transaction,
    any::{AnyConnectOptions, AnyPoolOptions, AnyRow},
};
use supertag_protocol::{
    v2::{
        AcceptEventRequest, AppendEventRequest, ApprovalRule, Assignment, ContextContract,
        ExecutionLimits, ExecutionSelection, FinishTaskRequest, HarnessExecutionProfile,
        HarnessKind, PolicyExecutionSettings, PutTagRequest, Reply, ReplyDestination, ReplyState,
        StartTaskRequest, SubmitTaskRequest, Tag, Task, TaskEvent, TaskState, WorkspaceSpec,
    },
    valid_git_commit, valid_workspace_id,
};
use uuid::Uuid;

#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error("{0}")]
    InvalidArgument(String),
    #[error("{0}")]
    NotFound(String),
    #[error("{0}")]
    Conflict(String),
    #[error("{0}")]
    FailedPrecondition(String),
    #[error("execution ownership does not match")]
    PermissionDenied,
    #[error("storage operation failed")]
    Storage(#[from] sqlx::Error),
    #[error("stored data is invalid")]
    Data(#[from] serde_json::Error),
}

pub(crate) type Result<T> = std::result::Result<T, StoreError>;
pub(crate) const MAX_TASK_PROMPT_BYTES: usize = 262_144;
// Reserve framing space for the enclosing conversation and execution messages.
pub(crate) const MAX_TASK_MESSAGE_BYTES: usize = supertag_protocol::MAX_MESSAGE_BYTES - 4096;

#[derive(Clone)]
pub struct Store {
    pub(crate) pool: AnyPool,
    execution_clock: Option<Arc<dyn Fn() -> i64 + Send + Sync>>,
    /// When this process first swept ephemeral Worker Hosts.
    ephemeral_watch_since: Arc<std::sync::OnceLock<i64>>,
}

impl Store {
    pub async fn open(url: &str) -> anyhow::Result<Self> {
        const SCHEMA_VERSION: i64 = 65;
        sqlx::any::install_default_drivers();
        let sqlite = url.starts_with("sqlite:");
        anyhow::ensure!(
            sqlite || url.starts_with("postgres:") || url.starts_with("postgresql:"),
            "expected a SQLite or PostgreSQL database URL"
        );
        if sqlite {
            sqlite_files::make_private(url)?;
        }
        let options = AnyConnectOptions::from_str(url)?;
        let pool = AnyPoolOptions::new()
            .max_connections(if sqlite { 1 } else { 8 })
            .acquire_timeout(Duration::from_secs(10))
            .connect_with(options)
            .await?;
        let tables: Vec<String> = if sqlite {
            sqlx::query_scalar(
                "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
            )
            .fetch_all(&pool)
            .await?
        } else {
            sqlx::query_scalar("SELECT CAST(table_name AS TEXT) FROM information_schema.tables WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'")
                .fetch_all(&pool).await?
        };
        if tables
            .iter()
            .any(|table| !table.starts_with("supertag_v2_"))
        {
            pool.close().await;
            anyhow::bail!(
                "Rust services require a fresh database; existing non-Rust tables were found"
            );
        }
        // Check an existing store before issuing any schema mutation. An unknown
        // newer schema must not be modified by an older executable.
        let version = if tables.iter().any(|table| table == "supertag_v2_schema") {
            let versions: Vec<i64> = sqlx::query_scalar("SELECT version FROM supertag_v2_schema")
                .fetch_all(&pool)
                .await?;
            if !matches!(versions.as_slice(), [version] if (1..=SCHEMA_VERSION).contains(version)) {
                pool.close().await;
                anyhow::bail!("unsupported Rust database schema");
            }
            versions[0]
        } else if !tables.is_empty() {
            pool.close().await;
            anyhow::bail!("Rust schema marker is missing; refusing to initialize existing tables");
        } else {
            0
        };
        let migrations = if sqlite {
            [
                include_str!("../migrations/sqlite/0001_initial.sql"),
                include_str!("../migrations/sqlite/0002_connector_outbox.sql"),
                include_str!("../migrations/sqlite/0003_execution_authority.sql"),
                include_str!("../migrations/sqlite/0004_objectives.sql"),
                include_str!("../migrations/sqlite/0005_host_enrollment.sql"),
                include_str!("../migrations/sqlite/0006_session_checkpoints.sql"),
                include_str!("../migrations/sqlite/0007_workspace_delivery.sql"),
                include_str!("../migrations/sqlite/0008_live_input.sql"),
                include_str!("../migrations/sqlite/0009_slack_threads.sql"),
                include_str!("../migrations/sqlite/0010_github_events.sql"),
                include_str!("../migrations/sqlite/0011_harness_selection.sql"),
                include_str!("../migrations/sqlite/0012_linear_events.sql"),
                include_str!("../migrations/sqlite/0013_conversations.sql"),
                include_str!("../migrations/sqlite/0014_lark.sql"),
                include_str!("../migrations/sqlite/0015_team_workstreams.sql"),
                include_str!("../migrations/sqlite/0016_operator_watch.sql"),
                include_str!("../migrations/sqlite/0017_microsoft_teams.sql"),
                include_str!("../migrations/sqlite/0018_mailbox.sql"),
                include_str!("../migrations/sqlite/0019_host_readiness.sql"),
                include_str!("../migrations/sqlite/0020_objective_inbox.sql"),
                include_str!("../migrations/sqlite/0021_approvals.sql"),
                include_str!("../migrations/sqlite/0022_approval_coverage.sql"),
                include_str!("../migrations/sqlite/0023_policy.sql"),
                include_str!("../migrations/sqlite/0024_direct_mailbox.sql"),
                include_str!("../migrations/sqlite/0025_surface_policy.sql"),
                include_str!("../migrations/sqlite/0026_context_resolution.sql"),
                include_str!("../migrations/sqlite/0027_work_sessions.sql"),
                include_str!("../migrations/sqlite/0028_work_session_lifecycle.sql"),
                include_str!("../migrations/sqlite/0029_objective_runtime_actions.sql"),
                include_str!("../migrations/sqlite/0030_commit_reviews.sql"),
                include_str!("../migrations/sqlite/0031_execution_limits.sql"),
                include_str!("../migrations/sqlite/0032_attempt_usage.sql"),
                include_str!("../migrations/sqlite/0033_opencode_harness.sql"),
                include_str!("../migrations/sqlite/0034_cursor_harness.sql"),
                include_str!("../migrations/sqlite/0035_execution_selection.sql"),
                include_str!("../migrations/sqlite/0036_tag_execution.sql"),
                include_str!("../migrations/sqlite/0037_accepted_execution.sql"),
                include_str!("../migrations/sqlite/0038_reply_recovery.sql"),
                include_str!("../migrations/sqlite/0039_tag_retirement.sql"),
                include_str!("../migrations/sqlite/0040_github_workspaces.sql"),
                include_str!("../migrations/sqlite/0041_artifact_captures.sql"),
                include_str!("../migrations/sqlite/0042_github_publications.sql"),
                include_str!("../migrations/sqlite/0043_task_result_artifacts.sql"),
                include_str!("../migrations/sqlite/0044_github_source_pins.sql"),
                include_str!("../migrations/sqlite/0045_task_output_policy.sql"),
                include_str!("../migrations/sqlite/0046_artifact_acquisitions.sql"),
                include_str!("../migrations/sqlite/0047_mcp_effects.sql"),
                include_str!("../migrations/sqlite/0048_artifact_volumes.sql"),
                include_str!("../migrations/sqlite/0049_task_artifact_inputs.sql"),
                include_str!("../migrations/sqlite/0050_artifact_publications.sql"),
                include_str!("../migrations/sqlite/0051_artifact_context.sql"),
                include_str!("../migrations/sqlite/0052_artifact_volume_fallback.sql"),
                include_str!("../migrations/sqlite/0053_manifest_relationships.sql"),
                include_str!("../migrations/sqlite/0054_direct_artifact_transfer.sql"),
                include_str!("../migrations/sqlite/0055_workspace_volume_mounts.sql"),
                include_str!("../migrations/sqlite/0056_apply_set_members.sql"),
                include_str!("../migrations/sqlite/0057_host_disk_space.sql"),
                include_str!("../migrations/sqlite/0058_operator_access_audit.sql"),
                include_str!("../migrations/sqlite/0059_placement_auth_keys.sql"),
                include_str!("../migrations/sqlite/0060_host_harness_capacity.sql"),
                include_str!("../migrations/sqlite/0061_reply_progress.sql"),
                include_str!("../migrations/sqlite/0062_surface_objectives_connector_leases.sql"),
                include_str!("../migrations/sqlite/0063_attempt_claim_times.sql"),
                include_str!("../migrations/sqlite/0064_workspace_mcp.sql"),
                include_str!("../migrations/sqlite/0065_audit_calls.sql"),
            ]
        } else {
            [
                include_str!("../migrations/postgresql/0001_initial.sql"),
                include_str!("../migrations/postgresql/0002_connector_outbox.sql"),
                include_str!("../migrations/postgresql/0003_execution_authority.sql"),
                include_str!("../migrations/postgresql/0004_objectives.sql"),
                include_str!("../migrations/postgresql/0005_host_enrollment.sql"),
                include_str!("../migrations/postgresql/0006_session_checkpoints.sql"),
                include_str!("../migrations/postgresql/0007_workspace_delivery.sql"),
                include_str!("../migrations/postgresql/0008_live_input.sql"),
                include_str!("../migrations/postgresql/0009_slack_threads.sql"),
                include_str!("../migrations/postgresql/0010_github_events.sql"),
                include_str!("../migrations/postgresql/0011_harness_selection.sql"),
                include_str!("../migrations/postgresql/0012_linear_events.sql"),
                include_str!("../migrations/postgresql/0013_conversations.sql"),
                include_str!("../migrations/postgresql/0014_lark.sql"),
                include_str!("../migrations/postgresql/0015_team_workstreams.sql"),
                include_str!("../migrations/postgresql/0016_operator_watch.sql"),
                include_str!("../migrations/postgresql/0017_microsoft_teams.sql"),
                include_str!("../migrations/postgresql/0018_mailbox.sql"),
                include_str!("../migrations/postgresql/0019_host_readiness.sql"),
                include_str!("../migrations/postgresql/0020_objective_inbox.sql"),
                include_str!("../migrations/postgresql/0021_approvals.sql"),
                include_str!("../migrations/postgresql/0022_approval_coverage.sql"),
                include_str!("../migrations/postgresql/0023_policy.sql"),
                include_str!("../migrations/postgresql/0024_direct_mailbox.sql"),
                include_str!("../migrations/postgresql/0025_surface_policy.sql"),
                include_str!("../migrations/postgresql/0026_context_resolution.sql"),
                include_str!("../migrations/postgresql/0027_work_sessions.sql"),
                include_str!("../migrations/postgresql/0028_work_session_lifecycle.sql"),
                include_str!("../migrations/postgresql/0029_objective_runtime_actions.sql"),
                include_str!("../migrations/postgresql/0030_commit_reviews.sql"),
                include_str!("../migrations/postgresql/0031_execution_limits.sql"),
                include_str!("../migrations/postgresql/0032_attempt_usage.sql"),
                include_str!("../migrations/postgresql/0033_opencode_harness.sql"),
                include_str!("../migrations/postgresql/0034_cursor_harness.sql"),
                include_str!("../migrations/postgresql/0035_execution_selection.sql"),
                include_str!("../migrations/postgresql/0036_tag_execution.sql"),
                include_str!("../migrations/postgresql/0037_accepted_execution.sql"),
                include_str!("../migrations/postgresql/0038_reply_recovery.sql"),
                include_str!("../migrations/postgresql/0039_tag_retirement.sql"),
                include_str!("../migrations/postgresql/0040_github_workspaces.sql"),
                include_str!("../migrations/postgresql/0041_artifact_captures.sql"),
                include_str!("../migrations/postgresql/0042_github_publications.sql"),
                include_str!("../migrations/postgresql/0043_task_result_artifacts.sql"),
                include_str!("../migrations/postgresql/0044_github_source_pins.sql"),
                include_str!("../migrations/postgresql/0045_task_output_policy.sql"),
                include_str!("../migrations/postgresql/0046_artifact_acquisitions.sql"),
                include_str!("../migrations/postgresql/0047_mcp_effects.sql"),
                include_str!("../migrations/postgresql/0048_artifact_volumes.sql"),
                include_str!("../migrations/postgresql/0049_task_artifact_inputs.sql"),
                include_str!("../migrations/postgresql/0050_artifact_publications.sql"),
                include_str!("../migrations/postgresql/0051_artifact_context.sql"),
                include_str!("../migrations/postgresql/0052_artifact_volume_fallback.sql"),
                include_str!("../migrations/postgresql/0053_manifest_relationships.sql"),
                include_str!("../migrations/postgresql/0054_direct_artifact_transfer.sql"),
                include_str!("../migrations/postgresql/0055_workspace_volume_mounts.sql"),
                include_str!("../migrations/postgresql/0056_apply_set_members.sql"),
                include_str!("../migrations/postgresql/0057_host_disk_space.sql"),
                include_str!("../migrations/postgresql/0058_operator_access_audit.sql"),
                include_str!("../migrations/postgresql/0059_placement_auth_keys.sql"),
                include_str!("../migrations/postgresql/0060_host_harness_capacity.sql"),
                include_str!("../migrations/postgresql/0061_reply_progress.sql"),
                include_str!(
                    "../migrations/postgresql/0062_surface_objectives_connector_leases.sql"
                ),
                include_str!("../migrations/postgresql/0063_attempt_claim_times.sql"),
                include_str!("../migrations/postgresql/0064_workspace_mcp.sql"),
                include_str!("../migrations/postgresql/0065_audit_calls.sql"),
            ]
        };
        if version < SCHEMA_VERSION {
            let mut transaction = pool.begin().await?;
            for migration in &migrations[version as usize..] {
                sqlx::raw_sql(migration).execute(&mut *transaction).await?;
            }
            if version < 52 {
                Box::pin(crate::artifact_volumes::backfill_file_paths(
                    &mut transaction,
                ))
                .await?;
            }
            if version < 16 {
                sqlx::query("UPDATE supertag_v2_watch_state SET feed_id=$1 WHERE singleton=1")
                    .bind(Uuid::new_v4().simple().to_string())
                    .execute(&mut *transaction)
                    .await?;
            }
            transaction.commit().await?;
        }
        let versions: Vec<i64> = sqlx::query_scalar("SELECT version FROM supertag_v2_schema")
            .fetch_all(&pool)
            .await?;
        anyhow::ensure!(
            versions == [SCHEMA_VERSION],
            "unsupported Rust database schema"
        );
        Ok(Self {
            pool,
            execution_clock: None,
            ephemeral_watch_since: Arc::default(),
        })
    }

    pub async fn close(&self) {
        self.pool.close().await;
    }

    pub(crate) async fn write(&self) -> Result<(Transaction<'_, Any>, i64)> {
        let mut transaction = self.pool.begin().await?;
        // PostgreSQL takes a row lock; SQLite takes its write lock before any reads.
        let order = next_order(&mut transaction).await?;
        Ok((transaction, order))
    }

    pub async fn put_tag(
        &self,
        tag_id: &str,
        instructions: &str,
        allowed_actions: Vec<String>,
    ) -> Result<Tag> {
        self.put_tag_with_workspace(tag_id, instructions, allowed_actions, None)
            .await
    }

    pub async fn put_tag_with_workspace(
        &self,
        tag_id: &str,
        instructions: &str,
        allowed_actions: Vec<String>,
        workspace: Option<WorkspaceSpec>,
    ) -> Result<Tag> {
        self.put_tag_configured(
            tag_id,
            instructions,
            allowed_actions,
            workspace,
            HarnessKind::Unspecified,
        )
        .await
    }

    pub async fn put_tag_configured(
        &self,
        tag_id: &str,
        instructions: &str,
        allowed_actions: Vec<String>,
        workspace: Option<WorkspaceSpec>,
        harness: HarnessKind,
    ) -> Result<Tag> {
        self.put_tag_spec(PutTagRequest {
            tag_id: tag_id.into(),
            instructions: instructions.into(),
            allowed_actions,
            workspace,
            harness_kind: harness as i32,
            approval_rules: vec![],
            execution: None,
            name: None,
            expected_revision: None,
        })
        .await
    }

    pub async fn put_tag_spec(&self, input: PutTagRequest) -> Result<Tag> {
        let (mut tx, _) = self.write().await?;
        let tag = Self::put_tag_in(&mut tx, input).await?;
        tx.commit().await?;
        Ok(tag)
    }

    pub(crate) async fn put_tag_in(
        transaction: &mut Transaction<'_, Any>,
        input: PutTagRequest,
    ) -> Result<Tag> {
        let PutTagRequest {
            tag_id,
            instructions,
            mut allowed_actions,
            mut workspace,
            harness_kind,
            approval_rules,
            execution,
            name: display_name,
            expected_revision,
        } = input;
        let tag_id = tag_id.as_str();
        let instructions = instructions.as_str();
        let harness =
            HarnessKind::try_from(harness_kind).map_err(|_| invalid("unknown harness kind"))?;
        let (harness, execution) = crate::policy::normalize_tag_execution(harness, execution)?;
        if workspace.is_some()
            && execution
                .as_ref()
                .is_some_and(|settings| settings.shared_execution_environment_id.is_some())
        {
            return Err(invalid(
                "shared execution cannot use a pinned Git Workspace",
            ));
        }
        name("Tag ID", tag_id)?;
        if let Some(display_name) = &display_name {
            crate::tags::validate_display_name(display_name)?;
        }
        if let Some(spec) = &workspace
            && (!valid_workspace_id(&spec.workspace_id)
                || (!spec.base_commit.is_empty() && !valid_git_commit(&spec.base_commit))
                || spec.github_source.is_some())
        {
            return Err(invalid("workspace ID and full Git base commit required"));
        }
        text("instructions", instructions, 65_536)?;
        if allowed_actions.len() > 256 {
            return Err(invalid("too many allowed actions"));
        }
        for action in &allowed_actions {
            name("allowed action", action)?;
        }
        allowed_actions.sort();
        allowed_actions.dedup();
        let actions = serde_json::to_string(&allowed_actions)?;
        let approval_rules = normalize_approval_rules(approval_rules, &allowed_actions)?;
        let stored_rules = stored_approval_rules(&approval_rules)?;
        if let Some(expected) = expected_revision {
            let revision: Option<i64> =
                sqlx::query_scalar("SELECT revision FROM supertag_v2_tags WHERE tag_id=$1")
                    .bind(tag_id)
                    .fetch_optional(&mut **transaction)
                    .await?;
            if revision.unwrap_or(0) as u64 != expected {
                return Err(StoreError::Conflict("Tag revision changed".into()));
            }
        }
        crate::github_workspaces::validate_tag_in(transaction, workspace.as_ref()).await?;
        crate::workspace_mounts::configure_in(transaction, &mut workspace).await?;
        if let Some(spec) = workspace.as_mut()
            && !supertag_protocol::mcp::normalize_workspace_servers(&mut spec.mcp_servers)
        {
            return Err(invalid("invalid Workspace MCP server names"));
        }
        let display_name =
            crate::tags::active_name_in(transaction, tag_id, display_name.as_deref()).await?;
        let revision: i64 = sqlx::query_scalar("INSERT INTO supertag_v2_tags (tag_id, instructions, allowed_actions, revision, workspace_id, workspace_base_commit, harness_kind, approval_rules, execution, name, workspace_mounts, workspace_mcp_servers) VALUES ($1,$2,$3,1,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT(tag_id) DO UPDATE SET instructions = excluded.instructions, allowed_actions = excluded.allowed_actions, revision = supertag_v2_tags.revision + 1, workspace_id = excluded.workspace_id, workspace_base_commit = excluded.workspace_base_commit, harness_kind = excluded.harness_kind, approval_rules = excluded.approval_rules, execution = excluded.execution, name = excluded.name, workspace_mounts=excluded.workspace_mounts, workspace_mcp_servers=excluded.workspace_mcp_servers RETURNING revision")
            .bind(tag_id).bind(instructions).bind(actions)
            .bind(workspace.as_ref().map(|spec| &spec.workspace_id))
            .bind(workspace.as_ref().map(|spec| &spec.base_commit))
            .bind(harness as i64)
            .bind(stored_rules)
            .bind(execution.as_ref().map(Message::encode_to_vec))
            .bind(&display_name)
            .bind(crate::workspace_mounts::encode(workspace.as_ref()))
            .bind(crate::workspaces::encode_mcp_servers(workspace.as_ref()))
            .fetch_one(&mut **transaction).await?;
        Ok(Tag {
            tag_id: tag_id.into(),
            instructions: instructions.into(),
            allowed_actions,
            revision: revision as u64,
            workspace,
            harness_kind: harness as i32,
            approval_rules,
            execution,
            name: display_name,
            retired_at_ms: None,
            runs_on: crate::placement::runs_on_in(transaction, tag_id).await?,
        })
    }

    pub async fn submit_task(&self, principal: &str, input: &SubmitTaskRequest) -> Result<Task> {
        let execution_limits = crate::budget_pool::normalize(input.execution_limits.as_ref())?;
        let output_policy =
            supertag_protocol::output_policy::normalize(input.output_policy.as_ref())
                .map_err(|error| invalid(error.message()))?;
        let artifact_inputs = crate::task_artifact_inputs::normalize(&input.input_artifacts)?;
        name("principal", principal)?;
        name("operation ID", &input.operation_id)?;
        name("Tag ID", &input.tag_id)?;
        name("Session ID", &input.session_id)?;
        if crate::conversations::private_session(&input.session_id) {
            return Err(StoreError::FailedPrecondition(
                "send messages through the conversation".into(),
            ));
        }
        if crate::mailbox::private_session(&input.session_id) {
            return Err(invalid("Mailbox Sessions are reserved for delivery"));
        }
        text("prompt", &input.prompt, MAX_TASK_PROMPT_BYTES)?;
        let mut digest = format!(
            "{:x}",
            Sha256::digest(serde_json::to_vec(&(
                &input.tag_id,
                &input.session_id,
                &input.prompt
            ))?)
        );
        if let Some(limits) = &execution_limits {
            digest = format!(
                "{:x}",
                Sha256::digest(serde_json::to_vec(&(&digest, limits.encode_to_vec()))?)
            );
        }
        let digest = output_policy_digest(digest, output_policy.as_ref())?;
        let digest = crate::task_artifact_inputs::digest(digest, &artifact_inputs);
        let (mut transaction, order) = self.write().await?;
        let prior = sqlx::query("SELECT request_digest, task_id FROM supertag_v2_admissions WHERE principal = $1 AND operation_id = $2")
            .bind(principal).bind(&input.operation_id).fetch_optional(&mut *transaction).await?;
        if let Some(prior) = prior {
            if prior.try_get::<String, _>("request_digest")? != digest {
                return Err(StoreError::Conflict(
                    "operation ID was used with different work".into(),
                ));
            }
            let task = task_in(&mut transaction, &prior.try_get::<String, _>("task_id")?).await?;
            transaction.commit().await?;
            return Ok(task);
        }
        crate::objectives::objective_admission_in(
            &mut transaction,
            &input.tag_id,
            &input.session_id,
            self.execution_now_ms(),
        )
        .await?;
        let mut task = insert_task_with_requirements(
            &mut transaction,
            order,
            &input.tag_id,
            &input.session_id,
            &input.prompt,
            (execution_limits.as_ref(), output_policy.as_ref()),
        )
        .await?;
        crate::objectives::objective_link_task_in(&mut transaction, &task).await?;
        if !artifact_inputs.is_empty() {
            Box::pin(crate::task_artifact_inputs::accept_in(
                &mut transaction,
                principal,
                &mut task,
                &artifact_inputs,
            ))
            .await?;
        }
        let id = &task.task_id;
        sqlx::query("INSERT INTO supertag_v2_admissions (principal, operation_id, request_digest, task_id) VALUES ($1,$2,$3,$4)")
            .bind(principal).bind(&input.operation_id).bind(digest).bind(id).execute(&mut *transaction).await?;
        supertag_protocol::crash_point("control-plane.submit", "before-commit");
        transaction.commit().await?;
        Ok(task)
    }

    pub async fn get_task(&self, task_id: &str) -> Result<Task> {
        name("Task ID", task_id)?;
        let row = sqlx::query("SELECT * FROM supertag_v2_tasks WHERE task_id = $1")
            .bind(task_id)
            .fetch_optional(&self.pool)
            .await?
            .ok_or_else(|| StoreError::NotFound("Task was not found".into()))?;
        task_row(&row)
    }

    pub async fn cancel_task(&self, task_id: &str) -> Result<Task> {
        name("Task ID", task_id)?;
        let (mut transaction, _) = self.write().await?;
        let task = task_in(&mut transaction, task_id).await?;
        if [
            TaskState::Queued as i32,
            TaskState::Claimed as i32,
            TaskState::Running as i32,
        ]
        .contains(&task.state)
        {
            sqlx::query("UPDATE supertag_v2_tasks SET state = $1 WHERE task_id = $2")
                .bind(TaskState::Cancelled as i64)
                .bind(task_id)
                .execute(&mut *transaction)
                .await?;
        }
        let task = task_in(&mut transaction, task_id).await?;
        crate::work_sessions::reports::settle_in(&mut transaction, &task, self.execution_now_ms())
            .await?;
        transaction.commit().await?;
        Ok(task)
    }

    pub async fn claim_task(
        &self,
        host: &HostAuthority,
        operation_id: &str,
    ) -> Result<Option<Assignment>> {
        self.claim_task_with_workspaces(host, operation_id, &[])
            .await
    }

    pub async fn claim_task_with_workspaces(
        &self,
        host: &HostAuthority,
        operation_id: &str,
        workspace_ids: &[String],
    ) -> Result<Option<Assignment>> {
        self.claim_task_for_host(host, operation_id, workspace_ids, HarnessKind::Unspecified)
            .await
    }

    pub async fn claim_task_for_host(
        &self,
        host: &HostAuthority,
        operation_id: &str,
        workspace_ids: &[String],
        harness: HarnessKind,
    ) -> Result<Option<Assignment>> {
        self.claim_task_with_context(host, operation_id, workspace_ids, harness, &[])
            .await
    }

    pub async fn claim_task_with_context(
        &self,
        host: &HostAuthority,
        operation_id: &str,
        workspace_ids: &[String],
        harness: HarnessKind,
        context_contracts: &[ContextContract],
    ) -> Result<Option<Assignment>> {
        self.claim_task_with_profile(
            host,
            operation_id,
            workspace_ids,
            harness,
            context_contracts,
            None,
        )
        .await
    }

    pub async fn claim_task_with_profile(
        &self,
        host: &HostAuthority,
        operation_id: &str,
        workspace_ids: &[String],
        harness: HarnessKind,
        context_contracts: &[ContextContract],
        execution_profile: Option<&HarnessExecutionProfile>,
    ) -> Result<Option<Assignment>> {
        self.claim_task_with_sources(
            host,
            operation_id,
            (workspace_ids, &[]),
            harness,
            context_contracts,
            execution_profile,
        )
        .await
    }

    pub async fn claim_task_with_sources(
        &self,
        host: &HostAuthority,
        operation_id: &str,
        (workspace_ids, gateway_workspace_ids): (&[String], &[String]),
        harness: HarnessKind,
        context_contracts: &[ContextContract],
        execution_profile: Option<&HarnessExecutionProfile>,
    ) -> Result<Option<Assignment>> {
        name("operation ID", operation_id)?;
        let profile = execution::normalize_profile(execution_profile)?;
        let profile_bytes = profile.encode_to_vec();
        if workspace_ids.len() > 128 || workspace_ids.iter().any(|id| !valid_workspace_id(id)) {
            return Err(invalid("invalid Worker Host workspace capabilities"));
        }
        let mut workspace_ids = workspace_ids.to_vec();
        workspace_ids.sort();
        workspace_ids.dedup();
        let workspace_scope = serde_json::to_string(&workspace_ids)?;
        if gateway_workspace_ids.len() > 128
            || gateway_workspace_ids
                .iter()
                .any(|id| !valid_workspace_id(id))
        {
            return Err(invalid("invalid Gateway workspace capabilities"));
        }
        let mut gateway_workspace_ids = gateway_workspace_ids.to_vec();
        gateway_workspace_ids.sort();
        gateway_workspace_ids.dedup();
        let gateway_workspace_scope = serde_json::to_string(&gateway_workspace_ids)?;
        if context_contracts.len() > 64 {
            return Err(invalid("too many Worker Host Context Item capabilities"));
        }
        let mut contracts = context_contracts.to_vec();
        for contract in &contracts {
            name("Context Item type", &contract.r#type)?;
            if contract.version == 0 {
                return Err(invalid("Context Item version is required"));
            }
        }
        contracts.sort_by(|left, right| {
            (&left.r#type, left.version).cmp(&(&right.r#type, right.version))
        });
        contracts.dedup();
        let context_scope = serde_json::to_string(
            &contracts
                .iter()
                .map(|contract| (&contract.r#type, contract.version))
                .collect::<Vec<_>>(),
        )?;
        let (mut transaction, _) = self.write().await?;
        let all_tags = hosts::current_scope_in(&mut transaction, host).await?;
        let now = self.execution_now_ms();
        crate::objectives::objective_sweep_in(&mut transaction, now).await?;
        authority::expire_due_attempts(&mut transaction, now).await?;
        crate::inputs::sweep_in(&mut transaction, now).await?;
        crate::mailbox::sweep_in(&mut transaction).await?;
        crate::work_sessions::reports::sweep_in(&mut transaction, now).await?;
        let prior = sqlx::query("SELECT task_id, attempt_id, lease_token, workspace_scope, gateway_workspace_scope, harness_kind, context_scope, execution_profile, attempt_execution FROM supertag_v2_claims WHERE principal = $1 AND operation_id = $2")
            .bind(&host.principal).bind(operation_id).fetch_optional(&mut *transaction).await?;
        if let Some(prior) = prior {
            let previous: Option<String> = prior.try_get("workspace_scope")?;
            if previous.as_deref().unwrap_or("[]") != workspace_scope
                || prior.try_get::<String, _>("gateway_workspace_scope")? != gateway_workspace_scope
                || prior.try_get::<i64, _>("harness_kind")? != harness as i64
                || prior.try_get::<String, _>("context_scope")? != context_scope
                || prior
                    .try_get::<Option<Vec<u8>>, _>("execution_profile")?
                    .unwrap_or_default()
                    != profile_bytes
            {
                return Err(StoreError::Conflict(
                    "claim operation used different Worker Host capabilities".into(),
                ));
            }
            let id: Option<String> = prior.try_get("task_id")?;
            let assignment = match id {
                Some(id) => {
                    let task = task_in(&mut transaction, &id).await?;
                    let attempt_id: String = prior.try_get("attempt_id")?;
                    if task.attempt_id.as_deref() == Some(attempt_id.as_str())
                        && matches!(task.state(), TaskState::Claimed | TaskState::Running)
                    {
                        if task.attempt_execution
                            != execution::read_attempt(prior.try_get("attempt_execution")?)?
                        {
                            return Err(invalid(
                                "Attempt differs from its execution selection receipt",
                            ));
                        }
                        Some(Assignment {
                            task: Some(task),
                            attempt_id,
                            lease_token: prior.try_get("lease_token")?,
                        })
                    } else {
                        None
                    }
                }
                None => None,
            };
            transaction.commit().await?;
            return Ok(assignment);
        }
        if !readiness::accepting_in(&mut transaction, host.id()).await? {
            transaction.commit().await?;
            return Ok(None);
        }
        let Some((id, attempt_execution)) = authority::claim_candidate(
            &mut transaction,
            now,
            (host.id(), host.generation),
            all_tags,
            (&workspace_ids, &gateway_workspace_ids),
            (harness, &profile),
            &contracts,
        )
        .await?
        else {
            // Commit maintenance transitions. An empty poll retains no claim receipt.
            transaction.commit().await?;
            return Ok(None);
        };
        let attempt = Uuid::new_v4().to_string();
        let lease = Uuid::new_v4().to_string();
        let attempt_execution = attempt_execution.encode_to_vec();
        sqlx::query("UPDATE supertag_v2_tasks SET state = $1, attempt_id = $2, host_principal = $3, host_generation = $4, lease_token = $5, lease_expires_at_ms = $6, event_sequence_base = next_sequence - 1, attempt_execution = $7 WHERE task_id = $8")
            .bind(TaskState::Claimed as i64).bind(&attempt).bind(&host.principal).bind(host.generation).bind(&lease)
            .bind(authority::lease_deadline(now)).bind(&attempt_execution).bind(&id).execute(&mut *transaction).await?;
        sqlx::query("INSERT INTO supertag_v2_claims (principal, operation_id, task_id, attempt_id, lease_token, workspace_scope, harness_kind, context_scope, execution_profile, attempt_execution, gateway_workspace_scope, claimed_at_ms) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)")
            .bind(&host.principal).bind(operation_id).bind(&id).bind(&attempt).bind(&lease).bind(workspace_scope).bind(harness as i64).bind(context_scope).bind(profile_bytes).bind(attempt_execution).bind(gateway_workspace_scope).bind(now).execute(&mut *transaction).await?;
        let task = task_in(&mut transaction, &id).await?;
        supertag_protocol::crash_point("control-plane.claim", "before-commit");
        transaction.commit().await?;
        Ok(Some(Assignment {
            task: Some(task),
            attempt_id: attempt,
            lease_token: lease,
        }))
    }

    pub async fn inspect_attempt(
        &self,
        host: &HostAuthority,
        task_id: &str,
        attempt_id: &str,
        lease_token: &str,
    ) -> Result<Task> {
        let mut transaction = self.pool.begin().await?;
        let row = owned(&mut transaction, host, task_id, attempt_id, lease_token).await?;
        let task = task_row(&row)?;
        transaction.commit().await?;
        Ok(task)
    }

    pub async fn start_task(&self, host: &HostAuthority, input: &StartTaskRequest) -> Result<Task> {
        let (mut transaction, _) = self.write().await?;
        let now = self.execution_now_ms();
        crate::objectives::objective_sweep_in(&mut transaction, now).await?;
        let row = owned(
            &mut transaction,
            host,
            &input.task_id,
            &input.attempt_id,
            &input.lease_token,
        )
        .await?;
        let state = row.try_get::<i64, _>("state")?;
        if state != TaskState::Claimed as i64 && state != TaskState::Running as i64 {
            transaction.commit().await?;
            return Err(StoreError::FailedPrecondition(
                "Task is no longer eligible to start".into(),
            ));
        }
        if !lease_is_live(&row, now)? {
            return Err(StoreError::FailedPrecondition(
                "execution lease expired".into(),
            ));
        }
        if state == TaskState::Claimed as i64 {
            if !crate::workspace_mounts::current_in(&mut transaction, &task_row(&row)?).await? {
                return Err(StoreError::FailedPrecondition(
                    "accepted Workspace Volume changed before start".into(),
                ));
            }
            if !crate::objectives::objective_task_can_start_in(
                &mut transaction,
                &task_row(&row)?,
                now,
            )
            .await?
            {
                // This reservation never authorized native execution. Retire it
                // immediately so a paused Objective cannot occupy its host until
                // lease expiry. Its durable claim receipt remains bound to the old
                // Attempt and cannot acquire the replacement reservation.
                sqlx::query("UPDATE supertag_v2_tasks SET state=$1, attempt_id=NULL, host_principal=NULL, host_generation=NULL, lease_token=NULL, lease_expires_at_ms=NULL, event_sequence_base=0 WHERE task_id=$2")
                    .bind(TaskState::Queued as i64).bind(&input.task_id)
                    .execute(&mut *transaction).await?;
                transaction.commit().await?;
                return Err(StoreError::FailedPrecondition(
                    "Objective does not allow this Task to start".into(),
                ));
            }
            let deadline = crate::objectives::objective_lease_deadline_in(
                &mut transaction,
                &task_row(&row)?,
                authority::lease_deadline(now),
            )
            .await?;
            sqlx::query("UPDATE supertag_v2_tasks SET state = $1, cleanup_pending = 1, cleanup_observed = 0, lease_expires_at_ms = $2 WHERE task_id = $3")
                .bind(TaskState::Running as i64).bind(deadline).bind(&input.task_id)
                .execute(&mut *transaction).await?;
            crate::mailbox::started_in(&mut transaction, &input.task_id).await?;
        }
        let task = task_in(&mut transaction, &input.task_id).await?;
        if state == TaskState::Claimed as i64 {
            crate::objectives::objective_started_in(&mut transaction, &task).await?;
            supertag_protocol::crash_point("control-plane.start", "before-commit");
        }
        transaction.commit().await?;
        Ok(task)
    }

    pub async fn append_event(
        &self,
        host: &HostAuthority,
        input: &AppendEventRequest,
    ) -> Result<TaskEvent> {
        let sequence =
            i64::try_from(input.sequence).map_err(|_| invalid("event sequence is too large"))?;
        if sequence == 0 {
            return Err(invalid("event sequence starts at one"));
        }
        text("event", &input.text, 16_384)?;
        let (mut transaction, _) = self.write().await?;
        let row = owned(
            &mut transaction,
            host,
            &input.task_id,
            &input.attempt_id,
            &input.lease_token,
        )
        .await?;
        let sequence = row
            .try_get::<i64, _>("event_sequence_base")?
            .checked_add(sequence)
            .ok_or_else(|| invalid("event sequence is too large"))?;
        let prior: Option<String> = sqlx::query_scalar(
            "SELECT text FROM supertag_v2_task_events WHERE task_id = $1 AND sequence = $2",
        )
        .bind(&input.task_id)
        .bind(sequence)
        .fetch_optional(&mut *transaction)
        .await?;
        if let Some(prior) = prior {
            if prior != input.text {
                return Err(StoreError::Conflict(
                    "event sequence was used with different content".into(),
                ));
            }
        } else {
            if row.try_get::<i64, _>("state")? != TaskState::Running as i64 {
                return Err(StoreError::FailedPrecondition("Task is not running".into()));
            }
            if !lease_is_live(&row, self.execution_now_ms())? {
                return Err(StoreError::FailedPrecondition(
                    "execution lease expired".into(),
                ));
            }
            if row.try_get::<i64, _>("next_sequence")? != sequence {
                return Err(StoreError::FailedPrecondition(
                    "event sequence has a gap".into(),
                ));
            }
            sqlx::query(
                "INSERT INTO supertag_v2_task_events (task_id, sequence, text) VALUES ($1,$2,$3)",
            )
            .bind(&input.task_id)
            .bind(sequence)
            .bind(&input.text)
            .execute(&mut *transaction)
            .await?;
            sqlx::query(
                "UPDATE supertag_v2_tasks SET next_sequence = next_sequence + 1 WHERE task_id = $1",
            )
            .bind(&input.task_id)
            .execute(&mut *transaction)
            .await?;
            supertag_protocol::crash_point("control-plane.append-event", "before-commit");
            crate::reply_progress::record_in(&mut transaction, &input.task_id, &input.text).await?;
        }
        transaction.commit().await?;
        Ok(TaskEvent {
            sequence: input.sequence,
            text: input.text.clone(),
        })
    }

    pub async fn finish_task(
        &self,
        host: &HostAuthority,
        input: &FinishTaskRequest,
    ) -> Result<Task> {
        text("result", &input.result, 262_144)?;
        if !input.succeeded && input.checkpoint_sha256.is_some() {
            return Err(invalid(
                "only a successful Attempt can advance a checkpoint",
            ));
        }
        let (mut transaction, order) = self.write().await?;
        let row = owned(
            &mut transaction,
            host,
            &input.task_id,
            &input.attempt_id,
            &input.lease_token,
        )
        .await?;
        let now = self.execution_now_ms();
        let mut state = task_row(&row)?.state();
        if state == TaskState::Running {
            crate::objectives::objective_sweep_in(&mut transaction, now).await?;
            state = task_in(&mut transaction, &input.task_id).await?.state();
        }
        if state == TaskState::Running && !lease_is_live(&row, now)? {
            authority::mark_uncertain(&mut transaction, &input.task_id).await?;
            state = TaskState::Uncertain;
        }
        let desired = if input.succeeded {
            TaskState::Succeeded
        } else {
            TaskState::Failed
        };
        if state == TaskState::Cancelled {
            // Finish is also the host's receipt that execution has stopped. Cancellation
            // remains authoritative; a late outcome cannot replace it.
            sqlx::query("UPDATE supertag_v2_tasks SET cleanup_pending = 0, cleanup_observed = 1 WHERE task_id = $1")
                .bind(&input.task_id)
                .execute(&mut *transaction)
                .await?;
        } else if state == TaskState::Uncertain {
            // The host can confirm cleanup after its execution authority expired.
            // The recovery decision remains with the operator.
            sqlx::query("UPDATE supertag_v2_tasks SET cleanup_observed = 1 WHERE task_id = $1")
                .bind(&input.task_id)
                .execute(&mut *transaction)
                .await?;
        } else if matches!(state, TaskState::Succeeded | TaskState::Failed) {
            if state != desired
                || row.try_get::<Option<String>, _>("result")?.as_deref()
                    != Some(input.result.as_str())
                || row.try_get::<i64, _>("finish_objective_signal")?
                    != i64::from(input.objective_signal)
                || row.try_get::<Option<String>, _>("finish_checkpoint_sha256")?
                    != input.checkpoint_sha256
                || crate::workspaces::delivery_from_row(&row)? != input.workspace_delivery
                || crate::artifact_captures::submitted_from_row(&row)?
                    != crate::artifact_captures::normalize_submissions(&input.artifacts)?
            {
                return Err(StoreError::Conflict(
                    "Task already has a different outcome".into(),
                ));
            }
            crate::approvals::finish_replay_in(&mut transaction, &task_row(&row)?, input).await?;
        } else {
            if state != TaskState::Running {
                return Err(StoreError::FailedPrecondition("Task is not running".into()));
            }
            if input.succeeded {
                crate::workspaces::finish_in(&mut transaction, &row, input).await?;
                let output_policy = output_policy_from_row(&row)?;
                if !input.artifacts.is_empty() || output_policy.is_some() {
                    Box::pin(crate::artifact_captures::submit_in(
                        &mut transaction,
                        input,
                        output_policy.as_ref(),
                    ))
                    .await?;
                }
            } else if !input.artifacts.is_empty() {
                return Err(invalid("only a successful Task can submit artifacts"));
            }
            sqlx::query("UPDATE supertag_v2_tasks SET state = $1, result = $2, cleanup_pending = 0, cleanup_observed = 1, finish_objective_signal = $3, finish_checkpoint_sha256 = $4 WHERE task_id = $5")
                .bind(desired as i64).bind(&input.result).bind(i64::from(input.objective_signal)).bind(&input.checkpoint_sha256).bind(&input.task_id)
                .execute(&mut *transaction).await?;
        }
        let task = task_in(&mut transaction, &input.task_id).await?;
        if !task.artifacts.is_empty() && task.encoded_len() > MAX_TASK_MESSAGE_BYTES {
            return Err(invalid("Task result exceeds its message size limit"));
        }
        if state == TaskState::Running {
            crate::approvals::finish_in(&mut transaction, &task, input, now).await?;
            crate::work_sessions::questions::finish_in(&mut transaction, &task, input, now).await?;
        }
        if state == TaskState::Running && task.state() == TaskState::Succeeded {
            sqlx::query("UPDATE supertag_v2_tasks SET completed_at_ms=$1 WHERE task_id=$2")
                .bind(now)
                .bind(&task.task_id)
                .execute(&mut *transaction)
                .await?;
            crate::checkpoints::finish_in(&mut transaction, &task, input).await?;
            crate::inbox::finish_in(&mut transaction, &task, input.objective_signal, now).await?;
        }
        crate::work_sessions::reports::settle_in(&mut transaction, &task, now).await?;
        if state == TaskState::Running && task.state() == TaskState::Succeeded {
            crate::objectives::objective_finish_in(
                &mut transaction,
                &task,
                input.objective_signal,
                now,
            )
            .await?;
        }
        if task.state == TaskState::Succeeded as i32 {
            enqueue_reply(&mut transaction, &task, order).await?;
            crate::github_publications::finish_in(&mut transaction, &task).await?;
        }
        crate::objectives::objective_sweep_in(&mut transaction, now).await?;
        if state == TaskState::Running {
            supertag_protocol::crash_point("control-plane.finish", "before-commit");
        }
        transaction.commit().await?;
        Ok(task)
    }

    pub async fn accept_event(&self, principal: &str, input: &AcceptEventRequest) -> Result<Task> {
        let account = connector_account(principal)?;
        if input.account_id != account {
            return Err(StoreError::PermissionDenied);
        }
        name("event ID", &input.event_id)?;
        name("Tag ID", &input.tag_id)?;
        name("Session ID", &input.session_id)?;
        if crate::mailbox::private_session(&input.session_id) {
            return Err(invalid("Mailbox Sessions are reserved for delivery"));
        }
        if crate::conversations::private_session(&input.session_id) {
            return Err(StoreError::FailedPrecondition(
                "send messages through the conversation".into(),
            ));
        }
        text("prompt", &input.prompt, MAX_TASK_PROMPT_BYTES)?;
        let destination = input
            .destination
            .as_ref()
            .ok_or_else(|| invalid("reply destination is required"))?;
        name("conversation ID", &destination.conversation_id)?;
        if let Some(thread) = &destination.thread_id {
            name("thread ID", thread)?;
        }
        let requested_execution = execution::normalize_request(input.requested_execution.as_ref())?;
        let delivery = (
            &input.tag_id,
            &input.session_id,
            &input.prompt,
            &destination.conversation_id,
            &destination.thread_id,
        );
        let digest_input = match &requested_execution {
            Some(selection) => serde_json::to_vec(&(delivery, selection.encode_to_vec()))?,
            None => serde_json::to_vec(&delivery)?,
        };
        let digest = format!("{:x}", Sha256::digest(digest_input));
        let (mut transaction, order) = self.write().await?;
        let prior = sqlx::query("SELECT request_digest, task_id FROM supertag_v2_inbound_events WHERE account_id = $1 AND event_id = $2")
            .bind(account).bind(&input.event_id).fetch_optional(&mut *transaction).await?;
        if let Some(prior) = prior {
            if prior.try_get::<String, _>("request_digest")? != digest {
                return Err(StoreError::Conflict(
                    "event ID was used with different content, routing, or execution".into(),
                ));
            }
            let task = task_in(&mut transaction, &prior.try_get::<String, _>("task_id")?).await?;
            transaction.commit().await?;
            return Ok(task);
        }
        crate::surface_policy::reject_generic_in(&mut transaction, account).await?;
        crate::objectives::objective_admission_in(
            &mut transaction,
            &input.tag_id,
            &input.session_id,
            self.execution_now_ms(),
        )
        .await?;
        let task = Box::pin(insert_task_options(
            &mut transaction,
            order,
            &input.tag_id,
            &input.session_id,
            &input.prompt,
            TaskAdmission {
                requested_execution: requested_execution.as_ref(),
                ..Default::default()
            },
        ))
        .await?;
        crate::objectives::objective_link_task_in(&mut transaction, &task).await?;
        sqlx::query("INSERT INTO supertag_v2_inbound_events (account_id, event_id, request_digest, task_id, conversation_id, thread_id) VALUES ($1,$2,$3,$4,$5,$6)")
            .bind(account).bind(&input.event_id).bind(digest).bind(&task.task_id).bind(&destination.conversation_id).bind(&destination.thread_id)
            .execute(&mut *transaction).await?;
        transaction.commit().await?;
        Ok(task)
    }

    pub async fn list_events(
        &self,
        task_id: &str,
        after_sequence: u64,
        limit: u32,
    ) -> Result<Vec<TaskEvent>> {
        self.get_task(task_id).await?;
        let after =
            i64::try_from(after_sequence).map_err(|_| invalid("event cursor is too large"))?;
        let limit = if limit == 0 { 32 } else { limit.min(32) } as i64;
        sqlx::query("SELECT sequence, text FROM supertag_v2_task_events WHERE task_id = $1 AND sequence > $2 ORDER BY sequence LIMIT $3")
            .bind(task_id).bind(after).bind(limit).fetch_all(&self.pool).await?.into_iter()
            .map(|row| Ok(TaskEvent { sequence: row.try_get::<i64, _>("sequence")? as u64, text: row.try_get("text")? })).collect()
    }
}

pub(crate) async fn insert_task(
    transaction: &mut Transaction<'_, Any>,
    order: i64,
    tag_id: &str,
    session_id: &str,
    prompt: &str,
) -> Result<Task> {
    insert_task_with_surface(transaction, order, tag_id, session_id, prompt, None).await
}

pub(crate) async fn insert_task_with_surface(
    transaction: &mut Transaction<'_, Any>,
    order: i64,
    tag_id: &str,
    session_id: &str,
    prompt: &str,
    surface: Option<&crate::surface_policy::AdmissionSurface>,
) -> Result<Task> {
    Box::pin(insert_task_options(
        transaction,
        order,
        tag_id,
        session_id,
        prompt,
        TaskAdmission {
            surface,
            ..Default::default()
        },
    ))
    .await
}

pub(crate) async fn insert_task_with_requirements(
    transaction: &mut Transaction<'_, Any>,
    order: i64,
    tag_id: &str,
    session_id: &str,
    prompt: &str,
    (execution_limits, output_policy): (
        Option<&ExecutionLimits>,
        Option<&supertag_protocol::v2::TaskOutputPolicy>,
    ),
) -> Result<Task> {
    Box::pin(insert_task_options(
        transaction,
        order,
        tag_id,
        session_id,
        prompt,
        TaskAdmission {
            execution_limits,
            output_policy,
            ..Default::default()
        },
    ))
    .await
}

pub(crate) async fn insert_owed_task(
    transaction: &mut Transaction<'_, Any>,
    order: i64,
    tag_id: &str,
    session_id: &str,
    prompt: &str,
) -> Result<Task> {
    Box::pin(insert_task_options(
        transaction,
        order,
        tag_id,
        session_id,
        prompt,
        TaskAdmission {
            owed: true,
            ..Default::default()
        },
    ))
    .await
}

#[derive(Default)]
struct TaskAdmission<'a> {
    surface: Option<&'a crate::surface_policy::AdmissionSurface>,
    execution_limits: Option<&'a ExecutionLimits>,
    output_policy: Option<&'a supertag_protocol::v2::TaskOutputPolicy>,
    requested_execution: Option<&'a ExecutionSelection>,
    owed: bool,
}

async fn insert_task_options(
    transaction: &mut Transaction<'_, Any>,
    order: i64,
    tag_id: &str,
    session_id: &str,
    prompt: &str,
    options: TaskAdmission<'_>,
) -> Result<Task> {
    let surface = options.surface;
    if crate::work_sessions::reserved_session(session_id) {
        return Err(invalid(
            "Work Session IDs are reserved for internal admission",
        ));
    }
    let objective = sqlx::query("SELECT o.objective_id,o.revision,o.runtime_actions FROM supertag_v2_objective_sessions s JOIN supertag_v2_objectives o ON o.objective_id=s.objective_id WHERE s.tag_id=$1 AND s.session_id=$2")
        .bind(tag_id)
        .bind(session_id)
        .fetch_optional(&mut **transaction)
        .await?;
    let objective_surface = surface.filter(|_| objective.is_some()).map(|surface| {
        crate::surface_policy::AdmissionSurface {
            origin: surface.origin.clone(),
            permission_set_ids: Vec::new(),
            context_set_ids: Vec::new(),
        }
    });
    let mut accepted =
        tag_policy_in(transaction, tag_id, objective_surface.as_ref().or(surface)).await?;
    if let Some(objective) = objective {
        let objective_id: String = objective.try_get("objective_id")?;
        crate::policy::apply_objective_runtime(
            &mut accepted.policy,
            &objective_id,
            objective.try_get::<i64, _>("revision")? as u64,
            serde_json::from_str(&objective.try_get::<String, _>("runtime_actions")?)?,
        )?;
    }
    crate::github_workspaces::refs::bind_in(
        transaction,
        tag_id,
        session_id,
        &mut accepted.workspace,
    )
    .await?;
    let harness = i64::from(accepted.policy.harness_kind);
    if options.output_policy.is_some()
        && (accepted.workspace.is_none()
            || !accepted
                .policy
                .allowed_actions
                .iter()
                .any(|action| action == "files:read"))
    {
        return Err(StoreError::FailedPrecondition(
            "declared Task outputs require a Workspace and accepted file read access".into(),
        ));
    }
    if let Some(previous) = sqlx::query("SELECT workspace_id,workspace_base_commit,workspace_github_source,workspace_mounts,workspace_mcp_servers,harness_kind,policy_snapshot FROM supertag_v2_tasks WHERE tag_id=$1 AND session_id=$2 ORDER BY accepted_order LIMIT 1")
        .bind(tag_id).bind(session_id).fetch_optional(&mut **transaction).await? {
        let prior_policy = previous.try_get::<Option<Vec<u8>>,_>("policy_snapshot")?.as_deref()
            .map(crate::policy::decode::<supertag_protocol::v2::TaskPolicySnapshot>).transpose()?;
        let prior_shared = supertag_protocol::shared_execution::environment(prior_policy.as_ref());
        let next_shared = supertag_protocol::shared_execution::environment(Some(&accepted.policy.snapshot));
        if crate::workspaces::workspace_from_row(&previous)? != accepted.workspace
            || previous.try_get::<i64,_>("harness_kind")? != harness || prior_shared != next_shared
        {
            return Err(StoreError::FailedPrecondition("workspace or harness changed; start a new Session".into()));
        }
    }
    let limits = crate::budget_pool::root_in(
        transaction,
        tag_id,
        session_id,
        options.execution_limits,
        options.owed,
    )
    .await?;
    let mut task = insert_accepted_task(
        transaction,
        order,
        tag_id,
        session_id,
        prompt,
        accepted,
        options.requested_execution,
    )
    .await?;
    crate::budget_pool::set_in(transaction, &mut task, limits).await?;
    if let Some(policy) = options.output_policy {
        sqlx::query("UPDATE supertag_v2_tasks SET output_policy=$1 WHERE task_id=$2")
            .bind(policy.encode_to_vec())
            .bind(&task.task_id)
            .execute(&mut **transaction)
            .await?;
        task.output_policy = Some(policy.clone());
        if task.encoded_len() > MAX_TASK_MESSAGE_BYTES {
            return Err(invalid("accepted Task exceeds the transport limit"));
        }
    }
    Ok(task)
}

struct AcceptedTag {
    revision: i64,
    workspace: Option<WorkspaceSpec>,
    policy: crate::policy::AdmissionPolicy,
}

impl AcceptedTag {
    fn validate_shared_execution(&self) -> Result<()> {
        if supertag_protocol::shared_execution::environment(Some(&self.policy.snapshot)).is_none() {
            return Ok(());
        }
        if self.workspace.is_some() {
            return Err(StoreError::FailedPrecondition(
                "shared execution cannot use a pinned Git Workspace".into(),
            ));
        }
        if self
            .policy
            .allowed_actions
            .iter()
            .any(|action| action == "commands:execute")
            && !self
                .policy
                .allowed_actions
                .iter()
                .any(|action| action == "files:write")
        {
            return Err(StoreError::FailedPrecondition(
                "shared execution commands require files:write".into(),
            ));
        }
        Ok(())
    }
}

async fn tag_policy_in(
    transaction: &mut Transaction<'_, Any>,
    tag_id: &str,
    surface: Option<&crate::surface_policy::AdmissionSurface>,
) -> Result<AcceptedTag> {
    let tag = sqlx::query("SELECT * FROM supertag_v2_tags WHERE tag_id = $1")
        .bind(tag_id)
        .fetch_optional(&mut **transaction)
        .await?
        .ok_or_else(|| StoreError::NotFound("Tag was not found".into()))?;
    crate::tags::ensure_active(&tag, tag_id)?;
    let mut workspace = crate::workspaces::workspace_from_row(&tag)?;
    let instructions: String = tag.try_get("instructions")?;
    let allowed_actions: Vec<String> =
        serde_json::from_str(&tag.try_get::<String, _>("allowed_actions")?)?;
    let approval_rules = approval_rules_from_row(&tag)?;
    let execution = tag_execution_from_row(&tag)?;
    let base_harness: i64 = tag.try_get("harness_kind")?;
    let policy = crate::policy::admission_in(
        transaction,
        tag_id,
        crate::policy::AdmissionBase {
            instructions: &instructions,
            allowed_actions: &allowed_actions,
            harness_kind: base_harness as i32,
            execution: execution.as_ref(),
            approval_rules: &approval_rules,
        },
        surface,
    )
    .await?;
    crate::github_workspaces::admission_in(transaction, &mut workspace, &policy.snapshot).await?;
    crate::workspace_mounts::admission_in(
        transaction,
        &mut workspace,
        &policy.allowed_actions,
        policy.harness_kind,
    )
    .await?;
    let accepted = AcceptedTag {
        revision: tag.try_get("revision")?,
        workspace,
        policy,
    };
    accepted.validate_shared_execution()?;
    Ok(accepted)
}

pub(crate) fn tag_execution_from_row(row: &AnyRow) -> Result<Option<PolicyExecutionSettings>> {
    row.try_get::<Option<Vec<u8>>, _>("execution")?
        .as_deref()
        .map(crate::policy::decode)
        .transpose()
}

/// The runtime actions a verified surface origin would grant this Tag's turn.
pub(crate) async fn surface_runtime_actions_in(
    transaction: &mut Transaction<'_, Any>,
    tag_id: &str,
    surface: Option<&crate::surface_policy::AdmissionSurface>,
) -> Result<Vec<String>> {
    let tag = tag_policy_in(transaction, tag_id, surface).await?;
    Ok(tag
        .policy
        .snapshot
        .runtime_authority
        .unwrap_or_default()
        .actions)
}

pub(crate) async fn owner_runtime_actions_in(
    transaction: &mut Transaction<'_, Any>,
    tag_id: &str,
) -> Result<Vec<String>> {
    let tag = tag_policy_in(transaction, tag_id, None).await?;
    Ok(tag
        .policy
        .snapshot
        .runtime_authority
        .unwrap_or_default()
        .actions)
}

/// Resolve current authority for an approval-driven child continuation without
/// inserting a Task. The original surface must still exist and accept this Tag.
pub(crate) async fn current_work_policy_in(
    tx: &mut Transaction<'_, Any>,
    source: &Task,
    starter: &Task,
    objective: Option<&str>,
) -> Result<Task> {
    use supertag_protocol::v2::{SurfaceAccount, SurfaceLocation, SurfacePolicyOrigin};
    let mut surface = None;
    if let Some(origin) = source
        .policy_snapshot
        .as_ref()
        .and_then(|s| s.origin.as_ref())
    {
        let row=sqlx::query("SELECT l.payload AS location,a.payload AS account FROM supertag_v2_surface_locations l JOIN supertag_v2_surface_accounts a ON a.account_id=l.account_id WHERE l.location_id=$1")
            .bind(&origin.location_id).fetch_optional(&mut **tx).await?.ok_or(StoreError::PermissionDenied)?;
        let location: SurfaceLocation =
            crate::policy::decode(&row.try_get::<Vec<u8>, _>("location")?)?;
        let account: SurfaceAccount =
            crate::policy::decode(&row.try_get::<Vec<u8>, _>("account")?)?;
        if !account.enabled
            || !location.enabled
            || location.tag_id != source.tag_id
            || location.account_id != origin.account_id
            || location.scope != origin.scope
        {
            return Err(StoreError::PermissionDenied);
        }
        surface = Some(crate::surface_policy::AdmissionSurface {
            origin: SurfacePolicyOrigin {
                location_id: location.location_id,
                location_revision: location.revision,
                account_id: location.account_id,
                connector_account_id: location.connector_account_id,
                scope: location.scope,
                origin_actions: origin.origin_actions.clone(),
            },
            permission_set_ids: if objective.is_some() {
                vec![]
            } else {
                location.permission_set_ids
            },
            context_set_ids: if objective.is_some() {
                vec![]
            } else {
                location.context_set_ids
            },
        });
    }
    if source.tag_id != starter.tag_id {
        let id = objective.ok_or(StoreError::PermissionDenied)?;
        let eligible:i64=sqlx::query_scalar("SELECT COUNT(*) FROM supertag_v2_objectives o JOIN supertag_v2_team_members m ON m.team_id=o.team_id AND m.tag_id=$2 WHERE o.objective_id=$1 AND EXISTS (SELECT 1 FROM supertag_v2_hosts h WHERE h.generation>0 AND h.revoked_at_ms IS NULL AND (h.all_tags=1 OR EXISTS (SELECT 1 FROM supertag_v2_host_tags scope WHERE scope.host_id=h.host_id AND scope.tag_id=$2)))")
            .bind(id).bind(&source.tag_id).fetch_one(&mut **tx).await?;
        if eligible == 0 {
            return Err(StoreError::PermissionDenied);
        }
    }
    let mut accepted = tag_policy_in(tx, &source.tag_id, surface.as_ref()).await?;
    crate::artifact_context::inherit(source, &mut accepted.policy)?;
    if let Some(id) = objective {
        let row = sqlx::query(
            "SELECT revision,runtime_actions FROM supertag_v2_objectives WHERE objective_id=$1",
        )
        .bind(id)
        .fetch_one(&mut **tx)
        .await?;
        let actions = serde_json::from_str(&row.try_get::<String, _>("runtime_actions")?)?;
        if source.tag_id == starter.tag_id {
            crate::policy::apply_objective_runtime(
                &mut accepted.policy,
                id,
                row.try_get::<i64, _>("revision")? as u64,
                actions,
            )?;
        } else {
            crate::policy::apply_delegated_runtime(
                &mut accepted.policy,
                starter,
                id,
                row.try_get::<i64, _>("revision")? as u64,
                &actions,
            )?;
            accepted.workspace = starter.workspace.clone();
        }
    }
    crate::github_workspaces::refs::inherit(&mut accepted.workspace, &source.workspace);
    accepted.validate_shared_execution()?;
    let mut result = source.clone();
    result.instructions = accepted.policy.instructions;
    result.allowed_actions = accepted.policy.allowed_actions;
    result.approval_rules = accepted.policy.approval_rules;
    result.harness_kind = accepted.policy.harness_kind;
    result.policy_snapshot = Some(accepted.policy.snapshot);
    result.workspace = accepted.workspace;
    result.tag_revision = accepted.revision as u64;
    Ok(result)
}

pub(crate) async fn insert_delegated_task_in(
    transaction: &mut Transaction<'_, Any>,
    order: i64,
    parent: &Task,
    objective_id: &str,
    tag_id: &str,
    session_id: &str,
    prompt: &str,
) -> Result<Task> {
    let objective = sqlx::query(
        "SELECT revision,runtime_actions FROM supertag_v2_objectives WHERE objective_id=$1",
    )
    .bind(objective_id)
    .fetch_one(&mut **transaction)
    .await?;
    let objective_actions: Vec<String> =
        serde_json::from_str(&objective.try_get::<String, _>("runtime_actions")?)?;
    let mut accepted = tag_policy_in(transaction, tag_id, None).await?;
    accepted.workspace = parent.workspace.clone();
    crate::policy::apply_delegated_runtime(
        &mut accepted.policy,
        parent,
        objective_id,
        objective.try_get::<i64, _>("revision")? as u64,
        &objective_actions,
    )?;
    insert_accepted_task(
        transaction,
        order,
        tag_id,
        session_id,
        prompt,
        accepted,
        None,
    )
    .await
}

async fn insert_accepted_task(
    transaction: &mut Transaction<'_, Any>,
    order: i64,
    tag_id: &str,
    session_id: &str,
    prompt: &str,
    accepted: AcceptedTag,
    requested_execution: Option<&ExecutionSelection>,
) -> Result<Task> {
    text("Task prompt", prompt, MAX_TASK_PROMPT_BYTES)?;
    accepted.validate_shared_execution()?;
    let AcceptedTag {
        revision,
        workspace,
        policy,
    } = accepted;
    let selection = execution::select(&policy.snapshot, requested_execution)?;
    let id = Uuid::new_v4().to_string();
    sqlx::query("INSERT INTO supertag_v2_tasks (task_id, tag_id, session_id, prompt, instructions, allowed_actions, tag_revision, state, accepted_order, workspace_id, workspace_base_commit,harness_kind,approval_rules,policy_snapshot,policy_effective_digest,execution_selection,workspace_github_source,workspace_mounts,workspace_mcp_servers) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)")
        .bind(&id).bind(tag_id).bind(session_id).bind(prompt)
        .bind(policy.instructions).bind(serde_json::to_string(&policy.allowed_actions)?)
        .bind(revision).bind(TaskState::Queued as i64).bind(order)
        .bind(workspace.as_ref().map(|spec| &spec.workspace_id))
        .bind(workspace.as_ref().map(|spec| &spec.base_commit))
        .bind(i64::from(policy.harness_kind))
        .bind(stored_approval_rules(&policy.approval_rules)?)
        .bind(policy.snapshot.encode_to_vec())
        .bind(policy.effective_digest)
        .bind(selection.encode_to_vec())
        .bind(workspace.as_ref().and_then(|spec| spec.github_source.as_ref()).map(Message::encode_to_vec).unwrap_or_default())
        .bind(crate::workspace_mounts::encode(workspace.as_ref()))
        .bind(crate::workspaces::encode_mcp_servers(workspace.as_ref()))
        .execute(&mut **transaction).await?;
    bounded_task_in(transaction, &id).await
}

pub(crate) async fn insert_task_from_snapshot(
    transaction: &mut Transaction<'_, Any>,
    order: i64,
    source: &Task,
    session_id: &str,
    prompt: &str,
) -> Result<Task> {
    crate::tags::require_active(transaction, &source.tag_id).await?;
    text("Task prompt", prompt, MAX_TASK_PROMPT_BYTES)?;
    let id = Uuid::new_v4().to_string();
    sqlx::query(
        "INSERT INTO supertag_v2_tasks
           (task_id,tag_id,session_id,prompt,instructions,allowed_actions,tag_revision,state,accepted_order,
            workspace_id,workspace_base_commit,harness_kind,approval_rules,policy_snapshot,policy_effective_digest,execution_limits,execution_selection,workspace_github_source,workspace_mounts,workspace_mcp_servers)
         SELECT $1, tag_id, $2, $3, instructions, allowed_actions, tag_revision, $4, $5,
                workspace_id, workspace_base_commit, harness_kind, approval_rules, policy_snapshot, policy_effective_digest,execution_limits,execution_selection,workspace_github_source,workspace_mounts,workspace_mcp_servers
         FROM supertag_v2_tasks WHERE task_id=$6",
    )
    .bind(&id).bind(session_id).bind(prompt).bind(TaskState::Queued as i64).bind(order)
    .bind(&source.task_id).execute(&mut **transaction).await?;
    sqlx::query("INSERT INTO supertag_v2_artifact_context_grants(task_id,artifact_id) SELECT $1,artifact_id FROM supertag_v2_artifact_context_grants WHERE task_id=$2").bind(&id).bind(&source.task_id).execute(&mut **transaction).await?;
    bounded_task_in(transaction, &id).await
}

pub(crate) async fn preserve_execution_in(
    transaction: &mut Transaction<'_, Any>,
    task: &mut Task,
    source: &Task,
) -> Result<()> {
    if let Some(selection) = &source.execution_selection
        && task.execution_selection.as_ref() != Some(selection)
    {
        sqlx::query("UPDATE supertag_v2_tasks SET execution_selection=$1 WHERE task_id=$2")
            .bind(selection.encode_to_vec())
            .bind(&task.task_id)
            .execute(&mut **transaction)
            .await?;
        task.execution_selection = Some(selection.clone());
    }
    Ok(())
}

pub(crate) async fn next_order(transaction: &mut Transaction<'_, Any>) -> Result<i64> {
    let order = increment_order(transaction).await?;
    // An audited operator call records its entries in each transaction that can change state, so
    // an entry commits exactly when the change it describes does.
    crate::audit::record_call_in(transaction).await?;
    Ok(order)
}

/// Takes the next write order without recording anything else.
pub(crate) async fn increment_order(transaction: &mut Transaction<'_, Any>) -> Result<i64> {
    Ok(sqlx::query_scalar("UPDATE supertag_v2_write_order SET revision = revision + 1 WHERE singleton = 1 RETURNING revision")
        .fetch_one(&mut **transaction).await?)
}

async fn bounded_task_in(transaction: &mut Transaction<'_, Any>, id: &str) -> Result<Task> {
    let task = task_in(transaction, id).await?;
    if task.encoded_len() > MAX_TASK_MESSAGE_BYTES {
        return Err(invalid(
            "accepted Task policy and prompt exceed the transport limit",
        ));
    }
    Ok(task)
}

pub(crate) async fn enqueue_reply(
    transaction: &mut Transaction<'_, Any>,
    task: &Task,
    order: i64,
) -> Result<()> {
    let mut route = sqlx::query("SELECT account_id, conversation_id, thread_id FROM supertag_v2_inbound_events WHERE task_id = $1")
        .bind(&task.task_id).fetch_optional(&mut **transaction).await?;
    if route.is_none() {
        // An Objective started from a surface thread answers there from its own Session.
        route = sqlx::query("SELECT home.account_id, home.conversation_id, home.thread_id FROM supertag_v2_surface_objectives home JOIN supertag_v2_objectives o ON o.objective_id=home.objective_id WHERE o.owner_tag_id=$1 AND o.session_id=$2")
            .bind(&task.tag_id).bind(&task.session_id).fetch_optional(&mut **transaction).await?;
    }
    let Some(route) = route else {
        return Ok(());
    };
    let result = task
        .result
        .as_deref()
        .ok_or_else(|| StoreError::FailedPrecondition("succeeded Task has no result".into()))?;
    sqlx::query("INSERT INTO supertag_v2_replies (reply_id, task_id, account_id, conversation_id, thread_id, text, state, ready_order) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(task_id) DO NOTHING")
        .bind(Uuid::new_v4().to_string()).bind(&task.task_id).bind(route.try_get::<String, _>("account_id")?)
        .bind(route.try_get::<String, _>("conversation_id")?).bind(route.try_get::<Option<String>, _>("thread_id")?)
        .bind(result).bind(ReplyState::Pending as i64).bind(order).execute(&mut **transaction).await?;
    Ok(())
}

pub(crate) fn connector_account(principal: &str) -> Result<&str> {
    name("principal", principal)?;
    let account = principal
        .strip_prefix("connector:")
        .ok_or(StoreError::PermissionDenied)?;
    name("connector account", account)?;
    Ok(account)
}

pub(crate) async fn reply_in(
    transaction: &mut Transaction<'_, Any>,
    account: &str,
    reply_id: &str,
) -> Result<AnyRow> {
    sqlx::query("SELECT * FROM supertag_v2_replies WHERE reply_id = $1 AND account_id = $2")
        .bind(reply_id)
        .bind(account)
        .fetch_optional(&mut **transaction)
        .await?
        .ok_or_else(|| StoreError::NotFound("reply was not found".into()))
}

pub(crate) fn reply_row(row: &AnyRow) -> Result<Reply> {
    Ok(Reply {
        reply_id: row.try_get("reply_id")?,
        task_id: row.try_get("task_id")?,
        account_id: row.try_get("account_id")?,
        destination: Some(ReplyDestination {
            conversation_id: row.try_get("conversation_id")?,
            thread_id: row.try_get("thread_id")?,
        }),
        text: row.try_get("text")?,
        state: row.try_get::<i64, _>("state")? as i32,
        provider_receipt: row.try_get("provider_receipt")?,
        ..Default::default()
    })
}

pub(crate) async fn task_in(transaction: &mut Transaction<'_, Any>, id: &str) -> Result<Task> {
    let row = sqlx::query("SELECT * FROM supertag_v2_tasks WHERE task_id = $1")
        .bind(id)
        .fetch_optional(&mut **transaction)
        .await?
        .ok_or_else(|| StoreError::NotFound("Task was not found".into()))?;
    task_row(&row)
}

pub(crate) async fn owned(
    transaction: &mut Transaction<'_, Any>,
    host: &HostAuthority,
    task_id: &str,
    attempt_id: &str,
    lease_token: &str,
) -> Result<AnyRow> {
    name("Task ID", task_id)?;
    name("Task Attempt ID", attempt_id)?;
    name("lease token", lease_token)?;
    hosts::current_scope_in(transaction, host).await?;
    let row = sqlx::query("SELECT * FROM supertag_v2_tasks WHERE task_id = $1")
        .bind(task_id)
        .fetch_optional(&mut **transaction)
        .await?
        .ok_or_else(|| StoreError::NotFound("Task was not found".into()))?;
    if row
        .try_get::<Option<String>, _>("host_principal")?
        .as_deref()
        != Some(host.principal.as_str())
        || row.try_get::<Option<i64>, _>("host_generation")? != Some(host.generation)
        || row.try_get::<Option<String>, _>("attempt_id")?.as_deref() != Some(attempt_id)
        || row.try_get::<Option<String>, _>("lease_token")?.as_deref() != Some(lease_token)
    {
        return Err(StoreError::PermissionDenied);
    }
    Ok(row)
}

pub(crate) fn read_host_profile(
    bytes: Option<Vec<u8>>,
) -> Result<Option<supertag_protocol::v2::HarnessExecutionProfile>> {
    execution::read_profile(bytes)
}

pub(crate) fn task_row(row: &AnyRow) -> Result<Task> {
    let policy_snapshot = crate::policy::snapshot_from_row(row)?;
    let stored_selection = row.try_get::<Option<Vec<u8>>, _>("execution_selection")?;
    let execution_selection = Some(
        stored_selection
            .as_deref()
            .map(crate::policy::decode)
            .transpose()?
            .unwrap_or_else(|| execution::accepted(policy_snapshot.as_ref())),
    );
    let attempt_id: Option<String> = row.try_get("attempt_id")?;
    let attempt_execution = if attempt_id.is_some() {
        execution::read_attempt(row.try_get("attempt_execution")?)?
    } else {
        None
    };
    Ok(Task {
        execution_limits: crate::budget_pool::from_row(row)?,
        task_id: row.try_get("task_id")?,
        tag_id: row.try_get("tag_id")?,
        session_id: row.try_get("session_id")?,
        prompt: row.try_get("prompt")?,
        instructions: row.try_get("instructions")?,
        allowed_actions: serde_json::from_str(&row.try_get::<String, _>("allowed_actions")?)?,
        tag_revision: row.try_get::<i64, _>("tag_revision")? as u64,
        state: row.try_get::<i64, _>("state")? as i32,
        result: row.try_get("result")?,
        attempt_id,
        workspace: crate::workspaces::workspace_from_row(row)?,
        workspace_delivery: crate::workspaces::delivery_from_row(row)?,
        harness_kind: row.try_get::<i64, _>("harness_kind")? as i32,
        approval_rules: approval_rules_from_row(row)?,
        policy_snapshot,
        execution_selection,
        attempt_execution,
        artifacts: crate::artifact_captures::submitted_from_row(row)?,
        output_policy: output_policy_from_row(row)?,
        input_artifacts: crate::task_artifact_inputs::from_row(row)?,
    })
}

fn output_policy_from_row(row: &AnyRow) -> Result<Option<supertag_protocol::v2::TaskOutputPolicy>> {
    row.try_get::<Option<Vec<u8>>, _>("output_policy")?
        .as_deref()
        .map(crate::policy::decode)
        .transpose()
}

pub(crate) fn output_policy_digest(
    digest: String,
    policy: Option<&supertag_protocol::v2::TaskOutputPolicy>,
) -> Result<String> {
    let Some(policy) = policy else {
        return Ok(digest);
    };
    Ok(format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&(
            digest,
            "task-output-policy",
            policy.encode_to_vec(),
        ))?)
    ))
}

pub(crate) const WORKSTREAM_POST_ACTION: &str = "workstream:post";
pub(crate) const MAILBOX_SEND_ACTION: &str = "mailbox:send";

#[derive(serde::Serialize, serde::Deserialize)]
struct StoredApprovalRule {
    action: String,
    operator_ids: Vec<String>,
}

fn stored_approval_rules(rules: &[ApprovalRule]) -> Result<String> {
    Ok(serde_json::to_string(
        &rules
            .iter()
            .map(|rule| StoredApprovalRule {
                action: rule.action.clone(),
                operator_ids: rule.operator_ids.clone(),
            })
            .collect::<Vec<_>>(),
    )?)
}

pub(crate) fn approval_rules_from_row(row: &AnyRow) -> Result<Vec<ApprovalRule>> {
    let stored: Vec<StoredApprovalRule> =
        serde_json::from_str(&row.try_get::<String, _>("approval_rules")?)?;
    Ok(stored
        .into_iter()
        .map(|rule| ApprovalRule {
            action: rule.action,
            operator_ids: rule.operator_ids,
        })
        .collect())
}

fn normalize_approval_rules(
    rules: Vec<ApprovalRule>,
    allowed: &[String],
) -> Result<Vec<ApprovalRule>> {
    let mut normalized = BTreeMap::new();
    for rule in rules {
        if !matches!(
            rule.action.as_str(),
            WORKSTREAM_POST_ACTION | MAILBOX_SEND_ACTION
        ) || !allowed.contains(&rule.action)
        {
            return Err(invalid(
                "approval rules require an allowed workstream:post or mailbox:send action",
            ));
        }
        let mut operators = rule.operator_ids;
        if operators.len() > 64 {
            return Err(invalid("too many approval operators"));
        }
        for operator in &operators {
            name("approval operator ID", operator)?;
            if operator.len() > 247
                || operator.starts_with("operator:")
                || operator.trim() != operator
            {
                return Err(invalid("use the operator ID without the operator: prefix"));
            }
        }
        operators.sort();
        operators.dedup();
        if normalized.insert(rule.action, operators).is_some() {
            return Err(invalid("duplicate approval rule"));
        }
    }
    Ok(normalized
        .into_iter()
        .map(|(action, operator_ids)| ApprovalRule {
            action,
            operator_ids,
        })
        .collect())
}

pub(crate) fn invalid(message: &str) -> StoreError {
    StoreError::InvalidArgument(message.into())
}

pub(crate) fn name(kind: &str, value: &str) -> Result<()> {
    if value.is_empty() || value.len() > 256 || value.chars().any(char::is_control) {
        return Err(invalid(&format!(
            "{kind} must contain 1–256 bytes without control characters"
        )));
    }
    Ok(())
}

pub(crate) fn text(kind: &str, value: &str, maximum: usize) -> Result<()> {
    if value.len() > maximum {
        return Err(invalid(&format!("{kind} exceeds its size limit")));
    }
    Ok(())
}
