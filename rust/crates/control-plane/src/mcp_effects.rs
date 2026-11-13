use std::collections::BTreeSet;

use serde_json::Value;
use sha2::{Digest, Sha256};
use sqlx::Row;
use supertag_protocol::{MAX_MESSAGE_BYTES, mcp, v2::*, valid_sha256};
use tonic::{Request, Response, Status};
use uuid::Uuid;

use crate::{
    ControlPlane, HostAuthority, Store, StoreError, approvals,
    store::{Result, invalid, lease_is_live, name, owned, task_row},
};

const RESERVED: i64 = 1;
const CONFIRMED: i64 = 2;
const UNCONFIRMED: i64 = 3;

fn identity(value: &impl serde::Serialize) -> Result<String> {
    Ok(format!("{:x}", Sha256::digest(serde_json::to_vec(value)?)))
}

fn owned_attempt(attempt: &Option<InspectAttemptRequest>) -> Result<&InspectAttemptRequest> {
    attempt
        .as_ref()
        .ok_or_else(|| invalid("Attempt identity is required"))
}

impl Store {
    pub async fn reserve_mcp_effect(
        &self,
        host: &HostAuthority,
        input: &ReserveMcpEffectRequest,
    ) -> Result<ReserveMcpEffectResponse> {
        let attempt = owned_attempt(&input.attempt)?;
        name("MCP operation ID", &input.operation_id)?;
        if !mcp::server_name(&input.server)
            || !mcp::tool_name(&input.tool)
            || !valid_sha256(&input.provider_binding)
            || !valid_sha256(&input.tool_schema_sha256)
            || input.arguments_json.len() > mcp::MAX_ARGUMENT_BYTES
        {
            return Err(invalid("invalid MCP dispatch identity or arguments"));
        }
        let arguments = approvals::canonical_arguments(&input.arguments_json)?;
        let parsed: Value = serde_json::from_str(&arguments)?;
        let (mut tx, order) = self.write().await?;
        let now = self.execution_now_ms();
        let owned = owned(
            &mut tx,
            host,
            &attempt.task_id,
            &attempt.attempt_id,
            &attempt.lease_token,
        )
        .await?;
        let task = task_row(&owned)?;
        let claude = task
            .attempt_execution
            .as_ref()
            .filter(|execution| execution.harness_kind() == HarnessKind::ClaudeCode)
            .ok_or(StoreError::PermissionDenied)?;
        // A Workspace server is the one this Attempt recorded before it started; the host
        // catalog cannot supply a server of the same name for this Task.
        let recorded = if mcp::workspace_servers(&task).contains(input.server.as_str()) {
            workspace_record_in(&mut tx, &attempt.task_id, &attempt.attempt_id)
                .await?
                .ok_or(StoreError::PermissionDenied)?
                .servers
        } else {
            claude.mcp_servers.clone()
        };
        let server = recorded
            .iter()
            .find(|server| server.name == input.server)
            .filter(|server| server.provider_binding.as_deref() == Some(&input.provider_binding))
            .ok_or(StoreError::PermissionDenied)?;
        let rules = server
            .resource_bindings
            .iter()
            .find(|entry| entry.tool == input.tool)
            .map(|entry| entry.rules.as_slice())
            .unwrap_or_default();
        let authority = mcp::authorize(&task, &input.server, &input.tool, rules, &parsed)
            .map_err(|_| StoreError::PermissionDenied)?;
        let requires_approval = !authority.gates.is_empty();
        let requirements: BTreeSet<_> = authority
            .gates
            .iter()
            .map(|(set, grant)| (&set.set_id, &set.approvers, &grant.action, &grant.resource))
            .collect();
        let approvers: BTreeSet<_> = authority
            .gates
            .iter()
            .flat_map(|(set, _)| &set.approvers)
            .collect();
        let operators: Vec<_> = approvers
            .iter()
            .filter_map(|id| id.strip_prefix("operator:").map(str::to_owned))
            .collect();
        if !approvers.is_empty() && operators.is_empty() {
            return Err(StoreError::PermissionDenied);
        }
        let action = format!("mcp:{}/{}", input.server, input.tool);
        let resource = authority.resource.unwrap_or_default();
        let binding = identity(&(
            "mcp-effect-v1",
            &input.provider_binding,
            &input.tool_schema_sha256,
            &requirements,
        ))?;
        let effect_digest = identity(&(
            &task.tag_id,
            &task.session_id,
            &action,
            &resource,
            &arguments,
            &binding,
        ))?;
        // Drift may require fresh approval, but it does not prove an earlier
        // call of these exact arguments had no external effect.
        let uncertainty_digest = identity(&(&task.tag_id, &task.session_id, &action, &arguments))?;
        if let Some(prior) = sqlx::query("SELECT effect_digest,approval_id,state,result_json FROM supertag_v2_mcp_effects WHERE attempt_id=$1 AND operation_id=$2")
            .bind(&attempt.attempt_id).bind(&input.operation_id).fetch_optional(&mut *tx).await? {
            if prior.try_get::<String,_>("effect_digest")? != effect_digest {
                return Err(StoreError::Conflict("MCP operation used different effect identity".into()));
            }
            let approval = approvals::load_in(&mut tx, &prior.try_get::<String,_>("approval_id")?).await?;
            return Ok(ReserveMcpEffectResponse {
                approval: Some(approval),
                result_json: prior.try_get("result_json")?,
                unconfirmed: prior.try_get::<i64,_>("state")? != CONFIRMED,
                ..Default::default()
            });
        }
        if task.state() != TaskState::Running || !lease_is_live(&owned, now)? {
            return Err(StoreError::FailedPrecondition(
                "MCP dispatch requires a live running Attempt".into(),
            ));
        }
        if let Some(id) = sqlx::query_scalar::<_, String>("SELECT approval_id FROM supertag_v2_mcp_effects WHERE uncertainty_digest=$1 AND state IN (1,3) ORDER BY reserved_at_ms LIMIT 1")
            .bind(&uncertainty_digest).fetch_optional(&mut *tx).await? {
            let approval = approvals::load_in(&mut tx, &id).await?;
            return Ok(ReserveMcpEffectResponse { approval: Some(approval), unconfirmed: true, ..Default::default() });
        }
        if !requires_approval {
            let pending: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM supertag_v2_approval_operations WHERE attempt_id=$1 AND operation_id=$2")
                .bind(&attempt.attempt_id).bind(&input.operation_id).fetch_one(&mut *tx).await?;
            if pending != 0 {
                return Err(StoreError::Conflict(
                    "MCP operation used different effect identity".into(),
                ));
            }
            let valid_for_ms = (owned
                .try_get::<i64, _>("lease_expires_at_ms")?
                .saturating_sub(now)
                .clamp(0, 12_000)) as u64;
            return Ok(ReserveMcpEffectResponse {
                ungated: true,
                dispatch_valid_for_ms: valid_for_ms,
                canonical_arguments_json: Some(arguments),
                ..Default::default()
            });
        }
        let request = RequestApprovalRequest {
            attempt: Some(attempt.clone()),
            operation_id: input.operation_id.clone(),
            summary: format!("MCP {} / {}", input.server, input.tool),
            action,
            resource,
            arguments_json: arguments,
        };
        let gate = approvals::gate_effect_in(
            &mut tx,
            &request,
            &owned,
            operators,
            Some(&binding),
            now,
            order,
        )
        .await?;
        let approval = gate.approval.ok_or(StoreError::PermissionDenied)?;
        if approval.state() == ApprovalState::Pending {
            let questions: i64 = sqlx::query_scalar(
                "SELECT (SELECT COUNT(*) FROM supertag_v2_objective_questions WHERE attempt_id=$1)+(SELECT COUNT(*) FROM supertag_v2_work_session_questions WHERE attempt_id=$1)",
            ).bind(&attempt.attempt_id).fetch_one(&mut *tx).await?;
            if questions > 0 {
                return Err(StoreError::FailedPrecondition(
                    "an Attempt cannot wait for both a question and MCP approval".into(),
                ));
            }
        }
        let mut dispatch_valid_for_ms = 0;
        let dispatch_id = if gate.granted {
            let lease: i64 = owned.try_get("lease_expires_at_ms")?;
            let deadline = lease.min(approval.valid_until_ms.unwrap_or(i64::MAX));
            dispatch_valid_for_ms = (deadline.saturating_sub(now).clamp(0, 12_000)) as u64;
            if dispatch_valid_for_ms == 0 {
                return Err(StoreError::FailedPrecondition(
                    "MCP dispatch authority ended".into(),
                ));
            }
            let id = Uuid::new_v4().to_string();
            sqlx::query("INSERT INTO supertag_v2_mcp_effects(attempt_id,operation_id,task_id,approval_id,effect_digest,uncertainty_digest,dispatch_id,state,reserved_at_ms) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)")
                .bind(&attempt.attempt_id).bind(&input.operation_id).bind(&attempt.task_id)
                .bind(&approval.approval_id).bind(effect_digest).bind(uncertainty_digest).bind(&id).bind(RESERVED).bind(now)
                .execute(&mut *tx).await?;
            Some(id)
        } else {
            None
        };
        tx.commit().await?;
        let canonical_arguments_json = dispatch_id.as_ref().map(|_| request.arguments_json);
        Ok(ReserveMcpEffectResponse {
            approval: Some(approval),
            dispatch_id,
            dispatch_valid_for_ms,
            canonical_arguments_json,
            ..Default::default()
        })
    }

