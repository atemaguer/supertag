//! External publication is a separate durable effect of an accepted Workspace
//! result. Task success never implies that a branch or pull request was published.
use crate::{
    Store, StoreError, external_effects, policy,
    store::{Result, invalid, name, next_order, task_in},
};
use prost::Message;
use sha2::{Digest, Sha256};
use sqlx::{Any, Row, Transaction, any::AnyRow};
use supertag_protocol::{MAX_MESSAGE_BYTES, v2::*};
use uuid::Uuid;

const LEASE_MS: i64 = 30_000;
const ACTION: &str = "pull-requests:create";

fn publisher(principal: &str) -> Result<&str> {
    let account = principal
        .strip_prefix("publisher:github/")
        .ok_or(StoreError::PermissionDenied)?;
    name("publisher account", account)?;
    Ok(account)
}
fn decode(row: &AnyRow) -> Result<GithubPublication> {
    policy::decode(&row.try_get::<Vec<u8>, _>("payload")?)
}
async fn row_in(tx: &mut Transaction<'_, Any>, id: &str) -> Result<AnyRow> {
    sqlx::query("SELECT * FROM supertag_v2_github_publications WHERE publication_id=$1")
        .bind(id)
        .fetch_optional(&mut **tx)
        .await?
        .ok_or_else(|| StoreError::NotFound("publication was not found".into()))
}
async fn save(tx: &mut Transaction<'_, Any>, value: &GithubPublication) -> Result<()> {
    sqlx::query("UPDATE supertag_v2_github_publications SET state=$1,phase=$2,payload=$3,approval_id=$4,cancel_requested=$5 WHERE publication_id=$6")
        .bind(i64::from(value.state)).bind(i64::from(value.phase)).bind(value.encode_to_vec()).bind(&value.approval_id).bind(i64::from(value.cancel_requested)).bind(&value.publication_id).execute(&mut **tx).await?;
    Ok(())
}
fn terminal(state: GithubPublicationState) -> bool {
    matches!(
        state,
        GithubPublicationState::Published
            | GithubPublicationState::Held
            | GithubPublicationState::Cancelled
    )
}
fn exact_receipt(
    value: &GithubPublication,
    receipt: &GithubPullRequestReceipt,
    exact_commit: bool,
) -> bool {
    receipt.number > 0
        && receipt.repository_id == value.repository_id
        && receipt.repository == value.repository
        && receipt.base_branch == value.base_branch
        && receipt.head_branch == value.head_branch
        && receipt.open
        && !receipt.merged
        && receipt.url
            == format!(
                "https://github.com/{}/pull/{}",
                value.repository, receipt.number
            )
        && (!exact_commit || (receipt.title == value.title && receipt.body == value.body))
        && (!exact_commit
            || value
                .delivery
                .as_ref()
                .is_some_and(|delivery| receipt.head_commit == delivery.head_commit))
}
async fn eligible_in(tx: &mut Transaction<'_, Any>, value: &GithubPublication) -> Result<bool> {
    let row=sqlx::query("SELECT t.state,t.cleanup_pending,g.retired_at_ms,o.status AS objective_status FROM supertag_v2_tasks t JOIN supertag_v2_tags g ON g.tag_id=t.tag_id LEFT JOIN supertag_v2_objective_tasks link ON link.task_id=t.task_id LEFT JOIN supertag_v2_objectives o ON o.objective_id=link.objective_id WHERE t.task_id=$1").bind(&value.task_id).fetch_one(&mut **tx).await?;
    Ok(
        row.try_get::<i64, _>("state")? == TaskState::Succeeded as i64
            && row.try_get::<i64, _>("cleanup_pending")? == 0
            && row.try_get::<Option<i64>, _>("retired_at_ms")?.is_none()
            && row.try_get::<Option<i64>, _>("objective_status")?
                != Some(ObjectiveStatus::Cancelled as i64),
    )
}

async fn ready_in(tx: &mut Transaction<'_, Any>, value: &GithubPublication) -> Result<bool> {
    let active:i64=sqlx::query_scalar("SELECT COUNT(*) FROM supertag_v2_tasks WHERE tag_id=$1 AND session_id=$2 AND (state IN (1,2,6,7) OR cleanup_pending=1)").bind(&value.tag_id).bind(&value.session_id).fetch_one(&mut **tx).await?;
    if active > 0 {
        return Ok(false);
    }
    // Administrative notices cannot make an unanswered owner turn ready to
    // publish. A real later turn supersedes the old question's freshness.
    let latest:Option<String>=sqlx::query_scalar("SELECT t.task_id FROM supertag_v2_tasks t WHERE t.tag_id=$1 AND t.session_id=$2 AND NOT EXISTS(SELECT 1 FROM supertag_v2_objective_tasks o WHERE o.task_id=t.task_id AND o.kind='notice') ORDER BY t.accepted_order DESC LIMIT 1").bind(&value.tag_id).bind(&value.session_id).fetch_optional(&mut **tx).await?;
    let Some(latest) = latest else {
        return Ok(false);
    };
    let waiting:i64=sqlx::query_scalar("SELECT (SELECT COUNT(*) FROM supertag_v2_approval_waits WHERE task_id=$1 AND continuation_task_id IS NULL)+(SELECT COUNT(*) FROM supertag_v2_objective_questions WHERE task_id=$1 AND published_at_ms IS NOT NULL AND answer_task_id IS NULL)+(SELECT COUNT(*) FROM supertag_v2_work_session_questions WHERE task_id=$1 AND published_at_ms IS NOT NULL AND answer_task_id IS NULL)").bind(latest).fetch_one(&mut **tx).await?;
    Ok(waiting == 0)
}

