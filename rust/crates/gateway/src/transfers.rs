use std::{
    fs::{DirBuilder, File, OpenOptions},
    io::ErrorKind,
    os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt},
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};

use anyhow::{Context, Result, ensure};
use sha2::{Digest, Sha256};
use supertag_protocol::{
    CHECKPOINT_CHUNK_BYTES, MAX_MESSAGE_BYTES, host_generation,
    v2::{
        checkpoint_directory_client::CheckpointDirectoryClient,
        checkpoint_download, checkpoint_upload,
        transfers_server::{Transfers, TransfersServer},
        workspace_directory_client::WorkspaceDirectoryClient,
        workspace_download, workspace_upload, *,
    },
    validate_checkpoint_reference, validate_workspace_delivery,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    sync::{Semaphore, mpsc},
    time::timeout,
};
use tokio_stream::wrappers::ReceiverStream;
use tonic::{Request, Response, Status, Streaming, transport::Channel};

use crate::Gateway;

mod artifacts;
pub mod volumes;

const TRANSFER_TIMEOUT: Duration = Duration::from_secs(25);
const WORKSPACE_TRANSFER_TIMEOUT: Duration = Duration::from_secs(120);

#[cfg(test)]
#[path = "transfers_review_tests.rs"]
mod review_tests;

#[derive(Clone)]
pub struct GatewayTransfers {
    gateway: Gateway,
    directory: Option<PathBuf>,
    capacity: Arc<Semaphore>,
    github_sources: Option<crate::github::workspaces::GithubWorkspaceSources>,
    volumes: volumes::ArtifactVolumeMappings,
}

impl GatewayTransfers {
    pub fn new(gateway: Gateway, directory: Option<PathBuf>) -> Result<Self> {
        if let Some(directory) = &directory {
            DirBuilder::new()
                .mode(0o700)
                .recursive(true)
                .create(directory)
                .context("create Gateway checkpoint directory")?;
            let metadata = directory.symlink_metadata()?;
            ensure!(
                metadata.is_dir()
                    && metadata.mode() & 0o077 == 0
                    && metadata.uid() == unsafe { libc::geteuid() },
                "Gateway checkpoint directory must be private"
            );
        }
        Ok(Self {
            gateway,
            directory,
            capacity: Arc::new(Semaphore::new(16)),
            github_sources: None,
            volumes: volumes::ArtifactVolumeMappings::default(),
        })
    }

    pub fn with_github_sources(
        mut self,
        sources: crate::github::workspaces::GithubWorkspaceSources,
    ) -> Self {
        self.github_sources = Some(sources);
        self
    }

    async fn get_source(
        &self,
        request: Request<InspectAttemptRequest>,
    ) -> Result<GithubWorkspace, Status> {
        self.gateway
            .forward_host(request, true, |channel, request| async {
                workspace_client(channel).get_source(request).await
            })
            .await
            .map(Response::into_inner)
    }

    pub fn service(self) -> TransfersServer<Self> {
        TransfersServer::new(self)
            .max_decoding_message_size(MAX_MESSAGE_BYTES)
            .max_encoding_message_size(MAX_MESSAGE_BYTES)
    }

