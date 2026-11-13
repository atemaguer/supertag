//! Approval decisions authorize one bound effect, never a Worker or native process.
use std::{collections::BTreeMap, fmt};

use prost::Message;
use serde::{
    Deserialize, Deserializer,
    de::{self, MapAccess, SeqAccess, Visitor},
};
use sha2::{Digest, Sha256};
use sqlx::{Any, Row, Transaction, any::AnyRow};
use supertag_protocol::{MAX_MESSAGE_BYTES, v2::*};
use uuid::Uuid;

use crate::{
    HostAuthority, Store, StoreError,
    objectives::{objective_admission_in, objective_link_task_in},
    store::{
        Result, approval_rules_from_row, insert_task_from_snapshot, invalid, lease_is_live, name,
        owned, task_in,
    },
};

const VIEW: &str = "SELECT a.*,c.grant_approval_id,c.covered_at_ms,g.state AS grant_state,g.scope AS grant_scope,g.decided_at_ms AS grant_decided_at_ms,g.decided_by AS grant_decided_by,g.reason AS grant_reason,g.valid_until_ms AS grant_valid_until_ms,(SELECT w.continuation_task_id FROM supertag_v2_approval_waits w WHERE w.task_id=a.task_id) AS continuation_task_id FROM supertag_v2_approvals a LEFT JOIN supertag_v2_approval_coverage c ON c.approval_id=a.approval_id LEFT JOIN supertag_v2_approvals g ON g.approval_id=c.grant_approval_id";
const ARGUMENT_LIMIT: usize = 131_072;

/// Operators and clients read and decide approvals in work they can see.
fn operator(principal: &str) -> Result<&str> {
    crate::store::actor(principal)?;
    Ok(principal)
}
fn digest(value: &impl serde::Serialize) -> Result<String> {
    Ok(format!(
        "sha256:{:x}",
        Sha256::digest(serde_json::to_vec(value)?)
    ))
}
fn summary(value: &str, limit: usize) -> Result<String> {
    let value = value.trim();
    if value.is_empty()
        || value.encode_utf16().count() > limit
        || value
            .chars()
            .any(|c| c.is_control() && c != '\n' && c != '\t')
    {
        return Err(invalid(
            "approval text is empty, oversized, or contains control characters",
        ));
    }
    Ok(value.to_owned())
}
/// Whether `principal` may decide. With no approvers named, any operator may and no client may:
/// a client decides only an approval that names it (`client:NAME`). Operators are named by their
/// operator ID, such as `local` or `token:laptop`.
fn eligible(approval: &Approval, principal: &str) -> bool {
    if approval.operator_ids.is_empty() {
        return principal.starts_with("operator:");
    }
    approval
        .operator_ids
        .iter()
        .any(|approver| approver_is(approver, principal))
}

/// Whether an approver entry names `principal`: `client:NAME` in full, an operator by its ID.
fn approver_is(approver: &str, principal: &str) -> bool {
    if approver.starts_with("client:") {
        approver == principal
    } else {
        principal.strip_prefix("operator:") == Some(approver)
    }
}
async fn access_in(tx: &mut Transaction<'_, Any>, principal: &str, task_id: &str) -> Result<bool> {
    crate::conversations::task_access_in(tx, principal, task_id).await
}

fn effect_request_digest(input: &RequestApprovalRequest) -> Result<String> {
    let canonical = canonical_arguments(&input.arguments_json)?;
    let arguments_digest = format!("sha256:{:x}", Sha256::digest(canonical.as_bytes()));
    digest(&(
        &input.action,
        &input.resource,
        &arguments_digest,
        &summary(&input.summary, 500)?,
    ))
}

/// A duplicate effect may skip consuming new authority, but cannot repurpose an
/// operation that already requested approval for a different normalized effect.
/// Compare the operation's own digest, not the original grant's arguments.
pub(crate) async fn ensure_operation_matches_in(
    tx: &mut Transaction<'_, Any>,
    attempt_id: &str,
    input: &RequestApprovalRequest,
) -> Result<()> {
    let prior: Option<String> = sqlx::query_scalar("SELECT request_digest FROM supertag_v2_approval_operations WHERE attempt_id=$1 AND operation_id=$2")
        .bind(attempt_id).bind(&input.operation_id).fetch_optional(&mut **tx).await?;
    if let Some(prior) = prior
        && prior != effect_request_digest(input)?
    {
        return Err(StoreError::Conflict(
            "approval operation used different arguments".into(),
        ));
    }
    Ok(())
}

/// Called in the same transaction as the actual effect, after its resource scope
/// and prior effect receipt have been checked. A standalone grant is not exposed.
pub(crate) async fn gate_in(
    tx: &mut Transaction<'_, Any>,
    host: &HostAuthority,
    input: &RequestApprovalRequest,
    now: i64,
    order: i64,
) -> Result<RequestApprovalResponse> {
    let attempt = input
        .attempt
        .as_ref()
        .ok_or_else(|| invalid("Attempt identity is required"))?;
    let task = owned(
        tx,
        host,
        &attempt.task_id,
        &attempt.attempt_id,
        &attempt.lease_token,
    )
    .await?;
    if task.try_get::<i64, _>("state")? != TaskState::Running as i64 || !lease_is_live(&task, now)?
    {
        return Err(StoreError::FailedPrecondition(
            "approval requires a live running Attempt".into(),
        ));
    }
    let rules = approval_rules_from_row(&task)?;
    let Some(rule) = rules.into_iter().find(|rule| rule.action == input.action) else {
        // An unconfigured Workstream is authorized by its real Team membership.
        return Ok(RequestApprovalResponse {
            approval: None,
            granted: true,
        });
    };
    let actions: Vec<String> =
        serde_json::from_str(&task.try_get::<String, _>("allowed_actions")?)?;
    if !actions.contains(&input.action) {
        return Err(StoreError::PermissionDenied);
    }
    name("approval resource", &input.resource)?;
    gate_effect_in(tx, input, &task, rule.operator_ids, None, now, order).await
}

