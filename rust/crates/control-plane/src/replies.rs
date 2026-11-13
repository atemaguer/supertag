//! Durable reply claim expiry and evidence-backed reconciliation. Never repost on expiry.
use crate::{
    Store, StoreError,
    policy::operator,
    store::{Result, connector_account, invalid, name, next_order, reply_in, reply_row, text},
};
use prost::Message;
use sha2::{Digest, Sha256};
use sqlx::{Any, Row, Transaction, any::AnyRow};
use supertag_protocol::v2::*;
use uuid::Uuid;

const LEASE_MS: i64 = 30_000;
const PAGE_BYTES: usize = 900 * 1024;

impl Store {
    pub async fn claim_reply(
        &self,
        principal: &str,
        operation_id: &str,
    ) -> Result<ClaimReplyResponse> {
        self.claim_reply_as(principal, operation_id, None).await
    }

    /// `owner` fences the claim to the account's current connector ownership lease.
    pub(crate) async fn claim_reply_as(
        &self,
        principal: &str,
        operation_id: &str,
        owner: Option<&str>,
    ) -> Result<ClaimReplyResponse> {
        let account = connector_account(principal)?;
        name("operation ID", operation_id)?;
        let (mut tx, _) = self.write().await?;
        let now = self.execution_now_ms();
        if let Some(owner) = owner {
            crate::connector_leases::current_in(&mut tx, account, owner, now).await?;
        }
        sweep_in(&mut tx, now).await?;
        if let Some(prior) = sqlx::query("SELECT reply_id,lease_token FROM supertag_v2_reply_claims WHERE account_id=$1 AND operation_id=$2").bind(account).bind(operation_id).fetch_optional(&mut *tx).await? {
            let mut reply = reply_row(&reply_in(&mut tx, account, &prior.try_get::<String,_>("reply_id")?).await?)?;
            crate::reply_progress::present_in(&mut tx, &mut reply).await?;
            let result = ClaimReplyResponse { reply: Some(reply), lease_token: prior.try_get("lease_token")? };
            tx.commit().await?;
            return Ok(result);
        }
        crate::reply_progress::sweep_in(&mut tx, now).await?;
        crate::reply_progress::enqueue_unsuccessful_in(&mut tx, account).await?;
        let id: Option<String> = sqlx::query_scalar(&format!("SELECT reply_id FROM supertag_v2_replies WHERE account_id=$1 AND state=$2 AND {} ORDER BY ready_order LIMIT 1", crate::reply_progress::FINAL_READY)).bind(account).bind(ReplyState::Pending as i64).bind(now).fetch_optional(&mut *tx).await?;
        let Some(id) = id else {
            tx.commit().await?;
            return Ok(ClaimReplyResponse::default());
        };
        let lease = Uuid::new_v4().to_string();
        sqlx::query("UPDATE supertag_v2_replies SET state=$1,lease_token=$2,lease_expires_at_ms=$3 WHERE reply_id=$4").bind(ReplyState::Claimed as i64).bind(&lease).bind(now.saturating_add(LEASE_MS)).bind(&id).execute(&mut *tx).await?;
        sqlx::query("INSERT INTO supertag_v2_reply_claims(account_id,operation_id,reply_id,lease_token) VALUES($1,$2,$3,$4)").bind(account).bind(operation_id).bind(&id).bind(&lease).execute(&mut *tx).await?;
        let mut reply = reply_row(&reply_in(&mut tx, account, &id).await?)?;
        crate::reply_progress::present_in(&mut tx, &mut reply).await?;
        let result = ClaimReplyResponse {
            reply: Some(reply),
            lease_token: lease,
        };
        supertag_protocol::crash_point("control-plane.claim-reply", "before-commit");
        tx.commit().await?;
        Ok(result)
    }