/// Called once inside Finish after independent Workspace receipt validation.
pub(crate) async fn finish_in(tx: &mut Transaction<'_, Any>, task: &Task) -> Result<()> {
    let Some(delivery) = task
        .workspace_delivery
        .as_ref()
        .filter(|delivery| delivery.committed)
    else {
        return Ok(());
    };
    let Some(workspace) = task
        .workspace
        .as_ref()
        .and_then(|spec| spec.github_source.as_ref())
    else {
        return Ok(());
    };
    let Some(configuration) = &workspace.pull_request else {
        return Ok(());
    };
    let source = workspace
        .source
        .as_ref()
        .ok_or_else(|| invalid("publication source is missing"))?;
    let snapshot = task
        .policy_snapshot
        .as_ref()
        .ok_or(StoreError::PermissionDenied)?;
    external_effects::surface(
        snapshot,
        &source.account_id,
        &format!("repository:{}", source.repository_id),
        ACTION,
    )?;
    let existing: Option<String> = sqlx::query_scalar(
        "SELECT publication_id FROM supertag_v2_github_publications WHERE task_id=$1",
    )
    .bind(&task.task_id)
    .fetch_optional(&mut **tx)
    .await?;
    if existing.is_some() {
        return Ok(());
    }
    let superseded=sqlx::query("SELECT * FROM supertag_v2_github_publications WHERE tag_id=$1 AND session_id=$2 AND state IN (1,2,3) AND phase=0 AND pushed=0 AND recovery_only=0").bind(&task.tag_id).bind(&task.session_id).fetch_all(&mut **tx).await?;
    for row in superseded {
        let mut prior = decode(&row)?;
        prior.state = GithubPublicationState::Cancelled as i32;
        prior.cancel_requested = true;
        prior.reason = "a newer verified commit superseded this undispatched publication".into();
        save(tx, &prior).await?;
    }
    let branch = supertag_protocol::session_branch(&task.tag_id, &task.session_id);
    let title = task
        .prompt
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or("Workspace update")
        .chars()
        .take(120)
        .collect::<String>();
    let body = format!(
        "SuperTag Task {}\n\n{}",
        task.task_id,
        task.result.as_deref().unwrap_or("")
    )
    .chars()
    .take(16_000)
    .collect::<String>();
    let value = GithubPublication {
        publication_id: Uuid::new_v4().to_string(),
        task_id: task.task_id.clone(),
        tag_id: task.tag_id.clone(),
        session_id: task.session_id.clone(),
        account_id: source.account_id.clone(),
        repository_id: source.repository_id,
        repository: source.repository.clone(),
        delivery: Some(delivery.clone()),
        head_branch: branch,
        base_branch: configuration.base_branch.clone(),
        title,
        body,
        state: GithubPublicationState::Queued as i32,
        created_order: next_order(tx).await?,
        ..Default::default()
    };
    sqlx::query("INSERT INTO supertag_v2_github_publications(publication_id,task_id,tag_id,session_id,account_id,created_order,state,payload) VALUES($1,$2,$3,$4,$5,$6,$7,$8)")
        .bind(&value.publication_id).bind(&value.task_id).bind(&value.tag_id).bind(&value.session_id).bind(&value.account_id).bind(value.created_order).bind(i64::from(value.state)).bind(value.encode_to_vec()).execute(&mut **tx).await?;
    Ok(())
}

async fn sweep_in(tx: &mut Transaction<'_, Any>, now: i64) -> Result<()> {
    let after: i64 = sqlx::query_scalar(
        "SELECT last_order FROM supertag_v2_github_publication_sweep WHERE singleton=1",
    )
    .fetch_one(&mut **tx)
    .await?;
    let rows=sqlx::query("SELECT * FROM supertag_v2_github_publications WHERE state IN (1,2,3,4,5) AND created_order>$1 ORDER BY created_order LIMIT 256").bind(after).fetch_all(&mut **tx).await?;
    let next = if rows.len() == 256 {
        rows.last().unwrap().try_get::<i64, _>("created_order")?
    } else {
        0
    };
    sqlx::query("UPDATE supertag_v2_github_publication_sweep SET last_order=$1 WHERE singleton=1")
        .bind(next)
        .execute(&mut **tx)
        .await?;
    for row in rows {
        let mut value = decode(&row)?;
        let expired = row
            .try_get::<Option<i64>, _>("lease_expires_at_ms")?
            .is_some_and(|until| until <= now);
        if !eligible_in(tx, &value).await?
            || (value.cancel_requested && row.try_get::<i64, _>("recovery_only")? == 0)
        {
            value.cancel_requested = true;
            value.state = if value.state() == GithubPublicationState::Sending
                || value.state() == GithubPublicationState::Uncertain
                || row.try_get::<i64, _>("pushed")? == 1
            {
                GithubPublicationState::Uncertain
            } else {
                GithubPublicationState::Cancelled
            } as i32;
            value.reason = "publication was cancelled before further provider effects".into();
        } else if expired && value.state() == GithubPublicationState::Sending {
            value.state = GithubPublicationState::Uncertain as i32;
            value.reason = "provider outcome is unproved after publisher authority expired".into();
        } else if expired && value.state() == GithubPublicationState::Claimed {
            value.state = if row.try_get::<i64, _>("recovery_only")? == 1 {
                GithubPublicationState::Uncertain
            } else {
                GithubPublicationState::Queued
            } as i32;
        }
        if value.state() == GithubPublicationState::Queued {
            sqlx::query(
                "UPDATE supertag_v2_github_publications SET planned=0 WHERE publication_id=$1",
            )
            .bind(&value.publication_id)
            .execute(&mut **tx)
            .await?;
        }
        if let Some(approval) = &value.approval_id {
            let state: i64 =
                sqlx::query_scalar("SELECT state FROM supertag_v2_approvals WHERE approval_id=$1")
                    .bind(approval)
                    .fetch_one(&mut **tx)
                    .await?;
            if value.state() == GithubPublicationState::WaitingApproval && matches!(state, 3 | 4) {
                value.state = GithubPublicationState::Held as i32;
                value.reason = "publication approval was denied or expired".into();
            }
            if value.state() == GithubPublicationState::WaitingApproval && state == 2 {
                value.state = GithubPublicationState::Queued as i32;
                value.reason.clear();
            }
        }
        save(tx, &value).await?;
    }
    Ok(())
}

