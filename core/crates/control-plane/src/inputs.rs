use crate::AttemptAccess;
use sqlx::{Any, Row, Transaction, any::AnyRow};
use supertag_protocol::v2::{
    InspectAttemptRequest, LiveInput, LiveInputDecision, LiveInputReceipt, LiveInputState,
    QueueInputRequest, ResolveInputRequest, SettleInputRequest, TakeInputResponse, Task, TaskState,
};

use crate::{
    Store, StoreError,
    objectives::{objective_admission_in, objective_link_task_in},
    session_inputs::{self, InputKind, NewInput},
    store::{
        HostAuthority, Result, insert_task, invalid, lease_is_live, name, owned, task_in, text,
    },
};

const ACKNOWLEDGEMENT_MS: i64 = 10_000;
pub(crate) const MAX_INPUT_BYTES: usize = 16_384;

impl Store {
    pub async fn queue_input(
        &self,
        principal: &str,
        request: &QueueInputRequest,
    ) -> Result<LiveInput> {
        let _wake = self.hint_after_commit();
        validate_operator(principal)?;
        name("Task ID", &request.task_id)?;
        name("operation ID", &request.operation_id)?;
        required_text("live input", &request.text)?;
        let (mut tx, order) = self.write().await?;
        let existing = session_inputs::by_key_in(
            &mut tx,
            &session_inputs::key(&[LIVE, principal, &request.operation_id]),
        )
        .await?;
        if let Some(existing) = existing {
            let (input, _) = input_in(&mut tx, &existing.input_id).await?;
            if input.task_id != request.task_id || input.text != request.text {
                return Err(StoreError::Conflict(
                    "operation ID was used with different live input".into(),
                ));
            }
            tx.rollback().await?;
            return Ok(input);
        }
        if !crate::conversations::task_access_in(&mut tx, principal, &request.task_id).await? {
            return Err(StoreError::NotFound("Task was not found".into()));
        }
        let task = sqlx::query("SELECT * FROM supertag_v2_tasks WHERE task_id=$1")
            .bind(&request.task_id)
            .fetch_optional(&mut *tx)
            .await?
            .ok_or_else(|| StoreError::NotFound("Task was not found".into()))?;
        let now = self.execution_now_ms();
        if !running(&task, now)? {
            return Err(StoreError::FailedPrecondition(
                "live input requires a running Task Attempt".into(),
            ));
        }
        let attempt_id: String = task.try_get("attempt_id")?;
        let tag_id: String = task.try_get("tag_id")?;
        let session_id: String = task.try_get("session_id")?;
        if crate::mailbox::private_session(&session_id) {
            return Err(StoreError::FailedPrecondition(
                "Mailbox Tasks receive input through delivery".into(),
            ));
        }
        if crate::memories::review_session(&session_id) {
            return Err(StoreError::FailedPrecondition(
                "a memory review takes no input".into(),
            ));
        }
        if crate::conversations::private_session(&session_id) {
            return Err(StoreError::FailedPrecondition(
                "send messages through the conversation".into(),
            ));
        }
        if crate::work_sessions::reserved_session(&session_id)
            || crate::work_sessions::task_kind_in(&mut tx, &request.task_id)
                .await?
                .is_some()
        {
            return Err(StoreError::FailedPrecondition(
                "Work Session Tasks and reports do not accept live input".into(),
            ));
        }
        objective_admission_in(&mut tx, &tag_id, &session_id, now).await?;
        let follower = insert_task(&mut tx, order, &tag_id, &session_id, &request.text).await?;
        objective_link_task_in(&mut tx, &follower).await?;
        let input = record_live_input_in(
            &mut tx,
            principal,
            &request.operation_id,
            &request.task_id,
            &attempt_id,
            &follower,
            now,
        )
        .await?
        .ok_or_else(|| {
            StoreError::FailedPrecondition(
                "Task policy changed; submit a new Task to continue this Session".into(),
            )
        })?;
        tx.commit().await?;
        Ok(input)
    }

