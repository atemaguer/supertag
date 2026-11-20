//! An Objective's Session asks its own Tag. Only a Tag's inbox Session reaches other Tags, so an
//! Objective's turn that needs something from outside the Objective asks the inbox Session with
//! `ask_tag`, which names no recipient. The ask is a message in the Objective's conversation with
//! its Tag ([`messages::objective_conversation_in`]) and wakes the inbox Session as a Tag's
//! question does, under the same wake limits and debounce. The inbox turn answers with
//! `send_message` to the Objective; the answer is a later message in that conversation and runs as
//! the Objective's next turn, like a Work Session report. Asking does not end the asking turn, and
//! an ask is due until it is answered: a turn that ends with nothing else running then waits
//! instead of being woken as idle.
use super::*;
use crate::{messages::OperationScope, messages::wakes::WakeRequest};

/// At most this many asks in one Task.
const ASKS_PER_TASK: i64 = 3;

fn untrusted(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

fn digest(value: &impl serde::Serialize) -> Result<String> {
    use sha2::{Digest, Sha256};
    Ok(format!(
        "sha256:{:x}",
        Sha256::digest(serde_json::to_vec(value)?)
    ))
}

fn message_text(text: &str) -> Result<&str> {
    let text = text.trim();
    if text.is_empty() || text.encode_utf16().count() > MAX_MESSAGE_UTF16 || text.contains('\0') {
        return Err(invalid(
            "message text must contain 1–8,000 UTF-16 units without a NUL",
        ));
    }
    Ok(text)
}

/// The Objective whose Session a turn runs in, whatever its kind: such a turn reaches no other
/// Tag.
pub(crate) async fn objective_session_in(
    tx: &mut Transaction<'_, Any>,
    tag_id: &str,
    session_id: &str,
) -> Result<Option<String>> {
    Ok(sqlx::query_scalar(
        "SELECT objective_id FROM supertag_v2_objective_sessions WHERE tag_id=$1 AND session_id=$2",
    )
    .bind(tag_id)
    .bind(session_id)
    .fetch_optional(&mut **tx)
    .await?)
}

/// The open Objective a turn may ask its Tag for: one of the Objective's own turns or a report
/// to it, never a Work Session's Task or a limit notice.
pub(crate) async fn asking_objective_in(
    tx: &mut Transaction<'_, Any>,
    task: &Task,
    kind: Option<i64>,
) -> Result<Option<String>> {
    if kind.is_some_and(|kind| kind != crate::work_sessions::REPORT) {
        return Ok(None);
    }
    Ok(sqlx::query_scalar(
        "SELECT o.objective_id FROM supertag_v2_objective_sessions s
         JOIN supertag_v2_objectives o ON o.objective_id=s.objective_id
         WHERE s.tag_id=$1 AND s.session_id=$2 AND o.owner_tag_id=$1 AND o.status NOT IN ($3,$4)
           AND NOT EXISTS (SELECT 1 FROM supertag_v2_objective_tasks n
                           WHERE n.task_id=$5 AND n.kind='notice')",
    )
    .bind(&task.tag_id)
    .bind(&task.session_id)
    .bind(ObjectiveStatus::Completed as i64)
    .bind(ObjectiveStatus::Cancelled as i64)
    .bind(&task.task_id)
    .fetch_optional(&mut **tx)
    .await?)
}

/// Whether the Objective asked its Tag something the inbox Session has not answered yet.
pub(crate) async fn waiting_in(tx: &mut Transaction<'_, Any>, objective_id: &str) -> Result<bool> {
    let open: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM supertag_v2_objective_asks
         WHERE objective_id=$1 AND answered_at_ms IS NULL",
    )
    .bind(objective_id)
    .fetch_one(&mut **tx)
    .await?;
    Ok(open > 0)
}

