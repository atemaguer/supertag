use std::{sync::Arc, time::Duration};

use anyhow::{Context, Result, ensure};
use supertag_protocol::negotiation::ProtocolChannel;
use supertag_protocol::{
    CHECKPOINT_CHUNK_BYTES, MAX_MESSAGE_BYTES,
    v2::{
        transfers_server::{Transfers, TransfersServer},
        workspace_directory_client::WorkspaceDirectoryClient,
        *,
    },
    validate_workspace_delivery,
};
use tokio::{
    sync::{Semaphore, mpsc},
    time::timeout,
};
use tokio_stream::wrappers::ReceiverStream;
use tonic::{Request, Response, Status, Streaming};

use crate::Api;

mod artifacts;
// Nothing reads through the relay any more; the HostRelay service and this hub go with it in
// the no-file-relay plan's slice 6.
#[allow(dead_code)]
mod relay;
pub mod volumes;

pub(crate) use relay::RelayHub;

#[cfg(test)]
#[path = "transfers_review_tests.rs"]
mod review_tests;

/// Git delivery as the API tier uses it: grants Worker Hosts a credential to read a remote
/// Workspace themselves, and checks Workspaces. The process that runs this tier supplies it,
/// with the Workspace Credentials it holds. A Worker Host gets a credential only for one
/// operation of a live Attempt, and keeps it in memory.
#[tonic::async_trait]
pub trait WorkspaceGit: Send + Sync + 'static {
    /// The credential a Worker Host presents to read `workspace`'s remote, with its expiry in
    /// milliseconds since the epoch (0 when it does not expire). None for a remote that needs none.
    /// The credential a Worker Host presents to `workspace`'s remote for one read, or with
    /// `push` one push.
    async fn grant(
        &self,
        workspace: &Workspace,
        push: bool,
    ) -> Result<(Option<workspace_git_grant::Credential>, i64)>;

    /// The remote URL when it advertises `commit` on a branch or tag, if any.
    async fn advertised_output_remote(
        &self,
        workspace: &Workspace,
        commit: &str,
        cancel: &tokio_util::sync::CancellationToken,
    ) -> Result<Option<String>>;

    /// Reads the remote and checks pushing, without changing it.
    async fn check(
        &self,
        workspace: &Workspace,
        cancel: &tokio_util::sync::CancellationToken,
    ) -> Result<WorkspaceCheck>;
}

/// Serves the Control Plane's byte transfers. It stores nothing: artifact and Workspace delivery
/// bytes stay on the Worker Host that produced them (or a Volume), and reach readers through
/// [`RelayHub`] without being written here. Session checkpoints stay on the host that wrote them.
#[derive(Clone)]
pub struct ApiTransfers {
    api: Api,
    capacity: Arc<Semaphore>,
    git: Option<Arc<dyn WorkspaceGit>>,
    signers: volumes::VolumeSigners,
    relay: Arc<RelayHub>,
}

impl ApiTransfers {
    pub fn new(api: Api) -> Self {
        Self {
            api,
            capacity: Arc::new(Semaphore::new(16)),
            git: None,
            signers: volumes::VolumeSigners::default(),
            relay: Arc::default(),
        }
    }

    /// Ends every Worker Host relay stream once `shutdown` is cancelled.
    pub(crate) fn close_relays_on(&self, shutdown: tokio_util::sync::CancellationToken) {
        let relay = self.relay.clone();
        tokio::spawn(async move {
            shutdown.cancelled().await;
            relay.close();
        });
    }

    /// The `HostRelay` service Worker Hosts answer relay requests through.
    pub fn host_relay_service(&self) -> host_relay_server::HostRelayServer<Self> {
        host_relay_server::HostRelayServer::new(self.clone())
            .max_decoding_message_size(MAX_MESSAGE_BYTES)
            .max_encoding_message_size(MAX_MESSAGE_BYTES)
    }

    pub fn with_workspace_git(mut self, git: Arc<dyn WorkspaceGit>) -> Self {
        self.git = Some(git);
        self
    }

    pub(crate) fn workspace_git(&self) -> Option<&Arc<dyn WorkspaceGit>> {
        self.git.as_ref()
    }

    pub(crate) fn api(&self) -> &Api {
        &self.api
    }

    async fn get_source(
        &self,
        request: Request<DownloadWorkspaceSourceRequest>,
    ) -> Result<WorkspaceSourceBundle, Status> {
        self.api
            .forward_host(request, true, |channel, request| async {
                workspace_client(channel).get_source(request).await
            })
            .await
            .map(Response::into_inner)
    }