async fn owned_in(
    tx: &mut Transaction<'_, Any>,
    principal: &str,
    lease: &GithubPublicationLease,
    now: i64,
) -> Result<(AnyRow, GithubPublication)> {
    let account = publisher(principal)?;
    let row = row_in(tx, &lease.publication_id).await?;
    let value = decode(&row)?;
    if value.account_id != account
        || row.try_get::<Option<String>, _>("publisher")?.as_deref() != Some(principal)
        || row.try_get::<Option<String>, _>("lease_token")?.as_deref() != Some(&lease.lease_token)
    {
        return Err(StoreError::PermissionDenied);
    }
    if terminal(value.state())
        || row
            .try_get::<Option<i64>, _>("lease_expires_at_ms")?
            .is_none_or(|until| until <= now)
    {
        return Err(StoreError::FailedPrecondition(
            "publication lease is no longer live".into(),
        ));
    }
    if row.try_get::<i64, _>("recovery_only")? == 0
        && (!eligible_in(tx, &value).await? || value.cancel_requested)
    {
        return Err(StoreError::FailedPrecondition(
            "publication authority was revoked".into(),
        ));
    }
    Ok((row, value))
}

pub(crate) async fn approval_eligibility_in(
    tx: &mut Transaction<'_, Any>,
    approval: &Approval,
) -> Result<Option<bool>> {
    let row = sqlx::query("SELECT * FROM supertag_v2_github_publications WHERE approval_id=$1")
        .bind(&approval.approval_id)
        .fetch_optional(&mut **tx)
        .await?;
    let Some(row) = row else {
        return Ok(None);
    };
    let value = decode(&row)?;
    Ok(Some(
        approval.consumed_at_ms.is_some()
            || (!terminal(value.state())
                && !value.cancel_requested
                && eligible_in(tx, &value).await?),
    ))
}

async fn approval_in(
    tx: &mut Transaction<'_, Any>,
    value: &mut GithubPublication,
    now: i64,
) -> Result<bool> {
    let task = task_in(tx, &value.task_id).await?;
    let authority = external_effects::surface(
        task.policy_snapshot
            .as_ref()
            .ok_or(StoreError::PermissionDenied)?,
        &value.account_id,
        &format!("repository:{}", value.repository_id),
        ACTION,
    )?;
    if !authority.approval_required || value.pull_request.is_some() {
        return Ok(true);
    }
    if let Some(id) = &value.approval_id {
        let row = sqlx::query(
            "SELECT state,valid_until_ms FROM supertag_v2_approvals WHERE approval_id=$1",
        )
        .bind(id)
        .fetch_one(&mut **tx)
        .await?;
        return Ok(
            row.try_get::<i64, _>("state")? == ApprovalState::Approved as i64
                && row
                    .try_get::<Option<i64>, _>("valid_until_ms")?
                    .is_none_or(|until| until > now),
        );
    }
    let owner = crate::conversations::task_owner_in(tx, &task.task_id)
        .await?
        .ok_or(StoreError::PermissionDenied)?;
    if !owner.is_empty()
        && !authority.operators.is_empty()
        && !authority
            .operators
            .iter()
            .any(|id| owner == format!("operator:{id}"))
    {
        return Err(StoreError::PermissionDenied);
    }
    let delivery = value
        .delivery
        .as_ref()
        .ok_or_else(|| invalid("publication has no delivery"))?;
    let bundle = delivery
        .bundle
        .as_ref()
        .ok_or_else(|| invalid("publication has no bundle"))?;
    let arguments=crate::approvals::canonical_arguments(&serde_json::json!({"target":"surface","account_id":value.account_id,"repository_id":value.repository_id,"repository":value.repository,"head_branch":value.head_branch,"base_branch":value.base_branch,"head_commit":delivery.head_commit,"bundle_sha256":bundle.sha256,"bundle_bytes":bundle.byte_length,"title":value.title,"body":value.body}).to_string())?;
    let arguments_digest = format!("sha256:{:x}", Sha256::digest(arguments.as_bytes()));
    let id = Uuid::new_v4().to_string();
    let objective: Option<String> =
        sqlx::query_scalar("SELECT objective_id FROM supertag_v2_objective_tasks WHERE task_id=$1")
            .bind(&task.task_id)
            .fetch_optional(&mut **tx)
            .await?;
    let order = next_order(tx).await?;
    sqlx::query("INSERT INTO supertag_v2_approvals(approval_id,task_id,attempt_id,tag_id,session_id,objective_id,action,resource,canonical_arguments_json,arguments_digest,rule_digest,summary,operator_ids,state,requested_at_ms,requested_order) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,1,$14,$15)")
        .bind(&id).bind(&task.task_id).bind(task.attempt_id.as_deref().ok_or_else(||invalid("publication Task has no settled Attempt"))?).bind(&task.tag_id).bind(&task.session_id).bind(objective).bind(ACTION)
        .bind(format!("surface:{}/repository:{}",value.account_id,value.repository_id)).bind(arguments).bind(arguments_digest).bind(authority.digest)
        .bind(format!("Push verified commit {} and open a draft pull request into {} on {}",delivery.head_commit,value.base_branch,value.repository)).bind(serde_json::to_string(&authority.operators)?).bind(now).bind(order).execute(&mut **tx).await?;
    value.approval_id = Some(id);
    Ok(false)
}