    async fn upload(
        &self,
        request: Request<Streaming<CheckpointUpload>>,
    ) -> Result<Response<CheckpointReference>, Status> {
        let directory = self.directory.as_ref().ok_or_else(|| {
            Status::failed_precondition("Gateway checkpoint storage is not configured")
        })?;
        let (metadata, _, mut stream) = request.into_parts();
        let begin = match stream.message().await?.and_then(|message| message.part) {
            Some(checkpoint_upload::Part::Begin(begin)) => begin,
            _ => {
                return Err(Status::invalid_argument(
                    "checkpoint upload requires an opening record",
                ));
            }
        };
        let reference = begin
            .reference
            .as_ref()
            .ok_or_else(|| Status::invalid_argument("checkpoint reference required"))?;
        validate_checkpoint_reference(reference)?;
        let mut reservation = Request::new(begin.clone());
        *reservation.metadata_mut() = metadata.clone();
        let reserved = self
            .gateway
            .forward_host(reservation, true, |channel, request| async move {
                checkpoint_client(channel).reserve_checkpoint(request).await
            })
            .await?
            .into_inner();
        if &reserved != reference {
            return Err(Status::data_loss(
                "Control Plane returned a different checkpoint reservation",
            ));
        }

        let mut file = StagedBlob::new(
            directory,
            BlobReference {
                sha256: reference.sha256.clone(),
                byte_length: reference.byte_length,
            },
        )?;
        while let Some(message) = stream.message().await? {
            let Some(checkpoint_upload::Part::Chunk(chunk)) = message.part else {
                return Err(Status::invalid_argument("expected a checkpoint chunk"));
            };
            file.append(&chunk).await?;
        }
        file.verify().await?;
        file.persist(directory).await?;
        sync_directory(directory).await?;

        let mut commit = Request::new(begin);
        *commit.metadata_mut() = metadata;
        self.gateway
            .forward_host(commit, true, |channel, request| async move {
                checkpoint_client(channel).commit_checkpoint(request).await
            })
            .await
    }

    async fn upload_workspace_delivery(
        &self,
        request: Request<Streaming<WorkspaceUpload>>,
    ) -> Result<Response<WorkspaceDeliveryReference>, Status> {
        let directory = self.directory()?;
        let (metadata, _, mut stream) = request.into_parts();
        let begin = match stream.message().await?.and_then(|message| message.part) {
            Some(workspace_upload::Part::Begin(begin)) => begin,
            _ => {
                return Err(Status::invalid_argument(
                    "workspace upload requires an opening record",
                ));
            }
        };
        let delivery = begin
            .delivery
            .as_ref()
            .ok_or_else(|| Status::invalid_argument("workspace delivery required"))?;
        validate_workspace_delivery(delivery)?;
        let mut reservation = Request::new(begin.clone());
        *reservation.metadata_mut() = metadata.clone();
        let reserved = self
            .gateway
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

        let mut patch =
            StagedBlob::new(directory, delivery.patch.clone().expect("validated patch"))?;
        let mut bundle = StagedBlob::new(
            directory,
            delivery.bundle.clone().expect("validated bundle"),
        )?;
        while let Some(message) = stream.message().await? {
            match message.part {
                Some(workspace_upload::Part::PatchChunk(bytes)) => patch.append(&bytes).await?,
                Some(workspace_upload::Part::BundleChunk(bytes)) => bundle.append(&bytes).await?,
                _ => {
                    return Err(Status::invalid_argument(
                        "expected a workspace artifact chunk",
                    ));
                }
            }
        }
        patch.verify().await?;
        bundle.verify().await?;
        patch.persist(directory).await?;
        bundle.persist(directory).await?;
        sync_directory(directory).await?;

        let mut commit = Request::new(begin);
        *commit.metadata_mut() = metadata;
        self.gateway
            .forward_host(commit, true, |channel, request| async move {
                workspace_client(channel).commit_delivery(request).await
            })
            .await
    }

    async fn get_workspace_reference(
        &self,
        request: Request<InspectAttemptRequest>,
    ) -> Result<Option<WorkspaceDeliveryReference>, Status> {
        self.gateway
            .forward_host(request, true, |channel, request| async move {
                workspace_client(channel).get_continuation(request).await
            })
            .await
            .map(|response| response.into_inner().delivery)
    }

    async fn get_review_reference(
        &self,
        request: Request<GetReviewArtifactRequest>,
    ) -> Result<WorkspaceDeliveryReference, Status> {
        self.gateway
            .forward_host(request, true, |channel, request| async move {
                workspace_client(channel).get_review_artifact(request).await
            })
            .await
            .map(Response::into_inner)
    }

