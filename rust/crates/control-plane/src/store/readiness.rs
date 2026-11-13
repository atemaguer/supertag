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
        let disk = input
            .disk_space
            .as_ref()
            .map(|disk| {
                let free = i64::try_from(disk.free_bytes).ok();
                let total = i64::try_from(disk.total_bytes).ok();
                match (free, total) {
                    (Some(free), Some(total)) if total > 0 && free <= total => Ok((free, total)),
                    _ => Err(invalid(
                        "host disk space needs a positive total no smaller than free space",
                    )),
                }
            })
            .transpose()?;
        let mut workspaces = input.workspace_ids.clone();
        workspaces.sort_unstable();
        workspaces.dedup();
        let workspaces = serde_json::to_string(&workspaces)?;
        let labels = serde_json::to_string(&crate::placement::parse_labels(
            &input.labels,
            crate::placement::LabelField::Reported,
        )?)?;
        let normalized_profile = input
            .execution_profile
            .as_ref()
            .map(|profile| execution::normalize_profile(Some(profile)))
            .transpose()?;
        let execution_profile = normalized_profile
            .as_ref()
            .map(|profile| profile.encode_to_vec());
        let harnesses = harness_capacities(input)?;
        let observed = (
            input.capacity,
            input.available_slots,
            input.readiness,
            input.reason,
            input.harness_kind,
            &workspaces,
        );
        let digest_input = match (&execution_profile, disk, &harnesses) {
            (Some(profile), None, None) => serde_json::to_vec(&(observed, profile, &labels))?,
            (None, None, None) => serde_json::to_vec(&(observed, &labels))?,
            (profile, disk, harnesses) => {
                serde_json::to_vec(&(observed, profile, disk, harnesses, &labels))?
            }
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
        sqlx::query("INSERT INTO supertag_v2_host_readiness (host_id,generation,sequence,request_digest,capacity,available_slots,readiness,reason,harness_kind,workspace_ids,last_seen_at_ms,presence_expires_at_ms,execution_profile,disk_free_bytes,disk_total_bytes,labels,harnesses) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) ON CONFLICT(host_id) DO UPDATE SET generation=excluded.generation,sequence=excluded.sequence,request_digest=excluded.request_digest,capacity=excluded.capacity,available_slots=excluded.available_slots,readiness=excluded.readiness,reason=excluded.reason,harness_kind=excluded.harness_kind,workspace_ids=excluded.workspace_ids,last_seen_at_ms=excluded.last_seen_at_ms,presence_expires_at_ms=excluded.presence_expires_at_ms,execution_profile=excluded.execution_profile,disk_free_bytes=excluded.disk_free_bytes,disk_total_bytes=excluded.disk_total_bytes,labels=excluded.labels,harnesses=excluded.harnesses")
            .bind(host.id()).bind(host.generation).bind(sequence).bind(digest)
            .bind(i64::from(input.capacity)).bind(i64::from(input.available_slots)).bind(i64::from(input.readiness))
            .bind(i64::from(input.reason)).bind(i64::from(input.harness_kind)).bind(workspaces).bind(now).bind(expires)
            .bind(execution_profile).bind(disk.map(|disk| disk.0)).bind(disk.map(|disk| disk.1)).bind(labels).bind(harnesses)
            .execute(&mut *transaction).await?;
        // When each lapsed login was first reported, so the Inbox item keeps its place.
        let lapsed = normalized_profile
            .as_ref()
            .map(|profile| profile.mcp_login_servers.clone())
            .unwrap_or_default();
        let recorded: Vec<String> =
            sqlx::query_scalar("SELECT server FROM supertag_v2_mcp_login_lapses WHERE host_id=$1")
                .bind(host.id())
                .fetch_all(&mut *transaction)
                .await?;
        for server in recorded.iter().filter(|server| !lapsed.contains(server)) {
            sqlx::query("DELETE FROM supertag_v2_mcp_login_lapses WHERE host_id=$1 AND server=$2")
                .bind(host.id())
                .bind(server)
                .execute(&mut *transaction)
                .await?;
        }
        for server in lapsed.iter().filter(|server| !recorded.contains(server)) {
            sqlx::query("INSERT INTO supertag_v2_mcp_login_lapses(host_id,server,observed_at_ms) VALUES($1,$2,$3)")
                .bind(host.id())
                .bind(server)
                .bind(now)
                .execute(&mut *transaction)
                .await?;
        }
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
    let host = sqlx::query("SELECT generation,draining,enrolled_at_ms,revoked_at_ms,ephemeral,granted_labels,removed_at_ms,credential_revision FROM supertag_v2_hosts WHERE host_id=$1")
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
    let occupied_by_harness: Vec<(i64, i64)> = sqlx::query_as("SELECT harness_kind,COUNT(*) FROM supertag_v2_tasks WHERE host_principal=$1 AND (state IN (2,6) OR ((state=7 OR cleanup_pending=1) AND cleanup_observed=0)) GROUP BY harness_kind")
        .bind(format!("host:{id}")).fetch_all(&mut **transaction).await?;
    let occupied: i64 = occupied_by_harness.iter().map(|(_, count)| count).sum();
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
        credential_revision: host.try_get::<i64, _>("credential_revision")? as u64,
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
        view.disk_space = match (
            row.try_get::<Option<i64>, _>("disk_free_bytes")?,
            row.try_get::<Option<i64>, _>("disk_total_bytes")?,
        ) {
            (Some(free), Some(total)) => Some(HostDiskSpace {
                free_bytes: free as u64,
                total_bytes: total as u64,
            }),
            _ => None,
        };
        if let Some(bytes) = row.try_get::<Option<Vec<u8>>, _>("harnesses")? {
            view.harnesses = HostHarnessCapacities::decode(bytes.as_slice())
                .map_err(|_| invalid("stored Worker Host harness capacity is invalid"))?
                .harnesses;
            clamp_harness_slots(
                &mut view.harnesses,
                &occupied_by_harness,
                view.available_slots,
            );
        }
        labels.extend(crate::placement::derived_labels(
            view.harness_kind(),
            &view.workspace_ids,
            view.execution_profile.as_ref(),
        ));
        // A Host serving several harnesses carries each one's derived labels.
        for harness in &view.harnesses {
            labels.extend(crate::placement::derived_labels(
                harness.harness_kind(),
                &view.workspace_ids,
                harness.execution_profile.as_ref(),
            ));
        }
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
        for harness in &mut view.harnesses {
            harness.available_slots = 0;
        }
    }
    view.phase = phase as i32;
    view.labels = labels.into_iter().collect();
    Ok(view)
}