    fn git(&self) -> Result<&Arc<dyn WorkspaceGit>, Status> {
        self.git.as_ref().ok_or_else(|| {
            Status::failed_precondition("git delivery does not run on this Control Plane")
        })
    }

    pub fn service(self) -> TransfersServer<Self> {
        TransfersServer::new(self)
            .max_decoding_message_size(MAX_MESSAGE_BYTES)
            .max_encoding_message_size(MAX_MESSAGE_BYTES)
    }

    /// Records a delivery whose bytes the calling host already holds. No bytes reach this tier.
    async fn commit_workspace_delivery(
        &self,
        request: Request<WorkspaceDeliveryRequest>,
    ) -> Result<Response<WorkspaceDeliveryReference>, Status> {
        let (metadata, _, begin) = request.into_parts();
        let delivery = begin
            .delivery
            .as_ref()
            .ok_or_else(|| Status::invalid_argument("workspace delivery required"))?;
        validate_workspace_delivery(delivery)?;
        let mut reservation = Request::new(begin.clone());
        *reservation.metadata_mut() = metadata.clone();
        let reserved = self
            .api
            .forward_host(reservation, true, |channel, request| async move {
                workspace_client(channel).reserve_delivery(request).await
            })
            .await?
            .into_inner();
        if &reserved != delivery {
            return Err(Status::data_loss(
                "Control Plane returned a different workspace reservation",
            ));
        }
        let mut commit = Request::new(begin);
        *commit.metadata_mut() = metadata;
        self.api
            .forward_host(commit, true, |channel, request| async move {
                workspace_client(channel).commit_delivery(request).await
            })
            .await
    }

    async fn get_workspace_reference(
        &self,
        request: Request<InspectAttemptRequest>,
    ) -> Result<Option<(WorkspaceDeliveryReference, BlobHolder)>, Status> {
        let continuation = self
            .api
            .forward_host(request, true, |channel, request| async move {
                workspace_client(channel).get_continuation(request).await
            })
            .await?
            .into_inner();
        match (continuation.delivery, continuation.holder) {
            (Some(delivery), Some(holder)) => Ok(Some((delivery, holder))),
            (None, _) => Ok(None),
            (Some(_), None) => Err(Status::data_loss(
                "Workspace continuation has no holding Worker Host",
            )),
        }
    }

    async fn authorize_upload<T>(&self, request: &Request<T>) -> Result<(), Status> {
        timeout(Duration::from_secs(5), self.api.registered_host(request))
            .await
            .map_err(|_| Status::deadline_exceeded("Worker Host authentication timed out"))??;
        Ok(())
    }

    fn acquire(&self) -> Result<tokio::sync::OwnedSemaphorePermit, Status> {
        self.capacity
            .clone()
            .try_acquire_owned()
            .map_err(|_| Status::resource_exhausted("too many blob transfers"))
    }
}

#[tonic::async_trait]
impl Transfers for ApiTransfers {
    async fn verify_workspace_output_remote(
        &self,
        request: Request<VerifyWorkspaceOutputRemoteRequest>,
    ) -> Result<Response<VerifyWorkspaceOutputRemoteResponse>, Status> {
        let (metadata, _, input) = request.into_parts();
        let attempt = input
            .attempt
            .ok_or_else(|| Status::invalid_argument("Attempt is required"))?;
        if !supertag_protocol::valid_git_commit(&input.commit) {
            return Err(Status::invalid_argument("invalid Git output commit"));
        }
        let source_request = || {
            let mut request = Request::new(DownloadWorkspaceSourceRequest {
                attempt: Some(attempt.clone()),
                merge: false,
            });
            *request.metadata_mut() = metadata.clone();
            request
        };
        let source = self.get_source(source_request()).await?;
        let workspace = source
            .workspace
            .clone()
            .ok_or_else(|| Status::internal("Workspace source is incomplete"))?;
        let git = self.git()?;
        let _permit = self.acquire()?;
        let cancel = tokio_util::sync::CancellationToken::new();
        let _cancel_on_drop = cancel.clone().drop_guard();
        let remote = timeout(
            Duration::from_secs(30),
            git.advertised_output_remote(&workspace, &input.commit, &cancel),
        )
        .await
        .map_err(|_| Status::deadline_exceeded("Workspace output verification timed out"))?
        .map_err(|_| Status::unavailable("Workspace output remote could not be verified"))?;
        if self.get_source(source_request()).await? != source {
            return Err(Status::permission_denied(
                "Workspace source is no longer authorized",
            ));
        }
        Ok(Response::new(VerifyWorkspaceOutputRemoteResponse {
            remote,
        }))
    }

