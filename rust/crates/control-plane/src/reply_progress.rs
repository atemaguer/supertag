//! A reply shown while its Task runs, then replaced by the final reply, and the verified
//! delivery card a work Session report carries.
//!
//! TypeScript parity: `packages/control-plane/src/index.ts` enqueues an acknowledgement on
//! admission, replaces it with `progress.updated` text, and delivers the final result into the
//! same message (`outbound-presentation.ts`). Here one row per Task holds only the newest
//! revision, so a slow or restarted Gateway skips stale progress instead of replaying it, and the
//! Control Plane paces updates per message across Gateway restarts.
//!
//! Ambiguity: an unconfirmed first post is never repeated, because the provider may already show
//! it. Updates replace a known message in place and are safe to repeat.
use crate::{
    Store, StoreError, policy,
    store::{Result, connector_account, invalid, name, next_order, task_in, text},
};
use prost::Message;
use serde::Deserialize;
use sqlx::{Any, Row, Transaction, any::AnyRow};
use supertag_protocol::v2::*;
use uuid::Uuid;

const LEASE_MS: i64 = 30_000;
/// Minimum time between two provider writes to one message, including the final replacement.
pub const UPDATE_INTERVAL_MS: i64 = 1_000;
const MAX_PROGRESS_CHARS: usize = 3_000;

/// Records the acknowledgement for a newly admitted Slack Task.
pub(crate) async fn acknowledge_in(
    tx: &mut Transaction<'_, Any>,
    task: &Task,
    account: &str,
    channel: &str,
    thread: &str,
) -> Result<()> {
    let workspace = task
        .workspace
        .as_ref()
        .map(|workspace| workspace.workspace_id.as_str())
        .filter(|workspace| !workspace.is_empty());
    let text = match workspace {
        Some(workspace) => format!("Got it. I’m looking into this in Workspace {workspace} now."),
        None => "Got it. I’m looking into this now.".to_owned(),
    };
    let order = next_order(tx).await?;
    sqlx::query("INSERT INTO supertag_v2_reply_progress (task_id,account_id,conversation_id,thread_id,text,revision,ready_order) VALUES ($1,$2,$3,$4,$5,1,$6)")
        .bind(&task.task_id).bind(account).bind(channel).bind(thread).bind(text).bind(order)
        .execute(&mut **tx).await?;
    Ok(())
}

#[derive(Deserialize)]
struct ProgressEvent {
    #[serde(rename = "type")]
    kind: String,
    progress: Progress,
}

#[derive(Deserialize)]
struct Progress {
    summary: String,
    #[serde(default)]
    items: Vec<ProgressItem>,
}

#[derive(Deserialize)]
struct ProgressItem {
    text: String,
    status: String,
}

/// The text a `progress.updated` Task event shows, formatted as TypeScript `taskProgressText`.
pub(crate) fn progress_text(event: &str) -> Option<String> {
    let event: ProgressEvent = serde_json::from_str(event).ok()?;
    if event.kind != "progress.updated" || event.progress.summary.trim().is_empty() {
        return None;
    }
    let mut text = event.progress.summary;
    if !event.progress.items.is_empty() {
        text.push('\n');
        for item in event.progress.items {
            let marker = match item.status.as_str() {
                "completed" => "✓",
                "active" => "•",
                "blocked" => "!",
                _ => "○",
            };
            text.push_str(&format!("\n{marker} {}", item.text));
        }
    }
    if text.chars().count() > MAX_PROGRESS_CHARS {
        text = text.chars().take(MAX_PROGRESS_CHARS - 1).collect();
        text.push('…');
    }
    Some(text)
}

/// Replaces the newest progress for a running Task. Identical text is not a new revision.
pub(crate) async fn record_in(
    tx: &mut Transaction<'_, Any>,
    task_id: &str,
    event: &str,
) -> Result<()> {
    let Some(text) = progress_text(event) else {
        return Ok(());
    };
    sqlx::query("UPDATE supertag_v2_reply_progress SET text=$1,revision=revision+1 WHERE task_id=$2 AND stopped=0 AND text<>$1")
        .bind(text).bind(task_id).execute(&mut **tx).await?;
    Ok(())
}

