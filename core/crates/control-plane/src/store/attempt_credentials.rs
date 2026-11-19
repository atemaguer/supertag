//! Attempt credentials: the bearer secret `StartTask` returns for one Task Attempt's data calls.
//!
//! Only its SHA-256 is stored, one per Task, bound to the Attempt, its lease, and the Worker Host
//! generation holding it. It resolves only while the Task still runs that Attempt under that
//! lease and generation, the lease is live, and the host is not revoked: renewing the lease extends it, and
//! finishing, reclaiming, lease expiry, revocation, or a new generation ends it without touching
//! this table. Starting the Attempt again replaces it.

use sha2::{Digest, Sha256};
use sqlx::{Any, Row, Transaction};
use supertag_protocol::{
    ATTEMPT_CREDENTIAL_SECRET_PREFIX, new_secret,
    v2::{InspectAttemptRequest, TaskState},
};

use super::{HostAuthority, Result, Store, StoreError, enrollments::credential_digest};

/// What an Attempt credential grants: the data calls of one Task Attempt, as the Worker Host
/// generation holding its lease. The store's data operations take it in place of an Attempt named
/// in the request, and still check the lease it names on every call.
#[derive(Clone, Debug)]
pub struct AttemptAccess {
    pub(crate) host: HostAuthority,
    pub(crate) lease: InspectAttemptRequest,
}

impl AttemptAccess {
    /// The authority of `lease`'s Attempt held by `host`, as a resolved credential carries it.
    /// The store checks the host's ownership of the lease whenever it uses it.
    pub fn new(host: &HostAuthority, lease: &InspectAttemptRequest) -> Self {
        Self {
            host: host.clone(),
            lease: lease.clone(),
        }
    }

    pub fn host(&self) -> &HostAuthority {
        &self.host
    }

    pub fn task_id(&self) -> &str {
        &self.lease.task_id
    }

    pub fn attempt_id(&self) -> &str {
        &self.lease.attempt_id
    }

    /// The Attempt and lease, as the lease-bound store operations read them.
    pub fn lease(&self) -> &InspectAttemptRequest {
        &self.lease
    }
}

/// Mints the credential for the Attempt `lease` names, replacing the Task's previous one.
pub(super) async fn mint_in(
    transaction: &mut Transaction<'_, Any>,
    host: &HostAuthority,
    lease: &InspectAttemptRequest,
    now: i64,
) -> Result<String> {
    let secret = new_secret(ATTEMPT_CREDENTIAL_SECRET_PREFIX);
    let digest = credential_digest(&Sha256::digest(secret.as_bytes()))?;
    sqlx::query("INSERT INTO supertag_v2_attempt_credentials (task_id,attempt_id,lease_token,host_id,host_generation,token_digest,issued_at_ms) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (task_id) DO UPDATE SET attempt_id=excluded.attempt_id,lease_token=excluded.lease_token,host_id=excluded.host_id,host_generation=excluded.host_generation,token_digest=excluded.token_digest,issued_at_ms=excluded.issued_at_ms")
        .bind(&lease.task_id)
        .bind(&lease.attempt_id)
        .bind(&lease.lease_token)
        .bind(host.id())
        .bind(host.generation)
        .bind(&digest)
        .bind(now)
        .execute(&mut **transaction)
        .await?;
    Ok(secret)
}

impl Store {
    /// Resolves the SHA-256 of a presented Attempt credential to the authority it grants. `None`
    /// when it names no credential, or its Attempt, lease, or host generation is no longer live.
    pub async fn resolve_attempt_credential(
        &self,
        token_digest: &[u8],
    ) -> Result<Option<AttemptAccess>> {
        let Ok(digest) = credential_digest(token_digest) else {
            return Ok(None);
        };
        let row = sqlx::query("SELECT c.task_id,c.attempt_id,c.lease_token,c.host_id,c.host_generation FROM supertag_v2_attempt_credentials c JOIN supertag_v2_tasks t ON t.task_id=c.task_id AND t.attempt_id=c.attempt_id AND t.lease_token=c.lease_token AND t.host_principal=('host:' || c.host_id) AND t.host_generation=c.host_generation JOIN supertag_v2_hosts h ON h.host_id=c.host_id AND h.generation=c.host_generation AND h.revoked_at_ms IS NULL WHERE c.token_digest=$1 AND t.state=$2 AND t.lease_expires_at_ms>$3")
            .bind(&digest)
            .bind(TaskState::Running as i64)
            .bind(self.execution_now_ms())
            .fetch_optional(&self.pool)
            .await?;
        let Some(row) = row else {
            return Ok(None);
        };
        let generation: i64 = row.try_get("host_generation")?;
        let host = HostAuthority::new(
            format!("host:{}", row.try_get::<String, _>("host_id")?),
            u64::try_from(generation).map_err(|_| StoreError::PermissionDenied)?,
        )?;
        Ok(Some(AttemptAccess {
            host,
            lease: InspectAttemptRequest {
                task_id: row.try_get("task_id")?,
                attempt_id: row.try_get("attempt_id")?,
                lease_token: row.try_get("lease_token")?,
            },
        }))
    }
}