async fn operation_in<T: Message>(
    tx: &mut Transaction<'_, Any>,
    principal: &str,
    operation: &str,
    kind: &str,
    input: &T,
) -> Result<(String, Option<GithubPublication>)> {
    name("publication operation", operation)?;
    let digest = policy::digest(kind, input);
    let row=sqlx::query("SELECT request_digest,response FROM supertag_v2_github_publication_operations WHERE principal=$1 AND operation_id=$2").bind(principal).bind(operation).fetch_optional(&mut **tx).await?;
    if let Some(row) = row {
        if row.try_get::<String, _>("request_digest")? != digest {
            return Err(StoreError::Conflict(
                "publication operation changed its request".into(),
            ));
        }
        return Ok((
            digest,
            Some(policy::decode(&row.try_get::<Vec<u8>, _>("response")?)?),
        ));
    }
    Ok((digest, None))
}
async fn receipt_in(
    tx: &mut Transaction<'_, Any>,
    principal: &str,
    operation: &str,
    digest: &str,
    value: &GithubPublication,
) -> Result<()> {
    sqlx::query("INSERT INTO supertag_v2_github_publication_operations(principal,operation_id,request_digest,publication_id,response) VALUES($1,$2,$3,$4,$5)").bind(principal).bind(operation).bind(digest).bind(&value.publication_id).bind(value.encode_to_vec()).execute(&mut **tx).await?;
    Ok(())
}

impl Store {
    pub async fn cancel_github_publication(
        &self,
        principal: &str,
        input: &CancelGithubPublicationRequest,
    ) -> Result<GithubPublication> {
        policy::operator(principal)?;
        let reason = input.reason.trim();
        if reason.is_empty() || reason.len() > 2000 {
            return Err(invalid(
                "publication cancellation requires a reason of at most 2000 bytes",
            ));
        }
        let (mut tx, _) = self.write().await?;
        let (digest, prior) =
            operation_in(&mut tx, principal, &input.operation_id, "cancel", input).await?;
        if let Some(prior) = prior {
            tx.commit().await?;
            return Ok(prior);
        }
        let row = row_in(&mut tx, &input.publication_id).await?;
        let mut value = decode(&row)?;
        if !crate::conversations::task_access_in(&mut tx, principal, &value.task_id).await? {
            return Err(StoreError::NotFound("publication was not found".into()));
        }
        if value.state() == GithubPublicationState::Published {
            return Err(StoreError::FailedPrecondition(
                "publication is already delivered".into(),
            ));
        }
        value.cancel_requested = true;
        value.reason = reason.into();
        value.state = if matches!(
            value.state(),
            GithubPublicationState::Sending | GithubPublicationState::Uncertain
        ) || row.try_get::<i64, _>("pushed")? == 1
        {
            GithubPublicationState::Uncertain
        } else {
            GithubPublicationState::Cancelled
        } as i32;
        save(&mut tx, &value).await?;
        receipt_in(&mut tx, principal, &input.operation_id, &digest, &value).await?;
        tx.commit().await?;
        Ok(value)
    }

