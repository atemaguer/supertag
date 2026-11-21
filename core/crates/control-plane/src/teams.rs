//! Team definitions: members, wake limits, and the Workstream. Mutations share the Control Plane
//! write order.

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
        let _wake = self.hint_after_commit();
        operator(principal)?;
        name("operation ID", &input.operation_id)?;
        let label = team_name(&input.name)?;
        let id = team_id(if input.team_id.is_empty() {
            label
        } else {
            &input.team_id
        })?;
        let members = member_ids(&input.member_tag_ids)?;
        let wake_limits = wake_limits(input.wake_limits.as_ref())?;
        let digest = digest(
            "create",
            &CreateTeamRequest {
                wake_limits,
                operation_id: String::new(),
                team_id: id.into(),
                name: label.into(),
                member_tag_ids: members.clone(),
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
                || prior.wake_limits != wake_limits
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
            let (mutual, per_tag, per_objective) = wake_limit_columns(wake_limits);
            sqlx::query("INSERT INTO supertag_v2_teams (team_id,name,revision,created_at_ms,updated_at_ms,wake_mutual_limit,wake_tag_hourly_limit,wake_objective_hourly_limit) VALUES ($1,$2,$3,$4,$4,$5,$6,$7)")
                .bind(id).bind(label).bind(revision).bind(now)
                .bind(mutual).bind(per_tag).bind(per_objective).execute(&mut *tx).await?;
            replace_members(&mut tx, id, &members).await?;
            // The Team's Workstream is its channel; its members read it.
            crate::messages::create_team_channel_in(&mut tx, id, &members, now).await?;
            Team {
                wake_limits,
                team_id: id.into(),
                name: label.into(),
                member_tag_ids: members,
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
        crate::store::actor(principal)?;
        let mut tx = self.pool.begin().await?;
        let team = visible_team_in(&mut tx, principal, reference).await?;
        tx.commit().await?;
        Ok(team)
    }

    /// Whether a client sees the Team now. Operators see every Team; a deleted Team is unseen.
    pub(crate) async fn client_sees_team(
        &self,
        tags: Option<&[String]>,
        team_id: &str,
    ) -> Result<bool> {
        let Some(tags) = tags else {
            return Ok(true);
        };
        let members: Vec<String> =
            sqlx::query_scalar("SELECT tag_id FROM supertag_v2_team_members WHERE team_id=$1")
                .bind(team_id)
                .fetch_all(&self.pool)
                .await?;
        Ok(!members.is_empty() && members.iter().all(|tag| tags.contains(tag)))
    }

    pub async fn list_teams(
        &self,
        principal: &str,
        input: &ListTeamsRequest,
    ) -> Result<ListTeamsResponse> {
        crate::store::actor(principal)?;
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
        // A client whose Auth Key limits its Tags sees only Teams made entirely of those Tags.
        let allowed = crate::store::client_tags_in(&mut tx, principal).await?;
        let outside = match &allowed {
            None => String::new(),
            Some(tags) if tags.is_empty() => " AND 1=0".into(),
            Some(tags) => format!(
                " AND NOT EXISTS (SELECT 1 FROM supertag_v2_team_members outside WHERE outside.team_id=t.team_id AND outside.tag_id NOT IN ({}))",
                (4..4 + tags.len())
                    .map(|index| format!("${index}"))
                    .collect::<Vec<_>>()
                    .join(",")
            ),
        };
        // Limit Teams before expanding their membership, keeping the entire
        // page under the public gRPC message bound with one database read.
        let sql = format!("WITH page AS (
                SELECT t.* FROM supertag_v2_teams t WHERE t.name > $1
                AND ($2='' OR EXISTS (SELECT 1 FROM supertag_v2_team_members filter WHERE filter.team_id=t.team_id AND filter.tag_id=$2)){outside}
                ORDER BY t.name LIMIT $3
            ) SELECT page.*,m.tag_id AS member_tag_id FROM page
              JOIN supertag_v2_team_members m ON m.team_id=page.team_id ORDER BY page.name,m.tag_id");
        let mut query = sqlx::query(&sql)
            .bind(&input.cursor)
            .bind(&input.member_tag_id)
            .bind(limit as i64 + 1);
        for tag in allowed.iter().flatten() {
            query = query.bind(tag);
        }
        let rows = query.fetch_all(&mut *tx).await?;
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
        let _wake = self.hint_after_commit();
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
        let wakes = input
            .wake_limits
            .as_ref()
            .map(|limits| wake_limits(Some(limits)))
            .transpose()?;
        if label.is_none() && members.is_none() && wakes.is_none() {
            return Err(invalid(
                "set at least one of Team name, members, or wake limits",
            ));
        }
        // A caller may refresh its revision before replaying an update. The
        // precondition fences a new effect, while the receipt identifies the
        // exact fields that were already accepted.
        let digest = digest(
            "update",
            &UpdateTeamRequest {
                // A present value replaces all three limits; an empty one restores the defaults.
                wake_limits: wakes.map(Option::unwrap_or_default),
                operation_id: String::new(),
                team: input.team.clone(),
                expected_revision: 0,
                name: label.map(str::to_owned),
                members: members.clone().map(|tag_ids| TeamMembers { tag_ids }),
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
            && wakes.is_none_or(|wakes| team.wake_limits == wakes);
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
            let now = self.execution_now_ms();
            if let Some(members) = members {
                validate_members(&mut tx, &members).await?;
                replace_members(&mut tx, &team.team_id, &members).await?;
                crate::messages::sync_channel_members_in(&mut tx, &team.team_id, &members, now)
                    .await?;
                team.member_tag_ids = members;
            }
            team.wake_limits = wakes.unwrap_or(team.wake_limits);
            team.revision = next_revision(team.revision as i64)? as u64;
            team.updated_at_ms = now;
            let (mutual, per_tag, per_objective) = wake_limit_columns(team.wake_limits);
            sqlx::query("UPDATE supertag_v2_teams SET name=$1,revision=$2,updated_at_ms=$3,wake_mutual_limit=$5,wake_tag_hourly_limit=$6,wake_objective_hourly_limit=$7 WHERE team_id=$4")
                .bind(&team.name).bind(team.revision as i64)
                .bind(team.updated_at_ms).bind(&team.team_id)
                .bind(mutual).bind(per_tag).bind(per_objective).execute(&mut *tx).await?;
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
        let _wake = self.hint_after_commit();
        operator(principal)?;
        name("operation ID", &input.operation_id)?;
        let digest = digest("delete", input);
        let (mut tx, order) = self.write().await?;
        if input.dry_run {
            // A dry run makes every check the deletion makes, then rolls it back unrecorded.
            let team = team_by_reference_in(&mut tx, &input.team).await?;
            delete_team_in(&mut tx, &team, None, self.execution_now_ms()).await?;
            tx.rollback().await?;
            return Ok(team);
        }
        if let Some(prior) = replay(&mut tx, principal, &input.operation_id, &digest).await? {
            tx.rollback().await?;
            return Ok(prior);
        }
        let team = team_by_reference_in(&mut tx, &input.team).await?;
        delete_team_in(&mut tx, &team, None, self.execution_now_ms()).await?;
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

/// Deletes a Team. With `expected_revision`, refuses a Team another writer changed.
pub(crate) async fn delete_team_in(
    tx: &mut Transaction<'_, Any>,
    team: &Team,
    expected_revision: Option<u64>,
    now: i64,
) -> Result<()> {
    if expected_revision.is_some_and(|revision| revision != team.revision) {
        return Err(StoreError::Conflict("Team revision changed".into()));
    }
    // Its membership cascades with the definition, while receipts stay audited. Its Workstream channel is archived and kept as a
    // record, as the Mailbox copies of its addressed posts are.
    crate::messages::archive_team_channel_in(tx, &team.team_id, now).await?;
    sqlx::query("DELETE FROM supertag_v2_teams WHERE team_id=$1")
        .bind(&team.team_id)
        .execute(&mut **tx)
        .await?;
    crate::apply_sets::forget(tx, "Team", &team.team_id).await
}

/// A Team by ID or name as `principal` sees it: a client whose Auth Key limits its Tags sees
/// only Teams made entirely of those Tags, and any other Team as if it did not exist.
pub(crate) async fn visible_team_in(
    tx: &mut Transaction<'_, Any>,
    principal: &str,
    reference: &str,
) -> Result<Team> {
    let team = team_by_reference_in(tx, reference).await?;
    if let Some(tags) = crate::store::client_tags_in(tx, principal).await?
        && !team.member_tag_ids.iter().all(|tag| tags.contains(tag))
    {
        return Err(StoreError::NotFound("Team was not found".into()));
    }
    Ok(team)
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
    let limit = |column: &str| -> Result<Option<u32>> {
        Ok(row
            .try_get::<Option<i64>, _>(column)?
            .map(|limit| limit as u32))
    };
    let limits = TeamWakeLimits {
        mutual_per_task: limit("wake_mutual_limit")?,
        per_tag_per_hour: limit("wake_tag_hourly_limit")?,
        per_objective_per_hour: limit("wake_objective_hourly_limit")?,
    };
    Ok(Team {
        wake_limits: (limits != TeamWakeLimits::default()).then_some(limits),
        team_id: row.try_get("team_id")?,
        name: row.try_get("name")?,
        member_tag_ids: Vec::new(),
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
    crate::store::resource_id("Team ID", value)?;
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
        crate::store::resource_id("member Tag ID", member)?;
    }
    Ok(members)
}

/// A Team's wake-limit overrides, each 0–1,000; no override at all is `None`.
fn wake_limits(input: Option<&TeamWakeLimits>) -> Result<Option<TeamWakeLimits>> {
    let Some(input) = input else {
        return Ok(None);
    };
    for value in [
        input.mutual_per_task,
        input.per_tag_per_hour,
        input.per_objective_per_hour,
    ]
    .into_iter()
    .flatten()
    {
        if value > 1000 {
            return Err(invalid("Team wake limits must be from 0 to 1,000"));
        }
    }
    Ok((*input != TeamWakeLimits::default()).then_some(*input))
}

fn wake_limit_columns(limits: Option<TeamWakeLimits>) -> (Option<i64>, Option<i64>, Option<i64>) {
    let limits = limits.unwrap_or_default();
    (
        limits.mutual_per_task.map(i64::from),
        limits.per_tag_per_hour.map(i64::from),
        limits.per_objective_per_hour.map(i64::from),
    )
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
        let principal = self.actor(&request)?;
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
        let principal = self.actor(&request)?;
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
