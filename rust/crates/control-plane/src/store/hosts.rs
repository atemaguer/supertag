use sqlx::{Any, Row, Transaction, any::AnyRow};
use supertag_protocol::v2::{HostRecord, TaskState};

use super::{
    Result, Store, StoreError,
    enrollments::{Role, enrollee_name, revoke_enrollment_in},
    name,
};

/// An ephemeral host that joined but never came online is removed after this window.
const EPHEMERAL_JOIN_TIMEOUT_MS: i64 = 10 * 60_000;
/// A registered ephemeral host that has not reported yet stays for one presence window.
/// The same window starts when this Control Plane process begins watching, so
/// time the Control Plane was down never counts as a host being offline.
const EPHEMERAL_REGISTRATION_GRACE_MS: i64 = 30_000;

#[derive(Clone, Debug)]
pub struct HostAuthority {
    pub(crate) principal: String,
    pub(crate) generation: i64,
}

impl HostAuthority {
    pub fn new(principal: impl Into<String>, generation: u64) -> Result<Self> {
        let principal = principal.into();
        host_id(
            principal
                .strip_prefix("host:")
                .ok_or(StoreError::PermissionDenied)?,
        )?;
        let generation = i64::try_from(generation).map_err(|_| StoreError::PermissionDenied)?;
        if generation == 0 {
            return Err(StoreError::PermissionDenied);
        }
        Ok(Self {
            principal,
            generation,
        })
    }

    pub(crate) fn id(&self) -> &str {
        &self.principal["host:".len()..]
    }
}

impl Store {
    /// Records `host:ID` with every Tag and a credential from startup configuration, as the
    /// Control Plane does for SUPERTAG_BOOTSTRAP_HOST_TOKEN.
    pub async fn seed_host(&self, id: &str, token_digest: &[u8]) -> Result<HostRecord> {
        self.seed_enrollment(Role::Host, id, token_digest).await?;
        let mut transaction = self.pool.begin().await?;
        let row = host_in(&mut transaction, id)
            .await?
            .ok_or(StoreError::PermissionDenied)?;
        transaction.commit().await?;
        host_row(&row)
    }

    pub async fn register_host(&self, id: &str, incarnation_id: &str) -> Result<HostRecord> {
        host_id(id)?;
        name("Worker Host incarnation ID", incarnation_id)?;
        let (mut transaction, _) = self.write().await?;
        let row = host_in(&mut transaction, id)
            .await?
            .ok_or(StoreError::PermissionDenied)?;
        let record = host_row(&row)?;
        if record.revoked {
            return Err(StoreError::PermissionDenied);
        }
        let generation: i64 = row.try_get("generation")?;
        let prior: Option<i64> = sqlx::query_scalar("SELECT generation FROM supertag_v2_host_incarnations WHERE host_id=$1 AND incarnation_id=$2")
            .bind(id).bind(incarnation_id).fetch_optional(&mut *transaction).await?;
        if let Some(prior) = prior {
            if prior != generation {
                return Err(StoreError::FailedPrecondition(
                    "Worker Host incarnation was replaced".into(),
                ));
            }
            transaction.rollback().await?;
            return Ok(record);
        }
        let next = next_generation(generation)?;
        let now = self.execution_now_ms();
        fence_execution_in(&mut transaction, id, generation, now).await?;
        sqlx::query("UPDATE supertag_v2_hosts SET generation=$1 WHERE host_id=$2")
            .bind(next)
            .bind(id)
            .execute(&mut *transaction)
            .await?;
        sqlx::query("INSERT INTO supertag_v2_host_incarnations (host_id,incarnation_id,generation,registered_at_ms) VALUES ($1,$2,$3,$4)")
            .bind(id).bind(incarnation_id).bind(next).bind(now).execute(&mut *transaction).await?;
        transaction.commit().await?;
        Ok(HostRecord {
            generation: next as u64,
            ..record
        })
    }

    pub async fn revoke_host(&self, id: &str) -> Result<HostRecord> {
        host_id(id)?;
        let (mut transaction, _) = self.write().await?;
        let row = host_in(&mut transaction, id)
            .await?
            .ok_or_else(|| StoreError::NotFound("Worker Host was not found".into()))?;
        let record = host_row(&row)?;
        if record.revoked {
            transaction.rollback().await?;
            return Ok(record);
        }
        let generation: i64 = row.try_get("generation")?;
        let next = next_generation(generation)?;
        let now = self.execution_now_ms();
        fence_execution_in(&mut transaction, id, generation, now).await?;
        sqlx::query("UPDATE supertag_v2_hosts SET generation=$1,revoked_at_ms=$2 WHERE host_id=$3")
            .bind(next)
            .bind(now)
            .bind(id)
            .execute(&mut *transaction)
            .await?;
        revoke_enrollment_in(&mut transaction, Role::Host, id, now).await?;
        transaction.commit().await?;
        Ok(HostRecord {
            generation: next as u64,
            revoked: true,
            ..record
        })
    }
}

