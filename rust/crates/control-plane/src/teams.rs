//! Team definitions and scheduling policy. Mutations share the Control Plane write order.

pub(crate) mod workstreams;

use prost::Message;
use sha2::{Digest, Sha256};
use sqlx::{Any, Row, Transaction, any::AnyRow};
use supertag_protocol::{MAX_MESSAGE_BYTES, v2::*};
use tonic::{Request, Response, Status};

use crate::{
    ControlPlane, Store, StoreError,
    store::{Result, invalid, name},
};

const MAX_MEMBERS: usize = 100;
const PAGE_LIMIT: u32 = 32;

impl Store {
    pub async fn create_team(&self, principal: &str, input: &CreateTeamRequest) -> Result<Team> {
        operator(principal)?;
        name("operation ID", &input.operation_id)?;
        let label = team_name(&input.name)?;
        let id = team_id(if input.team_id.is_empty() {
            label
        } else {
            &input.team_id
        })?;
        let members = member_ids(&input.member_tag_ids)?;
        let concurrency = input.max_concurrency.map(validate_limit).transpose()?;
        let digest = digest(
            "create",
            &CreateTeamRequest {
                operation_id: String::new(),
                team_id: id.into(),
                name: label.into(),
                member_tag_ids: members.clone(),
                max_concurrency: concurrency,
            },
        );
        let (mut tx, order) = self.write().await?;
        if let Some(prior) = replay(&mut tx, principal, &input.operation_id, &digest).await? {
            tx.rollback().await?;
            return Ok(prior);
        }
        let team = if let Some(prior) = team_by_id_in(&mut tx, id).await? {
            if prior.name != label
                || prior.member_tag_ids != members
                || prior.max_concurrency != concurrency
            {
                return Err(StoreError::Conflict(
                    "Team ID already exists with a different definition".into(),
                ));
            }
            prior
        } else {
            name_free(&mut tx, id, label).await?;
            validate_members(&mut tx, &members).await?;
            let last: i64 = sqlx::query_scalar("SELECT COALESCE(MAX(revision),0) FROM supertag_v2_team_operations WHERE team_id=$1")
                .bind(id).fetch_one(&mut *tx).await?;
            let revision = next_revision(last)?;
            let now = self.execution_now_ms();
            sqlx::query("INSERT INTO supertag_v2_teams (team_id,name,max_concurrency,revision,created_at_ms,updated_at_ms) VALUES ($1,$2,$3,$4,$5,$5)")
                .bind(id).bind(label).bind(concurrency.map(i64::from)).bind(revision).bind(now).execute(&mut *tx).await?;
            replace_members(&mut tx, id, &members).await?;
            Team {
                team_id: id.into(),
                name: label.into(),
                member_tag_ids: members,
                max_concurrency: concurrency,
                revision: revision as u64,
                created_at_ms: now,
                updated_at_ms: now,
            }
        };
        receipt(
            &mut tx,
            principal,
            &input.operation_id,
            "create",
            &digest,
            &team,
            order,
        )
        .await?;
        tx.commit().await?;
        Ok(team)
    }

    pub async fn get_team(&self, principal: &str, reference: &str) -> Result<Team> {
        operator(principal)?;
        let mut tx = self.pool.begin().await?;
        let team = team_by_reference_in(&mut tx, reference).await?;
        tx.commit().await?;
        Ok(team)
    }

