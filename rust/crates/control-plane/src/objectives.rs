//! Durable Objective lifecycle. Every mutation and execution hook shares the Store write lock.

use std::collections::BTreeMap;

use prost::Message;
use sha2::{Digest, Sha256};
use sqlx::{Any, Row, Transaction, any::AnyRow};
use supertag_protocol::v2::*;
use tonic::{Request, Response, Status};
use uuid::Uuid;

use crate::store::{HostAuthority, Result, insert_task, lease_is_live, name, owned, text};
use crate::{ControlPlane, Store, StoreError, objective_limits as limits};

struct Record {
    value: Objective,
    limits: limits::ObjectiveLimits,
    updated_at_ms: i64,
    cancelled_at_ms: Option<i64>,
    cancellation_reason: Option<String>,
    completion_summary: Option<String>,
    idle_wake_count: i64,
}

impl Record {
    fn closed(&self) -> bool {
        matches!(self.value.status, value if value == ObjectiveStatus::Completed as i32 || value == ObjectiveStatus::Cancelled as i32)
    }

    fn change_status(&mut self, status: ObjectiveStatus, now_ms: i64) {
        if self.value.status != status as i32 {
            self.value.status = status as i32;
            self.limits.status = domain_status(status);
            self.changed(now_ms);
        }
    }

    fn changed(&mut self, now_ms: i64) {
        self.value.revision += 1;
        self.updated_at_ms = now_ms;
    }
}

fn invalid(message: &str) -> StoreError {
    StoreError::InvalidArgument(message.into())
}
fn refused(message: &str) -> StoreError {
    StoreError::FailedPrecondition(message.into())
}

fn timestamp(value: i64) -> Result<limits::Timestamp> {
    limits::Timestamp::from_millis(value)
        .ok_or_else(|| invalid("timestamp is outside the supported range"))
}

fn domain_status(value: ObjectiveStatus) -> limits::ObjectiveStatus {
    match value {
        ObjectiveStatus::Working => limits::ObjectiveStatus::Working,
        ObjectiveStatus::Blocked => limits::ObjectiveStatus::Blocked,
        ObjectiveStatus::Limited => limits::ObjectiveStatus::Limited,
        ObjectiveStatus::ReadyForReview => limits::ObjectiveStatus::ReadyForReview,
        ObjectiveStatus::Completed => limits::ObjectiveStatus::Completed,
        ObjectiveStatus::Cancelled => limits::ObjectiveStatus::Cancelled,
        ObjectiveStatus::Unspecified => limits::ObjectiveStatus::Working,
    }
}

fn amount(value: u64) -> Result<i64> {
    if value > 9_007_199_254_740_991 {
        return Err(invalid("minor units must be a nonnegative safe integer"));
    }
    Ok(value as i64)
}

fn currency(value: &str) -> Result<()> {
    if value.len() != 3 || !value.bytes().all(|byte| byte.is_ascii_uppercase()) {
        return Err(invalid(
            "currency must contain three uppercase ASCII letters",
        ));
    }
    Ok(())
}

fn operator(principal: &str) -> Result<()> {
    name("operator principal", principal)?;
    if principal
        .strip_prefix("operator:")
        .is_none_or(str::is_empty)
    {
        return Err(StoreError::PermissionDenied);
    }
    Ok(())
}

fn digest(kind: &str, request: &impl Message) -> String {
    let mut hash = Sha256::new();
    hash.update(kind);
    hash.update([0]);
    hash.update(request.encode_to_vec());
    format!("{:x}", hash.finalize())
}

fn record_row(row: &AnyRow) -> Result<Record> {
    let status = ObjectiveStatus::try_from(row.try_get::<i64, _>("status")? as i32)
        .map_err(|_| refused("stored Objective status is invalid"))?;
    if status == ObjectiveStatus::Unspecified {
        return Err(refused("stored Objective status is unspecified"));
    }
    let deadline_ms: Option<i64> = row.try_get("deadline_ms")?;
    let paused_at_ms: Option<i64> = row.try_get("paused_at_ms")?;
    let created_at_ms: i64 = row.try_get("created_at_ms")?;
    let state: limits::LimitState =
        serde_json::from_str(&row.try_get::<String, _>("limit_state")?)?;
    let budget_limit_minor = row
        .try_get::<Option<i64>, _>("budget_limit_minor")?
        .map(|value| value as u64);
    let budget_currency: Option<String> = row.try_get("budget_currency")?;
    Ok(Record {
        value: Objective {
            objective_id: row.try_get("objective_id")?,
            owner_tag_id: row.try_get("owner_tag_id")?,
            session_id: row.try_get("session_id")?,
            outcome: row.try_get("outcome")?,
            ongoing: row.try_get::<i64, _>("ongoing")? == 1,
            starting_task_id: row
                .try_get::<Option<String>, _>("starting_task_id")?
                .unwrap_or_default(),
            status: status as i32,
            revision: row.try_get::<i64, _>("revision")? as u64,
            deadline_ms,
            budget_limit_minor,
            budget_currency: budget_currency.clone(),
            paused_at_ms,
            reported_spend_minor: state
                .reported_spend
                .as_ref()
                .map(|value| value.spend.amount_minor),
            team_id: row.try_get("team_id")?,
        },
        limits: limits::ObjectiveLimits {
            status: domain_status(status),
            created_at: Some(timestamp(created_at_ms)?),
            deadline: deadline_ms.map(timestamp).transpose()?,
            budget_limit_minor,
            budget_currency,
            paused_at: paused_at_ms.map(timestamp).transpose()?,
            state,
        },
        updated_at_ms: row.try_get("updated_at_ms")?,
        cancelled_at_ms: row.try_get("cancelled_at_ms")?,
        cancellation_reason: row.try_get("cancellation_reason")?,
        completion_summary: row.try_get("completion_summary")?,
        idle_wake_count: row.try_get("idle_wake_count")?,
    })
}