    async fn authorize_upload<T>(&self, request: &Request<T>) -> Result<(), Status> {
        let token_digest = self.gateway.credentials.host_credential_digest(request)?;
        let generation = host_generation(request)?;
        let host = timeout(
            Duration::from_secs(5),
            self.gateway
                .authenticate_host(token_digest, Duration::from_secs(5)),
        )
        .await
        .map_err(|_| Status::deadline_exceeded("Worker Host authentication timed out"))??;
        if host.revoked || generation != host.generation {
            return Err(Status::permission_denied(
                "Worker Host generation is no longer current",
            ));
        }
        Ok(())
    }

    fn directory(&self) -> Result<&Path, Status> {
        self.directory
            .as_deref()
            .ok_or_else(|| Status::failed_precondition("Gateway blob storage is not configured"))
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
        kind: WorkspaceArtifactKind,
        authorize: F,
    ) -> Result<Response<ReceiverStream<Result<WorkspaceDownload, Status>>>, Status>
    where
        F: Fn() -> Authorization + Send + Sync + 'static,
        Authorization: std::future::Future<Output = Result<(), Status>> + Send,
    {
        validate_workspace_delivery(&reference)?;
        let blob = match kind {
            WorkspaceArtifactKind::Patch => reference.patch.clone(),
            WorkspaceArtifactKind::Bundle => reference.bundle.clone(),
            _ => return Err(Status::invalid_argument("workspace artifact kind required")),
        }
        .expect("validated blob reference");
        let permit = self.acquire()?;
        let file = open_blob(&self.directory()?.join(&blob.sha256)).await?;
        let header = WorkspaceDownload {
            part: Some(workspace_download::Part::Reference(reference)),
        };
        Ok(Response::new(download_stream(
            file,
            permit,
            blob,
            header,
            |bytes| WorkspaceDownload {
                part: Some(workspace_download::Part::Chunk(bytes)),
            },
            authorize,
            WORKSPACE_TRANSFER_TIMEOUT,
        )))
    }

    async fn get_reference(
        &self,
        request: Request<InspectAttemptRequest>,
    ) -> Result<Option<CheckpointReference>, Status> {
        self.gateway
            .forward_host(request, true, |channel, request| async move {
                checkpoint_client(channel).get_checkpoint(request).await
            })
            .await
            .map(|response| response.into_inner().reference)
    }
}

