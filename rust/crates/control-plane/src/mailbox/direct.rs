//! Direct messages are durable Mailbox effects, never Workstream posts.
use sha2::{Digest, Sha256};

use super::*;

const SENDS_PER_TASK: i64 = 3;

fn operator(principal: &str) -> Result<()> {
    let id = principal
        .strip_prefix("operator:")
        .ok_or(StoreError::PermissionDenied)?;
    name("operator identity", id)
}
fn fingerprint(value: &impl serde::Serialize) -> Result<String> {
    Ok(format!(
        "sha256:{:x}",
        Sha256::digest(serde_json::to_vec(value)?)
    ))
}
async fn exists_in(tx: &mut Transaction<'_, Any>, tag: &str) -> Result<()> {
    let exists: Option<String> =
        sqlx::query_scalar("SELECT tag_id FROM supertag_v2_tags WHERE tag_id=$1")
            .bind(tag)
            .fetch_optional(&mut **tx)
            .await?;
    if exists.is_none() {
        return Err(StoreError::NotFound("Tag was not found".into()));
    }
    Ok(())
}
async fn may_send_in(tx: &mut Transaction<'_, Any>, sender: &str, recipient: &str) -> Result<bool> {
    let shared: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM supertag_v2_team_members a JOIN supertag_v2_team_members b ON a.team_id=b.team_id WHERE a.tag_id=$1 AND b.tag_id=$2")
        .bind(sender).bind(recipient).fetch_one(&mut **tx).await?;
    if shared > 0 {
        return Ok(true);
    }
    let granted: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM supertag_v2_mailbox_grants WHERE sender_tag_id=$1 AND recipient_tag_id=$2")
        .bind(sender).bind(recipient).fetch_one(&mut **tx).await?;
    Ok(granted > 0)
}
async fn message_in(tx: &mut Transaction<'_, Any>, id: &str) -> Result<TagMessage> {
    let row = sqlx::query("SELECT m.*,t.state AS task_state FROM supertag_v2_mailbox_messages m LEFT JOIN supertag_v2_tasks t ON t.task_id=m.task_id WHERE m.message_id=$1")
        .bind(id).fetch_one(&mut **tx).await?;
    message_row(&row)
}

impl Store {
    pub async fn change_mailbox_grant(
        &self,
        principal: &str,
        input: &ChangeMailboxGrantRequest,
    ) -> Result<ChangeMailboxGrantResponse> {
        operator(principal)?;
        name("operation ID", &input.operation_id)?;
        name("sender Tag ID", &input.sender_tag_id)?;
        name("recipient Tag ID", &input.recipient_tag_id)?;
        if input.sender_tag_id == input.recipient_tag_id {
            return Err(invalid("a Tag cannot grant itself messaging access"));
        }
        let digest = fingerprint(&(&input.sender_tag_id, &input.recipient_tag_id, input.granted))?;
        let (mut tx, _) = self.write().await?;
        let prior = sqlx::query("SELECT request_digest,changed FROM supertag_v2_mailbox_grant_operations WHERE principal=$1 AND operation_id=$2")
            .bind(principal).bind(&input.operation_id).fetch_optional(&mut *tx).await?;
        if let Some(prior) = prior {
            if prior.try_get::<String, _>("request_digest")? != digest {
                return Err(StoreError::Conflict(
                    "grant operation used different content".into(),
                ));
            }
            let changed = prior.try_get::<i64, _>("changed")? != 0;
            tx.rollback().await?;
            return Ok(ChangeMailboxGrantResponse { changed });
        }
        exists_in(&mut tx, &input.sender_tag_id).await?;
        exists_in(&mut tx, &input.recipient_tag_id).await?;
        let result = if input.granted {
            sqlx::query("INSERT INTO supertag_v2_mailbox_grants (sender_tag_id,recipient_tag_id,granted_by,granted_at_ms) VALUES ($1,$2,$3,$4) ON CONFLICT(sender_tag_id,recipient_tag_id) DO NOTHING")
                .bind(&input.sender_tag_id).bind(&input.recipient_tag_id).bind(principal).bind(self.execution_now_ms()).execute(&mut *tx).await?
        } else {
            sqlx::query("DELETE FROM supertag_v2_mailbox_grants WHERE sender_tag_id=$1 AND recipient_tag_id=$2")
                .bind(&input.sender_tag_id).bind(&input.recipient_tag_id).execute(&mut *tx).await?
        };
        let changed = result.rows_affected() != 0;
        sqlx::query("INSERT INTO supertag_v2_mailbox_grant_operations (principal,operation_id,request_digest,changed) VALUES ($1,$2,$3,$4)")
            .bind(principal).bind(&input.operation_id).bind(digest).bind(i64::from(changed)).execute(&mut *tx).await?;
        tx.commit().await?;
        Ok(ChangeMailboxGrantResponse { changed })
    }