async fn get_in(tx: &mut Transaction<'_, Any>, id: &str) -> Result<Record> {
    let row = sqlx::query("SELECT * FROM supertag_v2_objectives WHERE objective_id = $1")
        .bind(id)
        .fetch_optional(&mut **tx)
        .await?
        .ok_or_else(|| StoreError::NotFound("Objective was not found".into()))?;
    record_row(&row)
}

async fn save_in(tx: &mut Transaction<'_, Any>, record: &Record) -> Result<()> {
    sqlx::query("UPDATE supertag_v2_objectives SET status=$1, revision=$2, deadline_ms=$3, budget_limit_minor=$4, budget_currency=$5, paused_at_ms=$6, cancelled_at_ms=$7, cancellation_reason=$8, completion_summary=$9, limit_state=$10, updated_at_ms=$11, starting_task_id=$12, idle_wake_count=$14 WHERE objective_id=$13")
        .bind(record.value.status as i64).bind(record.value.revision as i64).bind(record.value.deadline_ms)
        .bind(record.value.budget_limit_minor.map(|value| value as i64)).bind(&record.value.budget_currency)
        .bind(record.value.paused_at_ms).bind(record.cancelled_at_ms).bind(&record.cancellation_reason).bind(&record.completion_summary)
        .bind(serde_json::to_string(&record.limits.state)?).bind(record.updated_at_ms).bind(&record.value.starting_task_id).bind(&record.value.objective_id).bind(record.idle_wake_count)
        .execute(&mut **tx).await?;
    Ok(())
}

async fn replay_in(
    tx: &mut Transaction<'_, Any>,
    principal: &str,
    operation_id: &str,
    request_digest: &str,
) -> Result<Option<Objective>> {
    if let Some(row) = sqlx::query("SELECT objective_id, request_digest FROM supertag_v2_objective_operations WHERE principal=$1 AND operation_id=$2")
        .bind(principal).bind(operation_id).fetch_optional(&mut **tx).await? {
        if row.try_get::<String, _>("request_digest")? != request_digest {
            return Err(StoreError::Conflict("operation ID was used with a different Objective mutation".into()));
        }
        return Ok(Some(get_in(tx, &row.try_get::<String, _>("objective_id")?).await?.value));
    }
    Ok(None)
}

async fn receipt_in(
    tx: &mut Transaction<'_, Any>,
    principal: &str,
    operation_id: &str,
    request_digest: &str,
    objective: &Objective,
) -> Result<()> {
    sqlx::query("INSERT INTO supertag_v2_objective_operations (principal,operation_id,request_digest,objective_id) VALUES ($1,$2,$3,$4)")
        .bind(principal).bind(operation_id).bind(request_digest).bind(&objective.objective_id).execute(&mut **tx).await?;
    Ok(())
}

async fn next_order(tx: &mut Transaction<'_, Any>) -> Result<i64> {
    Ok(sqlx::query_scalar("UPDATE supertag_v2_write_order SET revision=revision+1 WHERE singleton=1 RETURNING revision").fetch_one(&mut **tx).await?)
}

async fn internal_turn_in(
    tx: &mut Transaction<'_, Any>,
    record: &Record,
    key: &str,
    prompt: &str,
    kind: &str,
    now_ms: i64,
) -> Result<()> {
    let prior: Option<String> = sqlx::query_scalar(
        "SELECT task_id FROM supertag_v2_objective_notices WHERE objective_id=$1 AND notice_key=$2",
    )
    .bind(&record.value.objective_id)
    .bind(key)
    .fetch_optional(&mut **tx)
    .await?;
    if prior.is_some() || record.closed() {
        return Ok(());
    }
    let order = next_order(tx).await?;
    let task = insert_task(
        tx,
        order,
        &record.value.owner_tag_id,
        &record.value.session_id,
        prompt,
    )
    .await?;
    // Limit notices communicate exhausted authority; they never grant a fresh work budget.
    if kind == "notice" && limits::admission_blocker(&record.limits, timestamp(now_ms)?).is_some() {
        sqlx::query("UPDATE supertag_v2_tasks SET allowed_actions='[]' WHERE task_id=$1")
            .bind(&task.task_id)
            .execute(&mut **tx)
            .await?;
    }
    sqlx::query(
        "INSERT INTO supertag_v2_objective_tasks (task_id,objective_id,kind) VALUES ($1,$2,$3)",
    )
    .bind(&task.task_id)
    .bind(&record.value.objective_id)
    .bind(kind)
    .execute(&mut **tx)
    .await?;
    sqlx::query("INSERT INTO supertag_v2_objective_notices (objective_id,notice_key,task_id) VALUES ($1,$2,$3)")
        .bind(&record.value.objective_id).bind(key).bind(&task.task_id).execute(&mut **tx).await?;
    Ok(())
}

async fn cancel_open_in(
    tx: &mut Transaction<'_, Any>,
    objective_id: &str,
    except: Option<&str>,
) -> Result<()> {
    // Preserve cleanup_pending: cancellation is not acknowledgement that an adapter stopped.
    sqlx::query("UPDATE supertag_v2_tasks SET state=$1 WHERE task_id IN (SELECT task_id FROM supertag_v2_objective_tasks WHERE objective_id=$2) AND state IN ($3,$4,$5,$6) AND ($7 IS NULL OR task_id<>$7)")
        .bind(TaskState::Cancelled as i64).bind(objective_id).bind(TaskState::Queued as i64).bind(TaskState::Claimed as i64)
        .bind(TaskState::Running as i64).bind(TaskState::Uncertain as i64).bind(except).execute(&mut **tx).await?;
    Ok(())
}