    pub async fn get_input(&self, input_id: &str) -> Result<LiveInput> {
        name("live input ID", input_id)?;
        let mut tx = self.pool.begin().await?;
        let (input, _) = input_in(&mut tx, input_id).await?;
        tx.commit().await?;
        Ok(input)
    }

    pub async fn take_input(&self, authority: &AttemptAccess) -> Result<Option<LiveInput>> {
        Ok(self.take_input_for_attempt(authority).await?.input)
    }

    pub async fn take_input_for_attempt(
        &self,
        authority: &AttemptAccess,
    ) -> Result<TakeInputResponse> {
        let host = authority.host();
        let attempt = authority.lease();
        let (mut tx, _) = self.write().await?;
        let task = owned_attempt(&mut tx, host, attempt).await?;
        let now = self.execution_now_ms();
        sweep_in(&mut tx, now).await?;
        if !running(&task, now)? {
            tx.commit().await?;
            return Ok(TakeInputResponse::default());
        }
        let tag_id: String = task.try_get("tag_id")?;
        let session_id: String = task.try_get("session_id")?;
        let id: Option<String> = sqlx::query_scalar(
            "SELECT i.input_id FROM supertag_v2_session_inputs i WHERE i.offer_task_id=$1 AND i.offer_attempt_id=$2 AND i.offer_state=$3
             AND i.admitted_task_id=(SELECT task_id FROM supertag_v2_tasks WHERE tag_id=$4 AND session_id=$5 AND state=$6 ORDER BY accepted_order LIMIT 1)
             AND NOT EXISTS (SELECT 1 FROM supertag_v2_session_inputs prior WHERE prior.tag_id=$4 AND prior.session_id=$5 AND prior.offer_state IN ($7,$8))",
        )
        .bind(&attempt.task_id).bind(&attempt.attempt_id).bind(LiveInputState::Pending as i64)
        .bind(tag_id).bind(session_id).bind(TaskState::Queued as i64)
        .bind(LiveInputState::Dispatching as i64).bind(LiveInputState::Unknown as i64)
        .fetch_optional(&mut *tx).await?;
        let Some(id) = id else {
            tx.commit().await?;
            return Ok(TakeInputResponse::default());
        };
        let (mut input, _) = input_in(&mut tx, &id).await?;
        // A Pending row created before policy was checked at admission may be
        // left on disk. Leave its follower queued for ordinary execution.
        if !compatible_policy_in(&mut tx, &attempt.task_id, &input.follower_task_id).await? {
            set_state(&mut tx, &mut input, LiveInputState::Rejected).await?;
            tx.commit().await?;
            return Ok(TakeInputResponse::default());
        }
        let lease_end: i64 = task.try_get("lease_expires_at_ms")?;
        let valid_for_ms = lease_end.saturating_sub(now).min(ACKNOWLEDGEMENT_MS) as u64;
        sqlx::query("UPDATE supertag_v2_session_inputs SET offer_state=$1,acknowledgement_deadline_ms=$2 WHERE input_id=$3")
            .bind(LiveInputState::Dispatching as i64).bind(now.saturating_add(ACKNOWLEDGEMENT_MS))
            .bind(&id).execute(&mut *tx).await?;
        input.state = LiveInputState::Dispatching.into();
        let _wake = self.hint_after_commit();
        // A lost response is uncertain. No later take returns this text again.
        tx.commit().await?;
        Ok(TakeInputResponse {
            input: Some(input),
            valid_for_ms,
        })
    }