impl Store {
    /// Removes ephemeral Worker Hosts that went offline, or that joined and never
    /// came online. Removal revokes the host, fences its execution, unbinds its
    /// Tags, and hides it from the host list.
    pub async fn sweep_ephemeral_hosts(&self) -> Result<Vec<String>> {
        let now = self.execution_now_ms();
        // Absence counts only while this process watches. After a Control Plane
        // restart every host gets a full presence window to report again.
        let watching_since = *self.ephemeral_watch_since.get_or_init(|| now);
        let observed = watching_since.saturating_add(EPHEMERAL_REGISTRATION_GRACE_MS);
        let due = |row: &AnyRow| -> Result<bool> {
            let registered: Option<i64> = row.try_get("registered_at_ms")?;
            let deadline = match row.try_get::<Option<i64>, _>("presence_expires_at_ms")? {
                Some(presence) => presence,
                None => row
                    .try_get::<i64, _>("enrolled_at_ms")?
                    .saturating_add(EPHEMERAL_JOIN_TIMEOUT_MS),
            };
            let deadline = registered.map_or(deadline, |registered| {
                deadline.max(registered.saturating_add(EPHEMERAL_REGISTRATION_GRACE_MS))
            });
            Ok(now >= deadline.max(observed))
        };
        let query = "SELECT h.host_id, h.enrolled_at_ms, r.presence_expires_at_ms, (SELECT MAX(i.registered_at_ms) FROM supertag_v2_host_incarnations i WHERE i.host_id=h.host_id) AS registered_at_ms FROM supertag_v2_hosts h LEFT JOIN supertag_v2_host_readiness r ON r.host_id=h.host_id WHERE h.ephemeral=1 AND h.revoked_at_ms IS NULL ORDER BY h.host_id";
        let mut candidates = vec![];
        for row in sqlx::query(query).fetch_all(&self.pool).await? {
            if due(&row)? {
                candidates.push(row.try_get::<String, _>("host_id")?);
            }
        }
        if candidates.is_empty() {
            return Ok(candidates);
        }
        let (mut transaction, _) = self.write().await?;
        let mut removed = vec![];
        // Recheck under the write lock: a report may have arrived meanwhile.
        for row in sqlx::query(query).fetch_all(&mut *transaction).await? {
            let id: String = row.try_get("host_id")?;
            if !candidates.contains(&id) || !due(&row)? {
                continue;
            }
            let generation: i64 = host_in(&mut transaction, &id)
                .await?
                .ok_or(StoreError::PermissionDenied)?
                .try_get("generation")?;
            fence_execution_in(&mut transaction, &id, generation, now).await?;
            settle_removed_host_in(&mut transaction, &id, generation).await?;
            sqlx::query("UPDATE supertag_v2_hosts SET generation=$1,revoked_at_ms=$2,removed_at_ms=$2,all_tags=0 WHERE host_id=$3")
                .bind(next_generation(generation)?).bind(now).bind(&id)
                .execute(&mut *transaction).await?;
            sqlx::query("DELETE FROM supertag_v2_host_tags WHERE host_id=$1")
                .bind(&id)
                .execute(&mut *transaction)
                .await?;
            revoke_enrollment_in(&mut transaction, Role::Host, &id, now).await?;
            removed.push(id);
        }
        crate::objectives::objective_sweep_in(&mut transaction, now).await?;
        transaction.commit().await?;
        Ok(removed)
    }
}

pub(super) async fn current_scope_in(
    transaction: &mut Transaction<'_, Any>,
    host: &HostAuthority,
) -> Result<i64> {
    sqlx::query_scalar("SELECT all_tags FROM supertag_v2_hosts WHERE host_id=$1 AND generation=$2 AND revoked_at_ms IS NULL")
        .bind(host.id()).bind(host.generation)
        .fetch_optional(&mut **transaction).await?.ok_or(StoreError::PermissionDenied)
}

async fn host_in(transaction: &mut Transaction<'_, Any>, id: &str) -> Result<Option<AnyRow>> {
    Ok(
        sqlx::query("SELECT * FROM supertag_v2_hosts WHERE host_id=$1")
            .bind(id)
            .fetch_optional(&mut **transaction)
            .await?,
    )
}

fn host_row(row: &AnyRow) -> Result<HostRecord> {
    Ok(HostRecord {
        host_id: row.try_get("host_id")?,
        generation: row.try_get::<i64, _>("generation")? as u64,
        revoked: row.try_get::<Option<i64>, _>("revoked_at_ms")?.is_some(),
    })
}

