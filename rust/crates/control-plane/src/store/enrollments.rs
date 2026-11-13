//! Auth Keys and the enrollments they admit. An Auth Key admits one role: Worker Hosts, Gateways
//! or clients. Each enrollee generates its own credential and the Control Plane keeps only its
//! SHA-256 digest, so rotation is a digest swap and revocation takes effect on the next call.

use sha2::{Digest, Sha256};
use sqlx::{Any, Row, Transaction, any::AnyRow};
use supertag_protocol::v2::{
    AuthKey, CreateAuthKeyRequest, CredentialRotation, EnrollRequest, Enrollment,
    ListAuthKeysRequest, ListAuthKeysResponse, ListEnrollmentsRequest, ListEnrollmentsResponse,
    PrincipalRole, ResolvedCredential, RotateCredentialRequest,
};

use super::{Result, Store, StoreError, invalid, name};
use crate::placement::{LabelField, parse_labels};

/// A one-time Auth Key lives at most one hour, as in packages/core/src/auth-key.ts.
const ONE_TIME_AUTH_KEY_LIFETIME_MS: i64 = 60 * 60_000;
/// A reusable Auth Key lives at most 90 days.
const REUSABLE_AUTH_KEY_LIFETIME_MS: i64 = 90 * 24 * 60 * 60_000;
/// `last_used_at_ms` is refreshed at most this often.
const LAST_USED_INTERVAL_MS: i64 = 60_000;

/// The roles an Auth Key admits.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Role {
    Host,
    Gateway,
    Client,
}

impl Role {
    pub fn from_proto(value: i32) -> Option<Self> {
        match PrincipalRole::try_from(value).ok()? {
            PrincipalRole::Host => Some(Self::Host),
            PrincipalRole::Gateway => Some(Self::Gateway),
            PrincipalRole::Client => Some(Self::Client),
            PrincipalRole::Operator | PrincipalRole::Unspecified => None,
        }
    }

    fn parse(value: &str) -> Result<Self> {
        match value {
            "host" => Ok(Self::Host),
            "gateway" => Ok(Self::Gateway),
            "client" => Ok(Self::Client),
            _ => Err(StoreError::Data(serde::de::Error::custom("unknown role"))),
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Host => "host",
            Self::Gateway => "gateway",
            Self::Client => "client",
        }
    }

    pub fn proto(self) -> PrincipalRole {
        match self {
            Self::Host => PrincipalRole::Host,
            Self::Gateway => PrincipalRole::Gateway,
            Self::Client => PrincipalRole::Client,
        }
    }

    fn plural(self) -> &'static str {
        match self {
            Self::Host => "Worker Hosts",
            Self::Gateway => "Gateways",
            Self::Client => "clients",
        }
    }
}

/// `role:name` split into its parts, for an enrolled principal.
pub(crate) fn enrolled_principal(principal: &str) -> Option<(Role, &str)> {
    let (role, name) = principal.split_once(':')?;
    let role = Role::parse(role).ok()?;
    enrollee_name(name).ok()?;
    Some((role, name))
}

fn required_role(value: i32) -> Result<Role> {
    Role::from_proto(value).ok_or_else(|| invalid("role must be host, gateway or client"))
}