    pub async fn settle_mcp_effect(
        &self,
        host: &HostAuthority,
        input: &SettleMcpEffectRequest,
    ) -> Result<()> {
        let attempt = owned_attempt(&input.attempt)?;
        name("MCP operation ID", &input.operation_id)?;
        name("MCP dispatch ID", &input.dispatch_id)?;
        if let Some(result) = &input.result_json {
            if result.len() > mcp::MAX_RESULT_BYTES {
                return Err(invalid("MCP result exceeds its bound"));
            }
            let value: Value =
                serde_json::from_str(result).map_err(|_| invalid("invalid MCP result"))?;
            if !value.get("content").is_some_and(Value::is_array)
                || value
                    .get("isError")
                    .is_some_and(|value| !value.is_boolean())
                || value
                    .get("structuredContent")
                    .is_some_and(|value| !value.is_object())
            {
                return Err(invalid("invalid MCP result"));
            }
        }
        let (mut tx, _) = self.write().await?;
        owned(
            &mut tx,
            host,
            &attempt.task_id,
            &attempt.attempt_id,
            &attempt.lease_token,
        )
        .await?;
        let prior = sqlx::query("SELECT state,result_json,dispatch_id FROM supertag_v2_mcp_effects WHERE attempt_id=$1 AND operation_id=$2 AND task_id=$3")
            .bind(&attempt.attempt_id).bind(&input.operation_id).bind(&attempt.task_id)
            .fetch_optional(&mut *tx).await?.ok_or(StoreError::PermissionDenied)?;
        if prior.try_get::<String, _>("dispatch_id")? != input.dispatch_id {
            return Err(StoreError::PermissionDenied);
        }
        let state: i64 = prior.try_get("state")?;
        if state != RESERVED {
            if prior.try_get::<Option<String>, _>("result_json")? != input.result_json {
                return Err(StoreError::Conflict(
                    "MCP dispatch already settled with different evidence".into(),
                ));
            }
            return Ok(());
        }
        let state = if input.result_json.is_some() {
            CONFIRMED
        } else {
            UNCONFIRMED
        };
        sqlx::query("UPDATE supertag_v2_mcp_effects SET state=$1,result_json=$2,settled_at_ms=$3 WHERE dispatch_id=$4")
            .bind(state).bind(&input.result_json).bind(self.execution_now_ms()).bind(&input.dispatch_id)
            .execute(&mut *tx).await?;
        tx.commit().await?;
        Ok(())
    }
}