    pub async fn renew_reply(
        &self,
        principal: &str,
        input: &RenewReplyRequest,
    ) -> Result<ReplyLease> {
        let account = connector_account(principal)?;
        name("reply ID", &input.reply_id)?;
        name("lease token", &input.lease_token)?;
        let (mut tx, _) = self.write().await?;
        let now = self.execution_now_ms();
        let row = reply_in(&mut tx, account, &input.reply_id).await?;
        owned(&row, &input.lease_token)?;
        if row.try_get::<i64, _>("state")? != ReplyState::Claimed as i64
            || row
                .try_get::<Option<i64>, _>("lease_expires_at_ms")?
                .is_none_or(|expiry| now >= expiry)
        {
            sweep_in(&mut tx, now).await?;
            tx.commit().await?;
            return Err(StoreError::FailedPrecondition(
                "reply claim has expired or settled".into(),
            ));
        }
        sqlx::query("UPDATE supertag_v2_replies SET lease_expires_at_ms=$1 WHERE reply_id=$2")
            .bind(now.saturating_add(LEASE_MS))
            .bind(&input.reply_id)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        Ok(ReplyLease {
            valid_for_ms: LEASE_MS as u64,
        })
    }

    pub async fn settle_reply(&self, principal: &str, input: &SettleReplyRequest) -> Result<Reply> {
        let account = connector_account(principal)?;
        name("reply ID", &input.reply_id)?;
        name("lease token", &input.lease_token)?;
        if ![
            ReplyState::Delivered as i32,
            ReplyState::Failed as i32,
            ReplyState::Uncertain as i32,
        ]
        .contains(&input.state)
        {
            return Err(invalid(
                "reply settlement must be delivered, failed, or uncertain",
            ));
        }
        if let Some(receipt) = &input.provider_receipt {
            text("provider receipt", receipt, 4096)?;
        }
        let (mut tx, _) = self.write().await?;
        let now = self.execution_now_ms();
        sweep_in(&mut tx, now).await?;
        let row = reply_in(&mut tx, account, &input.reply_id).await?;
        owned(&row, &input.lease_token)?;
        let state: i64 = row.try_get("state")?;
        if state == input.state as i64
            && row.try_get::<Option<String>, _>("provider_receipt")? == input.provider_receipt
        {
            let reply = reply_row(&row)?;
            tx.commit().await?;
            return Ok(reply);
        }
        let late_receipt =
            state == ReplyState::Uncertain as i64 && row.try_get::<i64, _>("expired_claim")? == 1;
        if state != ReplyState::Claimed as i64 && !late_receipt {
            // Preserve the original holder's contrary observation for review, without
            // changing the already settled outcome or blocking this connector forever.
            let prior: Option<i64> = sqlx::query_scalar("SELECT recorded_order FROM supertag_v2_reply_audit WHERE reply_id=$1 AND kind='conflicting-settlement' AND principal=$2 AND state=$3 AND COALESCE(provider_receipt,'')=COALESCE($4,'') LIMIT 1")
                .bind(&input.reply_id).bind(principal).bind(input.state as i64).bind(&input.provider_receipt).fetch_optional(&mut *tx).await?;
            if prior.is_none() {
                audit_in(&mut tx, &input.reply_id, ReplyDeliveryAudit {
                    kind: "conflicting-settlement".into(), principal: principal.into(),
                    evidence: "Original Gateway reported a different result after this reply was settled. The settled result is unchanged.".into(),
                    recorded_at_ms: now, state: input.state, provider_receipt: input.provider_receipt.clone(),
                }).await?;
            }
            tx.commit().await?;
            return Err(StoreError::Conflict(
                "reply already has a different settlement".into(),
            ));
        }
        sqlx::query("UPDATE supertag_v2_replies SET state=$1,provider_receipt=$2,expired_claim=0 WHERE reply_id=$3").bind(input.state as i64).bind(&input.provider_receipt).bind(&input.reply_id).execute(&mut *tx).await?;
        audit_in(
            &mut tx,
            &input.reply_id,
            ReplyDeliveryAudit {
                kind: "connector-settled".into(),
                principal: principal.into(),
                evidence: if late_receipt {
                    "Original claim reconciled after expiry"
                } else {
                    "Original claim settled"
                }
                .into(),
                recorded_at_ms: now,
                state: input.state,
                provider_receipt: input.provider_receipt.clone(),
            },
        )
        .await?;
        let reply = reply_row(&reply_in(&mut tx, account, &input.reply_id).await?)?;
        supertag_protocol::crash_point("control-plane.settle-reply", "before-commit");
        tx.commit().await?;
        Ok(reply)
    }

    pub async fn sweep_replies(&self) -> Result<()> {
        let (mut tx, _) = self.write().await?;
        sweep_in(&mut tx, self.execution_now_ms()).await?;
        tx.commit().await?;
        Ok(())
    }

