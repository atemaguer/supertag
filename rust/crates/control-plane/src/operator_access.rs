//! Operator Tokens and the general audit log.
//!
//! An Operator Token is a named credential the admin operator issues to one teammate or machine.
//! The caller generates the secret and sends only its SHA-256 digest, so the Control Plane never
//! stores or receives a secret. The Gateway resolves every presented token here on every call, so
//! revocation and rotation take effect on the next call and on the next check of an open stream.

use sqlx::{Row, any::AnyRow};
use supertag_protocol::{MAX_MESSAGE_BYTES, v2::*};
use tonic::{Request, Response, Status};
use uuid::Uuid;

use crate::{
    ControlPlane, Store, StoreError,
    store::{Result, invalid, name},
};

/// An Operator Token expires 90 days after it is created or rotated. The lifetime is fixed.
pub const OPERATOR_TOKEN_LIFETIME_MS: i64 = 90 * 24 * 60 * 60 * 1000;
/// `last_used_at_ms` is refreshed at most this often, so reads do not write on every call.
const LAST_USED_INTERVAL_MS: i64 = 60_000;
/// Calls made with an Operator Token act as `token:NAME`.
pub const OPERATOR_TOKEN_PREFIX: &str = "token:";
const DEFAULT_LIMIT: u32 = 50;
const MAX_LIMIT: u32 = 500;

/// The result of resolving a presented Operator Token digest.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum OperatorAuthentication {
    /// The bare operator ID, such as `token:laptop-2`.
    Authenticated(String),
    Invalid,
    Expired,
    Revoked,
}

/// One audit entry before it is stored.
#[derive(Clone, Debug)]
pub struct AuditRecord {
    pub actor: String,
    pub action: String,
    pub target: String,
    pub succeeded: bool,
    pub code: String,
    pub method: String,
}

/// The bare operator ID of a Gateway-supplied `operator:` principal.
pub(crate) fn operator_id(principal: &str) -> Result<&str> {
    let id = principal
        .strip_prefix("operator:")
        .ok_or(StoreError::PermissionDenied)?;
    name("operator identity", id)?;
    Ok(id)
}

/// Whether the principal is the configured admin operator rather than an issued Operator Token.
pub(crate) fn is_admin(principal: &str) -> bool {
    principal
        .strip_prefix("operator:")
        .is_some_and(|id| !id.is_empty() && !id.starts_with(OPERATOR_TOKEN_PREFIX))
}

fn token_name(value: &str) -> Result<&str> {
    let mut bytes = value.bytes();
    let valid = value.len() <= 63
        && bytes
            .next()
            .is_some_and(|first| first.is_ascii_lowercase() || first.is_ascii_digit())
        && bytes.all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'-' | b'_')
        });
    if !valid {
        return Err(invalid(
            "Operator Token name must be 1-63 lowercase letters, digits, hyphens, or underscores, starting with a letter or digit",
        ));
    }
    Ok(value)
}

/// The longest audit target: a kind and up to two 256-byte IDs, such as a Mailbox grant.
pub const MAX_AUDIT_TARGET_BYTES: usize = 1024;

fn audit_target(value: &str) -> Result<()> {
    if value.is_empty()
        || value.len() > MAX_AUDIT_TARGET_BYTES
        || value.chars().any(char::is_control)
    {
        return Err(invalid(&format!(
            "audit target must contain 1–{MAX_AUDIT_TARGET_BYTES} bytes without control characters"
        )));
    }
    Ok(())
}

