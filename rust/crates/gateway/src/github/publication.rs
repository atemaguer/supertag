//! Durable delivery of verified Workspace commits to one GitHub Session branch.
pub mod plan;
mod provider;

use super::workspaces::GithubWorkspaceAccount;
use anyhow::{Context, Result, ensure};
use provider::{Provider, receipt, target};
use std::{path::Path, time::Duration};
use supertag_protocol::negotiation::ProtocolChannel;
use supertag_protocol::{MAX_MESSAGE_BYTES, authenticated_request, v2::*};
use tokio::time::{self, Instant};
use tokio_util::sync::CancellationToken;
use tonic::{Code, Request, Status};
use uuid::Uuid;

pub struct GithubPublisher {
    provider: Provider,
    client: github_publisher_client::GithubPublisherClient<ProtocolChannel>,
    token: String,
    principal: String,
}
impl GithubPublisher {
    pub fn new(
        config: GithubWorkspaceAccount,
        directory: &Path,
        blobs: &Path,
        channel: ProtocolChannel,
        token: String,
    ) -> Result<Self> {
        let provider = Provider::new(config, directory, blobs)?;
        let principal = format!("publisher:github/{}", provider.account);
        authenticated_request((), &token, Some(&principal))?;
        Ok(Self {
            provider,
            client: github_publisher_client::GithubPublisherClient::new(channel)
                .max_decoding_message_size(MAX_MESSAGE_BYTES)
                .max_encoding_message_size(MAX_MESSAGE_BYTES),
            token,
            principal,
        })
    }
    #[cfg(any(test, feature = "test-fixtures"))]
    pub fn with_test_endpoints(mut self, api: reqwest::Url, git: reqwest::Url) -> Result<Self> {
        self.provider.endpoints(api, git)?;
        Ok(self)
    }
    fn request<T>(&self, value: T) -> Result<Request<T>, Status> {
        let mut request = authenticated_request(value, &self.token, Some(&self.principal))?;
        request.set_timeout(Duration::from_secs(5));
        Ok(request)
    }
    pub async fn run(&self, shutdown: CancellationToken) -> Result<()> {
        let mut interval = time::interval(Duration::from_secs(1));
        interval.set_missed_tick_behavior(time::MissedTickBehavior::Delay);
        loop {
            tokio::select! {_=shutdown.cancelled()=>return Ok(()),_=interval.tick()=>{}}
            let mut client = self.client.clone();
            let claim = tokio::select! {_=shutdown.cancelled()=>return Ok(()),result=client.claim(self.request(ClaimGithubPublicationRequest {operation_id:Uuid::new_v4().to_string()})?)=>match result {Ok(value)=>value.into_inner(),Err(_)=>continue}};
            if claim.publication.is_none() {
                continue;
            }
            let cancel = shutdown.child_token();
            // Errors contain no raw provider bodies or credentials. Durable CP
            // state retains uncertainty, and replacement only performs reads.
            let _ = self.deliver(claim, cancel).await;
        }
    }
    async fn renew(
        &self,
        lease: &GithubPublicationLease,
    ) -> Result<ClaimGithubPublicationResponse, Status> {
        time::timeout(
            Duration::from_secs(3),
            self.client.clone().renew(self.request(lease.clone())?),
        )
        .await
        .map_err(|_| Status::deadline_exceeded("publication renewal timed out"))?
        .map(tonic::Response::into_inner)
    }
    async fn maintain(&self, lease: &GithubPublicationLease, mut until: Instant) -> Result<()> {
        loop {
            time::sleep_until((Instant::now() + Duration::from_secs(3)).min(until)).await;
            ensure!(Instant::now() < until, "publication authority expired");
            let started = Instant::now();
            let result = time::timeout_at(until, self.renew(lease)).await;
            match result {
                Ok(Ok(response)) => {
                    ensure!(response.valid_for_ms > 0, "publication authority expired");
                    until = started + Duration::from_millis(response.valid_for_ms);
                }
                Ok(Err(status))
                    if matches!(
                        status.code(),
                        Code::Unavailable | Code::Cancelled | Code::DeadlineExceeded
                    ) => {}
                Ok(Err(_)) => anyhow::bail!("publication authority revoked"),
                Err(_) => anyhow::bail!("publication authority expired"),
            }
        }
    }
    async fn deliver(
        &self,
        claim: ClaimGithubPublicationResponse,
        cancel: CancellationToken,
    ) -> Result<()> {
        let lease = GithubPublicationLease {
            publication_id: claim
                .publication
                .as_ref()
                .context("claim is empty")?
                .publication_id
                .clone(),
            lease_token: claim.lease_token,
        };
        let started = Instant::now();
        let current = self.renew(&lease).await?;
        ensure!(current.valid_for_ms > 0, "publication authority expired");
        let until = started + Duration::from_millis(current.valid_for_ms);
        let operation = self.workflow(current, &lease, &cancel);
        tokio::pin!(operation);
        let failure = tokio::select! {
            result=&mut operation=>{cancel.cancel();return result;},
            result=self.maintain(&lease,until)=>result,
            _=cancel.cancelled()=>Err(anyhow::anyhow!("publication stopped")),
        };
        cancel.cancel();
        // Let the owned Git subprocess observe cancellation and reap its group.
        // Expired authority still prevents any subsequent CP write reservation.
        let _ = time::timeout(Duration::from_secs(5), operation).await;
        failure
    }