/// The asks in the Objective's conversation from `from_seq` on, in seq order.
pub(super) async fn asks_in(
    tx: &mut Transaction<'_, Any>,
    conversation_id: &str,
    from_seq: i64,
    limit: i64,
) -> Result<Vec<AnyRow>> {
    Ok(sqlx::query(
        "SELECT m.* FROM supertag_v2_objective_asks k
         JOIN supertag_v2_messages m ON m.message_id=k.message_id
         WHERE m.conversation_id=$1 AND m.seq>=$2 ORDER BY m.seq LIMIT $3",
    )
    .bind(conversation_id)
    .bind(from_seq)
    .bind(limit)
    .fetch_all(&mut **tx)
    .await?)
}

/// One rendered ask, as the inbox turn sees it, with how to answer it.
pub(super) fn entry(objective_id: &str, row: &AnyRow) -> Result<String> {
    let id: String = row.try_get("message_id")?;
    let text: String = row.try_get("text")?;
    let objective = serde_json::to_string(objective_id)?
        .replace('<', "&lt;")
        .replace('>', "&gt;");
    Ok(format!(
        "<objective-message objective={objective} id=\"{id}\" via=\"ask_tag\">\n{}\n</objective-message>\nThis Tag's Objective {objective} asked this and waits for the answer: answer it with send_message and objective {objective}. The answer runs as the Objective's next turn.\n",
        untrusted(&text)
    ))
}

/// The inbox Session's answer to an Objective, as a Mailbox entry: it names the Objective and no
/// recipient Tag.
async fn answer_message_in(tx: &mut Transaction<'_, Any>, message_id: &str) -> Result<TagMessage> {
    let row = sqlx::query(
        "SELECT m.*,
                (SELECT k.answer_task_id FROM supertag_v2_objective_asks k
                 WHERE k.answer_message_id=m.message_id LIMIT 1) AS answer_task_id
         FROM supertag_v2_messages m WHERE m.message_id=$1",
    )
    .bind(message_id)
    .fetch_optional(&mut **tx)
    .await?
    .ok_or_else(|| StoreError::NotFound("message was not found".into()))?;
    let task_id: Option<String> = row.try_get("answer_task_id")?;
    let state = match &task_id {
        Some(task) => {
            let state: i64 =
                sqlx::query_scalar("SELECT state FROM supertag_v2_tasks WHERE task_id=$1")
                    .bind(task)
                    .fetch_one(&mut **tx)
                    .await?;
            match TaskState::try_from(state as i32) {
                Ok(TaskState::Succeeded) => TagMessageState::Handled,
                Ok(TaskState::Failed | TaskState::Cancelled) => TagMessageState::Failed,
                _ => TagMessageState::Pending,
            }
        }
        None => TagMessageState::Pending,
    };
    Ok(TagMessage {
        message_id: row.try_get("message_id")?,
        sender_tag_id: row.try_get("sender_id")?,
        recipient_tag_id: String::new(),
        source_task_id: row
            .try_get::<Option<String>, _>("source_task_id")?
            .unwrap_or_default(),
        workstream_post_id: None,
        objective_id: row.try_get("objective_id")?,
        text: row.try_get("text")?,
        hops: row.try_get::<i64, _>("hops")? as u32,
        task_id,
        state: state as i32,
        created_at_ms: row.try_get("created_at_ms")?,
        origin: TagMessageOrigin::Direct as i32,
        review: None,
        kind: row.try_get::<i64, _>("kind")? as i32,
    })
}