    pub async fn get_reply_delivery(&self, principal: &str, id: &str) -> Result<ReplyDelivery> {
        operator(principal)?;
        name("reply ID", id)?;
        let (mut tx, _) = self.write().await?;
        sweep_in(&mut tx, self.execution_now_ms()).await?;
        let result = delivery_in(&mut tx, id).await?;
        tx.commit().await?;
        Ok(result)
    }

    pub async fn list_reply_deliveries(
        &self,
        principal: &str,
        input: &ListReplyDeliveriesRequest,
    ) -> Result<ListReplyDeliveriesResponse> {
        operator(principal)?;
        if !input.account_id.is_empty() {
            name("account ID", &input.account_id)?;
        }
        if input.before_order < 0 || input.limit > 100 || ReplyState::try_from(input.state).is_err()
        {
            return Err(invalid("invalid reply page or state"));
        }
        let (mut tx, _) = self.write().await?;
        sweep_in(&mut tx, self.execution_now_ms()).await?;
        let limit = if input.limit == 0 { 50 } else { input.limit };
        let rows = sqlx::query("SELECT reply_id,ready_order FROM supertag_v2_replies WHERE ($1='' OR account_id=$1) AND ($2=0 OR state=$2) AND ($3=0 OR ready_order<$3) ORDER BY ready_order DESC LIMIT $4").bind(&input.account_id).bind(input.state as i64).bind(input.before_order).bind(i64::from(limit)+1).fetch_all(&mut *tx).await?;
        let mut result = ListReplyDeliveriesResponse::default();
        let mut bytes = 0;
        let mut last = 0;
        for row in rows {
            let delivery = delivery_in(&mut tx, &row.try_get::<String, _>("reply_id")?).await?;
            if result.deliveries.len() == limit as usize
                || bytes + delivery.encoded_len() + 16 > PAGE_BYTES
            {
                result.next_before_order = last;
                break;
            }
            bytes += delivery.encoded_len() + 16;
            last = row.try_get("ready_order")?;
            result.deliveries.push(delivery);
        }
        tx.commit().await?;
        Ok(result)
    }

    pub async fn resolve_reply(
        &self,
        principal: &str,
        input: &ResolveReplyRequest,
    ) -> Result<ReplyDelivery> {
        operator(principal)?;
        name("operation ID", &input.operation_id)?;
        name("reply ID", &input.reply_id)?;
        text("resolution evidence", &input.evidence, 4096)?;
        if input.evidence.trim().is_empty()
            || input
                .provider_receipt
                .as_ref()
                .is_some_and(|value| value.trim().is_empty())
        {
            return Err(invalid(
                "resolution evidence and any provider receipt must be nonempty",
            ));
        }
        if ![ReplyState::Delivered as i32, ReplyState::Failed as i32].contains(&input.state)
            || (input.state == ReplyState::Delivered as i32) != input.provider_receipt.is_some()
        {
            return Err(invalid(
                "resolution must be delivered with a provider receipt or failed without one",
            ));
        }
        if let Some(receipt) = &input.provider_receipt {
            text("provider receipt", receipt, 4096)?;
        }
        let digest = Sha256::digest(input.encode_to_vec()).to_vec();
        let (mut tx, _) = self.write().await?;
        if let Some(row) = sqlx::query("SELECT request_digest,response FROM supertag_v2_reply_resolutions WHERE principal=$1 AND operation_id=$2").bind(principal).bind(&input.operation_id).fetch_optional(&mut *tx).await? {
            if row.try_get::<Vec<u8>,_>("request_digest")? != digest { return Err(StoreError::Conflict("reply resolution operation was reused".into())); }
            let result = ReplyDelivery::decode(row.try_get::<Vec<u8>,_>("response")?.as_slice()).map_err(|_| invalid("invalid reply resolution receipt"))?;
            tx.commit().await?;
            return Ok(result);
        }
        let now = self.execution_now_ms();
        sweep_in(&mut tx, now).await?;
        let prior = delivery_in(&mut tx, &input.reply_id).await?;
        if prior.reply.expect("projected reply").state() != ReplyState::Uncertain {
            return Err(StoreError::FailedPrecondition(
                "only an uncertain reply can be resolved".into(),
            ));
        }
        sqlx::query("UPDATE supertag_v2_replies SET state=$1,provider_receipt=$2,expired_claim=0 WHERE reply_id=$3").bind(input.state as i64).bind(&input.provider_receipt).bind(&input.reply_id).execute(&mut *tx).await?;
        audit_in(
            &mut tx,
            &input.reply_id,
            ReplyDeliveryAudit {
                kind: "operator-resolved".into(),
                principal: principal.into(),
                evidence: input.evidence.clone(),
                recorded_at_ms: now,
                state: input.state,
                provider_receipt: input.provider_receipt.clone(),
            },
        )
        .await?;
        let result = delivery_in(&mut tx, &input.reply_id).await?;
        sqlx::query("INSERT INTO supertag_v2_reply_resolutions(principal,operation_id,request_digest,response) VALUES($1,$2,$3,$4)").bind(principal).bind(&input.operation_id).bind(digest).bind(result.encode_to_vec()).execute(&mut *tx).await?;
        tx.commit().await?;
        Ok(result)
    }
}

