//! Users: the people admitted to the Control Plane, and their invite keys. A User is a person,
//! never a machine. Every client device belongs to one and acts for them as `user:NAME`; a Worker
//! Host enrolled with a User's invite key belongs to them.

use sqlx::{Any, Row, Transaction, any::AnyRow};
use supertag_protocol::v2::{
    GetUserRequest, InviteUserRequest, InviteUserResponse, ListUsersRequest, ListUsersResponse,
    PutTagRequest, User,
};

use super::enrollments::{credential_digest, credential_unused_in, fingerprint, operator};
use super::{Result, Store, StoreError, invalid, name};

/// An invite key lasts 7 days unless the operator asks for another lifetime.
const DEFAULT_INVITE_LIFETIME_MS: i64 = 7 * 24 * 60 * 60_000;
/// At most as long as any reusable Auth Key.
const MAX_INVITE_LIFETIME_MS: i64 = 90 * 24 * 60 * 60_000;
/// Leaves room for `-invite-N` in the invite key's name, which is at most 63 bytes.
const MAX_USER_NAME: usize = 50;
const MAX_DISPLAY_NAME: usize = 100;

/// A User's name: a resource ID (as the personal Tag named after them is) of at most 50 bytes.
pub(crate) fn valid_user_name(value: &str) -> bool {
    value.len() <= MAX_USER_NAME && supertag_protocol::valid_resource_id(value)
}

fn user_name(value: &str) -> Result<()> {
    if valid_user_name(value) {
        Ok(())
    } else {
        Err(invalid(
            "a User's name is 1-50 lowercase letters, digits or hyphens, starting with a letter or digit and not ending with a hyphen",
        ))
    }
}

fn display_name(value: &str) -> Result<String> {
    let value = value.split_whitespace().collect::<Vec<_>>().join(" ");
    if value.chars().count() > MAX_DISPLAY_NAME || value.chars().any(char::is_control) {
        return Err(invalid(
            "a display name is at most 100 characters without control characters",
        ));
    }
    Ok(value)
}