impl Store {
    /// `ask_tag`: an Objective's turn asks its own Tag's inbox Session. The turn goes on.
    pub async fn ask_attempt_tag(
        &self,
        authority: &AttemptAccess,
        input: &AskAttemptTagRequest,
    ) -> Result<AskTagResponse> {
        let _wake = self.hint_after_commit();
        let host = authority.host();
        let attempt = authority.lease();
        name("operation ID", &input.operation_id)?;
        let text = message_text(&input.text)?;
        let digest = digest(&("ask_tag", text))?;
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
        if row.try_get::<i64, _>("state")? != TaskState::Running as i64
            || !lease_is_live(&row, now)?
        {
            return Err(StoreError::FailedPrecondition(
                "asking the Tag requires a live running Attempt".into(),
            ));
        }
        let task = crate::store::task_row(&row)?;
        let kind = crate::work_sessions::task_kind_in(&mut tx, &task.task_id).await?;
        let objective = asking_objective_in(&mut tx, &task, kind)
            .await?
            .ok_or(StoreError::PermissionDenied)?;
        if let Some((prior, message_id)) = messages::operation_in(
            &mut tx,
            OperationScope::Mailbox,
            &task.task_id,
            &input.operation_id,
        )
        .await?
        {
            if prior != digest {
                return Err(StoreError::Conflict(
                    "message operation used different content".into(),
                ));
            }
            tx.rollback().await?;
            return Ok(AskTagResponse {
                message_id,
                duplicate: true,
                wake_deferred: String::new(),
            });
        }
        let asked: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM supertag_v2_objective_asks WHERE task_id=$1")
                .bind(&task.task_id)
                .fetch_one(&mut *tx)
                .await?;
        if asked >= ASKS_PER_TASK {
            return Err(StoreError::FailedPrecondition(
                "this Task already asked its Tag three times; finish the turn and wait for the answer"
                    .into(),
            ));
        }
        let conversation =
            messages::objective_conversation_in(&mut tx, &task.tag_id, &objective, now).await?;
        let stored = messages::insert_message_in(
            &mut tx,
            &messages::NewMessage {
                conversation_id: &conversation,
                sender: Member::Tag(&task.tag_id),
                kind: MessageKind::Question,
                text,
                hops: 0,
                source_task_id: Some(&task.task_id),
                origin_task_id: Some(&task.task_id),
                objective_id: Some(&objective),
                task_id: None,
                effect_digest: None,
                addressees: &[],
                now,
            },
        )
        .await?;
        sqlx::query(
            "INSERT INTO supertag_v2_objective_asks (message_id,objective_id,task_id,asked_at_ms)
             VALUES ($1,$2,$3,$4)",
        )
        .bind(&stored.message_id)
        .bind(&objective)
        .bind(&task.task_id)
        .bind(now)
        .execute(&mut *tx)
        .await?;
        messages::record_operation_in(
            &mut tx,
            OperationScope::Mailbox,
            &task.task_id,
            &input.operation_id,
            &digest,
            &stored.message_id,
        )
        .await?;
        // The limits of the Tag's Team, as for the messages its inbox Session sends, when it is in
        // one.
        let teams: Vec<String> = sqlx::query_scalar(
            "SELECT team_id FROM supertag_v2_team_members WHERE tag_id=$1 ORDER BY team_id LIMIT 2",
        )
        .bind(&task.tag_id)
        .fetch_all(&mut *tx)
        .await?;
        let team = match teams.as_slice() {
            [only] => Some(only.as_str()),
            _ => None,
        };
        let outcome = wakes::wake_in(
            &mut tx,
            &WakeRequest {
                tag_id: &task.tag_id,
                conversation_id: &conversation,
                message_kind: MessageKind::Question,
                sender_tag_id: &task.tag_id,
                seq: stored.seq,
                hops: 0,
                origin_task_id: Some(&task.task_id),
                objective_id: Some(&objective),
                team_id: team,
                now,
            },
        )
        .await?;
        sweep_in(&mut tx, now).await?;
        tx.commit().await?;
        Ok(AskTagResponse {
            message_id: stored.message_id,
            duplicate: false,
            wake_deferred: outcome.deferred.unwrap_or_default(),
        })
    }