#[tonic::async_trait]
impl Transfers for GatewayTransfers {
    type DownloadWorkspaceSourceStream = ReceiverStream<Result<GithubWorkspaceDownload, Status>>;

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
            let mut request = Request::new(attempt.clone());
            *request.metadata_mut() = metadata.clone();
            request
        };
        let workspace = self.get_source(source_request()).await?;
        let sources = self.github_sources.as_ref().ok_or_else(|| {
            Status::failed_precondition("GitHub Workspace source is not configured on this Gateway")
        })?;
        let _permit = self.acquire()?;
        let cancel = tokio_util::sync::CancellationToken::new();
        let _cancel_on_drop = cancel.clone().drop_guard();
        let remote = timeout(
            Duration::from_secs(30),
            sources.advertised_output_remote(&workspace, &input.commit, &cancel),
        )
        .await
        .map_err(|_| Status::deadline_exceeded("GitHub output verification timed out"))?
        .map_err(|_| Status::unavailable("GitHub output remote could not be verified"))?;
        if self.get_source(source_request()).await? != workspace {
            return Err(Status::permission_denied(
                "GitHub source is no longer authorized",
            ));
        }
        Ok(Response::new(VerifyWorkspaceOutputRemoteResponse {
            remote,
        }))
    }

    async fn download_workspace_source(
        &self,
        request: Request<InspectAttemptRequest>,
    ) -> Result<Response<Self::DownloadWorkspaceSourceStream>, Status> {
        let attempt = request.get_ref().clone();
        let metadata = request.metadata().clone();
        // This authoritative check precedes credential resolution or provider I/O.
        let workspace = self.get_source(request).await?;
        let sources = self.github_sources.as_ref().ok_or_else(|| {
            Status::failed_precondition("GitHub Workspace source is not configured on this Gateway")
        })?;
        let permit = self.acquire()?;
        let cancel = tokio_util::sync::CancellationToken::new();
        let _cancel_on_drop = cancel.clone().drop_guard();
        let fetched = Arc::new(
            timeout(
                WORKSPACE_TRANSFER_TIMEOUT,
                sources.fetch(&workspace, &cancel),
            )
            .await
            .map_err(|_| Status::deadline_exceeded("GitHub source retrieval timed out"))?
            .map_err(|_| Status::unavailable("GitHub source could not be retrieved safely"))?,
        );
        let reference = BlobReference {
            sha256: fetched.bundle.sha256.clone(),
            byte_length: fetched.bundle.byte_length,
        };
        let header = GithubWorkspaceDownload {
            part: Some(github_workspace_download::Part::Reference(
                GithubWorkspaceBundle {
                    workspace: Some(workspace.clone()),
                    bundle: Some(reference.clone()),
                },
            )),
        };
        let file = open_blob(&fetched.bundle.path).await?;
        let service = self.clone();
        let authorize = move || {
            let service = service.clone();
            let workspace = workspace.clone();
            let keep = fetched.clone();
            let mut request = Request::new(attempt.clone());
            *request.metadata_mut() = metadata.clone();
            async move {
                let _keep = keep;
                if service.get_source(request).await? == workspace {
                    Ok(())
                } else {
                    Err(Status::permission_denied(
                        "GitHub source is no longer authorized",
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
            |bytes| GithubWorkspaceDownload {
                part: Some(github_workspace_download::Part::Chunk(bytes)),
            },
            authorize,
            WORKSPACE_TRANSFER_TIMEOUT,
        )))
    }

    async fn upload_checkpoint(
        &self,
        request: Request<Streaming<CheckpointUpload>>,
    ) -> Result<Response<CheckpointReference>, Status> {
        self.authorize_upload(&request).await?;
        let _permit = self.acquire()?;
        timeout(TRANSFER_TIMEOUT, self.upload(request))
            .await
            .map_err(|_| Status::deadline_exceeded("checkpoint upload timed out"))?
    }

    type DownloadCheckpointStream = ReceiverStream<Result<CheckpointDownload, Status>>;

    async fn download_checkpoint(
        &self,
        request: Request<InspectAttemptRequest>,
    ) -> Result<Response<Self::DownloadCheckpointStream>, Status> {
        let attempt = request.get_ref().clone();
        let metadata = request.metadata().clone();
        let Some(reference) = self.get_reference(request).await? else {
            return Ok(Response::new(empty_stream()));
        };
        validate_checkpoint_reference(&reference)?;
        let permit = self.acquire()?;
        let file = open_blob(&self.directory()?.join(&reference.sha256)).await?;
        let blob = BlobReference {
            sha256: reference.sha256.clone(),
            byte_length: reference.byte_length,
        };
        let header = CheckpointDownload {
            part: Some(checkpoint_download::Part::Reference(reference.clone())),
        };
        let service = self.clone();
        let authorize = move || {
            let service = service.clone();
            let reference = reference.clone();
            let mut request = Request::new(attempt.clone());
            *request.metadata_mut() = metadata.clone();
            async move {
                if service.get_reference(request).await?.as_ref() == Some(&reference) {
                    Ok(())
                } else {
                    Err(Status::permission_denied(
                        "Session checkpoint is no longer authorized",
                    ))
                }
            }
        };
        Ok(Response::new(download_stream(
            file,
            permit,
            blob,
            header,
            |bytes| CheckpointDownload {
                part: Some(checkpoint_download::Part::Chunk(bytes)),
            },
            authorize,
            TRANSFER_TIMEOUT,
        )))
    }

    async fn upload_workspace(
        &self,
        request: Request<Streaming<WorkspaceUpload>>,
    ) -> Result<Response<WorkspaceDeliveryReference>, Status> {
        self.authorize_upload(&request).await?;
        let _permit = self.acquire()?;
        timeout(
            WORKSPACE_TRANSFER_TIMEOUT,
            self.upload_workspace_delivery(request),
        )
        .await
        .map_err(|_| Status::deadline_exceeded("workspace upload timed out"))?
    }

    type DownloadWorkspaceStream = ReceiverStream<Result<WorkspaceDownload, Status>>;

    async fn download_workspace(
        &self,
        request: Request<InspectAttemptRequest>,
    ) -> Result<Response<Self::DownloadWorkspaceStream>, Status> {
        let attempt = request.get_ref().clone();
        let metadata = request.metadata().clone();
        let Some(reference) = self.get_workspace_reference(request).await? else {
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
                if service.get_workspace_reference(request).await?.as_ref() == Some(&expected) {
                    Ok(())
                } else {
                    Err(Status::permission_denied(
                        "Session bundle is no longer authorized",
                    ))
                }
            }
        };
        self.workspace_download(reference, WorkspaceArtifactKind::Bundle, authorize)
            .await
    }

    type DownloadWorkspaceArtifactStream = ReceiverStream<Result<WorkspaceDownload, Status>>;

    type DownloadReviewArtifactStream = ReceiverStream<Result<WorkspaceDownload, Status>>;

    async fn download_review_artifact(
        &self,
        request: Request<GetReviewArtifactRequest>,
    ) -> Result<Response<Self::DownloadReviewArtifactStream>, Status> {
        let input = request.get_ref().clone();
        let metadata = request.metadata().clone();
        let reference = self.get_review_reference(request).await?;
        let expected = reference.clone();
        let service = self.clone();
        let authorize = move || {
            let service = service.clone();
            let expected = expected.clone();
            let mut request = Request::new(input.clone());
            *request.metadata_mut() = metadata.clone();
            async move {
                if service.get_review_reference(request).await? == expected {
                    Ok(())
                } else {
                    Err(Status::permission_denied(
                        "review patch is no longer authorized",
                    ))
                }
            }
        };
        self.workspace_download(reference, WorkspaceArtifactKind::Patch, authorize)
            .await
    }

    async fn download_workspace_artifact(
        &self,
        request: Request<GetWorkspaceArtifactRequest>,
    ) -> Result<Response<Self::DownloadWorkspaceArtifactStream>, Status> {
        let kind = request.get_ref().kind();
        let delivery =
            self.gateway
                .forward(
                    request,
                    &self.gateway.credentials.operator,
                    |channel, request| async move {
                        workspace_client(channel).get_artifact(request).await
                    },
                )
                .await?
                .into_inner();
        self.workspace_download(delivery, kind, || async { Ok(()) })
            .await
    }
}

