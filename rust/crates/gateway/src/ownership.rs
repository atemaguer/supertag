//! Connector ownership and graceful drain shared by every surface connector.
//!
//! Any Gateway may accept verified provider events: ingress is deduplicated by the
//! Control Plane. Outbound delivery has one fenced owner per connector account.
//! Draining stops new ingress, never interrupts a provider send in progress,
//! settles what it already sent, and then releases ownership so another Gateway
//! takes over at once instead of waiting for the lease to expire.
use crate::delivery_journal::{Entry, Journal};
use anyhow::Result;
use axum::{
    Json,
    extract::{Request as HttpRequest, State},
    http::StatusCode,
    middleware::Next,
    response::{IntoResponse, Response},
};
use serde_json::json;
use std::{future::Future, time::Duration};
use supertag_protocol::negotiation::ProtocolChannel;
use supertag_protocol::{
    authenticated_request,
    v2::{
        ClaimConnectorRequest, ConnectorLease, ReleaseConnectorRequest, RenewConnectorRequest,
        connector_client::ConnectorClient,
    },
};
use tokio::time::{self, Instant};
use tokio_util::sync::CancellationToken;

const POLL_INTERVAL: Duration = Duration::from_secs(1);
const CALL_TIMEOUT: Duration = Duration::from_secs(5);
/// Bound on finishing in-flight delivery after a drain begins. The Gateway
/// process allows 15 seconds for every service to stop.
const DRAIN_TIMEOUT: Duration = Duration::from_secs(10);

/// Refuse provider requests that arrive after a drain began. Providers retry
/// a 503, and a retry reaches another Gateway.
pub(crate) async fn refuse_while_draining(
    State(draining): State<CancellationToken>,
    request: HttpRequest,
    next: Next,
) -> Response {
    if draining.is_cancelled() {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({ "error": "gateway_draining" })),
        )
            .into_response();
    }
    next.run(request).await
}

pub(crate) struct Owner<'a> {
    pub(crate) control_plane: &'a ConnectorClient<ProtocolChannel>,
    pub(crate) gateway_token: &'a str,
    pub(crate) principal: &'a str,
    pub(crate) journal: &'a Journal,
}

struct Held {
    token: String,
    valid_until: Instant,
    renew_at: Instant,
}

enum Claimed {
    Held(Held),
    Busy(Duration),
}