    pub async fn list_mailbox_grants(
        &self,
        principal: &str,
        input: &ListMailboxGrantsRequest,
    ) -> Result<ListMailboxGrantsResponse> {
        operator(principal)?;
        name("Tag ID", &input.tag_id)?;
        if input.limit > 100 {
            return Err(invalid("Mailbox grant page limit must be at most 100"));
        }
        let scope = fingerprint(&(principal, &input.tag_id))?;
        let (after_sender, after_recipient) = if input.cursor.is_empty() {
            (String::new(), String::new())
        } else {
            if input.cursor.len() > 1024 {
                return Err(invalid("invalid Mailbox grant cursor"));
            }
            let (sender, recipient, bound): (String, String, String) =
                serde_json::from_str(&input.cursor)
                    .map_err(|_| invalid("invalid Mailbox grant cursor"))?;
            name("cursor sender", &sender)?;
            name("cursor recipient", &recipient)?;
            if bound != scope {
                return Err(invalid("Mailbox grant cursor scope differs"));
            }
            (sender, recipient)
        };
        let limit = if input.limit == 0 { 50 } else { input.limit } as usize;
        let mut tx = self.pool.begin().await?;
        exists_in(&mut tx, &input.tag_id).await?;
        let rows = sqlx::query("SELECT * FROM supertag_v2_mailbox_grants WHERE (sender_tag_id=$1 OR recipient_tag_id=$1) AND (sender_tag_id>$2 OR (sender_tag_id=$2 AND recipient_tag_id>$3)) ORDER BY sender_tag_id,recipient_tag_id LIMIT $4")
            .bind(&input.tag_id).bind(after_sender).bind(after_recipient).bind((limit+1) as i64).fetch_all(&mut *tx).await?;
        let more = rows.len() > limit;
        let mut grants = vec![];
        for row in rows.iter().take(limit) {
            grants.push(MailboxGrant {
                sender_tag_id: row.try_get("sender_tag_id")?,
                recipient_tag_id: row.try_get("recipient_tag_id")?,
                granted_by: row.try_get("granted_by")?,
                granted_at_ms: row.try_get("granted_at_ms")?,
            });
        }
        let next_cursor = if more {
            let last = grants.last().expect("nonempty grant page");
            serde_json::to_string(&(&last.sender_tag_id, &last.recipient_tag_id, scope))?
        } else {
            String::new()
        };
        tx.commit().await?;
        Ok(ListMailboxGrantsResponse {
            grants,
            next_cursor,
        })
    }