impl Store {
    /// Creates the User, or finds an existing one, and issues a new reusable invite key that
    /// enrolls the User's devices and Worker Hosts. A repeat of the same operation returns the
    /// same User and key.
    pub async fn invite_user(
        &self,
        principal: &str,
        input: &InviteUserRequest,
    ) -> Result<InviteUserResponse> {
        operator(principal)?;
        user_name(&input.name)?;
        name("operation ID", &input.operation_id)?;
        let display = display_name(&input.display_name)?;
        if !input.role.is_empty() {
            super::resource_id("Role ID", &input.role)?;
        }
        if input.allowed_tag_ids.len() > 256 {
            return Err(invalid("an invite lists at most 256 shared Tags"));
        }
        let mut tags = input.allowed_tag_ids.clone();
        for tag in &tags {
            name("Tag ID", tag)?;
        }
        tags.sort_unstable();
        tags.dedup();
        let expires_in_ms = match input.expires_in_ms {
            0 => DEFAULT_INVITE_LIFETIME_MS,
            value => i64::try_from(value)
                .ok()
                .filter(|value| *value <= MAX_INVITE_LIFETIME_MS)
                .ok_or_else(|| invalid("an invite key lasts at most 90 days"))?,
        };
        let key = credential_digest(&input.key_digest)?;
        let request = fingerprint(&(
            &input.name,
            &display,
            &input.role,
            &tags,
            expires_in_ms,
            &key,
        ))?;
        let (mut tx, _) = self.write().await?;
        // A repeat of the same invitation returns what the first one issued.
        if let Some(prior) = sqlx::query(
            "SELECT * FROM supertag_v2_auth_keys WHERE operator_principal=$1 AND operation_id=$2",
        )
        .bind(principal)
        .bind(&input.operation_id)
        .fetch_optional(&mut *tx)
        .await?
        {
            if prior.try_get::<String, _>("request_digest")? != request {
                return Err(StoreError::Conflict(
                    "operation ID was used with different invitation details".into(),
                ));
            }
            let user = user_in(&mut tx, &input.name).await?.ok_or_else(|| {
                StoreError::Conflict("operation ID was used for another Auth Key".into())
            })?;
            let auth_key = super::enrollments::auth_key_row(&prior)?;
            tx.rollback().await?;
            return Ok(InviteUserResponse {
                user: Some(user),
                auth_key: Some(auth_key),
            });
        }
        let now = self.execution_now_ms();
        let user = match user_in(&mut tx, &input.name).await? {
            Some(user) => {
                // An existing User keeps their details; an invitation only issues a new key.
                if (!display.is_empty() && display != user.display_name)
                    || !input.role.is_empty()
                    || !tags.is_empty()
                {
                    return Err(StoreError::FailedPrecondition(format!(
                        "User {} already exists; invite them again with no display name, Role or Tags to issue another key",
                        user.name
                    )));
                }
                user
            }
            None => {
                if display.is_empty() {
                    return Err(invalid("a new User needs a display name"));
                }
                for tag in &tags {
                    crate::tags::require_active(&mut tx, tag).await?;
                    // A User reaches shared Tags; another person's own Tag is theirs alone.
                    if owner_in(&mut tx, tag).await?.is_some() {
                        return Err(StoreError::FailedPrecondition(format!(
                            "Tag {tag} is another User's personal Tag; list only shared Tags"
                        )));
                    }
                }
                // The User's personal Tag takes their name, and Tag IDs are never reused.
                let taken: Option<String> =
                    sqlx::query_scalar("SELECT tag_id FROM supertag_v2_tags WHERE tag_id=$1")
                        .bind(&input.name)
                        .fetch_optional(&mut *tx)
                        .await?;
                if taken.is_some() {
                    return Err(StoreError::FailedPrecondition(format!(
                        "a Tag named {0} already exists, and {0}'s personal Tag takes that name; choose another User name",
                        input.name
                    )));
                }
                sqlx::query("INSERT INTO supertag_v2_users (name,display_name,role,allowed_tag_ids,created_at_ms,created_by) VALUES ($1,$2,$3,$4,$5,$6)")
                    .bind(&input.name).bind(&display).bind(&input.role)
                    .bind(serde_json::to_string(&tags)?).bind(now).bind(principal)
                    .execute(&mut *tx).await?;
                personal_tag_in(&mut tx, &input.name, &input.role).await?;
                user_in(&mut tx, &input.name)
                    .await?
                    .ok_or_else(|| StoreError::Conflict("the User was not recorded".into()))?
            }
        };
        credential_unused_in(&mut tx, &key).await?;
        // Auth Key names are never reused, so each invitation of the User takes the next number.
        let issued: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM supertag_v2_auth_keys WHERE user_name=$1")
                .bind(&user.name)
                .fetch_one(&mut *tx)
                .await?;
        let mut number = issued + 1;
        let key_name = loop {
            let candidate = format!("{}-invite-{number}", user.name);
            let taken: Option<String> =
                sqlx::query_scalar("SELECT name FROM supertag_v2_auth_keys WHERE name=$1")
                    .bind(&candidate)
                    .fetch_optional(&mut *tx)
                    .await?;
            if taken.is_none() {
                break candidate;
            }
            number += 1;
        };
        let expires_at_ms = now
            .checked_add(expires_in_ms)
            .ok_or_else(|| invalid("invite key expiry is out of range"))?;
        // The key enrolls clients, and the User's Worker Hosts too; it runs and reaches the
        // shared Tags the User may talk to.
        sqlx::query("INSERT INTO supertag_v2_auth_keys (key_digest,operator_principal,operation_id,request_digest,allowed_tag_ids,all_tags,expires_at_ms,reusable,ephemeral,labels,name,created_at_ms,role,user_name) VALUES ($1,$2,$3,$4,$5,0,$6,1,0,'[]',$7,$8,'client',$9)")
            .bind(&key).bind(principal).bind(&input.operation_id).bind(&request)
            .bind(serde_json::to_string(&user.allowed_tag_ids)?).bind(expires_at_ms)
            .bind(&key_name).bind(now).bind(&user.name)
            .execute(&mut *tx).await?;
        let row = sqlx::query("SELECT * FROM supertag_v2_auth_keys WHERE key_digest=$1")
            .bind(&key)
            .fetch_one(&mut *tx)
            .await?;
        let auth_key = super::enrollments::auth_key_row(&row)?;
        tx.commit().await?;
        Ok(InviteUserResponse {
            user: Some(user),
            auth_key: Some(auth_key),
        })
    }