/// Expired progress claims. An unconfirmed first post stops the row; an update is retried.
pub(crate) async fn sweep_in(tx: &mut Transaction<'_, Any>, now: i64) -> Result<()> {
    sqlx::query("UPDATE supertag_v2_reply_progress SET stopped=1,lease_token=NULL,lease_revision=NULL,lease_expires_at_ms=NULL WHERE lease_token IS NOT NULL AND lease_expires_at_ms<=$1 AND provider_receipt IS NULL")
        .bind(now).execute(&mut **tx).await?;
    sqlx::query("UPDATE supertag_v2_reply_progress SET lease_token=NULL,lease_revision=NULL,lease_expires_at_ms=NULL WHERE lease_token IS NOT NULL AND lease_expires_at_ms<=$1")
        .bind(now).execute(&mut **tx).await?;
    Ok(())
}

/// SQL condition: the final reply for `supertag_v2_replies.task_id` must wait for an in-flight or
/// recently written progress message, so it always lands last and stays within the pace.
pub(crate) const FINAL_READY: &str = "NOT EXISTS (SELECT 1 FROM supertag_v2_reply_progress p WHERE p.task_id=supertag_v2_replies.task_id AND p.provider_receipt IS NOT NULL AND (p.lease_token IS NOT NULL OR p.next_at_ms>$3)) AND NOT EXISTS (SELECT 1 FROM supertag_v2_reply_progress p WHERE p.task_id=supertag_v2_replies.task_id AND p.provider_receipt IS NULL AND p.lease_token IS NOT NULL)";

/// Failed and cancelled Tasks have no result reply, so their acknowledgement would keep
/// promising work. TypeScript parity: a failed surface Task's final outbound reply is
/// `failureText` (`packages/control-plane/src/index.ts`), which replaces the acknowledgement.
/// Deliberate difference: TypeScript leaves a queued Task's acknowledgement when an operator
/// cancels it; Rust says that it stopped.
pub(crate) async fn enqueue_unsuccessful_in(
    tx: &mut Transaction<'_, Any>,
    account: &str,
) -> Result<()> {
    let rows = sqlx::query(
        "SELECT p.task_id,p.conversation_id,p.thread_id,t.state,t.result FROM supertag_v2_reply_progress p JOIN supertag_v2_tasks t ON t.task_id=p.task_id
         WHERE p.account_id=$1 AND p.closed=0 AND t.state IN ($2,$3)
           AND NOT EXISTS (SELECT 1 FROM supertag_v2_replies r WHERE r.task_id=p.task_id)
         ORDER BY p.ready_order LIMIT 32",
    )
    .bind(account)
    .bind(TaskState::Failed as i64)
    .bind(TaskState::Cancelled as i64)
    .fetch_all(&mut **tx)
    .await?;
    for row in rows {
        let task_id: String = row.try_get("task_id")?;
        let text = unsuccessful_text(
            row.try_get::<i64, _>("state")? == TaskState::Cancelled as i64,
            row.try_get::<Option<String>, _>("result")?.as_deref(),
        );
        let order = next_order(tx).await?;
        sqlx::query("INSERT INTO supertag_v2_replies (reply_id,task_id,account_id,conversation_id,thread_id,text,state,ready_order) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(task_id) DO NOTHING")
            .bind(Uuid::new_v4().to_string()).bind(&task_id).bind(account)
            .bind(row.try_get::<String, _>("conversation_id")?).bind(row.try_get::<String, _>("thread_id")?)
            .bind(text).bind(ReplyState::Pending as i64).bind(order)
            .execute(&mut **tx).await?;
        sqlx::query("UPDATE supertag_v2_reply_progress SET closed=1 WHERE task_id=$1")
            .bind(&task_id)
            .execute(&mut **tx)
            .await?;
    }
    Ok(())
}

/// TypeScript `failureText`: the error on one line, at most 500 characters.
pub(crate) fn unsuccessful_text(cancelled: bool, error: Option<&str>) -> String {
    if cancelled {
        return "I stopped working on this because it was cancelled.".into();
    }
    let error = error
        .unwrap_or_default()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(500)
        .collect::<String>();
    if error.is_empty() {
        "I ran into a problem while working on this.".into()
    } else {
        format!("I ran into a problem while working on this: {error}")
    }
}

