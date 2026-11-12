use sha2::{Digest, Sha256};
use sqlx::{Any, Row, Transaction, any::AnyRow};
use supertag_protocol::{MAX_MESSAGE_BYTES, v2::*};
use tonic::{Request, Response, Status};
use uuid::Uuid;

use crate::{
    ControlPlane, HostAuthority, Store, StoreError,
    store::{Result, invalid, lease_is_live, name, owned},
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
        host: &HostAuthority,
        input: &ReadAttemptWorkstreamRequest,
    ) -> Result<ReadAttemptWorkstreamResponse> {
        let attempt = input
            .attempt
            .as_ref()
            .ok_or_else(|| invalid("Attempt identity is required"))?;
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

    pub async fn post_attempt_workstream(
        &self,
        host: &HostAuthority,
        input: &PostAttemptWorkstreamRequest,
    ) -> Result<PostAttemptWorkstreamResponse> {
        let attempt = input
            .attempt
            .as_ref()
            .ok_or_else(|| invalid("Attempt identity is required"))?;
        name("operation ID", &input.operation_id)?;
        let body = input.body.trim();
        if body.is_empty() || body.encode_utf16().count() > MAX_BODY || body.contains('\0') {
            return Err(invalid(
                "post body must contain 1–16,384 characters without a NUL",
            ));
        }
        let recipients = recipients(&input.to_tag_ids)?;
        let (mut tx, _) = self.write().await?;
        let now = self.execution_now_ms();
        let (team, author) = attempt_team(&mut tx, host, attempt, now).await?;
        if !team.member_tag_ids.contains(&author) {
            return Err(StoreError::PermissionDenied);
        }
        let digest = format!(
            "{:x}",
            Sha256::digest(serde_json::to_vec(&(&team.team_id, &recipients, body))?)
        );
        let prior = sqlx::query("SELECT request_digest,post_id FROM supertag_v2_workstream_operations WHERE source_task_id=$1 AND operation_id=$2")
            .bind(&attempt.task_id).bind(&input.operation_id).fetch_optional(&mut *tx).await?;
        if let Some(prior) = prior {
            if prior.try_get::<String, _>("request_digest")? != digest {
                return Err(StoreError::Conflict(
                    "operation ID was used with a different Workstream post".into(),
                ));
            }
            let id: String = prior.try_get("post_id")?;
            let post = post_by_id(&mut tx, &id).await?;
            tx.rollback().await?;
            return Ok(PostAttemptWorkstreamResponse {
                post: Some(post),
                duplicate: true,
            });
        }
        if recipients
            .iter()
            .any(|id| !team.member_tag_ids.contains(id))
        {
            return Err(StoreError::PermissionDenied);
        }
        let prior = sqlx::query("SELECT * FROM supertag_v2_workstream_posts WHERE team_id=$1 AND source_task_id=$2 AND effect_digest=$3")
            .bind(&team.team_id).bind(&attempt.task_id).bind(&digest).fetch_optional(&mut *tx).await?;
        let duplicate = prior.is_some();
        let post = if let Some(row) = prior {
            post_row(&row)?
        } else {
            let id = Uuid::new_v4().to_string();
            let sequence: i64 = sqlx::query_scalar("UPDATE supertag_v2_teams SET next_post_sequence=next_post_sequence+1 WHERE team_id=$1 RETURNING next_post_sequence-1")
                .bind(&team.team_id).fetch_one(&mut *tx).await?;
            sqlx::query("INSERT INTO supertag_v2_workstream_posts (post_id,team_id,author_tag_id,source_task_id,to_tag_ids,body,effect_digest,sequence,created_at_ms) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)")
                .bind(&id).bind(&team.team_id).bind(&author).bind(&attempt.task_id).bind(serde_json::to_string(&recipients)?)
                .bind(body).bind(&digest).bind(sequence).bind(now).execute(&mut *tx).await?;
            WorkstreamPost {
                post_id: id,
                team_id: team.team_id,
                author_tag_id: author,
                to_tag_ids: recipients,
                body: body.into(),
                source_task_id: attempt.task_id.clone(),
                sequence: sequence as u64,
                created_at_ms: now,
            }
        };
        sqlx::query("INSERT INTO supertag_v2_workstream_operations (source_task_id,operation_id,request_digest,post_id) VALUES ($1,$2,$3,$4)")
            .bind(&attempt.task_id).bind(&input.operation_id).bind(&digest).bind(&post.post_id)
            .execute(&mut *tx).await?;
        tx.commit().await?;
        Ok(PostAttemptWorkstreamResponse {
            post: Some(post),
            duplicate,
        })
    }
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
    let objective: Option<Option<String>> = sqlx::query_scalar("SELECT o.team_id FROM supertag_v2_objective_tasks link JOIN supertag_v2_objectives o ON o.objective_id=link.objective_id WHERE link.task_id=$1")
        .bind(&attempt.task_id).fetch_optional(&mut **tx).await?;
    let id = match objective {
        Some(id) => {
            id.ok_or_else(|| StoreError::FailedPrecondition("this Objective has no Team".into()))?
        }
        None => {
            let teams: Vec<String> = sqlx::query_scalar("SELECT team_id FROM supertag_v2_team_members WHERE tag_id=$1 ORDER BY team_id LIMIT 2")
                .bind(&author).fetch_all(&mut **tx).await?;
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
    Ok((team, author))
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
    let mut rows = if let Some(after) = after {
        sqlx::query("SELECT * FROM supertag_v2_workstream_posts WHERE team_id=$1 AND sequence>$2 ORDER BY sequence LIMIT $3")
            .bind(team).bind(after).bind(limit as i64 + 1).fetch_all(&mut **tx).await?
    } else {
        let mut latest = sqlx::query("SELECT * FROM supertag_v2_workstream_posts WHERE team_id=$1 ORDER BY sequence DESC LIMIT $2")
            .bind(team).bind(limit as i64).fetch_all(&mut **tx).await?;
        latest.reverse();
        latest
    };
    let more = rows.len() > limit;
    rows.truncate(limit);
    let posts: Vec<WorkstreamPost> = rows.iter().map(post_row).collect::<Result<_>>()?;
    let next_cursor = posts
        .last()
        .filter(|_| more)
        .map_or_else(String::new, |post| format!("s{}", post.sequence));
    Ok(ListWorkstreamPostsResponse { posts, next_cursor })
}

async fn post_by_id(tx: &mut Transaction<'_, Any>, id: &str) -> Result<WorkstreamPost> {
    let row = sqlx::query("SELECT * FROM supertag_v2_workstream_posts WHERE post_id=$1")
        .bind(id)
        .fetch_one(&mut **tx)
        .await?;
    post_row(&row)
}

fn post_row(row: &AnyRow) -> Result<WorkstreamPost> {
    Ok(WorkstreamPost {
        post_id: row.try_get("post_id")?,
        team_id: row.try_get("team_id")?,
        author_tag_id: row.try_get("author_tag_id")?,
        to_tag_ids: serde_json::from_str(&row.try_get::<String, _>("to_tag_ids")?)?,
        body: row.try_get("body")?,
        source_task_id: row.try_get("source_task_id")?,
        sequence: row.try_get::<i64, _>("sequence")? as u64,
        created_at_ms: row.try_get("created_at_ms")?,
    })
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
        let host = self.host_authority(&request)?;
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
        let host = self.host_authority(&request)?;
        Ok(Response::new(
            self.store
                .post_attempt_workstream(&host, &request.into_inner())
                .await?,
        ))
    }
}
