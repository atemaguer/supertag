use prost::Message;
use sqlx::any::AnyRow;

use super::*;
use crate::Store;

const ACCOUNT: &str = "surface-account";
const LOCATION: &str = "surface-location";

async fn account_in(tx: &mut Transaction<'_, Any>, id: &str) -> Result<Option<SurfaceAccount>> {
    let bytes: Option<Vec<u8>> =
        sqlx::query_scalar("SELECT payload FROM supertag_v2_surface_accounts WHERE account_id=$1")
            .bind(id)
            .fetch_optional(&mut **tx)
            .await?;
    bytes.map(|bytes| policy::decode(&bytes)).transpose()
}

/// The revision of a Surface location.
pub(crate) async fn location_revision_in(
    tx: &mut Transaction<'_, Any>,
    id: &str,
) -> Result<Option<u64>> {
    Ok(location_in(tx, id).await?.map(|value| value.revision))
}

/// Deletes a Surface location at `expected_revision`.
pub(crate) async fn delete_location_in(
    tx: &mut Transaction<'_, Any>,
    id: &str,
    expected_revision: u64,
) -> Result<()> {
    let value = location_in(tx, id)
        .await?
        .ok_or_else(|| StoreError::NotFound("Surface location was not found".into()))?;
    revision(Some(expected_revision), Some(value.revision))?;
    sqlx::query("DELETE FROM supertag_v2_surface_locations WHERE location_id=$1")
        .bind(id)
        .execute(&mut **tx)
        .await?;
    crate::apply_sets::forget(tx, "SurfaceLocation", id).await
}

async fn location_in(tx: &mut Transaction<'_, Any>, id: &str) -> Result<Option<SurfaceLocation>> {
    let bytes: Option<Vec<u8>> = sqlx::query_scalar(
        "SELECT payload FROM supertag_v2_surface_locations WHERE location_id=$1",
    )
    .bind(id)
    .fetch_optional(&mut **tx)
    .await?;
    bytes.map(|bytes| policy::decode(&bytes)).transpose()
}

fn revision(expected: Option<u64>, prior: Option<u64>) -> Result<()> {
    if expected != prior {
        return Err(StoreError::Conflict(
            "Surface policy revision changed or expected revision is missing".into(),
        ));
    }
    Ok(())
}

fn page<M: Message + Default>(
    rows: Vec<AnyRow>,
    limit: usize,
    kind: &str,
    scope: &str,
    id: impl Fn(&M) -> &str,
) -> Result<(Vec<M>, String)> {
    let mut output = Vec::new();
    let mut bytes = 0;
    for row in rows {
        let value: M = policy::decode(&row.try_get::<Vec<u8>, _>("payload")?)?;
        bytes += value.encoded_len() + 16;
        if output.len() == limit || bytes > policy::PAGE_BYTES {
            let last = output
                .last()
                .ok_or_else(|| invalid("Surface policy exceeds the page limit"))?;
            let cursor = policy::next_cursor(kind, scope, id(last))?;
            return Ok((output, cursor));
        }
        output.push(value);
    }
    Ok((output, String::new()))
}

async fn bind_alias(
    tx: &mut Transaction<'_, Any>,
    location: &SurfaceLocation,
    scope_key: &str,
) -> Result<()> {
    let alias = sqlx::query("SELECT account_id,scope_key,tag_id FROM supertag_v2_managed_connector_aliases WHERE connector_account_id=$1")
        .bind(&location.connector_account_id).fetch_optional(&mut **tx).await?;
    if let Some(alias) = alias {
        if alias.try_get::<String, _>("account_id")? != location.account_id
            || alias.try_get::<String, _>("scope_key")? != scope_key
            || alias.try_get::<String, _>("tag_id")? != location.tag_id
        {
            return Err(StoreError::Conflict(
                "connector account alias already belongs to another Surface location or Tag".into(),
            ));
        }
    } else {
        sqlx::query("INSERT INTO supertag_v2_managed_connector_aliases (connector_account_id,account_id,scope_key,tag_id) VALUES ($1,$2,$3,$4)")
            .bind(&location.connector_account_id).bind(&location.account_id).bind(scope_key)
            .bind(&location.tag_id).execute(&mut **tx).await?;
    }
    Ok(())
}

fn normalize_set_ids(ids: &mut Vec<String>) -> Result<()> {
    if ids.len() > 128 {
        return Err(invalid("too many policy Sets on one Surface location"));
    }
    for id in ids.iter() {
        name("policy Set ID", id)?;
    }
    ids.sort_unstable();
    ids.dedup();
    Ok(())
}