impl Store {
    pub async fn create_auth_key(
        &self,
        principal: &str,
        input: &CreateAuthKeyRequest,
    ) -> Result<AuthKey> {
        operator(principal)?;
        auth_key_name(&input.name)?;
        let role = required_role(input.role)?;
        if role != Role::Host && (input.ephemeral || !input.labels.is_empty()) {
            return Err(invalid("only host Auth Keys are ephemeral or grant labels"));
        }
        // A gateway key lists no Tags. Its optional `all_tags` lets the Gateway serve connector
        // accounts no Surface Account names, which admit work on any Tag.
        let tags_apply = role != Role::Gateway;
        if !tags_apply && !input.allowed_tag_ids.is_empty() {
            return Err(invalid(
                "a gateway Auth Key lists no Tags; it takes only all Tags or none",
            ));
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
        if tags_apply
            && (input.allowed_tag_ids.len() > 256
                || input.all_tags != input.allowed_tag_ids.is_empty())
        {
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
            (role.as_str(), &key, expires_in_ms, &tags, input.all_tags),
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
        credential_unused_in(&mut transaction, &key).await?;
        for tag in &tags {
            crate::tags::require_active(&mut transaction, tag).await?;
        }
        let now = self.execution_now_ms();
        let expires_at_ms = now
            .checked_add(expires_in_ms)
            .ok_or_else(|| invalid("Auth Key expiry is out of range"))?;
        let inserted = sqlx::query("INSERT INTO supertag_v2_auth_keys (key_digest,operator_principal,operation_id,request_digest,allowed_tag_ids,all_tags,expires_at_ms,reusable,ephemeral,labels,name,created_at_ms,role) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT DO NOTHING")
            .bind(&key).bind(principal).bind(&input.operation_id).bind(fingerprint)
            .bind(scope).bind(i64::from(input.all_tags)).bind(expires_at_ms)
            .bind(i64::from(input.reusable)).bind(i64::from(input.ephemeral)).bind(serde_json::to_string(&labels)?)
            .bind(&input.name).bind(now).bind(role.as_str())
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
    /// Principals that already joined keep their enrollment. Idempotent.
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

    /// Enrolls the principal an Auth Key admits. The key is the caller's bearer; `key_digest` is
    /// its SHA-256. A repeat of an earlier join with the same operation, name and credential digest
    /// returns the same enrollment until the key is revoked. Every refusal of a key or replay is
    /// the same `PermissionDenied`, so it reveals nothing about the key.
    pub async fn enroll(&self, key_digest: &[u8], input: &EnrollRequest) -> Result<Enrollment> {
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
        let role = required_role(input.role)?;
        enrollee_name(&input.name)?;
        // The Control Plane seeds `host:local` and `gateway:local` from its configuration, so no
        // Auth Key may take that name first and stop it from starting.
        if role != Role::Client && input.name == BOOTSTRAP_NAME {
            return Err(invalid(
                "the name local is reserved for the Control Plane's own host and Gateway",
            ));
        }
        name("operation ID", &input.operation_id)?;
        let token = credential_digest(&input.token_digest)?;
        if key == token {
            return Err(invalid("Auth Key and enrolled credential must be distinct"));
        }
        let fingerprint = fingerprint(&(role.as_str(), &input.name, &input.operation_id, &token))?;
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
        let key_role = Role::parse(&row.try_get::<String, _>("role")?)?;
        if key_role != role {
            return Err(StoreError::FailedPrecondition(format!(
                "this Auth Key enrolls {}, not {}",
                key_role.plural(),
                role.plural()
            )));
        }
        let prior: Option<String> = sqlx::query_scalar("SELECT enrollment_digest FROM supertag_v2_auth_key_joins WHERE key_digest=$1 AND role=$2 AND name=$3")
            .bind(&key).bind(role.as_str()).bind(&input.name)
            .fetch_optional(&mut *transaction).await?;
        if let Some(prior) = prior {
            if prior != fingerprint {
                return Err(StoreError::PermissionDenied);
            }
            let enrollment = enrollment_in(&mut transaction, role, &input.name)
                .await?
                .ok_or(StoreError::PermissionDenied)?;
            transaction.rollback().await?;
            return Ok(enrollment);
        }
        let reusable = row.try_get::<i64, _>("reusable")? == 1;
        if !reusable && row.try_get::<Option<i64>, _>("consumed_at_ms")?.is_some() {
            return Err(StoreError::PermissionDenied);
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
        // Names are never reused within a role, and a host name is also never a Worker Host
        // that exists without an enrollment.
        let taken = enrollment_in(&mut transaction, role, &input.name)
            .await?
            .is_some()
            || (role == Role::Host
                && super::hosts::host_exists_in(&mut transaction, &input.name).await?);
        if taken {
            return Err(StoreError::Conflict(format!(
                "the {} name is not available",
                role.as_str()
            )));
        }
        credential_unused_in(&mut transaction, &token).await?;
        let key_label: String = row.try_get("name")?;
        insert_enrollment_in(
            &mut transaction,
            role,
            &input.name,
            &token,
            Some(&key_label),
            if role == Role::Client { &tags } else { &[] },
            role != Role::Host && all_tags,
            now,
        )
        .await?;
        if role == Role::Host {
            super::hosts::insert_host_in(
                &mut transaction,
                &input.name,
                all_tags,
                &tags,
                row.try_get::<i64, _>("ephemeral")? == 1,
                &row.try_get::<String, _>("labels")?,
                now,
            )
            .await?;
        }
        sqlx::query("INSERT INTO supertag_v2_auth_key_joins (key_digest,role,name,enrollment_digest,enrolled_at_ms) VALUES ($1,$2,$3,$4,$5)")
            .bind(&key).bind(role.as_str()).bind(&input.name).bind(&fingerprint).bind(now)
            .execute(&mut *transaction).await?;
        sqlx::query("UPDATE supertag_v2_auth_keys SET consumed_at_ms=COALESCE(consumed_at_ms,$1) WHERE key_digest=$2")
            .bind(now)
            .bind(&key)
            .execute(&mut *transaction)
            .await?;
        let enrollment = enrollment_in(&mut transaction, role, &input.name)
            .await?
            .ok_or(StoreError::PermissionDenied)?;
        transaction.commit().await?;
        Ok(enrollment)
    }

    /// Records a credential from the Control Plane's startup configuration: `host:local` with
    /// every Tag, or `gateway:local`, which may serve any connector account with every Tag.
    /// Restarting with the same credential changes nothing.
    pub async fn seed_enrollment(&self, role: Role, id: &str, token_digest: &[u8]) -> Result<()> {
        enrollee_name(id)?;
        if role == Role::Client {
            return Err(invalid("clients enroll with an Auth Key"));
        }
        let token = credential_digest(token_digest)?;
        let (mut transaction, _) = self.write().await?;
        let existing = sqlx::query(
            "SELECT token_digest FROM supertag_v2_enrollments WHERE role=$1 AND name=$2",
        )
        .bind(role.as_str())
        .bind(id)
        .fetch_optional(&mut *transaction)
        .await?;
        if let Some(row) = existing {
            if row.try_get::<String, _>("token_digest")? != token {
                return Err(StoreError::Conflict(format!(
                    "{}:{id} is enrolled with a different credential",
                    role.as_str()
                )));
            }
            transaction.rollback().await?;
            return Ok(());
        }
        credential_unused_in(&mut transaction, &token).await?;
        let now = self.execution_now_ms();
        insert_enrollment_in(
            &mut transaction,
            role,
            id,
            &token,
            None,
            &[],
            role == Role::Gateway,
            now,
        )
        .await?;
        if role == Role::Host {
            if super::hosts::host_exists_in(&mut transaction, id).await? {
                return Err(StoreError::Conflict(
                    "Worker Host is enrolled with different credentials or scope".into(),
                ));
            }
            super::hosts::insert_host_in(&mut transaction, id, true, &[], false, "[]", now).await?;
        }
        transaction.commit().await?;
        Ok(())
    }

    /// Resolves the digest of a presented enrolled credential. `None` when no unrevoked
    /// enrollment holds it. A success refreshes `last_used_at_ms` at most once a minute.
    pub async fn resolve_credential(
        &self,
        token_digest: &[u8],
    ) -> Result<Option<ResolvedCredential>> {
        let Ok(token) = credential_digest(token_digest) else {
            return Ok(None);
        };
        let Some(row) = sqlx::query("SELECT e.role,e.name,e.last_used_at_ms,h.generation FROM supertag_v2_enrollments e LEFT JOIN supertag_v2_hosts h ON e.role='host' AND h.host_id=e.name WHERE e.token_digest=$1 AND e.revoked_at_ms IS NULL AND (e.role<>'host' OR h.revoked_at_ms IS NULL)")
            .bind(&token).fetch_optional(&self.pool).await?
        else {
            return Ok(None);
        };
        let role = Role::parse(&row.try_get::<String, _>("role")?)?;
        let name: String = row.try_get("name")?;
        let now = self.execution_now_ms();
        if row
            .try_get::<Option<i64>, _>("last_used_at_ms")?
            .is_none_or(|used| now.saturating_sub(used) >= LAST_USED_INTERVAL_MS)
        {
            sqlx::query("UPDATE supertag_v2_enrollments SET last_used_at_ms=$1 WHERE token_digest=$2 AND (last_used_at_ms IS NULL OR last_used_at_ms<=$3)")
                .bind(now).bind(&token).bind(now - LAST_USED_INTERVAL_MS)
                .execute(&self.pool).await?;
        }
        Ok(Some(ResolvedCredential {
            role: role.proto().into(),
            name,
            generation: row
                .try_get::<Option<i64>, _>("generation")?
                .map_or(0, |generation| generation as u64),
        }))
    }

    /// Replaces an enrolled credential's digest. An enrollee rotates its own (an empty name); an
    /// operator rotates any. The previous credential stops authenticating at once. A repeat with
    /// the digest the rotation installed returns the same result, so a lost response can be
    /// retried.
    pub async fn rotate_credential(
        &self,
        caller: &str,
        input: &RotateCredentialRequest,
    ) -> Result<CredentialRotation> {
        let role = required_role(input.role)?;
        let target = if input.name.is_empty() {
            match enrolled_principal(caller) {
                Some((own_role, own_name)) if own_role == role => own_name.to_owned(),
                _ => {
                    return Err(invalid(
                        "name the enrollee to rotate, or rotate your own credential in your role",
                    ));
                }
            }
        } else {
            operator(caller)?;
            enrollee_name(&input.name)?;
            input.name.clone()
        };
        // An enrollee rotating its own credential may leave the revision 0: the credential it
        // presents names the revision it replaces.
        let expected = match input.expected_credential_revision {
            0 if input.name.is_empty() => None,
            value => Some(
                i64::try_from(value)
                    .ok()
                    .filter(|revision| *revision > 0)
                    .ok_or_else(|| invalid("expected credential revision must be at least 1"))?,
            ),
        };
        let token = credential_digest(&input.token_digest)?;
        let principal = format!("{}:{target}", role.as_str());
        let (mut transaction, _) = self.write().await?;
        let row = sqlx::query("SELECT * FROM supertag_v2_enrollments WHERE role=$1 AND name=$2")
            .bind(role.as_str())
            .bind(&target)
            .fetch_optional(&mut *transaction)
            .await?
            .ok_or_else(|| StoreError::NotFound(format!("{principal} was not found")))?;
        if row.try_get::<Option<i64>, _>("revoked_at_ms")?.is_some() {
            return Err(StoreError::FailedPrecondition(format!(
                "{principal} is revoked; enroll under a new name instead"
            )));
        }
        let revision: i64 = row.try_get("credential_revision")?;
        let installed = row.try_get::<String, _>("token_digest")? == token;
        if installed && expected.is_none_or(|expected| Some(revision) == expected.checked_add(1)) {
            transaction.rollback().await?;
            return Ok(CredentialRotation {
                principal,
                credential_revision: revision as u64,
            });
        }
        if expected.is_some_and(|expected| revision != expected) {
            return Err(StoreError::FailedPrecondition(
                "credential revision changed; read the enrollment and retry".into(),
            ));
        }
        // A credential set when the Control Plane starts is replaced by changing that setting.
        if row.try_get::<Option<String>, _>("auth_key_name")?.is_none() {
            return Err(StoreError::FailedPrecondition(format!(
                "{principal}'s credential comes from the Control Plane's startup configuration"
            )));
        }
        credential_unused_in(&mut transaction, &token).await?;
        sqlx::query("UPDATE supertag_v2_enrollments SET token_digest=$1,credential_revision=$2 WHERE role=$3 AND name=$4 AND credential_revision=$5")
            .bind(&token).bind(revision + 1).bind(role.as_str()).bind(&target).bind(revision)
            .execute(&mut *transaction).await?;
        sqlx::query("INSERT INTO supertag_v2_enrollment_secrets (token_digest,role,name,credential_revision) VALUES ($1,$2,$3,$4)")
            .bind(&token).bind(role.as_str()).bind(&target).bind(revision + 1)
            .execute(&mut *transaction).await?;
        transaction.commit().await?;
        Ok(CredentialRotation {
            principal,
            credential_revision: (revision + 1) as u64,
        })
    }

    pub async fn get_enrollment(&self, principal: &str, role: i32, id: &str) -> Result<Enrollment> {
        operator(principal)?;
        let role = required_role(role)?;
        enrollee_name(id)?;
        let mut transaction = self.pool.begin().await?;
        let enrollment = enrollment_in(&mut transaction, role, id)
            .await?
            .ok_or_else(|| StoreError::NotFound(format!("{}:{id} was not found", role.as_str())))?;
        transaction.commit().await?;
        Ok(enrollment)
    }

    /// Enrollments by role, then name. The cursor is the last `role:name` of the previous page.
    pub async fn list_enrollments(
        &self,
        principal: &str,
        input: &ListEnrollmentsRequest,
    ) -> Result<ListEnrollmentsResponse> {
        operator(principal)?;
        let role = match PrincipalRole::try_from(input.role) {
            Ok(PrincipalRole::Unspecified) => None,
            _ => Some(required_role(input.role)?),
        };
        if input.limit > 500 {
            return Err(invalid("enrollment page limit must be at most 500"));
        }
        let limit = if input.limit == 0 { 100 } else { input.limit } as usize;
        let (after_role, after_name) = if input.cursor.is_empty() {
            (String::new(), String::new())
        } else {
            let (role, name) = enrolled_principal(&input.cursor)
                .ok_or_else(|| invalid("unknown enrollment cursor"))?;
            (role.as_str().to_owned(), name.to_owned())
        };
        let mut transaction = self.pool.begin().await?;
        let mut rows = sqlx::query("SELECT * FROM supertag_v2_enrollments WHERE ($1='' OR role=$1) AND (role>$2 OR (role=$2 AND name>$3)) ORDER BY role, name LIMIT $4")
            .bind(role.map_or("", Role::as_str)).bind(&after_role).bind(&after_name).bind((limit + 1) as i64)
            .fetch_all(&mut *transaction).await?;
        transaction.commit().await?;
        let next_cursor = if rows.len() > limit {
            rows.truncate(limit);
            rows.last()
                .map(|row| -> Result<String> {
                    Ok(format!(
                        "{}:{}",
                        row.try_get::<String, _>("role")?,
                        row.try_get::<String, _>("name")?
                    ))
                })
                .transpose()?
                .unwrap_or_default()
        } else {
            String::new()
        };
        Ok(ListEnrollmentsResponse {
            enrollments: rows.iter().map(enrollment_row).collect::<Result<_>>()?,
            next_cursor,
        })
    }

    /// Idempotent. Revoking a host also fences its execution.
    pub async fn revoke_enrollment(
        &self,
        principal: &str,
        role: i32,
        id: &str,
    ) -> Result<Enrollment> {
        operator(principal)?;
        let role = required_role(role)?;
        enrollee_name(id)?;
        if role == Role::Host {
            self.revoke_host(id).await?;
        }
        let (mut transaction, _) = self.write().await?;
        enrollment_in(&mut transaction, role, id)
            .await?
            .ok_or_else(|| StoreError::NotFound(format!("{}:{id} was not found", role.as_str())))?;
        revoke_enrollment_in(&mut transaction, role, id, self.execution_now_ms()).await?;
        let enrollment = enrollment_in(&mut transaction, role, id)
            .await?
            .ok_or(StoreError::PermissionDenied)?;
        transaction.commit().await?;
        Ok(enrollment)
    }

    /// The Tags a client may talk to: `None` for every Tag. Operators are not limited.
    pub(crate) async fn client_tags(&self, principal: &str) -> Result<Option<Vec<String>>> {
        let mut transaction = self.pool.begin().await?;
        let tags = client_tags_in(&mut transaction, principal).await?;
        transaction.commit().await?;
        Ok(tags)
    }

    /// Refuses a client whose Auth Key does not let it talk to `tag`, as if the Tag did not exist.
    pub(crate) async fn ensure_client_tag(&self, principal: &str, tag: &str) -> Result<()> {
        if let Some(tags) = self.client_tags(principal).await?
            && !tags.iter().any(|allowed| allowed == tag)
        {
            return Err(StoreError::NotFound("Tag was not found".into()));
        }
        Ok(())
    }
}

/// The Tags a client may talk to: `None` for every Tag, and for every principal but a client.
pub(crate) async fn client_tags_in(
    transaction: &mut Transaction<'_, Any>,
    principal: &str,
) -> Result<Option<Vec<String>>> {
    let Some(id) = principal.strip_prefix("client:") else {
        return Ok(None);
    };
    let row = sqlx::query("SELECT allowed_tag_ids,all_tags FROM supertag_v2_enrollments WHERE role='client' AND name=$1")
        .bind(id).fetch_optional(&mut **transaction).await?
        .ok_or(StoreError::PermissionDenied)?;
    if row.try_get::<i64, _>("all_tags")? == 1 {
        return Ok(None);
    }
    Ok(Some(serde_json::from_str(
        &row.try_get::<String, _>("allowed_tag_ids")?,
    )?))
}

pub(super) async fn revoke_enrollment_in(
    transaction: &mut Transaction<'_, Any>,
    role: Role,
    id: &str,
    now: i64,
) -> Result<()> {
    sqlx::query("UPDATE supertag_v2_enrollments SET revoked_at_ms=$1 WHERE role=$2 AND name=$3 AND revoked_at_ms IS NULL")
        .bind(now).bind(role.as_str()).bind(id)
        .execute(&mut **transaction).await?;
    Ok(())
}

#[allow(clippy::too_many_arguments)]
async fn insert_enrollment_in(
    transaction: &mut Transaction<'_, Any>,
    role: Role,
    id: &str,
    token: &str,
    auth_key_name: Option<&str>,
    tags: &[String],
    all_tags: bool,
    now: i64,
) -> Result<()> {
    sqlx::query("INSERT INTO supertag_v2_enrollments (role,name,token_digest,auth_key_name,allowed_tag_ids,all_tags,enrolled_at_ms) VALUES ($1,$2,$3,$4,$5,$6,$7)")
        .bind(role.as_str()).bind(id).bind(token).bind(auth_key_name)
        .bind(serde_json::to_string(tags)?).bind(i64::from(all_tags)).bind(now)
        .execute(&mut **transaction).await?;
    sqlx::query("INSERT INTO supertag_v2_enrollment_secrets (token_digest,role,name,credential_revision) VALUES ($1,$2,$3,1)")
        .bind(token).bind(role.as_str()).bind(id)
        .execute(&mut **transaction).await?;
    Ok(())
}

async fn enrollment_in(
    transaction: &mut Transaction<'_, Any>,
    role: Role,
    id: &str,
) -> Result<Option<Enrollment>> {
    sqlx::query("SELECT * FROM supertag_v2_enrollments WHERE role=$1 AND name=$2")
        .bind(role.as_str())
        .bind(id)
        .fetch_optional(&mut **transaction)
        .await?
        .as_ref()
        .map(enrollment_row)
        .transpose()
}

fn enrollment_row(row: &AnyRow) -> Result<Enrollment> {
    let role = Role::parse(&row.try_get::<String, _>("role")?)?;
    let name: String = row.try_get("name")?;
    Ok(Enrollment {
        role: role.proto().into(),
        principal: format!("{}:{name}", role.as_str()),
        name,
        auth_key_name: row
            .try_get::<Option<String>, _>("auth_key_name")?
            .unwrap_or_default(),
        enrolled_at_ms: row.try_get("enrolled_at_ms")?,
        last_used_at_ms: row.try_get("last_used_at_ms")?,
        revoked_at_ms: row.try_get("revoked_at_ms")?,
        credential_revision: row.try_get::<i64, _>("credential_revision")? as u64,
        allowed_tag_ids: serde_json::from_str(&row.try_get::<String, _>("allowed_tag_ids")?)?,
        all_tags: row.try_get::<i64, _>("all_tags")? == 1,
    })
}

fn auth_key_row(row: &AnyRow) -> Result<AuthKey> {
    Ok(AuthKey {
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
        role: Role::parse(&row.try_get::<String, _>("role")?)?
            .proto()
            .into(),
    })
}

/// A new credential is no enrollee's current or earlier credential, no Auth Key, and no
/// Operator Token.
async fn credential_unused_in(transaction: &mut Transaction<'_, Any>, token: &str) -> Result<()> {
    let used: Option<String> = sqlx::query_scalar("SELECT key_digest FROM supertag_v2_auth_keys WHERE key_digest=$1 UNION SELECT token_digest FROM supertag_v2_enrollment_secrets WHERE token_digest=$1 UNION SELECT secret_digest FROM supertag_v2_operator_token_secrets WHERE secret_digest=$1")
        .bind(token)
        .fetch_optional(&mut **transaction)
        .await?;
    if used.is_some() {
        return Err(StoreError::Conflict("credential is already in use".into()));
    }
    Ok(())
}

pub(crate) fn operator(principal: &str) -> Result<()> {
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

/// 1 to 250 ASCII letters, digits, hyphens, underscores or dots: a Worker Host ID, Gateway name
/// or client name.
/// The name of the host and Gateway the Control Plane seeds from its configuration.
const BOOTSTRAP_NAME: &str = "local";

pub(crate) fn enrollee_name(id: &str) -> Result<()> {
    if id.is_empty()
        || id.len() > 250
        || !id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"-_.".contains(&byte))
    {
        return Err(invalid(
            "names are 1-250 letters, digits, hyphens, underscores or dots",
        ));
    }
    Ok(())
}

pub(super) fn credential_digest(bytes: &[u8]) -> Result<String> {
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