    pub async fn list_teams(
        &self,
        principal: &str,
        input: &ListTeamsRequest,
    ) -> Result<ListTeamsResponse> {
        operator(principal)?;
        if !input.cursor.is_empty() {
            team_name(&input.cursor)?;
        }
        let limit = if input.limit == 0 {
            PAGE_LIMIT
        } else {
            input.limit.min(PAGE_LIMIT)
        } as usize;
        let mut tx = self.pool.begin().await?;
        if !input.member_tag_id.is_empty() {
            name("member Tag ID", &input.member_tag_id)?;
            validate_members(&mut tx, std::slice::from_ref(&input.member_tag_id)).await?;
        }
        // Limit Teams before expanding their membership, keeping the entire
        // page under the public gRPC message bound with one database read.
        let rows = sqlx::query("WITH page AS (
                SELECT t.* FROM supertag_v2_teams t WHERE t.name > $1
                AND ($2='' OR EXISTS (SELECT 1 FROM supertag_v2_team_members filter WHERE filter.team_id=t.team_id AND filter.tag_id=$2))
                ORDER BY t.name LIMIT $3
            ) SELECT page.*,m.tag_id AS member_tag_id FROM page
              JOIN supertag_v2_team_members m ON m.team_id=page.team_id ORDER BY page.name,m.tag_id")
            .bind(&input.cursor).bind(&input.member_tag_id).bind(limit as i64 + 1)
            .fetch_all(&mut *tx).await?;
        let mut teams: Vec<Team> = Vec::new();
        let mut next_cursor = String::new();
        for row in rows {
            let id: String = row.try_get("team_id")?;
            let member: String = row.try_get("member_tag_id")?;
            if let Some(team) = teams.last_mut().filter(|team| team.team_id == id) {
                team.member_tag_ids.push(member);
                continue;
            }
            if teams.len() == limit {
                next_cursor = teams.last().expect("nonempty Team page").name.clone();
                break;
            }
            let mut team = team_row(&row)?;
            team.member_tag_ids.push(member);
            teams.push(team);
        }
        for team in &mut teams {
            team.member_tag_ids.sort_unstable();
        }
        tx.commit().await?;
        Ok(ListTeamsResponse { teams, next_cursor })
    }

    pub async fn update_team(&self, principal: &str, input: &UpdateTeamRequest) -> Result<Team> {
        operator(principal)?;
        name("operation ID", &input.operation_id)?;
        if input.expected_revision == 0 || input.expected_revision > i64::MAX as u64 {
            return Err(invalid("a positive expected Team revision is required"));
        }
        let label = input.name.as_deref().map(team_name).transpose()?;
        let members = input
            .members
            .as_ref()
            .map(|members| member_ids(&members.tag_ids))
            .transpose()?;
        let limit = input
            .max_concurrency
            .map(|limit| {
                if limit == 0 {
                    Ok(None)
                } else {
                    validate_limit(limit).map(Some)
                }
            })
            .transpose()?;
        if label.is_none() && members.is_none() && limit.is_none() {
            return Err(invalid(
                "set at least one of Team name, members, or concurrency",
            ));
        }
        // A caller may refresh its revision before replaying an update. The
        // precondition fences a new effect, while the receipt identifies the
        // exact fields that were already accepted.
        let digest = digest(
            "update",
            &UpdateTeamRequest {
                operation_id: String::new(),
                team: input.team.clone(),
                expected_revision: 0,
                name: label.map(str::to_owned),
                members: members.clone().map(|tag_ids| TeamMembers { tag_ids }),
                max_concurrency: input.max_concurrency,
            },
        );
        let (mut tx, order) = self.write().await?;
        if let Some(prior) = replay(&mut tx, principal, &input.operation_id, &digest).await? {
            tx.rollback().await?;
            return Ok(prior);
        }
        let mut team = team_by_reference_in(&mut tx, &input.team).await?;
        let satisfied = label.is_none_or(|label| team.name == label)
            && members
                .as_ref()
                .is_none_or(|members| team.member_tag_ids == *members)
            && limit.is_none_or(|limit| team.max_concurrency == limit);
        if input.expected_revision > team.revision
            || (input.expected_revision < team.revision && !satisfied)
        {
            return Err(StoreError::FailedPrecondition(
                "Team revision changed; reload before updating".into(),
            ));
        }
        if !satisfied {
            if let Some(label) = label {
                name_free(&mut tx, &team.team_id, label).await?;
                team.name = label.into();
            }
            if let Some(members) = members {
                validate_members(&mut tx, &members).await?;
                replace_members(&mut tx, &team.team_id, &members).await?;
                team.member_tag_ids = members;
            }
            team.max_concurrency = limit.unwrap_or(team.max_concurrency);
            team.revision = next_revision(team.revision as i64)? as u64;
            team.updated_at_ms = self.execution_now_ms();
            sqlx::query("UPDATE supertag_v2_teams SET name=$1,max_concurrency=$2,revision=$3,updated_at_ms=$4 WHERE team_id=$5")
                .bind(&team.name).bind(team.max_concurrency.map(i64::from)).bind(team.revision as i64)
                .bind(team.updated_at_ms).bind(&team.team_id).execute(&mut *tx).await?;
        }
        receipt(
            &mut tx,
            principal,
            &input.operation_id,
            "update",
            &digest,
            &team,
            order,
        )
        .await?;
        tx.commit().await?;
        Ok(team)
    }