    pub async fn record_github_publication_effect(
        &self,
        principal: &str,
        input: &RecordGithubPublicationEffectRequest,
    ) -> Result<GithubPublication> {
        publisher(principal)?;
        let lease = input
            .lease
            .as_ref()
            .ok_or_else(|| invalid("publication lease required"))?;
        if input.reason.len() > 2000 {
            return Err(invalid("publication reason exceeds 2000 bytes"));
        }
        let (mut tx, _) = self.write().await?;
        let now = self.execution_now_ms();
        sweep_in(&mut tx, now).await?;
        let (digest, prior) =
            operation_in(&mut tx, principal, &input.operation_id, "record", input).await?;
        if let Some(prior) = prior {
            tx.commit().await?;
            return Ok(prior);
        }
        let (row, mut value) = owned_in(&mut tx, principal, lease, now).await?;
        let read_only = row.try_get::<i64, _>("recovery_only")? == 1;
        let desired = GithubPublicationState::try_from(input.state)
            .map_err(|_| invalid("unknown publication state"))?;
        if input.phase != value.phase {
            return Err(StoreError::Conflict(
                "publication receipt has a different effect phase".into(),
            ));
        }
        match desired {
            GithubPublicationState::Queued => {
                if read_only
                    || value.state() != GithubPublicationState::Claimed
                    || value.phase() != GithubPublicationPhase::Inspect
                    || row.try_get::<i64, _>("pushed")? != 0
                    || input.reason.trim().is_empty()
                    || input.pull_request.is_some()
                    || input.pushed_commit.is_some()
                {
                    return Err(StoreError::FailedPrecondition(
                        "only an undispatched publication can retry discovery".into(),
                    ));
                }
            }
            GithubPublicationState::Claimed => {
                if read_only
                    || value.cancel_requested
                    || value.state() != GithubPublicationState::Sending
                    || value.phase() != GithubPublicationPhase::Push
                    || input.pull_request.is_some()
                    || input.pushed_commit.as_deref()
                        != value.delivery.as_ref().map(|d| d.head_commit.as_str())
                {
                    return Err(StoreError::FailedPrecondition(
                        "push requires a verified exact commit receipt".into(),
                    ));
                }
                sqlx::query(
                    "UPDATE supertag_v2_github_publications SET pushed=1 WHERE publication_id=$1",
                )
                .bind(&value.publication_id)
                .execute(&mut *tx)
                .await?;
            }
            GithubPublicationState::Published => {
                let receipt = input
                    .pull_request
                    .as_ref()
                    .filter(|r| exact_receipt(&value, r, true))
                    .ok_or_else(|| {
                        invalid("pull request receipt does not match the verified delivery")
                    })?;
                if !read_only
                    && (value.state() != GithubPublicationState::Sending
                        || !matches!(
                            value.phase(),
                            GithubPublicationPhase::Create | GithubPublicationPhase::Update
                        ))
                {
                    return Err(StoreError::FailedPrecondition(
                        "publication was not dispatched".into(),
                    ));
                }
                if value
                    .pull_request
                    .as_ref()
                    .is_some_and(|prior| prior.number != receipt.number)
                {
                    return Err(StoreError::Conflict(
                        "publication receipt changed its pull request".into(),
                    ));
                }
                let previous:Option<Vec<u8>>=sqlx::query_scalar("SELECT pull_request FROM supertag_v2_github_publication_sessions WHERE tag_id=$1 AND session_id=$2").bind(&value.tag_id).bind(&value.session_id).fetch_optional(&mut *tx).await?;
                if let Some(previous) = previous {
                    let previous: GithubPullRequestReceipt = policy::decode(&previous)?;
                    if previous.number != receipt.number {
                        return Err(StoreError::Conflict(
                            "Session already delivered to a different pull request".into(),
                        ));
                    }
                }
                sqlx::query("INSERT INTO supertag_v2_github_publication_sessions(tag_id,session_id,publication_id,pull_request) VALUES($1,$2,$3,$4) ON CONFLICT(tag_id,session_id) DO UPDATE SET publication_id=excluded.publication_id,pull_request=excluded.pull_request").bind(&value.tag_id).bind(&value.session_id).bind(&value.publication_id).bind(receipt.encode_to_vec()).execute(&mut *tx).await?;
                value.pull_request = Some(receipt.clone());
            }
            GithubPublicationState::Held | GithubPublicationState::Uncertain => {
                if desired == GithubPublicationState::Held
                    && value.state() == GithubPublicationState::Sending
                {
                    return Err(StoreError::FailedPrecondition(
                        "a dispatched provider effect requires proof or uncertainty".into(),
                    ));
                }
                if input.reason.trim().is_empty()
                    || input.pull_request.is_some()
                    || input.pushed_commit.is_some()
                {
                    return Err(invalid(
                        "an unresolved publication requires a reason without a success receipt",
                    ));
                }
                // A read-only observation cannot prove that an ambiguous write did
                // not occur. Keep it uncertain until an exact PR is observed.
                if read_only && desired == GithubPublicationState::Held {
                    return Err(StoreError::FailedPrecondition(
                        "ambiguous publication requires proof of its provider result".into(),
                    ));
                }
            }
            _ => return Err(invalid("invalid publication settlement state")),
        }
        value.state = desired as i32;
        value.reason = input.reason.clone();
        if matches!(
            desired,
            GithubPublicationState::Uncertain | GithubPublicationState::Queued
        ) {
            sqlx::query("UPDATE supertag_v2_github_publications SET retry_after_ms=$1 WHERE publication_id=$2").bind(now.saturating_add(60_000)).bind(&value.publication_id).execute(&mut *tx).await?;
        }

        if desired != GithubPublicationState::Claimed {
            sqlx::query("UPDATE supertag_v2_github_publications SET publisher=NULL,lease_token=NULL,lease_expires_at_ms=NULL WHERE publication_id=$1").bind(&value.publication_id).execute(&mut *tx).await?;
        }
        save(&mut tx, &value).await?;
        receipt_in(&mut tx, principal, &input.operation_id, &digest, &value).await?;
        tx.commit().await?;
        Ok(value)
    }
    pub async fn sweep_github_publications(&self) -> Result<()> {
        let (mut tx, _) = self.write().await?;
        sweep_in(&mut tx, self.execution_now_ms()).await?;
        tx.commit().await?;
        Ok(())
    }