    async fn commit_workspace(
        &self,
        request: Request<WorkspaceDeliveryRequest>,
    ) -> Result<Response<WorkspaceDeliveryReference>, Status> {
        self.authorize_upload(&request).await?;
        self.commit_workspace_delivery(request).await
    }

    async fn get_workspace_continuation(
        &self,
        request: Request<InspectAttemptRequest>,
    ) -> Result<Response<WorkspaceContinuation>, Status> {
        let (delivery, holder) = match self.get_workspace_reference(request).await? {
            Some((delivery, holder)) => (Some(delivery), Some(holder)),
            None => (None, None),
        };
        Ok(Response::new(WorkspaceContinuation { delivery, holder }))
    }

    async fn get_review_delivery(
        &self,
        request: Request<GetReviewArtifactRequest>,
    ) -> Result<Response<HeldWorkspaceDelivery>, Status> {
        Ok(Response::new(self.review_delivery(request).await?))
    }
}

#[tonic::async_trait]
impl host_relay_server::HostRelay for ApiTransfers {
    type AwaitStream = ReceiverStream<Result<RelayRequest, Status>>;

    async fn r#await(
        &self,
        request: Request<AwaitRelayRequest>,
    ) -> Result<Response<Self::AwaitStream>, Status> {
        let host = self.api.registered_host(&request).await?;
        let host_id = host_id(&host)?;
        Ok(Response::new(self.relay.connect(host_id, host.generation)))
    }

    async fn deliver(
        &self,
        request: Request<Streaming<RelayFrame>>,
    ) -> Result<Response<RelayDelivered>, Status> {
        let host = self.api.registered_host(&request).await?;
        let host_id = host_id(&host)?;
        self.relay
            .deliver(&host_id, host.generation, request.into_inner())
            .await
            .map(Response::new)
    }
}

fn host_id(caller: &crate::Caller) -> Result<String, Status> {
    caller
        .principal
        .strip_prefix("host:")
        .map(str::to_owned)
        .ok_or_else(|| Status::permission_denied("caller is not a Worker Host"))
}

#[tonic::async_trait]
impl workspace_git_access_server::WorkspaceGitAccess for ApiTransfers {
    /// Grants a live Attempt's Worker Host the credential to read its Workspace's source itself,
    /// or the Worker Host holding a landing's lease the credential to push it.
    async fn mint(
        &self,
        request: Request<MintWorkspaceGitAccessRequest>,
    ) -> Result<Response<WorkspaceGitGrant>, Status> {
        match (
            request.get_ref().permission(),
            request.get_ref().landing_id.is_empty(),
        ) {
            (WorkspaceGitPermission::Push, false) if request.get_ref().attempt.is_none() => {
                return self.mint_push(request).await;
            }
            (WorkspaceGitPermission::Read, true) if !request.get_ref().review_id.is_empty() => {
                return self.mint_review(request).await;
            }
            (WorkspaceGitPermission::Read, true) => {}
            _ => {
                return Err(Status::invalid_argument(
                    "a Worker Host reads with an Attempt, and pushes only with a landing lease it holds",
                ));
            }
        }
        let (metadata, _, input) = request.into_parts();
        // This authoritative check precedes credential resolution.
        let mut source = Request::new(DownloadWorkspaceSourceRequest {
            attempt: input.attempt,
            merge: input.merge,
        });
        *source.metadata_mut() = metadata;
        let source = self.get_source(source).await?;
        let workspace = source
            .workspace
            .ok_or_else(|| Status::internal("Workspace source is incomplete"))?;
        let (credential, expires_at_ms) = timeout(
            Duration::from_secs(30),
            self.git()?.grant(&workspace, false),
        )
        .await
        .map_err(|_| Status::deadline_exceeded("Workspace Credential lookup timed out"))?
        .map_err(|error| {
            Status::failed_precondition(format!(
                "Workspace source cannot be read from a Worker Host: {error:#}"
            ))
        })?;
        Ok(Response::new(WorkspaceGitGrant {
            workspace: Some(workspace),
            commit: source.commit,
            credential,
            expires_at_ms,
            branch: String::new(),
        }))
    }
}