    pub async fn settle_input(
        &self,
        authority: &AttemptAccess,
        request: &SettleInputRequest,
    ) -> Result<LiveInput> {
        let host = authority.host();
        let _wake = self.hint_after_commit();
        name("live input ID", &request.input_id)?;
        let attempt = authority.lease();
        let next = match request.receipt() {
            LiveInputReceipt::Accepted => LiveInputState::Accepted,
            LiveInputReceipt::Rejected => LiveInputState::Rejected,
            LiveInputReceipt::Unknown => LiveInputState::Unknown,
            LiveInputReceipt::Withdrawn => LiveInputState::Withdrawn,
            LiveInputReceipt::Unspecified => return Err(invalid("live input receipt is required")),
        };
        let (mut tx, _) = self.write().await?;
        owned_attempt(&mut tx, host, attempt).await?;
        let now = self.execution_now_ms();
        sweep_in(&mut tx, now).await?;
        let (mut input, _) = input_in(&mut tx, &request.input_id).await?;
        if input.task_id != attempt.task_id || input.attempt_id != attempt.attempt_id {
            return Err(StoreError::PermissionDenied);
        }
        let current = input.state();
        if current == next || current == LiveInputState::Withdrawn {
            // A withdrawal can arrive before the acknowledgement. The withdrawal
            // proves the input was unread and stays authoritative.
            tx.commit().await?;
            return Ok(input);
        }
        let withdrawal = next == LiveInputState::Withdrawn
            && matches!(current, LiveInputState::Accepted | LiveInputState::Unknown);
        if current != LiveInputState::Dispatching && !withdrawal {
            tx.commit().await?;
            return Err(StoreError::FailedPrecondition(
                "live input receipt cannot change the recorded delivery".into(),
            ));
        }
        match next {
            LiveInputState::Accepted => {
                let result = format!("Input accepted by Task {}.", input.task_id);
                update_follower(
                    &mut tx,
                    &input.follower_task_id,
                    TaskState::Queued,
                    TaskState::Succeeded,
                    Some(&result),
                )
                .await?;
                crate::reply_progress::follow_up_in(&mut tx, &input.task_id).await?;
                session_inputs::bind_in(&mut tx, &input.input_id, &input.task_id, false, now)
                    .await?;
            }
            LiveInputState::Withdrawn if current == LiveInputState::Accepted => {
                session_inputs::unbind_in(&mut tx, &input.input_id).await?;
                update_follower(
                    &mut tx,
                    &input.follower_task_id,
                    TaskState::Succeeded,
                    TaskState::Queued,
                    None,
                )
                .await?;
            }
            _ => {}
        }
        set_state(&mut tx, &mut input, next).await?;
        tx.commit().await?;
        Ok(input)
    }

    pub async fn resolve_input(
        &self,
        principal: &str,
        request: &ResolveInputRequest,
    ) -> Result<LiveInput> {
        let _wake = self.hint_after_commit();
        validate_operator(principal)?;
        name("live input ID", &request.input_id)?;
        name("operation ID", &request.operation_id)?;
        required_text("live input recovery evidence", &request.evidence)?;
        let next = match request.decision() {
            LiveInputDecision::Fail => LiveInputState::Failed,
            LiveInputDecision::Retry => LiveInputState::Retried,
            LiveInputDecision::Unspecified => {
                return Err(invalid("live input recovery decision is required"));
            }
        };
        let (mut tx, _) = self.write().await?;
        let replay = sqlx::query("SELECT input_id,resolution_decision AS decision,resolution_evidence AS evidence FROM supertag_v2_session_inputs WHERE resolution_principal=$1 AND resolution_operation_id=$2")
            .bind(principal).bind(&request.operation_id).fetch_optional(&mut *tx).await?;
        if let Some(replay) = replay {
            if replay.try_get::<String, _>("input_id")? != request.input_id
                || replay.try_get::<i64, _>("decision")? != i64::from(request.decision)
                || replay.try_get::<String, _>("evidence")? != request.evidence
            {
                return Err(StoreError::Conflict(
                    "operation ID was used with different live input recovery evidence".into(),
                ));
            }
            let input = input_in(&mut tx, &request.input_id).await?.0;
            tx.rollback().await?;
            return Ok(input);
        }
        let now = self.execution_now_ms();
        sweep_in(&mut tx, now).await?;
        let (mut input, follower_state) = input_in(&mut tx, &request.input_id).await?;
        if input.state() != LiveInputState::Unknown {
            return Err(StoreError::FailedPrecondition(
                "only uncertain live input can be resolved".into(),
            ));
        }
        if next == LiveInputState::Retried && follower_state != TaskState::Queued as i64 {
            return Err(StoreError::FailedPrecondition(
                "live input fallback Task is no longer queued".into(),
            ));
        }
        if next == LiveInputState::Failed {
            update_follower(
                &mut tx,
                &input.follower_task_id,
                TaskState::Queued,
                TaskState::Failed,
                Some("Uncertain live input delivery was closed by an operator."),
            )
            .await?;
        }
        sqlx::query("UPDATE supertag_v2_session_inputs SET resolution_principal=$2,resolution_operation_id=$3,resolution_decision=$4,resolution_evidence=$5,resolved_at_ms=$6 WHERE input_id=$1")
            .bind(&input.input_id).bind(principal).bind(&request.operation_id)
            .bind(i64::from(request.decision)).bind(&request.evidence).bind(now)
            .execute(&mut *tx).await?;
        set_state(&mut tx, &mut input, next).await?;
        tx.commit().await?;
        Ok(input)
    }