struct StagedBlob {
    staged: tempfile::NamedTempFile,
    handle: tokio::fs::File,
    length: u64,
    digest: Sha256,
    expected: BlobReference,
}

impl StagedBlob {
    fn new(directory: &Path, expected: BlobReference) -> Result<Self, Status> {
        let staged = tempfile::NamedTempFile::new_in(directory).map_err(storage_error)?;
        let handle =
            tokio::fs::File::from_std(staged.as_file().try_clone().map_err(storage_error)?);
        Ok(Self {
            staged,
            handle,
            expected,
            length: 0,
            digest: Sha256::new(),
        })
    }

    async fn append(&mut self, bytes: &[u8]) -> Result<(), Status> {
        self.length += bytes.len() as u64;
        if bytes.is_empty()
            || bytes.len() > CHECKPOINT_CHUNK_BYTES
            || self.length > self.expected.byte_length
        {
            return Err(Status::invalid_argument("invalid blob chunk size"));
        }
        self.digest.update(bytes);
        self.handle.write_all(bytes).await.map_err(storage_error)
    }

    async fn verify(&mut self) -> Result<(), Status> {
        if self.length != self.expected.byte_length
            || format!("{:x}", self.digest.clone().finalize()) != self.expected.sha256
        {
            return Err(Status::invalid_argument("blob length or digest mismatch"));
        }
        self.handle.flush().await.map_err(storage_error)?;
        self.handle.sync_all().await.map_err(storage_error)
    }