fn owned(row: &AnyRow, token: &str) -> Result<()> {
    if row.try_get::<Option<String>, _>("lease_token")?.as_deref() != Some(token) {
        return Err(StoreError::PermissionDenied);
    }
    Ok(())
}

async fn sweep_in(tx: &mut Transaction<'_, Any>, now: i64) -> Result<()> {
    let ids: Vec<String> = sqlx::query_scalar("SELECT reply_id FROM supertag_v2_replies WHERE state=$1 AND (lease_expires_at_ms IS NULL OR lease_expires_at_ms<=$2) ORDER BY ready_order LIMIT 128").bind(ReplyState::Claimed as i64).bind(now).fetch_all(&mut **tx).await?;
    for id in ids {
        sqlx::query("UPDATE supertag_v2_replies SET state=$1,expired_claim=1 WHERE reply_id=$2")
            .bind(ReplyState::Uncertain as i64)
            .bind(&id)
            .execute(&mut **tx)
            .await?;
        audit_in(tx, &id, ReplyDeliveryAudit { kind: "claim-expired".into(), principal: "system".into(), evidence: "Gateway claim expired without a durable delivery result. No automatic resend is permitted.".into(), recorded_at_ms: now, state: ReplyState::Uncertain.into(), provider_receipt: None }).await?;
    }
    Ok(())
}

async fn audit_in(
    tx: &mut Transaction<'_, Any>,
    id: &str,
    audit: ReplyDeliveryAudit,
) -> Result<()> {
    let order = next_order(tx).await?;
    sqlx::query("INSERT INTO supertag_v2_reply_audit(recorded_order,reply_id,kind,principal,evidence,recorded_at_ms,state,provider_receipt) VALUES($1,$2,$3,$4,$5,$6,$7,$8)").bind(order).bind(id).bind(audit.kind).bind(audit.principal).bind(audit.evidence).bind(audit.recorded_at_ms).bind(audit.state as i64).bind(audit.provider_receipt).execute(&mut **tx).await?;
    Ok(())
}

async fn delivery_in(tx: &mut Transaction<'_, Any>, id: &str) -> Result<ReplyDelivery> {
    let row = sqlx::query("SELECT * FROM supertag_v2_replies WHERE reply_id=$1")
        .bind(id)
        .fetch_optional(&mut **tx)
        .await?
        .ok_or_else(|| StoreError::NotFound("reply was not found".into()))?;
    let rows = sqlx::query(
        "SELECT * FROM supertag_v2_reply_audit WHERE reply_id=$1 ORDER BY recorded_order LIMIT 100",
    )
    .bind(id)
    .fetch_all(&mut **tx)
    .await?;
    let mut audit = vec![];
    for row in rows {
        audit.push(ReplyDeliveryAudit {
            kind: row.try_get("kind")?,
            principal: row.try_get("principal")?,
            evidence: row.try_get("evidence")?,
            recorded_at_ms: row.try_get("recorded_at_ms")?,
            state: row.try_get::<i64, _>("state")? as i32,
            provider_receipt: row.try_get("provider_receipt")?,
        });
    }
    let result = ReplyDelivery {
        reply: Some(reply_row(&row)?),
        lease_expires_at_ms: row.try_get("lease_expires_at_ms")?,
        audit,
    };
    if result.encoded_len() > PAGE_BYTES {
        return Err(invalid("reply delivery exceeds transport limit"));
    }
    Ok(result)
}