    pub async fn sweep_inputs(&self) -> Result<u64> {
        let (mut tx, _) = self.write().await?;
        let changed = sweep_in(&mut tx, self.execution_now_ms()).await?;
        if changed == 0 {
            tx.rollback().await?;
        } else {
            tx.commit().await?;
        }
        Ok(changed)
    }
}

pub(crate) async fn sweep_in(tx: &mut Transaction<'_, Any>, now: i64) -> Result<u64> {
    // The target can finish while a valid acknowledgement is in flight.
    // Preserve the dispatch hold until that receipt arrives or its window ends.
    let unknown = sqlx::query("UPDATE supertag_v2_session_inputs SET offer_state=$1 WHERE offer_state=$2 AND acknowledgement_deadline_ms <= $3")
        .bind(LiveInputState::Unknown as i64).bind(LiveInputState::Dispatching as i64).bind(now)
        .execute(&mut **tx).await?.rows_affected();
    // A pending input was never taken. It can fall back to its ordinary queued
    // Task when the original attempt can no longer receive it.
    let rejected = sqlx::query(
        "UPDATE supertag_v2_session_inputs SET offer_state=$1 WHERE offer_state=$2
         AND (NOT EXISTS (SELECT 1 FROM supertag_v2_tasks t WHERE t.task_id=supertag_v2_session_inputs.offer_task_id AND t.attempt_id=supertag_v2_session_inputs.offer_attempt_id AND t.state=$3 AND t.lease_expires_at_ms > $4)
         OR NOT EXISTS (SELECT 1 FROM supertag_v2_tasks f WHERE f.task_id=supertag_v2_session_inputs.admitted_task_id AND f.state=$5))",
    )
    .bind(LiveInputState::Rejected as i64).bind(LiveInputState::Pending as i64)
    .bind(TaskState::Running as i64).bind(now).bind(TaskState::Queued as i64)
    .execute(&mut **tx).await?.rows_affected();
    Ok(unknown + rejected)
}

pub(crate) async fn can_claim_in(
    tx: &mut Transaction<'_, Any>,
    task: &Task,
    order: i64,
) -> Result<bool> {
    let blocked: Option<String> = sqlx::query_scalar(
        "SELECT input_id FROM supertag_v2_session_inputs
         WHERE tag_id=$1 AND session_id=$2 AND position <= $3 AND offer_state IN ($4,$5) LIMIT 1",
    )
    .bind(&task.tag_id)
    .bind(&task.session_id)
    .bind(order)
    .bind(LiveInputState::Dispatching as i64)
    .bind(LiveInputState::Unknown as i64)
    .fetch_optional(&mut **tx)
    .await?;
    Ok(blocked.is_none())
}