    async fn persist(self, directory: &Path) -> Result<(), Status> {
        drop(self.handle);
        let path = directory.join(&self.expected.sha256);
        if let Err(error) = self.staged.persist_noclobber(&path) {
            if error.error.kind() != ErrorKind::AlreadyExists {
                return Err(storage_error(error.error));
            }
            verify_existing(&path, &self.expected).await?;
        }
        Ok(())
    }
}

fn empty_stream<T>() -> ReceiverStream<T> {
    let (_, receive) = mpsc::channel(1);
    ReceiverStream::new(receive)
}

fn download_stream<T, Chunk, Check, Authorization>(
    mut file: tokio::fs::File,
    permit: tokio::sync::OwnedSemaphorePermit,
    expected: BlobReference,
    header: T,
    chunk: Chunk,
    authorize: Check,
    budget: Duration,
) -> ReceiverStream<Result<T, Status>>
where
    T: Send + 'static,
    Chunk: Fn(Vec<u8>) -> T + Send + Sync + 'static,
    Check: Fn() -> Authorization + Send + Sync + 'static,
    Authorization: std::future::Future<Output = Result<(), Status>> + Send,
{
    let (send, receive) = mpsc::channel(2);
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
                let size = file.read(&mut buffer).await.map_err(storage_error)?;
                if size == 0 {
                    break;
                }
                length += size as u64;
                if length > expected.byte_length {
                    return Err(Status::data_loss("blob size does not match its receipt"));
                }
                digest.update(&buffer[..size]);
                if send.send(Ok(chunk(buffer[..size].to_vec()))).await.is_err() {
                    return Ok(());
                }
            }
            if length != expected.byte_length
                || format!("{:x}", digest.finalize()) != expected.sha256
            {
                return Err(Status::data_loss("blob digest does not match its receipt"));
            }
            authorize().await?;
            Ok(())
        };
        match timeout(budget, stream).await {
            Ok(Ok(())) => {}
            Ok(Err(error)) => {
                let _ = timeout(Duration::from_secs(2), send.send(Err(error))).await;
            }
            Err(_) => {
                let _ = timeout(
                    Duration::from_secs(2),
                    send.send(Err(Status::deadline_exceeded("blob download timed out"))),
                )
                .await;
            }
        }
    });
    ReceiverStream::new(receive)
}

async fn verify_existing(path: &Path, reference: &BlobReference) -> Result<(), Status> {
    let mut file = open_blob(path).await?;
    let mut digest = Sha256::new();
    let mut length = 0u64;
    let mut buffer = vec![0u8; CHECKPOINT_CHUNK_BYTES];
    loop {
        let count = file.read(&mut buffer).await.map_err(storage_error)?;
        if count == 0 {
            break;
        }
        length += count as u64;
        if length > reference.byte_length {
            return Err(Status::data_loss("stored blob exceeds its receipt"));
        }
        digest.update(&buffer[..count]);
    }
    if length != reference.byte_length || format!("{:x}", digest.finalize()) != reference.sha256 {
        return Err(Status::data_loss("stored blob conflicts with upload"));
    }
    Ok(())
}

async fn sync_directory(directory: &Path) -> Result<(), Status> {
    let path = directory.to_owned();
    tokio::task::spawn_blocking(move || File::open(path)?.sync_all())
        .await
        .map_err(|_| Status::internal("blob durability check failed"))?
        .map_err(storage_error)
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

fn checkpoint_client(channel: Channel) -> CheckpointDirectoryClient<Channel> {
    CheckpointDirectoryClient::new(channel)
        .max_decoding_message_size(MAX_MESSAGE_BYTES)
        .max_encoding_message_size(MAX_MESSAGE_BYTES)
}

fn workspace_client(channel: Channel) -> WorkspaceDirectoryClient<Channel> {
    WorkspaceDirectoryClient::new(channel)
        .max_decoding_message_size(MAX_MESSAGE_BYTES)
        .max_encoding_message_size(MAX_MESSAGE_BYTES)
}

fn storage_error(error: std::io::Error) -> Status {
    eprintln!("Gateway blob storage error: {}", error.kind());
    Status::internal("blob storage operation failed")
}
