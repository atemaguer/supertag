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

use crate::{
    HostAuthority, Store,
    store::{ClaimScope, Result, Sticky},
};

/// The longest a claim is held, inside the API tier's 10-second call budget.
const MAX_HOLD: Duration = Duration::from_secs(8);
/// How many claims of one host, across its lanes, may be held at once; more are answered at once.
const MAX_HELD_PER_HOST: usize = 16;
/// How often a held claim checks the watch feed without a signal.
const CHECK: Duration = Duration::from_millis(250);
/// The longest a held claim goes without claiming again, for the sweeps a claim runs.
const RECLAIM: Duration = Duration::from_secs(1);

/// How long a Session stays warm on the host its last Task finished on.
const WARM_MS: i64 = 5 * 60 * 1000;

/// The claims held now: how many per host principal, and what each can run.
#[derive(Default)]
pub(crate) struct HeldClaims {
    held: Mutex<HashMap<String, usize>>,
    scopes: Mutex<HashMap<u64, (String, ClaimScope)>>,
    next: Mutex<u64>,
    /// Each warm Session's host and until when, by Tag and Session.
    warm: Mutex<HashMap<(String, String), (String, i64)>>,
}

struct Held<'a> {
    claims: &'a HeldClaims,
    principal: String,
    id: u64,
}

impl Held<'_> {
    /// Records what this held claim can run, so other hosts leave its warm Sessions to it.
    fn can_run(&self, scope: Option<ClaimScope>) {
        if let Some(scope) = scope {
            self.claims
                .scopes
                .lock()
                .unwrap()
                .insert(self.id, (self.principal.clone(), scope));
        }
    }
}

impl Drop for Held<'_> {
    fn drop(&mut self) {
        self.claims.scopes.lock().unwrap().remove(&self.id);
        let mut held = self.claims.held.lock().unwrap();
        if let Some(count) = held.get_mut(&self.principal) {
            *count -= 1;
            if *count == 0 {
                held.remove(&self.principal);
            }
        }
    }
}

impl HeldClaims {
    /// The Session's last Task finished on this host: its next Task is offered here first.
    pub(crate) fn warm(&self, tag_id: &str, session_id: &str, principal: &str, now: i64) {
        let mut warm = self.warm.lock().unwrap();
        warm.retain(|_, (_, until)| *until > now);
        warm.insert(
            (tag_id.to_owned(), session_id.to_owned()),
            (principal.to_owned(), now + WARM_MS),
        );
    }

    /// The warm Sessions of other hosts that wait to claim now, with what their waiting claims
    /// can run.
    pub(crate) fn sticky(&self, principal: &str, now: i64) -> Vec<Sticky> {
        let scopes = self.scopes.lock().unwrap();
        self.warm
            .lock()
            .unwrap()
            .iter()
            .filter(|(_, (host, until))| host != principal && *until > now)
            .filter_map(|((tag_id, session_id), (host, _))| {
                let waiting: Vec<ClaimScope> = scopes
                    .values()
                    .filter(|(held_by, _)| held_by == host)
                    .map(|(_, scope)| scope.clone())
                    .collect();
                (!waiting.is_empty()).then(|| Sticky {
                    tag_id: tag_id.clone(),
                    session_id: session_id.clone(),
                    scopes: waiting,
                })
            })
            .collect()
    }

    fn hold(&self, principal: &str) -> Option<Held<'_>> {
        let mut held = self.held.lock().unwrap();
        let count = held.entry(principal.to_owned()).or_default();
        if *count >= MAX_HELD_PER_HOST {
            return None;
        }
        *count += 1;
        let mut next = self.next.lock().unwrap();
        *next += 1;
        Some(Held {
            claims: self,
            principal: principal.to_owned(),
            id: *next,
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
        let claim = async |scope: &mut Option<ClaimScope>| {
            self.claim_scoped(
                host,
                &input.operation_id,
                (&input.workspace_ids, &input.gateway_workspace_ids),
                (
                    harness,
                    &input.context_contracts,
                    input.execution_profile.as_ref(),
                ),
                scope,
            )
            .await
        };
        let mut changes = self.live.changes.subscribe();
        let mut head = self.feed_head().await?;
        let assignment = claim(&mut None).await?;
        let wait = wait.min(MAX_HOLD);
        if assignment.is_some() || wait.is_zero() {
            return Ok(assignment);
        }
        let Some(held) = self.live.claims.hold(&host.principal) else {
            return Ok(None);
        };
        // Claimed again now that it is held, so what it can run is recorded.
        let mut scope = None;
        if let Some(assignment) = claim(&mut scope).await? {
            return Ok(Some(assignment));
        }
        held.can_run(scope);
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
            let mut scope = None;
            if let Some(assignment) = claim(&mut scope).await? {
                return Ok(Some(assignment));
            }
            held.can_run(scope);
        }
    }
}