    pub async fn plan_github_publication(
        &self,
        principal: &str,
        input: &PlanGithubPublicationRequest,
    ) -> Result<GithubPublication> {
        publisher(principal)?;
        let lease = input
            .lease
            .as_ref()
            .ok_or_else(|| invalid("publication lease required"))?;
        let (mut tx, _) = self.write().await?;
        let now = self.execution_now_ms();
        sweep_in(&mut tx, now).await?;
        let (digest, prior) =
            operation_in(&mut tx, principal, &input.operation_id, "plan", input).await?;
        if let Some(prior) = prior {
            tx.commit().await?;
            return Ok(prior);
        }
        let (row, mut value) = owned_in(&mut tx, principal, lease, now).await?;
        let resuming =
            value.phase() == GithubPublicationPhase::Push && row.try_get::<i64, _>("pushed")? == 1;
        if row.try_get::<i64, _>("recovery_only")? == 1
            || value.state() != GithubPublicationState::Claimed
            || (value.phase() != GithubPublicationPhase::Inspect && !resuming)
            || value.cancel_requested
        {
            return Err(StoreError::FailedPrecondition(
                "publication cannot authorize another provider effect".into(),
            ));
        }
        if resuming {
            if input.pushed_commit.as_deref()
                != value
                    .delivery
                    .as_ref()
                    .map(|delivery| delivery.head_commit.as_str())
            {
                return Err(StoreError::FailedPrecondition(
                    "resuming requires fresh proof of the exact remote commit".into(),
                ));
            }
        } else if input.pushed_commit.is_some() {
            return Err(invalid("unexpected push proof before dispatch"));
        }
        if value.approval_id.is_some() && value.pull_request.is_none() && input.existing.is_some() {
            value.state = GithubPublicationState::Held as i32;
            value.reason =
                "pull request history changed while first-publication approval was pending".into();
            sqlx::query("UPDATE supertag_v2_github_publications SET publisher=NULL,lease_token=NULL,lease_expires_at_ms=NULL WHERE publication_id=$1").bind(&value.publication_id).execute(&mut *tx).await?;
            save(&mut tx, &value).await?;
            receipt_in(&mut tx, principal, &input.operation_id, &digest, &value).await?;
            tx.commit().await?;
            return Ok(value);
        }
        if let Some(existing) = &input.existing {
            if !exact_receipt(&value, existing, false) {
                return Err(invalid(
                    "observed pull request does not match accepted publication",
                ));
            }
            if let Some(prior) = &value.pull_request
                && prior.number != existing.number
            {
                return Err(StoreError::Conflict(
                    "publication changed its pull request".into(),
                ));
            }
            value.pull_request = Some(existing.clone());
        } else if value.pull_request.is_some() {
            return Err(StoreError::Conflict(
                "publication lost its previously observed pull request".into(),
            ));
        }
        let recorded:Option<Vec<u8>>=sqlx::query_scalar("SELECT pull_request FROM supertag_v2_github_publication_sessions WHERE tag_id=$1 AND session_id=$2").bind(&value.tag_id).bind(&value.session_id).fetch_optional(&mut *tx).await?;
        if let Some(recorded) = recorded {
            let recorded: GithubPullRequestReceipt = policy::decode(&recorded)?;
            if value
                .pull_request
                .as_ref()
                .is_none_or(|receipt| receipt.number != recorded.number)
            {
                return Err(StoreError::Conflict(
                    "Session publication differs from its recorded pull request".into(),
                ));
            }
        }
        if !approval_in(&mut tx, &mut value, now).await? {
            value.state = GithubPublicationState::WaitingApproval as i32;
            value.reason =
                "waiting for approval of this repository, branch and exact commit".into();
            sqlx::query("UPDATE supertag_v2_github_publications SET lease_expires_at_ms=NULL,publisher=NULL,lease_token=NULL WHERE publication_id=$1").bind(&value.publication_id).execute(&mut *tx).await?;
        }
        sqlx::query("UPDATE supertag_v2_github_publications SET planned=1 WHERE publication_id=$1")
            .bind(&value.publication_id)
            .execute(&mut *tx)
            .await?;
        save(&mut tx, &value).await?;
        receipt_in(&mut tx, principal, &input.operation_id, &digest, &value).await?;
        tx.commit().await?;
        Ok(value)
    }

