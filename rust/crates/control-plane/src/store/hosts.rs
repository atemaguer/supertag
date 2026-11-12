use sha2::{Digest, Sha256};
use sqlx::{Any, Row, Transaction, any::AnyRow};
use supertag_protocol::v2::{
    AuthKey, CreateAuthKeyRequest, EnrollHostRequest, HostRecord, TaskState,
};

use super::{Result, Store, StoreError, invalid, name};

#[derive(Clone, Debug)]
pub struct HostAuthority {
    pub(super) principal: String,
    pub(super) generation: i64,
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

    pub(super) fn id(&self) -> &str {
        &self.principal["host:".len()..]
    }
}

impl Store {
    pub async fn create_auth_key(
        &self,
        principal: &str,
        input: &CreateAuthKeyRequest,
    ) -> Result<AuthKey> {
        name(
            "operator identity",
            principal
                .strip_prefix("operator:")
                .ok_or(StoreError::PermissionDenied)?,
        )?;
        host_id(&input.host_id)?;
        name("operation ID", &input.operation_id)?;
        let key = credential_digest(&input.key_digest)?;
        let expires_in_ms = i64::try_from(input.expires_in_ms)
            .ok()
            .filter(|value| *value > 0)
            .ok_or_else(|| invalid("Auth Key expiry must be positive"))?;
        if input.allowed_tag_ids.len() > 256 || input.all_tags != input.allowed_tag_ids.is_empty() {
            return Err(invalid("choose all Tags or supply 1–256 allowed Tag IDs"));
        }
        let mut tags = input.allowed_tag_ids.clone();
        for tag in &tags {
            name("Tag ID", tag)?;
        }
        tags.sort_unstable();
        tags.dedup();
        let scope = serde_json::to_string(&tags)?;
        let fingerprint =
            fingerprint(&(&input.host_id, &key, expires_in_ms, &tags, input.all_tags))?;
        let (mut transaction, _) = self.write().await?;
        let prior = sqlx::query("SELECT request_digest, expires_at_ms FROM supertag_v2_auth_keys WHERE operator_principal=$1 AND operation_id=$2")
            .bind(principal).bind(&input.operation_id).fetch_optional(&mut *transaction).await?;
        let expires_at_ms = if let Some(prior) = prior {
            if prior.try_get::<String, _>("request_digest")? != fingerprint {
                return Err(StoreError::Conflict(
                    "operation ID was used with different Auth Key details".into(),
                ));
            }
            prior.try_get("expires_at_ms")?
        } else {
            if host_in(&mut transaction, &input.host_id).await?.is_some() {
                return Err(StoreError::Conflict(
                    "Worker Host ID is already enrolled".into(),
                ));
            }
            let used: Option<String> =
                sqlx::query_scalar("SELECT host_id FROM supertag_v2_hosts WHERE token_digest=$1")
                    .bind(&key)
                    .fetch_optional(&mut *transaction)
                    .await?;
            if used.is_some() {
                return Err(StoreError::Conflict("credential is already in use".into()));
            }
            for tag in &tags {
                let existing: Option<String> =
                    sqlx::query_scalar("SELECT tag_id FROM supertag_v2_tags WHERE tag_id=$1")
                        .bind(tag)
                        .fetch_optional(&mut *transaction)
                        .await?;
                if existing.is_none() {
                    return Err(StoreError::NotFound("allowed Tag was not found".into()));
                }
            }
            let expires_at_ms = self
                .execution_now_ms()
                .checked_add(expires_in_ms)
                .ok_or_else(|| invalid("Auth Key expiry is out of range"))?;
            let inserted = sqlx::query("INSERT INTO supertag_v2_auth_keys (key_digest,operator_principal,operation_id,request_digest,host_id,allowed_tag_ids,all_tags,expires_at_ms) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(key_digest) DO NOTHING")
                .bind(key).bind(principal).bind(&input.operation_id).bind(fingerprint).bind(&input.host_id)
                .bind(scope).bind(i64::from(input.all_tags)).bind(expires_at_ms)
                .execute(&mut *transaction).await?;
            if inserted.rows_affected() != 1 {
                return Err(StoreError::Conflict(
                    "Auth Key credential has already been issued".into(),
                ));
            }
            expires_at_ms
        };
        transaction.commit().await?;
        Ok(AuthKey {
            host_id: input.host_id.clone(),
            expires_at_ms,
            allowed_tag_ids: tags,
            all_tags: input.all_tags,
        })
    }