impl Store {
    pub async fn create_objective(
        &self,
        principal: &str,
        input: &CreateObjectiveRequest,
    ) -> Result<Objective> {
        operator(principal)?;
        name("operation ID", &input.operation_id)?;
        name("Objective ID", &input.objective_id)?;
        name("owner Tag ID", &input.owner_tag_id)?;
        text("outcome", &input.outcome, 65_536)?;
        if input.outcome.trim().is_empty() {
            return Err(invalid("outcome is required"));
        }
        if let Some(deadline) = input.deadline_ms {
            timestamp(deadline)?;
        }
        if let Some(limit) = input.budget_limit_minor {
            amount(limit)?;
        }
        if let Some(unit) = &input.budget_currency {
            currency(unit)?;
            if input.budget_limit_minor.is_none() {
                return Err(invalid("budget currency requires a limit"));
            }
        }
        let fingerprint = digest("create", input);
        let (mut tx, order) = self.write().await?;
        let now_ms = self.execution_now_ms();
        if let Some(prior) =
            replay_in(&mut tx, principal, &input.operation_id, &fingerprint).await?
        {
            tx.commit().await?;
            return Ok(prior);
        }
        let exists: Option<String> = sqlx::query_scalar(
            "SELECT objective_id FROM supertag_v2_objectives WHERE objective_id=$1",
        )
        .bind(&input.objective_id)
        .fetch_optional(&mut *tx)
        .await?;
        if exists.is_some() {
            return Err(StoreError::Conflict("Objective ID already exists".into()));
        }
        let tag: Option<String> =
            sqlx::query_scalar("SELECT tag_id FROM supertag_v2_tags WHERE tag_id=$1")
                .bind(&input.owner_tag_id)
                .fetch_optional(&mut *tx)
                .await?;
        if tag.is_none() {
            return Err(StoreError::NotFound("owner Tag was not found".into()));
        }
        let team_id = match &input.team_id {
            Some(team) => Some(
                crate::teams::team_by_reference_in(&mut tx, team)
                    .await?
                    .team_id,
            ),
            None => None,
        };
        let session_id = Uuid::new_v4().to_string();
        let mut state = limits::LimitState::default();
        if let Some(deadline) = input.deadline_ms {
            state.deadline_set_at = Some(limits::DeadlineObservation {
                deadline: timestamp(deadline)?,
                at: timestamp(now_ms)?,
            });
        }
        sqlx::query("INSERT INTO supertag_v2_objectives (objective_id,owner_tag_id,session_id,outcome,ongoing,status,revision,deadline_ms,budget_limit_minor,budget_currency,limit_state,created_at_ms,updated_at_ms,team_id) VALUES ($1,$2,$3,$4,$5,$6,1,$7,$8,$9,$10,$11,$11,$12)")
            .bind(&input.objective_id).bind(&input.owner_tag_id).bind(&session_id).bind(&input.outcome).bind(i64::from(input.ongoing)).bind(ObjectiveStatus::Working as i64)
            .bind(input.deadline_ms).bind(input.budget_limit_minor.map(|value| value as i64)).bind(&input.budget_currency).bind(serde_json::to_string(&state)?).bind(now_ms).bind(team_id).execute(&mut *tx).await?;
        sqlx::query("INSERT INTO supertag_v2_objective_sessions (tag_id,session_id,objective_id) VALUES ($1,$2,$3)")
            .bind(&input.owner_tag_id).bind(&session_id).bind(&input.objective_id).execute(&mut *tx).await?;
        let prompt = format!(
            "The Objective just started: plan the work, then start it.\n\n{}\n\n{}",
            input.outcome,
            if input.ongoing {
                "This responsibility is ongoing. An operator must end it; completing an assessment does not complete the Objective."
            } else {
                "When the outcome is met, report ready_for_review or completed with your result."
            }
        );
        let task = insert_task(&mut tx, order, &input.owner_tag_id, &session_id, &prompt).await?;
        objective_link_task_in(&mut tx, &task).await?;
        sqlx::query("UPDATE supertag_v2_objectives SET starting_task_id=$1 WHERE objective_id=$2")
            .bind(&task.task_id)
            .bind(&input.objective_id)
            .execute(&mut *tx)
            .await?;
        let record = get_in(&mut tx, &input.objective_id).await?;
        receipt_in(
            &mut tx,
            principal,
            &input.operation_id,
            &fingerprint,
            &record.value,
        )
        .await?;
        // No warning sweep runs inside creation: accepting the starting Task is its own result.
        tx.commit().await?;
        Ok(record.value)
    }

    pub async fn get_objective(&self, objective_id: &str) -> Result<Objective> {
        name("Objective ID", objective_id)?;
        let row = sqlx::query("SELECT * FROM supertag_v2_objectives WHERE objective_id=$1")
            .bind(objective_id)
            .fetch_optional(&self.pool)
            .await?
            .ok_or_else(|| StoreError::NotFound("Objective was not found".into()))?;
        Ok(record_row(&row)?.value)
    }

    pub async fn list_objectives(&self, input: &ListObjectivesRequest) -> Result<Vec<Objective>> {
        if !input.after_id.is_empty() {
            name("Objective cursor", &input.after_id)?;
        }
        // Outcomes may be 64 KiB; bound the complete gRPC response below one MiB.
        let count = if input.limit == 0 {
            12
        } else {
            input.limit.min(12)
        } as i64;
        sqlx::query("SELECT * FROM supertag_v2_objectives WHERE objective_id>$1 ORDER BY objective_id LIMIT $2")
            .bind(&input.after_id).bind(count).fetch_all(&self.pool).await?.iter().map(|row| Ok(record_row(row)?.value)).collect()
    }