/// The caller has already fenced the effect and its Attempt. Persist consumption
/// in the same transaction as either the in-store mutation or external dispatch intent.
pub(crate) async fn gate_effect_in(
    tx: &mut Transaction<'_, Any>,
    input: &RequestApprovalRequest,
    task: &AnyRow,
    mut operators: Vec<String>,
    authority: Option<&str>,
    now: i64,
    order: i64,
) -> Result<RequestApprovalResponse> {
    let attempt = input.attempt.as_ref().expect("validated effect Attempt");
    name("approval operation ID", &input.operation_id)?;
    let summary = summary(&input.summary, 500)?;
    let canonical = canonical_arguments(&input.arguments_json)?;
    let arguments_digest = format!("sha256:{:x}", Sha256::digest(canonical.as_bytes()));
    operators.sort_unstable();
    operators.dedup();
    let conversation_owner = crate::conversations::task_owner_in(tx, &attempt.task_id)
        .await?
        .ok_or(StoreError::PermissionDenied)?;
    if !conversation_owner.is_empty() {
        let owner = operator(&conversation_owner)?;
        if !operators.is_empty() && !operators.iter().any(|id| approver_is(id, owner)) {
            return Err(StoreError::PermissionDenied);
        }
    }
    let mut request_digest = effect_request_digest(input)?;
    let rule_digest = if let Some(authority) = authority {
        request_digest = digest(&(&request_digest, authority))?;
        digest(&(&input.action, &operators, authority))?
    } else {
        digest(&(&input.action, &operators))?
    };
    let tag: String = task.try_get("tag_id")?;
    let session: String = task.try_get("session_id")?;
    let objective: Option<String> =
        sqlx::query_scalar("SELECT objective_id FROM supertag_v2_objective_tasks WHERE task_id=$1")
            .bind(&attempt.task_id)
            .fetch_optional(&mut **tx)
            .await?;
    let prior = sqlx::query("SELECT request_digest,approval_id,granted FROM supertag_v2_approval_operations WHERE attempt_id=$1 AND operation_id=$2")
        .bind(&attempt.attempt_id).bind(&input.operation_id).fetch_optional(&mut **tx).await?;
    let mut approval = if let Some(prior) = prior {
        if prior.try_get::<String, _>("request_digest")? != request_digest {
            return Err(StoreError::Conflict(
                "approval operation used different arguments".into(),
            ));
        }
        let value = load_in(tx, &prior.try_get::<String, _>("approval_id")?).await?;
        if prior.try_get::<i64, _>("granted")? == 1 {
            // This exact operation already consumed authority atomically with its
            // effect; its caller owns effect deduplication, not a bearer grant.
            return Ok(RequestApprovalResponse {
                approval: Some(value),
                granted: true,
            });
        }
        value
    } else {
        // Existing decisions on these exact arguments take precedence over a
        // broad grant. In particular, a new operation ID cannot bypass a denial.
        let exact: Option<String> = sqlx::query_scalar("SELECT a.approval_id FROM supertag_v2_approvals a LEFT JOIN supertag_v2_approval_coverage c ON c.approval_id=a.approval_id LEFT JOIN supertag_v2_approvals g ON g.approval_id=c.grant_approval_id WHERE a.tag_id=$1 AND a.session_id=$2 AND a.action=$3 AND a.resource=$4 AND a.arguments_digest=$5 AND a.rule_digest=$6 AND a.state IN (1,2,3) AND (c.approval_id IS NULL OR (g.state=2 AND (g.valid_until_ms IS NULL OR g.valid_until_ms>$7))) AND (a.valid_until_ms IS NULL OR a.valid_until_ms>$7) AND (a.consumed_at_ms IS NULL OR a.state<>2 OR a.scope=2) AND ((a.task_id=$8 AND a.attempt_id=$9) OR EXISTS (SELECT 1 FROM supertag_v2_approval_waits w JOIN supertag_v2_approval_wait_requests r ON r.task_id=w.task_id WHERE r.approval_id=a.approval_id AND w.continuation_task_id=$8)) ORDER BY a.requested_order LIMIT 1")
            .bind(&tag).bind(&session).bind(&input.action).bind(&input.resource).bind(&arguments_digest).bind(&rule_digest).bind(now).bind(&attempt.task_id).bind(&attempt.attempt_id).fetch_optional(&mut **tx).await?;
        let scoped: Option<String> = if exact.is_none() {
            if let Some(objective) = &objective {
                sqlx::query_scalar("SELECT approval_id FROM supertag_v2_approvals WHERE objective_id=$1 AND tag_id=$2 AND action=$3 AND resource=$4 AND rule_digest=$5 AND state=2 AND scope=2 AND (valid_until_ms IS NULL OR valid_until_ms>$6) ORDER BY requested_order LIMIT 1")
                    .bind(objective).bind(&tag).bind(&input.action).bind(&input.resource).bind(&rule_digest).bind(now).fetch_optional(&mut **tx).await?
            } else {
                None
            }
        } else {
            None
        };
        let id = match exact.or(scoped) {
            Some(id) => id,
            None => {
                let id = Uuid::new_v4().to_string();
                sqlx::query("INSERT INTO supertag_v2_approvals (approval_id,task_id,attempt_id,tag_id,session_id,objective_id,action,resource,canonical_arguments_json,arguments_digest,rule_digest,summary,operator_ids,state,requested_at_ms,requested_order) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,1,$14,$15)")
                    .bind(&id).bind(&attempt.task_id).bind(&attempt.attempt_id).bind(&tag).bind(&session).bind(&objective).bind(&input.action).bind(&input.resource).bind(canonical).bind(&arguments_digest).bind(&rule_digest).bind(summary).bind(serde_json::to_string(&operators)?).bind(now).bind(order).execute(&mut **tx).await?;
                id
            }
        };
        sqlx::query("INSERT INTO supertag_v2_approval_operations (attempt_id,operation_id,request_digest,approval_id) VALUES ($1,$2,$3,$4)")
            .bind(&attempt.attempt_id).bind(&input.operation_id).bind(request_digest).bind(&id).execute(&mut **tx).await?;
        load_in(tx, &id).await?
    };
    approval.state = effective_state(tx, &approval, now).await? as i32;
    let granted = approval.state() == ApprovalState::Approved
        && (approval.scope() == ApprovalScope::Objective || approval.consumed_at_ms.is_none());
    if granted {
        if approval.scope() == ApprovalScope::Once {
            sqlx::query("UPDATE supertag_v2_approvals SET consumed_at_ms=$1 WHERE approval_id=$2 AND consumed_at_ms IS NULL")
                .bind(now).bind(&approval.approval_id).execute(&mut **tx).await?;
            approval.consumed_at_ms = Some(now);
        }
        sqlx::query("UPDATE supertag_v2_approval_operations SET granted=1 WHERE attempt_id=$1 AND operation_id=$2")
            .bind(&attempt.attempt_id).bind(&input.operation_id).execute(&mut **tx).await?;
    }
    Ok(RequestApprovalResponse {
        approval: Some(approval),
        granted,
    })
}

impl Store {
    pub async fn get_approval(&self, principal: &str, id: &str) -> Result<Approval> {
        operator(principal)?;
        name("approval ID", id)?;
        let mut tx = self.pool.begin().await?;
        let mut value = load_in(&mut tx, id).await?;
        if !access_in(&mut tx, principal, &value.task_id).await? {
            return Err(StoreError::NotFound("approval was not found".into()));
        }
        value.state = effective_state(&mut tx, &value, self.execution_now_ms()).await? as i32;
        tx.commit().await?;
        Ok(value)
    }