async fn replace_refs(
    tx: &mut Transaction<'_, Any>,
    location_id: &str,
    relation: &str,
    table: &str,
    sets: &[String],
) -> Result<()> {
    sqlx::query(&format!("DELETE FROM {relation} WHERE location_id=$1"))
        .bind(location_id)
        .execute(&mut **tx)
        .await?;
    let insert = format!(
        "INSERT INTO {relation} (location_id,set_id) SELECT $1,set_id FROM {table} WHERE set_id=$2"
    );
    for set in sets {
        let changed = sqlx::query(&insert)
            .bind(location_id)
            .bind(set)
            .execute(&mut **tx)
            .await?;
        if changed.rows_affected() != 1 {
            return Err(StoreError::NotFound(
                "Surface location references an unknown policy Set".into(),
            ));
        }
    }
    Ok(())
}

impl Store {
    pub async fn put_surface_account(
        &self,
        principal: &str,
        input: &PutSurfaceAccountRequest,
    ) -> Result<SurfaceAccount> {
        policy::operator(principal)?;
        name("operation ID", &input.operation_id)?;
        let hash = policy::digest("put-surface-account", input);
        let (mut tx, _) = self.write().await?;
        if let Some(value) = policy::replay(&mut tx, principal, &input.operation_id, &hash).await? {
            return Ok(value);
        }
        let mut value = input
            .account
            .clone()
            .ok_or_else(|| invalid("Surface Account is required"))?;
        name("Surface Account ID", &value.account_id)?;
        let (_, identity_key) = provider_identity(&value)?;
        let prior = account_in(&mut tx, &value.account_id).await?;
        revision(input.expected_revision, prior.as_ref().map(|a| a.revision))?;
        if prior.as_ref().is_some_and(|a| a.identity != value.identity) {
            return Err(StoreError::Conflict(
                "Surface Account identity is immutable".into(),
            ));
        }
        let occupied: Option<String> = sqlx::query_scalar(
            "SELECT account_id FROM supertag_v2_surface_accounts WHERE identity_key=$1 AND account_id<>$2",
        ).bind(&identity_key).bind(&value.account_id).fetch_optional(&mut *tx).await?;
        if occupied.is_some() {
            return Err(StoreError::Conflict(
                "Surface Account identity already exists".into(),
            ));
        }
        value.revision = policy::next_revision_in(&mut tx, ACCOUNT, &value.account_id).await?;
        sqlx::query("INSERT INTO supertag_v2_surface_accounts (account_id,identity_key,revision,payload) VALUES ($1,$2,$3,$4) ON CONFLICT(account_id) DO UPDATE SET revision=excluded.revision,payload=excluded.payload")
            .bind(&value.account_id).bind(identity_key).bind(value.revision as i64).bind(value.encode_to_vec())
            .execute(&mut *tx).await?;
        policy::receipt(&mut tx, principal, &input.operation_id, &hash, &value).await?;
        tx.commit().await?;
        Ok(value)
    }

    pub async fn get_surface_account(
        &self,
        principal: &str,
        input: &GetSurfaceAccountRequest,
    ) -> Result<SurfaceAccount> {
        policy::operator(principal)?;
        name("Surface Account ID", &input.account_id)?;
        account_in(&mut self.pool.begin().await?, &input.account_id)
            .await?
            .ok_or_else(|| StoreError::NotFound("Surface Account was not found".into()))
    }

    pub async fn list_surface_accounts(
        &self,
        principal: &str,
        input: &ListSurfaceAccountsRequest,
    ) -> Result<ListSurfaceAccountsResponse> {
        policy::operator(principal)?;
        let (limit, after) = policy::page(
            &ListPolicyResourcesRequest {
                limit: input.limit,
                cursor: input.cursor.clone(),
            },
            ACCOUNT,
            "",
        )?;
        let rows = sqlx::query("SELECT payload FROM supertag_v2_surface_accounts WHERE account_id>$1 ORDER BY account_id LIMIT $2")
            .bind(after).bind(limit as i64+1).fetch_all(&self.pool).await?;
        let (accounts, next_cursor) =
            page(rows, limit, ACCOUNT, "", |a: &SurfaceAccount| &a.account_id)?;
        Ok(ListSurfaceAccountsResponse {
            accounts,
            next_cursor,
        })
    }

