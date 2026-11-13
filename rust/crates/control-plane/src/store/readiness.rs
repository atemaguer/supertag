//! Fenced, expiring observations. A presence report is never an execution lease.

use prost::Message;
use sha2::{Digest, Sha256};
use sqlx::{Any, Row, Transaction};
use supertag_protocol::{v2::*, valid_workspace_id};

use super::{HostAuthority, Result, Store, StoreError, execution, hosts, invalid, name};

const PRESENCE_MS: i64 = 30_000;

impl Store {
    pub async fn report_host(
        &self,
        host: &HostAuthority,
        input: &ReportHostRequest,
    ) -> Result<WorkerHostStatus> {
        let sequence = i64::try_from(input.sequence)
            .ok()
            .filter(|n| *n > 0)
            .ok_or_else(|| invalid("host report sequence must be positive"))?;
        let readiness = HostReadiness::try_from(input.readiness)
            .map_err(|_| invalid("unknown host readiness"))?;
        let reason = HostReadinessReason::try_from(input.reason)
            .map_err(|_| invalid("unknown readiness reason"))?;
        HarnessKind::try_from(input.harness_kind).map_err(|_| invalid("unknown host harness"))?;
        if input.capacity > 1024 || input.available_slots > input.capacity {
            return Err(invalid(
                "host capacity must be at most 1024 and available slots cannot exceed it",
            ));
        }
        let valid = match readiness {
            HostReadiness::Pending => {
                input.available_slots == 0 && reason == HostReadinessReason::Starting
            }
            HostReadiness::Ready => {
                input.capacity > 0 && reason == HostReadinessReason::Unspecified
            }
            HostReadiness::Suppressed => {
                input.available_slots == 0
                    && matches!(
                        reason,
                        HostReadinessReason::RecoveryRequired | HostReadinessReason::Stopping
                    )
            }
            HostReadiness::Unspecified => false,
        };
        if !valid {
            return Err(invalid(
                "host readiness, reason and available slots are inconsistent",
            ));
        }
        if input.workspace_ids.len() > 256
            || input.workspace_ids.iter().any(|id| !valid_workspace_id(id))
        {
            return Err(invalid("host must report at most 256 valid Workspace IDs"));
        }
        let mut workspaces = input.workspace_ids.clone();
        workspaces.sort_unstable();
        workspaces.dedup();
        let workspaces = serde_json::to_string(&workspaces)?;
        let labels = serde_json::to_string(&crate::placement::parse_labels(
            &input.labels,
            crate::placement::LabelField::Reported,
        )?)?;
        let execution_profile = input
            .execution_profile
            .as_ref()
            .map(|profile| execution::normalize_profile(Some(profile)))
            .transpose()?
            .map(|profile| profile.encode_to_vec());
        let observed = (
            input.capacity,
            input.available_slots,
            input.readiness,
            input.reason,
            input.harness_kind,
            &workspaces,
        );
        let digest_input = match &execution_profile {
            Some(profile) => serde_json::to_vec(&(observed, profile, &labels))?,
            None => serde_json::to_vec(&(observed, &labels))?,
        };
        let digest = format!("{:x}", Sha256::digest(digest_input));
        let (mut transaction, _) = self.write().await?;
        hosts::current_scope_in(&mut transaction, host).await?;
        let prior = sqlx::query("SELECT generation,sequence,request_digest FROM supertag_v2_host_readiness WHERE host_id=$1")
            .bind(host.id()).fetch_optional(&mut *transaction).await?;
        if let Some(prior) =
            prior.filter(|row| row.try_get::<i64, _>("generation").ok() == Some(host.generation))
        {
            let previous: i64 = prior.try_get("sequence")?;
            if sequence < previous {
                return Err(StoreError::FailedPrecondition(
                    "host report was superseded".into(),
                ));
            }
            if sequence == previous {
                if prior.try_get::<String, _>("request_digest")? != digest {
                    return Err(StoreError::Conflict(
                        "host report sequence used different content".into(),
                    ));
                }
                // Replayed old traffic cannot make an offline host appear current.
                let view = status_in(&mut transaction, host.id(), self.execution_now_ms()).await?;
                transaction.commit().await?;
                return Ok(view);
            }
        }
        let now = self.execution_now_ms();
        let expires = now
            .checked_add(PRESENCE_MS)
            .ok_or_else(|| invalid("presence expiry is out of range"))?;
        sqlx::query("INSERT INTO supertag_v2_host_readiness (host_id,generation,sequence,request_digest,capacity,available_slots,readiness,reason,harness_kind,workspace_ids,last_seen_at_ms,presence_expires_at_ms,execution_profile,labels) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) ON CONFLICT(host_id) DO UPDATE SET labels=excluded.labels, generation=excluded.generation,sequence=excluded.sequence,request_digest=excluded.request_digest,capacity=excluded.capacity,available_slots=excluded.available_slots,readiness=excluded.readiness,reason=excluded.reason,harness_kind=excluded.harness_kind,workspace_ids=excluded.workspace_ids,last_seen_at_ms=excluded.last_seen_at_ms,presence_expires_at_ms=excluded.presence_expires_at_ms,execution_profile=excluded.execution_profile")
            .bind(host.id()).bind(host.generation).bind(sequence).bind(digest)
            .bind(i64::from(input.capacity)).bind(i64::from(input.available_slots)).bind(i64::from(input.readiness))
            .bind(i64::from(input.reason)).bind(i64::from(input.harness_kind)).bind(workspaces).bind(now).bind(expires)
            .bind(execution_profile).bind(labels)
            .execute(&mut *transaction).await?;
        let view = status_in(&mut transaction, host.id(), now).await?;
        transaction.commit().await?;
        Ok(view)
    }