    pub async fn begin_github_publication_effect(
        &self,
        principal: &str,
        input: &BeginGithubPublicationEffectRequest,
    ) -> Result<GithubPublication> {
        publisher(principal)?;
        let lease = input
            .lease
            .as_ref()
            .ok_or_else(|| invalid("publication lease required"))?;
        let (mut tx, _) = self.write().await?;
        let now = self.execution_now_ms();
        sweep_in(&mut tx, now).await?;
        let (digest, prior) =
            operation_in(&mut tx, principal, &input.operation_id, "begin", input).await?;
        if let Some(prior) = prior {
            tx.commit().await?;
            return Ok(prior);
        }
        let (row, mut value) = owned_in(&mut tx, principal, lease, now).await?;
        if row.try_get::<i64, _>("recovery_only")? == 1
            || row.try_get::<i64, _>("planned")? != 1
            || value.state() != GithubPublicationState::Claimed
            || value.cancel_requested
        {
            return Err(StoreError::FailedPrecondition(
                "publication has no current authority to write".into(),
            ));
        }
        let pushed = row.try_get::<i64, _>("pushed")? == 1;
        let phase = GithubPublicationPhase::try_from(input.phase)
            .map_err(|_| invalid("unknown publication phase"))?;
        let valid = match phase {
            GithubPublicationPhase::Push => {
                !pushed
                    && value.phase() == GithubPublicationPhase::Inspect
                    && ready_in(&mut tx, &value).await?
            }
            GithubPublicationPhase::Create => pushed && value.pull_request.is_none(),
            GithubPublicationPhase::Update => pushed && value.pull_request.is_some(),
            GithubPublicationPhase::Inspect => false,
        };
        if !valid {
            return Err(StoreError::FailedPrecondition(
                "publication effect is out of order".into(),
            ));
        }
        if !approval_in(&mut tx, &mut value, now).await? {
            return Err(StoreError::FailedPrecondition(
                "publication approval is missing or expired".into(),
            ));
        }
        if let Some(approval) = &value.approval_id {
            sqlx::query("UPDATE supertag_v2_approvals SET consumed_at_ms=COALESCE(consumed_at_ms,$1) WHERE approval_id=$2 AND state=2").bind(now).bind(approval).execute(&mut *tx).await?;
        }
        value.phase = phase as i32;
        value.state = GithubPublicationState::Sending as i32;
        value.reason.clear();
        save(&mut tx, &value).await?;
        receipt_in(&mut tx, principal, &input.operation_id, &digest, &value).await?;
        tx.commit().await?;
        Ok(value)
    }
    pub async fn get_github_publication(
        &self,
        principal: &str,
        input: &GetGithubPublicationRequest,
    ) -> Result<GithubPublication> {
        policy::operator(principal)?;
        let mut tx = self.pool.begin().await?;
        let value = decode(&row_in(&mut tx, &input.publication_id).await?)?;
        if !crate::conversations::task_access_in(&mut tx, principal, &value.task_id).await? {
            return Err(StoreError::NotFound("publication was not found".into()));
        }
        Ok(value)
    }
    pub async fn list_github_publications(
        &self,
        principal: &str,
        input: &ListGithubPublicationsRequest,
    ) -> Result<ListGithubPublicationsResponse> {
        policy::operator(principal)?;
        if input.limit > 100 || input.before_order < 0 {
            return Err(invalid("invalid publication page"));
        }
        let limit = if input.limit == 0 { 50 } else { input.limit } as usize;
        let mut tx = self.pool.begin().await?;
        let rows=sqlx::query("SELECT p.* FROM supertag_v2_github_publications p WHERE ($1='' OR p.task_id=$1) AND ($2=0 OR p.created_order<$2) AND EXISTS(SELECT 1 FROM supertag_v2_task_audience a WHERE a.task_id=p.task_id AND a.owner IN ('',$3)) ORDER BY p.created_order DESC LIMIT $4")
            .bind(&input.task_id).bind(input.before_order).bind(principal).bind((limit+1) as i64).fetch_all(&mut *tx).await?;
        let mut bytes = 0;
        let mut response = ListGithubPublicationsResponse::default();
        for row in rows {
            let value = decode(&row)?;
            bytes += value.encoded_len() + 16;
            if response.publications.len() == limit || bytes > MAX_MESSAGE_BYTES - 1024 {
                response.next_before_order = response
                    .publications
                    .last()
                    .map_or(0, |last| last.created_order);
                break;
            }
            response.publications.push(value);
        }
        Ok(response)
    }
    pub async fn claim_github_publication(
        &self,
        principal: &str,
        input: &ClaimGithubPublicationRequest,
    ) -> Result<ClaimGithubPublicationResponse> {
        let account = publisher(principal)?;
        name("publication claim operation", &input.operation_id)?;
        let (mut tx, _) = self.write().await?;
        let now = self.execution_now_ms();
        sweep_in(&mut tx, now).await?;
        let prior:Option<Vec<u8>>=sqlx::query_scalar("SELECT response FROM supertag_v2_github_publication_claims WHERE publisher=$1 AND operation_id=$2").bind(principal).bind(&input.operation_id).fetch_optional(&mut *tx).await?;
        if let Some(prior) = prior {
            let response = policy::decode(&prior)?;
            tx.commit().await?;
            return Ok(response);
        }
        let mut after = 0;
        let mut selected = None;
        loop {
            let rows=sqlx::query("SELECT p.* FROM supertag_v2_github_publications p WHERE p.account_id=$1 AND p.state IN (1,5) AND p.retry_after_ms<=$2 AND p.created_order>$3 AND (p.lease_expires_at_ms IS NULL OR p.lease_expires_at_ms<=$2) AND NOT EXISTS(SELECT 1 FROM supertag_v2_github_publications older WHERE older.tag_id=p.tag_id AND older.session_id=p.session_id AND older.created_order<p.created_order AND older.state IN (1,2,3,4,5)) ORDER BY p.created_order LIMIT 128").bind(account).bind(now).bind(after).fetch_all(&mut *tx).await?;
            let count = rows.len();
            for row in rows {
                let value = decode(&row)?;
                after = value.created_order;
                if value.state() == GithubPublicationState::Uncertain
                    || (eligible_in(&mut tx, &value).await? && ready_in(&mut tx, &value).await?)
                {
                    selected = Some(value);
                    break;
                }
            }
            if selected.is_some() || count < 128 {
                break;
            }
        }
        let Some(mut value) = selected else {
            tx.commit().await?;
            return Ok(ClaimGithubPublicationResponse::default());
        };
        let recovery = value.state() == GithubPublicationState::Uncertain;
        value.state = GithubPublicationState::Claimed as i32;
        let token = Uuid::new_v4().to_string();
        save(&mut tx, &value).await?;
        sqlx::query("UPDATE supertag_v2_github_publications SET publisher=$1,lease_token=$2,lease_expires_at_ms=$3,recovery_only=$4,planned=0 WHERE publication_id=$5").bind(principal).bind(&token).bind(now.saturating_add(LEASE_MS)).bind(i64::from(recovery)).bind(&value.publication_id).execute(&mut *tx).await?;
        let response = ClaimGithubPublicationResponse {
            publication: Some(value.clone()),
            lease_token: token,
            valid_for_ms: LEASE_MS as u64,
            read_only: recovery,
        };
        sqlx::query("INSERT INTO supertag_v2_github_publication_claims(publisher,operation_id,publication_id,response) VALUES($1,$2,$3,$4)").bind(principal).bind(&input.operation_id).bind(&value.publication_id).bind(response.encode_to_vec()).execute(&mut *tx).await?;
        tx.commit().await?;
        Ok(response)
    }
    pub async fn renew_github_publication(
        &self,
        principal: &str,
        input: &GithubPublicationLease,
    ) -> Result<ClaimGithubPublicationResponse> {
        let (mut tx, _) = self.write().await?;
        let now = self.execution_now_ms();
        sweep_in(&mut tx, now).await?;
        let (row, value) = owned_in(&mut tx, principal, input, now).await?;
        let read_only = row.try_get::<i64, _>("recovery_only")? == 1;
        if value.cancel_requested && !read_only {
            return Err(StoreError::FailedPrecondition(
                "publication cancellation requested".into(),
            ));
        }
        let mut until = now.saturating_add(LEASE_MS);
        if !read_only && let Some(approval) = &value.approval_id {
            let valid: Option<i64> = sqlx::query_scalar(
                "SELECT valid_until_ms FROM supertag_v2_approvals WHERE approval_id=$1",
            )
            .bind(approval)
            .fetch_one(&mut *tx)
            .await?;
            if let Some(valid) = valid {
                until = until.min(valid);
            }
        }
        if until <= now {
            return Err(StoreError::FailedPrecondition(
                "publication approval expired".into(),
            ));
        }
        sqlx::query("UPDATE supertag_v2_github_publications SET lease_expires_at_ms=$1 WHERE publication_id=$2").bind(until).bind(&value.publication_id).execute(&mut *tx).await?;
        tx.commit().await?;
        Ok(ClaimGithubPublicationResponse {
            publication: Some(value),
            lease_token: input.lease_token.clone(),
            valid_for_ms: (until - now) as u64,
            read_only,
        })
    }
}