    pub async fn set_objective_limits(
        &self,
        principal: &str,
        input: &SetObjectiveLimitsRequest,
    ) -> Result<Objective> {
        operator(principal)?;
        name("operation ID", &input.operation_id)?;
        name("Objective ID", &input.objective_id)?;
        if input.clear_deadline && input.deadline_ms.is_some() {
            return Err(invalid("set or clear the deadline, not both"));
        }
        if input.clear_budget
            && (input.budget_limit_minor.is_some() || input.budget_currency.is_some())
        {
            return Err(invalid("set or clear the budget, not both"));
        }
        if let Some(value) = input.deadline_ms {
            timestamp(value)?;
        }
        if let Some(value) = input.budget_limit_minor {
            amount(value)?;
        }
        if let Some(value) = &input.budget_currency {
            currency(value)?;
        }
        let fingerprint = digest("limits", input);
        let (mut tx, _) = self.write().await?;
        let now_ms = self.execution_now_ms();
        if let Some(prior) =
            replay_in(&mut tx, principal, &input.operation_id, &fingerprint).await?
        {
            tx.commit().await?;
            return Ok(prior);
        }
        let mut record = get_in(&mut tx, &input.objective_id).await?;
        if record.closed() {
            return Err(refused("a closed Objective's limits cannot change"));
        }
        if input
            .expected_revision
            .is_some_and(|value| value != record.value.revision)
        {
            return Err(StoreError::Conflict(
                "Objective revision changed; reload before updating".into(),
            ));
        }
        if let Some(value) = input.budget_limit_minor {
            if record
                .value
                .budget_limit_minor
                .is_some_and(|prior| value <= prior)
            {
                return Err(refused(
                    "increase the Objective budget above its current limit",
                ));
            }
            record.value.budget_limit_minor = Some(value);
        }
        if let Some(value) = &input.budget_currency {
            if record
                .value
                .budget_currency
                .as_ref()
                .is_some_and(|prior| prior != value)
            {
                return Err(refused(
                    "an existing monetary budget's currency cannot change",
                ));
            }
            if record.value.budget_limit_minor.is_none() {
                return Err(invalid("budget currency requires a limit"));
            }
            record.value.budget_currency = Some(value.clone());
        }
        if input.clear_budget {
            record.value.budget_limit_minor = None;
            record.value.budget_currency = None;
        }
        let old_deadline = record.value.deadline_ms;
        if input.clear_deadline {
            record.value.deadline_ms = None;
        }
        if input.deadline_ms.is_some() {
            record.value.deadline_ms = input.deadline_ms;
        }
        record.limits.budget_limit_minor = record.value.budget_limit_minor;
        record.limits.budget_currency = record.value.budget_currency.clone();
        record.limits.deadline = record.value.deadline_ms.map(timestamp).transpose()?;
        if old_deadline != record.value.deadline_ms {
            record.limits.state.deadline_set_at =
                record
                    .limits
                    .deadline
                    .map(|deadline| limits::DeadlineObservation {
                        deadline,
                        at: timestamp(now_ms).expect("validated current time"),
                    });
        }
        let reported = reported_in(&mut tx, &record).await?;
        record.limits.state =
            limits::evaluate_limits(&record.limits, timestamp(now_ms)?, reported.as_ref());
        if record.value.status == ObjectiveStatus::Limited as i32 {
            let mut possible = record.limits.clone();
            possible.status = limits::ObjectiveStatus::Working;
            // Raising a limit clears Limited independently of the operator pause.
            // The pause still prevents dispatch until Resume explicitly clears it.
            possible.paused_at = None;
            if limits::admission_blocker(&possible, timestamp(now_ms)?).is_none() {
                record.change_status(ObjectiveStatus::Working, now_ms);
                record.limits.state.summary = None;
            }
        }
        record.changed(now_ms);
        save_in(&mut tx, &record).await?;
        reconcile_in(&mut tx, &input.objective_id, now_ms).await?;
        let objective = get_in(&mut tx, &input.objective_id).await?.value;
        receipt_in(
            &mut tx,
            principal,
            &input.operation_id,
            &fingerprint,
            &objective,
        )
        .await?;
        tx.commit().await?;
        Ok(objective)
    }

    pub async fn pause_objective(
        &self,
        principal: &str,
        input: &ObjectiveActionRequest,
    ) -> Result<Objective> {
        self.objective_action(principal, input, "pause").await
    }
    pub async fn resume_objective(
        &self,
        principal: &str,
        input: &ObjectiveActionRequest,
    ) -> Result<Objective> {
        self.objective_action(principal, input, "resume").await
    }
    pub async fn cancel_objective(
        &self,
        principal: &str,
        input: &ObjectiveActionRequest,
    ) -> Result<Objective> {
        self.objective_action(principal, input, "cancel").await
    }