impl ApiTransfers {
    /// The read credential for the delivery of a review request the calling Attempt reviews: the
    /// review's authorization at the state owner is the check, and names the delivery, its remote
    /// Workspace, and the Session branch holding it.
    async fn mint_review(
        &self,
        request: Request<MintWorkspaceGitAccessRequest>,
    ) -> Result<Response<WorkspaceGitGrant>, Status> {
        let (metadata, extensions, input) = request.into_parts();
        let review = GetReviewArtifactRequest {
            attempt: input.attempt,
            review_id: input.review_id,
        };
        let held = self
            .review_delivery(Request::from_parts(metadata, extensions, review))
            .await?;
        let (Some(delivery), Some(workspace)) = (held.delivery, held.workspace) else {
            return Err(Status::failed_precondition(
                "the reviewed delivery is in a local Workspace, readable only on the Worker Host holding it",
            ));
        };
        let (credential, expires_at_ms) = timeout(
            Duration::from_secs(30),
            self.git()?.grant(&workspace, false),
        )
        .await
        .map_err(|_| Status::deadline_exceeded("Workspace Credential lookup timed out"))?
        .map_err(|error| {
            Status::failed_precondition(format!(
                "the reviewed Workspace cannot be read from a Worker Host: {error:#}"
            ))
        })?;
        Ok(Response::new(WorkspaceGitGrant {
            workspace: Some(workspace),
            commit: delivery.head_commit,
            credential,
            expires_at_ms,
            branch: held.session_branch,
        }))
    }

    async fn review_delivery(
        &self,
        request: Request<GetReviewArtifactRequest>,
    ) -> Result<HeldWorkspaceDelivery, Status> {
        Ok(self
            .api
            .forward_host(request, true, |channel, request| async move {
                workspace_client(channel).get_review_artifact(request).await
            })
            .await?
            .into_inner())
    }

    /// The push credential for a landing whose lease the calling Worker Host holds. Renewing
    /// the lease at the state owner, as the host, is the authoritative check, and names the
    /// landing's Workspace and delivered commit.
    async fn mint_push(
        &self,
        request: Request<MintWorkspaceGitAccessRequest>,
    ) -> Result<Response<WorkspaceGitGrant>, Status> {
        let (metadata, extensions, input) = request.into_parts();
        let lease = WorkspaceLandingLease {
            landing_id: input.landing_id,
            lease_token: input.landing_lease_token,
        };
        let renewed = self
            .api
            .forward_host(
                Request::from_parts(metadata, extensions, lease),
                true,
                |channel, request| async {
                    host_landings_client::HostLandingsClient::new(channel)
                        .max_decoding_message_size(MAX_MESSAGE_BYTES)
                        .max_encoding_message_size(MAX_MESSAGE_BYTES)
                        .renew(request)
                        .await
                },
            )
            .await?
            .into_inner();
        let (Some(landing), Some(workspace)) = (renewed.landing, renewed.workspace) else {
            return Err(Status::failed_precondition(
                "the landing has no remote Workspace to push to",
            ));
        };
        let commit = landing
            .delivery
            .map(|delivery| delivery.head_commit)
            .ok_or_else(|| Status::failed_precondition("the landing has no delivery"))?;
        let (credential, expires_at_ms) =
            timeout(Duration::from_secs(30), self.git()?.grant(&workspace, true))
                .await
                .map_err(|_| Status::deadline_exceeded("Workspace Credential lookup timed out"))?
                .map_err(|error| {
                    Status::failed_precondition(format!(
                        "the Workspace's remote cannot be pushed from a Worker Host: {error:#}"
                    ))
                })?;
        Ok(Response::new(WorkspaceGitGrant {
            workspace: Some(workspace),
            commit,
            credential,
            expires_at_ms,
            branch: String::new(),
        }))
    }

    pub fn workspace_git_access_service(
        &self,
    ) -> workspace_git_access_server::WorkspaceGitAccessServer<Self> {
        workspace_git_access_server::WorkspaceGitAccessServer::new(self.clone())
    }
}

fn workspace_client(channel: ProtocolChannel) -> WorkspaceDirectoryClient<ProtocolChannel> {
    WorkspaceDirectoryClient::new(channel)
        .max_decoding_message_size(MAX_MESSAGE_BYTES)
        .max_encoding_message_size(MAX_MESSAGE_BYTES)
}