    pub async fn list_approvals(
        &self,
        principal: &str,
        input: &ListApprovalsRequest,
    ) -> Result<ListApprovalsResponse> {
        operator(principal)?;
        if input.limit > 100 {
            return Err(invalid("approval page limit must be at most 100"));
        }
        let state =
            ApprovalState::try_from(input.state).map_err(|_| invalid("unknown approval state"))?;
        let scope = digest(&(principal, &input.objective_id, &input.task_id, input.state))?;
        let after = if input.cursor.is_empty() {
            0
        } else {
            let (position, bound) = input
                .cursor
                .split_once('|')
                .ok_or_else(|| invalid("invalid approval cursor"))?;
            if bound != scope || input.cursor.len() > 160 {
                return Err(invalid("approval cursor scope differs"));
            }
            position
                .parse::<i64>()
                .ok()
                .filter(|n| *n >= 0)
                .ok_or_else(|| invalid("invalid approval cursor"))?
        };
        let mut tx = self.pool.begin().await?;
        let owner = crate::store::sees_owner_sql("audience.owner", "$4");
        let rows = sqlx::query(&format!("{VIEW} WHERE a.requested_order>$1 AND ($2='' OR a.objective_id=$2) AND ($3='' OR a.task_id=$3) AND EXISTS (SELECT 1 FROM supertag_v2_task_audience audience WHERE audience.task_id=a.task_id AND {owner}) ORDER BY a.requested_order LIMIT 1001"))
            .bind(after).bind(&input.objective_id).bind(&input.task_id).bind(principal).fetch_all(&mut *tx).await?;
        let limit = if input.limit == 0 {
            50
        } else {
            input.limit as usize
        };
        let mut approvals = vec![];
        let mut position = after;
        let mut bytes = 0;
        let mut more = false;
        for row in &rows {
            let mut value = approval_row(row)?;
            value.state = effective_state(&mut tx, &value, self.execution_now_ms()).await? as i32;
            if state == ApprovalState::Unspecified || value.state() == state {
                if approvals.len() == limit || bytes + value.encoded_len() > MAX_MESSAGE_BYTES / 2 {
                    more = true;
                    break;
                }
                bytes += value.encoded_len();
                approvals.push(value);
            }
            position = row.try_get("requested_order")?;
        }
        more |= rows.len() == 1001;
        tx.commit().await?;
        Ok(ListApprovalsResponse {
            approvals,
            next_cursor: if more {
                format!("{position}|{scope}")
            } else {
                String::new()
            },
        })
    }

    pub async fn decide_approval(
        &self,
        principal: &str,
        input: &DecideApprovalRequest,
    ) -> Result<Approval> {
        let id = operator(principal)?;
        name("approval ID", &input.approval_id)?;
        name("decision operation ID", &input.operation_id)?;
        let reason = if input.reason.trim().is_empty() {
            None
        } else {
            Some(summary(&input.reason, 2000)?)
        };
        if !input.approve && reason.is_none() {
            return Err(invalid("denial requires a reason"));
        }
        let requested_scope =
            ApprovalScope::try_from(input.scope).map_err(|_| invalid("unknown approval scope"))?;
        let scope = if input.approve {
            if requested_scope == ApprovalScope::Unspecified {
                ApprovalScope::Once
            } else {
                requested_scope
            }
        } else {
            if requested_scope != ApprovalScope::Unspecified || input.valid_until_ms.is_some() {
                return Err(invalid("denial cannot grant a scope or validity period"));
            }
            ApprovalScope::Unspecified
        };
        let request_digest = digest(&(
            &input.approval_id,
            input.approve,
            scope as i32,
            input.valid_until_ms,
            &reason,
        ))?;
        let (mut tx, _) = self.write().await?;
        let mut value = load_in(&mut tx, &input.approval_id).await?;
        if !access_in(&mut tx, principal, &value.task_id).await? {
            return Err(StoreError::NotFound("approval was not found".into()));
        }
        if !eligible(&value, id) {
            return Err(StoreError::PermissionDenied);
        }
        let receipt=sqlx::query("SELECT request_digest,approval_id FROM supertag_v2_approval_decisions WHERE principal=$1 AND operation_id=$2")
            .bind(principal).bind(&input.operation_id).fetch_optional(&mut *tx).await?;
        if let Some(receipt) = receipt {
            if receipt.try_get::<String, _>("request_digest")? != request_digest {
                return Err(StoreError::Conflict(
                    "decision operation used different content".into(),
                ));
            }
            tx.rollback().await?;
            return Ok(value);
        }
        let now = self.execution_now_ms();
        let effective = effective_state(&mut tx, &value, now).await?;
        if effective == ApprovalState::Expired {
            sqlx::query("UPDATE supertag_v2_approvals SET state=4 WHERE approval_id=$1")
                .bind(&value.approval_id)
                .execute(&mut *tx)
                .await?;
            tx.commit().await?;
            return Err(StoreError::FailedPrecondition(
                "approval request expired".into(),
            ));
        }
        if effective != ApprovalState::Pending {
            return Err(StoreError::FailedPrecondition(
                "approval request already has a decision".into(),
            ));
        }
        if scope == ApprovalScope::Objective
            && crate::github_publications::approval_eligibility_in(&mut tx, &value)
                .await?
                .is_some()
        {
            return Err(invalid(
                "publication approval is bound to one exact destination and commit",
            ));
        }
        if scope == ApprovalScope::Objective && value.objective_id.is_none() {
            return Err(invalid("Objective scope requires an Objective"));
        }
        if input.valid_until_ms.is_some_and(|until| until <= now) {
            return Err(invalid("approval validity must end in the future"));
        }
        let state = if input.approve {
            ApprovalState::Approved
        } else {
            ApprovalState::Denied
        };
        sqlx::query("UPDATE supertag_v2_approvals SET state=$1,scope=$2,decided_at_ms=$3,decided_by=$4,reason=$5,valid_until_ms=$6 WHERE approval_id=$7")
            .bind(state as i64).bind(scope as i64).bind(now).bind(id).bind(reason).bind(input.valid_until_ms).bind(&value.approval_id).execute(&mut *tx).await?;
        sqlx::query("INSERT INTO supertag_v2_approval_decisions (principal,operation_id,request_digest,approval_id) VALUES ($1,$2,$3,$4)")
            .bind(principal).bind(&input.operation_id).bind(request_digest).bind(&value.approval_id).execute(&mut *tx).await?;
        if state == ApprovalState::Approved && scope == ApprovalScope::Objective {
            cover_pending_in(&mut tx, &value.approval_id, now).await?;
        }
        continue_in(&mut tx, &value.task_id, now).await?;
        value = load_in(&mut tx, &value.approval_id).await?;
        tx.commit().await?;
        Ok(value)
    }