    /// `send_message` with `objective`: an inbox turn answers one of its Tag's Objectives that
    /// asked it. The answer settles every open ask of that Objective and runs as its next turn.
    pub(super) async fn answer_attempt_objective(
        &self,
        authority: &AttemptAccess,
        input: &SendAttemptTagMessageRequest,
    ) -> Result<SendTagMessageResponse> {
        let _wake = self.hint_after_commit();
        let host = authority.host();
        let attempt = authority.lease();
        name("operation ID", &input.operation_id)?;
        name("Objective ID", &input.recipient_objective_id)?;
        if input.review.is_some() {
            return Err(invalid(
                "a commit review goes to a Tag; an answer to an Objective takes only text",
            ));
        }
        let text = message_text(&input.text)?;
        let objective_id = input.recipient_objective_id.as_str();
        let digest = digest(&("objective", objective_id, text))?;
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
        if row.try_get::<i64, _>("state")? != TaskState::Running as i64
            || !lease_is_live(&row, now)?
        {
            return Err(StoreError::FailedPrecondition(
                "direct messaging requires a live running Attempt".into(),
            ));
        }
        let task = crate::store::task_row(&row)?;
        // Only the Tag's inbox Session answers its Objectives.
        if !private_session(&task.session_id)
            || crate::work_sessions::task_kind_in(&mut tx, &task.task_id)
                .await?
                .is_some()
        {
            return Err(StoreError::PermissionDenied);
        }
        if let Some((prior, message_id)) = messages::operation_in(
            &mut tx,
            OperationScope::Mailbox,
            &task.task_id,
            &input.operation_id,
        )
        .await?
        {
            if prior != digest {
                return Err(StoreError::Conflict(
                    "message operation used different content".into(),
                ));
            }
            let message = answer_message_in(&mut tx, &message_id).await?;
            tx.rollback().await?;
            return Ok(SendTagMessageResponse {
                message: Some(message),
                duplicate: true,
                approval: None,
                review: None,
                wake_deferred: String::new(),
            });
        }
        let owner: Option<String> = sqlx::query_scalar(
            "SELECT owner_tag_id FROM supertag_v2_objectives WHERE objective_id=$1",
        )
        .bind(objective_id)
        .fetch_optional(&mut *tx)
        .await?;
        if owner.as_deref() != Some(task.tag_id.as_str()) {
            return Err(StoreError::NotFound(format!(
                "this Tag owns no Objective {objective_id}"
            )));
        }
        if !waiting_in(&mut tx, objective_id).await? {
            return Err(StoreError::FailedPrecondition(format!(
                "Objective {objective_id} has asked nothing that waits for an answer"
            )));
        }
        let kind = match MessageKind::try_from(input.kind) {
            Ok(MessageKind::Unspecified | MessageKind::Note) => MessageKind::Note,
            Ok(MessageKind::Review) | Err(_) => {
                return Err(invalid("an answer to an Objective has no review type"));
            }
            Ok(kind) => kind,
        };
        let conversation =
            messages::objective_conversation_in(&mut tx, &task.tag_id, objective_id, now).await?;
        let stored = messages::insert_message_in(
            &mut tx,
            &messages::NewMessage {
                conversation_id: &conversation,
                sender: Member::Tag(&task.tag_id),
                kind,
                text,
                hops: 0,
                source_task_id: Some(&task.task_id),
                origin_task_id: Some(&task.task_id),
                objective_id: Some(objective_id),
                task_id: None,
                effect_digest: None,
                addressees: &[],
                now,
            },
        )
        .await?;
        let turn =
            crate::objectives::answer_turn_in(&mut tx, objective_id, &stored.message_id, text, now)
                .await?;
        sqlx::query(
            "UPDATE supertag_v2_objective_asks SET answer_message_id=$1,answer_task_id=$2,
                answered_at_ms=$3
             WHERE objective_id=$4 AND answered_at_ms IS NULL",
        )
        .bind(&stored.message_id)
        .bind(&turn)
        .bind(now)
        .bind(objective_id)
        .execute(&mut *tx)
        .await?;
        messages::record_operation_in(
            &mut tx,
            OperationScope::Mailbox,
            &task.task_id,
            &input.operation_id,
            &digest,
            &stored.message_id,
        )
        .await?;
        let message = answer_message_in(&mut tx, &stored.message_id).await?;
        tx.commit().await?;
        Ok(SendTagMessageResponse {
            message: Some(message),
            duplicate: false,
            approval: None,
            review: None,
            wake_deferred: String::new(),
        })
    }
}