/// Adds the in-place replacement target and the result card to a claimed final reply, and
/// stops further progress for its Task.
pub(crate) async fn present_in(tx: &mut Transaction<'_, Any>, reply: &mut Reply) -> Result<()> {
    if let Some(row) = sqlx::query(
        "SELECT provider_receipt FROM supertag_v2_reply_progress WHERE task_id=$1 AND account_id=$2",
    )
    .bind(&reply.task_id)
    .bind(&reply.account_id)
    .fetch_optional(&mut **tx)
    .await?
    {
        reply.replace_provider_receipt = row.try_get("provider_receipt")?;
        sqlx::query("UPDATE supertag_v2_reply_progress SET stopped=1,closed=1 WHERE task_id=$1")
            .bind(&reply.task_id)
            .execute(&mut **tx)
            .await?;
    }
    reply.result_card = result_card_in(tx, &reply.task_id).await?;
    Ok(())
}

/// The verified delivery of the completed work Session a report Task reports on. TypeScript
/// parity: `workSessionResultCard` in `packages/control-plane/src/work-sessions.ts`. The branch is
/// the GitHub publication branch; the pull request URL must be the published receipt's exact URL.
pub(crate) async fn result_card_in(
    tx: &mut Transaction<'_, Any>,
    report_task_id: &str,
) -> Result<Option<ReplyResultCard>> {
    let Some(child) = sqlx::query_scalar::<_, String>(
        "SELECT child_task_id FROM supertag_v2_work_session_reports WHERE report_task_id=$1",
    )
    .bind(report_task_id)
    .fetch_optional(&mut **tx)
    .await?
    else {
        return Ok(None);
    };
    let child = task_in(tx, &child).await?;
    if child.state() != TaskState::Succeeded
        || !child
            .workspace_delivery
            .as_ref()
            .is_some_and(|delivery| delivery.committed)
    {
        return Ok(None);
    }
    let Some(payload) = sqlx::query_scalar::<_, Vec<u8>>(
        "SELECT payload FROM supertag_v2_github_publications WHERE task_id=$1",
    )
    .bind(&child.task_id)
    .fetch_optional(&mut **tx)
    .await?
    else {
        return Ok(None);
    };
    let publication: GithubPublication = policy::decode(&payload)?;
    let published = publication.state() == GithubPublicationState::Published;
    let pull_request_url = publication
        .pull_request
        .as_ref()
        .filter(|_| published)
        .filter(|receipt| {
            receipt.number > 0
                && receipt.url.eq_ignore_ascii_case(&format!(
                    "https://github.com/{}/pull/{}",
                    publication.repository, receipt.number
                ))
                && github_pull_request_url(&receipt.url)
        })
        .map(|receipt| receipt.url.clone());
    // Only a published branch exists on GitHub; an unfinished or failed publication names none.
    let branch = Some(publication.head_branch)
        .filter(|branch| !branch.is_empty())
        .filter(|_| published);
    Ok(
        (branch.is_some() || pull_request_url.is_some()).then_some(ReplyResultCard {
            branch,
            pull_request_url,
        }),
    )
}

fn github_pull_request_url(value: &str) -> bool {
    let Some(path) = value.strip_prefix("https://github.com/") else {
        return false;
    };
    value.len() <= 3_000
        && matches!(path.split('/').collect::<Vec<_>>().as_slice(), [owner, repository, "pull", number]
            if !owner.is_empty()
                && owner.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
                && !repository.is_empty()
                && repository.bytes().all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
                && number.bytes().next().is_some_and(|b| (b'1'..=b'9').contains(&b))
                && number.bytes().all(|b| b.is_ascii_digit()))
}

