//! Holds a Worker Host's claim that finds no Task until one can be claimed.
//!
//! An idle host used to claim four times a second, each claim a write transaction. Now a claim
//! that finds nothing waits: it tries again when a committed write that can queue a Task wakes
//! it, or when the operator watch feed moves, and at least once a second for the maintenance a
//! claim also does. It answers as soon as it claims a Task, when its wait ends, or when the
//! Control Plane drains.
use std::{collections::HashMap, sync::Mutex, time::Duration};

use supertag_protocol::v2::*;
use tokio::time::Instant;

use crate::{HostAuthority, Store, store::Result};

/// The longest a claim is held, inside the API tier's 10-second call budget.
const MAX_HOLD: Duration = Duration::from_secs(8);
/// How many claims of one host may be held at once; more are answered at once.
const MAX_HELD_PER_HOST: usize = 4;
/// How often a held claim checks the watch feed without a signal.
const CHECK: Duration = Duration::from_millis(250);
/// The longest a held claim goes without claiming again, for the sweeps a claim runs.
const RECLAIM: Duration = Duration::from_secs(1);

/// The claims held now, by host principal.
#[derive(Default)]
pub(crate) struct HeldClaims(Mutex<HashMap<String, usize>>);

struct Held<'a> {
    claims: &'a HeldClaims,
    principal: String,
}

impl Drop for Held<'_> {
    fn drop(&mut self) {
        let mut held = self.claims.0.lock().unwrap();
        if let Some(count) = held.get_mut(&self.principal) {
            *count -= 1;
            if *count == 0 {
                held.remove(&self.principal);
            }
        }
    }
}

impl HeldClaims {
    fn hold(&self, principal: &str) -> Option<Held<'_>> {
        let mut held = self.0.lock().unwrap();
        let count = held.entry(principal.to_owned()).or_default();
        if *count >= MAX_HELD_PER_HOST {
            return None;
        }
        *count += 1;
        Some(Held {
            claims: self,
            principal: principal.to_owned(),
        })
    }
}

impl Store {
    /// The operator watch feed's head; it moves with every Task created or changed.
    async fn feed_head(&self) -> Result<i64> {
        Ok(
            sqlx::query_scalar("SELECT head FROM supertag_v2_watch_state WHERE singleton = 1")
                .fetch_one(&self.pool)
                .await?,
        )
    }

    /// Claims a Task as `claim_task_with_sources` does, holding a claim that finds none for up
    /// to `wait`.
    pub async fn claim_task_waiting(
        &self,
        host: &HostAuthority,
        input: &ClaimTaskRequest,
        wait: Duration,
    ) -> Result<Option<Assignment>> {
        let harness = HarnessKind::try_from(input.harness_kind)
            .map_err(|_| crate::store::invalid("unknown harness kind"))?;
        let claim = async || {
            self.claim_task_with_sources(
                host,
                &input.operation_id,
                (&input.workspace_ids, &input.gateway_workspace_ids),
                harness,
                &input.context_contracts,
                input.execution_profile.as_ref(),
            )
            .await
        };
        let mut changes = self.live.changes.subscribe();
        let mut head = self.feed_head().await?;
        let assignment = claim().await?;
        let wait = wait.min(MAX_HOLD);
        if assignment.is_some() || wait.is_zero() {
            return Ok(assignment);
        }
        let Some(_held) = self.live.claims.hold(&host.principal) else {
            return Ok(None);
        };
        let until = Instant::now() + wait;
        let mut claimed_at = Instant::now();
        loop {
            let next = (Instant::now() + CHECK).min(until);
            tokio::select! {
                biased;
                _ = self.live.closing.cancelled() => return Ok(None),
                _ = changes.changed() => {}
                _ = tokio::time::sleep_until(next) => {}
            }
            if Instant::now() >= until {
                return Ok(None);
            }
            let current = self.feed_head().await?;
            if current == head && claimed_at.elapsed() < RECLAIM {
                continue;
            }
            head = current;
            claimed_at = Instant::now();
            if let Some(assignment) = claim().await? {
                return Ok(Some(assignment));
            }
        }
    }
}