    pub async fn get_user(&self, principal: &str, input: &GetUserRequest) -> Result<User> {
        operator(principal)?;
        user_name(&input.name)?;
        let mut tx = self.pool.begin().await?;
        let user = user_in(&mut tx, &input.name)
            .await?
            .ok_or_else(|| StoreError::NotFound(format!("User {} was not found", input.name)))?;
        tx.commit().await?;
        Ok(user)
    }

    pub async fn list_users(
        &self,
        principal: &str,
        input: &ListUsersRequest,
    ) -> Result<ListUsersResponse> {
        operator(principal)?;
        if input.limit > 500 {
            return Err(invalid("User page limit must be at most 500"));
        }
        let limit = if input.limit == 0 { 100 } else { input.limit } as usize;
        let mut rows =
            sqlx::query("SELECT * FROM supertag_v2_users WHERE name>$1 ORDER BY name LIMIT $2")
                .bind(&input.cursor)
                .bind((limit + 1) as i64)
                .fetch_all(&self.pool)
                .await?;
        let next_cursor = if rows.len() > limit {
            rows.truncate(limit);
            rows.last()
                .map(|row| row.try_get::<String, _>("name"))
                .transpose()?
                .unwrap_or_default()
        } else {
            String::new()
        };
        Ok(ListUsersResponse {
            users: rows.iter().map(user_row).collect::<Result<_>>()?,
            next_cursor,
        })
    }
}

/// Creates a new User's personal Tag: named after them, owned by them, with their Role, or the
/// Control Plane's `personal` Role when the operator defined one. The owner chooses its harness
/// and Workspace later.
async fn personal_tag_in(tx: &mut Transaction<'_, Any>, user: &str, role: &str) -> Result<()> {
    Store::put_tag_in(
        tx,
        PutTagRequest {
            tag_id: user.into(),
            ..Default::default()
        },
    )
    .await?;
    sqlx::query("UPDATE supertag_v2_tags SET owner_user=$1 WHERE tag_id=$1")
        .bind(user)
        .execute(&mut **tx)
        .await?;
    if role.is_empty() {
        crate::policy::assign_new_tag_role_in(tx, PERSONAL_ROLE, user, false).await?;
    } else {
        crate::policy::assign_new_tag_role_in(tx, role, user, true).await?;
    }
    Ok(())
}

/// The Role every personal Tag takes unless its User's invitation names another.
pub(crate) const PERSONAL_ROLE: &str = "personal";

/// The User who owns a Tag, for a personal Tag.
pub(crate) async fn owner_in(
    tx: &mut Transaction<'_, Any>,
    tag_id: &str,
) -> Result<Option<String>> {
    Ok(sqlx::query_scalar::<_, Option<String>>(
        "SELECT owner_user FROM supertag_v2_tags WHERE tag_id=$1",
    )
    .bind(tag_id)
    .fetch_optional(&mut **tx)
    .await?
    .flatten())
}

pub(crate) async fn user_in(tx: &mut Transaction<'_, Any>, name: &str) -> Result<Option<User>> {
    sqlx::query("SELECT * FROM supertag_v2_users WHERE name=$1")
        .bind(name)
        .fetch_optional(&mut **tx)
        .await?
        .as_ref()
        .map(user_row)
        .transpose()
}

fn user_row(row: &AnyRow) -> Result<User> {
    Ok(User {
        name: row.try_get("name")?,
        display_name: row.try_get("display_name")?,
        created_at_ms: row.try_get("created_at_ms")?,
        role: row.try_get("role")?,
        allowed_tag_ids: serde_json::from_str(&row.try_get::<String, _>("allowed_tag_ids")?)?,
    })
}