fn update(row: &AnyRow, revision: i64) -> Result<ReplyProgressUpdate> {
    Ok(ReplyProgressUpdate {
        task_id: row.try_get("task_id")?,
        account_id: row.try_get("account_id")?,
        destination: Some(ReplyDestination {
            conversation_id: row.try_get("conversation_id")?,
            thread_id: Some(row.try_get("thread_id")?),
        }),
        text: row.try_get("text")?,
        revision: u64::try_from(revision).map_err(|_| invalid("invalid progress revision"))?,
        provider_receipt: row.try_get("provider_receipt")?,
    })
}

impl Store {
    pub async fn claim_reply_progress(
        &self,
        principal: &str,
        operation_id: &str,
    ) -> Result<ClaimReplyProgressResponse> {
        let account = connector_account(principal)?;
        name("operation ID", operation_id)?;
        let (mut tx, _) = self.write().await?;
        let now = self.execution_now_ms();
        sweep_in(&mut tx, now).await?;
        if let Some(prior) = sqlx::query_scalar::<_, Vec<u8>>("SELECT response FROM supertag_v2_reply_progress_claims WHERE account_id=$1 AND operation_id=$2")
            .bind(account).bind(operation_id).fetch_optional(&mut *tx).await?
        {
            // A replay may only repeat a write its lease still covers. Once the lease expired,
            // was settled, or the row stopped, the final reply may already be visible, and
            // resending this older text would overwrite or follow it.
            let prior: ClaimReplyProgressResponse = policy::decode(&prior)?;
            let live = match &prior.update {
                Some(update) => sqlx::query_scalar::<_, String>(
                    "SELECT task_id FROM supertag_v2_reply_progress WHERE task_id=$1 AND account_id=$2 AND stopped=0 AND closed=0 AND lease_token=$3",
                )
                .bind(&update.task_id)
                .bind(account)
                .bind(&prior.lease_token)
                .fetch_optional(&mut *tx)
                .await?
                .is_some(),
                None => true,
            };
            tx.commit().await?;
            return Ok(if live {
                prior
            } else {
                ClaimReplyProgressResponse::default()
            });
        }
        // Only a running Task without a final reply shows progress. A final reply replaces it.
        let row = sqlx::query(
            "SELECT p.* FROM supertag_v2_reply_progress p JOIN supertag_v2_tasks t ON t.task_id=p.task_id
             WHERE p.account_id=$1 AND p.stopped=0 AND p.lease_token IS NULL AND p.revision>p.sent_revision
               AND p.next_at_ms<=$2 AND t.state IN ($3,$4)
               AND NOT EXISTS (SELECT 1 FROM supertag_v2_replies r WHERE r.task_id=p.task_id)
             ORDER BY p.ready_order LIMIT 1",
        )
        .bind(account)
        .bind(now)
        .bind(TaskState::Queued as i64)
        .bind(TaskState::Running as i64)
        .fetch_optional(&mut *tx)
        .await?;
        let Some(row) = row else {
            tx.commit().await?;
            return Ok(ClaimReplyProgressResponse::default());
        };
        let revision: i64 = row.try_get("revision")?;
        let lease = Uuid::new_v4().to_string();
        let response = ClaimReplyProgressResponse {
            update: Some(update(&row, revision)?),
            lease_token: lease.clone(),
        };
        sqlx::query("UPDATE supertag_v2_reply_progress SET lease_token=$1,lease_revision=$2,lease_expires_at_ms=$3 WHERE task_id=$4")
            .bind(&lease).bind(revision).bind(now.saturating_add(LEASE_MS)).bind(row.try_get::<String, _>("task_id")?)
            .execute(&mut *tx).await?;
        sqlx::query("INSERT INTO supertag_v2_reply_progress_claims (account_id,operation_id,task_id,response) VALUES ($1,$2,$3,$4)")
            .bind(account).bind(operation_id).bind(row.try_get::<String, _>("task_id")?).bind(response.encode_to_vec())
            .execute(&mut *tx).await?;
        tx.commit().await?;
        Ok(response)
    }