/// Offers a person's message, the input `follower` was admitted for, to the running Attempt
/// `attempt_id` of `task_id`. A message with no input yet records one for `principal`'s
/// operation. `None` when the running Task's policy differs, so the message waits for its own turn.
pub(crate) async fn record_live_input_in(
    tx: &mut Transaction<'_, Any>,
    principal: &str,
    operation: &str,
    task_id: &str,
    attempt_id: &str,
    follower: &Task,
    now: i64,
) -> Result<Option<LiveInput>> {
    if !compatible_policy_in(tx, task_id, &follower.task_id).await? {
        return Ok(None);
    }
    let input_id = match session_inputs::own_in(tx, &follower.task_id).await? {
        Some(own) if own.kind != InputKind::Person || own.offer_state.is_some() => {
            return Ok(None);
        }
        Some(own) => {
            sqlx::query("UPDATE supertag_v2_session_inputs SET offer_task_id=$1,offer_attempt_id=$2,offer_state=$3 WHERE input_id=$4")
                .bind(task_id).bind(attempt_id).bind(LiveInputState::Pending as i64).bind(&own.input_id)
                .execute(&mut **tx).await?;
            own.input_id
        }
        None => {
            let (_, audience) = session_inputs::requester_of_in(tx, &follower.task_id).await?;
            let own = session_inputs::admit_in(
                tx,
                follower,
                NewInput {
                    kind: InputKind::Person,
                    source_key: session_inputs::key(&[LIVE, principal, operation]),
                    requester: principal,
                    audience: &audience,
                },
                now,
            )
            .await?;
            sqlx::query("UPDATE supertag_v2_session_inputs SET offer_task_id=$1,offer_attempt_id=$2,offer_state=$3 WHERE input_id=$4")
                .bind(task_id).bind(attempt_id).bind(LiveInputState::Pending as i64).bind(&own.input_id)
                .execute(&mut **tx).await?;
            own.input_id
        }
    };
    Ok(Some(input_in(tx, &input_id).await?.0))
}

/// Delivers a person's just-admitted message into the Session's running Attempt as live input,
/// when one is running and the message fits. The message stays an ordinary queued Task until the
/// harness accepts it; if the harness never does, it runs on its own or joins the next claim.
pub(crate) async fn fold_in(
    tx: &mut Transaction<'_, Any>,
    principal: &str,
    operation: &str,
    follower: &Task,
    now: i64,
) -> Result<Option<LiveInput>> {
    if follower.prompt.len() > MAX_INPUT_BYTES {
        return Ok(None);
    }
    let active = sqlx::query("SELECT task_id,attempt_id FROM supertag_v2_tasks t WHERE tag_id=$1 AND session_id=$2 AND state=$3 AND lease_expires_at_ms>$4 AND NOT EXISTS (SELECT 1 FROM supertag_v2_work_session_tasks wt WHERE wt.task_id=t.task_id AND wt.kind=$5) ORDER BY accepted_order LIMIT 1")
        .bind(&follower.tag_id).bind(&follower.session_id).bind(TaskState::Running as i64).bind(now)
        .bind(crate::work_sessions::REPORT).fetch_optional(&mut **tx).await?;
    let Some(active) = active else {
        return Ok(None);
    };
    let source: String = active.try_get("task_id")?;
    let attempt: String = active.try_get("attempt_id")?;
    record_live_input_in(tx, principal, operation, &source, &attempt, follower, now).await
}

/// A batch answers at most this many messages: the claimed Task's and the ones joined to it.
pub(crate) const MAX_BATCH_MESSAGES: usize = 10;
/// Joined messages carry at most this much text in total.
pub(crate) const MAX_JOINED_BYTES: usize = 16 * 1024;
const JOIN_PRINCIPAL: &str = "control-plane:join";
/// The first field of a live input's or joined message's source key.
const LIVE: &str = "live";