    async fn objective_action(
        &self,
        principal: &str,
        input: &ObjectiveActionRequest,
        action: &str,
    ) -> Result<Objective> {
        operator(principal)?;
        name("operation ID", &input.operation_id)?;
        name("Objective ID", &input.objective_id)?;
        text("reason", &input.reason, 16_384)?;
        let fingerprint = digest(action, input);
        let (mut tx, _) = self.write().await?;
        let now_ms = self.execution_now_ms();
        if let Some(prior) =
            replay_in(&mut tx, principal, &input.operation_id, &fingerprint).await?
        {
            tx.commit().await?;
            return Ok(prior);
        }
        let mut record = get_in(&mut tx, &input.objective_id).await?;
        match action {
            "pause" => {
                if record.closed() {
                    return Err(refused("a closed Objective cannot be paused"));
                }
                if record.value.paused_at_ms.is_none() {
                    record.value.paused_at_ms = Some(now_ms);
                    record.limits.paused_at = Some(timestamp(now_ms)?);
                    record.changed(now_ms);
                }
            }
            "resume" => {
                if record.closed() {
                    return Err(refused("a closed Objective cannot be resumed"));
                }
                if let Some(paused_at) = record.value.paused_at_ms.take() {
                    record.limits.paused_at = None;
                    record.changed(now_ms);
                    let counts = sqlx::query("SELECT t.state, COUNT(*) AS total FROM supertag_v2_tasks t JOIN supertag_v2_objective_tasks ot ON ot.task_id=t.task_id WHERE ot.objective_id=$1 GROUP BY t.state").bind(&input.objective_id).fetch_all(&mut *tx).await?;
                    let mut summary = format!(
                        "An operator resumed the Objective after its pause at {}. Recorded Task states at resume:",
                        timestamp(paused_at)?
                    );
                    for count in counts {
                        let state = TaskState::try_from(count.try_get::<i64, _>("state")? as i32)
                            .map_err(|_| refused("stored Task state is invalid"))?;
                        summary.push_str(&format!(
                            " {:?}: {}.",
                            state,
                            count.try_get::<i64, _>("total")?
                        ));
                    }
                    internal_turn_in(
                        &mut tx,
                        &record,
                        &format!("resumed:{paused_at}"),
                        &summary,
                        "resume",
                        now_ms,
                    )
                    .await?;
                }
            }
            "cancel" => {
                if record.value.status == ObjectiveStatus::Completed as i32 {
                    return Err(refused("a completed Objective cannot be cancelled"));
                }
                if record.value.status != ObjectiveStatus::Cancelled as i32 {
                    record.cancelled_at_ms = Some(now_ms);
                    record.cancellation_reason =
                        (!input.reason.is_empty()).then(|| input.reason.clone());
                    record.change_status(ObjectiveStatus::Cancelled, now_ms);
                }
                cancel_open_in(&mut tx, &input.objective_id, None).await?;
            }
            _ => return Err(invalid("unknown Objective action")),
        }
        save_in(&mut tx, &record).await?;
        receipt_in(
            &mut tx,
            principal,
            &input.operation_id,
            &fingerprint,
            &record.value,
        )
        .await?;
        tx.commit().await?;
        Ok(record.value)
    }

    pub async fn review_objective(
        &self,
        principal: &str,
        input: &ReviewObjectiveRequest,
    ) -> Result<Objective> {
        operator(principal)?;
        name("operation ID", &input.operation_id)?;
        name("Objective ID", &input.objective_id)?;
        text("feedback", &input.feedback, 65_536)?;
        let fingerprint = digest("review", input);
        let (mut tx, _) = self.write().await?;
        let now_ms = self.execution_now_ms();
        if let Some(prior) =
            replay_in(&mut tx, principal, &input.operation_id, &fingerprint).await?
        {
            tx.commit().await?;
            return Ok(prior);
        }
        let mut record = get_in(&mut tx, &input.objective_id).await?;
        if record.value.status != ObjectiveStatus::ReadyForReview as i32 {
            return Err(refused("the Objective must be ready for review"));
        }
        if input.approved {
            record.change_status(ObjectiveStatus::Completed, now_ms);
            if !input.feedback.trim().is_empty() {
                record.completion_summary = Some(input.feedback.clone());
            }
            cancel_open_in(&mut tx, &input.objective_id, None).await?;
        } else {
            if input.feedback.trim().is_empty() {
                return Err(invalid("feedback is required to request changes"));
            }
            record.change_status(ObjectiveStatus::Working, now_ms);
            internal_turn_in(
                &mut tx,
                &record,
                &format!("review:{}", record.value.revision),
                &input.feedback,
                "work",
                now_ms,
            )
            .await?;
        }
        save_in(&mut tx, &record).await?;
        receipt_in(
            &mut tx,
            principal,
            &input.operation_id,
            &fingerprint,
            &record.value,
        )
        .await?;
        tx.commit().await?;
        Ok(record.value)
    }

    pub async fn sweep_objectives(&self) -> Result<()> {
        let (mut tx, _) = self.write().await?;
        let now_ms = self.execution_now_ms();
        objective_sweep_in(&mut tx, now_ms).await?;
        tx.commit().await?;
        Ok(())
    }
}

pub(crate) async fn objective_admission_in(
    tx: &mut Transaction<'_, Any>,
    tag_id: &str,
    session_id: &str,
    now_ms: i64,
) -> Result<()> {
    let id: Option<String> = sqlx::query_scalar(
        "SELECT objective_id FROM supertag_v2_objective_sessions WHERE tag_id=$1 AND session_id=$2",
    )
    .bind(tag_id)
    .bind(session_id)
    .fetch_optional(&mut **tx)
    .await?;
    if let Some(id) = id {
        reconcile_in(tx, &id, now_ms).await?;
        let mut record = get_in(tx, &id).await?;
        if let Some(blocker) = limits::admission_blocker(&record.limits, timestamp(now_ms)?) {
            return Err(refused(&format!(
                "Objective does not accept new work: {blocker:?}"
            )));
        }
        // A person's new accepted work is a fresh opportunity to make progress.
        record.idle_wake_count = 0;
        if record.value.status == ObjectiveStatus::Blocked as i32 {
            record.change_status(ObjectiveStatus::Working, now_ms);
        }
        save_in(tx, &record).await?;
    }
    Ok(())
}

pub(crate) async fn objective_link_task_in(
    tx: &mut Transaction<'_, Any>,
    task: &Task,
) -> Result<()> {
    sqlx::query("INSERT INTO supertag_v2_objective_tasks (task_id,objective_id,kind) SELECT $1, objective_id, 'work' FROM supertag_v2_objective_sessions WHERE tag_id=$2 AND session_id=$3 ON CONFLICT(task_id) DO NOTHING")
        .bind(&task.task_id).bind(&task.tag_id).bind(&task.session_id).execute(&mut **tx).await?;
    Ok(())
}