    pub async fn settle_reply_progress(
        &self,
        principal: &str,
        input: &SettleReplyProgressRequest,
    ) -> Result<ReplyProgressUpdate> {
        let account = connector_account(principal)?;
        name("Task ID", &input.task_id)?;
        name("lease token", &input.lease_token)?;
        let state = ReplyState::try_from(input.state).unwrap_or(ReplyState::Unspecified);
        if !matches!(
            state,
            ReplyState::Delivered | ReplyState::Failed | ReplyState::Uncertain
        ) {
            return Err(invalid(
                "progress settlement must be delivered, failed, or uncertain",
            ));
        }
        if let Some(receipt) = &input.provider_receipt {
            text("provider receipt", receipt, 4096)?;
        }
        if (state == ReplyState::Delivered) != input.provider_receipt.is_some() {
            return Err(invalid(
                "only a delivered progress settlement has a provider receipt",
            ));
        }
        let (mut tx, _) = self.write().await?;
        let now = self.execution_now_ms();
        let row = sqlx::query(
            "SELECT * FROM supertag_v2_reply_progress WHERE task_id=$1 AND account_id=$2",
        )
        .bind(&input.task_id)
        .bind(account)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(|| StoreError::NotFound("reply progress was not found".into()))?;
        let claimed = sqlx::query_scalar::<_, Vec<u8>>(
            "SELECT response FROM supertag_v2_reply_progress_claims WHERE account_id=$1 AND task_id=$2",
        )
        .bind(account)
        .bind(&input.task_id)
        .fetch_all(&mut *tx)
        .await?
        .into_iter()
        .filter_map(|bytes| policy::decode::<ClaimReplyProgressResponse>(&bytes).ok())
        .any(|claim| claim.lease_token == input.lease_token);
        if !claimed {
            return Err(StoreError::PermissionDenied);
        }
        let current: Option<String> = row.try_get("lease_token")?;
        if current.as_deref() != Some(input.lease_token.as_str()) {
            // A replay after settlement, or after the claim expired. A later receipt for an
            // unconfirmed first post is accepted once, so the final reply can replace it.
            let receipt: Option<String> = row.try_get("provider_receipt")?;
            if state == ReplyState::Delivered && receipt.is_none() {
                sqlx::query(
                    "UPDATE supertag_v2_reply_progress SET provider_receipt=$1 WHERE task_id=$2",
                )
                .bind(&input.provider_receipt)
                .bind(&input.task_id)
                .execute(&mut *tx)
                .await?;
            } else if state == ReplyState::Delivered && receipt != input.provider_receipt {
                return Err(StoreError::Conflict(
                    "reply progress already has a different provider receipt".into(),
                ));
            }
            let revision: i64 = row.try_get("sent_revision")?;
            let result = update(
                &sqlx::query("SELECT * FROM supertag_v2_reply_progress WHERE task_id=$1")
                    .bind(&input.task_id)
                    .fetch_one(&mut *tx)
                    .await?,
                revision,
            )?;
            tx.commit().await?;
            return Ok(result);
        }
        let leased: i64 = row.try_get("lease_revision")?;
        let receipt: Option<String> = row.try_get("provider_receipt")?;
        if state == ReplyState::Delivered
            && receipt
                .as_ref()
                .is_some_and(|receipt| Some(receipt) != input.provider_receipt.as_ref())
        {
            return Err(StoreError::Conflict(
                "an update returned a different provider message".into(),
            ));
        }
        let first = receipt.is_none();
        match state {
            ReplyState::Delivered => {
                sqlx::query("UPDATE supertag_v2_reply_progress SET provider_receipt=$1,sent_revision=$2,next_at_ms=$3,lease_token=NULL,lease_revision=NULL,lease_expires_at_ms=NULL WHERE task_id=$4")
                    .bind(&input.provider_receipt).bind(leased).bind(now.saturating_add(UPDATE_INTERVAL_MS)).bind(&input.task_id)
                    .execute(&mut *tx).await?;
            }
            // Without a confirmed first message there is nothing to update, and an uncertain
            // post may already be visible: stop, and let the final reply post on its own.
            _ if first => {
                sqlx::query("UPDATE supertag_v2_reply_progress SET stopped=1,lease_token=NULL,lease_revision=NULL,lease_expires_at_ms=NULL WHERE task_id=$1")
                    .bind(&input.task_id).execute(&mut *tx).await?;
            }
            // An update replaces the same message in place. Skip this revision and pace the next.
            _ => {
                sqlx::query("UPDATE supertag_v2_reply_progress SET sent_revision=$1,next_at_ms=$2,lease_token=NULL,lease_revision=NULL,lease_expires_at_ms=NULL WHERE task_id=$3")
                    .bind(leased).bind(now.saturating_add(UPDATE_INTERVAL_MS)).bind(&input.task_id)
                    .execute(&mut *tx).await?;
            }
        }
        let row = sqlx::query("SELECT * FROM supertag_v2_reply_progress WHERE task_id=$1")
            .bind(&input.task_id)
            .fetch_one(&mut *tx)
            .await?;
        let result = update(&row, row.try_get("sent_revision")?)?;
        tx.commit().await?;
        Ok(result)
    }
}