    pub async fn sweep_approvals(&self) -> Result<()> {
        let (mut tx, _) = self.write().await?;
        let now = self.execution_now_ms();
        let cursor = sqlx::query(
            "SELECT request_order,wait_order FROM supertag_v2_approval_sweep WHERE singleton=1",
        )
        .fetch_one(&mut *tx)
        .await?;
        let rows=sqlx::query("SELECT approval_id,requested_order FROM supertag_v2_approvals WHERE state IN (1,2) AND requested_order>$1 ORDER BY requested_order LIMIT 128")
            .bind(cursor.try_get::<i64,_>("request_order")?).fetch_all(&mut *tx).await?;
        let request_order = if rows.len() == 128 {
            rows.last().unwrap().try_get::<i64, _>("requested_order")?
        } else {
            0
        };
        for row in rows {
            let id: String = row.try_get("approval_id")?;
            let value = load_in(&mut tx, &id).await?;
            if effective_state(&mut tx, &value, now).await? == ApprovalState::Expired {
                sqlx::query("UPDATE supertag_v2_approvals SET state=4 WHERE approval_id=$1")
                    .bind(id)
                    .execute(&mut *tx)
                    .await?;
            }
        }
        let waiting=sqlx::query("SELECT w.task_id,t.accepted_order FROM supertag_v2_approval_waits w JOIN supertag_v2_tasks t ON t.task_id=w.task_id WHERE w.continuation_task_id IS NULL AND t.accepted_order>$1 ORDER BY t.accepted_order LIMIT 128")
            .bind(cursor.try_get::<i64,_>("wait_order")?).fetch_all(&mut *tx).await?;
        let wait_order = if waiting.len() == 128 {
            waiting
                .last()
                .unwrap()
                .try_get::<i64, _>("accepted_order")?
        } else {
            0
        };
        for row in waiting {
            continue_in(&mut tx, &row.try_get::<String, _>("task_id")?, now).await?;
        }
        sqlx::query("UPDATE supertag_v2_approval_sweep SET request_order=$1,wait_order=$2 WHERE singleton=1").bind(request_order).bind(wait_order).execute(&mut *tx).await?;
        tx.commit().await?;
        Ok(())
    }
}

fn waiting_ids(input: &FinishTaskRequest) -> Result<Vec<String>> {
    if input.waiting_approval_ids.len() > 32 {
        return Err(invalid("at most 32 approval requests may hold a Task"));
    }
    let mut ids = input.waiting_approval_ids.clone();
    for id in &ids {
        name("approval ID", id)?;
    }
    ids.sort_unstable();
    ids.dedup();
    Ok(ids)
}
pub(crate) async fn finish_replay_in(
    tx: &mut Transaction<'_, Any>,
    task: &Task,
    input: &FinishTaskRequest,
) -> Result<()> {
    let stored: String = sqlx::query_scalar(
        "SELECT finish_waiting_approval_ids FROM supertag_v2_tasks WHERE task_id=$1",
    )
    .bind(&task.task_id)
    .fetch_one(&mut **tx)
    .await?;
    if serde_json::from_str::<Vec<String>>(&stored)? != waiting_ids(input)? {
        return Err(StoreError::Conflict(
            "Task already finished with different approval waits".into(),
        ));
    }
    Ok(())
}
pub(crate) async fn finish_in(
    tx: &mut Transaction<'_, Any>,
    task: &Task,
    input: &FinishTaskRequest,
    now: i64,
) -> Result<()> {
    let ids = waiting_ids(input)?;
    if ids.is_empty() {
        return Ok(());
    }
    if !input.succeeded
        || task.state() != TaskState::Succeeded
        || input.objective_signal != ObjectiveSignal::Progress as i32
    {
        return Err(invalid(
            "approval waits require a successful Progress outcome",
        ));
    }
    let question: Option<String> = sqlx::query_scalar(
        "SELECT attempt_id FROM supertag_v2_objective_questions WHERE attempt_id=$1",
    )
    .bind(&input.attempt_id)
    .fetch_optional(&mut **tx)
    .await?;
    if question.is_some() {
        return Err(invalid(
            "a Task cannot wait for both a question and approval",
        ));
    }
    for id in &ids {
        let value = load_in(tx, id).await.map_err(|error| match error {
            StoreError::NotFound(_) => {
                invalid("approval wait does not name a request from this Attempt")
            }
            other => other,
        })?;
        if value.task_id != task.task_id || value.attempt_id != input.attempt_id {
            return Err(invalid(
                "approval wait does not name a request from this Attempt",
            ));
        }
        if value.consumed_at_ms.is_some() {
            return Err(invalid("an already consumed approval cannot hold a Task"));
        }
    }
    sqlx::query("UPDATE supertag_v2_tasks SET finish_waiting_approval_ids=$1 WHERE task_id=$2")
        .bind(serde_json::to_string(&ids)?)
        .bind(&task.task_id)
        .execute(&mut **tx)
        .await?;
    sqlx::query("INSERT INTO supertag_v2_approval_waits (task_id,attempt_id) VALUES ($1,$2)")
        .bind(&task.task_id)
        .bind(&input.attempt_id)
        .execute(&mut **tx)
        .await?;
    for id in ids {
        sqlx::query(
            "INSERT INTO supertag_v2_approval_wait_requests (approval_id,task_id) VALUES ($1,$2)",
        )
        .bind(id)
        .bind(&task.task_id)
        .execute(&mut **tx)
        .await?;
    }
    continue_in(tx, &task.task_id, now).await
}

/// Resolve all existing matching requests atomically with the original decision.
/// A link is authority attribution, not another operator decision. Denied,
/// expired, already covered, or stale requests can never acquire one.
async fn cover_pending_in(tx: &mut Transaction<'_, Any>, grant: &str, now: i64) -> Result<()> {
    sqlx::query("INSERT INTO supertag_v2_approval_coverage (approval_id,grant_approval_id,covered_at_ms) SELECT a.approval_id,g.approval_id,$2 FROM supertag_v2_approvals a JOIN supertag_v2_approvals g ON g.approval_id=$1 WHERE g.state=2 AND g.scope=2 AND a.state=1 AND a.objective_id=g.objective_id AND a.tag_id=g.tag_id AND a.action=g.action AND a.resource=g.resource AND a.rule_digest=g.rule_digest AND (a.valid_until_ms IS NULL OR a.valid_until_ms>$2) AND NOT EXISTS (SELECT 1 FROM supertag_v2_approval_coverage c WHERE c.approval_id=a.approval_id) AND NOT EXISTS (SELECT 1 FROM supertag_v2_objectives o WHERE o.objective_id=a.objective_id AND o.status IN (5,6)) AND EXISTS (SELECT 1 FROM supertag_v2_tasks t WHERE t.task_id=a.task_id AND t.attempt_id=a.attempt_id AND ((t.state=2 AND t.lease_expires_at_ms>$2) OR (t.state=3 AND EXISTS (SELECT 1 FROM supertag_v2_approval_waits w JOIN supertag_v2_approval_wait_requests r ON r.task_id=w.task_id WHERE r.approval_id=a.approval_id AND w.continuation_task_id IS NULL) AND NOT EXISTS (SELECT 1 FROM supertag_v2_tasks newer WHERE newer.tag_id=t.tag_id AND newer.session_id=t.session_id AND newer.accepted_order>t.accepted_order AND NOT EXISTS (SELECT 1 FROM supertag_v2_objective_tasks administrative WHERE administrative.task_id=newer.task_id AND administrative.kind='notice')))))")
        .bind(grant).bind(now).execute(&mut **tx).await?;
    let tasks: Vec<String> = sqlx::query_scalar("SELECT DISTINCT a.task_id FROM supertag_v2_approval_coverage c JOIN supertag_v2_approvals a ON a.approval_id=c.approval_id WHERE c.grant_approval_id=$1 ORDER BY a.task_id")
        .bind(grant).fetch_all(&mut **tx).await?;
    for task in tasks {
        continue_in(tx, &task, now).await?;
    }
    Ok(())
}