pub(crate) async fn objective_task_can_start_in(
    tx: &mut Transaction<'_, Any>,
    task: &Task,
    now_ms: i64,
) -> Result<bool> {
    let parent =
        sqlx::query("SELECT objective_id, kind FROM supertag_v2_objective_tasks WHERE task_id=$1")
            .bind(&task.task_id)
            .fetch_optional(&mut **tx)
            .await?;
    let Some(parent) = parent else {
        return Ok(true);
    };
    let record = get_in(tx, &parent.try_get::<String, _>("objective_id")?).await?;
    if record.closed() || record.value.paused_at_ms.is_some() {
        return Ok(false);
    }
    let eligible = if parent.try_get::<String, _>("kind")? == "notice" {
        !limits::deadline_stops_running(&record.limits, timestamp(now_ms)?, None)
    } else {
        limits::admission_blocker(&record.limits, timestamp(now_ms)?).is_none()
    };
    if !eligible {
        return Ok(false);
    }
    match record.value.team_id {
        Some(team_id) => crate::teams::capacity_in(tx, &team_id, task, now_ms).await,
        None => Ok(true),
    }
}

/// Starting native execution is the point at which absent provider cost becomes unknown.
/// A claim alone may never launch and must not count as an unreported execution.
pub(crate) async fn objective_started_in(tx: &mut Transaction<'_, Any>, task: &Task) -> Result<()> {
    let Some(attempt) = &task.attempt_id else {
        return Err(refused("started Task has no Attempt"));
    };
    sqlx::query("INSERT INTO supertag_v2_objective_usage (attempt_id,task_id,objective_id) SELECT $1,$2,objective_id FROM supertag_v2_objective_tasks WHERE task_id=$2 ON CONFLICT(attempt_id) DO NOTHING")
        .bind(attempt).bind(&task.task_id).execute(&mut **tx).await?;
    Ok(())
}

/// A host's timed authority cannot outlive a known Objective deadline plus grace.
/// Monetary budget exhaustion does not shorten an already running Attempt's lease.
pub(crate) async fn objective_lease_deadline_in(
    tx: &mut Transaction<'_, Any>,
    task: &Task,
    proposed: i64,
) -> Result<i64> {
    let id: Option<String> =
        sqlx::query_scalar("SELECT objective_id FROM supertag_v2_objective_tasks WHERE task_id=$1")
            .bind(&task.task_id)
            .fetch_optional(&mut **tx)
            .await?;
    let Some(id) = id else {
        return Ok(proposed);
    };
    let record = get_in(tx, &id).await?;
    Ok(match record.value.deadline_ms {
        Some(deadline) => {
            proposed.min(deadline.saturating_add(limits::deadline_grace_ms(&record.limits)))
        }
        None => proposed,
    })
}

pub(crate) async fn objective_finish_in(
    tx: &mut Transaction<'_, Any>,
    task: &Task,
    signal: i32,
    now_ms: i64,
) -> Result<()> {
    let signal =
        ObjectiveSignal::try_from(signal).map_err(|_| invalid("Objective signal is invalid"))?;
    if task.state != TaskState::Succeeded as i32 {
        return Ok(());
    }
    let id: Option<String> =
        sqlx::query_scalar("SELECT objective_id FROM supertag_v2_objective_tasks WHERE task_id=$1")
            .bind(&task.task_id)
            .fetch_optional(&mut **tx)
            .await?;
    let Some(id) = id else {
        return if signal == ObjectiveSignal::Progress {
            Ok(())
        } else {
            Err(refused("Task does not belong to an Objective"))
        };
    };
    let mut record = get_in(tx, &id).await?;
    if record.value.owner_tag_id != task.tag_id || record.value.session_id != task.session_id {
        return Err(StoreError::PermissionDenied);
    }
    if signal == ObjectiveSignal::Progress {
        if !record.value.ongoing
            && record.value.status == ObjectiveStatus::Working as i32
            && limits::admission_blocker(&record.limits, timestamp(now_ms)?).is_none()
        {
            let open: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM supertag_v2_tasks t JOIN supertag_v2_objective_tasks ot ON ot.task_id=t.task_id WHERE ot.objective_id=$1 AND t.task_id<>$2 AND (t.state IN ($3,$4,$5,$6) OR t.cleanup_pending=1)")
                .bind(&id).bind(&task.task_id).bind(TaskState::Queued as i64).bind(TaskState::Claimed as i64).bind(TaskState::Running as i64).bind(TaskState::Uncertain as i64).fetch_one(&mut **tx).await?;
            if open == 0 {
                if record.idle_wake_count == 0 {
                    record.idle_wake_count = 1;
                    internal_turn_in(tx, &record, &format!("idle:{}", task.task_id), "Your last turn ended with nothing running and nothing asked, while the Objective is still working. Continue the work, report a blocker, or finish the Objective. If this turn also ends that way, the Objective becomes blocked.", "idle", now_ms).await?;
                } else {
                    record.change_status(ObjectiveStatus::Blocked, now_ms);
                }
                save_in(tx, &record).await?;
            }
        }
        return Ok(());
    }
    if record.closed() {
        return Err(refused("Objective execution authority is closed"));
    }
    if limits::deadline_stops_running(&record.limits, timestamp(now_ms)?, None) {
        return Err(refused("Objective deadline grace period ended"));
    }
    let result = task.result.as_deref().unwrap_or("");
    if result.trim().is_empty() {
        return Err(invalid("an Objective signal requires a result summary"));
    }
    let status = match signal {
        ObjectiveSignal::Completed => {
            if record.value.ongoing {
                return Err(invalid(
                    "only an operator can complete an ongoing Objective",
                ));
            }
            ObjectiveStatus::Completed
        }
        ObjectiveSignal::ReadyForReview => ObjectiveStatus::ReadyForReview,
        ObjectiveSignal::Blocked => ObjectiveStatus::Blocked,
        ObjectiveSignal::Progress => unreachable!(),
    };
    if record.value.status == ObjectiveStatus::Limited as i32 {
        return Err(invalid("only an operator can resume a limited Objective"));
    }
    record.completion_summary = Some(result.into());
    record.change_status(status, now_ms);
    save_in(tx, &record).await?;
    if record.closed() {
        cancel_open_in(tx, &id, Some(&task.task_id)).await?;
    }
    Ok(())
}