/// The person's messages a claimed Task answers together with its own. The first claim binds
/// them: the later Queued messages of the Session, up to the first that is not a person's message,
/// acts for another requester or replies to another audience, has another policy, or would pass a
/// cap. Each joined message is bound to the Task as live input it accepted, so it settles now and
/// gets no reply of its own. Every later claim of the Task (a lost-start replay, an expired
/// reservation, a redelivery) presents the same messages, and the ones an earlier Attempt took in.
pub(crate) async fn join_at_claim_in(
    tx: &mut Transaction<'_, Any>,
    task: &Task,
    attempt_id: &str,
    now: i64,
) -> Result<Vec<supertag_protocol::v2::JoinedMessage>> {
    let claimed_before: Option<String> =
        sqlx::query_scalar("SELECT task_id FROM supertag_v2_claims WHERE task_id=$1 LIMIT 1")
            .bind(&task.task_id)
            .fetch_optional(&mut **tx)
            .await?;
    if claimed_before.is_some() {
        return session_inputs::replayed_in(tx, &task.task_id, attempt_id).await;
    }
    if !person_message_in(tx, &task.task_id).await? {
        return Ok(vec![]);
    }
    let head = session_inputs::requester_of_in(tx, &task.task_id).await?;
    let order: i64 =
        sqlx::query_scalar("SELECT accepted_order FROM supertag_v2_tasks WHERE task_id=$1")
            .bind(&task.task_id)
            .fetch_one(&mut **tx)
            .await?;
    let later = sqlx::query("SELECT task_id,prompt,accepted_at_ms FROM supertag_v2_tasks WHERE tag_id=$1 AND session_id=$2 AND state=$3 AND attempt_id IS NULL AND accepted_order>$4 ORDER BY accepted_order LIMIT $5")
        .bind(&task.tag_id).bind(&task.session_id).bind(TaskState::Queued as i64).bind(order)
        .bind(MAX_BATCH_MESSAGES as i64).fetch_all(&mut **tx).await?;
    let mut joined = Vec::new();
    let mut bytes = 0;
    for row in later {
        let id: String = row.try_get("task_id")?;
        let text: String = row.try_get("prompt")?;
        if joined.len() + 1 >= MAX_BATCH_MESSAGES
            || bytes + text.len() > MAX_JOINED_BYTES
            || !person_message_in(tx, &id).await?
            || session_inputs::requester_of_in(tx, &id).await? != head
            || !compatible_policy_in(tx, &task.task_id, &id).await?
        {
            break;
        }
        let input_id = match session_inputs::own_in(tx, &id).await? {
            Some(own) if own.task_id.is_some() || own.kind != InputKind::Person => break,
            // An input its harness never took falls back to its queued Task, which joins here.
            Some(own)
                if own.offer_state.is_none_or(|state| {
                    [
                        LiveInputState::Rejected as i64,
                        LiveInputState::Retried as i64,
                        LiveInputState::Withdrawn as i64,
                    ]
                    .contains(&state)
                }) =>
            {
                own.input_id
            }
            Some(_) => break,
            None => {
                let follower = task_in(tx, &id).await?;
                session_inputs::admit_in(
                    tx,
                    &follower,
                    NewInput {
                        kind: InputKind::Person,
                        source_key: session_inputs::key(&[
                            LIVE,
                            JOIN_PRINCIPAL,
                            &format!("join/{id}"),
                        ]),
                        requester: &head.0,
                        audience: &head.1,
                    },
                    now,
                )
                .await?
                .input_id
            }
        };
        sqlx::query("UPDATE supertag_v2_session_inputs SET offer_task_id=$1,offer_attempt_id=$2,offer_state=$3,acknowledgement_deadline_ms=NULL WHERE input_id=$4")
            .bind(&task.task_id).bind(attempt_id).bind(LiveInputState::Accepted as i64)
            .bind(&input_id).execute(&mut **tx).await?;
        session_inputs::bind_in(tx, &input_id, &task.task_id, true, now).await?;
        let result = format!("Input accepted by Task {}.", task.task_id);
        update_follower(
            tx,
            &id,
            TaskState::Queued,
            TaskState::Succeeded,
            Some(&result),
        )
        .await?;
        bytes += text.len();
        joined.push(supertag_protocol::v2::JoinedMessage {
            task_id: id,
            text,
            sent_at_ms: row
                .try_get::<Option<i64>, _>("accepted_at_ms")?
                .unwrap_or_default(),
        });
    }
    Ok(joined)
}