/// Called after clearing and storing an Objective's pause in this transaction.
/// Keeping the latest valid wait prevents a generic resume turn from expiring
/// its exact continuation authority. Resolved waits reconcile immediately.
pub(crate) async fn resume_wait_in(
    tx: &mut Transaction<'_, Any>,
    objective: &str,
    now: i64,
) -> Result<bool> {
    let task: Option<String> = sqlx::query_scalar("SELECT w.task_id FROM supertag_v2_approval_waits w JOIN supertag_v2_tasks t ON t.task_id=w.task_id AND t.attempt_id=w.attempt_id JOIN supertag_v2_objective_tasks link ON link.task_id=t.task_id LEFT JOIN supertag_v2_tasks continuation ON continuation.task_id=w.continuation_task_id WHERE link.objective_id=$1 AND t.state=3 AND NOT EXISTS (SELECT 1 FROM supertag_v2_approval_continuation_stops stopped WHERE stopped.task_id=w.task_id) AND ((w.continuation_task_id IS NULL AND NOT EXISTS (SELECT 1 FROM supertag_v2_tasks newer WHERE newer.tag_id=t.tag_id AND newer.session_id=t.session_id AND newer.accepted_order>t.accepted_order AND NOT EXISTS (SELECT 1 FROM supertag_v2_objective_tasks administrative WHERE administrative.task_id=newer.task_id AND administrative.kind='notice'))) OR (continuation.state IN (1,2,6) AND NOT EXISTS (SELECT 1 FROM supertag_v2_tasks newer WHERE newer.tag_id=continuation.tag_id AND newer.session_id=continuation.session_id AND newer.accepted_order>continuation.accepted_order AND NOT EXISTS (SELECT 1 FROM supertag_v2_objective_tasks administrative WHERE administrative.task_id=newer.task_id AND administrative.kind='notice')))) ORDER BY t.accepted_order DESC LIMIT 1")
        .bind(objective).fetch_optional(&mut **tx).await?;
    let Some(task) = task else {
        return Ok(false);
    };
    let ids: Vec<String> = sqlx::query_scalar("SELECT approval_id FROM supertag_v2_approval_wait_requests WHERE task_id=$1 ORDER BY approval_id")
        .bind(&task).fetch_all(&mut **tx).await?;
    let mut valid = false;
    for id in ids {
        let value = load_in(tx, &id).await?;
        valid |= effective_state(tx, &value, now).await? != ApprovalState::Expired;
    }
    if valid {
        continue_in(tx, &task, now).await?;
    }
    Ok(valid)
}