async fn reported_in(
    tx: &mut Transaction<'_, Any>,
    record: &Record,
) -> Result<Option<limits::ReportedSpend>> {
    let rows = sqlx::query("SELECT attempt_id, amount_minor, currency, estimated FROM supertag_v2_objective_usage WHERE objective_id=$1 ORDER BY attempt_id").bind(&record.value.objective_id).fetch_all(&mut **tx).await?;
    let mut amounts = BTreeMap::<String, u64>::new();
    let mut attempts = vec![];
    for row in rows {
        let amount: Option<i64> = row.try_get("amount_minor")?;
        if let (Some(value), Some(unit)) = (amount, row.try_get::<Option<String>, _>("currency")?) {
            let total = amounts.entry(unit).or_default();
            *total = total
                .checked_add(value as u64)
                .ok_or_else(|| refused("Objective reported spend overflowed"))?;
        }
        attempts.push(limits::AttemptCostEvidence {
            attempt_id: row.try_get("attempt_id")?,
            coverage: if amount.is_some() {
                limits::CostCoverage::Complete
            } else {
                limits::CostCoverage::Unknown
            },
            estimated: row.try_get::<i64, _>("estimated")? == 1,
        });
    }
    Ok(limits::reported_spend(&record.limits, &amounts, &attempts))
}

async fn reconcile_in(
    tx: &mut Transaction<'_, Any>,
    objective_id: &str,
    now_ms: i64,
) -> Result<()> {
    let mut record = get_in(tx, objective_id).await?;
    if record.closed() {
        return Ok(());
    }
    let tasks = sqlx::query("SELECT t.task_id,t.state,t.attempt_id,t.cleanup_pending FROM supertag_v2_tasks t JOIN supertag_v2_objective_tasks ot ON ot.task_id=t.task_id WHERE ot.objective_id=$1 ORDER BY t.accepted_order").bind(objective_id).fetch_all(&mut **tx).await?;
    let mut observed = vec![];
    for row in tasks {
        let task_id: String = row.try_get("task_id")?;
        let attempt_id: Option<String> = row.try_get("attempt_id")?;
        let state = row.try_get::<i64, _>("state")? as i32;
        // Cancellation and Uncertain are not cleanup receipts. Both keep the Objective
        // running until the exact Attempt is confirmed settled or explicitly resolved.
        let phase = if state == TaskState::Running as i32
            || row.try_get::<i64, _>("cleanup_pending")? == 1
        {
            limits::TaskPhase::Running {
                attempt_id: attempt_id
                    .ok_or_else(|| refused("running Objective Task has no Attempt"))?,
            }
        } else if state == TaskState::Queued as i32 || state == TaskState::Claimed as i32 {
            limits::TaskPhase::Pending
        } else {
            limits::TaskPhase::Settled
        };
        observed.push(limits::TaskObservation { task_id, phase });
    }
    let spend = reported_in(tx, &record).await?;
    let decision = limits::plan_sweep(
        &record.limits,
        timestamp(now_ms)?,
        spend.as_ref(),
        &observed,
        None,
        None,
    );
    record.limits.state = decision.state;
    if decision.stop_reason.is_some() {
        cancel_open_in(tx, objective_id, None).await?;
    }
    if decision.limit_now {
        record.change_status(ObjectiveStatus::Limited, now_ms);
        record.limits.state.summary = None;
    }
    record.value.reported_spend_minor = record
        .limits
        .state
        .reported_spend
        .as_ref()
        .map(|entry| entry.spend.amount_minor);
    save_in(tx, &record).await?;
    for notice in limits::notices_to_deliver(&record.limits) {
        internal_turn_in(tx, &record, &notice.key, &notice.message, "notice", now_ms).await?;
    }
    // Notices discovered after grace remain audit history but cannot gain execution authority.
    if limits::deadline_stops_running(&record.limits, timestamp(now_ms)?, None) {
        cancel_open_in(tx, objective_id, None).await?;
    }
    Ok(())
}

pub(crate) async fn objective_sweep_in(tx: &mut Transaction<'_, Any>, now_ms: i64) -> Result<()> {
    let ids: Vec<String> = sqlx::query_scalar("SELECT objective_id FROM supertag_v2_objectives WHERE status NOT IN ($1,$2) ORDER BY objective_id")
        .bind(ObjectiveStatus::Completed as i64).bind(ObjectiveStatus::Cancelled as i64).fetch_all(&mut **tx).await?;
    for id in ids {
        reconcile_in(tx, &id, now_ms).await?;
    }
    Ok(())
}