    pub async fn get_host(&self, id: &str) -> Result<WorkerHostStatus> {
        name("Worker Host ID", id)?;
        let mut transaction = self.pool.begin().await?;
        let view = status_in(&mut transaction, id, self.execution_now_ms()).await?;
        transaction.commit().await?;
        Ok(view)
    }

    pub async fn list_hosts(&self, input: &ListHostsRequest) -> Result<ListHostsResponse> {
        if input.limit > 500 {
            return Err(invalid("host page limit must be at most 500"));
        }
        if !input.cursor.is_empty() {
            name("host cursor", &input.cursor)?;
        }
        let limit = if input.limit == 0 { 100 } else { input.limit } as usize;
        let mut transaction = self.pool.begin().await?;
        let mut ids: Vec<String> = sqlx::query_scalar(
            "SELECT host_id FROM supertag_v2_hosts WHERE host_id>$1 AND removed_at_ms IS NULL ORDER BY host_id LIMIT $2",
        )
        .bind(&input.cursor)
        .bind((limit + 1) as i64)
        .fetch_all(&mut *transaction)
        .await?;
        let next_cursor = if ids.len() > limit {
            ids.truncate(limit);
            ids.last().cloned().unwrap_or_default()
        } else {
            String::new()
        };
        let now = self.execution_now_ms();
        let mut hosts = Vec::with_capacity(ids.len());
        for id in ids {
            hosts.push(status_in(&mut transaction, &id, now).await?);
        }
        transaction.commit().await?;
        Ok(ListHostsResponse { hosts, next_cursor })
    }

    pub async fn set_host_draining(&self, id: &str, draining: bool) -> Result<WorkerHostStatus> {
        name("Worker Host ID", id)?;
        let (mut transaction, _) = self.write().await?;
        let current = status_in(&mut transaction, id, self.execution_now_ms()).await?;
        if current.revoked_at_ms.is_some() {
            return Err(StoreError::FailedPrecondition(
                "Worker Host is revoked".into(),
            ));
        }
        sqlx::query("UPDATE supertag_v2_hosts SET draining=$1 WHERE host_id=$2")
            .bind(i64::from(draining))
            .bind(id)
            .execute(&mut *transaction)
            .await?;
        let view = status_in(&mut transaction, id, self.execution_now_ms()).await?;
        transaction.commit().await?;
        Ok(view)
    }
}

pub(super) async fn accepting_in(transaction: &mut Transaction<'_, Any>, id: &str) -> Result<bool> {
    let draining: i64 =
        sqlx::query_scalar("SELECT draining FROM supertag_v2_hosts WHERE host_id=$1")
            .bind(id)
            .fetch_one(&mut **transaction)
            .await?;
    Ok(draining == 0)
}

