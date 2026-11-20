use crate::AttemptAccess;
use sha2::{Digest, Sha256};
use sqlx::{Any, Row, Transaction};
use supertag_protocol::{MAX_MESSAGE_BYTES, v2::*};
use tonic::{Request, Response, Status};

use crate::{
    ControlPlane, HostAuthority, Store, StoreError,
    messages::{self, Member, MessageRow, NewMessage, OperationScope},
    store::{Result, WORKSTREAM_POST_ACTION, invalid, lease_is_live, name, owned},
};

use super::{operator, team_by_id_in, team_by_reference_in};

const MAX_BODY: usize = 16_384;
const MAX_RECIPIENTS: usize = 20;
// Even a full page of UTF-16-length-capped bodies and 20 maximum-length
// recipient IDs per post must fit within one public gRPC message.
const PAGE_LIMIT: u32 = 16;

impl Store {
    pub async fn list_workstream_posts(
        &self,
        principal: &str,
        input: &ListWorkstreamPostsRequest,
    ) -> Result<ListWorkstreamPostsResponse> {
        operator(principal)?;
        let mut tx = self.pool.begin().await?;
        let team = team_by_reference_in(&mut tx, &input.team).await?;
        let page = posts_in(
            &mut tx,
            &team.team_id,
            input.after_sequence,
            input.limit,
            &input.cursor,
        )
        .await?;
        tx.commit().await?;
        Ok(page)
    }

    pub async fn read_attempt_workstream(
        &self,
        authority: &AttemptAccess,
        input: &ReadAttemptWorkstreamRequest,
    ) -> Result<ReadAttemptWorkstreamResponse> {
        let host = authority.host();
        let attempt = authority.lease();
        // Serialize lease/Team policy with changes to membership, enrollment,
        // and the Attempt. A read does not consume a durable write order.
        let (mut tx, _) = self.write().await?;
        let (team, _) = attempt_team(&mut tx, host, attempt, self.execution_now_ms()).await?;
        let page = posts_in(
            &mut tx,
            &team.team_id,
            input.after_sequence,
            input.limit,
            &input.cursor,
        )
        .await?;
        tx.rollback().await?;
        Ok(ReadAttemptWorkstreamResponse {
            team: Some(team),
            page: Some(page),
        })
    }

    /// Appends a post to the Team's Workstream, its shared record. A post wakes nobody: each Tag it
    /// addresses gets one more mention, and every member sees it in the digest that opens its next
    /// inbox turn.
    pub async fn post_attempt_workstream(
        &self,
        authority: &AttemptAccess,
        input: &PostAttemptWorkstreamRequest,
    ) -> Result<PostAttemptWorkstreamResponse> {
        let _wake = self.hint_after_commit();
        let host = authority.host();
        let attempt = authority.lease();
        name("operation ID", &input.operation_id)?;
        let body = input.body.trim();
        if body.is_empty() || body.encode_utf16().count() > MAX_BODY || body.contains('\0') {
            return Err(invalid(
                "post body must contain 1–16,384 characters without a NUL",
            ));
        }
        let recipients = recipients(&input.to_tag_ids)?;
        let (mut tx, order) = self.write().await?;
        let now = self.execution_now_ms();
        let (team, author) = attempt_team(&mut tx, host, attempt, now).await?;
        let channel = messages::team_channel_in(&mut tx, &team.team_id)
            .await?
            .ok_or_else(|| StoreError::NotFound("Team Workstream was not found".into()))?;
        let digest = format!(
            "{:x}",
            Sha256::digest(serde_json::to_vec(&(&team.team_id, &recipients, body))?)
        );
        let prior = messages::operation_in(
            &mut tx,
            OperationScope::Workstream,
            &attempt.task_id,
            &input.operation_id,
        )
        .await?;
        if let Some((prior_digest, id)) = prior {
            if prior_digest != digest {
                return Err(StoreError::Conflict(
                    "operation ID was used with a different Workstream post".into(),
                ));
            }
            let post = post_by_id(&mut tx, &team.team_id, &id).await?;
            tx.rollback().await?;
            return Ok(PostAttemptWorkstreamResponse {
                post: Some(post),
                duplicate: true,
                approval: None,
            });
        }
        if recipients
            .iter()
            .any(|id| !team.member_tag_ids.contains(id))
        {
            return Err(StoreError::PermissionDenied);
        }
        let prior: Option<String> = sqlx::query_scalar(
            "SELECT message_id FROM supertag_v2_messages
             WHERE conversation_id=$1 AND source_task_id=$2 AND effect_digest=$3",
        )
        .bind(&channel)
        .bind(&attempt.task_id)
        .bind(&digest)
        .fetch_optional(&mut *tx)
        .await?;
        let approval_request = RequestApprovalRequest {
            attempt: Some(attempt.clone()),
            operation_id: input.operation_id.clone(),
            action: WORKSTREAM_POST_ACTION.into(),
            resource: team.team_id.clone(),
            arguments_json: serde_json::to_string(&serde_json::json!({
                "body": body, "to_tag_ids": recipients,
            }))?,
            summary: format!(
                "Post to the Team Workstream with {} addressed Tags.",
                recipients.len()
            ),
        };
        if prior.is_some() {
            // A duplicate effect adds no post. An operation with a pending
            // approval still cannot be reused for a different effect.
            crate::approvals::ensure_operation_matches_in(
                &mut tx,
                &attempt.attempt_id,
                &approval_request,
            )
            .await?;
        } else {
            let authorization =
                crate::approvals::gate_in(&mut tx, host, &approval_request, now, order).await?;
            if !authorization.granted {
                tx.commit().await?;
                return Ok(PostAttemptWorkstreamResponse {
                    post: None,
                    duplicate: false,
                    approval: authorization.approval,
                });
            }
        }
        let duplicate = prior.is_some();
        let id = if let Some(id) = prior {
            id
        } else {
            let objective = post_objective_in(&mut tx, &attempt.task_id).await?;
            // A post continues no chain: it wakes nobody.
            messages::insert_message_in(
                &mut tx,
                &NewMessage {
                    conversation_id: &channel,
                    sender: Member::Tag(&author),
                    kind: MessageKind::Note,
                    text: body,
                    hops: 0,
                    source_task_id: Some(&attempt.task_id),
                    origin_task_id: None,
                    objective_id: objective.as_deref(),
                    task_id: None,
                    effect_digest: Some(&digest),
                    addressees: &recipients,
                    now,
                },
            )
            .await?
            .message_id
        };
        let post = post_by_id(&mut tx, &team.team_id, &id).await?;
        messages::record_operation_in(
            &mut tx,
            OperationScope::Workstream,
            &attempt.task_id,
            &input.operation_id,
            &digest,
            &id,
        )
        .await?;
        tx.commit().await?;
        Ok(PostAttemptWorkstreamResponse {
            post: Some(post),
            duplicate,
            approval: None,
        })
    }
}