    async fn record(
        &self,
        lease: &GithubPublicationLease,
        phase: GithubPublicationPhase,
        state: GithubPublicationState,
        pull_request: Option<GithubPullRequestReceipt>,
        pushed_commit: Option<String>,
        reason: &str,
    ) -> Result<GithubPublication> {
        Ok(self
            .client
            .clone()
            .record_effect(self.request(RecordGithubPublicationEffectRequest {
                lease: Some(lease.clone()),
                operation_id: Uuid::new_v4().to_string(),
                phase: phase as i32,
                state: state as i32,
                pull_request,
                pushed_commit,
                reason: reason.into(),
            })?)
            .await?
            .into_inner())
    }
    async fn begin(
        &self,
        lease: &GithubPublicationLease,
        phase: GithubPublicationPhase,
    ) -> Result<GithubPublication> {
        // The renewal immediately before dispatch proves this exact current
        // lease. A lost Begin response is never treated as permission to send.
        self.renew(lease).await?;
        Ok(self
            .client
            .clone()
            .begin_effect(self.request(BeginGithubPublicationEffectRequest {
                lease: Some(lease.clone()),
                operation_id: Uuid::new_v4().to_string(),
                phase: phase as i32,
            })?)
            .await?
            .into_inner())
    }
    async fn workflow(
        &self,
        claim: ClaimGithubPublicationResponse,
        lease: &GithubPublicationLease,
        cancel: &CancellationToken,
    ) -> Result<()> {
        let mut job = claim.publication.context("claim is empty")?;
        let target = target(&job)?;
        let discovery = async {
            let token = self.provider.token(&job).await?;
            let observation = self.provider.inspect(&job, &token).await?;
            Ok::<_, anyhow::Error>((token, observation))
        }
        .await;
        let (token, observed) = match discovery {
            Ok(value) => value,
            Err(_) => {
                self.record(
                    lease,
                    job.phase(),
                    if claim.read_only {
                        GithubPublicationState::Uncertain
                    } else {
                        GithubPublicationState::Queued
                    },
                    None,
                    None,
                    "GitHub discovery is unavailable; no provider write was dispatched",
                )
                .await?;
                return Ok(());
            }
        };
        if claim.read_only {
            if let Some(found) = target.reconcile_create(observed.complete, &observed.requests) {
                self.record(
                    lease,
                    job.phase(),
                    GithubPublicationState::Published,
                    Some(receipt(&job, &found)),
                    None,
                    "",
                )
                .await?;
            } else {
                self.record(
                    lease,
                    job.phase(),
                    GithubPublicationState::Uncertain,
                    None,
                    None,
                    "read-only reconciliation did not prove the exact published commit",
                )
                .await?;
            }
            return Ok(());
        }
        let resuming = job.phase() == GithubPublicationPhase::Push;
        if resuming
            && (observed.branch.as_deref() != Some(target.commit.as_str()) || !observed.complete)
        {
            self.record(
                lease,
                job.phase(),
                GithubPublicationState::Held,
                None,
                None,
                "remote branch changed after the acknowledged push",
            )
            .await?;
            return Ok(());
        }
        let existing = if resuming && observed.requests.is_empty() {
            None
        } else {
            match target.discover(
                observed.complete,
                &observed.requests,
                observed.branch.as_deref(),
            ) {
                plan::Discovery::New => None,
                plan::Discovery::Open(value) => Some(value),
                plan::Discovery::Hold(reason) => {
                    self.record(
                        lease,
                        job.phase(),
                        GithubPublicationState::Held,
                        None,
                        None,
                        reason,
                    )
                    .await?;
                    return Ok(());
                }
            }
        };
        job = self
            .client
            .clone()
            .plan(self.request(PlanGithubPublicationRequest {
                lease: Some(lease.clone()),
                operation_id: Uuid::new_v4().to_string(),
                existing: existing.as_ref().map(|value| receipt(&job, value)),
                pushed_commit: if resuming {
                    observed.branch.clone()
                } else {
                    None
                },
            })?)
            .await?
            .into_inner();
        if matches!(
            job.state(),
            GithubPublicationState::WaitingApproval | GithubPublicationState::Held
        ) {
            return Ok(());
        }
        let prepared = match self.provider.prepare(&job, token, cancel).await {
            Ok(prepared) => prepared,
            Err(_) => {
                self.record(
                    lease,
                    job.phase(),
                    GithubPublicationState::Held,
                    None,
                    None,
                    "the exact verified Workspace bundle could not be prepared for publication",
                )
                .await?;
                return Ok(());
            }
        };
        if !resuming {
            job = self.begin(lease, GithubPublicationPhase::Push).await?;
            let push = self
                .provider
                .push(&job, &prepared, observed.branch.as_deref(), cancel)
                .await;
            let after = if push.is_ok() {
                self.provider.inspect(&job, &prepared.token).await.ok()
            } else {
                None
            };
            if after
                .as_ref()
                .is_none_or(|seen| seen.branch.as_deref() != Some(target.commit.as_str()))
            {
                self.record(
                    lease,
                    GithubPublicationPhase::Push,
                    GithubPublicationState::Uncertain,
                    None,
                    None,
                    "push outcome was not proved by the exact remote commit",
                )
                .await?;
                return Ok(());
            }
            job = self
                .record(
                    lease,
                    GithubPublicationPhase::Push,
                    GithubPublicationState::Claimed,
                    None,
                    Some(target.commit.clone()),
                    "",
                )
                .await?;
        }
        let phase = if let Some(prior) = &existing {
            let current = self
                .provider
                .get(&job, prior.number, &prepared.token)
                .await?;
            if !target.may_update_after_push(prior.number, &current) {
                self.record(
                    lease,
                    GithubPublicationPhase::Push,
                    GithubPublicationState::Held,
                    None,
                    None,
                    "pull request closed or changed before metadata update",
                )
                .await?;
                return Ok(());
            }
            GithubPublicationPhase::Update
        } else {
            GithubPublicationPhase::Create
        };
        job = self.begin(lease, phase).await?;
        let result = if let Some(prior) = existing {
            self.provider
                .update(&job, prior.number, &prepared.token)
                .await
        } else {
            self.provider.create(&job, &prepared.token).await
        };
        let found = match result {
            Ok(value)
                if target.matches(&value)
                    && value.open
                    && !value.merged
                    && value.commit == target.commit
                    && value.title == target.title
                    && value.body == target.body =>
            {
                Some(value)
            }
            _ => self
                .provider
                .inspect(&job, &prepared.token)
                .await
                .ok()
                .and_then(|seen| target.reconcile_create(seen.complete, &seen.requests)),
        };
        match found {
            Some(found) => {
                self.record(
                    lease,
                    phase,
                    GithubPublicationState::Published,
                    Some(receipt(&job, &found)),
                    None,
                    "",
                )
                .await?;
            }
            None => {
                self.record(
                    lease,
                    phase,
                    GithubPublicationState::Uncertain,
                    None,
                    None,
                    "pull request result was not proved; no provider write will be repeated",
                )
                .await?;
            }
        }
        Ok(())
    }
}