impl Store {
    pub async fn report_attempt_usage(
        &self,
        host: &HostAuthority,
        input: &ReportAttemptUsageRequest,
    ) -> Result<()> {
        let attempt = input
            .attempt
            .as_ref()
            .ok_or_else(|| invalid("Attempt identity is required"))?;
        let sequence =
            i64::try_from(input.sequence).map_err(|_| invalid("usage sequence is too large"))?;
        if sequence < 1 {
            return Err(invalid("usage sequence starts at one"));
        }
        if let Some(usage) = &input.native_usage {
            if input.amount_minor.is_some() || input.currency.is_some() || input.estimated {
                return Err(invalid("native token usage cannot include cost evidence"));
            }
            return self
                .report_native_usage(host, attempt, sequence, usage)
                .await;
        }
        if input.amount_minor.is_some() != input.currency.is_some() {
            return Err(invalid("reported cost requires both amount and currency"));
        }
        if let Some(value) = input.amount_minor {
            amount(value)?;
        }
        if let Some(value) = &input.currency {
            currency(value)?;
        }
        if input.estimated && input.amount_minor.is_none() {
            return Err(invalid("an estimated cost requires an amount"));
        }
        let fingerprint = digest("usage", input);
        let (mut tx, _) = self.write().await?;
        let now_ms = self.execution_now_ms();
        let task = owned(
            &mut tx,
            host,
            &attempt.task_id,
            &attempt.attempt_id,
            &attempt.lease_token,
        )
        .await?;
        let id: Option<String> = sqlx::query_scalar(
            "SELECT objective_id FROM supertag_v2_objective_tasks WHERE task_id=$1",
        )
        .bind(&attempt.task_id)
        .fetch_optional(&mut *tx)
        .await?;
        let Some(id) = id else {
            return Err(refused(
                "usage reporting currently requires an Objective Task",
            ));
        };
        let prior: Option<String> = sqlx::query_scalar("SELECT request_digest FROM supertag_v2_objective_usage_events WHERE attempt_id=$1 AND sequence=$2").bind(&attempt.attempt_id).bind(sequence).fetch_optional(&mut *tx).await?;
        if let Some(prior) = prior {
            if prior != fingerprint {
                return Err(StoreError::Conflict(
                    "usage sequence was used with different evidence".into(),
                ));
            }
            tx.commit().await?;
            return Ok(());
        }
        if task.try_get::<i64, _>("state")? != TaskState::Running as i64
            || !lease_is_live(&task, now_ms)?
        {
            return Err(refused("Task is not running"));
        }
        sqlx::query("INSERT INTO supertag_v2_objective_usage (attempt_id,task_id,objective_id) VALUES ($1,$2,$3) ON CONFLICT(attempt_id) DO NOTHING").bind(&attempt.attempt_id).bind(&attempt.task_id).bind(&id).execute(&mut *tx).await?;
        let previous: i64 = sqlx::query_scalar(
            "SELECT sequence FROM supertag_v2_objective_usage WHERE attempt_id=$1",
        )
        .bind(&attempt.attempt_id)
        .fetch_one(&mut *tx)
        .await?;
        if sequence != previous + 1 {
            return Err(refused("usage sequence has a gap"));
        }
        sqlx::query("UPDATE supertag_v2_objective_usage SET sequence=$1, amount_minor=$2, currency=$3, estimated=$4 WHERE attempt_id=$5")
            .bind(sequence).bind(input.amount_minor.map(|value| value as i64)).bind(&input.currency).bind(i64::from(input.estimated)).bind(&attempt.attempt_id).execute(&mut *tx).await?;
        sqlx::query("INSERT INTO supertag_v2_objective_usage_events (attempt_id,sequence,request_digest) VALUES ($1,$2,$3)").bind(&attempt.attempt_id).bind(sequence).bind(fingerprint).execute(&mut *tx).await?;
        reconcile_in(&mut tx, &id, now_ms).await?;
        tx.commit().await?;
        Ok(())
    }
}

#[tonic::async_trait]
impl objectives_server::Objectives for ControlPlane {
    async fn create_objective(
        &self,
        request: Request<CreateObjectiveRequest>,
    ) -> std::result::Result<Response<Objective>, Status> {
        let principal = self.principal(&request, "operator:")?;
        Ok(Response::new(
            self.store
                .create_objective(&principal, &request.into_inner())
                .await?,
        ))
    }
    async fn get_objective(
        &self,
        request: Request<GetObjectiveRequest>,
    ) -> std::result::Result<Response<Objective>, Status> {
        self.principal(&request, "operator:")?;
        Ok(Response::new(
            self.store
                .get_objective(&request.into_inner().objective_id)
                .await?,
        ))
    }
    async fn list_objectives(
        &self,
        request: Request<ListObjectivesRequest>,
    ) -> std::result::Result<Response<ListObjectivesResponse>, Status> {
        self.principal(&request, "operator:")?;
        Ok(Response::new(ListObjectivesResponse {
            objectives: self.store.list_objectives(&request.into_inner()).await?,
        }))
    }
    async fn set_limits(
        &self,
        request: Request<SetObjectiveLimitsRequest>,
    ) -> std::result::Result<Response<Objective>, Status> {
        let principal = self.principal(&request, "operator:")?;
        Ok(Response::new(
            self.store
                .set_objective_limits(&principal, &request.into_inner())
                .await?,
        ))
    }
    async fn pause_objective(
        &self,
        request: Request<ObjectiveActionRequest>,
    ) -> std::result::Result<Response<Objective>, Status> {
        let principal = self.principal(&request, "operator:")?;
        Ok(Response::new(
            self.store
                .pause_objective(&principal, &request.into_inner())
                .await?,
        ))
    }
    async fn resume_objective(
        &self,
        request: Request<ObjectiveActionRequest>,
    ) -> std::result::Result<Response<Objective>, Status> {
        let principal = self.principal(&request, "operator:")?;
        Ok(Response::new(
            self.store
                .resume_objective(&principal, &request.into_inner())
                .await?,
        ))
    }
    async fn cancel_objective(
        &self,
        request: Request<ObjectiveActionRequest>,
    ) -> std::result::Result<Response<Objective>, Status> {
        let principal = self.principal(&request, "operator:")?;
        Ok(Response::new(
            self.store
                .cancel_objective(&principal, &request.into_inner())
                .await?,
        ))
    }
    async fn review_objective(
        &self,
        request: Request<ReviewObjectiveRequest>,
    ) -> std::result::Result<Response<Objective>, Status> {
        let principal = self.principal(&request, "operator:")?;
        Ok(Response::new(
            self.store
                .review_objective(&principal, &request.into_inner())
                .await?,
        ))
    }
}