async fn workspace_record_in(
    tx: &mut sqlx::Transaction<'_, sqlx::Any>,
    task_id: &str,
    attempt_id: &str,
) -> Result<Option<WorkspaceMcpRecord>> {
    let record: Option<Vec<u8>> = sqlx::query_scalar(
        "SELECT record FROM supertag_v2_workspace_mcp_attempts WHERE task_id=$1 AND attempt_id=$2",
    )
    .bind(task_id)
    .bind(attempt_id)
    .fetch_optional(&mut **tx)
    .await?;
    record
        .map(|bytes| crate::policy::decode::<WorkspaceMcpRecord>(&bytes))
        .transpose()
}

fn valid_workspace_digest(digest: &str) -> bool {
    digest.strip_prefix("sha256:").is_some_and(|hex| {
        hex.len() == 64 && hex.bytes().all(|c| matches!(c, b'0'..=b'9' | b'a'..=b'f'))
    })
}

impl Store {
    /// Records the Workspace MCP servers one Attempt resolved, before any of them starts. The
    /// first recorded digest of a Task binds every later Attempt: a retry whose selected
    /// `.mcp.json` entries differ is refused, so the Worker Host starts none of them.
    pub async fn record_workspace_mcp(
        &self,
        host: &HostAuthority,
        input: &RecordWorkspaceMcpRequest,
    ) -> Result<()> {
        let attempt = owned_attempt(&input.attempt)?;
        let mut record = input
            .record
            .clone()
            .ok_or_else(|| invalid("Workspace MCP record is required"))?;
        if !valid_workspace_digest(&record.digest)
            || !mcp::normalize_capabilities(&mut record.servers)
            || record.servers.iter().any(|server| {
                server.provider_binding.is_none()
                    || !server.mapped_tools.is_empty()
                    || !server.resource_bindings.is_empty()
            })
        {
            return Err(invalid("invalid Workspace MCP record"));
        }
        let (mut tx, _) = self.write().await?;
        let now = self.execution_now_ms();
        let owned = owned(
            &mut tx,
            host,
            &attempt.task_id,
            &attempt.attempt_id,
            &attempt.lease_token,
        )
        .await?;
        let task = task_row(&owned)?;
        if task.state() != TaskState::Running || !lease_is_live(&owned, now)? {
            return Err(StoreError::FailedPrecondition(
                "Workspace MCP servers are recorded by a live running Attempt".into(),
            ));
        }
        let selected = mcp::workspace_servers(&task);
        if task
            .attempt_execution
            .as_ref()
            .is_none_or(|execution| execution.harness_kind() != HarnessKind::ClaudeCode)
            || selected.is_empty()
            || !record
                .servers
                .iter()
                .map(|server| server.name.as_str())
                .eq(selected.iter().copied())
        {
            return Err(StoreError::PermissionDenied);
        }
        if let Some(prior) =
            workspace_record_in(&mut tx, &attempt.task_id, &attempt.attempt_id).await?
        {
            if prior != record {
                return Err(StoreError::Conflict(
                    "this Attempt already recorded different Workspace MCP servers".into(),
                ));
            }
            return Ok(());
        }
        let pinned: Option<String> = sqlx::query_scalar(
            "SELECT digest FROM supertag_v2_workspace_mcp_attempts WHERE task_id=$1 LIMIT 1",
        )
        .bind(&attempt.task_id)
        .fetch_optional(&mut *tx)
        .await?;
        if pinned.is_some_and(|pinned| pinned != record.digest) {
            return Err(StoreError::FailedPrecondition(
                "Workspace MCP servers changed since this Task's first Task Attempt; SuperTag started none of them. Start a new Task to use the changed configuration".into(),
            ));
        }
        sqlx::query("INSERT INTO supertag_v2_workspace_mcp_attempts(task_id,attempt_id,digest,record) VALUES($1,$2,$3,$4)")
            .bind(&attempt.task_id)
            .bind(&attempt.attempt_id)
            .bind(&record.digest)
            .bind(prost::Message::encode_to_vec(&record))
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        Ok(())
    }
}