fn hex_digest(bytes: &[u8]) -> Result<String> {
    if bytes.len() != 32 {
        return Err(invalid("secret digest must be 32 bytes"));
    }
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

fn page_limit(limit: u32) -> Result<i64> {
    match limit {
        0 => Ok(i64::from(DEFAULT_LIMIT)),
        1..=MAX_LIMIT => Ok(i64::from(limit)),
        _ => Err(invalid(&format!(
            "limit must be from 1 through {MAX_LIMIT}"
        ))),
    }
}

fn token_row(row: &AnyRow, now: i64) -> Result<OperatorToken> {
    let name: String = row.try_get("name")?;
    let expires_at_ms: i64 = row.try_get("expires_at_ms")?;
    let revoked_at_ms: Option<i64> = row.try_get("revoked_at_ms")?;
    let phase = if revoked_at_ms.is_some() {
        OperatorTokenPhase::Revoked
    } else if expires_at_ms <= now {
        OperatorTokenPhase::Expired
    } else {
        OperatorTokenPhase::Active
    };
    Ok(OperatorToken {
        operator_id: format!("{OPERATOR_TOKEN_PREFIX}{name}"),
        name,
        phase: phase.into(),
        created_at_ms: row.try_get("created_at_ms")?,
        expires_at_ms,
        last_used_at_ms: row.try_get("last_used_at_ms")?,
        revoked_at_ms,
        rotated_at_ms: row.try_get("rotated_at_ms")?,
        secret_revision: u64::try_from(row.try_get::<i64, _>("secret_revision")?)
            .map_err(|_| invalid("stored secret revision is invalid"))?,
        created_by: row.try_get("created_by")?,
    })
}

const TOKEN_COLUMNS: &str = "name, created_by, created_at_ms, expires_at_ms, rotated_at_ms, last_used_at_ms, revoked_at_ms, secret_revision, secret_digest, operation_id";

impl Store {
    /// Records a new Operator Token. `created_by` is the bare admin operator ID.
    pub async fn create_operator_token(
        &self,
        created_by: &str,
        input: &CreateOperatorTokenRequest,
    ) -> Result<OperatorToken> {
        name("operator identity", created_by)?;
        let token = token_name(&input.name)?;
        name("operation ID", &input.operation_id)?;
        let digest = hex_digest(&input.secret_digest)?;
        let (mut tx, _) = self.write().await?;
        let now = self.execution_now_ms();
        let prior = sqlx::query(&format!(
            "SELECT {TOKEN_COLUMNS} FROM supertag_v2_operator_tokens WHERE name=$1"
        ))
        .bind(token)
        .fetch_optional(&mut *tx)
        .await?;
        if let Some(prior) = prior {
            // A retry of the same creation returns the token it created.
            if prior.try_get::<String, _>("operation_id")? == input.operation_id
                && prior.try_get::<String, _>("secret_digest")? == digest
                && prior.try_get::<i64, _>("secret_revision")? == 1
            {
                tx.rollback().await?;
                return token_row(&prior, now);
            }
            return Err(StoreError::Conflict(
                "Operator Token names are never reused; this name already exists".into(),
            ));
        }
        digest_unused(&mut tx, &digest).await?;
        let expires_at_ms = now
            .checked_add(OPERATOR_TOKEN_LIFETIME_MS)
            .ok_or_else(|| invalid("Operator Token expiry is out of range"))?;
        sqlx::query("INSERT INTO supertag_v2_operator_tokens (name, secret_digest, operation_id, secret_revision, created_by, created_at_ms, expires_at_ms) VALUES ($1,$2,$3,1,$4,$5,$6)")
            .bind(token).bind(&digest).bind(&input.operation_id).bind(created_by).bind(now).bind(expires_at_ms)
            .execute(&mut *tx).await?;
        remember_secret(&mut tx, token, &digest, &input.operation_id, 1).await?;
        let row = token_in(&mut tx, token).await?;
        tx.commit().await?;
        token_row(&row, now)
    }

    pub async fn get_operator_token(&self, name: &str) -> Result<OperatorToken> {
        let token = token_name(name)?;
        let row = sqlx::query(&format!(
            "SELECT {TOKEN_COLUMNS} FROM supertag_v2_operator_tokens WHERE name=$1"
        ))
        .bind(token)
        .fetch_optional(&self.pool)
        .await?
        .ok_or_else(|| StoreError::NotFound("Operator Token was not found".into()))?;
        token_row(&row, self.execution_now_ms())
    }

    /// Lists tokens by name.
    pub async fn list_operator_tokens(
        &self,
        input: &ListOperatorTokensRequest,
    ) -> Result<ListOperatorTokensResponse> {
        let limit = page_limit(input.limit)?;
        if !input.cursor.is_empty() {
            token_name(&input.cursor)?;
        }
        let rows = sqlx::query(&format!(
            "SELECT {TOKEN_COLUMNS} FROM supertag_v2_operator_tokens WHERE name > $1 ORDER BY name LIMIT $2"
        ))
        .bind(&input.cursor)
        .bind(limit + 1)
        .fetch_all(&self.pool)
        .await?;
        let now = self.execution_now_ms();
        let mut tokens = rows
            .iter()
            .map(|row| token_row(row, now))
            .collect::<Result<Vec<_>>>()?;
        let next_cursor = if tokens.len() as i64 > limit {
            tokens.truncate(limit as usize);
            tokens
                .last()
                .map(|token| token.name.clone())
                .unwrap_or_default()
        } else {
            String::new()
        };
        Ok(ListOperatorTokensResponse {
            tokens,
            next_cursor,
        })
    }

    /// Replaces the secret of a token that is not revoked and restarts its lifetime.
    pub async fn rotate_operator_token(
        &self,
        input: &RotateOperatorTokenRequest,
    ) -> Result<OperatorToken> {
        let token = token_name(&input.name)?;
        name("operation ID", &input.operation_id)?;
        let digest = hex_digest(&input.secret_digest)?;
        let (mut tx, _) = self.write().await?;
        let now = self.execution_now_ms();
        let prior = token_in(&mut tx, token).await?;
        let used: Option<String> = sqlx::query_scalar(
            "SELECT secret_digest FROM supertag_v2_operator_token_secrets WHERE name=$1 AND operation_id=$2",
        )
        .bind(token)
        .bind(&input.operation_id)
        .fetch_optional(&mut *tx)
        .await?;
        if let Some(used) = used {
            if used != digest {
                return Err(StoreError::Conflict(
                    "operation ID was used with a different secret".into(),
                ));
            }
            // A retry of the rotation that produced the current secret returns it unchanged. A
            // late retry of a superseded one never restores its secret.
            if prior.try_get::<String, _>("secret_digest")? == digest {
                tx.rollback().await?;
                return token_row(&prior, now);
            }
            return Err(StoreError::Conflict(
                "this rotation was superseded by a later one".into(),
            ));
        }
        if prior.try_get::<Option<i64>, _>("revoked_at_ms")?.is_some() {
            return Err(StoreError::FailedPrecondition(
                "a revoked Operator Token cannot be rotated".into(),
            ));
        }
        digest_unused(&mut tx, &digest).await?;
        let expires_at_ms = now
            .checked_add(OPERATOR_TOKEN_LIFETIME_MS)
            .ok_or_else(|| invalid("Operator Token expiry is out of range"))?;
        sqlx::query("UPDATE supertag_v2_operator_tokens SET secret_digest=$1, operation_id=$2, secret_revision=secret_revision+1, rotated_at_ms=$3, expires_at_ms=$4 WHERE name=$5")
            .bind(&digest).bind(&input.operation_id).bind(now).bind(expires_at_ms).bind(token)
            .execute(&mut *tx).await?;
        let revision = prior.try_get::<i64, _>("secret_revision")? + 1;
        remember_secret(&mut tx, token, &digest, &input.operation_id, revision).await?;
        let row = token_in(&mut tx, token).await?;
        tx.commit().await?;
        token_row(&row, now)
    }

    /// Idempotent: revoking a revoked token keeps the first revocation time.
    pub async fn revoke_operator_token(&self, name: &str) -> Result<OperatorToken> {
        let token = token_name(name)?;
        let (mut tx, _) = self.write().await?;
        let now = self.execution_now_ms();
        token_in(&mut tx, token).await?;
        sqlx::query("UPDATE supertag_v2_operator_tokens SET revoked_at_ms=$1 WHERE name=$2 AND revoked_at_ms IS NULL")
            .bind(now).bind(token).execute(&mut *tx).await?;
        let row = token_in(&mut tx, token).await?;
        tx.commit().await?;
        token_row(&row, now)
    }

    /// Resolves a presented secret digest. A success refreshes `last_used_at_ms` at most once a
    /// minute.
    pub async fn authenticate_operator_token(
        &self,
        token_digest: &[u8],
    ) -> Result<OperatorAuthentication> {
        let Ok(digest) = hex_digest(token_digest) else {
            return Ok(OperatorAuthentication::Invalid);
        };
        let Some(row) = sqlx::query(&format!(
            "SELECT {TOKEN_COLUMNS} FROM supertag_v2_operator_tokens WHERE secret_digest=$1"
        ))
        .bind(&digest)
        .fetch_optional(&self.pool)
        .await?
        else {
            return Ok(OperatorAuthentication::Invalid);
        };
        let now = self.execution_now_ms();
        let token = token_row(&row, now)?;
        match token.phase() {
            OperatorTokenPhase::Revoked => return Ok(OperatorAuthentication::Revoked),
            OperatorTokenPhase::Expired => return Ok(OperatorAuthentication::Expired),
            _ => {}
        }
        if token
            .last_used_at_ms
            .is_none_or(|used| now.saturating_sub(used) >= LAST_USED_INTERVAL_MS)
        {
            sqlx::query("UPDATE supertag_v2_operator_tokens SET last_used_at_ms=$1 WHERE name=$2 AND secret_digest=$3 AND (last_used_at_ms IS NULL OR last_used_at_ms<=$4)")
                .bind(now).bind(&token.name).bind(&digest).bind(now - LAST_USED_INTERVAL_MS)
                .execute(&self.pool).await?;
        }
        Ok(OperatorAuthentication::Authenticated(token.operator_id))
    }

    /// Stores one audit entry in the Control Plane write order.
    pub async fn record_audit_entry(&self, record: &AuditRecord) -> Result<AuditEntry> {
        name("audit actor", &record.actor)?;
        name("audit action", &record.action)?;
        audit_target(&record.target)?;
        name("audit code", &record.code)?;
        name("audit method", &record.method)?;
        let (mut tx, order) = self.write().await?;
        let at_ms = self.execution_now_ms();
        let id = Uuid::new_v4().to_string();
        sqlx::query("INSERT INTO supertag_v2_audit_entries (sequence, entry_id, at_ms, actor, action, target, outcome, code, method) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)")
            .bind(order).bind(&id).bind(at_ms).bind(&record.actor).bind(&record.action)
            .bind(&record.target).bind(if record.succeeded { 1_i64 } else { 2 })
            .bind(&record.code).bind(&record.method)
            .execute(&mut *tx).await?;
        tx.commit().await?;
        Ok(AuditEntry {
            id,
            at_ms,
            actor: record.actor.clone(),
            action: record.action.clone(),
            target: record.target.clone(),
            outcome: if record.succeeded {
                AuditOutcome::Succeeded
            } else {
                AuditOutcome::Failed
            }
            .into(),
            code: record.code.clone(),
            method: record.method.clone(),
        })
    }

    /// Newest first. A page that continues from `next_cursor` neither repeats nor skips entries
    /// recorded meanwhile.
    pub async fn list_audit_entries(
        &self,
        input: &ListAuditEntriesRequest,
    ) -> Result<ListAuditEntriesResponse> {
        let limit = page_limit(input.limit)?;
        if input.since_ms < 0 {
            return Err(invalid("since must not be negative"));
        }
        if input.actor.len() > 200 || input.actor.chars().any(char::is_control) {
            return Err(invalid("actor must be at most 200 characters"));
        }
        let before = if input.cursor.is_empty() {
            i64::MAX
        } else {
            input
                .cursor
                .parse::<i64>()
                .ok()
                .filter(|value| *value > 0)
                .ok_or_else(|| invalid("invalid audit cursor"))?
        };
        let rows = sqlx::query("SELECT sequence, entry_id, at_ms, actor, action, target, outcome, code, method FROM supertag_v2_audit_entries WHERE sequence < $1 AND at_ms >= $2 AND ($3 = '' OR actor = $3) ORDER BY sequence DESC LIMIT $4")
            .bind(before).bind(input.since_ms).bind(&input.actor).bind(limit + 1)
            .fetch_all(&self.pool).await?;
        let mut entries = Vec::with_capacity(rows.len());
        let mut sequences = Vec::with_capacity(rows.len());
        for row in &rows {
            sequences.push(row.try_get::<i64, _>("sequence")?);
            entries.push(AuditEntry {
                id: row.try_get("entry_id")?,
                at_ms: row.try_get("at_ms")?,
                actor: row.try_get("actor")?,
                action: row.try_get("action")?,
                target: row.try_get("target")?,
                outcome: match row.try_get::<i64, _>("outcome")? {
                    1 => AuditOutcome::Succeeded,
                    _ => AuditOutcome::Failed,
                }
                .into(),
                code: row.try_get("code")?,
                method: row.try_get("method")?,
            });
        }
        let next_cursor = if entries.len() as i64 > limit {
            entries.truncate(limit as usize);
            sequences[limit as usize - 1].to_string()
        } else {
            String::new()
        };
        Ok(ListAuditEntriesResponse {
            entries,
            next_cursor,
        })
    }
}

async fn token_in(tx: &mut sqlx::Transaction<'_, sqlx::Any>, name: &str) -> Result<AnyRow> {
    sqlx::query(&format!(
        "SELECT {TOKEN_COLUMNS} FROM supertag_v2_operator_tokens WHERE name=$1"
    ))
    .bind(name)
    .fetch_optional(&mut **tx)
    .await?
    .ok_or_else(|| StoreError::NotFound("Operator Token was not found".into()))
}

/// Refuses a digest any token holds or has ever held.
async fn digest_unused(tx: &mut sqlx::Transaction<'_, sqlx::Any>, digest: &str) -> Result<()> {
    let used: Option<String> = sqlx::query_scalar(
        "SELECT name FROM supertag_v2_operator_token_secrets WHERE secret_digest=$1",
    )
    .bind(digest)
    .fetch_optional(&mut **tx)
    .await?;
    if used.is_some() {
        return Err(StoreError::Conflict("secret is already in use".into()));
    }
    Ok(())
}

async fn remember_secret(
    tx: &mut sqlx::Transaction<'_, sqlx::Any>,
    name: &str,
    digest: &str,
    operation_id: &str,
    revision: i64,
) -> Result<()> {
    sqlx::query("INSERT INTO supertag_v2_operator_token_secrets (secret_digest, name, operation_id, secret_revision) VALUES ($1,$2,$3,$4)")
        .bind(digest).bind(name).bind(operation_id).bind(revision)
        .execute(&mut **tx).await?;
    Ok(())
}

impl ControlPlane {
    pub fn operator_access_service(&self) -> operator_access_server::OperatorAccessServer<Self> {
        operator_access_server::OperatorAccessServer::new(self.clone())
            .max_decoding_message_size(MAX_MESSAGE_BYTES)
            .max_encoding_message_size(MAX_MESSAGE_BYTES)
    }

    pub fn operator_directory_service(
        &self,
    ) -> operator_directory_server::OperatorDirectoryServer<Self> {
        operator_directory_server::OperatorDirectoryServer::new(self.clone())
            .max_decoding_message_size(MAX_MESSAGE_BYTES)
            .max_encoding_message_size(MAX_MESSAGE_BYTES)
    }

    /// The bare admin operator ID, or a refusal for an Operator Token.
    fn admin<T>(&self, request: &Request<T>) -> std::result::Result<String, Status> {
        let principal = self.principal(request, "operator:")?;
        if !is_admin(&principal) {
            return Err(Status::permission_denied(
                "Only the admin operator token manages Operator Tokens",
            ));
        }
        Ok(operator_id(&principal)?.to_owned())
    }
}

#[tonic::async_trait]
impl operator_access_server::OperatorAccess for ControlPlane {
    async fn create_operator_token(
        &self,
        request: Request<CreateOperatorTokenRequest>,
    ) -> std::result::Result<Response<OperatorToken>, Status> {
        let admin = self.admin(&request)?;
        Ok(Response::new(
            self.store
                .create_operator_token(&admin, request.get_ref())
                .await?,
        ))
    }

    async fn get_operator_token(
        &self,
        request: Request<GetOperatorTokenRequest>,
    ) -> std::result::Result<Response<OperatorToken>, Status> {
        self.admin(&request)?;
        Ok(Response::new(
            self.store
                .get_operator_token(&request.get_ref().name)
                .await?,
        ))
    }

    async fn list_operator_tokens(
        &self,
        request: Request<ListOperatorTokensRequest>,
    ) -> std::result::Result<Response<ListOperatorTokensResponse>, Status> {
        self.admin(&request)?;
        Ok(Response::new(
            self.store.list_operator_tokens(request.get_ref()).await?,
        ))
    }

    async fn rotate_operator_token(
        &self,
        request: Request<RotateOperatorTokenRequest>,
    ) -> std::result::Result<Response<OperatorToken>, Status> {
        self.admin(&request)?;
        Ok(Response::new(
            self.store.rotate_operator_token(request.get_ref()).await?,
        ))
    }

    async fn revoke_operator_token(
        &self,
        request: Request<RevokeOperatorTokenRequest>,
    ) -> std::result::Result<Response<OperatorToken>, Status> {
        self.admin(&request)?;
        Ok(Response::new(
            self.store
                .revoke_operator_token(&request.get_ref().name)
                .await?,
        ))
    }

    async fn list_audit_entries(
        &self,
        request: Request<ListAuditEntriesRequest>,
    ) -> std::result::Result<Response<ListAuditEntriesResponse>, Status> {
        self.principal(&request, "operator:")?;
        Ok(Response::new(
            self.store.list_audit_entries(request.get_ref()).await?,
        ))
    }
}

#[tonic::async_trait]
impl operator_directory_server::OperatorDirectory for ControlPlane {
    async fn authenticate(
        &self,
        request: Request<AuthenticateOperatorRequest>,
    ) -> std::result::Result<Response<OperatorIdentity>, Status> {
        if self.principal(&request, "service:")? != "service:gateway" {
            return Err(Status::permission_denied(
                "caller is not allowed to use this service",
            ));
        }
        match self
            .store
            .authenticate_operator_token(&request.get_ref().token_digest)
            .await?
        {
            OperatorAuthentication::Authenticated(operator_id) => {
                Ok(Response::new(OperatorIdentity { operator_id }))
            }
            OperatorAuthentication::Revoked => {
                Err(Status::unauthenticated("Operator Token was revoked"))
            }
            OperatorAuthentication::Expired => {
                Err(Status::unauthenticated("Operator Token expired"))
            }
            OperatorAuthentication::Invalid => {
                Err(Status::unauthenticated("valid bearer credential required"))
            }
        }
    }
}