    pub async fn send_attempt_tag_message(
        &self,
        host: &HostAuthority,
        input: &SendAttemptTagMessageRequest,
    ) -> Result<SendTagMessageResponse> {
        let attempt = input
            .attempt
            .as_ref()
            .ok_or_else(|| invalid("Attempt identity is required"))?;
        name("operation ID", &input.operation_id)?;
        name("recipient Tag ID", &input.recipient_tag_id)?;
        let text = input.text.trim();
        if text.is_empty() || text.encode_utf16().count() > MAX_MESSAGE_UTF16 || text.contains('\0')
        {
            return Err(invalid(
                "message text must contain 1–8,000 UTF-16 units without a NUL",
            ));
        }
        let digest = fingerprint(&(&input.recipient_tag_id, text))?;
        let (mut tx, order) = self.write().await?;
        let now = self.execution_now_ms();
        let task = owned(
            &mut tx,
            host,
            &attempt.task_id,
            &attempt.attempt_id,
            &attempt.lease_token,
        )
        .await?;
        if task.try_get::<i64, _>("state")? != TaskState::Running as i64
            || !lease_is_live(&task, now)?
        {
            return Err(StoreError::FailedPrecondition(
                "direct messaging requires a live running Attempt".into(),
            ));
        }
        if crate::work_sessions::task_kind_in(&mut tx, &attempt.task_id)
            .await?
            .is_some()
        {
            return Err(StoreError::PermissionDenied);
        }
        let sender: String = task.try_get("tag_id")?;
        if sender == input.recipient_tag_id {
            return Err(invalid("a Tag cannot send a message to itself"));
        }
        exists_in(&mut tx, &input.recipient_tag_id).await?;
        if !may_send_in(&mut tx, &sender, &input.recipient_tag_id).await? {
            return Err(StoreError::PermissionDenied);
        }
        let prior = sqlx::query("SELECT request_digest,message_id FROM supertag_v2_mailbox_send_operations WHERE source_task_id=$1 AND operation_id=$2")
            .bind(&attempt.task_id).bind(&input.operation_id).fetch_optional(&mut *tx).await?;
        if let Some(prior) = prior {
            if prior.try_get::<String, _>("request_digest")? != digest {
                return Err(StoreError::Conflict(
                    "message operation used different content".into(),
                ));
            }
            let message = message_in(&mut tx, &prior.try_get::<String, _>("message_id")?).await?;
            tx.rollback().await?;
            return Ok(SendTagMessageResponse {
                message: Some(message),
                duplicate: true,
                approval: None,
            });
        }
        let sent: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM supertag_v2_mailbox_messages WHERE source_task_id=$1 AND origin=1")
            .bind(&attempt.task_id).fetch_one(&mut *tx).await?;
        if sent >= SENDS_PER_TASK {
            return Err(StoreError::FailedPrecondition(
                "this Task already sent three direct messages".into(),
            ));
        }
        let hops = outgoing_hops_in(&mut tx, &attempt.task_id).await?;
        let authorization = crate::approvals::gate_in(
            &mut tx,
            host,
            &RequestApprovalRequest {
                attempt: Some(attempt.clone()),
                operation_id: input.operation_id.clone(),
                action: crate::store::MAILBOX_SEND_ACTION.into(),
                resource: input.recipient_tag_id.clone(),
                arguments_json: serde_json::to_string(
                    &serde_json::json!({"recipient_tag_id": input.recipient_tag_id, "text": text}),
                )?,
                summary: "Send a direct message to this Tag's Mailbox.".into(),
            },
            now,
            order,
        )
        .await?;
        if !authorization.granted {
            tx.commit().await?;
            return Ok(SendTagMessageResponse {
                message: None,
                duplicate: false,
                approval: authorization.approval,
            });
        }
        let objective: Option<String> = sqlx::query_scalar(
            "SELECT objective_id FROM supertag_v2_objective_tasks WHERE task_id=$1",
        )
        .bind(&attempt.task_id)
        .fetch_optional(&mut *tx)
        .await?;
        let id = Uuid::new_v4().to_string();
        sqlx::query("INSERT INTO supertag_v2_mailbox_messages (message_id,sender_tag_id,recipient_tag_id,source_task_id,origin,objective_id,text,hops,created_at_ms,delivery_order) VALUES ($1,$2,$3,$4,1,$5,$6,$7,$8,$9)")
            .bind(&id).bind(sender).bind(&input.recipient_tag_id).bind(&attempt.task_id).bind(objective).bind(text).bind(hops).bind(now).bind(order).execute(&mut *tx).await?;
        sqlx::query("INSERT INTO supertag_v2_mailbox_send_operations (source_task_id,operation_id,request_digest,message_id) VALUES ($1,$2,$3,$4)")
            .bind(&attempt.task_id).bind(&input.operation_id).bind(digest).bind(&id).execute(&mut *tx).await?;
        sweep_in(&mut tx).await?;
        let message = message_in(&mut tx, &id).await?;
        tx.commit().await?;
        Ok(SendTagMessageResponse {
            message: Some(message),
            duplicate: false,
            approval: None,
        })
    }
}