    pub async fn put_surface_location(
        &self,
        principal: &str,
        input: &PutSurfaceLocationRequest,
    ) -> Result<SurfaceLocation> {
        policy::operator(principal)?;
        name("operation ID", &input.operation_id)?;
        let hash = policy::digest("put-surface-location", input);
        let (mut tx, _) = self.write().await?;
        if let Some(value) = policy::replay(&mut tx, principal, &input.operation_id, &hash).await? {
            return Ok(value);
        }
        let mut value = input
            .location
            .clone()
            .ok_or_else(|| invalid("Surface location is required"))?;
        name("Surface location ID", &value.location_id)?;
        name("Surface Account ID", &value.account_id)?;
        name("Tag ID", &value.tag_id)?;
        normalize_set_ids(&mut value.permission_set_ids)?;
        normalize_set_ids(&mut value.context_set_ids)?;
        let account = account_in(&mut tx, &value.account_id)
            .await?
            .ok_or_else(|| StoreError::NotFound("Surface Account was not found".into()))?;
        let (provider, scope_key) = location_scope(&value)?;
        if provider_identity(&account)?.0 != provider {
            return Err(invalid("Surface location and account providers differ"));
        }
        verify_alias(provider, &value.connector_account_id)?;
        crate::tags::require_active(&mut tx, &value.tag_id).await?;
        let prior = location_in(&mut tx, &value.location_id).await?;
        revision(input.expected_revision, prior.as_ref().map(|l| l.revision))?;
        if prior.as_ref().is_some_and(|l| {
            l.account_id != value.account_id
                || l.connector_account_id != value.connector_account_id
                || l.scope != value.scope
                || l.tag_id != value.tag_id
        }) {
            return Err(StoreError::Conflict(
                "Surface location identity and owning Tag are immutable".into(),
            ));
        }
        let occupied: Option<String> = sqlx::query_scalar(
            "SELECT location_id FROM supertag_v2_surface_locations WHERE (connector_account_id=$1 OR (account_id=$2 AND scope_key=$3)) AND location_id<>$4 LIMIT 1",
        ).bind(&value.connector_account_id).bind(&value.account_id).bind(&scope_key)
            .bind(&value.location_id).fetch_optional(&mut *tx).await?;
        if occupied.is_some() {
            return Err(StoreError::Conflict(
                "Surface location or connector account alias already exists".into(),
            ));
        }
        bind_alias(&mut tx, &value, &scope_key).await?;
        value.revision = policy::next_revision_in(&mut tx, LOCATION, &value.location_id).await?;
        sqlx::query("INSERT INTO supertag_v2_surface_locations (location_id,account_id,connector_account_id,scope_key,revision,payload) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT(location_id) DO UPDATE SET revision=excluded.revision,payload=excluded.payload")
            .bind(&value.location_id).bind(&value.account_id).bind(&value.connector_account_id).bind(scope_key)
            .bind(value.revision as i64).bind(value.encode_to_vec()).execute(&mut *tx).await?;
        replace_refs(
            &mut tx,
            &value.location_id,
            "supertag_v2_surface_location_permission_sets",
            "supertag_v2_permission_sets",
            &value.permission_set_ids,
        )
        .await?;
        replace_refs(
            &mut tx,
            &value.location_id,
            "supertag_v2_surface_location_context_sets",
            "supertag_v2_context_sets",
            &value.context_set_ids,
        )
        .await?;
        policy::receipt(&mut tx, principal, &input.operation_id, &hash, &value).await?;
        tx.commit().await?;
        Ok(value)
    }

    pub async fn get_surface_location(
        &self,
        principal: &str,
        input: &GetSurfaceLocationRequest,
    ) -> Result<SurfaceLocation> {
        policy::operator(principal)?;
        name("Surface location ID", &input.location_id)?;
        location_in(&mut self.pool.begin().await?, &input.location_id)
            .await?
            .ok_or_else(|| StoreError::NotFound("Surface location was not found".into()))
    }

    pub async fn list_surface_locations(
        &self,
        principal: &str,
        input: &ListSurfaceLocationsRequest,
    ) -> Result<ListSurfaceLocationsResponse> {
        policy::operator(principal)?;
        if !input.account_id.is_empty() {
            name("Surface Account ID", &input.account_id)?;
        }
        let (limit, after) = policy::page(
            &ListPolicyResourcesRequest {
                limit: input.limit,
                cursor: input.cursor.clone(),
            },
            LOCATION,
            &input.account_id,
        )?;
        let rows = sqlx::query("SELECT payload FROM supertag_v2_surface_locations WHERE location_id>$1 AND ($2='' OR account_id=$2) ORDER BY location_id LIMIT $3")
            .bind(after).bind(&input.account_id).bind(limit as i64+1).fetch_all(&self.pool).await?;
        let (locations, next_cursor) = page(
            rows,
            limit,
            LOCATION,
            &input.account_id,
            |l: &SurfaceLocation| &l.location_id,
        )?;
        Ok(ListSurfaceLocationsResponse {
            locations,
            next_cursor,
        })
    }

    pub async fn delete_surface_location(
        &self,
        principal: &str,
        input: &DeleteSurfaceLocationRequest,
    ) -> Result<DeletePolicyResourceResponse> {
        policy::operator(principal)?;
        name("operation ID", &input.operation_id)?;
        name("Surface location ID", &input.location_id)?;
        let hash = policy::digest("delete-surface-location", input);
        let (mut tx, _) = self.write().await?;
        if let Some(value) = policy::replay(&mut tx, principal, &input.operation_id, &hash).await? {
            return Ok(value);
        }
        delete_location_in(&mut tx, &input.location_id, input.expected_revision).await?;
        let response = DeletePolicyResourceResponse { deleted: true };
        policy::receipt(&mut tx, principal, &input.operation_id, &hash, &response).await?;
        tx.commit().await?;
        Ok(response)
    }
}