use crate::ControlPlane;
use tonic::{Request, Response, Status};
impl ControlPlane {
    pub fn github_publications_service(
        &self,
    ) -> github_publications_server::GithubPublicationsServer<Self> {
        github_publications_server::GithubPublicationsServer::new(self.clone())
            .max_decoding_message_size(MAX_MESSAGE_BYTES)
            .max_encoding_message_size(MAX_MESSAGE_BYTES)
    }
}
#[tonic::async_trait]
impl github_publications_server::GithubPublications for ControlPlane {
    async fn get(
        &self,
        request: Request<GetGithubPublicationRequest>,
    ) -> std::result::Result<Response<GithubPublication>, Status> {
        let principal = self.principal(&request, "operator:")?;
        Ok(Response::new(
            self.store
                .get_github_publication(&principal, request.get_ref())
                .await?,
        ))
    }
    async fn list(
        &self,
        request: Request<ListGithubPublicationsRequest>,
    ) -> std::result::Result<Response<ListGithubPublicationsResponse>, Status> {
        let principal = self.principal(&request, "operator:")?;
        Ok(Response::new(
            self.store
                .list_github_publications(&principal, request.get_ref())
                .await?,
        ))
    }
    async fn cancel(
        &self,
        request: Request<CancelGithubPublicationRequest>,
    ) -> std::result::Result<Response<GithubPublication>, Status> {
        let principal = self.principal(&request, "operator:")?;
        Ok(Response::new(
            self.store
                .cancel_github_publication(&principal, request.get_ref())
                .await?,
        ))
    }
}
impl ControlPlane {
    pub fn github_publisher_service(&self) -> github_publisher_server::GithubPublisherServer<Self> {
        github_publisher_server::GithubPublisherServer::new(self.clone())
            .max_decoding_message_size(MAX_MESSAGE_BYTES)
            .max_encoding_message_size(MAX_MESSAGE_BYTES)
    }
}
#[tonic::async_trait]
impl github_publisher_server::GithubPublisher for ControlPlane {
    async fn claim(
        &self,
        request: Request<ClaimGithubPublicationRequest>,
    ) -> std::result::Result<Response<ClaimGithubPublicationResponse>, Status> {
        let principal = self.principal(&request, "publisher:github/")?;
        Ok(Response::new(
            self.store
                .claim_github_publication(&principal, request.get_ref())
                .await?,
        ))
    }
    async fn renew(
        &self,
        request: Request<GithubPublicationLease>,
    ) -> std::result::Result<Response<ClaimGithubPublicationResponse>, Status> {
        let principal = self.principal(&request, "publisher:github/")?;
        Ok(Response::new(
            self.store
                .renew_github_publication(&principal, request.get_ref())
                .await?,
        ))
    }
    async fn plan(
        &self,
        request: Request<PlanGithubPublicationRequest>,
    ) -> std::result::Result<Response<GithubPublication>, Status> {
        let principal = self.principal(&request, "publisher:github/")?;
        Ok(Response::new(
            self.store
                .plan_github_publication(&principal, request.get_ref())
                .await?,
        ))
    }
    async fn begin_effect(
        &self,
        request: Request<BeginGithubPublicationEffectRequest>,
    ) -> std::result::Result<Response<GithubPublication>, Status> {
        let principal = self.principal(&request, "publisher:github/")?;
        Ok(Response::new(
            self.store
                .begin_github_publication_effect(&principal, request.get_ref())
                .await?,
        ))
    }
    async fn record_effect(
        &self,
        request: Request<RecordGithubPublicationEffectRequest>,
    ) -> std::result::Result<Response<GithubPublication>, Status> {
        let principal = self.principal(&request, "publisher:github/")?;
        Ok(Response::new(
            self.store
                .record_github_publication_effect(&principal, request.get_ref())
                .await?,
        ))
    }
}
