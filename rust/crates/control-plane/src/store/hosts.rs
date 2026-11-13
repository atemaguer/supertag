use sha2::{Digest, Sha256};
use sqlx::{Any, Row, Transaction, any::AnyRow};
use supertag_protocol::v2::{
    AuthKey, CreateAuthKeyRequest, EnrollHostRequest, HostCredentialRotation, HostRecord,
    ListAuthKeysRequest, ListAuthKeysResponse, RotateHostCredentialRequest, TaskState,
};

use super::{Result, Store, StoreError, invalid, name};
use crate::placement::{LabelField, parse_labels};

/// An ephemeral host that joined but never came online is removed after this window.
const EPHEMERAL_JOIN_TIMEOUT_MS: i64 = 10 * 60_000;
/// A registered ephemeral host that has not reported yet stays for one presence window.
/// The same window starts when this Control Plane process begins watching, so
/// time the Control Plane was down never counts as a host being offline.
const EPHEMERAL_REGISTRATION_GRACE_MS: i64 = 30_000;
/// A one-time Auth Key lives at most one hour, as in packages/core/src/auth-key.ts.
const ONE_TIME_AUTH_KEY_LIFETIME_MS: i64 = 60 * 60_000;
/// A reusable Auth Key lives at most 90 days.
const REUSABLE_AUTH_KEY_LIFETIME_MS: i64 = 90 * 24 * 60 * 60_000;

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
        auth_key_name(&input.name)?;
        if input.reusable {
            if !input.host_id.is_empty() {
                return Err(invalid(
                    "a reusable Auth Key enrolls any Worker Host ID; omit the host ID",
                ));
            }
        } else {
            host_id(&input.host_id)?;
        }
        let labels = parse_labels(&input.labels, LabelField::AuthKey)?;
        name("operation ID", &input.operation_id)?;
        let key = credential_digest(&input.key_digest)?;
        // A leaked key, reusable keys especially, must not stay valid indefinitely.
        let max_lifetime = if input.reusable {
            REUSABLE_AUTH_KEY_LIFETIME_MS
        } else {
            ONE_TIME_AUTH_KEY_LIFETIME_MS
        };
        let expires_in_ms = match input.expires_in_ms {
            0 => max_lifetime,
            value => i64::try_from(value)
                .ok()
                .filter(|value| *value <= max_lifetime)
                .ok_or_else(|| {
                    invalid("Auth Key lifetime is at most one hour, or 90 days for a reusable key")
                })?,
        };
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
        let fingerprint = fingerprint(&(
            (&input.host_id, &key, expires_in_ms, &tags, input.all_tags),
            (input.reusable, input.ephemeral, &labels, &input.name),
        ))?;
        let (mut transaction, _) = self.write().await?;
        let prior = sqlx::query(
            "SELECT * FROM supertag_v2_auth_keys WHERE operator_principal=$1 AND operation_id=$2",
        )
        .bind(principal)
        .bind(&input.operation_id)
        .fetch_optional(&mut *transaction)
        .await?;
        if let Some(prior) = prior {
            if prior.try_get::<String, _>("request_digest")? != fingerprint {
                return Err(StoreError::Conflict(
                    "operation ID was used with different Auth Key details".into(),
                ));
            }
            transaction.rollback().await?;
            return auth_key_row(&prior);
        }
        let named: Option<String> =
            sqlx::query_scalar("SELECT name FROM supertag_v2_auth_keys WHERE name=$1")
                .bind(&input.name)
                .fetch_optional(&mut *transaction)
                .await?;
        if named.is_some() {
            return Err(StoreError::Conflict(
                "Auth Key names are never reused; choose another name".into(),
            ));
        }
        if !input.reusable && host_in(&mut transaction, &input.host_id).await?.is_some() {
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
            crate::tags::require_active(&mut transaction, tag).await?;
        }
        let now = self.execution_now_ms();
        let expires_at_ms = now
            .checked_add(expires_in_ms)
            .ok_or_else(|| invalid("Auth Key expiry is out of range"))?;
        let inserted = sqlx::query("INSERT INTO supertag_v2_auth_keys (key_digest,operator_principal,operation_id,request_digest,host_id,allowed_tag_ids,all_tags,expires_at_ms,reusable,ephemeral,labels,name,created_at_ms) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT DO NOTHING")
            .bind(&key).bind(principal).bind(&input.operation_id).bind(fingerprint).bind(&input.host_id)
            .bind(scope).bind(i64::from(input.all_tags)).bind(expires_at_ms)
            .bind(i64::from(input.reusable)).bind(i64::from(input.ephemeral)).bind(serde_json::to_string(&labels)?)
            .bind(&input.name).bind(now)
            .execute(&mut *transaction).await?;
        if inserted.rows_affected() != 1 {
            return Err(StoreError::Conflict(
                "Auth Key credential has already been issued".into(),
            ));
        }
        let row = sqlx::query("SELECT * FROM supertag_v2_auth_keys WHERE key_digest=$1")
            .bind(&key)
            .fetch_one(&mut *transaction)
            .await?;
        transaction.commit().await?;
        auth_key_row(&row)
    }

    /// Blocks new joins with the key, including replays of earlier joins.
    /// Hosts that already joined keep their enrollment. Idempotent.
    pub async fn revoke_auth_key(&self, principal: &str, key_name: &str) -> Result<AuthKey> {
        operator(principal)?;
        auth_key_name(key_name)?;
        let (mut transaction, _) = self.write().await?;
        sqlx::query("UPDATE supertag_v2_auth_keys SET revoked_at_ms=$1 WHERE name=$2 AND revoked_at_ms IS NULL")
            .bind(self.execution_now_ms())
            .bind(key_name)
            .execute(&mut *transaction)
            .await?;
        let row = sqlx::query("SELECT * FROM supertag_v2_auth_keys WHERE name=$1")
            .bind(key_name)
            .fetch_optional(&mut *transaction)
            .await?
            .ok_or_else(|| StoreError::NotFound("Auth Key was not found".into()))?;
        transaction.commit().await?;
        auth_key_row(&row)
    }

    /// One Auth Key, without its secret.
    pub async fn get_auth_key(&self, principal: &str, key_name: &str) -> Result<AuthKey> {
        operator(principal)?;
        auth_key_name(key_name)?;
        let row = sqlx::query("SELECT * FROM supertag_v2_auth_keys WHERE name=$1")
            .bind(key_name)
            .fetch_optional(&self.pool)
            .await?
            .ok_or_else(|| StoreError::NotFound("Auth Key was not found".into()))?;
        auth_key_row(&row)
    }

    /// Every Auth Key, revoked, expired and used ones included: the earliest created
    /// first, then by name, as packages/store/src/auth-key-store.ts lists them.
    pub async fn list_auth_keys(
        &self,
        principal: &str,
        input: &ListAuthKeysRequest,
    ) -> Result<ListAuthKeysResponse> {
        operator(principal)?;
        if input.limit > 500 {
            return Err(invalid("Auth Key page limit must be at most 500"));
        }
        let limit = if input.limit == 0 { 100 } else { input.limit } as usize;
        let mut transaction = self.pool.begin().await?;
        let (after_ms, after_name) = if input.cursor.is_empty() {
            (i64::MIN, String::new())
        } else {
            auth_key_name(&input.cursor)?;
            let created: i64 =
                sqlx::query_scalar("SELECT created_at_ms FROM supertag_v2_auth_keys WHERE name=$1")
                    .bind(&input.cursor)
                    .fetch_optional(&mut *transaction)
                    .await?
                    .ok_or_else(|| invalid("unknown Auth Key cursor"))?;
            (created, input.cursor.clone())
        };
        let mut rows = sqlx::query("SELECT * FROM supertag_v2_auth_keys WHERE created_at_ms>$1 OR (created_at_ms=$1 AND name>$2) ORDER BY created_at_ms, name LIMIT $3")
            .bind(after_ms)
            .bind(&after_name)
            .bind((limit + 1) as i64)
            .fetch_all(&mut *transaction)
            .await?;
        transaction.commit().await?;
        let next_cursor = if rows.len() > limit {
            rows.truncate(limit);
            rows.last()
                .map(|row| row.try_get::<String, _>("name"))
                .transpose()?
                .unwrap_or_default()
        } else {
            String::new()
        };
        Ok(ListAuthKeysResponse {
            auth_keys: rows.iter().map(auth_key_row).collect::<Result<_>>()?,
            next_cursor,
        })
    }

    /// Replaces an enrolled Worker Host's credential digest. The previous credential stops
    /// authenticating at once, as RotateWorkerHostCredential does in
    /// packages/store/src/worker-host-store.ts. A repeat with the digest the rotation
    /// installed returns the same result, so a lost response can be retried.
    pub async fn rotate_host_credential(
        &self,
        principal: &str,
        input: &RotateHostCredentialRequest,
    ) -> Result<HostCredentialRotation> {
        operator(principal)?;
        host_id(&input.host_id)?;
        let expected = i64::try_from(input.expected_credential_revision)
            .ok()
            .filter(|revision| *revision > 0)
            .ok_or_else(|| invalid("expected credential revision must be at least 1"))?;
        let token = credential_digest(&input.token_digest)?;
        let (mut transaction, _) = self.write().await?;
        let row = host_in(&mut transaction, &input.host_id)
            .await?
            .ok_or_else(|| StoreError::NotFound("Worker Host was not found".into()))?;
        if row.try_get::<Option<i64>, _>("revoked_at_ms")?.is_some() {
            return Err(StoreError::FailedPrecondition(
                "Worker Host is revoked; enroll the machine under a new ID".into(),
            ));
        }
        let revision: i64 = row.try_get("credential_revision")?;
        if row.try_get::<String, _>("token_digest")? == token
            && Some(revision) == expected.checked_add(1)
        {
            transaction.rollback().await?;
            return Ok(HostCredentialRotation {
                host_id: input.host_id.clone(),
                credential_revision: revision as u64,
            });
        }
        if revision != expected {
            return Err(StoreError::FailedPrecondition(
                "Worker Host credential revision changed; read the host and retry".into(),
            ));
        }
        // A credential set when the Control Plane starts is replaced by changing that setting.
        let joined: Option<String> = sqlx::query_scalar("SELECT host_id FROM supertag_v2_auth_keys WHERE host_id=$1 AND consumed_at_ms IS NOT NULL UNION SELECT host_id FROM supertag_v2_auth_key_enrollments WHERE host_id=$1")
            .bind(&input.host_id)
            .fetch_optional(&mut *transaction)
            .await?;
        if joined.is_none() {
            return Err(StoreError::FailedPrecondition(
                "this Worker Host's credential comes from the Control Plane's startup configuration".into(),
            ));
        }
        credential_unused_in(&mut transaction, &token).await?;
        sqlx::query("UPDATE supertag_v2_hosts SET token_digest=$1,credential_revision=$2 WHERE host_id=$3 AND credential_revision=$4")
            .bind(&token)
            .bind(revision + 1)
            .bind(&input.host_id)
            .bind(revision)
            .execute(&mut *transaction)
            .await?;
        transaction.commit().await?;
        Ok(HostCredentialRotation {
            host_id: input.host_id.clone(),
            credential_revision: (revision + 1) as u64,
        })
    }

    pub async fn enroll_host(
        &self,
        input: &EnrollHostRequest,
        key_digest: &[u8],
    ) -> Result<HostRecord> {
        // The key is looked up before the request is checked, as the TypeScript request gate
        // refuses an unknown Auth Key before anything else: a join with a key the Control Plane
        // does not know names no one to record, whatever else is wrong with it.
        let key = credential_digest(key_digest)?;
        let key_name: String =
            sqlx::query_scalar("SELECT name FROM supertag_v2_auth_keys WHERE key_digest=$1")
                .bind(&key)
                .fetch_optional(&self.pool)
                .await?
                .ok_or(StoreError::PermissionDenied)?;
        let actor = format!("auth-key:{key_name}");
        crate::audit::note_actor(&actor);
        host_id(&input.host_id)?;
        name("operation ID", &input.operation_id)?;
        let token = credential_digest(&input.token_digest)?;
        if key == token {
            return Err(invalid(
                "Auth Key and Worker Host credential must be distinct",
            ));
        }
        let operation = fingerprint(&(&input.host_id, &input.operation_id))?;
        let fingerprint = fingerprint(&(&input.host_id, &input.operation_id, &token))?;
        let (mut transaction, _) = self.write().await?;
        let Some(row) = sqlx::query("SELECT * FROM supertag_v2_auth_keys WHERE key_digest=$1")
            .bind(&key)
            .fetch_optional(&mut *transaction)
            .await?
        else {
            return Err(StoreError::PermissionDenied);
        };
        crate::audit::note_actor_in(&mut transaction, &actor).await?;
        // Revocation also refuses replays, as packages/store/src/auth-key-store.ts does.
        if row.try_get::<Option<i64>, _>("revoked_at_ms")?.is_some() {
            return Err(StoreError::PermissionDenied);
        }
        let reusable = row.try_get::<i64, _>("reusable")? == 1;
        if !reusable && row.try_get::<String, _>("host_id")? != input.host_id {
            return Err(StoreError::PermissionDenied);
        }
        // A reusable join is found again by its requested ID and operation, since the host it
        // enrolled may carry a suffix.
        let prior = if reusable {
            sqlx::query_as::<_, (String, String)>("SELECT host_id, enrollment_digest FROM supertag_v2_auth_key_enrollments WHERE key_digest=$1 AND operation_digest=$2")
                .bind(&key).bind(&operation).fetch_optional(&mut *transaction).await?
        } else {
            row.try_get::<Option<String>, _>("enrollment_digest")?
                .map(|digest| (input.host_id.clone(), digest))
        };
        if let Some((enrolled, prior)) = prior {
            if prior != fingerprint {
                return Err(StoreError::PermissionDenied);
            }
            let record = host_in(&mut transaction, &enrolled)
                .await?
                .ok_or(StoreError::PermissionDenied)?;
            // A retried join is audited under the host it enrolled, which may carry a suffix.
            if enrolled != input.host_id {
                crate::audit::changes_in(
                    &mut transaction,
                    &[crate::audit::AuditChange {
                        action: "worker-host.join".into(),
                        target: format!("WorkerHost/{enrolled}"),
                    }],
                )
                .await?;
                transaction.commit().await?;
            } else {
                transaction.rollback().await?;
            }
            return host_row(&record);
        }
        let now = self.execution_now_ms();
        if row.try_get::<i64, _>("expires_at_ms")? <= now {
            return Err(StoreError::PermissionDenied);
        }
        let all_tags = row.try_get::<i64, _>("all_tags")? == 1;
        let tags: Vec<String> =
            serde_json::from_str(&row.try_get::<String, _>("allowed_tag_ids")?)?;
        for tag in &tags {
            match crate::tags::require_active(&mut transaction, tag).await {
                Ok(()) => {}
                Err(StoreError::NotFound(_) | StoreError::FailedPrecondition(_)) => {
                    return Err(StoreError::PermissionDenied);
                }
                Err(error) => return Err(error),
            }
        }
        // A reusable join takes neither an enrolled ID nor one a pending one-time key reserves:
        // it enrolls the first free NAME-2, NAME-3, ... instead, as TypeScript does.
        let host_id = if reusable {
            let host_id = available_host_id_in(&mut transaction, &input.host_id, now).await?;
            if host_id != input.host_id {
                crate::audit::changes_in(
                    &mut transaction,
                    &[crate::audit::AuditChange {
                        action: "worker-host.join".into(),
                        target: format!("WorkerHost/{host_id}"),
                    }],
                )
                .await?;
            }
            host_id
        } else {
            input.host_id.clone()
        };
        let host = insert_host_in(&mut transaction, &host_id, &token, all_tags, now).await?;
        sqlx::query("UPDATE supertag_v2_hosts SET ephemeral=$1,granted_labels=$2 WHERE host_id=$3")
            .bind(row.try_get::<i64, _>("ephemeral")?)
            .bind(row.try_get::<String, _>("labels")?)
            .bind(&host_id)
            .execute(&mut *transaction)
            .await?;
        for tag in tags {
            sqlx::query("INSERT INTO supertag_v2_host_tags (host_id,tag_id) VALUES ($1,$2)")
                .bind(&host_id)
                .bind(tag)
                .execute(&mut *transaction)
                .await?;
        }
        if reusable {
            sqlx::query("INSERT INTO supertag_v2_auth_key_enrollments (key_digest,host_id,enrollment_digest,enrolled_at_ms,operation_digest) VALUES ($1,$2,$3,$4,$5)")
                .bind(&key).bind(&host_id).bind(&fingerprint).bind(now).bind(&operation).execute(&mut *transaction).await?;
            sqlx::query("UPDATE supertag_v2_auth_keys SET consumed_at_ms=$1 WHERE key_digest=$2")
                .bind(now)
                .bind(key)
                .execute(&mut *transaction)
                .await?;
        } else {
            sqlx::query("UPDATE supertag_v2_auth_keys SET consumed_at_ms=$1,enrollment_digest=$2 WHERE key_digest=$3")
                .bind(now).bind(fingerprint).bind(key).execute(&mut *transaction).await?;
        }
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

/// Most suffixes a reusable join tries before it reports the ID unavailable.
const MAX_HOST_ID_SUFFIX: u32 = 1000;

/// `requested`, or else the first `requested-N` from 2 that is neither enrolled, removed hosts
/// included, nor reserved by a pending one-time Auth Key.
async fn available_host_id_in(
    transaction: &mut Transaction<'_, Any>,
    requested: &str,
    now: i64,
) -> Result<String> {
    for suffix in 1..=MAX_HOST_ID_SUFFIX {
        let candidate = if suffix == 1 {
            requested.to_owned()
        } else {
            format!("{requested}-{suffix}")
        };
        if host_id(&candidate).is_err() {
            break;
        }
        let reserved: Option<String> = sqlx::query_scalar("SELECT key_digest FROM supertag_v2_auth_keys WHERE reusable=0 AND host_id=$1 AND consumed_at_ms IS NULL AND revoked_at_ms IS NULL AND expires_at_ms>$2")
            .bind(&candidate).bind(now).fetch_optional(&mut **transaction).await?;
        if reserved.is_none() && host_in(transaction, &candidate).await?.is_none() {
            return Ok(candidate);
        }
    }
    Err(StoreError::Conflict(
        "Worker Host ID is not available".into(),
    ))
}

async fn host_in(transaction: &mut Transaction<'_, Any>, id: &str) -> Result<Option<AnyRow>> {
    Ok(
        sqlx::query("SELECT * FROM supertag_v2_hosts WHERE host_id=$1")
            .bind(id)
            .fetch_optional(&mut **transaction)
            .await?,
    )
}

fn auth_key_row(row: &AnyRow) -> Result<AuthKey> {
    Ok(AuthKey {
        host_id: row.try_get("host_id")?,
        expires_at_ms: row.try_get("expires_at_ms")?,
        allowed_tag_ids: serde_json::from_str(&row.try_get::<String, _>("allowed_tag_ids")?)?,
        all_tags: row.try_get::<i64, _>("all_tags")? == 1,
        reusable: row.try_get::<i64, _>("reusable")? == 1,
        ephemeral: row.try_get::<i64, _>("ephemeral")? == 1,
        labels: serde_json::from_str(&row.try_get::<String, _>("labels")?)?,
        revoked: row.try_get::<Option<i64>, _>("revoked_at_ms")?.is_some(),
        name: row.try_get("name")?,
        created_at_ms: row.try_get("created_at_ms")?,
        used: row.try_get::<Option<i64>, _>("consumed_at_ms")?.is_some(),
    })
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

/// A rotated Worker Host credential is no other host's credential and no Auth Key.
async fn credential_unused_in(transaction: &mut Transaction<'_, Any>, token: &str) -> Result<()> {
    let used: Option<String> = sqlx::query_scalar("SELECT key_digest FROM supertag_v2_auth_keys WHERE key_digest=$1 UNION SELECT token_digest FROM supertag_v2_hosts WHERE token_digest=$1")
        .bind(token)
        .fetch_optional(&mut **transaction)
        .await?;
    if used.is_some() {
        return Err(StoreError::Conflict("credential is already in use".into()));
    }
    Ok(())
}

fn operator(principal: &str) -> Result<()> {
    name(
        "operator identity",
        principal
            .strip_prefix("operator:")
            .ok_or(StoreError::PermissionDenied)?,
    )
}

/// 1 to 63 lowercase letters, digits, hyphens or underscores, starting with a letter or
/// digit, as packages/core/src/auth-key.ts names Auth Keys.
fn auth_key_name(value: &str) -> Result<()> {
    let bytes = value.as_bytes();
    if bytes.is_empty()
        || bytes.len() > 63
        || !bytes[0].is_ascii_lowercase() && !bytes[0].is_ascii_digit()
        || !bytes
            .iter()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || b"-_".contains(byte))
    {
        return Err(invalid(
            "Auth Key name must be 1-63 lowercase letters, digits, hyphens or underscores, starting with a letter or digit",
        ));
    }
    Ok(())
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