    pub async fn delete_team(&self, principal: &str, input: &DeleteTeamRequest) -> Result<Team> {
        operator(principal)?;
        name("operation ID", &input.operation_id)?;
        let digest = digest("delete", input);
        let (mut tx, order) = self.write().await?;
        if let Some(prior) = replay(&mut tx, principal, &input.operation_id, &digest).await? {
            tx.rollback().await?;
            return Ok(prior);
        }
        let team = team_by_reference_in(&mut tx, &input.team).await?;
        let open: Option<String> = sqlx::query_scalar("SELECT objective_id FROM supertag_v2_objectives WHERE team_id=$1 AND status NOT IN ($2,$3) ORDER BY created_at_ms,objective_id LIMIT 1")
            .bind(&team.team_id).bind(ObjectiveStatus::Completed as i64).bind(ObjectiveStatus::Cancelled as i64)
            .fetch_optional(&mut *tx).await?;
        if let Some(open) = open {
            return Err(StoreError::FailedPrecondition(format!(
                "Team {} cannot be deleted while Objective {open} names it",
                team.name
            )));
        }
        // The Team's closed Objectives remain readable. Its Workstream and
        // membership cascade with the definition, while receipts stay audited.
        sqlx::query("DELETE FROM supertag_v2_teams WHERE team_id=$1")
            .bind(&team.team_id)
            .execute(&mut *tx)
            .await?;
        receipt(
            &mut tx,
            principal,
            &input.operation_id,
            "delete",
            &digest,
            &team,
            order,
        )
        .await?;
        tx.commit().await?;
        Ok(team)
    }
}

pub(crate) async fn team_by_reference_in(
    tx: &mut Transaction<'_, Any>,
    reference: &str,
) -> Result<Team> {
    team_name(reference)?;
    let rows = sqlx::query(
        "WITH matched AS (
            SELECT * FROM supertag_v2_teams WHERE team_id=$1 OR name=$1
            ORDER BY CASE WHEN team_id=$1 THEN 0 ELSE 1 END LIMIT 1
        ) SELECT matched.*,m.tag_id AS member_tag_id FROM matched
          JOIN supertag_v2_team_members m ON m.team_id=matched.team_id",
    )
    .bind(reference)
    .fetch_all(&mut **tx)
    .await?;
    let first = rows
        .first()
        .ok_or_else(|| StoreError::NotFound("Team was not found".into()))?;
    let mut team = team_row(first)?;
    team.member_tag_ids = rows
        .iter()
        .map(|row| row.try_get("member_tag_id"))
        .collect::<std::result::Result<_, _>>()?;
    team.member_tag_ids.sort_unstable();
    Ok(team)
}

async fn team_by_id_in(tx: &mut Transaction<'_, Any>, id: &str) -> Result<Option<Team>> {
    let row = sqlx::query("SELECT * FROM supertag_v2_teams WHERE team_id=$1")
        .bind(id)
        .fetch_optional(&mut **tx)
        .await?;
    match row {
        Some(row) => Ok(Some(team_with_members(tx, &row).await?)),
        None => Ok(None),
    }
}

async fn team_with_members(tx: &mut Transaction<'_, Any>, row: &AnyRow) -> Result<Team> {
    let mut team = team_row(row)?;
    team.member_tag_ids = sqlx::query_scalar(
        "SELECT tag_id FROM supertag_v2_team_members WHERE team_id=$1 ORDER BY tag_id",
    )
    .bind(&team.team_id)
    .fetch_all(&mut **tx)
    .await?;
    team.member_tag_ids.sort_unstable();
    Ok(team)
}

fn team_row(row: &AnyRow) -> Result<Team> {
    Ok(Team {
        team_id: row.try_get("team_id")?,
        name: row.try_get("name")?,
        member_tag_ids: Vec::new(),
        max_concurrency: row
            .try_get::<Option<i64>, _>("max_concurrency")?
            .map(|limit| limit as u32),
        revision: row.try_get::<i64, _>("revision")? as u64,
        created_at_ms: row.try_get("created_at_ms")?,
        updated_at_ms: row.try_get("updated_at_ms")?,
    })
}