    pub async fn enroll_host(
        &self,
        input: &EnrollHostRequest,
        key_digest: &[u8],
    ) -> Result<HostRecord> {
        host_id(&input.host_id)?;
        name("operation ID", &input.operation_id)?;
        let key = credential_digest(key_digest)?;
        let token = credential_digest(&input.token_digest)?;
        if key == token {
            return Err(invalid(
                "Auth Key and Worker Host credential must be distinct",
            ));
        }
        let fingerprint = fingerprint(&(&input.host_id, &input.operation_id, &token))?;
        let (mut transaction, _) = self.write().await?;
        let row = sqlx::query("SELECT * FROM supertag_v2_auth_keys WHERE key_digest=$1")
            .bind(&key)
            .fetch_optional(&mut *transaction)
            .await?
            .ok_or(StoreError::PermissionDenied)?;
        if row.try_get::<String, _>("host_id")? != input.host_id {
            return Err(StoreError::PermissionDenied);
        }
        if let Some(prior) = row.try_get::<Option<String>, _>("enrollment_digest")? {
            if prior != fingerprint {
                return Err(StoreError::PermissionDenied);
            }
            let record = host_in(&mut transaction, &input.host_id)
                .await?
                .ok_or(StoreError::PermissionDenied)?;
            transaction.rollback().await?;
            return host_row(&record);
        }
        let now = self.execution_now_ms();
        if row.try_get::<i64, _>("expires_at_ms")? <= now {
            return Err(StoreError::PermissionDenied);
        }
        let all_tags = row.try_get::<i64, _>("all_tags")? == 1;
        let tags: Vec<String> =
            serde_json::from_str(&row.try_get::<String, _>("allowed_tag_ids")?)?;
        let host = insert_host_in(&mut transaction, &input.host_id, &token, all_tags, now).await?;
        for tag in tags {
            sqlx::query("INSERT INTO supertag_v2_host_tags (host_id,tag_id) VALUES ($1,$2)")
                .bind(&input.host_id)
                .bind(tag)
                .execute(&mut *transaction)
                .await?;
        }
        sqlx::query("UPDATE supertag_v2_auth_keys SET consumed_at_ms=$1,enrollment_digest=$2 WHERE key_digest=$3")
            .bind(now).bind(fingerprint).bind(key).execute(&mut *transaction).await?;
        transaction.commit().await?;
        Ok(host)
    }

    pub async fn seed_host(&self, id: &str, token_digest: &[u8]) -> Result<HostRecord> {
        host_id(id)?;
        let token = credential_digest(token_digest)?;
        let (mut transaction, _) = self.write().await?;
        let record = if let Some(row) = host_in(&mut transaction, id).await? {
            if row.try_get::<String, _>("token_digest")? != token
                || row.try_get::<i64, _>("all_tags")? != 1
            {
                return Err(StoreError::Conflict(
                    "Worker Host is enrolled with different credentials or scope".into(),
                ));
            }
            host_row(&row)?
        } else {
            insert_host_in(&mut transaction, id, &token, true, self.execution_now_ms()).await?
        };
        transaction.commit().await?;
        Ok(record)
    }

    pub async fn authenticate_host(&self, token_digest: &[u8]) -> Result<HostRecord> {
        let token = credential_digest(token_digest)?;
        let row = sqlx::query("SELECT host_id,generation,revoked_at_ms FROM supertag_v2_hosts WHERE token_digest=$1 AND revoked_at_ms IS NULL")
            .bind(token).fetch_optional(&self.pool).await?.ok_or(StoreError::PermissionDenied)?;
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
        transaction.commit().await?;
        Ok(HostRecord {
            generation: next as u64,
            revoked: true,
            ..record
        })
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

async fn insert_host_in(
    transaction: &mut Transaction<'_, Any>,
    id: &str,
    token: &str,
    all_tags: bool,
    now: i64,
) -> Result<HostRecord> {
    let issued: Option<String> =
        sqlx::query_scalar("SELECT key_digest FROM supertag_v2_auth_keys WHERE key_digest=$1")
            .bind(token)
            .fetch_optional(&mut **transaction)
            .await?;
    if issued.is_some() {
        return Err(StoreError::Conflict("credential is already in use".into()));
    }
    let inserted = sqlx::query("INSERT INTO supertag_v2_hosts (host_id,token_digest,all_tags,enrolled_at_ms) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING")
        .bind(id).bind(token).bind(i64::from(all_tags)).bind(now).execute(&mut **transaction).await?;
    if inserted.rows_affected() != 1 {
        return Err(StoreError::Conflict(
            "Worker Host ID or credential is already enrolled".into(),
        ));
    }
    Ok(HostRecord {
        host_id: id.into(),
        generation: 0,
        revoked: false,
    })
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

fn next_generation(generation: i64) -> Result<i64> {
    generation
        .checked_add(1)
        .ok_or_else(|| StoreError::FailedPrecondition("Worker Host generation is exhausted".into()))
}

fn host_id(id: &str) -> Result<()> {
    if id.is_empty()
        || id.len() > 250
        || !id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"-_.".contains(&byte))
    {
        return Err(invalid("invalid Worker Host ID"));
    }
    Ok(())
}

fn credential_digest(bytes: &[u8]) -> Result<String> {
    if bytes.len() != 32 {
        return Err(invalid("credential digest must be 32 bytes"));
    }
    const HEX: &[u8; 16] = b"0123456789abcdef";
    Ok(bytes
        .iter()
        .flat_map(|byte| {
            [
                HEX[(byte >> 4) as usize] as char,
                HEX[(byte & 15) as usize] as char,
            ]
        })
        .collect())
}

fn fingerprint(value: &impl serde::Serialize) -> Result<String> {
    Ok(format!("{:x}", Sha256::digest(serde_json::to_vec(value)?)))
}