pub(crate) async fn status_in(
    transaction: &mut Transaction<'_, Any>,
    id: &str,
    now: i64,
) -> Result<WorkerHostStatus> {
    let host = sqlx::query("SELECT generation,draining,enrolled_at_ms,revoked_at_ms,ephemeral,granted_labels,removed_at_ms FROM supertag_v2_hosts WHERE host_id=$1")
        .bind(id).fetch_optional(&mut **transaction).await?.ok_or_else(|| StoreError::NotFound("Worker Host was not found".into()))?;
    let generation: i64 = host.try_get("generation")?;
    let draining = host.try_get::<i64, _>("draining")? != 0;
    let revoked_at_ms: Option<i64> = host.try_get("revoked_at_ms")?;
    let row =
        sqlx::query("SELECT * FROM supertag_v2_host_readiness WHERE host_id=$1 AND generation=$2")
            .bind(id)
            .bind(generation)
            .fetch_optional(&mut **transaction)
            .await?;
    // Reservations and unconfirmed cleanup consume capacity, including a replaced
    // generation. Once cleanup is proven the Session can still require recovery,
    // but that stopped process no longer occupies a native execution slot.
    let occupied: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM supertag_v2_tasks WHERE host_principal=$1 AND (state IN (2,6) OR ((state=7 OR cleanup_pending=1) AND cleanup_observed=0))")
        .bind(format!("host:{id}")).fetch_one(&mut **transaction).await?;
    let mut view = WorkerHostStatus {
        host_id: id.into(),
        generation: generation as u64,
        draining,
        active_attempts: u32::try_from(occupied).unwrap_or(u32::MAX),
        enrolled_at_ms: host.try_get("enrolled_at_ms")?,
        revoked_at_ms,
        ephemeral: host.try_get::<i64, _>("ephemeral")? != 0,
        granted_labels: serde_json::from_str(&host.try_get::<String, _>("granted_labels")?)?,
        removed_at_ms: host.try_get("removed_at_ms")?,
        ..Default::default()
    };
    let mut labels: std::collections::BTreeSet<String> =
        view.granted_labels.iter().cloned().collect();
    let mut phase = HostPhase::Pending;
    if let Some(row) = row {
        view.capacity = row.try_get::<i64, _>("capacity")? as u32;
        view.available_slots = (row.try_get::<i64, _>("available_slots")? as u32)
            .min(view.capacity.saturating_sub(view.active_attempts));
        view.harness_kind = row.try_get::<i64, _>("harness_kind")? as i32;
        view.reason = row.try_get::<i64, _>("reason")? as i32;
        view.workspace_ids = serde_json::from_str(&row.try_get::<String, _>("workspace_ids")?)?;
        view.execution_profile = execution::read_profile(row.try_get("execution_profile")?)?;
        labels.extend(crate::placement::derived_labels(
            view.harness_kind(),
            &view.workspace_ids,
            view.execution_profile.as_ref(),
        ));
        labels.extend(serde_json::from_str::<Vec<String>>(
            &row.try_get::<String, _>("labels")?,
        )?);
        view.last_seen_at_ms = Some(row.try_get("last_seen_at_ms")?);
        let expires: i64 = row.try_get("presence_expires_at_ms")?;
        view.presence_expires_at_ms = Some(expires);
        phase = if now >= expires {
            HostPhase::Offline
        } else if draining {
            HostPhase::Draining
        } else {
            match HostReadiness::try_from(row.try_get::<i64, _>("readiness")? as i32)
                .unwrap_or_default()
            {
                HostReadiness::Ready if view.available_slots > 0 => HostPhase::Ready,
                HostReadiness::Ready => HostPhase::Busy,
                HostReadiness::Suppressed => HostPhase::Suppressed,
                _ => HostPhase::Pending,
            }
        };
    }
    if revoked_at_ms.is_some() {
        phase = HostPhase::Revoked;
    }
    if phase != HostPhase::Ready {
        view.available_slots = 0;
    }
    view.phase = phase as i32;
    view.labels = labels.into_iter().collect();
    Ok(view)
}