/// The Objective a post belongs to: its Task's own, or else the Objective of the message chain an
/// inbox turn (or an approval continuation of one) continues.
async fn post_objective_in(tx: &mut Transaction<'_, Any>, task_id: &str) -> Result<Option<String>> {
    let own: Option<String> =
        sqlx::query_scalar("SELECT objective_id FROM supertag_v2_objective_tasks WHERE task_id=$1")
            .bind(task_id)
            .fetch_optional(&mut **tx)
            .await?;
    if own.is_some() {
        return Ok(own);
    }
    Ok(sqlx::query_scalar(
        "WITH RECURSIVE source_tasks(task_id) AS (
            SELECT CAST($1 AS TEXT)
            UNION
            SELECT w.task_id FROM supertag_v2_approval_waits w
            JOIN source_tasks s ON w.continuation_task_id=s.task_id
        ) SELECT w.objective_id FROM supertag_v2_session_inputs w
          JOIN source_tasks s ON w.task_id=s.task_id
          WHERE w.objective_id IS NOT NULL AND w.conversation_id IS NOT NULL
          ORDER BY w.hops DESC,w.created_at_ms,w.position LIMIT 1",
    )
    .bind(task_id)
    .fetch_optional(&mut **tx)
    .await?)
}

async fn attempt_team(
    tx: &mut Transaction<'_, Any>,
    host: &HostAuthority,
    attempt: &InspectAttemptRequest,
    now: i64,
) -> Result<(Team, String)> {
    let row = owned(
        tx,
        host,
        &attempt.task_id,
        &attempt.attempt_id,
        &attempt.lease_token,
    )
    .await?;
    if row.try_get::<i64, _>("state")? != TaskState::Running as i64 || !lease_is_live(&row, now)? {
        return Err(StoreError::FailedPrecondition(
            "Workstream access requires a live running Attempt".into(),
        ));
    }
    let author: String = row.try_get("tag_id")?;
    let team = workstream_for_task_in(tx, &attempt.task_id, &author).await?;
    Ok((team, author))
}

pub(crate) async fn workstream_for_task_in(
    tx: &mut Transaction<'_, Any>,
    task_id: &str,
    author: &str,
) -> Result<Team> {
    if crate::work_sessions::task_kind_in(tx, task_id)
        .await?
        .is_some()
    {
        return Err(StoreError::PermissionDenied);
    }
    let objective: Option<Option<String>> = sqlx::query_scalar("SELECT o.team_id FROM supertag_v2_objective_tasks link JOIN supertag_v2_objectives o ON o.objective_id=link.objective_id WHERE link.task_id=$1")
        .bind(task_id).fetch_optional(&mut **tx).await?;
    let id = match objective {
        Some(id) => {
            id.ok_or_else(|| StoreError::FailedPrecondition("this Objective has no Team".into()))?
        }
        None => {
            let teams: Vec<String> = sqlx::query_scalar("SELECT team_id FROM supertag_v2_team_members WHERE tag_id=$1 ORDER BY team_id LIMIT 2")
                .bind(author).fetch_all(&mut **tx).await?;
            match teams.as_slice() {
                [only] => only.clone(),
                [] => {
                    return Err(StoreError::FailedPrecondition(
                        "this Tag is in no Team".into(),
                    ));
                }
                _ => {
                    return Err(StoreError::FailedPrecondition(
                        "this Tag is in several Teams; an Objective must select the Workstream"
                            .into(),
                    ));
                }
            }
        }
    };
    let team = team_by_id_in(tx, &id)
        .await?
        .ok_or_else(|| StoreError::NotFound("Team was not found".into()))?;
    if !team.member_tag_ids.iter().any(|id| id == author) {
        return Err(StoreError::PermissionDenied);
    }
    Ok(team)
}

