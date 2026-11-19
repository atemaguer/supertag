//! Direct messages are durable Mailbox effects, never Workstream posts.
use crate::AttemptAccess;
use sha2::{Digest, Sha256};
use supertag_protocol::v2::commit_review_submission::Kind as ReviewKind;

use super::*;
use crate::{commit_reviews, messages::OperationScope, messages::wakes::WakeRequest};

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

fn review_kind(input: Option<&CommitReviewSubmission>) -> Result<Option<ReviewKind>> {
    let Some(input) = input else { return Ok(None) };
    match input.kind.as_ref() {
        Some(ReviewKind::Commit(commit)) => {
            let commit = commit.to_ascii_lowercase();
            if !supertag_protocol::valid_git_commit(&commit) {
                return Err(invalid("review.commit must be a full Git commit hash"));
            }
            Ok(Some(ReviewKind::Commit(commit)))
        }
        Some(ReviewKind::Response(response)) => {
            if response.request_id.is_empty()
                || response.request_id.encode_utf16().count() > 200
                || response
                    .request_id
                    .chars()
                    .any(|ch| ch.is_control() || ch.is_whitespace())
                || !matches!(
                    response.verdict(),
                    CommitReviewDecision::Approved | CommitReviewDecision::ChangesRequested
                )
            {
                return Err(invalid("review response requires a request ID and verdict"));
            }
            Ok(Some(ReviewKind::Response(response.clone())))
        }
        None => Err(invalid(
            "review must specify a commit or a request ID and verdict",
        )),
    }
}

fn review_arguments(kind: &ReviewKind) -> serde_json::Value {
    match kind {
        ReviewKind::Commit(commit) => serde_json::json!({"commit": commit}),
        ReviewKind::Response(response) => {
            let verdict = match response.verdict() {
                CommitReviewDecision::Approved => "approved",
                CommitReviewDecision::ChangesRequested => "changes_requested",
                CommitReviewDecision::Unspecified => {
                    unreachable!("validated commit review verdict")
                }
            };
            serde_json::json!({"requestId": response.request_id, "verdict": verdict})
        }
    }
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
async fn record_operation_in(
    tx: &mut Transaction<'_, Any>,
    task_id: &str,
    operation_id: &str,
    digest: &str,
    message_id: &str,
) -> Result<()> {
    messages::record_operation_in(
        tx,
        OperationScope::Mailbox,
        task_id,
        operation_id,
        digest,
        message_id,
    )
    .await
}

/// The type a Tag gives its message. A review request is the Control Plane's to mark: a Tag asks
/// for one with `review.commit`.
fn message_kind(value: i32) -> Result<MessageKind> {
    match MessageKind::try_from(value) {
        Ok(MessageKind::Unspecified | MessageKind::Note) => Ok(MessageKind::Note),
        Ok(MessageKind::Review) => Err(invalid(
            "a Tag cannot send the review type; request a commit review with review.commit",
        )),
        Ok(kind) => Ok(kind),
        Err(_) => Err(invalid("unknown message type")),
    }
}

fn type_name(kind: MessageKind) -> &'static str {
    match kind {
        MessageKind::Question => "question",
        MessageKind::Blocker => "blocker",
        MessageKind::Evidence => "evidence",
        MessageKind::Decision => "decision",
        MessageKind::Review => "review",
        MessageKind::Unspecified | MessageKind::Note => "note",
    }
}