/// The messages `task_id`'s Attempt `attempt_id` answers with its own; see
/// [`session_inputs::replayed_in`].
pub(crate) async fn joined_in(
    tx: &mut Transaction<'_, Any>,
    task_id: &str,
    attempt_id: &str,
) -> Result<Vec<supertag_protocol::v2::JoinedMessage>> {
    session_inputs::replayed_in(tx, task_id, attempt_id).await
}

/// A message a person sent: in a conversation, in a Slack, Teams or Lark thread, or as live input.
/// Not an internal turn such as a Schedule firing (which a conversation also shows), a notice, a
/// Mailbox delivery or a report, and not a GitHub or Linear event.
async fn person_message_in(tx: &mut Transaction<'_, Any>, task_id: &str) -> Result<bool> {
    let found: Option<i64> = sqlx::query_scalar(
        "SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM supertag_v2_schedule_fires WHERE task_id=$1)
            AND (EXISTS (SELECT 1 FROM supertag_v2_messages WHERE task_id=$1 AND sender_kind=2)
            OR EXISTS (SELECT 1 FROM supertag_v2_slack_messages WHERE task_id=$1)
            OR EXISTS (SELECT 1 FROM supertag_v2_lark_messages WHERE task_id=$1)
            OR EXISTS (SELECT 1 FROM supertag_v2_microsoft_teams_activities WHERE task_id=$1)
            OR EXISTS (SELECT 1 FROM supertag_v2_session_inputs WHERE admitted_task_id=$1 AND kind=2 AND conversation_id IS NULL))",
    )
    .bind(task_id)
    .fetch_optional(&mut **tx)
    .await?;
    Ok(found.is_some())
}

async fn compatible_policy_in(
    tx: &mut Transaction<'_, Any>,
    task_id: &str,
    follower_id: &str,
) -> Result<bool> {
    // Compare accepted Task values. Actions and approval rules are normalized
    // at admission, so a Tag revision with the same policy is immaterial.
    let matches: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM supertag_v2_tasks active JOIN supertag_v2_tasks follower
           ON follower.tag_id=active.tag_id AND follower.session_id=active.session_id
         WHERE active.task_id=$1 AND follower.task_id=$2
           AND active.instructions=follower.instructions
           AND active.allowed_actions=follower.allowed_actions
           AND active.approval_rules=follower.approval_rules
           AND active.policy_effective_digest=follower.policy_effective_digest
           AND active.execution_limits=follower.execution_limits
           AND active.harness_kind=follower.harness_kind
           AND active.workspace_id IS NOT DISTINCT FROM follower.workspace_id
           AND active.workspace_base_commit IS NOT DISTINCT FROM follower.workspace_base_commit
           AND active.workspace_base_ref IS NOT DISTINCT FROM follower.workspace_base_ref
           AND active.workspace_mounts IS NOT DISTINCT FROM follower.workspace_mounts
           AND active.workspace_mcp_servers IS NOT DISTINCT FROM follower.workspace_mcp_servers",
    )
    .bind(task_id)
    .bind(follower_id)
    .fetch_one(&mut **tx)
    .await?;
    if matches == 0 {
        return Ok(false);
    }
    let active = task_in(tx, task_id).await?;
    let follower = task_in(tx, follower_id).await?;
    Ok(active.execution_selection == follower.execution_selection)
}

