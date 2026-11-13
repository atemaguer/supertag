//! Fenced connector ownership. One Gateway delivers an account's replies at a time.
//! Ingress stays stateless: any Gateway may accept a verified provider event.
use crate::{
    Store, StoreError,
    store::{Result, connector_account, name},
};
use sqlx::{Any, Row, Transaction};
use supertag_protocol::v2::{
    ClaimConnectorRequest, ConnectorLease, ReleaseConnectorRequest, RenewConnectorRequest,
    SurfaceAccount,
};
use uuid::Uuid;

pub(crate) const CONNECTOR_LEASE_MS: i64 = 15_000;

impl Store {
    /// Checks that `gateway` (a Gateway name) serves the connector account. A managed account is
    /// served by the Gateway its SurfaceAccount names. An unmanaged account belongs to the first
    /// Gateway that acts for it, until that Gateway is revoked; then the next one takes it over.
    pub async fn bind_connector_account(&self, gateway: &str, account: &str) -> Result<()> {
        name("connector account", account)?;
        let managed = sqlx::query(
            "SELECT a.payload FROM supertag_v2_managed_connector_aliases alias
             JOIN supertag_v2_surface_accounts a ON a.account_id=alias.account_id
             WHERE alias.connector_account_id=$1",
        )
        .bind(account)
        .fetch_optional(&self.pool)
        .await?;
        if let Some(row) = managed {
            let surface: SurfaceAccount =
                crate::policy::decode(&row.try_get::<Vec<u8>, _>("payload")?)?;
            return if surface.gateway == gateway {
                Ok(())
            } else {
                Err(StoreError::PermissionDenied)
            };
        }
        let bound: Option<String> = sqlx::query_scalar(
            "SELECT gateway FROM supertag_v2_connector_gateways WHERE connector_account_id=$1",
        )
        .bind(account)
        .fetch_optional(&self.pool)
        .await?;
        if bound.as_deref() == Some(gateway) {
            return Ok(());
        }
        let (mut tx, _) = self.write().await?;
        let current: Option<String> = sqlx::query_scalar(
            "SELECT b.gateway FROM supertag_v2_connector_gateways b
             JOIN supertag_v2_enrollments e ON e.role='gateway' AND e.name=b.gateway
             WHERE b.connector_account_id=$1 AND e.revoked_at_ms IS NULL",
        )
        .bind(account)
        .fetch_optional(&mut *tx)
        .await?;
        match current {
            Some(current) if current == gateway => {}
            Some(_) => return Err(StoreError::PermissionDenied),
            None => {
                sqlx::query(
                    "DELETE FROM supertag_v2_connector_gateways WHERE connector_account_id=$1",
                )
                .bind(account)
                .execute(&mut *tx)
                .await?;
                sqlx::query("INSERT INTO supertag_v2_connector_gateways (connector_account_id,gateway,bound_at_ms) VALUES ($1,$2,$3)")
                    .bind(account).bind(gateway).bind(self.execution_now_ms())
                    .execute(&mut *tx).await?;
            }
        }
        tx.commit().await?;
        Ok(())
    }