async fn replace_members(
    tx: &mut Transaction<'_, Any>,
    id: &str,
    members: &[String],
) -> Result<()> {
    sqlx::query("DELETE FROM supertag_v2_team_members WHERE team_id=$1")
        .bind(id)
        .execute(&mut **tx)
        .await?;
    for member in members {
        sqlx::query("INSERT INTO supertag_v2_team_members (team_id,tag_id) VALUES ($1,$2)")
            .bind(id)
            .bind(member)
            .execute(&mut **tx)
            .await?;
    }
    Ok(())
}

async fn validate_members(tx: &mut Transaction<'_, Any>, members: &[String]) -> Result<()> {
    for member in members {
        crate::tags::require_active(tx, member).await?;
    }
    Ok(())
}

async fn name_free(tx: &mut Transaction<'_, Any>, id: &str, name: &str) -> Result<()> {
    let other: Option<String> =
        sqlx::query_scalar("SELECT team_id FROM supertag_v2_teams WHERE name=$1 AND team_id<>$2")
            .bind(name)
            .bind(id)
            .fetch_optional(&mut **tx)
            .await?;
    if other.is_some() {
        return Err(StoreError::Conflict("Team name already exists".into()));
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

fn team_name(value: &str) -> Result<&str> {
    let name = value.trim();
    if name.is_empty() || name.encode_utf16().count() > 200 || value.chars().any(char::is_control) {
        return Err(invalid(
            "Team name must contain 1–200 characters without control characters",
        ));
    }
    Ok(name)
}

fn team_id(value: &str) -> Result<&str> {
    if value.is_empty()
        || value.encode_utf16().count() > 200
        || matches!(value, "." | "..")
        || value
            .chars()
            .any(|ch| ch.is_whitespace() || ch.is_control())
    {
        return Err(invalid(
            "Team ID must contain 1–200 characters without whitespace or control characters",
        ));
    }
    Ok(value)
}

fn member_ids(values: &[String]) -> Result<Vec<String>> {
    let mut members = values.to_vec();
    members.sort_unstable();
    members.dedup();
    if members.is_empty() || members.len() > MAX_MEMBERS {
        return Err(invalid("a Team needs 1–100 distinct members"));
    }
    for member in &members {
        name("member Tag ID", member)?;
    }
    Ok(members)
}

fn validate_limit(value: u32) -> Result<u32> {
    if (1..=1000).contains(&value) {
        Ok(value)
    } else {
        Err(invalid("Team concurrency must be from 1 to 1,000"))
    }
}

fn next_revision(current: i64) -> Result<i64> {
    current
        .checked_add(1)
        .ok_or_else(|| StoreError::FailedPrecondition("Team revision limit reached".into()))
}

fn digest(action: &str, input: &impl Message) -> String {
    let mut hash = Sha256::new();
    hash.update(action.as_bytes());
    hash.update([0]);
    hash.update(input.encode_to_vec());
    format!("{:x}", hash.finalize())
}

async fn replay(
    tx: &mut Transaction<'_, Any>,
    principal: &str,
    operation: &str,
    digest: &str,
) -> Result<Option<Team>> {
    let row = sqlx::query("SELECT request_digest,response FROM supertag_v2_team_operations WHERE principal=$1 AND operation_id=$2")
        .bind(principal).bind(operation).fetch_optional(&mut **tx).await?;
    let Some(row) = row else {
        return Ok(None);
    };
    if row.try_get::<String, _>("request_digest")? != digest {
        return Err(StoreError::Conflict(
            "operation ID was used with a different Team request".into(),
        ));
    }
    let bytes: Vec<u8> = row.try_get("response")?;
    Team::decode(bytes.as_slice())
        .map(Some)
        .map_err(|error| sqlx::Error::Decode(Box::new(error)).into())
}

async fn receipt(
    tx: &mut Transaction<'_, Any>,
    principal: &str,
    operation: &str,
    action: &str,
    digest: &str,
    team: &Team,
    order: i64,
) -> Result<()> {
    let revision = if action == "delete" {
        next_revision(team.revision as i64)?
    } else {
        team.revision as i64
    };
    sqlx::query("INSERT INTO supertag_v2_team_operations (principal,operation_id,request_digest,team_id,action,revision,mutation_order,response) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)")
        .bind(principal).bind(operation).bind(digest).bind(&team.team_id).bind(action)
        .bind(revision).bind(order).bind(team.encode_to_vec()).execute(&mut **tx).await?;
    Ok(())
}

pub(crate) async fn capacity_in(
    tx: &mut Transaction<'_, Any>,
    team_id: &str,
    task: &Task,
    now: i64,
) -> Result<bool> {
    let limit: Option<i64> =
        sqlx::query_scalar("SELECT max_concurrency FROM supertag_v2_teams WHERE team_id=$1")
            .bind(team_id)
            .fetch_one(&mut **tx)
            .await?;
    let Some(limit) = limit else {
        return Ok(true);
    };
    // Closing the Objective does not prove that its native execution stopped.
    // Keep its slot reserved until the Worker Host confirms cleanup.
    let held: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM supertag_v2_tasks active
        JOIN supertag_v2_objective_tasks link ON link.task_id=active.task_id
        JOIN supertag_v2_objectives objective ON objective.objective_id=link.objective_id
        WHERE objective.team_id=$1 AND (objective.status NOT IN ($2,$3) OR active.cleanup_pending=1)
        AND active.task_id<>$4
        AND (active.state=$5 OR active.cleanup_pending=1
          OR (active.state=$6 AND active.lease_expires_at_ms>$7 AND ($8=0 OR active.accepted_order < (
            SELECT accepted_order FROM supertag_v2_tasks WHERE task_id=$4
          ))))",
    )
    .bind(team_id)
    .bind(ObjectiveStatus::Completed as i64)
    .bind(ObjectiveStatus::Cancelled as i64)
    .bind(&task.task_id)
    .bind(TaskState::Running as i64)
    .bind(TaskState::Claimed as i64)
    .bind(now)
    .bind(i64::from(task.state() == TaskState::Claimed))
    .fetch_one(&mut **tx)
    .await?;
    Ok(held < limit)
}

impl ControlPlane {
    pub fn teams_service(&self) -> teams_server::TeamsServer<Self> {
        teams_server::TeamsServer::new(self.clone())
            .max_decoding_message_size(MAX_MESSAGE_BYTES)
            .max_encoding_message_size(MAX_MESSAGE_BYTES)
    }
}

#[tonic::async_trait]
impl teams_server::Teams for ControlPlane {
    async fn create_team(
        &self,
        request: Request<CreateTeamRequest>,
    ) -> std::result::Result<Response<Team>, Status> {
        let principal = self.principal(&request, "operator:")?;
        Ok(Response::new(
            self.store
                .create_team(&principal, &request.into_inner())
                .await?,
        ))
    }

    async fn get_team(
        &self,
        request: Request<GetTeamRequest>,
    ) -> std::result::Result<Response<Team>, Status> {
        let principal = self.principal(&request, "operator:")?;
        Ok(Response::new(
            self.store
                .get_team(&principal, &request.into_inner().team)
                .await?,
        ))
    }

    async fn list_teams(
        &self,
        request: Request<ListTeamsRequest>,
    ) -> std::result::Result<Response<ListTeamsResponse>, Status> {
        let principal = self.principal(&request, "operator:")?;
        Ok(Response::new(
            self.store
                .list_teams(&principal, &request.into_inner())
                .await?,
        ))
    }

    async fn update_team(
        &self,
        request: Request<UpdateTeamRequest>,
    ) -> std::result::Result<Response<Team>, Status> {
        let principal = self.principal(&request, "operator:")?;
        Ok(Response::new(
            self.store
                .update_team(&principal, &request.into_inner())
                .await?,
        ))
    }

    async fn delete_team(
        &self,
        request: Request<DeleteTeamRequest>,
    ) -> std::result::Result<Response<Team>, Status> {
        let principal = self.principal(&request, "operator:")?;
        Ok(Response::new(
            self.store
                .delete_team(&principal, &request.into_inner())
                .await?,
        ))
    }

    async fn list_workstream_posts(
        &self,
        request: Request<ListWorkstreamPostsRequest>,
    ) -> std::result::Result<Response<ListWorkstreamPostsResponse>, Status> {
        let principal = self.principal(&request, "operator:")?;
        Ok(Response::new(
            self.store
                .list_workstream_posts(&principal, &request.into_inner())
                .await?,
        ))
    }
}