/// The Team whose wake limits a Task's direct messages use: its Workstream's, if it has one.
async fn limits_team_in(
    tx: &mut Transaction<'_, Any>,
    task_id: &str,
    sender: &str,
) -> Result<Option<String>> {
    match crate::teams::workstreams::workstream_for_task_in(tx, task_id, sender).await {
        Ok(team) => Ok(Some(team.team_id)),
        Err(StoreError::FailedPrecondition(_) | StoreError::PermissionDenied) => Ok(None),
        Err(error) => Err(error),
    }
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
        crate::tags::require_active(&mut tx, &input.sender_tag_id).await?;
        crate::tags::require_active(&mut tx, &input.recipient_tag_id).await?;
        let result = if input.granted {
            sqlx::query("INSERT INTO supertag_v2_mailbox_grants (sender_tag_id,recipient_tag_id,granted_by,granted_at_ms) VALUES ($1,$2,$3,$4) ON CONFLICT(sender_tag_id,recipient_tag_id) DO NOTHING")
                .bind(&input.sender_tag_id).bind(&input.recipient_tag_id).bind(principal).bind(self.execution_now_ms()).execute(&mut *tx).await?
        } else {
            sqlx::query("DELETE FROM supertag_v2_mailbox_grants WHERE sender_tag_id=$1 AND recipient_tag_id=$2")
                .bind(&input.sender_tag_id).bind(&input.recipient_tag_id).execute(&mut *tx).await?
        };
        let changed = result.rows_affected() != 0;
        if changed {
            crate::manifest_relationships::imperative_change(
                &mut tx,
                &input.recipient_tag_id,
                "acceptsMessagesFrom",
                &input.sender_tag_id,
            )
            .await?;
        }
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
        authority: &AttemptAccess,
        input: &SendAttemptTagMessageRequest,
    ) -> Result<SendTagMessageResponse> {
        let _wake = self.hint_after_commit();
        let host = authority.host();
        let attempt = authority.lease();
        name("operation ID", &input.operation_id)?;
        name("recipient Tag ID", &input.recipient_tag_id)?;
        let text = input.text.trim();
        if text.is_empty() || text.encode_utf16().count() > MAX_MESSAGE_UTF16 || text.contains('\0')
        {
            return Err(invalid(
                "message text must contain 1–8,000 UTF-16 units without a NUL",
            ));
        }
        let review = review_kind(input.review.as_ref())?;
        let chosen = message_kind(input.kind)?;
        let mut arguments =
            serde_json::json!({"recipient_tag_id": input.recipient_tag_id, "text": text});
        if chosen != MessageKind::Note {
            arguments["type"] = type_name(chosen).into();
        }
        let digest = if let Some(review) = &review {
            arguments["review"] = review_arguments(review);
            fingerprint(&arguments)?
        } else if chosen == MessageKind::Note {
            fingerprint(&(&input.recipient_tag_id, text))?
        } else {
            fingerprint(&(&input.recipient_tag_id, text, type_name(chosen)))?
        };
        // A review request is marked by the Control Plane; it wakes its reviewer at once.
        let message_kind = if matches!(review, Some(ReviewKind::Commit(_))) {
            MessageKind::Review
        } else {
            chosen
        };
        let approval_request = RequestApprovalRequest {
            attempt: Some(attempt.clone()),
            operation_id: input.operation_id.clone(),
            action: crate::store::MAILBOX_SEND_ACTION.into(),
            resource: input.recipient_tag_id.clone(),
            arguments_json: serde_json::to_string(&arguments)?,
            summary: match review.as_ref() {
                Some(ReviewKind::Commit(_)) => {
                    "Request review of a delivered commit from this Tag."
                }
                Some(ReviewKind::Response(_)) => {
                    "Record the verdict for an assigned commit review."
                }
                None => "Send a direct message to this Tag's Mailbox.",
            }
            .into(),
        };
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
        let kind = crate::work_sessions::task_kind_in(&mut tx, &attempt.task_id).await?;
        if kind.is_some()
            && !(kind == Some(crate::work_sessions::REPORT)
                && matches!(review, Some(ReviewKind::Commit(_))))
        {
            return Err(StoreError::PermissionDenied);
        }
        let sender: String = task.try_get("tag_id")?;
        if sender == input.recipient_tag_id {
            return Err(invalid("a Tag cannot send a message to itself"));
        }
        crate::tags::require_active(&mut tx, &input.recipient_tag_id).await?;
        // The sender may learn why, so it can tell whoever handed it the work.
        if !may_send_in(&mut tx, &sender, &input.recipient_tag_id).await? {
            let recipient = &input.recipient_tag_id;
            return Err(StoreError::FailedPrecondition(format!(
                "Tag {recipient} does not accept messages from Tag {sender}: they share no Team, and {recipient}'s acceptsMessagesFrom does not name {sender}. An operator can allow it with supertag mailbox-grant allow {sender} {recipient}"
            )));
        }
        let prior = messages::operation_in(
            &mut tx,
            OperationScope::Mailbox,
            &attempt.task_id,
            &input.operation_id,
        )
        .await?;
        if let Some((prior_digest, message_id)) = prior {
            if prior_digest != digest {
                return Err(StoreError::Conflict(
                    "message operation used different content".into(),
                ));
            }
            crate::approvals::ensure_operation_matches_in(
                &mut tx,
                &attempt.attempt_id,
                &approval_request,
            )
            .await?;
            let (message, recorded_review) = if matches!(review, Some(ReviewKind::Response(_))) {
                let stored = commit_reviews::for_message_in(&mut tx, &message_id)
                    .await?
                    .ok_or_else(|| StoreError::NotFound("commit review was not found".into()))?;
                (None, Some(stored))
            } else {
                (
                    Some(tag_message_by_id_in(&mut tx, &message_id).await?),
                    None,
                )
            };
            tx.rollback().await?;
            return Ok(SendTagMessageResponse {
                wake_deferred: String::new(),
                message,
                duplicate: true,
                approval: None,
                review: recorded_review,
            });
        }
        let source = review
            .as_ref()
            .map(|_| crate::store::task_row(&task))
            .transpose()?;
        let validated_request = match (&review, &source) {
            (Some(ReviewKind::Commit(commit)), Some(source)) => Some(
                Box::pin(commit_reviews::validate_request_in(
                    &mut tx,
                    source,
                    &input.recipient_tag_id,
                    commit,
                ))
                .await?,
            ),
            (Some(ReviewKind::Response(response)), Some(source)) => {
                let prior = Box::pin(commit_reviews::validate_response_in(
                    &mut tx,
                    source,
                    &input.recipient_tag_id,
                    &response.request_id,
                ))
                .await?;
                if let Some(verdict) = &prior.verdict {
                    if verdict.decision != response.verdict || verdict.summary != text {
                        return Err(StoreError::Conflict(
                            "commit review already has a different verdict".into(),
                        ));
                    }
                    crate::approvals::ensure_operation_matches_in(
                        &mut tx,
                        &attempt.attempt_id,
                        &approval_request,
                    )
                    .await?;
                    record_operation_in(
                        &mut tx,
                        &attempt.task_id,
                        &input.operation_id,
                        &digest,
                        &response.request_id,
                    )
                    .await?;
                    tx.commit().await?;
                    return Ok(SendTagMessageResponse {
                        wake_deferred: String::new(),
                        message: None,
                        duplicate: true,
                        approval: None,
                        review: Some(prior),
                    });
                }
                None
            }
            _ => None,
        };
        let (is_verdict, (hops, origin)) = if matches!(review, Some(ReviewKind::Response(_))) {
            (true, (0, attempt.task_id.clone()))
        } else {
            let sent: i64 = sqlx::query_scalar(
                "SELECT COUNT(*) FROM supertag_v2_messages m
                 JOIN supertag_v2_conversations c ON c.conversation_id=m.conversation_id AND c.kind=1
                 WHERE m.source_task_id=$1 AND m.sender_kind=1",
            )
            .bind(&attempt.task_id)
            .fetch_one(&mut *tx)
            .await?;
            if sent >= SENDS_PER_TASK {
                return Err(StoreError::FailedPrecondition(
                    "this Task already sent three direct messages".into(),
                ));
            }
            (false, wakes::origin_in(&mut tx, &attempt.task_id).await?)
        };
        let authorization =
            crate::approvals::gate_in(&mut tx, host, &approval_request, now, order).await?;
        if !authorization.granted {
            tx.commit().await?;
            return Ok(SendTagMessageResponse {
                wake_deferred: String::new(),
                message: None,
                duplicate: false,
                approval: authorization.approval,
                review: None,
            });
        }
        if is_verdict && let (Some(ReviewKind::Response(response)), Some(source)) = (review, source)
        {
            let (recorded, duplicate) = Box::pin(commit_reviews::record_response_in(
                &mut tx,
                &source,
                &input.recipient_tag_id,
                &response.request_id,
                response.verdict,
                text,
                now,
            ))
            .await?;
            record_operation_in(
                &mut tx,
                &attempt.task_id,
                &input.operation_id,
                &digest,
                &response.request_id,
            )
            .await?;
            tx.commit().await?;
            return Ok(SendTagMessageResponse {
                wake_deferred: String::new(),
                message: None,
                duplicate,
                approval: None,
                review: Some(recorded),
            });
        }
        let objective: Option<String> = sqlx::query_scalar(
            "SELECT objective_id FROM supertag_v2_objective_tasks WHERE task_id=$1",
        )
        .bind(&attempt.task_id)
        .fetch_optional(&mut *tx)
        .await?;
        let conversation = messages::direct_conversation_in(
            &mut tx,
            Member::Tag(&sender),
            Member::Tag(&input.recipient_tag_id),
            now,
        )
        .await?;
        let stored = messages::insert_message_in(
            &mut tx,
            &messages::NewMessage {
                conversation_id: &conversation,
                sender: Member::Tag(&sender),
                kind: message_kind,
                text,
                hops,
                source_task_id: Some(&attempt.task_id),
                origin_task_id: Some(&origin),
                objective_id: objective.as_deref(),
                task_id: None,
                effect_digest: None,
                addressees: std::slice::from_ref(&input.recipient_tag_id),
                now,
            },
        )
        .await?;
        let id = stored.message_id;
        if let Some(request) = validated_request {
            commit_reviews::insert_request_in(&mut tx, &id, &request, now, order).await?;
        }
        record_operation_in(&mut tx, &attempt.task_id, &input.operation_id, &digest, &id).await?;
        let team = limits_team_in(&mut tx, &attempt.task_id, &sender).await?;
        let outcome = wakes::wake_in(
            &mut tx,
            &WakeRequest {
                tag_id: &input.recipient_tag_id,
                conversation_id: &conversation,
                kind: ConversationKind::Direct,
                message_kind,
                addressed: false,
                sender_tag_id: &sender,
                seq: stored.seq,
                hops,
                origin_task_id: Some(&origin),
                objective_id: objective.as_deref(),
                team_id: team.as_deref(),
                now,
            },
        )
        .await?;
        sweep_in(&mut tx, now).await?;
        let message = tag_message_by_id_in(&mut tx, &id).await?;
        tx.commit().await?;
        Ok(SendTagMessageResponse {
            wake_deferred: outcome.deferred.unwrap_or_default(),
            message: Some(message),
            duplicate: false,
            approval: None,
            review: None,
        })
    }
}