/// Per-harness slots never show more than the Host's occupancy leaves: each harness loses the
/// slots its own occupying Attempts hold, and the entries never sum past the Host's total.
fn clamp_harness_slots(harnesses: &mut [HostHarnessCapacity], occupied: &[(i64, i64)], total: u32) {
    let mut remaining = total;
    for harness in harnesses {
        let held = occupied
            .iter()
            .filter(|(kind, _)| *kind == i64::from(harness.harness_kind))
            .map(|(_, count)| u32::try_from(*count).unwrap_or(u32::MAX))
            .sum::<u32>();
        harness.available_slots = harness
            .available_slots
            .min(harness.capacity.saturating_sub(held))
            .min(remaining);
        remaining -= harness.available_slots;
    }
}

/// A Host that runs several harnesses or concurrent Attempts reports one slot entry per harness.
/// The totals above must equal their sum, and a single summary harness is never ambiguous.
fn harness_capacities(input: &ReportHostRequest) -> Result<Option<Vec<u8>>> {
    if input.harnesses.is_empty() {
        return Ok(None);
    }
    if input.harnesses.len() > 16 {
        return Err(invalid("host must report at most 16 harnesses"));
    }
    let mut harnesses = Vec::with_capacity(input.harnesses.len());
    let (mut capacity, mut available) = (0_u32, 0_u32);
    for harness in &input.harnesses {
        HarnessKind::try_from(harness.harness_kind).map_err(|_| invalid("unknown host harness"))?;
        if harness.capacity == 0 || harness.available_slots > harness.capacity {
            return Err(invalid(
                "each host harness needs capacity and cannot exceed it",
            ));
        }
        capacity = capacity.saturating_add(harness.capacity);
        available = available.saturating_add(harness.available_slots);
        harnesses.push(HostHarnessCapacity {
            harness_kind: harness.harness_kind,
            execution_profile: Some(execution::normalize_profile(
                harness.execution_profile.as_ref(),
            )?),
            capacity: harness.capacity,
            available_slots: harness.available_slots,
        });
    }
    harnesses.sort_by_key(|harness| harness.harness_kind);
    if harnesses
        .windows(2)
        .any(|pair| pair[0].harness_kind == pair[1].harness_kind)
    {
        return Err(invalid("host harnesses must be distinct"));
    }
    if capacity != input.capacity || available != input.available_slots {
        return Err(invalid(
            "host capacity and available slots must equal their harness totals",
        ));
    }
    let summary = match harnesses.as_slice() {
        [single] => {
            input.harness_kind == single.harness_kind
                && input
                    .execution_profile
                    .as_ref()
                    .map(|profile| execution::normalize_profile(Some(profile)))
                    .transpose()?
                    == single.execution_profile
        }
        _ => {
            input.harness_kind == HarnessKind::Unspecified as i32
                && input.execution_profile.is_none()
        }
    };
    if !summary {
        return Err(invalid(
            "a Host with several harnesses reports them only as harness entries",
        ));
    }
    Ok(Some(HostHarnessCapacities { harnesses }.encode_to_vec()))
}
