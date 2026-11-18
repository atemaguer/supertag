use std::{
    fs::{File, OpenOptions},
    io::ErrorKind,
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};

use anyhow::{Context, Result, ensure};
use sha2::{Digest, Sha256};
use supertag_protocol::negotiation::ProtocolChannel;
use supertag_protocol::stream_failure::{EndsWithError, ends_with_error};
use supertag_protocol::{
    CHECKPOINT_CHUNK_BYTES, MAX_MESSAGE_BYTES,
    v2::{
        transfers_server::{Transfers, TransfersServer},
        workspace_directory_client::WorkspaceDirectoryClient,
        workspace_download, *,
    },
    validate_workspace_delivery,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    sync::{Semaphore, mpsc},
    time::timeout,
};
use tokio_stream::wrappers::ReceiverStream;
use tonic::{Request, Response, Status, Streaming};

use crate::Api;

mod artifacts;
mod relay;
pub mod volumes;

pub(crate) use relay::RelayHub;
use relay::{Incoming, RelayError};

const WORKSPACE_TRANSFER_TIMEOUT: Duration = Duration::from_secs(120);

#[cfg(test)]
#[path = "transfers_review_tests.rs"]
mod review_tests;

/// Git delivery as the API tier uses it: reads remote Workspace sources for Worker Hosts and
/// checks Workspaces. The process that runs this tier supplies it, with the Workspace
/// Credentials it holds; no credential reaches a Worker Host.
#[tonic::async_trait]
pub trait WorkspaceGit: Send + Sync + 'static {
    /// Fetches `commit` of `workspace`'s remote as a verified git bundle.
    async fn fetch(
        &self,
        workspace: &Workspace,
        commit: &str,
        cancel: &tokio_util::sync::CancellationToken,
    ) -> Result<FetchedSource>;

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

/// A fetched source bundle and the private state that must outlive its download.
pub struct FetchedSource {
    pub bundle: supertag_workspaces::TransferArtifact,
    pub keep: Box<dyn std::any::Any + Send + Sync>,
}

/// Serves the Control Plane's byte transfers. It stores nothing: artifact and Workspace delivery
/// bytes stay on the Worker Host that produced them (or a Volume), and reach readers through
/// [`RelayHub`] without being written here. Session checkpoints stay on the host that wrote them.
#[derive(Clone)]
pub struct ApiTransfers {
    api: Api,
    capacity: Arc<Semaphore>,
    git: Option<Arc<dyn WorkspaceGit>>,
    volumes: volumes::ArtifactVolumeMappings,
    relay: Arc<RelayHub>,
}