    /// Grant ownership when the account is free, expired, or already held by the
    /// same stable owner (a restarted Gateway with the same private state).
    pub async fn claim_connector(
        &self,
        principal: &str,
        input: &ClaimConnectorRequest,
    ) -> Result<ConnectorLease> {
        let account = connector_account(principal)?;
        name("connector owner ID", &input.owner_id)?;
        let (mut tx, _) = self.write().await?;
        let now = self.execution_now_ms();
        let current = sqlx::query(
            "SELECT owner_id,fence,expires_at_ms FROM supertag_v2_connector_leases WHERE account_id=$1",
        )
        .bind(account)
        .fetch_optional(&mut *tx)
        .await?;
        let fence = match &current {
            Some(row) => {
                let owner: String = row.try_get("owner_id")?;
                let expires: i64 = row.try_get("expires_at_ms")?;
                if owner != input.owner_id && expires > now {
                    tx.commit().await?;
                    return Ok(ConnectorLease {
                        granted: false,
                        retry_after_ms: (expires - now) as u64,
                        ..Default::default()
                    });
                }
                row.try_get::<i64, _>("fence")? + 1
            }
            None => 1,
        };
        let token = Uuid::new_v4().to_string();
        let expires = now.saturating_add(CONNECTOR_LEASE_MS);
        if current.is_some() {
            sqlx::query("UPDATE supertag_v2_connector_leases SET owner_id=$1,lease_token=$2,fence=$3,expires_at_ms=$4 WHERE account_id=$5")
                .bind(&input.owner_id).bind(&token).bind(fence).bind(expires).bind(account).execute(&mut *tx).await?;
        } else {
            sqlx::query("INSERT INTO supertag_v2_connector_leases (account_id,owner_id,lease_token,fence,expires_at_ms) VALUES ($1,$2,$3,$4,$5)")
                .bind(account).bind(&input.owner_id).bind(&token).bind(fence).bind(expires).execute(&mut *tx).await?;
        }
        tx.commit().await?;
        Ok(ConnectorLease {
            granted: true,
            lease_token: token,
            fence: fence as u64,
            valid_for_ms: CONNECTOR_LEASE_MS as u64,
            retry_after_ms: 0,
        })
    }

    pub async fn renew_connector(
        &self,
        principal: &str,
        input: &RenewConnectorRequest,
    ) -> Result<ConnectorLease> {
        let account = connector_account(principal)?;
        name("connector lease token", &input.lease_token)?;
        let (mut tx, _) = self.write().await?;
        let now = self.execution_now_ms();
        let fence = current_in(&mut tx, account, &input.lease_token, now).await?;
        sqlx::query("UPDATE supertag_v2_connector_leases SET expires_at_ms=$1 WHERE account_id=$2")
            .bind(now.saturating_add(CONNECTOR_LEASE_MS))
            .bind(account)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        Ok(ConnectorLease {
            granted: true,
            lease_token: input.lease_token.clone(),
            fence: fence as u64,
            valid_for_ms: CONNECTOR_LEASE_MS as u64,
            retry_after_ms: 0,
        })
    }

    /// Releasing a lease that was already lost is not an error: the account has
    /// another owner or none, and this Gateway owns nothing either way.
    pub async fn release_connector(
        &self,
        principal: &str,
        input: &ReleaseConnectorRequest,
    ) -> Result<()> {
        let account = connector_account(principal)?;
        name("connector lease token", &input.lease_token)?;
        let (mut tx, _) = self.write().await?;
        sqlx::query("UPDATE supertag_v2_connector_leases SET expires_at_ms=0 WHERE account_id=$1 AND lease_token=$2")
            .bind(account)
            .bind(&input.lease_token)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        Ok(())
    }

    /// Claim the next reply only for the account's current owner.
    pub async fn claim_owned_reply(
        &self,
        principal: &str,
        input: &supertag_protocol::v2::ClaimReplyRequest,
    ) -> Result<supertag_protocol::v2::ClaimReplyResponse> {
        connector_account(principal)?;
        name("connector lease token", &input.connector_lease_token)?;
        self.claim_reply_as(
            principal,
            &input.operation_id,
            Some(&input.connector_lease_token),
        )
        .await
    }
}

pub(crate) async fn current_in(
    tx: &mut Transaction<'_, Any>,
    account: &str,
    token: &str,
    now: i64,
) -> Result<i64> {
    let row = sqlx::query(
        "SELECT lease_token,fence,expires_at_ms FROM supertag_v2_connector_leases WHERE account_id=$1",
    )
    .bind(account)
    .fetch_optional(&mut **tx)
    .await?;
    match row {
        Some(row)
            if row.try_get::<String, _>("lease_token")? == token
                && row.try_get::<i64, _>("expires_at_ms")? > now =>
        {
            Ok(row.try_get("fence")?)
        }
        _ => Err(StoreError::FailedPrecondition(
            "connector ownership lease is not current".into(),
        )),
    }
}