pub(super) async fn host_exists_in(
    transaction: &mut Transaction<'_, Any>,
    id: &str,
) -> Result<bool> {
    Ok(host_in(transaction, id).await?.is_some())
}

/// The execution state of a newly enrolled Worker Host: its Tag scope, granted labels, and
/// whether it is removed once it goes offline.
pub(super) async fn insert_host_in(
    transaction: &mut Transaction<'_, Any>,
    id: &str,
    all_tags: bool,
    tags: &[String],
    ephemeral: bool,
    labels: &str,
    now: i64,
) -> Result<()> {
    let inserted = sqlx::query("INSERT INTO supertag_v2_hosts (host_id,all_tags,enrolled_at_ms,ephemeral,granted_labels) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING")
        .bind(id).bind(i64::from(all_tags)).bind(now).bind(i64::from(ephemeral)).bind(labels)
        .execute(&mut **transaction).await?;
    if inserted.rows_affected() != 1 {
        return Err(StoreError::Conflict(
            "Worker Host ID is already enrolled".into(),
        ));
    }
    for tag in tags {
        sqlx::query("INSERT INTO supertag_v2_host_tags (host_id,tag_id) VALUES ($1,$2)")
            .bind(id)
            .bind(tag)
            .execute(&mut **transaction)
            .await?;
    }
    Ok(())
}

async fn fence_execution_in(
    transaction: &mut Transaction<'_, Any>,
    id: &str,
    generation: i64,
    now: i64,
) -> Result<()> {
    if generation == 0 {
        return Ok(());
    }
    crate::objectives::objective_sweep_in(transaction, now).await?;
    let principal = format!("host:{id}");
    sqlx::query("UPDATE supertag_v2_tasks SET state=$1,attempt_id=NULL,host_principal=NULL,host_generation=NULL,lease_token=NULL,lease_expires_at_ms=NULL,event_sequence_base=0 WHERE host_principal=$2 AND host_generation=$3 AND state=$4")
        .bind(TaskState::Queued as i64).bind(&principal).bind(generation).bind(TaskState::Claimed as i64)
        .execute(&mut **transaction).await?;
    sqlx::query("UPDATE supertag_v2_tasks SET state=$1,cleanup_pending=1,lease_expires_at_ms=$2 WHERE host_principal=$3 AND host_generation=$4 AND state=$5")
        .bind(TaskState::Uncertain as i64).bind(now).bind(&principal).bind(generation).bind(TaskState::Running as i64)
        .execute(&mut **transaction).await?;
    sqlx::query("UPDATE supertag_v2_tasks SET lease_expires_at_ms=$1 WHERE host_principal=$2 AND host_generation=$3 AND state=$4 AND cleanup_pending=1")
        .bind(now).bind(&principal).bind(generation).bind(TaskState::Cancelled as i64)
        .execute(&mut **transaction).await?;
    Ok(())
}

/// A removed ephemeral host can never report again, so its interrupted
/// Attempts count as stopped: a running Task is queued to run elsewhere and a
/// cancelled one finishes its cleanup. packages/control-plane/src/index.ts
/// treats a removed host's running Attempt the same way.
async fn settle_removed_host_in(
    transaction: &mut Transaction<'_, Any>,
    id: &str,
    generation: i64,
) -> Result<()> {
    if generation == 0 {
        return Ok(());
    }
    let principal = format!("host:{id}");
    sqlx::query("UPDATE supertag_v2_tasks SET state=$1,result=NULL,attempt_id=NULL,host_principal=NULL,host_generation=NULL,lease_token=NULL,lease_expires_at_ms=NULL,cleanup_pending=0,cleanup_observed=0,event_sequence_base=0,finish_objective_signal=0 WHERE host_principal=$2 AND host_generation=$3 AND state=$4")
        .bind(TaskState::Queued as i64).bind(&principal).bind(generation).bind(TaskState::Uncertain as i64)
        .execute(&mut **transaction).await?;
    sqlx::query("UPDATE supertag_v2_tasks SET cleanup_pending=0,cleanup_observed=1 WHERE host_principal=$1 AND host_generation=$2 AND state=$3 AND cleanup_pending=1")
        .bind(&principal).bind(generation).bind(TaskState::Cancelled as i64)
        .execute(&mut **transaction).await?;
    Ok(())
}

fn next_generation(generation: i64) -> Result<i64> {
    generation
        .checked_add(1)
        .ok_or_else(|| StoreError::FailedPrecondition("Worker Host generation is exhausted".into()))
}

fn host_id(id: &str) -> Result<()> {
    enrollee_name(id)
}