pub(crate) async fn task_waits_in(tx: &mut Transaction<'_, Any>, task_id: &str) -> Result<bool> {
    let count:i64=sqlx::query_scalar("SELECT COUNT(*) FROM supertag_v2_approval_waits w JOIN supertag_v2_tasks t ON t.task_id=w.task_id AND t.attempt_id=w.attempt_id WHERE w.task_id=$1 AND w.continuation_task_id IS NULL
        AND NOT EXISTS (SELECT 1 FROM supertag_v2_tags tag
            WHERE tag.tag_id=t.tag_id AND tag.retired_at_ms IS NOT NULL)
        AND NOT EXISTS (SELECT 1 FROM supertag_v2_work_session_tasks child
            JOIN supertag_v2_work_sessions session ON session.work_session_id=child.work_session_id
            JOIN supertag_v2_tags parent ON parent.tag_id=session.parent_tag_id
            WHERE child.task_id=t.task_id AND parent.retired_at_ms IS NOT NULL)
        AND NOT EXISTS (SELECT 1 FROM supertag_v2_approval_continuation_stops stopped WHERE stopped.task_id=w.task_id) AND t.state=3 AND NOT EXISTS (SELECT 1 FROM supertag_v2_tasks newer WHERE newer.tag_id=t.tag_id AND newer.session_id=t.session_id AND newer.accepted_order>t.accepted_order AND NOT EXISTS (SELECT 1 FROM supertag_v2_objective_tasks administrative WHERE administrative.task_id=newer.task_id AND administrative.kind='notice')) AND NOT EXISTS (SELECT 1 FROM supertag_v2_objective_tasks link JOIN supertag_v2_objectives o ON o.objective_id=link.objective_id WHERE link.task_id=t.task_id AND o.status IN (5,6))")
        .bind(task_id).fetch_one(&mut **tx).await?;
    Ok(count > 0)
}

async fn continue_in(tx: &mut Transaction<'_, Any>, task_id: &str, now: i64) -> Result<()> {
    if !task_waits_in(tx, task_id).await? {
        return Ok(());
    }
    let ids:Vec<String>=sqlx::query_scalar("SELECT approval_id FROM supertag_v2_approval_wait_requests WHERE task_id=$1 ORDER BY approval_id").bind(task_id).fetch_all(&mut **tx).await?;
    let mut decisions = vec![];
    for id in ids {
        let mut value = load_in(tx, &id).await?;
        value.state = effective_state(tx, &value, now).await? as i32;
        if value.state() == ApprovalState::Pending {
            return Ok(());
        }
        decisions.push(value);
    }
    if decisions.is_empty() {
        return Ok(());
    }
    let source = task_in(tx, task_id).await?;
    let scope = crate::work_sessions::task_scope_in(tx, task_id).await?;
    let is_child = scope
        .as_ref()
        .is_some_and(|scope| scope.kind == crate::work_sessions::CHILD);
    let allocation = if is_child {
        None
    } else {
        let objective: Option<String> = sqlx::query_scalar(
            "SELECT objective_id FROM supertag_v2_objective_tasks WHERE task_id=$1",
        )
        .bind(&source.task_id)
        .fetch_optional(&mut **tx)
        .await?;
        match crate::budget_pool::child_in(
            tx,
            &source,
            objective.as_deref(),
            source.execution_limits.as_ref(),
        )
        .await
        {
            Ok(value) => value,
            Err(StoreError::FailedPrecondition(_)) => {
                return budget_stop_in(tx, &source, scope.as_ref()).await;
            }
            Err(error) => return Err(error),
        }
    };
    match objective_admission_in(tx, &source.tag_id, &source.session_id, now).await {
        Ok(()) => {}
        Err(StoreError::FailedPrecondition(_)) => return Ok(()),
        Err(error) => return Err(error),
    }
    if !task_waits_in(tx, task_id).await? {
        return Ok(());
    }
    let prompt = format!(
        "The operator decided the approval requests from your previous turn. Retry an approved action with its exact arguments, or choose another approach for a denied or expired action.\n{}",
        decisions
            .iter()
            .map(|value| format!(
                "{}: {}{}",
                value.approval_id,
                value.state().as_str_name(),
                value
                    .reason
                    .as_deref()
                    .map(|reason| format!(" ({reason})"))
                    .unwrap_or_default()
            ))
            .collect::<Vec<_>>()
            .join("\n")
    );
    if scope
        .as_ref()
        .is_some_and(|scope| scope.kind == crate::work_sessions::CHILD)
    {
        return Box::pin(crate::work_sessions::automatic::continue_in(
            tx, &source, &prompt, now,
        ))
        .await;
    }
    let order:i64=sqlx::query_scalar("UPDATE supertag_v2_write_order SET revision=revision+1 WHERE singleton=1 RETURNING revision").fetch_one(&mut **tx).await?;
    let mut task =
        if let Some(scope) = scope.filter(|scope| scope.kind == crate::work_sessions::REPORT) {
            let report = if scope.task_id == source.task_id {
                source.clone()
            } else {
                task_in(tx, &scope.task_id).await?
            };
            if report.tag_id != source.tag_id || report.session_id != source.session_id {
                return Err(StoreError::PermissionDenied);
            }
            Box::pin(insert_task_from_snapshot(
                tx,
                order,
                &report,
                &source.session_id,
                &prompt,
            ))
            .await?
        } else {
            crate::store::insert_task_with_requirements(
                tx,
                order,
                &source.tag_id,
                &source.session_id,
                &prompt,
                (allocation.as_ref(), None),
            )
            .await?
        };
    crate::budget_pool::set_in(tx, &mut task, allocation).await?;
    objective_link_task_in(tx, &task).await?;
    // A continuation of a private Conversation remains private and visible in
    // that owner's conversation history, regardless of the decision transport.
    let owner: Option<String> = sqlx::query_scalar(
        "SELECT principal FROM supertag_v2_conversations WHERE session_id=$1 AND tag_id=$2",
    )
    .bind(&source.session_id)
    .bind(&source.tag_id)
    .fetch_optional(&mut **tx)
    .await?;
    if let Some(owner) = owner {
        sqlx::query("INSERT INTO supertag_v2_conversation_messages (task_id,session_id,principal,operation_id,request_digest,accepted_order) VALUES ($1,$2,$3,$4,$5,$6)")
            .bind(&task.task_id).bind(&source.session_id).bind(owner).bind(format!("approval-continuation:{}",task.task_id)).bind(digest(&task_id)?).bind(order).execute(&mut **tx).await?;
    }
    sqlx::query("UPDATE supertag_v2_approval_waits SET continuation_task_id=$1 WHERE task_id=$2 AND continuation_task_id IS NULL").bind(&task.task_id).bind(task_id).execute(&mut **tx).await?;
    Ok(())
}

/// A verified operator decision remains durable even when its next owner turn
/// cannot fit the pool. The notice owes no new execution authority.
async fn budget_stop_in(
    tx: &mut Transaction<'_, Any>,
    source: &supertag_protocol::v2::Task,
    scope: Option<&crate::work_sessions::WorkSessionTaskScope>,
) -> Result<()> {
    let order = crate::store::next_order(tx).await?;
    let prompt = "This Session was not continued after the operator's approval decision because too little of its reported budget remains. Report this limit and wait for a new allowance from the operator.";
    let mut notice =
        insert_task_from_snapshot(tx, order, source, &source.session_id, prompt).await?;
    let objective: Option<String> =
        sqlx::query_scalar("SELECT objective_id FROM supertag_v2_objective_tasks WHERE task_id=$1")
            .bind(&source.task_id)
            .fetch_optional(&mut **tx)
            .await?;
    let allocation = crate::budget_pool::owed_in(
        tx,
        source,
        objective.as_deref(),
        source.execution_limits.as_ref(),
    )
    .await?;
    crate::budget_pool::set_in(tx, &mut notice, allocation).await?;
    sqlx::query("UPDATE supertag_v2_tasks SET allowed_actions='[]' WHERE task_id=$1")
        .bind(&notice.task_id)
        .execute(&mut **tx)
        .await?;
    sqlx::query("INSERT INTO supertag_v2_objective_tasks (task_id,objective_id,kind) SELECT $1,objective_id,'notice' FROM supertag_v2_objective_tasks WHERE task_id=$2").bind(&notice.task_id).bind(&source.task_id).execute(&mut **tx).await?;
    if let Some(scope) = scope {
        sqlx::query("INSERT INTO supertag_v2_work_session_tasks (task_id,work_session_id,kind) VALUES ($1,$2,2)").bind(&notice.task_id).bind(&scope.work_session_id).execute(&mut **tx).await?;
    }
    let event = format!("approval-budget-stop:{}", source.task_id);
    let route_digest = format!("{:x}", Sha256::digest(event.as_bytes()));
    sqlx::query("INSERT INTO supertag_v2_inbound_events (account_id,event_id,request_digest,task_id,conversation_id,thread_id) SELECT account_id,$1,$2,$3,conversation_id,thread_id FROM supertag_v2_inbound_events WHERE task_id=$4").bind(&event).bind(&route_digest).bind(&notice.task_id).bind(&source.task_id).execute(&mut **tx).await?;
    if scope.is_none() {
        sqlx::query("INSERT INTO supertag_v2_conversation_messages (task_id,session_id,principal,operation_id,request_digest,accepted_order) SELECT $1,session_id,principal,$2,$3,$4 FROM supertag_v2_conversations WHERE session_id=$5 AND tag_id=$6").bind(&notice.task_id).bind(event).bind(route_digest).bind(order).bind(&source.session_id).bind(&source.tag_id).execute(&mut **tx).await?;
    }
    sqlx::query("INSERT INTO supertag_v2_approval_continuation_stops (task_id,reason,notice_task_id) VALUES ($1,'budget',$2)").bind(&source.task_id).bind(&notice.task_id).execute(&mut **tx).await?;
    Ok(())
}

pub(crate) async fn pending_in(
    tx: &mut Transaction<'_, Any>,
    principal: &str,
    objective_id: &str,
    as_of_ms: i64,
    upper_order: i64,
    limit: usize,
) -> Result<Vec<InboxItem>> {
    operator(principal)?;
    let owner = crate::store::sees_owner_sql("audience.owner", "$4");
    let mut rows=sqlx::query(&format!("{VIEW} WHERE a.state=1 AND c.approval_id IS NULL AND a.requested_at_ms<=$1 AND a.requested_order<=$2 AND ($3='' OR a.objective_id=$3) AND EXISTS (SELECT 1 FROM supertag_v2_task_audience audience WHERE audience.task_id=a.task_id AND {owner}) AND NOT EXISTS (SELECT 1 FROM supertag_v2_objectives o WHERE o.objective_id=a.objective_id AND o.status IN (5,6)) AND EXISTS (SELECT 1 FROM supertag_v2_tasks t WHERE t.task_id=a.task_id AND t.attempt_id=a.attempt_id AND ((t.state=2 AND t.lease_expires_at_ms>$1) OR (t.state=3 AND EXISTS (SELECT 1 FROM supertag_v2_approval_waits w JOIN supertag_v2_approval_wait_requests r ON r.task_id=w.task_id WHERE r.approval_id=a.approval_id AND w.continuation_task_id IS NULL) AND NOT EXISTS (SELECT 1 FROM supertag_v2_tasks newer WHERE newer.tag_id=t.tag_id AND newer.session_id=t.session_id AND newer.accepted_order>t.accepted_order AND NOT EXISTS (SELECT 1 FROM supertag_v2_objective_tasks administrative WHERE administrative.task_id=newer.task_id AND administrative.kind='notice'))))) ORDER BY a.requested_order LIMIT $5"))
        .bind(as_of_ms).bind(upper_order).bind(objective_id).bind(principal).bind(limit.min(1001) as i64).fetch_all(&mut **tx).await?;
    rows.extend(sqlx::query(&format!("{VIEW} JOIN supertag_v2_github_publications publication ON publication.approval_id=a.approval_id WHERE a.state=1 AND a.requested_at_ms<=$1 AND a.requested_order<=$2 AND ($3='' OR a.objective_id=$3) AND EXISTS(SELECT 1 FROM supertag_v2_task_audience audience WHERE audience.task_id=a.task_id AND {owner}) ORDER BY a.requested_order LIMIT $5"))
        .bind(as_of_ms).bind(upper_order).bind(objective_id).bind(principal).bind(limit.min(1001) as i64).fetch_all(&mut **tx).await?);
    rows.sort_by_key(|row| row.get::<i64, _>("requested_order"));
    rows.dedup_by(|a, b| a.get::<String, _>("approval_id") == b.get::<String, _>("approval_id"));
    rows.truncate(limit.min(1001));
    let mut items = vec![];
    for row in rows {
        let value = approval_row(&row)?;
        if effective_state(tx, &value, as_of_ms).await? != ApprovalState::Pending {
            continue;
        }
        items.push(InboxItem {
            key: format!("approval:{}", value.approval_id),
            occurrence: value.approval_id.clone(),
            kind: InboxItemKind::Approval as i32,
            objective_id: value.objective_id.clone().unwrap_or_default(),
            task_id: value.task_id.clone(),
            attempt_id: Some(value.attempt_id.clone()),
            operator_eligible: eligible(&value, principal),
            actionable_since_ms: value.requested_at_ms,
            reason: value.summary.clone(),
            question: None,
            approval: Some(InboxApproval {
                approval_id: value.approval_id,
                tag_id: value.tag_id,
                action: value.action,
                resource: value.resource,
                summary: value.summary,
            }),
        });
    }
    Ok(items)
}

pub(crate) async fn load_in(tx: &mut Transaction<'_, Any>, id: &str) -> Result<Approval> {
    let row = sqlx::query(&format!("{VIEW} WHERE a.approval_id=$1"))
        .bind(id)
        .fetch_optional(&mut **tx)
        .await?
        .ok_or_else(|| StoreError::NotFound("approval was not found".into()))?;
    approval_row(&row)
}
fn approval_row(row: &AnyRow) -> Result<Approval> {
    let grant_approval_id: Option<String> = row.try_get("grant_approval_id")?;
    let covered = grant_approval_id.is_some();
    let stored_state: i64 = row.try_get("state")?;
    Ok(Approval {
        approval_id: row.try_get("approval_id")?,
        task_id: row.try_get("task_id")?,
        attempt_id: row.try_get("attempt_id")?,
        tag_id: row.try_get("tag_id")?,
        session_id: row.try_get("session_id")?,
        objective_id: row.try_get("objective_id")?,
        action: row.try_get("action")?,
        resource: row.try_get("resource")?,
        canonical_arguments_json: row.try_get("canonical_arguments_json")?,
        arguments_digest: row.try_get("arguments_digest")?,
        summary: row.try_get("summary")?,
        operator_ids: serde_json::from_str(&row.try_get::<String, _>("operator_ids")?)?,
        state: if covered && stored_state == ApprovalState::Pending as i64 {
            row.try_get::<i64, _>("grant_state")? as i32
        } else {
            stored_state as i32
        },
        scope: row.try_get::<i64, _>(if covered { "grant_scope" } else { "scope" })? as i32,
        requested_at_ms: row.try_get("requested_at_ms")?,
        decided_at_ms: row.try_get(if covered {
            "grant_decided_at_ms"
        } else {
            "decided_at_ms"
        })?,
        decided_by: row.try_get(if covered {
            "grant_decided_by"
        } else {
            "decided_by"
        })?,
        reason: row.try_get(if covered { "grant_reason" } else { "reason" })?,
        valid_until_ms: row.try_get(if covered {
            "grant_valid_until_ms"
        } else {
            "valid_until_ms"
        })?,
        consumed_at_ms: row.try_get("consumed_at_ms")?,
        continuation_task_id: row.try_get("continuation_task_id")?,
        grant_approval_id,
        covered_at_ms: row.try_get("covered_at_ms")?,
    })
}
async fn effective_state(
    tx: &mut Transaction<'_, Any>,
    value: &Approval,
    now: i64,
) -> Result<ApprovalState> {
    let state = value.state();
    if !matches!(state, ApprovalState::Pending | ApprovalState::Approved) {
        return Ok(state);
    }
    if value.valid_until_ms.is_some_and(|until| until <= now) {
        return Ok(ApprovalState::Expired);
    }
    if let Some(eligible) = crate::github_publications::approval_eligibility_in(tx, value).await? {
        return Ok(if eligible {
            state
        } else {
            ApprovalState::Expired
        });
    }
    if let Some(objective) = &value.objective_id {
        let status: i64 =
            sqlx::query_scalar("SELECT status FROM supertag_v2_objectives WHERE objective_id=$1")
                .bind(objective)
                .fetch_one(&mut **tx)
                .await?;
        if matches!(
            ObjectiveStatus::try_from(status as i32),
            Ok(ObjectiveStatus::Completed | ObjectiveStatus::Cancelled)
        ) {
            return Ok(ApprovalState::Expired);
        }
        if state == ApprovalState::Approved && value.scope() == ApprovalScope::Objective {
            return Ok(state);
        }
    }
    if value.consumed_at_ms.is_some() {
        return Ok(state);
    }
    let row = sqlx::query(
        "SELECT state,attempt_id,lease_expires_at_ms FROM supertag_v2_tasks WHERE task_id=$1",
    )
    .bind(&value.task_id)
    .fetch_one(&mut **tx)
    .await?;
    if row.try_get::<Option<String>, _>("attempt_id")?.as_deref() != Some(value.attempt_id.as_str())
    {
        return Ok(ApprovalState::Expired);
    }
    if row.try_get::<i64, _>("state")? == TaskState::Running as i64 && lease_is_live(&row, now)? {
        return Ok(state);
    }
    if row.try_get::<i64, _>("state")? == TaskState::Succeeded as i64 {
        let waiting:Option<Option<String>>=sqlx::query_scalar("SELECT w.continuation_task_id FROM supertag_v2_approval_waits w JOIN supertag_v2_approval_wait_requests r ON r.task_id=w.task_id WHERE r.approval_id=$1").bind(&value.approval_id).fetch_optional(&mut **tx).await?;
        if let Some(Some(continuation)) = waiting {
            // Once grants are eligible only for this exact continuation, never an
            // arbitrary later turn in the same Session.
            let active: i64 = sqlx::query_scalar(
                "SELECT COUNT(*) FROM supertag_v2_tasks WHERE task_id=$1 AND state IN (1,2,6)",
            )
            .bind(continuation)
            .fetch_one(&mut **tx)
            .await?;
            if active > 0 {
                return Ok(state);
            }
        } else if waiting.is_some() && task_waits_in(tx, &value.task_id).await? {
            return Ok(state);
        }
    }
    Ok(ApprovalState::Expired)
}

// Reject duplicate keys rather than hashing only whichever duplicate a parser
// happened to keep. Object key order/whitespace do not change action identity.
struct Canonical(serde_json::Value);
impl<'de> Deserialize<'de> for Canonical {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> std::result::Result<Self, D::Error> {
        struct V;
        impl<'de> Visitor<'de> for V {
            type Value = Canonical;
            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str("bounded JSON arguments without duplicate keys")
            }
            fn visit_unit<E: de::Error>(self) -> std::result::Result<Self::Value, E> {
                Ok(Canonical(serde_json::Value::Null))
            }
            fn visit_bool<E: de::Error>(self, v: bool) -> std::result::Result<Self::Value, E> {
                Ok(Canonical(v.into()))
            }
            fn visit_i64<E: de::Error>(self, v: i64) -> std::result::Result<Self::Value, E> {
                Ok(Canonical(v.into()))
            }
            fn visit_u64<E: de::Error>(self, v: u64) -> std::result::Result<Self::Value, E> {
                Ok(Canonical(v.into()))
            }
            fn visit_f64<E: de::Error>(self, v: f64) -> std::result::Result<Self::Value, E> {
                if v == 0.0 {
                    return Ok(Canonical(0.into()));
                }
                if v.fract() == 0.0 && v.abs() <= 9_007_199_254_740_991.0 {
                    return Ok(Canonical((v as i64).into()));
                }
                serde_json::Number::from_f64(v)
                    .map(|n| Canonical(n.into()))
                    .ok_or_else(|| E::custom("nonfinite JSON number"))
            }
            fn visit_str<E: de::Error>(self, v: &str) -> std::result::Result<Self::Value, E> {
                Ok(Canonical(v.into()))
            }
            fn visit_string<E: de::Error>(self, v: String) -> std::result::Result<Self::Value, E> {
                Ok(Canonical(v.into()))
            }
            fn visit_seq<A: SeqAccess<'de>>(
                self,
                mut sequence: A,
            ) -> std::result::Result<Self::Value, A::Error> {
                let mut values = vec![];
                while let Some(Canonical(value)) = sequence.next_element()? {
                    values.push(value);
                }
                Ok(Canonical(values.into()))
            }
            fn visit_map<A: MapAccess<'de>>(
                self,
                mut map: A,
            ) -> std::result::Result<Self::Value, A::Error> {
                let mut values = BTreeMap::new();
                while let Some((key, Canonical(value))) = map.next_entry::<String, Canonical>()? {
                    if values.insert(key, value).is_some() {
                        return Err(de::Error::custom("duplicate JSON key"));
                    }
                }
                Ok(Canonical(serde_json::Value::Object(
                    values.into_iter().collect(),
                )))
            }
        }
        deserializer.deserialize_any(V)
    }
}
pub(crate) fn canonical_arguments(input: &str) -> Result<String> {
    if input.len() > ARGUMENT_LIMIT {
        return Err(invalid("approval arguments exceed 128 KiB"));
    }
    let Canonical(value) = serde_json::from_str(input)
        .map_err(|_| invalid("approval arguments must be valid JSON without duplicate keys"))?;
    if !value.is_object() {
        return Err(invalid("approval arguments must be a JSON object"));
    }
    Ok(serde_json::to_string(&value)?)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn canonical_arguments_ignore_key_order_but_reject_ambiguous_or_excessive_documents() {
        assert_eq!(
            canonical_arguments(r#"{ "z": [1.0, -0.0], "a":{"b":true} }"#).unwrap(),
            canonical_arguments(r#"{"a":{"b":true},"z":[1,0]}"#).unwrap()
        );
        for input in [r#"{"a":1,"a":2}"#, r#"{"a":{"b":1,"b":2}}"#, "[]", "null"] {
            assert!(canonical_arguments(input).is_err());
        }
        assert!(canonical_arguments(&" ".repeat(ARGUMENT_LIMIT + 1)).is_err());
        assert!(canonical_arguments(&format!("{}0{}", "[".repeat(200), "]".repeat(200))).is_err());
    }
}

#[cfg(test)]
#[path = "approvals/budget_tests.rs"]
mod budget_tests;

#[cfg(test)]
mod eligibility_tests {
    use super::*;

    fn approval(approvers: &[&str]) -> Approval {
        Approval {
            operator_ids: approvers.iter().map(|id| (*id).to_owned()).collect(),
            ..Default::default()
        }
    }

    /// With no approvers named, any operator decides and no client does; a client decides only
    /// when it is named by its full principal, and an operator only by its operator ID.
    #[test]
    fn clients_decide_only_when_named() {
        let open = approval(&[]);
        assert!(eligible(&open, "operator:local"));
        assert!(eligible(&open, "operator:token:laptop"));
        assert!(!eligible(&open, "client:alice"));
        let named = approval(&["local", "client:alice"]);
        assert!(eligible(&named, "operator:local"));
        assert!(eligible(&named, "client:alice"));
        assert!(!eligible(&named, "client:bob"));
        assert!(!eligible(&named, "operator:token:laptop"));
        // A client name never matches an operator, nor an operator ID a client.
        assert!(!eligible(&approval(&["alice"]), "client:alice"));
        assert!(!eligible(
            &approval(&["client:alice"]),
            "operator:client:alice"
        ));
    }
}