impl crate::ControlPlane {
    pub fn reply_progress_service(&self) -> reply_progress_server::ReplyProgressServer<Self> {
        reply_progress_server::ReplyProgressServer::new(self.clone())
            .max_decoding_message_size(supertag_protocol::MAX_MESSAGE_BYTES)
            .max_encoding_message_size(supertag_protocol::MAX_MESSAGE_BYTES)
    }
}

#[tonic::async_trait]
impl reply_progress_server::ReplyProgress for crate::ControlPlane {
    async fn claim(
        &self,
        request: tonic::Request<ClaimReplyProgressRequest>,
    ) -> std::result::Result<tonic::Response<ClaimReplyProgressResponse>, tonic::Status> {
        let principal = self.principal(&request, "connector:")?;
        Ok(tonic::Response::new(
            self.store
                .claim_reply_progress(&principal, &request.get_ref().operation_id)
                .await?,
        ))
    }

    async fn settle(
        &self,
        request: tonic::Request<SettleReplyProgressRequest>,
    ) -> std::result::Result<tonic::Response<ReplyProgressUpdate>, tonic::Status> {
        let principal = self.principal(&request, "connector:")?;
        Ok(tonic::Response::new(
            self.store
                .settle_reply_progress(&principal, request.get_ref())
                .await?,
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::{Connection, Executor};

    async fn card(store: &Store, report: &str) -> Option<ReplyResultCard> {
        let mut tx = store.pool.begin().await.unwrap();
        let card = result_card_in(&mut tx, report).await.unwrap();
        tx.rollback().await.unwrap();
        card
    }

    async fn accept(store: &Store, id: &str, message: &str) -> Task {
        store
            .accept_slack_event(
                "connector:slack-test",
                &AcceptSlackEventRequest {
                    account_id: "slack-test".into(),
                    event_id: id.into(),
                    team_id: "TTEAM1".into(),
                    channel_id: "CCHANNEL1".into(),
                    message_ts: message.into(),
                    thread_ts: message.into(),
                    prompt: "Ship it".into(),
                    mention_tag_id: Some("builder".into()),
                },
            )
            .await
            .unwrap()
            .task
            .unwrap()
    }

    /// TypeScript parity: `tests/slack-session-report-card.test.ts`. Only a completed work
    /// Session with a verified commit has a card, and only an exact published pull request URL.
    async fn result_card_contract(url: &str) {
        let store = Store::open(url).await.unwrap();
        store.put_tag("builder", "Build", vec![]).await.unwrap();
        let starter = accept(&store, "EvSTART", "1794470000.000001").await;
        let child = accept(&store, "EvCHILD", "1794470000.000002").await;
        let report = accept(&store, "EvREPORT", "1794470000.000003").await;
        let delivery = |committed: bool| WorkspaceDeliveryReference {
            workspace_id: "app".into(),
            delivery_id: "delivery".into(),
            head_commit: "abcdef1234567".into(),
            committed,
            ..Default::default()
        };
        sqlx::query("UPDATE supertag_v2_tasks SET state=$1,workspace_delivery=$2 WHERE task_id=$3")
            .bind(TaskState::Succeeded as i64)
            .bind(delivery(true).encode_to_vec())
            .bind(&child.task_id)
            .execute(&store.pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO supertag_v2_work_sessions (work_session_id,title,parent_tag_id,parent_session_id,starter_task_id,tag_id,latest_task_id,created_order) VALUES ('work/ship','ship','builder',$1,$2,'builder',$3,900001)")
            .bind(&starter.session_id).bind(&starter.task_id).bind(&child.task_id)
            .execute(&store.pool).await.unwrap();
        sqlx::query("INSERT INTO supertag_v2_work_session_reports (child_task_id,work_session_id,report_task_id,created_order) VALUES ($1,'work/ship',$2,900002)")
            .bind(&child.task_id).bind(&report.task_id).execute(&store.pool).await.unwrap();
        // A commit that was not published to GitHub has no branch name to show.
        assert_eq!(card(&store, &report.task_id).await, None);
        assert_eq!(card(&store, &starter.task_id).await, None);

        let mut publication = GithubPublication {
            publication_id: "publication".into(),
            task_id: child.task_id.clone(),
            tag_id: "builder".into(),
            session_id: child.session_id.clone(),
            account_id: "github-app".into(),
            repository: "acme/app".into(),
            head_branch: "supertag/session/<!channel>".into(),
            state: GithubPublicationState::Sending as i32,
            created_order: 900003,
            ..Default::default()
        };
        sqlx::query("INSERT INTO supertag_v2_github_publications(publication_id,task_id,tag_id,session_id,account_id,created_order,state,payload) VALUES($1,$2,$3,$4,$5,$6,$7,$8)")
            .bind(&publication.publication_id).bind(&child.task_id).bind("builder").bind(&child.session_id).bind("github-app").bind(900003_i64).bind(publication.state as i64).bind(publication.encode_to_vec())
            .execute(&store.pool).await.unwrap();
        // A branch that is still being published, or failed to publish, is not shown.
        for state in [
            GithubPublicationState::Sending,
            GithubPublicationState::Uncertain,
            GithubPublicationState::Held,
        ] {
            sqlx::query("UPDATE supertag_v2_github_publications SET state=$1,payload=$2 WHERE publication_id='publication'")
                .bind(state as i64)
                .bind(GithubPublication { state: state as i32, ..publication.clone() }.encode_to_vec())
                .execute(&store.pool).await.unwrap();
            assert_eq!(card(&store, &report.task_id).await, None, "{state:?}");
        }
        let branch_only = Some(ReplyResultCard {
            branch: Some("supertag/session/<!channel>".into()),
            pull_request_url: None,
        });

        let save = |publication: GithubPublication| {
            let pool = store.pool.clone();
            async move {
                sqlx::query("UPDATE supertag_v2_github_publications SET state=$1,payload=$2 WHERE publication_id='publication'")
                    .bind(publication.state as i64).bind(publication.encode_to_vec()).execute(&pool).await.unwrap();
            }
        };
        publication.state = GithubPublicationState::Published as i32;
        for (number, url) in [
            (8, "https://github.com/acme/app/pull/7"),
            (7, "https://github.com.evil.example/acme/app/pull/7"),
            (7, "https://github.com/acme/app/pull/7/files"),
            (7, "http://github.com/acme/app/pull/7"),
        ] {
            publication.pull_request = Some(GithubPullRequestReceipt {
                number,
                url: url.into(),
                ..Default::default()
            });
            save(publication.clone()).await;
            assert_eq!(card(&store, &report.task_id).await, branch_only, "{url}");
        }
        publication.pull_request = Some(GithubPullRequestReceipt {
            number: 7,
            url: "https://github.com/acme/app/pull/7".into(),
            ..Default::default()
        });
        save(publication).await;
        let complete = Some(ReplyResultCard {
            branch: Some("supertag/session/<!channel>".into()),
            pull_request_url: Some("https://github.com/acme/app/pull/7".into()),
        });
        assert_eq!(card(&store, &report.task_id).await, complete);

        // The claimed final reply carries the card; no other reply does.
        sqlx::query("INSERT INTO supertag_v2_replies (reply_id,task_id,account_id,conversation_id,thread_id,text,state,ready_order) VALUES ('report-reply',$1,'slack-test','CCHANNEL1','1794470000.000001','Reported.',$2,900004)")
            .bind(&report.task_id).bind(ReplyState::Pending as i64).execute(&store.pool).await.unwrap();
        let claimed = store
            .claim_reply("connector:slack-test", "report")
            .await
            .unwrap()
            .reply
            .unwrap();
        assert_eq!(claimed.text, "Reported.");
        assert_eq!(claimed.result_card, complete);

        // Only a succeeded child with a committed delivery is reported as delivered.
        sqlx::query("UPDATE supertag_v2_tasks SET workspace_delivery=$1 WHERE task_id=$2")
            .bind(delivery(false).encode_to_vec())
            .bind(&child.task_id)
            .execute(&store.pool)
            .await
            .unwrap();
        assert_eq!(card(&store, &report.task_id).await, None);
        sqlx::query("UPDATE supertag_v2_tasks SET state=$1,workspace_delivery=$2 WHERE task_id=$3")
            .bind(TaskState::Failed as i64)
            .bind(delivery(true).encode_to_vec())
            .bind(&child.task_id)
            .execute(&store.pool)
            .await
            .unwrap();
        assert_eq!(card(&store, &report.task_id).await, None);
        store.close().await;
    }

    #[tokio::test]
    async fn sqlite_result_card_reports_only_verified_delivery() {
        let directory = tempfile::tempdir().unwrap();
        result_card_contract(&format!(
            "sqlite://{}?mode=rwc",
            directory.path().join("card.db").display()
        ))
        .await;
    }

    #[tokio::test]
    #[ignore = "requires SUPERTAG_RUST_TEST_POSTGRES_URL_FILE for a dedicated PostgreSQL test server"]
    async fn postgres_result_card_reports_only_verified_delivery() {
        let path = std::env::var_os("SUPERTAG_RUST_TEST_POSTGRES_URL_FILE")
            .expect("PostgreSQL test URL file required");
        let admin_url = std::fs::read_to_string(path).unwrap();
        let name = format!("supertag_rust_result_card_{}", Uuid::new_v4().simple());
        let mut admin = sqlx::PgConnection::connect(admin_url.trim()).await.unwrap();
        admin
            .execute(format!("CREATE DATABASE {name}").as_str())
            .await
            .unwrap();
        let mut url = url::Url::parse(admin_url.trim()).unwrap();
        url.set_path(&name);
        let outcome = tokio::task::LocalSet::new()
            .run_until(async move {
                tokio::task::spawn_local(async move { result_card_contract(url.as_str()).await })
                    .await
            })
            .await;
        admin
            .execute(format!("DROP DATABASE {name} WITH (FORCE)").as_str())
            .await
            .unwrap();
        outcome.unwrap();
    }

    #[test]
    fn unsuccessful_text_is_one_bounded_line() {
        assert_eq!(
            unsuccessful_text(false, Some("  a\n\tb  ")),
            "I ran into a problem while working on this: a b"
        );
        assert_eq!(
            unsuccessful_text(false, Some(" ")),
            "I ran into a problem while working on this."
        );
        assert_eq!(
            unsuccessful_text(false, Some(&"é".repeat(600))),
            format!(
                "I ran into a problem while working on this: {}",
                "é".repeat(500)
            )
        );
        assert_eq!(
            unsuccessful_text(true, Some("ignored")),
            "I stopped working on this because it was cancelled."
        );
    }

    #[test]
    fn progress_text_matches_the_typescript_format_and_ignores_other_events() {
        assert_eq!(
            progress_text(r#"{"type":"progress.updated","progress":{"summary":"Fixing tests","items":[{"text":"Read","status":"completed"},{"text":"Patch","status":"active"},{"text":"CI","status":"blocked"},{"text":"Ship","status":"pending"}]}}"#).as_deref(),
            Some("Fixing tests\n\n✓ Read\n• Patch\n! CI\n○ Ship")
        );
        assert_eq!(
            progress_text(r#"{"type":"progress.updated","progress":{"summary":"Only"}}"#)
                .as_deref(),
            Some("Only")
        );
        for other in [
            "Codex started",
            r#"{"type":"item.completed","item":{}}"#,
            r#"{"type":"progress.updated","progress":{"summary":" "}}"#,
        ] {
            assert_eq!(progress_text(other), None);
        }
    }
}