/// The live input each of `follower_task_ids` delivers, by follower Task ID, in one query.
pub(crate) async fn inputs_for_followers_in(
    tx: &mut Transaction<'_, Any>,
    follower_task_ids: &[&str],
) -> Result<std::collections::HashMap<String, LiveInput>> {
    let mut inputs = std::collections::HashMap::new();
    for chunk in follower_task_ids.chunks(crate::store::ID_BATCH) {
        let sql = format!(
            "{INPUT_SELECT} WHERE i.offer_state IS NOT NULL AND i.admitted_task_id IN ({})",
            crate::store::placeholders(1, chunk.len())
        );
        let mut query = sqlx::query(&sql);
        for id in chunk {
            query = query.bind(*id);
        }
        for row in query.fetch_all(&mut **tx).await? {
            let (input, _) = input_row(&row)?;
            inputs.insert(input.follower_task_id.clone(), input);
        }
    }
    Ok(inputs)
}

/// A live input: a person's message offered to a running Attempt, read as `LiveInput`.
const INPUT_SELECT: &str = "SELECT i.input_id,i.offer_task_id,i.offer_attempt_id,i.admitted_task_id,i.offer_state,
         f.prompt AS input_text,f.accepted_order AS input_order,f.state AS follower_state
         FROM supertag_v2_session_inputs i JOIN supertag_v2_tasks f ON f.task_id=i.admitted_task_id";

async fn input_in(tx: &mut Transaction<'_, Any>, id: &str) -> Result<(LiveInput, i64)> {
    let row = sqlx::query(&format!(
        "{INPUT_SELECT} WHERE i.input_id=$1 AND i.offer_state IS NOT NULL"
    ))
    .bind(id)
    .fetch_optional(&mut **tx)
    .await?
    .ok_or_else(|| StoreError::NotFound("live input was not found".into()))?;
    input_row(&row)
}

fn input_row(row: &AnyRow) -> Result<(LiveInput, i64)> {
    Ok((
        LiveInput {
            input_id: row.try_get("input_id")?,
            task_id: row.try_get("offer_task_id")?,
            attempt_id: row.try_get("offer_attempt_id")?,
            follower_task_id: row.try_get("admitted_task_id")?,
            text: row.try_get("input_text")?,
            state: row.try_get::<i64, _>("offer_state")? as i32,
            order: row.try_get::<i64, _>("input_order")? as u64,
        },
        row.try_get("follower_state")?,
    ))
}

async fn owned_attempt(
    tx: &mut Transaction<'_, Any>,
    host: &HostAuthority,
    attempt: &InspectAttemptRequest,
) -> Result<AnyRow> {
    owned(
        tx,
        host,
        &attempt.task_id,
        &attempt.attempt_id,
        &attempt.lease_token,
    )
    .await
}

async fn update_follower(
    tx: &mut Transaction<'_, Any>,
    task_id: &str,
    current: TaskState,
    next: TaskState,
    result: Option<&str>,
) -> Result<()> {
    sqlx::query("UPDATE supertag_v2_tasks SET state=$1,result=$2 WHERE task_id=$3 AND state=$4 AND attempt_id IS NULL")
        .bind(next as i64).bind(result).bind(task_id).bind(current as i64)
        .execute(&mut **tx).await?;
    Ok(())
}

async fn set_state(
    tx: &mut Transaction<'_, Any>,
    input: &mut LiveInput,
    state: LiveInputState,
) -> Result<()> {
    sqlx::query("UPDATE supertag_v2_session_inputs SET offer_state=$1 WHERE input_id=$2")
        .bind(state as i64)
        .bind(&input.input_id)
        .execute(&mut **tx)
        .await?;
    input.state = state.into();
    Ok(())
}

fn running(task: &AnyRow, now: i64) -> Result<bool> {
    Ok(task.try_get::<i64, _>("state")? == TaskState::Running as i64 && lease_is_live(task, now)?)
}

/// Operators and clients direct input into Tasks they can see.
fn validate_operator(principal: &str) -> Result<()> {
    crate::store::actor(principal)
}

fn required_text(kind: &str, value: &str) -> Result<()> {
    text(kind, value, MAX_INPUT_BYTES)?;
    if value.trim().is_empty() {
        return Err(invalid(&format!("{kind} is required")));
    }
    Ok(())
}