impl ApiTransfers {
    pub fn new(api: Api) -> Self {
        Self {
            api,
            capacity: Arc::new(Semaphore::new(16)),
            git: None,
            volumes: volumes::ArtifactVolumeMappings::default(),
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

    /// Writes a complete bundle of `delivery`'s commit, which `holder` builds on demand, into
    /// `destination`. Git delivery reads deliveries this way: its scratch repository
    /// starts empty. The bundle has no recorded digest; the caller checks it with Git against the
    /// delivered commit and deletes the file.
    pub async fn relay_complete_bundle_to_file(
        &self,
        holder: &BlobHolder,
        delivery: &WorkspaceDeliveryReference,
        destination: &Path,
    ) -> Result<()> {
        let incoming = self
            .relay
            .open_complete_bundle(holder, delivery)
            .await
            .map_err(|error| relay_status(error, &holder.host_id, "Workspace delivery"))?;
        self.write_relayed(
            incoming,
            Expected::Unrecorded {
                limit: supertag_protocol::MAX_WORKSPACE_BLOB_BYTES as u64,
            },
            destination,
        )
        .await
    }

    /// Writes one blob held by `holder` into `destination`, verifying its length and digest.
    pub async fn relay_to_file(
        &self,
        holder: &BlobHolder,
        blob: &BlobReference,
        destination: &Path,
    ) -> Result<()> {
        let incoming = self
            .relay
            .open(holder, blob)
            .await
            .map_err(|error| relay_status(error, &holder.host_id, "Workspace delivery"))?;
        self.write_relayed(incoming, Expected::Receipt(blob.clone()), destination)
            .await
    }

    async fn write_relayed(
        &self,
        mut incoming: relay::Incoming,
        expected: Expected,
        destination: &Path,
    ) -> Result<()> {
        let mut file = tokio::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(destination)
            .await?;
        let mut digest = Sha256::new();
        let mut length = 0u64;
        let read = async {
            while let Some(chunk) = incoming.next().await? {
                length += chunk.len() as u64;
                ensure!(
                    length <= expected.limit(),
                    "relayed blob exceeds its receipt"
                );
                digest.update(&chunk);
                file.write_all(&chunk).await?;
            }
            Ok::<_, anyhow::Error>(())
        };
        timeout(WORKSPACE_TRANSFER_TIMEOUT, read)
            .await
            .map_err(|_| anyhow::anyhow!("relayed blob read timed out"))??;
        if let Expected::Receipt(blob) = &expected {
            ensure!(
                length == blob.byte_length && format!("{:x}", digest.finalize()) == blob.sha256,
                "relayed blob does not match its receipt"
            );
        }
        file.sync_all().await?;
        Ok(())
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

    async fn get_review_reference(
        &self,
        request: Request<GetReviewArtifactRequest>,
    ) -> Result<(WorkspaceDeliveryReference, BlobHolder), Status> {
        held(
            self.api
                .forward_host(request, true, |channel, request| async move {
                    workspace_client(channel).get_review_artifact(request).await
                })
                .await?
                .into_inner(),
        )
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

    async fn workspace_download<F, Authorization>(
        &self,
        reference: WorkspaceDeliveryReference,
        holder: BlobHolder,
        kind: WorkspaceArtifactKind,
        authorize: F,
    ) -> Result<Response<Download<WorkspaceDownload>>, Status>
    where
        F: Fn() -> Authorization + Send + Sync + 'static,
        Authorization: std::future::Future<Output = Result<(), Status>> + Send,
    {
        validate_workspace_delivery(&reference)?;
        let permit = self.acquire()?;
        let (source, expected) = if kind == WorkspaceArtifactKind::CompleteBundle {
            let incoming = self
                .relay
                .open_complete_bundle(&holder, &reference)
                .await
                .map_err(|error| relay_status(error, &holder.host_id, "Workspace delivery"))?;
            (
                Source::Relay(incoming),
                Expected::Unrecorded {
                    limit: supertag_protocol::MAX_WORKSPACE_BLOB_BYTES as u64,
                },
            )
        } else {
            let blob = match kind {
                WorkspaceArtifactKind::Patch => reference.patch.clone(),
                WorkspaceArtifactKind::Bundle => reference.bundle.clone(),
                _ => return Err(Status::invalid_argument("workspace artifact kind required")),
            }
            .expect("validated blob reference");
            let incoming = self
                .relay
                .open(&holder, &blob)
                .await
                .map_err(|error| relay_status(error, &holder.host_id, "Workspace delivery"))?;
            (Source::Relay(incoming), Expected::Receipt(blob))
        };
        let header = WorkspaceDownload {
            part: Some(workspace_download::Part::Reference(reference)),
        };
        Ok(Response::new(download_stream(
            source,
            permit,
            expected,
            header,
            |bytes| WorkspaceDownload {
                part: Some(workspace_download::Part::Chunk(bytes)),
            },
            authorize,
            WORKSPACE_TRANSFER_TIMEOUT,
        )))
    }
}

#[tonic::async_trait]
impl Transfers for ApiTransfers {
    type DownloadWorkspaceSourceStream = Download<WorkspaceSourceDownload>;

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

    async fn download_workspace_source(
        &self,
        request: Request<DownloadWorkspaceSourceRequest>,
    ) -> Result<Response<Self::DownloadWorkspaceSourceStream>, Status> {
        let input = request.get_ref().clone();
        let metadata = request.metadata().clone();
        // This authoritative check precedes credential resolution or remote I/O.
        let source = self.get_source(request).await?;
        let workspace = source
            .workspace
            .clone()
            .ok_or_else(|| Status::internal("Workspace source is incomplete"))?;
        let git = self.git()?;
        let permit = self.acquire()?;
        let cancel = tokio_util::sync::CancellationToken::new();
        let _cancel_on_drop = cancel.clone().drop_guard();
        let fetched = Arc::new(
            timeout(
                WORKSPACE_TRANSFER_TIMEOUT,
                git.fetch(&workspace, &source.commit, &cancel),
            )
            .await
            .map_err(|_| Status::deadline_exceeded("Workspace source retrieval timed out"))?
            .map_err(|error| {
                Status::unavailable(format!("Workspace source could not be read: {error:#}"))
            })?,
        );
        let reference = BlobReference {
            sha256: fetched.bundle.sha256.clone(),
            byte_length: fetched.bundle.byte_length,
        };
        let header = WorkspaceSourceDownload {
            part: Some(workspace_source_download::Part::Reference(
                WorkspaceSourceBundle {
                    workspace: Some(workspace),
                    bundle: Some(reference.clone()),
                    commit: source.commit.clone(),
                },
            )),
        };
        let file = Source::File(open_blob(&fetched.bundle.path).await?);
        let service = self.clone();
        let authorize = move || {
            let service = service.clone();
            let source = source.clone();
            let keep = fetched.clone();
            let mut request = Request::new(input.clone());
            *request.metadata_mut() = metadata.clone();
            async move {
                let _keep = keep;
                if service.get_source(request).await? == source {
                    Ok(())
                } else {
                    Err(Status::permission_denied(
                        "Workspace source is no longer authorized",
                    ))
                }
            }
        };
        authorize().await?;
        Ok(Response::new(download_stream(
            file,
            permit,
            reference,
            header,
            |bytes| WorkspaceSourceDownload {
                part: Some(workspace_source_download::Part::Chunk(bytes)),
            },
            authorize,
            WORKSPACE_TRANSFER_TIMEOUT,
        )))
    }

    async fn commit_workspace(
        &self,
        request: Request<WorkspaceDeliveryRequest>,
    ) -> Result<Response<WorkspaceDeliveryReference>, Status> {
        self.authorize_upload(&request).await?;
        self.commit_workspace_delivery(request).await
    }

    type DownloadWorkspaceStream = Download<WorkspaceDownload>;

    async fn download_workspace(
        &self,
        request: Request<InspectAttemptRequest>,
    ) -> Result<Response<Self::DownloadWorkspaceStream>, Status> {
        self.continuation(request, WorkspaceArtifactKind::Bundle)
            .await
    }

    type DownloadCompleteWorkspaceStream = Download<WorkspaceDownload>;

    async fn download_complete_workspace(
        &self,
        request: Request<InspectAttemptRequest>,
    ) -> Result<Response<Self::DownloadCompleteWorkspaceStream>, Status> {
        self.continuation(request, WorkspaceArtifactKind::CompleteBundle)
            .await
    }

    type DownloadWorkspaceArtifactStream = Download<WorkspaceDownload>;

    type DownloadReviewArtifactStream = Download<WorkspaceDownload>;

    async fn download_review_artifact(
        &self,
        request: Request<GetReviewArtifactRequest>,
    ) -> Result<Response<Self::DownloadReviewArtifactStream>, Status> {
        let input = request.get_ref().clone();
        let metadata = request.metadata().clone();
        let (reference, holder) = self.get_review_reference(request).await?;
        let expected = reference.clone();
        let service = self.clone();
        let authorize = move || {
            let service = service.clone();
            let expected = expected.clone();
            let mut request = Request::new(input.clone());
            *request.metadata_mut() = metadata.clone();
            async move {
                if service.get_review_reference(request).await?.0 == expected {
                    Ok(())
                } else {
                    Err(Status::permission_denied(
                        "review patch is no longer authorized",
                    ))
                }
            }
        };
        self.workspace_download(reference, holder, WorkspaceArtifactKind::Patch, authorize)
            .await
    }

    async fn download_workspace_artifact(
        &self,
        request: Request<GetWorkspaceArtifactRequest>,
    ) -> Result<Response<Self::DownloadWorkspaceArtifactStream>, Status> {
        let kind = request.get_ref().kind();
        let input = request.get_ref().clone();
        let metadata = request.metadata().clone();
        let (delivery, holder) = self.get_workspace_artifact(request).await?;
        let expected = delivery.clone();
        let service = self.clone();
        // Recheck the operator's credential, such as a revoked Operator Token, while streaming.
        let authorize = move || {
            let service = service.clone();
            let expected = expected.clone();
            let mut request = Request::new(input.clone());
            *request.metadata_mut() = metadata.clone();
            async move {
                if service.get_workspace_artifact(request).await?.0 == expected {
                    Ok(())
                } else {
                    Err(Status::permission_denied(
                        "workspace artifact is no longer authorized",
                    ))
                }
            }
        };
        self.workspace_download(delivery, holder, kind, authorize)
            .await
    }
}

impl ApiTransfers {
    /// A Session's continuation for the Attempt about to run: the previous delivery's own bundle,
    /// or a complete bundle of it for a host that lacks its start commit.
    async fn continuation(
        &self,
        request: Request<InspectAttemptRequest>,
        kind: WorkspaceArtifactKind,
    ) -> Result<Response<Download<WorkspaceDownload>>, Status> {
        let attempt = request.get_ref().clone();
        let metadata = request.metadata().clone();
        let Some((reference, holder)) = self.get_workspace_reference(request).await? else {
            return Ok(Response::new(empty_stream()));
        };
        let service = self.clone();
        let expected = reference.clone();
        let authorize = move || {
            let service = service.clone();
            let expected = expected.clone();
            let mut request = Request::new(attempt.clone());
            *request.metadata_mut() = metadata.clone();
            async move {
                if service
                    .get_workspace_reference(request)
                    .await?
                    .is_some_and(|(current, _)| current == expected)
                {
                    Ok(())
                } else {
                    Err(Status::permission_denied(
                        "Session bundle is no longer authorized",
                    ))
                }
            }
        };
        self.workspace_download(reference, holder, kind, authorize)
            .await
    }
}

impl ApiTransfers {
    async fn get_workspace_artifact(
        &self,
        request: Request<GetWorkspaceArtifactRequest>,
    ) -> Result<(WorkspaceDeliveryReference, BlobHolder), Status> {
        held(
            self.api
                .forward(request, |channel, request| async move {
                    workspace_client(channel).get_artifact(request).await
                })
                .await?
                .into_inner(),
        )
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

fn held(held: HeldWorkspaceDelivery) -> Result<(WorkspaceDeliveryReference, BlobHolder), Status> {
    match held {
        HeldWorkspaceDelivery {
            delivery: Some(delivery),
            holder: Some(holder),
        } => Ok((delivery, holder)),
        _ => Err(Status::data_loss(
            "Workspace delivery has no holding Worker Host",
        )),
    }
}

/// The reader-facing error for a relay that could not start.
fn relay_status(error: RelayError, host: &str, what: &str) -> Status {
    match error {
        RelayError::Offline => Status::unavailable(format!(
            "{what} bytes are held by Worker Host {host}, {}",
            supertag_protocol::HOLDER_NOT_CONNECTED
        )),
        RelayError::Failed(status) => status,
    }
}

/// Where a download's bytes come from: a local file this process reads (a GitHub source bundle,
/// or a transient Volume snapshot), or the Worker Host relaying them.
pub(crate) enum Source {
    File(tokio::fs::File),
    Relay(Incoming),
}

impl Source {
    async fn next(&mut self, buffer: &mut [u8]) -> Result<Option<Vec<u8>>, Status> {
        match self {
            Self::File(file) => {
                let size = file.read(buffer).await.map_err(storage_error)?;
                Ok((size > 0).then(|| buffer[..size].to_vec()))
            }
            Self::Relay(incoming) => incoming.next().await,
        }
    }
}

/// A download's response stream: it ends with the producer's error when the transfer fails, so
/// a reader never mistakes a short stream for a complete one.
pub(crate) type Download<T> = EndsWithError<ReceiverStream<Result<T, Status>>>;

fn empty_stream<T>() -> Download<T> {
    let (_, receive) = mpsc::channel(1);
    ends_with_error(ReceiverStream::new(receive)).0
}

/// What a download must match: its blob's receipt, or, for a bundle the holder builds on demand,
/// only a size limit. Git checks such a bundle against the delivered commit.
pub(crate) enum Expected {
    Receipt(BlobReference),
    Unrecorded { limit: u64 },
}

impl From<BlobReference> for Expected {
    fn from(blob: BlobReference) -> Self {
        Self::Receipt(blob)
    }
}

impl Expected {
    fn limit(&self) -> u64 {
        match self {
            Self::Receipt(blob) => blob.byte_length,
            Self::Unrecorded { limit } => *limit,
        }
    }
}

fn download_stream<T, Chunk, Check, Authorization>(
    mut source: Source,
    permit: tokio::sync::OwnedSemaphorePermit,
    expected: impl Into<Expected>,
    header: T,
    chunk: Chunk,
    authorize: Check,
    budget: Duration,
) -> Download<T>
where
    T: Send + 'static,
    Chunk: Fn(Vec<u8>) -> T + Send + Sync + 'static,
    Check: Fn() -> Authorization + Send + Sync + 'static,
    Authorization: std::future::Future<Output = Result<(), Status>> + Send,
{
    let expected = expected.into();
    let (send, receive) = mpsc::channel(2);
    let (download, failure) = ends_with_error(ReceiverStream::new(receive));
    tokio::spawn(async move {
        let _permit = permit;
        let stream = async {
            if send.send(Ok(header)).await.is_err() {
                return Ok(());
            }
            let mut buffer = vec![0u8; CHECKPOINT_CHUNK_BYTES];
            let mut checked = tokio::time::Instant::now();
            let mut digest = Sha256::new();
            let mut length = 0u64;
            loop {
                if checked.elapsed() >= Duration::from_secs(1) {
                    authorize().await?;
                    checked = tokio::time::Instant::now();
                }
                let Some(bytes) = source.next(&mut buffer).await? else {
                    break;
                };
                length += bytes.len() as u64;
                if length > expected.limit() {
                    return Err(Status::data_loss("blob size does not match its receipt"));
                }
                digest.update(&bytes);
                if send.send(Ok(chunk(bytes))).await.is_err() {
                    return Ok(());
                }
            }
            if let Expected::Receipt(expected) = &expected
                && (length != expected.byte_length
                    || format!("{:x}", digest.finalize()) != expected.sha256)
            {
                return Err(Status::data_loss("blob digest does not match its receipt"));
            }
            authorize().await?;
            Ok(())
        };
        // A failed transfer ends the reader's stream with its error after the chunks already
        // sent, however slowly the reader reads; it never ends cleanly but short.
        match timeout(budget, stream).await {
            Ok(Ok(())) => {}
            Ok(Err(error)) => failure.fail(error),
            Err(_) => failure.fail(Status::deadline_exceeded("blob download timed out")),
        }
    });
    download
}

async fn open_blob(path: &Path) -> Result<tokio::fs::File, Status> {
    open_optional_blob(path)
        .await?
        .ok_or_else(|| Status::data_loss("stored blob is missing"))
}

async fn open_optional_blob(path: &Path) -> Result<Option<tokio::fs::File>, Status> {
    let path = path.to_owned();
    tokio::task::spawn_blocking(move || {
        let file = match OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
            .open(path)
        {
            Ok(file) => file,
            Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(storage_error(error)),
        };
        if !file.metadata().map_err(storage_error)?.is_file() {
            return Err(Status::data_loss("blob storage entry is not a file"));
        }
        Ok(Some(tokio::fs::File::from_std(file)))
    })
    .await
    .map_err(|_| Status::internal("blob file open failed"))?
}

fn workspace_client(channel: ProtocolChannel) -> WorkspaceDirectoryClient<ProtocolChannel> {
    WorkspaceDirectoryClient::new(channel)
        .max_decoding_message_size(MAX_MESSAGE_BYTES)
        .max_encoding_message_size(MAX_MESSAGE_BYTES)
}

fn storage_error(error: std::io::Error) -> Status {
    supertag_protocol::terminal_text::warn(&format!(
        "Control Plane Volume storage error: {}",
        error.kind()
    ));
    Status::internal("blob storage operation failed")
}