fn recipients(values: &[String]) -> Result<Vec<String>> {
    let mut ids = values.to_vec();
    ids.sort_unstable();
    ids.dedup();
    if ids.len() > MAX_RECIPIENTS {
        return Err(invalid("a Workstream post may address at most 20 Tags"));
    }
    for id in &ids {
        name("recipient Tag ID", id)?;
    }
    Ok(ids)
}

async fn posts_in(
    tx: &mut Transaction<'_, Any>,
    team: &str,
    after_sequence: Option<u64>,
    limit: u32,
    cursor: &str,
) -> Result<ListWorkstreamPostsResponse> {
    let limit = if limit == 0 {
        PAGE_LIMIT
    } else {
        limit.min(PAGE_LIMIT)
    } as usize;
    let after = if cursor.is_empty() {
        after_sequence
            .map(|value| {
                i64::try_from(value).map_err(|_| invalid("Workstream sequence is too large"))
            })
            .transpose()?
    } else {
        Some(
            cursor
                .strip_prefix('s')
                .and_then(|value| value.parse::<i64>().ok())
                .filter(|value| *value > 0 && format!("s{value}") == cursor)
                .ok_or_else(|| invalid("invalid Workstream cursor"))?,
        )
    };
    let Some(channel) = messages::team_channel_in(tx, team).await? else {
        return Err(StoreError::NotFound("Team Workstream was not found".into()));
    };
    // With a position, one more than a page tells whether more follow; the latest page has none
    // after it.
    let fetch = if after.is_some() { limit + 1 } else { limit };
    let mut rows = messages::page_in(tx, &channel, after, None, fetch as i64).await?;
    let more = rows.len() > limit;
    rows.truncate(limit);
    let posts: Vec<WorkstreamPost> = rows
        .into_iter()
        .map(|message| post_row(team, message))
        .collect();
    let next_cursor = posts
        .last()
        .filter(|_| more)
        .map_or_else(String::new, |post| format!("s{}", post.sequence));
    Ok(ListWorkstreamPostsResponse { posts, next_cursor })
}

async fn post_by_id(tx: &mut Transaction<'_, Any>, team: &str, id: &str) -> Result<WorkstreamPost> {
    let message = messages::message_by_id_in(tx, id)
        .await?
        .ok_or_else(|| StoreError::NotFound("Workstream post was not found".into()))?;
    Ok(post_row(team, message))
}

fn post_row(team: &str, message: MessageRow) -> WorkstreamPost {
    WorkstreamPost {
        post_id: message.message_id,
        team_id: team.to_owned(),
        author_tag_id: message.sender_id,
        to_tag_ids: message.addressees,
        body: message.text,
        source_task_id: message.source_task_id.unwrap_or_default(),
        sequence: message.seq as u64,
        created_at_ms: message.created_at_ms,
    }
}

impl ControlPlane {
    pub fn attempt_workstreams_service(
        &self,
    ) -> attempt_workstreams_server::AttemptWorkstreamsServer<Self> {
        attempt_workstreams_server::AttemptWorkstreamsServer::new(self.clone())
            .max_decoding_message_size(MAX_MESSAGE_BYTES)
            .max_encoding_message_size(MAX_MESSAGE_BYTES)
    }
}

#[tonic::async_trait]
impl attempt_workstreams_server::AttemptWorkstreams for ControlPlane {
    async fn read_attempt_workstream(
        &self,
        request: Request<ReadAttemptWorkstreamRequest>,
    ) -> std::result::Result<Response<ReadAttemptWorkstreamResponse>, Status> {
        let host = self.attempt(&request).await?;
        Ok(Response::new(
            self.store
                .read_attempt_workstream(&host, &request.into_inner())
                .await?,
        ))
    }

    async fn post_attempt_workstream(
        &self,
        request: Request<PostAttemptWorkstreamRequest>,
    ) -> std::result::Result<Response<PostAttemptWorkstreamResponse>, Status> {
        let host = self.attempt(&request).await?;
        Ok(Response::new(
            self.store
                .post_attempt_workstream(&host, &request.into_inner())
                .await?,
        ))
    }
}
