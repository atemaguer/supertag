//! Landing the deliveries this Worker Host holds. Right after a delivery, and then every second,
//! the host claims the landings of deliveries it holds, pushes the Session's branch (and in merge
//! mode the merge into the target) from its own copy of the commit, and records the result. No
//! delivery bytes reach the Control Plane; a review landing's pull request is the Control Plane's
//! to open once the branch is pushed.
use std::{path::Path, sync::Arc};

use anyhow::{Context, Result, ensure};
use supertag_git_delivery::{
    Credential, GitDelivery, Remote,
    landing::{HeldDeliveries, LandingCalls},
};
use supertag_protocol::{
    MAX_MESSAGE_BYTES,
    v2::{
        ClaimWorkspaceLandingRequest, ClaimWorkspaceLandingResponse, MintWorkspaceGitAccessRequest,
        RecordWorkspaceLandingRequest, WorkspaceGitPermission, WorkspaceLanding,
        WorkspaceLandingLease, host_landings_client::HostLandingsClient,
        workspace_git_access_client::WorkspaceGitAccessClient, workspace_git_grant,
    },
};
use tokio_util::sync::CancellationToken;
use tonic::{Status, codegen::InterceptedService, transport::Channel};

use crate::{HostHeaders, artifact_direct::SourceStorage};

type Client = HostLandingsClient<InterceptedService<Channel, HostHeaders>>;

/// This host's landings: its git delivery, without a credential vault, and what it lands from.
#[derive(Clone)]
pub(crate) struct Landings {
    delivery: GitDelivery,
    calls: Arc<dyn LandingCalls>,
    held: Arc<dyn HeldDeliveries>,
}

impl Landings {
    pub(crate) fn new(
        state_directory: &Path,
        channel: Channel,
        headers: HostHeaders,
        token: &str,
        storage: SourceStorage,
    ) -> Result<Self> {
        let access = WorkspaceGitAccessClient::with_interceptor(channel.clone(), headers.clone());
        let client = HostLandingsClient::with_interceptor(channel, headers)
            .max_decoding_message_size(MAX_MESSAGE_BYTES)
            .max_encoding_message_size(MAX_MESSAGE_BYTES);
        Ok(Self {
            delivery: GitDelivery::for_host(&state_directory.join("git-delivery"))?,
            calls: Arc::new(Calls {
                client,
                token: token.to_owned(),
            }),
            held: Arc::new(Held {
                storage,
                access,
                token: token.to_owned(),
            }),
        })
    }

    /// Lands what this host may claim now: run right after a delivery, so the Session's branch
    /// reaches the remote before the host moves on or exits.
    pub(crate) async fn land_now(&self, shutdown: &CancellationToken) {
        self.delivery
            .land_claimable(self.calls.clone(), self.held.clone(), shutdown)
            .await;
    }

    /// Lands queued landings, such as a retry or a merge after its Work Session closed, until
    /// `shutdown`.
    pub(crate) fn spawn(&self, shutdown: CancellationToken) {
        let landings = self.clone();
        tokio::spawn(async move {
            if let Err(error) = landings
                .delivery
                .run_host_landings(landings.calls, landings.held, shutdown)
                .await
            {
                crate::failures::note_unrecorded("Workspace landings stopped", &error);
            }
        });
    }
}

struct Calls {
    client: Client,
    token: String,
}

impl Calls {
    fn request<T>(&self, message: T) -> Result<tonic::Request<T>, Status> {
        crate::request(message, &self.token).map_err(|error| Status::internal(error.to_string()))
    }
}

#[tonic::async_trait]
impl LandingCalls for Calls {
    async fn claim(
        &self,
        request: ClaimWorkspaceLandingRequest,
    ) -> Result<ClaimWorkspaceLandingResponse, Status> {
        Ok(self
            .client
            .clone()
            .claim(self.request(request)?)
            .await?
            .into_inner())
    }

    async fn renew(
        &self,
        lease: WorkspaceLandingLease,
    ) -> Result<ClaimWorkspaceLandingResponse, Status> {
        Ok(self
            .client
            .clone()
            .renew(self.request(lease)?)
            .await?
            .into_inner())
    }

    async fn record(
        &self,
        record: RecordWorkspaceLandingRequest,
    ) -> Result<WorkspaceLanding, Status> {
        Ok(self
            .client
            .clone()
            .record(self.request(record)?)
            .await?
            .into_inner())
    }
}

struct Held {
    storage: SourceStorage,
    access: WorkspaceGitAccessClient<InterceptedService<Channel, HostHeaders>>,
    token: String,
}

#[tonic::async_trait]
impl HeldDeliveries for Held {
    async fn bundle(&self, claim: &ClaimWorkspaceLandingResponse, into: &Path) -> Result<bool> {
        let (Some(holder), Some(delivery)) = (
            claim.holder.as_ref(),
            claim
                .landing
                .as_ref()
                .and_then(|landing| landing.delivery.as_ref()),
        ) else {
            return Ok(false);
        };
        // The Workspace state that holds the delivery, which may belong to another lane of this
        // host.
        let Ok(state) = self.storage.workspace_of(&holder.attempt_id) else {
            return Ok(false);
        };
        let bytes = supertag_workspaces::complete_delivery_bundle(
            &state,
            &delivery.head_commit,
            &delivery.delivery_id,
            &CancellationToken::new(),
        )
        .await?;
        tokio::fs::write(into, bytes).await?;
        Ok(true)
    }

    /// The Control Plane grants the push credential for this lease only, and this host keeps it
    /// in memory for the one landing.
    async fn push_remote(
        &self,
        landing: &WorkspaceLanding,
        lease: &WorkspaceLandingLease,
    ) -> Result<Remote> {
        let mut request = crate::request(
            MintWorkspaceGitAccessRequest {
                landing_id: lease.landing_id.clone(),
                landing_lease_token: lease.lease_token.clone(),
                permission: WorkspaceGitPermission::Push as i32,
                ..Default::default()
            },
            &self.token,
        )?;
        request.set_timeout(std::time::Duration::from_secs(35));
        let grant = self.access.clone().mint(request).await?.into_inner();
        let workspace = grant.workspace.context("push grant has no Workspace")?;
        ensure!(
            workspace.remote == landing.remote,
            "push grant is for another remote"
        );
        let credential = grant.credential.map(|credential| match credential {
            workspace_git_grant::Credential::Https(https) => Credential::HttpsToken {
                username: https.username,
                token: https.token,
            },
            workspace_git_grant::Credential::Ssh(ssh) => Credential::SshKey {
                private_key: ssh.private_key,
                known_hosts: (!ssh.known_hosts.is_empty()).then_some(ssh.known_hosts),
            },
        });
        Remote::new(&landing.remote, credential)
    }
}