pub(crate) async fn require_no_pending_approval_in(
    tx: &mut sqlx::Transaction<'_, sqlx::Any>,
    attempt_id: &str,
) -> Result<()> {
    let pending: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM supertag_v2_approvals a WHERE a.attempt_id=$1 AND a.state=1 AND a.action LIKE 'mcp:%' AND NOT EXISTS (SELECT 1 FROM supertag_v2_approval_coverage c WHERE c.approval_id=a.approval_id)")
        .bind(attempt_id).fetch_one(&mut **tx).await?;
    if pending > 0 {
        return Err(StoreError::FailedPrecondition(
            "finish the turn awaiting MCP approval before asking a question".into(),
        ));
    }
    Ok(())
}

impl ControlPlane {
    pub fn attempt_mcp_effects_service(
        &self,
    ) -> attempt_mcp_effects_server::AttemptMcpEffectsServer<Self> {
        attempt_mcp_effects_server::AttemptMcpEffectsServer::new(self.clone())
            .max_decoding_message_size(MAX_MESSAGE_BYTES)
            .max_encoding_message_size(MAX_MESSAGE_BYTES)
    }
}

#[tonic::async_trait]
impl attempt_mcp_effects_server::AttemptMcpEffects for ControlPlane {
    async fn reserve(
        &self,
        request: Request<ReserveMcpEffectRequest>,
    ) -> std::result::Result<Response<ReserveMcpEffectResponse>, Status> {
        let host = self.host_authority(&request)?;
        Ok(Response::new(
            self.store
                .reserve_mcp_effect(&host, request.get_ref())
                .await?,
        ))
    }

    async fn settle(
        &self,
        request: Request<SettleMcpEffectRequest>,
    ) -> std::result::Result<Response<SettleMcpEffectResponse>, Status> {
        let host = self.host_authority(&request)?;
        self.store
            .settle_mcp_effect(&host, request.get_ref())
            .await?;
        Ok(Response::new(SettleMcpEffectResponse {}))
    }

    async fn record_workspace_mcp(
        &self,
        request: Request<RecordWorkspaceMcpRequest>,
    ) -> std::result::Result<Response<RecordWorkspaceMcpResponse>, Status> {
        let host = self.host_authority(&request)?;
        self.store
            .record_workspace_mcp(&host, request.get_ref())
            .await?;
        Ok(Response::new(RecordWorkspaceMcpResponse {}))
    }
}