impl Owner<'_> {
    fn request<T>(&self, input: T) -> Result<tonic::Request<T>> {
        let mut request = authenticated_request(input, self.gateway_token, Some(self.principal))?;
        request.set_timeout(CALL_TIMEOUT);
        Ok(request)
    }

    fn held(lease: ConnectorLease, requested_at: Instant) -> Option<Held> {
        let valid = Duration::from_millis(lease.valid_for_ms);
        (lease.granted && !lease.lease_token.is_empty() && valid >= Duration::from_secs(3)).then(
            || Held {
                token: lease.lease_token,
                valid_until: requested_at + valid,
                renew_at: requested_at + valid / 3,
            },
        )
    }

    async fn claim(&self, owner_id: &str) -> Result<Option<Claimed>> {
        let requested_at = Instant::now();
        let request = self.request(ClaimConnectorRequest {
            owner_id: owner_id.into(),
        })?;
        let Some(lease) = transient(self.control_plane.clone().claim_connector(request)).await?
        else {
            return Ok(None);
        };
        let lease = lease.into_inner();
        if !lease.granted {
            let wait = Duration::from_millis(lease.retry_after_ms.clamp(100, 15_000));
            return Ok(Some(Claimed::Busy(wait.min(POLL_INTERVAL))));
        }
        Ok(Self::held(lease, requested_at).map(Claimed::Held))
    }

    /// Returns false when the Control Plane says this Gateway no longer owns the account.
    async fn renew(&self, held: &mut Held) -> Result<bool> {
        let requested_at = Instant::now();
        let request = self.request(RenewConnectorRequest {
            lease_token: held.token.clone(),
        })?;
        match time::timeout(
            CALL_TIMEOUT,
            self.control_plane.clone().renew_connector(request),
        )
        .await
        {
            Ok(Ok(lease)) => match Self::held(lease.into_inner(), requested_at) {
                Some(renewed) => {
                    *held = renewed;
                    Ok(true)
                }
                None => Ok(false),
            },
            Ok(Err(error)) if error.code() == tonic::Code::FailedPrecondition => Ok(false),
            Ok(Err(error)) if retryable(error.code()) => Ok(true),
            Err(_) => Ok(true),
            Ok(Err(error)) => anyhow::bail!(
                "renew connector ownership rejected by Control Plane ({})",
                error.code()
            ),
        }
    }

    async fn release(&self, held: Held) {
        let Ok(request) = self.request(ReleaseConnectorRequest {
            lease_token: held.token,
        }) else {
            return;
        };
        // An unreleased lease only delays takeover until it expires.
        let _ = time::timeout(
            CALL_TIMEOUT,
            self.control_plane.clone().release_connector(request),
        )
        .await;
    }

    /// Whether the journal still records a reply this Gateway claimed or sent.
    fn in_flight(&self) -> Result<bool> {
        Ok(in_flight(self.journal.load()?.as_ref()))
    }

    /// Whether drain must still advance the journal before releasing ownership.
    fn draining(&self, owner: bool) -> Result<bool> {
        Ok(drain_pending(self.journal.load()?.as_ref(), owner))
    }

    /// Deliver replies while this Gateway owns the account, then drain.
    /// `advance` performs one journaled delivery step with the current lease token.
    pub(crate) async fn drive<F, Fut>(
        &self,
        shutdown: &CancellationToken,
        mut advance: F,
    ) -> Result<()>
    where
        F: FnMut(String) -> Fut,
        Fut: Future<Output = Result<bool>>,
    {
        let owner_id = self.journal.owner_id().to_owned();
        let mut held: Option<Held> = None;
        while !shutdown.is_cancelled() {
            if let Some(current) = held.as_mut() {
                let now = Instant::now();
                if now >= current.valid_until
                    || (now >= current.renew_at && !self.renew(current).await?)
                {
                    held = None;
                }
            }
            // A reply this Gateway already sent settles under its own reply lease.
            if held.is_none() && !self.in_flight()? {
                match self.claim(&owner_id).await? {
                    Some(Claimed::Held(lease)) => held = Some(lease),
                    Some(Claimed::Busy(wait)) => {
                        pause(shutdown, wait).await;
                        continue;
                    }
                    None => {
                        pause(shutdown, POLL_INTERVAL).await;
                        continue;
                    }
                }
            }
            let token = held
                .as_ref()
                .map(|lease| lease.token.clone())
                .unwrap_or_default();
            // A step runs to completion: cancelling it could drop a sent reply's receipt.
            if !advance(token).await? {
                pause(shutdown, POLL_INTERVAL).await;
            }
        }
        // Drain: start no new delivery, but settle any reply already claimed or sent.
        let deadline = Instant::now() + DRAIN_TIMEOUT;
        while self.draining(held.is_some())? && Instant::now() < deadline {
            let token = held
                .as_ref()
                .map(|lease| lease.token.clone())
                .unwrap_or_default();
            match time::timeout_at(deadline, advance(token)).await {
                Ok(Ok(true)) => {}
                Ok(Ok(false)) => time::sleep(Duration::from_millis(200)).await,
                Ok(Err(error)) => return Err(error),
                Err(_) => break,
            }
        }
        if let Some(lease) = held {
            self.release(lease).await;
        }
        Ok(())
    }
}

fn in_flight(entry: Option<&Entry>) -> bool {
    matches!(entry, Some(Entry::Sending { .. } | Entry::Settle { .. }))
}

/// A reply claim whose answer this Gateway never saw may already hold a reply
/// at the Control Plane. While it still owns the account, drain replays that
/// idempotent claim and delivers what it returns instead of leaving the reply
/// to expire as uncertain. Without ownership the claim cannot be replayed.
fn drain_pending(entry: Option<&Entry>, owner: bool) -> bool {
    in_flight(entry) || (owner && matches!(entry, Some(Entry::Claim { .. })))
}

async fn pause(shutdown: &CancellationToken, wait: Duration) {
    tokio::select! {
        _ = shutdown.cancelled() => {}
        _ = time::sleep(wait) => {}
    }
}

fn retryable(code: tonic::Code) -> bool {
    matches!(
        code,
        tonic::Code::Unavailable | tonic::Code::DeadlineExceeded | tonic::Code::Cancelled
    )
}

async fn transient<T>(call: impl Future<Output = Result<T, tonic::Status>>) -> Result<Option<T>> {
    match time::timeout(CALL_TIMEOUT, call).await {
        Ok(Ok(value)) => Ok(Some(value)),
        Ok(Err(error)) if retryable(error.code()) => Ok(None),
        Ok(Err(error)) => anyhow::bail!(
            "claim connector ownership rejected by Control Plane ({})",
            error.code()
        ),
        Err(_) => Ok(None),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn drain_finishes_an_unanswered_claim_only_while_owning_the_account() {
        let claim = Entry::Claim {
            operation_id: "op".into(),
        };
        assert!(drain_pending(Some(&claim), true));
        assert!(!drain_pending(Some(&claim), false));
        assert!(!drain_pending(None, true));
        // Outside drain an unanswered claim does not stop claiming ownership.
        assert!(!in_flight(Some(&claim)));
    }
}
